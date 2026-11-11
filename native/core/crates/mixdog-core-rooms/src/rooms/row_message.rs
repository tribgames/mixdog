//! A room row as the log stores it (`normalizeRoomRow`, `roomRowMessage` of
//! `session/agent-room.mjs`): the canonical row descriptor, and the stored message that carries it.
//! Rows are the log's JSON rows; keys come out in Node's order.
//!
//! A row's files (`parts`, `attachments`, `images`) are stored references the log's intake made
//! (`RoomFiles`); `attachments` are taken as that intake normalized them.

use mixdog_js::{js_trim, js_words, slice_utf16, utf16_len, value_to_string};
use serde_json::{Map, Value, json};

use super::config::ROOM_MAX_MEMBERS;
use super::turn_prompt::{is_attachment_ref, row_targets, stored_parts};

/// `meta.source` of every row stored in a room's log.
pub const ROOM_ROW_SOURCE: &str = "agent-room";
const NAME_LIMIT: usize = 80;
const TEXT_LIMIT: usize = 40_000;
const REASON_LIMIT: i64 = 240;
const TOOL_LIMIT: usize = 3;
const TOOL_SUMMARY_LIMIT: usize = 400;
const ATTACHMENT_LIMIT: usize = 64;
const QUOTA_KINDS: [&str; 3] = ["quota_exhausted", "entitlement", "billing"];

/// `String(value ?? '')`.
fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => value_to_string(other),
    }
}

/// `bounded(value, limit)`: trimmed, and cut with an ellipsis past `limit` UTF-16 units.
fn bounded(value: &str, limit: usize) -> String {
    let text = js_trim(value);
    if utf16_len(text) > limit { format!("{}…", slice_utf16(text, limit - 1)) } else { text.to_owned() }
}

/// `cleanName`: whitespace runs collapsed to one space, trimmed, at most 80 units.
fn clean_name(value: Option<&Value>) -> String {
    slice_utf16(&js_words(&text_of(value)).collect::<Vec<_>>().join(" "), NAME_LIMIT)
}

