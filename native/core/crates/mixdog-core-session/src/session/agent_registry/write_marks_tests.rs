//! The row writer of [`StoreWorkers`]: one queue per session, so a session held at its put holds no other session's
//! write or answer; one ledger of outcomes, which is all a flush answers from ([`StoreWorkers::marks`] tells progress
//! alone); a release applied to the session and on the map it was decided for and to no other; and the shutdown, which
//! puts what was accepted before it seals admission and settles at its cutoff what it could not put.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_agent::agent_tool::host::ReleaseDone;
use mixdog_agent::agent_tool::host::ReleaseOutcome;
use mixdog_agent::agent_tool::host::ReleaseReceipt;
use mixdog_agent::agent_tool::host::ReleaseTarget;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::Attempt;
use mixdog_core_ports::ports::threads::HeaderStored;
use mixdog_core_ports::ports::threads::HeaderWrite;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::Bound;
use super::StoreWorkers;
use super::WorkerStore;

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// Headers whose patches wait at a gate named by the session, or fail for the session `bad` or for a refused probe; the
/// patches applied, in order. As a journal: the journal each session is written to, the `worker` value its header
/// holds, and the operations whose record it holds.
#[derive(Default)]
struct GatedHeaders {
    gates: Mutex<Vec<(String, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    applied: Mutex<Vec<(String, Value)>>,
    /// The probes (`worker.probe`) whose write the store refuses.
    refused: Mutex<HashSet<String>>,
    /// The probes whose stored write is answered with an unknown outcome: `true` when its record landed after all.
    unknown: Mutex<HashMap<String, bool>>,
    /// The operations whose record the journal holds.
    recorded: Mutex<HashSet<String>>,
    /// The journal a session is written to when it is not its first (empty: none can be told).
    journals: Mutex<HashMap<String, String>>,
    /// Each session's `worker` value as its header holds it.
    held: Mutex<HashMap<String, Value>>,
    /// The sessions whose log cannot tell what became of an operation.
    unsettled: Mutex<HashSet<String>>,
    /// How often an operation's fate was asked for (`Attempt::Settle`).
    settles: AtomicUsize,
    /// How often the writer was asked what it holds.
    asked: AtomicUsize,
    /// How many releases were handed to the journal to be written (not the questions about one).
    submitted: AtomicUsize,
}

impl GatedHeaders {
    /// The next patch of `session` signals the first notify when it arrives and waits for the second.
    fn hold(&self, session: &str) -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
        let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        self.gates.lock().unwrap().push((session.to_owned(), arrived.clone(), go.clone()));
        (arrived, go)
    }

    fn journal(&self, session: &str) -> String {
        self.journals.lock().unwrap().get(session).cloned().unwrap_or_else(|| format!("log:{session}"))
    }

    fn applied(&self) -> Vec<(String, Value)> {
        self.applied.lock().unwrap().clone()
    }

    fn worker(&self, session: &str) -> Value {
        self.held.lock().unwrap().get(session).cloned().unwrap_or(Value::Null)
    }
}

fn probe_of(set: &Map<String, Value>) -> String {
    set.get("worker").and_then(|worker| worker.get("probe")).and_then(Value::as_str).unwrap_or_default().to_owned()
}

#[async_trait::async_trait]
impl ThreadState for GatedHeaders {
    async fn header(&self, thread: &ThreadId) -> Result<mixdog_store::schema::record::Header, PortError> {
        Ok(match self.worker(thread.as_str()) {
            Value::Null => Map::new(),
            worker => Map::from_iter([("worker".to_owned(), worker)]),
        })
    }
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            gates.iter().position(|(s, _, _)| s == thread.as_str()).map(|at| gates.remove(at))
        };
        if let Some((_, arrived, go)) = gate {
            arrived.notify_one();
            go.notified().await;
        }
        if thread.as_str() == "bad" || self.refused.lock().unwrap().contains(&probe_of(&set)) {
            return Err(PortError::Denied("the header store refused it".into()));
        }
        let worker = set.get("worker").cloned().unwrap_or(Value::Null);
        self.held.lock().unwrap().insert(thread.as_str().to_owned(), worker.clone());
        self.applied.lock().unwrap().push((thread.as_str().to_owned(), worker));
        Ok(())
    }
    async fn patch_header_if(
        &self,
        _: &ThreadId,
        _: Map<String, Value>,
        _: Map<String, Value>,
        _: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError> {
        Ok(None)
    }
    /// The journal's own answer, by the rule the session's actor holds: a write decided for another journal, or on a
    /// value the header no longer holds, is superseded and applied nowhere; an operation submitted again is answered
    /// by its record; a stored one leaves its record.
    async fn store_header(&self, thread: &ThreadId, write: HeaderWrite) -> HeaderStored {
        if write.incarnation != self.journal(thread.as_str()) {
            return HeaderStored::Superseded("the session's journal is another one".into());
        }
        let recorded = self.recorded.lock().unwrap().contains(&write.operation);
        match write.attempt {
            Attempt::Settle => {
                self.settles.fetch_add(1, Ordering::SeqCst);
                let gate = {
                    let mut gates = self.gates.lock().unwrap();
                    let name = format!("settle:{}", thread.as_str());
                    gates.iter().position(|(s, _, _)| *s == name).map(|at| gates.remove(at))
                };
                if let Some((_, arrived, go)) = gate {
                    arrived.notify_one();
                    go.notified().await;
                }
                return if self.unsettled.lock().unwrap().contains(thread.as_str()) {
                    HeaderStored::Indeterminate("the log cannot tell".into())
                } else if recorded {
                    HeaderStored::Stored
                } else {
                    HeaderStored::Refused("the journal holds no record of the operation".into())
                };
            }
            Attempt::Replay if recorded => return HeaderStored::Stored,
            Attempt::Replay | Attempt::First => {}
        }
        self.submitted.fetch_add(1, Ordering::SeqCst);
        let before = self.worker(thread.as_str());
        if write.expect.get("worker").is_some_and(|expected| *expected != before) {
            return HeaderStored::Superseded("the header holds another value".into());
        }
        let probe = probe_of(&write.set);
        if let Err(error) = self.patch_header(thread, write.set, write.unset).await {
            return HeaderStored::Refused(format!("{error:?}"));
        }
        if let Some(landed) = self.unknown.lock().unwrap().remove(&probe) {
            if landed {
                self.recorded.lock().unwrap().insert(write.operation);
            } else {
                self.applied.lock().unwrap().pop();
                self.held.lock().unwrap().insert(thread.as_str().to_owned(), before);
            }
            return HeaderStored::Indeterminate("the append's outcome is unknown".into());
        }
        self.recorded.lock().unwrap().insert(write.operation);
        HeaderStored::Stored
    }
    fn log_identity(&self, thread: &ThreadId) -> Option<String> {
        Some(self.journal(thread.as_str())).filter(|journal| !journal.is_empty())
    }
    /// What this journal's writer holds: the `worker` value its last applied patch left.
    async fn held_fields(&self, thread: &ThreadId, keys: &'static [&'static str]) -> Result<Map<String, Value>, PortError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            let name = format!("held:{}", thread.as_str());
            gates.iter().position(|(s, _, _)| *s == name).map(|at| gates.remove(at))
        };
        if let Some((_, arrived, go)) = gate {
            arrived.notify_one();
            go.notified().await;
        }
        Ok(keys.iter().map(|key| ((*key).to_owned(), if *key == "worker" { self.worker(thread.as_str()) } else { Value::Null })).collect())
    }
    async fn publish(&self, _: &ThreadId, _: Section) -> Result<(), PortError> {
        Ok(())
    }
}

