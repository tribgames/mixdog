use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;

use super::*;
use crate::rooms::config::RoomConfigInput;
use crate::rooms::records::{RoomPatch, TurnFields};
use crate::rooms::service::KnownAgent;

const ORDER_GOLDEN: &str = include_str!("order_golden.json");

#[test]
fn the_log_order_of_every_recorded_case_equals_node() {
    let golden: Value = serde_json::from_str(ORDER_GOLDEN).unwrap();
    for case in golden.as_array().unwrap() {
        let list = |key: &str| case[key].as_array().unwrap().clone();
        assert_eq!(Value::Array(in_log_order(list("read"), &list("posted"))), case["out"], "{}", case["name"]);
    }
}

struct Mem(StdMutex<RoomDoc>);
#[async_trait]
impl RoomStore for Mem {
    async fn load(&self) -> Result<RoomDoc, RoomError> {
        Ok(self.0.lock().unwrap().clone())
    }
    async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
        *self.0.lock().unwrap() = doc.clone();
        Ok(())
    }
}

#[derive(Default)]
struct Daemon {
    appended: StdMutex<Vec<Value>>,
    aborted: StdMutex<Vec<String>>,
    catalog: StdMutex<u32>,
}
#[async_trait]
impl RoomDaemon for Daemon {
    async fn append_rows(&self, _: &str, messages: Vec<Value>) -> Result<(), String> {
        self.appended.lock().unwrap().extend(messages);
        Ok(())
    }
    async fn room_rows(&self, _: &str) -> Result<Vec<Value>, String> {
        Ok(Vec::new())
    }
    async fn submit(&self, _: &str, _: &RoomPrompt, _: &SubmitOptions) -> Result<bool, String> {
        Ok(true)
    }
    async fn read_snapshot(&self, _: &str) -> Result<Value, String> {
        Ok(json!({ "items": [] }))
    }
    async fn abort(&self, session_id: &str) -> Result<(), String> {
        self.aborted.lock().unwrap().push(session_id.to_owned());
        Ok(())
    }
    fn republish(&self, _: &str) {}
    fn republish_catalog(&self) {
        *self.catalog.lock().unwrap() += 1;
    }
}

struct Labels;
#[async_trait]
impl RoomLabels for Labels {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String> {
        Ok(members
            .iter()
            .map(|id| (id.clone(), MemberLabel { id: id.clone(), name: id.to_uppercase(), route: json!({ "provider": "p", "model": "m" }), description: String::new(), disabled: id == "off" }))
            .collect())
    }
}

struct Files;
#[async_trait]
impl RoomFiles for Files {
    async fn take_in(&self, _: &str, row: Value) -> Result<Value, String> {
        Ok(row)
    }
}

#[derive(Default)]
struct Sessions {
    made: StdMutex<Vec<(String, Value)>>,
}
#[async_trait]
impl SessionOps for Sessions {
    async fn route(&self, session_id: &str) -> Result<Option<Value>, RoomError> {
        Ok(self.made.lock().unwrap().iter().any(|(id, _)| id == session_id).then(|| json!({})))
    }
    async fn create(&self, session_id: &str, params: &Value) -> Result<(), RoomError> {
        self.made.lock().unwrap().push((session_id.to_owned(), params.clone()));
        Ok(())
    }
    async fn set_route(&self, _: &str, _: &Value) -> Result<(), RoomError> {
        Ok(())
    }
    async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
        Ok(())
    }
    async fn is_retired(&self, _: &str) -> Result<bool, RoomError> {
        Ok(false)
    }
    async fn set_retired(&self, _: &str, _: bool) -> Result<(), RoomError> {
        Ok(())
    }
    async fn rename(&self, _: &str, _: &str) -> Result<(), RoomError> {
        Ok(())
    }
    async fn clear(&self, _: &str, _: &str) -> Result<(), RoomError> {
        Ok(())
    }
    async fn delete(&self, _: &str) -> Result<(), RoomError> {
        Ok(())
    }
}

