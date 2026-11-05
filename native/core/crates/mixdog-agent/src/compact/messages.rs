//! Message classification and protected-context splitting for compaction.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Role;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_start;

use crate::message::AgentMessage;
use crate::message::Source;
use crate::project::is_actual_user_instruction;
use crate::project::is_control_marker;
use crate::project::is_protected_context_user;

static REFERENCE_FILES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^Reference files:\s*", "i"));
static REFERENCE_PATH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^###\s+(.+?)\s*$", "m"));

/// The assistant `.` that closes an injected context turn so the next prompt
/// stays its own message. Model context only.
pub fn context_ack_message() -> AgentMessage {
    let mut ack = AgentMessage::assistant(".", Vec::new());
    ack.source = Some(Source::ContextAck);
    ack
}

pub fn is_protected_context_ack(m: &AgentMessage) -> bool {
    m.role() == Role::Assistant
        && matches!(&m.message.content, Content::Text(text) if js_trim(text) == ".")
        && m.tool_calls().is_empty()
}

pub fn latest_actual_user_instruction_index(messages: &[AgentMessage]) -> Option<usize> {
    messages.iter().rposition(is_actual_user_instruction)
}

/// The user instruction that began the request `index` belongs to; a
/// steering message continues the request instead of starting one.
pub fn request_start(messages: &[AgentMessage], index: usize) -> Option<usize> {
    let end = (index + 1).min(messages.len());
    let started = messages[..end]
        .iter()
        .rposition(|m| is_actual_user_instruction(m) && m.source != Some(Source::Steering));
    started.or_else(|| latest_actual_user_instruction_index(&messages[..end]))
}

/// Delivered task notifications the model has not answered yet: every one
/// after the latest final assistant reply. They are turn input and must
/// survive a compaction verbatim.
pub fn pending_task_notification_indexes(messages: &[AgentMessage]) -> Vec<usize> {
    let mut pending = Vec::new();
    for index in (0..messages.len()).rev() {
        let m = &messages[index];
        if m.role() == Role::Assistant
            && m.tool_calls().is_empty()
            && !is_protected_context_ack(m)
            && m.source != Some(Source::CompactExecutionText)
        {
            break;
        }
        if m.role() == Role::User && m.source == Some(Source::TaskNotification) {
            pending.insert(0, index);
        }
    }
    pending
}

/// Runtime rows that are conversation, not instructions: notifications,
/// schedule results and turn-interruption markers.
pub fn is_compact_conversation_row(m: &AgentMessage) -> bool {
    if m.role() != Role::User {
        return false;
    }
    if matches!(m.source, Some(Source::TaskNotification | Source::ScheduleResult)) {
        return true;
    }
    matches!(&m.message.content, Content::Text(text) if is_control_marker(text))
        && !is_actual_user_instruction(m)
}

/// A tool call's arguments as an object, whether stored parsed or as JSON text.
pub fn call_arguments(arguments: &serde_json::Value) -> serde_json::Value {
    let parsed = match arguments {
        serde_json::Value::String(text) => serde_json::from_str(text).unwrap_or(serde_json::Value::Null),
        other => other.clone(),
    };
    if parsed.is_object() { parsed } else { serde_json::json!({}) }
}

/// The reference-files message rewritten as a manifest of its paths: the
/// bodies are not re-injected after a compaction.
fn reference_files_manifest(m: &AgentMessage) -> Option<AgentMessage> {
    let Content::Text(text) = &m.message.content else {
        return None;
    };
    if m.role() != Role::User {
        return None;
    }
    let text = js_trim_start(text);
    if !REFERENCE_FILES.is_match(text) {
        return None;
    }
    let mut paths: Vec<&str> = Vec::new();
    for found in REFERENCE_PATH.captures_iter(text) {
        if let Some(path) = found.get(1).map(js_trim)
            && !path.is_empty()
            && !paths.contains(&path)
        {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return None;
    }
    let mut lines = vec![
        "<system-reminder>".to_owned(),
        "# Reference files".to_owned(),
        "These files were attached when the session started. Re-read a path when its current contents are needed; the original bodies are not re-injected after Compact.".to_owned(),
    ];
    lines.extend(paths.iter().map(|path| format!("- {path}")));
    lines.push("</system-reminder>".to_owned());
    let mut manifest = AgentMessage::user(lines.join("\n"));
    manifest.message_id = m.message_id.clone();
    Some(manifest)
}

pub struct ProtectedSplit {
    pub protected_prefix: Vec<AgentMessage>,
    pub conversation: Vec<AgentMessage>,
}

pub fn split_protected_context(messages: &[AgentMessage]) -> ProtectedSplit {
    let mut protected_prefix = Vec::new();
    let mut conversation = Vec::new();
    let mut prefix_mode = true;
    let mut previous_was_protected = false;
    for m in messages {
        if m.role() == Role::System {
            protected_prefix.push(m.clone());
            previous_was_protected = false;
            continue;
        }
        if prefix_mode && is_protected_context_user(m) {
            protected_prefix.push(m.clone());
            previous_was_protected = true;
            continue;
        }
        if prefix_mode && let Some(manifest) = reference_files_manifest(m) {
            protected_prefix.push(manifest);
            previous_was_protected = true;
            continue;
        }
        if prefix_mode && previous_was_protected && is_protected_context_ack(m) {
            protected_prefix.push(m.clone());
            previous_was_protected = false;
            continue;
        }
        prefix_mode = false;
        previous_was_protected = false;
        conversation.push(m.clone());
    }
    ProtectedSplit { protected_prefix, conversation }
}
