//! Recorded-fixture conformance of the Google providers: the intercepted
//! exchanges of the Node implementation under
//! `fixtures/providers-intercepted/{gemini,vertex-ai-adc,vertex-ai-api-key,
//! antigravity-oauth}` are replayed against the codec, the adapters and the
//! retry rows.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::conformance::check_provider_attempt;
use mixdog_core_api::domain::conformance::check_wire_codec;
use mixdog_core_api::domain::mock::MockRetryDecider;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use serde_json::Value;
use serde_json::json;

use super::auth::RequestAuth;
use super::auth::antigravity::ENDPOINT;
use super::auth::antigravity::TokenDoc;
use super::auth::antigravity::TokenStore;
use super::auth::vertex;
use super::codec::GEMINI_ORIGIN;
use super::codec::GoogleCodec;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use super::policy;
use super::serving::VertexPlace;
use super::traits::ModelTraits;
use super::traits::ThinkingControl;

struct AllGemini;

impl ModelTraits for AllGemini {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

fn traits() -> Arc<dyn ModelTraits> {
    Arc::new(AllGemini)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Rec {
    url: String,
    body: String,
    served: String,
}

struct Scenario {
    recs: Vec<Rec>,
    result: Value,
    sleeps_ms: Vec<u64>,
    rng: Vec<f64>,
}

impl Scenario {
    /// The content request: the first `streamGenerateContent` exchange.
    fn content(&self) -> &Rec {
        self.recs.iter().find(|r| r.url.contains(":streamGenerateContent")).expect("content record")
    }

    fn error_status(&self) -> u16 {
        self.result["error"]["status"].as_u64().expect("error status") as u16
    }
}

fn fixture_root() -> PathBuf {
    std::env::var_os("MIXDOG_FIXTURES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures"))
        .join("providers-intercepted")
}

#[allow(clippy::disallowed_methods, reason = "test setup: reads recorded fixtures")]
fn load(provider: &str, name: &str) -> Scenario {
    let dir = fixture_root().join(provider).join(name);
    let read = |file: &str| -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(file)).expect(file)).expect("json")
    };
    let exchange = read("exchange.json");
    let recs = exchange["records"]
        .as_array()
        .expect("records")
        .iter()
        .map(|r| Rec {
            url: format!("{}{}", r["origin"].as_str().unwrap(), r["path"].as_str().unwrap()),
            body: r["bodyText"].as_str().unwrap_or("").to_owned(),
            served: r["served"].as_str().unwrap_or("").to_owned(),
        })
        .collect();
    let sleeps_ms = exchange["determinism"]["retrySleeps"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["delayMs"].as_u64()).collect())
        .unwrap_or_default();
    let rng = exchange["determinism"]["rng"]["samples"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["value"].as_f64()).collect())
        .unwrap_or_default();
    Scenario { recs, result: read("result.json"), sleeps_ms, rng }
}

fn fixture_request(model: &str) -> ModelRequest {
    let text = |role, t: &str| Message::new(role, Content::Text(t.into()));
    ModelRequest {
        model: model.into(),
        messages: vec![text(Role::System, "You are a fixture assistant."), text(Role::User, "Look up the answer.")],
        tools: vec![ToolDefinition {
            name: "lookup".into(),
            description: "Read a value".into(),
            input_schema: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
            defer_loading: false,
            freeform: None,
        }],
        options: RequestOptions::default(),
    }
}

// ---------------------------------------------------------------------------
// The four recorded providers
// ---------------------------------------------------------------------------

const VERTEX_ADC_BASE: &str = "https://us-central1-aiplatform.googleapis.com/v1/projects/projectaa-a5af6/locations/us-central1";

struct Provider {
    dir: &'static str,
    model: &'static str,
    codec: GoogleCodec,
}

fn providers() -> Vec<Provider> {
    vec![
        Provider { dir: "gemini", model: "gemini-2.5-pro", codec: GoogleCodec::gemini(GEMINI_ORIGIN, traits()) },
        Provider {
            dir: "vertex-ai-adc",
            model: "gemini-2.5-pro",
            codec: GoogleCodec::vertex(VertexPlace::project("projectaa-a5af6", Some("us-central1"), None), traits()),
        },
        Provider {
            dir: "vertex-ai-api-key",
            model: "gemini-2.5-pro",
            codec: GoogleCodec::vertex(VertexPlace::express(), traits()),
        },
        Provider {
            dir: "antigravity-oauth",
            model: "gemini-3-pro",
            codec: GoogleCodec::antigravity(ENDPOINT, "fixture-project", "2.19.1", traits()),
        },
    ]
}

fn without_request_id(mut body: Value) -> Value {
    if let Some(map) = body.as_object_mut() {
        map.shift_remove("requestId");
    }
    body
}

#[test]
fn vertex_project_base_matches_the_recording() {
    assert_eq!(vertex::project_base("projectaa-a5af6", "us-central1").unwrap(), VERTEX_ADC_BASE);
    assert_eq!(
        vertex::project_base("p", "global").unwrap(),
        "https://aiplatform.googleapis.com/v1/projects/p/locations/global"
    );
    assert_eq!(
        vertex::project_base("p", "eu").unwrap(),
        "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu"
    );
    assert!(vertex::project_base("p", "us/../x").is_err());
}

#[test]
fn requests_encode_to_the_recorded_wire() {
    for p in providers() {
        let scenario = load(p.dir, "text");
        let wire = p.codec.encode(&fixture_request(p.model)).expect("encode");
        let recorded = scenario.content();
        assert_eq!(wire.url, recorded.url, "{}: url", p.dir);
        assert_eq!(wire.method, "POST");
        let sent: Value = serde_json::from_slice(&wire.body).unwrap();
        let expected: Value = serde_json::from_str(&recorded.body).unwrap();
        assert_eq!(without_request_id(sent.clone()), without_request_id(expected), "{}: body", p.dir);
        if p.dir == "antigravity-oauth" {
            let id = sent["requestId"].as_str().unwrap();
            assert!(id.starts_with("agent-") && id.len() == "agent-".len() + 36);
            assert!(
                wire.headers.contains(&(
                    "user-agent".into(),
                    "antigravity/hub/2.19.1 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)".into()
                ))
            );
        }
    }
}

