//! What one model-context message contributes to the catalog row (1.4.5
//! `_sessionMessageProjection`): the per-message part, stored in the index as
//! `message_rows` and aggregated by `read_stats`.

use serde_json::Value;

use crate::agent_mode::wants_incoming_tail;
use crate::routine_result::is_routine_result_message;
use crate::routine_result::routine_provenance;
use crate::routine_result::routine_result_notice_text;
use crate::session_text::preview_text;
use crate::session_text::session_message_text;
use crate::summary::MessageStats;
use crate::title::summary_preview_cut;
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
    let tool_use =
        message.get("content").and_then(Value::as_array).is_some_and(|c| c.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("tool_use")));
    !has_calls && !tool_use
}

impl MessageRow {
    /// The row of `message`, a member of the model context.
    pub fn of(message: &Value) -> MessageRow {
        let conversational = matches!(role(message), Some("user" | "assistant"));
        let content = message.get("content").unwrap_or(&Value::Null);
        let routine_result = is_routine_result_message(message);
        // The preview and the last-message line of a message are cuts of one cleaned text.
        let shown = (conversational && !routine_result).then(|| preview_text(&session_message_text(content))).flatten();
        let cut = |text: Option<&str>, max| text.map_or_else(String::new, |text| summary_preview_cut(text, max));
        let preview = if role(message) == Some("user") && !routine_result { cut(shown.as_deref(), 240) } else { String::new() };
        let line = if !conversational {
            String::new()
        } else if routine_result {
            cut(preview_text(&routine_result_notice_text(message)).as_deref(), LAST_MESSAGE_PREVIEW_MAX)
        } else {
            cut(shown.as_deref(), LAST_MESSAGE_PREVIEW_MAX)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The preview and the line of a message cleaned once equal each one's own noise test and cleaning of the message
    /// text: with surrounding whitespace (the noise test cleans the trimmed text), an envelope only the trimmed text
    /// starts with, injected blocks, noise, and a text longer than both cuts.
    #[test]
    fn the_preview_and_the_line_are_each_their_own_cleaning_of_the_text() {
        let texts = [
            "hello world".to_owned(),
            "  hello\n\tworld  ".to_owned(),
            "\n# Session\nCwd: /p\nModel: m\n\nthe ask".to_owned(),
            "# Session\nCwd: /p\nModel: m\n\nthe ask".to_owned(),
            "before <system-reminder>hidden</system-reminder> after <skill>open".to_owned(),
            "[mixdog-runtime] a note".to_owned(),
            "<system-reminder>only</system-reminder>".to_owned(),
            "   ".to_owned(),
            String::new(),
            "Reference files: a.txt b.txt".to_owned(),
            format!(" {}", "word ".repeat(120)),
            "가나다 ".repeat(90),
        ];
        let own = |raw: &str, max| if crate::session_text::is_session_preview_noise(raw) { String::new() } else { crate::title::clean_summary_preview(raw, max) };
        for text in &texts {
            for role in ["user", "assistant", "tool"] {
                let row = MessageRow::of(&json!({ "role": role, "content": text }));
                let preview = if role == "user" { own(text, 240) } else { String::new() };
                let line = if role == "tool" { String::new() } else { own(text, LAST_MESSAGE_PREVIEW_MAX) };
                assert_eq!((row.preview.as_str(), row.line.as_str()), (preview.as_str(), line.as_str()), "{role} {text:?}");
            }
        }
    }

    /// The cuts count UTF-16 units: the 160-unit line ends inside the emoji's surrogate pair, which leaves the
    /// replacement character, and the 240-unit preview keeps the emoji. A routine result's line is its notice, never its
    /// content, and it has no preview.
    #[test]
    fn the_cuts_count_utf16_units_and_a_routine_result_shows_its_notice() {
        let a159 = "a".repeat(159);
        let row = MessageRow::of(&json!({ "role": "user", "content": format!("{a159}😀") }));
        assert_eq!(row.line, format!("{a159}\u{FFFD}"));
        assert_eq!(row.preview, format!("{a159}😀"));

        let routine = json!({
            "role": "user",
            "content": "the schedule's raw output",
            "meta": { "source": "schedule-result", "routine": { "kind": "schedule", "name": "nightly", "status": "ok", "summary": "all green" } },
        });
        let row = MessageRow::of(&routine);
        assert_eq!((row.preview.as_str(), row.line.as_str()), ("", "⏱ Schedule · nightly — all green"));
    }
}
