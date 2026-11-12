//! The room records in `state/core.sqlite` (`rooms(room_id, doc)`), one row per room.
//!
//! `Rooms` saves the whole document under its single writer, so a save is a diff against the
//! stored rows applied in one transaction: changed rooms are upserted, vanished ones deleted.

use async_trait::async_trait;
use mixdog_store::state::CoreState;

use super::RoomError;
use super::records::{RoomDoc, RoomRecord, RoomStore};

pub struct StateRoomStore {
    state: CoreState,
}

impl StateRoomStore {
    pub fn new(state: CoreState) -> Self {
        Self { state }
    }
}

fn port(error: impl std::fmt::Display) -> RoomError {
    RoomError::Port(format!("room records: {error}"))
}

#[async_trait]
impl RoomStore for StateRoomStore {
    async fn load(&self) -> Result<RoomDoc, RoomError> {
        let mut doc = RoomDoc::new();
        for (id, text) in self.state.rooms().await.map_err(port)? {
            // A record that does not read is kept aside (`corrupt:rooms:<id>` in the state's `meta`) and the other rooms load: one
            // bad room does not take the room list down, as it did not take down Node's whole file there.
            match serde_json::from_str::<RoomRecord>(&text) {
                Ok(record) => {
                    doc.insert(id, record);
                }
                Err(e) => {
                    mixdog_rt::node_stderr!("[state] room {id} is damaged ({e}); kept as meta corrupt:rooms:{id}");
                    self.state.set_aside_room(&id, &text).await.map_err(port)?;
                }
            }
        }
        Ok(doc)
    }

    async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
        let stored = self.state.rooms().await.map_err(port)?;
        let mut upserts = Vec::new();
        for (id, record) in doc {
            let text = serde_json::to_string(record).map_err(port)?;
            if stored.iter().find(|(stored_id, _)| stored_id == id).is_none_or(|(_, old)| *old != text) {
                upserts.push((id.clone(), text));
            }
        }
        let deletes: Vec<String> =
            stored.into_iter().map(|(id, _)| id).filter(|id| !doc.contains_key(id)).collect();
        if upserts.is_empty() && deletes.is_empty() {
            return Ok(());
        }
        self.state
            .write(move |tx| {
                for (id, text) in &upserts {
                    tx.put_room(id, text)?;
                }
                for id in &deletes {
                    tx.delete_room(id)?;
                }
                Ok(())
            })
            .await
            .map_err(port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rooms::config::RoomConfigInput;
    use crate::rooms::records::Rooms;

    #[tokio::test]
    async fn rooms_survive_a_reopen_and_removals_are_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("core.sqlite");
        let t = mixdog_rt::testing::tokens();
        let (state, _) = CoreState::open(t.sqlite_writer_thread, t.interactive_io, &path).unwrap();
        let rooms = Rooms::new(StateRoomStore::new(state.clone()));
        let input = RoomConfigInput {
            name: "Plan".into(),
            members: vec!["lead".into(), "bench".into()],
            ..Default::default()
        };
        rooms.create(&input, "room01", 5).await.unwrap();
        rooms.create(&input, "room02", 6).await.unwrap();
        rooms.remove("room01").await.unwrap();

        let again = Rooms::new(StateRoomStore::new(state));
        let ids: Vec<String> = again.list().await.unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["room02"]);
    }

    #[tokio::test]
    async fn a_room_record_that_does_not_read_is_set_aside_and_the_other_rooms_load() {
        let dir = tempfile::tempdir().unwrap();
        let t = mixdog_rt::testing::tokens();
        let (state, _) = CoreState::open(t.sqlite_writer_thread, t.interactive_io, &dir.path().join("core.sqlite")).unwrap();
        let rooms = Rooms::new(StateRoomStore::new(state.clone()));
        let input = RoomConfigInput { name: "Plan".into(), members: vec!["lead".into(), "bench".into()], ..Default::default() };
        rooms.create(&input, "room02", 6).await.unwrap();
        state.write(|tx| tx.put_room("room01", "{broken")).await.unwrap();

        let again = Rooms::new(StateRoomStore::new(state.clone()));
        let ids: Vec<String> = again.list().await.unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["room02"], "the unreadable record does not take the list down");
        assert_eq!(state.meta("corrupt:rooms:room01").await.unwrap().as_deref(), Some("{broken"), "it is kept, as it was");
        assert_eq!(state.room("room01").await.unwrap(), None, "and no longer in the table, so a save does not delete the kept copy");
    }
}
