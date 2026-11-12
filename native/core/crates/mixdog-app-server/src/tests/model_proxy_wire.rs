//! The model proxy from the wire: `modelProxy/run` frames through the server's admission to the real `ModelProxyService` (over
//! the real `ProxyRunner` and broker), its events and answers coming back as frames. Replays `model-proxy-host-trust-cases`:
//! the recorded burst of sends is admitted whole and every one runs, and the recorded refusal of a call that would take the
//! data held past its bound has Node's status, code and words. Only the provider is scripted (it answers, or holds its first
//! call in flight).

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::admission::Admission;
use mixdog_ai::broker::ModelBroker;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::mock::MockAttempt;
use mixdog_core_api::domain::mock::MockProvider;
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::mock::MockHostChannel;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderConfigSource;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderLookup;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProxyRunner;
use mixdog_core_domains::domains::ai_admin::model_proxy::QuotaProbe;
use mixdog_core_domains::domains::ai_admin::model_proxy::WireRouter;
use mixdog_core_domains::domains::ai_admin::model_proxy::request_out;
use mixdog_core_domains::domains::ai_admin::model_proxy_service::ModelProxyService;
use serde_json::Value;
use serde_json::json;

use super::Client;
use super::Rig;

const TRUST: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-trust-cases/golden.json");

fn recorded(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&TRUST).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

struct Events(VecDeque<p::StreamEvent>);

#[async_trait]
impl p::ModelStream for Events {
    async fn next(&mut self) -> Option<Result<p::StreamEvent, p::ProviderError>> {
        self.0.pop_front().map(Ok)
    }
    fn delivery(&self) -> p::DeliveryState {
        p::DeliveryState::Accepted
    }
    fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
}

/// The PC's provider: answers "ok" to every call; with a hold, its first attempt waits for the test to let it go.
struct Answering {
    inner: MockProvider,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    holds_first: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl p::ProviderAdapter for Answering {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &mixdog_protocol::ProviderId {
        self.inner.id()
    }
    fn codec(&self) -> &dyn p::WireCodec {
        self.inner.codec()
    }
    fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
        self.inner.retry_policy()
    }
    fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
        self.inner.keepalive()
    }
    async fn attempt(&self, _: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
        if self.holds_first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(Box::new(Events(
            [p::StreamEvent::TextDelta("ok".into()), p::StreamEvent::Completed { stop: Some(p::StopReason::EndTurn), pricing_model: None, request_ms: None }].into(),
        )))
    }
}

struct Lookup(Arc<Answering>);

#[async_trait]
impl ProviderLookup for Lookup {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        (name == "openai").then(|| self.0.clone() as Arc<dyn p::ProviderAdapter>)
    }
}

struct Unused;

#[async_trait]
impl QuotaProbe for Unused {
    async fn usable(&self, _: &str, _: &str) -> Result<bool, String> {
        unreachable!("no case asks for quota")
    }
}

#[async_trait]
impl ProviderConfigSource for Unused {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        unreachable!("no case asks for the provider config")
    }
}

#[async_trait]
impl WireRouter for Unused {
    async fn route(&self, _: &dyn p::ProviderAdapter, _: &str, _: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError> {
        Ok(None)
    }
}

struct Offline;

#[async_trait]
impl mixdog_ai::transport::HttpSend for Offline {
    async fn send(&self, _: p::WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::HttpResponse, p::ProviderError> {
        Err(p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent))
    }
}

/// A rig whose `modelProxy` methods are the real service, over the provider; `inflight` is the service's bound on the data held.
async fn rig(provider: Arc<Answering>, inflight: Option<usize>) -> Rig {
    let tokens = mixdog_rt::testing::tokens();
    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    // The catalog's metadata source is offline and no case lists models: its folder is never read or written.
    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), std::env::temp_dir().join("mixdog-model-proxy-wire-unused"), io);
    let catalog = Arc::new(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata).await);
    let broker = Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(mixdog_ai::retry::StandardRetryDecider)));
    let runner = ProxyRunner { providers: Arc::new(Lookup(provider)), broker, quota: Arc::new(Unused), wire: Arc::new(Unused), config: Arc::new(Unused), catalog };
    let rig = Rig::gated(&[]);
    let mut service = ModelProxyService::new(Arc::new(runner), Arc::new(MockHostChannel::default()), rig.outgoing.clone());
    if let Some(bytes) = inflight {
        service = service.with_inflight_bound(bytes);
    }
    rig.core.serve(Arc::new(service));
    rig
}

