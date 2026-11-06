//! A bot's emoji reaction on a message the user wrote (`session/message-reactions.mjs`): stored
//! on the message as `meta.transcript.reactions` (`[{ agentId, emoji, at }]`, one per bot), so it
//! travels with the transcript. Pure functions over stored messages; the actor writes the result.

use mixdog_protocol::text_class::is_internal_transcript_display_text;
use mixdog_store::session_text::session_message_text;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::transcript::normalize_reactions;
use super::transcript::truthy;
use mixdog_core_base::rooms::ids::ROOM_ROW_SOURCE;

/// Node's `message.meta.room`, when the message is a group-room line (`isRoomRowMessage`).
fn room_of(message: &Value) -> Option<&Value> {
    let meta = message.get("meta")?;
    let room = meta.get("room")?;
    (meta.get("source").and_then(Value::as_str) == Some(ROOM_ROW_SOURCE) && room.get("kind").is_some_and(truthy))
        .then_some(room)
}

/// `isReactableMessage`: a message the user wrote (a prompt typed or steered into the chat, or the
/// user's own row in a room's log). Runtime notices, routine fires, posted results and other bots'
/// messages are not.
pub(super) fn is_reactable_message(message: &Value) -> bool {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(meta) = message.get("meta").filter(|meta| meta.is_object()) else {
        return false;
    };
    let transcript = meta.get("transcript");
    if !transcript.and_then(|t| t.get("messageId")).and_then(Value::as_str).is_some_and(|id| !id.is_empty()) {
        return false;
    }
    let transcript = transcript.expect("a message id implies a transcript");
    if let Some(room) = room_of(message) {
        return room.get("kind").and_then(Value::as_str) == Some("user") && !room.get("fromSession").is_some_and(truthy);
    }
    if meta.get("source").is_some_and(truthy) && meta.get("source").and_then(Value::as_str) != Some("steering") {
        return false;
    }
    if meta.get("synthetic") == Some(&Value::Bool(true)) {
        return false;
    }
    if transcript.get("fromAgent").is_some_and(truthy) || transcript.get("routineTrigger").is_some_and(truthy) {
        return false;
    }
    !is_internal_transcript_display_text(&session_message_text(message.get("content").unwrap_or(&Value::Null)))
}

pub(super) struct Change<'a> {
    pub agent_id: &'a str,
    /// `""` removes the bot's reaction.
    pub emoji: &'a str,
    pub messages_back: u64,
    /// An emoji another bot already left there is refused (a group room's members do not repeat
    /// each other).
    pub others_keep: bool,
    pub at: i64,
}

pub(super) struct Reacted {
    /// The message's position in the list searched.
    pub index: usize,
    pub message_id: String,
    pub reactions: Vec<Value>,
    pub changed: bool,
    /// The message with the new reactions; `None` when nothing changed.
    pub message: Option<Value>,
}

/// `reactToMessage`: set (or, with `""`, remove) `agent_id`'s reaction on the user message
/// `messages_back` user messages before the newest one in `messages`. One reaction per bot: a new
/// one takes the place of the old. The error is Node's message.
pub(super) fn react_to_message(messages: &[Value], change: &Change<'_>) -> Result<Reacted, String> {
    let mut seen: u64 = 0;
    let mut found = None;
    for (index, message) in messages.iter().enumerate().rev() {
        if !is_reactable_message(message) {
            continue;
        }
        if seen == change.messages_back {
            found = Some(index);
            break;
        }
        seen += 1;
    }
    let Some(index) = found else {
        return Err(if seen > 0 {
            format!("react: there are only {seen} user messages to react to")
        } else {
            "react: there is no user message to react to".to_owned()
        });
    };
    let previous = &messages[index];
    let transcript = &previous["meta"]["transcript"];
    let current = normalize_reactions(transcript.get("reactions"));
    let agent_of = |entry: &Value| entry["agentId"].as_str().unwrap_or_default().to_owned();
    let own = current.iter().find(|entry| agent_of(entry) == change.agent_id);
    if !change.emoji.is_empty() && change.others_keep {
        let taken = current
            .iter()
            .find(|entry| agent_of(entry) != change.agent_id && entry["emoji"].as_str() == Some(change.emoji));
        if let Some(taken) = taken {
            return Err(format!("react: {} already left {} on that message", agent_of(taken), change.emoji));
        }
    }
    let message_id = transcript["messageId"].as_str().unwrap_or_default().to_owned();
    let own_emoji = own.map(|entry| entry["emoji"].as_str().unwrap_or_default());
    if own_emoji == Some(change.emoji) || (own.is_none() && change.emoji.is_empty()) {
        return Ok(Reacted { index, message_id, reactions: current, changed: false, message: None });
    }
    let entry = json!({ "agentId": change.agent_id, "emoji": change.emoji, "at": change.at });
    let reactions: Vec<Value> = if change.emoji.is_empty() {
        current.into_iter().filter(|each| agent_of(each) != change.agent_id).collect()
    } else if own.is_some() {
        current.into_iter().map(|each| if agent_of(&each) == change.agent_id { entry.clone() } else { each }).collect()
    } else {
        current.into_iter().chain([entry]).collect()
    };
    let mut rest: Map<String, Value> = transcript.as_object().cloned().unwrap_or_default();
    rest.shift_remove("reactions");
    if !reactions.is_empty() {
        rest.insert("reactions".into(), Value::Array(reactions.clone()));
    }
    let mut message = previous.clone();
    message["meta"]["transcript"] = Value::Object(rest);
    Ok(Reacted { index, message_id, reactions, changed: true, message: Some(message) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `golden/reactions.json` is Node's own `reactToMessage` over the same lists.
    #[test]
    fn reacting_matches_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/reactions.json")).unwrap();
        for case in golden.as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let change = &case["change"];
            let got = match react_to_message(
                messages,
                &Change {
                    agent_id: change["agentId"].as_str().unwrap(),
                    emoji: change["emoji"].as_str().unwrap(),
                    messages_back: change["messagesBack"].as_u64().unwrap(),
                    others_keep: change["othersKeep"].as_bool().unwrap(),
                    at: change["at"].as_i64().unwrap(),
                },
            ) {
                Err(error) => json!({ "error": error }),
                Ok(done) => json!({
                    "index": done.index,
                    "messageId": done.message_id,
                    "reactions": done.reactions,
                    "changed": done.changed,
                    "message": done.message,
                }),
            };
            // Compared as text: the key order of the stored message is part of the shape.
            assert_eq!(got.to_string(), case["expected"].to_string(), "{}", case["name"]);
        }
    }
}
