//! Background-job completions in the thread's queue, as today's pending-message entries
//! (`pending-message-entry.mjs`): a completion is queued like any input, a running turn takes
//! it at its next model-call boundary, and what no turn took starts its own turn.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

/// `PENDING_MODE_TASK_NOTIFICATION`.
pub const MODE: &str = "task-notification";
/// `COMPLETION_NOTIFICATION_KIND`.
pub(crate) const KIND: &str = "completion_notification";

/// `pendingEntryMode(entry) === PENDING_MODE_TASK_NOTIFICATION`.
pub fn is_notification(entry: &Value) -> bool {
    entry.get("mode").and_then(Value::as_str) == Some(MODE)
        || entry.get("notificationKind").and_then(Value::as_str) == Some(KIND)
}

/// A queued completion: its id and the persisted entry without it (`markCompletionEntry`
/// through `normalizePersistedEntryBase`, with `meta: {execution_surface, execution_id,
/// status}`). The id is addressed by the execution, so the same completion queued twice is
/// one entry. `None` for blank text, which Node never queues.
pub fn entry(surface: &str, task_id: &str, status: &str, text: &str, now: i64) -> Option<(String, Value)> {
    let message = mixdog_js::js_trim(text);
    if message.is_empty() {
        return None;
    }
    let execution_id = mixdog_js::js_trim(task_id);
    let identity = if execution_id.is_empty() {
        format!("content:{text}")
    } else {
        format!("execution:{execution_id}")
    };
    let digest = Sha256::digest(identity.as_bytes());
    let id = format!("completion_{}", &hex(&digest)[..24]);
    let mut execution = Map::new();
    let surface = mixdog_js::js_trim(surface);
    if !surface.is_empty() {
        execution.insert("surface".into(), Value::String(surface.to_owned()));
    }
    if !execution_id.is_empty() {
        execution.insert("id".into(), Value::String(execution_id.to_owned()));
    }
    let status = mixdog_js::js_trim(status);
    if !status.is_empty() {
        execution.insert("status".into(), Value::String(status.to_owned()));
    }
    let mut entry = json!({ "message": message, "notificationKind": KIND, "mode": MODE });
    if !execution_id.is_empty() {
        entry["executionId"] = Value::String(execution_id.to_owned());
    }
    if !execution.is_empty() {
        entry["execution"] = Value::Object(execution);
    }
    entry["enqueuedAt"] = json!(now);
    Some((id, entry))
}

/// `PROMPT_ORIGIN_CHANNEL` (`shared/prompt-origin.mjs:8`).
pub const ORIGIN_CHANNEL: &str = "channel";

/// `PROMPT_ORIGIN_AGENT_REPORT` (`shared/prompt-origin.mjs`).
pub const ORIGIN_AGENT_REPORT: &str = "agent-report";

/// `promptOriginOf(entry.origin)` (`prompt-origin.mjs:16-21`): a known origin, else none.
pub fn prompt_origin(entry: &Value) -> Option<&'static str> {
    match entry.get("origin").and_then(Value::as_str) {
        Some(ORIGIN_CHANNEL) => Some(ORIGIN_CHANNEL),
        Some(ORIGIN_AGENT_REPORT) => Some(ORIGIN_AGENT_REPORT),
        _ => None,
    }
}

/// Whether the entry is an inbound channel message, which `submitSession` starts a turn for whatever
/// `autoWakeCompletions` says (that flag gates only `wakeQueuedCompletion`, `infrastructure.mjs:154`).
pub fn is_channel(entry: &Value) -> bool {
    prompt_origin(entry) == Some(ORIGIN_CHANNEL)
}

/// A channel notification queued as a task notification that is not a completion
/// (`channel-session-router.mjs:23-28`; the entry `explicitModeField` keeps,
/// `pending-message-entry.mjs:176-183`): `mode` and `origin`, no execution. `None` for blank text.
pub fn channel_entry(text: &str, now: i64) -> Option<Value> {
    let message = mixdog_js::js_trim(text);
    if message.is_empty() {
        return None;
    }
    Some(json!({ "message": message, "mode": MODE, "origin": ORIGIN_CHANNEL, "priority": "later", "enqueuedAt": now }))
}

