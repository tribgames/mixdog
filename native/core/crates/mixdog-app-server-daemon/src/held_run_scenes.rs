//! The composed approval gate through the daemon's own pieces: the real policy gate (`PolicyGate` over `ToolPolicy`, the file grant store),
//! the real `SessionGate` over the process's unattended-run registry, the production `ProcessHeldHome`, `HeldRequests` behind the`n//! `HeldGates` the turn path gets, and the heartbeat's `FactSources`. Only the surface's approval card (the thread's own gate) and the
//! home-thread delivery are stand-ins. A run nobody can show a card for is held; a turn whose clients leave keeps its card.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::NoGuards;
use mixdog_agent::env::NullObserver;
use mixdog_agent::env::PolicyGate;
use mixdog_agent::env::PolicyGateParts;
use mixdog_agent::env::ToolGate;
use mixdog_core::run_host::mcp_seams::UnattendedRuns;
use mixdog_core::run_host::run_approvals::RunApprovals;
use mixdog_core::run_host::unattended::UnattendedRunRegistry;
use mixdog_core_api::ApprovalSurfaces;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_core_ports::ports::gate::GateEnv;
use mixdog_core_ports::ports::gate::GateRun;
use mixdog_core_ports::ports::gate::LiveHeader;
use mixdog_core_ports::ports::gate::SessionGate;
use mixdog_core_ports::ports::run_stamps::RunStamps;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::HeldRequest;
use mixdog_protocol::HumanGateResponse;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolApprovalDecision;
use mixdog_services::bots::beat::CatalogPage;
use mixdog_services::bots::beat::FactSources;
use mixdog_services::bots::beat::SessionCatalog;
use mixdog_services::bots::beat::TaskWatches;
use mixdog_services::bots::routine::RoutineKind;
use mixdog_services::bots::runtime::RoutineRecords;
use mixdog_services::bots::runtime::RoutineState;
use mixdog_store::schema::record::Header;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::FileGrantStore;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::PreToolHook;
use mixdog_tools::policy::SessionGrants;
use mixdog_tools::policy::SessionSurface;
use mixdog_tools::policy::ToolPolicy;
use mixdog_tools::policy::ToolResolver;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;

use crate::held_home_draft::ProcessHeldHome;
use crate::held_requests::HeldAnswer;
use crate::held_requests::HeldGates;
use crate::held_requests::HeldHome;
use crate::held_requests::HeldPush;
use crate::held_requests::HeldRequests;
use crate::held_requests::RunInfo;

struct NoStamps;

#[async_trait]
impl RunStamps for NoStamps {
    async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
        None
    }
}

/// `GateEnv` over the process's unattended-run registry; `ann` is the one contact bot (her `AGENT.md` says `kind: bot`).
struct Env {
    runs: Arc<UnattendedRunRegistry>,
}

#[async_trait]
impl GateEnv for Env {
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun> {
        self.runs.run_of(thread).await
    }
    async fn is_contact_bot(&self, agent_id: &str) -> bool {
        agent_id == "ann"
    }
    fn allow_all_actions(&self) -> bool {
        false
    }
    async fn connector_account(&self, _: &ThreadId, _: &Header, _: &GateCall) -> Result<Option<mixdog_agent::env::BoundAccount>, String> {
        Ok(None)
    }
}

struct FixedHeader(Arc<Header>);

impl LiveHeader for FixedHeader {
    fn header(&self) -> Arc<Header> {
        self.0.clone()
    }
}

struct Connectors;

#[async_trait]
impl ConnectorPermissions for Connectors {
    fn needs_approval(&self, _: &str, _: &str) -> bool {
        false
    }
    fn disabled(&self, _: &str, _: &str) -> bool {
        false
    }
    fn project_disabled(&self, _: &ThreadId, _: &str) -> bool {
        false
    }
    async fn allow_always(&self, _: &str, _: &str) -> bool {
        false
    }
}

/// The two tools the scripts call: `github` is an outbound comment, `shell` is no outbound call.
struct Named {
    spec: ToolSpec,
    kind: Option<ActionKind>,
}

#[async_trait]
impl Tool for Named {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }
    fn outbound_kind(&self, _: &Value) -> Option<ActionKind> {
        self.kind
    }
    async fn call(&self, _: &ToolContext, _: Value) -> ToolOutcome {
        Ok(ToolOutput::default())
    }
}

struct Tools;

