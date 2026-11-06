//! Queued input as the run's steering drain hands it over (`ask-turn-steering-drain.mjs`): a
//! steered entry one input each, the rest of the queue grouped by mode, the prompts merged
//! into one input and each task notification on its own (`_groupPendingMessageEntries`).

use mixdog_core_api::ids::QueuedId;
use serde_json::Value;

use super::completions;
use super::run::SteerInput;
use super::run::SteerMode;

/// A steered entry as the host drain hands it over, alone and unmerged.
pub(crate) fn steered(qid: QueuedId, entry: &Value) -> SteerInput {
    SteerInput {
        queued_ids: vec![qid],
        content: entry.get("message").cloned().unwrap_or(Value::Null),
        text: entry.get("text").and_then(Value::as_str).map(str::to_owned),
        mode: SteerMode::Prompt,
        execution: None,
        submitted_at: entry.get("submittedAt").and_then(Value::as_i64),
        message_id: entry.get("messageId").and_then(Value::as_str).map(str::to_owned),
    }
}

/// `_groupPendingMessageEntries`: the prompts merged into one input (carrying every prompt's
/// id), then each task notification on its own, in queue order. Empty when nothing carries
/// content.
pub(crate) fn groups(entries: &[(QueuedId, Value)]) -> Vec<SteerInput> {
    let (notes, prompts): (Vec<_>, Vec<_>) =
        entries.iter().partition(|(_, entry)| completions::is_notification(entry));
    let mut out = Vec::new();
    let normalized: Vec<Normalized> = prompts.iter().filter_map(|(_, entry)| normalize(entry)).collect();
    if let Some(merged) = merge(&normalized) {
        out.push(input(prompts.iter().map(|(id, _)| id.clone()).collect(), merged, SteerMode::Prompt, None));
    }
    for (id, entry) in notes {
        let Some(merged) = normalize(entry).and_then(|n| merge(&[n])) else {
            continue;
        };
        let execution = completions::execution(entry);
        out.push(input(vec![id.clone()], merged, SteerMode::TaskNotification, execution));
    }
    out
}

fn input(queued_ids: Vec<QueuedId>, merged: Normalized, mode: SteerMode, execution: Option<Value>) -> SteerInput {
    SteerInput {
        queued_ids,
        content: merged.content,
        text: Some(merged.text),
        mode,
        execution,
        submitted_at: None,
        message_id: None,
    }
}

pub(crate) struct Normalized {
    pub content: Value,
    pub text: String,
}

/// `promptContentText`.
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("image") => "[Image]".to_owned(),
                    _ => part.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
                },
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        Value::Object(_) => "[object Object]".to_owned(),
        other => other.to_string(),
    }
}

/// `normalizePendingMessageEntry`. A queued turn's prompt is its `message`, a string or an
/// array of parts (Node keeps parts under `content`).
pub(crate) fn normalize(entry: &Value) -> Option<Normalized> {
    let content = match (entry.get("content"), entry.get("message"), entry.get("text")) {
        (Some(content), _, _) => content.clone(),
        (None, Some(message @ (Value::String(_) | Value::Array(_))), _) => message.clone(),
        (None, _, Some(text @ Value::String(_))) => text.clone(),
        _ => return None,
    };
    let own_text = entry.get("text").and_then(Value::as_str);
    let text = match own_text {
        Some(text) => mixdog_js::js_trim(text).to_owned(),
        None => mixdog_js::js_trim(&content_text(&content)).to_owned(),
    };
    match content {
        Value::Array(parts) => (!parts.is_empty()).then(|| Normalized { content: Value::Array(parts), text }),
        Value::String(raw) => {
            let value = mixdog_js::js_trim(&raw).to_owned();
            if value.is_empty() {
                return None;
            }
            let text = if text.is_empty() { value.clone() } else { text };
            Some(Normalized { content: Value::String(value), text })
        }
        other => {
            let fallback = mixdog_js::js_trim(&content_text(&other)).to_owned();
            if fallback.is_empty() {
                return None;
            }
            let text = if text.is_empty() { fallback.clone() } else { text };
            Some(Normalized { content: Value::String(fallback), text })
        }
    }
}

