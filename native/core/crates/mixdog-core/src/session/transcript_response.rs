//! The live inbound agent-response card: what the transcript pushes when a task session's
//! completion arrives (Node's `buildExecutionResponseToolItem` in `agent-envelope.mjs`,
//! `pushAsyncAgentResponse` in `transcript-intake.mjs`, `appendAgentResponseTail` in
//! `agent-response-tail.mjs`).
//!
//! A completion is `{content, meta}` as `notifySessionCompletion` emits it (`meta.execution_id`,
//! `meta.execution_surface`, `meta.status`). [`agent_response`] turns it into a card, or, when
//! the transcript's last item is an inbound agent card, into that card with the response
//! appended. The tail rule is Node's: only the last item is ever extended, so a later response
//! never reaches above an outbound tool, an assistant or user row, or a preview/body change.

use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::message_class::envelope::CARD_SURFACES;
use mixdog_protocol::message_class::envelope::Parsed;
use mixdog_protocol::message_class::envelope::agent_job_ids;
use mixdog_protocol::message_class::envelope::is_terminal_error_status;
use mixdog_protocol::message_class::envelope::parse_synthetic_agent_message;
use mixdog_protocol::message_class::js::or_str;
use mixdog_protocol::message_class::js::re;
use mixdog_protocol::text_class::parse_task_notification;
use serde_json::Value;
use serde_json::json;

use super::transcript_convert::Ctx;
use super::transcript_convert::item_of;
use super::transcript_rows::Row;
use super::transcript_rows::num_value;

/// A task session's completion as `notifySessionCompletion(owner, text, meta)` emits it.
pub struct Completion<'a> {
    pub content: &'a str,
    pub meta: &'a Value,
}

/// What the transcript does with a completion.
#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    /// A new item at the end of the transcript.
    Push(ThreadItem),
    /// The last item, extended by the response (same id).
    Patch(ThreadItem),
}

/// The transcript's item for `completion`: a new card `id`, or the `previous` (last) item
/// extended. `None` when the text is no card at all (Node then shows it as a user or
/// synthetic row, `pushUserOrSyntheticItem`); `now` is the arrival time in milliseconds.
pub fn agent_response(
    completion: &Completion<'_>,
    id: &str,
    previous: Option<&ThreadItem>,
    now: i64,
) -> Option<Delivery> {
    let text = js_trim(completion.content);
    let meta = completion.meta;
    let text_field = |key: &str| js_trim(&or_str(meta.get(key), "")).to_owned();
    let ids = agent_job_ids(text);
    let key = match text_field("execution_id") {
        id if !id.is_empty() => id,
        _ => ids.as_ref().map(|(task_id, _)| js_trim(task_id).to_owned()).unwrap_or_default(),
    };
    let status = match text_field("status") {
        status if !status.is_empty() => status,
        _ => ids.map(|(_, status)| status).unwrap_or_default(),
    };
    let row = response_row(text, id, &key, &text_field("execution_surface"), &status, now)?;
    if row.get("name").and_then(Value::as_str) == Some("agent")
        && let Some(previous) = previous.and_then(tool_row)
        && let Some(patch) = append_to_tail(&previous, &row, now)
    {
        let mut merged = previous;
        merged.extend(patch);
        return Some(Delivery::Patch(item(merged)));
    }
    Some(Delivery::Push(item(row)))
}

fn item(row: Row) -> ThreadItem {
    item_of(row, &Ctx { turn: None, message: None, counts_prompt: false, source: None })
}

/// `taskNotificationHasBody(text)`.
pub(in crate::session) fn has_body(text: &str) -> bool {
    match parse_task_notification(text) {
        Some(n) => !n.result.is_empty() || !n.error.is_empty(),
        None => re(r"\n\s*\n[\s\S]*\S", "").is_match(text),
    }
}