/// The text a queued completion delivers.
pub fn text(entry: &Value) -> String {
    entry.get("message").and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The entry's execution provenance (`group.execution`).
pub fn execution(entry: &Value) -> Option<Value> {
    entry.get("execution").filter(|e| e.is_object()).cloned()
}

/// The input row of the turn a completion starts: stored as a task notification with its
/// execution, never as the user speaking (`ask-queue.mjs` `tailTurnFor`/`queuedTurnInput`).
pub fn input_row(entry: &Value) -> Value {
    let mut meta = json!({ "source": MODE });
    if let Some(execution) = execution(entry) {
        meta["execution"] = execution;
    }
    // The turn's prompt origin rides its input row's meta beside `source` (`turnPromptSourceFor`,
    // `ask-turn-execute.mjs:27-34`, spread into `userTurnMeta` at `ask-turn-prepare.mjs:223-225`): the
    // warmer's `cacheWarmTurnKind` reads it back (`cache-warm.mjs:541-545,563-571`; `warmer/plan.rs`).
    if let Some(origin) = prompt_origin(entry) {
        meta["origin"] = Value::String(origin.to_owned());
    }
    json!({ "role": "user", "content": text(entry), "meta": meta })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = "<task-notification>\n<task-id>job-7</task-id>\n<status>completed</status>\n<summary>Shell task completed (exit 0)</summary>\n<result>\nok\n</result>\n</task-notification>";

    /// `markCompletionEntry(text, {meta: {execution_id, status}})` persisted.
    #[test]
    fn a_completion_is_queued_as_nodes_persisted_entry() {
        let (id, entry) = entry("shell", "job-7", "completed", &format!("  {SHELL}\n"), 42).unwrap();
        // sha256("execution:job-7"), first 24 hex digits.
        assert_eq!(id, format!("completion_{}", &hex(&Sha256::digest(b"execution:job-7"))[..24]));
        assert_eq!(
            entry,
            json!({
                "message": SHELL,
                "notificationKind": "completion_notification",
                "mode": "task-notification",
                "executionId": "job-7",
                "execution": { "surface": "shell", "id": "job-7", "status": "completed" },
                "enqueuedAt": 42,
            })
        );
        assert!(is_notification(&entry));
        assert!(is_notification(&json!({ "message": "x", "mode": "task-notification" })));
        assert!(!is_notification(&json!({ "message": "x" })));
        assert_eq!(
            input_row(&entry),
            json!({
                "role": "user",
                "content": SHELL,
                "meta": {
                    "source": "task-notification",
                    "execution": { "surface": "shell", "id": "job-7", "status": "completed" },
                },
            })
        );
        assert!(super::entry("shell", "job-7", "completed", " \n", 1).is_none());
    }

    /// `promptOriginOf` and the origin on the input row's meta (`ask-turn-prepare.mjs:223-225`).
    #[test]
    fn a_known_origin_rides_the_input_row_and_a_channel_entry_is_not_held_back() {
        let channel = channel_entry(" PR opened ", 5).unwrap();
        assert_eq!(channel, json!({ "message": "PR opened", "mode": "task-notification", "origin": "channel", "priority": "later", "enqueuedAt": 5 }));
        assert!(is_channel(&channel));
        assert_eq!(input_row(&channel)["meta"], json!({ "source": "task-notification", "origin": "channel" }));
        let report = json!({ "message": "x", "mode": "task-notification", "origin": "agent-report" });
        assert!(!is_channel(&report));
        assert_eq!(input_row(&report)["meta"]["origin"], "agent-report");
        let unknown = json!({ "message": "x", "mode": "task-notification", "origin": "other" });
        assert_eq!(input_row(&unknown)["meta"], json!({ "source": "task-notification" }));
        assert!(channel_entry("  ", 5).is_none());
    }
}
