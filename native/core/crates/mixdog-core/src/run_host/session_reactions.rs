//! `Reactions` for the `react` tool over the session runtime. A bot reacts in its own chat with
//! the user: its home thread (the message is in that thread) or its seat in a group room (the
//! message is the user's row in the room's log, where members do not repeat each other's emoji).
//! The reaction is stored on the message by the thread that holds it (`thread/reactions/set`,
//! which the session serves, `session/message_reactions.rs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::state::react::{ReactResult, ReactSeat, Reactions};
use serde_json::{Value, json};

use mixdog_core_ports::ports::threads::port_error;
use crate::run_host::reactions::ReactionTargets;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_base::rooms::ids::room_session_id;
use mixdog_core_session::session::SessionDirectory;

pub struct SessionReactions {
    directory: Arc<SessionDirectory>,
    /// Where a successful reaction records the message it hit (`noteReactionTarget`): the one
    /// process-wide table every turn's `LoopReactions` takes from.
    targets: Arc<ReactionTargets>,
}

impl SessionReactions {
    pub fn new(directory: Arc<SessionDirectory>, targets: Arc<ReactionTargets>) -> Self {
        Self { directory, targets }
    }
}

/// The bot whose own chat `session_id` is, derived from the id alone.
fn seat_of(session_id: &str) -> Option<ReactSeat> {
    room_member_of_session(session_id)
        .map(|member| member.agent_id)
        .or_else(|| agent_id_of_home_session(session_id))
        .map(|agent_id| ReactSeat { agent_id })
}

/// The session's refusal (no such message, an emoji another bot already left) reaches the model as
/// Node's own error text.
fn refusal(error: CoreError) -> PortError {
    match error {
        CoreError::DomainError { message: Some(message), .. } => {
            PortError::Failed { capability: "session".into(), message: message.to_string() }
        }
        other => port_error(other),
    }
}

/// `noteReactionTarget`: a set (never a removal) records the message the session's reply says it
/// landed on.
fn note_hit(targets: &ReactionTargets, session_id: &str, call_id: &str, set: bool, room: bool, reply: &Value) {
    if !set {
        return;
    }
    if let Some(message_id) = reply.get("messageId").and_then(Value::as_str) {
        targets.note(session_id, call_id, message_id, room);
    }
}

#[async_trait]
impl Reactions for SessionReactions {
    fn seat(&self, thread: &ThreadId) -> Option<ReactSeat> {
        seat_of(thread.as_str())
    }

    async fn react(
        &self,
        thread: &ThreadId,
        call: &ToolCallId,
        seat: &ReactSeat,
        emoji: Option<&str>,
        messages_back: u64,
    ) -> Result<ReactResult, PortError> {
        let room = room_member_of_session(thread.as_str());
        let target = match &room {
            Some(member) => room_session_id(&member.room_id).map(ThreadId::from).unwrap_or_else(|| thread.clone()),
            None => thread.clone(),
        };
        let ctx = CallContext::internal("react");
        let handle = self.directory.open_handle(&target, &ctx).await.map_err(port_error)?;
        let params = json!({
            "threadId": target,
            "agentId": seat.agent_id,
            "emoji": emoji,
            "messagesBack": messages_back,
            "othersKeep": room.is_some(),
            "callId": call,
        });
        let reply = handle
            .request(CoreRequest { method: Method("thread/reactions/set"), params, op: None, ctx })
            .await
            .map_err(refusal)?;
        match reply {
            Reply::Value(value) => {
                note_hit(&self.targets, thread.as_str(), call.as_str(), emoji.is_some(), room.is_some(), &value);
                Ok(ReactResult { changed: value.get("changed").and_then(Value::as_bool).unwrap_or(false) })
            }
            Reply::Subscribe(_) => Err(PortError::Failed {
                capability: "session".into(),
                message: "thread/reactions/set subscribed".into(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::env::Reactions as _;

    use super::*;
    use crate::run_host::reactions::{LoopReactions, NoMessageFacts};

    #[test]
    fn a_set_notes_the_hit_message_and_a_removal_or_a_reply_without_one_notes_nothing() {
        let targets = ReactionTargets::new();
        let reply = json!({ "changed": true, "messageId": "m7" });
        note_hit(&targets, "s", "c1", false, false, &reply);
        note_hit(&targets, "s", "c2", true, false, &json!({ "changed": true }));
        assert_eq!(targets.held(), 0);
        note_hit(&targets, "s", "c3", true, true, &reply);
        let hit = targets.take("s", "c3").unwrap();
        assert_eq!((hit.message_id.as_str(), hit.room), ("m7", true));
    }

    /// The react tool's target reaches the turn that is running: the tool holds the session's
    /// table from construction, each turn builds its own `LoopReactions` over the same table
    /// afterwards, and the one that took the call finds the record; a turn of another session
    /// does not.
    #[test]
    fn the_react_tools_target_reaches_the_running_turn() {
        let table = Arc::new(ReactionTargets::new());
        let tool_side = table.clone();
        let facts = || Arc::new(NoMessageFacts);
        let turn = LoopReactions::new("sess_home_bench", table.clone(), facts(), |_| false);
        let other_turn = LoopReactions::new("sess_desktop_x", table, facts(), |_| false);
        note_hit(&tool_side, "sess_home_bench", "call_1", true, false, &json!({ "changed": true, "messageId": "m7" }));
        assert!(other_turn.take_target("call_1").is_none());
        let hit = turn.take_target("call_1").unwrap();
        assert_eq!((hit.message_id.as_str(), hit.room), ("m7", false));
        assert!(turn.take_target("call_1").is_none(), "consumed once");
    }
    /// The seat is derived from the id alone, so it needs no thread to be loaded.
    #[test]
    fn a_home_and_a_room_seat_name_their_bot_and_other_threads_have_none() {
        let agent = |id: &str| seat_of(id).map(|seat| seat.agent_id);
        assert_eq!(agent("sess_home_bench").as_deref(), Some("bench"));
        assert_eq!(agent("sess_rmem_abc123_bench").as_deref(), Some("bench"));
        assert_eq!(agent("sess_desktop_x"), None);
    }
}
