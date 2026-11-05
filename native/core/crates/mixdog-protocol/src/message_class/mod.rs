//! The one per-message classification of 1.4.5 user-role rows that Node recognised only by
//! their text (`transcript-restore/restore.mjs` `restoredUserTranscriptItems`, room rows from
//! `agent-room.mjs` `roomRowItem`): what the transcript shows for the message, and with which
//! display text. The migration writes the answer as typed facts (`visible`, `prompt`,
//! `meta.taskCard`, `meta.turnEnd`); the core reads those facts and never matches text. A
//! caller holding raw messages (compaction deciding whether dropped rows show anything) asks
//! this function directly, so the rule has one home.
//!
//! | Node restores | [`Shown`] |
//! |---|---|
//! | nothing (`meta:'skill'\|'hook'`, internal display text, empty text) | `Nothing` |
//! | a notice (`schedule-result`, `held-request` with an id) | `Notice` |
//! | a tool card (task notification, completion wrapper, synthetic agent message) | `Card` |
//! | the cancel line (`turndone` cancelled) | `TurnEnd` |
//! | a user bubble | `User(text)` |

pub mod envelope;
pub mod js;
pub mod presence;
pub mod user_text;

pub use presence::message_shown;
pub use presence::messages_shown;

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use serde_json::Value;

use crate::text_class::is_internal_transcript_display_text;
use crate::text_class::is_transcript_cancelled_status_text;
use envelope::card;
use envelope::completion_card_from_execution;
use envelope::parse_model_visible_completion_wrapper;
use envelope::parse_synthetic_agent_message;
use js::re;
use js::str_of;
use js::truthy;
use user_text::UserText;
use user_text::tool_result_text;

static COMPLETION_ERROR_LABEL: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"^(failed|error|timeout|killed|cancelled)$", "i"));
static SYNTHETIC_ERROR_LABEL: LazyLock<JsRegex> = LazyLock::new(|| re(r"^(failed|error|killed|cancelled)$", "i"));

/// What Node's restore shows for one user-role message.
#[derive(Debug, Clone, PartialEq)]
pub enum Shown {
    Nothing,
    Notice,
    Card(Value),
    TurnEnd,
    /// A user bubble with this text.
    User(String),
}

impl Shown {
    /// Whether the transcript shows anything for the message.
    pub fn is_visible(&self) -> bool {
        !matches!(self, Shown::Nothing)
    }
}

fn source(message: &Value) -> Option<&str> {
    message.get("meta").and_then(|meta| str_of(meta, "source"))
}

/// `isRoomRowMessage(message)`.
pub fn is_room_row(message: &Value) -> bool {
    source(message) == Some("agent-room")
        && truthy(message.get("meta").and_then(|m| m.get("room")).and_then(|r| r.get("kind")))
}

/// `restoredUserTranscriptItems(message, …, userText)`.
pub fn user_row(message: &Value, text: &mut UserText<'_>) -> Shown {
    let meta = message.get("meta");
    if let Some(Value::String(kind)) = meta
        && (kind == "skill" || kind == "hook")
    {
        return Shown::Nothing;
    }
    let source = source(message);
    let held = source == Some("held-request")
        && truthy(meta.and_then(|m| m.get("heldRequest")).and_then(|h| h.get("id")));
    if source == Some("schedule-result") || held {
        return Shown::Notice;
    }
    if source == Some("import") {
        let content = message.get("content");
        let text = match content {
            Some(Value::String(text)) => text.clone(),
            other => tool_result_text(other),
        };
        let text = js_trim(&text);
        return if text.is_empty() { Shown::Nothing } else { Shown::User(text.to_owned()) };
    }
    let text = js_trim(&text.text(message.get("content"))).to_owned();
    let completion = if source == Some("task-notification") {
        completion_card_from_execution(meta.and_then(|m| m.get("execution")), &text)
    } else {
        parse_model_visible_completion_wrapper(&text)
    };
    if let Some(parsed) = completion {
        return Shown::Card(card(parsed, &text, &COMPLETION_ERROR_LABEL));
    }
    if text.is_empty() || is_internal_transcript_display_text(&text) {
        return Shown::Nothing;
    }
    if is_transcript_cancelled_status_text(&text) {
        return Shown::TurnEnd;
    }
    match parse_synthetic_agent_message(&text) {
        Some(parsed) => Shown::Card(card(parsed, &text, &SYNTHETIC_ERROR_LABEL)),
        None => Shown::User(text),
    }
}

/// `promptHistoryKey(text)` is not empty.
fn counts(text: &str) -> bool {
    !js_trim(text).is_empty()
}

/// The room line's prompt: a user line's text (`roomRowItem`), when it counts.
pub fn room_prompt(message: &Value) -> Option<String> {
    let room = message.get("meta")?.get("room")?;
    if str_of(room, "kind") != Some("user") {
        return None;
    }
    let text = message.get("content").and_then(Value::as_str).unwrap_or("");
    counts(text).then(|| text.to_owned())
}
