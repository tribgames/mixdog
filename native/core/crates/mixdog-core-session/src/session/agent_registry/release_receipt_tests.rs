//! A release's receipt against the production session actor over the real thread store: the receipt answers for its own
//! record's journal barrier, so it agrees with the cleanup's count and with the record the next process opens. The
//! journal's failures are injected at the log writer's own steps ([`mixdog_store::fsio::set_append_hook`]): the hook is
//! the process's, and every test here runs in a process of its own (nextest).

use mixdog_agent::agent_tool::dispatch::CleanupParts;
use mixdog_agent::agent_tool::dispatch::CleanupReport;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::host::ReleaseDone;
use mixdog_agent::agent_tool::host::ReleaseOutcome;
use mixdog_agent::agent_tool::host::ReleaseTarget;
use mixdog_core_ports::ports::threads::Attempt;
use mixdog_core_ports::ports::threads::HeaderStored;
use mixdog_core_ports::ports::threads::HeaderWrite;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_store::fsio::AppendStep;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::Record;

use super::*;

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq)]
enum Fault {
    /// The write stops half way and is rolled back: nothing of the batch is applied.
    Refuse,
    /// The write stops half way and its rollback fails too: the batch's outcome is unknown until the log is reconciled.
    Unknown,
}

/// Which header record a fault is for.
#[derive(Clone)]
enum Of {
    /// A release; `probe`: only the one whose map carries it.
    Release { probe: Option<String> },
    /// A row write that is no release, of `session`, whose map carries `probe`.
    Row { session: String, probe: String },
}

/// What the append of each named record does, once.
static FAULTS: Mutex<Vec<(Of, Fault)>> = Mutex::new(Vec::new());

thread_local! {
    /// The rollback that follows this thread's faulted write fails too: a write and its rollback are one append, on
    /// one thread, so another log's rollback is never met.
    static TRUNCATE_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether `record` is the header record `of` names. A release's record carries its operation.
fn is_record(record: &Record, of: &Of) -> bool {
    let Record::Meta(MetaRecord { op, change: Slot::Inline(change) }) = record else { return false };
    let Some(worker) = change.set.get("worker").and_then(Value::as_object) else { return false };
    let probe = worker.get("probe").and_then(Value::as_str);
    match (of, op) {
        (Of::Release { probe: wanted }, Some(op)) => {
            op.id.as_str().starts_with("worker-release:") && wanted.as_deref().is_none_or(|wanted| probe == Some(wanted))
        }
        (Of::Row { session, probe: wanted }, None) => worker.get("of").and_then(Value::as_str) == Some(session.as_str()) && probe == Some(wanted.as_str()),
        _ => false,
    }
}

fn append_hook(step: AppendStep, records: &[Record]) -> std::io::Result<()> {
    match step {
        AppendStep::Write => {
            let fault = {
                let mut faults = FAULTS.lock().unwrap();
                faults.iter().position(|(of, _)| records.iter().any(|record| is_record(record, of))).map(|at| faults.remove(at).1)
            };
            match fault {
                Some(fault) => {
                    TRUNCATE_FAILS.set(fault == Fault::Unknown);
                    Err(std::io::Error::other("EIO: injected"))
                }
                None => Ok(()),
            }
        }
        AppendStep::Truncate if TRUNCATE_FAILS.replace(false) => Err(std::io::Error::other("EIO: injected")),
        _ => Ok(()),
    }
}

/// The append of the record `of` names meets `fault`, once.
fn fault_of(of: Of, fault: Fault) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| mixdog_store::fsio::set_append_hook(append_hook));
    FAULTS.lock().unwrap().push((of, fault));
}

/// The append of the release carrying `probe` (any release when `None`) meets `fault`, once.
fn fault(probe: Option<&str>, fault: Fault) {
    fault_of(Of::Release { probe: probe.map(str::to_owned) }, fault);
}

/// The journal the loaded session `thread` is written to.
fn journal(core: &Core, thread: &ThreadId) -> String {
    ThreadState::log_identity(&*core.threads, thread).expect("the session is loaded")
}

fn released(probe: &str) -> Row {
    obj(json!({ "releasedAt": at(NOW), "probe": probe }))
}

async fn outcome(done: ReleaseDone) -> ReleaseOutcome {
    tokio::time::timeout(DEADLINE, done.outcome()).await.expect("the release was answered within 30 s")
}

/// The session's `worker` map as its header holds it now: of a loaded session the live header, else its stored record.
async fn worker_of(core: &Core, thread: &ThreadId) -> Option<Value> {
    ThreadState::header(&*core.threads, thread).await.expect("the session's header").get("worker").cloned()
}

