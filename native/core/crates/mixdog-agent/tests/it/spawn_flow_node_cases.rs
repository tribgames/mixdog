//! Node's spawn flow cases (`fixtures/spawn-flow-cases`, `record-spawn-flow-cases.mjs`): a job started by the
//! `JobStarter`, a prepared spawn's turn planned by `SpawnFlowImpl::turn_plan` and run by the `TurnRunner`, and the
//! agent close through `close_resolved` over the job board; what each case reads against Node's.
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::dispatch::CloseParts;
use mixdog_agent::agent_tool::dispatch::close_resolved;
use mixdog_agent::agent_tool::flow::early::EarlyNotice;
use mixdog_agent::agent_tool::flow::job_starter::JobStarter;
use mixdog_agent::agent_tool::flow::job_starter::StartContext;
use mixdog_agent::agent_tool::flow::notify::NotifyContext;
use mixdog_agent::agent_tool::flow::reconcile::JobHandle;
use mixdog_agent::agent_tool::flow::result::WorkerResult;
use mixdog_agent::agent_tool::flow::seams::*;
use mixdog_agent::agent_tool::flow::spawn::PreparedSpawn;
use mixdog_agent::agent_tool::flow::spawn::SpawnFlowDeps;
use mixdog_agent::agent_tool::flow::spawn::SpawnFlowImpl;
use mixdog_agent::agent_tool::flow::turn::TurnRunner;
use mixdog_agent::agent_tool::flow::worker_turns::Claim;
use mixdog_agent::agent_tool::flow::worker_turns::TurnOwner;
use mixdog_agent::agent_tool::flow::world::Created;
use mixdog_agent::agent_tool::flow::world::Delegation;
use mixdog_agent::agent_tool::flow::world::SpawnAdmission;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_agent::agent_tool::flow::world::SpawnWorld;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::views::JobViews;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_agent::env::Clock;
use mixdog_ai::service::admin_route::Obj;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        1_772_359_200_000 // 2026-03-01T10:00:00.000Z
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn golden() -> Vec<Value> {
    let path = format!("{}/../../fixtures/spawn-flow-cases/golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    golden["cases"].as_array().unwrap().clone()
}

fn case(kind: &str) -> Vec<Value> {
    golden().into_iter().filter(|c| c["kind"] == kind).collect()
}

/// `value` with each task id written as Node's recording masks it.
fn masked(value: Value, ids: &[String]) -> Value {
    let mut text = value.to_string();
    for id in ids {
        text = text.replace(id.as_str(), "<task>");
    }
    serde_json::from_str(&text).unwrap()
}

/// What Node's owner receives, as far as the core's task notifier carries it: the session, the whole text, and of
/// the meta the surface, task id, status and caller.
fn recorded_deliveries(recorded: &Value) -> Value {
    let rows = recorded["deliveries"].as_array().unwrap().iter().map(|d| {
        let meta = &d["meta"];
        json!({
            "sessionId": d["sessionId"],
            "text": d["text"],
            "meta": { "execution_surface": meta["execution_surface"], "execution_id": meta["execution_id"], "status": meta["status"], "caller_session_id": meta["caller_session_id"] },
        })
    });
    Value::Array(rows.collect())
}

#[derive(Default)]
struct Owner(Mutex<Vec<Value>>);

#[async_trait]
impl TaskNotifier for Owner {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        lock(&self.0).push(json!({
            "sessionId": owner.as_str(),
            "text": notification,
            "meta": { "execution_surface": surface, "execution_id": task_id, "status": status, "caller_session_id": owner.as_str() },
        }));
    }
}

/// The test's fake session manager: the worker's turn appends `partial` (if any) and blocks until its session closes;
/// a skill-selection run answers at once.
#[derive(Default)]
struct World {
    partial: Option<String>,
    messages: Mutex<Vec<Option<String>>>,
    closures: Mutex<Vec<Value>>,
    closed: Notify,
    started: Notify,
    turns: Mutex<Vec<Value>>,
    canonical: bool,
}