impl ToolResolver for Tools {
    fn resolve(&self, _: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
        let kind = match name {
            "github" => Some(ActionKind::Comment),
            "shell" | "read" => None,
            _ => return None,
        };
        let spec = ToolSpec {
            name: name.to_owned(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: String::new(),
            input_schema: json!({}),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Some(Arc::new(Named { spec, kind }))
    }
}

/// The PreToolUse hook: the decision the script's `ask` carries (`beforeToolHook`), none otherwise.
struct Hook(Arc<Mutex<Option<HookDecision>>>);

#[async_trait]
impl PreToolHook for Hook {
    async fn pre_tool(&self, _: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        Ok(self.0.lock().unwrap().clone())
    }
}

/// The approval card of the surface (the surface's tool approval hook): what the script's `ui` answers, `Unavailable` without one.
#[derive(Default)]
struct Card {
    answer: Mutex<Option<ApprovalResolution>>,
    asked: Mutex<Vec<ApprovalAsk>>,
    /// A card that waits for a client (the client turn's queue): the asks waiting, in order, each with the sender its answer comes through,
    /// and one permit per ask that arrived.
    waiting: Mutex<Vec<(ApprovalAsk, tokio::sync::oneshot::Sender<ApprovalResolution>)>>,
    arrived: Arrivals,
    waits: AtomicBool,
}

struct Arrivals(tokio::sync::Semaphore);

impl Default for Arrivals {
    fn default() -> Self {
        Self(tokio::sync::Semaphore::new(0))
    }
}

#[async_trait]
impl ApprovalGate for Card {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        if self.waits.load(Ordering::SeqCst) {
            let (answer, answered) = tokio::sync::oneshot::channel();
            self.asked.lock().unwrap().push(ask.clone());
            self.waiting.lock().unwrap().push((ask, answer));
            self.arrived.0.add_permits(1);
            return answered.await.unwrap_or(ApprovalResolution::Cancelled { at: 0 });
        }
        // A surface without a card has no approval hook: nothing is asked, the call is denied.
        let answer = self.answer.lock().unwrap().clone();
        if answer.is_some() {
            self.asked.lock().unwrap().push(ask);
        }
        answer.unwrap_or(ApprovalResolution::Unavailable { at: 0 })
    }
}

struct Surfaces(Arc<AtomicBool>);

impl ApprovalSurfaces for Surfaces {
    fn attached(&self, _: &ThreadId) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The production `ProcessHeldHome` for everything but the two seams the test replaces: the id (a counter) and
/// the delivery into the owner's home thread (recorded for the test to read).
struct RecordingHome {
    inner: Arc<ProcessHeldHome>,
    rows: Mutex<Vec<Value>>,
    ids: AtomicU64,
    /// How the scenario's home thread is slow: `all` and `pending` never persist the rows they name,
    /// `pending-until-release` persists a pending row once the script releases it.
    stall: Mutex<String>,
    /// One permit per delivery recorded: the test waits on the delivery.
    delivered: tokio::sync::Semaphore,
    /// The rows persisted, in the order their deliveries completed.
    persisted: Mutex<Vec<Value>>,
    /// Deliveries waiting for the script's `release`, and the permits that release them.
    waiting_release: std::sync::atomic::AtomicUsize,
    release: tokio::sync::Semaphore,
    /// One permit per released delivery that completed.
    completed: tokio::sync::Semaphore,
}

#[async_trait]
impl HeldHome for RecordingHome {
    async fn run_of(&self, thread: &ThreadId) -> Option<RunInfo> {
        self.inner.run_of(thread).await
    }
    fn ui_attached(&self, thread: &ThreadId) -> bool {
        self.inner.ui_attached(thread)
    }
    async fn deliver(&self, agent_id: &str, held: &HeldRequest) -> Result<(), String> {
        self.rows.lock().unwrap().push(json!({ "agentId": agent_id, "held": serde_json::to_value(held).map_err(|e| e.to_string())? }));
        self.delivered.add_permits(1);
        let stall = self.stall.lock().unwrap().clone();
        let pending = held.status == mixdog_protocol::HeldRequestStatus::Pending;
        let released = stall == "pending-until-release" && pending;
        if stall == "all" || (pending && stall == "pending") {
            std::future::pending::<()>().await;
        }
        if released {
            self.waiting_release.fetch_add(1, Ordering::SeqCst);
            self.release.acquire().await.unwrap().forget();
        }
        self.persisted
            .lock()
            .unwrap()
            .push(json!({ "agentId": agent_id, "id": held.id, "status": serde_json::to_value(held.status).map_err(|e| e.to_string())? }));
        if released {
            self.completed.add_permits(1);
        }
        Ok(())
    }
    fn push(&self, event: &HeldPush) {
        self.inner.push(event);
    }
    async fn agent_name(&self, agent_id: &str) -> Result<String, String> {
        self.inner.agent_name(agent_id).await
    }
    fn new_id(&self) -> String {
        format!("00000000-0000-4000-8000-{:012}", self.ids.fetch_add(1, Ordering::SeqCst) + 1)
    }
    fn grants(&self) -> Arc<dyn mixdog_tools::policy::GrantStore> {
        self.inner.grants()
    }
}

struct EmptyCatalog;

#[async_trait]
impl SessionCatalog for EmptyCatalog {
    async fn page(&self, _: usize, _: Option<&str>) -> Result<CatalogPage, String> {
        Ok(CatalogPage::default())
    }
    fn awaiting_approval(&self, _: &str) -> bool {
        false
    }
}

struct NoWatches;

#[async_trait]
impl TaskWatches for NoWatches {
    async fn task_session_ids(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

struct NoRoutines;

#[async_trait]
impl RoutineRecords for NoRoutines {
    async fn state(&self, _: RoutineKind, _: &str) -> Result<Option<RoutineState>, String> {
        Ok(None)
    }
    async fn list(&self, _: RoutineKind) -> Result<Vec<RoutineState>, String> {
        Ok(Vec::new())
    }
    async fn record_skip(&self, _: RoutineKind, _: &str, _: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
        Ok(())
    }
    async fn record_delivery(&self, _: RoutineKind, _: &str, _: &str, _: Option<Value>) -> Result<(), String> {
        Ok(())
    }
    async fn record_webhook_run(&self, _: &str, _: mixdog_services::webhooks::RunStamp, _: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
        Ok(())
    }
}

/// One scenario's world: a data directory, a virtual clock and the composition's pieces over them.
struct Scene {
    now: Arc<AtomicI64>,
    runs: Arc<UnattendedRunRegistry>,
    ui_attached: Arc<AtomicBool>,
    card: Arc<Card>,
    hook: Arc<Mutex<Option<HookDecision>>>,
    home: Arc<RecordingHome>,
    held: Arc<HeldRequests>,
    approvals: Arc<dyn RunApprovals>,
    policy: Arc<ToolPolicy>,
    waiting: mpsc::UnboundedReceiver<HeldPush>,
    _dir: tempfile::TempDir,
}

impl Scene {
    fn new(now: i64) -> Self {
        let ui_attached = Arc::new(AtomicBool::new(false));
        Self::over(now, ui_attached.clone(), Arc::new(Surfaces(ui_attached)))
    }

    /// The scene over `surfaces`: the answer of "is an approval UI attached to this thread" (`ui_attached` is only the script's flag for `Surfaces`).
    fn over(now: i64, ui_attached: Arc<AtomicBool>, surfaces: Arc<dyn ApprovalSurfaces>) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().expect("a data directory");
        let now = Arc::new(AtomicI64::new(now));
        let clock: Arc<dyn Fn() -> i64 + Send + Sync> = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let grants = FileGrantStore::with_clock(dir.path().join("human-gate"), tokens.interactive_io, tokens.durability_io, clock.clone());
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let (tx, waiting) = mpsc::unbounded_channel();
        let pushes = Arc::new(Mutex::new(Vec::new()));
        let notifier: crate::held_home_draft::HeldNotifier = {
            let pushes = pushes.clone();
            Arc::new(move |push: &HeldPush| {
                pushes.lock().unwrap().push(push.clone());
                let _ = tx.send(push.clone());
            })
        };
        let inner = ProcessHeldHome::new(runs.clone(), surfaces, tokens.interactive_io, dir.path().to_owned(), notifier, grants.clone());
        let home = Arc::new(RecordingHome {
            inner,
            rows: Mutex::new(Vec::new()),
            ids: AtomicU64::new(0),
            stall: Mutex::default(),
            delivered: tokio::sync::Semaphore::new(0),
            persisted: Mutex::default(),
            waiting_release: Default::default(),
            release: tokio::sync::Semaphore::new(0),
            completed: tokio::sync::Semaphore::new(0),
        });
        let held = HeldRequests::new(home.clone(), clock);
        let hook = Arc::new(Mutex::new(None));
        let policy = Arc::new(ToolPolicy::new(grants.clone(), Arc::new(Connectors)).with_hook(Arc::new(Hook(hook.clone()))));
        Self { now, runs, ui_attached, card: Arc::default(), hook, home, approvals: Arc::new(HeldGates(held.clone())), held, policy, waiting, _dir: dir }
    }

    /// The tool gate of one session over the scene's stand-in card.
    fn gate(&self, session: &str) -> Arc<PolicyGate> {
        self.kit().gate_over(session, self.card.clone())
    }

    fn kit(&self) -> GateKit {
        GateKit { runs: self.runs.clone(), policy: self.policy.clone(), approvals: self.approvals.clone() }
    }
}

/// What assembles a session's tool gate, shareable into a run's script.
#[derive(Clone)]
struct GateKit {
    runs: Arc<UnattendedRunRegistry>,
    policy: Arc<ToolPolicy>,
    approvals: Arc<dyn RunApprovals>,
}

impl GateKit {
    /// The tool gate of one session, as the assembly builds it: the session's own facts, the policy, and the approvals that went through
    /// `RunApprovals::gate_for` over `own`, the thread's own gate.
    fn gate_over(&self, session: &str, own: Arc<dyn ApprovalGate>) -> Arc<PolicyGate> {
        let thread = ThreadId::from(session);
        let header: Arc<Header> = Arc::new(Header::new());
        let (_tx, surface) = watch::channel(Arc::new(SessionSurface::default()));
        let session_gate = SessionGate::new(thread.clone(), Arc::new(FixedHeader(header)), surface, Arc::new(Env { runs: self.runs.clone() }));
        Arc::new(PolicyGate::new(PolicyGateParts {
            policy: self.policy.clone(),
            connectors: Arc::new(Connectors),
            session: Arc::new(session_gate),
            tools: Arc::new(Tools),
            grants: Arc::new(SessionGrants::default()),
            approvals: self.approvals.gate_for(&thread, own),
            observer: Arc::new(NullObserver),
            guards: Arc::new(NoGuards),
            thread_id: thread,
            cwd: std::path::PathBuf::from("work"),
            cancel: mixdog_rt::CancellationToken::new(),
        }))
    }
}

fn present(call: &GateCall, decision: GateDecision) -> Value {
    match decision {
        GateDecision::Deny(text) => json!({ "denial": text }),
        GateDecision::Allow => json!({ "allowed": true, "name": call.name, "args": call.args }),
        GateDecision::Rewrite(rewritten) => json!({ "allowed": true, "name": rewritten.name, "args": rewritten.args }),
        GateDecision::Ask(_) => panic!("the policy gate answers an approval itself"),
    }
}

/// A connection of the real app server over the mock core, as the transport would hand it in.
struct Client {
    handle: mixdog_app_server::ConnectionHandle,
    wire: Arc<mixdog_core_api::mock::MockConnection>,
    /// Every frame drained so far, so that a frame that arrived with a response is still there when it is looked for.
    seen: Mutex<Vec<String>>,
}

impl Client {
    fn new(handle: mixdog_app_server::ConnectionHandle, wire: Arc<mixdog_core_api::mock::MockConnection>) -> Self {
        Self { handle, wire, seen: Mutex::default() }
    }

