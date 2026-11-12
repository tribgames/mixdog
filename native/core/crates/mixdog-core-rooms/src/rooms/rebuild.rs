//! The `rooms` table of a fresh `state/core.sqlite` (after `CoreState::open_or_set_aside` kept a damaged one), from the room's log
//! `sess_room_<id>`: its title is the room's name and its header's `roomMembers` is the record of who is in the room (written
//! at every membership change, `RoomHost::record_members`). A member session proves nothing: one whose cleanup failed when its
//! member was removed is still there.

use std::collections::BTreeMap;

use mixdog_core_base::rooms::ids::room_id_of_session;
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

/// One record per room log: its name from the log's title, its members from the log's `roomMembers` (a log without that record
/// proves no member, so its room does not come back), its creation time from the log's. What no session holds stays at what a
/// new room gets (the round and message limits, shared tools off, empty cursors and submissions, no last speaker or preview).
pub async fn rebuild_rooms(state: &CoreState, index: &SqliteStore) -> Result<Rebuilt, DbError> {
    let mut logs: BTreeMap<String, (String, i64, Vec<String>)> = BTreeMap::new();
    for listed in index.list_sessions(true, None, None).await? {
        let text = |key: &str| listed.row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let created = listed.row.get("createdAt").and_then(Value::as_f64).map_or(0, |ms| ms as i64);
        if let Some(room) = room_id_of_session(&text("id")) {
            let members = listed
                .row
                .get("roomMembers")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            logs.insert(room, (text("title"), created, members));
        }
    }
    let rooms = Rooms::new(StateRoomStore::new(state.clone()));
    let mut rebuilt = Rebuilt { rooms: 0, skipped: 0 };
    for (room, (name, created, members)) in logs {
        let input = RoomConfigInput { name, members, ..Default::default() };
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
        // `ghost` was removed from `abc123`, but its session cleanup failed: its session is still there, the room's record omits it.
        // `old789` has no record of its members at all.
        for (id, title, created, members) in [
            ("sess_room_abc123", "Plan", 7, Some(json!(["lead", "bench"]))),
            ("sess_rmem_abc123_bench", "", 9, None),
            ("sess_rmem_abc123_lead", "", 8, None),
            ("sess_rmem_abc123_ghost", "", 7, None),
            ("sess_room_def456", "Solo", 5, Some(json!(["lead"]))),
            ("sess_rmem_def456_lead", "", 6, None),
            ("sess_room_old789", "Old", 4, None),
            ("sess_rmem_old789_lead", "", 4, None),
            ("sess_rmem_old789_bench", "", 4, None),
            ("sess_home_lead", "", 1, None),
        ] {
            let mut header = json!({"id": id, "title": title, "createdAt": created, "updatedAt": created});
            if let Some(members) = members {
                header["roomMembers"] = members;
            }
            let head = CatalogHead { session: id.into(), log_id: "4f1c2a9e0b7d3c5a6e8f9012".into(), base_session: None, header: header.as_object().unwrap().clone() };
            index.upsert(head, DirtyMark::Set).await.unwrap();
        }
        let (state, _) = CoreState::open(t.sqlite_writer_thread, t.interactive_io, &data.path().join("core.sqlite")).unwrap();

        assert_eq!(rebuild_rooms(&state, &index).await.unwrap(), Rebuilt { rooms: 1, skipped: 2 }, "a room with one member left, or none recorded, is no room");
        let room = Rooms::new(StateRoomStore::new(state.clone())).get("abc123").await.unwrap();
        assert_eq!((room.config.name.as_str(), room.config.members.clone(), room.created_at), ("Plan", vec!["lead".to_owned(), "bench".to_owned()], 7));
        state.close();
        index.close();
    }
}