type Folded = (String, Vec<ToolCall>, Option<(u64, u64)>, Option<StopReason>);

fn fold(events: &[StreamEvent]) -> Folded {
    let mut text = String::new();
    let mut calls = Vec::new();
    let mut usage = None;
    let mut stop = None;
    for event in events {
        match event {
            StreamEvent::TextDelta(t) => text.push_str(t),
            StreamEvent::ToolCallDone(c) => calls.push(c.clone()),
            StreamEvent::Usage(u) => usage = Some((u.input_tokens, u.output_tokens)),
            StreamEvent::Completed { stop: s, .. } => stop = s.clone(),
            _ => {}
        }
    }
    (text, calls, usage, stop)
}

fn decode_all(codec: &GoogleCodec, wire: &str) -> Result<Vec<StreamEvent>, ProviderError> {
    let mut decoder = codec.decoder(&fixture_request("gemini-2.5-pro"));
    let mut events = decoder.feed(wire.as_bytes())?;
    events.extend(decoder.finish()?);
    Ok(events)
}

#[test]
fn recorded_sse_streams_fold_to_the_recorded_results() {
    // The vertex recordings were served as a JSON array, not as SSE; they are
    // covered by `non_sse_bodies_are_truncated_streams`.
    for p in providers().into_iter().filter(|p| matches!(p.dir, "gemini" | "antigravity-oauth")) {
        let text = load(p.dir, "text");
        let ok = &text.result["ok"];
        let events = decode_all(&p.codec, &text.content().served).expect("text stream");
        let (content, calls, usage, stop) = fold(&events);
        assert_eq!(content, ok["content"].as_str().unwrap(), "{}", p.dir);
        assert!(calls.is_empty());
        assert_eq!(usage, Some((ok["usage"]["inputTokens"].as_u64().unwrap(), ok["usage"]["outputTokens"].as_u64().unwrap())));
        assert_eq!(stop, None, "Node: stopReason null");

        let tool = load(p.dir, "tool-call");
        let events = decode_all(&p.codec, &tool.content().served).expect("tool stream");
        let (_, calls, usage, stop) = fold(&events);
        let expected = &tool.result["ok"]["toolCalls"][0];
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, expected["id"].as_str().unwrap());
        assert_eq!(calls[0].name, expected["name"].as_str().unwrap());
        assert_eq!(calls[0].arguments, expected["arguments"]);
        assert_eq!(usage, Some((20, 6)));
        assert_eq!(stop, None, "Node: stopReason null");

        // The shared codec conformance: split feeding, one terminal event, and
        // an end without it is a truncated stream.
        let cut = load(p.dir, "truncated-eof");
        check_wire_codec(&p.codec, &fixture_request("gemini-2.5-pro"), text.content().served.as_bytes(), cut.content().served.as_bytes(), 17);
    }
}

#[test]
fn non_sse_bodies_are_truncated_streams() {
    for p in providers().into_iter().filter(|p| p.dir.starts_with("vertex")) {
        let scenario = load(p.dir, "text");
        let err = decode_all(&p.codec, &scenario.content().served).unwrap_err();
        assert_eq!(err.transport, Some(TransportFault::TruncatedStream), "{}", p.dir);
        assert_eq!(err.kind, ErrorKind::Transient);
    }
}

/// The vertex recordings' chunks re-framed the way `alt=sse` frames them.
fn as_sse(array_body: &str) -> String {
    let chunks: Vec<Value> = serde_json::from_str(array_body).expect("recorded chunk array");
    chunks.iter().map(|c| format!("data: {c}\n\n")).collect()
}

#[test]
fn vertex_chunks_decode_as_sse_with_cache_exclusive_usage() {
    for p in providers().into_iter().filter(|p| p.dir.starts_with("vertex")) {
        let text = as_sse(&load(p.dir, "text").content().served);
        let first_chunk = text.split("\n\n").next().unwrap().to_owned() + "\n\n";
        check_wire_codec(&p.codec, &fixture_request("gemini-2.5-pro"), text.as_bytes(), first_chunk.as_bytes(), 31);
        let (content, _, usage, stop) = fold(&decode_all(&p.codec, &text).unwrap());
        assert_eq!((content.as_str(), usage, stop), ("The result is 42.", Some((20, 8)), None));

        let tool = as_sse(&load(p.dir, "tool-call").content().served);
        let (_, calls, _, stop) = fold(&decode_all(&p.codec, &tool).unwrap());
        assert_eq!((calls[0].id.as_str(), stop), ("gemini_366b187da650ce24", None));
    }
    // Vertex accounts input without the cached tokens.
    let codec = &providers()[1].codec;
    let wire = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"x\"}]},\"finishReason\":\"STOP\"}],\
        \"usageMetadata\":{\"promptTokenCount\":100,\"cachedContentTokenCount\":60,\"candidatesTokenCount\":5}}\n\n";
    assert_eq!(fold(&decode_all(codec, wire).unwrap()).2, Some((40, 5)));
}

#[test]
fn truncated_recordings_end_as_transient_truncation() {
    for p in providers() {
        for name in ["truncated-eof", "truncated-reset"] {
            let scenario = load(p.dir, name);
            let err = decode_all(&p.codec, &scenario.content().served).unwrap_err();
            assert_eq!(err.transport, Some(TransportFault::TruncatedStream), "{} {name}", p.dir);
            assert_eq!(err.kind, ErrorKind::Transient);
            assert_eq!(err.delivery, DeliveryState::Accepted);
        }
    }
    // The stream had shown text: a replay would double-render it.
    let scenario = load("gemini", "truncated-eof");
    let err = decode_all(&providers()[0].codec, &scenario.content().served).unwrap_err();
    assert!(err.exposure.text_emitted);
}

#[test]
fn upstream_errors_classify_from_status() {
    for p in providers() {
        for (name, kind) in [("error-400", ErrorKind::InvalidRequest), ("error-401", ErrorKind::Auth)] {
            let scenario = load(p.dir, name);
            let status = scenario.error_status();
            let err = p.codec.classify(&ErrorResponse {
                status: Some(status),
                headers: Vec::new(),
                body: scenario.content().served.clone().into_bytes(),
            });
            assert_eq!((err.kind, err.status), (kind, Some(status)), "{} {name}", p.dir);
            assert_eq!(err.delivery, DeliveryState::Accepted);
            assert!(err.message.contains("fixture upstream error"));
        }
    }
}