async fn workers(headers: Arc<impl ThreadState + 'static>) -> (tempfile::TempDir, StoreWorkers) {
    let dir = tempfile::tempdir().expect("temp dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = dir.path().to_owned();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let (state, _) =
        mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).expect("core state");
    (dir, StoreWorkers::new(index, headers, tokens.interactive_io, Arc::new(super::KeptRows::new(state))))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_barrier_waits_for_the_writes_before_it_and_not_the_later_ones() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (before_arrived, before_go) = headers.hold("before");
    let (after_arrived, _after_held) = headers.hold("after");

    workers.write("before", Some(Map::new()));
    tokio::time::timeout(DEADLINE, before_arrived.notified()).await.expect("the earlier patch did not start within 10 s");
    let mark = workers.marks().accepted();
    let mut settled = Box::pin(workers.marks().reached(mark));
    assert!(futures::poll!(settled.as_mut()).is_pending(), "the patch from before the barrier is still held");

    // A write after the barrier, of another session: its patch starts while the earlier session's is held, and is held for good.
    workers.write("after", None);
    tokio::time::timeout(DEADLINE, after_arrived.notified()).await.expect("the later patch did not start within 10 s of a held session");
    before_go.notify_one();
    let answer = tokio::time::timeout(DEADLINE, settled).await.expect("the barrier did not answer within 10 s although the earlier patch was applied");
    assert_eq!(answer, Ok(()));
    assert_eq!(workers.marks().committed(), mark, "the later write was still open when the barrier answered");
}

/// The flush's error is the ledger's. The marks tell that the write is closed and nothing of what became of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_write_before_the_flush_is_its_error_and_only_progress_to_the_marks() {
    let (_dir, workers) = workers(Arc::new(GatedHeaders::default())).await;
    workers.write("bad", None);
    let error = within("the flush", workers.settled()).await.expect_err("the failed patch is the flush's error");
    assert!(error.starts_with("the agent index: write 1, accepted before the barrier, failed: the worker row of bad"), "{error}");
    assert_eq!(within("the marks", workers.marks().reached(1)).await, Ok(()), "the marks keep no failure of this store");
}

fn released(probe: &str) -> Map<String, Value> {
    json!({ "releasedAt": "2026-11-06T00:00:00.000Z", "probe": probe }).as_object().cloned().expect("an object")
}

fn row(probe: &str) -> Map<String, Value> {
    json!({ "status": "idle", "probe": probe }).as_object().cloned().expect("an object")
}

/// The receipt the registry makes of a release of `released(probe)` decided now on `prior`: bound to what the store
/// names for the session at this moment.
fn receipt(workers: &StoreWorkers, session: &str, probe: &str, prior: Option<Map<String, Value>>) -> ReleaseReceipt {
    let Bound { target, incarnation, .. } = WorkerStore::bound(workers, session).expect("the store names the session");
    ReleaseReceipt {
        session_id: session.to_owned(),
        incarnation,
        prior,
        operation: format!("worker-release:{session}:{probe}"),
        tag: None,
        turn: None,
        revision: 0,
        target,
        released: released(probe),
    }
}

/// A first release of a session that has no map yet.
fn release(workers: &StoreWorkers, session: &str, probe: &str) -> ReleaseDone {
    release_on(workers, session, probe, None)
}

/// A first release of `session`, decided on `prior`.
fn release_on(workers: &StoreWorkers, session: &str, probe: &str, prior: Option<Map<String, Value>>) -> ReleaseDone {
    workers.release(&receipt(workers, session, probe, prior), false)
}

async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, wait).await.unwrap_or_else(|_| panic!("{what} did not happen within 10 s"))
}

/// A flush answers for the writes accepted before it: one accepted later and refused, while a write of the flush is
/// still at its put, neither fails the flush nor holds it; the next flush is the one that reports it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failing_write_accepted_after_a_flushs_watermark_neither_fails_nor_holds_it() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (arrived, go) = headers.hold("before");
    workers.write("before", Some(Map::new()));
    within("the earlier patch's start", arrived.notified()).await;
    let mut flush = Box::pin(workers.settled());
    assert!(futures::poll!(flush.as_mut()).is_pending(), "the write before the flush is still at its put");

    let refused = release(&workers, "bad", "bad");
    let outcome = within("the later release's answer", refused.outcome()).await;
    assert!(matches!(&outcome, ReleaseOutcome::Refused(why) if why.contains("bad")), "{outcome:?}");
    assert!(futures::poll!(flush.as_mut()).is_pending(), "the later refusal did not answer the flush");
    go.notify_one();
    assert_eq!(within("the flush", flush).await, Ok(()), "the later refusal is not the flush's");
    let later = within("the next flush", workers.settled()).await;
    assert!(later.as_ref().is_err_and(|error| error.contains("bad")), "the flush after the refusal reports it: {later:?}");
}

