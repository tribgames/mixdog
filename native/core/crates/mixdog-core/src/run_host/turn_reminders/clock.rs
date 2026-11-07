//! The current-time reminder (`prompt-utils.mjs` `buildCurrentTimeBlock`, `shared/time-format.mjs`
//! `formatLocalAndUtcTimestamp`): a prompt that asks about the date or the time carries the moment it was sent, in
//! the machine's zone and in UTC.

use std::sync::LazyLock;

use chrono::DateTime;
use chrono::Utc;
use mixdog_js::JsRegex;
use mixdog_js::time;
use serde_json::Value;

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

/// `promptContentText(content)` for text and image blocks; an attachment reference is not resolved here.
fn prompt_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                part if part.get("type").and_then(Value::as_str) == Some("image") => "[Image]".to_owned(),
                part => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<String>>()
            .join("\n"),
        Value::Null => String::new(),
        other => mixdog_js::value_to_string(other),
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
        time::local_zone().name(),
        sign,
        minutes / 60,
        minutes % 60,
        utc.format("%Y-%m-%dT%H:%M:%S%.3fZ"),
    )
}

/// `buildCurrentTimeBlock(prompt)`: the timestamp when the prompt asks about a date or the time, else empty.
pub fn block(prompt: &Value, now_ms: f64) -> String {
    let content = prompt_content_text(prompt);
    let text = mixdog_js::js_to_lowercase(&mixdog_js::js_words(&content).collect::<Vec<&str>>().join(" "));
    if text.is_empty() || !(TIME_WORDS.is_match(&text) || DATE_WORDS.is_match(&text)) {
        return String::new();
    }
    timestamp(now_ms)
}
