//! The core's hold on new turn starts (`hold{on}`, LR §5.1) as a session follows it: a client's prompt is queued at once and the
//! release starts it, an in-core start waits out the hold before it is admitted (Node's `daemonWorkGate.deferring`), and the drain
//! commit that drops the hold refuses what it kept waiting (`daemonWorkGate.shutdown()`); and a busy session is running work the
//! core's lifecycle counts (Node's `busySessions`).

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;
use std::time::Duration;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::thread::Stop;
use mixdog_protocol::DrainReason;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

use super::BusyHold;
use super::CoreWork;
use super::SessionDirectory;
use super::SessionHandle;
use super::StartHold;
use super::testing::Rig;
use super::testing::awaiting;
use super::tests::connection;
use super::tests::idle;
use super::tests::request;
use super::tests::rows;
use super::tests::start_thread;
use crate::eventually_on;

/// A directory whose sessions follow `hold` as the core's hold on turn starts.
fn held(rig: &Rig) -> (watch::Sender<StartHold>, SessionDirectory) {
    held_counting(rig, Arc::new(super::NoCoreWork))
}

/// [`held`], with the sessions' busy turns counted by `work`.
fn held_counting(rig: &Rig, work: Arc<dyn CoreWork>) -> (watch::Sender<StartHold>, SessionDirectory) {
    let (hold, gate) = watch::channel(StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = gate;
    deps.core_work = work;
    (hold, SessionDirectory::new(Arc::new(deps)))
}

/// The busy periods a session began, those still held, and the runs registered in them.
#[derive(Default)]
struct Counted {
    began: AtomicUsize,
    held: Arc<AtomicUsize>,
    runs: Arc<AtomicUsize>,
}

struct Period {
    held: Arc<AtomicUsize>,
    runs: Arc<AtomicUsize>,
}

impl CoreWork for Counted {
    fn busy(&self, _: &ThreadId, _: &str) -> Box<dyn BusyHold> {
        self.began.fetch_add(1, SeqCst);
        self.held.fetch_add(1, SeqCst);
        Box::new(Period { held: self.held.clone(), runs: self.runs.clone() })
    }
}

impl BusyHold for Period {
    fn run(&self, _: &mixdog_rt::CancellationToken) -> Box<dyn Send + Sync> {
        self.runs.fetch_add(1, SeqCst);
        Box::new(())
    }
}

impl Drop for Period {
    fn drop(&mut self) {
        self.held.fetch_sub(1, SeqCst);
    }
}

/// Node's `busySessions` (`busy.mjs` `sessionTurnBusy`: `busy`, and the `queued` input a settling turn runs next): the prompts the
/// hold queued run as one busy period of the session, which holds the core from the first one's start until the last one settled,
/// with each run registered for a confirmed stop's abort; input the hold keeps queued is no busy work.
#[tokio::test(start_paused = true)]
async fn a_session_is_busy_from_its_first_queued_turn_until_the_last_one_settled() {
    let rig = Rig::new();
    let counted = Arc::new(Counted::default());
    let (hold, directory) = held_counting(&rig, counted.clone());
    let handle = start_thread(&directory).await;
    hold.send_replace(StartHold::Held);
    for (op, prompt) in [("op-1", "first"), ("op-2", "second")] {
        answer(&handle, submit(&handle, op, prompt, "")).await.expect("admitted");
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 2).then_some(())).await;
    assert_eq!(counted.began.load(SeqCst), 0, "input the hold keeps queued is not busy");

    hold.send_replace(StartHold::Open);
    let user = |text: &str| ("user", text.to_owned());
    eventually_on!(&[&handle.cell.stepped], || (counted.held.load(SeqCst) == 0 && handle.cell.queue.load().is_empty() && rows(&handle).contains(&user("second"))).then_some(())).await;
    assert!(idle(&handle));
    assert_eq!(counted.began.load(SeqCst), 1, "one busy period, with no gap between the queued turns");
    assert!(counted.runs.load(SeqCst) >= 1, "each run is registered");
}

/// A client's `turn/start` of `prompt`, naming `submission` when it is not empty.
fn submit(handle: &SessionHandle, op: &str, prompt: &str, submission: &str) -> CoreRequest {
    let options = if submission.is_empty() { json!({}) } else { json!({ "clientSubmissionId": submission }) };
    request("turn/start", json!({ "threadId": handle.id, "opId": op, "input": { "prompt": prompt, "options": options } }), op)
}

/// What a `turn/start` answers.
async fn answer(handle: &SessionHandle, req: CoreRequest) -> Result<Value, CoreError> {
    let Reply::Value(value) = handle.request(req).await? else { panic!("turn/start answers a value") };
    Ok(value)
}

/// A client's prompt under the hold is queued and answered at once, so its call keeps none of the thread's requests waiting
/// behind it; a stop naming it hands it back, and the release starts the prompt left queued.
#[tokio::test(start_paused = true)]
async fn a_client_prompt_under_the_hold_is_queued_at_once_and_the_release_starts_it() {
    let rig = Rig::new();
    let (hold, directory) = held(&rig);
    let handle = start_thread(&directory).await;
    hold.send_replace(StartHold::Held);

    for (op, prompt, submission) in [("op-1", "kept", "sub1"), ("op-2", "taken back", "sub2")] {
        let reply = answer(&handle, submit(&handle, op, prompt, submission)).await.expect("admitted");
        assert_eq!(reply["kind"], "queued", "answered at once, not held: {reply}");
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 2).then_some(())).await;
    assert!(idle(&handle), "nothing starts while the core holds turn starts");
    let stopped = handle.stop(Stop { turn: None, restore_prompt: None, submission_id: Some("sub2".into()), ctx: connection() }).await.expect("stop");
    assert_eq!(stopped["restoreText"], "taken back", "the stop hands the held prompt back: {stopped}");

    hold.send_replace(StartHold::Open);
    let user = |text: &str| ("user", text.to_owned());
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.queue.load().is_empty() && rows(&handle).contains(&user("kept"))).then_some(())).await;
    assert!(!rows(&handle).contains(&user("taken back")), "the prompt handed back never runs");
}