/// The writes are ordered per session: while session `a` is held at its put, session `b`'s release is put and answered.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_held_at_its_put_holds_no_other_sessions_release_or_answer() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (a_arrived, a_go) = headers.hold("a");
    let a = release(&workers, "a", "a");
    within("a's put", a_arrived.notified()).await;

    let b = release(&workers, "b", "b");
    assert_eq!(within("b's answer while a is held", b.outcome()).await, ReleaseOutcome::Stored);
    assert_eq!(a.now(), None, "a is still at its put");
    assert_eq!(headers.applied(), [("b".to_owned(), Value::Object(released("b")))]);
    assert_eq!(workers.marks().check(2), None, "a's write is open");

    a_go.notify_one();
    assert_eq!(within("a's answer", a.outcome()).await, ReleaseOutcome::Stored);
    assert_eq!(within("the flush", workers.settled()).await, Ok(()));
}

/// The session directory's shutdown (`RowWrites`): its flush stops header admission, and at its cutoff a header write a
/// flush that overran left queued is answered refused there and then, not when the write ahead of it returns. None is
/// put from then on and none opens a session. The kept table needs no session and is written until the writer itself
/// shuts down.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn from_the_directorys_flush_on_a_header_write_is_refused_and_the_tables_are_still_written() {
    use crate::session::RowWrites;
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (arrived, go) = headers.hold("a");
    let first = json!({ "status": "idle" }).as_object().cloned().unwrap();
    workers.write("a", Some(first.clone()));
    within("the first write's put", arrived.notified()).await;
    let queued = release_on(&workers, "a", "a", Some(first.clone()));

    let mut drain = Box::pin(RowWrites::drain(&workers));
    assert!(futures::poll!(drain.as_mut()).is_pending(), "the flush waits for what was accepted");
    let accepted = workers.marks().accepted();
    let sealed = release(&workers, "b", "b");
    assert!(matches!(sealed.now(), Some(ReleaseOutcome::Refused(_))), "no header release joins the flush: {:?}", sealed.now());

    // The flush overran: the directory goes on to drain its slots.
    drop(drain);
    RowWrites::headers_closed(&workers);
    let left = queued.now();
    assert!(matches!(&left, Some(ReleaseOutcome::Refused(why)) if why.contains("shutting down")), "settled at the cutoff, with a's put still held: {left:?}");
    go.notify_one();
    let late = release(&workers, "c", "c");
    assert!(matches!(late.now(), Some(ReleaseOutcome::Refused(_))), "{:?}", late.now());
    workers.write("c", None);
    assert_eq!(workers.marks().accepted(), accepted, "no header write was accepted from the flush on");

    WorkerStore::keep(&workers, "k", Some(released("k")));
    assert_eq!(workers.marks().accepted(), accepted + 1, "the kept table still takes writes");
    let _ = within("the kept write", workers.settled()).await;
    let kept = within("the kept maps", WorkerStore::worker_maps(&workers)).await.expect("the maps");
    assert!(kept.contains(&("k".to_owned(), released("k"))), "{kept:?}");
    let _ = within("the shutdown", workers.shutdown()).await;
    assert_eq!(headers.applied(), [("a".to_owned(), Value::Object(first))], "the headers were asked for nothing more");
    WorkerStore::keep(&workers, "k2", Some(released("k2")));
    assert_eq!(workers.marks().accepted(), accepted + 1, "the shutdown sealed the tables too");
}

/// The cutoff of a shutdown whose drain overran, with one session blocked and one healthy. The healthy session's
/// release was drained and stored before the cutoff. Of the blocked session, the release that was never submitted is
/// refused at the cutoff, and the one at its put, which may have reached its journal, is indeterminate: neither waits
/// for the put, which never returns here until the test lets it, and what it returns then answers nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_the_cutoff_a_blocked_sessions_releases_are_settled_and_a_healthy_sessions_was_stored() {
    use crate::session::RowWrites;
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (a_arrived, a_go) = headers.hold("a");
    let submitted = release(&workers, "a", "a1");
    within("a's put", a_arrived.notified()).await;
    let unsubmitted = release_on(&workers, "a", "a2", Some(released("a1")));
    let healthy = release(&workers, "b", "b");

    let overran = tokio::time::timeout(std::time::Duration::from_millis(300), RowWrites::drain(&workers)).await;
    assert!(overran.is_err(), "the drain waits on the blocked session until its deadline");
    assert_eq!(healthy.now(), Some(ReleaseOutcome::Stored), "the healthy session drained while the other was blocked");
    assert_eq!((submitted.now(), unsubmitted.now()), (None, None), "nothing of the blocked session is answered before the cutoff");

    RowWrites::headers_closed(&workers);
    let (at_put, queued) = (submitted.now(), unsubmitted.now());
    assert!(matches!(&at_put, Some(ReleaseOutcome::Indeterminate(why)) if why.contains("not known")), "submitted, outcome unknown: {at_put:?}");
    assert!(matches!(&queued, Some(ReleaseOutcome::Refused(why)) if why.contains("shutting down")), "provably not submitted: {queued:?}");
    assert_eq!(headers.applied(), [("b".to_owned(), Value::Object(released("b")))], "the stores agree: b's release alone is there");
    let flushed = within("the flush", workers.settled()).await;
    assert!(flushed.as_ref().is_err_and(|error| error.contains("the worker row of a")), "the stop step logs what was not stored: {flushed:?}");

    // The blocked put returns at last: it answers nothing, and the writer can be joined.
    a_go.notify_one();
    let _ = within("the shutdown", workers.shutdown()).await;
    assert!(matches!(submitted.now(), Some(ReleaseOutcome::Indeterminate(_))), "the cutoff's answer stands: {:?}", submitted.now());
    assert!(matches!(unsubmitted.now(), Some(ReleaseOutcome::Refused(_))));
}