/// `buildExecutionResponseToolItem(text, { id, responseKey, executionSurface, executionStatus,
/// now })`: the card's row, `None` when the text is no card and the surface names none.
fn response_row(text: &str, id: &str, response_key: &str, surface: &str, status: &str, now: i64) -> Option<Row> {
    let surface = js_trim(surface).to_lowercase();
    let status = js_trim(status).to_lowercase();
    let explicit = CARD_SURFACES.contains(&surface.as_str()).then(|| surface.clone());
    let synthetic = match parse_synthetic_agent_message(text) {
        Some(parsed) => parsed,
        None => {
            let name = explicit.clone()?;
            let mut args = serde_json::Map::new();
            args.insert("type".into(), json!("result"));
            if !status.is_empty() {
                args.insert("status".into(), json!(status));
            }
            if !response_key.is_empty() {
                args.insert("task_id".into(), json!(response_key));
            }
            args.insert("surface".into(), json!(name));
            Parsed {
                name,
                label: if status.is_empty() { "completed".into() } else { status.clone() },
                args,
                result: js_trim(text).to_owned(),
                raw_result: None,
                is_error: None,
            }
        }
    };
    let label = if synthetic.label.is_empty() { "notification".to_owned() } else { synthetic.label.clone() };
    let name = match explicit {
        Some(name) => name,
        None if synthetic.name.is_empty() => "task".to_owned(),
        None => synthetic.name.clone(),
    };
    let is_agent = name == "agent";
    let mut args = synthetic.args.clone();
    if !surface.is_empty() {
        args.insert("surface".into(), json!(surface));
    }
    if !status.is_empty() {
        args.insert("status".into(), json!(status));
    }
    if is_agent {
        args.insert("type".into(), json!("result"));
    }
    let raw_result = synthetic.raw_result.clone().unwrap_or_else(|| text.to_owned());
    let body = has_body(text);
    let key = if response_key.is_empty() { or_str(args.get("task_id"), "") } else { response_key.to_owned() };
    let key = js_trim(&key).to_owned();
    let is_error = synthetic.is_error.clone().unwrap_or_else(|| Value::Bool(is_terminal_error_status(&label)));
    let mut row = Row::new();
    row.insert("kind".into(), json!("tool"));
    row.insert("id".into(), json!(id));
    row.insert("name".into(), json!(name));
    row.insert("args".into(), Value::Object(args));
    row.insert("result".into(), json!(synthetic.result));
    row.insert("rawResult".into(), json!(raw_result));
    row.insert("isError".into(), is_error.clone());
    row.insert("expanded".into(), json!(false));
    row.insert("count".into(), json!(1));
    row.insert("completedCount".into(), json!(1));
    row.insert("startedAt".into(), num_value(now as f64));
    row.insert("completedAt".into(), num_value(now as f64));
    if is_agent {
        row.insert("agentDirection".into(), json!("inbound"));
        row.insert("agentResponseKey".into(), json!(key));
        row.insert("agentResponseHasBody".into(), json!(body));
        row.insert("agentResponseAggregate".into(), json!(false));
        row.insert(
            "agentResponseEntries".into(),
            json!([{
                "key": key,
                "raw": js_trim(&raw_result),
                "result": synthetic.result,
                "hasBody": body,
                "isError": is_error == Value::Bool(true),
            }]),
        );
    }
    Some(row)
}

/// `responseEntry(response)` of a response or a stored entry.
fn response_entry(response: &Value, key: &Value, raw: &[&str]) -> Value {
    let raw = raw
        .iter()
        .find_map(|name| response.get(*name).filter(|v| !v.is_null()))
        .map(|v| js_trim(&value_to_string(v)).to_owned())
        .unwrap_or_default();
    let mut entry = serde_json::Map::new();
    entry.insert("key".into(), json!(or_str(Some(key), "")));
    entry.insert("raw".into(), json!(raw));
    if let Some(result) = response.get("result") {
        entry.insert("result".into(), result.clone());
    }
    entry.insert("hasBody".into(), json!(response.get("hasBody") == Some(&Value::Bool(true))));
    entry.insert("isError".into(), json!(response.get("isError") == Some(&Value::Bool(true))));
    Value::Object(entry)
}

/// `appendAgentResponseTail(previous, response, now)`: the patch that adds `response` (a card
/// row) to `previous`, `None` when `previous` is no inbound agent card or the presentation
/// phase differs (a bodyless failure stays a separate row from a later full body).
fn append_to_tail(previous: &Row, response: &Row, now: i64) -> Option<Row> {
    if previous.get("kind").and_then(Value::as_str) != Some("tool")
        || previous.get("agentDirection").and_then(Value::as_str) != Some("inbound")
    {
        return None;
    }
    let fields = |name: &str| response.get(name).cloned().unwrap_or(Value::Null);
    let next = {
        let view = json!({
            "result": response.get("result"),
            "rawResult": response.get("rawResult"),
            "hasBody": response.get("agentResponseHasBody"),
            "isError": response.get("isError"),
        });
        response_entry(&view, &fields("agentResponseKey"), &["rawResult", "raw"])
    };
    let mut entries: Vec<Value> = match previous.get("agentResponseEntries") {
        Some(Value::Array(list)) if !list.is_empty() => {
            list.iter().map(|entry| response_entry(entry, &entry.get("key").cloned().unwrap_or(Value::Null), &["rawResult", "raw"])).collect()
        }
        _ => {
            let view = json!({
                "result": previous.get("result"),
                "rawResult": previous.get("rawResult").filter(|v| !v.is_null()).or_else(|| previous.get("result")),
                "hasBody": previous.get("agentResponseHasBody"),
                "isError": previous.get("isError"),
            });
            vec![response_entry(&view, &previous.get("agentResponseKey").cloned().unwrap_or(Value::Null), &["rawResult", "raw"])]
        }
    };
    let next_key = next["key"].as_str().unwrap_or("").to_owned();
    let existing = (!next_key.is_empty()).then(|| entries.iter().position(|e| e["key"] == next_key)).flatten();
    match existing {
        // A preview, final or retry of one execution is one response.
        Some(index) => entries[index] = next.clone(),
        None => {
            if previous.get("agentResponseHasBody") != Some(&next["hasBody"]) {
                return None;
            }
            entries.push(next.clone());
        }
    }
    let raw = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let raw = entry["raw"].as_str().unwrap_or("");
            (!raw.is_empty()).then(|| format!("{}. agent\n{raw}", index + 1))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let flag = |entry: &Value, name: &str| entry[name] == Value::Bool(true);
    let mut patch = Row::new();
    patch.insert("args".into(), fields("args"));
    if let Some(result) = response.get("result") {
        patch.insert("result".into(), result.clone());
    }
    patch.insert("rawResult".into(), if raw.is_empty() { Value::Null } else { json!(raw) });
    patch.insert("isError".into(), json!(entries.iter().any(|e| flag(e, "isError"))));
    patch.insert("count".into(), json!(entries.len()));
    patch.insert("completedCount".into(), json!(entries.len()));
    patch.insert("completedAt".into(), num_value(now as f64));
    patch.insert(
        "agentResponseKeys".into(),
        json!(entries.iter().filter_map(|e| e["key"].as_str().filter(|k| !k.is_empty())).collect::<Vec<_>>()),
    );
    patch.insert("agentResponseHasBody".into(), json!(entries.iter().all(|e| flag(e, "hasBody"))));
    patch.insert("agentResponseAggregate".into(), json!(entries.len() > 1));
    patch.insert("agentResponseEntries".into(), Value::Array(entries));
    Some(patch)
}

