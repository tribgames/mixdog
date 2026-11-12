//! The job views against real Node's (`fixtures/job-views/golden.json`, from `benchmarks/rust-core/recorders/record-job-views.mjs`):
//! the worker list, the job rows, the status card (live, frozen, spawning, respawned, resumed) and the worker fallback, over
//! the states Node's own tests build. The core's own parts run: `JobViews` over the job board, the production `AgentRegistry`
//! and the production `AgentWorkers` (its thread header read, model-context read and live progress) over a real session
//! directory, whose threads are created and given their messages through the directory's own entry points. The doubles stand
//! at the seams the recorder scripts in Node: the registry's index store (`Store`, where Node's `agentSessionEntries` stub sits),
//! the thread store under the directory (the session manager's `getSession` answers) and the clock. What Node's rows and cards
//! hold beyond what the core's roster row, job row and task view have is declared in the manifest's exclusions.

use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::host::ListOptions;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::Views;
use mixdog_agent::agent_tool::views::JobViews;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_tools::orch::agent::TaskResult;

use super::super::workers::AgentWorkers;
use crate::session::SessionDirectory;
use crate::session::thread_state::SessionThreads;
use super::*;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/job-views/golden.json");

struct NoJobs;
impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
    fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
        None
    }
}

struct AgentClock(i64);
impl mixdog_agent::env::Clock for AgentClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn internal() -> CallContext {
    CallContext::internal("job-views")
}

/// A Node record with its `null` members left out: an absent `Option` of the core is Node's `null`.
fn bare(value: &Value) -> Value {
    Value::Object(value.as_object().unwrap().iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

struct World {
    views: JobViews,
    threads: Arc<SessionThreads>,
    _sessions: crate::session::testing::Rig,
    _registry_rig: Rig,
}

async fn world(scenario: &Value, now: i64) -> World {
    let sessions = crate::session::testing::Rig::new();
    let directory = Arc::new(SessionDirectory::new(sessions.deps()));
    let rig = Rig::new();
    rig.clock.0.store(now, Ordering::SeqCst);
    let registry = Arc::new(AgentRegistry::new(rig.store.clone(), directory.clone(), Arc::new(Hour), rig.clock.clone()));
    let threads = Arc::new(SessionThreads::new(directory.clone()));
    let workers = Arc::new(AgentWorkers::new(directory.clone(), threads.clone(), registry.clone(), Arc::new(NoJobs), rig.clock.clone()));

    // The tag each session carries: the entries' tags (Node's `agentSessionEntries`) and the tag map's.
    let mut tags: HashMap<String, String> = HashMap::new();
    for entry in scenario["entries"].as_array().into_iter().flatten() {
        tags.insert(entry["session"].as_str().unwrap().to_owned(), entry["tag"].as_str().unwrap().to_owned());
    }
    for (tag, session) in scenario["tags"].as_object().into_iter().flatten() {
        tags.insert(session.as_str().unwrap().to_owned(), tag.clone());
    }
    for session in scenario["sessions"].as_array().unwrap().iter().filter(|s| s["closed"] != json!(true)) {
        let id = session["id"].as_str().unwrap();
        // The record's own fields become the thread's header; the conversation goes in through the thread's own append.
        let mut header: Row = session
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| !["id", "messages", "tools", "runtime", "snapshot", "pendingDepth"].contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        header.insert("parentSessionId".into(), json!("lead"));
        header.insert("ownerSessionId".into(), json!("lead"));
        if let Some(tag) = tags.get(id) {
            header.insert("agentTag".into(), json!(tag));
        }
        let thread = ThreadId::from(id);
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("the worker thread");
        // A `null` message is no stored row.
        let messages: Vec<Value> = session["messages"].as_array().unwrap().iter().filter(|m| !m.is_null()).cloned().collect();
        let handle = directory.open_handle(&thread, &internal()).await.expect("opens");
        let request = CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "threadId": thread, "messages": messages }), op: None, ctx: internal() };
        handle.request(request).await.expect("the conversation is appended");
    }
    // The tool call's own refresh: the scan binds each tagged session's tag.
    registry.refresh_tags_from_sessions(true, &Scope::default()).await;

    let board = JobBoard::new(Arc::new(AgentClock(now)), None, None);
    for task in scenario["tasks"].as_array().into_iter().flatten() {
        let meta = &task["meta"];
        let id = task["taskId"].as_str().unwrap().to_owned();
        let (tag, session) = (text(meta, "tag"), text(meta, "sessionId"));
        board
            .register(NewJob {
                task_id: Some(id.clone()),
                label: tag.clone().or_else(|| session.clone()).or_else(|| text(task, "operation")),
                operation: text(task, "operation").unwrap(),
                owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
                meta: JobMeta {
                    tag,
                    session_id: session,
                    agent: text(meta, "agent"),
                    provider: text(meta, "provider"),
                    model: text(meta, "model"),
                    respawned: meta["respawned"] == json!(true),
                    resumed: meta["resumed"] == json!(true),
                    ..JobMeta::default()
                },
                started_at_ms: Some(now + task["startedOffset"].as_i64().unwrap_or(0)),
                ..NewJob::default()
            })
            .expect("the job registers");
        if let Some(done) = task.get("complete") {
            board.complete(
                &id,
                Completion { result: text(done, "result").map(TaskResult::Content), error: text(done, "error"), notify: false, ..Completion::new(done["status"].as_str().unwrap()) },
            );
        }
    }
    let views = JobViews::new(board, registry.clone() as Arc<dyn Registry>, workers, Arc::new(AgentClock(now)));
    World { views, threads, _sessions: sessions, _registry_rig: rig }
}

