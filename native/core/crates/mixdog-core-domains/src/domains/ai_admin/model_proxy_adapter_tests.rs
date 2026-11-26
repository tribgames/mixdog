//! The server's stand-in for a PC provider, attempt by attempt: over the PC end of the model proxy (the real runner and
//! broker on a scripted provider) or over a link that answers as a missing or vanishing PC.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use mixdog_ai::broker::{ModelProxyTransport, ProxyError};
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::mock::{MockAttempt, MockProvider};
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::domain::provider::ProviderAdapter as _;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::ProxiedAdapter;
use crate::domains::ai_admin::model_proxy::tests::{hi, loopback, loopback_on, rejected};

struct NoStore;

#[async_trait]
impl AttachmentReader for NoStore {
    async fn read(&self, _: &str) -> Result<Vec<u8>, ReadError> {
        Err(ReadError::Permanent)
    }
}

fn stand_in(pc: impl ModelProxyTransport + 'static) -> ProxiedAdapter {
    ProxiedAdapter::new("mock", w::ProxyTraits::default(), Arc::new(pc), Arc::new(NoStore))
}

/// Every event of the stream, and the failure it ended with.
async fn drain(mut stream: Box<dyn p::ModelStream>) -> (Vec<p::StreamEvent>, Option<p::ProviderError>) {
    let mut events = Vec::new();
    while let Some(next) = stream.next().await {
        match next {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
    }
    (events, None)
}

fn text(events: &[p::StreamEvent]) -> String {
    events.iter().filter_map(|e| if let p::StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect()
}

/// The PC's broker retried twice (a refusal, then a stream cut after its usage): this attempt is the answered one alone,
/// with nothing of the attempt the PC voided, as one send of the provider.
#[tokio::test(start_paused = true)]
async fn a_pc_retry_leaves_only_the_answered_attempt_in_the_stream() {
    let pc = loopback([rejected(503), MockAttempt::Body(b"u:10,5\n".to_vec()), MockAttempt::Body(b"t:hi\ndone\n".to_vec())]).await;
    let stream = stand_in(pc).attempt(Arc::new(hi())).await.expect("the call streams");
    let (events, failure) = drain(stream).await;
    assert!(failure.is_none(), "{failure:?}");
    assert_eq!(text(&events), "hi");
    assert!(!events.iter().any(|e| matches!(e, p::StreamEvent::Usage(u) if u.input_tokens == 10)), "the voided attempt's usage is gone: {events:?}");
    assert!(matches!(events.last(), Some(p::StreamEvent::Completed { .. })));
}

#[tokio::test(start_paused = true)]
async fn a_failure_the_pc_retried_out_is_final_here() {
    let provider = Arc::new(MockProvider::new((0..6).map(|_| rejected(503))));
    let pc = loopback_on(provider.clone()).await;
    let Err(error) = stand_in(pc).attempt(Arc::new(hi())).await else { panic!("the call failed before any stream opened") };
    assert_eq!(
        (error.status, error.should_retry, error.delivery, provider.attempts.load(Ordering::SeqCst)),
        (Some(503), Some(false), p::DeliveryState::Accepted, 5)
    );
}

/// The PC's ladder ended on repeated overload and named the model to send again with: this attempt's failure carries it, so
/// the session's loop resends with that model as Node's did.
#[tokio::test]
async fn a_fallback_the_pc_named_reaches_the_loop_with_its_model() {
    let mut overloaded = p::ProviderError::new(p::ErrorKind::Overloaded, p::DeliveryState::NotSent);
    overloaded.status = Some(529);
    let failure = crate::domains::ai_admin::model_proxy::failure_out(&overloaded, w::ProxyOutcome::Fallback { model: "other".into() });
    let link = pc(Vec::new(), Some(ProxyError::Remote(serde_json::to_value(failure).unwrap())));
    let Err(error) = stand_in(link).attempt(Arc::new(hi())).await else { panic!("the call failed") };
    assert_eq!((error.fallback_model.as_deref(), error.status, error.should_retry), (Some("other"), Some(529), Some(false)));
}

/// The link answers as Node's channel does with no PC, a PC that never takes the call, or one that leaves mid-call.
struct Pc {
    events: Vec<w::ProxyEvent>,
    then: Option<ProxyError>,
    calls: AtomicU32,
}

#[async_trait]
impl ModelProxyTransport for Pc {
    async fn execute(&self, _: Value, events: &mut (dyn FnMut(Value) + Send), cancel: &CancellationToken) -> Result<Value, ProxyError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        for event in &self.events {
            events(serde_json::to_value(event).unwrap());
        }
        match &self.then {
            Some(error) => Err(error.clone()),
            None => {
                cancel.cancelled().await;
                Err(ProxyError::Cancelled)
            }
        }
    }
}

fn pc(events: Vec<w::ProxyEvent>, then: Option<ProxyError>) -> Pc {
    let _ = mixdog_rt::testing::tokens();
    Pc { events, then, calls: AtomicU32::new(0) }
}

#[tokio::test]
async fn with_no_pc_the_attempt_fails_with_nodes_unavailable_text() {
    let text = "model proxy unavailable: no desktop client is connected to run model calls";
    let Err(error) = stand_in(pc(Vec::new(), Some(ProxyError::Unavailable(text.into())))).attempt(Arc::new(hi())).await else { panic!("no PC answered") };
    assert_eq!((error.message.as_str(), error.should_retry), (text, Some(false)));
}

/// The link went after the PC streamed: what it showed stays shown, and the attempt ends on the PC's leaving.
#[tokio::test]
async fn a_pc_that_leaves_mid_call_ends_the_attempt_with_its_leaving() {
    let link = pc(vec![w::ProxyEvent::TextDelta { text: "par".into() }], Some(ProxyError::Cancelled));
    let stream = stand_in(link).attempt(Arc::new(hi())).await.expect("the call streamed");
    let (events, failure) = drain(stream).await;
    assert_eq!(text(&events), "par");
    let failure = failure.expect("the attempt failed");
    assert_eq!((failure.message.as_str(), failure.should_retry), ("model proxy unavailable: the desktop client disconnected", Some(false)));
}

/// Dropping the stream (the turn was stopped) gives the PC's call up.
#[tokio::test]
async fn dropping_the_stream_gives_the_call_up() {
    struct Watched(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl ModelProxyTransport for Watched {
        async fn execute(&self, _: Value, events: &mut (dyn FnMut(Value) + Send), cancel: &CancellationToken) -> Result<Value, ProxyError> {
            events(serde_json::to_value(w::ProxyEvent::TextDelta { text: "x".into() }).unwrap());
            cancel.cancelled().await;
            self.0.notify_one();
            Err(ProxyError::Cancelled)
        }
    }
    let _ = mixdog_rt::testing::tokens();
    let given_up = Arc::new(tokio::sync::Notify::new());
    let stream = stand_in(Watched(given_up.clone())).attempt(Arc::new(hi())).await.expect("the call streams");
    drop(stream);
    tokio::time::timeout(std::time::Duration::from_secs(5), given_up.notified()).await.expect("the call was given up");
}

/// A model the PC routes on no wire of its own is asked once (`#noWireRoute`).
#[tokio::test]
async fn a_single_wire_model_is_asked_its_route_once() {
    let link = Arc::new(pc(Vec::new(), None));
    struct Answering(Arc<Pc>);
    #[async_trait]
    impl ModelProxyTransport for Answering {
        async fn execute(&self, _: Value, _: &mut (dyn FnMut(Value) + Send), _: &CancellationToken) -> Result<Value, ProxyError> {
            self.0.calls.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::to_value(w::ProxyAnswer::Route { route: None }).unwrap())
        }
    }
    let adapter = stand_in(Answering(link.clone()));
    let routing = adapter.wire_routing().expect("the PC routes");
    for _ in 0..2 {
        assert_eq!(routing.resolve_wire_route("m", &p::WireRouteContext::default()).await.unwrap(), None);
    }
    assert_eq!(link.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn proxied_adapter_resolves_vision_policy_from_pc_traits() {
    let vision = stand_in(pc(Vec::new(), None));
    assert!(mixdog_image_egress::route::resolve(&vision.image_route(&hi()).await).policy().vision);

    let text_only = ProxiedAdapter::new(
        "mixdog-local",
        w::ProxyTraits { takes_images: Some(false), ..Default::default() },
        Arc::new(pc(Vec::new(), None)),
        Arc::new(NoStore),
    );
    assert!(!mixdog_image_egress::route::resolve(&text_only.image_route(&hi()).await).policy().vision);
}