fn is_row_id(id: &str) -> bool {
    (1..=120).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_sender_session(id: &str) -> bool {
    (1..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// `Number.isInteger(value) && value >= 0`.
fn is_count(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= 0.0)
}

/// `finiteTime`: a finite number above zero, else null.
fn finite_time(value: Option<&Value>) -> Value {
    match value {
        Some(number) if number.as_f64().is_some_and(|n| n.is_finite() && n > 0.0) => number.clone(),
        _ => Value::Null,
    }
}

/// `storedImages`: a user row's image chips as a chat prompt's row carries them.
fn stored_images(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|image| image.is_object())
        .take(ATTACHMENT_LIMIT)
        .map(|image| {
            let id = match image.get("id") {
                Some(id) if id.is_number() || id.is_string() => id.clone(),
                _ => Value::Null,
            };
            let shown = |key: &str, fallback: &str, limit: usize| {
                let text = text_of(image.get(key));
                slice_utf16(if text.is_empty() { fallback } else { &text }, limit)
            };
            let bytes = Some(mixdog_js::to_number_of(image.get("bytes"))).filter(|n| *n > 0.0).map_or(json!(0), mixdog_js::json_number);
            let mut out = Map::new();
            out.insert("id".into(), id);
            out.insert("name".into(), json!(shown("name", "Image", 200)));
            out.insert("mimeType".into(), json!(shown("mimeType", "image/png", 100)));
            out.insert("bytes".into(), bytes);
            if let Some(reference) = image.get("attachmentRef").and_then(Value::as_str).filter(|r| is_attachment_ref(r)) {
                out.insert("attachmentRef".into(), json!(reference));
            }
            Value::Object(out)
        })
        .collect()
}

/// A row descriptor in canonical shape; an unknown kind or an invalid id is refused.
pub fn normalize_room_row(row: &Value) -> Result<Value, String> {
    let kind = row.get("kind").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "user" | "speech" | "pass" | "cap" | "stopped" | "interrupted") {
        let shown = row.get("kind").map_or_else(|| "undefined".to_owned(), value_to_string);
        return Err(format!("unknown room row kind \"{shown}\""));
    }
    let id = row.get("id").and_then(Value::as_str).filter(|id| is_row_id(id)).unwrap_or("");
    if id.is_empty() {
        return Err("room row id is invalid".into());
    }
    let carries_text = matches!(kind, "user" | "speech");
    let text = if carries_text { bounded(&text_of(row.get("text")), TEXT_LIMIT) } else { String::new() };
    let tools: Vec<Value> = row
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(TOOL_LIMIT)
        .map(|tool| {
            let name = clean_name(tool.get("name"));
            json!({ "name": if name.is_empty() { "tool".to_owned() } else { name }, "summary": bounded(&text_of(tool.get("summary")), TOOL_SUMMARY_LIMIT) })
        })
        .collect();
    let failed_pass = kind == "pass" && row.get("failed") == Some(&Value::Bool(true));
    let names: Vec<String> = if failed_pass {
        row.get("names")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|name| clean_name(Some(name)))
            .filter(|name| !name.is_empty())
            .take(ROOM_MAX_MEMBERS)
            .collect()
    } else {
        Vec::new()
    };
    // `[row.reason ?? []].flat()`: a list contributes its items, anything else itself.
    let reasons: Vec<String> = if failed_pass {
        match row.get("reason") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(list)) => list.iter().map(|each| js_trim(&value_to_string(each)).to_owned()).filter(|each| !each.is_empty()).collect(),
            Some(single) => Some(js_trim(&value_to_string(single)).to_owned()).filter(|each| !each.is_empty()).into_iter().collect(),
        }
    } else {
        Vec::new()
    };
    let count = i64::try_from(reasons.len()).unwrap_or(i64::MAX);
    let share = usize::try_from((REASON_LIMIT - 2 * (count - 1)).div_euclid(count.max(1))).unwrap_or(0);
    let reason = reasons.iter().map(|each| bounded(each, share)).collect::<Vec<_>>().join("; ");
    let usage = row.get("usage").filter(|usage| {
        kind == "cap"
            && row.get("limit").and_then(Value::as_str) == Some("usage")
            && usage.get("kind").and_then(Value::as_str).is_some_and(|k| QUOTA_KINDS.contains(&k))
    });
    let usage = usage.map(|stop| {
        json!({
            "kind": stop["kind"],
            "provider": bounded(&text_of(stop.get("provider")), NAME_LIMIT),
            "model": bounded(&text_of(stop.get("model")), NAME_LIMIT),
            "resetAt": finite_time(stop.get("resetAt")),
        })
    });
    let mut targets: Vec<(String, String)> = Vec::new();
    for (id, name) in row_targets(row) {
        let (id, name) = (clean_name(Some(&json!(id))), clean_name(Some(&json!(name))));
        if !id.is_empty() && !targets.iter().any(|(other, _)| *other == id) {
            targets.push((id, name));
        }
    }
    targets.truncate(ROOM_MAX_MEMBERS);
    let parts = if carries_text { stored_parts(row.get("parts")) } else { Vec::new() };
    let attachments: Vec<Value> = if carries_text { row.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default() } else { Vec::new() };
    let images = if kind == "user" { stored_images(row.get("images")) } else { Vec::new() };
    let from_session = row.get("fromSession").and_then(Value::as_str).filter(|s| kind == "user" && is_sender_session(s));

    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("kind".into(), json!(kind));
    if let Some(at) = row.get("at").filter(|at| at.as_f64().is_some_and(f64::is_finite)) {
        out.insert("at".into(), at.clone());
    }
    for key in ["speaker", "name"] {
        let named = clean_name(row.get(key));
        if !named.is_empty() {
            out.insert(key.into(), json!(named));
        }
    }
    if let Some(session) = from_session {
        out.insert("fromSession".into(), json!(session));
        let agent = clean_name(row.get("fromAgent"));
        if !agent.is_empty() {
            out.insert("fromAgent".into(), json!(agent));
        }
        let sender = clean_name(row.get("fromName"));
        out.insert("fromName".into(), json!(if sender.is_empty() { "Lead".to_owned() } else { sender }));
    }
    if !targets.is_empty() {
        out.insert("to".into(), json!(targets.iter().map(|(id, _)| id).collect::<Vec<_>>()));
        out.insert("toName".into(), json!(targets.iter().map(|(id, name)| if name.is_empty() { id } else { name }).collect::<Vec<_>>()));
    }
    if row.get("failed") == Some(&Value::Bool(true)) {
        out.insert("failed".into(), json!(true));
    }
    if !names.is_empty() {
        out.insert("names".into(), json!(names));
    }
    if !reason.is_empty() {
        out.insert("reason".into(), json!(reason));
    }
    let limit = row.get("limit").and_then(Value::as_str);
    if matches!(limit, Some("rounds" | "messages")) || usage.is_some() {
        out.insert("limit".into(), row.get("limit").cloned().unwrap_or(Value::Null));
    }
    if let Some(usage) = usage {
        out.insert("usage".into(), usage);
    }
    for key in ["rounds", "messages"] {
        if is_count(row.get(key)) {
            out.insert(key.into(), row[key].clone());
        }
    }
    for (key, list) in [("tools", tools), ("parts", parts), ("attachments", attachments), ("images", images)] {
        if !list.is_empty() {
            out.insert(key.into(), Value::Array(list));
        }
    }
    out.insert("text".into(), json!(text));
    Ok(Value::Object(out))
}

