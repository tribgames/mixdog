//! A failed turn's retry resubmits its prompt (`manager/failed-turn-rewind.mjs`). The stale copy
//! the failure left in the model context is dropped first, so the retry reaches the model once:
//! the trailing prompt a text resubmission repeats verbatim (`trailingUnansweredPromptIndex`), or
//! the failed message a retry names by id (`retainedFailedTurnInput`). An answered tail is kept:
//! the retry then continues from it. The log's rows stay; the model context shrinks, durably
//! (`RunPort::context_rewound`), for this run and the turns after it.

use mixdog_core_api::ids::ItemId;
use mixdog_js::js_trim;
use mixdog_protocol::thread::SubmitOptions;
use serde_json::Value;

fn is_role(message: &Value, role: &str) -> bool {
    message.get("role").and_then(Value::as_str) == Some(role)
}

fn text_part(part: &Value) -> bool {
    part.is_string() || part.get("type").and_then(Value::as_str) == Some("text")
}

/// `promptContentText` over text-only content.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                part => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `stripRuntimeUserContext(message).content`: the producer's own prefix and suffix come off; a
/// stale boundary leaves the content as stored.
fn stripped_content(message: &Value) -> Value {
    let content = message.get("content").cloned().unwrap_or(Value::Null);
    let context = message.pointer("/meta/runtimeUserContext").filter(|_| is_role(message, "user"));
    let (Some(prefix), Some(suffix)) = (
        context.and_then(|context| context.get("prefix")).and_then(Value::as_str),
        context.and_then(|context| context.get("suffix")).and_then(Value::as_str),
    ) else {
        return content;
    };
    match &content {
        Value::String(text) => {
            let (text_len, bounds) = (text.encode_utf16().count(), prefix.encode_utf16().count() + suffix.encode_utf16().count());
            if text_len < bounds || !text.starts_with(prefix) || !text.ends_with(suffix) {
                return content;
            }
            Value::String(text[prefix.len()..text.len() - suffix.len()].to_owned())
        }
        Value::Array(parts) => {
            let block = |part: Option<&Value>, want: &str| {
                part.is_some_and(|part| part.get("type").and_then(Value::as_str) == Some("text") && part.get("text").and_then(Value::as_str) == Some(want))
            };
            if (!prefix.is_empty() && !block(parts.first(), prefix))
                || (!suffix.is_empty() && !block(parts.last(), suffix))
                || parts.len() < usize::from(!prefix.is_empty()) + usize::from(!suffix.is_empty())
            {
                return content;
            }
            Value::Array(parts[usize::from(!prefix.is_empty())..parts.len() - usize::from(!suffix.is_empty())].to_vec())
        }
        _ => content,
    }
}

/// `trailingUnansweredPromptIndex`: the trailing user row `prompt` repeats verbatim; none when
/// the tail was answered, the texts differ, or the stored prompt carries media a text
/// resubmission would lose.
pub(crate) fn trailing_unanswered_prompt_index(messages: &[Value], prompt: &str) -> Option<usize> {
    let resubmitted = js_trim(prompt);
    if resubmitted.is_empty() {
        return None;
    }
    let (index, message) = messages.iter().enumerate().rev().find(|(_, message)| !is_role(message, "system"))?;
    if !is_role(message, "user") {
        return None;
    }
    let content = stripped_content(message);
    let text_only = match &content {
        Value::String(_) => true,
        Value::Array(parts) => parts.iter().all(text_part),
        _ => false,
    };
    (text_only && js_trim(&content_text(&content)) == resubmitted).then_some(index)
}

pub(crate) const NOT_LATEST_EXECUTION: &str = "The failed turn is no longer the latest execution.";
pub(crate) const NOT_LATEST_ATTEMPT: &str = "The failed attempt is no longer the latest execution.";

/// `retainedFailedTurnInput`: the failed user message the retry names, resolved against the
/// durable failure; `None` when the latest message is not a user row.
pub(crate) fn retained_failed_turn_input(messages: &[Value], message_id: &str, attempt_id: Option<&str>) -> Result<Option<usize>, &'static str> {
    let latest = messages.iter().enumerate().rev().find(|(_, message)| !is_role(message, "system"));
    let transcript = latest.and_then(|(_, message)| message.pointer("/meta/transcript"));
    let failed = transcript.and_then(|transcript| transcript.pointer("/completion/status")).and_then(Value::as_str) == Some("failed");
    if message_id.is_empty() || transcript.and_then(|transcript| transcript.get("messageId")).and_then(Value::as_str) != Some(message_id) || !failed {
        return Err(NOT_LATEST_EXECUTION);
    }
    let recorded = transcript.and_then(|transcript| transcript.pointer("/completion/attemptId")).and_then(Value::as_str).unwrap_or_default();
    if !recorded.is_empty() && Some(recorded) != attempt_id {
        return Err(NOT_LATEST_ATTEMPT);
    }
    Ok(latest.filter(|(_, message)| is_role(message, "user")).map(|(index, _)| index))
}

