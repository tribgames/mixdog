//! The model-exchange driver over fake transports on a paused clock: it is the only place a phase deadline is enforced, so
//! these run the production driver and nothing else decides when a phase expires.

use std::sync::Arc;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Boundary;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::WireRequest;
use tokio::time::Instant;

use super::deadlines::MODEL_STREAM;
use super::link::Exchange;
use super::link::HttpResponse;
use super::link::HttpSend;
use super::model_driver::Classify;
use super::model_driver::ModelCall;
use super::model_driver::ModelDriver;
use crate::providers::idle::testing::Timetable;

fn wire() -> WireRequest {
    WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: "http://x.test/".into(), headers: vec![], body: vec![] }
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

/// A transport that answers its head after `head_after` with a body that delivers `chunks` and then stays silent; it counts
/// the requests it was given.
struct Script {
    head_after: Duration,
    chunks: Vec<(u64, &'static str)>,
    seen: AtomicU32,
}

impl Script {
    fn new(head_after: u64, chunks: &[(u64, &'static str)]) -> Arc<Self> {
        Arc::new(Self { head_after: secs(head_after), chunks: chunks.to_vec(), seen: AtomicU32::new(0) })
    }
}

#[async_trait]
impl HttpSend for Script {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.seen.fetch_add(1, Ordering::SeqCst);
        super::model_driver::connected();
        mixdog_rt::time::sleep(self.head_after).await;
        Ok(HttpResponse { status: 200, headers: vec![], body: Timetable::of(&self.chunks) })
    }

    fn reports_connection(&self) -> bool {
        true
    }
}

/// A call whose expiries read `<phase> <window ms>` and are counted: the number of classifications is the number of failures.
fn call(identity: &SendIdentity, windows: PhaseWindows) -> (ModelCall, Arc<AtomicU32>) {
    let counted = Arc::new(AtomicU32::new(0));
    let seen = counted.clone();
    let classify: Classify = Arc::new(move |expiry, delivery, _| {
        seen.fetch_add(1, Ordering::SeqCst);
        let mut err = ProviderError::new(ErrorKind::Transient, delivery);
        err.message = format!("{:?} {}", expiry.phase, expiry.window.as_millis());
        err.timed_out = true;
        err
    });
    (ModelCall::new(identity, windows, classify), counted)
}

/// An adapter's declared head window of 240 s is the window: an agent threshold of 120 s does not cut it, and it expires at 240.
#[tokio::test(start_paused = true)]
async fn a_declared_head_window_of_240_seconds_survives_120_and_expires_at_240() {
    let identity = SendIdentity::default();
    let (call, classified) = call(&identity, PhaseWindows { head: Some(secs(240)), ..PhaseWindows::default() });
    let driver = ModelDriver::new(Script::new(10_000, &[]));
    let began = Instant::now();
    let mut send = std::pin::pin!(driver.send(&call, wire(), MODEL_STREAM));
    tokio::select! {
        _ = mixdog_rt::time::sleep(secs(120)) => {}
        _ = &mut send => panic!("the head wait ended before its window"),
    }
    let ctx = identity.attempt_context();
    assert_eq!((ctx.phase, ctx.window), (AttemptPhase::Head, secs(240)), "the clock holds the declared window");
    let err = send.await.err().expect("the head never comes");
    assert_eq!(began.elapsed(), secs(240));
    assert_eq!((err.message.as_str(), classified.load(Ordering::SeqCst)), ("Head 240000", 1), "one failure, classified once");
}

/// Silence after a protocol payload is the first-output window (600 s with nothing declared), counted from the payload: later
/// payloads that carry no output do not renew it. One expiry, one failure, however often it is asked for.
#[tokio::test(start_paused = true)]
async fn metadata_then_silence_expires_at_the_first_output_window_and_more_metadata_does_not_renew_it() {
    let identity = SendIdentity::default();
    let (call, classified) = call(&identity, PhaseWindows { head: Some(secs(285)), ..PhaseWindows::default() });
    let driver = ModelDriver::new(Script::new(0, &[(0, "a"), (100, "b")]));
    let (response, attempt) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    let began = Instant::now();
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstProtocolPayload);
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstProtocolPayload);
    assert_eq!(identity.attempt_context().phase, AttemptPhase::FirstOutput);
    assert!(matches!(body.next().await, Some(Err(_))), "the silence ends the read");
    assert_eq!(began.elapsed(), secs(600), "from the first payload, whole, not renewed at 100 s");
    let first = body.expired(Default::default()).expect("the driver's expiry");
    let again = body.expired(Default::default()).expect("the same failure");
    assert_eq!((first.message.as_str(), again.message.as_str(), classified.load(Ordering::SeqCst)), ("FirstOutput 600000", "FirstOutput 600000", 1));
}