    /// The `item/tool/requestApproval` frame this connection is sent, once it is.
    #[allow(dead_code, reason = "Shared wire fixture helper retained for approval scenarios; this test subset does not ask for that frame.")]
    async fn approval_request(&self) -> Value {
        // Picks the one wire frame the test waits for out of the connection's frames.
        let find = |texts: &[String]| {
            texts.iter().find_map(|text| {
                text.find('{').and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok()).filter(|frame| frame["method"] == "item/tool/requestApproval")
            })
        };
        if let Some(frame) = find(&self.seen.lock().unwrap()) {
            return frame;
        }
        let frames = self.wire.drain_text_until(|all| find(all).is_some()).await;
        let frame = find(&frames).expect("the approval request frame");
        self.seen.lock().unwrap().extend(frames);
        frame
    }

    /// The approval request among the frames seen so far, if one has arrived.
    fn approval_request_seen(&self) -> Option<Value> {
        let seen = self.seen.lock().unwrap();
        seen.iter().find_map(|text| {
            text.find('{').and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok()).filter(|frame| frame["method"] == "item/tool/requestApproval")
        })
    }

    fn request(&self, id: i64, method: &str, params: Value) {
        let message = serde_json::from_value(json!({ "id": id, "method": method, "params": params })).expect("a request");
        let _ = self.handle.on_message(message);
    }

