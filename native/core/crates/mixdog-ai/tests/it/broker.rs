use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::Lane;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::admission::RunLiveness;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::ModelProxyTransport;
use mixdog_ai::broker::ProxyError;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::broker::execute_via_proxy;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Sink {
    events: Vec<StreamEvent>,
    discards: u32,
    abandoned: Vec<(u64, u64, Option<String>)>,
}

impl AttemptSink for Sink {
    fn event(&mut self, event: StreamEvent) {
        self.events.push(event);
    }
    fn discard(&mut self) {
        self.discards += 1;
        self.events.clear();
    }
    fn abandoned(&mut self, usage: &Usage, model: Option<&str>) {
        self.abandoned.push((usage.input_tokens, usage.output_tokens, model.map(str::to_owned)));
    }
}

fn rejected(status: u16) -> MockAttempt {
    MockAttempt::Rejected(ErrorResponse {
        status: Some(status),
        headers: Vec::new(),
        body: Vec::new(),
    })
}

fn setup() -> (ModelBroker, SendRequest) {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new("mock".into(), "default"), LaneSettings::default());
    let request = Arc::new(ModelRequest {
        model: "m".into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: Vec::new(),
        options: RequestOptions::default(),
    });
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    (
        broker,
        SendRequest {
            request,
            lane,
            admission: AdmissionRequest::default(),
        },
    )
}

#[tokio::test(start_paused = true)]
async fn retries_through_failures_and_discards_each_failed_attempt() {
    let (broker, send) = setup();
    let provider = MockProvider::new([
        rejected(503),
        MockAttempt::Fault {
            fault: TransportFault::Reset,
            reached: DeliveryState::Ambiguous,
        },
        MockAttempt::Body(b"t:hi\ndone\n".to_vec()),
    ]);
    let mut sink = Sink::default();
    let attempts = broker
        .send(&provider, send, &mut sink, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(attempts, 3);
    assert_eq!(sink.discards, 2);
    assert!(matches!(sink.events.last(), Some(StreamEvent::Completed { .. })));
    assert_eq!(provider.attempts.load(Ordering::Relaxed), 3);
}

#[tokio::test(start_paused = true)]
async fn a_retried_attempt_that_reported_usage_is_handed_to_the_sink_once() {
    let (broker, send) = setup();
    let provider = MockProvider::new([
        MockAttempt::Body(b"u:10,5\n".to_vec()),
        MockAttempt::Body(b"t:hi\ndone\n".to_vec()),
    ]);
    let mut sink = Sink::default();
    let attempts = broker.send(&provider, send, &mut sink, &CancellationToken::new()).await.unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(sink.abandoned, vec![(10, 5, None)]);
}

#[tokio::test(start_paused = true)]
async fn deterministic_refusal_surfaces_after_one_attempt() {
    let (broker, send) = setup();
    let provider = MockProvider::new([rejected(401)]);
    let err = broker
        .send(&provider, send, &mut Sink::default(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(err, SendError::Provider(e) if e.status == Some(401)));
    assert_eq!(provider.attempts.load(Ordering::Relaxed), 1);
}

#[tokio::test(start_paused = true)]
async fn spent_row_is_exhausted() {
    let (broker, send) = setup();
    // Empty script: every attempt fails to connect.
    let provider = MockProvider::new([]);
    let err = broker
        .send(&provider, send, &mut Sink::default(), &CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(err, SendError::Exhausted(_)));
    assert_eq!(provider.attempts.load(Ordering::Relaxed), 5, "1 + 4 retries");
}

#[tokio::test(start_paused = true)]
async fn cancel_ends_the_retry_wait() {
    let (broker, send) = setup();
    let provider = MockProvider::new([rejected(503)]);
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(50)).await;
        stopper.cancel();
    });
    let err = broker
        .send(&provider, send, &mut Sink::default(), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, SendError::Cancelled));
}

/// A provider whose first attempt fails with `message`, its retry line worded as the OpenAI-compatible ladder's.
struct Refusing {
    inner: MockProvider,
    message: String,
}

#[async_trait]
impl ProviderAdapter for Refusing {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }

    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }

    fn retry_line(&self, _model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        Some(mixdog_core_api::domain::provider::RetryLine {
            tag: "[custom]".into(),
            delay: true,
            style: mixdog_core_api::domain::provider::RetryLineStyle::Attempt,
        })
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if self.inner.attempts.load(Ordering::Relaxed) == 0 {
            self.inner.attempts.fetch_add(1, Ordering::Relaxed);
            let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Overloaded, DeliveryState::Accepted);
            error.status = Some(503);
            error.message = self.message.clone();
            return Err(error);
        }
        self.inner.attempt(request).await
    }
}

