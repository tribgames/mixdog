//! Replay of Node's recording `fixtures/room-user-send-cases/golden.json` (`record-room-user-send-cases.mjs`: a user's message
//! as the desktop's `submitToSession` handler validates it and `session-host.ts:1090` hands it to `acceptSend`). Each case's
//! steps go to the core as a client sends them: a send is `room/send`, the request the desktop's `submitToSession` on a room
//! log makes (`service-route.ts`), served by the room service as `compose_flip.rs` composes it (`RoomService` → `UserSend` →
//! `LiveRooms::send`), its rows posted into a real room log through `DirectoryRoomDaemon`, their files taken in by
//! `SessionFiles` over the real attachment store, the room records in a real `state/core.sqlite` (`StateRoomStore`); a stop
//! is the scheduler's (`RoomCalls::stop`, as `RoomRunner::stop`); a restart stops the rooms and the sessions and starts them
//! again over the same folders. Not run, as in Node's recording: the member labels (the recorded `labels`) and the exchange a
//! route starts (each request the scheduler takes is recorded, `RoomCalls::observe_routes`). Each case's whole observed value
//! is compared in recorded order, with the one normalisation the manifest declares (`replay.normalised.newId`).

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_base::support::testing::{request, value, with_op};
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::calls::{CallRunner, Request, RoomCalls, Run};
use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
use mixdog_core_rooms::rooms::live::{LiveRooms, RoomFiles, RoomLabels, RoomPorts};
use mixdog_core_rooms::rooms::ready::RoomsReady;
use mixdog_core_rooms::rooms::records::{RoomDoc, RoomRecord, RoomStore, Rooms};
use mixdog_core_rooms::rooms::service::{KnownAgent, ListingEnd, RoomHost, RoomRunner, RoomService};
use mixdog_core_rooms::rooms::store::StateRoomStore;
use mixdog_core_rooms::rooms::turn_host::MemberLabel;
use mixdog_core_rooms::rooms::user_send::UserSend;
use mixdog_rt::CancellationToken;
use mixdog_store::state::CoreState;
use mixdog_testkit::exact::Exact;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

use super::room_rows_replay::Log;

/// How long a step may take before the test calls it hung (a failure bound, not a wait the test relies on).
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// The keys of a case's observed value that are its recorded inputs.
const INPUTS: [&str; 3] = ["rooms", "labels", "sends"];

const ROOM: &str = "abc123";

fn golden() -> Exact {
    Exact::decode(&serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/room-user-send-cases/golden.json")).expect("golden.json")).expect("recording")
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|e| panic!("recording: {e}"))
}

/// The room records in `state/core.sqlite` (`StateRoomStore`, as `compose_flip.rs` composes it); `fail_next` makes the next
/// save fail as a failed write does.
struct Saves {
    store: StateRoomStore,
    fail_next: Arc<AtomicBool>,
}
#[async_trait]
impl RoomStore for Saves {
    async fn load(&self) -> Result<RoomDoc, RoomError> {
        self.store.load().await
    }
    async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(RoomError::Port("room records: disk I/O error".into()));
        }
        self.store.save(doc).await
    }
}

/// `memberLabels(room)` as recorded (`labels`), by member id.
struct Labels(HashMap<String, MemberLabel>);
#[async_trait]
impl RoomLabels for Labels {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String> {
        Ok(members.iter().filter_map(|id| self.0.get(id).map(|label| (id.clone(), label.clone()))).collect())
    }
}

/// The next row's post held: it says it arrived, then waits to be released (Node's recorder holds the log's `post`).
type Hold = (oneshot::Sender<()>, oneshot::Receiver<()>);

/// The room log's file intake (`SessionFiles`), shared with the log the case reads back; a held send's row waits here, before
/// anything of it is stored or posted.
struct Files {
    intake: Arc<super::room_files::SessionFiles>,
    hold: Arc<Mutex<Option<Hold>>>,
}
#[async_trait]
impl RoomFiles for Files {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let hold = self.hold.lock().unwrap().take();
        if let Some((arrived, released)) = hold {
            let _ = arrived.send(());
            let _ = released.await;
        }
        self.intake.take_in(room_id, row).await
    }
}

/// The exchange a route starts is not run (Node's recorder records `scheduler.route`): it ends at once.
struct Routes;
#[async_trait]
impl CallRunner for Routes {
    async fn run(&self, _: &str, _: &Request, _: &Arc<Run>) -> Result<(), String> {
        Ok(())
    }

    /// No member speaks here, so there is no one to cut off.
    async fn cut_off(&self, _: &str) {}
}

