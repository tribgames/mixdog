//! Old-format readers of one session item (SM §11.4): the 1.4.5 json, the dev log and the
//! pair rule, the compaction archive and pending jobs, turn checkpoints, the pending
//! spools and the worker indexes. Strict where SM says so; every lone surrogate becomes
//! U+FFFD and is counted.

use std::collections::BTreeSet;
use std::collections::HashMap;

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

use super::ids::message_iids;
use super::model::Row;
use super::model::RunModel;
use super::model::SessionModel;
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

/// Worker-row fields carried as the `worker` header map (SM §11.4.6).
const WORKER_FIELDS: &[&str] = &[
    "tag",
    "task_id",
    "stage",
    "status",
    "error",
    "failureReason",
    "finishedAt",
    "released",
    "reapAt",
    "restartNotified",
    "turnStartedAt",
    "runtimePid",
];

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

/// JavaScript `Number(v)` for the values 1.4.5 reads numerically.
fn js_number_of(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
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
fn read_json(id: &str, bytes: &[u8], replaced: &mut u64) -> R<(Header, Vec<Value>)> {
    let value = parse(bytes, QuarantineCode::ParseError, "session json", replaced)?;
    let Value::Object(mut map) = value else {
        return q(QuarantineCode::SchemaViolation, "session json is not an object");
    };
    let messages = match map.remove("messages") {
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
        "edit" => {
            messages.is_some()
                && count_of(r.get("len")).is_some()
                && count_of(r.get("at")).is_some()
                && count_of(r.get("del")).is_some()
        }
        "rollback" => count_of(r.get("len")).is_some(),
        "patch" => {
            let (Some(set), Some(unset)) = (
                r.get("set").and_then(Value::as_object),
                r.get("unset").and_then(Value::as_array),
            ) else {
                return None;
            };
            !set.contains_key("messages")
                && !set.contains_key("id")
                && unset.iter().all(|k| k.is_string() && k != "messages" && k != "id")
        }
        _ => false,
    };
    ok.then_some(r)
}

/// The dev reader's fold (`dev:session-log-reader.mjs` `parseSessionLog`), strict: a
/// line it would skip is `parse_error`, a sequence or length break `schema_violation`.
/// A final line without LF is a torn tail and is excluded.
pub fn fold_log(id: &str, bytes: &[u8], replaced: &mut u64) -> R<LogFold> {
    // Every complete line ends with LF; the bytes after the last LF are the torn tail.
    let lines: Vec<&[u8]> = match bytes.iter().rposition(|&b| b == b'\n') {
        Some(end) => bytes[..end].split(|&b| b == b'\n').collect(),
        None => Vec::new(),
    };
    let mut accepted: Vec<Map<String, Value>> = Vec::new();
    let mut length: u64 = 0;
    let mut last_compacted = 0usize;
    for (n, line) in lines.into_iter().enumerate() {
        let value = parse(line, QuarantineCode::ParseError, &format!("log line {}", n + 1), replaced)?;
        let Some(record) = decode_record(&value) else {
            return q(QuarantineCode::ParseError, format!("log line {} is not a record", n + 1));
        };
        let expected = accepted.len();
        let t = record["t"].as_str().unwrap_or("");
        let misplaced = count_of(record.get("s")) != Some(expected as u64)
            || (expected == 0 && t != "session")
            || (expected == 1 && t != "compacted")
            || (expected > 0 && t == "session");
        let len = count_of(record.get("len"));
        let mlen = record.get("messages").and_then(Value::as_array).map_or(0, |m| m.len() as u64);
        let next = if misplaced {
            None
        } else {
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
        };
        let Some(next) = next else {
            return q(
                QuarantineCode::SchemaViolation,
                format!("log line {}: {} at sequence {expected}", n + 1, if misplaced { "sequence break" } else { "length mismatch" }),
            );
        };
        length = next;
        if t == "compacted" {
            last_compacted = accepted.len();
        }
        accepted.push(record.clone());
    }
    if accepted.len() < 2 {
        return q(QuarantineCode::SchemaViolation, "log has no session + compacted base");
    }
    let base = &accepted[0];
    if base["id"].as_str() != Some(id) {
        return q(
            QuarantineCode::IdMismatch,
            format!("log base names {}", base["id"].as_str().unwrap_or("")),
        );
    }
    let mut header = base["header"].as_object().cloned().unwrap_or_default();
    for r in accepted.iter().filter(|r| r["t"] == "patch") {
        for k in r["unset"].as_array().into_iter().flatten() {
            header.remove(k.as_str().unwrap_or(""));
        }
        for (k, v) in r["set"].as_object().into_iter().flatten() {
            header.insert(k.clone(), v.clone());
        }
    }
    let mut messages: Vec<Value> = Vec::new();
    for r in &accepted[last_compacted..] {
        let ms = || r["messages"].as_array().cloned().unwrap_or_default();
        match r["t"].as_str().unwrap_or("") {
            "compacted" => messages = ms(),
            "append" => messages.extend(ms()),
            "edit" => {
                let at = count_of(r.get("at")).unwrap_or(0) as usize;
                let del = count_of(r.get("del")).unwrap_or(0) as usize;
                messages.splice(at..at + del, ms());
            }
            "rollback" => messages.truncate(count_of(r.get("len")).unwrap_or(0) as usize),
            _ => {}
        }
    }
    let legacy = base.get("legacy").and_then(Value::as_object).map(|l| Legacy {
        sha1: l["sha1"].as_str().unwrap_or("").to_string(),
        redacted_from: l.get("redactedFrom").and_then(Value::as_str).map(str::to_string),
    });
    Ok(LogFold {
        header,
        messages,
        legacy,
    })
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
        let close = (probe.get(*at) == Some(&b'"'))
            .then(|| probe[*at + 1..].iter().position(|b| *b == b'"'))
            .flatten();
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
    bytes.zip(items.then_some(())).is_some_and(|(bytes, ())| {
        usize::try_from(bytes).is_ok_and(|b| at.checked_add(b).and_then(|e| e.checked_add(1)) == Some(line.len()))
    })
}

fn opt_u64(v: Option<&Value>, what: &str) -> R<Option<u64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) if n.as_u64().is_some() => Ok(n.as_u64()),
        Some(_) => q(QuarantineCode::ArchiveParseError, format!("{what} is not a count")),
    }
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