/// The line written before a retry carries the server's text: a credential the process holds is redacted from it.
#[tokio::test(start_paused = true)]
async fn the_retry_line_redacts_a_credential_the_refusal_echoes() {
    let (broker, send) = setup();
    mixdog_ai::oauth::carried::keep("config the-retry-line-test", &["retry-line-key-3f9a71c2"]);
    let provider = Refusing {
        inner: MockProvider::new([MockAttempt::Body(b"t:hi\ndone\n".to_vec())]),
        message: "upstream 503: key retry-line-key-3f9a71c2 is overloaded".into(),
    };
    let (lines, _capture) = mixdog_rt::node_log::capture();
    broker.send(&provider, send, &mut Sink::default(), &CancellationToken::new()).await.unwrap();
    let lines: Vec<String> = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].starts_with("[custom] retry attempt 2 after upstream 503: key [REDACTED] is overloaded"), "{}", lines[0]);
}

struct Echo;

#[async_trait]
impl ModelProxyTransport for Echo {
    async fn execute(
        &self,
        call: JsonValue,
        events: &mut (dyn FnMut(JsonValue) + Send),
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ProxyError> {
        if cancel.is_cancelled() {
            return Err(ProxyError::Cancelled);
        }
        events(call.clone());
        Ok(call)
    }
}

#[tokio::test]
async fn proxy_streams_events_and_never_runs_after_cancel() {
    let mut seen = Vec::new();
    let cancel = CancellationToken::new();
    let result = execute_via_proxy(&Echo, JsonValue::from(1), &mut |e| seen.push(e), &cancel)
        .await
        .unwrap();
    assert_eq!(result, JsonValue::from(1));
    assert_eq!(seen.len(), 1);
    cancel.cancel();
    assert_eq!(
        execute_via_proxy(&Echo, JsonValue::from(2), &mut |_| {}, &cancel).await,
        Err(ProxyError::Cancelled)
    );
}
/// A provider whose stream plays `script`, each event after its delay, and
/// then goes silent for good.
struct Scripted {
    inner: MockProvider,
    script: Mutex<Option<VecDeque<(Duration, StreamEvent)>>>,
}

struct ScriptedStream(VecDeque<(Duration, StreamEvent)>);

#[async_trait]
impl ModelStream for ScriptedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        let Some((after, event)) = self.0.pop_front() else {
            return std::future::pending().await;
        };
        mixdog_rt::time::sleep(after).await;
        Some(Ok(event))
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl ProviderAdapter for Scripted {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }

    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }

    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let script = self.script.lock().unwrap().take().expect("one attempt");
        Ok(Box::new(ScriptedStream(script)))
    }
}

const LEASE: Duration = Duration::from_secs(60);

struct Run {
    admission: Arc<Admission>,
    lane: Arc<Lane>,
    abort: CancellationToken,
    send: tokio::task::JoinHandle<Result<u32, SendError>>,
}

