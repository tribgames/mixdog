use std::sync::atomic::AtomicUsize;

use mixdog_core_api::domain::provider::{Content, Message as ChatMessage, RequestOptions, Role};
use serde_json::json;

use super::*;
use crate::catalog::{PricedUsage, UsageArgs};
use crate::providers::openai::config::{ModelFacts, ModelFactsSource, OpenAiConfig};
use crate::providers::openai::scripted::{Dialed, ScriptedDial, Wire as SocketWire};
use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
use crate::registry::accounting::{UsagePricing, UsageRow, UsageSink};
use crate::transport::link::{Exchange, HttpResponse};

#[derive(Default)]
struct Keys(AtomicUsize);

#[async_trait]
impl CredentialSource for Keys {
    async fn current(&self) -> Result<Credential, ProviderError> {
        Ok(Credential { bearer: "fixture-old".into(), account_id: None })
    }

    async fn after_rejection(&self, rejected: &Credential) -> Result<Option<Credential>, ProviderError> {
        assert_eq!(rejected.bearer, "fixture-old");
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Some(Credential { bearer: "fixture-new".into(), account_id: None }))
    }
}

struct Facts;

impl ModelFactsSource for Facts {
    fn facts(&self, _: &str) -> ModelFacts {
        ModelFacts { reasoning: Some(true), ..ModelFacts::default() }
    }
}

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[derive(Default)]
struct Http {
    replies: Mutex<VecDeque<(u16, String)>>,
    requests: Mutex<Vec<Value>>,
}

#[async_trait]
impl HttpSend for Http {
    async fn send(&self, wire: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        if wire.method == "HEAD" {
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Body(None)) });
        }
        self.requests.lock().unwrap().push(serde_json::from_slice(&wire.body).unwrap());
        let (status, body) = self.replies.lock().unwrap().pop_front().expect("scripted HTTP reply");
        Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from(body)))) })
    }
}

fn adapter(
    transport: TransportKind,
    mode: TransportMode,
    context: Arc<SessionContext>,
    keys: Arc<Keys>,
    dial: Arc<ScriptedDial>,
    http: Arc<Http>,
) -> OpenAiAdapter {
    OpenAiAdapter::new(
        ProviderId::from("openai"),
        OpenAiCodec::new(OpenAiConfig::api_key(true, Arc::new(Facts), context.clone()), transport),
        AdapterLinks {
            http, dial, context, credentials: keys,
            compress_lane: mixdog_rt::testing::tokens().cpu_bulk,
            listing: ListingLookup::new(),
        },
    ).with_mode(mode)
}

fn context(switch: Option<&'static str>) -> Arc<SessionContext> {
    Arc::new(SessionContext::with_sources(|| 0, || "request-id".into())
        .with_var(move |key| (key == "MIXDOG_OPENAI_HTTP_FALLBACK").then_some(switch).flatten().map(str::to_owned)))
}

fn codex_adapter(
    mode: TransportMode, context: Arc<SessionContext>, keys: Arc<Keys>, dial: Arc<ScriptedDial>, http: Arc<Http>,
) -> OpenAiAdapter {
    let identity = super::super::config::CodexIdentity {
        installation_id: "fixture-installation".into(), user_agent: "fixture".into(),
        version: "1".into(), beta_features: String::new(),
    };
    let codec = OpenAiCodec::new(OpenAiConfig::codex(false, identity, Arc::new(Facts), context.clone()), TransportKind::WebSocket);
    OpenAiAdapter::new(ProviderId::from("openai-oauth"), codec, AdapterLinks {
        http, dial, context, credentials: keys, compress_lane: mixdog_rt::testing::tokens().cpu_bulk,
        listing: ListingLookup::new(),
    }).with_mode(mode)
}

fn request() -> ModelRequest {
    ModelRequest {
        model: "gpt-6.1-sol".into(),
        messages: vec![ChatMessage::new(Role::User, Content::Text("first question".into()))],
        tools: Vec::new(),
        options: RequestOptions { session_id: Some("scope".into()), ..RequestOptions::default() },
    }
}