/// An in-core start (a routine's, a channel's) waits out the hold before it is admitted, as Node's `deferring` waits before
/// `admitted` enters the turn gate, so an idle delete is not held off meanwhile. The drain commit that drops the hold refuses it
/// with admission's refusal, refuses the starts that follow, and starts nothing the hold queued; a cancelled drain opens the hold
/// again, and what it queued starts on this core.
#[tokio::test(start_paused = true)]
async fn the_drain_commit_refuses_the_start_the_hold_kept_waiting() {
    let rig = Rig::new();
    let (hold, directory) = held(&rig);
    let handle = start_thread(&directory).await;
    hold.send_replace(StartHold::Held);

    let routine = {
        let handle = handle.clone();
        tokio::spawn(async move { answer(&handle, CoreRequest { ctx: CallContext::internal("routine"), ..submit(&handle, "op-in", "routine", "") }).await })
    };
    mixdog_rt::time::sleep(Duration::from_secs(1)).await;
    assert!(!routine.is_finished() && idle(&handle), "the in-core start waits for the hold");
    drop(directory.turn_gate().fence(&handle.id).expect("the waiting start holds no admission of the thread"));
    let queued = answer(&handle, submit(&handle, "op-1", "queued", "")).await.expect("admitted");
    assert_eq!(queued["kind"], "queued", "{queued}");

    hold.send_replace(StartHold::Closed(DrainReason::Update));
    let shutting_down = CoreError::ServerShuttingDown { drain_reason: DrainReason::Update };
    let refused = awaiting(|| "the held start to be refused".to_owned(), routine).await.expect("joined");
    assert_eq!(refused.err(), Some(shutting_down.clone()));
    assert_eq!(answer(&handle, submit(&handle, "op-2", "after", "")).await.err(), Some(shutting_down));
    assert!(idle(&handle) && handle.cell.queue.load().len() == 1, "the queued prompt stays for the next core");

    hold.send_replace(StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.queue.load().is_empty() && rows(&handle).contains(&("user", "queued".to_owned()))).then_some(())).await;
}

/// Node's work gate refuses a client's `retryFailedTurn` while it holds (`callRefusal`: `HOLD_ALLOWED_CALLS` lacks it), as the retry
/// starts a model turn at once; once the drain commit dropped the hold it is refused as admission refuses a start, and an open hold
/// lets it through to its own checks.
#[tokio::test(start_paused = true)]
async fn a_client_retry_is_refused_while_the_core_holds_turn_starts() {
    let rig = Rig::new();
    let (hold, directory) = held(&rig);
    let handle = start_thread(&directory).await;
    let retry = |op: &str| request("turn/retryFailed", json!({ "threadId": handle.id, "opId": op, "turnKey": "attempt:none" }), op);

    hold.send_replace(StartHold::Held);
    let refused = handle.request(retry("r-1")).await.err();
    assert_eq!(refused, Some(mixdog_core_base::support::failed("session", "daemon is holding new work for an update install")));
    hold.send_replace(StartHold::Closed(DrainReason::Update));
    assert_eq!(handle.request(retry("r-2")).await.err(), Some(CoreError::ServerShuttingDown { drain_reason: DrainReason::Update }));

    hold.send_replace(StartHold::Open);
    let Reply::Value(answer) = handle.request(retry("r-3")).await.expect("answered") else { panic!("turn/retryFailed answers a value") };
    assert_eq!(answer, json!(false), "no failed turn to retry");
}

/// An in-core start waiting out the hold keeps its thread loaded: the idle deadline coming meanwhile leaves the thread nobody
/// watches in memory (Node's start opens its session only after the wait; here the caller's start is on the thread's cell), and
/// the release starts it.
#[tokio::test(start_paused = true)]
async fn an_in_core_start_waiting_out_the_hold_keeps_its_thread_loaded() {
    let rig = Rig::new();
    let (hold, directory) = held(&rig);
    let handle = start_thread(&directory).await;
    hold.send_replace(StartHold::Held);
    let routine = {
        let handle = handle.clone();
        tokio::spawn(async move { answer(&handle, CoreRequest { ctx: CallContext::internal("routine"), ..submit(&handle, "op-in", "routine", "") }).await })
    };
    mixdog_rt::time::sleep(Duration::from_secs(1)).await;
    assert!(!routine.is_finished(), "the in-core start waits for the hold");

    handle.inbox.send(super::actor::Inbox::IdleDue).await.expect("the actor takes the inbox");
    // The paused clock moves only once every ready task has run: an unload the deadline decided would be done by then.
    mixdog_rt::time::sleep(Duration::from_secs(1)).await;
    assert!(directory.handle(&handle.id).is_some(), "the waiting start keeps the thread loaded");

    hold.send_replace(StartHold::Open);
    let started = awaiting(|| "the start the hold kept waiting".to_owned(), routine).await.expect("joined").expect("admitted");
    assert_eq!(started["kind"], "started", "{started}");
}
