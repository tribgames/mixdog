//! The tail reminder on the Anthropic wire (`tail-reminder-split.mjs`, `anthropic-request-utils.mjs`): a user
//! message built for one request, always the last, never stored. Two layouts:
//! - legacy: its own text block appended to the last user message (a new user message when there is none),
//!   after the cache breakpoint, and never sent again;
//! - turn-scoped (first-party route, model taking `clear_at` system messages): the request ends with a
//!   `{role: "system", clear_at: "next_user_message"}` message, and every later request re-sends it
//!   byte-identically right before the assistant turn it produced, so the wire only ever grows.

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::Role;
use serde_json::json;

use super::lowering::WireContent;
use super::lowering::WireMessage;

/// `splitTailReminder`: the request's messages without its reminder, and the reminder's text (empty when the
/// last message is not one).
pub(crate) fn split_tail_reminder(messages: &[Message]) -> (&[Message], String) {
    match messages.split_last() {
        Some((last, rest)) if last.role == Role::User && last.source == Some(MessageSource::TailReminder) => {
            let text = match &last.content {
                Content::Text(text) => text.clone(),
                Content::Parts(parts) => parts
                    .iter()
                    .filter_map(|part| match part {
                        ContentPart::Text(text, _) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect(),
            };
            (rest, text)
        }
        _ => (messages, String::new()),
    }
}

/// A turn-scoped message must follow a user turn; an effort control (empty system message) may sit between them.
/// Creation and replay both decide by this one rule on the lowered array, so a turn whose request carried no
/// reminder never gets one on replay.
fn follows_user_turn(messages: &[WireMessage]) -> bool {
    let Some(mut index) = messages.len().checked_sub(1) else { return false };
    if messages[index].role == "system" && matches!(&messages[index].content, WireContent::Blocks(blocks) if blocks.is_empty()) {
        let Some(before) = index.checked_sub(1) else { return false };
        index = before;
    }
    messages[index].role == "user"
}

fn turn_reminder_message(text: &str) -> WireMessage {
    let mut message = WireMessage::new("system", WireContent::Blocks(vec![json!({ "type": "text", "text": text })]));
    message.clear_at = true;
    message
}

/// The lowered history with each stored reminder re-sent right before the assistant turn generated under it
/// (after any effort control), exactly where that turn's own request carried it as its last message. String
/// contents become one text block, so a cache marker (which turns a string into a block list on the turn it
/// lands) never changes a message's shape between requests: the wire stays append-only.
pub(crate) fn with_turn_reminders(messages: Vec<WireMessage>) -> Vec<WireMessage> {
    let mut out: Vec<WireMessage> = Vec::with_capacity(messages.len());
    for mut message in messages {
        if message.role == "assistant"
            && let Some(text) = message.turn_reminder.clone()
            && follows_user_turn(&out)
        {
            out.push(turn_reminder_message(&text));
        }
        if let WireContent::Text(text) = &message.content
            && !text.trim().is_empty()
        {
            message.content = WireContent::Blocks(vec![json!({ "type": "text", "text": text })]);
        }
        out.push(message);
    }
    out
}

/// The current reminder as a turn-scoped system message ending the request. A tail that is not a user turn (an
/// assistant continuation) cannot take one and gets no reminder at all: anything else would be missing from the
/// next request, which replays that turn without one.
pub(crate) fn append_turn_reminder(mut messages: Vec<WireMessage>, reminder: &str) -> Vec<WireMessage> {
    if !reminder.is_empty() && follows_user_turn(&messages) {
        messages.push(turn_reminder_message(reminder));
    }
    messages
}

/// The legacy layout: the reminder is the final text block of the last user message, after the breakpoint.
pub(crate) fn append_tail_reminder(mut messages: Vec<WireMessage>, reminder: &str) -> Vec<WireMessage> {
    if reminder.is_empty() {
        return messages;
    }
    let block = json!({ "type": "text", "text": reminder });
    match messages.last_mut() {
        Some(last) if last.role == "user" => {
            let mut blocks = match &last.content {
                WireContent::Text(text) => vec![json!({ "type": "text", "text": text })],
                WireContent::Blocks(blocks) => blocks.clone(),
            };
            blocks.push(block);
            last.content = WireContent::Blocks(blocks);
        }
        _ => messages.push(WireMessage::new("user", WireContent::Blocks(vec![block]))),
    }
    messages
}
