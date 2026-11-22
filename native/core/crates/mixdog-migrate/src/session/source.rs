//! Old-format readers of one session item (SM §11.4): the 1.4.5 json, the dev log and the
//! pair rule, the compaction archive and pending jobs, turn checkpoints, the pending
//! spools and the worker indexes. Strict where SM says so; every lone surrogate becomes
//! U+FFFD and is counted.

use std::collections::BTreeSet;
use std::collections::HashMap;

use indexmap::IndexMap;
use mixdog_js::js_object_keys;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::time::date_parse;
use mixdog_js::to_number;
use mixdog_js::to_number_of as js_number_of;
use mixdog_protocol::message_class::js::or_str;
use mixdog_protocol::message_class::js::string as js_string;
use mixdog_store::schema::migration::ItemKind;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::record::ArchiveOrigin;
use mixdog_store::schema::record::ArchiveTag;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::RunPhase;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;
use serde_json::value::RawValue;
use sha1::Digest as _;
use sha1::Sha1;

use mixdog_core_prompt::prompt::migrate::migrate_system_messages;

use super::context_blobs::ContextBlobs;
use super::context_blobs::OfficeExtractor;
use super::ids::message_iids;
use super::model::Row;
use super::model::RunModel;
use super::model::SessionModel;
use super::pending;
use super::splice::Splice;
use super::splice::restore_header;
use super::splice::splice;
use crate::durable;
use crate::error::Blocked;
use crate::framework::ItemContext;
use crate::json;
use crate::json::hex;

/// Why a session item cannot convert: quarantined with a code, or the run is blocked.
#[derive(Debug)]
pub enum Fail {
    Quarantine(QuarantineCode, String),
    Blocked(Blocked),
}

impl From<Blocked> for Fail {
    fn from(b: Blocked) -> Self {
        Fail::Blocked(b)
    }
}

pub type R<T> = Result<T, Fail>;

fn q<T>(code: QuarantineCode, detail: impl Into<String>) -> R<T> {
    Err(Fail::Quarantine(code, detail.into()))
}

pub const JSON_SUFFIX: &str = ".json";
pub const LOG_SUFFIX: &str = ".log.jsonl";
pub const ARCHIVE_SUFFIX: &str = ".compaction-archive.jsonl";
pub const PENDING_SUFFIX: &str = ".compaction-archive.pending";
pub const SPOOL_DIR: &str = "session-pending";
pub const LEGACY_SPOOL: &str = "session-pending-messages.json";
pub const AGENT_WORKERS: &str = "agent-workers.json";
pub const LEAD_WORKERS: &str = "lead-workers.json";
pub const AGENT_RELEASED: &str = "agent-workers-released.json";

pub fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn parse(text: &[u8], code: QuarantineCode, what: &str, replaced: &mut u64) -> R<Value> {
    match json::parse_source(text) {
        Ok(parsed) => {
            *replaced += parsed.replaced_surrogates;
            Ok(parsed.value)
        }
        Err(e) => q(code, format!("{what}: {e}")),
    }
}

/// `Number.isSafeInteger(v) && v >= 0`.
fn count_of(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_number()?;
    if let Some(u) = n.as_u64() {
        return (u < (1 << 53)).then_some(u);
    }
    let f = n.as_f64()?;
    (f >= 0.0 && f.fract() == 0.0 && f <= 9_007_199_254_740_991.0).then_some(f as u64)
}

// ── 1.4.5 json ───────────────────────────────────────────────────────────────

/// Header and messages of a 1.4.5 `<id>.json`, strict on syntax and `id`/`messages`.
fn read_json(id: &str, bytes: &[u8], replaced: &mut u64, messages_as: Messages<'_>) -> R<(Header, Vec<Value>)> {
    let value = match messages_as.parse(bytes) {
        Ok(parsed) => {
            *replaced += parsed.replaced_surrogates;
            parsed.value
        }
        Err(e) => return q(QuarantineCode::ParseError, format!("session json: {e}")),
    };
    let Value::Object(mut map) = value else {
        return q(QuarantineCode::SchemaViolation, "session json is not an object");
    };
    if json::object_repeats_a_top_level_key(bytes) {
        return q(QuarantineCode::ParseError, "session json repeats a top-level key");
    }
    let messages = match map.shift_remove("messages") {
        Some(Value::Array(m)) => m,
        _ => return q(QuarantineCode::SchemaViolation, "messages is not an array"),
    };
    match map.get("id") {
        None => {}
        Some(Value::String(s)) if s == id => {}
        Some(Value::String(s)) => {
            return q(QuarantineCode::IdMismatch, format!("json id {s} in the file of {id}"));
        }
        Some(_) => return q(QuarantineCode::SchemaViolation, "id is not a string"),
    }
    Ok((map, messages))
}

// ── Dev log ──────────────────────────────────────────────────────────────────

/// `{sha1, redactedFrom?}` of the json the log was built from.
pub struct Legacy {
    pub sha1: String,
    pub redacted_from: Option<String>,
}

pub struct LogFold {
    pub header: Header,
    pub messages: Vec<Value>,
    pub legacy: Option<Legacy>,
}

/// `decodeRecord` (`dev:session-log-format.mjs`): the record a line holds, else `None`.
fn decode_record(v: &Value) -> Option<&Map<String, Value>> {
    let r = v.as_object()?;
    let s = count_of(r.get("s"))?;
    let messages = r.get("messages").and_then(Value::as_array);
    let ok = match r.get("t")?.as_str()? {
        "session" => {
            let header = r.get("header")?.as_object()?;
            let id = r.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let legacy_ok = match r.get("legacy") {
                Some(Value::Null) => true,
                Some(Value::Object(l)) => {
                    l.get("sha1").is_some_and(Value::is_string)
                        && count_of(l.get("size")).is_some()
                        && l.get("mtimeMs").and_then(Value::as_f64).is_some_and(f64::is_finite)
                        && matches!(l.get("redactedFrom"), None | Some(Value::String(_)))
                }
                _ => false,
            };
            let prev_ok = match r.get("prev") {
                Some(Value::Null) => true,
                Some(Value::Object(p)) => p.get("logId").is_some_and(Value::is_string),
                _ => false,
            };
            s == 0
                && r.get("v").and_then(Value::as_f64) == Some(1.0)
                && r.get("logId").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
                && !header.contains_key("messages")
                && header.get("id").is_none_or(|h| h.as_str() == Some(id))
                && legacy_ok
                && prev_ok
        }
        "compacted" => messages.is_some_and(|m| count_of(r.get("len")) == Some(m.len() as u64)),
        "append" => messages.is_some_and(|m| !m.is_empty()) && count_of(r.get("len")).is_some(),
        "edit" => messages.is_some() && count_of(r.get("len")).is_some() && count_of(r.get("at")).is_some() && count_of(r.get("del")).is_some(),
        "rollback" => count_of(r.get("len")).is_some(),
        "patch" => {
            let (Some(set), Some(unset)) = (r.get("set").and_then(Value::as_object), r.get("unset").and_then(Value::as_array)) else {
                return None;
            };
            !set.contains_key("messages") && !set.contains_key("id") && unset.iter().all(|k| k.is_string() && k != "messages" && k != "id")
        }
        _ => false,
    };
    ok.then_some(r)
}

/// `holdsNoData`: only NUL and white space.
fn holds_no_data(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| matches!(b, 0 | b' ' | b'\t' | b'\n' | b'\r'))
}

/// `legacyStanding` (`dev:session-log-reader.mjs:341-370`): does the log win?
pub fn log_wins(legacy: Option<&Legacy>, json: Option<&[u8]>) -> bool {
    let Some(json) = json.filter(|j| !holds_no_data(j)) else {
        return true;
    };
    let sha1 = hex(&Sha1::digest(json));
    match legacy {
        Some(l) if l.sha1 == sha1 => true,
        Some(l) if l.redacted_from.as_deref() == Some(sha1.as_str()) => true,
        _ => false,
    }
}

// ── Compaction archive and pending jobs ──────────────────────────────────────

/// `compactionArchiveRange`: visible seqs are in `(after, before)`.
fn archive_range(header: &Header) -> Option<(f64, f64)> {
    let archive = header.get("compaction")?.get("archive")?.as_object()?;
    let before = js_number_of(archive.get("nextSeq"));
    let cleared = js_number_of(archive.get("clearedThrough"));
    let after = if cleared.is_nan() { 0.0 } else { cleared.floor().max(0.0) };
    if before.fract() != 0.0 || !before.is_finite() || before - 1.0 <= after {
        return None;
    }
    Some((after, before))
}

fn visible(range: Option<(f64, f64)>, seq: u64) -> bool {
    range.is_some_and(|(after, before)| after < seq as f64 && (seq as f64) < before)
}