fn answering(holds_first: bool) -> Arc<Answering> {
    Arc::new(Answering { inner: MockProvider::new(Vec::<MockAttempt>::new()), entered: tokio::sync::Notify::new(), release: tokio::sync::Notify::new(), holds_first: holds_first.into() })
}

/// The `modelProxy/run` frame of a send of `messages` to "openai".
fn run_frame(client: &Client, id: i64, messages: Vec<p::Message>) {
    let request = p::ModelRequest { model: "gpt".into(), messages, tools: Vec::new(), options: p::RequestOptions::default() };
    let call = w::ProxyCall::Send { provider: "openai".into(), request: Box::new(request_out(&request)) };
    client.request(id, "modelProxy/run", json!({ "runId": format!("r{id}"), "call": call, "allowedProviders": null }));
}

/// Collects frames until the responses of `ids` arrived: each answer by id, and the streamed text of each run.
async fn answers(client: &Client, ids: &[i64]) -> (HashMap<i64, Value>, HashMap<String, String>) {
    let (mut answers, mut text) = (HashMap::new(), HashMap::<String, String>::new());
    while answers.len() < ids.len() {
        let frames = client.frames(1).await;
        assert!(!frames.is_empty(), "no frame arrived while waiting for the answers of {ids:?} (got {:?})", answers.keys());
        for frame in frames {
            if frame.body["method"] == "modelProxy/run/event" {
                let params = &frame.body["params"];
                if let w::ProxyEvent::TextDelta { text: delta } = serde_json::from_value(params["event"].clone()).expect("a typed event") {
                    text.entry(params["runId"].as_str().unwrap().to_owned()).or_default().push_str(&delta);
                }
            } else if let Some(id) = frame.body["id"].as_i64() {
                answers.insert(id, frame.body["result"]["result"].clone());
            }
        }
    }
    (answers, text)
}

/// The recorded burst: every send of it reaches the real service through the server's admission, none is refused, and each one
/// answers `sent` with the text Node's did.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_recorded_burst_and_refusal_reach_the_real_model_proxy_service_from_the_wire() {
    let burst = recorded("a burst of sends all run, with no rate or concurrency refusal");
    let sends = burst["sends"].as_u64().unwrap() as i64;
    assert!(sends > 8, "the recorded burst is past the C2 cap");
    let rig = rig(answering(false), None).await;
    let client = rig.ready(1, json!({}));
    for id in 1..=sends {
        run_frame(&client, id, Vec::new());
    }
    let ids: Vec<i64> = (1..=sends).collect();
    let (answered, text) = answers(&client, &ids).await;
    assert!(answered.values().all(|answer| answer["result"] == "sent"), "no send of the burst was refused: {answered:?}");
    let results: Vec<Value> = ids.iter().map(|id| json!({ "content": text[&format!("r{id}")] })).collect();
    assert_eq!(Value::Array(results), burst["results"]);

    // The recorded refusal: the second call would take the data held past the bound while the first is in flight.
    let refusal = recorded("payloads past the aggregate in-flight limit are refused, and so are oversized event replies");
    let rejected = &refusal["secondCall"]["rejected"];
    let big = || vec![p::Message::new(p::Role::User, p::Content::Text("x".repeat(refusal["payloadChars"].as_u64().unwrap() as usize)))];
    let provider = answering(true);
    let rig = self::rig(provider.clone(), Some(refusal["maxInflightBytes"].as_u64().unwrap() as usize)).await;
    let client = rig.ready(1, json!({}));
    run_frame(&client, 1, big());
    tokio::time::timeout(std::time::Duration::from_secs(5), provider.entered.notified()).await.expect("the first call to reach its provider");
    run_frame(&client, 2, big());
    let (refused, _) = answers(&client, &[2]).await;
    let failure = &refused[&2]["failure"];
    assert_eq!(refused[&2]["result"], "failed");
    assert_eq!((failure["code"].as_str(), failure["status"].as_u64(), failure["message"].as_str()), (rejected["code"].as_str(), rejected["props"]["status"].as_u64(), rejected["message"].as_str()));
    provider.release.notify_one();
    let (first, _) = answers(&client, &[1]).await;
    assert_eq!(first[&1]["result"], "sent");
    run_frame(&client, 3, big());
    let (third, _) = answers(&client, &[3]).await;
    assert_eq!(third[&3]["result"], "sent", "the share the first call held is back");
}