/// The receipt the registry makes of a release of `released(probe)` decided now on `prior`: bound to what the store
/// names for the session at this moment, under an identity of its own.
fn receipt(core: &Core, thread: &ThreadId, probe: &str, prior: Option<Row>) -> ReleaseReceipt {
    let Bound { target, incarnation, .. } = WorkerStore::bound(&*core.workers, thread.as_str()).expect("the store names the session");
    ReleaseReceipt {
        session_id: thread.as_str().to_owned(),
        incarnation,
        prior,
        operation: format!("worker-release:{}", uuid::Uuid::new_v4().simple()),
        tag: None,
        turn: None,
        revision: 0,
        target,
        released: released(probe),
    }
}

/// A first release of `released(probe)`, decided on `prior`.
fn release(core: &Core, thread: &ThreadId, probe: &str, prior: Option<Row>) -> ReleaseDone {
    let receipt = receipt(core, thread, probe, prior);
    assert_eq!((receipt.target, receipt.incarnation.as_str()), (ReleaseTarget::Header, journal(core, thread).as_str()), "bound to the session's own journal");
    WorkerStore::release(&*core.workers, &receipt, false)
}

/// The release's header write as the row writer sends it.
fn header_write(receipt: &ReleaseReceipt, attempt: Attempt) -> HeaderWrite {
    HeaderWrite {
        operation: receipt.operation.clone(),
        incarnation: receipt.incarnation.clone(),
        expect: Map::from_iter([("worker".to_owned(), receipt.prior.clone().map_or(Value::Null, Value::Object))]),
        set: Map::from_iter([("worker".to_owned(), Value::Object(receipt.released.clone()))]),
        unset: Vec::new(),
        attempt,
    }
}

/// What the session's journal answers of the release's own operation, nothing appended.
async fn fate(core: &Core, receipt: &ReleaseReceipt) -> HeaderStored {
    ThreadState::store_header(&*core.threads, &ThreadId::from(receipt.session_id.as_str()), header_write(receipt, Attempt::Settle)).await
}

/// A row write of a loaded session whose save fails is kept by the session and answered as written; a release is not: its
/// receipt is the failure of its own record, the flush that covers it is refused, and the record the next process opens
/// holds no release.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_whose_save_fails_is_not_a_stored_release() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let row = worker_row(worker.as_str(), "w1", json!({}));
    WorkerStore::write(&*core.workers, worker.as_str(), Some(row.clone()));
    core.written().await;

    fault(Some("lost"), Fault::Refuse);
    let receipt = outcome(release(&core, &worker, "lost", Some(row.clone()))).await;
    assert!(matches!(&receipt, ReleaseOutcome::Refused(why) if why.contains(worker.as_str())), "the failed save is the release's own answer: {receipt:?}");
    assert_eq!(worker_of(&core, &worker).await, Some(Value::Object(row.clone())), "the session holds no release it did not store");
    let flushed = core.workers.settled().await;
    assert!(flushed.as_ref().is_err_and(|error| error.contains(worker.as_str())), "the flush covers the refused release: {flushed:?}");
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(row)), "the reopened record agrees with the receipt");
}

/// A release is its own operation: one that was refused is not answered by the success of the write that replaced it, and
/// the replacement is not failed by it. The record holds the replacement.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_release_and_the_write_that_replaced_it_each_report_their_own_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;

    fault(Some("first"), Fault::Refuse);
    // The refused one writes nothing: the replacement is decided on the map the header still holds.
    let (first, second) = (release(&core, &worker, "first", None), release(&core, &worker, "second", None));
    let (first, second) = (outcome(first).await, outcome(second).await);
    assert!(matches!(first, ReleaseOutcome::Refused(_)), "the replacement lent the refused release nothing: {first:?}");
    assert_eq!(second, ReleaseOutcome::Stored);
    core.workers.settled().await.expect("the header holds what the session is owed");
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("second"))));
}

/// The other order: a release that was stored stays stored when the next write of its session is refused, and that write's
/// failure is its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stored_release_is_not_failed_by_the_refused_write_that_followed_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;

    fault(Some("second"), Fault::Refuse);
    let (first, second) = (release(&core, &worker, "first", None), release(&core, &worker, "second", Some(released("first"))));
    let (first, second) = (outcome(first).await, outcome(second).await);
    assert_eq!(first, ReleaseOutcome::Stored, "the later failure is not the stored release's");
    assert!(matches!(second, ReleaseOutcome::Refused(_)), "{second:?}");
    assert!(core.workers.settled().await.is_err(), "the later refusal is the flush's");
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("first"))));
}

