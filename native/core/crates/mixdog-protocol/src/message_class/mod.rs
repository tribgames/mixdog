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

/// `meta.source` of an automatic Goal turn's prompt.
pub const GOAL_CONTINUATION_SOURCE: &str = "goal-continuation";
/// `meta.source` of the prompt that closes a Goal which reached its duration.
pub const GOAL_CLOSEOUT_SOURCE: &str = "goal-closeout";

/// Whether a message is the prompt of a Goal entry's turn: the runtime's text, shown as no row of its own, but listed by history
/// pages, where the failed end of a turn that stopped before any output is recorded on it.
pub fn is_goal_prompt(message: &Value) -> bool {
    matches!(message.pointer("/meta/source").and_then(Value::as_str), Some(GOAL_CONTINUATION_SOURCE | GOAL_CLOSEOUT_SOURCE))
}

/// The typed fact of a tool card row (`meta.taskCard`).
pub const TASK_CARD: &str = "taskCard";
/// The typed fact of an interrupted turn end (`meta.turnEnd`).
pub const TURN_END: &str = "turnEnd";

/// What a stored row carries besides its body.
#[derive(Debug, Clone, PartialEq)]
pub struct RowFacts {
    /// False when the transcript shows nothing for the message.
    pub visible: bool,
    /// The display text when the row counts for prompt history (`ItemRecord.prompt`).
    pub prompt: Option<String>,
}

/// The typed facts of a room row or a user-role message, as both the migration and the live
/// writer store them: [`room_prompt`] for a room row, else [`user_row`], with a card or a
/// cancel line written into `meta` (`meta.taskCard`, `meta.turnEnd`). `None` for any other
/// message, which keeps its row as is.
pub fn row_facts(message: &mut Value, text: &mut UserText<'_>) -> Option<RowFacts> {
    if is_room_row(message) {
        return Some(RowFacts { visible: true, prompt: room_prompt(message) });
    }
    if str_of(message, "role") != Some("user") {
        return None;
    }
    let mut facts = RowFacts { visible: true, prompt: None };
    match user_row(message, text) {
        // A Goal entry's prompt shows nothing but stays listed (see [`is_goal_prompt`]), as the live writer lists it.
        Shown::Nothing => facts.visible = is_goal_prompt(message),
        Shown::Notice => {}
        Shown::Card(card) => set_meta(message, TASK_CARD, card),
        Shown::TurnEnd => set_meta(message, TURN_END, serde_json::json!({ "status": "cancelled", "elapsedMs": 0 })),
        Shown::User(text) => facts.prompt = Some(text),
    }
    Some(facts)
}

/// The message without the display facts [`row_facts`] wrote into its `meta` (`taskCard`, `turnEnd`): the
/// conversation message as the model context holds it (today's `session.messages`, which never carried them). A
/// `meta` left empty is the one [`set_meta`] created, so it goes too.
pub fn without_display_facts(message: &mut Value) {
    let Some(row) = message.as_object_mut() else {
        return;
    };
    let Some(meta) = row.get_mut("meta").and_then(Value::as_object_mut) else {
        return;
    };
    let had = meta.shift_remove(TASK_CARD).is_some() | meta.shift_remove(TURN_END).is_some();
    if had && meta.is_empty() {
        row.shift_remove("meta");
    }
}

fn set_meta(message: &mut Value, key: &str, fact: Value) {
    let Some(message) = message.as_object_mut() else {
        return;
    };
    let meta = message.entry("meta").or_insert(Value::Null);
    if meta.is_null() {
        *meta = Value::Object(serde_json::Map::new());
    }
    if let Some(meta) = meta.as_object_mut() {
        meta.insert(key.to_owned(), fact);
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
