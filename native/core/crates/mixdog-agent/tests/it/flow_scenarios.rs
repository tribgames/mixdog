//! The spawn and send flows over a scripted world: a contact agent may not hand work to itself, cancelling and closing an agent
//! closes its worker sessions and jobs, a spawn's report names what its todo list leaves undone, and a hop completes its job.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::dispatch::{CloseParts, cancel_agent_tree, close_resolved};
use mixdog_agent::agent_tool::error_text::PlainErrorText;
use mixdog_agent::agent_tool::error_text::PresentedErrorText;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_agent::agent_tool::flow::job_starter::JobStarter;
use mixdog_agent::agent_tool::flow::job_starter::StartContext;
use mixdog_agent::agent_tool::flow::seams::*;
use mixdog_agent::agent_tool::flow::send::SendFlowImpl;
use mixdog_agent::agent_tool::flow::spawn::SpawnFlowImpl;
use mixdog_agent::agent_tool::flow::worker_turns::Claim;
use mixdog_agent::agent_tool::flow::worker_turns::TurnOwner;
use mixdog_agent::agent_tool::flow::world::Created;
use mixdog_agent::agent_tool::flow::world::Delegation;
use mixdog_agent::agent_tool::flow::world::SendWorld;
use mixdog_agent::agent_tool::flow::world::SpawnAdmission;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_agent::agent_tool::flow::world::SpawnWorld;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::model_select::ListOptions as ModelListOptions;
use mixdog_agent::agent_tool::model_select::ModelCatalog;
use mixdog_agent::agent_tool::model_select::ModelRow;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_agent::agent_tool::{AgentParts, AgentRuntime, assemble};
use mixdog_agent::env::Clock;
use mixdog_agent::response::Termination;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_ai::service::admin_route::Obj;

const START: i64 = 1_772_359_200_000;

pub(crate) struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        START
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

