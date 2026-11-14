//! Queued input as the run's steering drain hands it over (`ask-turn-steering-drain.mjs`,
//! the TUI's `drainPendingSteering`): every entry, steered or queued, one input of its own.

use mixdog_core_api::ids::QueuedId;
use serde_json::Value;

use super::completions;
use super::run::SteerInput;
use super::run::SteerMode;

/// A steered entry as the host drain hands it over, alone and unmerged.
pub(crate) fn steered(qid: QueuedId, entry: &Value) -> SteerInput {
    SteerInput {
        queued_ids: vec![submission_of(qid, entry)],
        content: entry.get("message").cloned().unwrap_or(Value::Null),
        text: entry.get("text").and_then(Value::as_str).map(str::to_owned),
        mode: SteerMode::Prompt,
        execution: None,
        submitted_at: entry.get("submittedAt").and_then(Value::as_i64),
        message_id: entry.get("messageId").and_then(Value::as_str).map(str::to_owned),
    }
}

/// The drain as the TUI's `drainPendingSteering` hands it over (`steering.mjs:204`): every
/// accepted entry is its own input, in queue order, a task notification carrying its
/// execution. Entries that carry no content are left out.
pub(crate) fn groups(entries: &[(QueuedId, Value)]) -> Vec<SteerInput> {
    let mut out = Vec::new();
    for (id, entry) in entries {
        let Some(merged) = normalize(entry).and_then(|n| merge(&[n])) else {
            continue;
        };
        if completions::is_notification(entry) {
            out.push(input(vec![submission_of(id.clone(), entry)], merged, SteerMode::TaskNotification, completions::execution(entry)));
        } else {
            out.push(input(vec![submission_of(id.clone(), entry)], merged, SteerMode::Prompt, None));
        }
    }
    out
}

/// `STALE_USER_INJECTION_TTL_MS` (`pending-message-entry.mjs`).
const STALE_USER_INJECTION_TTL_MS: i64 = 30 * 60 * 1000;

/// `PENDING_PROCESS_START_MS`: when this process began owning sessions, read once from the first session's clock
/// (no entry of this process is queued before its first session exists).
pub(crate) fn owner_started_ms(now: i64) -> i64 {
    static STARTED: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *STARTED.get_or_init(|| now)
}

/// `isStaleUserInjection`: an entry that is no completion, queued before this owner started and more than thirty
/// minutes ago.
fn is_stale_user_injection(entry: &Value, now: i64, owner_started: i64) -> bool {
    if entry.get("notificationKind").and_then(Value::as_str) == Some(completions::KIND) {
        return false;
    }
    let enqueued_at = entry.get("enqueuedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    if enqueued_at <= 0 || enqueued_at >= owner_started {
        return false;
    }
    now - enqueued_at > STALE_USER_INJECTION_TTL_MS
}

/// `lateDeliveryText`: the text under a header naming how long it waited; blank text is left as it is.
pub(crate) fn late_delivery_text(text: &str, enqueued_at: i64, now: i64) -> String {
    if mixdog_js::js_trim(text).is_empty() {
        return text.to_owned();
    }
    // `Math.round` of a positive quotient.
    let round = |num: i64, den: i64| ((num as f64 / den as f64) + 0.5).floor() as i64;
    let minutes = round(now - enqueued_at, 60_000).max(1);
    let age = if minutes >= 120 { format!("~{}h", round(minutes, 60)) } else { format!("~{minutes}m") };
    format!("[late delivery: queued {age} ago, before the current session owner started]\n{text}")
}

/// The entry as it is delivered (`hydratePendingMessages`): a stale user entry's string `message` carries the
/// late-delivery header instead of being dropped; structured content and completions are delivered as they are.
pub(crate) fn late_delivery(entry: &Value, now: i64, owner_started: i64) -> Value {
    let mut out = entry.clone();
    if !is_stale_user_injection(entry, now, owner_started) {
        return out;
    }
    if let Some(message) = entry.get("message").and_then(Value::as_str) {
        let enqueued_at = entry.get("enqueuedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64;
        out["message"] = Value::String(late_delivery_text(message, enqueued_at, now));
    }
    out
}

/// `entry.transcriptMeta` when it is an object (`steeringEntryMetadata`, `steering.mjs:33`).
fn meta_of(entry: &Value) -> Option<&Value> {
    entry.get("transcriptMeta").filter(|meta| meta.is_object())
}

/// The id a delivered row names its entry by: the client's submission (`options.clientSubmissionId`, Node's `submissionIds`),
/// else the queue id.
fn submission_of(qid: QueuedId, entry: &Value) -> QueuedId {
    entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).map_or(qid, QueuedId::from)
}