const CREATED: &str = r#"{"type":"response.created","response":{"id":"r","model":"served-model"}}"#;
const DONE: &str = r#"{"type":"response.completed","response":{"id":"r","output":[]}}"#;
const AUTH: &str = r#"{"type":"error","status":401,"error":{"code":"invalid_api_key","message":"key rejected"}}"#;
const TEXT: &str = r#"{"type":"response.output_text.delta","item_id":"message","delta":"visible" }"#;
const CALL: &str = r#"{"type":"response.output_item.done","item":{"type":"function_call","id":"item","call_id":"call","name":"lookup","arguments":"{}","status":"completed"}}"#;
const HOSTED_CALL: &str = r#"{"type":"response.web_search_call.completed","item_id":"search"}"#;

fn sse(records: &[&str]) -> String {
    records.iter().map(|record| format!("data: {record}\n\n")).collect()
}

fn socket(frames: &[&str]) -> Dialed {
    Dialed::Socket { frames: frames.iter().map(|s| (*s).into()).collect(), close: (1000, String::new()) }
}

async fn result(adapter: &dyn ProviderAdapter, request: ModelRequest) -> (Vec<StreamEvent>, Option<ProviderError>) {
    let mut stream = match adapter.attempt(Arc::new(request)).await {
        Ok(stream) => stream,
        Err(error) => return (Vec::new(), Some(error)),
    };
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(event) => events.push(event),
            Err(error) => return (events, Some(error)),
        }
    }
    assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })));
    (events, None)
}

#[tokio::test]
async fn fallback_opt_out_blocks_switching_and_prior_stickiness_but_not_explicit_http() {
    for (transport, setting, sticky, expect_http) in [
        (TransportKind::WebSocket, Some(" Off "), false, false),
        (TransportKind::WebSocket, Some("0"), true, false),
        (TransportKind::WebSocket, Some("typo"), false, true),
        (TransportKind::Http1, Some("false"), false, true),
    ] {
        let http = Arc::new(Http::default());
        if expect_http {
            http.replies.lock().unwrap().push_back((200, sse(&[DONE])));
        }
        let dial = ScriptedDial::with(vec![Dialed::Rejected { status: 404, body: "{}".into() }]);
        let adapter = adapter(transport, TransportMode::Auto, context(setting), Arc::new(Keys::default()), dial.clone(), http.clone());
        if sticky {
            adapter.pool.mark_http("scope");
        }
        let (_, error) = result(&adapter, request()).await;
        assert_eq!(error.and_then(|e| e.status), (!expect_http).then_some(404));
        assert_eq!(http.requests.lock().unwrap().len(), usize::from(expect_http));
        assert_eq!(dial.wire().len(), usize::from(transport == TransportKind::WebSocket));
    }
}

#[tokio::test]
async fn public_websocket_reloads_in_band_401_once_and_never_after_visible_output_or_a_call() {
    for (frames, reload, second_401) in [
        (vec![CREATED, AUTH], true, false),
        (vec![AUTH], true, true),
        (vec![CREATED, TEXT, AUTH], false, false),
        (vec![CREATED, CALL, AUTH], false, false),
    ] {
        let keys = Arc::new(Keys::default());
        let mut script = vec![socket(&frames)];
        if reload {
            script.push(socket(if second_401 { &[AUTH] } else { &[DONE] }));
        }
        let dial = ScriptedDial::with(script);
        let adapter = adapter(TransportKind::WebSocket, TransportMode::WsDelta, context(None), keys.clone(), dial.clone(), Arc::new(Http::default()));
        let (events, error) = result(&adapter, request()).await;
        assert_eq!(keys.0.load(Ordering::SeqCst), usize::from(reload));
        assert_eq!(error.as_ref().and_then(|e| e.status), (!reload || second_401).then_some(401));
        if let Some(error) = error {
            assert_eq!(error.reauth_required, second_401);
            if !reload {
                assert!(error.unsafe_to_retry);
                assert!(events.iter().any(|event| matches!(event, StreamEvent::TextDelta(_) | StreamEvent::ToolCallDone(_))));
            }
        }
        let upgrades: Vec<_> = dial.wire().into_iter().filter_map(|entry| match entry {
            SocketWire::Upgrade { headers, .. } => headers.into_iter().find(|(name, _)| name == "authorization").map(|(_, key)| key),
            _ => None,
        }).collect();
        assert_eq!(upgrades, if reload { vec!["Bearer fixture-old", "Bearer fixture-new"] } else { vec!["Bearer fixture-old"] });
    }
}