fn scope_of(context: &Value) -> Scope {
    Scope { caller_session_id: text(context, "callerSessionId"), host_pid: context.get("clientHostPid").and_then(Value::as_u64) }
}

/// The card of Node's `renderJob`, from the fields the core's task view has.
fn card_of(job: &mixdog_agent::agent_tool::host::Job) -> Value {
    let v = &job.view;
    bare(&json!({
        "task_id": job.task_id, "type": v.kind, "status": v.status, "tag": v.tag, "sessionId": v.session_id, "agent": v.agent,
        "provider": v.provider, "model": v.model, "effort": v.effort, "fast": v.fast, "startedAt": v.started_at, "finishedAt": v.finished_at,
        "error": v.error, "workerStatus": v.worker_status, "stage": v.stage, "worker_stage": v.worker_stage, "last_progress": v.last_progress,
        "diagnostic": v.diagnostic, "silent_for": v.silent_for_secs, "tool_silent_for": v.tool_silent_for,
        "queued_followups": v.queued_followups, "respawned": v.respawned.then_some(true), "resumed": v.resumed.then_some(true), "note": v.note,
        "result": v.result.as_ref().map(|r| match r {
            TaskResult::Content(text) => json!(text),
            TaskResult::Json(value) => value.clone(),
        }),
    }))
}