/// A shutdown seals admission and then drains: a release accepted behind a write still at its put, so not started when
/// the shutdown begins, is put before the shutdown ends, in its session's order; what is written after the seal is
/// refused and numbered nowhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shutdown_puts_a_release_accepted_and_not_started_and_then_admits_nothing() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (arrived, go) = headers.hold("a");
    let first = json!({ "status": "idle" }).as_object().cloned().unwrap();
    workers.write("a", Some(first.clone()));
    within("the first write's put", arrived.notified()).await;
    let queued = release_on(&workers, "a", "a", Some(first.clone()));

    let mut stop = Box::pin(workers.shutdown());
    assert!(futures::poll!(stop.as_mut()).is_pending(), "the shutdown waits for what was accepted");
    assert_eq!(queued.now(), None, "the release is queued, not started");
    let accepted = workers.marks().accepted();
    let late = release(&workers, "late", "late");
    assert!(matches!(late.now(), Some(ReleaseOutcome::Refused(_))), "admission is sealed: {:?}", late.now());
    workers.write("late", None);
    assert_eq!(workers.marks().accepted(), accepted, "nothing is accepted after the seal");

    go.notify_one();
    assert_eq!(within("the shutdown", stop).await, Ok(()));
    assert_eq!(queued.now(), Some(ReleaseOutcome::Stored), "the queued release was put before the shutdown ended");
    assert_eq!(headers.applied(), [("a".to_owned(), Value::Object(first)), ("a".to_owned(), Value::Object(released("a")))]);
}

/// A flush answers from the writes at or below its watermark, each put under its own number. A write accepted above it
/// takes neither the place nor the outcome of a queued one below it: it does not repair the flush when the write below
/// was refused, and does not fail it when the write below was stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flush_answers_from_the_writes_at_or_below_its_watermark_alone() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (arrived, go) = headers.hold("a");
    workers.write("a", Some(row("w0")));
    within("the first write's put", arrived.notified()).await;
    headers.refused.lock().unwrap().insert("w1".to_owned());
    workers.write("a", Some(row("w1")));
    // A second flush to the same watermark, taken now and waited for later.
    let earlier = workers.flush_mark();
    let watermark = earlier.number();
    let mut flush = Box::pin(workers.settled());
    assert!(futures::poll!(flush.as_mut()).is_pending(), "the writes before the flush are not put yet");
    // Accepted above the watermark while the refused write is still queued: same session, same target.
    workers.write("a", Some(row("w2")));
    assert_eq!(workers.marks().accepted(), watermark + 1, "the later write has a number of its own");
    go.notify_one();

    let answer = within("the flush", flush).await;
    assert!(answer.as_ref().is_err_and(|error| error.contains("write 2,")), "the later write did not repair the flush: {answer:?}");
    assert_eq!(within("the next flush", workers.settled()).await, Ok(()), "the session's last write is stored");
    assert_eq!(headers.applied(), [("a".to_owned(), Value::Object(row("w0"))), ("a".to_owned(), Value::Object(row("w2")))], "each write was put, in order");
    let still = within("the earlier watermark again", workers.settled_to(&earlier)).await;
    assert!(still.is_err(), "a flush to the earlier watermark still answers from the writes up to it: {still:?}");
    assert_eq!(workers.ledger_len(), 2, "the refusal is held for the flush that can still select it, with the write after it");
    drop(earlier);
    assert_eq!(workers.ledger_len(), 0, "answered: the session's last write is stored, so nothing is held");

    // The other order: stored at the watermark, refused above it.
    let (arrived, go) = headers.hold("b");
    workers.write("b", Some(row("x0")));
    within("b's put", arrived.notified()).await;
    let mut flush = Box::pin(workers.settled());
    headers.refused.lock().unwrap().insert("x1".to_owned());
    workers.write("b", Some(row("x1")));
    assert!(futures::poll!(flush.as_mut()).is_pending());
    go.notify_one();
    assert_eq!(within("the flush", flush).await, Ok(()), "the refusal above the watermark is not this flush's");
    let later = within("the flush after it", workers.settled()).await;
    assert!(later.as_ref().is_err_and(|error| error.contains("the worker row of b")), "{later:?}");
}

/// The ledger the flushes answer from holds what an answer can still depend on, not what was written: with no flush
/// outstanding, hundreds of refused writes of one session leave the one outcome of its last write; a flush outstanding
/// holds the one it selects until it answers; and the entry goes when the session's last write is stored, or with the
/// session when its record is deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_flush_ledger_holds_one_outcome_for_a_session_however_many_of_its_writes_were_refused() {
    const REFUSED: usize = 300;
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    for n in 0..REFUSED {
        workers.write("bad", Some(row(&format!("w{n}"))));
    }
    let flushed = within("the flush", workers.settled()).await;
    assert!(flushed.as_ref().is_err_and(|error| error.contains(&format!("write {REFUSED},"))), "the last refused write is the flush's: {flushed:?}");
    assert_eq!(workers.ledger_len(), 1, "one outcome for the session, not one per refused write");
    assert_eq!(within("the marks", workers.marks().reached(REFUSED as u64)).await, Ok(()), "and no second history of them in the marks");

    // An outstanding flush holds the outcome it selects while later writes close; it is dropped with the flush.
    let outstanding = workers.flush_mark();
    for n in 0..REFUSED {
        workers.write("bad", Some(row(&format!("x{n}"))));
    }
    assert!(within("the later flush", workers.settled()).await.is_err());
    assert_eq!(workers.ledger_len(), 2, "the outstanding flush's and the last write's");
    assert!(within("the outstanding flush", workers.settled_to(&outstanding)).await.is_err());
    drop(outstanding);
    assert_eq!(workers.ledger_len(), 1);

    // Another session whose last write is stored owes nothing and holds nothing.
    headers.refused.lock().unwrap().insert("no".to_owned());
    workers.write("a", Some(row("no")));
    workers.write("a", Some(row("yes")));
    let _ = within("the flush", workers.settled()).await;
    assert_eq!(workers.ledger_len(), 1, "the session whose last write is stored left no entry");

    // The session is deleted (its map is kept from here): with no flush outstanding, what its header was owed goes.
    WorkerStore::keep(&workers, "bad", Some(row("kept")));
    assert_eq!(within("the flush", workers.settled()).await, Ok(()), "the kept write is what the session is owed");
    assert_eq!(workers.ledger_len(), 0);
}

