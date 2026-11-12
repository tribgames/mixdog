//! Room records (the catalog table `rooms(roomId, doc)`), written by the one `global("room")`
//! writer: every mutation reads, changes and persists whole on one serial chain, on a copy that
//! replaces the live records only after the save succeeded.
//!
//! In-flight rounds are memory-only. A record still carrying `running` at start-up was cut off by
//! a restart: `recover` clears it and names the rooms to mark interrupted. Nothing resumes.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_rt::SerialChain;
use serde::{Deserialize, Serialize};

use super::RoomError;
use super::config::{RoomConfig, RoomConfigInput, normalize_room_config};
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::room_member_session_id;

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
    /// Submission ids of accepted user messages, newest last (bounded). Absent from the record until one is accepted, as
    /// Node's record leaves it (`agent-room-messages.ts:99-102` sets it at the first).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
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

/// What a running room changes about its own record: the members' cursors and last line, the
/// running mark and the members still owed a turn. Everything else is the room service's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TurnFields {
    pub cursors: HashMap<String, String>,
    pub seen: HashMap<String, String>,
    pub last_speaker: Option<String>,
    pub last_at: Option<i64>,
    pub last_preview: Option<String>,
    pub running: Option<Running>,
    pub owed: Option<Vec<String>>,
}

/// Told the records after each save.
pub type RoomsChanged = Arc<dyn Fn(&RoomDoc) + Send + Sync>;

/// Keeps who is in a room (its id, its members) on the room's own log, the one record a rebuilt room takes its members from.
pub type MemberLog = Arc<dyn Fn(String, Vec<String>) -> Pin<Box<dyn Future<Output = Result<(), RoomError>> + Send>> + Send + Sync>;

pub struct Rooms<S: RoomStore> {
    store: S,
    listeners: Mutex<Vec<RoomsChanged>>,
    member_log: Mutex<Option<MemberLog>>,
    // The one room writer: a mutation loads, changes and saves on this chain, in arrival order.
    // Reads of the live records pass through it only for the first load.
    writer: Arc<SerialChain>,
    // The live records; locked only to swap or clone the handle, never across an await.
    doc: Mutex<Option<Arc<RoomDoc>>>,
}

impl<S: RoomStore> Rooms<S> {
    pub fn new(store: S) -> Self {
        Self { store, listeners: Mutex::new(Vec::new()), member_log: Mutex::new(None), writer: SerialChain::new(), doc: Mutex::new(None) }
    }

    /// Every save that changes who is in a room first has `log` record the members about to be saved ([`Self::log_members`]).
    pub fn log_members_with(&self, log: MemberLog) {
        *self.member_log.lock().unwrap_or_else(|e| e.into_inner()) = Some(log);
    }