#[tokio::test]
async fn oauth_401_renewal_is_shared_by_websocket_and_http_fallback() {
    let http = Arc::new(Http::default());
    http.replies.lock().unwrap().push_back((200, sse(&[AUTH])));
    let keys = Arc::new(Keys::default());
    let dial = ScriptedDial::with(vec![
        socket(&[AUTH]),
        Dialed::Rejected { status: 404, body: "{}".into() },
    ]);
    let adapter = codex_adapter(TransportMode::Auto, context(None), keys.clone(), dial, http.clone());
    let (_, error) = result(&adapter, request()).await;
    assert!(error.is_some_and(|error| error.status == Some(401) && error.reauth_required));
    assert_eq!(keys.0.load(Ordering::SeqCst), 1);
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn oauth_force_http_is_explicit_in_auto_and_is_ignored_when_pinned_to_ws() {
    for mode in [TransportMode::Auto, TransportMode::WsDelta] {
        let expected_http = mode == TransportMode::Auto;
        let context = Arc::new(SessionContext::with_sources(|| 0, || "fixture".into()).with_var(|name| match name {
            "MIXDOG_OPENAI_HTTP_FALLBACK" => Some("off".into()),
            "MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK" => Some("yes".into()),
            _ => None,
        }));
        let http = Arc::new(Http::default());
        let dial = ScriptedDial::with(if expected_http { Vec::new() } else { vec![socket(&[DONE])] });
        let keys = Arc::new(Keys::default());
        if expected_http {
            http.replies.lock().unwrap().extend([(200, sse(&[AUTH])), (200, sse(&[DONE]))]);
        }
        let adapter = codex_adapter(mode, context, keys.clone(), dial.clone(), http.clone());
        assert!(result(&adapter, request()).await.1.is_none());
        assert_eq!(keys.0.load(Ordering::SeqCst), usize::from(expected_http));
        assert_eq!(http.requests.lock().unwrap().len(), if expected_http { 2 } else { 0 });
        assert_eq!(dial.wire().is_empty(), expected_http);
    }
}

#[tokio::test]
async fn a_hosted_tool_effect_vetoes_auth_recovery_without_emitting_a_client_call() {
    let keys = Arc::new(Keys::default());
    let dial = ScriptedDial::with(vec![socket(&[HOSTED_CALL, AUTH])]);
    let adapter = codex_adapter(TransportMode::Auto, context(None), keys.clone(), dial, Arc::new(Http::default()));
    let (events, error) = result(&adapter, request()).await;
    let error = error.unwrap();
    assert_eq!(error.status, Some(401));
    assert!(error.unsafe_to_retry && error.exposure.tool_dispatched);
    assert!(!events.iter().any(|event| matches!(event, StreamEvent::ToolCallDone(_))));
    assert_eq!(keys.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn visible_reasoning_ends_the_send_without_reconnect_refresh_or_fallback() {
    const REASONING: &str = r#"{"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning","encrypted_content":"opaque"}}"#;
    const DELTA: &str = r#"{"type":"response.reasoning_summary_text.delta","delta":"visible"}"#;
    const TRANSIENT: &str = r#"{"type":"error","status":503,"error":{"code":"server_error","message":"unavailable"}}"#;
    const UNKNOWN: &str = r#"{"type":"error","status":404,"error":{"code":"model_not_found","message":"model not found"}}"#;
    for shown in [REASONING, DELTA] {
        // A different failure for each entry to the retry/reconnect ladder.
        for (failure, status) in [(TRANSIENT, 503), (UNKNOWN, 404), (AUTH, 401)] {
            let dial = ScriptedDial::with(vec![socket(&[CREATED, shown, failure])]);
            let keys = Arc::new(Keys::default());
            let http = Arc::new(Http::default());
            let adapter = codex_adapter(TransportMode::Auto, context(None), keys.clone(), dial.clone(), http.clone());
            let (events, error) = result(&adapter, request()).await;
            assert!(events.iter().any(|event| matches!(event, StreamEvent::ReasoningDelta(_) | StreamEvent::Progress(ProgressKind::Reasoning))));
            let error = error.expect("the original failure must surface");
            assert_eq!(error.status, Some(status));
            // Unsafe for this send to retry on its own, and not ended for the loop, which may withdraw the reasoning and replay.
            assert!(error.unsafe_to_retry && !error.recovery_exhausted);
            assert_eq!(keys.0.load(Ordering::SeqCst), 0);
            assert_eq!(dial.wire().iter().filter(|entry| matches!(entry, SocketWire::Frame(_))).count(), 1);
            assert!(http.requests.lock().unwrap().is_empty());
        }
    }
}

fn with_update(mut request: ModelRequest, index: usize) -> ModelRequest {
    request.options.effort = Some("high".into());
    request.options.effort_projection = Some(mixdog_core_api::domain::provider::EffortProjection {
        initial_effort: "low".into(), updates: [(index, "high".into())].into(),
    });
    request
}

fn update_in(body: &Value) -> bool {
    body["input"].as_array().unwrap().iter().any(|item| item["type"] == "configuration_update")
}

#[tokio::test]
async fn a_rejected_effort_value_does_not_disable_the_update_field() {
    let http = Arc::new(Http::default());
    http.replies.lock().unwrap().extend([
        (400, json!({"error": {
            "code": "unsupported_value", "param": "input[0].reasoning.effort",
            "message": "configuration_update rejected the effort value 'high'",
        }}).to_string()),
        (200, sse(&[DONE])),
    ]);
    let adapter = adapter(TransportKind::Http1, TransportMode::Auto, context(None), Arc::new(Keys::default()),
        ScriptedDial::with(Vec::new()), http.clone());
    assert_eq!(result(&adapter, with_update(request(), 0)).await.1.and_then(|error| error.status), Some(400));
    assert!(result(&adapter, with_update(request(), 0)).await.1.is_none());
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(update_in));
}

#[tokio::test]
async fn rejected_effort_rebuilds_the_http_request_and_is_remembered_by_normalized_model() {
    let http = Arc::new(Http::default());
    http.replies.lock().unwrap().extend([
        (400, json!({"error": {"message": "Mid-conversation effort is not supported"}}).to_string()),
        (200, sse(&[DONE])),
        (200, sse(&[DONE])),
    ]);
    let adapter = adapter(TransportKind::Http1, TransportMode::Auto, context(None), Arc::new(Keys::default()),
        ScriptedDial::with(Vec::new()), http.clone());
    assert!(result(&adapter, with_update(request(), 0)).await.1.is_none());
    let mut alias = request();
    alias.model = "gpt-6-1-sol-2026-07-01".into();
    assert!(result(&adapter, with_update(alias, 0)).await.1.is_none());
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(update_in(&requests[0]));
    assert_eq!(requests[0]["reasoning"]["effort"], "low");
    for body in &requests[1..] {
        assert!(!update_in(body));
        assert_eq!(body["reasoning"]["effort"], "high");
    }
}

#[tokio::test]
async fn an_effort_error_indexes_the_sent_websocket_delta_and_reissues_full_input() {
    const REJECTED: &str = r#"{"type":"response.failed","response":{"error":{"status":400,"param":"input[0].type","message":"Unknown value"}}}"#;
    let dial = ScriptedDial::with(vec![socket(&[DONE, REJECTED]), socket(&[DONE])]);
    let adapter = adapter(TransportKind::WebSocket, TransportMode::WsDelta, context(None), Arc::new(Keys::default()),
        dial.clone(), Arc::new(Http::default()));
    let mut first = request();
    first.options.effort = Some("low".into());
    assert!(result(&adapter, first).await.1.is_none());
    let mut second = with_update(request(), 1);
    second.messages.push(ChatMessage::new(Role::User, Content::Text("follow-up".into())));
    assert!(result(&adapter, second).await.1.is_none());
    let frames: Vec<Value> = dial.wire().into_iter().filter_map(|entry| match entry {
        SocketWire::Frame(text) => Some(serde_json::from_str(&text).unwrap()),
        _ => None,
    }).collect();
    assert_eq!(frames.len(), 3);
    assert_eq!(frames[1]["previous_response_id"], "r");
    assert_eq!(frames[1]["input"][0]["type"], "configuration_update");
    assert!(frames[2].get("previous_response_id").is_none());
    assert!(!update_in(&frames[2]));
    assert_eq!(frames[2]["input"].as_array().unwrap().len(), 2);
    assert_eq!(frames[2]["reasoning"]["effort"], "high");
}

#[tokio::test]
async fn partial_sse_preserves_dispatched_calls_replay_and_reported_usage_without_resending() {
    const REJECTED: &str = r#"{"type":"response.failed","response":{"serviceTier":"priority","usage":{"input_tokens":11,"output_tokens":5,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}},"error":{"status":400,"message":"configuration_update rejected"}}}"#;
    let http = Arc::new(Http::default());
    for tail in [Some(REJECTED), None] {
        let mut frames = vec![CREATED, CALL];
        frames.extend(tail);
        http.replies.lock().unwrap().push_back((200, sse(&frames)));
    }
    let adapter = adapter(TransportKind::Http1, TransportMode::Auto, context(None), Arc::new(Keys::default()),
        ScriptedDial::with(Vec::new()), http.clone());
    for billed in [true, false] {
        let (events, failure) = result(&adapter, with_update(request(), 0)).await;
        let failure = failure.expect("neither terminal failure nor EOF completes the response");
        assert!(failure.unsafe_to_retry && failure.exposure.tool_dispatched);
        assert_eq!(events.iter().filter(|event| matches!(event, StreamEvent::ToolCallDone(_))).count(), 1);
        assert_eq!(failure.partial_model.as_deref(), Some("served-model"));
        let replay = failure.partial_replay.clone().unwrap();
        assert_eq!(replay.items[0]["call_id"], "call");
        if billed {
            let usage = failure.partial_usage.clone().unwrap();
            assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.reasoning_tokens), (11, 5, 3, Some(2)));
            assert_eq!(usage.raw.unwrap()["service_tier"], "priority");
        } else {
            assert!(failure.partial_usage.is_none(), "EOF must not synthesize billed tokens");
        }
    }
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(update_in), "a late refusal must not disable effort updates");
}

