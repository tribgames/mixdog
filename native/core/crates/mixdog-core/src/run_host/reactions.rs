//! `Reactions`: which tool calls are emoji reactions, what each one hit, and which transcript
//! messages a reaction can answer (`runtime-core/reaction-tool-defs.mjs`,
//! `session/message-reactions.mjs`, `loop/no-tool-turn.mjs`).
//!
//! `AgentMessage` carries no free-form meta, so what Node reads from `meta` (the room-row
//! source, `transcript.roomRow`, `synthetic`, `fromAgent`, `routineTrigger`) comes from the
//! session through [`MessageFacts`], keyed by the message id.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::env::ReactionTarget;
use mixdog_agent::env::Reactions;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::message_class::js::truthy;
use serde_json::Value;

use crate::session::StoredRows;

pub const REACTION_TOOL_NAME: &str = "react";
/// `ROOM_ROW_SOURCE` (`agent-room.mjs`).
const ROOM_ROW_SOURCE: &str = "agent-room";
/// Records held at once; the oldest is dropped past it.
const TARGET_CAP: usize = 256;

pub trait MessageFacts: Send + Sync {
    /// `meta.transcript.roomRow`: the newest room-log user row a room member's prompt shows.
    fn room_row(&self, message_id: &str) -> Option<String>;
    /// For a room-log row (`meta.source == 'agent-room'`): whether it is a user's own row
    /// (`room.kind == 'user'` and not `fromSession`). `None` for any other message.
    fn room_row_is_user(&self, message_id: &str) -> Option<bool>;
    /// `meta.synthetic`, `transcript.fromAgent` or `transcript.routineTrigger`.
    fn not_user_written(&self, message_id: &str) -> bool;
}

/// Facts for a session without rooms: every message is an ordinary chat message.
pub struct NoMessageFacts;

impl MessageFacts for NoMessageFacts {
    fn room_row(&self, _: &str) -> Option<String> {
        None
    }
    fn room_row_is_user(&self, _: &str) -> Option<bool> {
        None
    }
    fn not_user_written(&self, _: &str) -> bool {
        false
    }
}

/// The facts as Node reads them off the message in hand: the run's [`StoredRows`] holds the exact
/// stored body of every message the turn holds (read back from the store, or committed by the run).
/// A message the run never registered has no facts.
impl MessageFacts for StoredRows {
    /// `roomRowOf` (`no-tool-turn.mjs`): `meta.transcript.roomRow`.
    fn room_row(&self, message_id: &str) -> Option<String> {
        self.with_body(message_id, |body| {
            body.pointer("/meta/transcript/roomRow").and_then(Value::as_str).map(str::to_owned)
        })
        .flatten()
    }

    /// `isRoomRowMessage` (`meta.source === 'agent-room' && Boolean(meta.room?.kind)`), then
    /// `meta.room.kind === 'user' && !meta.room.fromSession` (`isReactableMessage`).
    fn room_row_is_user(&self, message_id: &str) -> Option<bool> {
        self.with_body(message_id, |body| {
            let meta = body.get("meta")?;
            let room = meta.get("room");
            let kind = room.and_then(|room| room.get("kind"));
            if meta.get("source").and_then(Value::as_str) != Some(ROOM_ROW_SOURCE) || !truthy(kind) {
                return None;
            }
            Some(kind.and_then(Value::as_str) == Some("user") && !truthy(room.and_then(|room| room.get("fromSession"))))
        })
        .flatten()
    }

    /// `meta.synthetic === true || transcript.fromAgent || transcript.routineTrigger`.
    fn not_user_written(&self, message_id: &str) -> bool {
        self.with_body(message_id, |body| {
            let Some(meta) = body.get("meta") else { return false };
            let transcript = meta.get("transcript");
            meta.get("synthetic") == Some(&Value::Bool(true))
                || truthy(transcript.and_then(|t| t.get("fromAgent")))
                || truthy(transcript.and_then(|t| t.get("routineTrigger")))
        })
        .unwrap_or(false)
    }
}

