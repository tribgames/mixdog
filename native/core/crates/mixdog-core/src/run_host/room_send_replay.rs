//! Replay of Node's recording `fixtures/room-user-send-cases/golden.json` (`record-room-user-send-cases.mjs`, Node's
//! `acceptSend` of `agent-room-messages.ts` as `session-host.ts:1090` calls it). Each case's sends go to the core through
//! `room/send`, the request the desktop's `submitToSession` on a room log makes (`service-route.ts`), served by the room
//! service as `compose_flip.rs` composes it: `RoomService` → `UserSend` → `LiveRooms::send`, its rows posted into a real
//! room log through `DirectoryRoomDaemon` and their files taken in by `SessionFiles` over the real attachment store. Not
//! run, as in Node's recording: the member labels (the recorded `labels`) and the exchange a route starts (the scheduler's
//! runner records each request in Node's option shape). Each case's whole observed value is compared in recorded order.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

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
use mixdog_core_rooms::rooms::turn_host::MemberLabel;
use mixdog_core_rooms::rooms::user_send::UserSend;
use mixdog_rt::CancellationToken;
use mixdog_testkit::exact::Exact;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::room_rows_replay::Log;

/// How long a step may take before the test calls it hung (a failure bound, not a wait the test relies on).
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// The keys of a case's observed value that are its recorded inputs.
const INPUTS: [&str; 3] = ["rooms", "labels", "sends"];

