use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::{
    Content, DeliveryState, ErrorKind, Exposure, Message, ModelRequest, ModelStream, ProviderAdapter, ProviderError, RequestOptions, Role, StreamEvent,
    TransportFault, WireCodec, WireRequest,
};
use serde_json::{Value, json};

use super::auth::{Authorization, RequestAuth};
use super::codec::{Attach, GEMINI_ORIGIN, GoogleCodec};
use super::serving::VertexPlace;
use super::traits::{CatalogGoogleTraits, ModelTraits};
use crate::transport::{BodyStream, Exchange, HttpResponse, HttpSend};

fn traits() -> Arc<dyn ModelTraits> {
    Arc::new(CatalogGoogleTraits(Vec::new()))
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "gemini-3.6-flash".into(),
        messages: vec![Message::new(Role::User, Content::Text("hello".into()))],
        tools: vec![],
        options: RequestOptions::default(),
    }
}

#[test]
fn express_rejects_explicit_non_global_location_before_any_send() {
    let http = Arc::new(Script::default());
    for location in [None, Some(" GLOBAL ")] {
        let adapter = super::vertex_express_at("fixture", location, http.clone(), traits());
        let wire = adapter.codec().encode(&request()).unwrap();
        assert_eq!(wire.url, "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.6-flash:streamGenerateContent?alt=sse");
    }
    let adapter = super::vertex_express_at("fixture", Some("us-central1"), http, traits());
    let err = adapter.codec().encode(&request()).unwrap_err();
    assert_eq!((err.kind, err.delivery), (ErrorKind::InvalidRequest, DeliveryState::NotSent));
    assert!(err.message.contains("serves only the global location"));
}

#[test]
fn safety_settings_follow_supported_generate_bodies_without_changing_defaults() {
    let api = GoogleCodec::gemini(GEMINI_ORIGIN, traits());
    let vertex = GoogleCodec::vertex(VertexPlace::express(), traits());
    let gateway = GoogleCodec::gemini("https://gateway.invalid", traits()).with_error_label("OpenCode Go Gemini streamGenerateContent");
    let antigravity = GoogleCodec::antigravity("https://gateway.invalid", "project", "1.0.0", traits());
    let body = |codec: &GoogleCodec, request: &ModelRequest| -> Value { serde_json::from_slice(&codec.encode(request).unwrap().body).unwrap() };
    let mut request = request();
    let settings = json!([{ "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_LOW_AND_ABOVE" }]);
    for params in [None, Some(json!({"safetySettings": null})), Some(json!({"safetySettings": []}))] {
        request.options.model_parameters = params;
        assert!(body(&api, &request).get("safetySettings").is_none());
    }
    request.options.model_parameters = Some(json!({"safetySettings": settings.clone()}));
    for codec in [&api, &vertex, &gateway] {
        assert_eq!(body(codec, &request)["safetySettings"], settings);
    }
    assert!(body(&antigravity, &request)["request"].get("safetySettings").is_none());
    let inner = api.build_inner(&request).unwrap();
    let state = mixdog_core_api::domain::provider::GeminiCacheState {
        cache_name: "cachedContents/fixture".into(),
        cache_created_at: 0,
        cache_created_at_iter: 0,
        cache_expires_at: 0,
        cache_model: request.model.clone(),
        cache_token_size: 0,
        cache_prefix_content_count: 0,
        cache_prefix_hash: String::new(),
        cache_credential_fingerprint: String::new(),
    };
    let wire = api.wire(&request, &inner, Some(Attach { name: &state.cache_name, state: &state })).unwrap();
    let cached: Value = serde_json::from_slice(&wire.body).unwrap();
    assert_eq!(cached["safetySettings"], settings);
    assert_eq!(cached["cachedContent"], "cachedContents/fixture");
    request.options.model_parameters = Some(json!({"safetySettings": {}}));
    assert_eq!(api.encode(&request).unwrap_err().kind, ErrorKind::InvalidRequest);
}

