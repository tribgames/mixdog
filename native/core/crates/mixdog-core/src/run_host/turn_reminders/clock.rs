//! The current-time reminder (`prompt-utils.mjs` `buildCurrentTimeBlock`, `shared/time-format.mjs`
//! `formatLocalAndUtcTimestamp`): a prompt that asks about the date or the time carries the moment it was sent, in
//! the machine's zone and in UTC.

use std::sync::LazyLock;

use chrono::DateTime;
use chrono::Utc;
use mixdog_js::JsRegex;
use mixdog_js::time;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::ReadError;
use mixdog_protocol::message_class::user_text::attachment_text;
use serde_json::Value;

use super::zone_names::RENAMED;

/// `promptNeedsDateReminder`.
static DATE_WORDS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(?:\uC624\uB298|\uB0B4\uC77C|\uC5B4\uC81C|\uBAA8\uB808|\uADF8\uC800\uAED8|\uC694\uC998|\uCD5C\uADFC|\uBC29\uAE08|\uC544\uAE4C|\uD604\uC7AC\s*(?:\uB0A0\uC9DC|\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04|\uB0A0\uC9DC|\uC694\uC77C)|\uBA87\s*\uC6D4\s*\uBA87\s*\uC77C|\uBA87\s*\uC2DC|\uBB34\uC2A8\s*\uC694\uC77C|\uC694\uC77C|\uB0A0\uC9DC|\uC774\uBC88\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC9C0\uB09C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uB2E4\uC74C\s*(?:\uC8FC|\uB2EC|\uC6D4|\uB144)|\uC62C\uD574|\uC791\uB144|\uB0B4\uB144|today|tomorrow|yesterday|recently|current\s+(?:date|time)|what\s+(?:date|time)|which\s+day|weekday|this\s+(?:week|month|year)|last\s+(?:week|month|year)|next\s+(?:week|month|year))",
        "i",
    )
});

/// `promptNeedsTimeReminder`.
static TIME_WORDS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(?:\uD604\uC7AC\s*(?:\uC2DC\uAC04|\uC2DC\uAC01)|\uC9C0\uAE08\s*(?:\uBA87\s*\uC2DC|\uC2DC\uAC04)|\uBA87\s*\uC2DC|\uC2DC\uAC01|\uC2DC\uAC04|current\s+time|what\s+time|time\s+is\s+it)",
        "i",
    )
});

/// `MAX_ATTACHMENT_BLOB_BYTES` (`attachments/limits.mjs:9`): a larger blob is invalid.
const MAX_ATTACHMENT_BLOB_BYTES: u64 = 64 * 1024 * 1024;

/// `isAttachmentReference(part)`: `attachmentRef` is 64 lower-case hex digits.
fn attachment_ref(part: &Value) -> Option<&str> {
    part.get("attachmentRef").and_then(Value::as_str).filter(|hex| hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `attachmentTextForPart(part)` of a text part: a reference reads its blob (`readAttachmentText`: a missing, invalid,
/// oversize or tampered blob throws, which fails the turn) and a file is wrapped with its name.
fn text_part(part: &Value, blobs: &dyn Blobs) -> Result<String, String> {
    let Some(hex) = attachment_ref(part) else { return Ok(part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned()) };
    let stored = match blobs.text_within(hex, MAX_ATTACHMENT_BLOB_BYTES) {
        Ok(Some(text)) => text,
        Ok(None) => return Err(format!("prompt attachment {hex} is invalid")),
        Err(ReadError::Missing) => return Err(format!("prompt attachment {hex} is missing")),
        Err(ReadError::Other) => return Err(format!("prompt attachment {hex} is invalid")),
    };
    Ok(attachment_text(&stored, part.get("textKind").and_then(Value::as_str), part.get("filename").and_then(Value::as_str)))
}

/// `promptContentText(content)` (`prompt-utils.mjs:12`): a string, or the parts' text joined by a newline, a stored
/// text attachment read from the store, an image as `[Image]`.
pub fn prompt_content_text(content: &Value, blobs: &dyn Blobs) -> Result<String, String> {
    match content {
        Value::String(text) => Ok(text.clone()),
        Value::Array(parts) => {
            let mut texts: Vec<String> = Vec::new();
            for part in parts {
                let text = match part {
                    Value::String(text) => text.clone(),
                    part if part.get("type").and_then(Value::as_str) == Some("text") => text_part(part, blobs)?,
                    part if part.get("type").and_then(Value::as_str) == Some("image") => "[Image]".to_owned(),
                    part => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                };
                if !text.is_empty() {
                    texts.push(text);
                }
            }
            Ok(texts.join("\n"))
        }
        Value::Null => Ok(String::new()),
        other => Ok(mixdog_js::value_to_string(other)),
    }
}

/// The zone name Node prints for a tz-database name: ICU's canonical id (`Asia/Kolkata` reads `Asia/Calcutta`).
fn printed_zone(name: &str) -> &str {
    match RENAMED.binary_search_by(|(known, _)| (*known).cmp(name)) {
        Ok(at) => RENAMED[at].1,
        Err(_) => name,
    }
}

/// `formatLocalAndUtcTimestamp(new Date())` at `now_ms`: `Local: <date> <time> <zone> (UTC±hh:mm)` and `UTC: <ISO>`.
pub fn timestamp(now_ms: f64) -> String {
    let Some(local) = time::local_fields(now_ms) else { return String::new() };
    let Some(utc) = DateTime::<Utc>::from_timestamp_millis(now_ms as i64) else { return String::new() };
    let offset_ms = time::local_offset_ms(now_ms);
    let sign = if offset_ms < 0 { '-' } else { '+' };
    let minutes = offset_ms.abs() / 60_000;
    format!(
        "Local: {:04}-{:02}-{:02} {:02}:{:02}:{:02} {} (UTC{}{:02}:{:02})\nUTC: {}",
        local.year,
        local.month,
        local.day,
        local.hour,
        local.minute,
        local.second,
        printed_zone(time::local_zone().name()),
        sign,
        minutes / 60,
        minutes % 60,
        utc.format("%Y-%m-%dT%H:%M:%S%.3fZ"),
    )
}

/// `buildCurrentTimeBlock(prompt)`: the timestamp when the prompt (`content`, its text as `promptContentText` reads it)
/// asks about a date or the time, else empty.
pub fn block(content: &str, now_ms: f64) -> String {
    let text = mixdog_js::js_to_lowercase(&mixdog_js::js_words(content).collect::<Vec<&str>>().join(" "));
    if text.is_empty() || !(TIME_WORDS.is_match(&text) || DATE_WORDS.is_match(&text)) {
        return String::new();
    }
    timestamp(now_ms)
}