/// A session's deletion retires what its header was owed for the flushes taken from then on, and erases nothing a
/// flush taken before it selected: neither a failure recorded when the session is kept, nor one of a write accepted
/// before the flush's watermark that fails only after the session is kept. The pin ends with the mark.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flush_taken_before_its_sessions_deletion_keeps_the_outcome_it_selected() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;

    // The failure is recorded already when the session is kept.
    headers.refused.lock().unwrap().insert("no".to_owned());
    workers.write("a", Some(row("no")));
    assert!(within("the flush", workers.settled()).await.is_err(), "a's header write was refused");
    let before = workers.flush_mark();
    WorkerStore::keep(&workers, "a", Some(row("kept")));
    assert_eq!(within("a flush after the keep", workers.settled()).await, Ok(()), "the header's failure is retired for it");
    let pinned = within("the flush taken before", workers.settled_to(&before)).await;
    assert!(pinned.as_ref().is_err_and(|error| error.contains("the worker row of a")), "the keep erased nothing it selected: {pinned:?}");
    assert_eq!(workers.ledger_len(), 1, "held for that flush alone");
    drop(before);
    assert_eq!(workers.ledger_len(), 0, "the pin ended with the mark");

    // The failure arrives after the session is kept: the write was accepted before the flush and is still at its put.
    let (arrived, go) = headers.hold("b");
    workers.write("b", Some(row("no")));
    within("b's put", arrived.notified()).await;
    let before = workers.flush_mark();
    WorkerStore::keep(&workers, "b", Some(row("kept")));
    let mut pinned = Box::pin(workers.settled_to(&before));
    assert!(futures::poll!(pinned.as_mut()).is_pending(), "the write below the watermark is not closed yet");
    go.notify_one();
    let pinned = within("the flush taken before", pinned).await;
    assert!(pinned.as_ref().is_err_and(|error| error.contains("the worker row of b")), "the failure that came after the keep is its answer: {pinned:?}");
    assert_eq!(within("a flush after the keep", workers.settled()).await, Ok(()), "and no later flush's");
    assert_eq!(workers.ledger_len(), 1);
    drop(before);
    assert_eq!(workers.ledger_len(), 0);
    let kept = within("the kept maps", WorkerStore::worker_maps(&workers)).await.expect("the maps");
    assert_eq!(kept.len(), 2, "both sessions' kept writes were stored: {kept:?}");
}

/// A release is stored by its own record and by nothing else. The header already holds the very map the release would
/// put (an ordinary write put it); the release's append then ends with an unknown outcome and did not land: that same
/// operation is asked for, and answered not stored. One that did land is answered stored.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_is_not_stored_by_another_write_that_put_the_same_value() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    workers.write("a", Some(released("same")));
    within("the ordinary write", workers.settled()).await.expect("stored");
    assert_eq!(headers.applied(), [("a".to_owned(), Value::Object(released("same")))], "the header holds the value");

    headers.unknown.lock().unwrap().insert("same".to_owned(), false);
    let lost = within("the release's answer", release_on(&workers, "a", "same", Some(released("same"))).outcome()).await;
    assert!(matches!(&lost, ReleaseOutcome::Refused(why) if why.contains("settled as not stored")), "the equal value is not its receipt: {lost:?}");
    assert_eq!(headers.settles.load(Ordering::SeqCst), 1, "its own operation was asked for");
    assert!(within("the flush", workers.settled()).await.is_err(), "the release that was not stored is the flush's");

    headers.unknown.lock().unwrap().insert("landed".to_owned(), true);
    let landed = within("the release's answer", release_on(&workers, "a", "landed", Some(released("same"))).outcome()).await;
    assert_eq!(landed, ReleaseOutcome::Stored, "its own record is in the journal");
}

/// An append whose outcome stays unknown holds its own session's next header write and no one else's: the next release
/// of the session asks for that same operation once more and, while it cannot be told, is refused unsubmitted; another
/// session's release is stored meanwhile; and once the log can tell, the session writes again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unsettled_append_holds_its_own_sessions_next_header_write_and_no_other_sessions() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    headers.unknown.lock().unwrap().insert("lost".to_owned(), false);
    headers.unsettled.lock().unwrap().insert("a".to_owned());
    let (arrived, go) = headers.hold("a");
    let lost = release(&workers, "a", "lost");
    within("a's put", arrived.notified()).await;
    let next = release(&workers, "a", "next");
    go.notify_one();

    let lost = within("the lost release's answer", lost.outcome()).await;
    assert!(matches!(&lost, ReleaseOutcome::Indeterminate(why) if why.contains("not settled")), "{lost:?}");
    let next = within("the next release's answer", next.outcome()).await;
    assert!(matches!(&next, ReleaseOutcome::Indeterminate(why) if why.contains("cannot be settled")), "{next:?}");
    assert_eq!(within("another session's release", release(&workers, "b", "b").outcome()).await, ReleaseOutcome::Stored);
    assert!(headers.applied().iter().all(|(session, _)| session == "b"), "nothing of a was written over the unknown append: {:?}", headers.applied());

    // The log can tell now: the lost append left nothing, and the session writes again.
    headers.unsettled.lock().unwrap().clear();
    assert_eq!(within("the release after it settled", release(&workers, "a", "again").outcome()).await, ReleaseOutcome::Stored);
}

/// A release is bound, where it is decided, to the journal its session has then, and the target applies it to no
/// other: the session is replaced under the same id while the release waits behind a write, and the release is
/// answered superseded with nothing written. A session the store can tell no journal for is named by nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_queued_for_a_session_that_was_replaced_before_its_put_writes_nothing() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let (arrived, go) = headers.hold("a");
    workers.write("a", Some(row("w0")));
    within("the first write's put", arrived.notified()).await;
    let old = receipt(&workers, "a", "old", Some(row("w0")));
    assert_eq!((old.target, old.incarnation.as_str()), (ReleaseTarget::Header, "log:a"), "bound to the journal it was decided for");
    let queued = workers.release(&old, false);

    headers.journals.lock().unwrap().insert("a".to_owned(), "log:a2".to_owned());
    go.notify_one();
    let outcome = within("the release's answer", queued.outcome()).await;
    assert!(matches!(&outcome, ReleaseOutcome::Superseded(_)), "{outcome:?}");
    assert_eq!(headers.applied(), [("a".to_owned(), Value::Object(row("w0")))], "the new session was not patched by id");
    // Submitted again, it is still the operation it was, for the journal it was decided for.
    let again = within("the same release again", workers.release(&old, true).outcome()).await;
    assert!(matches!(&again, ReleaseOutcome::Superseded(_)), "never rebound to the journal the session has now: {again:?}");

    let next = receipt(&workers, "a", "new", Some(row("w0")));
    assert_eq!(next.incarnation, "log:a2");
    assert_eq!(within("the next release", workers.release(&next, false).outcome()).await, ReleaseOutcome::Stored);

    headers.journals.lock().unwrap().insert("nowhere".to_owned(), String::new());
    assert_eq!(WorkerStore::bound(&workers, "nowhere"), None, "a session of unknown identity is bound to nothing");
}

