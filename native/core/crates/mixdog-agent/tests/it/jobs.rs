//! The agent tool's job board: an empty agent report notifies without a result body, a cancelled run's output is its
//! cancellation report, and a lost result lives as long as what it describes.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use crate::agent_tool::Fakes;
use crate::agent_tool::World;
use crate::agent_tool::runtime_with;
use crate::agent_tool::world_with;
use crate::delegation_features::TestClock;
use crate::flow_scenarios::backend;
use crate::flow_scenarios::rig;
use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::dispatch::CleanupParts;
use mixdog_agent::agent_tool::dispatch::CloseParts;
use mixdog_agent::agent_tool::dispatch::cleanup_idle;
use mixdog_agent::agent_tool::dispatch::close_resolved;
use mixdog_agent::agent_tool::flow::world::SpawnContext;
use mixdog_agent::agent_tool::host::Recovered;
use mixdog_agent::agent_tool::host::Topology;
use mixdog_agent::agent_tool::scope::Caller;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Notices {
    sent: Mutex<Vec<(String, String)>>,
    arrived: tokio::sync::Notify,
}

#[async_trait]
impl TaskNotifier for Notices {
    async fn finished(&self, owner: &ThreadId, surface: &str, _task_id: &str, _status: &str, notification: String) {
        assert_eq!(surface, "agent");
        self.sent.lock().unwrap().push((owner.as_str().to_owned(), notification));
        self.arrived.notify_waiters();
    }
}

/// Waits until `want` notifications have been delivered (delivery runs on a spawned task of the
/// runtime's work pool), then lets any task already runnable finish. The bound only turns a
/// notification that never arrives into a failure.
async fn settle(notices: &Notices, want: usize) {
    let arrive = async {
        loop {
            let arrived = notices.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if notices.sent.lock().unwrap().len() >= want {
                break;
            }
            arrived.await;
        }
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), arrive).await.expect("a notification never arrived");
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

#[test]
fn register_allocates_ids_and_refuses_a_duplicate_explicit_one() {
    backend();
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(1_000))), None, None);
    let named = |id: Option<&str>| NewJob { task_id: id.map(Into::into), operation: "spawn".into(), ..NewJob::default() };
    assert_eq!(board.register(named(Some(" t1 "))).unwrap(), "t1");
    assert_eq!(board.register(named(Some("t1"))).unwrap_err(), "background task already exists: t1");
    let first = board.register(named(Some("  "))).unwrap();
    let second = board.register(named(None)).unwrap();
    assert!(first.starts_with("task_agent_") && second.starts_with("task_agent_"), "{first} {second}");
    assert_ne!(first, second);
}

/// `renderBackgroundTaskNotification`: an agent's object result with `content: ""` delivers an
/// empty authored body (no `<result>` block), never the JSON of the object.
#[tokio::test(start_paused = true)]
async fn an_empty_agent_report_notifies_without_a_result_body() {
    backend();
    let notices = Arc::new(Notices::default());
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(1_000))), Some(notices.clone()), None);
    board
        .register(NewJob {
            task_id: Some("t1".into()),
            operation: "spawn".into(),
            label: Some("w".into()),
            owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
            meta: JobMeta { tag: Some("w".into()), ..JobMeta::default() },
            ..NewJob::default()
        })
        .unwrap();
    board.complete("t1", Completion { result: Some(TaskResult::Json(json!({ "agent": "worker", "content": "" }))), ..Completion::new("completed") });
    settle(&notices, 1).await;
    let sent = notices.sent.lock().unwrap();
    assert!(sent[0].1.contains("<status>completed</status>"), "{}", sent[0].1);
    assert!(!sent[0].1.contains("<result>") && !sent[0].1.contains("worker"), "{}", sent[0].1);
}

/// A cancelled job's run that settles the moment it is stopped finds its row cancelled already: the output it settles
/// with is the owner's one `cancelled` report. The job's stop settles in place, as a worker woken on another thread can
/// before the cancel returns.
#[tokio::test(start_paused = true)]
async fn a_run_settled_as_it_is_stopped_reports_its_output_as_cancelled() {
    backend();
    let notices = Arc::new(Notices::default());
    let board = JobBoard::new(Arc::new(TestClock(AtomicI64::new(1_000))), Some(notices.clone()), None);
    let worker = board.clone();
    board
        .register(NewJob {
            task_id: Some("t1".into()),
            operation: "spawn".into(),
            owner: JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() },
            meta: JobMeta { tag: Some("w".into()), ..JobMeta::default() },
            notify_on_cancel: true,
            cancel: Some(Arc::new(move || worker.settle_cancelled("t1", Some(TaskResult::Json(json!({ "content": "partial work" })))))),
            ..NewJob::default()
        })
        .unwrap();
    board.cancel("t1", "stopped", CancelNotice::Default);
    settle(&notices, 1).await;
    let sent = notices.sent.lock().unwrap();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].1.contains("<status>cancelled</status>") && sent[0].1.contains("partial work"), "{}", sent[0].1);
}