/// Semantic output starts the idle window and only later semantic output renews it.
#[tokio::test(start_paused = true)]
async fn idle_starts_at_semantic_output_and_is_renewed_only_by_semantic_progress() {
    let identity = SendIdentity::default();
    let windows = PhaseWindows { head: Some(secs(285)), idle: Some(secs(100)), ..PhaseWindows::default() };
    let (call, _) = call(&identity, windows);
    let driver = ModelDriver::new(Script::new(0, &[(0, "a"), (60, "b"), (30, "c")]));
    let (response, attempt) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstSemanticOutput);
    let began = Instant::now();
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstSemanticOutput);
    assert!(body.next().await.is_some());
    // A payload that is not semantic progress renews nothing: the window still runs from the output at 60 s.
    attempt.observe(Boundary::FirstProtocolPayload);
    assert!(matches!(body.next().await, Some(Err(_))));
    assert_eq!(began.elapsed(), secs(60 + 100), "idle runs from the last semantic progress");
}

/// The recovery's window is one generation total over head and body: a head that came early does not reset it.
#[tokio::test(start_paused = true)]
async fn a_recovery_survives_120_seconds_and_expires_at_its_total_even_if_the_head_came_early() {
    let identity = SendIdentity::default();
    let windows = PhaseWindows { head: Some(secs(60)), recovery: Some(secs(285)), ..PhaseWindows::default() };
    let (call, classified) = call(&identity, windows);
    let driver = ModelDriver::new(Script::new(5, &[]));
    let began = Instant::now();
    let (response, _) = driver.send(&call.recovery(), wire(), MODEL_STREAM).await.expect("the head came at 5 s");
    let mut body = response.body;
    {
        let mut read = std::pin::pin!(body.next());
        tokio::select! {
            _ = mixdog_rt::time::sleep(secs(120)) => {}
            _ = &mut read => panic!("the recovery ended before its total"),
        }
        assert!(matches!(read.await, Some(Err(_))));
    }
    assert_eq!(began.elapsed(), secs(285));
    assert_eq!(classified.load(Ordering::SeqCst), 0, "not classified until someone asks, then once");
    assert_eq!(body.expired(Default::default()).expect("the expiry").message, "Recovery 285000");
    assert_eq!(classified.load(Ordering::SeqCst), 1);
}

/// Every submission is its own attempt with a fresh identity and its whole window; an old handle changes nothing of its
/// successor; a request that is not a model attempt (`aux`) begins none.
#[tokio::test(start_paused = true)]
async fn each_submission_is_a_fresh_attempt_an_old_handle_changes_nothing_and_auxiliary_requests_begin_none() {
    let identity = SendIdentity::default();
    let (call, _) = call(&identity, PhaseWindows { head: Some(secs(100)), ..PhaseWindows::default() });
    let script = Script::new(0, &[]);
    let driver = ModelDriver::new(script.clone());
    let (_first_response, first) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    mixdog_rt::time::sleep(secs(40)).await;
    // The response is held: dropping it ends the attempt, which the last assertions of this test show on their own.
    let (second_response, second) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    assert_ne!(first.id(), second.id());
    let ctx = identity.attempt_context();
    assert_eq!((ctx.id, ctx.phase, ctx.window), (second.id(), AttemptPhase::Payload, secs(100)), "the whole window, fresh");
    let deadline = ctx.deadline;
    first.observe(Boundary::FirstProtocolPayload);
    first.observe(Boundary::AttemptFailed);
    let after = identity.attempt_context();
    assert_eq!((after.id, after.phase, after.deadline), (second.id(), AttemptPhase::Payload, deadline), "the old handle moved nothing");
    let started = |identity: &SendIdentity| identity.take_boundaries().into_iter().filter(|(_, b)| *b == Boundary::AttemptStarted).count();
    assert_eq!(started(&identity), 2);
    driver.aux().send(wire(), MODEL_STREAM).await.expect("answered");
    assert_eq!((started(&identity), identity.attempt_context().id), (0, second.id()), "an auxiliary request begins no attempt");
    assert_eq!(script.seen.load(Ordering::SeqCst), 3);
    // Letting go of the response ends the attempt: no finished attempt stays open in a phase.
    drop(second_response);
    assert_eq!((identity.attempt_context().id, identity.attempt_context().phase), (second.id(), AttemptPhase::Retired));
}