/// An append whose outcome is unknown is no success and is not written again as a new release: that same operation is
/// settled (the log rolls it back) before the session's next write starts, and is answered by what the journal then
/// holds of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_append_of_unknown_outcome_is_settled_before_the_sessions_next_write() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;

    fault(Some("lost"), Fault::Unknown);
    let (lost, next) = (release(&core, &worker, "lost", None), release(&core, &worker, "next", None));
    let (lost, next) = (outcome(lost).await, outcome(next).await);
    assert!(matches!(&lost, ReleaseOutcome::Refused(why) if why.contains("settled as not stored")), "{lost:?}");
    assert_eq!(next, ReleaseOutcome::Stored, "the next write went on once the log was settled");
    drop(core);

    let reopened = Core::up(dir.path()).await;
    assert_eq!(worker_of(&reopened, &worker).await, Some(Value::Object(released("next"))), "the lost append left nothing behind");
}

/// A shutdown drains: the releases accepted behind the one at its put are stored when it returns, each answered, and the
/// record the next process opens holds the last of them. What is released after it is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_stores_the_releases_queued_behind_the_one_at_its_put() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;

    let queued: Vec<ReleaseDone> = (0..4).map(|n| release(&core, &worker, &format!("r{n}"), (n > 0).then(|| released(&format!("r{}", n - 1))))).collect();
    tokio::time::timeout(DEADLINE, core.workers.shutdown()).await.expect("the shutdown ended within 30 s").expect("every accepted release was stored");
    for done in &queued {
        assert_eq!(done.now(), Some(ReleaseOutcome::Stored), "answered before the shutdown returned");
    }
    let late = release(&core, &worker, "late", Some(released("r3")));
    assert!(matches!(late.now(), Some(ReleaseOutcome::Refused(_))), "admission is sealed: {:?}", late.now());
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("r3"))));
}

/// The session directory's shutdown puts the releases accepted before it while their actors are there; one that arrives
/// once it has drained its slots is refused and opens no session, and the kept table is written until the writer stops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_the_directory_shut_down_a_header_release_is_refused_and_opens_no_session() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    assert!(core.directory.set_row_writes(core.workers.clone()).is_ok());
    let log = journal(&core, &worker);
    // The index lists the session with its journal, as a registry's load reads it.
    let row = worker_row(worker.as_str(), "w1", json!({}));
    WorkerStore::write(&*core.workers, worker.as_str(), Some(row.clone()));
    core.written().await;
    let _ = WorkerStore::index_since(&*core.workers, None).await.expect("the index is read");

    let stored = receipt(&core, &worker, "queued", Some(row));
    let queued = WorkerStore::release(&*core.workers, &stored, false);
    tokio::time::timeout(DEADLINE, core.directory.shutdown()).await.expect("the directory shut down within 30 s");
    assert_eq!(queued.now(), Some(ReleaseOutcome::Stored), "the accepted release was put before the threads stopped");
    assert!(core.directory.handle(&worker).is_none(), "the session is unloaded");

    // The session is unloaded: the release is bound to the journal the index listed it with, and still refused.
    let late = receipt(&core, &worker, "late", Some(released("queued")));
    assert_eq!((late.target, late.incarnation.as_str()), (ReleaseTarget::Header, log.as_str()));
    let late = WorkerStore::release(&*core.workers, &late, false);
    assert!(matches!(late.now(), Some(ReleaseOutcome::Refused(_))), "answered at once, not queued: {:?}", late.now());
    assert!(core.directory.handle(&worker).is_none(), "the refused release opened no session");
    // The ability to open is gone where it lives: no caller opens a thread, so asking for an operation that was
    // submitted before answers that it cannot tell, and opens nothing.
    let ctx = mixdog_core_api::call::CallContext::internal("test");
    assert!(core.directory.open_handle(&worker, &ctx).await.is_err(), "the sealed directory opens no thread");
    let asked = fate(&core, &stored).await;
    assert!(matches!(asked, HeaderStored::Indeterminate(_)), "not told, and never taken for absent: {asked:?}");
    assert!(core.directory.handle(&worker).is_none(), "and opened no session");
    let kept = obj(json!({ "sessionId": "s-kept", "tag": "kept" }));
    WorkerStore::keep(&*core.workers, "s-kept", Some(kept.clone()));
    tokio::time::timeout(DEADLINE, core.workers.shutdown()).await.expect("the writer shut down within 30 s").expect("what was accepted is stored");
    assert_eq!(core.state.meta_prefix("agent-kept-worker:").await.unwrap(), [("agent-kept-worker:s-kept".to_owned(), serde_json::to_string(&kept).unwrap())]);
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("queued"))), "the record holds the accepted release alone");
}