struct Catalog;
#[async_trait]
impl AgentCatalog for Catalog {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        Ok(Vec::new())
    }
    async fn mixy_route(&self) -> Value {
        json!({ "provider": "anthropic", "model": "opus" })
    }
    async fn mixy_created(&self) -> bool {
        true
    }
    async fn presence(&self, _: &[String]) -> Result<HashMap<String, crate::rooms::home::Presence>, RoomError> {
        Ok(HashMap::new())
    }
    async fn archived_name(&self, _: &str) -> String {
        String::new()
    }
    async fn task_workspace(&self) -> String {
        "/tasks".into()
    }
}

struct Unmanaged;
#[async_trait]
impl Maintainer for Unmanaged {
    async fn ask(&self, _: &str, _: &str) -> Maintained {
        Maintained::Unmanaged
    }
}

struct Rig {
    rooms: Arc<Rooms<Mem>>,
    live: Arc<LiveRooms>,
    daemon: Arc<Daemon>,
    sessions: Arc<Sessions>,
}

async fn rig(members: &[&str]) -> Rig {
    mixdog_rt::testing::tokens();
    let rooms = Arc::new(Rooms::new(Mem(StdMutex::new(RoomDoc::new()))));
    let input = RoomConfigInput { name: "Plan".into(), members: members.iter().map(|m| (*m).into()).collect(), ..Default::default() };
    rooms.create(&input, "room01", 1).await.unwrap();
    let (daemon, sessions) = (Arc::new(Daemon::default()), Arc::new(Sessions::default()));
    let live = LiveRooms::new(
        rooms.clone(),
        RoomPorts {
            daemon: daemon.clone(),
            labels: Arc::new(Labels),
            files: Arc::new(Files),
            sessions: sessions.clone(),
            catalog: Arc::new(Catalog),
            maintainer: Arc::new(Unmanaged),
            preview: Arc::new(|text: &str| text.trim().to_owned()),
            log: Arc::new(|_: &str| {}),
        },
    );
    live.start(&rooms).await.unwrap();
    Rig { rooms, live, daemon, sessions }
}

#[tokio::test]
async fn no_room_is_hosted_until_the_relay_queue_is_bound() {
    let rig = rig(&["a", "b"]).await;
    assert!(rig.live.host("room01").is_none());
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    assert!(rig.live.host("room01").is_some());
    assert!(rig.live.host("nope").is_none());
}

#[tokio::test]
async fn a_turn_saves_what_it_owns_and_a_service_edit_is_followed_without_losing_it() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let record = host.room().unwrap();
    record.lock().unwrap().cursors.extend([("a".to_owned(), "r1".to_owned()), ("b".to_owned(), "r2".to_owned())]);
    host.set_running(Some(9));
    host.set_owed(Some(vec!["a".into(), "b".into()]));
    host.persist().await.unwrap();
    let saved = rig.rooms.get("room01").await.unwrap();
    assert_eq!((saved.running, saved.owed.clone(), saved.cursors.len()), (Some(Running { started_at: 9 }), Some(vec!["a".to_owned(), "b".to_owned()]), 2));

    // The room service takes "b" out and renames the room: the same live record follows.
    rig.rooms.update("room01", &RoomPatch { name: Some("Renamed".into()), members: Some(vec!["a".into(), "c".into()]), ..Default::default() }).await.unwrap();
    let seen = record.lock().unwrap().clone();
    assert_eq!((seen.name.as_str(), seen.members.clone()), ("Renamed", vec!["a".to_owned(), "c".to_owned()]));
    assert_eq!(seen.cursors.keys().collect::<Vec<_>>(), ["a"]);
    // A save of the turn's fields after the edit keeps the edit.
    host.persist().await.unwrap();
    assert_eq!(rig.rooms.get("room01").await.unwrap().config.members, ["a", "c"]);

    // A room taken away is no longer hosted.
    rig.rooms.remove("room01").await.unwrap();
    assert!(rig.live.host("room01").is_none());
    assert!(!host.exists());
    assert!(host.room().is_err());
}

