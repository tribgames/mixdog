//! How a room member's finished turn is read (`apps/desktop/src/main/agent-room-turn.ts`,
//! `session-final-answer.ts`): the final answer of a session snapshot, a turn that finished
//! without reply text, its tool summaries, and the words a turn posts. Snapshots are the session
//! service's JSON, read as Node reads them.

use mixdog_js::{js_trim, json_stringify, slice_utf16, to_number_of, value_to_string};
use serde_json::{Value, json};

use super::config::{is_pass_reply, without_pass_marker};

#[cfg(test)]
mod tests;

const TOOL_SUMMARY: usize = 400;

/// `SessionFinalAnswer`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionAnswer {
    /// The turn-done item's id, as the snapshot holds it.
    pub id: Value,
    /// Its time, as the snapshot holds it.
    pub at: Value,
    /// `done`, `failed` or `cancelled`.
    pub status: String,
    pub text: String,
    /// The turn answered with a reaction on the user's message alone.
    pub reacted: bool,
}

impl SessionAnswer {
    pub fn to_value(&self) -> Value {
        let mut value = json!({ "id": self.id, "at": self.at, "status": self.status, "text": self.text });
        if self.reacted {
            value["reacted"] = Value::Bool(true);
        }
        value
    }
}

/// A JS truthy field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(_) => true,
    }
}

fn kind(item: &Value) -> Option<&str> {
    item.get("kind").and_then(Value::as_str)
}

fn items(snapshot: &Value) -> &[Value] {
    snapshot.get("items").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `x == null`.
fn nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `typeof at === 'number' && at < startedAt` with `startedAt` a number.
fn before(at: Option<&Value>, started_at: f64) -> Option<bool> {
    at.filter(|at| at.is_number()).and_then(Value::as_f64).map(|at| at < started_at)
}

/// `sessionFinalAnswer(snapshot, startedAt)`: a completed turn owns its answer by id. A late or
/// incomplete projection is pending (`None`), not permission to substitute an earlier answer.
pub fn session_final_answer(snapshot: &Value, started_at: &Value) -> Option<SessionAnswer> {
    let started_at = started_at.as_f64().filter(|started_at| started_at.is_finite())?;
    if !truthy(Some(snapshot)) || truthy(snapshot.get("busy")) || truthy(snapshot.get("streamingTail")) {
        return None;
    }
    let items = items(snapshot);
    let done_index = items.iter().rposition(|item| kind(item) == Some("turndone"))?;
    let done = &items[done_index];
    if nullish(done.get("id")) || before(done.get("at"), started_at) != Some(false) {
        return None;
    }
    // A newer prompt can arrive before the next busy roster does.
    if items[done_index + 1..].iter().any(|item| matches!(kind(item), Some("user" | "assistant"))) {
        return None;
    }
    let answer = |text: String, reacted: bool, status: &str| SessionAnswer { id: done["id"].clone(), at: done["at"].clone(), status: status.to_owned(), text, reacted };
    let status = done.get("status").and_then(Value::as_str);
    if let Some(status @ ("failed" | "cancelled")) = status {
        return Some(answer(String::new(), false, status));
    }
    let final_id = done.get("finalAssistantId");
    // A reaction alone answered the turn: nothing to read, and nothing more comes.
    if status == Some("done") && nullish(final_id) && done.get("reacted") == Some(&Value::Bool(true)) {
        return Some(answer(String::new(), true, "done"));
    }
    if status != Some("done") || nullish(final_id) {
        return None;
    }
    let answer_index = items[..done_index].iter().rposition(|item| item.get("id") == final_id && kind(item) == Some("assistant"))?;
    if items[answer_index + 1..done_index].iter().any(|item| kind(item) == Some("turndone")) {
        return None;
    }
    let reply = &items[answer_index];
    let text = reply.get("text").and_then(Value::as_str)?;
    if reply.get("streaming") == Some(&Value::Bool(true)) || js_trim(text).is_empty() {
        return None;
    }
    Some(answer(text.to_owned(), false, "done"))
}

/// `emptyFinishedTurn`: a turn that finished without any reply text. A member saying nothing
/// passes (`session_final_answer` waits for text, which never comes).
pub fn empty_finished_turn(snapshot: &Value, started_at: &Value) -> Option<SessionAnswer> {
    if !truthy(Some(snapshot)) || truthy(snapshot.get("busy")) || truthy(snapshot.get("streamingTail")) {
        return None;
    }
    let items = items(snapshot);
    let done_index = items.iter().rposition(|item| kind(item) == Some("turndone"))?;
    let done = &items[done_index];
    // `done.at < startedAt` against a start that is no number compares false.
    let early = started_at.as_f64().and_then(|started_at| before(done.get("at"), started_at));
    if done.get("status").and_then(Value::as_str) != Some("done") || !done.get("at").is_some_and(Value::is_number) || early == Some(true) {
        return None;
    }
    if done_index != items.len() - 1 {
        return None;
    }
    let final_id = done.get("finalAssistantId");
    if let Some(reply) = items.iter().find(|item| item.get("id") == final_id && kind(item) == Some("assistant")) {
        let text = reply.get("text");
        let blank = nullish(text) || text.is_some_and(|text| js_trim(&value_to_string(text)).is_empty());
        if !blank {
            return None;
        }
    }
    Some(SessionAnswer { id: done.get("id").cloned().unwrap_or(Value::Null), at: done["at"].clone(), status: "done".to_owned(), text: String::new(), reacted: false })
}

/// `toolSummaries(snapshot, startedAt)`: a finished member turn's tool calls, one bounded line each.
pub fn tool_summaries(snapshot: &Value, started_at: f64) -> Vec<(String, String)> {
    let items = items(snapshot);
    let mut start = items.len();
    while start > 0 && kind(&items[start - 1]) != Some("user") {
        start -= 1;
    }
    items[start..]
        .iter()
        .filter(|item| {
            let at = to_number_of(item.get("at"));
            let at = if at == 0.0 || at.is_nan() { started_at } else { at };
            kind(item) == Some("tool") && at >= started_at
        })
        .map(|item| {
            let name = if truthy(item.get("name")) { value_to_string(&item["name"]) } else { "tool".to_owned() };
            let result = match item.get("result") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) | None => json_stringify(&Value::String(String::new())),
                Some(other) => json_stringify(other),
            };
            (name, slice_utf16(&result, TOOL_SUMMARY))
        })
        .collect()
}

/// `spokenText(answer, waiting)`: a pass never shows its marker. While the user waits, what the
/// member wrote before "(pass)" is its answer; otherwise the turn is a pass.
pub fn spoken_text(answer: &SessionAnswer, waiting: bool) -> String {
    let passed = answer.status != "done" || is_pass_reply(&answer.text);
    if answer.status == "done" && (!passed || waiting) { without_pass_marker(&answer.text) } else { String::new() }
}