/// One step of a scripted body.
#[derive(Clone, Copy)]
enum Step {
    Chunk(&'static str),
    Fault,
    Eof,
    Pending,
}

/// A body that plays `steps` in order and counts every poll of it: the reads the driver passes on to the underlying body.
struct Played {
    steps: std::collections::VecDeque<Step>,
    polls: Arc<AtomicU32>,
}

#[async_trait]
impl super::link::BodyStream for Played {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        match self.steps.pop_front() {
            Some(Step::Chunk(chunk)) => Some(Ok(bytes::Bytes::from_static(chunk.as_bytes()))),
            Some(Step::Fault) => Some(Err(mixdog_core_api::domain::provider::TransportFault::Reset)),
            Some(Step::Eof) | None => None,
            Some(Step::Pending) => std::future::pending().await,
        }
    }
}

struct PlayedTransport {
    steps: Vec<Step>,
    polls: Arc<AtomicU32>,
}

#[async_trait]
impl HttpSend for PlayedTransport {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Played { steps: self.steps.iter().copied().collect(), polls: self.polls.clone() }) })
    }
}

/// What the attempt published about its end, after the body has been let go.
fn ends(identity: &SendIdentity) -> (usize, usize) {
    let published = identity.take_boundaries();
    let count = |boundary| published.iter().filter(|(_, b)| *b == boundary).count();
    (count(Boundary::AttemptFailed), count(Boundary::AttemptEnded))
}

/// A body whose deadline expired is terminal: its one error, then `None` for good with no further read of the underlying body; the
/// attempt retired when it terminated, before anyone asked for the expiry, whose one classification stays retrievable.
#[tokio::test(start_paused = true)]
async fn an_expired_body_yields_one_error_then_none_and_is_never_polled_again() {
    let identity = SendIdentity::default();
    let (call, classified) = call(&identity, PhaseWindows { head: Some(secs(285)), ..PhaseWindows::default() });
    let polls = Arc::new(AtomicU32::new(0));
    let driver = ModelDriver::new(Arc::new(PlayedTransport { steps: vec![Step::Chunk("a"), Step::Pending, Step::Chunk("late")], polls: polls.clone() }));
    let (response, attempt) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    assert!(matches!(body.next().await, Some(Ok(_))));
    attempt.observe(Boundary::FirstProtocolPayload);
    assert!(matches!(body.next().await, Some(Err(_))), "the first-output window expired");
    assert_eq!(identity.attempt_context().phase, AttemptPhase::Retired, "retired at termination, before expired() is asked");
    assert_eq!(classified.load(Ordering::SeqCst), 0);
    assert!(body.next().await.is_none() && body.next().await.is_none());
    assert_eq!(polls.load(Ordering::SeqCst), 2, "the chunk and the silent read, and no read after the expiry");
    let first = body.expired(Default::default()).expect("the expiry stays retrievable");
    assert_eq!((first.message.as_str(), body.expired(Default::default()).expect("again").message.as_str()), ("FirstOutput 600000", "FirstOutput 600000"));
    assert_eq!(classified.load(Ordering::SeqCst), 1, "classified once");
    drop(body);
    assert_eq!(ends(&identity), (1, 0), "retired exactly once");
}

/// A transport fault is terminal too: one error, then `None`, the underlying body left alone, the attempt retired once, and no
/// expiry to retrieve.
#[tokio::test(start_paused = true)]
async fn a_transport_error_yields_one_error_then_none_and_is_never_polled_again() {
    let identity = SendIdentity::default();
    let (call, classified) = call(&identity, PhaseWindows::default());
    let polls = Arc::new(AtomicU32::new(0));
    let driver = ModelDriver::new(Arc::new(PlayedTransport { steps: vec![Step::Chunk("a"), Step::Fault, Step::Chunk("late")], polls: polls.clone() }));
    let (response, _) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    assert!(matches!(body.next().await, Some(Ok(_))));
    assert!(matches!(body.next().await, Some(Err(mixdog_core_api::domain::provider::TransportFault::Reset))));
    assert_eq!(identity.attempt_context().phase, AttemptPhase::Retired);
    assert!(body.next().await.is_none() && body.next().await.is_none());
    assert_eq!(polls.load(Ordering::SeqCst), 2, "no read after the fault");
    assert!(body.expired(Default::default()).is_none(), "the wire's fault is no expiry");
    assert_eq!(classified.load(Ordering::SeqCst), 0);
    drop(body);
    assert_eq!(ends(&identity), (1, 0), "retired exactly once");
}

