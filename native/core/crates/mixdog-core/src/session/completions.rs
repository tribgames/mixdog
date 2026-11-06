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
const KIND: &str = "completion_notification";

/// `pendingEntryMode(entry) === PENDING_MODE_TASK_NOTIFICATION`.
pub fn is_notification(entry: &Value) -> bool {
    entry.get("mode").and_then(Value::as_str) == Some(MODE)
        || entry.get("notificationKind").and_then(Value::as_str) == Some(KIND)
}

/// A queued completion: its id and the persisted entry without it (`markCompletionEntry`
/// through `normalizePersistedEntryBase`). The id is addressed by the execution, so the same
/// completion queued twice is one entry. `None` for blank text, which Node never queues.
pub fn entry(task_id: &str, status: &str, text: &str, now: i64) -> Option<(String, Value)> {
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
    if let Some(parsed) = mixdog_agent::project::parse_task_notification(text) {
        execution.insert("surface".into(), Value::String(parsed.surface));
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
        let (id, entry) = entry("job-7", "completed", &format!("  {SHELL}\n"), 42).unwrap();
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
        assert!(super::entry("job-7", "completed", " \n", 1).is_none());
    }
}
