//! [`ListRooms`] over the room records: `thread/list` and the rooms' republish stamp each room's
//! log row as `agentRooms.withRooms` does (Node `agent-room-views.ts` `catalogWithRooms`, the
//! summary from `mixdog_core_rooms::rooms::catalog_rows`): a room's log row carries the room's
//! name, its last message time and the room summary (`agentRoom`); member sessions and the log
//! rows of rooms that are gone are left out.
//!
//! A room whose log has no catalog row gets the row Node's catalog makes up for it (`unlisted`,
//! [`unlisted_rows`]); the listing puts those first on its unfiltered first page, as the whole
//! catalog does.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::is_room_thread_session_id;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_base::rooms::ids::room_session_id;
use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
use mixdog_core_rooms::rooms::catalog_rows::room_summary;
use mixdog_core_rooms::rooms::records::RoomRecord;
use mixdog_core_rooms::rooms::records::RoomStore;
use mixdog_core_rooms::rooms::records::Rooms;
use mixdog_core_rooms::rooms::service::RoomRunner;
use mixdog_core_session::session::thread_list::ListRooms;
use mixdog_protocol::ThreadSummary;
use serde_json::Value;

/// `catalogWithRooms(rows, rooms, summaryOf)` over the rows of one listing, in their order.
pub fn with_rooms(
    rows: Vec<ThreadSummary>,
    rooms: &HashMap<String, RoomRecord>,
    summary_of: impl Fn(&RoomRecord) -> Value,
) -> Vec<ThreadSummary> {
    rows.into_iter()
        .filter_map(|mut row| {
            if room_member_of_session(row.id.as_str()).is_some() {
                return None;
            }
            let Some(room_id) = room_id_of_session(row.id.as_str()) else { return Some(row) };
            let room = rooms.get(&room_id)?;
            // The room's latest message is what the list shows; the log session's own times move
            // whenever it is loaded or saved, so they only stand in until the room has one.
            let last_at = room.last_at.unwrap_or_else(|| row.activity_at.unwrap_or(0).max(row.updated_at));
            row.title = room.config.name.clone();
            row.updated_at = last_at;
            row.activity_at = Some(last_at);
            row.agent_room = Some(summary_of(room));
            Some(row)
        })
        .collect()
}

/// The rows `catalogWithRooms` makes up for rooms whose log has no catalog row (`unlisted`): the room's name, its last message time
/// (else its creation) and its summary, as a task thread with nothing in it.
pub fn unlisted_rows(
    rooms: &[RoomRecord],
    logs: &[ThreadId],
    summary_of: impl Fn(&RoomRecord) -> Value,
) -> Vec<ThreadSummary> {
    rooms
        .iter()
        .filter_map(|room| {
            let log = room_session_id(&room.id)?;
            if !logs.iter().any(|id| id.as_str() == log) {
                return None;
            }
            let at = room.last_at.unwrap_or(room.created_at);
            let row = serde_json::json!({
                "id": log,
                "preview": "",
                "title": room.config.name,
                "updatedAt": at,
                "activityAt": at,
                "messageCount": 0,
                "cwd": "",
                "classification": "task",
                "projectPath": null,
                "agentRoom": summary_of(room),
            });
            Some(serde_json::from_value(row).expect("a made-up room row is a thread summary"))
        })
        .collect()
}

pub struct RoomListRows<S: RoomStore> {
    rooms: Arc<Rooms<S>>,
    runner: Arc<dyn RoomRunner>,
    names: Arc<dyn MemberNames>,
}

impl<S: RoomStore> RoomListRows<S> {
    pub fn new(rooms: Arc<Rooms<S>>, runner: Arc<dyn RoomRunner>, names: Arc<dyn MemberNames>) -> Self {
        Self { rooms, runner, names }
    }
}

#[async_trait]
impl<S: RoomStore + 'static> ListRooms for RoomListRows<S> {
    async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, String> {
        // A page with no room's log or member session has nothing to stamp or leave out.
        if !rows.iter().any(|row| is_room_thread_session_id(row.id.as_str())) {
            return Ok(rows);
        }
        let rooms: HashMap<String, _> =
            self.rooms.list().await.map_err(|error| error.to_string())?.into_iter().map(|room| (room.id.clone(), room)).collect();
        let names = self.names.names().await;
        Ok(with_rooms(rows, &rooms, |room| room_summary(room, &names, self.runner.is_running(&room.id))))
    }

    async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
        let rooms = self.rooms.list().await.map_err(|error| error.to_string())?;
        Ok(rooms.iter().filter_map(|room| room_session_id(&room.id)).map(ThreadId::from).collect())
    }

    async fn unlisted(&self, logs: &[ThreadId]) -> Result<Vec<ThreadSummary>, String> {
        let rooms = self.rooms.list().await.map_err(|error| error.to_string())?;
        let names = self.names.names().await;
        Ok(unlisted_rows(&rooms, logs, |room| room_summary(room, &names, self.runner.is_running(&room.id))))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/room-catalog/golden.json")).unwrap()
    }

    /// Every page of `fixtures/room-catalog/golden.json` stamped as the real desktop
    /// `catalogWithRooms`/`roomSummary` stamped it: titles, times, `agentRoom`, and the rows left out.
    #[test]
    fn the_rows_are_stamped_as_nodes() {
        let golden = golden();
        let names: HashMap<String, String> = serde_json::from_value(golden["names"].clone()).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let rows: Vec<ThreadSummary> = serde_json::from_value(case["rows"].clone()).unwrap();
            let rooms: HashMap<String, RoomRecord> = serde_json::from_value::<Vec<RoomRecord>>(case["rooms"].clone())
                .unwrap()
                .into_iter()
                .map(|room| (room.id.clone(), room))
                .collect();
            let running: HashSet<String> = serde_json::from_value(case["running"].clone()).unwrap();
            let out = with_rooms(rows, &rooms, |room| room_summary(room, &names, running.contains(&room.id)));
            assert_eq!(serde_json::to_value(&out).unwrap(), case["out"], "{}", case["name"]);
        }
    }
}
