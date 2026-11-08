//! The custom-provider probes against what Node answers (`benchmarks/rust-core/recorders/record-custom-probe.mjs`):
//! the discovery result and its error view, the connection test's phases, and the thrown,
//! redacted send failures. The endpoint is Node's scripted server replayed through the real
//! `CustomListing`; the provider's send is scripted with the status Node's server gave.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::providers::connect::rewrite::StaticCredential;
use mixdog_ai::providers::custom::Protocol;
use mixdog_ai::providers::custom::listing::CustomListing;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::custom_probe::*;
use super::failure::Failure;

const GOLDEN: &str = include_str!("../../../../../fixtures/custom-probe/golden.json");

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Node's scripted `/models` answer.
struct Scripted {
    status: u16,
    body: Vec<u8>,
    seen: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Scripted {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        Ok(HttpResponse { status: self.status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(self.body.clone())))) })
    }
}

struct Endpoint {
    listing: CustomListing,
    chat_status: u16,
    chat_message: String,
}

#[async_trait]
impl CustomEndpoint for Endpoint {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        self.listing.list_models().await
    }
    fn discovery_error(&self) -> Option<ProviderError> {
        self.listing.discovery_error()
    }
    async fn send_test(&self, _: &str, _: &[String]) -> Result<Option<String>, ProviderError> {
        if self.chat_status == 200 {
            return Ok(None);
        }
        let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::Accepted);
        error.status = Some(self.chat_status);
        error.message = format!("{} {}", self.chat_status, self.chat_message);
        Err(error)
    }
}

struct Host {
    case: Value,
    http: Arc<Scripted>,
    stall: bool,
}

impl Host {
    fn of(case: &Value) -> Arc<Self> {
        let models = &case["models"];
        let http = Arc::new(Scripted {
            status: models["status"].as_u64().unwrap() as u16,
            body: serde_json::to_vec(&models["body"]).unwrap(),
            seen: Mutex::default(),
        });
        Arc::new(Self { case: case.clone(), http, stall: false })
    }
}

#[async_trait]
impl CustomProbeHost for Host {
    fn require_local_provider_management(&self) -> Result<(), Failure> {
        Ok(())
    }
    async fn resolve_input(&self, _: &Value) -> Result<ResolvedCustom, Failure> {
        Ok(ResolvedCustom { id: None, config: self.case["config"].clone(), api_key: self.case["apiKey"].as_str().unwrap().to_owned() })
    }
    async fn create(&self, id: &str, config: &Value, api_key: &str) -> Result<Arc<dyn CustomEndpoint>, Failure> {
        let keyless = config["auth"] == "none";
        let credential = (!keyless).then(|| ("authorization".to_owned(), format!("Bearer {api_key}")));
        let chat = &self.case["chat"];
        let message = chat["body"]["error"]["message"].as_str().or(chat["body"]["error"].as_str()).unwrap_or_default().to_owned();
        let listing = CustomListing::new(
            id,
            Protocol::OpenaiChat,
            config["baseURL"].as_str().unwrap(),
            Vec::new(),
            self.http.clone(),
            Arc::new(StaticCredential(credential)),
            keyless,
            config,
            ListingLookup::new(),
        );
        if self.stall {
            return Ok(Arc::new(Stalled));
        }
        Ok(Arc::new(Endpoint { listing, chat_status: chat["status"].as_u64().unwrap_or(200) as u16, chat_message: message }))
    }
    async fn key_ids(&self, _: &str) -> Result<Vec<String>, Failure> {
        Ok(Vec::new())
    }
    fn env(&self, _: &str) -> Option<String> {
        None
    }
}

/// An endpoint that never answers.
struct Stalled;

#[async_trait]
impl CustomEndpoint for Stalled {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        std::future::pending().await
    }
    fn discovery_error(&self) -> Option<ProviderError> {
        None
    }
    async fn send_test(&self, _: &str, _: &[String]) -> Result<Option<String>, ProviderError> {
        std::future::pending().await
    }
}

#[tokio::test]
async fn every_probe_answers_as_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let host = Host::of(case);
        let probes = CustomProbes::new(host.clone());
        let got = match case["op"].as_str().unwrap() {
            "test" => probes.test(case["input"].clone()).await,
            _ => probes.discover_models(case["input"].clone()).await,
        };
        match (&case["error"], got) {
            (Value::String(error), Err(failure)) => assert_eq!(failure.message(), error, "{name}"),
            (Value::Null, Ok(result)) => assert_eq!(result, case["result"], "{name}"),
            (_, other) => panic!("{name}: {other:?}"),
        }
        // The discovery asks Node's header and path, once at most.
        let seen = host.http.seen.lock().unwrap();
        let wanted: Vec<&Value> = case["seen"].as_array().unwrap().iter().filter(|s| s["method"] == "GET").collect();
        assert_eq!(seen.len(), wanted.len(), "{name}: discovery requests");
        for (sent, want) in seen.iter().zip(wanted) {
            assert!(sent.url.ends_with("/models"), "{name}");
            let bearer = sent.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.replace(case["apiKey"].as_str().unwrap(), "<key>"));
            assert_eq!(bearer.as_deref(), want["authorization"].as_str(), "{name}: authorization");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_discovery_that_never_answers_times_out_at_sixty_seconds() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let case = &golden["cases"][0];
    let host = Arc::new(Host { case: case.clone(), http: Host::of(case).http.clone(), stall: true });
    let started = tokio::time::Instant::now();
    let result = CustomProbes::new(host).discover_models(json!({})).await.unwrap();
    assert_eq!(result, json!({ "models": [], "error": { "kind": "timeout", "message": "model discovery timed out after 60s" } }));
    assert_eq!(started.elapsed(), Duration::from_secs(60));
}