fn golden() -> Exact {
    Exact::decode(&serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/room-user-send-cases/golden.json")).expect("golden.json")).expect("recording")
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap_or_else(|e| panic!("recording: {e}"))
}

/// The room records in memory, the recorded `rooms` as the store holds them.
struct Mem(Mutex<RoomDoc>);
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

/// `memberLabels(room)` as recorded (`labels`), by member id.
struct Labels(HashMap<String, MemberLabel>);
#[async_trait]
impl RoomLabels for Labels {
    async fn labels(&self, members: &[String]) -> Result<HashMap<String, MemberLabel>, String> {
        Ok(members.iter().filter_map(|id| self.0.get(id).map(|label| (id.clone(), label.clone()))).collect())
    }
}

/// The room log's file intake (`SessionFiles`), shared with the log the case reads back.
struct Files(Arc<super::room_files::SessionFiles>);
#[async_trait]
impl RoomFiles for Files {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String> {
        self.0.take_in(room_id, row).await
    }
}

/// The exchange a route starts is not run (Node's recorder records `scheduler.route`): each request, in Node's option shape.
struct Routes(mpsc::UnboundedSender<Value>);
#[async_trait]
impl CallRunner for Routes {
    async fn run(&self, room_id: &str, request: &Request, _: &Arc<Run>) -> Result<(), String> {
        let _ = self.0.send(json!({ "roomId": room_id, "to": request.to, "everyone": request.everyone, "waiting": request.waiting }));
        Ok(())
    }

    /// No member speaks here (a route's run ends at once), so there is no one to cut off.
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

/// One case: its rooms, sends and labels as recorded, through the composed room service; its whole observed value.
async fn replay(case: &Exact) -> Value {
    let rooms_in: Vec<RoomRecord> = serde_json::from_value(plain(case.get("rooms"))).expect("recorded rooms");
    let labels: Vec<MemberLabel> = plain(case.get("labels"))
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
    let now = golden().get("clock").get("dateNow").as_f64() as i64;

    let republished = Arc::new(AtomicUsize::new(0));
    let log = Log::over({
        let republished = republished.clone();
        Arc::new(move || {
            republished.fetch_add(1, Ordering::SeqCst);
        })
    })
    .await;
    // Node's recorder holds the room log session from the start, whether or not the room exists.
    let thread = log.create("abc123").await;

    let rooms = Arc::new(Rooms::new(Mem(Mutex::new(rooms_in.into_iter().map(|room| (room.id.clone(), room)).collect()))));
    let live = LiveRooms::new(
        rooms.clone(),
        RoomPorts {
            daemon: log.daemon.clone(),
            approvals: Arc::new(Unreached),
            labels: Arc::new(Labels(labels.into_iter().map(|label| (label.id.clone(), label)).collect())),
            files: Arc::new(Files(log.files.clone())),
            sessions: Arc::new(Unreached),
            catalog: Arc::new(Unreached),
            maintainer: Arc::new(Unreached),
            preview: Arc::new(|text: &str| mixdog_core_rooms::rooms::preview::plain_preview_text(text)),
            log: Arc::new(|_: &str| {}),
            now: Arc::new(move || now),
        },
    );
    let (routes, mut routed_rx) = mpsc::unbounded_channel();
    let calls = RoomCalls::new(Arc::new(Routes(routes)), Arc::new(|_: &str| {}));
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
    let dir = tempfile::tempdir().unwrap();
    let service = RoomService::new(
        rooms.clone(),
        Arc::new(Host(republished.clone())),
        Arc::new(Idle),
        mixdog_core_base::support::testing::scopes(dir.path(), "room").await,
        Arc::new(Unnamed),
        ready,
        Arc::new(UserSend::new(rooms.clone(), live.clone(), calls.clone())),
    );

    let mut outcomes = Vec::new();
    for (n, send) in plain(case.get("sends")).as_array().unwrap().iter().enumerate() {
        // `submitToSession(sessionId, prompt, options)` as the desktop sends it (`service-route.ts` `turnInput`).
        let mut options = send["options"].as_object().unwrap().clone();
        let id = options.shift_remove("id");
        if let Some(id) = id {
            options.insert("clientSubmissionId".into(), id);
        }
        let input = json!({ "threadId": send["sessionId"], "prompt": send["prompt"], "options": options });
        let op = n as u64 + 1;
        let answer = tokio::time::timeout(DEADLINE, value(&service, request("room/send", with_op(json!({ "input": input }), op), Some(op))))
            .await
            .unwrap_or_else(|_| panic!("room/send {n} answered within the deadline"));
        outcomes.push(match answer {
            Ok(reply) => json!({ "returned": reply }),
            Err(error) => json!({ "threw": threw(error) }),
        });
    }

    let read_back = mixdog_core_rooms::rooms::live::RoomDaemon::room_rows(&*log.daemon, thread.as_str()).await.expect("the room log's rows");
    let want_routes = case.get("routed").as_array().len();
    let mut routed = Vec::new();
    for _ in 0..want_routes {
        routed.push(tokio::time::timeout(DEADLINE, routed_rx.recv()).await.expect("a recorded route reached the scheduler").expect("routes"));
    }
    assert!(routed_rx.try_recv().is_err(), "a route Node did not make");

    let room = match rooms.get("abc123").await {
        Ok(record) => {
            let stored = serde_json::to_value(&record).unwrap();
            let field = |key: &str| stored.get(key).cloned().unwrap_or_else(|| json!({ "$exact": "undefined" }));
            json!({ "lastSpeaker": field("lastSpeaker"), "lastAt": field("lastAt"), "lastPreview": field("lastPreview"), "submissions": field("submissions") })
        }
        Err(RoomError::NotFound(_)) => Value::Null,
        Err(error) => panic!("{error:?}"),
    };

    let mut observed = json!({
        "outcomes": outcomes,
        "readBack": read_back,
        "routed": routed,
        "room": room,
        "catalogRepublished": republished.load(Ordering::SeqCst),
    });
    if case.try_get("storedBytes").is_some() {
        let mut stored = Vec::new();
        for row in observed["readBack"].as_array().unwrap().clone() {
            for part in row["parts"].as_array().cloned().unwrap_or_default() {
                stored.push(json!({ "type": part["type"], "text": log.stored_text(part["attachmentRef"].as_str().unwrap()).await }));
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
    assert_eq!(cases.len(), 10, "the recording's cases");
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