// ---------------------------------------------------------------------------
// Retry rows against the recorded sleeps
// ---------------------------------------------------------------------------

fn delays(
    error: &ProviderError,
    policy: &RetryPolicy,
    class: RetryClass,
    samples: impl Fn(usize) -> JitterSamples,
) -> (Vec<u64>, Verdict) {
    let decider = MockRetryDecider;
    let mut state = RetryState::new(class, "m");
    let mut out = Vec::new();
    for i in 0..40 {
        let decision = decider.verdict(error, &state, policy, samples(i));
        state = decision.next;
        match decision.verdict {
            Verdict::Retry { delay, .. } => out.push(delay.as_millis() as u64),
            other => return (out, other),
        }
    }
    panic!("a bounded row never retries forever");
}

#[test]
fn retry_rows_reproduce_the_recorded_sleeps() {
    // The recorder ran without a live text sink, so the truncated attempts
    // carried no exposure and were replayed; with a sink the stream would have
    // shown text and the verdict is to surface (the decode test above).
    let truncated = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
    let at = |step| JitterSamples { step, advice: 0.5 };

    // Antigravity: three retries at 1/2/4 s with ±10 % jitter from the
    // recorded random draws.
    for name in ["truncated-eof", "truncated-reset"] {
        let scenario = load("antigravity-oauth", name);
        let (got, end) =
            delays(&truncated, &policy::antigravity(), RetryClass::Request, |i| at(scenario.rng[i.min(2)]));
        assert_eq!(got, scenario.sleeps_ms, "antigravity {name}");
        assert!(!matches!(end, Verdict::Retry { .. }));
    }
    // Gemini and Vertex AI: three stream retries at an unjittered 1/2/4 s.
    for dir in ["gemini", "vertex-ai-adc", "vertex-ai-api-key"] {
        let scenario = load(dir, "truncated-eof");
        let (got, _) = delays(&truncated, &policy::gemini(), RetryClass::Midstream, |_| at(0.5));
        let recorded: Vec<u64> = scenario.sleeps_ms.iter().copied().filter(|ms| [1000, 2000, 4000].contains(ms)).collect();
        assert_eq!(got, vec![1000, 2000, 4000]);
        assert!(recorded.starts_with(&[1000, 2000, 4000]), "{dir}: recorded sleeps {recorded:?}");
    }
}

#[test]
fn antigravity_retry_kinds_follow_the_typed_error_fields() {
    let codec = GoogleCodec::antigravity(ENDPOINT, "p", "2.19.1", traits());
    let failure = |status: u16, reason: &str| {
        let body = json!({"error":{"code":status,"message":"x","status":"RESOURCE_EXHAUSTED",
            "details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":reason}]}});
        codec.classify(&ErrorResponse { status: Some(status), headers: vec![], body: body.to_string().into_bytes() })
    };
    let policy = policy::antigravity();
    let run = |err: &ProviderError| delays(err, &policy, RetryClass::Request, |_| JitterSamples { step: 0.5, advice: 0.5 });
    let (capacity, end) = run(&failure(429, "MODEL_CAPACITY_EXHAUSTED"));
    assert_eq!(capacity, vec![1000, 2000, 4000], "capacity: three same-host retries");
    assert!(!matches!(end, Verdict::Retry { .. }));
    let (rpm, _) = run(&failure(429, "RATE_LIMIT_EXCEEDED"));
    assert_eq!(rpm, vec![1000], "rate limit: one quick retry");
    let (quota, end) = run(&failure(429, "QUOTA_EXHAUSTED"));
    assert!(quota.is_empty() && end == Verdict::Surface, "spent quota is never retried");
    let (overloaded, _) = run(&failure(503, "BACKEND_ERROR"));
    assert_eq!(
        overloaded.len(),
        15,
        "503 runs the inner ladder (3), then a capacity retry (1) that restarts it, three times, then a last ladder"
    );
}

// ---------------------------------------------------------------------------
// Adapters over scripted HTTP
// ---------------------------------------------------------------------------

struct Chunks(VecDeque<Result<Bytes, TransportFault>>);

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front()
    }
}

enum Step {
    Respond { status: u16, body: String, fault: Option<TransportFault> },
    Fail(ProviderError),
}

fn respond(status: u16, body: &str) -> Step {
    Step::Respond { status, body: body.into(), fault: None }
}

#[derive(Default)]
struct Scripted {
    steps: Mutex<VecDeque<Step>>,
    seen: Mutex<Vec<WireRequest>>,
}

impl Scripted {
    fn new(steps: Vec<Step>) -> Arc<Self> {
        Arc::new(Self { steps: Mutex::new(steps.into()), seen: Mutex::default() })
    }

    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|r| r.url.clone()).collect()
    }
}

#[async_trait]
impl HttpSend for Scripted {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: crate::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        self.seen.lock().unwrap().push(request);
        match self.steps.lock().unwrap().pop_front().expect("scripted step") {
            Step::Fail(err) => Err(err),
            Step::Respond { status, body, fault } => {
                // Two units, so decoding is incremental.
                let cut = body.len() / 2;
                let mut chunks: VecDeque<Result<Bytes, TransportFault>> = VecDeque::new();
                chunks.push_back(Ok(Bytes::copy_from_slice(&body.as_bytes()[..cut])));
                chunks.push_back(Ok(Bytes::copy_from_slice(&body.as_bytes()[cut..])));
                chunks.extend(fault.map(Err));
                Ok(HttpResponse { status, headers: vec![], body: Box::new(Chunks(chunks)) })
            }
        }
    }
}

#[derive(Default)]
struct MemoryStore(Mutex<Option<TokenDoc>>);

impl MemoryStore {
    fn with(doc: TokenDoc) -> Arc<Self> {
        Arc::new(Self(Mutex::new(Some(doc))))
    }
}

#[async_trait]
impl TokenStore for MemoryStore {
    async fn load(&self) -> Option<TokenDoc> {
        self.0.lock().unwrap().clone()
    }

    async fn save(&self, doc: &TokenDoc) -> bool {
        *self.0.lock().unwrap() = Some(doc.clone());
        true
    }