/// A release that was decided on a map its header no longer holds writes nothing, the first time or again: a newer
/// binding is not overwritten by an older release, and a release whose record the journal holds is answered by that
/// record, whatever the header holds now.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_writes_only_over_the_map_it_was_decided_on() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    workers.write("a", Some(row("w0")));
    within("the row", workers.settled()).await.expect("stored");
    let stored = receipt(&workers, "a", "r1", Some(row("w0")));
    assert_eq!(within("the release", workers.release(&stored, false).outcome()).await, ReleaseOutcome::Stored);
    let never = receipt(&workers, "a", "r2", Some(row("w0")));

    // A newer binding of the session.
    workers.write("a", Some(row("newer")));
    within("the newer row", workers.settled()).await.expect("stored");
    let first = within("a first release on the older map", workers.release(&never, false).outcome()).await;
    assert!(matches!(&first, ReleaseOutcome::Superseded(_)), "{first:?}");
    let again = within("the same again", workers.release(&never, true).outcome()).await;
    assert!(matches!(&again, ReleaseOutcome::Superseded(_)), "{again:?}");
    assert_eq!(within("the stored one again", workers.release(&stored, true).outcome()).await, ReleaseOutcome::Stored, "answered by its own record");
    assert_eq!(headers.worker("a"), Value::Object(row("newer")), "the newer binding stands");
}

/// The store's record of what a session really holds exists only while the session's last closed write was not stored,
/// which is when the caller's own map is ahead of the target. A stored write leaves none; a refused one makes the
/// session's task read the target; a superseded release shows the caller's word was wrong and the target is read
/// again; while a write of the session is still open the record is not offered, since the release queued then is put
/// after that write; and a stored write drops it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_store_records_what_a_session_holds_only_while_its_last_write_was_not_stored() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    let holds = |session: &str| WorkerStore::bound(&workers, session).expect("the store names the session").holds;
    assert_eq!(holds("a"), None);
    workers.write("a", Some(row("w0")));
    within("the row", workers.settled()).await.expect("stored");
    assert_eq!(holds("a"), None, "a stored write leaves the caller's map true");

    // A refused write: the caller's map is ahead, and the target is read.
    headers.refused.lock().unwrap().insert("no".to_owned());
    workers.write("a", Some(row("no")));
    assert!(within("the flush", workers.settled()).await.is_err());
    within("the read after the refusal", workers.idle()).await;
    assert_eq!(holds("a"), Some(Some(row("w0"))), "what the header really holds");
    // A release decided on it is a compare-and-set that holds.
    let decided = receipt(&workers, "a", "r1", holds("a").expect("recorded"));
    assert_eq!(within("the release", workers.release(&decided, false).outcome()).await, ReleaseOutcome::Stored);
    assert_eq!(holds("a"), None, "stored: the record is dropped");

    // A release decided on a map the header does not hold: superseded, nothing written, and the target read.
    let asked = headers.asked.load(Ordering::SeqCst);
    let wrong = within("the release on a wrong word", release_on(&workers, "a", "r2", Some(row("no"))).outcome()).await;
    assert!(matches!(wrong, ReleaseOutcome::Superseded(_)), "{wrong:?}");
    within("the read after the mismatch", workers.idle()).await;
    assert_eq!((holds("a"), headers.worker("a")), (Some(Some(released("r1"))), Value::Object(released("r1"))), "read, not written");
    assert_eq!(headers.asked.load(Ordering::SeqCst), asked + 1, "asked of the writer once, after the mismatch");

    // With a write of the session still at its put, the record is not offered: a release queued now is put after it.
    let (arrived, go) = headers.hold("a");
    workers.write("a", Some(row("w1")));
    within("the write's put", arrived.notified()).await;
    assert_eq!(holds("a"), None);
    go.notify_one();
    within("the write", workers.settled()).await.expect("stored");
    assert_eq!(holds("a"), None, "and the stored write dropped it");
}

/// A release's precondition is the receipt's, fixed at the decision, and nothing fixes another one later. A release
/// that was refused is submitted again after the header was changed in between: it is the same compare-and-set on the
/// same map, so it is superseded and the newer header stands; what the header holds was not read to make it fit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_submitted_again_keeps_the_precondition_it_was_decided_on() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    workers.write("a", Some(row("w0")));
    within("the row", workers.settled()).await.expect("stored");

    headers.refused.lock().unwrap().insert("r".to_owned());
    let decided = receipt(&workers, "a", "r", Some(row("w0")));
    let first = within("the release", workers.release(&decided, false).outcome()).await;
    assert!(matches!(first, ReleaseOutcome::Refused(_)), "{first:?}");
    headers.refused.lock().unwrap().clear();

    // The header is changed in between.
    workers.write("a", Some(row("newer")));
    within("the newer row", workers.settled()).await.expect("stored");
    let again = within("the release again", workers.release(&decided, true).outcome()).await;
    assert!(matches!(again, ReleaseOutcome::Superseded(_)), "the old release is not made to fit the newer header: {again:?}");
    assert_eq!(decided.prior, Some(row("w0")), "the precondition is the one it was decided on");
    assert_eq!(headers.worker("a"), Value::Object(row("newer")), "the newer header stands");
}

