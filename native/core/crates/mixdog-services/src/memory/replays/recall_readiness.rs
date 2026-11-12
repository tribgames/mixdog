//! Replay of `native/core/fixtures/memory-recall-readiness` (recall-embedding-readiness.test.mjs, 5 cases + 9 further shapes) against
//! `embed_recall_query` (`memory/recall/readiness.rs`), the core's `embedRecallQuery`: the product's recall reaches it through
//! `RecallEmbedder::query_vector` (`boot.rs`, `Recall::search_by_query`). The embedder is scripted as the recorder's was (`ColdEmbed`: every
//! call logged where Node's endpoint logged it); the request signal is a `CancellationToken` with the recorded reason; the wait's timer is
//! observed through `TIMER_SEAM` (armed delay, cleared; it fires when the replay moves the paused clock by the recorded delay). Each scenario's
//! result, error identity, calls, ordered trace and timer summary are compared whole.
//!
//! The driver performs the recorder's steps at their recorded places. Node's microtask turns are the core future's polls: a step the recorder
//! took after its `call(…)` returned is taken after the first poll; `fireTimer`'s `await armedSignal` lets pending work run, which is a second poll.

use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_testkit::Exact;
use tokio_util::sync::CancellationToken;

use crate::memory::embed::config::InputType;
use crate::memory::recall::readiness::{ColdEmbed, EmbedRequest, RecallEmbedding, TIMER_SEAM, TimerEvent, embed_recall_query};
use crate::memory::replays::{case, golden, object, same, string};

const SET: &str = "memory-recall-readiness";
const DEADLINE: Duration = Duration::from_secs(30);

type Error = Arc<Exact>;
type Trace = Arc<Mutex<Vec<Exact>>>;

enum Warmup {
    Resolves,
    Rejects(Error),
    Never,
    Gate(Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), Error>>>>),
}

struct Scripted {
    ready: bool,
    can_warmup: bool,
    warmup: Warmup,
    vector: Vec<f32>,
    trace: Trace,
    calls: Arc<Mutex<Vec<Exact>>>,
    warmup_error_seen: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    settled_signal: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    warmup_settled: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl Scripted {
    fn note(&self, call: Exact) {
        self.calls.lock().unwrap().push(call.clone());
        self.trace.lock().unwrap().push(object(vec![("event", string("product call")), ("call", call)]));
    }
}

fn error_value(error: &Error) -> Exact {
    (**error).clone()
}

#[async_trait]
impl ColdEmbed for Scripted {
    type Error = Error;

    fn is_ready(&self) -> bool {
        self.note(string("isReady"));
        self.ready
    }

    fn can_warmup(&self) -> bool {
        self.note(string("canWarmup"));
        self.can_warmup
    }

    fn warmup(&self) -> BoxFuture<'static, Result<(), Error>> {
        self.note(string("warmup"));
        let trace = self.trace.clone();
        let signal = self.settled_signal.lock().unwrap().take();
        let outcome: BoxFuture<'static, Result<(), Error>> = match &self.warmup {
            Warmup::Resolves => Box::pin(async { Ok(()) }),
            Warmup::Rejects(error) => {
                let error = error.clone();
                Box::pin(async move { Err(error) })
            }
            Warmup::Never => Box::pin(std::future::pending()),
            Warmup::Gate(gate) => {
                let gate = gate.lock().unwrap().take().expect("the warmup is called once");
                Box::pin(async move { gate.await.expect("the gate is settled") })
            }
        };
        Box::pin(async move {
            let settled = outcome.await;
            trace.lock().unwrap().push(match &settled {
                Ok(()) => object(vec![("event", string("warmup settled"))]),
                Err(error) => object(vec![("event", string("warmup rejected")), ("error", error_value(error))]),
            });
            if let Some(signal) = signal {
                let _ = signal.send(());
            }
            settled
        })
    }

    async fn embed(&self, text: &str, request: EmbedRequest) -> Result<Vec<f32>, Error> {
        let input_type = match request.input_type {
            InputType::Query => "query",
            InputType::Document => "document",
        };
        self.note(Exact::Array(vec![
            string("embed"),
            string(text),
            object(vec![("priority", Exact::Bool(request.priority)), ("inputType", string(input_type))]),
        ]));
        Ok(self.vector.clone())
    }

    fn on_warmup_error(&self, error: &Error) {
        self.note(Exact::Array(vec![string("onWarmupError"), error_value(error)]));
        if let Some(seen) = self.warmup_error_seen.lock().unwrap().take() {
            let _ = seen.send(());
        }
    }
}

