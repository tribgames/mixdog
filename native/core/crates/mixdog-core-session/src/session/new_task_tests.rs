//! The receipt gate of a new task (`new_task.rs`) at `thread/start`: a request that arrives again starts one task, with the receipts,
//! phases and replies of `apps/desktop/src/main/new-task-requests.ts`. Each test names the behaviour a revert of it breaks.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_rt::CancellationToken;
use mixdog_statefile::new_task_receipt::Phase;
use mixdog_statefile::new_task_receipt::Receipt;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::SessionDirectory;
use super::new_task::NewTaskReceipts;
use super::seams::RunOutcome;
use super::testing::Rig;

const REUSED: &str = "Submission id was reused for different content.";

/// The bound of every wait in this file, in real time. The tests run on a paused clock, which moves only when a test advances it,
/// so a deadline taken on it never fires for a wait that stalls: the bound is a thread's, outside the runtime.
const BOUND: std::time::Duration = std::time::Duration::from_secs(60);

/// `work`, or a failure naming `what` once `BOUND` of real time has passed without it. The deadline is a thread that waits on a
/// channel for the work's end: it ends with the work, and when the bound passes first it wakes the test, which then fails.
async fn within<T>(what: &str, work: impl std::future::Future<Output = T>) -> T {
    bounded(|| what.to_owned(), work).await
}

/// The step a test has reached, named in its deadline's failure.
#[derive(Clone)]
struct Steps(Arc<std::sync::Mutex<&'static str>>);

impl Steps {
    fn at(&self, step: &'static str) {
        *self.0.lock().unwrap() = step;
    }
}

/// A test's whole body under one real-time deadline (`BOUND`), whose failure names the test and the step it reached: the awaits
/// inside need none of their own.
async fn whole<F, Fut>(test: &str, body: F)
where
    F: FnOnce(Steps) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let steps = Steps(Arc::new(std::sync::Mutex::new("its start")));
    let reached = steps.clone();
    bounded(move || format!("{test}, at {}", reached.0.lock().unwrap()), body(steps)).await;
}

async fn bounded<T>(what: impl FnOnce() -> String, work: impl std::future::Future<Output = T>) -> T {
    let (done, waiting) = std::sync::mpsc::channel::<()>();
    let (expire, expired) = tokio::sync::oneshot::channel::<()>();
    std::thread::spawn(move || {
        if waiting.recv_timeout(BOUND) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
            expire.send(()).ok();
        }
    });
    tokio::select! {
        biased;
        out = work => {
            drop(done);
            out
        }
        _ = expired => panic!("{}: not within {BOUND:?}", what()),
    }
}

fn hex_sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn receipt_path(rig: &Rig, id: &str) -> std::path::PathBuf {
    rig._data.path().join("userdata").join("new-task-receipts").join(format!("{}.json", hex_sha(id)))
}

fn stored(rig: &Rig, id: &str) -> Option<Receipt> {
    Receipt::parse(&std::fs::read(receipt_path(rig, id)).ok()?)
}

/// A rig whose every run is counted: a run is a prompt that was sent.
fn counting(rig: &Rig) -> Arc<AtomicUsize> {
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = runs.clone();
    rig.set_script(Arc::new(move |_run| {
        counted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { RunOutcome::Completed(Default::default()) })
    }));
    runs
}

fn directory_over(rig: &Rig) -> (SessionDirectory, Arc<NewTaskReceipts>) {
    let deps = Arc::new(rig.deps_parts(rig.store.clone()));
    let receipts = deps.new_tasks.clone();
    (SessionDirectory::new(deps), receipts)
}

/// The submit of the desktop and the phone: `thread/start` of a task with its first prompt and the client's submission id.
async fn submit(directory: &SessionDirectory, op: &str, id: &str, prompt: &str, draft: Value) -> Result<String, CoreError> {
    submit_on(directory, op, id, prompt, draft, CancellationToken::new()).await
}

/// `submit` on a connection whose end cancels `connection`.
async fn submit_on(directory: &SessionDirectory, op: &str, id: &str, prompt: &str, draft: Value, connection: CancellationToken) -> Result<String, CoreError> {
    let reply = directory
        .request(CoreRequest {
            method: Method("thread/start"),
            params: json!({
                "opId": op, "kind": "task", "projectPath": "/ws", "draft": draft,
                "initialInput": { "prompt": prompt, "options": { "clientSubmissionId": id } },
            }),
            op: Some(OpId::from(op)),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, connection),
        })
        .await?;
    let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
    Ok(subscribe.result["thread"]["id"].as_str().expect("thread id").to_owned())
}

fn derived(id: &str) -> String {
    format!("sess_desktop_{}", hex_sha(id))
}

/// A route the draft names is refused (the route layer's own refusal of an unknown provider).
struct RefusesDraftRoute;