#[derive(Default)]
struct Script {
    sent: Mutex<Vec<WireRequest>>,
    replies: Mutex<VecDeque<(u16, Chunks)>>,
}

impl Script {
    fn answer(&self, status: u16, chunks: impl IntoIterator<Item = Result<Bytes, TransportFault>>) {
        self.replies.lock().unwrap().push_back((status, Chunks(chunks.into_iter().collect())));
    }
}

struct Chunks(VecDeque<Result<Bytes, TransportFault>>);

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front()
    }
}

#[async_trait]
impl HttpSend for Script {
    async fn send(&self, wire: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(wire);
        let (status, chunks) = self.replies.lock().unwrap().pop_front().expect("unexpected send");
        Ok(HttpResponse { status, headers: vec![], body: Box::new(chunks) })
    }
}

struct Bound;

#[async_trait]
impl RequestAuth for Bound {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        Ok(Authorization { headers: vec![("Authorization".into(), "Bearer fixture".into())], identity: "account".into() })
    }

    async fn rejected(&self, _: &Authorization) -> bool {
        false
    }
}

async fn failure(stream: &mut dyn ModelStream) -> ProviderError {
    while let Some(event) = stream.next().await {
        match event {
            Err(error) => return error,
            Ok(StreamEvent::Completed { .. }) => panic!("expected a failed turn"),
            Ok(_) => {}
        }
    }
    panic!("stream closed without a failure");
}

#[tokio::test]
async fn eligible_vertex_gemini_unary_recovery_keeps_the_selected_location_and_account() {
    let http = Arc::new(Script::default());
    http.answer(404, []);
    http.answer(200, [Ok(Bytes::from_static(b"data: {\"candidates\":[{}]}\n\n"))]);
    http.answer(200, [Ok(Bytes::from_static(b"{\n\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"text\":\"recovered\"}]}}]\n}"))]);
    let mut request = request();
    request.options.send_group = Some("send".into());
    request.options.model_parameters = Some(json!({"serviceTier": "priority"}));
    // Priority is served in `us`, rather than a single region. Let it fall back from `us` to global.
    let adapter =
        super::vertex(VertexPlace::project("project", None, Some("us")), Arc::new(Bound), "account".into(), http.clone(), traits(), Arc::new(|_| None));
    let request = Arc::new(request);
    let err = failure(adapter.attempt(request.clone()).await.unwrap().as_mut()).await;
    assert!(adapter.recovers_spent(&request, &err));
    for exposure in [Exposure { tool_dispatched: true, ..Exposure::default() }, Exposure { tool_input_cut: true, ..Exposure::default() }] {
        let mut unsafe_failure = err.clone();
        unsafe_failure.exposure = exposure;
        assert!(!adapter.recovers_spent(&request, &unsafe_failure));
    }
    let mut long_wait = err.clone();
    long_wait.retry_after = Some(std::time::Duration::from_secs(301));
    assert!(!adapter.recovers_spent(&request, &long_wait));
    assert!(!adapter.recovers_spent(&ModelRequest { model: "anthropic/claude-sonnet-4".into(), ..(*request).clone() }, &err));
    assert!(!adapter.recovers_spent(&ModelRequest { model: "openai/gpt-oss-120b-maas".into(), ..(*request).clone() }, &err));
    let mut recovered = adapter.recover_spent(request).await.unwrap();
    let mut text = String::new();
    let mut completed = false;
    while let Some(event) = recovered.next().await {
        match event.unwrap() {
            StreamEvent::TextDelta(delta) => text.push_str(&delta),
            StreamEvent::Completed { .. } => completed = true,
            _ => {}
        }
    }
    assert!(completed);
    assert_eq!(text, "recovered");
    let sent = http.sent.lock().unwrap();
    assert_eq!(sent.len(), 3);
    assert!(sent[0].url.contains("/locations/us/"));
    assert_eq!(sent[2].url, "https://aiplatform.googleapis.com/v1/projects/project/locations/global/publishers/google/models/gemini-3.6-flash:generateContent");
    assert_eq!(sent[2].headers, sent[1].headers);
    assert_eq!(sent[2].body, sent[1].body);
}

