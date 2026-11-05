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
            let record: RoomRecord = serde_json::from_str(&text).map_err(|e| port(format!("{id}: {e}")))?;
            doc.insert(id, record);
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
}