/// A value a session keeps unsaved is no stored release. A row write whose save fails is kept by the loaded session,
/// which then shows the map; a release of that same map whose append ends with an unknown outcome is answered by its
/// own operation's record, which the journal does not hold: not stored, though the header shows its value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_is_not_stored_by_the_value_its_session_keeps_unsaved() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let mut kept = released("kept");
    kept.insert("of".into(), json!(worker.as_str()));

    fault_of(Of::Row { session: worker.as_str().to_owned(), probe: "kept".into() }, Fault::Refuse);
    WorkerStore::write(&*core.workers, worker.as_str(), Some(kept.clone()));
    core.workers.settled().await.expect("a row write the session keeps is answered written");
    assert_eq!(worker_of(&core, &worker).await, Some(Value::Object(kept.clone())), "the session shows the unsaved value");

    fault(Some("kept"), Fault::Unknown);
    let unsaved = ReleaseReceipt { released: kept.clone(), ..receipt(&core, &worker, "kept", Some(kept.clone())) };
    let answer = outcome(WorkerStore::release(&*core.workers, &unsaved, false)).await;
    assert!(matches!(&answer, ReleaseOutcome::Refused(why) if why.contains("settled as not stored")), "the kept value is no receipt: {answer:?}");
    let asked = fate(&core, &unsaved).await;
    assert!(matches!(asked, HeaderStored::Refused(_)), "the journal holds no record of the release: {asked:?}");
    assert!(core.workers.settled().await.is_err(), "the flush covers the release that was not stored");
}

/// An unloaded session's release is bound to the journal the index lists it with, opens the session through its actor
/// and is stored there; a session of which the store was told no journal is named by nothing, so nothing is decided.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_of_an_unloaded_session_is_bound_to_the_journal_the_index_lists() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let log = journal(&core, &worker);
    let row = worker_row(worker.as_str(), "w1", json!({}));
    WorkerStore::write(&*core.workers, worker.as_str(), Some(row.clone()));
    core.written().await;
    core.directory.release(&worker).await;
    assert!(core.directory.handle(&worker).is_none(), "the session is unloaded");

    assert_eq!(WorkerStore::bound(&*core.workers, worker.as_str()), None, "no journal is known yet: the session has no identity to bind to");
    assert!(core.directory.handle(&worker).is_none(), "and asking opened nothing");

    let _ = WorkerStore::index_since(&*core.workers, None).await.expect("the index is read");
    let unloaded = receipt(&core, &worker, "unloaded", Some(row));
    assert_eq!((unloaded.target, unloaded.incarnation.as_str()), (ReleaseTarget::Header, log.as_str()), "the journal the index lists");
    assert_eq!(outcome(WorkerStore::release(&*core.workers, &unloaded, false)).await, ReleaseOutcome::Stored);
    core.written().await;
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("unloaded"))));
}

/// `Stored` is the barrier of the release's own journal record, not a publication receipt: with the index behind the
/// journal, the release is stored for its handle and for the flush, and the record the next process opens holds it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_is_stored_at_its_journal_barrier_whatever_the_index_shows() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;

    // The index is recorded as lacking rows of the session that its log holds.
    core.store.lose_rows(worker.as_str());
    assert_eq!(outcome(release(&core, &worker, "r", None)).await, ReleaseOutcome::Stored, "the journal's barrier is the receipt");
    core.workers.settled().await.expect("the flush counts it stored");
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released("r"))));
}

/// The session's actor is unloaded, and the index is left without the row of `operation`, as after a projection it never
/// took: only the journal holds the record.
async fn projection_lost(core: &Core, thread: &ThreadId, operation: &str) {
    core.written().await;
    core.directory.release(thread).await;
    assert!(core.directory.handle(thread).is_none(), "the session is unloaded");
    core.index.forget_thread_op(thread.as_str(), operation).await.expect("the index held the operation's row");
    core.store.lose_rows(thread.as_str());
}