/// How the recorder drove a scenario (`record-memory-recall-readiness.mjs:73-110`).
enum Drive {
    /// `settled(call({ waitMs }))`.
    Call,
    /// The signal is aborted after the call returned (case 4).
    AbortAfterCall,
    /// The signal is aborted before the call.
    AbortBefore,
    /// The timer is fired, the recall settles, then the warmup gate settles (`Ok` resolves, `Err` rejects).
    FireThenSettle(tokio::sync::oneshot::Sender<Result<(), Error>>),
    /// The warmup gate is released after the call returned.
    ReleaseAfterCall(tokio::sync::oneshot::Sender<Result<(), Error>>),
}

struct Scenario<'a> {
    recorded: &'a Exact,
    wait: Duration,
    drive: Drive,
    embedder: Arc<Scripted>,
    /// The injected error a result's or rejection's identity is checked against.
    reference: Option<Error>,
    /// The signal's recorded reason (`None`: aborted without one).
    reason: Option<Error>,
    late_failure: Option<tokio::sync::oneshot::Receiver<()>>,
}

fn vector(g: &Exact) -> Vec<f32> {
    g.get("vector").as_array().iter().map(|n| n.as_f64() as f32).collect()
}

fn vector_value(v: &[f32]) -> Exact {
    Exact::Array(v.iter().map(|n| Exact::from(f64::from(*n))).collect())
}

/// The scenario's step texts in recorded order (the driver's actions, taken where the recorder took them).
fn steps(recorded: &Exact) -> Vec<String> {
    recorded.get("trace").as_array().iter().filter_map(|entry| entry.try_get("step").map(|s| s.as_str().to_owned())).collect()
}

fn scenario<'a>(g: &Exact, recorded: &'a Exact, ready: bool, can_warmup: bool, warmup: Warmup, wait_ms: Option<u64>, drive: Drive) -> Scenario<'a> {
    let (seen, late_failure) = tokio::sync::oneshot::channel();
    let (settled_signal, warmup_settled) = tokio::sync::oneshot::channel();
    let embedder = Arc::new(Scripted {
        settled_signal: Mutex::new(Some(settled_signal)),
        warmup_settled: Mutex::new(Some(warmup_settled)),
        ready,
        can_warmup,
        warmup,
        vector: vector(g),
        trace: Arc::default(),
        calls: Arc::default(),
        warmup_error_seen: Mutex::new(Some(seen)),
    });
    let wait = wait_ms.map_or_else(crate::memory::recall::readiness::cold_embed_wait, Duration::from_millis);
    Scenario { recorded, wait, drive, embedder, reference: None, reason: None, late_failure: Some(late_failure) }
}

fn result_value(result: &RecallEmbedding<Error>) -> Exact {
    let (vector, state, error) = match result {
        RecallEmbedding::Ready(v) => (vector_value(v), "ready", None),
        RecallEmbedding::Warmed(v) => (vector_value(v), "warmed", None),
        RecallEmbedding::Empty => (Exact::Null, "empty", None),
        RecallEmbedding::Unavailable => (Exact::Null, "unavailable", None),
        RecallEmbedding::Timeout => (Exact::Null, "timeout", None),
        RecallEmbedding::Failed(e) => (Exact::Null, "failed", Some(error_value(e))),
    };
    let mut entries = vec![("vector", vector), ("state", string(state))];
    if let Some(error) = error {
        entries.push(("error", error));
    }
    object(entries)
}