/// A send on a one-slot lane with a 60 s unattended lease, over a stream that
/// plays `script` and then says nothing.
fn start(attended: bool, script: Vec<(Duration, StreamEvent)>) -> Run {
    mixdog_rt::testing::tokens();
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(
        &LaneKey::new("mock".into(), "default"),
        LaneSettings {
            concurrency: Some(1),
            unattended_lease: Some(LEASE),
            ..LaneSettings::default()
        },
    );
    let broker = ModelBroker::new(admission.clone(), Arc::new(StandardRetryDecider));
    let request = SendRequest {
        request: Arc::new(ModelRequest {
            model: "m".into(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        }),
        lane: lane.clone(),
        admission: AdmissionRequest {
            liveness: Some(RunLiveness::new(attended)),
            ..AdmissionRequest::default()
        },
    };
    let provider = Scripted {
        inner: MockProvider::new([]),
        script: Mutex::new(Some(script.into())),
    };
    let abort = CancellationToken::new();
    let send = {
        let abort = abort.clone();
        tokio::spawn(async move { broker.send(&provider, request, &mut Sink::default(), &abort).await })
    };
    Run { admission, lane, abort, send }
}

/// Moves paused time forward one second at a time, letting every task it woke
/// run, so an event due mid-way sees the time it was due.
async fn settle(total: Duration) {
    let mut left = total;
    loop {
        let step = left.min(Duration::from_secs(1));
        tokio::time::advance(step).await;
        left -= step;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        if left.is_zero() {
            break;
        }
    }
}

fn held(admission: &Admission) -> usize {
    admission.snapshot()[0].active
}

fn keepalives() -> Vec<(Duration, StreamEvent)> {
    (0..5).map(|_| (Duration::from_secs(10), StreamEvent::ProviderKeepalive)).collect()
}

#[tokio::test(start_paused = true)]
async fn a_silent_unattended_send_returns_its_permit_and_stays_abortable() {
    let run = start(false, keepalives());
    settle(Duration::ZERO).await;
    assert_eq!(held(&run.admission), 1);
    // Keepalives at 10..50 s are not progress.
    settle(LEASE - Duration::from_secs(1)).await;
    assert_eq!(held(&run.admission), 1);
    settle(Duration::from_secs(1)).await;
    assert_eq!(held(&run.admission), 0);
    let other = run
        .admission
        .acquire(&run.lane, AdmissionRequest::default(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(!run.send.is_finished(), "the silent run is still alive");
    run.abort.cancel();
    assert!(matches!(run.send.await.unwrap(), Err(SendError::Cancelled)));
    assert_eq!(held(&run.admission), 1, "its end returned nothing a second time");
    drop(other);
}

#[tokio::test(start_paused = true)]
async fn a_silent_attended_send_keeps_its_permit() {
    let run = start(true, keepalives());
    settle(Duration::ZERO).await;
    settle(LEASE * 10).await;
    assert_eq!(held(&run.admission), 1);
    assert!(!run.send.is_finished());
    run.abort.cancel();
    assert!(matches!(run.send.await.unwrap(), Err(SendError::Cancelled)));
    assert_eq!(held(&run.admission), 0);
}

#[tokio::test(start_paused = true)]
async fn content_moves_the_lease_of_an_unattended_send() {
    let run = start(false, vec![(Duration::from_secs(40), StreamEvent::TextDelta("x".into()))]);
    settle(Duration::ZERO).await;
    settle(Duration::from_secs(99)).await;
    assert_eq!(held(&run.admission), 1, "99 s in, 59 s after the text");
    settle(Duration::from_secs(1)).await;
    assert_eq!(held(&run.admission), 0, "60 s after the text");
}
/// A provider whose first stream shows one event and then dies with `message`; its spent send is re-issued as `recovered`.
struct Dying {
    inner: MockProvider,
    message: String,
}

struct DyingStream {
    shown: bool,
    message: String,
}

#[async_trait]
impl ModelStream for DyingStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        if !self.shown {
            self.shown = true;
            return Some(Ok(StreamEvent::ProviderKeepalive));
        }
        let mut error = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Auth, DeliveryState::Accepted);
        error.message = self.message.clone();
        Some(Err(error))
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

#[async_trait]
impl ProviderAdapter for Dying {
    fn id(&self) -> &ProviderId {
        self.inner.id()
    }

    fn codec(&self) -> &dyn WireCodec {
        self.inner.codec()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.inner.retry_policy()
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        self.inner.keepalive()
    }

    fn recovers_spent(&self, _model: &str, _failure: &ProviderError) -> bool {
        true
    }

    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.inner.attempt(request).await
    }

    async fn attempt(&self, _request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Ok(Box::new(DyingStream { shown: false, message: self.message.clone() }))
    }
}

/// The line written after a dead stream is re-issued names the stream's failure, which repeats what the endpoint answered: a
/// credential the process holds is redacted from it.
#[tokio::test(start_paused = true)]
async fn the_recovery_line_redacts_a_credential_the_dead_stream_echoes() {
    let (broker, send) = setup();
    mixdog_ai::oauth::carried::keep("config the-recovery-line-test", &["recovery-line-key-9b27e0d4"]);
    let provider = Dying {
        inner: MockProvider::new([MockAttempt::Body(b"t:hi\ndone\n".to_vec())]),
        message: "upstream: key recovery-line-key-9b27e0d4 is overloaded".into(),
    };
    let (lines, _capture) = mixdog_rt::node_log::capture();
    broker.send(&provider, send, &mut Sink::default(), &CancellationToken::new()).await.unwrap();
    let lines: Vec<String> = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
    assert_eq!(lines, ["[gemini] stream failed (upstream: key [REDACTED] is overloaded); recovered via non-streaming generateContent"]);
}