/// The recovery of a release, on the journal it was decided for, after a newer binding of the session. The release's
/// record is committed; its projection was lost and its actor unloaded, so only the journal can answer for it; and the
/// session's header holds a newer worker map since.
///
/// The committed operation, submitted again, is answered stored by its own record and appends nothing. Nothing else is
/// a success: an operation that never committed is superseded by the newer binding and not written over it; the
/// committed operation's id under another map is a conflict; an id the journal fenced is a fence. The newer binding
/// stands throughout, and in the record the next process opens.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_after_a_newer_binding_overwrites_nothing_and_takes_no_fence_or_conflict_for_success() {
    use crate::session::thread_ops::OpCall;
    use mixdog_store::schema::bounded::Digest;
    use mixdog_store::schema::bounded::Text;
    use mixdog_store::schema::record::OpRef;
    use mixdog_store::schema::record::OpState as Logged;
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let row = worker_row(worker.as_str(), "w1", json!({}));
    WorkerStore::write(&*core.workers, worker.as_str(), Some(row.clone()));
    core.written().await;

    let committed = receipt(&core, &worker, "r", Some(row.clone()));
    let never = receipt(&core, &worker, "never", Some(row.clone()));
    assert_eq!(outcome(WorkerStore::release(&*core.workers, &committed, false)).await, ReleaseOutcome::Stored);
    // A fence of an operation of its own, in the same journal.
    let fenced = ReleaseReceipt { operation: "worker-release:fenced".into(), ..never.clone() };
    let fence = OpRef {
        id: Text::try_from(fenced.operation.as_str()).expect("an op id"),
        method: Text::try_from("op/status").expect("a method"),
        digest: Digest::try_from(mixdog_core_base::ops::PayloadDigest::of_params(&json!({})).as_str().to_owned()).expect("a digest"),
        audience: None,
        result: None,
    };
    let handle = core.directory.handle(&worker).expect("the session is loaded");
    handle.op_call(OpCall::Record { op: Box::new(fence), state: Logged::Fenced, detail: None }).await.expect("the fence is recorded");
    drop(handle);
    projection_lost(&core, &worker, &committed.operation).await;

    // A newer binding of the session, on the same journal.
    let newer = worker_row(worker.as_str(), "w2", json!({}));
    WorkerStore::write(&*core.workers, worker.as_str(), Some(newer.clone()));
    core.workers.settled().await.expect("the newer binding is stored");
    core.directory.release(&worker).await;
    let stands = Some(Value::Object(newer.clone()));
    assert_eq!(worker_of(&core, &worker).await, stands);

    let again = outcome(WorkerStore::release(&*core.workers, &committed, true)).await;
    assert_eq!(again, ReleaseOutcome::Stored, "the journal's own record of the operation answers for it");
    assert_eq!(worker_of(&core, &worker).await, stands, "and nothing was appended over the newer binding");

    let superseded = outcome(WorkerStore::release(&*core.workers, &never, true)).await;
    assert!(matches!(&superseded, ReleaseOutcome::Superseded(_)), "decided on a map the header no longer holds: {superseded:?}");
    let conflict = ReleaseReceipt { released: released("other"), ..committed.clone() };
    let conflict = outcome(WorkerStore::release(&*core.workers, &conflict, true)).await;
    assert!(
        matches!(&conflict, ReleaseOutcome::Refused(_) | ReleaseOutcome::Superseded(_)),
        "a record of other parameters under the id is no receipt: {conflict:?}"
    );
    let fence = outcome(WorkerStore::release(&*core.workers, &fenced, true)).await;
    assert!(matches!(&fence, ReleaseOutcome::Refused(_) | ReleaseOutcome::Superseded(_)), "a fence is no receipt: {fence:?}");
    assert_eq!(worker_of(&core, &worker).await, stands, "the newer binding stands");
    drop(core);

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, stands, "the reopened record holds the newer binding");
    assert_eq!(fate(&next, &committed).await, HeaderStored::Stored, "and the committed release's record");
    assert!(matches!(fate(&next, &never).await, HeaderStored::Refused(_)), "and none of the one that never committed");
}

/// A session of `id` made in `core`, loaded, with `row` as its worker map.
async fn made(core: &Core, id: &str, row: &Row) -> ThreadId {
    let thread = ThreadId::from(id);
    core.directory.create_with_id(thread.clone(), obj(json!({ "cwd": "/ws" })), json!({})).await.expect("the session is made");
    core.directory.open_handle(&thread, &mixdog_core_api::call::CallContext::internal("test")).await.expect("the session opens");
    WorkerStore::write(&*core.workers, id, Some(row.clone()));
    core.written().await;
    thread
}

/// The same recovery when the session was replaced: another journal under the same id, holding the very map the release
/// was decided on, so nothing but the journal's identity tells them apart. The release committed in the first journal
/// is submitted again to the store that now holds the replacement: it is superseded, the replacement's header is as it
/// was, and its journal holds no record of the operation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovery_writes_nothing_to_a_session_that_replaced_the_one_it_was_decided_for() {
    let row = obj(json!({ "sessionId": "s-same", "tag": "w1", "status": "idle" }));
    let first = tempfile::tempdir().unwrap();
    let core = Core::up(first.path()).await;
    let worker = made(&core, "s-same", &row).await;
    let committed = receipt(&core, &worker, "r", Some(row.clone()));
    let never = receipt(&core, &worker, "never", Some(row.clone()));
    assert_eq!(outcome(WorkerStore::release(&*core.workers, &committed, false)).await, ReleaseOutcome::Stored);
    core.written().await;
    drop(core);

    let second = tempfile::tempdir().unwrap();
    let replaced = Core::up(second.path()).await;
    let worker = made(&replaced, "s-same", &row).await;
    let now = WorkerStore::bound(&*replaced.workers, "s-same").expect("the replacement is named");
    assert_ne!(now.incarnation, committed.incarnation, "the same id, another journal");
    let stands = Some(Value::Object(row.clone()));

    for old in [&committed, &never] {
        let again = outcome(WorkerStore::release(&*replaced.workers, old, true)).await;
        assert!(matches!(&again, ReleaseOutcome::Superseded(_)), "never rebound to the journal the session has now: {again:?}");
        assert_eq!(worker_of(&replaced, &worker).await, stands, "nothing was written to the replacement");
    }
    // Asked on the replacement's own journal, the operation has no record there.
    let here = ReleaseReceipt { incarnation: now.incarnation.clone(), ..committed.clone() };
    assert!(matches!(fate(&replaced, &here).await, HeaderStored::Refused(_)), "the replacement's journal holds no record of it");
    replaced.workers.settled().await.expect_err("the superseded releases are the flush's");
    drop(replaced);

    let next = Core::up(second.path()).await;
    assert_eq!(worker_of(&next, &worker).await, stands, "the reopened replacement holds what it held");
}