async fn run(name: &str, mut s: Scenario<'_>) {
    // The wait's deadline is the core ticker's, which runs on an installed backend.
    mixdog_rt::testing::tokens();
    let timers: Rc<std::cell::RefCell<Vec<(u64, bool, bool)>>> = Rc::default();
    {
        let (timers, trace) = (timers.clone(), s.embedder.trace.clone());
        let seam: Rc<dyn Fn(TimerEvent)> = Rc::new(move |event| {
            let mut timers = timers.borrow_mut();
            let index = timers.len().saturating_sub(1);
            match event {
                TimerEvent::Armed(delay) => {
                    let delay = delay.as_millis() as u64;
                    trace.lock().unwrap().push(object(vec![("event", string("timer armed")), ("timer", Exact::from(timers.len() as f64)), ("delay", Exact::from(delay as f64))]));
                    timers.push((delay, false, false));
                }
                TimerEvent::Cleared => {
                    timers[index].1 = true;
                    trace.lock().unwrap().push(object(vec![("event", string("timer cleared")), ("timer", Exact::from(index as f64))]));
                }
                TimerEvent::Fired => timers[index].2 = true,
            }
        });
        TIMER_SEAM.with(|cell| *cell.borrow_mut() = Some(seam));
    }
    let trace = s.embedder.trace.clone();
    let step = |text: &str| trace.lock().unwrap().push(object(vec![("step", string(text))]));
    let recorded_steps = steps(s.recorded);
    let mut taken = recorded_steps.iter();
    let mut take = |what: &str| {
        let text = taken.next().unwrap_or_else(|| panic!("{name}: the recording has no step for {what}"));
        step(text);
    };
    let cancel = CancellationToken::new();
    let query = match s.recorded.get("query") {
        Exact::Null | Exact::Undefined => None,
        q => Some(q.as_str().to_owned()),
    };
    let reason = s.reason.clone();
    let abort_reason = move || reason.clone().expect("the scenario aborts with the recorded reason");
    if matches!(s.drive, Drive::AbortBefore) {
        take("the abort before the call");
        cancel.cancel();
    }
    let embedder = s.embedder.clone();
    let call = embed_recall_query(&embedder, query.as_deref(), s.wait, &cancel, abort_reason);
    tokio::pin!(call);
    let mut gate = None;
    let outcome = match std::mem::replace(&mut s.drive, Drive::Call) {
        Drive::Call | Drive::AbortBefore => tokio::time::timeout(DEADLINE, &mut call).await,
        Drive::AbortAfterCall => {
            assert!(futures::poll!(&mut call).is_pending(), "{name}: the call settled before its abort");
            take("the abort");
            cancel.cancel();
            tokio::time::timeout(DEADLINE, &mut call).await
        }
        Drive::ReleaseAfterCall(release) => {
            assert!(futures::poll!(&mut call).is_pending(), "{name}: the call settled before the release");
            take("the release");
            release.send(Ok(())).expect("the gate is held");
            tokio::time::timeout(DEADLINE, &mut call).await
        }
        Drive::FireThenSettle(release) => {
            assert!(futures::poll!(&mut call).is_pending(), "{name}: the call settled before the timer");
            assert!(futures::poll!(&mut call).is_pending(), "{name}: the call settled before the timer");
            take("the timer");
            tokio::time::advance(s.wait).await;
            let out = tokio::time::timeout(DEADLINE, &mut call).await;
            gate = Some(release);
            out
        }
    };
    let outcome = outcome.unwrap_or_else(|_| panic!("{name}: the recall did not settle within {DEADLINE:?}"));
    let settled = match &outcome {
        Ok(result) => object(vec![("event", string("recall call settled")), ("result", result_value(result))]),
        Err(error) => object(vec![("event", string("recall call rejected")), ("error", error_value(error))]),
    };
    trace.lock().unwrap().push(settled);
    if let Some(release) = gate {
        let late = s.reference.clone();
        take("the warmup gate");
        match late {
            Some(failure) => {
                release.send(Err(failure)).expect("the gate is held");
                let seen = s.late_failure.take().expect("the late failure's signal");
                tokio::time::timeout(DEADLINE, seen).await.unwrap_or_else(|_| panic!("{name}: the late warmup failure was not reported within {DEADLINE:?}")).expect("seen");
            }
            None => {
                release.send(Ok(())).expect("the gate is held");
                // The warmup settles in its own task.
                let settled = s.embedder.warmup_settled.lock().unwrap().take().expect("the warmup's settle signal");
                tokio::time::timeout(DEADLINE, settled).await.unwrap_or_else(|_| panic!("{name}: the background warmup did not settle within {DEADLINE:?}")).expect("settled");
            }
        }
    }
    TIMER_SEAM.with(|cell| *cell.borrow_mut() = None);
    assert!(taken.next().is_none(), "{name}: a recorded step was not taken");

    let mut actual = vec![("label", s.recorded.get("label").clone()), ("query", s.recorded.get("query").clone())];
    // The recorded label and query are the scenario's inputs; what follows is the core's.
    match &outcome {
        Ok(result) => {
            actual.push(("result", result_value(result)));
            if let RecallEmbedding::Failed(error) = result {
                actual.push(("errorIsTheInjectedObject", s.reference.as_ref().map_or(Exact::Null, |r| Exact::Bool(Arc::ptr_eq(r, error)))));
            }
        }
        Err(error) => {
            actual.push(("rejected", error_value(error)));
            actual.push(("rejectedWithTheInjectedReason", s.reference.as_ref().map_or(Exact::Null, |r| Exact::Bool(Arc::ptr_eq(r, error)))));
        }
    }
    actual.push(("trace", Exact::Array(trace.lock().unwrap().clone())));
    actual.push(("calls", Exact::Array(s.embedder.calls.lock().unwrap().clone())));
    let timers = timers
        .borrow()
        .iter()
        .map(|(armed, cleared, fired)| object(vec![("armed", Exact::from(*armed as f64)), ("cleared", Exact::Bool(*cleared)), ("fired", Exact::Bool(*fired))]))
        .collect();
    actual.push(("timers", Exact::Array(timers)));
    same(name, s.recorded, &object(actual));
}

