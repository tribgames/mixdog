//! The spawn and send flows against the goldens recorded from Node
//! (`fixtures/agent/record-flows.mjs`, `flows/spawn.json`, `flows/send.json`): the same scripted
//! world, the same effect calls in the same order, the same job at the end. Fixture loading reads
//! files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::error_text::PlainErrorText;
use mixdog_agent::agent_tool::{AgentParts, assemble};
use mixdog_agent::agent_tool::flow::job_starter::JobStarter;
use mixdog_agent::agent_tool::flow::send::SendFlowImpl;
use mixdog_agent::agent_tool::flow::seams::*;
use mixdog_agent::agent_tool::flow::spawn::SpawnFlowImpl;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_agent::agent_tool::flow::worker_turns::Claim;
use mixdog_agent::agent_tool::flow::worker_turns::TurnOwner;
use mixdog_agent::agent_tool::flow::world::Created;
use mixdog_agent::agent_tool::flow::world::Delegation;
use mixdog_agent::agent_tool::flow::world::SendWorld;
use mixdog_agent::agent_tool::flow::world::SpawnAdmission;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_agent::agent_tool::flow::world::SpawnWorld;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_agent::env::Clock;
use mixdog_agent::response::Termination;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::render;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_ai::service::admin_route::Obj;

const START: i64 = 1_772_359_200_000; // 2026-03-01T10:00:00.000Z