/// A release's precondition is fixed where it is decided and never read again, on the production actor. The release is
/// refused at its append; the session's header is then changed by a write that is not the registry's; and the next
/// cleanup's recovery submits that same operation with that same precondition. It is a compare-and-set that no longer
/// holds: superseded, with the newer header left as it is, not overwritten by the old release. The session's task then
/// reads what the header holds, so the decision after that is made on the truth and is stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recovered_release_keeps_its_precondition_and_the_decision_after_a_mismatch_is_made_on_what_the_session_holds() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let id = worker.as_str();
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let registry = AgentRegistry::new(core.workers.clone(), core.directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW))));
    let row = worker_row(id, "w1", owned.clone());
    {
        let mut st = registry.lock();
        registry.persist(&mut st, id, Some(row.clone()));
    }
    core.written().await;

    fault(None, Fault::Refuse);
    let judged: HashMap<String, _> = HashMap::from([(id.to_owned(), registry.turn_mark(id))]);
    let released = registry.release_closed_at(&lead("lead"), None, id, &[], Some(&judged));
    let [first] = &released.releases[..] else { panic!("one release: {:?}", released.spared) };
    let decided = first.receipt.clone();
    assert_eq!(decided.prior, Some(row.clone()), "decided on the registry's map");
    let refused = outcome(first.done.clone()).await;
    assert!(matches!(refused, ReleaseOutcome::Refused(_)), "{refused:?}");

    // The header is changed in between, and holds a tombstone the registry's own map does not.
    let tombstone = json!({ "tag": "w0", "reapedAt": "2026-11-05T00:00:00.000Z", "sessionId": "gone" });
    let mut newer = worker_row(id, "w2", owned);
    newer.insert("tombstone".into(), tombstone.clone());
    WorkerStore::write(&*core.workers, id, Some(newer.clone()));
    core.workers.settled().await.expect("the newer row is stored");
    let stands = Some(Value::Object(newer.clone()));

    let recovered = registry.recover_releases(&lead("lead"));
    let [again] = &recovered[..] else { panic!("the refused release is recovered") };
    assert_eq!(again.receipt, decided, "the same operation, with the precondition it was decided on");
    let superseded = outcome(again.done.clone()).await;
    assert!(matches!(superseded, ReleaseOutcome::Superseded(_)), "a compare-and-set that no longer holds: {superseded:?}");
    assert_eq!(worker_of(&core, &worker).await, stands, "the newer header was not overwritten by the old release");
    assert!(registry.recover_releases(&lead("lead")).is_empty(), "a superseded release is never made again");

    // The mismatch made the session's task read what the header holds: the next decision is made on that.
    core.workers.idle().await;
    assert!(registry.lock().map(id).is_some_and(|map| !map.contains_key("tombstone")), "the registry's own map lacks the tombstone");
    assert_eq!(WorkerStore::bound(&*core.workers, id).expect("the session is named").holds, Some(Some(newer.clone())));
    let judged: HashMap<String, _> = HashMap::from([(id.to_owned(), registry.turn_mark(id))]);
    let released = registry.release_closed_at(&lead("lead"), None, id, &[], Some(&judged));
    let [next] = &released.releases[..] else { panic!("one release: {:?}", released.spared) };
    assert_eq!(next.receipt.prior, Some(newer), "decided on what the header holds, not on the registry's own map");
    assert_ne!(next.receipt.operation, decided.operation, "a new decision is a new operation");
    // What is written is the release applied to the map it expects, not to the registry's: the tombstone survives.
    assert_eq!(next.receipt.released.get("tombstone"), Some(&tombstone), "the write's base is its precondition");
    assert_eq!(outcome(next.done.clone()).await, ReleaseOutcome::Stored, "so it is not superseded for ever");
    core.written().await;
    drop((released, recovered, registry, core));

    let reopened = Core::up(dir.path()).await;
    let stored = worker_of(&reopened, &worker).await.expect("the released map");
    assert_eq!(stored.get("tombstone"), Some(&tombstone), "the newer tombstone was not written away by the release");
    assert!(stored.get("releasedAt").is_some(), "and the release is stored: {stored}");
}

