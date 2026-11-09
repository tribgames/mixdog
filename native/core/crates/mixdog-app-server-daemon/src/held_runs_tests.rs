//! The composed approval gate against the Node recording `fixtures/held-runs` (`record-held-runs.mjs`, `b6f10295a`, exact manifest).
//!
//! Node drove its tool-call gate (`applyBeforeToolHook`) for a room member, a schedule run, a webhook run and an ordinary session, with
//! and without an approval UI, answering held requests through `resolveHeldRequest` and reading Mixy's heartbeat facts, and wrote the
//! script it ran and everything it produced: the rows posted to the owner's home thread, the pushes, the UI asks, the outcome of each
//! call, the heartbeat facts, the audit file and the grants file. This replays each script against the composition's own pieces: the real
//! policy gate (`PolicyGate` over `ToolPolicy`, the file grant store), the real `SessionGate` over the process's unattended-run registry,
//! the production `ProcessHeldHome`, `HeldRequests` behind the `HeldGates` that `compose_flip` hands the turn path, and the heartbeat's
//! own `FactSources`. Only the surface's approval card (the thread's own gate, answered by the script's `ui`) and the home-thread
//! delivery (recorded, as Node's was) are stand-ins. The whole trace of each scenario must equal Node's.

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
use mixdog_protocol::ApprovalRemember;
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
use mixdog_services::bots::beat::digest::Entry;
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

/// The recorded scenarios. The golden is read as the recorder wrote it, never edited.
const GOLDEN: &str = include_str!("../../../fixtures/held-runs/golden.json");

struct NoStamps;

#[async_trait]
impl RunStamps for NoStamps {
    async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
        None
    }
}

/// `GateEnv` over the process's unattended-run registry; `ann` is the one contact bot (the recorder wrote her `AGENT.md` with `kind: bot`).
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
            "shell" => None,
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

/// The approval card of the surface (Node's `toolApprovalHook`): what the script's `ui` answers, `Unavailable` without one.
#[derive(Default)]
struct Card {
    answer: Mutex<Option<ApprovalResolution>>,
    asked: Mutex<Vec<ApprovalAsk>>,
}

#[async_trait]
impl ApprovalGate for Card {
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        self.asked.lock().unwrap().push(ask);
        self.answer.lock().unwrap().clone().unwrap_or(ApprovalResolution::Unavailable { at: 0 })
    }
}

struct Surfaces(Arc<AtomicBool>);

