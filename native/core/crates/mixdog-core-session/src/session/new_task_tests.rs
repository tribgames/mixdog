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
    let first = submit(&directory, "op-1", "sub-a", "write the report", json!({})).await.expect("first");
    let retry = submit(&directory, "op-2", "sub-a", "write the report", json!({})).await.expect("retry");
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
    submit(&directory, "op-1", "sub-order", "write the report", json!({})).await.expect("first");
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
    submit(&directory, "op-1", "sub-b", "write the report", json!({})).await.expect("first");
    let before = std::fs::read(receipt_path(&rig, "sub-b")).expect("receipt");
    let changed = submit(&directory, "op-2", "sub-b", "write another report", json!({})).await;
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
    submit(&directory, "op-1", "sub-c", "write the report", json!({})).await.expect("first");
    // The process ended after the prompt was accepted and before `accepted` was written.
    let receipt = stored(&rig, "sub-c").expect("receipt");
    std::fs::write(receipt_path(&rig, "sub-c"), receipt.with_phase(Phase::Configured).to_bytes()).expect("rewind");
    let (restarted, receipts) = directory_over(&rig);
    let retry = submit(&restarted, "op-2", "sub-c", "write the report", json!({})).await.expect("retry");
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
    submit(&directory, "op-1", "sub-d", "write the report", json!({})).await.expect("first");
    let reserved = stored(&first, "sub-d").expect("receipt").with_phase(Phase::Reserved);
    // A core that never made the thread: another store, the receipt as the interrupted attempt left it.
    let rig = Rig::new();
    let runs = counting(&rig);
    std::fs::create_dir_all(receipt_path(&rig, "sub-d").parent().unwrap()).expect("folder");
    std::fs::write(receipt_path(&rig, "sub-d"), reserved.to_bytes()).expect("seed");
    let (restarted, receipts) = directory_over(&rig);
    let retry = submit(&restarted, "op-2", "sub-d", "write the report", json!({})).await.expect("retry");
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
    let refused = submit(&directory, "op-1", "sub-e", "write the report", REFUSED_ROUTE()).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if message.contains("route refused")), "{refused:?}");
    let mark = stored(&rig, "sub-e").expect("receipt");
    assert!(mark.refused() && mark.phase() == Phase::Reserved);
    assert_ne!(mark.session_id(), derived("sub-e"), "the refused reservation is not resumed");
    assert_eq!(receipts.writes.lock().unwrap().last(), Some(&("reserved+refused".to_owned(), true)));
    let other = submit(&directory, "op-2", "sub-e", "write something else", json!({})).await.expect("other content");
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
    let first = submit(&directory, "op-1", "sub-m", "write the report", json!({})).await.expect("first");
    let on_disk = std::fs::read(receipt_path(&rig, "sub-m")).expect("receipt");
    assert_eq!(on_disk, stored(&rig, "sub-m").expect("receipt").to_bytes(), "the file is the receipt's own bytes");
    let (restarted, receipts) = directory_over(&rig);
    let replay = submit(&restarted, "op-2", "sub-m", "write the report", json!({})).await.expect("replay");
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
    let rig = Rig::new();
    let runs = counting(&rig);
    let (entered, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Semaphore::new(0)));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.new_route = Arc::new(HeldRoute { entered: entered.clone(), release: release.clone(), held: false.into() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let connection = CancellationToken::new();
    // The attempt is past `reserved`: the connection ends and the call is dropped with it, before any answer.
    tokio::select! {
        () = entered.notified() => connection.cancel(),
        answered = submit_on(&directory, "op-1", "sub-l", "write the report", json!({}), connection.clone()) => panic!("answered while held: {answered:?}"),
    }
    assert_eq!(stored(&rig, "sub-l").expect("receipt").phase(), Phase::Reserved, "the reply is lost after `reserved`");
    release.add_permits(1);
    let retry = submit(&directory, "op-2", "sub-l", "write the report", json!({})).await.expect("retry");
    assert_eq!(retry, derived("sub-l"));
    assert_eq!(runs.load(Ordering::SeqCst), 1, "one prompt");
    assert_eq!(directory.loaded_ids().len(), 1, "one task");
    let receipt = stored(&rig, "sub-l").expect("receipt");
    assert_eq!((receipt.phase(), receipt.refused()), (Phase::Accepted, false));
}

/// Two identical requests at once start one task; two with other content, the first holds the id.
#[tokio::test(start_paused = true)]
async fn requests_at_once_join_or_are_refused() {
    let rig = Rig::new();
    let runs = counting(&rig);
    let (directory, _) = directory_over(&rig);
    let (a, b) = tokio::join!(
        submit(&directory, "op-1", "sub-f", "write the report", json!({})),
        submit(&directory, "op-2", "sub-f", "write the report", json!({})),
    );
    assert_eq!(a.expect("a"), b.expect("b"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    let (c, d) = tokio::join!(
        submit(&directory, "op-3", "sub-g", "write the report", json!({})),
        submit(&directory, "op-4", "sub-g", "write another", json!({})),
    );
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
    let started = submit(&directory, "op-1", "sub-h", "write the report", json!({})).await.expect("started");
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
    let failed = submit(&directory, "op-1", "sub-i", "write the report", json!({})).await.expect_err("refused");
    let CoreError::DomainError { code: Some(code), message: Some(message), .. } = &failed else { panic!("a coded failure: {failed:?}") };
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/new-task-dedupe/golden.json")).expect("golden");
    let node = &golden["scenarios"]["io-error"]["recorded"][1]["reply"];
    assert_eq!(json!({ "ok": false, "error": message.as_ref(), "code": code.as_ref() }), *node);
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    assert_eq!(directory.loaded_ids().len(), 0);
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
    running.acquire_many(all).await.expect("open").forget();
    assert_eq!(receipts.in_flight(), super::new_task::MAX_ACTIVE);
    let refused = receipts.run("one-more", &json!({}), |_| async { Err(mixdog_core_base::support::failed("session", "never runs")) }).await;
    assert!(matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if message.as_ref() == "Too many new task requests are in progress."), "{refused:?}");
    release.add_permits(super::new_task::MAX_ACTIVE);
    for task in held {
        task.await.expect("joined").expect_err("released");
    }
}