    /// Waits until the response of request `id` is written; it must be a result.
    async fn response(&self, id: i64) {
        // Woken by each frame the connection receives; the frames are `control:<json>` or `<subscription>:<json>`.
        // Finds the frame answering request `id` among the connection's frames; other frames are not this request's response.
        let frame_of = |text: &String| text.find('{').and_then(|at| serde_json::from_str::<Value>(&text[at..]).ok()).filter(|frame| frame["id"] == json!(id));
        let frames = self.wire.drain_text_until(|all| all.iter().any(|text| frame_of(text).is_some())).await;
        let frame = frames.iter().find_map(frame_of).expect("the response frame");
        self.seen.lock().unwrap().extend(frames);
        assert!(frame.get("result").is_some(), "request {id} failed: {frame}");
    }
}

/// The session the bot `ann` speaks from in room `abcdef`: a room member's run, the one kind of run whose asks are held for a person
/// when no card is attached (a schedule or webhook run never asks, `pipeline.rs` `ask`).
const ROOM_MEMBER: &str = "sess_rmem_abcdef_ann";

/// Asks one `shell` call of the room member `session` whose hook says ask, with no card attached: the ask is held and pushed, and the
/// call waits. Returns the waiting call and the held request's id.
async fn hold(scene: &mut Scene, session: &str) -> (tokio::task::JoinHandle<Value>, String) {
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });
    scene.ui_attached.store(false, Ordering::SeqCst);
    let gate = scene.gate(session);
    let call = GateCall::new("shell".to_owned(), json!({ "command": "echo hi" }));
    let mut task = tokio::spawn(async move { present(&call, gate.check_call("call_1", &call).await) });
    let request_id = tokio::select! {
        settled = &mut task => panic!("the call settled without being held: {settled:?}"),
        push = scene.waiting.recv() => push.expect("a push").request_id,
    };
    scene.home.delivered.acquire().await.unwrap().forget();
    (task, request_id)
}

fn answer(approved: bool, reason: Option<&str>) -> HeldAnswer {
    HeldAnswer {
        approved,
        reason: reason.map(str::to_owned),
        device: "Pixel".to_owned(),
        connection_kind: None,
        response: None,
        edited_args: None,
        remember: None,
    }
}

#[tokio::test(start_paused = true)]
async fn a_room_members_run_nobody_can_show_a_card_for_is_held_however_long_it_waits_and_runs_once_approved() {
    let mut scene = Scene::new(1_800_000_000_000);
    let facts = |scene: &Scene| {
        let held = scene.held.clone();
        async move {
            FactSources { catalog: Arc::new(EmptyCatalog), watches: Arc::new(NoWatches), held, routines: Arc::new(NoRoutines) }
                .collect(0)
                .await
                .expect("the facts")
        }
    };
    let before = json!(facts(&scene).await.approvals);
    let (task, request_id) = hold(&mut scene, ROOM_MEMBER).await;
    assert_eq!(scene.held.pending().len(), 1);
    assert_ne!(json!(facts(&scene).await.approvals), before, "the heartbeat counts the held ask");
    assert!(scene.card.asked.lock().unwrap().is_empty(), "nothing was shown on a card");

    // No timer ends a held ask: a hundred years later it still waits.
    let hundred_years = 100 * 365 * 24 * 3600 * 1000_u64;
    scene.now.fetch_add(hundred_years as i64, Ordering::SeqCst);
    tokio::time::advance(Duration::from_millis(hundred_years)).await;
    assert!(!task.is_finished());
    assert_eq!(scene.held.pending().len(), 1);

    assert!(scene.held.resolve(&request_id, answer(true, None)).await, "the answer is accepted");
    let outcome = task.await.expect("the call settles");
    assert_eq!(outcome["allowed"], true, "{outcome}");
    assert!(scene.held.pending().is_empty());
    assert!(!scene.held.resolve(&request_id, answer(true, None)).await, "a request is answered once");
}

#[tokio::test(start_paused = true)]
async fn a_held_ask_that_is_denied_ends_its_call_with_the_denial() {
    let mut scene = Scene::new(1_800_000_000_000);
    let (task, request_id) = hold(&mut scene, ROOM_MEMBER).await;
    assert!(scene.held.resolve(&request_id, answer(false, Some("not now"))).await);
    let outcome = task.await.expect("the call settles");
    assert!(outcome["denial"].is_string(), "the call is denied: {outcome}");
    assert!(outcome.get("allowed").is_none());
}

