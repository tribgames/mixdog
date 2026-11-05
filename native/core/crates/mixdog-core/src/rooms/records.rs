//! Room records (the catalog table `rooms(roomId, doc)`), written by the one `global("room")`
//! writer: every mutation reads, changes and persists whole under one lock, on a copy that
//! replaces the live records only after the save succeeded.
//!
//! In-flight rounds are memory-only. A record still carrying `running` at start-up was cut off by
//! a restart: `recover` clears it and names the rooms to mark interrupted. Nothing resumes.

use std::collections::{BTreeMap, HashMap};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::RoomError;
use super::config::{RoomConfig, RoomConfigInput, normalize_room_config};
use super::ids::{MIXY_AGENT_ID, room_member_session_id};

const SUBMISSIONS_KEPT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub started_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomRecord {
    pub id: String,
    #[serde(flatten)]
    pub config: RoomConfig,
    pub created_at: i64,
    /// Per member: the id of the last room row it was shown.
    #[serde(default)]
    pub cursors: HashMap<String, String>,
    /// Per member: the id of the newest row a prompt its session took was handed.
    #[serde(default)]
    pub seen: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_preview: Option<String>,
    #[serde(default)]
    pub running: Option<Running>,
    /// Members of a user-addressed set the message cap cut off.
    #[serde(default)]
    pub owed: Option<Vec<String>>,
    /// Submission ids of accepted user messages, newest last (bounded).
    #[serde(default)]
    pub submissions: Vec<String>,
}

pub type RoomDoc = BTreeMap<String, RoomRecord>;

#[async_trait]
pub trait RoomStore: Send + Sync {
    async fn load(&self) -> Result<RoomDoc, RoomError>;
    async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Left {
    pub room_id: String,
    pub agent_id: String,
}

impl Left {
    /// The member session that goes with the departure.
    pub fn session_id(&self) -> Option<String> {
        room_member_session_id(&self.room_id, &self.agent_id)
    }
}

#[derive(Clone, Debug, Default)]
pub struct RoomPatch {
    pub name: Option<String>,
    pub members: Option<Vec<String>>,
    pub max_rounds: Option<f64>,
    pub max_messages: Option<f64>,
    pub share_tools: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Updated {
    pub room: RoomRecord,
    pub renamed: bool,
    /// Members taken out; their sessions go with them.
    pub gone: Vec<String>,
}

/// `gone` out of `room`'s members and everything kept for them (owed turns, cursors, seen rows).
fn remove_from_room(room: &mut RoomRecord, gone: &[String]) {
    room.config.members.retain(|id| !gone.contains(id));
    if let Some(owed) = &mut room.owed {
        owed.retain(|id| !gone.contains(id));
    }
    for id in gone {
        room.cursors.remove(id);
        room.seen.remove(id);
    }
}

pub struct Rooms<S: RoomStore> {
    store: S,
    // The one room writer: reads of the live records also pass through it, briefly.
    doc: Mutex<Option<RoomDoc>>,
}

impl<S: RoomStore> Rooms<S> {
    pub fn new(store: S) -> Self {
        Self { store, doc: Mutex::new(None) }
    }

    /// Run `change` on a copy of the records and persist it; the copy replaces the live records
    /// only when the save succeeds. A `change` that leaves the records equal writes nothing.
    async fn write<T>(&self, change: impl FnOnce(&mut RoomDoc) -> Result<T, RoomError>) -> Result<T, RoomError> {
        let mut guard = self.doc.lock().await;
        if guard.is_none() {
            *guard = Some(self.store.load().await?);
        }
        let live = guard.as_ref().expect("loaded above");
        let mut next = live.clone();
        let result = change(&mut next)?;
        if next != *live {
            self.store.save(&next).await?;
            *guard = Some(next);
        }
        Ok(result)
    }

    async fn read<T>(&self, view: impl FnOnce(&RoomDoc) -> T) -> Result<T, RoomError> {
        let mut guard = self.doc.lock().await;
        if guard.is_none() {
            *guard = Some(self.store.load().await?);
        }
        Ok(view(guard.as_ref().expect("loaded above")))
    }

    pub async fn list(&self) -> Result<Vec<RoomRecord>, RoomError> {
        self.read(|doc| doc.values().cloned().collect()).await
    }

    pub async fn get(&self, room_id: &str) -> Result<RoomRecord, RoomError> {
        self.read(|doc| doc.get(room_id).cloned()).await?.ok_or_else(no_room)
    }

    pub async fn create(&self, input: &RoomConfigInput, room_id: &str, now_ms: i64) -> Result<RoomRecord, RoomError> {
        let config = normalize_room_config(input)?;
        let record = RoomRecord {
            id: room_id.to_owned(),
            config,
            created_at: now_ms,
            cursors: HashMap::new(),
            seen: HashMap::new(),
            last_speaker: None,
            last_at: None,
            last_preview: None,
            running: None,
            owed: None,
            submissions: Vec::new(),
        };
        self.write(|doc| {
            doc.insert(record.id.clone(), record.clone());
            Ok(record)
        })
        .await
    }