#[derive(Default)]
struct Ledger(Mutex<Vec<UsageRow>>, tokio::sync::Notify);

#[async_trait]
impl UsageSink for Ledger {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        self.1.notify_one();
        Ok(())
    }
}

struct Pricing;

impl UsagePricing for Pricing {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        PricedUsage { input: args.input_tokens, cost_usd: None, rates: Default::default() }
    }
}

#[tokio::test(start_paused = true)]
async fn cancelling_before_the_queued_failure_keeps_its_decoded_usage() {
    const FAILED: &str = r#"{"type":"response.failed","response":{"usage":{"input_tokens":11,"output_tokens":3},"error":{"status":400,"message":"configuration_update rejected"}}}"#;
    let http = Arc::new(Http::default());
    http.replies.lock().unwrap().push_back((200, sse(&[CREATED, TEXT, FAILED])));
    let inner = adapter(TransportKind::Http1, TransportMode::Auto, context(None), Arc::new(Keys::default()),
        ScriptedDial::with(Vec::new()), http.clone());
    let ledger = Arc::new(Ledger::default());
    let sink = Arc::clone(&ledger);
    let deps = AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
    let accounted = AccountedAdapter::wrap(Arc::new(inner), "openai", Arc::new(deps));
    let mut stream = accounted.attempt(Arc::new(with_update(request(), 0))).await.unwrap();
    assert_eq!(stream.next().await, Some(Ok(StreamEvent::TextDelta("visible".into()))));
    drop(stream);
    tokio::time::timeout(Duration::from_secs(1), ledger.1.notified()).await.expect("cancelled usage row");
    let rows = ledger.0.lock().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].status.as_str(), rows[0].model.as_str(), rows[0].input, rows[0].output), ("cancelled", "served-model", 11.0, 3.0));
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn cancellation_at_a_tool_from_the_completed_bundle_keeps_decoded_usage() {
    const COMPLETED: &str = r#"{"type":"response.completed","response":{"id":"r","model":"served-model","output":[{"type":"function_call","id":"item","call_id":"call","name":"lookup","arguments":"{}","status":"completed"}],"usage":{"input_tokens":17,"output_tokens":5}}}"#;
    for transport in [TransportKind::Http1, TransportKind::WebSocket] {
        let http = Arc::new(Http::default());
        let sockets = if transport == TransportKind::WebSocket {
            vec![socket(&[COMPLETED])]
        } else {
            http.replies.lock().unwrap().push_back((200, sse(&[COMPLETED])));
            Vec::new()
        };
        let inner = adapter(transport, TransportMode::WsDelta, context(None), Arc::new(Keys::default()),
            ScriptedDial::with(sockets), http);
        let ledger = Arc::new(Ledger::default());
        let sink = Arc::clone(&ledger);
        let deps = AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
        let accounted = AccountedAdapter::wrap(Arc::new(inner), "openai", Arc::new(deps));
        let mut stream = accounted.attempt(Arc::new(request())).await.unwrap();
        loop {
            match stream.next().await.expect("tool before usage").unwrap() {
                StreamEvent::ToolCallDone(call) => {
                    assert_eq!(call.id, "call");
                    break;
                }
                StreamEvent::Usage(_) | StreamEvent::Completed { .. } => panic!("tool must be exposed first"),
                _ => {}
            }
        }
        drop(stream);
        tokio::time::timeout(Duration::from_secs(1), ledger.1.notified()).await.expect("cancelled usage row");
        let rows = ledger.0.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].status.as_str(), rows[0].model.as_str(), rows[0].input, rows[0].output), ("cancelled", "served-model", 17.0, 5.0));
    }
}

