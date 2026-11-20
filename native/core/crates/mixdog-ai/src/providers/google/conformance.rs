//! Recorded-fixture conformance of the Google providers: the intercepted
//! exchanges of the Node implementation under
//! `fixtures/providers-intercepted/{gemini,vertex-ai-adc,vertex-ai-api-key,
//! antigravity-oauth}` are replayed against the codec, the adapters and the
//! retry rows.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
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
use super::policy;
use super::serving::VertexPlace;
use super::traits::ModelTraits;
use super::traits::ThinkingControl;
use crate::transport::BodyStream;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

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

// Fixtures

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

// The four recorded providers

const VERTEX_ADC_BASE: &str = "https://us-central1-aiplatform.googleapis.com/v1/projects/projectaa-a5af6/locations/us-central1";

#[test]
fn vertex_project_base_matches_the_recording() {
    assert_eq!(vertex::project_base("projectaa-a5af6", "us-central1").unwrap(), VERTEX_ADC_BASE);
    assert_eq!(vertex::project_base("p", "global").unwrap(), "https://aiplatform.googleapis.com/v1/projects/p/locations/global");
    assert_eq!(vertex::project_base("p", "eu").unwrap(), "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu");
    assert!(vertex::project_base("p", "us/../x").is_err());
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

// Retry rows against the recorded sleeps

fn delays(error: &ProviderError, policy: &RetryPolicy, class: RetryClass, samples: impl Fn(usize) -> JitterSamples) -> (Vec<u64>, Verdict) {
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
    assert_eq!(overloaded.len(), 15, "503 runs the inner ladder (3), then a capacity retry (1) that restarts it, three times, then a last ladder");
}

// Adapters over scripted HTTP

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
    async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
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

fn big_request() -> ModelRequest {
    let say = |role, t: String| Message::new(role, Content::Text(t));
    let mut request = fixture_request("gemini-2.5-pro");
    request.messages =
        vec![say(Role::System, "x".repeat(12_000)), say(Role::User, "first".into()), say(Role::Assistant, "second".into()), say(Role::User, "third".into())];
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

/// `refreshTokens`: any 400 or 401 asks for a sign-in, worded with the status and the redacted body.
#[tokio::test]
async fn a_refused_antigravity_refresh_names_its_status_and_body() {
    let http = Scripted::new(vec![respond(401, r#"{"error":"nope","refresh_token":"leaked-refresh"}"#)]);
    let store = MemoryStore::with(doc(NOW_MS - 1, "p"));
    let auth = super::auth::antigravity::AntigravityAuth::new(http, store, clock());
    let err = auth.authorize().await.unwrap_err();
    assert!(err.reauth_required);
    assert_eq!(err.message, r#"[antigravity-oauth] token refresh 401: {"error":"nope","refresh_token":"[REDACTED]"}"#);
}

fn adc_json() -> String {
    json!({"type":"authorized_user","client_id":"fixture-client","client_secret":"fixture-secret",
        "refresh_token":"fixture-refresh-token","quota_project_id":"projectaa-a5af6"})
    .to_string()
}

const NOT_FOUND: &str = r#"{"error":{"code":404,"status":"NOT_FOUND","message":"gone"}}"#;

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
    assert_eq!(claims, json!({"iss":"sa@p.iam.gserviceaccount.com","scope":vertex::SCOPE,"aud":vertex::TOKEN_URI,"iat":1000,"exp":4600}));
    let public = STANDARD.decode(TEST_KEY_PUBLIC).unwrap();
    ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, public)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
        .expect("signature verifies");
    assert!(vertex::jwt_assertion("sa", "not a key", 0).is_err());
}

#[test]
fn error_wording_sets_only_the_codes_node_reads_it_for() {
    // The kind is read from typed fields; wording counts only where Node's `antigravityError` reads it (capacity or
    // rate-limit wording on an untyped 429), never for a context overflow.
    let codec = GoogleCodec::antigravity(ENDPOINT, "p", "2.19.1", traits());
    let classify = |status, message: &str| {
        codec.classify(&ErrorResponse { status: Some(status), headers: vec![], body: json!({"error": {"message": message}}).to_string().into_bytes() }).kind
    };
    assert_eq!(classify(429, "Resource exhausted: server busy, capacity exceeded"), ErrorKind::Overloaded);
    assert_eq!(classify(400, "prompt is too long, maximum context length exceeded"), ErrorKind::InvalidRequest);
}

fn gemini_adapter(http: Arc<Scripted>) -> super::adapter::GoogleAdapter {
    super::gemini("key-1", http, traits())
}
fn cached_adapter(steps: Vec<Step>) -> (super::adapter::GoogleAdapter, Arc<Scripted>) {
    use super::cache::layer::ExplicitCache;
    use super::cache::policy::Tuning;
    use super::cache::registry::Registry;

    let http = Scripted::new(steps);
    let cache =
        ExplicitCache::new("key-1", super::codec::GEMINI_ORIGIN, http.clone(), Arc::new(TokioRuntime), Arc::new(Registry::default()), Tuning::default());
    (super::gemini("key-1", http.clone(), traits()).with_cache(cache), http)
}
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
fn vertex_at(place: VertexPlace, http: &Arc<Scripted>) -> super::adapter::GoogleAdapter {
    super::vertex(place, Arc::new(super::auth::ApiKeyAuth::new("key-1")), String::new(), http.clone(), traits(), Arc::new(|_| None))
}
/// `accessError`: a gcloud login's 403 for a missing permission says which role to grant; `invalid_grant` on the
/// gcloud refresh token says to sign in again (vertex-ai-auth.mjs `_grant`).
#[tokio::test]
async fn a_gcloud_logins_refusals_say_what_to_do() {
    let denied = r#"{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission 'aiplatform.endpoints.predict' denied on resource."}}"#;
    let http = Scripted::new(vec![respond(403, denied)]);
    let place = VertexPlace::project("p", Some("us-central1"), None).with_gcloud_principal("The gcloud account me@example.com");
    let err = vertex_at(place, &http).attempt(Arc::new(fixture_request("gemini-2.5-pro"))).await.err().expect("403");
    assert_eq!(err.status, Some(403));
    assert!(
        err.message.starts_with(
            "[vertex-ai] The gcloud account me@example.com does not have permission to use Vertex AI in project p. \
             Grant it the Vertex AI User role (roles/aiplatform.user), then try again. (HTTP 403: "
        ),
        "{}",
        err.message
    );

    let http = Scripted::new(vec![respond(400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#)]);
    let credential = vertex::parse_adc(&adc_json(), "adc.json").unwrap();
    let err = vertex::VertexAuth::new(http, credential, clock()).authorize().await.unwrap_err();
    assert_eq!(
        err.message,
        "Vertex AI authentication failed: the gcloud login has expired or was revoked (Token has been expired or revoked.). \
         Run `gcloud auth application-default login` again."
    );
    assert_eq!(err.status, Some(400));
}
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
async fn a_recorded_assistant_turn_replays_with_its_signatures() {
    let wire = concat!(
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"thinking\",\"thought\":true,\"thoughtSignature\":\"sig-t\"},",
        "{\"functionCall\":{\"name\":\"lookup\",\"args\":{\"key\":\"answer\"}},\"thoughtSignature\":\"sig-c\"}]},",
        "\"finishReason\":\"STOP\"}]}\n\n"
    );
    let adapter = gemini_adapter(Scripted::new(vec![respond(200, wire)]));
    let (events, err) = collect(&adapter, fixture_request("gemini-2.5-pro")).await;
    assert!(err.is_none());
    let replay = events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.clone()) } else { None }).expect("replay envelope");
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
    assert_eq!(body["contents"][2]["parts"][0], json!({"functionResponse": {"name": "lookup", "response": {"result": "42"}}}));
}
// Structure

/// The stream's content windows Node has (`createRestStreamWatchdogs`) live in `watchdog.rs` on the runtime's clock
/// (`mixdog_rt::Deadline`); no provider source holds a timer of its own.
#[test]
fn no_content_timer_exists_in_the_provider_sources() {
    let sources = [
        include_str!("watchdog.rs"),
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