struct Turns(Arc<World>);

#[async_trait]
impl TurnSessions for Turns {
    async fn message_count(&self, _: &str) -> usize {
        lock(&self.0.messages).len()
    }
    async fn assistant_texts(&self, _: &str, start: usize) -> Vec<AssistantText> {
        lock(&self.0.messages).iter().skip(start).flatten().map(|content| AssistantText { content: content.clone(), replay: String::new() }).collect()
    }
    fn not_done_report(&self, _: &str) -> String {
        String::new()
    }
    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        let Some(partial) = &self.0.partial else {
            lock(&self.0.turns).push(json!({ "canonical": self.0.canonical, "present": request.skill_selection.is_some(), "value": request.skill_selection }));
            return Ok(TurnResult { content: "ok".into(), iterations: 1, ..TurnResult::default() });
        };
        if !partial.is_empty() {
            lock(&self.0.messages).push(Some(partial.clone()));
        }
        self.0.started.notify_one();
        self.0.closed.notified().await;
        Err(TurnError::new("Session closed: closeSession"))
    }
    fn unload_runtime(&self, _: &str, _: &str) {}
}

#[async_trait]
impl Sessions for Turns {
    async fn rehydrate_agent_sessions(&self) -> bool {
        false
    }
    async fn read_session_handoff(&self, _: &str) -> Option<String> {
        None
    }
    async fn close_session(&self, id: &str, reason: &str, options: CloseOptions) -> bool {
        let mut row = json!({ "tombstone": options.tombstone });
        if options.owner_close {
            row["ownerClose"] = json!(true);
        }
        lock(&self.0.closures).push(json!([id, reason, row]));
        self.0.closed.notify_one();
        true
    }
    fn descendant_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn child_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn clear_statusline_route(&self, _: &str) {}
}

struct NoEvents;
impl SubagentEvents for NoEvents {
    fn start(&self, _: &str, _: &str, _: &str) {}
    fn stop(&self, _: &str, _: &str, _: &str, _: &str) {}
}

struct NoReview;
impl ReviewHandle for NoReview {
    fn complete(&self, _: Vec<String>) {}
}
struct NoReviews;
impl TurnReviews for NoReviews {
    fn begin(&self, _: &str, _: &str, _: &str, _: &str) -> Box<dyn ReviewHandle> {
        Box::new(NoReview)
    }
}

struct NoOwnerNotify;
impl OwnerNotify for NoOwnerNotify {
    fn notify(&self, _: &str, _: &str, _: &Value) -> bool {
        false
    }
}

struct NoInbox;
impl WorkerInbox for NoInbox {
    fn enqueue_completion(&self, _: &str, _: &str, _: &Value) -> bool {
        false
    }
}

struct Slot;
#[async_trait]
impl Lease for Slot {
    async fn release(self: Box<Self>) {}
    fn yielder(&self) -> Arc<dyn mixdog_agent::env::Yielder> {
        Arc::new(Immediate)
    }
}
struct Immediate;
#[async_trait]
impl mixdog_agent::env::Yielder for Immediate {
    async fn run_yielded(&self, task: BoxFuture<'_, bool>, _: Option<&mixdog_agent::cancel::Cancel>) -> Result<(), String> {
        task.await;
        Ok(())
    }
}
struct Open;
#[async_trait]
impl Admission for Open {
    async fn acquire(&self, _: &str, _: Option<&str>, _: &mixdog_agent::cancel::Cancel) -> Result<Box<dyn Lease>, String> {
        Ok(Box::new(Slot))
    }
}
struct NoStarts;
impl TaskStarts for NoStarts {
    fn record(&self, _: &str, _: &str) {}
}