impl ApprovalSurfaces for Surfaces {
    fn attached(&self, _: &ThreadId) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// The production `ProcessHeldHome` for everything but the two seams the recording replaces: the id (Node's seeded `randomUUID`) and
/// the delivery into the owner's home thread (recorded, as the recorder's loader hook did).
struct RecordingHome {
    inner: Arc<ProcessHeldHome>,
    rows: Mutex<Vec<Value>>,
    ids: AtomicU64,
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

fn entry_json(entry: &Entry) -> Value {
    let mut out = json!({ "id": entry.id, "bot": entry.bot, "title": entry.title, "preview": entry.preview });
    if entry.room {
        out["room"] = Value::Bool(true);
    }
    out
}

/// One scenario's world: a data directory, a virtual clock and the composition's pieces over them.
struct Scene {
    now: Arc<AtomicI64>,
    grants: Arc<FileGrantStore>,
    runs: Arc<UnattendedRunRegistry>,
    ui_attached: Arc<AtomicBool>,
    card: Arc<Card>,
    hook: Arc<Mutex<Option<HookDecision>>>,
    home: Arc<RecordingHome>,
    held: Arc<HeldRequests>,
    approvals: Arc<dyn RunApprovals>,
    policy: Arc<ToolPolicy>,
    pushes: Arc<Mutex<Vec<HeldPush>>>,
    waiting: mpsc::UnboundedReceiver<HeldPush>,
    _dir: tempfile::TempDir,
}

impl Scene {
    fn new(now: i64) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().expect("a data directory");
        let now = Arc::new(AtomicI64::new(now));
        let clock: Arc<dyn Fn() -> i64 + Send + Sync> = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst))
        };
        let grants = FileGrantStore::with_clock(dir.path().join("human-gate"), tokens.interactive_io, tokens.durability_io, clock.clone());
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let ui_attached = Arc::new(AtomicBool::new(false));
        let (tx, waiting) = mpsc::unbounded_channel();
        let pushes = Arc::new(Mutex::new(Vec::new()));
        let notifier: crate::held_home_draft::HeldNotifier = {
            let pushes = pushes.clone();
            Arc::new(move |push: &HeldPush| {
                pushes.lock().unwrap().push(push.clone());
                let _ = tx.send(push.clone());
            })
        };
        let inner = ProcessHeldHome::new(runs.clone(), Arc::new(Surfaces(ui_attached.clone())), tokens.interactive_io, dir.path().to_owned(), notifier, grants.clone());
        let home = Arc::new(RecordingHome { inner, rows: Mutex::new(Vec::new()), ids: AtomicU64::new(0) });
        let held = HeldRequests::new(home.clone(), clock);
        let hook = Arc::new(Mutex::new(None));
        let policy = Arc::new(ToolPolicy::new(grants.clone(), Arc::new(Connectors)).with_hook(Arc::new(Hook(hook.clone()))));
        Self { now, grants, runs, ui_attached, card: Arc::default(), hook, home, approvals: Arc::new(HeldGates(held.clone())), held, policy, pushes, waiting, _dir: dir }
    }

    /// The tool gate of one session, as the assembly builds it: the session's own facts, the policy, and the approvals that went through `RunApprovals::gate_for`.
    fn gate(&self, session: &str) -> Arc<PolicyGate> {
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
            approvals: self.approvals.gate_for(&thread, self.card.clone()),
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

fn parse<T: serde::de::DeserializeOwned>(value: Option<&Value>) -> Option<T> {
    value.filter(|v| !v.is_null()).map(|v| serde_json::from_value(v.clone()).expect("a recorded name"))
}

fn push_json(push: &HeldPush) -> Value {
    json!({ "sessionId": push.session_id, "agentId": push.agent_id, "agentName": push.agent_name, "requestId": push.request_id })
}

/// What the scenario produced since the last step: the rows posted, the pushes, the asks the card saw.
struct Seen {
    rows: usize,
    pushes: usize,
    asks: usize,
}

impl Seen {
    fn take(&mut self, scene: &Scene) -> Value {
        let rows = scene.home.rows.lock().unwrap();
        let pushes = scene.pushes.lock().unwrap();
        let asked = scene.card.asked.lock().unwrap();
        let ui: Vec<Value> = asked
            .iter()
            .skip(self.asks)
            .map(|ask| {
                let field = |name: &str| ask.payload.get(name).cloned().unwrap_or(Value::Null);
                json!({ "name": field("name"), "kind": field("kind"), "reason": field("reason"), "remember": field("remember") })
            })
            .collect();
        let out = json!({
            "deliveries": rows[self.rows..],
            "pushes": pushes[self.pushes..].iter().map(push_json).collect::<Vec<_>>(),
            "uiAsks": ui,
        });
        (self.rows, self.pushes, self.asks) = (rows.len(), pushes.len(), asked.len());
        out
    }
}

fn merged(mut step: Value, seen: Value) -> Value {
    step.as_object_mut().unwrap().extend(seen.as_object().unwrap().clone());
    step
}

async fn replay(scenario: &Value) -> Value {
    let mut scene = Scene::new(scenario["now"].as_i64().expect("now"));
    let sessions = serde_json::from_str::<Value>(GOLDEN).unwrap()["sessions"].clone();
    let session_of = |name: &Value| sessions[name.as_str().unwrap()].as_str().expect("a recorded session").to_owned();
    let mut seen = Seen { rows: 0, pushes: 0, asks: 0 };
    let mut marks = Vec::new();
    let mut asks: std::collections::HashMap<String, (tokio::task::JoinHandle<Value>, String)> = std::collections::HashMap::new();
    let mut trace = Vec::new();

    for op in scenario["script"].as_array().unwrap() {
        match op["op"].as_str().unwrap() {
            "mark" => {
                let kind = if op["kind"] == "webhook" { mixdog_tools::policy::RunKind::Webhook } else { mixdog_tools::policy::RunKind::Schedule };
                let session = session_of(&op["session"]);
                marks.push(scene.runs.mark(&session, kind, op["agentId"].as_str().unwrap(), op["name"].as_str().unwrap()));
                trace.push(json!({ "op": "mark", "session": session }));
            }
            "ask" => {
                let session = session_of(&op["session"]);
                let (name, args) = (op["call"]["name"].as_str().unwrap().to_owned(), op["call"]["args"].clone());
                *scene.hook.lock().unwrap() = (!op["hook"].is_null()).then(|| HookDecision {
                    action: HookAction::Ask,
                    reason: op["hook"]["reason"].as_str().map(str::to_owned),
                    name: None,
                    args: None,
                });
                let ui = &op["ui"];
                scene.ui_attached.store(!ui.is_null(), Ordering::SeqCst);
                *scene.card.answer.lock().unwrap() = (!ui.is_null()).then(|| ApprovalResolution::Decided {
                    decision: ToolApprovalDecision {
                        approved: ui["approved"].as_bool().unwrap(),
                        reason: None,
                        answers: None,
                        reply: None,
                        response: parse(ui.get("response")),
                        edited_args: None,
                        remember: parse(ui.get("remember")),
                        scope: None,
                    },
                    device: ui["device"].as_str().unwrap_or_default().to_owned(),
                    connection_kind: ConnectionKind::Desktop,
                    at: scene.now.load(Ordering::SeqCst),
                });
                let gate = scene.gate(&session);
                let call = GateCall::new(name, args);
                let id = op["id"].as_str().unwrap().to_owned();
                let mut task = tokio::spawn({
                    let call_id = format!("call_{id}");
                    async move {
                        let decision = gate.check_call(&call_id, &call).await;
                        present(&call, decision)
                    }
                });
                // Held when the push comes before the call settles, as the recorder decided.
                let mut step = json!({ "op": "ask", "id": id, "session": session });
                let first = tokio::select! {
                    settled = &mut task => Err(settled.expect("the call settles")),
                    push = scene.waiting.recv() => Ok(push.expect("a push").request_id),
                };
                match first {
                    Err(outcome) => {
                        step["state"] = "settled".into();
                        step["outcome"] = outcome;
                    }
                    Ok(request_id) => {
                        step["state"] = "held".into();
                        asks.insert(id, (task, request_id));
                    }
                }
                let seen_now = seen.take(&scene);
                trace.push(merged(step, seen_now));
            }
            "facts" => {
                let facts = FactSources { catalog: Arc::new(EmptyCatalog), watches: Arc::new(NoWatches), held: scene.held.clone(), routines: Arc::new(NoRoutines) }
                    .collect(0)
                    .await
                    .expect("the facts");
                trace.push(json!({
                    "op": "facts",
                    "facts": {
                        "sessions": facts.sessions.iter().map(entry_json).collect::<Vec<_>>(),
                        "tasks": facts.tasks.iter().map(entry_json).collect::<Vec<_>>(),
                        "approvals": facts.approvals,
                        "routines": facts.routines.iter().map(|r| json!({ "kind": r.kind.word(), "name": r.name, "enabled": r.enabled, "failures": r.failures })).collect::<Vec<_>>(),
                    },
                }));
            }
            "answer" => {
                let id = op["ask"].as_str().unwrap();
                let (task, request_id) = asks.remove(id).expect("a held ask");
                let decision = &op["decision"];
                let answer = HeldAnswer {
                    approved: decision["approved"].as_bool().unwrap(),
                    reason: decision["reason"].as_str().map(str::to_owned),
                    device: decision["device"].as_str().unwrap_or_default().to_owned(),
                    connection_kind: None,
                    response: parse::<HumanGateResponse>(decision.get("response")),
                    edited_args: None,
                    remember: parse::<ApprovalRemember>(decision.get("remember")),
                };
                let accepted = scene.held.resolve(&request_id, answer).await;
                let outcome = task.await.expect("the call settles");
                let step = json!({ "op": "answer", "ask": id, "requestId": request_id, "accepted": accepted, "outcome": outcome });
                let seen_now = seen.take(&scene);
                trace.push(merged(step, seen_now));
            }
            "advance" => {
                let ms = op["ms"].as_u64().unwrap();
                scene.now.fetch_add(ms as i64, Ordering::SeqCst);
                // Paused time: a timer that expires a held request would fire here.
                tokio::time::advance(Duration::from_millis(ms)).await;
                tokio::task::yield_now().await;
                // What the elapsed time settled: a held call that an expiry timer had answered.
                let fired = asks.values().filter(|(task, _)| task.is_finished()).count();
                trace.push(json!({ "op": "advance", "ms": ms, "now": scene.now.load(Ordering::SeqCst), "fired": fired }));
            }
            other => panic!("unknown op {other}"),
        }
    }
    drop(marks);
    let audit: Vec<Value> = scene
        .grants
        .read_audit(None, usize::MAX)
        .await
        .expect("the audit")
        .into_iter()
        .rev()
        .map(|a| {
            json!({ "at": a.at_ms, "agentId": a.agent_id, "kind": a.kind, "action": a.action, "tool": a.tool, "target": a.target, "decision": a.decision, "device": a.device })
        })
        .collect();
    let grants: Vec<Value> = scene
        .grants
        .list_grants(None)
        .await
        .expect("the grants")
        .into_iter()
        .map(|g| json!({ "id": g.id, "agentId": g.agent_id, "action": g.action.render(), "mode": g.mode.as_str(), "device": g.device, "at": g.at_ms }))
        .collect();
    json!({ "trace": trace, "audit": audit, "grants": grants })
}

#[tokio::test(start_paused = true)]
async fn every_run_node_holds_is_held_and_every_run_it_does_not_hold_is_not() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
    let scenarios = golden["scenarios"].as_array().expect("scenarios");
    assert_eq!(scenarios.len(), 10, "the recorded scenario list");
    for scenario in scenarios {
        assert_eq!(scenario["timers"]["registered"], 0, "Node's gate registered no timer: {}", scenario["name"]);
        let got = replay(scenario).await;
        let want = json!({ "trace": scenario["trace"], "audit": scenario["audit"], "grants": scenario["grants"] });
        for part in ["audit", "grants"] {
            assert_eq!(got[part], want[part], "{} {part}", scenario["name"]);
        }
        let (got_trace, want_trace) = (got["trace"].as_array().unwrap(), want["trace"].as_array().unwrap());
        for (index, (g, w)) in got_trace.iter().zip(want_trace).enumerate() {
            assert_eq!(g, w, "{} step {index}", scenario["name"]);
        }
        assert_eq!(got_trace.len(), want_trace.len(), "{}", scenario["name"]);
    }
}
