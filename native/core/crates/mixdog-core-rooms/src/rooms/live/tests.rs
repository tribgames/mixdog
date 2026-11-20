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

/// What a client of the room log can see, revision by revision: the log takes a post (rows and view) or a view alone as one
/// update, as the session actor does (a view that already stands is no revision).
#[derive(Default)]
struct Log {
    rows: StdMutex<Vec<String>>,
    view: StdMutex<RoomViewUpdate>,
    revisions: StdMutex<Vec<(Vec<String>, RoomViewUpdate)>>,
}
impl Log {
    fn take(&self, rows: Vec<String>, view: RoomViewUpdate) {
        let (mut held, mut shown) = (self.rows.lock().unwrap(), self.view.lock().unwrap());
        if rows.is_empty() && *shown == view {
            return;
        }
        held.extend(rows);
        *shown = view;
        self.revisions.lock().unwrap().push((held.clone(), shown.clone()));
    }
    /// Every revision as `rows | band`, the band being who types, `…` while deciding, `-` when the room shows nothing.
    fn seen(&self) -> Vec<String> {
        self.revisions
            .lock()
            .unwrap()
            .iter()
            .map(|(rows, view)| {
                let band = match &view.exchange {
                    None => "-".to_owned(),
                    Some(exchange) if exchange.deciding => "…".to_owned(),
                    Some(exchange) => exchange.speaking.clone(),
                };
                format!("{} | {band}", rows.join(",")).trim().to_owned()
            })
            .collect()
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
    log: Arc<Log>,
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
    async fn publish_view(&self, room_session_id: &str, view: Option<ExchangeView>, questions: Vec<Value>) {
        self.log.take(Vec::new(), RoomViewUpdate { exchange: view.clone(), questions: questions.clone() });
        self.published.lock().unwrap().push((room_session_id.to_owned(), view, questions));
    }
}

fn decision(approval: &str) -> ApprovalAnswer {
    ApprovalAnswer {
        request: mixdog_core_api::ids::ServerRequestId(approval.to_owned()),
        connection: mixdog_core_api::ids::ConnectionId(1),
        device: "desktop".into(),
        connection_kind: serde_json::from_value(json!("desktop")).unwrap(),
        origin: serde_json::from_value(json!("local")).unwrap(),
        result: json!({ "approved": true }),
    }
}

struct Labels;
#[async_trait]
impl RoomLabels for Labels {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String> {
        // The first send into the room that has the member "held" waits here, before its post enters the log's delivery.
        if members.iter().any(|id| id == "held") && !LABELS_HELD.swap(true, std::sync::atomic::Ordering::SeqCst) {
            LABELS_IN.notify_one();
            LABELS_GO.notified().await;
        }
        Ok(members
            .iter()
            .map(|id| (id.clone(), MemberLabel { id: id.clone(), name: id.to_uppercase(), route: json!({ "provider": "p", "model": "m" }), description: String::new(), disabled: id == "off" }))
            .collect())
    }
}

static TAKING_IN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static LET_GO: tokio::sync::Notify = tokio::sync::Notify::const_new();
static LABELS_IN: tokio::sync::Notify = tokio::sync::Notify::const_new();
static LABELS_GO: tokio::sync::Notify = tokio::sync::Notify::const_new();
static LABELS_HELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct Files;

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
    async fn decide(&self, _: &crate::rooms::exchange_run::SupervisorStep) -> Result<Option<crate::rooms::exchange::Decision>, String> {
        Ok(Some(crate::rooms::exchange::Decision { action: crate::rooms::exchange::Action::Unmanaged, scene: None }))
    }
}

fn user(id: &str) -> Value {
    json!({ "id": id, "kind": "user", "text": "hi", "at": 1 })
}

fn speech(id: &str, speaker: &str) -> Value {
    json!({ "id": id, "kind": "speech", "speaker": speaker, "name": speaker.to_uppercase(), "text": "words", "at": 2 })
}

fn exchange() -> Arc<TurnState> {
    Arc::new(TurnState::new(Arc::new(crate::rooms::calls::Run::default())))
}
#[async_trait]
impl RoomFiles for Files {
    async fn take_in(&self, _: &str, row: Value) -> Result<Value, String> {
        // A message held while it is taken in: the test presses Stop at that moment, then lets it go.
        if row["text"] == json!("gate") {
            TAKING_IN.notify_one();
            LET_GO.notified().await;
        }
        // A row with files takes its time to be taken in.
        if row["slow"] == json!(true) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Ok(row)
    }
}