struct Owns;
impl TurnOwner for Owns {
    fn claim(&self, _: &str, _: Option<Arc<JobHandle>>) -> Claim {
        Claim::custom("sub-1".into(), Box::new(|_| {}))
    }
    fn observe(&self, _: &str) -> bool {
        true
    }
}

/// The close flow's registry as the test fakes it: the tag resolves to the worker, a live worker (not a Lead).
struct Reg;
#[async_trait]
impl Registry for Reg {
    fn resolve_tombstone_owners(&self) {}
    async fn refresh_tags_from_sessions(&self, _: bool, _: &Scope) {}
    fn resolve_tag(&self, _: &str, _: &Scope, _: ResolveOptions) -> Result<Option<String>, String> {
        Ok(Some("sess_close_worker".into()))
    }
    fn live_session(&self, _: &str) -> Option<SessionFacts> {
        Some(SessionFacts { agent: "worker".into(), ..SessionFacts::default() })
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
        Some("close-worker".into())
    }
    fn unbind_tag(&self, _: &str) {}
    fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
    fn forget_terminal_session(&self, _: Option<&str>, _: &str) {}
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

/// The session runtime as a prepared spawn's turn sees it: only which surface runs the turn.
struct Surface(bool);
impl SpawnAdmission for Surface {
    fn workspace_cwd_lock(&self, _: &[String]) -> Option<String> {
        None
    }
    fn enter_worker_spawn(&self, _: &[String]) -> Result<Box<dyn Send>, String> {
        Ok(Box::new(()))
    }
}
#[async_trait]
impl SpawnWorld for Surface {
    async fn load_config(&self) -> Result<Obj, String> {
        unreachable!("the spawn is prepared already")
    }
    fn loaded_config(&self) -> Option<Obj> {
        None
    }
    async fn route_candidates(&self, _: &Obj, _: &str) -> Result<Vec<Value>, String> {
        unreachable!()
    }
    async fn agent_defined(&self, _: &str) -> Result<bool, String> {
        unreachable!()
    }
    fn agent_disabled(&self, _: &Obj, _: &str) -> bool {
        unreachable!()
    }
    async fn agent_kind(&self, _: &str) -> Result<Option<String>, String> {
        unreachable!()
    }
    fn is_contact_agent(&self, _: &str, _: Option<&str>) -> bool {
        unreachable!()
    }
    fn delegation(&self, _: &str) -> Delegation {
        unreachable!()
    }
    async fn agent_permission(&self, _: &str) -> Result<Option<Value>, String> {
        unreachable!()
    }
    fn next_tag(&self, _: &str, _: &SpawnContext) -> String {
        unreachable!()
    }
    fn resolve_runtime_spec(&self, _: &Value, _: &str) -> Value {
        unreachable!()
    }
    fn route_window_meta(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn canonical_surface(&self) -> bool {
        self.0
    }
    fn can_create_child(&self) -> bool {
        self.0
    }
    fn prewarm_git_probes(&self, _: &str) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    async fn create_child(&self, _: &Obj, _: &str, _: &str) -> Result<Created, String> {
        unreachable!()
    }
    async fn ensure_provider(&self, _: &Obj, _: &str) -> Result<(), String> {
        unreachable!()
    }
    async fn prepare_session(&self, _: &Obj) -> Result<Created, String> {
        unreachable!()
    }
    fn write_statusline_route(&self, _: &str, _: &Value) {}
    fn bind_tag(&self, _: &str, _: &Value, _: &Obj) {}
    fn prewarm_transport(&self, _: &str, _: &Value) {}
    fn upsert_worker_row(&self, _: &Value, _: &str, _: &Obj) {}
}

struct Rig {
    world: Arc<World>,
    board: JobBoard,
    owner: Arc<Owner>,
    publications: Arc<AtomicUsize>,
    starter: JobStarter,
    runner: Arc<TurnRunner>,
    spawn: SpawnFlowImpl,
}

fn rig(world: World) -> Rig {
    mixdog_rt::testing::tokens();
    let world = Arc::new(world);
    let clock: Arc<dyn Clock> = Arc::new(FixedClock);
    let owner = Arc::new(Owner::default());
    let board = JobBoard::new(clock.clone(), Some(owner.clone()), None);
    let publications = Arc::new(AtomicUsize::new(0));
    let status: Arc<dyn Fn() + Send + Sync> = {
        let publications = publications.clone();
        Arc::new(move || {
            publications.fetch_add(1, Ordering::SeqCst);
        })
    };
    let turns: Arc<dyn TurnSessions> = Arc::new(Turns(world.clone()));
    let sessions: Arc<dyn Sessions> = Arc::new(Turns(world.clone()));
    let early = Arc::new(EarlyNotice::new(Arc::new(NoOwnerNotify), clock.clone()));
    let runner = Arc::new(TurnRunner::new(turns.clone(), Arc::new(Owns), Arc::new(NoReviews), Arc::new(NoEvents), Arc::new(NoInbox), early));
    let starter = JobStarter::new(board.clone(), sessions.clone(), turns.clone(), Arc::new(Open), Arc::new(NoStarts), status.clone());
    let registry: Arc<dyn Registry> = Arc::new(Reg);
    let surface = Arc::new(Surface(world.canonical));
    let spawn = SpawnFlowImpl::new(SpawnFlowDeps {
        world: surface.clone(),
        admission: surface,
        registry: registry.clone(),
        sessions,
        env: Arc::new(Env),
        board: board.clone(),
        views: Arc::new(JobViews::new(board.clone(), registry, Arc::new(NoWorkers), clock.clone())),
        starter: Arc::new(JobStarter::new(board.clone(), Arc::new(Turns(world.clone())), turns, Arc::new(Open), Arc::new(NoStarts), status.clone())),
        runner: runner.clone(),
        clock,
        status_changed: status,
        default_cwd: "/default".into(),
        mcp_scope_id: None,
    });
    Rig { world, board, owner, publications, starter, runner, spawn }
}

fn prepared(args: Value, tag: &str, session: &str, prompt: &str) -> PreparedSpawn {
    PreparedSpawn {
        args,
        tag: tag.into(),
        session: json!({ "id": session }),
        agent: "worker".into(),
        preset: json!({ "provider": "test-provider", "model": "test-model" }),
        preset_name: json!("worker-route"),
        worker_cwd: "C:\\Project\\tree".into(),
        prompt: prompt.into(),
    }
}

async fn settle() {
    for _ in 0..8 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

fn sort_closures(value: &mut Value) {
    value["closures"].as_array_mut().unwrap().sort_by_key(Value::to_string);
}

fn lead(id: &str) -> StartContext {
    StartContext { caller_session_id: Some(id.into()), client_host_pid: Some(u64::from(std::process::id())), ..StartContext::default() }
}

#[tokio::test]
async fn a_jobs_status_is_published_at_start_and_once_settled_as_in_node() {
    let case = &case("status")[0];
    let rig = rig(World::default());
    let meta = JobMeta { tag: Some("status-test".into()), ..JobMeta::default() };
    let job = rig
        .starter
        .start_job("spawn", meta, lead("lead-test"), |_, _| async { Ok(Some(WorkerResult { value: json!({ "content": "done" }), error: None })) })
        .unwrap();
    let at_start = json!({ "status": job.status(), "publications": rig.publications.load(Ordering::SeqCst) });
    rig.board.wait_terminal(job.task_id()).await;
    settle().await;
    let settled = json!({ "status": job.status(), "publications": rig.publications.load(Ordering::SeqCst) });
    assert_eq!(json!({ "atStart": at_start, "settled": settled }), case["recorded"], "{}", case["case"]);
}

#[tokio::test]
async fn a_jobs_completion_goes_to_its_caller_once_as_in_node() {
    let case = &case("owner")[0];
    let rig = rig(World::default());
    let meta = JobMeta { tag: Some("owner-test".into()), ..JobMeta::default() };
    let job = rig
        .starter
        .start_job("spawn", meta, lead("lead-owner"), |_, _| async { Ok(Some(WorkerResult { value: json!({ "content": "owner handoff" }), error: None })) })
        .unwrap();
    rig.board.wait_terminal(job.task_id()).await;
    settle().await;
    // The core's start context holds no routing id and no notify callback: nothing stale can be called.
    let got = masked(json!({ "status": job.status(), "staleCalls": 0, "deliveries": *lock(&rig.owner.0) }), &[job.task_id().to_owned()]);
    let want = json!({ "status": case["recorded"]["status"], "staleCalls": case["recorded"]["staleCalls"], "deliveries": recorded_deliveries(&case["recorded"]) });
    assert_eq!(got, want, "{}", case["case"]);
}

#[tokio::test]
async fn a_spawns_skill_selection_reaches_the_workers_turn_as_in_node() {
    let case = &case("skills")[0];
    let mut turns = Vec::new();
    for run in case["runs"].as_array().unwrap() {
        let rig = rig(World { canonical: run["canonical"] == true, ..World::default() });
        let plan = rig.spawn.turn_plan(&prepared(run["args"].clone(), "sel-worker", "sess_sel_worker", "task with $payload-skill"));
        let context = NotifyContext { caller_session_id: Some("x".into()), ..NotifyContext::default() };
        rig.runner.run(plan, Some(context), None).await.unwrap();
        turns.extend(lock(&rig.world.turns).drain(..));
    }
    assert_eq!(json!({ "turns": turns }), case["recorded"], "{}", case["case"]);
}

#[tokio::test]
async fn closing_a_running_agent_tells_its_owner_once_as_cancelled_as_in_node() {
    for case in case("close") {
        let partial = case["partial"].as_str().unwrap().to_owned();
        let rig = rig(World { partial: Some(partial), messages: Mutex::new(vec![None]), ..World::default() });
        let world = rig.world.clone();
        let plan = rig.spawn.turn_plan(&prepared(json!({}), "close-worker", "sess_close_worker", "work"));
        let runner = rig.runner.clone();
        let meta = JobMeta { tag: Some("close-worker".into()), session_id: Some("sess_close_worker".into()), ..JobMeta::default() };
        let job = rig
            .starter
            .start_job("spawn", meta, lead("sess_close_lead"), move |job, notify| async move { runner.run(plan, Some(notify), Some(job)).await.map(Some) })
            .unwrap();
        world.started.notified().await;
        let scope = Scope { caller_session_id: Some("sess_close_lead".into()), host_pid: None };
        let sessions = Turns(world.clone());
        let parts = CloseParts { registry: &Reg, sessions: &sessions, tasks: &rig.board };
        let closed = close_resolved(parts, "sess_close_worker", "close-worker", &scope, None, false).await.unwrap();
        rig.board.wait_terminal(job.task_id()).await;
        settle().await;
        let got = masked(
            json!({
                "closed": { "closed": closed.closed, "tag": closed.tag, "sessionId": closed.session_id, "task_id": closed.task_id },
                "status": job.status(),
                "closures": *lock(&world.closures),
                "deliveries": *lock(&rig.owner.0),
            }),
            &[job.task_id().to_owned()],
        );
        let recorded = &case["recorded"];
        // The closes as a set: the core sends the cancel-time close from a spawned task, so it lands after the agent
        // close where Node's lands before it (a listed difference, MANIFEST `compared`).
        let mut got = got;
        sort_closures(&mut got);
        let mut want = json!({ "closed": recorded["closed"], "status": recorded["status"], "closures": recorded["closures"], "deliveries": recorded_deliveries(recorded) });
        sort_closures(&mut want);
        assert_eq!(got, want, "{}", case["case"]);
    }
}