/// The journal answers that it holds no record of an operation only where it ends cleanly. With its last frame torn,
/// an operation whose record lies before the tear is still found, and one it holds no record of is not told absent:
/// the question is an error, which a settle or a replay answers as indeterminate.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_journal_tells_an_operation_absent_only_from_its_clean_end() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let committed = receipt(&core, &worker, "r", None);
    assert_eq!(outcome(WorkerStore::release(&*core.workers, &committed, false)).await, ReleaseOutcome::Stored);
    // A later record, so that the release's is not the journal's last frame.
    WorkerStore::write(&*core.workers, worker.as_str(), Some(released("later")));
    core.written().await;
    core.directory.release(&worker).await;
    assert!(core.directory.handle(&worker).is_none(), "the session is unloaded: nothing holds its log open");

    let asked = |op: &str| {
        let (store, thread, op) = (core.store.clone(), worker.clone(), op.to_owned());
        async move {
            let io = mixdog_rt::testing::tokens().interactive_io;
            mixdog_core_base::support::on_lane_wait(io, &mixdog_rt::CancellationToken::new(), move |lane| {
                crate::session::ThreadStore::committed_op(&*store, lane, &thread, &op)
            })
            .await
            .expect("the lane ran it")
        }
    };
    assert!(asked(&committed.operation).await.expect("the journal can tell").is_some());
    assert!(asked("worker-release:none").await.expect("read to its clean end").is_none(), "absent, by the whole journal");

    // The last frame is cut short.
    let log = core.store.sessions_dir().join(worker.as_str());
    let last = *mixdog_store::log::list_logs(&log).expect("the session's log files").last().expect("a log file");
    let file = std::fs::OpenOptions::new().write(true).open(log.join(mixdog_store::log::log_name(last))).expect("the last segment");
    let len = file.metadata().expect("its size").len();
    file.set_len(len - 2).expect("the tear");
    drop(file);

    assert!(asked(&committed.operation).await.expect("its record lies before the tear").is_some());
    assert!(asked("worker-release:none").await.is_err(), "a journal not read to its clean end tells nothing absent");
}

/// The order of `agent close` and of a cleanup's `close_member`: the registry writes the member's row and releases it
/// at once, with the row write still queued or at its put, on the production actor. The member is not spared and its
/// release does not fail: its precondition is fixed there and then, as the row just written, which is what the session
/// holds (accepted by the actor, saved or not yet) when the release is put in its turn. It is stored; the record the
/// next process opens holds it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_asked_for_right_behind_a_row_write_waits_its_turn_and_is_decided_on_that_row() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let worker = core.start("op-worker", json!({})).await;
    let id = worker.as_str();
    let registry = AgentRegistry::new(core.workers.clone(), core.directory.clone(), Arc::new(Hour), Arc::new(TestClock(AtomicI64::new(NOW))));
    let row = worker_row(id, "w1", json!({ "parentSessionId": "lead", "ownerSessionId": "lead" }));
    {
        let mut st = registry.lock();
        registry.persist(&mut st, id, Some(row.clone()));
    }
    let judged: HashMap<String, _> = HashMap::from([(id.to_owned(), registry.turn_mark(id))]);
    let released = registry.release_closed_at(&lead("lead"), None, id, &[], Some(&judged));
    assert!(released.spared.is_empty(), "a row write still open spares no member: {:?}", released.spared);
    let [release] = &released.releases[..] else { panic!("one release") };
    assert_eq!(release.receipt.prior, Some(row), "decided, there and then, on the row written just before it");
    assert_eq!(outcome(release.done.clone()).await, ReleaseOutcome::Stored, "and the row was what the session held when the release was put");
    core.written().await;
    let stored = release.receipt.released.clone();
    drop((released, registry, core));

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(stored)));
}

struct Frozen;
impl mixdog_agent::env::Clock for Frozen {
    fn now_ms(&self) -> i64 {
        NOW
    }
}