/// `mergeNormalizedContentEntries(normalized, promptContentText)`: all-string content joins
/// with newlines, anything structured becomes one parts array with a newline part between
/// entries; the display text is the non-blank texts joined with newlines.
fn merge(normalized: &[Normalized]) -> Option<Normalized> {
    if normalized.is_empty() {
        return None;
    }
    let display = normalized
        .iter()
        .map(|entry| if entry.text.is_empty() { content_text(&entry.content) } else { entry.text.clone() })
        .filter(|text| !mixdog_js::js_trim(text).is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.iter().all(|entry| entry.content.is_string()) {
        let content = normalized
            .iter()
            .filter_map(|entry| entry.content.as_str().filter(|text| !text.is_empty()))
            .collect::<Vec<_>>()
            .join("\n");
        // `merged?.content`: an empty join carries nothing.
        return (!content.is_empty()).then(|| Normalized { content: Value::String(content), text: display });
    }
    let newline = || serde_json::json!({ "type": "text", "text": "\n" });
    let mut parts: Vec<Value> = Vec::new();
    for entry in normalized {
        match &entry.content {
            Value::String(text) => {
                if !mixdog_js::js_trim(text).is_empty() {
                    parts.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
            Value::Array(items) => parts.extend(items.iter().cloned()),
            other => {
                let text = content_text(other);
                if !mixdog_js::js_trim(&text).is_empty() {
                    parts.push(serde_json::json!({ "type": "text", "text": text }));
                }
            }
        }
        parts.push(newline());
    }
    while parts.last() == Some(&newline()) {
        parts.pop();
    }
    let content = Value::Array(parts);
    let text = if display.is_empty() { content_text(&content) } else { display };
    Some(Normalized { content, text })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(text: &str) -> QueuedId {
        QueuedId::from(text)
    }

    /// `pending-task-notification-mode.test.mjs` "a drain batch groups by mode: prompts merge
    /// into one turn, each notification stands alone".
    #[test]
    fn a_drain_batch_groups_by_mode() {
        let shell = json!({ "surface": "shell", "id": "job_recovery_1", "status": "failed", "resultType": "shell_task_result" });
        let agent = json!({ "surface": "agent", "id": "task_2", "status": "completed", "resultType": "agent_task_result" });
        let entries = [
            (id("u1"), json!({ "message": "먼저 이것", "enqueuedAt": 10 })),
            (id("n1"), json!({ "message": "Async shell task job_recovery_1 (failed, exit n/a) finished.", "mode": "task-notification", "execution": shell })),
            (id("u2"), json!({ "message": "그리고 저것", "enqueuedAt": 30 })),
            (id("n2"), json!({ "message": "Async agent task task_2 (completed) finished.\n\nResult:\n> done", "mode": "task-notification", "execution": agent })),
        ];
        let groups = groups(&entries);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].mode, SteerMode::Prompt);
        assert_eq!(groups[0].content, json!("먼저 이것\n그리고 저것"));
        assert_eq!(groups[0].queued_ids, [id("u1"), id("u2")]);
        assert_eq!(groups[1].mode, SteerMode::TaskNotification);
        assert_eq!(groups[1].execution, Some(shell));
        assert_eq!(groups[1].queued_ids, [id("n1")]);
        assert_eq!(groups[2].execution, Some(agent));
        for group in &groups[1..] {
            assert!(!group.content.as_str().unwrap().contains("이것"));
        }
    }

    /// `mergeNormalizedContentEntries`: structured content becomes one parts array, a newline
    /// part between entries and none trailing; the display text joins each entry's text.
    #[test]
    fn structured_prompts_merge_into_one_parts_array() {
        let image = json!({ "type": "image", "data": "AA==", "mimeType": "image/png" });
        let entries = [
            (id("u1"), json!({ "message": "  look  " })),
            (id("u2"), json!({ "message": [{ "type": "text", "text": "at this" }, image] })),
            (id("u3"), json!({ "message": "   " })),
        ];
        let [merged] = groups(&entries).try_into().expect("one group");
        assert_eq!(
            merged.content,
            json!([{ "type": "text", "text": "look" }, { "type": "text", "text": "\n" }, { "type": "text", "text": "at this" }, image])
        );
        assert_eq!(merged.text.as_deref(), Some("look\nat this\n[Image]"));
        assert_eq!(merged.queued_ids, [id("u1"), id("u2"), id("u3")]);
        assert!(groups(&[(id("u4"), json!({ "message": " \n" }))]).is_empty());
    }
}