    /// Members taken out leave as a deleted bot does; the room keeps its id and log.
    pub async fn update(&self, room_id: &str, patch: &RoomPatch) -> Result<Updated, RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            let current = &room.config;
            let config = normalize_room_config(&RoomConfigInput {
                name: patch.name.clone().unwrap_or_else(|| current.name.clone()),
                members: patch.members.clone().unwrap_or_else(|| current.members.clone()),
                max_rounds: Some(patch.max_rounds.unwrap_or(f64::from(current.max_rounds))),
                max_messages: Some(patch.max_messages.unwrap_or(f64::from(current.max_messages))),
                share_tools: patch.share_tools.unwrap_or(current.share_tools),
            })?;
            let renamed = config.name != current.name;
            let gone: Vec<String> =
                current.members.iter().filter(|id| !config.members.contains(id)).cloned().collect();
            remove_from_room(room, &gone);
            room.config = config;
            Ok(Updated { room: room.clone(), renamed, gone })
        })
        .await
    }

    pub async fn remove(&self, room_id: &str) -> Result<RoomRecord, RoomError> {
        self.write(|doc| doc.remove(room_id).ok_or_else(no_room)).await
    }

    /// `agent_ids` out of every room's members; Mixy is never removed. Who left which room.
    pub async fn drop_members(&self, agent_ids: &[String]) -> Result<Vec<Left>, RoomError> {
        self.write(|doc| {
            let mut left = Vec::new();
            for room in doc.values_mut() {
                let gone: Vec<String> = room
                    .config
                    .members
                    .iter()
                    .filter(|id| id.as_str() != MIXY_AGENT_ID && agent_ids.contains(id))
                    .cloned()
                    .collect();
                if gone.is_empty() {
                    continue;
                }
                remove_from_room(room, &gone);
                left.extend(gone.into_iter().map(|agent_id| Left { room_id: room.id.clone(), agent_id }));
            }
            Ok(left)
        })
        .await
    }

    /// "대화 초기화": the room keeps its id, members and limits; cursors and the last line restart.
    /// Refused while members are speaking.
    pub async fn reset(&self, room_id: &str, now_ms: i64) -> Result<RoomRecord, RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            if room.running.is_some() {
                return Err(RoomError::Invalid("The room is still talking; stop it or wait before resetting.".into()));
            }
            room.cursors.clear();
            room.seen.clear();
            room.owed = None;
            room.last_speaker = None;
            room.last_preview = None;
            room.last_at = Some(now_ms);
            Ok(room.clone())
        })
        .await
    }

    /// An exchange starts (`Some`) or ends (`None`). Starting one in a running room is refused.
    pub async fn set_running(&self, room_id: &str, running: Option<Running>) -> Result<(), RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            if running.is_some() && room.running.is_some() {
                return Err(RoomError::Invalid("The room is already talking.".into()));
            }
            room.running = running;
            Ok(())
        })
        .await
    }

    /// An exchange ended: the `running` mark clears; `owed` names the members a message cap cut
    /// off (`None` when nobody is owed a turn).
    pub async fn end_exchange(&self, room_id: &str, owed: Option<Vec<String>>) -> Result<(), RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            room.running = None;
            room.owed = owed.filter(|ids| !ids.is_empty());
            Ok(())
        })
        .await
    }

    /// A user message was accepted under `submission_id`; false when it was seen before.
    pub async fn accept_submission(&self, room_id: &str, submission_id: &str) -> Result<bool, RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            if room.submissions.iter().any(|id| id == submission_id) {
                return Ok(false);
            }
            room.submissions.push(submission_id.to_owned());
            let excess = room.submissions.len().saturating_sub(SUBMISSIONS_KEPT);
            room.submissions.drain(..excess);
            Ok(true)
        })
        .await
    }

    /// Start-up: exchanges a restart cut off. Their `running` mark is cleared; the caller posts an
    /// `interrupted` row and aborts the members. Nothing resumes on its own.
    pub async fn recover(&self) -> Result<Vec<RoomRecord>, RoomError> {
        self.write(|doc| {
            let mut cut = Vec::new();
            for room in doc.values_mut().filter(|room| room.running.is_some()) {
                room.running = None;
                cut.push(room.clone());
            }
            Ok(cut)
        })
        .await
    }
}

