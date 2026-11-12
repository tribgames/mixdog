//! The `rooms` table of a fresh `state/core.sqlite` (after `CoreState::open_or_set_aside` kept a damaged one), from the sessions the
//! rooms own: a room's log `sess_room_<id>` (its title is the room's name) and the member sessions `sess_rmem_<id>_<agent>`.

use std::collections::BTreeMap;

use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_store::sqlite::DbError;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::state::CoreState;
use serde_json::Value;

use super::config::RoomConfigInput;
use super::records::Rooms;
use super::store::StateRoomStore;

/// How many rooms were given back, and how many logs had too little left to (no title, or fewer members than a room needs).
#[derive(Debug, PartialEq, Eq)]
pub struct Rebuilt {
    pub rooms: usize,
    pub skipped: usize,
}

/// One record per room log: its name from the log's title, its members from the member sessions that exist (oldest first), its
/// creation time from the log's. What no session holds stays at what a new room gets (the round and message limits, shared
/// tools off, empty cursors and submissions, no last speaker or preview).
pub async fn rebuild_rooms(state: &CoreState, index: &SqliteStore) -> Result<Rebuilt, DbError> {
    let mut logs: BTreeMap<String, (String, i64)> = BTreeMap::new();
    let mut members: BTreeMap<String, Vec<(i64, String)>> = BTreeMap::new();
    for listed in index.list_sessions(true, None, None).await? {
        let text = |key: &str| listed.row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let created = listed.row.get("createdAt").and_then(Value::as_f64).map_or(0, |ms| ms as i64);
        let id = text("id");
        if let Some(room) = room_id_of_session(&id) {
            logs.insert(room, (text("title"), created));
        } else if let Some(member) = room_member_of_session(&id) {
            members.entry(member.room_id).or_default().push((created, member.agent_id));
        }
    }
    let rooms = Rooms::new(StateRoomStore::new(state.clone()));
    let mut rebuilt = Rebuilt { rooms: 0, skipped: 0 };
    for (room, (name, created)) in logs {
        let mut who = members.remove(&room).unwrap_or_default();
        who.sort();
        let input = RoomConfigInput { name, members: who.into_iter().map(|(_, agent)| agent).collect(), ..Default::default() };
        match rooms.create(&input, &room, created).await {
            Ok(_) => rebuilt.rooms += 1,
            Err(_) => rebuilt.skipped += 1,
        }
    }
    Ok(rebuilt)
}

#[cfg(test)]
mod tests {
    use mixdog_rt::LaneToken;
    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::summary::CatalogHead;
    use serde_json::json;

    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rooms_come_back_from_their_logs_and_member_sessions() {
        let t = mixdog_rt::testing::tokens();
        let data = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let root = data.path().to_path_buf();
        let _job = t
            .maintenance_io
            .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
                let t = mixdog_rt::testing::tokens();
                let _ = tx.send(SqliteStore::open(lane, t.sqlite_writer_thread, t.interactive_io, &root));
            })
            .expect("lane");
        let index = rx.recv().expect("job ran").unwrap();
        for (id, title, created) in [
            ("sess_room_abc123", "Plan", 7),
            ("sess_rmem_abc123_bench", "", 9),
            ("sess_rmem_abc123_lead", "", 8),
            ("sess_room_def456", "Solo", 5),
            ("sess_rmem_def456_lead", "", 6),
            ("sess_home_lead", "", 1),
        ] {
            let header = json!({"id": id, "title": title, "createdAt": created, "updatedAt": created});
            let head = CatalogHead { session: id.into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
            index.upsert(head, DirtyMark::Set).await.unwrap();
        }
        let (state, _) = CoreState::open(t.sqlite_writer_thread, t.interactive_io, &data.path().join("core.sqlite")).unwrap();

        assert_eq!(rebuild_rooms(&state, &index).await.unwrap(), Rebuilt { rooms: 1, skipped: 1 }, "a room with one member left is no room");
        let room = Rooms::new(StateRoomStore::new(state.clone())).get("abc123").await.unwrap();
        assert_eq!((room.config.name.as_str(), room.config.members.clone(), room.created_at), ("Plan", vec!["lead".to_owned(), "bench".to_owned()], 7));
        state.close();
        index.close();
    }
}