/// A release of unknown outcome does not strand its session. The mark it leaves carries its own operation, and the
/// session's next header operation settles it first: in a new queue task, after the first one retired, and with no
/// ordinary write in between. Only while it still cannot be told is the release behind it answered, unsubmitted, as
/// indeterminate on its own receipt. Once told, a release decided on what the session then holds is stored, whether
/// the lost one turns out committed or not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_of_unknown_outcome_is_settled_by_its_sessions_next_operation_whichever_task_runs_it() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    for (session, landed) in [("a", false), ("b", true)] {
        let probe = format!("lost-{session}");
        headers.unknown.lock().unwrap().insert(probe.clone(), landed);
        headers.unsettled.lock().unwrap().insert(session.to_owned());
        let lost = within("the lost release", release(&workers, session, &probe).outcome()).await;
        assert!(matches!(lost, ReleaseOutcome::Indeterminate(_)), "{lost:?}");
        // The queue that put it has nothing more and retires; the flush sees the session idle.
        assert!(within("the flush", workers.settled()).await.is_err());
        let settled_state = landed.then(|| released(&probe));

        // Still not to be told: the release behind it is not submitted, and says so itself.
        let submitted = headers.submitted.load(Ordering::SeqCst);
        let held = receipt(&workers, session, "held", settled_state.clone());
        let answer = within("the release behind it", workers.release(&held, false).outcome()).await;
        assert!(matches!(&answer, ReleaseOutcome::Indeterminate(why) if why.contains("cannot be settled")), "its own receipt: {answer:?}");
        assert_eq!(headers.submitted.load(Ordering::SeqCst), submitted, "nothing was submitted");

        // The log can tell now. No ordinary write comes: the next release settles the lost one first, by its operation.
        headers.unsettled.lock().unwrap().clear();
        let settles = headers.settles.load(Ordering::SeqCst);
        assert_eq!(within("the held release again", workers.release(&held, true).outcome()).await, ReleaseOutcome::Stored);
        assert_eq!(headers.settles.load(Ordering::SeqCst), settles + 1, "the lost operation was asked for once");
        assert_eq!(headers.worker(session), Value::Object(released("held")));

        // Settled: the one after asks for nothing more of it.
        assert_eq!(within("the next release", release_on(&workers, session, "next", Some(released("held"))).outcome()).await, ReleaseOutcome::Stored);
        assert_eq!(headers.settles.load(Ordering::SeqCst), settles + 1, "nothing is left to settle");
    }
}

/// The cutoff and a flight that was not submitted yet. A release's task has taken it from the queue and is still
/// settling an earlier release when the directory's cutoff comes: its flight exists, and nothing of it was handed to
/// the journal. The cutoff takes that flight and answers it refused, not indeterminate, and when the task goes on it
/// submits nothing: the journal is asked to write no release after the cutoff.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn at_the_cutoff_a_flight_that_was_not_submitted_is_refused_and_is_never_submitted_after_it() {
    use crate::session::RowWrites;
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    headers.unknown.lock().unwrap().insert("lost".to_owned(), false);
    headers.unsettled.lock().unwrap().insert("a".to_owned());
    let lost = within("the lost release", release(&workers, "a", "lost").outcome()).await;
    assert!(matches!(lost, ReleaseOutcome::Indeterminate(_)), "{lost:?}");

    // The next release's task takes it and is held while it settles the lost one: taken, and not submitted.
    let (arrived, go) = headers.hold("settle:a");
    let paused = release(&workers, "a", "paused");
    within("the settling of the lost release", arrived.notified()).await;
    let queued = release(&workers, "a", "queued");
    let submitted = headers.submitted.load(Ordering::SeqCst);

    RowWrites::headers_closed(&workers);
    let (paused, queued) = (paused.now(), queued.now());
    assert!(matches!(&paused, Some(ReleaseOutcome::Refused(why)) if why.contains("shutting down")), "taken unsubmitted, so provably not written: {paused:?}");
    assert!(matches!(&queued, Some(ReleaseOutcome::Refused(_))), "{queued:?}");

    // The lost one can be told now, so the task goes on to its put: the flight is gone, and nothing is submitted.
    headers.unsettled.lock().unwrap().clear();
    go.notify_one();
    let _ = within("the shutdown", workers.shutdown()).await;
    assert_eq!(headers.submitted.load(Ordering::SeqCst), submitted, "no release reached the journal after the cutoff");
    assert!(headers.applied().is_empty(), "and nothing was written: {:?}", headers.applied());
}

/// A retirement covers what was accepted before it, and a session can be retired more than once. The session is
/// deleted, made again, and a header write of the new record is still at its put when a flush is taken and the session
/// is deleted again. That write then fails: it was accepted after the first retirement, which says nothing of it, and
/// before the second, so the flush taken before the second still selects it. A flush taken after the second owes the
/// header nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_retirement_does_not_hide_a_write_accepted_after_the_first() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    WorkerStore::keep(&workers, "a", Some(row("kept")));
    within("the first deletion", workers.settled()).await.expect("stored");
    // Made again: its map is kept no more, and its writes go to its header.
    WorkerStore::keep(&workers, "a", None);
    within("the kept row's removal", workers.settled()).await.expect("stored");
    assert!(!WorkerStore::kept(&workers, "a"));

    headers.refused.lock().unwrap().insert("no".to_owned());
    let (arrived, go) = headers.hold("a");
    workers.write("a", Some(row("no")));
    within("the header write's put", arrived.notified()).await;
    let before = workers.flush_mark();
    WorkerStore::keep(&workers, "a", Some(row("kept again")));
    let mut pinned = Box::pin(workers.settled_to(&before));
    assert!(futures::poll!(pinned.as_mut()).is_pending(), "the write below the watermark is not closed yet");
    go.notify_one();

    let pinned = within("the flush taken before the second deletion", pinned).await;
    assert!(pinned.as_ref().is_err_and(|error| error.contains("the worker row of a")), "the first retirement does not cover it: {pinned:?}");
    assert_eq!(within("a flush after the second deletion", workers.settled()).await, Ok(()), "the second one does, for the flushes after it");
    assert_eq!(workers.ledger_len(), 1, "held for the flush that selects it");
    drop(before);
    assert_eq!(workers.ledger_len(), 0);
}