/// The injected error the recorder threw (the recorded `result.error`, `rejected` or late `warmup rejected` error): an input of the scenario.
fn injected(recorded: &Exact) -> Error {
    if let Some(result) = recorded.try_get("result")
        && let Some(error) = result.try_get("error")
    {
        return Arc::new(error.clone());
    }
    if let Some(rejected) = recorded.try_get("rejected") {
        return Arc::new(rejected.clone());
    }
    let late = recorded.get("trace").as_array().iter().find(|e| e.try_get("event").is_some_and(|e| e.as_str() == "warmup rejected"));
    Arc::new(late.expect("the scenario has an injected error").get("error").clone())
}

fn gate() -> (tokio::sync::oneshot::Sender<Result<(), Error>>, Warmup) {
    let (send, receive) = tokio::sync::oneshot::channel();
    (send, Warmup::Gate(Mutex::new(Some(receive))))
}

fn scenario_of(g: &Exact, index: usize, name: &str) -> &'static Exact {
    let recorded = case(g, index, name).get("scenario").clone();
    Box::leak(Box::new(recorded))
}

fn further(g: &Exact, label: &str) -> &'static Exact {
    let all = case(g, 5, "further shapes (beyond the test file)").get("scenarios").as_array();
    let found = all.iter().find(|s| s.get("label").as_str() == label).unwrap_or_else(|| panic!("no further shape {label:?}"));
    Box::leak(Box::new(found.clone()))
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_recording_has_five_cases_and_nine_further_shapes() {
    let g = golden(SET);
    crate::memory::replays::assert_case_count(&g, 6);
    assert_eq!(case(&g, 5, "further shapes (beyond the test file)").get("scenarios").as_array().len(), 9, "further shapes");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn ready_recall_embeds_immediately_as_a_query() {
    let g = golden(SET);
    let r = scenario_of(&g, 0, "ready recall embeds immediately as a query (test line 8)");
    run("case 1", scenario(&g, r, true, false, Warmup::Rejects(Arc::new(Exact::Null)), None, Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_waits_for_warmup_and_keeps_dense_retrieval() {
    let g = golden(SET);
    let r = scenario_of(&g, 1, "cold recall waits for warmup and keeps dense retrieval in the same request (test line 31)");
    run("case 2", scenario(&g, r, false, true, Warmup::Resolves, Some(50), Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_reports_warmup_failure_and_preserves_lexical_fallback() {
    let g = golden(SET);
    let r = scenario_of(&g, 2, "cold recall reports warmup failure and preserves lexical fallback (test line 70)");
    let failure = injected(r);
    let mut s = scenario(&g, r, false, true, Warmup::Rejects(failure.clone()), Some(50), Drive::Call);
    s.reference = Some(failure);
    run("case 3", s).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_aborts_without_waiting_for_the_timeout() {
    let g = golden(SET);
    let r = scenario_of(&g, 3, "cold recall aborts without waiting for the timeout (test line 90)");
    let reason = injected(r);
    let mut s = scenario(&g, r, false, true, Warmup::Never, Some(5_000), Drive::AbortAfterCall);
    (s.reference, s.reason) = (Some(reason.clone()), Some(reason));
    run("case 4", s).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_falls_back_after_the_bounded_wait_while_warmup_continues() {
    let g = golden(SET);
    let r = scenario_of(&g, 4, "cold recall falls back after the bounded wait while warmup continues (test line 47)");
    let (release, warmup) = gate();
    run("case 5", scenario(&g, r, false, true, warmup, Some(5), Drive::FireThenSettle(release))).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_times_out_then_the_warmup_fails_in_the_background() {
    let g = golden(SET);
    let r = further(&g, "cold recall times out, then the warmup fails in the background");
    let (release, warmup) = gate();
    let mut s = scenario(&g, r, false, true, warmup, Some(5), Drive::FireThenSettle(release));
    s.reference = Some(injected(r));
    // The late failure's identity is not part of the recorded result (the result is the timeout).
    run("further: late failure", s).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn empty_query() {
    let g = golden(SET);
    run("further: empty query", scenario(&g, further(&g, "empty query"), true, true, Warmup::Resolves, None, Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn null_ish_query_is_empty() {
    let g = golden(SET);
    run("further: null query", scenario(&g, further(&g, "null-ish query is empty"), true, true, Warmup::Resolves, None, Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn cold_recall_that_cannot_warm_up() {
    let g = golden(SET);
    let r = further(&g, "cold recall that cannot warm up");
    run("further: cannot warm", scenario(&g, r, false, false, Warmup::Rejects(Arc::new(Exact::Null)), Some(50), Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn signal_already_aborted_before_the_call() {
    let g = golden(SET);
    let r = further(&g, "signal already aborted before the call");
    let reason = injected(r);
    let mut s = scenario(&g, r, true, true, Warmup::Resolves, None, Drive::AbortBefore);
    (s.reference, s.reason) = (Some(reason.clone()), Some(reason));
    run("further: aborted early", s).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn signal_aborted_without_a_reason() {
    let g = golden(SET);
    let r = further(&g, "signal aborted without a reason");
    // The signal's reason is the platform's default (a DOMException in Node): the replay's signal carries the recorded one; no identity reference.
    let mut s = scenario(&g, r, false, true, Warmup::Resolves, None, Drive::AbortBefore);
    s.reason = Some(injected(r));
    run("further: aborted bare", s).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn zero_wait_with_an_already_resolved_warmup() {
    let g = golden(SET);
    let r = further(&g, "zero wait with an already-resolved warmup");
    run("further: zero wait", scenario(&g, r, false, true, Warmup::Resolves, Some(0), Drive::Call)).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn warmup_completes_after_a_deferred_release_before_the_wait() {
    let g = golden(SET);
    let r = further(&g, "warmup completes after a deferred release, before the wait");
    let (release, warmup) = gate();
    run("further: deferred warmup", scenario(&g, r, false, true, warmup, Some(60_000), Drive::ReleaseAfterCall(release))).await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn query_is_trimmed_before_embedding() {
    let g = golden(SET);
    let r = further(&g, "query is trimmed before embedding");
    run("further: trimmed", scenario(&g, r, true, false, Warmup::Resolves, None, Drive::Call)).await;
}