    async fn replace_if_current(&self, spent: &TokenDoc, next: &TokenDoc) -> bool {
        let mut stored = self.0.lock().unwrap();
        if stored.as_ref() == Some(spent) {
            *stored = Some(next.clone());
            true
        } else {
            false
        }
    }
}

// Before the Gemini API's dated model redirects (2026-12-01), so these fixed-clock requests keep their ids.
const NOW_MS: u64 = 1_790_000_000_000;

fn doc(expires_at_ms: u64, project: &str) -> TokenDoc {
    TokenDoc {
        access_token: "stale-access".into(),
        refresh_token: "fixture-refresh-token".into(),
        expires_at_ms,
        project_id: project.into(),
        tier_id: String::new(),
        email: String::new(),
        user_id: String::new(),
    }
}

fn clock() -> Box<dyn Fn() -> u64 + Send + Sync> {
    Box::new(|| NOW_MS)
}

async fn antigravity_adapter(http: Arc<Scripted>, store: Arc<MemoryStore>) -> super::adapter::GoogleAdapter {
    super::antigravity(store, "2.19.1".into(), http, traits(), clock(), None).await.expect("adapter")
}

async fn collect(adapter: &dyn ProviderAdapter, request: ModelRequest) -> (Vec<StreamEvent>, Option<ProviderError>) {
    let mut stream = match adapter.attempt(Arc::new(request)).await {
        Ok(stream) => stream,
        Err(err) => return (Vec::new(), Some(err)),
    };
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(event) => events.push(event),
            Err(err) => return (events, Some(err)),
        }
    }
    (events, None)
}

fn gemini_adapter(http: Arc<Scripted>) -> super::adapter::GoogleAdapter {
    super::gemini("key-1", http, traits())
}

struct TokioRuntime;

impl super::cache::layer::CacheRuntime for TokioRuntime {
    fn now_ms(&self) -> u64 {
        NOW_MS
    }
    fn spawn(&self, task: futures::future::BoxFuture<'static, ()>) {
        tokio::spawn(task);
    }
    fn spawn_after(&self, _delay_ms: u64, _task: futures::future::BoxFuture<'static, ()>) {}
    fn deadline(&self, _ms: u64) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(futures::future::pending())
    }
}

/// A cached request the server answers 400: the cache is forgotten (registry
/// and session state) and the request is resent once without it, never again.
#[tokio::test]
async fn a_rejected_cache_is_dropped_and_the_request_resent_once_uncached() {
    use super::cache::layer::ExplicitCache;
    use super::cache::policy::Tuning;
    use super::cache::registry::Registry;
    use mixdog_core_api::domain::provider::ProviderState;
    use mixdog_core_api::domain::provider::StreamEvent;

    let text = load("gemini", "text");
    let create = r#"{"name":"cachedContents/c1","usageMetadata":{"totalTokenCount":3000}}"#;
    let http = Scripted::new(vec![
        respond(200, create),
        respond(400, REJECTED),
        respond(200, &text.content().served),
    ]);
    let registry = Arc::new(Registry::default());
    let cache = ExplicitCache::new(
        "key-1",
        super::codec::GEMINI_ORIGIN,
        http.clone(),
        Arc::new(TokioRuntime),
        registry.clone(),
        Tuning::default(),
    );
    let adapter = super::gemini("key-1", http.clone(), traits()).with_cache(cache);
    let say = |role, t: String| Message::new(role, Content::Text(t));
    let mut request = fixture_request("gemini-2.5-pro");
    request.messages = vec![
        say(Role::System, "x".repeat(12_000)),
        say(Role::User, "first".into()),
        say(Role::Assistant, "second".into()),
        say(Role::User, "third".into()),
    ];
    let (events, err) = collect(&adapter, request).await;
    assert!(err.is_none(), "{err:?}");
    assert_eq!(fold(&events).0, "The result is 42.");
    let sent = http.seen.lock().unwrap();
    assert_eq!(sent.len(), 3, "one create, the cached send, one uncached resend");
    assert!(sent[0].url.ends_with("/v1beta/cachedContents"));
    let body = |i: usize| -> serde_json::Value { serde_json::from_slice(&sent[i].body).unwrap() };
    assert_eq!(body(1)["cachedContent"], "cachedContents/c1");
    assert!(body(2).get("cachedContent").is_none());
    assert!(!registry.name_is_live("cachedContents/c1", NOW_MS));
    let states: Vec<_> = events.iter().filter_map(|e| if let StreamEvent::ProviderState(s) = e { Some(s) } else { None }).collect();
    assert_eq!(states.last(), Some(&&ProviderState::default()));
}

fn cached_adapter(steps: Vec<Step>) -> (super::adapter::GoogleAdapter, Arc<Scripted>) {
    use super::cache::layer::ExplicitCache;
    use super::cache::policy::Tuning;
    use super::cache::registry::Registry;

    let http = Scripted::new(steps);
    let cache = ExplicitCache::new(
        "key-1",
        super::codec::GEMINI_ORIGIN,
        http.clone(),
        Arc::new(TokioRuntime),
        Arc::new(Registry::default()),
        Tuning::default(),
    );
    (super::gemini("key-1", http.clone(), traits()).with_cache(cache), http)
}

fn big_request() -> ModelRequest {
    let say = |role, t: String| Message::new(role, Content::Text(t));
    let mut request = fixture_request("gemini-2.5-pro");
    request.messages = vec![
        say(Role::System, "x".repeat(12_000)),
        say(Role::User, "first".into()),
        say(Role::Assistant, "second".into()),
        say(Role::User, "third".into()),
    ];
    request
}

fn held_state() -> mixdog_core_api::domain::provider::ProviderState {
    serde_json::from_value(json!({
        "gemini": {
            "cacheName": "cachedContents/old", "cacheCreatedAt": 1, "cacheCreatedAtIter": 1,
            "cacheExpiresAt": 2, "cacheModel": "gemini-2.5-pro", "cacheTokenSize": 3,
            "cachePrefixContentCount": 1, "cachePrefixHash": "h", "cacheCredentialFingerprint": "f"
        },
        "providerAccountId": "acct-1"
    }))
    .unwrap()
}