/// The cutoff and an outcome the target already established. A release is answered superseded by its target, and the
/// session's task goes on to read what the header holds; the directory's cutoff comes during that read. The read is no
/// part of the release's flight: the receipt was answered superseded when the target answered, the cutoff finds no
/// flight to answer as indeterminate, and nothing of the release is left to settle.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cutoff_during_the_read_after_a_mismatch_leaves_the_outcome_the_target_established() {
    use crate::session::RowWrites;
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    workers.write("a", Some(row("w0")));
    within("the row", workers.settled()).await.expect("stored");

    let (arrived, go) = headers.hold("held:a");
    let wrong = release_on(&workers, "a", "r", Some(row("another")));
    within("the read of what the header holds", arrived.notified()).await;
    RowWrites::headers_closed(&workers);

    let outcome = wrong.now();
    assert!(matches!(&outcome, Some(ReleaseOutcome::Superseded(_))), "the target's own answer, not the cutoff's: {outcome:?}");
    assert!(workers.writers.lanes().unsettled.is_empty(), "nothing was written, so nothing is left to settle");
    go.notify_one();
    let flushed = within("the shutdown", workers.shutdown()).await;
    assert!(flushed.as_ref().is_err_and(|error| error.contains("the header holds another value")), "the flush tells the same outcome: {flushed:?}");
    assert_eq!(headers.worker("a"), Value::Object(row("w0")), "and nothing was written");
}

/// A session is marked kept and its retirement numbered in one step. An earlier retirement of the session is still
/// held, by a flush taken before it; the session was made again, and a failing header write of the new record closes
/// while the session is being deleted a second time. Whichever comes first, the write's failure is recorded for the
/// flush taken before the second deletion: it never closes seeing the session kept with only the old retirement, which
/// would cover it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_closing_while_its_session_is_kept_again_never_sees_it_kept_without_that_retirement() {
    let headers = Arc::new(GatedHeaders::default());
    let (_dir, workers) = workers(headers.clone()).await;
    headers.refused.lock().unwrap().extend(["no1".to_owned(), "no2".to_owned()]);
    // A failure of the first record, held by a flush taken before the first deletion: that retirement stays live.
    workers.write("a", Some(row("no1")));
    let early = workers.flush_mark();
    assert!(within("the early flush", workers.settled_to(&early)).await.is_err());
    WorkerStore::keep(&workers, "a", Some(row("kept")));
    within("the first deletion", workers.settled()).await.expect("stored");
    WorkerStore::keep(&workers, "a", None);
    within("the kept row's removal", workers.settled()).await.expect("stored");
    within("the session's task", workers.idle()).await;
    assert!(!WorkerStore::kept(&workers, "a"));
    assert_eq!(workers.writers.lanes().retired.get("a").map(Vec::len), Some(2), "the earlier retirements are still held");

    let (arrived, go) = headers.hold("a");
    workers.write("a", Some(row("no2")));
    within("the header write's put", arrived.notified()).await;
    let before = workers.flush_mark();
    {
        // With the lanes held, the second deletion and the write's close both wait for them; neither is half done.
        let lanes = workers.writers.lanes();
        go.notify_one();
        std::thread::scope(|scope| {
            scope.spawn(|| WorkerStore::keep(&workers, "a", Some(row("kept again"))));
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(!workers.kept.holds("a"), "not marked kept before its retirement can be numbered");
            drop(lanes);
        });
    }

    let pinned = within("the flush taken before the second deletion", workers.settled_to(&before)).await;
    assert!(pinned.as_ref().is_err_and(|error| error.contains("the worker row of a")), "the failure is not covered by the old retirement: {pinned:?}");
    assert!(WorkerStore::kept(&workers, "a"));
    assert_eq!(within("a flush after the second deletion", workers.settled()).await, Ok(()));
}

/// A kept row's release is bound to the row itself: the identity the table gave it when the session was kept. It is
/// answered by its own committed transaction, applied only while the row holds the map it was decided on, and never
/// to a row kept again under the same id after the first was removed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kept_rows_release_is_bound_to_that_row_and_to_the_map_it_was_decided_on() {
    let (_dir, workers) = workers(Arc::new(GatedHeaders::default())).await;
    WorkerStore::keep(&workers, "k", Some(row("kept")));
    within("the kept write", workers.settled()).await.expect("stored");
    let first = receipt(&workers, "k", "k", Some(row("kept")));
    assert!(first.target == ReleaseTarget::Kept && !first.incarnation.is_empty() && first.incarnation != "kept", "{first:?}");
    assert_eq!(within("the kept release", workers.release(&first, false).outcome()).await, ReleaseOutcome::Stored);

    // A newer map of the same row: the stored release, submitted again, is answered by its own transaction and writes
    // nothing; one never committed, decided on the older map, is superseded.
    workers.write("k", Some(row("newer")));
    within("the newer map", workers.settled()).await.expect("stored");
    assert_eq!(within("the stored release again", workers.release(&first, true).outcome()).await, ReleaseOutcome::Stored);
    let never = ReleaseReceipt { operation: "worker-release:k:never".into(), ..first.clone() };
    let outcome = within("a release on the older map", workers.release(&never, true).outcome()).await;
    assert!(matches!(&outcome, ReleaseOutcome::Superseded(why) if why.contains("no longer holds")), "{outcome:?}");
    let kept = within("the kept maps", WorkerStore::worker_maps(&workers)).await.expect("the maps");
    assert_eq!(kept, [("k".to_owned(), row("newer"))], "the newer map stands");

    // The row is removed and the session kept again under the same id: another row, with another identity.
    WorkerStore::keep(&workers, "k", None);
    WorkerStore::keep(&workers, "k", Some(row("kept")));
    within("the row kept again", workers.settled()).await.expect("stored");
    let second = WorkerStore::bound(&workers, "k").expect("the new row is named");
    assert_ne!(second.incarnation, first.incarnation, "the id is reused, the identity is not");
    let outcome = within("the first row's release", workers.release(&first, true).outcome()).await;
    assert!(matches!(&outcome, ReleaseOutcome::Superseded(why) if why.contains("not the one")), "{outcome:?}");
    let kept = within("the kept maps", WorkerStore::worker_maps(&workers)).await.expect("the maps");
    assert_eq!(kept, [("k".to_owned(), row("kept"))], "nothing of the first row's release was written to the second");
}