/// A board on a clock the test moves, and the scope of `lead`, the owner of its jobs.
fn lead_board() -> (JobBoard, Arc<TestClock>, Scope) {
    backend();
    let clock = Arc::new(TestClock(AtomicI64::new(1_000)));
    (JobBoard::new(clock.clone(), None, None), clock, Scope { caller_session_id: Some("lead".into()), host_pid: None })
}

/// Starts `lead`'s job `id` of `tag`, on `session` once it has one.
fn lead_job(board: &JobBoard, id: &str, tag: &str, session: Option<&str>) {
    let meta = JobMeta { tag: Some(tag.into()), session_id: session.map(Into::into), ..JobMeta::default() };
    let owner = JobOwner { caller_session_id: Some("lead".into()), ..JobOwner::default() };
    board.register(NewJob { task_id: Some(id.into()), operation: "spawn".into(), owner, meta, ..NewJob::default() }).unwrap();
}

/// Past the time a finished job is kept: the next look at the board prunes it.
fn expire(clock: &TestClock) {
    clock.0.fetch_add(31 * 60_000, Ordering::SeqCst);
}

/// `lead`'s job `id` failed unread and was pruned: its result is lost.
fn lose(board: &JobBoard, clock: &TestClock, scope: &Scope, id: &str) {
    board.complete(id, Completion::new("failed"));
    expire(clock);
    board.cleanup_jobs(scope, false);
}

/// A tag given to a new agent inherits nothing lost, also when the job of the agent before it is pruned unread after
/// the new agent's own: the newest job of a tag speaks for it.
#[test]
fn a_reused_tag_inherits_no_lost_result() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "old", "w", Some("s1"));
    lead_job(&board, "new", "w", Some("s2"));
    board.complete("new", Completion::new("completed"));
    board.acknowledge("new");
    expire(&clock);
    board.cleanup_jobs(&scope, false);
    lose(&board, &clock, &scope, "old");
    assert!(board.result_delivered("s2", "w", "lead", &scope), "the new agent under the tag");
    assert!(!board.result_delivered("s1", "", "lead", &scope), "the agent before it still lost its own result");
}

/// Closing an agent ends its lost result: neither its session nor its owner's tag reads as undelivered afterwards.
#[tokio::test]
async fn closing_an_agent_ends_its_lost_result() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "t1", "w", Some("s1"));
    lose(&board, &clock, &scope, "t1");
    assert!(!board.result_delivered("s2", "w", "lead", &scope), "the tag's result is lost");
    let mut world = World::default();
    world.json = json!({ "closeOk": true });
    let fakes = Fakes(Arc::new(world));
    let view = close_resolved(CloseParts { registry: &fakes, sessions: &fakes, tasks: &board }, "s1", "w", &scope, None, false).await.expect("closes");
    assert!(view.closed);
    assert!(board.result_delivered("s1", "", "lead", &scope) && board.result_delivered("s2", "w", "lead", &scope));
}

/// An owner that ends takes the results lost to it along, its agents' and its tags'.
#[test]
fn an_owner_that_ends_takes_its_lost_results_along() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "t1", "w", Some("s1"));
    lose(&board, &clock, &scope, "t1");
    assert!(!board.result_delivered("s1", "", "lead", &scope) && !board.result_delivered("s2", "w", "lead", &scope));
    board.forget_session("lead");
    assert!(board.result_delivered("s1", "", "lead", &scope) && board.result_delivered("s2", "w", "lead", &scope));
}

/// A spawn that failed before it had a session leaves no lost result: no agent of it is there to ask about.
#[test]
fn a_spawn_that_failed_before_it_had_a_session_leaves_no_lost_result() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "t0", "w", None);
    lose(&board, &clock, &scope, "t0");
    assert!(board.result_delivered("s2", "w", "lead", &scope));
}

/// A deleted worker takes its lost result along, under its session and under its owner's tag.
#[test]
fn a_deleted_worker_takes_its_lost_result_along() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "t1", "w", Some("s1"));
    lose(&board, &clock, &scope, "t1");
    assert!(!board.result_delivered("s2", "w", "lead", &scope), "the tag's result is lost");
    board.forget_session("s1");
    assert!(board.result_delivered("s1", "", "lead", &scope) && board.result_delivered("s2", "w", "lead", &scope));
}

/// Of two spawns of one tag that raced, the one registered last holds the tag: the earlier one, failed unread and not
/// pruned yet, does not keep the agent under the tag from reading as delivered.
#[test]
fn a_superseded_job_does_not_speak_for_its_tag() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "old", "w", None);
    lead_job(&board, "new", "w", Some("s2"));
    board.complete("new", Completion::new("completed"));
    board.acknowledge("new");
    expire(&clock);
    board.complete("old", Completion::new("failed"));
    assert!(board.result_delivered("s2", "w", "lead", &scope));
}