/// The stored message of one row: user rows are the user's words, member rows assistant text;
/// passes and notices carry no content. `now_ms` stands for a row without a time (`Date.now()`).
pub fn room_row_message(row: &Value, now_ms: i64) -> Result<Value, String> {
    let normal = normalize_room_row(row)?;
    let Value::Object(mut room) = normal else { unreachable!("a normalized row is an object") };
    let take = |room: &mut Map<String, Value>, key: &str| room.shift_remove(key);
    let id = take(&mut room, "id").unwrap_or(Value::Null);
    let at = take(&mut room, "at").unwrap_or_else(|| json!(now_ms));
    let text = take(&mut room, "text").unwrap_or_else(|| json!(""));
    let attachments = take(&mut room, "attachments");
    let user = room.get("kind") == Some(&json!("user"));
    let mut transcript = Map::new();
    transcript.insert("at".into(), at);
    transcript.insert("messageId".into(), id);
    if let Some(attachments) = attachments {
        transcript.insert("attachments".into(), attachments);
    }
    Ok(json!({
        "role": if user { "user" } else { "assistant" },
        "content": text,
        "meta": { "source": ROOM_ROW_SOURCE, "room": Value::Object(room), "transcript": Value::Object(transcript) },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("src/rooms/row_message/golden.json");

    /// Every recorded Node row: the canonical descriptor, the stored message, or the refusal.
    #[test]
    fn every_recorded_row_equals_node() {
        let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let row = &case["row"];
            match case.get("error") {
                Some(error) => assert_eq!(normalize_room_row(row).unwrap_err(), error.as_str().unwrap(), "{name}"),
                None => {
                    assert_eq!(normalize_room_row(row).unwrap(), case["normalized"], "{name}");
                    let mut stamped = row.clone();
                    if stamped.get("at").is_none() {
                        stamped["at"] = json!(424242);
                    }
                    assert_eq!(room_row_message(&stamped, 0).unwrap(), case["message"], "{name}");
                }
            }
        }
        let bare = room_row_message(&json!({ "id": "i1", "kind": "interrupted" }), 777).unwrap();
        assert_eq!(bare, golden["noAt"]);
    }

    #[test]
    fn key_order_is_nodes() {
        let message = room_row_message(&json!({ "id": "s", "kind": "speech", "speaker": "a", "name": "A", "text": "t", "at": 1, "to": ["b"] }), 0).unwrap();
        let keys: Vec<_> = message["meta"]["room"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["kind", "speaker", "name", "to", "toName"]);
    }
}