#[tokio::test(start_paused = true)]
async fn a_run_with_an_attached_card_asks_the_card_and_is_not_held() {
    let scene = Scene::new(1_800_000_000_000);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });
    scene.ui_attached.store(true, Ordering::SeqCst);
    *scene.card.answer.lock().unwrap() = Some(ApprovalResolution::Decided {
        decision: ToolApprovalDecision {
            approved: true,
            reason: None,
            answers: None,
            reply: None,
            response: Some(HumanGateResponse::Approve),
            edited_args: None,
            remember: None,
            scope: None,
        },
        device: "Pixel".into(),
        connection_kind: ConnectionKind::Desktop,
        at: 0,
    });
    let gate = scene.gate(ROOM_MEMBER);
    let call = GateCall::new("shell".to_owned(), json!({ "command": "echo hi" }));
    let outcome = present(&call, gate.check_call("call_1", &call).await);
    assert_eq!(outcome["allowed"], true, "{outcome}");
    assert_eq!(scene.card.asked.lock().unwrap().len(), 1, "the card was asked");
    assert!(scene.held.pending().is_empty(), "nothing was held");
}
fn decided(approved: bool, reason: Option<&str>) -> ApprovalResolution {
    ApprovalResolution::Decided {
        decision: ToolApprovalDecision {
            approved,
            reason: reason.map(str::to_owned),
            answers: None,
            reply: None,
            response: Some(if approved { HumanGateResponse::Approve } else { HumanGateResponse::Deny }),
            edited_args: None,
            remember: None,
            scope: None,
        },
        device: "Pixel".into(),
        connection_kind: ConnectionKind::Desktop,
        at: 0,
    }
}

/// A client turn whose card waits for an answer: its gate over a card that holds each ask until the test answers it.
fn waiting_turn(session: &str) -> (Scene, Arc<PolicyGate>) {
    let scene = Scene::new(1_800_000_000_000);
    scene.card.waits.store(true, Ordering::SeqCst);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });
    scene.ui_attached.store(true, Ordering::SeqCst);
    let gate = scene.gate(session);
    (scene, gate)
}

fn ask_in_background(gate: &Arc<PolicyGate>, id: &'static str, path: &'static str) -> tokio::task::JoinHandle<Value> {
    let gate = gate.clone();
    tokio::spawn(async move {
        let call = GateCall::new("read".to_owned(), json!({ "path": path }));
        present(&call, gate.check_call(id, &call).await)
    })
}

#[tokio::test(start_paused = true)]
async fn the_cards_of_a_turn_are_shown_one_at_a_time_in_the_order_asked_and_each_call_settles_on_its_own_answer() {
    let (scene, gate) = waiting_turn("sess_cards");
    let first = ask_in_background(&gate, "call_a", "a.txt");
    scene.card.arrived.0.acquire().await.unwrap().forget();
    let second = ask_in_background(&gate, "call_b", "b.txt");
    scene.card.arrived.0.acquire().await.unwrap().forget();
    let args = |index: usize| scene.card.waiting.lock().unwrap()[index].0.payload["args"]["path"].clone();
    assert_eq!(scene.card.waiting.lock().unwrap().len(), 2, "the second card queues behind the first");
    assert_eq!((args(0), args(1)), (json!("a.txt"), json!("b.txt")), "in the order asked");

    let (_, answer) = scene.card.waiting.lock().unwrap().remove(0);
    answer.send(decided(true, None)).unwrap();
    assert_eq!(first.await.unwrap()["allowed"], true, "the first call is allowed by its own answer");
    assert!(!second.is_finished(), "the second call still waits for its card");
    assert_eq!(args(0), json!("b.txt"), "the card now shown is the second");

    let (_, answer) = scene.card.waiting.lock().unwrap().remove(0);
    answer.send(decided(false, Some("not this one"))).unwrap();
    let denied = second.await.unwrap();
    let text = denied["denial"].as_str().unwrap_or_else(|| panic!("the second call is denied: {denied}"));
    // A person's refusal is worded "was not approved: <their note>" (`pipeline.rs` `ask`); "denied" is a hook's wording.
    assert!(text.starts_with("Error: tool \"read\" was not approved: not this one"), "{text}");
}

#[tokio::test(start_paused = true)]
async fn a_card_without_an_opt_in_limit_never_expires_however_long_it_waits() {
    let (scene, gate) = waiting_turn("sess_forever");
    let call = ask_in_background(&gate, "call_a", "a.txt");
    scene.card.arrived.0.acquire().await.unwrap().forget();
    assert_eq!(scene.card.waiting.lock().unwrap()[0].0.expires_after, None, "the card carries no limit");
    scene.now.fetch_add(3_153_600_000_000, Ordering::SeqCst);
    tokio::time::advance(Duration::from_millis(3_153_600_000_000)).await;
    assert!(!call.is_finished(), "a hundred years later the call still waits");
    assert_eq!(scene.card.waiting.lock().unwrap().len(), 1, "and its card is still the one shown");
    let (_, answer) = scene.card.waiting.lock().unwrap().remove(0);
    answer.send(decided(true, None)).unwrap();
    assert_eq!(call.await.unwrap()["allowed"], true);
}
// ---- the real path: the thread's own gate (`RunPort` over the session actor), the app server's connections and the real directory ----

struct RealCore {
    mock: Arc<mixdog_core_api::mock::MockCore>,
    directory: Arc<mixdog_core_session::session::SessionDirectory>,
}

/// The core of the composition for what this test reads: the real session directory behind `threads()`, the mock for the rest.
impl mixdog_core_api::CoreHandle for RealCore {
    fn threads(&self) -> &dyn mixdog_core_api::ThreadDirectory {
        &*self.directory
    }
    fn app_feed(&self) -> Arc<dyn mixdog_core_api::FeedSource> {
        self.mock.app_feed()
    }
    fn scoped_feed(&self, id: &mixdog_core_api::ids::FeedId) -> Option<Arc<dyn mixdog_core_api::FeedSource>> {
        self.mock.scoped_feed(id)
    }
    fn ops(&self) -> &dyn mixdog_core_api::OpIndex {
        self.mock.ops()
    }
    fn domain_for(&self, method: &str) -> Option<&dyn mixdog_core_api::DomainService> {
        self.mock.domain_for(method)
    }
    fn host_media(&self) -> &dyn mixdog_core_api::HostMediaSink {
        self.mock.host_media()
    }
    fn lifecycle(&self) -> watch::Receiver<mixdog_core_api::CoreState> {
        self.mock.lifecycle()
    }
    fn connection_closed(&self, connection: mixdog_core_api::ids::ConnectionId) {
        self.mock.connection_closed(connection);
    }
    fn connection_opened(&self, connection: mixdog_core_api::ids::ConnectionId, origin: mixdog_protocol::Origin, device: &str, kind: ConnectionKind) {
        self.mock.connection_opened(connection, origin, device, kind);
    }
    fn request_started(&self, method: &str, params: &serde_json::Value) -> mixdog_core_api::handle::RequestGuard {
        self.mock.request_started(method, params)
    }
}