fn no_room() -> RoomError {
    RoomError::NotFound("This room no longer exists.".into())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[derive(Clone, Default)]
    struct MemStore {
        saved: Arc<StdMutex<Vec<RoomDoc>>>,
        initial: Arc<StdMutex<RoomDoc>>,
        fail: Arc<StdMutex<bool>>,
    }

    #[async_trait]
    impl RoomStore for MemStore {
        async fn load(&self) -> Result<RoomDoc, RoomError> {
            Ok(self.initial.lock().unwrap().clone())
        }
        async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
            if *self.fail.lock().unwrap() {
                return Err(RoomError::Port("disk".into()));
            }
            self.saved.lock().unwrap().push(doc.clone());
            Ok(())
        }
    }

    fn input(members: &[&str]) -> RoomConfigInput {
        RoomConfigInput {
            name: "Plan".into(),
            members: members.iter().map(|m| (*m).into()).collect(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn delete_cascade_removes_a_member_everywhere_but_never_mixy() {
        let store = MemStore::default();
        let rooms = Rooms::new(store.clone());
        rooms.create(&input(&["lead", "gh", "ops"]), "room01", 1).await.unwrap();
        rooms.create(&input(&["gh", "ops"]), "room02", 2).await.unwrap();
        rooms.create(&input(&["lead", "ops"]), "room03", 3).await.unwrap();
        let left = rooms.drop_members(&["gh".into(), "lead".into()]).await.unwrap();
        assert_eq!(
            left,
            [
                Left { room_id: "room01".into(), agent_id: "gh".into() },
                Left { room_id: "room02".into(), agent_id: "gh".into() },
            ]
        );
        assert_eq!(left[0].session_id().as_deref(), Some("sess_rmem_room01_gh"));
        let room = rooms.get("room01").await.unwrap();
        assert_eq!(room.config.members, ["lead", "ops"]);
        assert_eq!(rooms.get("room02").await.unwrap().config.members, ["ops"], "a room keeps its id");
        assert_eq!(rooms.get("room03").await.unwrap().config.members, ["lead", "ops"]);
        assert!(rooms.drop_members(&["gh".into()]).await.unwrap().is_empty());
        let saves = store.saved.lock().unwrap().len();
        assert_eq!(saves, 4, "three creates and one cascade; the empty cascade writes nothing");
    }

    #[tokio::test]
    async fn removed_members_lose_cursors_and_owed_turns() {
        let rooms = Rooms::new(MemStore::default());
        rooms.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        rooms
            .write(|doc| {
                let room = doc.get_mut("room01").unwrap();
                room.cursors.insert("b".into(), "r1".into());
                room.seen.insert("b".into(), "r1".into());
                room.owed = Some(vec!["a".into(), "b".into()]);
                Ok(())
            })
            .await
            .unwrap();
        let updated = rooms
            .update("room01", &RoomPatch { name: Some("Renamed".into()), members: Some(vec!["a".into(), "c".into()]), ..Default::default() })
            .await
            .unwrap();
        assert_eq!((updated.renamed, updated.gone.clone()), (true, vec!["b".to_string()]));
        assert!(updated.room.cursors.is_empty() && updated.room.seen.is_empty());
        assert_eq!(updated.room.owed, Some(vec!["a".to_string()]));
        assert_eq!(updated.room.config.members, ["a", "c"]);
        assert!(rooms.update("room01", &RoomPatch { members: Some(vec!["a".into()]), ..Default::default() }).await.is_err());
        assert_eq!(rooms.get("room01").await.unwrap().config.members, ["a", "c"]);
    }

    #[tokio::test]
    async fn a_restart_marks_running_rooms_interrupted_and_never_resumes() {
        let store = MemStore::default();
        let mut cut = Rooms::new(store.clone());
        cut.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        cut.create(&input(&["a", "b"]), "room02", 2).await.unwrap();
        cut.set_running("room01", Some(Running { started_at: 5 })).await.unwrap();
        assert!(cut.set_running("room01", Some(Running { started_at: 6 })).await.is_err());
        // The process dies; the next one loads what was saved.
        *store.initial.lock().unwrap() = store.saved.lock().unwrap().last().unwrap().clone();
        cut = Rooms::new(store.clone());
        let interrupted = cut.recover().await.unwrap();
        assert_eq!(interrupted.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["room01"]);
        assert!(cut.get("room01").await.unwrap().running.is_none());
        assert!(cut.recover().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_save_leaves_the_records_unchanged() {
        let store = MemStore::default();
        let rooms = Rooms::new(store.clone());
        rooms.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        *store.fail.lock().unwrap() = true;
        assert!(rooms.remove("room01").await.is_err());
        assert!(rooms.get("room01").await.is_ok());
        *store.fail.lock().unwrap() = false;
        rooms.remove("room01").await.unwrap();
        assert!(rooms.get("room01").await.is_err());
    }

    #[tokio::test]
    async fn reset_clears_cursors_but_not_while_running() {
        let rooms = Rooms::new(MemStore::default());
        rooms.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        rooms.set_running("room01", Some(Running { started_at: 1 })).await.unwrap();
        assert!(rooms.reset("room01", 9).await.is_err());
        rooms.set_running("room01", None).await.unwrap();
        let room = rooms.reset("room01", 9).await.unwrap();
        assert_eq!((room.last_at, room.config.members.len()), (Some(9), 2));
    }

    #[tokio::test]
    async fn submissions_dedupe_and_stay_bounded() {
        let rooms = Rooms::new(MemStore::default());
        rooms.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        assert!(rooms.accept_submission("room01", "s1").await.unwrap());
        assert!(!rooms.accept_submission("room01", "s1").await.unwrap());
        for n in 0..SUBMISSIONS_KEPT + 5 {
            rooms.accept_submission("room01", &format!("n{n}")).await.unwrap();
        }
        assert_eq!(rooms.get("room01").await.unwrap().submissions.len(), SUBMISSIONS_KEPT);
    }
}