/// The `transcriptMeta` of the steering inputs [`groups`] makes of `entries`, in the same order:
/// each entry's own. An entry without one is absent.
pub(crate) fn group_metas(entries: &[(QueuedId, Value)]) -> Vec<&Value> {
    entries.iter().filter(|(_, entry)| normalize(entry).is_some()).filter_map(|(_, entry)| meta_of(entry)).collect()
}

/// A steered entry's own `transcriptMeta`.
pub(crate) fn steered_meta(entry: &Value) -> Option<&Value> {
    meta_of(entry)
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

/// The names and aliases of the registered slash commands (`SLASH_COMMANDS`, `tui/app/slash-commands.mjs`).
const SLASH_TOKENS: &[&str] = &[
    "clear", "new", "project", "projects", "compact", "btw", "goal", "autoclear", "resume", "context", "shells", "stop",
    "fork", "inherit", "usage", "model", "websearch", "workflow", "outputstyle", "output-style", "style", "theme",
    "agents", "effort", "fast", "mcp", "skills", "memory", "plugins", "providers", "settings", "setting", "config",
    "profile", "update", "doctor", "quit", "exit", "q",
];

/// `isSlashQueuedEntry` (`queue-helpers.mjs`): the entry is not marked `skipSlashCommands` (JS truthiness) and its
/// text (`content ?? text`, a queued prompt's `message` here) begins with `/` and a registered command or alias
/// (`recognisedSlashToken`: `/^\s*\/(\S+)/`, lower-cased).
pub(crate) fn is_slash_entry(entry: &Value) -> bool {
    let skipped = match entry.get("skipSlashCommands") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    if skipped {
        return false;
    }
    let content = ["content", "message", "text"]
        .iter()
        .find_map(|key| entry.get(*key).filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(Value::Null);
    recognised_slash_token(&content_text(&content)).is_some()
}

/// `recognisedSlashToken`: the lower-cased first token when it names a registered command or alias.
pub(crate) fn recognised_slash_token(text: &str) -> Option<String> {
    let rest = mixdog_js::js_trim_start(text).strip_prefix('/')?;
    let token = mixdog_js::js_to_lowercase(rest.split(mixdog_js::is_js_space).next().unwrap_or_default());
    (!token.is_empty() && SLASH_TOKENS.contains(&token.as_str())).then_some(token)
}

#[cfg(test)]
mod slash_tests {
    use super::*;

    fn golden() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/capability-refusals/golden.json");
        serde_json::from_str::<Value>(&std::fs::read_to_string(path).expect("golden")).expect("json")["slash"].clone()
    }

    /// Node's registry (`SLASH_COMMANDS` at b6f10295a, a static table with nothing added at runtime) names exactly these
    /// tokens, and `recognisedSlashToken` answers the recorded token for every probe.
    #[test]
    fn the_slash_tokens_equal_nodes_registry_and_recognition() {
        let slash = golden();
        let mut recorded: Vec<String> = slash["commands"]
            .as_array()
            .expect("commands")
            .iter()
            .flat_map(|command| std::iter::once(command["name"].clone()).chain(command["aliases"].as_array().expect("aliases").clone()))
            .map(|token| token.as_str().expect("token").to_owned())
            .collect();
        let mut ours: Vec<String> = SLASH_TOKENS.iter().map(|token| (*token).to_owned()).collect();
        recorded.sort();
        ours.sort();
        assert_eq!(ours, recorded);
        for probe in slash["probes"].as_array().expect("probes") {
            let text = probe["text"].as_str().expect("text");
            assert_eq!(recognised_slash_token(text), probe["token"].as_str().map(str::to_owned), "{text:?}");
        }
    }
}

/// `promptContentText`.
pub(crate) fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(text) => text.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("image") => "[Image]".to_owned(),
                    Some("file") => "[File]".to_owned(),
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
        assert_eq!(groups.len(), 4);
        assert_eq!(groups[0].mode, SteerMode::Prompt);
        assert_eq!(groups[0].content, json!("먼저 이것"));
        assert_eq!(groups[0].queued_ids, [id("u1")]);
        assert_eq!(groups[1].mode, SteerMode::TaskNotification);
        assert_eq!(groups[1].execution, Some(shell));
        assert_eq!(groups[1].queued_ids, [id("n1")]);
        assert_eq!(groups[2].content, json!("그리고 저것"));
        assert_eq!(groups[2].queued_ids, [id("u2")]);
        assert_eq!(groups[3].execution, Some(agent));
    }

    /// Each entry is its own input; structured content stays one parts array, a blank entry
    /// is left out.
    #[test]
    fn structured_prompts_are_one_input_each() {
        let image = json!({ "type": "image", "data": "AA==", "mimeType": "image/png" });
        let entries = [
            (id("u1"), json!({ "message": "  look  " })),
            (id("u2"), json!({ "message": [{ "type": "text", "text": "at this" }, image] })),
            (id("u3"), json!({ "message": "   " })),
        ];
        let [first, second] = groups(&entries).try_into().expect("two inputs");
        assert_eq!(first.content, json!("look"));
        assert_eq!(first.queued_ids, [id("u1")]);
        assert_eq!(second.content, json!([{ "type": "text", "text": "at this" }, image]));
        assert_eq!(second.text.as_deref(), Some("at this\n[Image]"));
        assert_eq!(second.queued_ids, [id("u2")]);
        assert!(groups(&[(id("u4"), json!({ "message": " \n" }))]).is_empty());
    }

    /// `isStaleUserInjection` and `lateDeliveryText` (`pending-message-entry.mjs`): only a user entry queued before
    /// the owner started and more than thirty minutes ago is headed; the age is minutes below two hours, hours from there.
    #[test]
    fn a_stale_user_entry_is_delivered_under_nodes_late_delivery_header() {
        const MIN: i64 = 60_000;
        let (start, now) = (1_000 * MIN, 1_010 * MIN);
        let late = |entry: Value| late_delivery(&entry, now, start)["message"].clone();
        let header = |age: &str| format!("[late delivery: queued {age} ago, before the current session owner started]\nhello");
        // 31 minutes before now, before the owner started.
        assert_eq!(late(json!({ "message": "hello", "enqueuedAt": now - 31 * MIN })), json!(header("~31m")));
        // 119.4 minutes rounds to 119m; 120 minutes is 2h; 150 minutes rounds to 3h (`Math.round(2.5)`).
        assert_eq!(late(json!({ "message": "hello", "enqueuedAt": now - 119 * MIN - 24_000 })), json!(header("~119m")));
        assert_eq!(late(json!({ "message": "hello", "enqueuedAt": now - 120 * MIN })), json!(header("~2h")));
        assert_eq!(late(json!({ "message": "hello", "enqueuedAt": now - 150 * MIN })), json!(header("~3h")));
        // Exactly thirty minutes is not stale, nor is an entry this owner queued, one without a stamp, or a completion.
        assert_eq!(late(json!({ "message": "hello", "enqueuedAt": now - 30 * MIN })), json!("hello"));
        assert_eq!(late_delivery(&json!({ "message": "hello", "enqueuedAt": start }), start + 90 * MIN, start)["message"], json!("hello"));
        assert_eq!(late(json!({ "message": "hello" })), json!("hello"));
        assert_eq!(late(json!({ "message": "hello", "notificationKind": "completion_notification", "enqueuedAt": 1 })), json!("hello"));
        // A channel notice that is no completion is headed; structured content is delivered as it is.
        assert_eq!(late(json!({ "message": "hello", "mode": "task-notification", "origin": "channel", "enqueuedAt": MIN })), json!(header("~17h")));
        let parts = json!([{ "type": "text", "text": "hello" }]);
        assert_eq!(late(json!({ "message": parts, "enqueuedAt": 1 })), parts);
        assert_eq!(late_delivery_text("  ", 1, now), "  ");
    }

    /// A delivered entry names the client's submission (Node's `submissionIds`), else its queue id.
    #[test]
    fn an_entry_is_named_by_its_client_submission() {
        let entries = [
            (id("q1"), json!({ "message": "a", "options": { "clientSubmissionId": "sub-1" } })),
            (id("q2"), json!({ "message": "b" })),
        ];
        let [first, second] = groups(&entries).try_into().expect("two inputs");
        assert_eq!(first.queued_ids, [id("sub-1")]);
        assert_eq!(second.queued_ids, [id("q2")]);
    }

    /// Each input carries its own entry's `transcriptMeta`; an entry that is no object has none.
    #[test]
    fn a_group_carries_its_own_entry_meta() {
        let shell = json!({ "surface": "shell", "id": "j1" });
        let entries = [
            (id("u1"), json!({ "message": "a" })),
            (id("u2"), json!({ "message": "b", "transcriptMeta": { "hop": 2, "botChain": ["x"] } })),
            (id("u3"), json!({ "message": "c", "transcriptMeta": { "hop": 5 } })),
            (id("n1"), json!({ "message": "done", "mode": "task-notification", "execution": shell, "transcriptMeta": { "hop": 1 } })),
            (id("n2"), json!({ "message": "done too", "mode": "task-notification", "transcriptMeta": "no" })),
        ];
        let metas = group_metas(&entries);
        assert_eq!(metas, [&json!({ "hop": 2, "botChain": ["x"] }), &json!({ "hop": 5 }), &json!({ "hop": 1 })]);
        assert_eq!(steered_meta(&entries[2].1), Some(&json!({ "hop": 5 })));
        assert_eq!(steered_meta(&entries[0].1), None);
    }
}