/// The provider's silence before its first output is one clock from the connection: a head that came late at 500 s leaves the
/// first-output wait only what is left of its window, so the unanswered request ends at 600 s, not 500 + 600.
#[tokio::test(start_paused = true)]
async fn a_late_head_leaves_the_first_output_wait_no_fresh_window() {
    let identity = SendIdentity::default();
    let (call, _) = call(&identity, PhaseWindows { head: Some(secs(600)), payload: Some(secs(600)), first_output: Some(secs(600)), ..PhaseWindows::default() });
    let driver = ModelDriver::new(Script::new(500, &[(0, "a")]));
    let began = Instant::now();
    let (response, attempt) = driver.send(&call, wire(), MODEL_STREAM).await.expect("the head came at 500 s");
    let mut body = response.body;
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstProtocolPayload);
    assert!(matches!(body.next().await, Some(Err(_))));
    assert_eq!(began.elapsed(), secs(600), "one silence window from the connection");
    assert_eq!(body.expired(Default::default()).expect("the expiry").message, "FirstOutput 600000");
}

/// Connecting is its own clock: a transport that never gets its connection fails as a connection timeout, unclassified as the
/// provider's silence and with nothing sent; once connected, the head window counts from the connection.
#[tokio::test(start_paused = true)]
async fn connecting_is_not_the_providers_silence() {
    struct Dialling;
    #[async_trait]
    impl HttpSend for Dialling {
        async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            std::future::pending().await
        }

        fn reports_connection(&self) -> bool {
            true
        }
    }
    let identity = SendIdentity::default();
    let (call, classified) = call(&identity, PhaseWindows { head: Some(secs(30)), ..PhaseWindows::default() });
    let err = ModelDriver::new(Arc::new(Dialling)).send(&call, wire(), MODEL_STREAM).await.err().expect("never connected");
    assert_eq!((err.code.as_deref(), err.delivery, classified.load(Ordering::SeqCst)), (Some("UND_ERR_CONNECT_TIMEOUT"), mixdog_core_api::domain::provider::DeliveryState::NotSent, 0));
    let published: Vec<Boundary> = identity.take_boundaries().into_iter().map(|(_, b)| b).collect();
    assert_eq!(published, [Boundary::AttemptStarted, Boundary::AttemptFailed], "no connection was reported");
}

/// The consumer's own work while it holds the stream unread is not the provider's silence: the idle deadline moves by it.
#[tokio::test(start_paused = true)]
async fn local_work_is_taken_off_the_providers_silence() {
    let identity = SendIdentity::default();
    let windows = PhaseWindows { head: Some(secs(285)), idle: Some(secs(100)), ..PhaseWindows::default() };
    let (call, _) = call(&identity, windows);
    // The second chunk comes 70 s after the read that follows the local work: 150 s after the output.
    let driver = ModelDriver::new(Script::new(0, &[(0, "a"), (70, "b")]));
    let (response, attempt) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    assert!(body.next().await.is_some());
    attempt.observe(Boundary::FirstSemanticOutput);
    {
        let _work = identity.local_work();
        mixdog_rt::time::sleep(secs(80)).await;
    }
    assert!(matches!(body.next().await, Some(Ok(_))), "80 s of local work plus 70 s of silence is within the 100 s idle window");
}

/// The end of the body is terminal: `None` for good, no further read, the attempt ended once.
#[tokio::test(start_paused = true)]
async fn the_end_of_a_body_is_terminal_and_is_never_polled_again() {
    let identity = SendIdentity::default();
    let (call, _) = call(&identity, PhaseWindows::default());
    let polls = Arc::new(AtomicU32::new(0));
    let driver = ModelDriver::new(Arc::new(PlayedTransport { steps: vec![Step::Chunk("a"), Step::Eof, Step::Chunk("late")], polls: polls.clone() }));
    let (response, _) = driver.send(&call, wire(), MODEL_STREAM).await.expect("answered");
    let mut body = response.body;
    assert!(matches!(body.next().await, Some(Ok(_))));
    assert!(body.next().await.is_none());
    assert_eq!(identity.attempt_context().phase, AttemptPhase::Retired);
    assert!(body.next().await.is_none() && body.next().await.is_none());
    assert_eq!(polls.load(Ordering::SeqCst), 2, "no read after the end");
    drop(body);
    assert_eq!(ends(&identity), (0, 1), "ended exactly once");
}