#[tokio::test(start_paused = true)]
async fn a_send_that_never_answers_is_thrown_at_twenty_seconds() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let case = golden["cases"].as_array().unwrap().iter().find(|c| c["name"] == "a manual model is tested without discovery").unwrap();
    let host = Arc::new(Host { case: case.clone(), http: Host::of(case).http.clone(), stall: true });
    let started = tokio::time::Instant::now();
    let failure = CustomProbes::new(host).test(case["input"].clone()).await.unwrap_err();
    assert_eq!(failure.message(), "connection test timed out after 20s");
    assert_eq!(started.elapsed(), Duration::from_secs(20));
}

/// A refused port and a restricted port (`127.0.0.1:9`) through the real transport, the real listing and the real
/// send path: the settings page shows what Node's probes recorded (`connect_errors.json` `probes`): `fetch failed` for
/// the discovery's raw `fetch`, `Connection error.` for the connection test's SDK send.
#[tokio::test]
async fn an_unreachable_endpoint_reads_as_node_shows_it() {
    use super::collaborators::CustomProviders as _;
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}/v1", listener.local_addr().unwrap())
    };
    for (name, base) in [("refused", closed.as_str()), ("badPort", "http://127.0.0.1:9/v1")] {
        let recorded = &golden["probes"][name];
        let w = super::custom_admin_tests::world(std::collections::HashMap::new()).await;
        let input = json!({ "name": "Probe", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-DUMMY-probe-secret-0123456789" });
        let manual = json!({ "name": "Probe", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-DUMMY-probe-secret-0123456789", "schemaVersion": 2, "modelOverrides": { "m-manual": { "manual": true } } });
        assert_eq!(w.admin.discover_models(input.clone()).await.unwrap(), recorded["discover"]["result"], "{name}: discover");
        assert_eq!(w.admin.test(input).await.unwrap(), recorded["testDiscovery"]["result"], "{name}: test through discovery");
        // The send retries on the 1, 2, 4, 8 s ladder before it throws; a refused loopback connect on Windows
        // takes seconds per attempt and would outlast the 20 s limit, so only the restricted port (no connect) sends
        // here; the refused send is `a_refused_send_throws_the_sdks_text_after_the_retry_ladder`.
        if name == "badPort" {
            let thrown = w.admin.test(manual).await.unwrap_err();
            assert_eq!(thrown.message(), recorded["testSend"]["thrown"].as_str().unwrap(), "{name}: test send");
        }
    }
}

/// Refuses every send at once, as the link does a closed port, with the text of the exchange's class.
struct Refusing {
    sends: Mutex<Vec<mixdog_ai::transport::Surface>>,
}

#[async_trait]
impl HttpSend for Refusing {
    async fn send(&self, _request: WireRequest, exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.sends.lock().unwrap().push(exchange.surface);
        let mut error = ProviderError::transport(TransportFault::Connect { os_code: Some(111) }, DeliveryState::NotSent);
        error.message = exchange.surface.text(|| "connect refused".to_owned());
        Err(error)
    }
}

/// The connection test's send over a refusing link, through the real adapter, retry ladder and probe: what Node
/// recorded (`probes.refused.testSend.thrown`) is thrown once the ladder is spent, and every send went out as the SDK
/// class. The ladder's waits run on the paused clock.
#[tokio::test]
async fn a_refused_send_throws_the_sdks_text_after_the_retry_ladder() {
    use super::collaborators::CustomProviders as _;
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
    let link = Arc::new(Refusing { sends: Mutex::new(Vec::new()) });
    let w = super::custom_admin_tests::world_over(std::collections::HashMap::new(), Some(link.clone())).await;
    let manual = json!({ "name": "Probe", "protocol": "openai-chat", "baseURL": "http://127.0.0.1:1/v1", "apiKey": "sk-DUMMY-probe-secret-0123456789", "schemaVersion": 2, "modelOverrides": { "m-manual": { "manual": true } } });
    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let thrown = w.admin.test(manual).await.unwrap_err();
    assert_eq!(thrown.message(), golden["probes"]["refused"]["testSend"]["thrown"].as_str().unwrap());
    let sends = link.sends.lock().unwrap();
    assert!(sends.len() > 1, "the ladder retried: {}", sends.len());
    assert!(sends.iter().all(|surface| *surface == mixdog_ai::transport::Surface::Sdk), "{sends:?}");
    assert!(started.elapsed() < TEST_TIMEOUT, "the ladder ends inside the 20 s limit: {:?}", started.elapsed());
}

#[test]
fn credential_looking_text_is_redacted_to_one_short_line() {
    let secrets = vec!["hunter2hunter2".to_owned(), String::new()];
    assert_eq!(
        sanitize_message("Authorization: Bearer abc.def-ghi\nkey hunter2hunter2 token=zzz api_key: \"qq\" sk-abcdefgh12", &secrets),
        // Node's own result: the field rule also takes the redacted scheme word.
        "Authorization: [redacted] [redacted] key [redacted] token=[redacted] api_key: \"[redacted]\" [redacted]"
    );
    assert_eq!(sanitize_message("", &[]), "request failed");
    let long = sanitize_message(&"x".repeat(400), &[]);
    assert_eq!(long.chars().count(), 301);
    assert!(long.ends_with('…'));
}