#[async_trait::async_trait]
impl super::NewThreadRoute for RefusesDraftRoute {
    async fn adopt(&self, _: &mixdog_core_api::ids::ThreadId, pick: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        if pick.is_some() { Err("route refused".to_owned()) } else { Ok(serde_json::Map::new()) }
    }

    async fn adopt_control(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn seat(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<(), String> {
        Ok(())
    }
}

const REFUSED_ROUTE: fn() -> Value = || json!({ "route": { "provider": "p", "model": "m" } });

/// The dedupe itself: a retry (a new `opId`, the same submission id and content) answers the first task and sends no second prompt.
#[tokio::test(start_paused = true)]
async fn a_retried_request_starts_one_task() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, receipts) = directory_over(&rig);
    let first = within("the first request's answer", submit(&directory, "op-1", "sub-a", "write the report", json!({}))).await.expect("first");
    let retry = within("the retry's answer", submit(&directory, "op-2", "sub-a", "write the report", json!({}))).await.expect("retry");
    assert_eq!(first, derived("sub-a"), "the address is derived from the submission id");
    assert_eq!(retry, first);
    assert_eq!(directory.loaded_ids().len(), 1, "one task");
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one prompt");
    let receipt = stored(&rig, "sub-a").expect("a receipt");
    assert_eq!((receipt.phase(), receipt.session_id(), receipt.refused()), (Phase::Accepted, first.as_str(), false));
    // The phases are written as Node writes them: only `accepted` is flushed before it is reported.
    let writes = receipts.writes.lock().unwrap().clone();
    assert_eq!(writes, vec![("reserved".to_owned(), false), ("configured".to_owned(), false), ("accepted".to_owned(), true)]);
}

/// The durability order for `accepted`: the receipt is not `accepted` while the prompt is being sent, and is flushed once it is.
#[tokio::test(start_paused = true)]
async fn the_accepted_receipt_follows_the_prompt_and_is_flushed() {
    let rig = Rig::new();
    let seen = Arc::new(std::sync::Mutex::new(None));
    let (path, at_run) = (receipt_path(&rig, "sub-order"), seen.clone());
    rig.set_script(Arc::new(move |_run| {
        *at_run.lock().unwrap() = Receipt::parse(&std::fs::read(&path).expect("the receipt exists when the prompt is sent")).map(|receipt| receipt.phase());
        Box::pin(async { RunOutcome::Completed(Default::default()) })
    }));
    let (directory, receipts) = directory_over(&rig);
    within("the request's answer", submit(&directory, "op-1", "sub-order", "write the report", json!({}))).await.expect("first");
    assert_eq!(*seen.lock().unwrap(), Some(Phase::Configured), "the prompt is sent before the receipt says accepted");
    let writes = receipts.writes.lock().unwrap().clone();
    assert_eq!(writes.last(), Some(&("accepted".to_owned(), true)), "accepted is flushed before it is reported");
    assert!(writes[..writes.len() - 1].iter().all(|(_, flushed)| !flushed), "reserved and configured are atomic renames only");
}

/// The changed-content rule: the same id with other content is refused, and nothing is created or changed.
#[tokio::test(start_paused = true)]
async fn the_same_id_with_other_content_is_refused_and_creates_nothing() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    within("the first request's answer", submit(&directory, "op-1", "sub-b", "write the report", json!({}))).await.expect("first");
    let before = std::fs::read(receipt_path(&rig, "sub-b")).expect("receipt");
    let changed = within("the changed request's answer", submit(&directory, "op-2", "sub-b", "write another report", json!({}))).await;
    assert!(matches!(&changed, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == REUSED), "{changed:?}");
    assert_eq!(directory.loaded_ids().len(), 1);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(receipt_path(&rig, "sub-b")).expect("receipt"), before, "the receipt is as it was");
}

/// The phase resumed after a crash: a `configured` receipt over a thread that holds the prompt sends no second prompt and ends `accepted`.
#[tokio::test(start_paused = true)]
async fn a_retry_after_a_crash_resumes_at_configured_without_a_second_prompt() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    within("the first request's answer", submit(&directory, "op-1", "sub-c", "write the report", json!({}))).await.expect("first");
    // The process ended after the prompt was accepted and before `accepted` was written.
    let receipt = stored(&rig, "sub-c").expect("receipt");
    std::fs::write(receipt_path(&rig, "sub-c"), receipt.with_phase(Phase::Configured).to_bytes()).expect("rewind");
    let (restarted, receipts) = directory_over(&rig);
    let retry = within("the retry's answer", submit(&restarted, "op-2", "sub-c", "write the report", json!({}))).await.expect("retry");
    assert_eq!(retry, derived("sub-c"));
    assert_eq!(runs.load(Ordering::SeqCst), 1, "the prompt the thread holds is not sent again");
    assert_eq!(stored(&rig, "sub-c").expect("receipt").phase(), Phase::Accepted);
    assert_eq!(*receipts.writes.lock().unwrap(), vec![("accepted".to_owned(), true)], "the attempt resumes at configured: nothing is reserved or configured again");
}

