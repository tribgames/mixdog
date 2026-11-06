//! A worker's turn against the goldens recorded from Node (`fixtures/agent/record-turns.mjs`):
//! `runSpawn` and `runSend` under a real job starter and board, and `createWorkerTurns`' row
//! bookkeeping. Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelAll;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::flow::early::EarlyNotice;
use mixdog_agent::agent_tool::flow::job_starter::JobStarter;
use mixdog_agent::agent_tool::flow::job_starter::StartContext;
use mixdog_agent::agent_tool::flow::reconcile::JobHandle;
use mixdog_agent::agent_tool::flow::seams::*;
use mixdog_agent::agent_tool::flow::turn::TurnPlan;
use mixdog_agent::agent_tool::flow::turn::TurnRunner;
use mixdog_agent::agent_tool::flow::worker_turns::Claim;
use mixdog_agent::agent_tool::flow::worker_turns::TurnOwner;
use mixdog_agent::agent_tool::flow::worker_turns::WorkerTurns;
use mixdog_agent::agent_tool::host::CloseOptions;
use mixdog_agent::agent_tool::host::Sessions;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::env::Clock;
use mixdog_agent::response::Termination;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

const START: i64 = 1_772_359_200_000; // 2026-03-01T10:00:00.000Z

fn fixture(name: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{}/../../fixtures/agent/turns/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    serde_json::from_str::<Value>(&text).unwrap().as_array().unwrap().clone()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        START
    }
}

/// The ticker task lives on the runtime that first asks for it; keep that one alive for the process.
fn long_lived_ticker() {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap());
    let _entered = runtime.enter();
    mixdog_rt::testing::tokens();
    mixdog_rt::ticker();
}