/// Segment rows and pending-job rows in seq order (SM §11.4.3).
fn archive_rows(
    id: &str,
    header: &Header,
    archive: Option<&[u8]>,
    pending: Option<&[u8]>,
    replaced: &mut u64,
) -> R<(Vec<Row>, Vec<u64>)> {
    let range = archive_range(header);
    let mut entries: Vec<(u64, u8, Vec<Row>)> = Vec::new();
    let mut segment_seqs = BTreeSet::new();
    if let Some(text) = archive {
        for (n, line) in text.split(|&b| b == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            let what = format!("archive line {}", n + 1);
            let value = parse(line, QuarantineCode::ArchiveParseError, &what, replaced)?;
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
            let at = opt_number(seg.get("at"), &what)?;
            // 1.4.5 shows the last `count` items of a segment its index reads.
            let shown = indexed_segment(line) && visible(range, seq);
            let first_shown = items.len().saturating_sub(usize::try_from(count).unwrap_or(usize::MAX));
            let origin = ArchiveOrigin::Segment {
                id: text_id(seg_id)?,
                prev: prev.as_deref().map(text_id).transpose()?,
                count,
                bytes,
            };
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
                    archive: Some(ArchiveTag {
                        seq,
                        at: at.clone(),
                        origin: origin.clone(),
                    }),
                    prompt: None,
                    body: item.clone(),
                })
                .collect();
            segment_seqs.insert(seq);
            entries.push((seq, 0, rows));
        }
    }
    let mut superseded = Vec::new();
    if let Some(text) = pending {
        let doc = parse(text, QuarantineCode::ArchiveParseError, "pending jobs", replaced)?;
        let Some(Value::Array(jobs)) = doc.get("jobs") else {
            return q(QuarantineCode::ArchiveParseError, "pending sidecar holds no jobs");
        };
        for job in jobs {
            let (Some(seq), Some(Value::Array(messages))) =
                (job.get("seq").and_then(Value::as_u64), job.get("messages"))
            else {
                return q(QuarantineCode::ArchiveParseError, "a pending job without seq/messages");
            };
            if segment_seqs.contains(&seq) {
                superseded.push(seq);
                continue;
            }
            let divider = match job.get("divider") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return q(QuarantineCode::ArchiveParseError, "job divider"),
            };
            let tag = ArchiveTag {
                seq,
                at: opt_number(job.get("at"), "job at")?,
                origin: ArchiveOrigin::Pending {
                    divider,
                    cleared_through: opt_u64(job.get("clearedThrough"), "job clearedThrough")?,
                    max_bytes: opt_u64(job.get("maxBytes"), "job maxBytes")?,
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
            entries.push((seq, 1, rows));
        }
    }
    entries.sort_by_key(|(seq, kind, _)| (*seq, *kind));
    Ok((entries.into_iter().flat_map(|(_, _, rows)| rows).collect(), superseded))
}

fn text_id(s: &str) -> R<mixdog_store::schema::bounded::Id> {
    mixdog_store::schema::bounded::Id::try_from(s)
        .map_err(|e| Fail::Quarantine(QuarantineCode::SchemaViolation, e))
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
    out.insert(
        "updatedAt".into(),
        serde_json::Number::from_f64(updated).map_or(Value::Null, |n| {
            if updated.fract() == 0.0 && updated.abs() < 9.0e15 {
                Value::from(updated as i64)
            } else {
                Value::Number(n)
            }
        }),
    );
    Value::Object(out)
}