/// The service's host: only the catalog republish is asked by a send (`deps.republishCatalog`), counted with the log's.
struct Host(Arc<AtomicUsize>);
#[async_trait]
impl RoomHost for Host {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        unreachable!("a send lists no agents")
    }
    async fn mixy_route(&self) -> Value {
        unreachable!("a send reads no route")
    }
    async fn task_workspace(&self) -> String {
        unreachable!("a send reads no workspace")
    }
    async fn session_exists(&self, _: &str) -> bool {
        unreachable!("a send reads no session")
    }
    async fn create_session(&self, _: &str, _: &Value) -> Result<(), RoomError> {
        unreachable!("a send creates no session")
    }
    async fn rename_session(&self, _: &str, _: &str) -> Result<(), RoomError> {
        unreachable!("a send renames no session")
    }
    async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
        unreachable!("a send archives no session")
    }
    async fn delete_sessions(&self, _: &[String]) -> usize {
        unreachable!("a send deletes no session")
    }
    async fn start_over(&self, _: &str) -> Result<Option<String>, RoomError> {
        unreachable!("a send starts nothing over")
    }
    async fn reset_member(&self, _: &str) -> Result<(), RoomError> {
        unreachable!("a send resets no member")
    }
    async fn republish_catalog(&self, publish: &CancellationToken) -> Result<Option<ListingEnd>, RoomError> {
        publish.cancel();
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
}

struct Idle;
#[async_trait]
impl RoomRunner for Idle {
    fn is_running(&self, _: &str) -> bool {
        false
    }
    fn stop(&self, _: &str) {}
    async fn start(&self, _: &str, _: Vec<String>) -> Result<(), RoomError> {
        unreachable!("a send starts no exchange through the service's runner")
    }
    fn cancel_owed_to(&self, _: &str, _: &[String]) {}
}

struct Unnamed;
#[async_trait]
impl MemberNames for Unnamed {
    async fn names(&self) -> HashMap<String, String> {
        HashMap::new()
    }
}

/// The member sessions, the agent catalog and the maintainer a send never reaches.
struct Unreached;
#[async_trait]
impl mixdog_core_rooms::rooms::sessions::SessionOps for Unreached {
    async fn route(&self, _: &str) -> Result<Option<Value>, RoomError> {
        unreachable!("a send asks no member session")
    }
    async fn create(&self, _: &str, _: &Value) -> Result<(), RoomError> {
        unreachable!("a send creates no member session")
    }
    async fn set_route(&self, _: &str, _: &Value) -> Result<(), RoomError> {
        unreachable!("a send routes no member session")
    }
    async fn set_archived(&self, _: &str, _: bool) -> Result<(), RoomError> {
        unreachable!("a send archives no member session")
    }
    async fn is_retired(&self, _: &str) -> Result<bool, RoomError> {
        unreachable!("a send reads no member session")
    }
    async fn set_retired(&self, _: &str, _: bool) -> Result<(), RoomError> {
        unreachable!("a send retires no member session")
    }
    async fn set_retired_title(&self, _: &str, _: &str) -> Result<(), RoomError> {
        unreachable!("a send renames no member session")
    }
    async fn rename(&self, _: &str, _: &str) -> Result<(), RoomError> {
        unreachable!("a send renames no member session")
    }
    async fn clear(&self, _: &str, _: &str) -> Result<(), RoomError> {
        unreachable!("a send clears no member session")
    }
    async fn delete(&self, _: &str) -> Result<(), RoomError> {
        unreachable!("a send deletes no member session")
    }
}
#[async_trait]
impl mixdog_core_rooms::rooms::sessions::AgentCatalog for Unreached {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        unreachable!("a send lists no agents")
    }
    async fn mixy_route(&self) -> Value {
        unreachable!("a send reads no route")
    }
    async fn mixy_created(&self) -> bool {
        unreachable!("a send reads no route")
    }
    async fn presence(&self, _: &[String]) -> Result<HashMap<String, mixdog_core_rooms::rooms::home::Presence>, RoomError> {
        unreachable!("a send checks no agent")
    }
    async fn archived_name(&self, _: &str) -> String {
        unreachable!("a send names no archive")
    }
    async fn task_workspace(&self) -> String {
        unreachable!("a send reads no workspace")
    }
}
/// The room's views: a send holds no approval and hands off no question; its view publishes go nowhere here.
#[async_trait]
impl mixdog_core_rooms::rooms::live::RoomApprovals for Unreached {
    async fn approve(&self, _: &str, _: mixdog_core_rooms::rooms::live::ApprovalAnswer) -> Result<bool, String> {
        unreachable!("a send answers no approval")
    }
    async fn answer_question(&self, _: &str, _: mixdog_core_rooms::rooms::live::ApprovalAnswer) -> Result<bool, String> {
        unreachable!("a send answers no question")
    }
    fn member_questions(&self, _: &str, _: &[String]) -> Vec<Value> {
        Vec::new()
    }
    fn publish_view(&self, _: &str, _: Option<mixdog_core_rooms::rooms::live::ExchangeView>, _: Vec<Value>) {}
}
#[async_trait]
impl mixdog_core_rooms::rooms::maintainer::Maintainer for Unreached {
    async fn decide(&self, _: &mixdog_core_rooms::rooms::exchange_run::SupervisorStep) -> Result<Option<mixdog_core_rooms::rooms::exchange::Decision>, String> {
        unreachable!("a send runs no exchange")
    }
}