#[tokio::test]
async fn vertex_terminal_failures_carry_reported_usage_without_completing_the_turn() {
    let http = Arc::new(Script::default());
    let usage = Bytes::from_static(
        b"data: {\"usageMetadata\":{\"promptTokenCount\":20,\"cachedContentTokenCount\":5,\"candidatesTokenCount\":8,\"thoughtsTokenCount\":3}}\n\n",
    );
    for end in [Ok(Bytes::from_static(b"data: {\"candidates\":[{\"finishReason\":\"SAFETY\"}]}\n\n")), Err(TransportFault::TruncatedStream)] {
        http.answer(200, [Ok(usage.clone()), end]);
    }
    let adapter = super::vertex_express_at("fixture", None, http, traits());
    let request = Arc::new(request());
    for kind in [Some(ErrorKind::Policy), None] {
        let err = failure(adapter.attempt(request.clone()).await.unwrap().as_mut()).await;
        if let Some(kind) = kind {
            assert_eq!(err.kind, kind);
            assert!(!adapter.recovers_spent(&request, &err));
        } else {
            assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
        }
        assert_eq!(err.partial_model.as_deref(), Some("gemini-3.6-flash"));
        let usage = err.partial_usage.clone().expect("reported tokens belong to the failed attempt");
        assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens, usage.reasoning_tokens), (15, 5, 11, Some(3)));
    }
}

fn usage_frame(metadata: Value) -> Bytes {
    Bytes::from(format!("data: {}\n\n", json!({"usageMetadata": metadata})))
}