/// The checkpoint disposition (SM §11.4.4): `None` = covered (or no checkpoint),
/// else the turn messages to recover (when recoverable) and the run.
fn checkpoint(
    id: &str,
    session_header: &Header,
    header: Option<&[u8]>,
    journal: Option<&[u8]>,
    replaced: &mut u64,
) -> Option<(Vec<Value>, RunModel)> {
    let text = header?;
    let unrecovered = |rid: String, checkpoint: Value, at: Option<i64>| {
        Some((
            Vec::new(),
            RunModel {
                rid,
                at,
                phases: vec![(
                    RunPhase::Interrupted,
                    Some(serde_json::json!({"unrecovered": true, "checkpoint": checkpoint})),
                )],
            },
        ))
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
    let token = json::js_to_string(&h["turnToken"]);
    if session_header.get("turnCoverage").and_then(Value::as_str) == Some(token.as_str()) {
        return None;
    }
    let rid = format!("ckpt:{token}");
    let at = h.get("startedAt").and_then(Value::as_i64);
    let generation = |v: Option<&Value>| {
        let n = js_number_of(v);
        if n.is_nan() { 0.0 } else { n }
    };
    if generation(h.get("generation")) != generation(session_header.get("generation")) {
        return unrecovered(rid, folded, at);
    }
    let messages = folded["turnMessages"].as_array().cloned().unwrap_or_default();
    let interruption = folded.get("interruption").cloned();
    Some((
        messages,
        RunModel {
            rid,
            at,
            phases: vec![(RunPhase::Started, None), (RunPhase::Interrupted, interruption)],
        },
    ))
}

// ── Shared spools and worker indexes ─────────────────────────────────────────

#[derive(Deserialize)]
struct Spool<'a> {
    #[serde(borrow, default)]
    sessions: HashMap<String, &'a RawValue>,
}

#[derive(Deserialize)]
struct Workers<'a> {
    #[serde(borrow, default)]
    workers: HashMap<String, &'a RawValue>,
}

/// Session ids a shared file names (`sessions` keys of a spool; `sessionId` of worker
/// rows). `None` when the file does not parse.
pub fn shared_session_ids(name: &str, bytes: &[u8]) -> Option<Vec<String>> {
    let text = std::str::from_utf8(bytes).ok()?;
    if name.ends_with(AGENT_WORKERS) || name.ends_with(LEAD_WORKERS) {
        let workers: Workers<'_> = serde_json::from_str(text).ok()?;
        let mut ids = Vec::new();
        for raw in workers.workers.values() {
            let row = json::parse_source(raw.get().as_bytes()).ok()?.value;
            if let Some(id) = row.get("sessionId").and_then(Value::as_str) {
                ids.push(id.to_string());
            }
        }
        Some(ids)
    } else {
        let spool: Spool<'_> = serde_json::from_str(text).ok()?;
        Some(spool.sessions.into_keys().collect())
    }
}

/// This session's pending entries, `(qid, entry minus id)`, in `enqueuedAt` order
/// (ties: source order; SM §11.4.5).
fn queue(cx: &ItemContext<'_>, id: &str, shared: &[&SourceFile], replaced: &mut u64) -> R<Vec<(String, Value)>> {
    let mut entries: Vec<(f64, usize, String, Value)> = Vec::new();
    let mut spools: Vec<&&SourceFile> = shared
        .iter()
        .filter(|f| f.path.starts_with(&format!("{SPOOL_DIR}/")))
        .collect();
    spools.extend(shared.iter().filter(|f| f.path == LEGACY_SPOOL));
    for file in spools {
        let bytes = cx.read_source(file)?;
        let text = std::str::from_utf8(&bytes).map_err(|e| Fail::Quarantine(QuarantineCode::ParseError, e.to_string()))?;
        let spool: Spool<'_> = serde_json::from_str(text)
            .map_err(|e| Fail::Quarantine(QuarantineCode::ParseError, format!("{}: {e}", file.path)))?;
        let Some(raw) = spool.sessions.get(id) else { continue };
        let list = parse(raw.get().as_bytes(), QuarantineCode::ParseError, &file.path, replaced)?;
        for entry in list.as_array().into_iter().flatten() {
            let Some(obj) = entry.as_object() else { continue };
            // 1.4.5 drops an entry without an id (`pendingMessageQueueEntry`): never delivered.
            let Some(qid) = obj.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                continue;
            };
            let mut rest = obj.clone();
            rest.remove("id");
            let at = js_number_of(obj.get("enqueuedAt"));
            let n = entries.len();
            entries.push((if at.is_nan() { 0.0 } else { at }, n, qid.to_string(), Value::Object(rest)));
        }
    }
    entries.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(entries.into_iter().map(|(_, _, qid, e)| (qid, e)).collect())
}

