//! `ingest/transcript-rows.mjs`: timestamp coercion, cwd extraction from the first rows of a file,
//! and the conversation row a transcript line contributes.

use std::path::{Path, PathBuf};

use mixdog_js::time::date_parse;
use mixdog_js::{js_trim, json_parse, value_to_string};
use mixdog_rt::{CancellationToken, LaneToken, MaintenanceIo};
use mixdog_statefile::{metadata, read_range};
use serde_json::Value;

use crate::memory::ingest_shape::{session_message_content_for_ingest, should_exclude_ingest_message};

/// A transcript timestamp (seconds, ms or ISO string) in ms, and whether the file recorded it
/// (`recorded`) or it was made up at collection (`collected`).
pub fn parse_ts_with_source(value: Option<&Value>, fallback_ms: f64) -> (f64, &'static str) {
    if let Some(Value::Number(n)) = value
        && let Some(n) = n.as_f64().filter(|n| n.is_finite())
    {
        return (if n < 1e12 { n * 1000.0 } else { n }, "recorded");
    }
    let parsed = date_parse(&value.map_or_else(|| "undefined".to_owned(), value_to_string));
    if parsed.is_finite() { (parsed, "recorded") } else { (fallback_ms, "collected") }
}

/// `parseTsToMs`.
pub fn parse_ts_to_ms(value: Option<&Value>, now_ms: f64) -> f64 {
    parse_ts_with_source(value, now_ms).0
}

/// The session cwd Mixdog embeds as a top-level `cwd` on every message row, read from the first
/// five lines of the first 100 KiB. Only a directory that exists counts.
pub async fn cwd_from_transcript_path(lane: MaintenanceIo, file: &Path) -> Option<PathBuf> {
    let file = file.to_owned();
    let job = lane
        .submit_wait(&CancellationToken::new(), move |lane| {
            let size = metadata(lane, &file).ok()?.len();
            let bytes = read_range(lane, &file, 0, size.min(100 * 1024) as usize).ok()?;
            let text = String::from_utf8_lossy(&bytes);
            for line in text.split('\n').take(5) {
                let line = js_trim(line);
                if line.is_empty() {
                    continue;
                }
                let Ok(obj) = json_parse(line) else { continue };
                let Some(candidate) = obj.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { continue };
                if metadata(lane, Path::new(candidate)).is_ok_and(|m| m.is_dir()) {
                    return Some(PathBuf::from(candidate));
                }
            }
            None
        })
        .await;
    job.ok()?.await.ok().flatten()
}

/// A conversation row of a transcript line.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptRow {
    pub role: &'static str,
    pub content: String,
    pub ts_ms: f64,
    pub time_source: &'static str,
}

/// The row a parsed line contributes, or none when it is not a pure conversation row. The role is
/// `message.role` (legacy) or the top-level `type` of the current writer; synthetic
/// reference-file, compaction, ack and internal-notification rows are dropped.
pub fn transcript_row_from_line(parsed: &Value, now_ms: f64) -> Option<TranscriptRow> {
    if parsed.get("memoryEligible") == Some(&Value::Bool(false)) {
        return None;
    }
    let message = parsed.get("message").filter(|m| !m.is_null());
    let role = message.and_then(|m| m.get("role")).filter(|r| !r.is_null()).cloned().or_else(|| match parsed.get("type").and_then(Value::as_str) {
        Some(kind @ ("user" | "assistant")) => Some(Value::String(kind.to_owned())),
        _ => None,
    });
    let role: &'static str = match role.as_ref().and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return None,
    };
    let shaped = serde_json::json!({"role": role, "content": message.and_then(|m| m.get("content"))});
    if should_exclude_ingest_message(&shaped) {
        return None;
    }
    let content = session_message_content_for_ingest(&shaped);
    if js_trim(&content).is_empty() {
        return None;
    }
    let stamp = parsed.get("timestamp").filter(|v| !v.is_null()).or_else(|| parsed.get("ts"));
    let (ts_ms, time_source) = parse_ts_with_source(stamp, now_ms);
    Some(TranscriptRow { role, content, ts_ms, time_source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timestamps_are_seconds_ms_or_iso() {
        assert_eq!(parse_ts_with_source(Some(&json!(1_700_000_000)), 5.0), (1_700_000_000_000.0, "recorded"));
        assert_eq!(parse_ts_with_source(Some(&json!(1_700_000_000_123u64)), 5.0), (1_700_000_000_123.0, "recorded"));
        assert_eq!(parse_ts_with_source(Some(&json!("2026-01-02T03:04:05.000Z")), 5.0), (1_767_323_045_000.0, "recorded"));
        assert_eq!(parse_ts_with_source(Some(&json!("later")), 5.0), (5.0, "collected"));
        assert_eq!(parse_ts_with_source(None, 5.0), (5.0, "collected"));
    }

    #[test]
    fn rows_come_from_message_role_or_type() {
        let legacy = json!({"message": {"role": "user", "content": "hello there"}, "ts": 1_700_000_000});
        assert_eq!(transcript_row_from_line(&legacy, 9.0).unwrap().role, "user");
        let current = json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "an answer"}]}, "timestamp": "2026-01-02T03:04:05.000Z"});
        let row = transcript_row_from_line(&current, 9.0).unwrap();
        assert_eq!((row.role, row.content.as_str()), ("assistant", "an answer"));
        assert!(transcript_row_from_line(&json!({"type": "summary", "message": {"content": "x"}}), 9.0).is_none());
        assert!(transcript_row_from_line(&json!({"type": "user", "memoryEligible": false, "message": {"content": "x"}}), 9.0).is_none());
        assert!(transcript_row_from_line(&json!({"type": "user", "message": {"content": "   "}}), 9.0).is_none());
    }
}
