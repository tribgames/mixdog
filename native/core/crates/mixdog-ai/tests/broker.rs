use std::sync::Arc;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::ModelProxyTransport;
use mixdog_ai::broker::ProxyError;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::broker::execute_via_proxy;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_protocol::JsonValue;
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        stopper.cancel();
    });
    let err = broker
        .send(&provider, send, &mut Sink::default(), &cancel)
        .await
        .unwrap_err();
    assert!(matches!(err, SendError::Cancelled));
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