/// A refusal as the desktop's caller gets it, the wire's `domainError` turned into an error by the desktop's
/// `coreFailure` (`apps/desktop/src/shared/core-error.ts:11-21`): its message (the code standing in when there is none), its
/// code when it has one, and as `details` the detail's fields without the wire's `type` tag, present only when there are any.
fn threw(error: CoreError) -> Value {
    let CoreError::DomainError { message, code, detail, .. } = error else { panic!("a send refused with a domain error, not {error:?}") };
    let message = message.map(|m| m.to_string());
    let Some(code) = code.map(|c| c.to_string()) else { return json!({ "message": message.expect("an uncoded refusal carries its message") }) };
    let mut out = Map::new();
    out.insert("message".into(), json!(message.unwrap_or_else(|| code.clone())));
    out.insert("code".into(), json!(code));
    let mut fields = detail.map(|detail| serde_json::to_value(&*detail).unwrap()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    fields.remove("type");
    if !fields.is_empty() {
        out.insert("details".into(), Value::Object(fields));
    }
    Value::Object(out)
}

fn outcome(answer: Result<Value, CoreError>) -> Value {
    match answer {
        Ok(reply) => json!({ "returned": reply }),
        Err(error) => json!({ "threw": threw(error) }),
    }
}

type Service = RoomService<Saves, Host, Idle>;

/// One start of the core's rooms over the case's folders.
struct Core {
    state: CoreState,
    rooms: Arc<Rooms<Saves>>,
    calls: Arc<RoomCalls<Routes>>,
    service: Arc<Service>,
    /// The next save of the room records fails.
    fail_next_save: Arc<AtomicBool>,
}

/// A case's world: its folders (the room records' state, the room log's data, the op scopes), what it records, and the core
/// running over them.
struct World {
    log: Log,
    state_dir: tempfile::TempDir,
    ops_dir: tempfile::TempDir,
    labels: HashMap<String, MemberLabel>,
    routed: Arc<Mutex<Vec<Value>>>,
    republished: Arc<AtomicUsize>,
    hold: Arc<Mutex<Option<Hold>>>,
    now: i64,
    ops: u64,
    core: Option<Core>,
}

impl World {
    /// The recorded `rooms` saved in the room records' store, the room log created (Node's recorder holds the log session
    /// from the start, whether or not the room exists), and the core started.
    async fn new(rooms: Vec<RoomRecord>, labels: Vec<MemberLabel>) -> Self {
        let republished = Arc::new(AtomicUsize::new(0));
        let log = Log::over({
            let republished = republished.clone();
            Arc::new(move || {
                republished.fetch_add(1, Ordering::SeqCst);
            })
        })
        .await;
        log.create(ROOM).await;
        let state_dir = tempfile::tempdir().unwrap();
        let (state, _) = open_state(&state_dir);
        let doc: RoomDoc = rooms.into_iter().map(|room| (room.id.clone(), room)).collect();
        StateRoomStore::new(state.clone()).save(&doc).await.expect("the recorded rooms saved");
        state.close();
        let mut world = Self {
            log,
            state_dir,
            ops_dir: tempfile::tempdir().unwrap(),
            labels: labels.into_iter().map(|label| (label.id.clone(), label)).collect(),
            routed: Arc::default(),
            republished,
            hold: Arc::default(),
            now: golden().get("clock").get("dateNow").as_f64() as i64,
            ops: 0,
            core: None,
        };
        world.start().await;
        world
    }

    fn core(&self) -> &Core {
        self.core.as_ref().expect("the core runs")
    }

    /// The rooms as `compose_flip.rs` composes them, over the case's folders.
    async fn start(&mut self) {
        let (state, _) = open_state(&self.state_dir);
        let fail_next_save = Arc::new(AtomicBool::new(false));
        let rooms = Arc::new(Rooms::new(Saves { store: StateRoomStore::new(state.clone()), fail_next: fail_next_save.clone() }));
        let now = self.now;
        let live = LiveRooms::new(
            rooms.clone(),
            RoomPorts {
                daemon: self.log.daemon.clone(),
                approvals: Arc::new(Unreached),
                labels: Arc::new(Labels(self.labels.clone())),
                files: Arc::new(Files { intake: self.log.files.clone(), hold: self.hold.clone() }),
                sessions: Arc::new(Unreached),
                catalog: Arc::new(Unreached),
                maintainer: Arc::new(Unreached),
                preview: Arc::new(|text: &str| mixdog_core_rooms::rooms::preview::plain_preview_text(text)),
                log: Arc::new(|_: &str| {}),
                now: Arc::new(move || now),
            },
        );
        let calls = RoomCalls::new(Arc::new(Routes), Arc::new(|_: &str| {}));
        let routed = self.routed.clone();
        calls.observe_routes(Arc::new(move |room_id: &str, request: &Request| {
            routed.lock().unwrap().push(json!({ "roomId": room_id, "to": request.to, "everyone": request.everyone, "waiting": request.waiting }));
        }));
        live.bind_relays(Arc::new(|_: &str, _: &str| {}));
        // The rooms' first load hosts them, as `compose_flip.rs` binds it.
        let ready = RoomsReady::new();
        ready
            .bind({
                let (live, rooms) = (live.clone(), rooms.clone());
                move || {
                    let (live, rooms) = (live.clone(), rooms.clone());
                    async move { live.host_loaded(&rooms).await }
                }
            })
            .expect("bound once");
        let service = Arc::new(RoomService::new(
            rooms.clone(),
            Arc::new(Host(self.republished.clone())),
            Arc::new(Idle),
            mixdog_core_base::support::testing::scopes(self.ops_dir.path(), "room").await,
            Arc::new(Unnamed),
            ready,
            Arc::new(UserSend::new(rooms.clone(), live, calls.clone())),
        ));
        self.core = Some(Core { state, rooms, calls, service, fail_next_save });
    }

    /// The core stops (its room records closed, its sessions shut down) and starts again over the same folders.
    async fn restart(&mut self) {
        let core = self.core.take().expect("the core runs");
        let Core { state, rooms, calls, service, .. } = core;
        drop((service, calls, rooms));
        state.close();
        self.log.restart().await;
        self.start().await;
    }

    /// `room/send` with `send`'s `{ sessionId, prompt, options }`, as the desktop's route sends `submitToSession`'s arguments
    /// (`service-route.ts` `turnInput`: the submit options it knows, `id` as `clientSubmissionId`).
    fn request(&mut self, send: &Value) -> impl std::future::Future<Output = Result<Value, CoreError>> + Send + 'static {
        let mut options = send["options"].as_object().cloned().unwrap_or_default();
        if let Some(id) = options.shift_remove("id") {
            options.insert("clientSubmissionId".into(), id);
        }
        let input = json!({ "threadId": send["sessionId"], "prompt": send["prompt"], "options": options });
        self.input(input)
    }

    /// `room/send` with `input` as it is.
    fn input(&mut self, input: Value) -> impl std::future::Future<Output = Result<Value, CoreError>> + Send + 'static {
        self.ops += 1;
        let (op, service) = (self.ops, self.core().service.clone());
        async move {
            tokio::time::timeout(DEADLINE, value(&*service, request("room/send", with_op(json!({ "input": input }), op), Some(op))))
                .await
                .unwrap_or_else(|_| panic!("room/send {op} answered within the deadline"))
        }
    }

    /// Each step in turn, as Node's recorder runs them; what each gave.
    async fn steps(&mut self, sends: &[Value]) -> Vec<Value> {
        let mut outcomes: Vec<Value> = Vec::new();
        let mut in_flight: VecDeque<(usize, oneshot::Sender<()>, tokio::task::JoinHandle<Result<Value, CoreError>>)> = VecDeque::new();
        for step in sends {
            if step["restart"] == true {
                self.restart().await;
                outcomes.push(json!({ "restarted": true }));
            } else if step["stop"] == true {
                outcomes.push(json!({ "stopped": self.core().calls.stop(ROOM) }));
            } else if step["release"] == true {
                let (at, release, answer) = in_flight.pop_front().expect("a held send to release");
                let _ = release.send(());
                outcomes[at] = outcome(tokio::time::timeout(DEADLINE, answer).await.expect("the released send answered within the deadline").expect("the send ran"));
                outcomes.push(json!({ "released": at }));
            } else if step["held"] == true {
                let (arrived, reached) = oneshot::channel();
                let (release, released) = oneshot::channel();
                *self.hold.lock().unwrap() = Some((arrived, released));
                let at = outcomes.len();
                outcomes.push(Value::Null);
                let mut answer = tokio::spawn(self.request(step));
                // The send reaches its post, or is refused before it (then the hold is left for no one).
                tokio::time::timeout(DEADLINE, async {
                    tokio::select! {
                        _ = reached => {}
                        _ = &mut answer => panic!("a held send answered before its post"),
                    }
                })
                .await
                .expect("the held send reached its post within the deadline");
                in_flight.push_back((at, release, answer));
            } else {
                let answer = self.request(step).await;
                outcomes.push(outcome(answer));
            }
        }
        assert!(in_flight.is_empty(), "a held send was never released");
        outcomes
    }

    /// The room log's rows as the room host reads them back, the core's own row ids named as the manifest declares
    /// (`replay.normalised.newId`): a read-back id that starts with `user_` and is no submission id of the case is renamed
    /// `user_newId<n>`, `n` counting them in the order they first appear.
    async fn read_back(&self, submissions: &[String]) -> Value {
        let thread = format!("sess_room_{ROOM}");
        let mut rows = mixdog_core_rooms::rooms::live::RoomDaemon::room_rows(&*self.log.daemon, &thread).await.expect("the room log's rows");
        let mut made: Vec<String> = Vec::new();
        for row in &mut rows {
            let Some(id) = row["id"].as_str().filter(|id| id.starts_with("user_") && !submissions.iter().any(|s| s == id)).map(str::to_owned) else { continue };
            let n = made.iter().position(|seen| *seen == id).unwrap_or_else(|| {
                made.push(id.clone());
                made.len() - 1
            });
            row["id"] = json!(format!("user_newId{}", n + 1));
        }
        Value::Array(rows)
    }

    /// The room as stored (what a restart reads): the fields `acceptSend` and the log change.
    async fn stored_room(&self) -> Value {
        let doc = StateRoomStore::new(self.core().state.clone()).load().await.expect("the stored rooms");
        match doc.get(ROOM) {
            Some(record) => {
                let stored = serde_json::to_value(record).unwrap();
                let field = |key: &str| stored.get(key).cloned().unwrap_or_else(|| json!({ "$exact": "undefined" }));
                json!({ "lastSpeaker": field("lastSpeaker"), "lastAt": field("lastAt"), "lastPreview": field("lastPreview"), "submissions": field("submissions") })
            }
            None => Value::Null,
        }
    }

    /// What a refused send must leave as it was: the log's rows, the routed requests, the stored room and the attachment
    /// store's files.
    async fn state(&self) -> Value {
        json!({
            "rows": self.read_back(&[]).await,
            "routed": *self.routed.lock().unwrap(),
            "room": self.stored_room().await,
            "files": self.log.stored_files(),
            "dataBytes": self.log.data_files().into_iter().map(|(name, bytes)| json!([name, bytes])).collect::<Vec<_>>(),
            "catalogRepublished": self.republished.load(Ordering::SeqCst),
        })
    }
}