/// The session's clock, following the script's virtual clock.
struct VirtualClock(Arc<std::sync::atomic::AtomicI64>);

impl mixdog_core_session::session::Clock for VirtualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The server-request sink the session actor publishes into: the app server's `Outgoing`, counting what the actor published.
struct Published {
    outgoing: Arc<mixdog_app_server::Outgoing>,
    arrived: tokio::sync::Semaphore,
    frames: Mutex<Vec<Value>>,
    /// The `serverRequest/resolved` frames the actor published: the resolution it actually produced.
    resolved_frames: Mutex<Vec<Value>>,
    resolved_arrived: tokio::sync::Semaphore,
}

impl mixdog_core_api::ServerRequestSink for Published {
    fn publish(&self, req: mixdog_core_api::server_request::PendingServerRequest) {
        self.frames.lock().unwrap().push(serde_json::from_slice(&req.frame).expect("a frame"));
        self.outgoing.publish(req);
        self.arrived.add_permits(1);
    }
    fn resolved(&self, id: &mixdog_core_api::ids::ServerRequestId, frame: bytes::Bytes) {
        self.resolved_frames.lock().unwrap().push(serde_json::from_slice(&frame).expect("a frame"));
        self.resolved_arrived.add_permits(1);
        self.outgoing.resolved(id, frame);
    }
    fn response_rejected(&self, to: mixdog_core_api::ids::ConnectionId, error: mixdog_core_api::CoreError) {
        self.outgoing.response_rejected(to, error);
    }
}