/// The phase resumed after a crash: a `reserved` receipt with no thread behind it starts the task at the reserved address.
#[tokio::test(start_paused = true)]
async fn a_retry_after_a_crash_at_reserved_creates_the_task_at_the_reserved_address() {
    let first = Rig::new();
    counting(&first);
    let (directory, _) = directory_over(&first);
    within("the first request's answer", submit(&directory, "op-1", "sub-d", "write the report", json!({}))).await.expect("first");
    let reserved = stored(&first, "sub-d").expect("receipt").with_phase(Phase::Reserved);
    // A core that never made the thread: another store, the receipt as the interrupted attempt left it.
    let rig = Rig::new();
    let runs = counting(&rig);
    std::fs::create_dir_all(receipt_path(&rig, "sub-d").parent().unwrap()).expect("folder");
    std::fs::write(receipt_path(&rig, "sub-d"), reserved.to_bytes()).expect("seed");
    let (restarted, receipts) = directory_over(&rig);
    let retry = within("the retry's answer", submit(&restarted, "op-2", "sub-d", "write the report", json!({}))).await.expect("retry");
    assert_eq!(retry, derived("sub-d"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&rig, "sub-d").expect("receipt").phase(), Phase::Accepted);
    assert_eq!(*receipts.writes.lock().unwrap(), vec![("configured".to_owned(), false), ("accepted".to_owned(), true)], "the attempt resumes at reserved: the reservation is not made again");
}

/// The refusal reset: an attempt refused before the prompt leaves a marked receipt on a fresh address, flushed; the id may then be
/// sent with other content, which starts there on a fresh address of its own, the mark cleared.
#[tokio::test(start_paused = true)]
async fn a_refused_attempt_marks_its_receipt_and_frees_the_id() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(RefusesDraftRoute);
    let deps = Arc::new(deps);
    let (receipts, directory) = (deps.new_tasks.clone(), SessionDirectory::new(deps));
    let refused = within("the refusal", submit(&directory, "op-1", "sub-e", "write the report", REFUSED_ROUTE())).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if message.contains("route refused")), "{refused:?}");
    let mark = stored(&rig, "sub-e").expect("receipt");
    assert!(mark.refused() && mark.phase() == Phase::Reserved);
    assert_ne!(mark.session_id(), derived("sub-e"), "the refused reservation is not resumed");
    assert_eq!(receipts.writes.lock().unwrap().last(), Some(&("reserved+refused".to_owned(), true)));
    let other = within("the other content's answer", submit(&directory, "op-2", "sub-e", "write something else", json!({}))).await.expect("other content");
    assert_ne!(other, mark.session_id());
    assert_ne!(other, derived("sub-e"));
    let receipt = stored(&rig, "sub-e").expect("receipt");
    assert_eq!((receipt.phase(), receipt.refused(), receipt.session_id()), (Phase::Accepted, false, other.as_str()));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    // The write that frees the id is flushed too.
    assert!(receipts.writes.lock().unwrap().contains(&("reserved".to_owned(), true)));
}

/// A receipt that is already on disk when the core starts (the one Node wrote, carried over by the migration under the same name and
/// bytes) is answered as Node answers it: `accepted` replays the session and sends nothing.
#[tokio::test(start_paused = true)]
async fn an_accepted_receipt_found_at_start_answers_the_session_and_sends_nothing() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    let first = within("the first request's answer", submit(&directory, "op-1", "sub-m", "write the report", json!({}))).await.expect("first");
    let on_disk = std::fs::read(receipt_path(&rig, "sub-m")).expect("receipt");
    assert_eq!(on_disk, stored(&rig, "sub-m").expect("receipt").to_bytes(), "the file is the receipt's own bytes");
    let (restarted, receipts) = directory_over(&rig);
    let replay = within("the replayed answer", submit(&restarted, "op-2", "sub-m", "write the report", json!({}))).await.expect("replay");
    assert_eq!(replay, first);
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read(receipt_path(&rig, "sub-m")).expect("receipt"), on_disk, "nothing is written for a replay");
    assert!(receipts.writes.lock().unwrap().is_empty());
}
/// The first route adoption is held until released and says when it is entered: an attempt stopped between `reserved` and
/// `configured`.
struct HeldRoute {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    held: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl super::NewThreadRoute for HeldRoute {
    async fn adopt(&self, _: &mixdog_core_api::ids::ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        if !self.held.swap(true, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.acquire().await.expect("open").forget();
        }
        Ok(serde_json::Map::new())
    }