/// The row a live tool card item came from: its typed fields and the rest of its attributes.
/// `None` for another item, or a card whose text lives out of line (a live card is inline).
fn tool_row(item: &ThreadItem) -> Option<Row> {
    let ThreadItem::ToolCall { id, name, input, run, meta, .. } = item else { return None };
    let inline = |text: &Option<MaybeBlob<String>>| match text {
        Some(MaybeBlob::Inline(text)) => Some(Some(text.clone())),
        Some(MaybeBlob::Blob(_)) => None,
        None => Some(None),
    };
    let ItemMeta { at, message_id, posted, ext, .. } = meta;
    let mut row = Row::new();
    row.insert("kind".into(), json!("tool"));
    row.insert("id".into(), json!(id.as_str()));
    row.insert("name".into(), json!(name));
    row.insert("args".into(), input.clone());
    if let Some(result) = inline(&run.result)? {
        row.insert("result".into(), json!(result));
    }
    if let Some(raw) = inline(&run.raw_result)? {
        row.insert("rawResult".into(), json!(raw));
    }
    if let Some(is_error) = run.is_error {
        row.insert("isError".into(), json!(is_error));
    }
    for (key, value) in [("startedAt", run.started_at), ("completedAt", run.completed_at), ("at", *at)] {
        if let Some(value) = value {
            row.insert(key.into(), Value::from(value));
        }
    }
    for (key, value) in [("count", run.count), ("completedCount", run.completed_count)] {
        if let Some(value) = value {
            row.insert(key.into(), json!(value));
        }
    }
    if let Some(message_id) = message_id {
        row.insert("messageId".into(), json!(message_id));
    }
    if let Some(posted) = posted {
        row.insert("posted".into(), json!(posted));
    }
    for (key, value) in ext {
        row.insert(key.clone(), value.clone());
    }
    Some(row)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    /// Node's `pushAsyncAgentResponse` over recorded completions (`record-agent-response.mjs`):
    /// after every delivery the transcript's items equal Node's, field for field.
    #[test]
    fn agent_response_equals_nodes() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/agent-response/cases.json");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).expect("cases.json")).expect("json");
        let mut cards = 0;
        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap_or("?");
            let mut items: Vec<ThreadItem> = Vec::new();
            for (completion, step) in case["completions"].as_array().expect("completions").iter().zip(case["steps"].as_array().expect("steps")) {
                let content = completion["content"].as_str().expect("content");
                let delivered = agent_response(
                    &Completion { content, meta: &completion["meta"] },
                    step["id"].as_str().expect("id"),
                    items.last(),
                    step["now"].as_i64().expect("now"),
                );
                if step["action"] != "execution-ui" {
                    assert_eq!(delivered, None, "{name}: no card for {}", step["action"]);
                    continue;
                }
                match delivered.unwrap_or_else(|| panic!("{name}: a card")) {
                    Delivery::Push(item) => items.push(item),
                    Delivery::Patch(item) => *items.last_mut().expect("tail") = item,
                }
                cards += 1;
                let got: Vec<Value> = items.iter().map(|i| Value::Object(tool_row(i).expect("tool"))).collect();
                // `expanded` is the TUI's own fold state; a typed item has no home for it.
                let mut want = step["items"].clone();
                for item in want.as_array_mut().expect("items") {
                    item.as_object_mut().expect("item").shift_remove("expanded");
                }
                assert_eq!(Value::Array(got), want, "{name}: items after {}", step["id"]);
            }
        }
        assert!(cards >= 10);
    }
}
