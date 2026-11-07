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
    fn republish_catalog(&self) {
        *self.catalog.lock().unwrap() += 1;
    }
}

/// The approval calls the room made, the views it published, in order, and the handed-off questions
/// its members hold (by member).
#[derive(Default)]
struct Approvals {
    answered: StdMutex<Vec<(String, String, Value)>>,
    questioned: StdMutex<Vec<(String, String)>>,
    published: StdMutex<Vec<(String, Option<ExchangeView>, Vec<Value>)>>,
    held: StdMutex<HashMap<String, Vec<Value>>>,
}
#[async_trait]
impl RoomApprovals for Approvals {
    async fn approve(&self, session_id: &str, answer: ApprovalAnswer) -> Result<bool, String> {
        self.answered.lock().unwrap().push((session_id.to_owned(), answer.request.0, answer.result));
        Ok(true)
    }
    async fn answer_question(&self, member_session: &str, answer: ApprovalAnswer) -> Result<bool, String> {
        self.questioned.lock().unwrap().push((member_session.to_owned(), answer.request.0));
        Ok(true)
    }
    fn member_questions(&self, room_id: &str, members: &[String]) -> Vec<Value> {
        let held = self.held.lock().unwrap();
        members
            .iter()
            .flat_map(|member| {
                let session = format!("sess_rmem_{room_id}_{member}");
                held.get(member).cloned().unwrap_or_default().into_iter().map(move |mut q| {
                    q["roomMember"] = json!(member);
                    q["memberSessionId"] = json!(session);
                    q
                })
            })
            .collect()
    }
    fn publish_view(&self, room_session_id: &str, view: Option<ExchangeView>, questions: Vec<Value>) {
        self.published.lock().unwrap().push((room_session_id.to_owned(), view, questions));
    }
}