/// The `worker` header map of this session (agent index wins over lead; SM §11.4.6).
fn worker(cx: &ItemContext<'_>, id: &str, shared: &[&SourceFile], replaced: &mut u64) -> R<Option<Header>> {
    for name in [AGENT_WORKERS, LEAD_WORKERS] {
        let Some(file) = shared.iter().find(|f| f.path == name) else { continue };
        let bytes = cx.read_source(file)?;
        let text = std::str::from_utf8(&bytes).map_err(|e| Fail::Quarantine(QuarantineCode::ParseError, e.to_string()))?;
        let workers: Workers<'_> = serde_json::from_str(text)
            .map_err(|e| Fail::Quarantine(QuarantineCode::ParseError, format!("{name}: {e}")))?;
        let mut keys: Vec<&String> = workers.workers.keys().collect();
        keys.sort();
        for key in keys {
            let mut count = 0;
            let row = parse(workers.workers[key].get().as_bytes(), QuarantineCode::ParseError, name, &mut count)?;
            if row.get("sessionId").and_then(Value::as_str) != Some(id) {
                continue;
            }
            *replaced += count;
            let mut map = Map::new();
            for field in WORKER_FIELDS {
                if let Some(v) = row.get(*field) {
                    map.insert((*field).to_string(), v.clone());
                }
            }
            let mut set = Map::new();
            set.insert("worker".into(), Value::Object(map));
            return Ok(Some(set));
        }
    }
    Ok(None)
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

/// Reads every source of `session/<id>` into the model the frames are written from.
pub fn read(cx: &ItemContext<'_>, item: &ManifestItem, id: &str) -> R<SessionModel> {
    let mut replaced = 0u64;
    let read = |rel: String| -> R<Option<Vec<u8>>> {
        match source(item, &rel) {
            Some(file) => Ok(Some(cx.read_source(file)?)),
            None => Ok(None),
        }
    };
    let json_bytes = read(format!("sessions/{id}{JSON_SUFFIX}"))?;
    let log_bytes = read(format!("sessions/{id}{LOG_SUFFIX}"))?;
    let archive = read(format!("sessions/{id}{ARCHIVE_SUFFIX}"))?;
    let pending = read(format!("sessions/{id}{PENDING_SUFFIX}"))?;
    let ckpt_header = read(format!("turn-checkpoints/{id}.json"))?;
    let ckpt_journal = read(format!("turn-checkpoints/{id}.jsonl"))?;

    let (header, messages) = match &log_bytes {
        Some(log) => {
            let mut log_replaced = 0;
            let fold = fold_log(id, log, &mut log_replaced)?;
            if log_wins(fold.legacy.as_ref(), json_bytes.as_deref()) {
                replaced += log_replaced;
                (fold.header, fold.messages)
            } else {
                read_json(id, json_bytes.as_deref().unwrap_or_default(), &mut replaced)?
            }
        }
        None => read_json(id, json_bytes.as_deref().unwrap_or_default(), &mut replaced)?,
    };

    let (archive_rows, superseded) =
        archive_rows(id, &header, archive.as_deref(), pending.as_deref(), &mut replaced)?;
    let recovered = checkpoint(id, &header, ckpt_header.as_deref(), ckpt_journal.as_deref(), &mut replaced);
    let (turn_messages, runs) = match recovered {
        Some((messages, run)) => (messages, vec![run]),
        None => (Vec::new(), Vec::new()),
    };
    let all: Vec<Value> = messages.iter().chain(turn_messages.iter()).cloned().collect();
    let mut iids = message_iids(id, &all);
    let turn_iids = iids.split_off(messages.len());
    let rid = runs.first().filter(|_| !turn_messages.is_empty()).map(|r| r.rid.clone());

    let shared = cx.shared_for(&format!("session/{id}"));
    let queue = queue(cx, id, &shared, &mut replaced)?;
    let metas = worker(cx, id, &shared, &mut replaced)?.into_iter().collect();
    let mut messages = message_rows(iids, messages, None);
    let mut checkpoint_rows = message_rows(turn_iids, turn_messages, rid.as_deref());
    super::restore::convert(
        messages.iter_mut().chain(checkpoint_rows.iter_mut()),
        &super::restore::StoreBlobs(cx),
    );
    Ok(SessionModel {
        id: id.to_string(),
        header,
        archive: archive_rows,
        messages,
        checkpoint_rows,
        runs,
        queue,
        metas,
        superseded_jobs: superseded,
        replaced_surrogates: replaced,
    })
}
