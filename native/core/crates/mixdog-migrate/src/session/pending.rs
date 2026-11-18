//! Recover the 1.4.5 manager spool and the Lead TUI's steering mirror into the
//! same queue. Only older TUI rows without a stable submission ID use the
//! tagged reader's ambiguous recent-text fallback.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use mixdog_js::to_number;
use mixdog_protocol::PastedText;
use mixdog_protocol::PromptAttachment;
use mixdog_store::schema::bounded::Id;
use mixdog_store::schema::migration::MANIFEST_PATH;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::SourceFile;
use mixdog_store::schema::record::Header;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;
use serde_json::value::RawValue;

use super::source::Fail;
use super::source::LEGACY_SPOOL;
use super::source::R;
use super::source::SPOOL_DIR;
use super::source::is_session_id;
use crate::durable::sha256_hex;
use crate::framework::ItemContext;

const TUI_PREFIX: &str = "tui_";
const RESTORE_TTL_MS: f64 = 30.0 * 60.0 * 1000.0;
const RESTORE_DEDUP_WINDOW: usize = 80;

#[derive(Deserialize)]
struct Spool<'a> {
    #[serde(borrow, default)]
    sessions: HashMap<String, &'a RawValue>,
    #[serde(rename = "sessionTouchedAt", default)]
    touched: Value,
    #[serde(rename = "updatedAt", default)]
    updated: Value,
}

pub(super) fn is_spool(path: &str) -> bool {
    path == LEGACY_SPOOL || path.strip_prefix(SPOOL_DIR).is_some_and(|tail| tail.starts_with('/'))
}

pub(super) fn owners(bytes: &[u8]) -> Option<Vec<String>> {
    let spool: Spool<'_> = serde_json::from_slice(bytes).ok()?;
    Some(
        spool
            .sessions
            .into_keys()
            .filter_map(|key| {
                let id = key.strip_prefix(TUI_PREFIX).unwrap_or(&key);
                is_session_id(id).then(|| id.to_owned())
            })
            .collect(),
    )
}

fn text(value: &Value) -> Option<&str> {
    value.as_str().map(js_trim).filter(|s| !s.is_empty())
}

fn stable_submission(id: &str) -> bool {
    // Older TUI processes reused their local item counter on every boot.
    !id.strip_prefix("it_")
        .is_some_and(|tail| !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()))
}

fn submission_id(row: &Value) -> Option<&str> {
    [row.pointer("/options/clientSubmissionId"), row.get("submissionId"), row.pointer("/options/id")]
        .into_iter()
        .flatten()
        .filter_map(text)
        .find(|id| stable_submission(id))
}

fn ids(value: Option<&Value>) -> impl Iterator<Item = &str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn delivered_submissions<'a>(messages: impl Iterator<Item = &'a Value>) -> BTreeSet<&'a str> {
    let mut delivered = BTreeSet::new();
    for message in messages.filter(|m| m["role"] == "user") {
        let meta = &message["meta"];
        let transcript = &meta["transcript"];
        delivered.extend(transcript["checkpointId"].as_str());
        delivered.extend(ids(transcript.get("submissionIds")));
        delivered.extend(ids(meta.get("submissionIds")));
    }
    delivered
}