fn decision(approval: &str) -> ApprovalAnswer {
    ApprovalAnswer {
        request: mixdog_core_api::ids::ServerRequestId(approval.to_owned()),
        connection: mixdog_core_api::ids::ConnectionId(1),
        device: "desktop".into(),
        connection_kind: serde_json::from_value(json!("desktop")).unwrap(),
        result: json!({ "approved": true }),
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
    async fn set_retired_title(&self, _: &str, _: &str) -> Result<(), RoomError> {
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
    approvals: Arc<Approvals>,
}

async fn rig(members: &[&str]) -> Rig {
    mixdog_rt::testing::tokens();
    let rooms = Arc::new(Rooms::new(Mem(StdMutex::new(RoomDoc::new()))));
    let input = RoomConfigInput { name: "Plan".into(), members: members.iter().map(|m| (*m).into()).collect(), ..Default::default() };
    rooms.create(&input, "room01", 1).await.unwrap();
    let (daemon, sessions, approvals) = (Arc::new(Daemon::default()), Arc::new(Sessions::default()), Arc::new(Approvals::default()));
    let live = LiveRooms::new(
        rooms.clone(),
        RoomPorts {
            daemon: daemon.clone(),
            approvals: approvals.clone(),
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
    Rig { rooms, live, daemon, sessions, approvals }
}

/// `scheduler.approve` + `decorate`: the speaking member's approval shows on the room log while
/// the exchange runs; only that approval is answered, through the member's session, and the room
/// stops showing it; with no exchange running there is nothing to answer.
#[tokio::test]
async fn the_room_answers_only_the_approval_its_speaking_member_shows() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    assert!(!rig.live.approve("sess_room_room01", decision("ap1")).await.unwrap(), "no exchange runs");

    let host = rig.live.host("room01").unwrap();
    let state = Arc::new(TurnState::new(Arc::new(crate::rooms::calls::Run::default())));
    host.track(&state);
    state.start_speaking("a", "A", "typing_1".into());
    state.set_member_session("sess_rmem_room01_a");
    state.set_approval(Some(json!({ "id": "ap1", "name": "shell" })));
    host.republish();
    let shown = ExchangeView { speaking: "a".into(), speaking_name: "A".into(), typing_id: "typing_1".into(), approval: Some(json!({ "id": "ap1", "name": "shell" })) };
    assert_eq!(rig.approvals.published.lock().unwrap().last().cloned(), Some(("sess_room_room01".to_owned(), Some(shown), Vec::new())));

    assert!(!rig.live.approve("sess_room_room01", decision("other")).await.unwrap(), "another id is refused");
    assert!(rig.live.approve("sess_room_room01", decision("ap1")).await.unwrap());
    assert_eq!(*rig.approvals.answered.lock().unwrap(), [("sess_rmem_room01_a".to_owned(), "ap1".to_owned(), json!({ "approved": true }))]);
    assert_eq!(state.approval(), None);
    let after = rig.approvals.published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(after.1.map(|view| view.approval), Some(None), "published again without the approval");
    assert!(!rig.live.approve("sess_room_room01", decision("ap1")).await.unwrap(), "never a second answer");

    assert!(host.untrack(&state));
    host.republish();
    assert_eq!(rig.approvals.published.lock().unwrap().last().cloned(), Some(("sess_room_room01".to_owned(), None, Vec::new())));
}

/// A member's approval resolved in its own thread (answered by a client on the room log, the
/// v2 path): the room stops showing it at once and republishes; another id changes nothing.
#[tokio::test]
async fn a_member_approval_resolved_in_its_thread_leaves_the_room_at_once() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let state = Arc::new(TurnState::new(Arc::new(crate::rooms::calls::Run::default())));
    host.track(&state);
    state.start_speaking("a", "A", "typing_1".into());
    state.set_member_session("sess_rmem_room01_a");
    state.set_approval(Some(json!({ "id": "7", "name": "shell" })));
    let published = || rig.approvals.published.lock().unwrap().len();
    let before = published();
    rig.live.member_resolved("room01", "8");
    assert_eq!((published(), state.approval().is_some()), (before, true), "another approval");
    rig.live.member_resolved("room01", "7");
    assert_eq!(state.approval(), None);
    let (_, view, _) = rig.approvals.published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(view.map(|view| view.approval), Some(None));
}

/// `memberQuestions` (`agent-rooms.ts:424-451`): the questions of the sessions the members handed
/// work to show on the room log, each tagged with its member, whether or not an exchange runs.
/// One of them is answered through that member's own session, even while another member speaks,
/// and leaves the card list at once. A changed list is published again (`noteMemberRows`), and
/// an answered id is forgotten once the member's list drops it.
#[tokio::test]
async fn a_handed_off_question_shows_on_the_room_and_is_answered_through_its_member() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    rig.approvals.held.lock().unwrap().insert("b".into(), vec![json!({ "id": "q1", "kind": "question" }), json!({ "id": "q2", "kind": "question" })]);
    rig.live.republish_room("room01");
    let (_, view, questions) = rig.approvals.published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(view, None, "no exchange runs");
    let tagged = |id: &str| json!({ "id": id, "kind": "question", "roomMember": "b", "memberSessionId": "sess_rmem_room01_b" });
    assert_eq!(questions, [tagged("q1"), tagged("q2")]);

    // Another member speaks; the question is still answered through `b`'s own session.
    let host = rig.live.host("room01").unwrap();
    let state = Arc::new(TurnState::new(Arc::new(crate::rooms::calls::Run::default())));
    host.track(&state);
    state.start_speaking("a", "A", "typing_1".into());
    state.set_member_session("sess_rmem_room01_a");
    assert!(rig.live.approve("sess_room_room01", decision("q1")).await.unwrap());
    assert_eq!(*rig.approvals.questioned.lock().unwrap(), [("sess_rmem_room01_b".to_owned(), "q1".to_owned())]);
    assert!(rig.approvals.answered.lock().unwrap().is_empty(), "not the speaking member's approval");
    let (_, _, questions) = rig.approvals.published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(questions, [tagged("q2")], "the answered card leaves at once");

    // The member's list drops it: the answered id is forgotten, so a new question of that id shows.
    rig.approvals.held.lock().unwrap().insert("b".into(), vec![json!({ "id": "q2", "kind": "question" })]);
    rig.live.republish_room("room01");
    rig.approvals.held.lock().unwrap().insert("b".into(), vec![json!({ "id": "q1", "kind": "question" }), json!({ "id": "q2", "kind": "question" })]);
    rig.live.republish_room("room01");
    let (_, _, questions) = rig.approvals.published.lock().unwrap().last().cloned().unwrap();
    assert_eq!(questions, [tagged("q1"), tagged("q2")]);
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
            approvals: Arc::new(Approvals::default()),
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
