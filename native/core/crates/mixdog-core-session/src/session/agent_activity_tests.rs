//! The job board's activity signal on the owner's thread (`agent_activity.rs`):
//! - a loaded thread publishes its status once, one settle beat after it starts;
//! - Node's agent status listener publishes the lists only when they changed;
//! - only a loaded thread hears the signal;
//! - the idle clock counts the thread's background work as work, and restarts on the signal.

use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use crate::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

/// The `thread/agents/updated` values published on `thread`'s feed so far.
fn published(rig: &Rig, thread: &ThreadId) -> Vec<Value> {
    rig.feeds
        .frames(thread.as_str())
        .into_iter()
        .filter(|(_, method, _)| method == "thread/agents/updated")
        .map(|(_, _, params)| params["value"].clone())
        .collect()
}

fn agents(tag: &str) -> ThreadAgents {
    ThreadAgents { agent_workers: Vec::new(), agent_jobs: vec![json!({ "task_id": "task-1", "tag": tag, "status": "running" })], ..Default::default() }
}

fn set_status(rig: &Rig, status: ThreadAgents) {
    *rig.agents.status.lock().unwrap() = status;
}

fn reads(rig: &Rig) -> usize {
    rig.agents.reads.lock().unwrap().len()
}

/// The load's first status pass reads the status one settle beat (16 ms) after the thread
/// starts. Node's initial lists are empty, so an empty status publishes nothing; one with rows
/// publishes them.
#[tokio::test(start_paused = true)]
async fn a_loaded_thread_publishes_its_agent_status_after_one_settle_beat() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let quiet = start_thread(&directory).await;
    // The settle beat passes only by this advance.
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    eventually_on!(&[&rig.agents.read], || (reads(&rig) == 1).then_some(())).await;
    mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    assert!(published(&rig, &quiet.id).is_empty(), "empty lists are Node's initial state: no change");

    set_status(&rig, agents("review"));
    let started = tokio::time::Instant::now();
    let busy = start_thread(&directory).await;
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    eventually_on!(&[&rig.feeds.published], || (published(&rig, &busy.id).len() == 1).then_some(())).await;
    assert!(tokio::time::Instant::now() - started >= super::actor::STATUS_SETTLE, "not before the settle beat");
    assert_eq!(published(&rig, &busy.id), vec![serde_json::to_value(agents("review")).unwrap()]);
}

/// Each signal reads the owner's status again; an answer equal to the published one publishes
/// nothing (`publishChanged`), a changed one is published.
#[tokio::test(start_paused = true)]
async fn a_job_change_republishes_the_owners_agent_status_only_when_it_changed() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    // The load's own pass (empty lists, nothing published).
    eventually_on!(&[&rig.agents.read], || (reads(&rig) == 1).then_some(())).await;

    set_status(&rig, agents("review"));
    directory.agent_activity(handle.id.as_str());
    eventually_on!(&[&rig.feeds.published], || (published(&rig, &handle.id).len() == 1).then_some(())).await;

    // The same answer: read again, published no second time.
    directory.agent_activity(handle.id.as_str());
    eventually_on!(&[&rig.agents.read], || (reads(&rig) == 3).then_some(())).await;

    set_status(&rig, agents("plan"));
    directory.agent_activity(handle.id.as_str());
    eventually_on!(&[&rig.feeds.published], || (published(&rig, &handle.id).len() == 2).then_some(())).await;
    assert_eq!(
        published(&rig, &handle.id),
        vec![serde_json::to_value(agents("review")).unwrap(), serde_json::to_value(agents("plan")).unwrap()],
        "the repeated answer between them published nothing"
    );
    assert!(rig.agents.reads.lock().unwrap().iter().all(|thread| thread == &handle.id), "only the owner's status is read");
}

/// A session with no runtime here hears nothing: no status is read for it.
#[tokio::test(start_paused = true)]
async fn a_thread_that_is_not_loaded_hears_nothing() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    tokio::time::advance(super::actor::STATUS_SETTLE).await;
    eventually_on!(&[&rig.agents.read], || (reads(&rig) == 1).then_some(())).await;
    directory.agent_activity("never-loaded");
    directory.agent_activity("");
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(*rig.agents.reads.lock().unwrap(), vec![handle.id.clone()], "only the loaded thread's own load pass");
    assert!(published(&rig, &handle.id).is_empty());
}

/// `idle-clock.mjs`: a deadline that finds the thread's background work running waits its whole
/// delay again; the job ending (the signal) starts the clock over, and the thread unloads one
/// full delay later.
#[tokio::test(start_paused = true)]
async fn a_thread_nobody_watched_stays_while_its_background_work_runs() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "start the job", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    rig.work.0.store(true, Ordering::SeqCst);

    tokio::time::advance(super::actor::IDLE_EVICT + Duration::from_secs(1)).await;
    mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    assert!(directory.handle(&handle.id).is_some(), "background work keeps the thread");

    rig.work.0.store(false, Ordering::SeqCst);
    directory.agent_activity(handle.id.as_str());
    mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    tokio::time::advance(super::actor::IDLE_EVICT - Duration::from_secs(1)).await;
    mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    assert!(directory.handle(&handle.id).is_some(), "the clock started over at the signal");
    tokio::time::advance(Duration::from_secs(2)).await;
    eventually_on!(&[&handle.cell.stepped, directory.left()], || directory.handle(&handle.id).is_none().then_some(())).await;
}

/// How often the actors emitted `signal` (`approval`, `record`) for `thread`.
fn signals(rig: &Rig, signal: &str, thread: &ThreadId) -> usize {
    let want = format!("{signal}:{}", thread.as_str());
    rig.signals.0.lock().unwrap().iter().filter(|seen| **seen == want).count()
}

/// `sessionRecords.onChange`: an acked header change of the thread is its record signal.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_header_change_signals_the_session_record() {
    use mixdog_core_api::ThreadHandle;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::ids::Method;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let before = signals(&rig, "record", &handle.id);
    let patch = json!({ "threadId": handle.id, "set": { "provider": "openai", "model": "gpt-5" }, "unset": [] });
    handle
        .request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") })
        .await
        .expect("patch");
    eventually_on!(&[&rig.signals.1], || (signals(&rig, "record", &handle.id) > before).then_some(())).await;
}

/// `onSessionApprovalWaitChange`: a turn that starts waiting on an approval signals once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approval_wait_signals_the_approval_change() {
    use std::sync::Arc;

    use mixdog_core_api::domain::approval::ApprovalAsk;
    use mixdog_core_api::domain::approval::ApprovalGate;
    use mixdog_core_api::domain::approval::ApprovalKind;

    use super::seams::RunOutcome;

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::Tool,
                    call_id: None,
                    tool: Some("shell".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "kind": "shell", "tool": "shell", "request": { "target": "make" } }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert_eq!(signals(&rig, "approval", &handle.id), 0, "no wait before the turn");
    turn(&handle, "long job", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.approvals.load().is_empty()).then_some(())).await;
    eventually_on!(&[&rig.signals.1], || (signals(&rig, "approval", &handle.id) == 1).then_some(())).await;
}
