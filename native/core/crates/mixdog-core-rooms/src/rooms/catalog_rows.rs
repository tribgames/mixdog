//! How a room shows in the session list (Node `agent-room-views.ts` `roomSummary`): the room
//! summary a room's log row carries as `agentRoom`, and the members' display names it needs. The
//! list rows themselves are stamped by `mixdog-core` `run_host::room_list` (`catalogWithRooms`).

use std::collections::HashMap;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use super::records::RoomRecord;

/// The agents' display names by id, Mixy's under `lead` (Node `records.names`: the catalog's
/// user-made definitions, refreshed whenever the agents are listed, and `leadName() || 'Mixy'`).
#[async_trait]
pub trait MemberNames: Send + Sync {
    async fn names(&self) -> HashMap<String, String>;
}

/// `roomSummary(room, names, running)`.
pub fn room_summary(room: &RoomRecord, names: &HashMap<String, String>, running: bool) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), json!(room.id));
    out.insert("name".into(), json!(room.config.name));
    out.insert("members".into(), json!(room.config.members));
    out.insert("maxRounds".into(), json!(room.config.max_rounds));
    out.insert("maxMessages".into(), json!(room.config.max_messages));
    out.insert("shareTools".into(), json!(room.config.share_tools));
    if let Some(speaker) = room.last_speaker.as_deref().filter(|s| !s.is_empty()) {
        out.insert("lastSpeaker".into(), json!(speaker));
    }
    if let Some(preview) = room.last_preview.as_deref().filter(|p| !p.is_empty()) {
        out.insert("lastPreview".into(), json!(preview));
    }
    let member_names: Map<String, Value> =
        room.config.members.iter().map(|id| (id.clone(), json!(names.get(id).unwrap_or(id)))).collect();
    out.insert("memberNames".into(), Value::Object(member_names));
    if running {
        out.insert("running".into(), json!(true));
    }
    Value::Object(out)
}