#[tokio::test]
async fn a_post_stores_the_canonical_row_and_the_list_preview_follows_the_spoken_line() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    host.post(vec![json!({ "id": "row_1", "kind": "speech", "speaker": "a", "name": " A  ", "text": "  hello ", "at": 5, "junk": 1 })]).await.unwrap();
    let appended = rig.daemon.appended.lock().unwrap().clone();
    assert_eq!(appended.len(), 1);
    assert_eq!(appended[0]["content"], "hello");
    assert_eq!(appended[0]["meta"]["room"], json!({ "kind": "speech", "speaker": "a", "name": "A" }));
    assert_eq!(appended[0]["meta"]["transcript"], json!({ "at": 5, "messageId": "row_1" }));
    // The log has not caught up: the posted row is still in the rows read.
    let rows = host.rows().await.unwrap();
    assert_eq!(rows.iter().map(|row| row["id"].as_str().unwrap()).collect::<Vec<_>>(), ["row_1"]);
    host.persist().await.unwrap();
    assert_eq!(rig.rooms.get("room01").await.unwrap().last_preview.as_deref(), Some("hello"));
    assert!(*rig.daemon.catalog.lock().unwrap() >= 1);
    // A row Node refuses fails the post.
    assert!(host.post(vec![json!({ "id": "bad id", "kind": "pass" })]).await.is_err());
}

#[tokio::test]
async fn a_member_session_is_made_once_for_a_member_and_never_for_a_stranger() {
    let rig = rig(&["a", MIXY_AGENT_ID]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let labels = host.labels().await.unwrap();
    let id = host.member_session(&labels["a"]).await.unwrap();
    assert_eq!(id, "sess_rmem_room01_a");
    assert_eq!(host.member_session(&labels["a"]).await.unwrap(), id);
    let made = rig.sessions.made.lock().unwrap().clone();
    assert_eq!(made.len(), 1);
    assert_eq!(made[0].1["sessionProfile"], json!({ "homeAgent": "a" }));
    assert_eq!(made[0].1["cwd"], "/tasks");
    assert_eq!(made[0].1["desktopSession"], json!({ "classification": "task", "projectPath": null }));
    let stranger = MemberLabel { id: "zed".into(), name: "Z".into(), route: Value::Null, description: String::new(), disabled: false };
    assert_eq!(host.member_session(&stranger).await.unwrap_err(), "\"zed\" is not a member of that room.");
    assert_eq!(rig.sessions.made.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_restart_marks_a_cut_off_exchange_interrupted_and_stops_its_members() {
    mixdog_rt::testing::tokens();
    let rooms = Arc::new(Rooms::new(Mem(StdMutex::new(RoomDoc::new()))));
    let input = RoomConfigInput { name: "Plan".into(), members: vec!["a".into(), "b".into()], ..Default::default() };
    rooms.create(&input, "room01", 1).await.unwrap();
    rooms.save_turn("room01", &TurnFields { running: Some(Running { started_at: 3 }), ..Default::default() }).await.unwrap();
    let (daemon, sessions) = (Arc::new(Daemon::default()), Arc::new(Sessions::default()));
    let live = LiveRooms::new(
        rooms.clone(),
        RoomPorts {
            daemon: daemon.clone(),
            labels: Arc::new(Labels),
            files: Arc::new(Files),
            sessions,
            catalog: Arc::new(Catalog),
            maintainer: Arc::new(Unmanaged),
            preview: Arc::new(|text: &str| text.to_owned()),
            log: Arc::new(|_: &str| {}),
        },
    );
    assert_eq!(live.start(&rooms).await.unwrap(), ["room01"]);
    assert_eq!(*daemon.aborted.lock().unwrap(), ["sess_rmem_room01_a", "sess_rmem_room01_b"]);
    let appended = daemon.appended.lock().unwrap().clone();
    assert_eq!(appended[0]["meta"]["room"], json!({ "kind": "interrupted" }));
    assert!(rooms.get("room01").await.unwrap().running.is_none());
}