/// One idle worker of the Lead `lead` on a loaded session of `core`, with what a cleanup of it takes.
async fn idle_worker(core: &Core) -> (ThreadId, Arc<AgentRegistry>, CleanupParts) {
    let worker = core.start("op-worker", json!({})).await;
    let owned = json!({ "parentSessionId": "lead", "ownerSessionId": "lead" });
    let mut agent = obj(owned.clone());
    agent.extend(obj(json!({ "agent": "worker", "agentTag": "w1" })));
    core.set_header(worker.as_str(), agent).await;
    let clock = Arc::new(TestClock(AtomicI64::new(NOW)));
    let registry = Arc::new(AgentRegistry::new(core.workers.clone(), core.directory.clone(), Arc::new(Hour), clock.clone()));
    {
        let mut st = registry.lock();
        registry.persist(&mut st, worker.as_str(), Some(worker_row(worker.as_str(), "w1", owned)));
    }
    core.written().await;
    let sessions = Arc::new(AgentSessions::new(
        core.directory.clone(),
        core.threads.clone(),
        registry.clone(),
        Arc::new(Statusline::default()),
        clock,
        Arc::new(ClosedShells::default()),
        Arc::new(mixdog_tools::fs::ReadState::default()),
    ));
    let board = Arc::new(mixdog_agent::agent_tool::board::JobBoard::new(Arc::new(Frozen), None, None));
    (worker, registry.clone(), CleanupParts { registry, sessions, tasks: board })
}

async fn cleanup(parts: &CleanupParts) -> CleanupReport {
    let scope = lead("lead");
    let listed = parts.registry.refresh_topology(false, &scope).await;
    let run = mixdog_agent::agent_tool::dispatch::cleanup_idle(parts.clone(), &scope, listed, mixdog_rt::CancellationToken::new());
    tokio::time::timeout(DEADLINE, run).await.expect("the cleanup ended within 30 s").expect("the cleanup ran")
}

/// A cleanup whose release could not be stored does not count its tree: the session is stamped closed and unbound,
/// and neither stands in for the receipt; it is not hidden, which only a stored release authorises. The member is named,
/// its record holds no release, and the next cleanup stores the same release again, hides the session then, and counts
/// no tree for it; the record the next process opens then holds it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_counts_no_tree_whose_release_was_not_stored_and_the_next_one_recovers_it() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let (worker, registry, parts) = idle_worker(&core).await;
    let id = worker.as_str();

    fault(None, Fault::Refuse);
    let report = cleanup(&parts).await;
    assert_eq!(report.agents_closed, 0, "{report:?}");
    let named = report.not_closed.iter().find(|entry| entry["sessionId"] == json!(id)).unwrap_or_else(|| panic!("the member is named: {report:?}"));
    assert!(named["reason"].as_str().is_some_and(|reason| reason.contains("was not stored")), "{named}");
    let held = registry.lock().releases.get(id).map(|held| (held.receipt.clone(), held.done.now())).expect("the release is kept for recovery");
    assert!(matches!(held.1, Some(ReleaseOutcome::Refused(_))), "{:?}", held.1);
    assert!(registry.is_released(id), "the release stands in memory");
    let hidden = || mixdog_agent::agent_tool::host::Sessions::is_hidden(&*parts.sessions, id);
    assert!(!hidden().await, "a release that is not stored hides nothing");
    let stored = worker_of(&core, &worker).await.expect("the row's map");
    assert!(stored.get("releasedAt").is_none() && stored.get("sessionId") == Some(&json!(id)), "the record holds no release: {stored}");
    assert_eq!(held.0.prior.clone().map(Value::Object), Some(stored), "the release was decided on the map the record still holds");

    let again = cleanup(&parts).await;
    assert!(again.not_closed.is_empty(), "the same release was stored this time: {again:?}");
    assert_eq!(again.agents_closed, 0, "a recovery counts no tree: the invocation that closed it was partial");
    assert!(hidden().await, "the release is stored now: its hide waited for this receipt");
    assert!(registry.recover_releases(&lead("lead")).is_empty() && registry.lock().releases.is_empty(), "nothing is left to recover");
    assert_eq!(fate(&core, &held.0).await, HeaderStored::Stored, "the operation that was refused is the one that was stored");
    core.written().await;
    drop((parts, registry, core));

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(held.0.released)), "the reopened record holds the release the receipt named");
}

/// The count, the receipt and the record agree when the release is stored: one tree closed, nothing to recover, and the
/// record the next process opens holds the released map.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanup_counts_the_tree_whose_release_was_stored() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::up(dir.path()).await;
    let (worker, registry, parts) = idle_worker(&core).await;

    let report = cleanup(&parts).await;
    assert_eq!((report.agents_closed, report.not_closed.len()), (1, 0), "{report:?}");
    let released = registry.lock().releases.get(worker.as_str()).map(|held| (held.receipt.released.clone(), held.done.now())).expect("the receipt");
    assert_eq!(released.1, Some(ReleaseOutcome::Stored));
    drop((parts, registry, core));

    let next = Core::up(dir.path()).await;
    assert_eq!(worker_of(&next, &worker).await, Some(Value::Object(released.0)));
}