pub struct LoopReactions {
    facts: Arc<dyn MessageFacts>,
    /// `isInternalTranscriptDisplayText`: runtime control rows persisted as user messages.
    is_internal_text: fn(&str) -> bool,
    targets: Mutex<(HashMap<String, (String, bool)>, VecDeque<String>)>,
}

impl LoopReactions {
    pub fn new(facts: Arc<dyn MessageFacts>, is_internal_text: fn(&str) -> bool) -> Self {
        Self { facts, is_internal_text, targets: Mutex::new((HashMap::new(), VecDeque::new())) }
    }

    /// The react tool records the message a successful call landed on (`noteReactionTarget`).
    pub fn note_target(&self, call_id: &str, message_id: &str, room: bool) {
        if call_id.is_empty() || message_id.is_empty() {
            return;
        }
        let mut guard = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        let (map, order) = &mut *guard;
        if map.insert(call_id.to_owned(), (message_id.to_owned(), room)).is_none() {
            order.push_back(call_id.to_owned());
        }
        while map.len() > TARGET_CAP {
            if let Some(oldest) = order.pop_front() {
                map.remove(&oldest);
            }
        }
    }

    /// The run ended: its leftover records go (`clearReactionTargets`).
    pub fn clear(&self) {
        let mut guard = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        guard.0.clear();
        guard.1.clear();
    }

    pub fn held(&self) -> usize {
        self.targets.lock().unwrap_or_else(|e| e.into_inner()).0.len()
    }
}

impl Reactions for LoopReactions {
    /// Direct, or bridged through `call_tool`.
    fn is_reaction_call(&self, call: &ToolCall) -> bool {
        call.name == REACTION_TOOL_NAME
            || (call.name == "call_tool"
                && call.arguments.get("name").and_then(|n| n.as_str()) == Some(REACTION_TOOL_NAME))
    }

    fn take_target(&self, call_id: &str) -> Option<ReactionTarget> {
        let mut guard = self.targets.lock().unwrap_or_else(|e| e.into_inner());
        let (message_id, room) = guard.0.remove(call_id)?;
        guard.1.retain(|id| id != call_id);
        Some(ReactionTarget { message_id, room })
    }

    /// A prompt typed or steered into the chat, or the user's own row in a room's log.
    /// Notices, routine fires, posted results and other bots' messages are not.
    fn is_reactable(&self, message: &AgentMessage) -> bool {
        if message.role() != Role::User {
            return false;
        }
        let Some(id) = message.message_id.as_deref().filter(|id| !id.is_empty()) else {
            return false;
        };
        if let Some(user_row) = self.facts.room_row_is_user(id) {
            return user_row;
        }
        if !matches!(message.source, None | Some(Source::Steering)) || self.facts.not_user_written(id) {
            return false;
        }
        !(self.is_internal_text)(&message.text())
    }

