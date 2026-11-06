//! The delivery's `RoomRelay` (`agentRoomHost().relay`, agent-room-messages.ts `relay`): a room
//! member's session relays its own reported work in one turn in its room, once the room is idle.
//! `settled` resolves the turn's end status (`done` when it finished).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_services::bots::delivery::env::{RoomRelay, WakeFollow};
use mixdog_services::bots::live::{WakeOptions, WakeTurn};

use super::calls::{CallFollow, CallRunner, RoomCall, RoomCalls};
use super::records::{RoomStore, Rooms};

struct Follow(WakeFollow);

#[async_trait]
impl CallFollow for Follow {
    async fn follow(&self, submission_id: &str) -> Result<(), String> {
        self.0.follow(submission_id).await
    }
}

/// [`RoomRelay`] over the room records and the room calls.
pub struct MemberRelay<S: RoomStore, R: CallRunner> {
    rooms: Arc<Rooms<S>>,
    calls: Arc<RoomCalls<R>>,
}

impl<S: RoomStore, R: CallRunner> MemberRelay<S, R> {
    pub fn new(rooms: Arc<Rooms<S>>, calls: Arc<RoomCalls<R>>) -> Self {
        Self { rooms, calls }
    }
}

#[async_trait]
impl<S: RoomStore + 'static, R: CallRunner + 'static> RoomRelay for MemberRelay<S, R> {
    async fn relay(&self, session_id: &str, prompt: &str, options: WakeOptions, follow: WakeFollow) -> Result<Option<WakeTurn>, String> {
        let member = room_member_of_session(session_id).ok_or("Not a group-room member session.")?;
        let room = self.rooms.get(&member.room_id).await.map_err(|error| error.to_string())?;
        if !room.config.members.contains(&member.agent_id) {
            return Err("That agent is no longer a member of the room.".into());
        }
        let (call, settled) = RoomCall::relay(&member.agent_id, prompt, &options.id, options.hop, Some(Arc::new(Follow(follow))));
        self.calls.relay_when_idle(&member.room_id, call);
        Ok(Some(WakeTurn { settled }))
    }
}

#[cfg(test)]
mod tests;