fn open_state(dir: &tempfile::TempDir) -> (CoreState, impl Sized) {
    let tokens = mixdog_rt::testing::tokens();
    CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("state/core.sqlite")
}

fn inputs(case: &Exact) -> (Vec<RoomRecord>, Vec<MemberLabel>, Vec<Value>) {
    let rooms: Vec<RoomRecord> = serde_json::from_value(plain(case.get("rooms"))).expect("recorded rooms");
    let labels = plain(case.get("labels"))
        .as_array()
        .unwrap()
        .iter()
        .map(|label| MemberLabel {
            id: label["id"].as_str().unwrap().into(),
            name: label["name"].as_str().unwrap().into(),
            route: label["route"].clone(),
            description: label["description"].as_str().unwrap().into(),
            disabled: label["disabled"] == true,
        })
        .collect();
    let sends = plain(case.get("sends")).as_array().unwrap().clone();
    (rooms, labels, sends)
}

/// One case: its rooms, labels and steps as recorded, through the composed room service; its whole observed value.
async fn replay(case: &Exact) -> Value {
    let (rooms, labels, sends) = inputs(case);
    let submissions: Vec<String> = sends.iter().filter_map(|send| send["options"]["id"].as_str().map(str::to_owned)).collect();
    let mut world = World::new(rooms, labels).await;
    let outcomes = world.steps(&sends).await;
    // The room settles (no exchange runs, no relay is held back, no message is on its way) before what was routed is read:
    // nothing more can be routed into it after this point.
    let calls = world.core().calls.clone();
    tokio::time::timeout(DEADLINE, calls.settled(ROOM)).await.expect("the room settled within the deadline");
    let mut observed = json!({
        "outcomes": outcomes,
        "readBack": world.read_back(&submissions).await,
        "routed": *world.routed.lock().unwrap(),
        "room": world.stored_room().await,
        "catalogRepublished": world.republished.load(Ordering::SeqCst),
    });
    if case.try_get("storedBytes").is_some() {
        let mut stored = Vec::new();
        for row in observed["readBack"].as_array().unwrap().clone() {
            for part in row["parts"].as_array().cloned().unwrap_or_default() {
                stored.push(json!({ "type": part["type"], "text": world.log.stored_text(part["attachmentRef"].as_str().unwrap()).await }));
            }
        }
        observed["storedBytes"] = Value::Array(stored);
    }
    observed
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_send_replays_nodes_accept_send() {
    let golden = golden();
    let cases = golden.get("cases").as_array();
    assert_eq!(cases.len(), 17, "the recording's cases");
    let mut differ = Vec::new();
    for case in cases {
        let name = case.get("case").as_str();
        let observed = case.get("observed");
        let got = Exact::decode(&replay(observed).await).unwrap_or_else(|e| panic!("{name}: {e}"));
        // `rooms`, `labels` and `sends` are the case's inputs (fed above); every other recorded key is what Node gave, in
        // recorded order, and the core gives exactly those keys.
        let outputs: Vec<&(String, Exact)> = observed.entries().iter().filter(|(key, _)| !INPUTS.contains(&key.as_str())).collect();
        let gave: Vec<&(String, Exact)> = got.entries().iter().collect();
        if gave != outputs {
            differ.push(format!("{name}\n  core: {gave:?}\n  node: {outputs:?}"));
        }
    }
    assert!(differ.is_empty(), "{} of {} cases differ from Node's:\n{}", differ.len(), cases.len(), differ.join("\n"));
}

/// The first recorded case's room and labels: a room every member of which can be addressed.
async fn plan_room() -> World {
    let golden = golden();
    let (rooms, labels, _) = inputs(golden.get("cases").as_array()[0].get("observed"));
    World::new(rooms, labels).await
}

/// `acceptSend` keeps the submission id in the room before it awaits the save (`agent-room-messages.ts:103`, `:109`): a send
/// whose save failed answers the failure, and its retry is acknowledged (`:76`) and posts and routes nothing more.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_send_whose_save_failed_is_acknowledged_when_retried_and_posted_once() {
    let mut world = plan_room().await;
    let send = json!({ "sessionId": format!("sess_room_{ROOM}"), "prompt": "hello all", "options": { "id": "sub-save" } });
    world.core().fail_next_save.store(true, Ordering::SeqCst);
    let first = world.request(&send).await;
    assert!(first.is_err(), "the failed save is the send's answer: {first:?}");
    assert_eq!(outcome(world.request(&send).await), json!({ "returned": true }), "the retry is acknowledged");
    let rows: Vec<Value> = world.read_back(&[]).await.as_array().unwrap().iter().map(|row| row["id"].clone()).collect();
    assert_eq!(rows, [json!("sub-save")], "posted once");
    assert_eq!(world.routed.lock().unwrap().len(), 1, "routed once");
    assert_eq!(world.stored_room().await["submissions"], json!(["sub-save"]), "the id is stored by the next save");
}