    async fn adopt_control(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn seat(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<(), String> {
        Ok(())
    }
}

/// A lost reply: the client's connection ends while its request runs, and the client retries. The attempt does not end with its
/// caller (Node's promise runs without it), so the reply lost after any phase leaves the attempt running on to `accepted` (or to a
/// refusal): the retry joins it or reads its receipt. One task, one prompt.
#[tokio::test(start_paused = true)]
async fn a_request_whose_reply_is_lost_runs_on_and_the_retry_gets_its_task() {
    whole("a_request_whose_reply_is_lost_runs_on_and_the_retry_gets_its_task", |step| async move {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldRoute { entered: entered.clone(), release: release.clone(), held: false.into() });
    let deps = Arc::new(deps);
    let receipts = deps.new_tasks.clone();
    let directory = SessionDirectory::new(deps);
    let connection = CancellationToken::new();
    // The attempt is past `reserved`: the connection ends and the call is dropped with it, before any answer.
    step.at("the attempt reaching its held route");
    tokio::select! {
        () = entered.notified() => connection.cancel(),
        answered = submit_on(&directory, "op-1", "sub-l", "write the report", json!({}), connection.clone()) => panic!("answered while held: {answered:?}"),
    }
    assert_eq!(stored(&rig, "sub-l").expect("receipt").phase(), Phase::Reserved, "the reply is lost after `reserved`");
    // The retry arrives while the attempt is still held, and joins it: no second attempt starts. Each other way the retry can go
    // (a second attempt, or an answer without joining) ends the wait as a failure.
    let mut attempts = receipts.attempts.subscribe();
    assert_eq!(*attempts.borrow(), 1, "the held attempt");
    let mut retry = tokio::spawn({
        let directory = directory.share();
        async move { submit(&directory, "op-2", "sub-l", "write the report", json!({})).await }
    });
    step.at("the retry joining the held attempt, starting a second one or being answered");
    tokio::select! {
        () = receipts.joined.notified() => {}
        _ = attempts.wait_for(|started| *started > 1) => panic!("the retry started a second attempt instead of joining the held one"),
        answered = &mut retry => panic!("the retry was answered without joining the held attempt: {answered:?}"),
    }
    assert_eq!(*attempts.borrow(), 1, "one attempt");
    release.add_permits(1);
    step.at("the joined retry's answer once the attempt was released");
    let retry = retry.await.expect("joined").expect("retry");
    assert_eq!(retry, derived("sub-l"));
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one prompt");
    assert_eq!(directory.loaded_ids().len(), 1, "one task");
    let receipt = stored(&rig, "sub-l").expect("receipt");
    assert_eq!((receipt.phase(), receipt.refused()), (Phase::Accepted, false));
    let writes = receipts.writes.lock().unwrap().clone();
    assert_eq!(writes, vec![("reserved".to_owned(), false), ("configured".to_owned(), false), ("accepted".to_owned(), true)], "one attempt's phases");
    })
    .await;
}

/// An attempt that panics gives up its place: the callers it had get no answer, and the next request for the id starts afresh
/// instead of joining an attempt that will never answer.
#[tokio::test(start_paused = true)]
async fn an_attempt_that_panics_frees_its_id() {
    let rig = Rig::new();
    let receipts = NewTaskReceipts::new(&rig._data.path().join("userdata"), mixdog_rt::testing::tokens().durability_io);
    let panicked = within("the panicked attempt's answer", receipts.run("sub-p", &json!({}), |_| async { panic!("the attempt's seam panics") })).await;
    assert!(matches!(&panicked, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == "The new task request ended without an answer."), "{panicked:?}");
    assert_eq!(receipts.in_flight(), 0, "the panicked attempt gave up its place");
    let next = within(
        "the next attempt's answer",
        receipts.run("sub-p", &json!({}), |_| async { Err(mixdog_core_base::support::failed("session", "the next attempt ran")) }),
    )
    .await;
    assert!(matches!(&next, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == "the next attempt ran"), "{next:?}");
}

/// At shutdown an attempt in flight is cut where it stands, as a process ending there: shutdown returns with nothing in flight,
/// the receipt keeps the phase it had (not marked refused by the closed directory's refusal), and the next start resumes it. As in
/// Node's quit, neither the caller in flight nor a request after shutdown gets an answer or a refusal: the request ends with its
/// connection (`apps/desktop/src/main/index.ts:1662-1664` detaches the phones' carriers first and nothing ends the attempt).
#[tokio::test(start_paused = true)]
async fn shutdown_cuts_an_attempt_in_flight_and_the_next_start_resumes_it() {
    whole("shutdown_cuts_an_attempt_in_flight_and_the_next_start_resumes_it", |step| async move {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldRoute { entered: entered.clone(), release: release.clone(), held: false.into() });
    let deps = Arc::new(deps);
    let receipts = deps.new_tasks.clone();
    let directory = SessionDirectory::new(deps);
    let caller = submit(&directory, "op-1", "sub-s", "write the report", json!({}));
    tokio::pin!(caller);
    step.at("the attempt reaching its held route");
    tokio::select! {
        () = entered.notified() => {}
        answered = &mut caller => panic!("answered while held: {answered:?}"),
    }
    step.at("the directory's shutdown");
    directory.shutdown().await;
    assert_eq!(receipts.in_flight(), 0, "the attempt was cut");
    // Nothing the attempt held runs on: released now, it would write `configured`.
    release.add_permits(1);
    let polled = |future: std::pin::Pin<&mut dyn std::future::Future<Output = Result<String, CoreError>>>| {
        future.poll(&mut std::task::Context::from_waker(std::task::Waker::noop())).map(|answer| format!("{answer:?}"))
    };
    assert_eq!(polled(caller.as_mut()), std::task::Poll::Pending, "the caller in flight got an answer at shutdown");
    assert_eq!(*receipts.writes.lock().unwrap(), vec![("reserved".to_owned(), false)]);
    let receipt = stored(&rig, "sub-s").expect("receipt");
    assert_eq!((receipt.phase(), receipt.refused(), receipt.session_id()), (Phase::Reserved, false, derived("sub-s").as_str()));
    let later = submit(&directory, "op-2", "sub-s", "write the report", json!({}));
    tokio::pin!(later);
    assert_eq!(polled(later.as_mut()), std::task::Poll::Pending, "a request after shutdown got an answer");
    assert_eq!(*receipts.attempts.borrow(), 1, "a request after shutdown started an attempt");
    let (restarted, _) = directory_over(&rig);
    step.at("the retry's answer after the restart");
    let retry = submit(&restarted, "op-3", "sub-s", "write the report", json!({})).await.expect("retry");
    assert_eq!(retry, derived("sub-s"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&rig, "sub-s").expect("receipt").phase(), Phase::Accepted);
    })
    .await;
}

/// The route is seated on the created session, the last step of its creation (the record is written, `begin_thread` has not
/// returned), and held there until released, saying when it is entered.
struct HeldSeat {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    held: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl super::NewThreadRoute for HeldSeat {
    async fn adopt(&self, _: &mixdog_core_api::ids::ThreadId, _: Option<&serde_json::Map<String, Value>>) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn adopt_control(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<serde_json::Map<String, Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn seat(&self, _: &mixdog_core_api::ids::ThreadId) -> Result<(), String> {
        if !self.held.swap(true, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.acquire().await.expect("open").forget();
        }
        Ok(())
    }
}

/// A shutdown while the session's creation has written its record and not returned (Node: `client.create` pending, its daemon
/// having made the session) ends the attempt before the `try` that refuses (session-host-lifecycle.ts:824-835): the receipt stays
/// `reserved` at its address, unmarked. The caller gets no answer; the retry after the restart opens the session there and starts
/// the task in it, as the recorded `retry-after-created` does: one task, one prompt, at the derived address. The draft names no
/// route: a draft's route is Node's `setRoute`, awaited after `client.create` returned (see the quit tests below).
#[tokio::test(start_paused = true)]
async fn shutdown_while_the_creation_has_not_returned_keeps_the_reservation() {
    whole("shutdown_while_the_creation_has_not_returned_keeps_the_reservation", |step| async move {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldSeat { entered: entered.clone(), release: release.clone(), held: false.into() });
    let deps = Arc::new(deps);
    let receipts = deps.new_tasks.clone();
    let directory = SessionDirectory::new(deps);
    let caller = submit(&directory, "op-1", "sub-q", "write the report", json!({}));
    tokio::pin!(caller);
    step.at("the creation reaching its held seat");
    tokio::select! {
        () = entered.notified() => {}
        answered = &mut caller => panic!("answered while held: {answered:?}"),
    }
    let header = directory.try_stored_header(&mixdog_core_api::ids::ThreadId::from(derived("sub-q"))).await.expect("read");
    assert!(header.is_some(), "the creation wrote its record");
    step.at("the directory's shutdown");
    directory.shutdown().await;
    release.add_permits(1);
    let polled = caller.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
    assert!(polled.is_pending(), "the caller in flight got an answer at shutdown: {polled:?}");
    let receipt = stored(&rig, "sub-q").expect("receipt");
    assert_eq!((receipt.phase(), receipt.refused(), receipt.session_id()), (Phase::Reserved, false, derived("sub-q").as_str()), "the reservation is kept");
    assert_eq!(*receipts.writes.lock().unwrap(), vec![("reserved".to_owned(), false)]);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldSeat { entered: Arc::default(), release: Arc::new(tokio::sync::Semaphore::new(0)), held: true.into() });
    let restarted = SessionDirectory::new(Arc::new(deps));
    step.at("the retry's answer after the restart");
    let retry = submit(&restarted, "op-2", "sub-q", "write the report", json!({})).await.expect("retry");
    assert_eq!(retry, derived("sub-q"), "the retry starts the task in the session at the reserved address");
    assert_eq!(stored(&rig, "sub-q").expect("receipt").phase(), Phase::Accepted);
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one prompt");
    assert_eq!(restarted.loaded_ids().len(), 1, "one task");
    })
    .await;
}

/// The draft's worktree is entered and held there until released, saying when it is entered.
struct HeldPlace {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    held: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl super::NewThreadPlace for HeldPlace {
    async fn projects(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    async fn enter_worktree(&self, _: &mixdog_core_api::ids::ThreadId, _: &Value, _: Option<&Value>, _: &CancellationToken) -> Result<(), CoreError> {
        if !self.held.swap(true, Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.acquire().await.expect("open").forget();
        }
        Ok(())
    }
}

/// What Node recorded for a quit scenario (golden.json, `quit-*`): after the quit, the receipt and the sessions; after the retry,
/// its address, the receipt and the sessions. A receipt is its file's JSON less `signature`, the hash of the content, which here is
/// the test's own (the replay compares the content Node sent, signature included).
fn recorded_quit(scenario: &str) -> Value {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/new-task-dedupe/golden.json")).expect("golden");
    let recorded = &golden["scenarios"][scenario]["recorded"];
    let receipt = |step: &Value| {
        let files = step["receipts"].as_object().expect("the receipts");
        assert_eq!(files.len(), 1, "one receipt");
        unsigned(files.values().next().and_then(Value::as_str).expect("a receipt's text"))
    };
    json!({
        "quit": { "receipt": receipt(&recorded[0]), "sessions": recorded[0]["sessions"] },
        "retry": { "address": recorded[1]["reply"]["sessionId"], "receipt": receipt(&recorded[1]), "sessions": recorded[1]["sessions"] },
    })
}

fn unsigned(text: &str) -> Value {
    let mut receipt: Value = serde_json::from_str(text).expect("a receipt");
    receipt.as_object_mut().expect("an object").remove("signature");
    receipt
}

/// The core's addresses in the recording's terms: the derived one kept, every other numbered `<fresh:N>` by first appearance.
#[derive(Default)]
struct Names(Vec<String>);

impl Names {
    fn of(&mut self, id: &str, address: &str) -> String {
        if address == derived(id) {
            return address.to_owned();
        }
        if !self.0.iter().any(|seen| seen == address) {
            self.0.push(address.to_owned());
        }
        format!("<fresh:{}>", self.0.iter().position(|seen| seen == address).expect("named") + 1)
    }
}

/// The core's state in the recording's terms: the receipt of `id` (less its signature, its address named) and every session the
/// directory stores among `addresses`, with its prompts (at most the one this test's tasks send) and whether it is still only reserved.
async fn core_state(rig: &Rig, directory: &SessionDirectory, id: &str, names: &mut Names, addresses: &[String]) -> (Value, Value) {
    let mut receipt = unsigned(&String::from_utf8(std::fs::read(receipt_path(rig, id)).expect("the receipt")).expect("text"));
    let address = receipt["sessionId"].as_str().expect("an address").to_owned();
    receipt["sessionId"] = Value::String(names.of(id, &address));
    let mut sessions = serde_json::Map::new();
    for address in addresses {
        let thread = mixdog_core_api::ids::ThreadId::from(address.clone());
        if directory.try_stored_header(&thread).await.expect("read").is_some() {
            let prompts = usize::from(directory.holds_user_conversation(&thread).await.expect("rows"));
            sessions.insert(names.of(id, address), json!({ "prompts": prompts, "reserved": prompts == 0 }));
        }
    }
    (receipt, Value::Object(sessions))
}

/// A quit while the attempt awaits a call of its draft step (`quit-in-set-route`: the draft's route, which the core adopts inside its
/// creation call; `quit-in-request-worktree`: the draft's worktree): the call is held, the directory shuts down, and the receipt, the
/// sessions and the retry after the restart are what Node recorded: refused on a fresh address (session-host-lifecycle.ts:955, the
/// call failing inside the `try` while unsent), no session left, and the retry's task on that address with its one prompt. The caller in
/// flight gets no answer.
async fn quit_inside(step: Steps, scenario: &str, id: &str, draft: fn() -> Value, held: impl FnOnce(&mut super::SessionDeps, Arc<tokio::sync::Notify>, Arc<tokio::sync::Semaphore>)) {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    let mut deps = rig.deps_parts(rig.store.clone());
    held(&mut deps, entered.clone(), release.clone());
    let directory = SessionDirectory::new(Arc::new(deps));
    let caller = submit(&directory, "op-1", id, "write the report", draft());
    tokio::pin!(caller);
    step.at("the attempt reaching its held call");
    tokio::select! {
        () = entered.notified() => {}
        answered = &mut caller => panic!("answered while held: {answered:?}"),
    }
    step.at("the directory's shutdown");
    directory.shutdown().await;
    release.add_permits(1);
    let polled = caller.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
    assert!(polled.is_pending(), "the caller in flight got an answer at shutdown: {polled:?}");
    let node = recorded_quit(scenario);
    let mut names = Names::default();
    let fresh = stored(&rig, id).expect("receipt").session_id().to_owned();
    let addresses = [derived(id), fresh];
    let (receipt, sessions) = core_state(&rig, &directory, id, &mut names, &addresses).await;
    assert_eq!(json!({ "receipt": receipt, "sessions": sessions }), node["quit"], "after the quit");
    let (restarted, _) = directory_over(&rig);
    step.at("the retry's answer after the restart");
    let retry = submit(&restarted, "op-2", id, "write the report", draft()).await.expect("retry");
    let address = names.of(id, &retry);
    let (receipt, sessions) = core_state(&rig, &restarted, id, &mut names, &addresses).await;
    assert_eq!(json!({ "address": address, "receipt": receipt, "sessions": sessions }), node["retry"], "after the retry");
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one prompt");
}

#[tokio::test(start_paused = true)]
async fn a_quit_inside_the_draft_route_refuses_the_attempt_as_node_recorded() {
    whole("a_quit_inside_the_draft_route_refuses_the_attempt_as_node_recorded", |step| async move {
        quit_inside(step, "quit-in-set-route", "s-quit-route", REFUSED_ROUTE, |deps, entered, release| {
            deps.new_route = Arc::new(HeldRoute { entered, release, held: false.into() });
        })
        .await;
    })
    .await;
}

#[tokio::test(start_paused = true)]
async fn a_quit_inside_the_draft_worktree_refuses_the_attempt_as_node_recorded() {
    whole("a_quit_inside_the_draft_worktree_refuses_the_attempt_as_node_recorded", |step| async move {
        quit_inside(step, "quit-in-request-worktree", "s-quit-worktree", || json!({ "worktree": { "fromDefault": true } }), |deps, entered, release| {
            deps.new_place = Arc::new(HeldPlace { entered, release, held: false.into() });
        })
        .await;
    })
    .await;
}

/// A receipt write that does not end (stalled on durability) holds shutdown only up to its bound: shutdown is still waiting one tick
/// before it, and at the bound it ends, reporting the overrun.
#[tokio::test(start_paused = true)]
async fn shutdown_waits_for_a_stalled_receipt_write_only_up_to_its_bound() {
    let bound = std::time::Duration::from_millis(2500);
    let _clock = super::testing::HeldClock::hold();
    let rig = Rig::new();
    counting(&rig);
    let (directory, receipts) = directory_over(&rig);
    let stall = Arc::new(super::new_task::WriteStall::default());
    *receipts.stall.lock().unwrap() = Some(stall.clone());
    let caller = submit(&directory, "op-1", "sub-w", "write the report", json!({}));
    tokio::pin!(caller);
    within("the receipt write reaching its stall", async {
        tokio::select! {
            () = stall.entered.notified() => {}
            answered = &mut caller => panic!("answered while its write was stalled: {answered:?}"),
        }
    })
    .await;
    let shutdown = receipts.shutdown(bound);
    tokio::pin!(shutdown);
    let mut polled = || shutdown.as_mut().poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
    assert!(polled().is_pending(), "shutdown did not wait for the write that began");
    tokio::time::advance(bound - std::time::Duration::from_millis(1)).await;
    assert!(polled().is_pending(), "shutdown stopped waiting before its bound");
    tokio::time::advance(std::time::Duration::from_millis(1)).await;
    match polled() {
        std::task::Poll::Ready(Err(overrun)) => assert!(overrun.contains("did not end within 2.5s"), "{overrun}"),
        other => panic!("at the bound shutdown answered {other:?}, not the overrun"),
    }
    stall.release.add_permits(1);
}

/// Two identical requests at once start one task; two with other content, the first holds the id.
#[tokio::test(start_paused = true)]
async fn requests_at_once_join_or_are_refused() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    let (a, b) = within("the answers of two identical requests at once", async {
        tokio::join!(
            submit(&directory, "op-1", "sub-f", "write the report", json!({})),
            submit(&directory, "op-2", "sub-f", "write the report", json!({})),
        )
    })
    .await;
    assert_eq!(a.expect("a"), b.expect("b"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    let (c, d) = within("the answers of two requests with other content at once", async {
        tokio::join!(
            submit(&directory, "op-3", "sub-g", "write the report", json!({})),
            submit(&directory, "op-4", "sub-g", "write another", json!({})),
        )
    })
    .await;
    assert!(c.is_ok());
    assert!(matches!(&d, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == REUSED), "{d:?}");
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

/// A file that is no receipt binds nothing: the id starts on its derived address and the file is replaced.
#[tokio::test(start_paused = true)]
async fn a_file_that_is_no_receipt_binds_nothing() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    std::fs::create_dir_all(receipt_path(&rig, "sub-h").parent().unwrap()).expect("folder");
    std::fs::write(receipt_path(&rig, "sub-h"), [0u8; 64]).expect("nul-filled");
    let started = within("the request's answer", submit(&directory, "op-1", "sub-h", "write the report", json!({}))).await.expect("started");
    assert_eq!(started, derived("sub-h"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert_eq!(stored(&rig, "sub-h").expect("receipt").phase(), Phase::Accepted);
}

/// An I/O error reading the receipt fails the request (a directory where the file should be), with the error Node's read gives on
/// every system (its recording's `io-error` reply: `EISDIR` and its text, where Windows refuses the open as access denied).
#[tokio::test(start_paused = true)]
async fn an_io_error_reading_the_receipt_fails_the_request() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    std::fs::create_dir_all(receipt_path(&rig, "sub-i")).expect("obstruction");
    let failed = within("the request's refusal", submit(&directory, "op-1", "sub-i", "write the report", json!({}))).await.expect_err("refused");
    let CoreError::DomainError { code: Some(code), message: Some(message), .. } = &failed else { panic!("a coded failure: {failed:?}") };
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/new-task-dedupe/golden.json")).expect("golden");
    let manifest: Value = serde_json::from_str(include_str!("../../../../fixtures/new-task-dedupe/MANIFEST.json")).expect("manifest");
    let mut node = golden["scenarios"]["io-error"]["recorded"][1]["reply"].clone();
    // Less only the reply fields the manifest declares not compared (fields of Node's in-process fs error that no caller receives).
    for path in manifest["comparison"]["notCompared"].as_object().expect("declared").keys() {
        if let Some(field) = path.strip_prefix("recorded[].reply.") {
            node.as_object_mut().expect("a reply").remove(field);
        }
    }
    assert_eq!(json!({ "ok": false, "error": message.as_ref(), "code": code.as_ref() }), node);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    assert_eq!(directory.loaded_ids().len(), 0);
}

/// The refusal's fresh address is `sess_desktop_` and 32 random bytes in hex (`freshSessionId`): every hex digit takes any value.
/// Two joined UUID v4 values would fix digit 12 of each half to `4` and digit 16 to one of `8`-`b`; over 64 addresses each of those
/// digits takes a value outside `4`, `8`-`b` unless the bytes are not uniformly random (a chance of (5/16)^64, about 10^-32, each).
#[test]
fn the_fresh_address_is_32_random_bytes() {
    let addresses: Vec<String> = (0..64).map(|_| super::new_task::fresh_session_id()).collect();
    for address in &addresses {
        let hex = address.strip_prefix("sess_desktop_").expect("the prefix");
        assert!(hex.len() == 64 && hex.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')), "{address}");
    }
    for at in [12, 16, 44, 48] {
        let digits: std::collections::BTreeSet<u8> = addresses.iter().map(|address| address.as_bytes()["sess_desktop_".len() + at]).collect();
        assert!(digits.iter().any(|digit| !matches!(digit, b'4' | b'8'..=b'9' | b'a'..=b'b')), "hex digit {at} only ever took {digits:?}");
    }
}

/// At most 128 requests are in flight; the next is refused with Node's message, and a finished one frees its place.
#[tokio::test(start_paused = true)]
async fn the_129th_request_in_flight_is_refused() {
    let rig = Rig::new();
    let receipts = NewTaskReceipts::new(&rig._data.path().join("userdata"), mixdog_rt::testing::tokens().durability_io);
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let running = Arc::new(tokio::sync::Semaphore::new(0));
    let mut held = Vec::new();
    for index in 0..super::new_task::MAX_ACTIVE {
        let (receipts, release, running) = (receipts.clone(), release.clone(), running.clone());
        held.push(tokio::spawn(async move {
            receipts
                .run(&format!("held-{index}"), &json!({ "n": index }), move |_| async move {
                    running.add_permits(1);
                    release.acquire().await.expect("open").forget();
                    Err(mixdog_core_base::support::failed("session", "released"))
                })
                .await
        }));
    }
    // Every held request runs its attempt, so holds its place, before the next asks for one.
    let all = u32::try_from(super::new_task::MAX_ACTIVE).expect("fits");
    within("every held request running its attempt", running.acquire_many(all)).await.expect("open").forget();
    assert_eq!(receipts.in_flight(), super::new_task::MAX_ACTIVE);
    let refused = within(
        "the 129th request's refusal",
        receipts.run("one-more", &json!({}), |_| async { Err(mixdog_core_base::support::failed("session", "never runs")) }),
    )
    .await;
    assert!(matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == "Too many new task requests are in progress."), "{refused:?}");
    release.add_permits(super::new_task::MAX_ACTIVE);
    for task in held {
        within("a released request's answer", task).await.expect("joined").expect_err("released");
    }
}