fn fixture(name: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{}/../../fixtures/agent/flows/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    serde_json::from_str::<Value>(&text).unwrap().as_array().unwrap().clone()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        START
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
pub(crate) fn backend() {
    mixdog_rt::testing::tokens();
}

pub(crate) async fn settle() {
    for _ in 0..8 {
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    }
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type Log = Arc<Mutex<Vec<Value>>>;

fn log(l: &Log, entry: Value) {
    lock(l).push(entry);
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn numbers(v: &Value) -> Vec<usize> {
    v.as_array().map(|a| a.iter().filter_map(|n| n.as_u64().map(|n| n as usize)).collect()).unwrap_or_default()
}

fn turn_result(v: &Value) -> TurnResult {
    TurnResult {
        content: v["content"].as_str().unwrap_or_default().to_owned(),
        report_content: v.get("reportContent").and_then(Value::as_str).map(str::to_owned),
        termination: v.get("termination").and_then(Value::as_str).map(|t| match t {
            "truncated" => Termination::Truncated,
            "empty" => Termination::Empty,
            "refusal" => Termination::Refusal,
            other => panic!("termination {other}"),
        }),
        iterations: v.get("iterations").and_then(Value::as_u64).unwrap_or(1) as u32,
        tool_calls_total: v.get("toolCallsTotal").and_then(Value::as_u64).unwrap_or(0),
        stop_reason: v.get("stopReason").and_then(Value::as_str).map(str::to_owned),
    }
}

// ---- the world's fakes --------------------------------------------------------------------

pub(crate) struct Shared {
    log: Log,
    pub(crate) notices: Log,
    steps: Vec<Value>,
    session: Mutex<Value>,
    config: Obj,
    tags: Mutex<HashMap<String, String>>,
    pub(crate) board: JobBoard,
    /// Sessions whose review the store holds for their owner (a completion with no patch of its own
    /// still joins one it holds).
    parked: Mutex<std::collections::HashSet<String>>,
    created: std::sync::atomic::AtomicUsize,
    asks: std::sync::atomic::AtomicUsize,
    in_flight: std::sync::atomic::AtomicUsize,
    holds: Mutex<HashMap<usize, Arc<tokio::sync::Notify>>>,
    hold_create: Vec<usize>,
    hold_ask: Vec<usize>,
    /// The session's model rows: the earlier user row, then each say step's assistant row.
    messages: Mutex<Vec<Option<String>>>,
    /// The shells Node's reap left for the handoff (host.stoppedShellJobs), read once.
    stopped: Mutex<Option<StoppedShellJobs>>,
}

impl Shared {
    /// The gate the script opens for the nth slow step (a release that comes first is kept).
    fn hold(&self, n: usize) -> Arc<tokio::sync::Notify> {
        lock(&self.holds).entry(n).or_default().clone()
    }
}

struct Sess(Arc<Shared>);
#[async_trait]
impl TurnSessions for Sess {
    async fn message_count(&self, _: &str) -> usize {
        lock(&self.0.messages).len()
    }
    async fn assistant_texts(&self, _: &str, start: usize) -> Vec<AssistantText> {
        lock(&self.0.messages)
            .iter()
            .skip(start)
            .filter_map(|row| row.clone())
            .map(|content| AssistantText { content, replay: String::new() })
            .collect()
    }
    fn take_stopped_shell_jobs(&self, _: &str) -> StoppedShellJobs {
        lock(&self.0.stopped).take().unwrap_or_default()
    }
    fn not_done_report(&self, _: &str) -> String {
        String::new()
    }
    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        use std::sync::atomic::Ordering::SeqCst;
        log(&self.0.log, json!(["ask", handoff_content(&request.prompt, &request.attachments), request.cwd]));
        let n = self.0.asks.fetch_add(1, SeqCst) + 1;
        self.0.in_flight.fetch_add(1, SeqCst);
        if self.0.hold_ask.contains(&n) {
            self.0.hold(n).notified().await;
        }
        let result = self.script(&request);
        self.0.in_flight.fetch_sub(1, SeqCst);
        result
    }
    fn unload_runtime(&self, _: &str, reason: &str) {
        log(&self.0.log, json!(format!("unload:{reason}")));
    }
}
impl Sess {
    fn script(&self, request: &TurnRequest) -> Result<TurnResult, TurnError> {
        for step in &self.0.steps {
            if let Some(diff) = step.get("tool").and_then(Value::as_str) {
                (request.hooks.on_tool_result)(&ToolResultMessage { ui_diff: Some(diff.to_owned()) });
            } else if let Some(terminal) = step.get("terminal") {
                if let Some(hook) = &request.hooks.on_terminal_result {
                    hook(&turn_result(terminal));
                }
            } else if let Some(notice) = step.get("notify") {
                // A completion of the worker's own tool, as its tools hand it to the turn.
                (request.hooks.notify)(notice["text"].as_str().unwrap_or_default(), &notice["meta"]);
            } else if let Some(result) = step.get("return") {
                return Ok(turn_result(result));
            } else if let Some(error) = step.get("throw") {
                return Err(TurnError::new(s(error, "message")));
            } else if let Some(text) = step.get("say").and_then(Value::as_str) {
                lock(&self.0.messages).push(Some(text.to_owned()));
            } else if let Some(message) = step.get("stall").and_then(Value::as_str) {
                // A stop by the progress watchdog: its sentence, and the handoff the abort carried, if any.
                return Err(TurnError {
                    message: message.to_owned(),
                    partial_handoff: step.get("partialHandoff").and_then(Value::as_str).map(str::to_owned),
                    ..TurnError::default()
                });
            }
        }
        Ok(turn_result(&json!({ "content": "" })))
    }
}

struct Events(Arc<Shared>);
impl SubagentEvents for Events {
    fn start(&self, _: &str, _: &str, _: &str) {
        log(&self.0.log, json!("emit:start"));
    }
    fn stop(&self, _: &str, _: &str, _: &str, status: &str) {
        log(&self.0.log, json!(format!("emit:stop:{status}")));
    }
}

/// The review store ignores a completion that has no owner (beginAgentTurnReview hands none).
struct Review(Arc<Shared>, Mutex<bool>, String, String);
impl ReviewHandle for Review {
    fn complete(&self, patches: Vec<String>) {
        let mut done = lock(&self.1);
        if !*done {
            *done = true;
            // The store takes a completion with a patch, or one for a session whose review it holds.
            let mut parked = lock(&self.0.parked);
            if !self.2.is_empty() && (!patches.is_empty() || parked.contains(&self.3)) {
                parked.insert(self.3.clone());
                log(&self.0.log, json!(["reviewComplete", patches]));
            }
        }
    }
}
struct Reviews(Arc<Shared>);
impl TurnReviews for Reviews {
    fn begin(&self, owner: &str, session: &str, tag: &str, agent: &str) -> Box<dyn ReviewHandle> {
        log(&self.0.log, json!(["reviewBegin", owner, session, { "tag": tag, "agent": agent }]));
        Box::new(Review(self.0.clone(), Mutex::new(false), owner.to_owned(), session.to_owned()))
    }
}

struct Owner(Arc<Shared>);
impl OwnerNotify for Owner {
    fn notify(&self, owner: &str, text: &str, meta: &Value) -> bool {
        log(&self.0.notices, json!({ "session": owner, "text": text, "meta": meta }));
        true
    }
}

struct NoInbox;
impl WorkerInbox for NoInbox {
    fn enqueue_completion(&self, _: &str, _: &str, _: &Value) -> bool {
        false
    }
}

struct Closer(Arc<Shared>);
#[async_trait]
impl Sessions for Closer {
    async fn rehydrate_agent_sessions(&self) -> bool {
        false
    }
    async fn read_session_handoff(&self, _: &str) -> Option<String> {
        None
    }
    async fn close_session(&self, id: &str, reason: &str, _: CloseOptions) -> bool {
        log(&self.0.log, json!(format!("close:{id}:{reason}")));
        true
    }
    fn descendant_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn clear_statusline_route(&self, _: &str) {}
}

struct Slot;
#[async_trait]
impl Lease for Slot {
    async fn release(self: Box<Self>) {}
    fn yielder(&self) -> std::sync::Arc<dyn mixdog_agent::env::Yielder> {
        std::sync::Arc::new(Immediate)
    }
}

/// A slot that hands nothing back: the task just runs.
struct Immediate;
#[async_trait]
impl mixdog_agent::env::Yielder for Immediate {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, _: Option<&mixdog_agent::cancel::Cancel>) -> Result<(), String> {
        task.await;
        Ok(())
    }
}

struct Open;
#[async_trait]
impl Admission for Open {
    async fn acquire(&self, _: &str, _: Option<&str>, cancel: &mixdog_agent::cancel::Cancel) -> Result<Box<dyn Lease>, String> {
        if cancel.is_aborted() {
            return Err("agent task cancelled before resource admission".into());
        }
        Ok(Box::new(Slot))
    }
}

struct NoStarts;
impl TaskStarts for NoStarts {
    fn record(&self, _: &str, _: &str) {}
}

/// The owner of the worker's turns as Node's fakes log it: a claim, its release, an observation.
struct TurnsOwner(Arc<Shared>);
impl TurnOwner for TurnsOwner {
    fn claim(&self, _: &str, _: Option<Arc<mixdog_agent::agent_tool::flow::reconcile::JobHandle>>) -> Claim {
        log(&self.0.log, json!("claim"));
        let shared = self.0.clone();
        Claim::custom("sub-1".into(), Box::new(move |status| log(&shared.log, json!(format!("release:{}", status.word())))))
    }
    fn observe(&self, session_id: &str) -> bool {
        log(&self.0.log, json!(["observe", session_id]));
        true
    }
}
struct Reg(Arc<Shared>);
#[async_trait]
impl Registry for Reg {
    fn resolve_tombstone_owners(&self) {}
    async fn refresh_tags_from_sessions(&self, _: bool, _: &Scope) {
        log(&self.0.log, json!("refresh"));
    }
    fn resolve_tag(&self, tag: &str, _: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        log(&self.0.log, json!(format!("resolveTag:{tag}:{}", options.scan_sessions)));
        match lock(&self.0.tags).get(tag).map(String::as_str) {
            Some("THROW") => Err(format!("tag \"{tag}\" is ambiguous")),
            other => Ok(other.map(str::to_owned)),
        }
    }
    fn live_session(&self, _: &str) -> Option<SessionFacts> {
        None
    }
    fn tag_session(&self, _: &str) -> Option<String> {
        None
    }
    fn has_tag_agent(&self, _: &str) -> bool {
        false
    }
    fn tag_count(&self) -> usize {
        0
    }
    fn tag_for_session(&self, _: &str) -> Option<String> {
        Some("scout".into())
    }
    fn unbind_tag(&self, _: &str) {}
    fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str) {
        log(&self.0.log, json!(format!("forget:{}:{session_id}", tag.unwrap_or_default())));
    }
    fn remove_worker_row(&self, _: &str) {}
    fn mark_released(&self, _: &[String]) {}
    fn read_worker_rows(&self, _: &Scope) -> Result<Vec<TagRecord>, String> {
        Ok(Vec::new())
    }
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
        Vec::new()
    }
    fn tag_tombstone_for_tag(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    fn consume_tag_tombstone(&self, _: &TagRecord) {}
    fn last_tag_session(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    async fn resumable_tag_session(&self, _: &str, _: &str, _: &Scope) -> Option<Resumable> {
        None
    }
}

struct Env;
#[async_trait]
impl Environment for Env {
    async fn is_directory(&self, _: &str) -> bool {
        true
    }
    async fn read_text(&self, _: &str) -> Result<String, String> {
        Err("no files".into())
    }
    fn current_dir(&self) -> String {
        "/cwd".into()
    }
    fn now_iso(&self) -> String {
        "2026-03-01T10:00:00.000Z".into()
    }
}

struct NoWorkers;
#[async_trait]
impl Workers for NoWorkers {
    async fn session(&self, _: &str) -> Option<WorkerFacts> {
        None
    }
    fn live(&self, _: &str) -> WorkerLive {
        WorkerLive::default()
    }
    async fn entries(&self, _: bool, _: &Scope) -> Vec<(String, WorkerFacts)> {
        Vec::new()
    }
}

/// What the spawn scenario's host answers (`host`) and does (`scenario`).
struct SpawnHost {
    shared: Arc<Shared>,
    scenario: Value,
    host: Value,
}

impl SpawnAdmission for SpawnHost {
    fn workspace_cwd_lock(&self, owners: &[String]) -> Option<String> {
        // The lock is held by one session: it pins a worker only when that session is an owner asked.
        let holder = s(&self.scenario, "lockOwner");
        owners.iter().any(|o| *o == holder).then(|| self.scenario["lock"].as_str().map(str::to_owned)).flatten()
    }
    fn enter_worker_spawn(&self, _: &[String]) -> Result<Box<dyn Send>, String> {
        Ok(Box::new(()))
    }
}

#[async_trait]
impl SpawnWorld for SpawnHost {
    async fn load_config(&self) -> Result<Obj, String> {
        Ok(self.shared.config.clone())
    }
    fn loaded_config(&self) -> Option<Obj> {
        Some(self.shared.config.clone())
    }
    async fn route_candidates(&self, _: &Obj, _: &str) -> Result<Vec<Value>, String> {
        Ok(self.host["agent"]["candidates"].as_array().cloned().unwrap_or_default())
    }
    async fn agent_defined(&self, _: &str) -> Result<bool, String> {
        Ok(self.host["agent"]["defined"] == true)
    }
    fn agent_disabled(&self, _: &Obj, _: &str) -> bool {
        self.host["agent"]["disabled"] == true
    }
    async fn agent_kind(&self, _: &str) -> Result<Option<String>, String> {
        Ok(self.host["agent"]["kind"].as_str().map(str::to_owned))
    }
    fn is_contact_agent(&self, _: &str, _: Option<&str>) -> bool {
        self.host["agent"]["contact"] == true
    }
    fn delegation(&self, _: &str) -> Delegation {
        Delegation {
            chain: self.host["delegation"]["chain"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_owned()).collect(),
            acting: s(&self.host["delegation"], "acting"),
        }
    }
    async fn agent_permission(&self, _: &str) -> Result<Option<Value>, String> {
        Ok(Some(self.host["agent"]["permission"].clone()).filter(|p| !p.is_null()))
    }
    fn next_tag(&self, _: &str, _: &SpawnContext) -> String {
        s(&self.scenario, "nextTag")
    }
    fn resolve_runtime_spec(&self, preset: &Value, tag: &str) -> Value {
        json!({ "runtime": preset["provider"], "options": { "lane": "agent", "agentId": tag } })
    }
    fn route_window_meta(&self, _: &str, _: &str) -> Option<Value> {
        Some(self.scenario["window"].clone()).filter(|w| !w.is_null())
    }
    fn canonical_surface(&self) -> bool {
        self.scenario["canonical"] == true
    }
    fn can_create_child(&self) -> bool {
        true
    }
    fn prewarm_git_probes(&self, _: &str) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    async fn create_child(&self, spec: &Obj, prompt: &str, tag: &str) -> Result<Created, String> {
        use std::sync::atomic::Ordering::SeqCst;
        let n = self.shared.created.fetch_add(1, SeqCst) + 1;
        log(&self.shared.log, json!(["createChild", { "spec": spec, "prompt": prompt, "tag": tag }]));
        if let Some(message) = self.scenario["createThrows"].as_str() {
            return Err(message.to_owned());
        }
        if self.scenario["cancel"] == "during-prep" {
            let id = self.shared.board.list_jobs(&Scope::default()).first().map(|j| j.task_id.clone()).unwrap();
            self.shared.board.cancel(&id, "cancelled mid prep", CancelNotice::Default);
        }
        // A race holds the nth creation open until the script releases it.
        if self.shared.hold_create.contains(&n) {
            self.shared.hold(n).notified().await;
        }
        let mut session = lock(&self.shared.session).clone();
        if n > 1 {
            session["id"] = json!(format!("sess_w{n}"));
        }
        Ok(Created { session, effective_cwd: self.scenario["effectiveCwd"].as_str().map(str::to_owned) })
    }
    async fn ensure_provider(&self, _: &Obj, provider: &str) -> Result<(), String> {
        log(&self.shared.log, json!(["ensureProvider", provider]));
        match self.scenario["ensureThrows"].as_str() {
            Some(message) => Err(message.to_owned()),
            None => Ok(()),
        }
    }
    async fn prepare_session(&self, spec: &Obj) -> Result<Created, String> {
        log(&self.shared.log, json!(["prepareSession", spec]));
        Ok(Created { session: lock(&self.shared.session).clone(), effective_cwd: self.scenario["effectiveCwd"].as_str().map(str::to_owned) })
    }
    fn write_statusline_route(&self, _: &str, _: &Value) {}
    fn bind_tag(&self, tag: &str, session: &Value, descriptor: &Obj) {
        log(&self.shared.log, json!(["bindTag", tag, session["id"], descriptor]));
        lock(&self.shared.tags).insert(tag.to_owned(), s(session, "id"));
    }
    fn prewarm_transport(&self, _: &str, _: &Value) {}
    fn upsert_worker_row(&self, session: &Value, tag: &str, row: &Obj) {
        log(&self.shared.log, json!(["upsert", tag, session["id"], row]));
    }
}

struct SendHost {
    shared: Arc<Shared>,
    scenario: Value,
}

#[async_trait]
impl SendWorld for SendHost {
    fn session(&self, id: &str) -> Option<Value> {
        Some(lock(&self.shared.session).clone()).filter(|session| session["id"] == id)
    }
    fn surface_runs(&self, _: &Value) -> bool {
        self.scenario["surface"] == "canonical"
    }
    fn canonical_surface(&self) -> bool {
        self.scenario["surface"] == "canonical"
    }
    fn is_busy(&self, _: &str) -> bool {
        self.scenario["busy"] == true || self.shared.in_flight.load(std::sync::atomic::Ordering::SeqCst) > 0
    }
    async fn load_config(&self) -> Result<Option<Obj>, String> {
        Ok(Some(self.shared.config.clone()))
    }
    async fn route_candidates(&self, config: &Obj, agent: &str) -> Result<Vec<Value>, String> {
        Ok(config.get("agents").and_then(|a| a.get(agent)).cloned().into_iter().collect())
    }
    fn can_set_route(&self) -> bool {
        self.scenario["surface"] == "canonical"
    }
    async fn set_route(&self, _: &Value, route: &Value) -> Result<(), String> {
        log(&self.shared.log, json!(["setRoute", route]));
        if let Some(patch) = self.scenario["afterSetRoute"].as_object() {
            let mut session = lock(&self.shared.session);
            session.as_object_mut().unwrap().extend(patch.clone());
        }
        Ok(())
    }
    fn update_session_route(&self, id: &str, route: &Value, _: &Value, cross_provider: bool) {
        log(&self.shared.log, json!(["updateSessionRoute", id, route, cross_provider]));
    }
    fn hold_session_route(&self, id: &str, route: Option<&Value>) {
        log(&self.shared.log, json!(["holdSessionRoute", id, route]));
    }
    async fn enqueue_turn(&self, _: &Value, prompt: &str, attachments: &[Value], context: Option<&Value>) -> Result<Option<Value>, String> {
        log(&self.shared.log, json!(["enqueueTurn", handoff_content(prompt, attachments), context]));
        Ok(Some(self.scenario["enqueueReturns"].clone()).filter(|v| !v.is_null()))
    }
    fn enqueue_pending(&self, id: &str, prompt: &str, attachments: &[Value]) -> Option<u64> {
        if self.scenario["noPending"] == true {
            return None;
        }
        log(&self.shared.log, json!(["enqueuePending", id, handoff_content(prompt, attachments)]));
        self.scenario["pendingDepth"].as_u64()
    }
    async fn rebind_delegation(&self, id: &str, caller: Option<&str>) -> Result<(), String> {
        log(&self.shared.log, json!(["rebindDelegation", id, caller]));
        Ok(())
    }
}

/// presentErrorText(error, { surface: 'agent' }), which the board applies to a job's failure.
struct Presented;
impl mixdog_agent::agent_tool::error_text::ErrorText for Presented {
    fn present(&self, message: &str) -> String {
        use mixdog_ai::service::error_text::{ErrorView, PresentOptions, present_error_text};
        present_error_text(&ErrorView::message(message), &PresentOptions { surface: "agent".into(), ..PresentOptions::default() })
    }
}

pub(crate) struct Rig {
    pub(crate) shared: Arc<Shared>,
    pub(crate) spawn: Arc<SpawnFlowImpl>,
    send: Arc<SendFlowImpl>,
    /// The agent tool over the flows, as the compose root assembles it.
    pub(crate) runtime: Arc<mixdog_agent::agent_tool::AgentRuntime>,
}

fn stopped_shells(host: Option<&Value>) -> Option<StoppedShellJobs> {
    let names = |key: &str| -> Vec<String> {
        host.and_then(|h| h.pointer(&format!("/stoppedShellJobs/{key}"))).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
    };
    host.and_then(|h| h.get("stoppedShellJobs")).map(|_| StoppedShellJobs { stopped: names("stopped"), stopping: names("stopping") })
}

pub(crate) fn rig(scenario: &Value, host: Option<&Value>) -> Rig {
    let clock: Arc<dyn Clock> = Arc::new(FixedClock);
    // The board delivers through the shared state, which holds the board: build the state first
    // with a placeholder board, then the board over the state.
    let placeholder = JobBoard::new(clock.clone(), None, None);
    let config = scenario["config"].as_object().cloned().unwrap_or_default();
    let tags: HashMap<String, String> = scenario["tags"].as_object().map(|t| t.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default();
    let session = if scenario.get("session").is_some() {
        scenario["session"].clone()
    } else {
        json!({ "id": "sess_w1", "cwd": "/work", "parentSessionId": "lead", "ownerSessionId": "lead" })
    };
    let mut shared = Shared {
        log: Arc::default(),
        notices: Arc::default(),
        steps: scenario["steps"].as_array().cloned().unwrap_or_default(),
        session: Mutex::new(session),
        config,
        tags: Mutex::new(tags),
        board: placeholder,
        parked: Mutex::default(),
        created: Default::default(),
        asks: Default::default(),
        in_flight: Default::default(),
        holds: Mutex::default(),
        hold_create: numbers(&scenario["holdCreate"]),
        hold_ask: numbers(&scenario["holdAsk"]),
        messages: Mutex::new(vec![None]),
        stopped: Mutex::new(stopped_shells(host)),
    };
    // The notifier needs the state (its notices); give it its own handle to the same lists.
    let notices = shared.notices.clone();
    let delivered = Arc::new(DeliveredTo(notices));
    shared.board = JobBoard::new(clock.clone(), Some(delivered), None);
    let shared = Arc::new(shared);
    let board = shared.board.clone();
    board.set_error_text(Arc::new(Presented));

    let sessions: Arc<dyn TurnSessions> = Arc::new(Sess(shared.clone()));
    let turns: Arc<dyn TurnOwner> = Arc::new(TurnsOwner(shared.clone()));
    // A job cancelled "before" is cancelled by the time its first status goes out, which is before
    // its work is released.
    let status: Arc<dyn Fn() + Send + Sync> = {
        let (l, board, early) = (shared.log.clone(), board.clone(), Mutex::new(scenario["cancel"] == "before"));
        Arc::new(move || {
            log(&l, json!("status"));
            if std::mem::take(&mut *lock(&early)) {
                let id = board.list_jobs(&Scope::default()).first().map(|j| j.task_id.clone()).unwrap();
                board.cancel(&id, "cancelled early", CancelNotice::Default);
            }
        })
    };
    let registry: Arc<dyn Registry> = Arc::new(Reg(shared.clone()));
    let spawn_host = Arc::new(SpawnHost { shared: shared.clone(), scenario: scenario.clone(), host: host.cloned().unwrap_or(Value::Null) });
    // The same assembly the compose root calls.
    let assembled = assemble(AgentParts {
        board: board.clone(),
        clock,
        registry,
        sessions: Arc::new(Closer(shared.clone())),
        turn_sessions: sessions,
        turns,
        reviews: Arc::new(Reviews(shared.clone())),
        events: Arc::new(Events(shared.clone())),
        inbox: Arc::new(NoInbox),
        owner_notify: Arc::new(Owner(shared.clone())),
        admission: Arc::new(Open),
        starts: Arc::new(NoStarts),
        workers: Arc::new(NoWorkers),
        status_changed: status,
        spawn_world: spawn_host.clone(),
        spawn_admission: spawn_host,
        send_world: Arc::new(SendHost { shared: shared.clone(), scenario: scenario.clone() }),
        terminal_trace: Arc::new(NoTrace),
        env: Arc::new(Env),
        catalog: None,
        scopes: Arc::new(NoScopes),
        errors: Arc::new(PlainErrorText),
        default_cwd: "/default".into(),
        mcp_scope_id: None,
    });
    let (spawn, send, runtime) = (assembled.spawn, assembled.send, assembled.runtime);
    Rig { shared, spawn, send, runtime }
}

/// No terminal trace, no caller scope: the flows under test never reach them.
struct NoTrace;
impl TerminalTrace for NoTrace {
    fn has_terminal_trace(&self, _: &str, _: &Scope) -> Result<bool, String> {
        Ok(false)
    }
    fn reap_terminal_trace_for_tag(&self, _: &str, _: &Scope) {}
}

struct NoScopes;
impl CallerScopes for NoScopes {
    fn scope_of(&self, _: &ThreadId) -> Scope {
        Scope::default()
    }
}

struct DeliveredTo(Log);
#[async_trait]
impl TaskNotifier for DeliveredTo {
    async fn finished(&self, owner: &ThreadId, _surface: &str, _task_id: &str, _status: &str, notification: String) {
        log(&self.0, json!({ "session": owner.as_str(), "text": notification }));
    }
}

// ---- comparing ----------------------------------------------------------------------------

/// Paths without a drive letter and with `/`, the form the golden is recorded in.
fn norm(value: &mut Value) {
    match value {
        Value::String(text) => {
            let bytes = text.as_bytes();
            let drive = bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
            if drive || text.starts_with('\\') {
                *text = text[if drive { 2 } else { 0 }..].replace('\\', "/");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(norm),
        Value::Object(map) => map.values_mut().for_each(norm),
        _ => {}
    }
}

/// Masks the job's id and puts paths in the golden's form.
fn masked(value: Value, id: Option<&str>) -> Value {
    let text = value.to_string();
    let text = id.map_or(text.clone(), |id| text.replace(id, "job"));
    let mut out: Value = serde_json::from_str(&text).unwrap();
    norm(&mut out);
    out
}

/// A job's meta as its card shows it, with the host process the job was started for.
fn public_meta(meta: &JobMeta, pid: Option<u64>) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<&String>| {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            out.insert(key.into(), json!(v));
        }
    };
    put("tag", meta.tag.as_ref());
    put("sessionId", meta.session_id.as_ref());
    put("agent", meta.agent.as_ref());
    put("preset", meta.preset.as_ref());
    put("provider", meta.provider.as_ref());
    put("model", meta.model.as_ref());
    put("effort", meta.effort.as_ref());
    if let Some(fast) = meta.fast {
        out.insert("fast".into(), json!(fast));
    }
    if meta.respawned {
        out.insert("respawned".into(), json!(true));
    }
    if meta.resumed {
        out.insert("resumed".into(), json!(true));
    }
    if meta.auto_effort_off {
        out.insert("autoEffort".into(), json!(false));
    }
    if let Some(pid) = pid {
        out.insert("clientHostPid".into(), json!(pid));
    }
    Value::Object(out)
}

fn final_state(rig: &Rig, id: &str, with_label: bool) -> Value {
    let task = rig.shared.board.get(id, &Scope::default()).unwrap();
    let mut out = json!({
        "status": task.status,
        "error": task.error,
        "terminalReason": task.terminal_reason,
        "meta": public_meta(&task.meta, Some(4242)),
        "notified": task.notified,
        "result": match &task.result { Some(TaskResult::Json(v)) => v.clone(), _ => Value::Null },
    });
    if with_label {
        out["label"] = json!(task.label);
    }
    out
}

/// Fails at the first place two values differ, naming it.
fn same(name: &str, path: &str, got: &Value, want: &Value) {
    match (got, want) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                same(name, &format!("{path}/{key}"), a.get(key).unwrap_or(&Value::Null), b.get(key).unwrap_or(&Value::Null));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                same(name, &format!("{path}/{i}"), x, y);
            }
        }
        _ => assert_eq!(got, want, "{name} at {path}"),
    }
}