/// `room/send`'s arguments as Node's `submitToSession` handlers check them (`requiredSessionId`, `requiredPromptContent`,
/// `requiredSubmitOptions`): each field of the wrong type, missing or too large is refused with no effect: the room log's rows,
/// the routed requests, the stored room, the attachment store and the catalog stay as they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_malformed_argument_is_refused_before_anything_happens() {
    let mut world = plan_room().await;
    let log = json!(format!("sess_room_{ROOM}"));
    let png = json!({ "type": "image", "data": "cG5n", "mimeType": "image/png" });
    let docx = json!({ "type": "file", "data": "ZG9jeA==", "mimeType": "application/msword", "filename": "a.doc" });
    let input = |thread: Value, prompt: Value, options: Value| json!({ "threadId": thread, "prompt": prompt, "options": options });
    let ok = |options: Value| input(log.clone(), json!("hi"), options);
    let big = |units: usize| json!("a".repeat(units));
    let cases: Vec<(&str, Value)> = vec![
        ("input not an object", json!("hi")),
        ("an unknown input field", json!({ "threadId": log, "prompt": "hi", "extra": 1 })),
        ("threadId missing", json!({ "prompt": "hi" })),
        ("threadId a number", input(json!(7), json!("hi"), json!({}))),
        ("threadId blank", input(json!("  "), json!("hi"), json!({}))),
        ("threadId with a slash", input(json!("sess_room_abc/../x"), json!("hi"), json!({}))),
        ("threadId too long", input(json!("s".repeat(257)), json!("hi"), json!({}))),
        ("prompt missing", json!({ "threadId": log })),
        ("prompt a number", input(log.clone(), json!(1), json!({}))),
        ("prompt blank", input(log.clone(), json!("   "), json!({}))),
        ("prompt over 1,000,000 units", input(log.clone(), big(1_000_001), json!({}))),
        ("prompt no parts", input(log.clone(), json!([]), json!({}))),
        ("prompt 33 parts", input(log.clone(), json!(vec![json!({ "type": "text", "text": "a" }); 33]), json!({}))),
        ("a part not an object", input(log.clone(), json!(["a"]), json!({}))),
        ("a part of no known type", input(log.clone(), json!([{ "type": "audio" }]), json!({}))),
        ("a text part without text", input(log.clone(), json!([{ "type": "text", "text": 3 }]), json!({}))),
        ("text parts over 1,000,000 units", input(log.clone(), json!([{ "type": "text", "text": "a".repeat(600_000) }, { "type": "text", "text": "a".repeat(400_001) }]), json!({}))),
        ("only blank text", input(log.clone(), json!([{ "type": "text", "text": " " }]), json!({}))),
        ("an image without a type", input(log.clone(), json!([{ "type": "image", "data": "cG5n" }]), json!({}))),
        ("an image of another type", input(log.clone(), json!([{ "type": "image", "data": "cG5n", "mimeType": "image/bmp" }]), json!({}))),
        ("an image without data", input(log.clone(), json!([{ "type": "image", "data": "", "mimeType": "image/png" }]), json!({}))),
        ("an image whose data is no base64", input(log.clone(), json!([{ "type": "image", "data": "a b", "mimeType": "image/png" }]), json!({}))),
        ("a ninth image", input(log.clone(), json!(vec![png.clone(); 9]), json!({}))),
        ("a file of an unsupported type", input(log.clone(), json!([{ "type": "file", "data": "eA==", "mimeType": "text/plain" }]), json!({}))),
        ("a file whose type is too long", input(log.clone(), json!([{ "type": "file", "data": "eA==", "mimeType": "a".repeat(129) }]), json!({}))),
        ("a file whose data is a number", input(log.clone(), json!([{ "type": "file", "data": 5, "mimeType": "application/pdf" }]), json!({}))),
        ("a ninth file", input(log.clone(), json!(vec![docx.clone(); 9]), json!({}))),
        ("options not an object", ok(json!([]))),
        ("an unknown option", ok(json!({ "device": "phone" }))),
        ("an option named __proto__ deep inside", ok(json!({ "pastedTexts": { "1": { "constructor": 1 } } }))),
        ("options nested deeper than 12", ok(json!({ "pastedTexts": (0..13).fold(json!(1), |inner, _| json!({ "a": inner })) }))),
        ("a submission id that is a number", ok(json!({ "clientSubmissionId": 5 }))),
        ("a blank submission id", ok(json!({ "clientSubmissionId": " " }))),
        ("a submission id over 256 units", ok(json!({ "clientSubmissionId": "s".repeat(257) }))),
        ("a submission id with a control character", ok(json!({ "clientSubmissionId": "s\u{1}" }))),
        ("a fractional submittedAt", ok(json!({ "submittedAt": 1.5 }))),
        ("a submittedAt of 0", ok(json!({ "submittedAt": 0 }))),
        ("retryFailedTurn not a boolean", ok(json!({ "retryFailedTurn": "yes" }))),
        ("kickoff not a boolean", ok(json!({ "kickoff": 1 }))),
        ("an unknown priority", ok(json!({ "priority": "soon" }))),
        ("displayText not a string", ok(json!({ "displayText": 1 }))),
        ("displayText over 1,000,000 units", ok(json!({ "displayText": "a".repeat(1_000_001) }))),
        ("a blank goalCommand", ok(json!({ "goalCommand": "  " }))),
    ];
    let before = world.state().await;
    for (name, input) in cases {
        let answer = world.input(input).await;
        assert!(matches!(answer, Err(CoreError::DomainError { .. })), "{name}: refused, not {answer:?}");
        assert_eq!(world.state().await, before, "{name}: nothing changed");
    }
    // The checks pass a message they accept on: the same room then takes one.
    assert_eq!(outcome(world.input(input(log.clone(), json!([{ "type": "text", "text": "ok" }, png, docx]), json!({ "clientSubmissionId": "sub-ok" }))).await), json!({ "returned": true }));
}