async fn settle() {
    for _ in 0..4 {
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---- the runner -----------------------------------------------------------------------------

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

#[derive(Default)]
struct World {
    calls: Mutex<Vec<Value>>,
    notices: Mutex<Vec<Value>>,
    /// The worker session's rows: two before the turn, then what the script appends.
    rows: Mutex<Vec<AssistantText>>,
    steps: Vec<Value>,
    board: std::sync::OnceLock<JobBoard>,
    job: Mutex<Option<String>>,
}

impl World {
    fn log(&self, entry: impl Into<Value>) {
        lock(&self.calls).push(entry.into());
    }
}

struct Sess(Arc<World>);

#[async_trait]
impl TurnSessions for Sess {
    async fn message_count(&self, _: &str) -> usize {
        // Two rows existed before the turn; only the assistant rows after them are the turn's.
        2 + lock(&self.0.rows).len()
    }

    async fn assistant_texts(&self, _: &str, start: usize) -> Vec<AssistantText> {
        lock(&self.0.rows).iter().skip(start.saturating_sub(2)).cloned().collect()
    }

    fn not_done_report(&self, _: &str) -> String {
        String::new()
    }

    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        let w = &self.0;
        w.log(format!("ask:{}@{}", request.prompt, request.cwd));
        for step in &w.steps {
            if let Some(diff) = step.get("tool").and_then(Value::as_str) {
                (request.hooks.on_tool_result)(&ToolResultMessage { ui_diff: Some(diff.to_owned()) });
            } else if let Some(text) = step.get("assistant").and_then(Value::as_str) {
                let replay = step.get("replay").and_then(Value::as_str).unwrap_or_default();
                lock(&w.rows).push(AssistantText { content: text.to_owned(), replay: replay.to_owned() });
            } else if let Some(terminal) = step.get("terminal") {
                if let Some(hook) = &request.hooks.on_terminal_result {
                    hook(&turn_result(terminal));
                }
            } else if step.get("cancel").is_some() {
                let id = lock(&w.job).clone().unwrap();
                w.board.get().unwrap().cancel(&id, "agent close", CancelNotice::Default);
            } else if let Some(result) = step.get("return") {
                return Ok(turn_result(result));
            } else if let Some(error) = step.get("throw") {
                return Err(TurnError {
                    message: error["message"].as_str().unwrap().to_owned(),
                    carried_report: error.get("carriedReport").and_then(Value::as_str).map(str::to_owned),
                    partial_handoff: error.get("partialHandoff").and_then(Value::as_str).map(str::to_owned),
                });
            }
        }
        Ok(turn_result(&json!({ "content": "" })))
    }

    fn unload_runtime(&self, _: &str, reason: &str) {
        self.0.log(format!("unload:{reason}"));
    }
}

struct Events(Arc<World>);
impl SubagentEvents for Events {
    fn start(&self, _: &str, _: &str, _: &str) {
        self.0.log("emit:start");
    }
    fn stop(&self, _: &str, _: &str, _: &str, status: &str) {
        self.0.log(format!("emit:stop:{status}"));
    }
}

/// The review store ignores a completion that has no owner (beginAgentTurnReview hands none).
struct Review(Arc<World>, Mutex<bool>, String);
impl ReviewHandle for Review {
    fn complete(&self, patches: Vec<String>) {
        let mut done = lock(&self.1);
        if !*done {
            *done = true;
            // The store takes a completion only with a patch (a fresh store holds no review).
            if !self.2.is_empty() && !patches.is_empty() {
                self.0.log(json!(["reviewComplete", patches]));
            }
        }
    }
}
struct Reviews(Arc<World>);
impl TurnReviews for Reviews {
    fn begin(&self, owner: &str, session: &str, tag: &str, agent: &str) -> Box<dyn ReviewHandle> {
        self.0.log(json!(["reviewBegin", owner, session, { "tag": tag, "agent": agent }]));
        Box::new(Review(self.0.clone(), Mutex::new(false), owner.to_owned()))
    }
}

struct Owner(Arc<World>);
impl OwnerNotify for Owner {
    fn notify(&self, owner: &str, text: &str, meta: &Value) -> bool {
        lock(&self.0.notices).push(json!({ "session": owner, "text": text, "meta": meta }));
        true
    }
}

struct Delivered(Arc<World>);
#[async_trait]
impl TaskNotifier for Delivered {
    async fn finished(&self, owner: &ThreadId, _surface: &str, _task_id: &str, _status: &str, notification: String) {
        lock(&self.0.notices).push(json!({ "session": owner.as_str(), "text": notification }));
    }
}

struct NoInbox;
impl WorkerInbox for NoInbox {
    fn enqueue_completion(&self, _: &str, _: &str, _: &Value) -> bool {
        false
    }
}

struct Closer;
#[async_trait]
impl Sessions for Closer {
    async fn rehydrate_agent_sessions(&self) -> bool {
        false
    }
    async fn read_session_handoff(&self, _: &str) -> Option<String> {
        None
    }
    async fn close_session(&self, _: &str, _: &str, _: CloseOptions) -> bool {
        true
    }
    fn descendant_session_ids(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn clear_statusline_route(&self, _: &str) {}
}

struct Open;
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

/// The route's side of a claim: a claim opens the observation (`claim`), and the row a claim
/// settles when no turn started records the status it was released with (`release:<status>`).
/// The owner of the worker's turns as Node's fake logs it: every claim, and the release of each.
struct TurnsOwner(Arc<World>);
impl TurnOwner for TurnsOwner {
    fn claim(&self, _: &str, _: Option<Arc<JobHandle>>) -> Claim {
        self.0.log("claim");
        let world = self.0.clone();
        Claim::custom("sub-1".into(), Box::new(move |status| world.log(format!("release:{}", status.word()))))
    }
    fn observe(&self, _: &str) -> bool {
        true
    }
}
struct Names;
impl SessionNames for Names {
    fn tag_for_session(&self, _: &str) -> Option<String> {
        Some("scout".into())
    }
    fn agent(&self, _: &str) -> Option<String> {
        Some("worker".into())
    }
}

fn identity(spawn: bool, agent: &str) -> Map<String, Value> {
    let mut value = json!({ "tag": "scout", "sessionId": "sess_w1", "agent": agent, "provider": "openai", "model": "gpt-x" });
    if spawn {
        value["preset"] = json!("worker-preset");
        value["effort"] = json!("high");
        value["fast"] = json!(false);
    }
    value.as_object().unwrap().clone()
}

fn mask(value: &Value, id: &str) -> Value {
    serde_json::from_str(&value.to_string().replace(id, "job")).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_workers_turn_equals_nodes_runner() {
    long_lived_ticker();
    for scenario in fixture("runner.json") {
        let name = scenario["name"].as_str().unwrap();
        eprintln!("scenario {name}");
        let spawn = scenario["kind"] == "spawn";
        let agent = scenario.get("agent").and_then(Value::as_str).unwrap_or("worker").to_owned();
        let canonical = scenario.get("canonical") == Some(&Value::Bool(true));
        let world = Arc::new(World { steps: scenario["steps"].as_array().unwrap().clone(), ..World::default() });
        let board = JobBoard::new(Arc::new(FixedClock), Some(Arc::new(Delivered(world.clone()))), None);
        world.board.set(board.clone()).ok();
        let clock: Arc<dyn Clock> = Arc::new(FixedClock);
        let sessions: Arc<dyn TurnSessions> = Arc::new(Sess(world.clone()));
        let turns: Arc<dyn TurnOwner> = Arc::new(TurnsOwner(world.clone()));
        let early = Arc::new(EarlyNotice::new(Arc::new(Owner(world.clone())), clock));
        let runner = Arc::new(TurnRunner::new(sessions.clone(), turns, Arc::new(Reviews(world.clone())), Arc::new(Events(world.clone())), Arc::new(NoInbox), early));
        let plan = TurnPlan {
            kind: if spawn { TurnKind::Spawn } else { TurnKind::Send },
            session_id: "sess_w1".into(),
            parent_session_id: None,
            session_owner_id: None,
            tag: "scout".into(),
            agent: agent.clone(),
            identity: identity(spawn, &agent),
            prompt: "do it".into(),
            attachments: Vec::new(),
            context: None,
            cwd: "/work".into(),
            skill_selection: None,
            canonical,
        };
        let (done, finished) = oneshot::channel();
        let mut task_id = None;
        if scenario["job"] == true {
            let starter = JobStarter::new(board.clone(), Arc::new(Closer), sessions, Arc::new(Open), Arc::new(NoStarts), Arc::new(|| {}));
            let meta = JobMeta {
                tag: Some("scout".into()),
                session_id: Some("sess_w1".into()),
                agent: Some(agent.clone()),
                preset: spawn.then(|| "worker-preset".into()),
                provider: Some("openai".into()),
                model: Some("gpt-x".into()),
                effort: spawn.then(|| "high".into()),
                fast: Some(false),
                ..JobMeta::default()
            };
            let context = StartContext { caller_session_id: Some("lead".into()), client_host_pid: Some(4242), ..StartContext::default() };
            let (runner, world2) = (runner.clone(), world.clone());
            let job = starter
                .start_job(if spawn { "spawn" } else { "send" }, meta, context, move |job, notify| async move {
                    *lock(&world2.job) = Some(job.task_id().to_owned());
                    let outcome = runner.run(plan, Some(notify), Some(job)).await;
                    let _ = done.send(outcome.clone());
                    outcome.map(Some)
                })
                .unwrap();
            task_id = Some(job.task_id().to_owned());
        } else {
            let _ = done.send(runner.run(plan, None, None).await);
        }
        let outcome = finished.await.unwrap();
        settle().await;
        let row = task_id.as_ref().and_then(|id| board.get(id, &Scope::default())).map(|t| {
            json!({ "status": t.status, "error": t.error, "terminalReason": t.terminal_reason, "notified": t.notified })
        });
        let got = json!({
            "outcome": match &outcome { Ok(value) => json!({ "value": value.value }), Err(error) => json!({ "error": error }) },
            "calls": *lock(&world.calls),
            "notices": *lock(&world.notices),
            "row": row,
        });
        let got = match &task_id {
            Some(id) => mask(&got, id),
            None => got,
        };
        let mut want = scenario["result"].clone();
        // Node logs the claim and release of its fake worker turns; the notices of a final
        // delivery carry no meta.
        for notice in want["notices"].as_array_mut().unwrap() {
            notice.as_object_mut().unwrap().entry("meta").or_insert(Value::Null);
        }
        let mut got = got;
        for notice in got["notices"].as_array_mut().unwrap() {
            if notice["meta"].is_null() {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        for notice in want["notices"].as_array_mut().unwrap() {
            if notice["meta"].is_null() {
                notice.as_object_mut().unwrap().remove("meta");
            }
        }
        assert_eq!(got, want, "{name}");
    }
}

// ---- worker turns ---------------------------------------------------------------------------

#[derive(Default)]
struct Probe {
    rows: Mutex<Vec<Value>>,
    changed: AtomicUsize,
    unobserved: Arc<AtomicUsize>,
    listeners: Mutex<HashMap<String, Arc<dyn TurnListener>>>,
}

struct ProbeSource(Arc<Probe>);
impl TurnSource for ProbeSource {
    fn observe_session_turns(&self, session_id: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve> {
        lock(&self.0.listeners).insert(session_id.to_owned(), listener);
        let counter = self.0.unobserved.clone();
        Some(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }))
    }
}

struct ProbeRows(Arc<Probe>);
impl WorkerRows for ProbeRows {
    fn upsert(&self, session_id: &str, tag: Option<&str>, update: RowUpdate) {
        let mut patch = Map::new();
        if let Some(v) = update.status {
            patch.insert("status".into(), json!(v));
        }
        if let Some(v) = update.stage {
            patch.insert("stage".into(), json!(v));
        }
        if let Some(v) = update.task_id {
            patch.insert("task_id".into(), json!(v));
        }
        if let Some(v) = update.turn_started_at {
            patch.insert("turnStartedAt".into(), json!(v));
        }
        if let Some(v) = update.finished_at {
            patch.insert("finishedAt".into(), json!(v));
        }
        if let Some(v) = update.failure_reason {
            patch.insert("failureReason".into(), json!(v));
        }
        lock(&self.0.rows).push(json!({ "session": session_id, "tag": tag, "patch": patch }));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_turn_rows_equal_nodes() {
    long_lived_ticker();
    for scenario in fixture("worker-turns.json") {
        let name = scenario["name"].as_str().unwrap();
        let probe = Arc::new(Probe::default());
        let board = JobBoard::new(Arc::new(FixedClock), None, None);
        let changed = probe.clone();
        let turns = WorkerTurns::new(
            Arc::new(ProbeSource(probe.clone())),
            Arc::new(ProbeRows(probe.clone())),
            Arc::new(Names),
            Arc::new(FixedClock),
            Arc::new(move || {
                changed.changed.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let owner = format!("lead-{}", scenario_number(name));
        let mut jobs: Vec<Arc<JobHandle>> = Vec::new();
        let mut claims = Vec::new();
        for (i, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let mark = lock(&probe.rows).len();
            let mut got = Map::new();
            match op["op"].as_str().unwrap() {
                "job" => {
                    let id = format!("j{}-{}", scenario_number(name), jobs.len());
                    board
                        .register(NewJob {
                            task_id: Some(id.clone()),
                            operation: "spawn".into(),
                            label: Some("scout".into()),
                            owner: JobOwner { caller_session_id: Some(owner.clone()), ..JobOwner::default() },
                            ..NewJob::default()
                        })
                        .unwrap();
                    jobs.push(Arc::new(JobHandle::new(board.clone(), id, "spawn".into(), None)));
                }
                "cancelJob" => {
                    board.cancel_all(&CancelAll {
                        scope: Scope { caller_session_id: Some(owner.clone()), host_pid: None },
                        terminal_reason: op.get("terminalReason").and_then(Value::as_str).map(str::to_owned),
                        notice: CancelNotice::Never,
                        ..CancelAll::default()
                    });
                }
                "claim" => {
                    let job = op.get("job").and_then(Value::as_u64).map(|n| jobs[n as usize].clone());
                    let claim = turns.claim("sess_w1", job);
                    got.insert("submissionPrefix".into(), json!(claim.submission_id.starts_with("agent-turn-")));
                    claims.push(claim);
                }
                "release" => {
                    let status = match op["status"].as_str().unwrap() {
                        "idle" => mixdog_agent::agent_tool::flow::reconcile::FinalStatus::Idle,
                        "error" => mixdog_agent::agent_tool::flow::reconcile::FinalStatus::Error,
                        _ => mixdog_agent::agent_tool::flow::reconcile::FinalStatus::Cancelled,
                    };
                    claims[op["claim"].as_u64().unwrap() as usize].release(status);
                }
                "observe" => {
                    got.insert("observed".into(), json!(turns.observe("sess_w1")));
                }
                "turnStart" => {
                    let submission_ids = op["claims"].as_array().map(|c| c.iter().map(|i| claims[i.as_u64().unwrap() as usize].submission_id.clone()).collect()).unwrap_or_default();
                    let listener = lock(&probe.listeners).get("sess_w1").cloned().unwrap();
                    listener.turn_started(TurnStart {
                        turn_id: op["turn"].as_str().unwrap().to_owned(),
                        started_at_ms: START + op.get("at").and_then(Value::as_i64).unwrap_or(0),
                        submission_ids,
                    });
                }
                "turnSettle" => {
                    let listener = lock(&probe.listeners).get("sess_w1").cloned().unwrap();
                    listener.turn_settled(TurnOutcome {
                        turn_id: op["turn"].as_str().unwrap().to_owned(),
                        done: op["status"] == "done",
                        result: op.get("result").map(turn_result),
                    });
                }
                "forget" => {
                    turns.dispose();
                    got.insert("unobserved".into(), json!(probe.unobserved.load(Ordering::SeqCst)));
                }
                other => panic!("{name}: {other}"),
            }
            got.insert("rows".into(), Value::Array(lock(&probe.rows)[mark..].to_vec()));
            got.insert("changed".into(), json!(probe.changed.load(Ordering::SeqCst)));
            assert_eq!(Value::Object(got), scenario["results"][i], "{name} op {i}");
        }
    }
}

/// The recorder numbers its worker-turns scenarios from one, in order.
fn scenario_number(name: &str) -> usize {
    fixture("worker-turns.json").iter().position(|s| s["name"] == name).unwrap() + 1
}