    fn room_row(&self, message: &AgentMessage) -> Option<String> {
        let id = message.message_id.as_deref()?;
        self.facts.room_row(id).filter(|row| !row.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::message::AgentMessage;
    use serde_json::json;

    use super::*;

    fn reactions() -> LoopReactions {
        LoopReactions::new(Arc::new(NoMessageFacts), |t| t.starts_with("<runtime-notice>"))
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c".into(), name: name.into(), arguments: args, native_type: None }
    }

    #[test]
    fn react_calls_are_recognised_direct_and_bridged() {
        let r = reactions();
        assert!(r.is_reaction_call(&call("react", json!({}))));
        assert!(r.is_reaction_call(&call("call_tool", json!({"name": "react"}))));
        assert!(!r.is_reaction_call(&call("call_tool", json!({"name": "read"}))));
    }

    #[test]
    fn a_target_is_consumed_once() {
        let r = reactions();
        r.note_target("c1", "m1", true);
        r.note_target("", "m", false);
        let t = r.take_target("c1").unwrap();
        assert_eq!((t.message_id.as_str(), t.room), ("m1", true));
        assert!(r.take_target("c1").is_none());
        assert_eq!(r.held(), 0);
    }

    #[test]
    fn the_record_map_is_capped() {
        let r = reactions();
        for i in 0..300 {
            r.note_target(&format!("c{i}"), "m", false);
        }
        assert_eq!(r.held(), TARGET_CAP);
        assert!(r.take_target("c0").is_none());
        assert!(r.take_target("c299").is_some());
    }

    #[test]
    fn only_real_user_input_is_reactable() {
        let r = reactions();
        let mut m = AgentMessage::user("hello");
        assert!(!r.is_reactable(&m), "no message id yet");
        m.message_id = Some("m1".into());
        assert!(r.is_reactable(&m));
        m.source = Some(Source::TaskNotification);
        assert!(!r.is_reactable(&m));
        let mut notice = AgentMessage::user("<runtime-notice> x");
        notice.message_id = Some("m2".into());
        assert!(!r.is_reactable(&notice));
    }

    fn keyed(id: &str, body: serde_json::Value, rows: &StoredRows) -> AgentMessage {
        let mut message = AgentMessage::user("hello");
        message.message_id = Some(id.into());
        rows.record(&message, body);
        message
    }

    /// `isReactableMessage` and `roomRowOf` over the stored bodies the run holds (Node reads
    /// them off `message.meta`).
    #[test]
    fn stored_rows_give_nodes_message_facts() {
        let rows = Arc::new(StoredRows::new());
        let user = |extra: serde_json::Value| {
            let mut meta = json!({ "transcript": { "messageId": "x" } });
            for (k, v) in extra.as_object().unwrap() {
                if k == "transcript" {
                    meta["transcript"].as_object_mut().unwrap().extend(v.as_object().unwrap().clone());
                } else {
                    meta[k] = v.clone();
                }
            }
            json!({ "role": "user", "content": "hello", "meta": meta })
        };
        let typed = keyed("typed", user(json!({})), &rows);
        let synthetic = keyed("synthetic", user(json!({ "synthetic": true })), &rows);
        let synthetic_text = keyed("synthetic-text", user(json!({ "synthetic": "yes" })), &rows);
        let from_agent = keyed("from-agent", user(json!({ "transcript": { "fromAgent": "bot" } })), &rows);
        let routine = keyed("routine", user(json!({ "transcript": { "routineTrigger": { "id": "r" } } })), &rows);
        let room = |id: &str, r: serde_json::Value| keyed(id, user(json!({ "source": "agent-room", "room": r })), &rows);
        let own_row = room("own-row", json!({ "kind": "user" }));
        let relayed_row = room("relayed-row", json!({ "kind": "user", "fromSession": "s1" }));
        let bot_row = room("bot-row", json!({ "kind": "agent", "fromAgent": "a" }));
        let kindless = keyed("kindless", user(json!({ "room": { "kind": "" } })), &rows);
        let member_prompt = keyed("member-prompt", user(json!({ "synthetic": true, "transcript": { "roomRow": "row-7" } })), &rows);

        let facts: &dyn MessageFacts = &*rows;
        assert_eq!(facts.room_row("member-prompt").as_deref(), Some("row-7"));
        assert_eq!(facts.room_row("typed"), None);
        assert_eq!(facts.room_row_is_user("kindless"), None, "no agent-room source");
        assert_eq!(facts.room_row_is_user("bot-row"), Some(false));
        assert_eq!((facts.room_row("never-registered"), facts.room_row_is_user("never-registered")), (None, None));
        assert!(!facts.not_user_written("never-registered"));

        let r = LoopReactions::new(rows.clone(), |t| t.starts_with("<runtime-notice>"));
        let reactable: Vec<bool> = [&typed, &synthetic, &synthetic_text, &from_agent, &routine, &own_row, &relayed_row, &bot_row, &kindless, &member_prompt]
            .iter()
            .map(|m| r.is_reactable(m))
            .collect();
        assert_eq!(reactable, [true, false, true, false, false, true, false, false, true, false]);
        assert_eq!(Reactions::room_row(&r, &member_prompt).as_deref(), Some("row-7"));
        assert_eq!(Reactions::room_row(&r, &typed), None);
    }
}