#[derive(Default)]
struct Daemon {
    appended: StdMutex<Vec<Value>>,
    aborted: StdMutex<Vec<String>>,
    catalog: StdMutex<u32>,
    /// The process's sensitive values.
    marks: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
    log: Arc<Log>,
    /// A test's barrier: while set, a post waits inside the log (holding the room's publication) until it is told to go.
    hold: StdMutex<Option<Arc<tokio::sync::Notify>>>,
}
#[async_trait]
impl RoomDaemon for Daemon {
    async fn append_rows(&self, _: &str, messages: Vec<Value>, view: RoomViewUpdate) -> Result<(), String> {
        let hold = self.hold.lock().unwrap().take();
        if let Some(hold) = hold {
            hold.notified().await;
        }
        let ids = messages.iter().map(|message| message["meta"]["transcript"]["messageId"].as_str().unwrap_or_default().to_owned()).collect();
        self.appended.lock().unwrap().extend(messages);
        self.log.take(ids, view);
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
    fn redact_text(&self, session_id: &str, text: &str) -> String {
        self.marks.redact_text(session_id, text)
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
    let log = Arc::new(Log::default());
    let (daemon, sessions, approvals) = (Arc::new(Daemon { log: log.clone(), ..Daemon::default() }), Arc::new(Sessions::default()), Arc::new(Approvals { log, ..Approvals::default() }));
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
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
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
    let shown = ExchangeView { speaking: "a".into(), speaking_name: "A".into(), typing_id: "typing_1".into(), approval: Some(json!({ "id": "ap1", "name": "shell" })), deciding: false };
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
/// The list reads the live records: a post's preview and a speech's time show before the exchange saves.
#[tokio::test]
async fn the_room_list_shows_the_preview_and_time_before_the_exchange_saves() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    host.post(vec![json!({ "id": "row_1", "kind": "speech", "speaker": "a", "name": "A", "text": "hello", "at": 5 })]).await.unwrap();
    host.room().unwrap().lock().unwrap().last_at = Some(1234);
    let listed = rig.rooms.list().await.unwrap();
    assert_eq!((listed[0].last_preview.as_deref(), listed[0].last_at), (Some("hello"), Some(1234)));
}
/// `reset` of `agent-rooms.ts`: the live room forgets its log, cursors, `seen`, last speaker and preview and what is owed, so
/// the next save writes none of the old conversation back.
#[tokio::test]
async fn a_reset_room_carries_nothing_of_the_old_conversation_into_its_next_save() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    host.post(vec![json!({ "id": "row_1", "kind": "speech", "speaker": "a", "name": "A", "text": "old talk", "at": 5 })]).await.unwrap();
    {
        let record = host.room().unwrap();
        let mut record = record.lock().unwrap();
        record.cursors.insert("a".into(), "row_1".into());
        record.seen = Some(HashMap::from([("a".to_owned(), "row_1".to_owned())]));
        record.last_speaker = Some("a".into());
    }
    host.set_owed(Some(vec!["b".into()]));
    host.persist().await.unwrap();

    rig.rooms.reset("room01", 777).await.unwrap();
    host.persist().await.unwrap();
    let saved = rig.rooms.get("room01").await.unwrap();
    assert_eq!(
        (saved.cursors.len(), saved.seen.len(), saved.owed, saved.last_speaker, saved.last_preview, saved.last_at),
        (0, 0, None, None, None, Some(777))
    );
    assert!(host.rows().await.unwrap().is_empty(), "the posted rows are forgotten with the log");
}
/// `append` of `agent-room-delivery.mjs`: a post takes its place before its files are taken in, so a later post cannot overtake it.
#[tokio::test]
async fn a_slow_speech_is_not_overtaken_by_a_later_speech() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let slow = json!({ "id": "row_slow", "kind": "speech", "speaker": "a", "name": "A", "text": "first", "at": 5, "slow": true });
    let fast = json!({ "id": "row_fast", "kind": "speech", "speaker": "b", "name": "B", "text": "second", "at": 6 });
    let (first, second) = tokio::join!(host.post(vec![slow]), host.post(vec![fast]));
    first.unwrap();
    second.unwrap();
    let order: Vec<String> = rig.daemon.appended.lock().unwrap().iter().map(|message| message["meta"]["transcript"]["messageId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(order, ["row_slow", "row_fast"]);
}
/// Once a post has reserved its place no later post of any kind overtakes it, whatever its own rows take to prepare: a user's
/// plain row before a speech, and a speech before a user's row.
#[tokio::test]
async fn a_post_that_reserved_is_never_overtaken_by_a_later_post_of_any_kind() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let user = |id: &str, slow: bool| json!({ "id": id, "kind": "user", "at": 1, "text": id, "slow": slow });
    let speech = |id: &str, slow: bool| json!({ "id": id, "kind": "speech", "speaker": "a", "name": "A", "text": id, "at": 2, "slow": slow });
    let (one, two) = tokio::join!(host.post(vec![user("u1", true)]), host.post(vec![speech("s1", false)]));
    let (three, four) = tokio::join!(host.post(vec![speech("s2", true)]), host.post(vec![user("u2", false)]));
    [one, two, three, four].into_iter().for_each(|posted| posted.unwrap());
    let order: Vec<String> = rig.daemon.appended.lock().unwrap().iter().map(|message| message["meta"]["transcript"]["messageId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(order, ["u1", "s1", "s2", "u2"]);
}
/// A send held before its post enters the log's delivery (Node's recorder holds `log.post`) does not block another send: the
/// second answers while the first is held, and the first posts after it is let go.
#[tokio::test]
async fn a_send_held_before_delivery_does_not_block_another_sends_answer() {
    use crate::rooms::calls::tests::Fake;
    use crate::rooms::user_send::UserMessage;
    let rig = rig(&["a", "held"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let calls = RoomCalls::new(Arc::new(Fake::default()), Arc::new(|_: &str| {}));
    let message = |text: &str| UserMessage { session_id: "sess_room_room01".into(), prompt: json!(text), submission_id: String::new(), pasted_images: None, pasted_texts: None };
    let second = async {
        LABELS_IN.notified().await;
        let two = message("two");
        assert_eq!(rig.live.send(&rig.rooms, &calls, &two).await.unwrap(), true);
        assert_eq!(rig.daemon.appended.lock().unwrap().len(), 1, "the second answered while the first is held");
        LABELS_GO.notify_one();
    };
    let one = message("one");
    let (first, ()) = tokio::join!(rig.live.send(&rig.rooms, &calls, &one), second);
    assert_eq!(first.unwrap(), true);
    let texts: Vec<String> = rig.daemon.appended.lock().unwrap().iter().map(|message| message["content"].as_str().unwrap().to_owned()).collect();
    assert_eq!(texts, ["two", "one"]);
}
/// `stop` of `agent-room-scheduler.ts` cancels the intakes: a message still being taken in when Stop is pressed (no post yet) is
/// posted but routes to nobody.
#[tokio::test]
async fn a_stop_while_a_message_is_taken_in_cancels_its_route() {
    use crate::rooms::calls::tests::Fake;
    use crate::rooms::user_send::UserMessage;
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let runner = Arc::new(Fake::default());
    let calls = RoomCalls::new(runner.clone(), Arc::new(|_: &str| {}));
    let message = UserMessage { session_id: "sess_room_room01".into(), prompt: json!("gate"), submission_id: String::new(), pasted_images: None, pasted_texts: None };
    let stopper = async {
        TAKING_IN.notified().await;
        assert!(rig.daemon.appended.lock().unwrap().is_empty(), "nothing is posted yet");
        assert!(calls.stop_ticket("room01").found, "the intake in progress is what the stop cancels");
        LET_GO.notify_one();
    };
    let (sent, ()) = tokio::join!(rig.live.send(&rig.rooms, &calls, &message), stopper);
    assert_eq!(sent.unwrap(), true);
    tokio::task::yield_now().await;
    assert!(runner.seen.lock().unwrap().is_empty(), "a stopped message routes to no member");
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
            now: Arc::new(|| chrono::Utc::now().timestamp_millis()),
        },
    );
    assert_eq!(live.start(&rooms).await.unwrap(), ["room01"]);
    assert_eq!(*daemon.aborted.lock().unwrap(), ["sess_rmem_room01_a", "sess_rmem_room01_b"]);
    let appended = daemon.appended.lock().unwrap().clone();
    assert_eq!(appended[0]["meta"]["room"], json!({ "kind": "interrupted" }));
    assert!(rooms.get("room01").await.unwrap().running.is_none());
}
/// A plain send after a finished exchange, every revision the log's clients can see: the user's row (no exchange, no band), the
/// band as the exchange begins (deciding) and when each member starts typing, each member's words together with the end of its
/// typing (the room deciding who is next, never "nobody"), and the band leaving only when the room finishes. No revision shows
/// a speaker's words with that speaker still typing, or the band missing between two speakers.
#[tokio::test]
async fn a_sends_exchange_shows_the_band_and_the_rows_as_one_revision_each() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    host.post(vec![user("u1")]).await.unwrap();

    let state = exchange();
    host.track(&state);
    host.republish();
    state.start_speaking("a", "A", "t1".into());
    host.republish();
    host.post_ending_turn(vec![speech("a1", "a")], &state).await.unwrap();
    // The supervisor's step names the same state it was already in: no revision.
    state.stop_speaking();
    host.republish();
    state.start_speaking("b", "B", "t2".into());
    host.republish();
    host.post_ending_turn(vec![speech("b1", "b")], &state).await.unwrap();
    assert!(host.untrack(&state));
    host.republish();
    rig.live.published("room01").await;

    assert_eq!(rig.approvals.log.seen(), ["u1 | -", "u1 | …", "u1 | a", "u1,a1 | …", "u1,a1 | b", "u1,a1,b1 | …", "u1,a1,b1 | -"]);
}
/// The same speaker twice in a row, its second start and several publications coalesced behind one post: the band is the
/// second turn's typing only once it starts, and the first turn's typing never returns after its words.
#[tokio::test]
async fn the_same_speaker_twice_never_shows_its_finished_turn_again_even_when_views_coalesce() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let state = exchange();
    host.track(&state);
    state.start_speaking("a", "A", "t1".into());
    host.republish();

    // The words are being stored (the post holds the room's publication) while views are asked for: all of them wait their turn.
    let go = Arc::new(tokio::sync::Notify::new());
    *rig.daemon.hold.lock().unwrap() = Some(go.clone());
    let post = tokio::spawn({
        let (host, state) = (host.clone(), state.clone());
        async move { host.post_ending_turn(vec![speech("a1", "a")], &state).await }
    });
    while rig.daemon.hold.lock().unwrap().is_some() {
        tokio::task::yield_now().await;
    }
    host.republish();
    host.republish();
    go.notify_one();
    post.await.unwrap().unwrap();
    rig.live.published("room01").await;
    assert_eq!(rig.approvals.log.seen(), ["| a", "a1 | …"], "the queued views built themselves from the state they met: nothing restores a");

    state.start_speaking("a", "A", "t3".into());
    host.republish();
    host.republish();
    host.republish();
    rig.live.published("room01").await;
    assert_eq!(rig.approvals.log.seen(), ["| a", "a1 | …", "a1 | a"], "three coalesced publications are one revision");
}
/// A send that reaches the log after the exchange was untracked and before its final publication: the user's row arrives with the
/// cleared activity as one revision (never the row with the old band, then a separate clear), and the publication that follows
/// has nothing left to change.
#[tokio::test]
async fn a_send_between_the_exchange_ending_and_its_last_publication_carries_the_clear() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let state = exchange();
    host.track(&state);
    host.republish();
    host.post_ending_turn(vec![speech("a1", "a")], &state).await.unwrap();
    assert!(host.untrack(&state));
    host.post(vec![user("u3")]).await.unwrap();
    host.republish();
    rig.live.published("room01").await;
    assert_eq!(rig.approvals.log.seen(), ["| …", "a1 | …", "a1,u3 | -"]);
}
/// A send queued while the room answers hands the room straight to the next exchange: the member cut short is retired with no row,
/// and the next exchange begins deciding, so the log never shows the room without its band in between.
#[tokio::test]
async fn a_queued_send_keeps_the_band_across_the_hand_off() {
    let rig = rig(&["a", "b"]).await;
    rig.live.bind_relays(Arc::new(|_: &str, _: &str| {}));
    let host = rig.live.host("room01").unwrap();
    let old = exchange();
    host.track(&old);
    old.start_speaking("b", "B", "t1".into());
    host.republish();
    host.post(vec![user("u2")]).await.unwrap();
    // Cut short: nothing is posted; the turn is retired explicitly.
    old.end_turn();
    host.republish();
    let next = exchange();
    host.track(&next);
    host.republish();
    next.start_speaking("a", "A", "t2".into());
    host.republish();
    rig.live.published("room01").await;

    assert_eq!(rig.approvals.log.seen(), ["| b", "u2 | b", "u2 | …", "u2 | a"]);
}


#[path = "send_rules.rs"]
mod send_rules;