#[test]
fn sparse_usage_folds_by_token_family_and_new_zero_wins_across_aliases() {
    let api = GoogleCodec::gemini(GEMINI_ORIGIN, traits());
    let vertex = GoogleCodec::vertex(VertexPlace::express(), traits());
    let antigravity = GoogleCodec::antigravity("https://gateway.invalid", "project", "1.0.0", traits());
    let request = request();
    for (codec, envelope, expected_input) in [(&api, false, 22), (&vertex, false, 22), (&antigravity, true, 22)] {
        let mut decoder = codec.decoder(&request);
        let frame = |chunk: Value| {
            let data = if envelope { json!({"response": chunk}) } else { chunk };
            format!("data: {data}\n\n")
        };
        for chunk in [
            json!({"usageMetadata": {"promptTokenCount": 20, "toolUsePromptTokenCount": 2, "cachedContentTokenCount": 5, "thoughtsTokenCount": 3}}),
            json!({"usageMetadata": {"candidatesTokenCount": 8, "cachedContentTokenCount": null}}),
        ] {
            assert!(decoder.feed(frame(chunk).as_bytes()).unwrap().iter().all(|event| !matches!(event, StreamEvent::Usage(_))));
        }
        let interim = decoder
            .feed(
                frame(json!({"usageMetadata": {"cached_content_token_count": 0, "thoughts_token_count": 0},
            "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "done"}]}}]}))
                .as_bytes(),
            )
            .unwrap();
        assert!(interim.iter().all(|event| !matches!(event, StreamEvent::Usage(_))));
        let done = decoder.finish().unwrap();
        let usages = done
            .iter()
            .filter_map(|event| match event {
                StreamEvent::Usage(usage) => Some(usage),
                _ => None,
            })
            .collect::<Vec<_>>();
        let [usage] = usages.as_slice() else {
            panic!("one terminal usage event");
        };
        assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens, usage.reasoning_tokens), (expected_input, 0, 8, Some(0)));
    }
}

struct RowSink(tokio::sync::mpsc::UnboundedSender<crate::registry::accounting::UsageRow>);

#[async_trait]
impl crate::registry::accounting::UsageSink for RowSink {
    async fn record_queued(&self, row: crate::registry::accounting::UsageRow) -> Result<(), String> {
        self.0.send(row).map_err(|error| error.to_string())
    }
}

struct TokenPricing;

impl crate::registry::accounting::UsagePricing for TokenPricing {
    fn price_usage(&self, args: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
        crate::catalog::PricedUsage { input: args.input_tokens, cost_usd: Some(0.0), rates: Default::default() }
    }
}

#[tokio::test]
async fn dropping_a_vertex_stream_accounts_sparse_observed_usage_once_without_a_terminal_event() {
    use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
    use crate::registry::accounting::UsageSink;

    for cancel in [true, false] {
        let http = Arc::new(Script::default());
        http.answer(
            200,
            [
                Ok(usage_frame(json!({"promptTokenCount": 20, "cachedContentTokenCount": 5, "thoughtsTokenCount": 3}))),
                Ok(usage_frame(json!({"candidatesTokenCount": 8}))),
                Ok(Bytes::from_static(b"data: {\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"text\":\"done\"}]}}]}\n\n")),
            ],
        );
        let (tx, mut rows) = tokio::sync::mpsc::unbounded_channel();
        let sink: Arc<dyn UsageSink> = Arc::new(RowSink(tx));
        let deps = AccountingDeps::new(Arc::new(TokenPricing), Arc::new(move || Some(sink.clone())));
        let adapter = AccountedAdapter::wrap(Arc::new(super::vertex_express_at("fixture", None, http, traits())), "vertex-ai", Arc::new(deps));
        let mut request = request();
        request.options.send_group = Some("group".into());
        let mut stream = adapter.attempt(Arc::new(request)).await.unwrap();
        for _ in 0..2 {
            assert!(matches!(stream.next().await, Some(Ok(StreamEvent::ChunkProgress(None)))));
        }
        if !cancel {
            while let Some(event) = stream.next().await {
                if matches!(event.unwrap(), StreamEvent::Completed { .. }) {
                    break;
                }
            }
        }
        drop(stream);
        adapter
            .settle_send(
                "group",
                if cancel { mixdog_core_api::domain::provider::SendEnd::Cancelled } else { mixdog_core_api::domain::provider::SendEnd::Surfaced },
            )
            .await;
        drop(adapter);
        let row = rows.recv().await.expect("one attempt row");
        assert_eq!((row.status.as_str(), row.input, row.cache_read, row.output), (if cancel { "cancelled" } else { "completed" }, 15.0, 5.0, 11.0));
        assert!(rows.recv().await.is_none(), "no second row for the same attempt");
    }
}

#[tokio::test]
async fn empty_stop_can_be_retried_as_sse_but_never_as_unary() {
    let http = Arc::new(Script::default());
    http.answer(200, [Ok(Bytes::from_static(b"data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n"))]);
    let adapter = super::vertex_express_at("fixture", None, http, traits());
    let request = Arc::new(request());
    let err = failure(adapter.attempt(request.clone()).await.unwrap().as_mut()).await;
    assert_eq!(err.kind, ErrorKind::Transient);
    assert_eq!(err.code.as_deref(), Some("no_response_text"));
    assert!(!err.recovery_terminal, "the SSE retry policy still owns this failure");
    assert!(!adapter.recovers_spent(&request, &err));
}

struct RotatingKey(Mutex<&'static str>);

#[async_trait]
impl crate::providers::key_source::ApiKeySource for RotatingKey {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok((*self.0.lock().unwrap()).into())
    }

    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

#[tokio::test]
async fn direct_unary_reuses_the_attached_tail_only_under_the_same_key() {
    use super::cache::policy::{CacheRequest, Tuning, credential_fingerprint, prefix_hash};
    use mixdog_core_api::domain::provider::{GeminiCacheState, ProviderState};

    let key = Arc::new(RotatingKey(Mutex::new("fixture-original")));
    let http = Arc::new(Script::default());
    http.answer(200, [Ok(Bytes::from_static(b"data: {\"candidates\":[{}]}\n\n"))]);
    http.answer(
        200,
        [Ok(Bytes::from_static(
            b"{\"usageMetadata\":{\"promptTokenCount\":12},\"candidates\":[{\"finishReason\":\"STOP\",\"content\":{\"parts\":[{\"text\":\"done\"}]}}]}",
        ))],
    );
    let adapter = super::gemini_with(
        key.clone(),
        http.clone(),
        traits(),
        Arc::new(super::cache::runtime::RtCacheRuntime),
        super::cache::registry::Registry::shared(),
        Tuning::default(),
    );
    let mut request = request();
    request.options.send_group = Some("cached".into());
    request.options.shared_cache_prefix_count = Some(1);
    request.messages.push(Message::new(Role::User, Content::Text("tail".into())));
    let contents = [json!({"role": "user", "parts": [{"text": "hello"}]}), json!({"role": "user", "parts": [{"text": "tail"}]})];
    let shape = CacheRequest { system_instruction: "", tools: &[], tool_config: None, contents: &contents };
    request.options.provider_state = Some(ProviderState {
        gemini: Some(GeminiCacheState {
            cache_name: "cachedContents/fixture".into(),
            cache_created_at: 0,
            cache_created_at_iter: 0,
            cache_expires_at: u64::MAX,
            cache_model: request.model.clone(),
            cache_token_size: 5000,
            cache_prefix_content_count: 1,
            cache_prefix_hash: prefix_hash(&request.model, &shape, 1),
            cache_credential_fingerprint: credential_fingerprint("fixture-original"),
        }),
        ..ProviderState::default()
    });
    let request = Arc::new(request);
    let err = failure(adapter.attempt(request.clone()).await.unwrap().as_mut()).await;
    assert!(adapter.recovers_spent(&request, &err));
    let mut stream = adapter.recover_spent(request.clone()).await.unwrap();
    let mut reported = None;
    while let Some(event) = stream.next().await {
        if let StreamEvent::Usage(usage) = event.unwrap() {
            reported = Some(usage);
        }
    }
    let usage = reported.expect("reported unary input");
    assert_eq!((usage.input_tokens, usage.cache_read_tokens), (12, 0));
    assert!(usage.raw.unwrap().get("cachedContentTokenCount").is_none());
    *key.0.lock().unwrap() = "fixture-rotated";
    let Err(err) = adapter.recover_spent(request).await else {
        panic!("a rotated key must not be sent");
    };
    assert!(err.kind == ErrorKind::Auth && err.recovery_terminal);
    let sent = http.sent.lock().unwrap();
    assert_eq!(sent.len(), 2);
    assert!(sent[1].url.ends_with(":generateContent"));
    assert_eq!(sent[1].headers, sent[0].headers);
    assert_eq!(sent[1].body, sent[0].body);
    let body: Value = serde_json::from_slice(&sent[1].body).unwrap();
    assert_eq!(body["cachedContent"], "cachedContents/fixture");
    assert_eq!(body["contents"], json!([contents[1].clone()]));
}

#[tokio::test]
async fn unary_prompt_block_and_auth_refusal_are_authoritative() {
    for (status, body, expected) in [
        (200, b"{\"promptFeedback\":{\"blockReason\":\"SAFETY\"},\"usageMetadata\":{\"promptTokenCount\":6}}".as_slice(), ErrorKind::Policy),
        (401, b"{\"error\":{\"status\":\"UNAUTHENTICATED\",\"message\":\"revoked\"}}".as_slice(), ErrorKind::Auth),
    ] {
        let http = Arc::new(Script::default());
        http.answer(status, [Ok(Bytes::from_static(body))]);
        let adapter = super::gemini("fixture", http, traits());
        let Err(err) = adapter.recover_spent(Arc::new(request())).await else {
            panic!("expected a unary refusal");
        };
        assert_eq!(err.kind, expected);
        assert!(err.recovery_terminal, "the caller must keep the unary verdict");
        if expected == ErrorKind::Policy {
            assert_eq!(err.partial_usage.clone().unwrap().input_tokens, 6);
        }
    }
}