/// A string with a lone surrogate counts as its units and is never looked into for well-formedness: Node's validators
/// (`ipc-validation.ts:1152-1222`, `:1225-1266`) test only length, blankness, control characters and the id/type/base64
/// alphabets, so a lone surrogate in a free text field (prompt, a text part, displayText, goalCommand, the submission id, a file
/// name) is accepted, and in a field with an alphabet (the thread id, a mime type, base64 data) it falls outside it and is
/// refused with no effect. The value is parsed as `JSON.parse` parses the wire text (`mixdog_js::json_parse`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lone_surrogate_is_accepted_in_free_text_and_refused_where_an_alphabet_rules() {
    let mut world = plan_room().await;
    let parse = |text: String| mixdog_js::json_parse(&text).expect("the wire text parses");
    let room = format!("sess_room_{ROOM}");
    let refused = vec![
        ("threadId", format!(r#"{{"threadId":"{room}\ud800","prompt":"hi"}}"#)),
        ("an image's type", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"image","data":"cG5n","mimeType":"image/png\ud800"}}]}}"#)),
        ("an image's data", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"image","data":"cG5n\ud800","mimeType":"image/png"}}]}}"#)),
        ("a file's type", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"file","data":"ZG9j","mimeType":"application/pdf\ud800"}}]}}"#)),
        ("a file's data", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"file","data":"\udc00ZG9j","mimeType":"application/pdf"}}]}}"#)),
    ];
    let before = world.state().await;
    for (field, text) in refused {
        let answer = world.input(parse(text)).await;
        assert!(matches!(answer, Err(CoreError::DomainError { .. })), "{field}: refused, not {answer:?}");
        assert_eq!(world.state().await, before, "{field}: nothing changed");
    }
    let accepted = vec![
        ("the prompt", format!(r#"{{"threadId":"{room}","prompt":"hi \ud800","options":{{"clientSubmissionId":"s1"}}}}"#)),
        ("a text part", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"text","text":"\ude00 hi"}}],"options":{{"clientSubmissionId":"s2"}}}}"#)),
        ("the submission id", format!(r#"{{"threadId":"{room}","prompt":"hi","options":{{"clientSubmissionId":"s3-\ud83d"}}}}"#)),
        ("displayText", format!(r#"{{"threadId":"{room}","prompt":"hi","options":{{"clientSubmissionId":"s4","displayText":"\ud800"}}}}"#)),
        ("goalCommand", format!(r#"{{"threadId":"{room}","prompt":"hi","options":{{"clientSubmissionId":"s5","goalCommand":"\ud800"}}}}"#)),
        ("a file name", format!(r#"{{"threadId":"{room}","prompt":[{{"type":"text","text":"hi"}},{{"type":"file","data":"ZG9j","mimeType":"application/msword","filename":"a\ud800.doc"}}],"options":{{"clientSubmissionId":"s6"}}}}"#)),
    ];
    for (field, text) in accepted {
        let answer = outcome(world.input(parse(text)).await);
        assert_eq!(answer, json!({ "returned": true }), "{field}: accepted");
    }
}

/// Who may post: Node's `submitToSession` is served to the desktop (`ipc-sessions.ts:221`), to an SSH desktop through the
/// same handler, and to a paired phone (`remote-session-methods.ts:155`); `room/send` is open to the same origins as the
/// `turn/start` it replaces on a room log. What a caller can name: only a room log's session (any other session, or a room
/// that does not exist, is refused before anything happens: "This room no longer exists.", `agent-room-records.ts:102-105`);
/// a file only by its content address (the recorded case of a pasted image naming one the store does not hold).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn room_send_is_open_to_the_desktop_and_the_phone_and_names_only_a_room_log() {
    let room = mixdog_app_protocol::client_method_spec("room/send").expect("room/send");
    let turn = mixdog_app_protocol::client_method_spec("turn/start").expect("turn/start");
    assert_eq!(room.origins, turn.origins, "the origins submitToSession has");
    let mut world = plan_room().await;
    let before = world.state().await;
    for thread in ["sess_abc123", "sess_room_zzz999"] {
        let answer = outcome(world.input(json!({ "threadId": thread, "prompt": "hi", "options": { "clientSubmissionId": "sub-x" } })).await);
        assert_eq!(answer, json!({ "threw": { "message": "This room no longer exists." } }), "{thread}");
        assert_eq!(world.state().await, before, "{thread}: nothing changed");
    }
}
/// Every other way a param can name a target is refused or ignored with no effect outside the room. A thread id that is not
/// exactly a room log's (another kind of session, another spelling, a room that is not there) is refused before anything
/// happens; no other field of the input or of the options takes a target (an alias such as `roomId` or `sessionId` is an
/// unknown field); a member is named only inside the prompt, and only a member of this room; a part's or a side table's `path`
/// is never read: the bytes a message stores are those it carries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_other_way_a_param_could_name_a_target_reaches_nothing() {
    let mut world = plan_room().await;
    let log = json!(format!("sess_room_{ROOM}"));
    let before = world.state().await;
    let mut refused: Vec<(String, Value)> = Vec::new();
    for thread in ["room_abc123", "abc123", "sess_room_ABC123", "sess_room_abc12", "sess_room_abc123x", "sess_home_lead", "sess_member_abc123_lead", "sess_room_abc123 x"] {
        refused.push((format!("thread {thread}"), json!({ "threadId": thread, "prompt": "hi" })));
    }
    for alias in ["sessionId", "roomId", "room", "target", "path", "to"] {
        refused.push((format!("input field {alias}"), json!({ "threadId": log, "prompt": "hi", alias: format!("sess_room_{ROOM}") })));
        refused.push((format!("option {alias}"), json!({ "threadId": log, "prompt": "hi", "options": { alias: "sess_other" } })));
    }
    refused.push(("a member that is not in the room".into(), json!({ "threadId": log, "prompt": "/ask nobody hello" })));
    for (name, input) in refused {
        let answer = world.input(input).await;
        assert!(matches!(answer, Err(CoreError::DomainError { .. })), "{name}: refused, not {answer:?}");
        assert_eq!(world.state().await, before, "{name}: nothing changed");
    }

    // A path in a part or a side table: whatever the message does, the file's bytes never reach the log or the store.
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, "SECRET-MARKER-9f3a1c").unwrap();
    let path = secret.to_string_lossy().into_owned();
    let none = "0".repeat(64);
    let named = json!({
        "threadId": log,
        "prompt": [
            { "type": "text", "text": "see 1 and 2" },
            { "type": "file", "data": "ZG9j", "mimeType": "application/msword", "path": path, "url": path, "attachmentRef": none },
            { "type": "image", "data": "cG5n", "mimeType": "image/png", "path": path, "file": path },
        ],
        "options": {
            "clientSubmissionId": "sub-path",
            "pastedImages": { "1": { "id": "1", "path": path, "attachmentRef": none, "mimeType": "image/png" } },
            "pastedTexts": { "1": { "id": "1", "path": path, "source": "file", "name": "secret.txt" } },
        },
    });
    let _ = world.input(named).await;
    let seen = serde_json::to_string(&world.state().await).unwrap();
    assert!(!seen.contains("SECRET-MARKER-9f3a1c") && !seen.contains("U0VDUkVULU1BUktFUi05ZjNhMWM"), "the file's bytes stay out of the room: {seen}");
    for (name, bytes) in world.log.data_files() {
        assert!(!String::from_utf8_lossy(&bytes).contains("SECRET-MARKER-9f3a1c"), "{name}: the file's bytes stay out of the store");
    }
}