async fn connect(server: &mixdog_app_server::AppServer, id: u64, thread: &str) -> Client {
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockLimits;

    let wire = Arc::new(MockConnection::new(mixdog_core_api::ids::ConnectionId(id), MockLimits::default()));
    let client = Client::new(server.open(mixdog_core_api::ids::ConnectionId(id), wire.clone()), wire);
    client.request(
        0,
        "initialize",
        json!({ "clientInfo": { "name": "Pixel", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": { "approvalsInbox": false } }),
    );
    client.response(0).await;
    client.request(1, "thread/resume", json!({ "threadId": thread, "window": { "lastItems": 10 } }));
    client.response(1).await;
    client
}

/// A client turn whose clients leave, on the real path: the gate of the turn is the thread's own, a `RunPort` that sends its ask to the
/// session actor, which publishes it to the app server's connections; the clients are real connections of the real server, dropped as a
/// transport drops them, and the answer is the client's response frame routed by the server to the actor. The card stays pending across
/// a hundred years, is sent again to the client that returns, and the answer settles the call.
#[tokio::test(start_paused = true)]
async fn a_card_pending_on_the_real_thread_gate_survives_its_clients() {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::mock::MockCore;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_session::session::RunOutcome;
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::approval_surfaces::ThreadApprovalSurfaces;
    use mixdog_core_session::session::testing::Rig;

    let now = 1_800_000_000_000_i64;
    let member = "sess_member".to_owned();
    let outgoing = mixdog_app_server::Outgoing::new();
    let rig = Rig::new();
    let published = Arc::new(Published {
        outgoing: outgoing.clone(),
        arrived: tokio::sync::Semaphore::new(0),
        frames: Mutex::default(),
        resolved_frames: Mutex::default(),
        resolved_arrived: tokio::sync::Semaphore::new(0),
    });
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.server_requests = published.clone();
    // Who answered is the composition's own device layer over the registry the transport fills, and the resolution's time is read
    // from the test's virtual clock.
    let registry = Arc::new(mixdog_remote::registry::DeviceRegistry::default());
    parts.devices = Arc::new(mixdog_core_base::approvals::devices::RegistryDevices::new(registry.clone()));
    let virtual_now = Arc::new(std::sync::atomic::AtomicI64::new(now));
    parts.clock = Arc::new(VirtualClock(virtual_now.clone()));
    let directory = Arc::new(SessionDirectory::new(Arc::new(parts)));
    let core = Arc::new(RealCore { mock: Arc::new(MockCore::new(&[], MockLimits::default())), directory: directory.clone() });
    let server = mixdog_app_server::AppServer::new(
        core,
        outgoing.clone(),
        Arc::new(|_| Some(mixdog_protocol::Origin::Local)),
        crate::server::server_config(mixdog_app_protocol::limits::Limits::default(), Default::default()),
    )
    .expect("the default limits are valid");
    let surfaces = Arc::new(ThreadApprovalSurfaces::new(directory.clone(), outgoing.clone()));
    let scene = Scene::over(now, Arc::new(AtomicBool::new(false)), surfaces);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });

    // The turn: its gate is assembled when the run starts, over the run's own port, and then serves the calls the test sends it.
    let kit = scene.kit();
    let (calls, wanted) = mpsc::unbounded_channel::<(String, GateCall)>();
    let (settled, mut results) = mpsc::unbounded_channel::<Value>();
    let (ready, mut started) = mpsc::unbounded_channel::<()>();
    let wanted = Arc::new(Mutex::new(Some(wanted)));
    rig.set_script(Arc::new(move |run| {
        let (kit, wanted, settled, ready) = (kit.clone(), wanted.clone(), settled.clone(), ready.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let gate = kit.gate_over(run.thread.as_str(), Arc::new(run.port.clone()));
            let mut wanted = wanted.lock().unwrap().take().expect("one run");
            ready.send(()).expect("the test waits");
            while let Some((id, call)) = wanted.recv().await {
                let outcome = present(&call, gate.check_call(&id, &call).await);
                settled.send(outcome).expect("the test waits");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    directory.create_with_id(ThreadId::from(member.as_str()), serde_json::Map::new(), json!({})).await.expect("the thread");

    // A client starts the turn, then the model asks for a tool that needs approval.
    let client = connect(&server, 1, &member).await;
    let handle = directory.handle(&ThreadId::from(member.as_str())).expect("loaded");
    use mixdog_core_api::ThreadHandle;
    handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": member, "opId": "op-1", "input": { "prompt": "go" } }),
            op: Some(OpId::from("op-1")),
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("turn/start");
    started.recv().await.expect("the run started");
    calls.send(("call_1".to_owned(), GateCall::new("shell".to_owned(), json!({ "command": "echo hi" })))).expect("the run waits");
    published.arrived.acquire().await.expect("the card").forget();
    let shown = published.frames.lock().unwrap().last().cloned().expect("the published card");
    assert_eq!(shown["method"], "item/tool/requestApproval");
    assert_eq!(shown["params"]["name"], "shell");

    // Every client leaves, a hundred years pass: the card is still pending and the call still waits.
    drop(client);
    let hundred_years = 100 * 365 * 24 * 3600 * 1000_u64;
    scene.now.fetch_add(hundred_years as i64, Ordering::SeqCst);
    virtual_now.fetch_add(hundred_years as i64, Ordering::SeqCst);
    tokio::time::advance(Duration::from_millis(hundred_years)).await;
    assert!(results.try_recv().is_err(), "the call still waits for its answer");

    // A phone paired as "Pixel" returns: it is sent the very pending request, and answers it over the wire.
    registry.connect_relay(2, "peer-pixel");
    registry.attach_peer("peer-pixel", "cred-pixel", "Pixel", "Safari");
    let client = connect(&server, 2, &member).await;
    client.request(2, "thread/resume", json!({ "threadId": member, "window": { "lastItems": 10 } }));
    client.response(2).await;
    let frame = client.approval_request_seen().expect("the returning client is sent the pending card");
    assert_eq!(frame, shown, "the redelivered request is the one published");
    client.handle.on_message(
        serde_json::from_value(json!({ "id": frame["id"], "result": { "approved": true, "response": "approve", "reason": null } })).expect("a response"),
    );
    let outcome = results.recv().await.expect("the call settles");
    assert_eq!(outcome["allowed"], true, "{outcome}");
    mixdog_rt::time::timeout(Duration::from_secs(1), published.resolved_arrived.acquire())
        .await
        .expect("the actor published the resolution")
        .expect("the sink")
        .forget();
    let resolution = published.resolved_frames.lock().unwrap().last().cloned().expect("a resolved frame")["params"]["resolution"].clone();
    assert_eq!(resolution["kind"], "decided");
    assert_eq!(resolution["decision"]["approved"], true);
    assert_eq!(resolution["device"], "Pixel", "who answered is the paired device");
    drop(calls);
}

/// The real path of a client turn, up to its card: a client connected and shown the card of a `shell` call that needs approval.
struct RealTurn {
    server: mixdog_app_server::AppServer,
    published: Arc<Published>,
    results: mpsc::UnboundedReceiver<Value>,
    virtual_now: Arc<std::sync::atomic::AtomicI64>,
    member: String,
    shown: Value,
    client: Client,
    // Held so the run's gate and the card's surface outlive the test body.
    _keep: (Scene, mpsc::UnboundedSender<(String, GateCall)>, Arc<mixdog_core_session::session::SessionDirectory>),
}

async fn real_turn_with_card(now: i64) -> RealTurn {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::ids::OpId;
    use mixdog_core_api::mock::MockCore;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_session::session::RunOutcome;
    use mixdog_core_session::session::SessionDirectory;
    use mixdog_core_session::session::approval_surfaces::ThreadApprovalSurfaces;
    use mixdog_core_session::session::testing::Rig;

    let member = "sess_member".to_owned();
    let outgoing = mixdog_app_server::Outgoing::new();
    let rig = Rig::new();
    let published = Arc::new(Published {
        outgoing: outgoing.clone(),
        arrived: tokio::sync::Semaphore::new(0),
        frames: Mutex::default(),
        resolved_frames: Mutex::default(),
        resolved_arrived: tokio::sync::Semaphore::new(0),
    });
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.server_requests = published.clone();
    let registry = Arc::new(mixdog_remote::registry::DeviceRegistry::default());
    registry.connect_relay(1, "peer-pixel");
    registry.attach_peer("peer-pixel", "cred-pixel", "Pixel", "Safari");
    parts.devices = Arc::new(mixdog_core_base::approvals::devices::RegistryDevices::new(registry));
    let virtual_now = Arc::new(std::sync::atomic::AtomicI64::new(now));
    parts.clock = Arc::new(VirtualClock(virtual_now.clone()));
    let directory = Arc::new(SessionDirectory::new(Arc::new(parts)));
    let core = Arc::new(RealCore { mock: Arc::new(MockCore::new(&[], MockLimits::default())), directory: directory.clone() });
    let server = mixdog_app_server::AppServer::new(
        core,
        outgoing.clone(),
        Arc::new(|_| Some(mixdog_protocol::Origin::Local)),
        crate::server::server_config(mixdog_app_protocol::limits::Limits::default(), Default::default()),
    )
    .expect("the default limits are valid");
    let surfaces = Arc::new(ThreadApprovalSurfaces::new(directory.clone(), outgoing));
    let scene = Scene::over(now, Arc::new(AtomicBool::new(false)), surfaces);
    *scene.hook.lock().unwrap() = Some(HookDecision { action: HookAction::Ask, reason: Some("needs approval".into()), name: None, args: None });
    let kit = scene.kit();
    let (calls, wanted) = mpsc::unbounded_channel::<(String, GateCall)>();
    let (settled, results) = mpsc::unbounded_channel::<Value>();
    let (ready, mut started) = mpsc::unbounded_channel::<()>();
    let wanted = Arc::new(Mutex::new(Some(wanted)));
    rig.set_script(Arc::new(move |run| {
        let (kit, wanted, settled, ready) = (kit.clone(), wanted.clone(), settled.clone(), ready.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let gate = kit.gate_over(run.thread.as_str(), Arc::new(run.port.clone()));
            let mut wanted = wanted.lock().unwrap().take().expect("one run");
            ready.send(()).expect("the test waits");
            while let Some((id, call)) = wanted.recv().await {
                let outcome = present(&call, gate.check_call(&id, &call).await);
                settled.send(outcome).expect("the test waits");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    directory.create_with_id(ThreadId::from(member.as_str()), serde_json::Map::new(), json!({})).await.expect("the thread");
    let client = connect(&server, 1, &member).await;
    let handle = directory.handle(&ThreadId::from(member.as_str())).expect("loaded");
    handle
        .request(CoreRequest {
            method: Method("turn/start"),
            params: json!({ "threadId": member, "opId": "op-1", "input": { "prompt": "go" } }),
            op: Some(OpId::from("op-1")),
            ctx: CallContext::internal("test"),
        })
        .await
        .expect("turn/start");
    started.recv().await.expect("the run started");
    calls.send(("call_1".to_owned(), GateCall::new("shell".to_owned(), json!({ "command": "echo hi" })))).expect("the run waits");
    published.arrived.acquire().await.expect("the card").forget();
    let shown = published.frames.lock().unwrap().last().cloned().expect("the published card");
    RealTurn { server, published, results, virtual_now, member, shown, client, _keep: (scene, calls, directory) }
}

impl RealTurn {
    async fn pass(&self, ms: u64) {
        self.virtual_now.fetch_add(ms as i64, Ordering::SeqCst);
        tokio::time::advance(Duration::from_millis(ms)).await;
    }
}

/// The opt-in limit is read once per process, so these two tests set it before the core is built; each test is a process of its own
/// under nextest.
fn opt_in_limit_of_ten_minutes() {
    // SAFETY: set before any thread of the test reads the environment for it; the test process is single-test.
    unsafe { std::env::set_var("MIXDOG_TOOL_APPROVAL_TIMEOUT_MS", "600000") };
}

#[tokio::test(start_paused = true)]
async fn with_the_opt_in_limit_a_card_nobody_answers_expires_at_the_limit_and_the_model_is_told_it_was_not_approved() {
    opt_in_limit_of_ten_minutes();
    let now = 1_800_000_000_000_i64;
    let mut turn = real_turn_with_card(now).await;
    let params = &turn.shown["params"];
    assert_eq!(
        params["expiresAt"].as_i64().unwrap() - params["requestedAt"].as_i64().unwrap(),
        600_000,
        "the card names its deadline: the limit after it was asked"
    );

    drop(turn.client);
    turn.client = connect(&turn.server, 3, &turn.member).await;
    turn.pass(599_999).await;
    assert!(turn.results.try_recv().is_err(), "a millisecond before the limit the call still waits");
    assert!(turn.published.resolved_frames.lock().unwrap().is_empty(), "and nothing is resolved");

    turn.pass(1).await;
    let outcome = turn.results.recv().await.expect("the call settles at the limit");
    let told = outcome["denial"].as_str().unwrap_or_else(|| panic!("the call is denied: {outcome}"));
    assert!(told.contains("tool \"shell\" was not approved: approval timed out"), "{told}");
    mixdog_rt::time::timeout(Duration::from_secs(1), turn.published.resolved_arrived.acquire())
        .await
        .expect("the actor published the resolution")
        .expect("the sink")
        .forget();
    let resolution = turn.published.resolved_frames.lock().unwrap().last().cloned().unwrap()["params"]["resolution"].clone();
    assert_eq!(resolution["kind"], "timedOut", "clients are told the card timed out, not that someone denied it");
    assert_eq!(resolution["at"].as_i64(), Some(now + 600_000), "at the moment of the limit");
}

#[tokio::test(start_paused = true)]
async fn with_the_opt_in_limit_an_answer_before_it_settles_the_call_and_the_limit_passing_later_changes_nothing() {
    opt_in_limit_of_ten_minutes();
    let now = 1_800_000_000_000_i64;
    let mut turn = real_turn_with_card(now).await;
    turn.pass(599_999).await;
    turn.client.handle.on_message(
        serde_json::from_value(json!({ "id": turn.shown["id"], "result": { "approved": true, "response": "approve", "reason": null } })).expect("a response"),
    );
    let outcome = turn.results.recv().await.expect("the call settles");
    assert_eq!(outcome["allowed"], true, "{outcome}");
    mixdog_rt::time::timeout(Duration::from_secs(1), turn.published.resolved_arrived.acquire())
        .await
        .expect("the actor published the resolution")
        .expect("the sink")
        .forget();
    turn.pass(10).await;
    let frames = turn.published.resolved_frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1, "no second resolution at the limit: {frames:?}");
    assert_eq!(frames[0]["params"]["resolution"]["kind"], "decided");
    assert_eq!(frames[0]["params"]["resolution"]["at"].as_i64(), Some(now + 599_999));
}