/// Whether 1.4.5's archive index (`compaction-archive.mjs` `indexArchive`) reads `line` as a
/// segment: its first 512 bytes hold `SEGMENT_HEAD` then `"items":`, and the head's `bytes`
/// ends the line exactly. Every 1.4.5 archive read skips any other line.
pub(super) fn indexed_segment(line: &[u8]) -> bool {
    let probe = &line[..line.len().min(512)];
    let mut at = 0;
    let literal = |at: &mut usize, text: &[u8]| {
        let hit = probe[*at..].starts_with(text);
        if hit {
            *at += text.len();
        }
        hit
    };
    let digits = |at: &mut usize| {
        let n = probe[*at..].iter().take_while(|b| b.is_ascii_digit()).count();
        let value = std::str::from_utf8(&probe[*at..*at + n]).ok().filter(|_| n > 0).and_then(|d| d.parse::<u64>().ok());
        *at += n;
        value
    };
    let quoted = |at: &mut usize| {
        let close = (probe.get(*at) == Some(&b'"')).then(|| probe[*at + 1..].iter().position(|b| *b == b'"')).flatten();
        close.inspect(|n| *at += n + 2).is_some()
    };
    let head = literal(&mut at, br#"{"v":1,"seq":"#)
        && digits(&mut at).is_some()
        && literal(&mut at, br#","id":"#)
        && quoted(&mut at)
        && literal(&mut at, br#","prev":"#)
        && (literal(&mut at, b"null") || quoted(&mut at))
        && literal(&mut at, br#","at":"#)
        && digits(&mut at).is_some()
        && literal(&mut at, br#","count":"#)
        && digits(&mut at).is_some()
        && literal(&mut at, br#","bytes":"#);
    if !head {
        return false;
    }
    let bytes = digits(&mut at);
    let items = literal(&mut at, br#","items":"#);
    bytes
        .zip(items.then_some(()))
        .is_some_and(|(bytes, ())| usize::try_from(bytes).is_ok_and(|b| at.checked_add(b).and_then(|e| e.checked_add(1)) == Some(line.len())))
}

fn opt_number(v: Option<&Value>, what: &str) -> R<Option<Number>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(Some(n.clone())),
        Some(_) => q(QuarantineCode::ArchiveParseError, format!("{what} is not a number")),
    }
}

fn role_of(v: &Value) -> Option<String> {
    v.get("role").and_then(Value::as_str).map(str::to_string)
}

/// What one damaged part of an archive sidecar leaves in the session's damage note: which sidecar,
/// which line (an archive segment's; 0 for the pending sidecar, which is skipped whole), why, and
/// the part's bytes (decoded lossily, cut at 4 KiB) so nothing skipped is lost for good.
fn skipped(file: &str, line: usize, why: &str, bytes: &[u8]) -> Value {
    const KEPT: usize = 4096;
    let cut = bytes.len().min(KEPT);
    serde_json::json!({
        "file": file,
        "line": line,
        "why": why,
        "bytes": bytes.len(),
        "text": String::from_utf8_lossy(&bytes[..cut]),
    })
}

/// One line of the display archive as its segment: the seq and the rows. Quarantine codes here
/// mean this line is damaged, not the session.
fn segment_rows(line: &[u8], what: &str, range: Option<(f64, f64)>, replaced: &mut u64) -> R<(u64, Vec<Row>)> {
    let value = parse(line, QuarantineCode::ArchiveParseError, what, replaced)?;
    let Some(seg) = value.as_object() else {
        return q(QuarantineCode::ArchiveParseError, format!("{what} is not a segment"));
    };
    let (Some(1), Some(seq), Some(Value::String(seg_id)), Some(count), Some(bytes), Some(Value::Array(items))) = (
        seg.get("v").and_then(Value::as_u64),
        seg.get("seq").and_then(Value::as_u64),
        seg.get("id"),
        seg.get("count").and_then(Value::as_u64),
        seg.get("bytes").and_then(Value::as_u64),
        seg.get("items"),
    ) else {
        return q(QuarantineCode::ArchiveParseError, format!("{what} is not a segment"));
    };
    let prev = match seg.get("prev") {
        Some(Value::Null) => None,
        Some(Value::String(p)) => Some(p.clone()),
        _ => return q(QuarantineCode::ArchiveParseError, format!("{what}: prev")),
    };
    let at = opt_number(seg.get("at"), what)?;
    // 1.4.5 shows the last `count` items of a segment its index reads.
    let shown = indexed_segment(line) && visible(range, seq);
    let first_shown = items.len().saturating_sub(usize::try_from(count).unwrap_or(usize::MAX));
    let origin = ArchiveOrigin::Segment { id: text_id(seg_id)?, prev: prev.as_deref().map(text_id).transpose()?, count, bytes };
    let rows = items
        .iter()
        .enumerate()
        .map(|(j, item)| Row {
            iid: match item.get("id") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => format!("arc:{seq}:{j}"),
            },
            turn: None,
            role: role_of(item),
            form: Form::Display,
            model: false,
            visible: shown && j >= first_shown,
            archive: Some(ArchiveTag { seq, at: at.clone(), origin: origin.clone() }),
            prompt: None,
            body: item.clone(),
        })
        .collect();
    Ok((seq, rows))
}

/// JavaScript truthiness of a parsed JSON value.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A job's `at`: a number as it is; a value that is not one reads as the segment line wrote it,
/// `Math.max(0, Math.floor(Number(at) || 0))`; absent or null stays absent.
fn job_at(v: Option<&Value>) -> Option<Number> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(n.clone()),
        Some(other) => {
            let f = to_number(other).floor();
            let f = if f.is_nan() || f < 0.0 { 0.0 } else { f };
            Some(if f < 9_007_199_254_740_992.0 { Number::from(f as u64) } else { Number::from_f64(f).unwrap_or_else(|| Number::from(0u64)) })
        }
    }
}

/// `Number.isInteger(seq)`: any integer-valued number, negative or beyond 2^53 included.
fn integer_seq(v: Option<&Value>) -> Option<f64> {
    v?.as_number()?.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0)
}

/// The jobs of a pending sidecar (`parsePendingJobs`): `jobs` is an array and every job has an
/// integer `seq` and a `messages` array, else the sidecar is damaged as a whole and the error
/// is for the caller, which skips all of it. Nothing else decides this.
fn pending_jobs(doc: &Value) -> R<&Vec<Value>> {
    match doc.get("jobs") {
        Some(Value::Array(jobs)) if jobs.iter().all(|job| integer_seq(job.get("seq")).is_some() && job.get("messages").is_some_and(Value::is_array)) => {
            Ok(jobs)
        }
        Some(Value::Array(_)) => q(QuarantineCode::ArchiveParseError, "a pending job without an integer seq and a messages array"),
        _ => q(QuarantineCode::ArchiveParseError, "pending sidecar holds no jobs"),
    }
}

/// `committedSeqOf`: the number the session record commits (`compaction.archive.nextSeq`,
/// floored), 0 when it names none.
fn committed_seq(header: &Header) -> f64 {
    let next = js_number_of(header.get("compaction").and_then(|c| c.get("archive")).and_then(|a| a.get("nextSeq"))).floor();
    if next > 0.0 { next } else { 0.0 }
}

/// One pending compaction job as its seq and rows. A job `pending_jobs` accepted whose number
/// the target cannot hold (negative, or beyond 2^53) is a quarantine error for the caller to
/// skip: only a hand-damaged record has one that its session commits.
fn pending_job_rows(id: &str, job: &Value, range: Option<(f64, f64)>) -> R<(u64, Vec<Row>)> {
    // The other fields were never checked, so each takes what its reader made of a value that
    // does not conform.
    let Some(Value::Array(messages)) = job.get("messages") else {
        return q(QuarantineCode::ArchiveParseError, "a pending job without a messages array");
    };
    let Some(seq) = count_of(job.get("seq")) else {
        return q(QuarantineCode::ArchiveParseError, "the job's sequence number cannot be represented");
    };
    let tag = ArchiveTag {
        seq,
        at: job_at(job.get("at")),
        origin: ArchiveOrigin::Pending {
            // `if (!divider) return items`: any truthy value adds the divider.
            divider: job.get("divider").is_some_and(js_truthy),
            // Counts that are not counts are left out, as a field that was never set.
            cleared_through: count_of(job.get("clearedThrough")),
            max_bytes: count_of(job.get("maxBytes")),
        },
    };
    let iids = message_iids(&format!("{id}#arc{seq}"), messages);
    let rows = messages
        .iter()
        .zip(iids)
        .map(|(m, iid)| Row {
            iid,
            turn: None,
            role: role_of(m),
            form: Form::Message,
            model: false,
            visible: visible(range, seq),
            archive: Some(tag.clone()),
            prompt: None,
            body: m.clone(),
        })
        .collect();
    Ok((seq, rows))
}

fn text_id(s: &str) -> R<mixdog_store::schema::bounded::Id> {
    mixdog_store::schema::bounded::Id::try_from(s).map_err(|e| Fail::Quarantine(QuarantineCode::SchemaViolation, e))
}

// ── Turn checkpoints ─────────────────────────────────────────────────────────

/// `replayTurnJournal` (`v145:turn-checkpoint-journal.mjs:754`): the header with its
/// delta journal merged.
fn replay_journal(header: &Map<String, Value>, journal: Option<&[u8]>, replaced: &mut u64) -> Value {
    let Some(raw) = journal else {
        return Value::Object(header.clone());
    };
    let mut messages: Vec<Value> = header["turnMessages"].as_array().cloned().unwrap_or_default();
    let mut sealed = header.get("sealed") == Some(&Value::Bool(true));
    let mut full = header.get("fullTranscript") == Some(&Value::Bool(true));
    let mut context = header.get("contextState").cloned().unwrap_or(Value::Null);
    let snap = header.get("interruption").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut started = snap.get("responseStarted") == Some(&Value::Bool(true));
    let str_of = |v: Option<&Value>| match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => json::js_to_string(v),
    };
    let mut text = str_of(snap.get("partialAssistantContent"));
    let mut tomb = String::new();
    let mut reasoning = str_of(snap.get("partialReasoningContent"));
    let mut phase = if snap.get("phase").and_then(Value::as_str) == Some("tools") { "tools" } else { "streaming" };
    let pairs = |v: Option<&Value>| -> Vec<(Value, Value)> {
        v.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| match p.as_array().map(Vec::as_slice) {
                        Some([k, v]) => Some((k.clone(), v.clone())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let set = |map: &mut Vec<(Value, Value)>, k: Value, v: Value| match map.iter_mut().find(|(x, _)| *x == k) {
        Some(slot) => slot.1 = v,
        None => map.push((k, v)),
    };
    let mut calls = Vec::new();
    for (k, v) in pairs(snap.get("observedToolCalls")) {
        set(&mut calls, k, v);
    }
    let mut results = Vec::new();
    for (k, v) in pairs(snap.get("observedToolResults")) {
        set(&mut results, k, v);
    }
    let mut updated = js_number_of(header.get("updatedAt"));
    if updated.is_nan() {
        updated = 0.0;
    }
    let mut head = false;
    let mut expected = 0f64;
    for line in raw.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(parsed) = json::parse_source(line) else { continue };
        *replaced += parsed.replaced_surrogates;
        let r = parsed.value;
        if !r.is_object() {
            continue;
        }
        let seq = js_number_of(r.get("s"));
        if seq.fract() != 0.0 || seq.is_nan() || seq < 0.0 || seq < expected {
            continue;
        }
        if seq > expected {
            break;
        }
        expected = seq + 1.0;
        if !head {
            let epoch = |v: Option<&Value>| {
                let n = js_number_of(v);
                if n.is_nan() { 0.0 } else { n }
            };
            if r.get("t").and_then(Value::as_str) != Some("h")
                || r.get("turnToken") != header.get("turnToken")
                || epoch(r.get("e")) != epoch(header.get("journalEpoch"))
            {
                return Value::Object(header.clone());
            }
            head = true;
            continue;
        }
        match r.get("t").and_then(Value::as_str) {
            Some("m") => {
                let i = js_number_of(r.get("i"));
                if i.fract() == 0.0 && i >= 0.0 && (i as usize) <= messages.len() {
                    let m = r.get("m").cloned().unwrap_or(Value::Null);
                    if (i as usize) == messages.len() {
                        messages.push(m);
                    } else {
                        messages[i as usize] = m;
                    }
                }
            }
            Some("seal") => sealed = true,
            Some("full") => {
                if let Some(Value::Array(ms)) = r.get("ms") {
                    messages = ms.clone();
                    full = true;
                }
            }
            Some("len") => {
                let n = js_number_of(r.get("n"));
                if n.fract() == 0.0 && n >= 0.0 && (n as usize) <= messages.len() {
                    messages.truncate(n as usize);
                }
            }
            Some("x") => {
                if let Some(d) = r.get("d").filter(|d| d.is_object()) {
                    if let Some(Value::Bool(b)) = d.get("rs") {
                        started = *b;
                    }
                    match d.get("ph").and_then(Value::as_str) {
                        Some("tools") => phase = "tools",
                        Some("streaming") => phase = "streaming",
                        _ => {}
                    }
                    if let Some(Value::String(s)) = d.get("ts") {
                        text = s.clone();
                    }
                    if let Some(Value::String(s)) = d.get("ta") {
                        text.push_str(s);
                    }
                    if let Some(Value::String(s)) = d.get("qs") {
                        reasoning = s.clone();
                    }
                    if let Some(Value::String(s)) = d.get("qa") {
                        reasoning.push_str(s);
                    }
                    if let Some(Value::String(s)) = d.get("tb") {
                        tomb = s.clone();
                    }
                    if d.get("cc") == Some(&Value::Bool(true)) {
                        calls.clear();
                    }
                    for (k, v) in pairs(d.get("cs")) {
                        set(&mut calls, k, v);
                    }
                    for (k, v) in pairs(d.get("os")) {
                        set(&mut results, k, v);
                    }
                    for id in d.get("od").and_then(Value::as_array).into_iter().flatten() {
                        results.retain(|(k, _)| k != id);
                    }
                }
            }
            Some("c") => context = r.get("c").cloned().unwrap_or(Value::Null),
            _ => {}
        }
        let at = js_number_of(r.get("at"));
        if at.is_finite() && at > updated {
            updated = at;
        }
    }
    if !head {
        return Value::Object(header.clone());
    }
    let mut out = header.clone();
    out.insert("turnMessages".into(), Value::Array(messages));
    if sealed {
        out.insert("sealed".into(), Value::Bool(true));
    }
    if full {
        out.insert("fullTranscript".into(), Value::Bool(true));
    }
    let pairs_value = |p: Vec<(Value, Value)>| Value::Array(p.into_iter().map(|(k, v)| Value::Array(vec![k, v])).collect());
    out.insert(
        "interruption".into(),
        serde_json::json!({
            "responseStarted": started,
            "partialAssistantContent": format!("{text}{tomb}"),
            "partialReasoningContent": reasoning,
            "phase": phase,
            "observedToolCalls": pairs_value(calls),
            "observedToolResults": pairs_value(results),
        }),
    );
    out.insert("contextState".into(), context);
    out.insert("updatedAt".into(), mixdog_js::json_number(updated));
    Value::Object(out)
}

/// The checkpoint disposition (SM §11.4.4), 1.4.5's own ([`super::splice`]): `None` =
/// covered (or no checkpoint), else the recovered turn's messages (none for an unrecovered
/// one) and its run. A recovered turn is spliced into the session as 1.4.5 recovery does:
/// `session_messages` keep the turn's boundary and `session_header` its restored context.
fn checkpoint(
    id: &str,
    session_header: &mut Header,
    session_messages: &mut Vec<Value>,
    header: Option<&[u8]>,
    journal: Option<&[u8]>,
    blobs: &ContextBlobs<'_, '_>,
    replaced: &mut u64,
) -> R<Option<(Vec<Value>, RunModel)>> {
    let Some(text) = header else {
        return Ok(None);
    };
    let unrecovered = |rid: String, checkpoint: Value, at: Option<i64>| {
        Ok(Some((
            Vec::new(),
            RunModel { rid, at, phases: vec![(RunPhase::Interrupted, Some(serde_json::json!({"unrecovered": true, "checkpoint": checkpoint})))] },
        )))
    };
    let parsed = json::parse_source(text).ok();
    let valid = parsed.as_ref().and_then(|p| {
        let h = p.value.as_object()?;
        (h.get("version").and_then(Value::as_f64) == Some(1.0)
            && h.get("sessionId").and_then(Value::as_str) == Some(id)
            && json::js_truthy(h.get("turnToken"))
            && h.get("turnMessages").is_some_and(Value::is_array))
        .then_some(h)
    });
    let Some(h) = valid else {
        let key = &crate::durable::sha256_hex(text)[..16];
        let body = match &parsed {
            Some(p) => {
                *replaced += p.replaced_surrogates;
                p.value.clone()
            }
            None => Value::String(String::from_utf8_lossy(text).into_owned()),
        };
        return unrecovered(format!("ckpt:{key}"), body, None);
    };
    *replaced += parsed.as_ref().map_or(0, |p| p.replaced_surrogates);
    let folded = replay_journal(h, journal, replaced);
    let rid = format!("ckpt:{}", json::js_to_string(&h["turnToken"]));
    let at = h.get("startedAt").and_then(Value::as_i64);
    let folded_header = folded.as_object().expect("a folded checkpoint is its header, merged");
    let turn = match splice(session_header, session_messages, folded_header, blobs)? {
        Splice::Covered => return Ok(None),
        Splice::Conflict => return unrecovered(rid, folded, at),
        Splice::Replay { keep, turn } => {
            // A save of the same turn made after it opened gives way to the checkpoint's copy.
            session_messages.truncate(keep);
            turn
        }
    };
    // The recovery's `Date.now()`: the latest time the checkpoint records, so a rerun
    // converts identically.
    let now = ["updatedAt", "startedAt"].into_iter().map(|key| js_number_of(folded.get(key))).filter(|n| n.is_finite()).fold(0.0, f64::max);
    let rows: Vec<Value> = session_messages.iter().chain(&turn).cloned().collect();
    restore_header(session_header, &rows, &folded, blobs, now)?;
    let interruption = folded.get("interruption").cloned();
    Ok(Some((turn, RunModel { rid, at, phases: vec![(RunPhase::Started, None), (RunPhase::Interrupted, interruption)] })))
}

// ── Shared spools and worker indexes ─────────────────────────────────────────

#[derive(Deserialize)]
struct Released<'a> {
    #[serde(borrow, default)]
    released: Option<&'a RawValue>,
}

/// An index's `workers` or `tombstones`: a list as is, or an object's values in
/// `Object.values` order (integer-like keys first); anything else has none (`workerRows`,
/// `store-agent-worker-rows.mjs`; `normalizeTagTombstones`, `worker-rows.mjs:73`).
fn index_rows(raw: Option<&RawValue>) -> serde_json::Result<Vec<&RawValue>> {
    match raw.map(|r| r.get().trim_start()) {
        Some(text) if text.starts_with('[') => serde_json::from_str(text),
        Some(text) if text.starts_with('{') => {
            let rows: IndexMap<String, &RawValue> = serde_json::from_str(text)?;
            let keys: Map<String, Value> = rows.keys().map(|k| (k.clone(), Value::Null)).collect();
            Ok(js_object_keys(&keys).into_iter().map(|k| rows[k.as_str()]).collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// An index's `workers`: a list in its order, or a map's rows by sorted key (of two rows naming one session the
/// first stays); anything else has none.
fn worker_rows(raw: Option<&RawValue>) -> serde_json::Result<Vec<&RawValue>> {
    match raw.map(|r| r.get().trim_start()) {
        Some(text) if text.starts_with('[') => serde_json::from_str(text),
        Some(text) if text.starts_with('{') => {
            let rows: std::collections::BTreeMap<String, &RawValue> = serde_json::from_str(text)?;
            Ok(rows.into_values().collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// Session id → release marker; anything but an object has none (`parseReleased`).
fn released_entries(raw: Option<&RawValue>) -> serde_json::Result<HashMap<String, &RawValue>> {
    match raw.map(|r| r.get().trim_start()) {
        Some(text) if text.starts_with('{') => serde_json::from_str(text),
        _ => Ok(HashMap::new()),
    }
}

// ── Tag tombstones (`worker-rows.mjs`, `agent-reap-state.mjs`) ───────────────

/// The agent tool's `clean`: `String(value ?? '').trim()`.
fn clean_nullish(value: Option<&Value>) -> String {
    js_trim(&js_string(value)).to_string()
}

/// `positiveInt`: `Math.floor(Number(value))` when at least 1.
fn positive_int(value: Option<&Value>) -> Option<f64> {
    let n = value.map_or(f64::NAN, to_number).floor();
    (n.is_finite() && n >= 1.0).then_some(n)
}

/// `stampMs`: a positive number as is, a positive numeric text that does not start like an
/// ISO date, else `Date.parse` of the text when positive; 0 otherwise.
fn stamp_ms(value: Option<&Value>) -> f64 {
    let positive = |n: f64| if n.is_finite() && n > 0.0 { n } else { 0.0 };
    if let Some(Value::Number(n)) = value {
        return positive(n.as_f64().unwrap_or(f64::NAN));
    }
    let text = clean_nullish(value);
    if text.is_empty() {
        return 0.0;
    }
    let iso = text.len() > 4 && text.as_bytes()[..4].iter().all(u8::is_ascii_digit) && text.as_bytes()[4] == b'-';
    let numeric = positive(string_to_number(&text));
    if numeric > 0.0 && !iso {
        return numeric;
    }
    positive(date_parse(&text))
}

/// A session as `recoverTagTombstoneOwner` lists it: its catalog summary row
/// (`store-summary-index.mjs:252-278`) built from its header.
pub struct Candidate {
    id: String,
    tag: String,
    pid: Option<f64>,
    parent: String,
    owner: String,
    created: f64,
}

impl Candidate {
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The header fields [`Self::of`] reads.
    const FIELDS: [&'static str; 5] = ["agentTag", "clientHostPid", "parentSessionId", "ownerSessionId", "createdAt"];

    fn of(id: &str, header: &Header) -> Self {
        let field = |key: &str| header.get(key).filter(|v| json::js_truthy(Some(v)));
        let created = header.get("createdAt").map_or(f64::NAN, to_number);
        Candidate {
            id: id.to_string(),
            tag: clean_nullish(field("agentTag")),
            pid: positive_int(header.get("clientHostPid")),
            parent: clean_nullish(field("parentSessionId").or(field("ownerSessionId"))),
            owner: clean_nullish(field("ownerSessionId").or(field("parentSessionId"))),
            created: if created.is_finite() && created > 0.0 { created } else { 0.0 },
        }
    }
}

/// The `worker` map from a session's row (every field as stored, the store's worker index
/// keys on its owner and `clientHostPid`), its tombstone (`tombstone`, without the
/// `sessionId` the header implies) and its release marker (`releasedAt`).
fn worker_map(row: Option<Value>, tombstone: Option<Value>, released: Option<Value>) -> Map<String, Value> {
    let mut map = match row {
        Some(Value::Object(row)) => row,
        _ => Map::new(),
    };
    // Readers derive it from `releasedAt`.
    map.shift_remove("released");
    if let Some(Value::Object(mut tombstone)) = tombstone {
        tombstone.shift_remove("sessionId");
        map.insert("tombstone".into(), Value::Object(tombstone));
    }
    if let Some(at) = released {
        map.insert("releasedAt".into(), at);
    }
    map
}

/// `cleanValue`: `String(value || '').trim()`.
pub(super) fn clean(value: Option<&Value>) -> String {
    js_trim(&or_str(value, "")).to_string()
}

#[derive(Deserialize)]
struct Index<'a> {
    #[serde(borrow, default)]
    workers: Option<&'a RawValue>,
}

/// The parent link a session without one gets from `agent-workers.json`, as Node's agent
/// listing fills it (`daemon-stored-session-views.mjs:93-97`): of `workerLinks`
/// (`store-agent-worker-rows.mjs:286-302`), the last naming this session sets
/// `parentSessionId` and `ownerSessionId`.
fn parent_link(cx: &ItemContext<'_>, id: &str, header: &Header, shared: &[&SourceFile], replaced: &mut u64) -> R<Option<Header>> {
    if json::js_truthy(header.get("parentSessionId")) {
        return Ok(None);
    }
    let Some(file) = shared.iter().find(|f| f.path == AGENT_WORKERS) else { return Ok(None) };
    let bad = |e: &dyn std::fmt::Display| Fail::Quarantine(QuarantineCode::ParseError, format!("{AGENT_WORKERS}: {e}"));
    let text = String::from_utf8(cx.read_source(file)?).map_err(|e| bad(&e))?;
    let index: Index<'_> = serde_json::from_str(&text).map_err(|e| bad(&e))?;
    let mut link = None;
    for raw in index_rows(index.workers).map_err(|e| bad(&e))? {
        if !raw.get().trim_start().starts_with('{') {
            continue;
        }
        let mut count = 0;
        let row = parse(raw.get().as_bytes(), QuarantineCode::ParseError, AGENT_WORKERS, &mut count)?;
        if clean(row.get("sessionId")) != id {
            continue;
        }
        let parent = clean(row.get("parentSessionId"));
        let owner_field = if json::js_truthy(row.get("ownerSessionId")) { "ownerSessionId" } else { "parentSessionId" };
        let owner = clean(row.get(owner_field));
        if parent.is_empty() && owner.is_empty() {
            continue;
        }
        let (parent, owner) = match (parent.is_empty(), owner.is_empty()) {
            (true, _) => (owner.clone(), owner),
            (_, true) => (parent.clone(), parent),
            _ => (parent, owner),
        };
        link = Some((parent, owner, count));
    }
    let Some((parent, owner, count)) = link else { return Ok(None) };
    *replaced += count;
    let mut set = Map::new();
    set.insert("parentSessionId".into(), Value::String(parent));
    set.insert("ownerSessionId".into(), Value::String(owner));
    Ok(Some(set))
}

/// The `archivedAgentResults` header set of a session that carries the result of a reaped agent child
/// (`super::archived`), read from the link files it consumes; `None` when it carries none.
fn archived_results(cx: &ItemContext<'_>, id: &str, header: &Header, messages: &[Value], shared: &[&SourceFile]) -> R<Option<Header>> {
    let mut texts: [Option<Vec<u8>>; 3] = [None, None, None];
    for (slot, name) in texts.iter_mut().zip(super::archived::LINK_FILES) {
        if let Some(file) = shared.iter().find(|f| f.path == name) {
            *slot = Some(cx.read_source(file)?);
        }
    }
    if texts.iter().all(Option::is_none) {
        return Ok(None);
    }
    let parents = super::archived::parents(texts[0].as_deref(), texts[1].as_deref(), texts[2].as_deref());
    let results = super::archived::results(id, header, messages, &parents, |child| cx.has_item(&format!("session/{child}")));
    if results.is_empty() {
        return Ok(None);
    }
    let mut set = Map::new();
    set.insert(super::archived::HEADER_KEY.into(), Value::Object(results));
    Ok(Some(set))
}

// ── The item ─────────────────────────────────────────────────────────────────

fn source<'a>(item: &'a ManifestItem, rel: &str) -> Option<&'a SourceFile> {
    item.sources.iter().find(|s| s.path == rel)
}

fn message_rows(iids: Vec<String>, messages: Vec<Value>, turn: Option<&str>) -> Vec<Row> {
    messages
        .into_iter()
        .zip(iids)
        .map(|(body, iid)| Row {
            iid,
            turn: turn.map(str::to_string),
            role: role_of(&body),
            form: Form::Message,
            model: true,
            visible: true,
            archive: None,
            prompt: None,
            body,
        })
        .collect()
}

/// Moves the requests a compaction carried over out of `messages` to where they were said among the archived rows.
///
/// 1.4.5 keeps the user's earlier requests in the model context after a compaction and archives what it dropped, so a
/// stored session lists every archived row, then the kept requests one after another with none of their answers between
/// them (`store-transcript-projection.mjs:288`, `[...archived.items, ...restored]`). Only its live view had them in
/// place. A history is read in the order it was written, so the kept requests are written among the archived rows: each
/// before the first shown archived row that is newer than it (rows carry their time: an archived row's `at`, a
/// message's `meta.transcript.at`), a request as old as the newest divider before that divider. A row is one the
/// transcript shows as the user's prompt (`prompt`), sent no later than the newest shown divider; everything else stays
/// where it was.
///
/// The model context is the messages in 1.4.5's order, which the moved rows no longer are: the returned list (every
/// message, in that order) is what the context restarts at. `None` when nothing moved.
fn place_retained(archive: &mut Vec<Row>, messages: &mut Vec<Row>) -> Option<Vec<(String, Value)>> {
    let shown_at = |row: &Row| row.body.get("at").and_then(Value::as_f64).filter(|at| at.is_finite());
    let is_divider = |row: &Row| row.body.get("status").and_then(Value::as_str) == Some("compacted");
    let said_at = |row: &Row| row.body.pointer("/meta/transcript/at").and_then(Value::as_f64).filter(|at| at.is_finite());
    let newest_divider = archive
        .iter()
        .filter(|row| row.visible && is_divider(row))
        .filter_map(shown_at)
        .fold(None, |max: Option<f64>, at| Some(max.map_or(at, |m| m.max(at))))?;
    let retained =
        |row: &Row| row.visible && row.prompt.is_some() && row.role.as_deref() == Some("user") && said_at(row).is_some_and(|at| at <= newest_divider);
    if !messages.iter().any(retained) {
        return None;
    }
    let context: Vec<(String, Value)> = messages.iter().map(|row| (row.iid.clone(), row.body.clone())).collect();
    let (mut moved, kept): (Vec<Row>, Vec<Row>) = std::mem::take(messages).into_iter().partition(retained);
    *messages = kept;
    // Oldest first; requests of one instant keep the order they were said in.
    moved.sort_by(|a, b| said_at(a).partial_cmp(&said_at(b)).unwrap_or(std::cmp::Ordering::Equal));
    let mut moved = moved.into_iter().peekable();
    let mut placed = Vec::with_capacity(archive.len() + moved.len());
    for row in std::mem::take(archive) {
        if let Some(at) = shown_at(&row).filter(|_| row.visible) {
            while let Some(request) = moved.next_if(|request| said_at(request).is_some_and(|said| said < at || (said == at && is_divider(&row)))) {
                placed.push(request);
            }
        }
        placed.push(row);
    }
    placed.extend(moved);
    *archive = placed;
    Some(context)
}

#[cfg(test)]
mod archive_damage_tests {
    use super::*;

    fn segment(seq: u64) -> String {
        let items = r#"[{"id":"m1","role":"assistant"}]"#;
        format!(r#"{{"v":1,"seq":{seq},"id":"seg{seq}","prev":null,"at":5,"count":1,"bytes":{},"items":{items}}}"#, items.len())
    }

    fn committing(next_seq: u64) -> Header {
        let mut header = Header::new();
        header.insert("compaction".into(), serde_json::json!({ "archive": { "nextSeq": next_seq } }));
        header
    }

    /// Validity of the sidecar is `Number.isInteger(seq)` and a messages array, nothing more; which
    /// jobs migrate is the record's: one it does not commit (`seq >= nextSeq`) is discarded, a number
    /// beyond 2^53 included, and the committed job still migrates.
    #[test]
    fn a_job_the_record_does_not_commit_is_discarded_not_the_sidecar() {
        let pending = r#"{"jobs":[{"seq":1,"messages":[{"role":"user","content":"x"}]},{"seq":9007199254740992,"messages":[]}]}"#;
        let (mut replaced, mut damage) = (0u64, Vec::new());
        let (rows, _) = archive_rows("sess_a", &committing(2), None, Some(pending.as_bytes()), &mut replaced, &mut damage)
            .expect("both jobs are integers with messages: the sidecar is valid");
        let seqs: Vec<u64> = rows.iter().filter_map(|row| row.archive.as_ref().map(|tag| tag.seq)).collect();
        assert_eq!(seqs, [1]);
        assert_eq!(damage.len(), 1);
        assert_eq!(damage[0]["line"], 2);
        assert_eq!(damage[0]["why"], "its compaction was never saved in the session record");
    }

    /// Only `seq` and `messages` make a job valid; a divider, `at`, `clearedThrough` or `maxBytes`
    /// that does not conform takes what its reader made of it, and the job migrates.
    #[test]
    fn a_pending_job_with_unusable_optional_fields_still_migrates() {
        let pending = r#"{"jobs":[{"seq":3,"messages":[{"role":"user","content":"x"}],"divider":"yes","at":"7.9","clearedThrough":"a","maxBytes":-1}]}"#;
        let (mut replaced, mut damage) = (0u64, Vec::new());
        let (rows, _) = archive_rows("sess_a", &committing(4), None, Some(pending.as_bytes()), &mut replaced, &mut damage)
            .expect("the sidecar is valid: only seq and messages count");
        assert!(damage.is_empty());
        let tag = rows[0].archive.as_ref().expect("an archive row");
        assert_eq!(tag.seq, 3);
        assert_eq!(tag.at, Some(Number::from(7u64)));
        assert!(matches!(&tag.origin, ArchiveOrigin::Pending { divider: true, cleared_through: None, max_bytes: None }));
    }

    /// One damaged archive line is skipped alone; one job without `seq`/`messages` sets the whole
    /// pending sidecar aside (its valid job too, as the earlier version read it). The session
    /// converts, and each skipped part is recorded with its place and why.
    #[test]
    fn a_damaged_archive_part_is_skipped_and_recorded_not_fatal() {
        let archive = format!("{}\n{{not json\n{}\n", segment(1), segment(2));
        let pending = r#"{"jobs":[{"seq":3,"messages":[{"role":"user","content":"x"}]},{"seq":"four","messages":[]}]}"#;
        let (mut replaced, mut damage) = (0u64, Vec::new());
        let (rows, superseded) = archive_rows("sess_a", &Header::new(), Some(archive.as_bytes()), Some(pending.as_bytes()), &mut replaced, &mut damage)
            .expect("a damaged part does not fail the session");
        assert!(superseded.is_empty());
        let seqs: Vec<u64> = rows.iter().filter_map(|row| row.archive.as_ref().map(|tag| tag.seq)).collect();
        assert_eq!(seqs, [1, 2], "job 3 goes with its sidecar");
        let places: Vec<(String, u64)> = damage.iter().map(|d| (d["file"].as_str().unwrap().to_owned(), d["line"].as_u64().unwrap())).collect();
        assert_eq!(places, [("archive".to_owned(), 2), ("pending".to_owned(), 0)]);
        assert_eq!(damage[0]["text"], "{not json");
        assert_eq!(damage[1]["text"], pending, "the whole sidecar is what was skipped");
    }
}

#[cfg(test)]
mod place_retained_tests {
    use serde_json::json;

    use super::*;

    fn archived(id: &str, body: Value) -> Row {
        Row { iid: id.into(), turn: None, role: None, form: Form::Display, model: false, visible: true, archive: None, prompt: None, body }
    }

    fn message(id: &str, role: &str, at: Option<i64>, prompt: bool) -> Row {
        let mut body = json!({ "role": role, "content": id });
        if let Some(at) = at {
            body["meta"] = json!({ "transcript": { "messageId": id, "at": at } });
        }
        Row {
            iid: id.into(),
            turn: None,
            role: Some(role.into()),
            form: Form::Message,
            model: true,
            visible: true,
            archive: None,
            prompt: prompt.then(|| id.to_owned()),
            body,
        }
    }

    fn ids(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|row| row.iid.as_str()).collect()
    }

    #[test]
    fn a_request_a_compaction_carried_over_is_written_where_it_was_said() {
        let mut archive = vec![
            archived("a1", json!({ "kind": "assistant", "at": 10 })),
            archived("t1", json!({ "kind": "tool" })), // a row without a time stays with the row before it
            archived("a2", json!({ "kind": "assistant", "at": 30 })),
            archived("d1", json!({ "kind": "statusdone", "status": "compacted", "at": 40 })),
        ];
        let mut summary = message("sum", "user", Some(41), false);
        summary.visible = false;
        let mut messages = vec![
            summary,
            message("u1", "user", Some(5), true),
            message("u2", "user", Some(20), true),
            message("u3", "user", Some(40), true), // as old as the divider: the compaction carried it too
            message("kept", "assistant", Some(35), false),
            message("u4", "user", Some(50), true), // said after the compaction
        ];
        let context = place_retained(&mut archive, &mut messages).expect("rows moved");
        assert_eq!(ids(&archive), ["u1", "a1", "t1", "u2", "a2", "u3", "d1"]);
        assert_eq!(ids(&messages), ["sum", "kept", "u4"], "what the compaction did not carry over stays in its order");
        // The context is 1.4.5's: every message, in the order it held them.
        assert_eq!(context.iter().map(|(iid, _)| iid.as_str()).collect::<Vec<_>>(), ["sum", "u1", "u2", "u3", "kept", "u4"]);
        assert!(archive.iter().filter(|row| row.form == Form::Message).all(|row| row.model && row.visible), "a moved row is the message itself");
    }

    #[test]
    fn a_session_with_no_shown_divider_or_no_carried_request_is_left_as_it_is() {
        let mut archive = vec![archived("a1", json!({ "kind": "assistant", "at": 10 }))];
        let mut messages = vec![message("u1", "user", Some(5), true)];
        assert_eq!(place_retained(&mut archive, &mut messages), None, "no divider");
        archive.push(archived("d1", json!({ "kind": "statusdone", "status": "compacted", "at": 40 })));
        let mut later = vec![message("u9", "user", Some(50), true), message("n", "user", None, true)];
        assert_eq!(place_retained(&mut archive, &mut later), None, "nothing said before the divider");
        assert_eq!((ids(&archive), ids(&later)), (vec!["a1", "d1"], vec!["u9", "n"]));
    }
}

#[cfg(test)]
mod worker_index_tests {
    use super::*;

    /// A worker index names its rows' sessions as a list (in its order) or as an id-keyed map (by sorted key).
    #[test]
    fn a_worker_index_names_its_rows_sessions_as_a_list_or_as_a_map() {
        let map = r#"{"version":2,"workers":{"sess_b":{"sessionId":"sess_b"},"sess_a":{"sessionId":"sess_a"}}}"#;
        let list = r#"{"version":1,"workers":[{"sessionId":"sess_2"},{"sessionId":"sess_1"}]}"#;
        for (case, (text, shape)) in [(map, "map"), (list, "list")].into_iter().enumerate() {
            let parsed: Value = serde_json::from_str(text).unwrap();
            let want: Vec<String> = match &parsed["workers"] {
                Value::Array(rows) => {
                    assert_eq!(shape, "list");
                    rows.iter().map(|row| row["sessionId"].as_str().unwrap().to_owned()).collect()
                }
                Value::Object(rows) => {
                    assert_eq!(shape, "map");
                    let mut keyed: Vec<(&String, &Value)> = rows.iter().collect();
                    keyed.sort_by(|a, b| a.0.cmp(b.0));
                    keyed.into_iter().map(|(_, row)| row["sessionId"].as_str().unwrap().to_owned()).collect()
                }
                other => panic!("case {case}: workers is {other}"),
            };
            assert!(!want.is_empty(), "case {case}");
            assert_eq!(worker_row_session_ids(text.as_bytes()), want, "case {case} ({shape}): the rows' sessions");
            let (named, _) = shared_session_ids(AGENT_WORKERS, text.as_bytes()).expect("the index parses");
            assert_eq!(named[..want.len()], want[..], "case {case} ({shape}): the sessions the shared file names");
        }
    }
}

/// The dev reader's fold (`dev:session-log-reader.mjs` `parseSessionLog`): a line that holds
/// no record of ours (blank, not JSON, not a record, of an unknown kind) is skipped as Node
/// skips it, and a sequence or length break ends the replay there, keeping what came before as Node
/// does; a log with no `session` + `compacted` base is `schema_violation`. A line is decoded as UTF-8
/// with U+FFFD for invalid bytes, as Node's `toString('utf8')` does; a CR before the LF is JSON
/// white space. A final line without LF is a torn tail and is excluded.
///
/// The log is read one line at a time and folded as it goes: a `compacted` record replaces the
/// messages, so what is held is the working history plus the longest line, never the file
/// (a 1.4.5 log repeats the whole history in every `compacted` record and reaches hundreds of
/// MB). The result is the fold of the bytes read, not yet proven to be the manifest's: the
/// caller `verify`s the handle before it uses it.
fn chained_length(record: &Map<String, Value>, expected: usize, t: &str, length: u64) -> Option<u64> {
    let misplaced = count_of(record.get("s")) != Some(expected as u64)
        || (expected == 0 && t != "session")
        || (expected == 1 && t != "compacted")
        || (expected > 0 && t == "session");
    if misplaced {
        return None;
    }
    let len = count_of(record.get("len"));
    let mlen = record.get("messages").and_then(Value::as_array).map_or(0, |m| m.len() as u64);
    match t {
        "compacted" => len,
        "append" => len.filter(|l| *l == length + mlen),
        "edit" => {
            let at = count_of(record.get("at")).unwrap_or(0);
            let del = count_of(record.get("del")).unwrap_or(0);
            len.filter(|l| at + del <= length && *l + del == length + mlen)
        }
        "rollback" => len.filter(|l| *l <= length),
        _ => Some(length),
    }
}

pub fn fold_log(id: &str, log: &mut durable::OpenFile, replaced: &mut u64) -> R<LogFold> {
    fold_log_as(id, log, replaced, Messages::Whole)
}

/// What a read keeps of each message.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Messages<'a> {
    Whole,
    /// A `null` in the place of each, and of the header only the fields named: the count and those fields are the
    /// read's, at a fraction of the memory and the time (a stored header carries the session's whole context, and every
    /// change of it is a line of the log).
    Narrowed(&'a [&'a str]),
}

impl Messages<'_> {
    fn parse(self, text: &[u8]) -> std::result::Result<json::Parsed, String> {
        match self {
            Messages::Whole => json::parse_source(text),
            Messages::Narrowed(keep) => json::parse_source_narrowed(text, keep),
        }
    }
}

fn fold_log_as(id: &str, log: &mut durable::OpenFile, replaced: &mut u64, messages_as: Messages<'_>) -> R<LogFold> {
    let mut line = Vec::new();
    // Lines accepted so far, which is also the sequence number the next one must carry.
    let mut accepted = 0usize;
    let mut length: u64 = 0;
    let mut base_id = String::new();
    let mut header = Header::default();
    let mut legacy = None;
    let mut messages: Vec<Value> = Vec::new();
    loop {
        line.clear();
        log.read_line_into(&mut line)?;
        // Every complete line ends with LF; the bytes after the last LF are the torn tail.
        if line.pop() != Some(b'\n') {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let Ok(parsed) = messages_as.parse(text.as_bytes()) else { continue };
        let value = parsed.value;
        let Some(record) = decode_record(&value) else { continue };
        let t = record["t"].as_str().unwrap_or("").to_owned();
        let Some(next) = chained_length(record, accepted, &t, length) else { break };
        length = next;
        *replaced += parsed.replaced_surrogates;
        let Value::Object(mut record) = value else {
            unreachable!("decode_record admits only objects");
        };
        // `length` is the validated length of `messages`, so every index below is in range.
        let take_messages = |r: &mut Map<String, Value>| match r.shift_remove("messages") {
            Some(Value::Array(m)) => m,
            _ => Vec::new(),
        };
        match t.as_str() {
            "session" => {
                base_id = record["id"].as_str().unwrap_or("").to_owned();
                header = match record.shift_remove("header") {
                    Some(Value::Object(h)) => h,
                    _ => Header::default(),
                };
                legacy = record.get("legacy").and_then(Value::as_object).map(|l| Legacy {
                    sha1: l["sha1"].as_str().unwrap_or("").to_string(),
                    redacted_from: l.get("redactedFrom").and_then(Value::as_str).map(str::to_string),
                });
            }
            "compacted" => messages = take_messages(&mut record),
            "append" => messages.extend(take_messages(&mut record)),
            "edit" => {
                let at = count_of(record.get("at")).unwrap_or(0) as usize;
                let del = count_of(record.get("del")).unwrap_or(0) as usize;
                messages.splice(at..at + del, take_messages(&mut record));
            }
            "rollback" => messages.truncate(count_of(record.get("len")).unwrap_or(0) as usize),
            "patch" => {
                for k in record["unset"].as_array().into_iter().flatten() {
                    header.shift_remove(k.as_str().unwrap_or(""));
                }
                for (k, v) in record["set"].as_object().into_iter().flatten() {
                    header.insert(k.clone(), v.clone());
                }
            }
            _ => {}
        }
        accepted += 1;
    }
    if accepted < 2 {
        return q(QuarantineCode::SchemaViolation, "log has no session + compacted base");
    }
    if base_id != id {
        return q(QuarantineCode::IdMismatch, format!("log base names {base_id}"));
    }
    Ok(LogFold { header, messages, legacy })
}
/// Segment rows and pending-job rows in seq order (SM §11.4.3).
fn archive_rows(
    id: &str,
    header: &Header,
    archive: Option<&[u8]>,
    pending: Option<&[u8]>,
    replaced: &mut u64,
    damage: &mut Vec<Value>,
) -> R<(Vec<Row>, Vec<u64>)> {
    let range = archive_range(header);
    let mut entries = Vec::new();
    let segment_seqs = segment_entries(archive, range, replaced, damage, &mut entries)?;
    let superseded = pending_entries(id, header, pending, range, &segment_seqs, replaced, damage, &mut entries)?;
    entries.sort_by_key(|(seq, kind, _)| (*seq, *kind));
    Ok((entries.into_iter().flat_map(|(_, _, rows)| rows).collect(), superseded))
}

type ArchiveEntries = Vec<(u64, u8, Vec<Row>)>;

fn segment_entries(
    archive: Option<&[u8]>,
    range: Option<(f64, f64)>,
    replaced: &mut u64,
    damage: &mut Vec<Value>,
    entries: &mut ArchiveEntries,
) -> R<BTreeSet<u64>> {
    let mut segment_seqs = BTreeSet::new();
    let Some(text) = archive else { return Ok(segment_seqs) };
    for (n, line) in text.split(|&b| b == b'\n').enumerate() {
        if line.is_empty() {
            continue;
        }
        let what = format!("archive line {}", n + 1);
        match segment_rows(line, &what, range, replaced) {
            Ok((seq, rows)) => {
                segment_seqs.insert(seq);
                entries.push((seq, 0, rows));
            }
            Err(Fail::Quarantine(_, detail)) => damage.push(skipped("archive", n + 1, &detail, line)),
            Err(blocked) => return Err(blocked),
        }
    }
    Ok(segment_seqs)
}

#[allow(clippy::too_many_arguments)]
fn pending_entries(
    id: &str,
    header: &Header,
    pending: Option<&[u8]>,
    range: Option<(f64, f64)>,
    segment_seqs: &BTreeSet<u64>,
    replaced: &mut u64,
    damage: &mut Vec<Value>,
    entries: &mut ArchiveEntries,
) -> R<Vec<u64>> {
    let mut superseded = Vec::new();
    let Some(text) = pending else { return Ok(superseded) };
    match parse(text, QuarantineCode::ArchiveParseError, "pending jobs", replaced) {
        Err(Fail::Quarantine(_, detail)) => damage.push(skipped("pending", 0, &detail, text)),
        Err(blocked) => return Err(blocked),
        // The sidecar is one unit, as the earlier version read it (`parsePendingJobs`): one
        // damaged job sets the whole file aside.
        Ok(doc) => match pending_jobs(&doc) {
            Ok(jobs) => {
                let committed = committed_seq(header);
                for (n, job) in jobs.iter().enumerate() {
                    let part = |why: &str| skipped("pending", n + 1, why, job.to_string().as_bytes());
                    // `recoverPending`: a job its session record does not commit was never saved
                    // with its compaction and is discarded, whatever its number.
                    if integer_seq(job.get("seq")).is_some_and(|seq| seq >= committed) {
                        damage.push(part("its compaction was never saved in the session record"));
                        continue;
                    }
                    match pending_job_rows(id, job, range) {
                        Ok((seq, _)) if segment_seqs.contains(&seq) => superseded.push(seq),
                        Ok((seq, rows)) => entries.push((seq, 1, rows)),
                        Err(Fail::Quarantine(_, detail)) => damage.push(part(&detail)),
                        Err(blocked) => return Err(blocked),
                    }
                }
            }
            Err(Fail::Quarantine(_, detail)) => damage.push(skipped("pending", 0, &detail, text)),
            Err(blocked) => return Err(blocked),
        },
    }
    Ok(superseded)
}
#[derive(Deserialize)]
struct Workers<'a> {
    /// A list or an id-keyed map (`workerRows`, `store-agent-worker-rows.mjs:269`).
    #[serde(borrow, default)]
    workers: Option<&'a RawValue>,
    #[serde(borrow, default)]
    tombstones: Option<&'a RawValue>,
}
/// The session ids of a worker index's rows (`agent-workers.json`, `lead-workers.json`); none when it does not parse. Node lists
/// a row whose session has no record with a null header (`store-agent-worker-rows.mjs:615`), so each is a session of its own.
pub fn worker_row_session_ids(bytes: &[u8]) -> Vec<String> {
    let Some(workers) = std::str::from_utf8(bytes).ok().and_then(|text| serde_json::from_str::<Workers<'_>>(text).ok()) else {
        return Vec::new();
    };
    worker_rows(workers.workers)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|raw| json::parse_source(raw.get().as_bytes()).ok())
        .filter_map(|row| row.value.get("sessionId").and_then(Value::as_str).filter(|id| is_session_id(id)).map(str::to_owned))
        .collect()
}
/// What a shared file names: the session ids (`sessions` keys of a spool; `sessionId` of
/// worker rows and tombstones; keys of the release markers) and the tombstones without a
/// `sessionId`, whose session `recover_owner` finds. `None` when the file does not parse.
pub fn shared_session_ids(name: &str, bytes: &[u8]) -> Option<(Vec<String>, Vec<Value>)> {
    if pending::is_spool(name) {
        return Some((pending::owners(bytes)?, Vec::new()));
    }
    let text = std::str::from_utf8(bytes).ok()?;
    if name.ends_with(AGENT_RELEASED) {
        let doc: Released<'_> = serde_json::from_str(text).ok()?;
        Some((released_entries(doc.released).ok()?.into_keys().collect(), Vec::new()))
    } else if name.ends_with(AGENT_WORKERS) || name.ends_with(LEAD_WORKERS) {
        let workers: Workers<'_> = serde_json::from_str(text).ok()?;
        let mut ids = Vec::new();
        for raw in worker_rows(workers.workers).ok()? {
            let row = json::parse_source(raw.get().as_bytes()).ok()?.value;
            if let Some(id) = row.get("sessionId").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
            // The parent link matches the cleaned id (`parent_link`).
            let linked = clean(row.get("sessionId"));
            if row.get("sessionId").and_then(Value::as_str) != Some(linked.as_str()) {
                ids.push(linked);
            }
        }
        let mut ownerless = Vec::new();
        for raw in index_rows(workers.tombstones).ok()? {
            let row = json::parse_source(raw.get().as_bytes()).ok()?.value;
            match clean_nullish(row.get("sessionId")) {
                id if !id.is_empty() => ids.push(id),
                _ if row.is_object() => ownerless.push(row),
                _ => {}
            }
        }
        Some((ids, ownerless))
    } else {
        None
    }
}
/// A session's file by its path under `<D>`: a journaled source, or the bare path the plan lists.
pub trait DataPath {
    fn data_path(&self) -> &str;
}

impl DataPath for SourceFile {
    fn data_path(&self) -> &str {
        &self.path
    }
}

impl DataPath for String {
    fn data_path(&self) -> &str {
        self
    }
}

/// Every migrating session as a `Candidate`; one whose header does not read is none.
pub fn session_candidates<'a, F: DataPath + 'a>(
    sessions: impl IntoIterator<Item = (&'a str, &'a [F])>,
    // A session whose header the caller already read: its record is not read again.
    known: impl Fn(&str) -> Option<Header>,
    mut read: impl FnMut(&str, &F) -> crate::error::Result<Vec<u8>>,
    mut open: impl FnMut(&str, &F) -> crate::error::Result<durable::OpenFile>,
) -> crate::error::Result<Vec<Candidate>> {
    let mut out = Vec::new();
    for (id, sources) in sessions {
        if let Some(header) = known(id) {
            out.push(Candidate::of(id, &header));
            continue;
        }
        let find = |suffix: &str| {
            let rel = format!("sessions/{id}{suffix}");
            sources.iter().find(|s| s.data_path() == rel)
        };
        let json = find(JSON_SUFFIX).map(|f| read(id, f)).transpose()?;
        let log = find(LOG_SUFFIX).map(|f| open(id, f)).transpose()?;
        if let Ok((header, _)) = header_and_messages(id, json.as_deref(), log, &mut 0) {
            out.push(Candidate::of(id, &header));
        }
    }
    Ok(out)
}
/// The session `recoverTagTombstoneOwner` (`worker-rows.mjs:47-71`) gives a tombstone
/// without a `sessionId`, read as `normalizeTagTombstones` (`:73-101`) reads it (a tag, a
/// parsed `reapedAt` clamped to now; no TTL here, readers apply it): when the tombstone
/// names no owner, the one session under its tag and terminal, with an owner, created by
/// its reap. `None` when that is not exactly one.
pub fn recover_owner<'a>(row: &Value, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    let row = row.as_object()?;
    let tag = clean_nullish(row.get("tag"));
    let reaped = date_parse(&clean_nullish(row.get("reapedAt")));
    let owned = !clean_nullish(row.get("parentSessionId")).is_empty() || !clean_nullish(row.get("ownerSessionId")).is_empty();
    if tag.is_empty() || !(reaped.is_finite() && reaped > 0.0) || owned {
        return None;
    }
    let reaped = reaped.min(now_ms());
    let pid = positive_int(row.get("clientHostPid"))?;
    let mut found = candidates.iter().filter(|c| c.tag == tag && c.pid == Some(pid) && !c.parent.is_empty() && c.created > 0.0 && c.created <= reaped);
    let one = found.next()?;
    found.next().is_none().then_some(one)
}
fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}
/// The `worker` header map of this session (SM §11.4.6): its worker row (agent index wins
/// over lead), the reaper's tombstone of it and its owner's release marker, all verbatim
/// (readers apply Node's TTL).
fn worker(cx: &ItemContext<'_>, id: &str, header: &Header, shared: &[&SourceFile], replaced: &mut u64) -> R<Option<Header>> {
    let bad = |name: &str, e: &dyn std::fmt::Display| Fail::Quarantine(QuarantineCode::ParseError, format!("{name}: {e}"));
    let read = |name: &str| -> R<Option<String>> {
        let Some(file) = shared.iter().find(|f| f.path == name) else { return Ok(None) };
        String::from_utf8(cx.read_source(file)?).map(Some).map_err(|e| bad(name, &e))
    };
    let own = [Candidate::of(id, header)];
    let mut all: Option<Vec<Candidate>> = None;
    let mut row = None;
    // Of two tombstones of this session the newer `reapedAt` stays.
    let mut tombstone: Option<(f64, Value)> = None;
    for name in [AGENT_WORKERS, LEAD_WORKERS] {
        let Some(text) = read(name)? else { continue };
        let workers: Workers<'_> = serde_json::from_str(&text).map_err(|e| bad(name, &e))?;
        if row.is_none() {
            for raw in worker_rows(workers.workers).map_err(|e| bad(name, &e))? {
                let mut count = 0;
                let found = parse(raw.get().as_bytes(), QuarantineCode::ParseError, name, &mut count)?;
                if found.get("sessionId").and_then(Value::as_str) == Some(id) {
                    *replaced += count;
                    row = Some(found);
                    break;
                }
            }
        }
        for raw in index_rows(workers.tombstones).map_err(|e| bad(name, &e))? {
            let mut count = 0;
            let mut entry = parse(raw.get().as_bytes(), QuarantineCode::ParseError, name, &mut count)?;
            let sid = clean_nullish(entry.get("sessionId"));
            if sid.is_empty() {
                // Only when this session could own it are the others read.
                if recover_owner(&entry, &own).is_none() {
                    continue;
                }
                if all.is_none() {
                    // A session no converter has reached yet has its sources journaled here, and is converted from them later.
                    let sessions: Vec<_> = cx
                        .manifest
                        .items
                        .iter()
                        .filter(|i| i.kind == ItemKind::Session)
                        .filter_map(|i| Some((i.key.as_str().strip_prefix("session/")?, cx.sources_of(i))))
                        .map(|(id, sources)| sources.map(|sources| (id, sources)))
                        .collect::<crate::error::Result<_>>()?;
                    all = Some(session_candidates(
                        sessions.iter().map(|(id, sources)| (*id, sources.as_slice())),
                        |_| None,
                        |_, file| cx.read_source(file),
                        |_, file| cx.open_source(file),
                    )?);
                }
                let Some(owner) = recover_owner(&entry, all.as_deref().unwrap_or_default()) else { continue };
                if owner.id != id {
                    continue;
                }
                let map = entry.as_object_mut().expect("recover_owner takes objects only");
                map.insert("parentSessionId".into(), Value::String(owner.parent.clone()));
                map.insert("ownerSessionId".into(), Value::String(owner.owner.clone()));
            } else if sid != id {
                continue;
            }
            *replaced += count;
            let at = stamp_ms(entry.get("reapedAt"));
            if tombstone.as_ref().is_none_or(|(kept, _)| at > *kept) {
                tombstone = Some((at, entry));
            }
        }
    }
    let tombstone = tombstone.map(|(_, entry)| entry);
    let mut released = None;
    if let Some(text) = read(AGENT_RELEASED)? {
        let doc: Released<'_> = serde_json::from_str(&text).map_err(|e| bad(AGENT_RELEASED, &e))?;
        if let Some(raw) = released_entries(doc.released).map_err(|e| bad(AGENT_RELEASED, &e))?.get(id) {
            released = Some(parse(raw.get().as_bytes(), QuarantineCode::ParseError, AGENT_RELEASED, replaced)?);
        }
    }
    if row.is_none() && tombstone.is_none() && released.is_none() {
        return Ok(None);
    }
    let mut set = Map::new();
    set.insert("worker".into(), Value::Object(worker_map(row, tombstone, released)));
    Ok(Some(set))
}
/// The `worker` header set of `session/<id>` as its conversion installs it, `header` being what was read of its header.
pub(super) fn worker_of(cx: &ItemContext<'_>, id: &str, header: &Header, shared: &[&SourceFile]) -> R<Option<Header>> {
    worker(cx, id, header, shared, &mut 0)
}
/// Header and messages of a session: its log's when the log wins over its json (`log_wins`).
pub(crate) fn header_and_messages(id: &str, json: Option<&[u8]>, log: Option<durable::OpenFile>, replaced: &mut u64) -> R<(Header, Vec<Value>)> {
    header_and_messages_as(id, json, log, replaced, Messages::Whole)
}

/// [`header_and_messages`] with the messages kept as `messages_as` says.
fn header_and_messages_as(
    id: &str,
    json: Option<&[u8]>,
    log: Option<durable::OpenFile>,
    replaced: &mut u64,
    messages_as: Messages<'_>,
) -> R<(Header, Vec<Value>)> {
    match log {
        Some(mut log) => {
            let mut log_replaced = 0;
            let folded = fold_log_as(id, &mut log, &mut log_replaced, messages_as);
            // A log that is not the manifest's is no source, whatever it folded to.
            log.verify()?;
            let fold = folded?;
            if log_wins(fold.legacy.as_ref(), json) {
                *replaced += log_replaced;
                Ok((fold.header, fold.messages))
            } else {
                read_json(id, json.unwrap_or_default(), replaced, messages_as)
            }
        }
        None => read_json(id, json.unwrap_or_default(), replaced, messages_as),
    }
}

/// What a retention verdict reads of `session/<id>` before it is converted: the `fields` of the header its conversion
/// folds, with the parent link its conversion takes from the worker index, and how many messages it holds
/// ([`Messages::Narrowed`]). The header also carries what the worker index is matched to a session by
/// ([`Candidate::FIELDS`]), so [`worker_of`] over it finds the map the conversion would install: a tombstone that names
/// no session reaches its one owner by them.
pub fn skim(cx: &ItemContext<'_>, item: &ManifestItem, id: &str, fields: &[&str]) -> R<(Header, u64)> {
    let fields: Vec<&str> = fields.iter().copied().chain(Candidate::FIELDS.into_iter().filter(|field| !fields.contains(field))).collect();
    let fields = fields.as_slice();
    let json = match source(item, &format!("sessions/{id}{JSON_SUFFIX}")) {
        Some(file) => Some(cx.read_source(file)?),
        None => None,
    };
    let log = match source(item, &format!("sessions/{id}{LOG_SUFFIX}")) {
        Some(file) => Some(cx.open_source(file)?),
        None => None,
    };
    let (mut header, messages) = header_and_messages_as(id, json.as_deref(), log, &mut 0, Messages::Narrowed(fields))?;
    let shared = cx.shared_for(&format!("session/{id}"));
    if let Some(link) = parent_link(cx, id, &header, &shared, &mut 0)? {
        header.extend(link);
    }
    Ok((header, messages.len() as u64))
}
/// Reads every source of `session/<id>` into the model the frames are written from; `office`
/// extracts office documents a recovered turn's context signatures read.
pub fn read(cx: &ItemContext<'_>, item: &ManifestItem, id: &str, office: &OfficeExtractor) -> R<SessionModel> {
    let mut replaced = 0u64;
    let read = |rel: String| -> R<Option<Vec<u8>>> {
        match source(item, &rel) {
            Some(file) => Ok(Some(cx.read_source(file)?)),
            None => Ok(None),
        }
    };
    let json_bytes = read(format!("sessions/{id}{JSON_SUFFIX}"))?;
    let log = match source(item, &format!("sessions/{id}{LOG_SUFFIX}")) {
        Some(file) => Some(cx.open_source(file)?),
        None => None,
    };
    let archive = read(format!("sessions/{id}{ARCHIVE_SUFFIX}"))?;
    let pending = read(format!("sessions/{id}{PENDING_SUFFIX}"))?;
    let ckpt_header = read(format!("turn-checkpoints/{id}.json"))?;
    let ckpt_journal = read(format!("turn-checkpoints/{id}.jsonl"))?;

    // A session only a worker index row names (`worker_row_session_ids`) has no record: Node reads its header as null.
    let (mut header, mut messages) = if item.sources.is_empty() {
        let mut header = Header::new();
        header.insert(mixdog_store::archived_agent::WORKER_ROW_ONLY_KEY.into(), Value::Bool(true));
        // The catalog row takes `Date.now()` for a header without `updatedAt`: a fixed one keeps the migrated index the same run to run.
        header.insert("updatedAt".into(), Value::from(1));
        (header, Vec::new())
    } else {
        header_and_messages(id, json_bytes.as_deref(), log, &mut replaced)?
    };
    let shared = cx.shared_for(&format!("session/{id}"));
    let archived = archived_results(cx, id, &header, &messages, &shared)?;

    let mut archive_damage = Vec::new();
    let (archive_rows, superseded) = archive_rows(id, &header, archive.as_deref(), pending.as_deref(), &mut replaced, &mut archive_damage)?;
    let recovered = checkpoint(
        id,
        &mut header,
        &mut messages,
        ckpt_header.as_deref(),
        ckpt_journal.as_deref(),
        &ContextBlobs { cx, office, thread: id.to_owned().into() },
        &mut replaced,
    )?;
    let (mut turn_messages, runs) = match recovered {
        Some((messages, run)) => (messages, vec![run]),
        None => (Vec::new(), Vec::new()),
    };
    let all: Vec<Value> = messages.iter().chain(turn_messages.iter()).cloned().collect();
    // The sessions whose sidecars this one may name: a copy 1.4.5 made (a clear's fork) names no source, so its set is
    // what its transcript names, stored once here for the prune's index.
    mixdog_store::offload_sources::stamp(&mut header, id, &all);
    // The ids are stamped over 1.4.5's array, system messages included, so every row keeps its 1.4.5 id.
    let mut iids = message_iids(id, &all);
    let mut turn_iids = iids.split_off(messages.len());
    // The system prefix becomes the header's prompt blocks; the rows start after it.
    let system = migrate_system_messages(&all, &header).map_err(|e| Fail::Quarantine(QuarantineCode::SchemaViolation, format!("system messages: {e}")))?;
    system.apply(&mut header);
    // A checkpoint that holds the whole transcript (`fullTranscript`: the turn compacted it) replaces every saved
    // message, so the system prefix is the checkpoint's own: the rest of it is taken off the recovered turn.
    let saved = system.rows_from.min(messages.len());
    let recovered = system.rows_from - saved;
    messages.drain(..saved);
    iids.drain(..saved);
    turn_messages.drain(..recovered);
    turn_iids.drain(..recovered);
    let rid = runs.first().filter(|_| !turn_messages.is_empty()).map(|r| r.rid.clone());

    let queue = pending::read(cx, id, &shared, &header, &all, &mut replaced)?;
    let mut metas: Vec<Header> = worker(cx, id, &header, &shared, &mut replaced)?.into_iter().collect();
    metas.extend(parent_link(cx, id, &header, &shared, &mut replaced)?);
    metas.extend(archived);
    let mut messages = message_rows(iids, messages, None);
    let mut checkpoint_rows = message_rows(turn_iids, turn_messages, rid.as_deref());
    super::restore::convert(messages.iter_mut().chain(checkpoint_rows.iter_mut()), &super::restore::StoreBlobs(cx));
    let mut archive_rows = archive_rows;
    // A turn recovered from its checkpoint holds the requests its own compaction carried over the same way.
    let held: Vec<(String, Value)> =
        if archive_rows.is_empty() { Vec::new() } else { messages.iter().chain(&checkpoint_rows).map(|row| (row.iid.clone(), row.body.clone())).collect() };
    let moved = [place_retained(&mut archive_rows, &mut messages), place_retained(&mut archive_rows, &mut checkpoint_rows)];
    let context = moved.iter().any(Option::is_some).then_some(held);
    Ok(SessionModel {
        id: id.to_string(),
        header,
        archive: archive_rows,
        messages,
        context,
        checkpoint_rows,
        runs,
        queue,
        metas,
        superseded_jobs: superseded,
        archive_damage,
        replaced_surrogates: replaced,
    })
}