/// The fields of Node's card the core's task view has.
fn node_card(card: &Value) -> Value {
    let keys = [
        "task_id", "type", "status", "tag", "sessionId", "agent", "provider", "model", "effort", "fast", "startedAt", "finishedAt", "error", "workerStatus", "stage",
        "worker_stage", "last_progress", "diagnostic", "silent_for", "tool_silent_for", "queued_followups", "respawned", "resumed", "note", "result",
    ];
    bare(&Value::Object(keys.iter().filter_map(|key| card.get(*key).map(|v| ((*key).to_owned(), v.clone()))).collect()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_job_views_equal_nodes() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = golden["now"].as_i64().unwrap();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let world = world(scenario, now).await;
        for (index, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let want = &scenario["results"][index];
            let at = format!("{name}: op {index} ({})", op["op"]);
            match op["op"].as_str().unwrap() {
                "list" => {
                    let opts = &op["opts"];
                    let flag = |key: &str| opts[key] == json!(true);
                    let rows = world
                        .views
                        .list(
                            &scope_of(&opts["context"]),
                            ListOptions { scan_sessions: flag("scanSessions"), include_idle: flag("includeIdle"), include_closed: flag("includeClosed"), include_terminal: flag("includeTerminal") },
                        )
                        .await;
                    let got: Vec<Value> = rows
                        .iter()
                        .map(|r| json!({
                            "tag": r.tag, "status": r.status, "stage": r.stage, "last_progress": r.last_progress, "tool_silent_for": r.tool_silent_for,
                            "hung_diagnostic": r.hung_diagnostic, "active": r.active,
                        }))
                        .collect();
                    // A session Node's stub lists as closed is not in the world: the core drops a worker's row when it closes the worker
                    // (`close_resolved`), so the production registry has no such row to list.
                    let closed_tags: Vec<&str> = scenario["sessions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|s| s["closed"] == json!(true))
                        .filter_map(|s| scenario["entries"].as_array()?.iter().find(|e| e["session"] == s["id"])?["tag"].as_str())
                        .collect();
                    let expected: Vec<Value> = want["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .zip(want["active"].as_array().unwrap())
                        .filter(|(row, _)| !closed_tags.contains(&row["tag"].as_str().unwrap()))
                        .map(|(row, active)| {
                            let hung = text(row, "diagnostic").filter(|d| d.starts_with("tool possibly hung"));
                            json!({
                                "tag": row["tag"], "status": row["status"], "stage": row["stage"], "last_progress": row["last_progress"],
                                "tool_silent_for": row["tool_silent_for"], "hung_diagnostic": hung, "active": active,
                            })
                        })
                        .collect();
                    // The order of the rows is the entries' (Node's stub's, the registry's index order here); the roster sorts what it
                    // is given, so the rows are compared by tag.
                    let by_tag = |mut rows: Vec<Value>| {
                        rows.sort_by(|a, b| a["tag"].as_str().cmp(&b["tag"].as_str()));
                        json!(rows)
                    };
                    assert_eq!(by_tag(got), by_tag(expected), "{at}");
                }
                "listJobs" => {
                    let rows = world.views.list_jobs(&scope_of(&op["context"])).await;
                    let got: Vec<Value> = rows
                        .iter()
                        .map(|r| json!({ "task_id": r.task_id, "type": r.kind, "status": r.status, "tag": r.tag, "error": r.error, "finished": r.finished, "stamp": r.stamp }))
                        .collect();
                    let expected: Vec<Value> = want["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .zip(want["finished"].as_array().unwrap())
                        .map(|(row, finished)| {
                            let stamp = text(row, "finishedAt").unwrap_or_else(|| text(row, "startedAt").unwrap());
                            json!({ "task_id": row["task_id"], "type": row["type"], "status": row["status"], "tag": row["tag"], "error": row["error"], "finished": finished, "stamp": stamp })
                        })
                        .collect();
                    assert_eq!(json!(got), json!(expected), "{at}");
                }
                "lookup" | "fallback" => {
                    let args = if op["op"] == "lookup" { op["args"].clone() } else { json!({ "sessionId": op["target"] }) };
                    let answer = world.views.get_job_or_worker(&args, &Scope::default(), true).await;
                    let expected_card = want.get("card").filter(|card| !card.is_null());
                    match (&answer, expected_card, want.get("error")) {
                        (Ok(job), Some(card), _) => assert_eq!(card_of(job), node_card(card), "{at}"),
                        (Err(error), None, Some(message)) => assert_eq!(json!(error), *message, "{at}"),
                        // A target no task and no worker answers: `workerFallbackJob` is `null`, and the lookup's own error stands.
                        (Err(error), None, None) => assert!(want["job"].is_null() && error.starts_with("agent read/status: no task found"), "{at}: {error}"),
                        (got, want_card, want_error) => panic!("{at}: got {got:?}; Node answered card {want_card:?}, error {want_error:?}"),
                    }
                }
                "patch" => {
                    let set: Row = op["set"].as_object().unwrap().clone();
                    world.threads.patch_header(&ThreadId::from(op["id"].as_str().unwrap()), set, Vec::new()).await.expect("the header patch");
                }
                other => panic!("{at}: unknown op {other}"),
            }
        }
    }
}