/// The context a retry turn starts from: the stale copy of the failed prompt is dropped
/// (`prepareAskTurn`: a retry that names its message resolves it, a bare retry rewinds the
/// unanswered prompt). The rows dropped, none when the context stays as read.
pub(crate) fn rewound(stored: &mut Vec<(ItemId, Value)>, options: Option<&SubmitOptions>, prompt: &str) -> Result<Vec<(ItemId, Value)>, &'static str> {
    let Some(options) = options else { return Ok(Vec::new()) };
    let bodies: Vec<Value> = stored.iter().map(|(_, body)| body.clone()).collect();
    let index = match options.retry_turn_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => retained_failed_turn_input(&bodies, id, options.retry_attempt_id.as_deref())?,
        None if options.retry_failed_turn == Some(true) => trailing_unanswered_prompt_index(&bodies, prompt),
        None => None,
    };
    Ok(index.map(|index| stored.split_off(index)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Node's `failed-turn-rewind.mjs` answers (`fixtures/failed-turn-rewind`).
    #[test]
    fn the_rewind_answers_nodes_index_and_refusals() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/failed-turn-rewind/golden.json")).expect("golden");
        for case in golden["rewind"].as_array().expect("cases") {
            let messages: Vec<Value> = serde_json::from_value(case["messages"].clone()).expect("messages");
            let want = case["index"].as_i64().filter(|index| *index >= 0).map(|index| index as usize);
            assert_eq!(trailing_unanswered_prompt_index(&messages, case["prompt"].as_str().expect("prompt")), want, "{}", case["name"]);
        }
        for case in golden["retained"].as_array().expect("cases") {
            let messages: Vec<Value> = serde_json::from_value(case["messages"].clone()).expect("messages");
            let got = retained_failed_turn_input(&messages, case["id"].as_str().expect("id"), case["attempt"].as_str());
            match case.get("error").and_then(Value::as_str) {
                Some(error) => assert_eq!(got, Err(error), "{}", case["name"]),
                None => assert_eq!(got, Ok(case["index"].as_u64().map(|index| index as usize)), "{}", case["name"]),
            }
        }
    }

    fn row(id: &str, body: Value) -> (ItemId, Value) {
        (ItemId::from(id.to_owned()), body)
    }

    /// A bare retry drops the unanswered copy of its prompt, a named retry drops the failed
    /// message it names, and anything else leaves the context as read.
    #[test]
    fn a_retry_turn_starts_from_the_context_without_the_stale_prompt() {
        let history = || vec![row("a", json!({ "role": "user", "content": "first" })), row("b", json!({ "role": "assistant", "content": "ok" })), row("c", json!({ "role": "user", "content": "go", "meta": { "transcript": { "messageId": "m1", "completion": { "status": "failed" } } } }))];
        let bare = SubmitOptions { retry_failed_turn: Some(true), ..Default::default() };
        let dropped = |rows: Vec<(ItemId, Value)>| rows.into_iter().map(|(iid, _)| iid.0).collect::<Vec<_>>();
        let mut stored = history();
        assert_eq!(rewound(&mut stored, Some(&bare), "go").map(dropped), Ok(vec!["c".to_owned()]));
        assert_eq!(stored.len(), 2);
        let mut stored = history();
        assert_eq!(rewound(&mut stored, Some(&bare), "other").map(dropped), Ok(Vec::new()));
        assert_eq!(stored.len(), 3);
        let named = SubmitOptions { retry_failed_turn: Some(true), retry_turn_id: Some("m1".into()), ..Default::default() };
        let mut stored = history();
        assert_eq!(rewound(&mut stored, Some(&named), "go").map(dropped), Ok(vec!["c".to_owned()]));
        assert_eq!(stored.len(), 2);
        let stale = SubmitOptions { retry_turn_id: Some("m2".into()), ..Default::default() };
        assert_eq!(rewound(&mut history(), Some(&stale), "go").map(dropped), Err(NOT_LATEST_EXECUTION));
        assert_eq!(rewound(&mut history(), None, "go").map(dropped), Ok(Vec::new()));
        assert_eq!(rewound(&mut history(), Some(&SubmitOptions::default()), "go").map(dropped), Ok(Vec::new()));
    }
}