fn drain(rig: &Rig, id: Option<&str>) -> (Value, Value) {
    let calls = masked(Value::Array(lock(&rig.shared.log).clone()), id);
    let mut notices = masked(Value::Array(lock(&rig.shared.notices).clone()), id);
    for notice in notices.as_array_mut().unwrap() {
        if notice.get("meta").is_some_and(Value::is_null) {
            notice.as_object_mut().unwrap().remove("meta");
        }
    }
    (calls, notices)
}

#[tokio::test(start_paused = true)]
async fn a_spawn_equals_nodes() {
    backend();
    for case in fixture("spawn.json") {
        let name = s(&case, "name");
        let scenario = &case["scenario"];
        let rig = rig(scenario, Some(&case["host"]));
        let context = SpawnContext {
            caller_session_id: Some("lead".into()),
            session_id: None,
            owner_session_id: Some(s(scenario, "owner")),
            client_host_pid: Some(4242),
        };
        let started = rig.spawn.start_deferred_spawn_job(
            &scenario["args"],
            scenario["callerCwd"].as_str().unwrap(),
            &context,
            &context,
            SpawnOptions { respawned: scenario["respawned"] == true },
        )
        .await;
        let (start_error, id, pending) = match &started {
            Ok(job) => {
                let task = rig.shared.board.get(job.task_id(), &Scope::default()).unwrap();
                (Value::Null, Some(job.task_id().to_owned()), masked(public_meta(&task.meta, Some(4242)), Some(job.task_id())))
            }
            Err(error) => (json!(error), None, Value::Null),
        };
        settle().await;
        settle().await;
        let (calls, notices) = drain(&rig, id.as_deref());
        let final_value = id.as_deref().map_or(Value::Null, |id| masked(final_state(&rig, id, true), Some(id)));
        let got = json!({ "startError": start_error, "pending": pending, "calls": calls, "notices": notices, "final": final_value });
        let mut want = case["result"].clone();
        for notice in want["notices"].as_array_mut().unwrap() {
            if notice.get("meta").is_some_and(Value::is_null) {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        // The shells' own statuses are what Node's reap (the shell owner's, not the flow's) did to
        // the registered jobs; the flow sees only the lists handed to it. So the statuses are not
        // part of what the flow answers: they must agree with those lists, job by job.
        let shell_tasks = want.as_object_mut().unwrap().remove("shellTasks");
        same(&name, "", &got, &want);
        let handed = |key: &str| case["host"]["stoppedShellJobs"][key].as_array().cloned().unwrap_or_default();
        let ended: Vec<Value> = handed("stopped").into_iter().chain(handed("stopping")).collect();
        let jobs = scenario["shellJobs"].as_array().cloned().unwrap_or_default();
        assert_eq!(shell_tasks.is_some(), !jobs.is_empty(), "{name}: shellTasks");
        for job in &jobs {
            let id = job["id"].clone();
            let status = if ended.contains(&id) { "cancelled" } else { "running" };
            assert_eq!(shell_tasks.as_ref().unwrap()[id.as_str().unwrap()], status, "{name}: {id}");
        }
        assert_eq!(shell_tasks.map_or(0, |tasks| tasks.as_object().unwrap().len()), jobs.len(), "{name}: shellTasks");
    }
}

#[tokio::test(start_paused = true)]
async fn a_send_equals_nodes() {
    backend();
    for case in fixture("send.json") {
        let name = s(&case, "name");
        let scenario = &case["scenario"];
        let rig = rig(scenario, None);
        let args = &scenario["args"];
        let caller = Scope { caller_session_id: Some("lead".into()), host_pid: Some(4242) };
        let context = SpawnContext { caller_session_id: Some("lead".into()), session_id: None, owner_session_id: Some("lead".into()), client_host_pid: Some(4242) };
        let session = rig.shared.session.lock().unwrap().clone();
        let result = match s(scenario, "op").as_str() {
            "prepare" => match rig.send.prepare_send(args, &caller).await {
                Ok(prepared) => json!({ "prepared": { "sessionId": prepared.session_id, "prompt": prepared.prompt, "args": prepared.args } }),
                Err(error) => json!({ "error": error }),
            },
            "wake" => json!({ "woke": rig.send.wake_idle_worker("sess_w1") }),
            "adopt" => {
                let prepared = Prepared {
                    args: args.clone(),
                    session: SessionFacts { id: "sess_w1".into(), ..SessionFacts::default() },
                    session_id: "sess_w1".into(),
                    prompt: Some("x".into()),
                    route: None,
                };
                let notify = if scenario["noCaller"] == true { SpawnContext::default() } else { context.clone() };
                SendFlowImpl::adopt_caller(&rig.send, &prepared, &notify).await.expect("adopt");
                json!({ "adopted": true })
            }
            _ => {
                let prepared = Prepared {
                    args: args.clone(),
                    session: SessionFacts { id: "sess_w1".into(), agent: s(&session, "agent"), cwd: s(&session, "cwd"), ..SessionFacts::default() },
                    session_id: "sess_w1".into(),
                    prompt: Some("follow up".into()),
                    route: Some(scenario["route"].clone()).filter(|r| !r.is_null()),
                };
                let options = DispatchOptions { reused: scenario["extras"]["reused"] == true, resumed: scenario["extras"]["resumed"] == true };
                match rig.send.dispatch_to_existing_session(&prepared, &context, options).await {
                    Ok(reply @ AgentReply::Queued(_)) => json!({ "queued": render(&reply, "") }),
                    Ok(AgentReply::Task { .. }) => json!({ "task": true }),
                    Ok(other) => panic!("{name}: {other:?}"),
                    Err(error) => json!({ "error": error }),
                }
            }
        };
        settle().await;
        settle().await;
        let id = rig.shared.board.list_jobs(&Scope::default()).first().map(|t| t.task_id.clone());
        let (calls, notices) = drain(&rig, id.as_deref());
        let mut got = result.as_object().cloned().unwrap();
        got.insert("calls".into(), calls);
        got.insert("notices".into(), notices);
        got.insert("final".into(), id.as_deref().map_or(Value::Null, |id| masked(final_state(&rig, id, false), Some(id))));
        let mut want = case["result"].clone();
        for notice in want["notices"].as_array_mut().unwrap() {
            if notice.get("meta").is_some_and(Value::is_null) {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        same(&name, "", &Value::Object(got), &want);
    }
}

#[test]
fn a_contact_agent_may_not_hand_work_to_itself() {
    use mixdog_agent::agent_tool::flow::spawn::assert_bot_chain_target;
    // Node's text, from `assertBotChainTarget` (`runtime/shared/bot-hops.mjs`).
    let message = assert_bot_chain_target("robot", &[], "robot", "agent spawn").unwrap_err();
    assert_eq!(message, "agent spawn: the contact agent \"robot\" cannot hand work to itself; do it yourself or delegate to a sub-agent");
    assert_eq!(assert_bot_chain_target("", &["x".into()], "x", "agent spawn"), Ok(()));
}

/// Spins (yielding) until `ready`, failing instead of hanging when it never is.
async fn until(_what: &str, ready: impl Fn() -> bool) {
    while !ready() {
        tokio::task::yield_now().await;
    }
}

/// Two requests meeting on one tag or worker, and a cancel meeting a settle, each as a script whose
/// slow steps wait for the script to release them: the interleaving is forced, so the outcome Node's
/// ordering gives is the one asserted (winner, losers, notifications, final job states).
#[tokio::test(start_paused = true)]
async fn racing_requests_end_as_nodes_do() {
    backend();
    for case in fixture("races.json") {
        let name = s(&case, "name");
        let scenario = &case["scenario"];
        let rig = rig(scenario, Some(&case["host"]));
        let context = SpawnContext { caller_session_id: Some("lead".into()), session_id: None, owner_session_id: Some("lead".into()), client_host_pid: Some(4242) };
        let want = &case["result"];
        let want_len = want["calls"].as_array().unwrap().len();
        let mut jobs: Vec<(String, String)> = Vec::new();
        let mut replies = Map::new();
        let all_terminal = |rig: &Rig, jobs: &[(String, String)]| jobs.iter().all(|(_, id)| rig.shared.board.get(id, &Scope::default()).is_none_or(|t| t.is_terminal()));
        let ops = case["ops"].as_array().unwrap();
        for (index, op) in ops.iter().enumerate() {
            match s(op, "op").as_str() {
                "start" => {
                    let job = rig.spawn.start_deferred_spawn_job(&op["args"], "/work", &context, &context, SpawnOptions { respawned: false }).await.unwrap();
                    jobs.push((s(op, "as"), job.task_id().to_owned()));
                }
                "dispatch" => {
                    let session = lock(&rig.shared.session).clone();
                    let prepared = Prepared {
                        args: json!({ "tag": "scout", "prompt": "follow up" }),
                        session: SessionFacts { id: "sess_w1".into(), agent: s(&session, "agent"), cwd: s(&session, "cwd"), ..SessionFacts::default() },
                        session_id: "sess_w1".into(),
                        prompt: Some("follow up".into()),
                        route: None,
                    };
                    let known: Vec<String> = rig.shared.board.list_jobs(&Scope::default()).into_iter().map(|t| t.task_id).collect();
                    let reply = SendFlowImpl::dispatch_to_existing_session(&rig.send, &prepared, &context, DispatchOptions::default()).await.unwrap();
                    replies.insert(
                        s(op, "as"),
                        match &reply {
                            AgentReply::Queued(_) => json!({ "queued": render(&reply, "") }),
                            _ => json!({ "task": true }),
                        },
                    );
                    if let Some(new) = rig.shared.board.list_jobs(&Scope::default()).into_iter().find(|t| !known.contains(&t.task_id)) {
                        jobs.push((s(op, "as"), new.task_id));
                    }
                }
                "until" if op["notices"].is_u64() => {
                    let wanted = op["notices"].as_u64().unwrap() as usize;
                    until(&format!("{name}: notices"), || lock(&rig.shared.notices).len() >= wanted).await;
                }
                "until" => {
                    let entry = op["log"].clone();
                    let head = op["head"].as_str().map(str::to_owned);
                    let wanted = op["count"].as_u64().unwrap() as usize;
                    let matches = |c: &Value| match &head {
                        Some(head) => c.get(0).and_then(Value::as_str).unwrap_or_else(|| c.as_str().unwrap_or_default()) == head,
                        None => *c == entry,
                    };
                    until(&format!("{name}: {entry}"), || lock(&rig.shared.log).iter().filter(|c| matches(c)).count() >= wanted).await;
                }
                "release" => rig.shared.hold(op["n"].as_u64().unwrap() as usize).notify_one(),
                "cancel" => {
                    let id = &jobs.iter().find(|(alias, _)| *alias == s(op, "as")).unwrap().1;
                    rig.shared.board.cancel(id, &s(op, "reason"), CancelNotice::Default);
                }
                "settle" => {
                    // Quiet means: every job terminal and, at the last settle, the whole trace written.
                    let last = index == ops.len() - 1;
                    let want_notices = want["notices"].as_array().unwrap().len();
                    until(&format!("{name}: settle"), || {
                        all_terminal(&rig, &jobs) && (!last || (lock(&rig.shared.log).len() >= want_len && lock(&rig.shared.notices).len() >= want_notices))
                    })
                    .await;
                    for _ in 0..30 {
                        tokio::task::yield_now().await;
                    }
                }
                other => panic!("{name}: {other}"),
            }
        }
        let calls = Value::Array(lock(&rig.shared.log).clone());
        let notices = Value::Array(lock(&rig.shared.notices).clone());
        let finals: Map<String, Value> = jobs.iter().map(|(alias, id)| (alias.clone(), final_state(&rig, id, false))).collect();
        let got = json!({ "replies": replies, "calls": calls, "notices": notices, "finals": finals });
        let mut text = got.to_string();
        for (alias, id) in &jobs {
            text = text.replace(id.as_str(), &format!("job_{alias}"));
        }
        let mut got: Value = serde_json::from_str(&text).unwrap();
        norm(&mut got);
        let mut want = want.clone();
        for notice in want["notices"].as_array_mut().unwrap() {
            if notice.get("meta").is_some_and(Value::is_null) {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        for notice in got["notices"].as_array_mut().unwrap() {
            if notice.get("meta").is_some_and(Value::is_null) {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        same(&name, "", &got, &want);
    }
}
/// Closes recorded with their options, and a signal when one arrives.
#[derive(Default)]
struct RecordedCloses {
    calls: Mutex<Vec<(String, String, bool, bool)>>,
    arrived: tokio::sync::Notify,
}
#[async_trait]
impl Sessions for RecordedCloses {
    async fn rehydrate_agent_sessions(&self) -> bool {
        false
    }
    async fn read_session_handoff(&self, _: &str) -> Option<String> {
        None
    }
    async fn close_session(&self, id: &str, reason: &str, options: CloseOptions) -> bool {
        lock(&self.calls).push((id.to_owned(), reason.to_owned(), options.tombstone, options.owner_close));
        self.arrived.notify_one();
        true
    }
    fn descendant_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn clear_statusline_route(&self, _: &str) {}
}

/// `runToCompletion`: a foreground run resolves with the agent's final content and closes the
/// agent's session with the executor reason, neither tombstoning nor as an owner close.
#[tokio::test(start_paused = true)]
async fn a_foreground_run_ends_with_its_content_and_closes_its_session() {
    backend();
    let case = fixture("spawn.json").into_iter().next().unwrap();
    let scenario = &case["scenario"];
    let rig = rig(scenario, Some(&case["host"]));
    let context = SpawnContext { caller_session_id: Some("lead".into()), session_id: None, owner_session_id: Some("lead".into()), client_host_pid: Some(4242) };
    let cancel = tokio_util::sync::CancellationToken::new();
    let (session, content) = rig.spawn.run_to_completion(&scenario["args"], scenario["callerCwd"].as_str().unwrap(), &context, &cancel).await.expect("the run completes");
    assert_eq!(content, "done");
    let session = session.expect("the run's session");
    let closed = rig.shared.log.lock().unwrap().iter().any(|entry| *entry == json!(format!("close:{session}:routine-executor-finished")));
    assert!(closed, "the agent's session is closed after the run");
}

/// `job-start.mjs`: cancelling an agent job closes its worker session with reason
/// `agent-task-cancel`, neither tombstoning it nor as an owner close (the host builds the turn's
/// `Session "<id>" closed: closeSession (reason=agent-task-cancel)` text from that reason).
#[tokio::test]
async fn cancelling_an_agent_job_closes_its_worker_session_with_the_cancel_reason() {
    backend();
    let rig = rig(&json!({}), None);
    let closes = Arc::new(RecordedCloses::default());
    let starter = JobStarter::new(rig.shared.board.clone(), closes.clone(), Arc::new(Sess(rig.shared.clone())), Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
    let meta = JobMeta { session_id: Some("sess_w1".into()), ..JobMeta::default() };
    starter
        .start_job("agent", meta, Default::default(), |_, _| async { std::future::pending::<Result<Option<mixdog_agent::agent_tool::flow::result::WorkerResult>, String>>().await })
        .expect("started");
    let id = rig.shared.board.list_jobs(&Scope::default()).first().map(|j| j.task_id.clone()).expect("job");
    rig.shared.board.cancel(&id, "user cancelled", CancelNotice::Default);
    closes.arrived.notified().await;
    assert_eq!(*lock(&closes.calls), [("sess_w1".to_owned(), "agent-task-cancel".to_owned(), false, false)]);
    assert_eq!(
        mixdog_agent::cancel::close_session_reason("sess_w1", "agent-task-cancel"),
        "Session \"sess_w1\" closed: closeSession (reason=agent-task-cancel)"
    );
}
