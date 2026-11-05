//! What one model-context message contributes to the catalog row (1.4.5
//! `_sessionMessageProjection`): the per-message part, stored in the index as
//! `message_rows` and aggregated by `read_stats`.

use serde_json::Value;

use crate::agent_mode::wants_incoming_tail;
use crate::routine_result::is_routine_result_message;
use crate::routine_result::routine_provenance;
use crate::routine_result::routine_result_notice_text;
use crate::session_text::is_session_preview_noise;
use crate::session_text::session_message_text;
use crate::summary::MessageStats;
use crate::title::clean_summary_preview;
use crate::user_message_kind::is_real_turn_message;

const LAST_MESSAGE_PREVIEW_MAX: usize = 160;
/// One past the pill's 99.
pub const INCOMING_TAIL_MAX: usize = 100;

#[derive(Debug, Clone, PartialEq)]
pub struct MessageRow {
    /// A `user`/`assistant` message (counts in `messageCount`).
    pub counted: bool,
    pub real: bool,
    /// An incoming kind with a last-message line.
    pub incoming: bool,
    /// The first-prompt preview candidate ('' when none).
    pub preview: String,
    /// The last-message line ('' when none).
    pub line: String,
    /// Routine provenance of `line` (null or object, as JSON text).
    pub routine: String,
}

fn role(message: &Value) -> Option<&str> {
    message.get("role").and_then(Value::as_str)
}

fn is_incoming_kind(message: &Value) -> bool {
    if is_routine_result_message(message) {
        return true;
    }
    if role(message) != Some("assistant") {
        return false;
    }
    let has_calls = match message.get("toolCalls") {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    };
    let tool_use = message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|c| c.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")));
    !has_calls && !tool_use
}

impl MessageRow {
    /// The row of `message`, a member of the model context.
    pub fn of(message: &Value) -> MessageRow {
        let conversational = matches!(role(message), Some("user" | "assistant"));
        let content = message.get("content").unwrap_or(&Value::Null);
        let preview = if role(message) != Some("user") || is_routine_result_message(message) {
            String::new()
        } else {
            let raw = session_message_text(content);
            if is_session_preview_noise(&raw) { String::new() } else { clean_summary_preview(&raw, 240) }
        };
        let line = if conversational {
            let raw = if is_routine_result_message(message) {
                routine_result_notice_text(message)
            } else {
                session_message_text(content)
            };
            if is_session_preview_noise(&raw) { String::new() } else { clean_summary_preview(&raw, LAST_MESSAGE_PREVIEW_MAX) }
        } else {
            String::new()
        };
        let routine = if line.is_empty() { Value::Null } else { routine_provenance(message) };
        MessageRow {
            counted: conversational,
            real: is_real_turn_message(message),
            incoming: conversational && !line.is_empty() && is_incoming_kind(message),
            preview,
            line,
            routine: routine.to_string(),
        }
    }
}

/// The catalog stats of the live rows (in context order) of `session`.
pub struct StatsRows {
    pub count: u64,
    pub real: u64,
    /// Places (1-based among counted rows) of the newest incoming rows, oldest first.
    pub incoming: Vec<u64>,
    pub preview: String,
    pub last: Option<(String, String)>,
}

impl StatsRows {
    pub fn into_stats(self, session: &str) -> MessageStats {
        let (last, last_routine) = match self.last {
            Some((line, routine)) => (line, serde_json::from_str(&routine).expect("stored routine")),
            None => (String::new(), Value::Null),
        };
        MessageStats {
            count: self.count,
            real: self.real,
            incoming: wants_incoming_tail(session).then_some(self.incoming),
            preview: self.preview,
            last,
            last_routine,
        }
    }
}
