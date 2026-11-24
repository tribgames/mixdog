//! What a finished turn hands back (`session-runtime/handoff-attachments.mjs`): [`turn_slice`], the
//! messages of one turn, and [`sensitive`], the credential/secret deny list
//! (`runtime/shared/sensitive-path-rules.mjs`) an automatic hand-off never crosses.

use serde_json::Value;

/// `turnSlice(messages, { runId, since })`: from the user message that took submission `run_id`
/// (or, with `since`, the first user message at or after it) to the end; all of `messages` when
/// neither is asked, and none when the one asked for is not found.
pub fn turn_slice(messages: &Value, run_id: &str, since: f64) -> Vec<Value> {
    let list: &[Value] = messages.as_array().map_or(&[], Vec::as_slice);
    let user = |message: &Value| message.get("role").and_then(Value::as_str) == Some("user");
    let transcript_of = |message: &Value| message.get("meta").and_then(|meta| meta.get("transcript")).cloned().unwrap_or(Value::Null);
    let start = if !run_id.is_empty() {
        list.iter().position(|message| {
            if !user(message) {
                return false;
            }
            let transcript = transcript_of(message);
            let ids = |value: Option<&Value>| value.and_then(Value::as_array).cloned().unwrap_or_default();
            let mut named = std::iter::once(transcript.get("checkpointId").cloned().unwrap_or(Value::Null))
                .chain(ids(transcript.get("submissionIds")))
                .chain(ids(message.get("meta").and_then(|meta| meta.get("submissionIds"))));
            named.any(|id| id.as_str() == Some(run_id))
        })
    } else if since > 0.0 {
        list.iter().position(|message| user(message) && mixdog_js::to_number_of(transcript_of(message).get("at")) >= since)
    } else {
        None
    };
    match start {
        Some(start) => list[start..].to_vec(),
        None if !run_id.is_empty() || since > 0.0 => Vec::new(),
        None => list.to_vec(),
    }
}

/// The credential / secret file deny list of the runtime's attachment hand-offs (the workspace's, which also keeps a paired device
/// from those files).
pub use mixdog_workspace::sensitive;