fn recent_user_texts(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .rev()
        .filter(|m| m["role"] == "user")
        .take(RESTORE_DEDUP_WINDOW)
        .filter_map(|m| match &m["content"] {
            Value::String(text) => Some(text.clone()),
            Value::Array(parts) => Some(
                parts
                    .iter()
                    .map(|part| part["text"].as_str().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .filter(|text| !js_trim(text).is_empty())
        .collect()
}

fn timestamp(entry: &Map<String, Value>, keys: &[&str]) -> Option<Number> {
    keys.iter()
        .filter_map(|key| entry.get(*key))
        .find_map(|value| {
            let at = to_number(value);
            (at.is_finite() && at > 0.0).then(|| {
                if at.fract() == 0.0 && at < i64::MAX as f64 {
                    Number::from(at as i64)
                } else {
                    Number::from_f64(at).expect("finite timestamp")
                }
            })
        })
}

fn normalize_pastes(
    options: &mut Map<String, Value>,
    legacy: &mut Map<String, Value>,
    message: &Value,
) {
    for (field, image) in [("pastedImages", true), ("pastedTexts", false)] {
        let Some(raw) = options.shift_remove(field) else { continue };
        if raw.is_null() {
            continue;
        }
        let Some(entries) = raw.as_object() else {
            legacy.insert(field.into(), raw);
            continue;
        };
        let mut native = Map::new();
        let mut untyped = Map::new();
        for (key, paste) in entries {
            let Some(mut entry) = paste.as_object().cloned() else {
                untyped.insert(key.clone(), paste.clone());
                continue;
            };
            if entry.get("id").and_then(Value::as_i64).is_none()
                && let Some(id) = entry.get("id").and_then(Value::as_str).unwrap_or(key).parse::<i64>().ok()
            {
                entry.insert("id".into(), Value::from(id));
            }
            link_ref(&mut entry);
            if image {
                entry.entry("type").or_insert_with(|| Value::from("image"));
                if entry.get("mediaType").and_then(text).is_none() {
                    let reference = entry.get("attachmentRef").and_then(Value::as_str);
                    let part_type = reference.and_then(|reference| {
                        message.as_array()?.iter().find_map(|part| {
                            (part["type"] == "image" && part["attachmentRef"].as_str() == Some(reference))
                                .then(|| text(&part["mimeType"]))
                                .flatten()
                        })
                    });
                    let media = entry.get("mimeType").and_then(text).or(part_type)
                        .unwrap_or("application/octet-stream");
                    entry.insert("mediaType".into(), Value::from(media));
                }
            }
            let entry = Value::Object(entry);
            let typed = if image {
                serde_json::from_value::<PromptAttachment>(entry.clone()).is_ok()
            } else {
                serde_json::from_value::<PastedText>(entry.clone()).is_ok()
            };
            if typed {
                native.insert(key.clone(), entry);
            } else {
                // A malformed chip must not cause native reopen to discard all retry options.
                untyped.insert(key.clone(), paste.clone());
            }
        }
        if !native.is_empty() {
            options.insert(field.into(), Value::Object(native));
        }
        if !untyped.is_empty() {
            legacy.insert(field.into(), Value::Object(untyped));
        }
    }
}

/// The tagged TUI mirror stores `{ref}` links; the native types name the same link `attachmentRef`.
fn link_ref(part: &mut Map<String, Value>) {
    if part.get("attachmentRef").and_then(text).is_none()
        && let Some(reference) = part.get("ref").and_then(text).map(str::to_owned)
    {
        part.shift_remove("ref");
        part.insert("attachmentRef".into(), Value::from(reference));
    }
}

/// `message` is the executable payload the new drain reads. `text` is
/// independent of it, especially when the composer is showing attachment chips.
fn normalize(mut entry: Map<String, Value>, tui: bool, submission: Option<&str>) -> Option<(f64, Value)> {
    let source = if tui {
        entry.get("content").filter(|value| value.is_string() || value.is_array())
            .or_else(|| entry.get("text"))
    } else {
        entry.get("message").filter(|value| value.is_string())
            .or_else(|| entry.get("content"))
            .or_else(|| entry.get("text"))
    }?;
    let mut message = match source {
        Value::String(_) => Value::from(text(source)?),
        Value::Array(parts) if !parts.is_empty() => source.clone(),
        _ => return None,
    };
    for part in message.as_array_mut().into_iter().flatten().filter_map(Value::as_object_mut) {
        link_ref(part);
    }
    entry.shift_remove("content");
    entry.insert("message".into(), message.clone());

    let at = if tui {
        timestamp(&entry, &["at", "submittedAt"])
    } else {
        timestamp(&entry, &["enqueuedAt"])
    };
    let order = at.as_ref().and_then(Number::as_f64).unwrap_or(0.0);
    if let Some(at) = at {
        entry.insert("enqueuedAt".into(), Value::Number(at));
    }

    let mut options = match entry.shift_remove("options") {
        Some(Value::Object(options)) => options,
        _ => Map::new(),
    };
    if let Some(submitted) = timestamp(&entry, &["submittedAt"]) {
        options.entry("submittedAt").or_insert(Value::Number(submitted));
    }
    if let Some(submission) = submission {
        options.insert("clientSubmissionId".into(), Value::from(submission));
    } else {
        options.shift_remove("clientSubmissionId");
    }
    for key in ["pastedImages", "pastedTexts", "retryFailedTurn", "retryTurnId", "retryAttemptId"] {
        if let Some(value) = entry.get(key) {
            options.entry(key).or_insert_with(|| value.clone());
        }
    }
    // SubmitOptions rejects unknown fields as a group. Keep old queue controls
    // beside the typed options so a legacy flag cannot disable a retry.
    let mut legacy = Map::new();
    options.retain(|key, value| match key.as_str() {
        "clientSubmissionId" | "submittedAt" | "displayText" | "goalCommand"
        | "retryFailedTurn" | "retryTurnId" | "retryAttemptId" | "pastedImages"
        | "pastedTexts" | "kickoff" | "attachmentSizes" => true,
        "context" | "priority" | "mode" | "origin" | "transcriptMeta"
        | "skipSlashCommands" | "suppressDisplay" | "skillSelection" => {
            entry.entry(key.clone()).or_insert_with(|| value.clone());
            false
        }
        _ => {
            legacy.insert(key.clone(), value.clone());
            false
        }
    });
    if let Some(display) = options.get("displayText").and_then(text).or_else(|| entry.get("text").and_then(text)) {
        let display = Value::from(display);
        entry.insert("text".into(), display.clone());
        options.insert("displayText".into(), display);
    }
    if entry.get("suppressDisplay").and_then(Value::as_bool) == Some(true) {
        options.entry("kickoff").or_insert(Value::Bool(true));
    }
    normalize_pastes(&mut options, &mut legacy, &message);
    if !options.is_empty() {
        entry.insert("options".into(), Value::Object(options));
    }
    if !legacy.is_empty() {
        entry.insert("legacyOptions".into(), Value::Object(legacy));
    }
    Some((order, Value::Object(entry)))
}

struct Bucket<'a> {
    path: &'a str,
    rows: Vec<Value>,
    touched: f64,
    updated: f64,
}

fn nonzero(n: f64) -> Option<f64> {
    (!n.is_nan() && n != 0.0).then_some(n)
}

fn touched_at(touched: f64, updated: f64, now: f64) -> f64 {
    if touched.is_finite() && touched > 0.0 {
        touched
    } else {
        nonzero(updated).unwrap_or(now)
    }
}

fn row_id(row: &Value) -> Option<&str> {
    row["id"].as_str().filter(|s| !s.is_empty())
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum RowKey<'a> {
    Submission(&'a str),
    Local(&'a str),
}

fn local_id(row: &Value, tui: bool) -> Option<&str> {
    row_id(row).map(|id| if tui { js_trim(id) } else { id }).filter(|s| !s.is_empty())
}

fn row_key(row: &Value, tui: bool) -> Option<RowKey<'_>> {
    submission_id(row).map(RowKey::Submission).or_else(|| local_id(row, tui).map(RowKey::Local))
}

/// A shard wins over the legacy copy of the same submission. A row without a
/// stable ID still matches a copy by local ID, but cannot merge two explicit IDs.
fn merged<'a>(
    buckets: &'a [Bucket<'_>],
    now: f64,
    tui: bool,
) -> Vec<(&'a str, usize, &'a Value, f64)> {
    let mut shards = buckets.iter().filter(|b| b.path != LEGACY_SPOOL);
    let mut kept = Vec::new();
    let mut merged_touch = None;
    let explicit_locals: BTreeSet<_> = buckets.iter().flat_map(|b| &b.rows)
        .filter(|row| submission_id(row).is_some())
        .filter_map(|row| local_id(row, tui)).collect();
    let shadowed = |row: &Value| {
        submission_id(row).is_none() && local_id(row, tui).is_some_and(|id| explicit_locals.contains(id))
    };
    if let Some(legacy) = buckets.iter().find(|b| b.path == LEGACY_SPOOL) {
        let keys: BTreeSet<_> = shards.clone().flat_map(|b| &b.rows).filter_map(|row| row_key(row, tui)).collect();
        let anonymous: BTreeSet<_> = shards.clone().flat_map(|b| &b.rows)
            .filter(|row| row_key(row, tui).is_none()).map(json_stringify).collect();
        let touched = shards.clone().next().and_then(|b| nonzero(b.touched))
            .or_else(|| nonzero(legacy.touched))
            .or_else(|| nonzero(legacy.updated))
            .unwrap_or(now);
        let touched = touched_at(touched, now, now);
        for (index, row) in legacy.rows.iter().enumerate() {
            let present = match row_key(row, tui) {
                Some(key) => keys.contains(&key),
                None => anonymous.contains(&json_stringify(row)),
            };
            if !present && !shadowed(row) {
                kept.push((legacy.path, index, row, touched));
                merged_touch = Some(touched);
            }
        }
    }
    for (index, shard) in shards.by_ref().enumerate() {
        let touched = if index == 0 { merged_touch } else { None }
            .unwrap_or_else(|| touched_at(shard.touched, shard.updated, now));
        kept.extend(shard.rows.iter().enumerate().filter(|(_, row)| !shadowed(row))
            .map(|(index, row)| (shard.path, index, row, touched)));
    }
    kept
}

fn migration_time(cx: &ItemContext<'_>) -> f64 {
    // The plan is durable before conversion starts; keep the expiration basis
    // across retries, so restarting halfway through cannot age out more rows.
    crate::durable::modified(&cx.roots.data.join(MANIFEST_PATH))
        .unwrap_or_else(SystemTime::now)
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

pub(super) fn read(
    cx: &ItemContext<'_>,
    owner: &str,
    shared: &[&SourceFile],
    header: &Header,
    messages: &[Value],
    replaced: &mut u64,
) -> R<Vec<(String, Value)>> {
    let manager_delivered: BTreeSet<_> = ids(header.get("deliveredPendingMessageIds")).collect();
    // The tagged restore reads the live session's messages, not the display archive.
    let mut delivered = delivered_submissions(messages.iter());
    let mut recent = None;
    let tui_bucket = format!("{TUI_PREFIX}{owner}");
    let buckets = [(owner, false), (tui_bucket.as_str(), true)];
    let mut sources: [Vec<Bucket<'_>>; 2] = Default::default();
    let mut entries = Vec::new();
    for file in shared.iter().copied().filter(|file| is_spool(&file.path)) {
        let bytes = cx.read_source(file)?;
        let bad = |error: &dyn std::fmt::Display| {
            Fail::Quarantine(QuarantineCode::ParseError, format!("{}: {error}", file.path))
        };
        let spool: Spool<'_> = serde_json::from_slice(&bytes).map_err(|e| bad(&e))?;
        for ((bucket, tui), sources) in buckets.into_iter().zip(&mut sources) {
            if !tui && bucket.starts_with(TUI_PREFIX) {
                continue;
            }
            let Some(raw) = spool.sessions.get(bucket) else { continue };
            let list = crate::json::parse_source(raw.get().as_bytes()).map_err(|e| bad(&e))?;
            *replaced += list.replaced_surrogates;
            if let Value::Array(rows) = list.value
                && !rows.is_empty()
            {
                sources.push(Bucket {
                    path: &file.path,
                    rows,
                    touched: to_number(&spool.touched[bucket]),
                    updated: to_number(&spool.updated),
                });
            }
        }
    }
    let now = migration_time(cx);
    // Apply the manager's local-ID receipts before making either bucket's
    // submission claims. A reused ID cannot prove which of its rows was sent.
    let mut manager_ids: HashMap<&str, Option<&str>> = HashMap::new();
    for row in sources[0].iter().flat_map(|bucket| &bucket.rows) {
        if let Some(id) = local_id(row, false).filter(|id| manager_delivered.contains(id))
            && let Some(submission) = submission_id(row)
        {
            match manager_ids.entry(id) {
                std::collections::hash_map::Entry::Occupied(mut old) if *old.get() != Some(submission) => {
                    old.insert(None);
                }
                std::collections::hash_map::Entry::Vacant(slot) => { slot.insert(Some(submission)); }
                _ => {}
            }
        }
    }
    delivered.extend(manager_ids.values().copied().flatten());
    let mut submissions = BTreeSet::new();
    for ((bucket, tui), sources) in buckets.into_iter().zip(&sources) {
        let mut local_ids = BTreeSet::new();
        for (path, index, row, touched) in merged(sources, now, tui) {
            let mut entry = match row {
                Value::Object(entry) => entry.clone(),
                Value::String(_) if tui => Map::from_iter([("text".into(), row.clone())]),
                _ => continue,
            };
            entry.shift_remove("id");
            let id = local_id(row, tui);
            let submission = submission_id(row);
            if !tui && submission.is_none() && id.is_none_or(|id| manager_delivered.contains(id)) {
                continue;
            }
            let shown = if tui {
                let Some(shown) = text(if row.is_string() { row } else { &row["text"] }) else { continue };
                let written_at = timestamp(&entry, &["at"]).and_then(|at| at.as_f64()).unwrap_or(touched);
                if written_at > 0.0 && now - written_at > RESTORE_TTL_MS {
                    continue;
                }
                Some(shown)
            } else {
                None
            };
            let Some((at, entry)) = normalize(entry, tui, submission) else { continue };
            if let Some(submission) = submission {
                if delivered.contains(submission) || !submissions.insert(submission) {
                    continue;
                }
            } else {
                // The text heuristic is only for older TUI rows without a stable ID.
                if shown.is_some_and(|shown| recent.get_or_insert_with(|| recent_user_texts(messages))
                    .iter().any(|body| body.contains(shown)))
                    || id.is_some_and(|id| !local_ids.insert(id))
                {
                    continue;
                }
            }
            entries.push((at, id, path, bucket, index, entry));
        }
    }
    // The split prepends legacy additions. Keep them first on a timestamp
    // tie, even when combining the two distinct buckets of the Lead.
    entries.sort_by(|a, b| {
        let shard = |path| path != LEGACY_SPOOL;
        a.0.total_cmp(&b.0).then_with(|| shard(a.2).cmp(&shard(b.2)))
    });
    let reserved: BTreeSet<_> = entries.iter().filter_map(|e| e.1).collect();
    let mut used = BTreeSet::new();
    Ok(entries
        .into_iter()
        .map(|(_, id, path, bucket, index, entry)| {
            let qid = id.filter(|id| Id::try_from(*id).is_ok() && used.insert((*id).to_owned()));
            let qid = qid.map(str::to_owned).unwrap_or_else(|| {
                let hash = sha256_hex(format!("{path}\0{bucket}\0{index}").as_bytes());
                (0..)
                    .map(|suffix| format!("migrated-{hash}-{suffix}"))
                    .find(|id| !reserved.contains(id.as_str()) && used.insert(id.clone()))
                    .expect("a free queue id")
            });
            (qid, entry)
        })
        .collect())
}