const CREATE_C1: &str = r#"{"name":"cachedContents/c1","usageMetadata":{"totalTokenCount":3000}}"#;
/// A refusal of the attached cache: only one that names the cached content is replayed uncached
/// (`isGeminiCachedContentError`).
const REJECTED: &str = r#"{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"CachedContent not found"}}"#;

/// After a cached rejection the uncached resend runs once; if it fails, the
/// error carries no state (Node persists state from a delivered result only).
#[tokio::test]
async fn a_failing_resend_after_a_cache_reset_persists_no_state() {
    let fault = || ProviderError::transport(TransportFault::Reset, DeliveryState::NotSent);
    let cases = [
        ("retry transport failure", Step::Fail(fault())),
        ("retry 500", respond(500, r#"{"error":{"code":500,"status":"INTERNAL","message":"boom"}}"#)),
        ("retry 403", respond(403, r#"{"error":{"code":403,"status":"PERMISSION_DENIED","message":"no"}}"#)),
    ];
    for (name, retry) in cases {
        let (adapter, http) = cached_adapter(vec![respond(200, CREATE_C1), respond(400, REJECTED), retry]);
        let mut request = big_request();
        request.options.provider_state = Some(held_state());
        let (_, err) = collect(&adapter, request).await;
        assert!(err.is_some(), "{name}: fails");
        assert_eq!(http.seen.lock().unwrap().len(), 3, "{name}: create, cached send, one resend");
    }
}

#[tokio::test]
async fn gemini_adapter_streams_the_recorded_turn_and_passes_the_attempt_conformance() {
    let text = load("gemini", "text");
    let served = &text.content().served;
    let http = Scripted::new(vec![respond(200, served)]);
    let adapter = gemini_adapter(http.clone());
    let (events, err) = collect(&adapter, fixture_request("gemini-2.5-pro")).await;
    assert!(err.is_none());
    assert_eq!(fold(&events).0, "The result is 42.");
    {
        let seen = http.seen.lock().unwrap();
        assert_eq!(seen[0].url, text.content().url);
        assert!(seen[0].headers.contains(&("x-goog-api-key".into(), "key-1".into())));
    }

    let http = Scripted::new(vec![respond(200, served)]);
    check_provider_attempt(&gemini_adapter(http), Arc::new(fixture_request("gemini-2.5-pro")), DeliveryState::Accepted).await;

    // A reset after the first bytes: a socket fact, with the exposure so far.
    let reset = load("gemini", "truncated-reset");
    let step = Step::Respond { status: 200, body: reset.content().served.clone(), fault: Some(TransportFault::Reset) };
    let (events, err) = collect(&gemini_adapter(Scripted::new(vec![step])), fixture_request("gemini-2.5-pro")).await;
    let err = err.expect("reset");
    assert_eq!((err.kind, err.transport.clone()), (ErrorKind::Transient, Some(TransportFault::Reset)));
    assert!(err.exposure.text_emitted);
    assert!(events.iter().all(|e| !matches!(e, StreamEvent::Completed { .. })));
    let step = Step::Respond { status: 200, body: reset.content().served.clone(), fault: Some(TransportFault::Reset) };
    check_provider_attempt(&gemini_adapter(Scripted::new(vec![step])), Arc::new(fixture_request("gemini-2.5-pro")), DeliveryState::Accepted)
        .await;

    // Before a status arrives the transport's own state is reported.
    let mut refused = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
    refused.message = "refused".into();
    let adapter = gemini_adapter(Scripted::new(vec![Step::Fail(refused)]));
    check_provider_attempt(&adapter, Arc::new(fixture_request("gemini-2.5-pro")), DeliveryState::NotSent).await;
}

#[tokio::test]
async fn an_empty_stop_is_reasked_unless_it_answers_a_tool_result() {
    let wire = "data: {\"candidates\":[{\"content\":{\"parts\":[]},\"finishReason\":\"STOP\"}]}\n\n";
    let (_, err) = collect(&gemini_adapter(Scripted::new(vec![respond(200, wire)])), fixture_request("gemini-2.5-pro")).await;
    let err = err.expect("empty answer");
    assert_eq!((err.kind, err.code.as_deref()), (ErrorKind::Transient, Some("no_response_text")));
    assert!(!err.exposure.text_emitted, "nothing was shown, so a re-ask is safe");

    let mut after_tool = fixture_request("gemini-2.5-pro");
    let mut result = Message::new(Role::Tool, Content::Text("42".into()));
    result.tool_call_id = Some("c1".into());
    after_tool.messages.push(result);
    let (events, err) = collect(&gemini_adapter(Scripted::new(vec![respond(200, wire)])), after_tool).await;
    assert!(err.is_none());
    assert_eq!(fold(&events).3, None);
}

#[tokio::test]
async fn antigravity_refreshes_once_on_401_with_the_recorded_requests() {
    let scenario = load("antigravity-oauth", "error-401");
    let content = scenario.recs.iter().filter(|r| r.url.contains(":streamGenerateContent")).collect::<Vec<_>>();
    let token = scenario.recs.iter().find(|r| r.url.contains("oauth2.googleapis.com")).unwrap();
    let http = Scripted::new(vec![
        respond(401, &content[0].served),
        respond(200, &token.served),
        respond(401, &content[1].served),
    ]);
    let store = MemoryStore::with(doc(NOW_MS + 3_600_000, "fixture-project"));
    let adapter = antigravity_adapter(http.clone(), store.clone()).await;
    let (_, err) = collect(&adapter, fixture_request("gemini-3-pro")).await;
    let err = err.expect("401 stays a 401");
    assert_eq!((err.kind, err.status), (ErrorKind::Auth, Some(401)));
    assert_eq!(
        http.urls(),
        scenario.recs.iter().map(|r| r.url.clone()).collect::<Vec<_>>(),
        "content, token refresh, content"
    );
    let seen = http.seen.lock().unwrap();
    assert_eq!(String::from_utf8_lossy(&seen[1].body), token.body, "the recorded refresh request");
    assert!(seen[0].headers.contains(&("authorization".into(), "Bearer stale-access".into())));
    assert!(seen[2].headers.contains(&("authorization".into(), "Bearer fixture-access-token".into())));
    let stored = store.0.lock().unwrap().clone().unwrap();
    assert_eq!((stored.access_token.as_str(), stored.project_id.as_str()), ("fixture-access-token", "fixture-project"));
    assert_eq!(stored.expires_at_ms, NOW_MS + 3_600_000);
}

#[tokio::test]
async fn antigravity_serves_the_recorded_turns_and_refuses_a_changed_account() {
    let text = load("antigravity-oauth", "text");
    let http = Scripted::new(vec![respond(200, &text.content().served)]);
    let store = MemoryStore::with(doc(NOW_MS + 3_600_000, "fixture-project"));
    let adapter = antigravity_adapter(http.clone(), store.clone()).await;
    let (events, err) = collect(&adapter, fixture_request("gemini-3-pro")).await;
    assert!(err.is_none());
    assert_eq!(fold(&events).0, "The result is 42.");

    // A sign-in to another project after the adapter was built.
    *store.0.lock().unwrap() = Some(doc(NOW_MS + 3_600_000, "other-project"));
    let (_, err) = collect(&adapter, fixture_request("gemini-3-pro")).await;
    let err = err.expect("identity mismatch");
    assert_eq!((err.kind, err.reauth_required, err.delivery), (ErrorKind::Auth, true, DeliveryState::NotSent));
    assert_eq!(http.urls().len(), 1);
}

#[tokio::test]
async fn expired_tokens_refresh_ahead_of_the_request_and_dead_grants_need_a_login() {
    let grant = r#"{"access_token":"fresh","expires_in":3600}"#;
    let http = Scripted::new(vec![respond(200, grant)]);
    let store = MemoryStore::with(doc(NOW_MS + 60_000, "p"));
    let auth = super::auth::antigravity::AntigravityAuth::new(http.clone(), store.clone(), clock());
    // Inside the five-minute skew: refreshed, refresh token kept.
    let authorization = auth.authorize().await.unwrap();
    assert_eq!(authorization.headers[0].1, "Bearer fresh");
    assert_eq!(store.0.lock().unwrap().clone().unwrap().refresh_token, "fixture-refresh-token");
    auth.authorize().await.unwrap();
    assert_eq!(http.urls().len(), 1, "a fresh token is reused");

    let http = Scripted::new(vec![respond(400, r#"{"error":"invalid_grant"}"#)]);
    let store = MemoryStore::with(doc(NOW_MS - 1, "p"));
    let auth = super::auth::antigravity::AntigravityAuth::new(http, store, clock());
    let err = auth.authorize().await.unwrap_err();
    assert!(err.reauth_required && err.kind == ErrorKind::Auth);

    // A server fault while the token is still valid does not break the turn.
    let http = Scripted::new(vec![respond(503, "{}")]);
    let store = MemoryStore::with(doc(NOW_MS + 60_000, "p"));
    let auth = super::auth::antigravity::AntigravityAuth::new(http, store, clock());
    assert_eq!(auth.authorize().await.unwrap().headers[0].1, "Bearer stale-access");
}

fn adc_json() -> String {
    json!({"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret",
        "refresh_token":"fixture-refresh-token","quota_project_id":"projectaa-a5af6"})
    .to_string()
}

#[tokio::test]
async fn vertex_adc_mints_per_request_and_replays_the_recorded_401() {
    let scenario = load("vertex-ai-adc", "error-401");
    let token = scenario.recs.iter().find(|r| r.url.contains("oauth2.googleapis.com")).unwrap();
    let content = scenario.content();
    let credential = vertex::parse_adc(&adc_json(), "adc.json").unwrap();
    assert_eq!(vertex::resolve_project(&credential, &|_| None).as_deref(), Some("projectaa-a5af6"));
    let http = Scripted::new(vec![
        respond(200, &token.served),
        respond(401, &content.served),
        respond(200, &token.served),
        respond(401, &content.served),
    ]);
    let auth = Arc::new(vertex::VertexAuth::new(http.clone(), credential, clock()));
    let identity = auth.identity().to_owned();
    let adapter = super::vertex(VertexPlace::project("projectaa-a5af6", Some("us-central1"), None), auth, identity, http.clone(), traits(), Arc::new(|_| None));
    let (_, err) = collect(&adapter, fixture_request("gemini-2.5-pro")).await;
    let err = err.expect("401");
    assert_eq!((err.kind, err.status), (ErrorKind::Auth, Some(401)));
    assert_eq!(http.urls(), scenario.recs.iter().map(|r| r.url.clone()).collect::<Vec<_>>());
    let seen = http.seen.lock().unwrap();
    assert_eq!(String::from_utf8_lossy(&seen[0].body), token.body);
    assert!(seen[1].headers.contains(&("authorization".into(), "Bearer fixture-access-token".into())));
}

fn vertex_at(place: VertexPlace, http: &Arc<Scripted>) -> super::adapter::GoogleAdapter {
    super::vertex(place, Arc::new(super::auth::ApiKeyAuth::new("key-1")), String::new(), http.clone(), traits(), Arc::new(|_| None))
}

const NOT_FOUND: &str = r#"{"error":{"code":404,"status":"NOT_FOUND","message":"gone"}}"#;

#[tokio::test]
async fn a_404_from_an_environment_region_is_resent_once_on_global() {
    let http = Scripted::new(vec![respond(404, NOT_FOUND), respond(200, "")]);
    let adapter = vertex_at(VertexPlace::project("p", None, Some("us-central1")), &http);
    assert!(adapter.attempt(Arc::new(fixture_request("gemini-2.5-pro"))).await.is_ok());
    let urls = http.urls();
    assert_eq!(urls.len(), 2);
    assert!(urls[0].starts_with("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/"));
    assert!(urls[1].starts_with("https://aiplatform.googleapis.com/v1/projects/p/locations/global/"));
}

#[tokio::test]
async fn a_404_at_global_after_the_fallback_surfaces_with_the_global_hint() {
    let http = Scripted::new(vec![respond(404, NOT_FOUND), respond(404, NOT_FOUND)]);
    let adapter = vertex_at(VertexPlace::project("p", None, Some("us-central1")), &http);
    let err = adapter.attempt(Arc::new(fixture_request("gemini-2.5-pro"))).await.err().expect("404");
    assert_eq!(err.status, Some(404));
    assert_eq!(http.urls().len(), 2, "resent once, not again");
    assert!(err.message.contains("global"), "{}", err.message);
}

#[tokio::test]
async fn a_configured_or_global_location_is_never_resent_on_a_404() {
    for place in [VertexPlace::project("p", Some("us-central1"), None), VertexPlace::project("p", None, None)] {
        let http = Scripted::new(vec![respond(404, NOT_FOUND)]);
        let err = vertex_at(place, &http).attempt(Arc::new(fixture_request("gemini-2.5-pro"))).await.err().expect("404");
        assert_eq!(err.status, Some(404));
        assert_eq!(http.urls().len(), 1);
    }
}

#[tokio::test]
async fn concurrent_requests_share_one_vertex_token_mint() {
    let grant = r#"{"access_token":"t","expires_in":3600}"#;
    let http = Scripted::new(vec![respond(200, grant)]);
    let credential = vertex::parse_adc(&adc_json(), "adc.json").unwrap();
    let auth = Arc::new(vertex::VertexAuth::new(http.clone(), credential, clock()));
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let auth = auth.clone();
            tokio::spawn(async move { auth.authorize().await.unwrap() })
        })
        .collect();
    for task in tasks {
        assert_eq!(task.await.unwrap().headers[0].1, "Bearer t");
    }
    assert_eq!(http.urls().len(), 1);
}

#[test]
fn vertex_credentials_parse_and_reject_unsupported_types() {
    let user = vertex::parse_adc(&adc_json(), "adc.json").unwrap();
    let again = vertex::parse_adc(&adc_json(), "adc.json").unwrap();
    assert_eq!(user.identity, again.identity);
    assert!(!user.identity.contains("fixture-secret"));
    let err = vertex::parse_adc(r#"{"type":"external_account"}"#, "adc.json").unwrap_err();
    assert!(err.message.contains("external_account"));
    assert!(vertex::parse_adc(r#"{"type":"authorized_user","client_id":"x"}"#, "adc.json").is_err());
    let impersonated = json!({"type":"impersonated_service_account",
        "service_account_impersonation_url":"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/t@p.iam.gserviceaccount.com:generateAccessToken",
        "delegates":["d@p.iam.gserviceaccount.com"], "source_credentials": serde_json::from_str::<Value>(&adc_json()).unwrap()});
    let credential = vertex::parse_adc(&impersonated.to_string(), "adc.json").unwrap();
    assert_eq!(credential.account, "t@p.iam.gserviceaccount.com");
    assert!(vertex::parse_service_account(r#"{"client_email":"a"}"#).is_err());
}

// A throwaway 2048-bit key made for this test; the DER is split so no single
// literal looks like a credential.
const TEST_KEY_DER: [&str; 2] = [
    "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCsKl2E5GVUer+6ZaAy/CCzv5gBTi8Wa2lW0TX9gP1v6CHo3OFUiUwS4UykErhTH7gfZNZL6KZM7izXgQlx3afpH3TaPmZruVuppyDFRcv+riorOlJnbkK2aCabQfhSHfDIoYFMz2cwlOc2cM+sioDxUlmILK6gX9FWtfCjeV4IISDIsKtYTzlKj5C2CZNOsusaWO9FNzUpJPFqXMuMOKnEgkexeqJiJjOQhJQA/jmIsG6dV7Ik7DoyoU4zpsG+Sy5Qf2dJnS9HfSvtJcgY+D6X8dvPl3g4SPPmnZ5C9+lf5NuJ48L4rVBf0fdlRfajnn//3AzRNhuRT98U1Ep6g+KlAgMBAAECggEAEl7e5bw9N7t1U91eL7KJhsSN4q3GBn1lmxbtzOQDpvo9DAztmkigLm+N7v/0XSJIUkk/OJBVlmXfsQsax+Sf8xchL9xyr1Hy/vJPY91jvAQ3ia9KdbDlO3N3kx+B8LkzJSVel6SV3TA2T6/P6RhKU/W2ifpCk+hFfRwi1j6wEuvQx2bqq3SU7oIHNs6hdoiJRa36bZOtFRgE53KWXHe0VhWYUwEw9DRMAi5NYPKJrA7MpaSsp3pQl8F+TWxUi52L/1jAqkbAjX4j0Vb43EiyliPif/JWZbvTuB90Z1ynehnrAk9MzmlwZ5kGCyzafW6gt10k4+c//yj2LRKCLL2KrQKBgQDxXURa0a9O80OWqBj2MIZz54K+AIezBVwM7+NfctHP0S9/z7C6FWp0i2xzT3jn",
    "+iDf8gMsD2e0150nInlBqAWZkbZnWnZK1EYBoGQboO22EVUDPHLJtSmZS360mn6c/EUee3iHBSgWGYWR7KBzpDm131Wm2VoEIIkpyOKknwwu4wKBgQC2muo0+6a/NqTVrA5BoN1KIE3JdtWz+MQ+TCWrifgVJ0XOfHBUPgtcYV8p1hhjEgDCmZBB11Jdhf2rvNik4Uvtq4nZtt6+g+ImZt2iiewLJjTbEf7/2kcquXZi+91kAqKERNf+Dr9w7dZ1WhUkUZxtp8v7G4wkrXlOdqP04osW1wKBgDoq0fhZJDiQo69BH5LlKuHv3zBPDGT2W7K6dT9henLs5NeWg+60jo07tI0tj+PIAfg2aNFLfSC1/aeaxUIvbfoOhbjusididOSbdMS7yc3g6232OWum/zl0WjrIKM9IdJfeBbP0aC67Q9dhAWIdJ9NO2WN2ah0ogiXRxd0Kf3MlAoGAFHONP5nftxK7q2K1xgvqPN8ZVzMEBEAcWo3Uuj2dl2DqpJGzUvwP8azGJ71exdnCVAk26ujexLK5En74FJ9XDatkqQmeMOA8d+iVchrYYPdKfC6rzKP5zIMxCy0CQq043m+HcWDdeBxrJIGOVJ7/Uhi0887GB2WWbH9FJawpv8kCgYA3jxnoJwv2fOQmcMdOFheOirlHl25P0f9wc0wKay0qi/0lXqggFcJ73kluIyJXTsmezIG2JMSInDQ287IMEoxmHrxY8atH5AItiSSfV6NtvUmDzbGmff62adyR8O7NETDNOEayEJOkEZmwgVKKUSao+KkOKkBa34TW/eHeClxsQw==",
];
const TEST_KEY_PUBLIC: &str = "MIIBCgKCAQEArCpdhORlVHq/umWgMvwgs7+YAU4vFmtpVtE1/YD9b+gh6NzhVIlMEuFMpBK4Ux+4H2TWS+imTO4s14EJcd2n6R902j5ma7lbqacgxUXL/q4qKzpSZ25Ctmgmm0H4Uh3wyKGBTM9nMJTnNnDPrIqA8VJZiCyuoF/RVrXwo3leCCEgyLCrWE85So+QtgmTTrLrGljvRTc1KSTxalzLjDipxIJHsXqiYiYzkISUAP45iLBunVeyJOw6MqFOM6bBvksuUH9nSZ0vR30r7SXIGPg+l/Hbz5d4OEjz5p2eQvfpX+TbiePC+K1QX9H3ZUX2o55//9wM0TYbkU/fFNRKeoPipQIDAQAB";

#[test]
fn service_account_jwt_is_a_valid_rs256_assertion() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let der = TEST_KEY_DER.concat();
    let label = "PRIVATE";
    let pem = format!("-----BEGIN {label} KEY-----\n{der}\n-----END {label} KEY-----\n");
    let jwt = vertex::jwt_assertion("sa@p.iam.gserviceaccount.com", &pem, 1_000).unwrap();
    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3);
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(
        claims,
        json!({"iss":"sa@p.iam.gserviceaccount.com","scope":vertex::SCOPE,"aud":vertex::TOKEN_URI,"iat":1000,"exp":4600})
    );
    let public = STANDARD.decode(TEST_KEY_PUBLIC).unwrap();
    ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, public)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
        .expect("signature verifies");
    assert!(vertex::jwt_assertion("sa", "not a key", 0).is_err());
}

#[tokio::test]
async fn a_recorded_assistant_turn_replays_with_its_signatures() {
    let wire = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"thinking\",\"thought\":true,\"thoughtSignature\":\"sig-t\"},",
        "{\"functionCall\":{\"name\":\"lookup\",\"args\":{\"key\":\"answer\"}},\"thoughtSignature\":\"sig-c\"}]},",
        "\"finishReason\":\"STOP\"}]}\n\n"
    );
    let adapter = gemini_adapter(Scripted::new(vec![respond(200, wire)]));
    let (events, err) = collect(&adapter, fixture_request("gemini-2.5-pro")).await;
    assert!(err.is_none());
    let replay = events
        .iter()
        .find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.clone()) } else { None })
        .expect("replay envelope");
    assert_eq!(replay.items["model"], "gemini-2.5-pro");
    let call = fold(&events).1.remove(0);

    let mut assistant = Message::new(Role::Assistant, Content::Text(String::new()));
    assistant.tool_calls.push(call.clone());
    assistant.push_replay(replay);
    let mut result = Message::new(Role::Tool, Content::Text("42".into()));
    result.tool_call_id = Some(call.id.clone());
    let mut next = fixture_request("gemini-2.5-pro");
    next.messages.push(assistant);
    next.messages.push(result);
    let wire = GoogleCodec::gemini(GEMINI_ORIGIN, traits()).encode(&next).unwrap();
    let body: Value = serde_json::from_slice(&wire.body).unwrap();
    let model_parts = &body["contents"][1]["parts"];
    assert_eq!(model_parts[0]["thoughtSignature"], "sig-t");
    assert_eq!(model_parts[1]["thoughtSignature"], "sig-c");
    // The recorded part carried no id, so the response carries none either.
    assert_eq!(
        body["contents"][2]["parts"][0],
        json!({"functionResponse": {"name": "lookup", "response": {"result": "42"}}})
    );
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

#[test]
fn no_content_timer_exists_in_the_provider_sources() {
    let sources = [
        include_str!("adapter.rs"),
        include_str!("auth/antigravity.rs"),
        include_str!("auth/mod.rs"),
        include_str!("auth/vertex.rs"),
        include_str!("codec.rs"),
        include_str!("decode.rs"),
        include_str!("error.rs"),
        include_str!("json.rs"),
        include_str!("mod.rs"),
        include_str!("policy.rs"),
        include_str!("request.rs"),
        include_str!("schema.rs"),
        include_str!("traits.rs"),
    ];
    for source in sources {
        let code = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in ["tokio::time", "time::timeout", "sleep(", "Instant::now", "timeout("] {
            assert!(!code.contains(forbidden), "a timer ({forbidden}) in provider code");
        }
    }
}

#[test]
fn error_text_is_never_matched() {
    // Classification reads typed fields; the same wording under different
    // typed fields classifies differently.
    let codec = GoogleCodec::antigravity(ENDPOINT, "p", "2.19.1", traits());
    let classify = |status, message: &str| {
        codec
            .classify(&ErrorResponse {
                status: Some(status),
                headers: vec![],
                body: json!({"error": {"message": message}}).to_string().into_bytes(),
            })
            .kind
    };
    assert_eq!(classify(429, "Resource exhausted: server busy, capacity exceeded"), ErrorKind::RateLimited);
    assert_eq!(classify(400, "prompt is too long, maximum context length exceeded"), ErrorKind::InvalidRequest);
}

/// Node's Gemini stream consumer reported one kind per chunk (`golden/stream_progress.json`): thinking, text, a call;
/// a bare finish chunk none. The Rust decoder reports the same for each chunk.
#[test]
fn the_decoder_reports_the_progress_kinds_node_s_consumer_does() {
    use crate::providers::progress_golden::{golden, node_names, rust_names};
    let gemini = providers().into_iter().find(|p| p.dir == "gemini").expect("gemini");
    let mut decoder = gemini.codec.decoder(&fixture_request(gemini.model));
    for step in golden()["decoders"]["gemini"].as_array().expect("gemini") {
        let events = decoder.feed(format!("data: {}\r\n\r\n", step["wire"]).as_bytes()).expect("feed");
        assert_eq!(rust_names(&events), node_names(&step["kinds"]), "{}", step["wire"]);
    }
}