pub(crate) fn turn_result(v: &Value) -> TurnResult {
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
    pub(crate) log: Log,
    pub(crate) notices: Log,
    /// The sessions listed again (`revealSession`).
    revealed: Log,
    /// The sessions hidden and not listed again since.
    hidden: Mutex<std::collections::HashSet<String>>,
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
    /// Per turn, the skill selection it was handed: `{ "skillSelection": text }`, or `{}` for none.
    pub(crate) selections: Mutex<Vec<Value>>,
    /// Per turn, its kind.
    pub(crate) kinds: Mutex<Vec<TurnKind>>,
    /// The agents below the worker as `(session, parent)`, in the order Node linked them.
    children: Vec<(String, String)>,
    /// The sessions whose close does not land (`tree.failClose`).
    fail_close: Vec<String>,
    /// What the tree's cancel answered, or the text it failed with (`treeCancel`).
    pub(crate) tree_cancel: Mutex<Value>,
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
        lock(&self.0.messages).iter().skip(start).filter_map(|row| row.clone()).map(|content| AssistantText { content, replay: String::new() }).collect()
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
        lock(&self.0.selections).push(request.skill_selection.as_ref().map_or_else(|| json!({}), |text| json!({ "skillSelection": text })));
        lock(&self.0.kinds).push(request.kind);
        let n = self.0.asks.fetch_add(1, SeqCst) + 1;
        self.0.in_flight.fetch_add(1, SeqCst);
        if self.0.hold_ask.contains(&n) {
            self.0.hold(n).notified().await;
        }
        let result = self.script(&request).await;
        self.0.in_flight.fetch_sub(1, SeqCst);
        result
    }
    fn unload_runtime(&self, _: &str, reason: &str) {
        log(&self.0.log, json!(format!("unload:{reason}")));
    }
}
impl Sess {
    async fn script(&self, request: &TurnRequest) -> Result<TurnResult, TurnError> {
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
            } else if let Some(message) = step.get("wakeTaken").and_then(Value::as_str) {
                // The session refused a wake: another turn of the worker took its completions.
                return Err(TurnError { message: message.to_owned(), wake_taken: true, ..TurnError::default() });
            } else if let Some(text) = step.get("say").and_then(Value::as_str) {
                lock(&self.0.messages).push(Some(text.to_owned()));
            } else if let Some(reason) = step.get("cancelTask").and_then(Value::as_str) {
                let id = self.0.board.list_jobs(&Scope::default()).first().map(|j| j.task_id.clone()).unwrap();
                self.0.board.cancel(&id, reason, CancelNotice::Default);
            } else if let Some(reason) = step.get("cancelTree").and_then(Value::as_str) {
                // The entry `agent close` and the owner's teardown run: the session and the agents below it close, each after its jobs.
                let session = s(&lock(&self.0.session), "id");
                let outcome = cancel_agent_tree(&Closer(self.0.clone()), &self.0.board, &session, reason, CloseOptions::default()).await;
                *lock(&self.0.tree_cancel) = match outcome {
                    Ok(closed) => json!({ "returned": closed, "threw": null }),
                    Err(message) => json!({ "returned": null, "threw": message }),
                };
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
    async fn close_turn(&self, id: &str, turn: &str, reason: &str) -> bool {
        log(&self.0.log, json!(format!("close-turn:{id}:{turn}:{reason}")));
        true
    }
    async fn try_close_session(&self, id: &str, reason: &str, options: CloseOptions) -> Result<bool, String> {
        let closed = self.close_session(id, reason, options).await;
        if self.0.fail_close.iter().any(|failing| failing == id) {
            return Err(format!("agent session {id} could not be durably closed"));
        }
        Ok(closed)
    }
    async fn descendant_session_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn child_session_ids(&self, parent: &str) -> Vec<String> {
        self.0.children.iter().filter(|(_, p)| p == parent).map(|(id, _)| id.clone()).collect()
    }
    fn clear_statusline_route(&self, _: &str) {}
    async fn hide_sessions(&self, hides: &[mixdog_agent::agent_tool::host::Hide]) -> Vec<mixdog_tools::orch::agent::HideFailed> {
        lock(&self.0.hidden).extend(hides.iter().map(|hide| hide.session_id.clone()));
        Vec::new()
    }
    async fn reveal_session(&self, id: &str) {
        lock(&self.0.hidden).remove(id);
        log(&self.0.revealed, json!(id));
    }
    async fn is_hidden(&self, id: &str) -> bool {
        lock(&self.0.hidden).contains(id)
    }
}

struct Slot;

/// A slot that hands nothing back: the task just runs.
struct Immediate;

pub(crate) struct Open;
#[async_trait]
impl Admission for Open {
    async fn acquire(&self, _: &str, _: Option<&str>, cancel: &mixdog_agent::cancel::Cancel) -> Result<Box<dyn Lease>, String> {
        if cancel.is_aborted() {
            return Err("agent task cancelled before resource admission".into());
        }
        Ok(Box::new(Slot))
    }
}

/// Every start a job starter recorded, as (tool call, task) pairs.
static RECORDED_STARTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

pub(crate) struct NoStarts;
impl TaskStarts for NoStarts {
    fn record(&self, call: &str, task: &str) {
        lock(&RECORDED_STARTS).push((call.to_owned(), task.to_owned()));
    }
}

/// A world whose agent reports what its todo list leaves undone, named by the session it is asked about.
struct Todo(Sess);
#[async_trait]
impl TurnSessions for Todo {
    async fn message_count(&self, session_id: &str) -> usize {
        self.0.message_count(session_id).await
    }
    async fn assistant_texts(&self, session_id: &str, start: usize) -> Vec<AssistantText> {
        self.0.assistant_texts(session_id, start).await
    }
    fn not_done_report(&self, session_id: &str) -> String {
        format!("Not done: {session_id}")
    }
    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        self.0.run_turn(request).await
    }
    fn unload_runtime(&self, session_id: &str, reason: &str) {
        self.0.unload_runtime(session_id, reason)
    }
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
pub(crate) struct Reg(pub(crate) Arc<Shared>);
#[async_trait]
impl Registry for Reg {
    async fn resolve_tombstone_owners(&self) {}
    async fn refresh_tags_from_sessions(&self, _: bool, _: &Scope) -> Result<(), String> {
        log(&self.0.log, json!("refresh"));
        Ok(())
    }
    async fn resolve_tag(&self, tag: &str, _: &Scope, options: ResolveOptions) -> Result<Option<String>, String> {
        log(&self.0.log, json!(format!("resolveTag:{tag}:{}", options.scan_sessions)));
        match lock(&self.0.tags).get(tag).map(String::as_str) {
            Some("THROW") => Err(format!("tag \"{tag}\" is ambiguous")),
            other => Ok(other.map(str::to_owned)),
        }
    }
    async fn live_session(&self, _: &str) -> Option<SessionFacts> {
        None
    }
    fn tag_session(&self, _: &str) -> Option<String> {
        None
    }
    fn has_tag_agent(&self, _: &str) -> bool {
        false
    }
    async fn tag_for_session(&self, _: &str) -> Option<String> {
        Some("scout".into())
    }
    fn unbind_tag(&self, _: &str) {}
    async fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
    fn forget_terminal_session(&self, tag: Option<&str>, session_id: &str) {
        log(&self.0.log, json!(format!("forget:{}:{session_id}", tag.unwrap_or_default())));
    }
    fn remove_worker_row(&self, _: &str) {}
    /// This registry's writes are its store: what it released is there when the call returns.
    fn release_closed_at(
        &self,
        scope: &Scope,
        tag: Option<&str>,
        root: &str,
        descendants: &[String],
        at: Option<&std::collections::HashMap<String, Option<mixdog_agent::agent_tool::host::TurnMark>>>,
    ) -> mixdog_agent::agent_tool::host::Released {
        use mixdog_agent::agent_tool::host::{Release, ReleaseOutcome, Released};
        self.release_closed(scope, tag, root, descendants);
        let turn = |id: &str| at.and_then(|at| at.get(id)).cloned().flatten();
        let releases = std::iter::once(root.to_owned())
            .chain(descendants.iter().cloned())
            .map(|id| Release::answered(id.clone(), tag.filter(|_| id == root).map(str::to_owned), turn(&id), ReleaseOutcome::Stored))
            .collect();
        Released { releases, spared: Vec::new() }
    }
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
    async fn last_tag_session(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    async fn resumable_tag_session(&self, _: &str, _: &str, _: &Scope) -> Result<Option<Resumable>, String> {
        Ok(None)
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

pub(crate) struct NoWorkers;
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
        if self.host["agent"]["stallCandidates"] == true {
            std::future::pending::<()>().await;
        }
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
    async fn delegation(&self, _: &str) -> Delegation {
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
    async fn session(&self, id: &str) -> Option<Value> {
        Some(lock(&self.shared.session).clone()).filter(|session| session["id"] == id)
    }
    async fn surface_runs(&self, _: &Value) -> bool {
        self.scenario["surface"] == "canonical"
    }
    fn canonical_surface(&self) -> bool {
        self.scenario["surface"] == "canonical"
    }
    async fn is_busy(&self, _: &str) -> bool {
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

pub(crate) struct Rig {
    pub(crate) shared: Arc<Shared>,
    pub(crate) spawn: Arc<SpawnFlowImpl>,
    pub(crate) send: Arc<SendFlowImpl>,
    /// The assembled agent tool: its `handle` is the tool's own entry.
    pub(crate) runtime: Arc<AgentRuntime>,
}

/// The catalog a scenario's `catalog` rows describe (the model picker's rows, as recorded).
struct RecordedCatalog(Vec<Value>);
#[async_trait]
impl ModelCatalog for RecordedCatalog {
    async fn list(&self, _: ModelListOptions) -> Result<Vec<ModelRow>, String> {
        Ok(self
            .0
            .iter()
            .map(|r| ModelRow {
                provider: s(r, "provider"),
                id: s(r, "id"),
                display: s(r, "display"),
                catalog_complete: r["catalogComplete"] == true,
                row: r.clone(),
            })
            .collect())
    }
}

fn stopped_shells(host: Option<&Value>) -> Option<StoppedShellJobs> {
    let names = |key: &str| -> Vec<String> {
        host.and_then(|h| h.pointer(&format!("/stoppedShellJobs/{key}")))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default()
    };
    host.and_then(|h| h.get("stoppedShellJobs")).map(|_| StoppedShellJobs { stopped: names("stopped"), stopping: names("stopping") })
}

pub(crate) fn rig(scenario: &Value, host: Option<&Value>) -> Rig {
    let clock: Arc<dyn Clock> = Arc::new(FixedClock);
    // The board delivers through the shared state, which holds the board: build the state first
    // with a placeholder board, then the board over the state.
    let placeholder = JobBoard::new(clock.clone(), None, None);
    let config = scenario["config"].as_object().cloned().unwrap_or_default();
    let tags: HashMap<String, String> =
        scenario["tags"].as_object().map(|t| t.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()).unwrap_or_default();
    let session = if scenario.get("session").is_some() {
        scenario["session"].clone()
    } else {
        json!({ "id": "sess_w1", "cwd": "/work", "parentSessionId": "lead", "ownerSessionId": "lead" })
    };
    let mut shared = Shared {
        log: Arc::default(),
        notices: Arc::default(),
        revealed: Arc::default(),
        hidden: Mutex::default(),
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
        selections: Mutex::default(),
        kinds: Mutex::default(),
        children: scenario["tree"]["children"].as_array().map(|rows| rows.iter().map(|c| (s(c, "id"), s(c, "parent"))).collect()).unwrap_or_default(),
        fail_close: scenario["tree"]["failClose"].as_array().map(|ids| ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
        tree_cancel: Mutex::new(Value::Null),
    };
    // The notifier needs the state (its notices); give it its own handle to the same lists.
    let notices = shared.notices.clone();
    let delivered = Arc::new(DeliveredTo(notices));
    shared.board = JobBoard::new(clock.clone(), Some(delivered), None);
    let shared = Arc::new(shared);
    let board = shared.board.clone();
    board.set_error_text(Arc::new(PresentedErrorText));

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
        catalog: scenario["catalog"].as_array().map(|rows| Arc::new(RecordedCatalog(rows.clone())) as Arc<dyn ModelCatalog>),
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
#[async_trait]
impl TerminalTrace for NoTrace {
    async fn has_terminal_trace(&self, _: &str, _: &Scope) -> Result<bool, String> {
        Ok(false)
    }
    async fn reap_terminal_trace_for_tag(&self, _: &str, _: &Scope) {}
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
    if let Some(enabled) = meta.effort_auto {
        out.insert("effortAuto".into(), json!(enabled.as_bool()));
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

/// The file and image parts the agent tool resolved from a call's `attachments`.
pub(crate) fn resolved_parts() -> Vec<Value> {
    vec![
        json!({ "type": "file", "attachmentRef": "a".repeat(64), "sizeBytes": 12, "mimeType": "application/pdf", "filename": "spec.pdf" }),
        json!({ "type": "image", "attachmentRef": "b".repeat(64), "sizeBytes": 34, "mimeType": "image/png", "filename": "shot.png" }),
    ]
}

/// The worker's turn text and parts, from the recorded `ask`.
pub(crate) fn asked(rig: &Rig) -> Value {
    lock(&rig.shared.log).iter().find(|entry| entry[0] == "ask").map(|entry| entry[1].clone()).expect("the worker's turn ran")
}

#[test]
fn a_contact_agent_may_not_hand_work_to_itself() {
    use mixdog_agent::agent_tool::flow::spawn::assert_bot_chain_target;
    // Node's text, from `assertBotChainTarget` (`runtime/shared/bot-hops.mjs`).
    let message = assert_bot_chain_target("robot", &[], "robot", "agent spawn").unwrap_err();
    assert_eq!(message, "agent spawn: the contact agent \"robot\" cannot hand work to itself; do it yourself or delegate to a sub-agent");
    assert_eq!(assert_bot_chain_target("", &["x".into()], "x", "agent spawn"), Ok(()));
}

/// Closes recorded with their options, the turn closes with their turn, and a signal when one arrives. A turn close
/// waits for `hold`, when one is set, before it ends.
#[derive(Default)]
pub(crate) struct RecordedCloses {
    pub(crate) calls: Mutex<Vec<(String, String, bool, bool)>>,
    pub(crate) turns: Mutex<Vec<(String, String, String)>>,
    hold: Mutex<Option<Arc<tokio::sync::Notify>>>,
    ended: std::sync::atomic::AtomicUsize,
    arrived: tokio::sync::Notify,
    hidden: Mutex<std::collections::HashSet<String>>,
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
    async fn close_turn(&self, id: &str, turn: &str, reason: &str) -> bool {
        lock(&self.turns).push((id.to_owned(), turn.to_owned(), reason.to_owned()));
        self.arrived.notify_one();
        let hold = lock(&self.hold).clone();
        if let Some(hold) = hold {
            hold.notified().await;
        }
        self.ended.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        true
    }
    async fn descendant_session_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn clear_statusline_route(&self, _: &str) {}
    async fn hide_sessions(&self, hides: &[mixdog_agent::agent_tool::host::Hide]) -> Vec<mixdog_tools::orch::agent::HideFailed> {
        lock(&self.hidden).extend(hides.iter().map(|hide| hide.session_id.clone()));
        Vec::new()
    }
    async fn reveal_session(&self, id: &str) {
        lock(&self.hidden).remove(id);
    }
    async fn is_hidden(&self, id: &str) -> bool {
        lock(&self.hidden).contains(id)
    }
}

/// What a board's notifier is told, with the hop each completion is delivered at.
#[derive(Default)]
struct HopsSeen(Mutex<Vec<(String, u32)>>);
#[async_trait]
impl TaskNotifier for HopsSeen {
    async fn finished(&self, _: &ThreadId, _: &str, task_id: &str, _: &str, _: String) {
        lock(&self.0).push((task_id.to_owned(), 0));
    }
    async fn finished_at_hop(&self, _: &ThreadId, _: &str, task_id: &str, _: &str, _: String, hop: u32) {
        lock(&self.0).push((task_id.to_owned(), hop));
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
pub(crate) fn backend() {
    mixdog_rt::testing::tokens();
}
pub(crate) async fn settle() {
    for _ in 0..8 {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(15)).await;
    }
}
#[async_trait]
impl Lease for Slot {
    async fn release(self: Box<Self>) {}
    fn yielder(&self) -> std::sync::Arc<dyn mixdog_agent::env::Yielder> {
        std::sync::Arc::new(Immediate)
    }
}
#[async_trait]
impl mixdog_agent::env::Yielder for Immediate {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, _: Option<&mixdog_agent::cancel::Cancel>) -> Result<(), String> {
        task.await;
        Ok(())
    }
}
/// The agent port's own entry with the resolved parts, as `AgentTool::call` hands them over.
pub(crate) async fn execute_with_parts(rig: &Rig, args: Value) {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_protocol::ToolCallId;
    use mixdog_tools::orch::agent::{AgentPort, AgentRequest};
    use tokio_util::sync::CancellationToken;
    let (thread, call, cwd, cancel) = (ThreadId::from("lead"), ToolCallId::from("call"), AbsPath::new(std::env::temp_dir()).unwrap(), CancellationToken::new());
    let request = AgentRequest { thread: &thread, call: &call, args, attachment_parts: resolved_parts(), cwd: &cwd, cancel: &cancel };
    rig.runtime.execute(request).await.expect("the agent port answers");
    settle().await;
    settle().await;
}
type NoResult = Result<Option<mixdog_agent::agent_tool::flow::result::WorkerResult>, String>;

fn job_turn(turn: &str) -> Option<mixdog_agent::agent_tool::flow::reconcile::JobTurn> {
    Some(mixdog_agent::agent_tool::flow::reconcile::JobTurn { session_id: "sess_w1".into(), turn_id: turn.into() })
}

/// `job-start.mjs`: cancelling an agent job closes the turn it submitted with reason `agent-task-cancel` (the host
/// builds the turn's `Session "<id>" closed: closeSession (reason=agent-task-cancel)` text from that reason). The
/// close names that turn: the session itself is not closed, so nothing else that runs on it is reached.
#[tokio::test]
async fn cancelling_an_agent_job_closes_the_turn_it_submitted_with_the_cancel_reason() {
    backend();
    let rig = rig(&json!({}), None);
    let closes = Arc::new(RecordedCloses::default());
    let starter =
        JobStarter::new(rig.shared.board.clone(), closes.clone(), Arc::new(Sess(rig.shared.clone())), Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
    let meta = JobMeta { session_id: Some("sess_w1".into()), ..JobMeta::default() };
    let running = Arc::new(tokio::sync::Notify::new());
    let began = running.clone();
    starter
        .start_job("agent", meta, Default::default(), move |job, _| async move {
            job.set_turn(job_turn("turn-1"));
            began.notify_one();
            std::future::pending::<NoResult>().await
        })
        .expect("started");
    running.notified().await;
    let id = rig.shared.board.list_jobs(&Scope::default()).first().map(|j| j.task_id.clone()).expect("job");
    rig.shared.board.cancel(&id, "user cancelled", CancelNotice::Default);
    closes.arrived.notified().await;
    assert_eq!(*lock(&closes.turns), [("sess_w1".to_owned(), "turn-1".to_owned(), "agent-task-cancel".to_owned())]);
    assert!(lock(&closes.calls).is_empty(), "the session is not closed: {:?}", lock(&closes.calls));
    assert_eq!(
        mixdog_agent::cancel::close_session_reason("sess_w1", "agent-task-cancel"),
        "Session \"sess_w1\" closed: closeSession (reason=agent-task-cancel)"
    );
}

/// A cancelled job has nothing on its session before it submitted a turn and once its turn is over: the cancellation
/// closes nothing then, whatever runs on the session. A turn it submits after the cancellation is closed as it starts.
#[tokio::test(start_paused = true)]
async fn a_cancelled_job_closes_nothing_before_its_turn_started_or_after_it_ended() {
    backend();
    let rig = rig(&json!({}), None);
    let closes = Arc::new(RecordedCloses::default());
    let starter =
        JobStarter::new(rig.shared.board.clone(), closes.clone(), Arc::new(Sess(rig.shared.clone())), Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
    let meta = || JobMeta { session_id: Some("sess_w1".into()), ..JobMeta::default() };

    // Before: the job is still reading the session when it is cancelled, and submits afterwards.
    let submit = Arc::new(tokio::sync::Notify::new());
    let go = submit.clone();
    let early = starter
        .start_job("send", meta(), Default::default(), move |job, _| async move {
            go.notified().await;
            job.set_turn(job_turn("turn-late"));
            std::future::pending::<NoResult>().await
        })
        .expect("started");
    settle().await;
    rig.shared.board.cancel(early.task_id(), "user cancelled", CancelNotice::Default);
    settle().await;
    assert!(lock(&closes.turns).is_empty() && lock(&closes.calls).is_empty(), "nothing of the job runs on the session yet");
    submit.notify_one();
    settle().await;
    assert_eq!(*lock(&closes.turns), [("sess_w1".to_owned(), "turn-late".to_owned(), "agent-task-cancel".to_owned())]);

    // After: its turn ended and the job is collecting its report when it is cancelled.
    let late = starter
        .start_job("send", meta(), Default::default(), move |job, _| async move {
            job.set_turn(job_turn("turn-done"));
            job.set_turn(None);
            std::future::pending::<NoResult>().await
        })
        .expect("started");
    settle().await;
    rig.shared.board.cancel(late.task_id(), "user cancelled", CancelNotice::Default);
    settle().await;
    assert_eq!(lock(&closes.turns).len(), 1, "the ended turn is not closed: {:?}", lock(&closes.turns));
    assert!(lock(&closes.calls).is_empty(), "and the session is never closed: {:?}", lock(&closes.calls));
}

/// A close that began is carried to its end: the job's work ending first does not drop it halfway.
#[tokio::test(start_paused = true)]
async fn a_cancelled_jobs_close_ends_though_its_work_ends_first() {
    backend();
    let rig = rig(&json!({}), None);
    let closes = Arc::new(RecordedCloses::default());
    let hold = Arc::new(tokio::sync::Notify::new());
    *lock(&closes.hold) = Some(hold.clone());
    let starter =
        JobStarter::new(rig.shared.board.clone(), closes.clone(), Arc::new(Sess(rig.shared.clone())), Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
    let finish = Arc::new(tokio::sync::Notify::new());
    let end = finish.clone();
    let job = starter
        .start_job("send", JobMeta { session_id: Some("sess_w1".into()), ..JobMeta::default() }, Default::default(), move |job, _| async move {
            job.set_turn(job_turn("turn-1"));
            end.notified().await;
            Ok::<_, String>(None)
        })
        .expect("started");
    settle().await;
    rig.shared.board.cancel(job.task_id(), "user cancelled", CancelNotice::Default);
    closes.arrived.notified().await;
    finish.notify_one();
    settle().await;
    let ended = || closes.ended.load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(ended(), 0, "the close is still under way");
    hold.notify_one();
    settle().await;
    assert_eq!(ended(), 1, "the close that began reached its end");
}

/// Admits the first job and holds every other until it is cancelled.
#[derive(Default)]
struct FirstOnly {
    taken: std::sync::atomic::AtomicBool,
    waiting: tokio::sync::Notify,
    left: tokio::sync::Notify,
}
#[async_trait]
impl Admission for FirstOnly {
    async fn acquire(&self, _: &str, _: Option<&str>, cancel: &mixdog_agent::cancel::Cancel) -> Result<Box<dyn Lease>, String> {
        if !self.taken.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Ok(Box::new(Slot));
        }
        self.waiting.notify_one();
        cancel.cancelled().await;
        self.left.notify_one();
        Err("agent task cancelled before resource admission".into())
    }
}

/// A job cancelled while it waits for admission started no turn: the session it was to run on, where another job's turn
/// runs, is not closed.
#[tokio::test]
async fn cancelling_a_job_that_has_not_started_closes_no_session() {
    backend();
    let rig = rig(&json!({}), None);
    let closes = Arc::new(RecordedCloses::default());
    let admission = Arc::new(FirstOnly::default());
    let starter =
        JobStarter::new(rig.shared.board.clone(), closes.clone(), Arc::new(Sess(rig.shared.clone())), admission.clone(), Arc::new(NoStarts), Arc::new(|| {}));
    let meta = || JobMeta { session_id: Some("sess_w1".into()), ..JobMeta::default() };
    let running = Arc::new(tokio::sync::Notify::new());
    let began = running.clone();
    starter
        .start_job("send", meta(), Default::default(), move |_, _| async move {
            began.notify_one();
            std::future::pending::<NoResult>().await
        })
        .expect("started");
    running.notified().await;
    let waiting = starter.start_job("send", meta(), Default::default(), |_, _| async { NoResult::Ok(None) }).expect("started");
    admission.waiting.notified().await;
    rig.shared.board.cancel(waiting.task_id(), "user cancelled", CancelNotice::Default);
    admission.left.notified().await;
    assert!(lock(&closes.calls).is_empty(), "the session keeps the turn running on it: {:?}", lock(&closes.calls));
}
/// `agent close` of an agent that has agents below it (`closeSession` is `cancelAgentTree`): the agents below close first,
/// after the jobs bound to them, and the owner's job is cancelled with the close's reason.
#[tokio::test(start_paused = true)]
async fn closing_an_agent_closes_the_agents_below_it_and_cancels_their_jobs() {
    backend();
    let rig = rig(&json!({ "tree": { "children": [{ "id": "sess_c1", "parent": "sess_w1" }] } }), None);
    let starter = JobStarter::new(
        rig.shared.board.clone(),
        Arc::new(Closer(rig.shared.clone())),
        Arc::new(Sess(rig.shared.clone())),
        Arc::new(Open),
        Arc::new(NoStarts),
        Arc::new(|| {}),
    );
    let meta = JobMeta { tag: Some("kid".into()), session_id: Some("sess_c1".into()), ..JobMeta::default() };
    let start = StartContext { caller_session_id: Some("sess_w1".into()), ..StartContext::default() };
    let handle = starter.start_job("spawn", meta, start, |_, _| std::future::pending::<NoResult>()).expect("started");
    settle().await;
    let registry = Reg(rig.shared.clone());
    let closer = Closer(rig.shared.clone());
    let parts = CloseParts { registry: &registry, sessions: &closer, tasks: &rig.shared.board };
    let view = close_resolved(parts, "sess_w1", "sess_w1", &Scope::default(), None, false).await.expect("closes");
    assert!(view.closed);
    settle().await;
    // The cancelled job submitted no turn: it closes nothing of its own, and the tree's closes are the only ones.
    let closes: Vec<Value> = lock(&rig.shared.log).iter().filter(|entry| entry.as_str().is_some_and(|e| e.starts_with("close"))).cloned().collect();
    assert_eq!(closes, [json!("close:sess_c1:cli-agent-close"), json!("close:sess_w1:cli-agent-close")]);
    let job = rig.shared.board.get(handle.task_id(), &Scope::default()).unwrap();
    assert_eq!((job.status.as_str(), job.error.as_deref()), ("cancelled", Some("cli-agent-close")));
}
/// A spawn has no session when it starts and gets one while it runs: its report names what that agent's todo list leaves undone.
#[tokio::test(start_paused = true)]
async fn a_spawns_report_names_what_its_todo_list_leaves_undone() {
    backend();
    let rig = rig(&json!({}), None);
    let starter = JobStarter::new(
        rig.shared.board.clone(),
        Arc::new(Closer(rig.shared.clone())),
        Arc::new(Todo(Sess(rig.shared.clone()))),
        Arc::new(Open),
        Arc::new(NoStarts),
        Arc::new(|| {}),
    );
    let meta = JobMeta { tag: Some("scout".into()), ..JobMeta::default() };
    let start = StartContext { caller_session_id: Some("lead".into()), ..StartContext::default() };
    let board = rig.shared.board.clone();
    starter
        .start_job("spawn", meta, start, move |job, _| async move {
            board.update_meta(job.task_id(), |meta| meta.session_id = Some("sess_late".into()));
            Ok(Some(mixdog_agent::agent_tool::flow::result::WorkerResult { value: json!({ "content": "done" }), error: None }))
        })
        .expect("started");
    settle().await;
    settle().await;
    let notices = lock(&rig.shared.notices).clone();
    assert!(notices.iter().any(|n| n["text"].as_str().is_some_and(|t| t.contains("Not done: sess_late"))), "{notices:?}");
}
/// A job started by a turn at a bot-chain hop is delivered at it: the owner's completion returns at the hop of the turn that
/// started the job (`toolCompletionMeta`, `ctx.hop`); a job started outside a chain is told at none.
#[tokio::test(start_paused = true)]
async fn a_job_started_at_a_hop_completes_at_that_hop() {
    backend();
    let rig = rig(&json!({}), None);
    let seen = Arc::new(HopsSeen::default());
    let board = JobBoard::new(Arc::new(FixedClock), Some(seen.clone()), None);
    let starter =
        JobStarter::new(board, Arc::new(Closer(rig.shared.clone())), Arc::new(Sess(rig.shared.clone())), Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
    let done = |_: Arc<mixdog_agent::agent_tool::flow::reconcile::JobHandle>, _: mixdog_agent::agent_tool::flow::notify::NotifyContext| async {
        Ok::<_, String>(Some(mixdog_agent::agent_tool::flow::result::WorkerResult { value: json!({ "content": "done" }), error: None }))
    };
    let hopped = starter
        .start_job("spawn", JobMeta::default(), StartContext { caller_session_id: Some("lead".into()), hop: Some(json!(3)), ..StartContext::default() }, done)
        .expect("started");
    let plain = starter
        .start_job("spawn", JobMeta::default(), StartContext { caller_session_id: Some("lead".into()), ..StartContext::default() }, done)
        .expect("started");
    settle().await;
    settle().await;
    let told = lock(&seen.0).clone();
    assert!(told.contains(&(hopped.task_id().to_owned(), 3)), "{told:?}");
    assert!(told.contains(&(plain.task_id().to_owned(), 0)), "{told:?}");
}

// ---- the flows with their world written out -----------------------------------------------------------------------------------

fn world_config() -> Value {
    json!({
        "default": "main-preset",
        "presets": [{ "id": "main-preset", "name": "MAIN", "provider": "anthropic", "model": "opus", "effort": "high" }],
        "agents": { "worker": { "provider": "openai", "model": "gpt-5", "effort": "medium" } },
    })
}

/// A worker agent `worker` on its own route; the worker's turn calls a tool, then answers `answer`.
fn spawn_world(answer: &str) -> (Value, Value) {
    let scenario = json!({
        "args": { "agent": "worker", "prompt": "do it", "tag": "scout" }, "callerCwd": "/work",
        "context": { "callerSessionId": "lead", "ownerSessionId": "lead", "clientHostPid": 4242, "cwd": "/work" },
        "respawned": false, "config": world_config(), "tags": {}, "nextTag": "worker-1", "lock": null, "lockOwner": "lead", "owner": "lead",
        "window": null, "ensureThrows": null, "effectiveCwd": null, "createThrows": null, "cancel": null,
        "steps": [{ "tool": "diff-1" }, { "terminal": { "content": answer } }, { "return": { "content": answer } }], "canonical": true,
    });
    let host = json!({
        "agent": { "name": "worker", "defined": true, "disabled": false, "kind": null, "contact": false, "permission": null,
            "candidates": [{ "provider": "openai", "model": "gpt-5", "effort": "medium" }] },
        "delegation": { "chain": ["lead"], "acting": "lead" },
    });
    (scenario, host)
}

/// A live worker `scout` on `sess_w1`, idle, that answers `answer` to a send.
fn send_world(op: &str, answer: &str) -> Value {
    json!({
        "op": op, "args": { "tag": "scout", "prompt": "follow up" },
        "session": { "id": "sess_w1", "agent": "worker", "provider": "openai", "model": "gpt-5", "cwd": "/work", "parentSessionId": "lead",
            "ownerSessionId": "lead", "clientHostPid": 4242, "messages": [{ "role": "user", "content": "earlier" }] },
        "surface": "process", "busy": false, "noPending": false, "pendingDepth": 1, "enqueueReturns": null, "afterSetRoute": null,
        "config": world_config(), "tags": { "scout": "sess_w1" }, "noCaller": false, "extras": {}, "route": null,
        "steps": [{ "tool": "diff-1" }, { "terminal": { "content": answer } }, { "return": { "content": answer } }],
    })
}

fn caller_context() -> SpawnContext {
    SpawnContext {
        caller_session_id: Some("lead".into()),
        session_id: None,
        owner_session_id: Some("lead".into()),
        client_host_pid: Some(4242),
        ..SpawnContext::default()
    }
}

#[tokio::test(start_paused = true)]
async fn a_spawn_runs_the_worker_on_its_agents_route_and_tells_the_caller_when_it_is_done() {
    backend();
    let (scenario, host) = spawn_world("done");
    let rig = rig(&scenario, Some(&host));
    let context = caller_context();
    let job = rig.spawn.start_deferred_spawn_job(&scenario["args"], "/work", &context, &context, SpawnOptions { respawned: false }).await.expect("started");
    let task = rig.shared.board.get(job.task_id(), &Scope::default()).unwrap();
    let meta = public_meta(&task.meta, None);
    assert_eq!(
        meta,
        json!({ "tag": "scout", "agent": "worker", "preset": "agent-worker", "provider": "openai", "model": "gpt-5", "effort": "medium", "effortAuto": true })
    );
    settle().await;
    settle().await;
    let state = final_state(&rig, job.task_id(), true);
    assert_eq!((state["status"].as_str(), state["notified"].as_bool()), (Some("completed"), Some(true)));
    assert_eq!(state["result"]["content"], "done");
    let notices = lock(&rig.shared.notices).clone();
    assert!(
        notices.iter().any(|n| n["session"] == "lead" && n["text"].as_str().is_some_and(|t| t.contains("<status>completed</status>") && t.contains("done"))),
        "{notices:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_send_to_an_idle_worker_runs_its_turn_as_a_job_and_tells_the_caller() {
    backend();
    let scenario = send_world("dispatch", "sent");
    let rig = rig(&scenario, None);
    let context = caller_context();
    let session = lock(&rig.shared.session).clone();
    let prepared = Prepared {
        args: scenario["args"].clone(),
        session: SessionFacts { id: "sess_w1".into(), agent: s(&session, "agent"), cwd: s(&session, "cwd"), ..SessionFacts::default() },
        session_id: "sess_w1".into(),
        prompt: Some("follow up".into()),
        route: None,
    };
    let reply = rig.send.dispatch_to_existing_session(&prepared, &context, DispatchOptions::default()).await.expect("dispatched");
    assert!(matches!(reply, AgentReply::Task { .. }), "an idle worker takes the turn at once");
    settle().await;
    settle().await;
    let id = rig.shared.board.list_jobs(&Scope::default()).first().map(|t| t.task_id.clone()).expect("the send's job");
    let state = final_state(&rig, &id, false);
    assert_eq!((state["status"].as_str(), state["result"]["content"].as_str()), (Some("completed"), Some("sent")));
    assert_eq!(asked(&rig), "follow up");
}

#[tokio::test(start_paused = true)]
async fn waking_an_idle_worker_reveals_its_session_and_runs_its_wake_turn_with_an_empty_prompt() {
    backend();
    let mut scenario = send_world("wake", "woken");
    scenario["steps"] = json!([{ "return": { "content": "woken" } }]);
    let rig = rig(&scenario, None);
    rig.send.wake_worker("sess_w1", Box::new(())).await.expect("woken");
    settle().await;
    settle().await;
    assert_eq!(*lock(&rig.shared.revealed), [json!("sess_w1")]);
    assert_eq!(asked(&rig), "");
    assert_eq!(*lock(&rig.shared.kinds), [TurnKind::Wake], "the turn takes the queued completions as its input");
    assert!(rig.send.wake_worker("", Box::new(())).await.is_err(), "no session, no wake");
}

/// A send and a wake of the same worker, both jobs of its owner, run their own turns one after the other: the wake's
/// job waits while the send's turn runs, then asks its own turn.
#[tokio::test(start_paused = true)]
async fn a_send_and_a_wake_of_one_worker_run_their_own_turns_one_after_the_other() {
    backend();
    let mut scenario = send_world("dispatch", "answered");
    scenario["holdAsk"] = json!([1]);
    let rig = rig(&scenario, None);
    let session = lock(&rig.shared.session).clone();
    let prepared = Prepared {
        args: scenario["args"].clone(),
        session: SessionFacts { id: "sess_w1".into(), agent: s(&session, "agent"), cwd: s(&session, "cwd"), ..SessionFacts::default() },
        session_id: "sess_w1".into(),
        prompt: Some("follow up".into()),
        route: None,
    };
    rig.send.dispatch_to_existing_session(&prepared, &caller_context(), DispatchOptions::default()).await.expect("dispatched");
    settle().await;
    rig.send.wake_worker("sess_w1", Box::new(())).await.expect("woken");
    settle().await;
    assert_eq!(*lock(&rig.shared.kinds), [TurnKind::Send], "the wake waits for the send's turn to end");
    let jobs = rig.shared.board.list_jobs(&Scope::default());
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[1].turn_stage.map(|(stage, _)| stage), Some(mixdog_agent::agent_tool::flow::stages::TurnStage::Waiting));
    rig.shared.hold(1).notify_one();
    settle().await;
    settle().await;
    assert_eq!(*lock(&rig.shared.kinds), [TurnKind::Send, TurnKind::Wake]);
    let asks: Vec<Value> = lock(&rig.shared.log).iter().filter(|entry| entry[0] == "ask").map(|entry| entry[1].clone()).collect();
    assert_eq!(asks, [json!("follow up"), json!("")], "each turn is asked its own prompt");
    let jobs = rig.shared.board.list_jobs(&Scope::default());
    assert!(jobs.iter().all(|job| job.operation == "send" && job.status == "completed"), "{jobs:?}");
}

#[tokio::test(start_paused = true)]
async fn the_files_and_images_of_a_call_reach_the_first_turn_of_a_spawn_and_the_turn_of_a_send() {
    backend();
    let (scenario, host) = spawn_world("done");
    let spawned = rig(&scenario, Some(&host));
    execute_with_parts(&spawned, json!({ "type": "spawn", "agent": "worker", "prompt": "do it", "tag": "scout" })).await;
    let sent = rig(&send_world("dispatch", "sent"), None);
    execute_with_parts(&sent, json!({ "type": "send", "tag": "scout", "prompt": "follow up" })).await;
    for (rig, prompt) in [(&spawned, "do it"), (&sent, "follow up")] {
        let content = asked(rig);
        let items = content.as_array().unwrap_or_else(|| panic!("a turn with parts asks with a list: {content}"));
        assert_eq!(items.len(), 3, "the prompt, the file and the image: {content}");
        assert_eq!(items[0]["text"], prompt);
        assert_eq!((items[1]["filename"].as_str(), items[2]["filename"].as_str()), (Some("spec.pdf"), Some("shot.png")));
    }
}

#[tokio::test(start_paused = true)]
async fn a_foreground_run_ends_with_the_workers_answer_and_closes_its_session() {
    backend();
    let (scenario, host) = spawn_world("done");
    let rig = rig(&scenario, Some(&host));
    let cancel = tokio_util::sync::CancellationToken::new();
    let (session, content) = rig.spawn.run_to_completion(&scenario["args"], "/work", &caller_context(), &cancel).await.expect("the run completes");
    assert_eq!(content, "done");
    let session = session.expect("the run's session");
    let closed = lock(&rig.shared.log).iter().any(|entry| *entry == json!(format!("close:{session}:routine-executor-finished")));
    assert!(closed, "the agent's session is closed once the run is over");
}
