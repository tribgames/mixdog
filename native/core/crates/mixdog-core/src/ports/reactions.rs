//! `Reactions` for the `react` tool over the session runtime. A bot reacts in its own chat with
//! the user: its home thread (the message is in that thread) or its seat in a group room (the
//! message is the user's row in the room's log, where members do not repeat each other's emoji).
//! The reaction is stored on the message by the thread that holds it (`thread/reactions/set`,
//! which the session actor must serve; until it does the call answers `invalidParams`).

use std::sync::Arc;

use async_trait::async_trait;
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

use super::threads::port_error;
use crate::rooms::ids::{agent_id_of_home_session, room_member_of_session, room_session_id};
use crate::session::SessionDirectory;

pub struct SessionReactions {
    directory: Arc<SessionDirectory>,
}

impl SessionReactions {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

/// The bot whose own chat `session_id` is, derived from the id alone.
fn seat_of(session_id: &str) -> Option<ReactSeat> {
    room_member_of_session(session_id)
        .map(|member| member.agent_id)
        .or_else(|| agent_id_of_home_session(session_id))
        .map(|agent_id| ReactSeat { agent_id })
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
            .map_err(port_error)?;
        match reply {
            Reply::Value(value) => Ok(ReactResult { changed: value.get("changed").and_then(Value::as_bool).unwrap_or(false) }),
            Reply::Subscribe(_) => Err(PortError::Failed {
                capability: "session".into(),
                message: "thread/reactions/set subscribed".into(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The seat is derived from the id alone, so it needs no thread to be loaded.
    #[test]
    fn a_home_and_a_room_seat_name_their_bot_and_other_threads_have_none() {
        let agent = |id: &str| seat_of(id).map(|seat| seat.agent_id);
        assert_eq!(agent("sess_home_bench").as_deref(), Some("bench"));
        assert_eq!(agent("sess_rmem_abc123_bench").as_deref(), Some("bench"));
        assert_eq!(agent("sess_desktop_x"), None);
    }
}