#[tokio::test]
async fn the_accounted_send_keeps_a_billed_effort_refusal_exactly_once() {
    const BILLED: &str = r#"{"type":"response.failed","response":{"usage":{"input_tokens":11,"output_tokens":3,"cost_in_usd_ticks":125000000},"error":{"status":400,"message":"configuration_update rejected"}}}"#;
    const SUCCESS: &str = r#"{"type":"response.completed","response":{"id":"second","output":[],"model":"gpt-6.1-sol","usage":{"input_tokens":17,"output_tokens":5}}}"#;
    for transport in [TransportKind::Http1, TransportKind::WebSocket] {
        for effect in [None, Some(TEXT), Some(CALL)] {
            let mut first = vec![CREATED];
            first.extend(effect);
            first.push(BILLED);
            let mut sockets = Vec::new();
            let http = Arc::new(Http::default());
            if transport == TransportKind::WebSocket {
                sockets.push(socket(&first));
                if effect.is_none() {
                    sockets.push(socket(&[SUCCESS]));
                }
            } else {
                http.replies.lock().unwrap().push_back((200, sse(&first)));
                if effect.is_none() {
                    http.replies.lock().unwrap().push_back((200, sse(&[SUCCESS])));
                }
            }
            let dial = ScriptedDial::with(sockets);
            let inner = adapter(transport, TransportMode::WsDelta, context(None), Arc::new(Keys::default()), dial.clone(), http.clone());
            let ledger = Arc::new(Ledger::default());
            let sink = Arc::clone(&ledger);
            let deps = AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
            let accounted = AccountedAdapter::wrap(Arc::new(inner), "openai", Arc::new(deps));
            let (events, error) = result(accounted.as_ref(), with_update(request(), 0)).await;
            let rows = ledger.0.lock().unwrap();
            let sent: Vec<Value> = if transport == TransportKind::WebSocket {
                dial.wire().into_iter().filter_map(|item| match item {
                    SocketWire::Frame(text) => Some(serde_json::from_str(&text).unwrap()),
                    _ => None,
                }).collect()
            } else {
                http.requests.lock().unwrap().clone()
            };
            assert!(update_in(&sent[0]));
            assert_eq!((rows[0].input, rows[0].output, rows[0].model.as_str()), (11.0, 3.0, "served-model"));
            assert_eq!(rows[0].cost_usd, Some(0.0125));
            if let Some(effect) = effect {
                assert_eq!(sent.len(), 1);
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].status, "failed");
                assert!(error.unwrap().unsafe_to_retry);
                if effect == TEXT {
                    assert_eq!(events.iter().filter(|event| matches!(event, StreamEvent::TextDelta(_))).count(), 1);
                } else {
                    assert_eq!(events.iter().filter(|event| matches!(event, StreamEvent::ToolCallDone(_))).count(), 1);
                }
            } else {
                assert!(error.is_none());
                assert_eq!(sent.len(), 2);
                assert!(!update_in(&sent[1]));
                assert_eq!(rows.len(), 2);
                assert!(rows[0].id.ends_with(":abandoned:0"));
                assert_eq!((rows[1].input, rows[1].output, rows[1].attempts), (17.0, 5.0, 2));
            }
        }
    }
}