/// A close of a tag no session answers for any more, made across every terminal (`scope: "all"`), ends the lost result
/// of the tag's owner: the owner is read off the tag's agent, not off the caller's scope.
#[tokio::test]
async fn a_global_close_of_a_forgotten_tag_ends_its_owners_lost_result() {
    let (board, clock, scope) = lead_board();
    lead_job(&board, "t1", "w", Some("s1"));
    lose(&board, &clock, &scope, "t1");
    let live = json!({ "s1": { "id": "s1", "agent": "worker", "cwd": "/work", "parentSessionId": "lead" } });
    let world = world_with(json!({ "unresolvable": ["w"], "tagAgents": ["w"], "live": live }), &[("w", "s1")]);
    let caller = Caller { scope: scope.clone(), cwd: "/work".into(), ..Caller::default() };
    let reply = runtime_with(&world, Arc::new(board.clone())).handle(&json!({ "type": "close", "tag": "w", "scope": "all" }), &caller).await;
    assert!(matches!(&reply, AgentReply::Closed(view) if view.forgotten), "{reply:?}");
    assert!(board.result_delivered("s2", "w", "lead", &scope));
}

/// A cleanup that closes an agent below a root it then fails to close ends the closed agent's lost result, under its
/// session and under its tag.
#[tokio::test]
async fn a_cleanup_stopped_at_its_root_ends_the_lost_results_of_the_agents_it_closed() {
    let (board, clock, _) = lead_board();
    let owner = JobOwner { caller_session_id: Some("root".into()), ..JobOwner::default() };
    let meta = JobMeta { tag: Some("m".into()), session_id: Some("member".into()), ..JobMeta::default() };
    board.register(NewJob { task_id: Some("t1".into()), operation: "spawn".into(), owner, meta, ..NewJob::default() }).unwrap();
    board.complete("t1", Completion::new("failed"));
    expire(&clock);
    board.cleanup_jobs(&Scope::default(), false);
    let root = Scope { caller_session_id: Some("root".into()), host_pid: None };
    assert!(!board.result_delivered("other", "m", "root", &root), "the member's tag result is lost");
    let rows = json!([{ "tag": "r", "sessionId": "root", "parentSessionId": "lead", "status": "idle" }]);
    let fakes = Arc::new(Fakes(world_with(json!({ "rows": rows, "closeOk": true, "closeFails": ["root"] }), &[("r", "root")])));
    let parts = CleanupParts { registry: fakes.clone(), sessions: fakes, tasks: Arc::new(board.clone()) };
    let topology = Topology {
        children: HashMap::from([("root".to_owned(), vec!["member".to_owned()])]),
        present: HashSet::from(["root".to_owned(), "member".to_owned()]),
        ..Topology::default()
    };
    let lead = Scope { caller_session_id: Some("lead".into()), host_pid: None };
    let report = cleanup_idle(parts, &lead, (topology, Recovered::default()), CancellationToken::new()).await.expect("the cleanup runs");
    assert_eq!(report.not_closed.len(), 1, "only the root's close failed: {report:?}");
    assert!(board.result_delivered("other", "m", "root", &root));
}

/// A routine's executor runs under an owner that is no session, for that run alone: once the run is over nothing is kept
/// as lost to it, also when the executor failed unread and its job is pruned.
#[tokio::test(start_paused = true)]
async fn a_routine_run_keeps_no_lost_result_once_it_is_over() {
    backend();
    let config = json!({
        "default": "main-preset",
        "presets": [{ "id": "main-preset", "name": "MAIN", "provider": "anthropic", "model": "opus", "effort": "high" }],
        "agents": { "worker": { "provider": "openai", "model": "gpt-5", "effort": "medium" } },
    });
    let scenario = json!({ "config": config, "nextTag": "worker-1", "canonical": true, "steps": [{ "throw": { "message": "the executor failed" } }] });
    let host = json!({
        "agent": { "name": "worker", "defined": true, "disabled": false, "kind": null, "contact": false, "permission": null,
            "candidates": [{ "provider": "openai", "model": "gpt-5", "effort": "medium" }] },
        "delegation": { "chain": ["lead"], "acting": "lead" },
    });
    let rig = rig(&scenario, Some(&host));
    let routine = SpawnContext { caller_session_id: Some("routine_exec_1".into()), owner_session_id: Some("routine_exec_1".into()), ..SpawnContext::default() };
    let run = rig.spawn.run_to_completion(&json!({ "agent": "worker", "prompt": "do it" }), "/work", &routine, &CancellationToken::new()).await;
    assert!(run.is_err(), "{run:?}");
    let board = &rig.shared.board;
    board.cleanup_jobs(&Scope::default(), true);
    assert!(board.result_delivered("sess_w1", "worker-1", "routine_exec_1", &Scope::default()));
}