    /// The logs of the rooms whose members differ between `live` and `next` record `next`'s, inside the writer's turn: a log
    /// and its room change in one order whoever changes them, and a crash or a failed save after it leaves a log that lists
    /// the members about to be saved, never one the room has dropped. A log that cannot be written fails the write, the
    /// logs written before it put back. A new room's failure is not the write's: the next load gives its log the record.
    /// The rooms whose logs were written.
    async fn log_members(&self, live: &RoomDoc, next: &RoomDoc) -> Result<Vec<String>, RoomError> {
        let Some(log) = self.member_log.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return Ok(Vec::new()) };
        let mut written = Vec::new();
        for (id, room) in next {
            match live.get(id) {
                None => {
                    let _ = log(id.clone(), room.config.members.clone()).await;
                }
                Some(before) if before.config.members != room.config.members => {
                    if let Err(error) = log(id.clone(), room.config.members.clone()).await {
                        Self::unlog_members(&log, live, &written).await;
                        return Err(error);
                    }
                    written.push(id.clone());
                }
                Some(_) => {}
            }
        }
        Ok(written)
    }

    /// The logs of `rooms` record `live`'s members again: the change they were written for was not saved.
    async fn unlog_members(log: &MemberLog, live: &RoomDoc, rooms: &[String]) {
        for id in rooms {
            if let Some(room) = live.get(id) {
                let _ = log(id.clone(), room.config.members.clone()).await;
            }
        }
    }

    fn live(&self) -> Option<Arc<RoomDoc>> {
        self.doc.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_live(&self, doc: Arc<RoomDoc>) {
        *self.doc.lock().unwrap_or_else(|e| e.into_inner()) = Some(doc);
    }

    /// The live records, loaded on first use. Called only while holding the writer's turn.
    async fn loaded(&self) -> Result<Arc<RoomDoc>, RoomError> {
        if let Some(live) = self.live() {
            return Ok(live);
        }
        let doc = Arc::new(self.store.load().await?);
        self.set_live(doc.clone());
        Ok(doc)
    }

    /// Run `change` on a copy of the records and persist it. The copy is the live records while it is saved, as Node changes its
    /// records and then awaits `persist` (a listing meanwhile reads the change); a failed save takes it back. A `change` that
    /// leaves the records equal writes nothing.
    async fn write<T>(&self, change: impl FnOnce(&mut RoomDoc) -> Result<T, RoomError>) -> Result<T, RoomError> {
        self.write_with(change, false).await
    }

    /// [`Self::write`]; with `keep_unsaved`, a change whose save failed stays in the live records (Node's records keep a change
    /// whose `persist` rejected), and the next save writes it.
    async fn write_with<T>(&self, change: impl FnOnce(&mut RoomDoc) -> Result<T, RoomError>, keep_unsaved: bool) -> Result<T, RoomError> {
        let _turn = self.writer.acquire().await;
        let live = self.loaded().await?;
        let mut next = RoomDoc::clone(&live);
        let result = change(&mut next)?;
        if next != *live {
            let next = Arc::new(next);
            self.set_live(next.clone());
            let logged = match self.log_members(&live, &next).await {
                Ok(logged) => logged,
                Err(error) => {
                    self.set_live(live);
                    return Err(error);
                }
            };
            let saved = self.store.save(&next).await;
            if saved.is_err() && !keep_unsaved {
                let log = self.member_log.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if let Some(log) = log {
                    Self::unlog_members(&log, &live, &logged).await;
                }
                self.set_live(live);
            } else {
                let told: Vec<RoomsChanged> = self.listeners.lock().unwrap_or_else(|e| e.into_inner()).clone();
                for listener in told {
                    listener(&next);
                }
            }
            saved?;
        }
        Ok(result)
    }

    /// `listener` hears the records after every save that changed them.
    pub fn on_change(&self, listener: RoomsChanged) {
        self.listeners.lock().unwrap_or_else(|e| e.into_inner()).push(listener);
    }

    /// A running room saves its own fields (`persist` of the room host).
    pub async fn save_turn(&self, room_id: &str, fields: &TurnFields) -> Result<(), RoomError> {
        self.write(|doc| {
            let room = doc.get_mut(room_id).ok_or_else(no_room)?;
            room.cursors = fields.cursors.clone();
            room.seen = fields.seen.clone();
            room.last_speaker = fields.last_speaker.clone();
            room.last_at = fields.last_at;
            room.last_preview = fields.last_preview.clone();
            room.running = fields.running;
            room.owed = fields.owed.clone();
            Ok(())
        })
        .await
    }

    /// The live records as they are, a write's save in flight or not (Node's `records.rooms()`); the first load waits its turn.
    async fn read<T>(&self, view: impl FnOnce(&RoomDoc) -> T) -> Result<T, RoomError> {
        if let Some(live) = self.live() {
            return Ok(view(&live));
        }
        let _turn = self.writer.acquire().await;
        Ok(view(&*self.loaded().await?))
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
        self.write(|doc| Ok(drop_from(doc, agent_ids))).await
    }

    /// `dropMembers` then `persist` of `pruneDeleted` (`agent-room-membership.ts:69-71`): [`Self::drop_members`], except that a
    /// failed save leaves the members gone from the live records, as Node's do (recorded: `fixtures/room-catalog-states`,
    /// `prune-failed`); the next save writes it.
    pub async fn prune_members(&self, agent_ids: &[String]) -> Result<Vec<Left>, RoomError> {
        self.write_with(|doc| Ok(drop_from(doc, agent_ids)), true).await
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


    /// A user message was accepted under `submission_id`: appended, the newest [`SUBMISSIONS_KEPT`] kept
    /// (`agent-room-messages.ts:103`; a second send of the id that was already on its way appends it again, as Node's does).
    /// The id stays in the live records even when its save fails, as Node's room keeps it in memory before it awaits
    /// `persist` (`:103`, `:109`): a retry of that send is acknowledged and posts nothing, and the next save writes the id.
    pub async fn accept_submission(&self, room_id: &str, submission_id: &str) -> Result<(), RoomError> {
        self.write_with(
            |doc| {
                let room = doc.get_mut(room_id).ok_or_else(no_room)?;
                room.submissions.push(submission_id.to_owned());
                let excess = room.submissions.len().saturating_sub(SUBMISSIONS_KEPT);
                room.submissions.drain(..excess);
                Ok(())
            },
            true,
        )
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

/// `agent_ids` out of every room's members; Mixy is never removed. Who left which room.
fn drop_from(doc: &mut RoomDoc, agent_ids: &[String]) -> Vec<Left> {
    let mut left = Vec::new();
    for room in doc.values_mut() {
        let gone: Vec<String> =
            room.config.members.iter().filter(|id| id.as_str() != MIXY_AGENT_ID && agent_ids.contains(id)).cloned().collect();
        if gone.is_empty() {
            continue;
        }
        remove_from_room(room, &gone);
        left.extend(gone.into_iter().map(|agent_id| Left { room_id: room.id.clone(), agent_id }));
    }
    left
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

    /// A room whose exchange began at `started_at`, as the exchange saves it (`persist`).
    fn running_at(started_at: i64) -> TurnFields {
        TurnFields { running: Some(Running { started_at }), ..Default::default() }
    }

    #[tokio::test]
    async fn a_restart_marks_running_rooms_interrupted_and_never_resumes() {
        let store = MemStore::default();
        let mut cut = Rooms::new(store.clone());
        cut.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        cut.create(&input(&["a", "b"]), "room02", 2).await.unwrap();
        cut.save_turn("room01", &running_at(5)).await.unwrap();
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
        rooms.save_turn("room01", &running_at(1)).await.unwrap();
        assert!(rooms.reset("room01", 9).await.is_err());
        rooms.save_turn("room01", &TurnFields::default()).await.unwrap();
        let room = rooms.reset("room01", 9).await.unwrap();
        assert_eq!((room.last_at, room.config.members.len()), (Some(9), 2));
    }

    #[tokio::test]
    async fn submissions_stay_bounded() {
        let rooms = Rooms::new(MemStore::default());
        rooms.create(&input(&["a", "b"]), "room01", 1).await.unwrap();
        for n in 0..SUBMISSIONS_KEPT + 5 {
            rooms.accept_submission("room01", &format!("n{n}")).await.unwrap();
        }
        let kept = rooms.get("room01").await.unwrap().submissions;
        assert_eq!((kept.len(), kept[0].as_str()), (SUBMISSIONS_KEPT, "n5"), "the newest are kept");
    }
}
