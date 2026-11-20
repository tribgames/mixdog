//! One send through the API-key adapter against a scripted endpoint: request compression and its latch, a fast
//! request the fast pool refuses, and a request whose version-floor feature the model refuses. Each test scripts
//! the endpoint's replies in the test and reads the requests the adapter put on the wire.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::claude_floors;
use mixdog_ai::claude_floors::Feature;
use mixdog_ai::providers::anthropic::AnthropicAdapter;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::ApiKeySource;
use mixdog_ai::providers::anthropic::ModelCaps;
use mixdog_ai::providers::anthropic::fast_mode::FastMode;
use mixdog_ai::providers::anthropic::fast_mode::now_ms;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

const OK: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"fine\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

struct Body(Option<bytes::Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn reply(status: u16, body: &str) -> Reply {
    Reply { status, headers: Vec::new(), body: body.to_owned() }
}

fn refusal(status: u16, kind: &str, message: &str) -> Reply {
    reply(status, &json!({ "type": "error", "error": { "type": kind, "message": message } }).to_string())
}

fn with_header(mut reply: Reply, name: &str, value: &str) -> Reply {
    reply.headers.push((name.to_owned(), value.to_owned()));
    reply
}

/// Answers each request with the next scripted reply and keeps what was sent.
struct Endpoint {
    script: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<WireRequest>>,
}

impl Endpoint {
    fn new(script: impl IntoIterator<Item = Reply>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script.into_iter().collect()), sent: Mutex::default() })
    }

    fn sent(&self) -> Vec<WireRequest> {
        self.sent.lock().unwrap().clone()
    }

    fn push(&self, reply: Reply) {
        self.script.lock().unwrap().push_back(reply);
    }
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().unwrap().push(request);
        let next = self.script.lock().unwrap().pop_front().expect("a scripted reply for this request");
        Ok(HttpResponse { status: next.status, headers: next.headers, body: Box::new(Body(Some(next.body.into()))) })
    }
}

struct Key;

#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("not-a-credential".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

fn adapter(config: AnthropicConfig, endpoint: &Arc<Endpoint>) -> AnthropicAdapter {
    AnthropicAdapter::api_key(config, endpoint.clone(), Arc::new(Key), mixdog_rt::testing::tokens().cpu_bulk)
}

fn config(caps: ModelCaps) -> AnthropicConfig {
    AnthropicConfig::new(Arc::new(move |_: &str| Some(caps.clone())))
}

fn ask(model: &str, text: &str, options: RequestOptions) -> Arc<ModelRequest> {
    Arc::new(ModelRequest { model: model.into(), messages: vec![Message::new(Role::User, Content::Text(text.into()))], tools: Vec::new(), options })
}

/// Opens the attempt and reads its stream to the end: the failure it ends with, or the text it produced.
async fn send(adapter: &AnthropicAdapter, request: Arc<ModelRequest>) -> Result<String, ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        if let StreamEvent::TextDelta(t) = item? {
            text.push_str(&t);
        }
    }
    Ok(text)
}

fn header<'a>(request: &'a WireRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn plain_body(request: &WireRequest) -> Value {
    serde_json::from_slice(&request.body).expect("a plain JSON body")
}

// ---------------------------------------------------------------------------
// The model listing request and configured headers
// ---------------------------------------------------------------------------

fn count_of(request: &WireRequest, name: &str) -> usize {
    request.headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name)).count()
}

#[tokio::test]
async fn the_listing_is_one_get_on_the_configured_base_with_the_key_and_the_api_version() {
    let endpoint = Endpoint::new([reply(200, r#"{"data":[{"id":"claude-sonnet-4-6"}]}"#)]);
    let mut config = config(ModelCaps::default());
    config.base_url = "https://gateway.example/".into();
    let rows = adapter(config, &endpoint).list_rows().await.expect("the listing");
    assert_eq!(rows.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["claude-sonnet-4-6"]);
    let sent = &endpoint.sent()[0];
    assert_eq!((sent.method.as_str(), sent.url.as_str()), ("GET", "https://gateway.example/v1/models"));
    assert!(sent.body.is_empty());
    assert_eq!(header(sent, "x-api-key"), Some("not-a-credential"));
    assert_eq!(header(sent, "anthropic-version"), Some(mixdog_ai::providers::anthropic::ANTHROPIC_VERSION));
}

#[tokio::test]
async fn configured_extra_headers_replace_the_default_version_and_key_but_never_the_requests_own_betas() {
    let extra = vec![
        ("anthropic-version".to_owned(), "2099-01-01".to_owned()),
        ("x-api-key".to_owned(), "extra-key".to_owned()),
        ("x-tenant".to_owned(), "t1".to_owned()),
        ("anthropic-beta".to_owned(), "extra-beta".to_owned()),
    ];
    let endpoint = Endpoint::new([reply(200, r#"{"data":[]}"#), reply(200, OK)]);
    let mut config = config(ModelCaps::default());
    config.extra_headers = extra;
    let adapter = adapter(config, &endpoint);
    adapter.list_rows().await.expect("the listing");
    send(&adapter, ask("claude-sonnet-4-6", "hi", RequestOptions::default())).await.unwrap();
    for sent in endpoint.sent() {
        assert_eq!(count_of(&sent, "anthropic-version"), 1);
        assert_eq!(header(&sent, "anthropic-version"), Some("2099-01-01"));
        assert_eq!(count_of(&sent, "x-api-key"), 1);
        assert_eq!(header(&sent, "x-api-key"), Some("extra-key"));
        assert_eq!(header(&sent, "x-tenant"), Some("t1"));
    }
    let messages = &endpoint.sent()[1];
    assert!(!header(messages, "anthropic-beta").unwrap_or_default().contains("extra-beta"), "{:?}", header(messages, "anthropic-beta"));
}

// ---------------------------------------------------------------------------
// Request compression
// ---------------------------------------------------------------------------

fn gunzip(request: &WireRequest) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(request.body.as_slice()).read_to_end(&mut out).expect("a gzip body");
    out
}

fn large() -> String {
    "x".repeat(16 * 1024)
}

#[tokio::test]
async fn a_large_body_to_the_official_endpoint_is_sent_gzipped_and_a_small_or_foreign_one_is_not() {
    mixdog_ai::reset_process_state();
    let endpoint = Endpoint::new([reply(200, OK), reply(200, OK), reply(200, OK)]);
    let official = adapter(config(ModelCaps::default()), &endpoint);
    let big = ask("claude-sonnet-4-6", &large(), RequestOptions::default());
    let plain = official.codec().encode(&big).expect("encodes").body;
    send(&official, big.clone()).await.unwrap();
    send(&official, ask("claude-sonnet-4-6", "hi", RequestOptions::default())).await.unwrap();
    let mut foreign_config = config(ModelCaps::default());
    foreign_config.base_url = "https://gateway.example".into();
    let foreign = adapter(foreign_config, &endpoint);
    send(&foreign, big.clone()).await.unwrap();
    let sent = endpoint.sent();
    assert_eq!(header(&sent[0], "content-encoding"), Some("gzip"));
    assert!(header(&sent[0], "content-length").is_none(), "the plain body's length no longer holds");
    assert_eq!(gunzip(&sent[0]), plain, "the compressed body decompresses to the request's own bytes");
    assert!(sent[0].body.len() < plain.len());
    assert!(header(&sent[1], "content-encoding").is_none(), "under 8 KiB goes plain");
    assert!(header(&sent[2], "content-encoding").is_none(), "only the official endpoint takes a compressed body");
    assert_eq!(sent[2].body, plain);
}

#[tokio::test]
async fn the_kill_switch_turns_compression_off() {
    mixdog_ai::reset_process_state();
    let endpoint = Endpoint::new([reply(200, OK)]);
    let off: mixdog_ai::transport::preconnect::Setting = Arc::new(|name: &str| (name == "MIXDOG_ANTHROPIC_REQ_GZIP").then(|| "0".to_owned()));
    let adapter = adapter(config(ModelCaps::default()), &endpoint).with_settings(off);
    send(&adapter, ask("claude-sonnet-4-6", &large(), RequestOptions::default())).await.unwrap();
    assert!(header(&endpoint.sent()[0], "content-encoding").is_none());
}

#[tokio::test]
async fn a_refused_compressed_body_is_sent_once_plain_and_compression_stays_off_only_when_the_plain_one_is_taken() {
    mixdog_ai::reset_process_state();
    let big = ask("claude-sonnet-4-6", &large(), RequestOptions::default());
    // Refused plain as well: the request is the problem, not the encoding. The latch stays open.
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", "bad"), refusal(400, "invalid_request_error", "bad")]);
    let adapter = adapter(config(ModelCaps::default()), &endpoint);
    let err = send(&adapter, big.clone()).await.expect_err("the plain body is refused too");
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(endpoint.sent().len(), 2);
    assert!(!mixdog_ai::providers::anthropic::gzip_latched());
    // Refused compressed, taken plain: the endpoint cannot read gzip, so no later body of the process is compressed.
    endpoint.push(refusal(415, "invalid_request_error", "unsupported encoding"));
    endpoint.push(reply(200, OK));
    send(&adapter, big.clone()).await.unwrap();
    let sent = endpoint.sent();
    assert_eq!(sent.len(), 4);
    assert_eq!(header(&sent[2], "content-encoding"), Some("gzip"));
    assert!(header(&sent[3], "content-encoding").is_none());
    assert_eq!(sent[3].body, gunzip(&sent[2]));
    assert!(mixdog_ai::providers::anthropic::gzip_latched());
    endpoint.push(reply(200, OK));
    send(&adapter, big).await.unwrap();
    assert!(header(&endpoint.sent()[4], "content-encoding").is_none());
    mixdog_ai::reset_process_state();
}

// ---------------------------------------------------------------------------
// Fast speed refused by the fast pool
// ---------------------------------------------------------------------------

const FAST_MODEL: &str = "claude-opus-4-8";

fn fast_config(fast: &Arc<FastMode>) -> AnthropicConfig {
    let mut config = config(ModelCaps { fast_mode: true, manual_thinking: true, max_output_tokens: Some(16384), ..ModelCaps::default() });
    config.fast_mode = Arc::clone(fast);
    config
}

fn fast_request() -> Arc<ModelRequest> {
    ask(FAST_MODEL, "hi", RequestOptions { fast: true, ..RequestOptions::default() })
}

fn speed(request: &WireRequest) -> Option<String> {
    plain_body(request).get("speed").and_then(Value::as_str).map(str::to_owned)
}

fn has_fast_beta(request: &WireRequest) -> bool {
    header(request, "anthropic-beta").is_some_and(|b| b.contains("fast-mode"))
}

#[tokio::test]
async fn a_fast_request_the_pool_refuses_with_a_long_window_is_replayed_at_standard_speed_and_later_ones_start_there() {
    let fast = Arc::new(FastMode::new());
    let endpoint = Endpoint::new([with_header(refusal(429, "rate_limit_error", "fast pool is full"), "retry-after", "120"), reply(200, OK)]);
    let adapter = adapter(fast_config(&fast), &endpoint);
    assert_eq!(send(&adapter, fast_request()).await.unwrap(), "fine");
    let sent = endpoint.sent();
    assert_eq!(sent.len(), 2, "one refusal, one replay");
    assert_eq!(speed(&sent[0]).as_deref(), Some("fast"));
    assert!(has_fast_beta(&sent[0]));
    assert_eq!(speed(&sent[1]), None);
    assert!(has_fast_beta(&sent[1]), "the replay keeps the beta header");
    // The cooldown is at least ten minutes however short the server's window.
    assert!(!fast.available(now_ms()));
    let left = fast.cooldown_remaining_ms(now_ms());
    assert!((590_000.0..=600_000.0).contains(&left), "{left}");
    assert_eq!(fast.disabled_reason(), None);
    endpoint.push(reply(200, OK));
    send(&adapter, fast_request()).await.unwrap();
    let next = &endpoint.sent()[2];
    assert_eq!(speed(next), None, "during the cooldown a fast request is built at standard speed");
    assert!(!has_fast_beta(next));
}

#[tokio::test]
async fn a_short_server_window_is_waited_out_at_fast_speed_not_replayed_standard() {
    let fast = Arc::new(FastMode::new());
    let endpoint = Endpoint::new([with_header(refusal(429, "rate_limit_error", "busy"), "retry-after", "5")]);
    let adapter = adapter(fast_config(&fast), &endpoint);
    let err = send(&adapter, fast_request()).await.expect_err("left to the caller's retry");
    assert_eq!(err.kind, ErrorKind::RateLimited);
    assert_eq!(endpoint.sent().len(), 1);
    assert!(fast.available(now_ms()), "fast mode stays on");
}

#[tokio::test]
async fn a_missing_overage_billing_header_turns_fast_mode_off_for_good() {
    let fast = Arc::new(FastMode::new());
    let refused = with_header(refusal(429, "rate_limit_error", "no overage"), "anthropic-ratelimit-unified-overage-disabled-reason", "org_level_disabled");
    let endpoint = Endpoint::new([refused, reply(200, OK)]);
    let adapter = adapter(fast_config(&fast), &endpoint);
    send(&adapter, fast_request()).await.unwrap();
    assert_eq!(speed(&endpoint.sent()[1]), None);
    assert_eq!(fast.disabled_reason().as_deref(), Some("org_level_disabled"));
    assert!(!fast.available(now_ms()));
    assert!(fast.cooldown_remaining_ms(now_ms()).is_infinite());
}

#[tokio::test]
async fn an_account_that_cannot_serve_fast_mode_is_replayed_standard_and_remembered() {
    let fast = Arc::new(FastMode::new());
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", "Fast mode is not enabled for this organization"), reply(200, OK)]);
    let adapter = adapter(fast_config(&fast), &endpoint);
    send(&adapter, fast_request()).await.unwrap();
    assert_eq!(endpoint.sent().len(), 2);
    assert_eq!(speed(&endpoint.sent()[1]), None);
    assert_eq!(fast.disabled_reason().as_deref(), Some("fast_mode_not_enabled"));
}

#[tokio::test]
async fn a_request_that_never_asked_for_fast_speed_is_not_replayed_for_a_fast_pool_refusal() {
    let fast = Arc::new(FastMode::new());
    let endpoint = Endpoint::new([with_header(refusal(429, "rate_limit_error", "busy"), "retry-after", "120")]);
    let adapter = adapter(fast_config(&fast), &endpoint);
    let standard = ask(FAST_MODEL, "hi", RequestOptions::default());
    assert!(send(&adapter, standard).await.is_err());
    assert_eq!(endpoint.sent().len(), 1);
    assert_eq!(speed(&endpoint.sent()[0]), None);
    assert!(fast.available(now_ms()), "a standard request says nothing about the fast pool");
}

#[tokio::test]
async fn a_model_the_catalog_does_not_mark_fast_is_never_sent_at_fast_speed() {
    let endpoint = Endpoint::new([reply(200, OK)]);
    let adapter = adapter(config(ModelCaps::default()), &endpoint);
    send(&adapter, fast_request()).await.unwrap();
    assert_eq!(speed(&endpoint.sent()[0]), None);
    assert!(!has_fast_beta(&endpoint.sent()[0]));
}

// ---------------------------------------------------------------------------
// A version-floor feature the model refuses
// ---------------------------------------------------------------------------

fn display_caps() -> ModelCaps {
    ModelCaps {
        adaptive_thinking: true,
        effort_levels: vec!["low".into(), "high".into()],
        max_output_tokens: Some(16384),
        thinking_display_updates: true,
        ..ModelCaps::default()
    }
}

const DISPLAY_REFUSAL: &str = "thinking.adaptive.display: Extra inputs are not permitted";

fn thinking(request: &WireRequest) -> Value {
    plain_body(request)["thinking"].clone()
}

#[tokio::test]
async fn a_refused_thinking_display_is_switched_off_for_the_model_and_the_request_replayed_once_without_it() {
    let model = "claude-sonnet-5-8";
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", DISPLAY_REFUSAL), reply(200, OK)]);
    let adapter = adapter(config(display_caps()), &endpoint);
    assert!(claude_floors::enabled(Feature::ProgressUpdates, "anthropic", model));
    assert_eq!(send(&adapter, ask(model, "hi", RequestOptions::default())).await.unwrap(), "fine");
    let sent = endpoint.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(thinking(&sent[0]), json!({ "type": "adaptive", "display": "updates" }));
    assert!(header(&sent[0], "anthropic-beta").unwrap().contains("thinking-display-updates"));
    assert_eq!(thinking(&sent[1]), json!({ "type": "adaptive" }));
    assert!(!header(&sent[1], "anthropic-beta").unwrap().contains("thinking-display-updates"));
    assert!(!claude_floors::enabled(Feature::ProgressUpdates, "anthropic", model));
    assert!(claude_floors::enabled(Feature::ProgressUpdates, "anthropic-oauth", model), "the other route is its own record");
    // The next send of the model does not offer it again.
    endpoint.push(reply(200, OK));
    send(&adapter, ask(model, "again", RequestOptions::default())).await.unwrap();
    assert_eq!(endpoint.sent().len(), 3);
    assert_eq!(thinking(&endpoint.sent()[2]), json!({ "type": "adaptive" }));
}

#[tokio::test]
async fn a_floor_refusal_is_replayed_once_per_feature_and_a_second_refusal_surfaces() {
    let model = "claude-sonnet-5-7";
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", DISPLAY_REFUSAL), refusal(400, "invalid_request_error", DISPLAY_REFUSAL)]);
    let adapter = adapter(config(display_caps()), &endpoint);
    let err = send(&adapter, ask(model, "hi", RequestOptions::default())).await.expect_err("the replay is refused too");
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(err.status, Some(400));
    assert_eq!(endpoint.sent().len(), 2);
}

#[tokio::test]
async fn a_refusal_that_names_no_floor_feature_is_not_replayed_and_marks_nothing() {
    let model = "claude-sonnet-5-6";
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", "max_tokens: must be greater than 0")]);
    let adapter = adapter(config(display_caps()), &endpoint);
    assert!(send(&adapter, ask(model, "hi", RequestOptions::default())).await.is_err());
    assert_eq!(endpoint.sent().len(), 1);
    assert!(claude_floors::enabled(Feature::ProgressUpdates, "anthropic", model));
    // The same words under another status are not the model's refusal of the field either.
    let endpoint = Endpoint::new([refusal(500, "api_error", DISPLAY_REFUSAL)]);
    let adapter = self::adapter(config(display_caps()), &endpoint);
    assert!(send(&adapter, ask(model, "hi", RequestOptions::default())).await.is_err());
    assert!(claude_floors::enabled(Feature::ProgressUpdates, "anthropic", model));
}

#[tokio::test]
async fn a_refused_turn_scoped_reminder_is_replayed_and_the_model_stays_off_it() {
    let model = "claude-sonnet-5-9";
    let mut reminder = Message::new(Role::User, Content::Text("remember the rules".into()));
    reminder.source = Some(MessageSource::TailReminder);
    let request = Arc::new(ModelRequest {
        model: model.into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into())), reminder],
        tools: Vec::new(),
        options: RequestOptions::default(),
    });
    let endpoint = Endpoint::new([refusal(400, "invalid_request_error", "messages.1.clear_at: Extra inputs are not permitted"), reply(200, OK)]);
    let adapter = adapter(config(display_caps()), &endpoint);
    send(&adapter, request.clone()).await.unwrap();
    let sent = endpoint.sent();
    let messages = |r: &WireRequest| plain_body(r)["messages"].as_array().unwrap().clone();
    let first = messages(&sent[0]);
    assert_eq!(first.last().unwrap()["role"], "system", "the reminder rides as a turn-scoped system message");
    assert_eq!(first.last().unwrap()["clear_at"], "next_user_message");
    let second = messages(&sent[1]);
    assert!(second.iter().all(|m| m.get("clear_at").is_none()), "the replay carries it as a block of the user message");
    assert_eq!(second.last().unwrap()["role"], "user");
    assert!(!claude_floors::enabled(Feature::TurnScopedSystem, "anthropic", model));
    // A refusal of the content rule is the model taking the message, so it is surfaced rather than replayed.
    let other = Endpoint::new([refusal(400, "invalid_request_error", "messages.1.clear_at: supports text blocks only")]);
    let adapter = self::adapter(config(display_caps()), &other);
    assert!(send(&adapter, ask(model, "hi", RequestOptions::default())).await.is_err());
    assert_eq!(other.sent().len(), 1);
}

// ---------------------------------------------------------------------------
// SSE framing of the stream decoder (Node `lib/sse-framing.mjs`)
// ---------------------------------------------------------------------------

fn delta(text: &str) -> String {
    json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}).to_string()
}

/// The text each fed region produced, one entry per region.
fn texts_of_regions(regions: &[&str]) -> Vec<Vec<String>> {
    use mixdog_core_api::domain::provider::WireCodec;
    let codec = mixdog_ai::providers::anthropic::AnthropicCodec::new(mixdog_ai::providers::anthropic::Flavor::ApiKey, config(ModelCaps::default()));
    let mut decoder = codec.decoder(&ask("claude-sonnet-4-6", "hi", RequestOptions::default()));
    // The region that opens the text block the deltas write to: a delta of no open block is dropped.
    let open = json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}});
    decoder.feed(format!("event: content_block_start\ndata: {open}\n\n").as_bytes()).expect("the block opens");
    regions
        .iter()
        .map(|region| {
            decoder
                .feed(region.as_bytes())
                .expect("the region decodes")
                .into_iter()
                .filter_map(|event| match event {
                    StreamEvent::TextDelta(text) => Some(text),
                    _ => None,
                })
                .collect()
        })
        .collect()
}

#[test]
fn data_and_event_lines_frame_with_or_without_the_space_after_the_colon_and_other_lines_are_dropped() {
    let (a, b, c, d, e) = (delta("a"), delta("b"), delta("c"), delta("d"), delta("e"));
    let regions = [
        // `event:` and `data:` without the optional space.
        format!("event:content_block_delta\ndata:{a}\n\n"),
        // Comments, other fields and blank data lines are dropped; the record beside them is not.
        format!(": ping\nid: 7\ndata:\ndata: \nretry: 5\nevent: content_block_delta\ndata: {b}\n\n"),
        // CRLF transports: the trailing `\r` is trimmed from the value lines and a bare `\r` line is ignored.
        format!("event: content_block_delta\r\ndata: {c}\r\n\r\n"),
        // Many records of one chunk come out in order.
        format!("data: {d}\n\ndata: {e}\n\n"),
    ];
    let regions: Vec<&str> = regions.iter().map(String::as_str).collect();
    assert_eq!(texts_of_regions(&regions), [vec!["a"], vec!["b"], vec!["c"], vec!["d", "e"]]);
}

#[test]
fn a_record_split_across_network_chunks_is_decoded_when_its_line_completes() {
    let whole = format!("data: {}\n\n", delta("joined"));
    let (head, tail) = whole.split_at(whole.len() / 2);
    assert_eq!(texts_of_regions(&[head, tail]), [Vec::<String>::new(), vec!["joined".to_owned()]]);
}

#[test]
fn a_malformed_record_does_not_discard_the_well_formed_record_beside_it() {
    let good = delta("kept");
    let region = format!("data: {{oops\n\ndata: {good}\n\n");
    assert_eq!(texts_of_regions(&[&region]), [vec!["kept"]]);
}

// ---------------------------------------------------------------------------
// Server-side fallback (Node `anthropic-server-fallback.mjs`)
// ---------------------------------------------------------------------------

const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

fn fallback_options(model_parameters: Option<Value>) -> RequestOptions {
    RequestOptions { model_parameters, ..RequestOptions::default() }
}

/// The body and `anthropic-beta` header the adapter put on the wire for one turn of `model`.
async fn sent_for(model: &str, model_parameters: Option<Value>) -> (Value, String) {
    let endpoint = Endpoint::new([reply(200, OK)]);
    send(&adapter(config(ModelCaps::default()), &endpoint), ask(model, "hi", fallback_options(model_parameters))).await.unwrap();
    let sent = endpoint.sent();
    (plain_body(&sent[0]), header(&sent[0], "anthropic-beta").unwrap_or_default().to_owned())
}

#[tokio::test]
async fn only_the_opus_5_and_fable_5_families_opt_in_to_the_default_fallback_and_the_beta_follows_the_body() {
    for (model, eligible) in [
        ("claude-opus-5", true),
        ("claude-opus-5-20260801", true),
        ("claude-fable-5", true),
        ("claude-fable-5-20260801", true),
        ("claude-opus-4-8", false),
        ("claude-sonnet-4-6", false),
        ("claude-opus-55", false),
    ] {
        let (body, beta) = sent_for(model, None).await;
        assert_eq!(body.get("fallbacks"), eligible.then(|| json!("default")).as_ref(), "{model}: body");
        let names: Vec<&str> = beta.split(',').collect();
        assert_eq!(names.iter().filter(|n| **n == FALLBACK_BETA).count(), usize::from(eligible), "{model}: beta header {beta}");
    }
    // The beta is gated by the body: an eligible model that opted out sends neither.
    let (body, beta) = sent_for("claude-opus-5", Some(json!({"serverFallback": false}))).await;
    assert!(body.get("fallbacks").is_none());
    assert!(!beta.contains(FALLBACK_BETA), "{beta}");
    // Only an explicit `false` opts out.
    let (body, _) = sent_for("claude-opus-5", Some(json!({"serverFallback": true}))).await;
    assert_eq!(body["fallbacks"], "default");
    let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    let at = |name: &str| keys.iter().position(|k| *k == name).unwrap();
    assert_eq!((at("fallbacks"), at("stream")), (at("messages") + 1, keys.len() - 1), "{keys:?}: after the messages, before the trailing stream");
}

fn fallback_block() -> Value {
    json!({"type": "fallback", "from": {"model": "claude-opus-5"}, "to": {"model": "claude-opus-4-8"}, "trigger": {"type": "refusal", "category": "cyber"}})
}

fn recorded_fallbacks(events: &[StreamEvent]) -> Option<Value> {
    events.iter().find_map(|e| match e {
        StreamEvent::ProviderMetadata(meta) => Some(meta.clone()),
        _ => None,
    })
}

async fn events_of(adapter: &AnthropicAdapter, request: Arc<ModelRequest>) -> Vec<StreamEvent> {
    let mut stream = adapter.attempt(request).await.expect("the attempt opens");
    let mut events = Vec::new();
    while let Some(item) = stream.next().await {
        events.push(item.expect("the stream carries no failure"));
    }
    events
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap())).collect()
}

#[tokio::test]
async fn a_fallback_block_in_the_stream_is_recorded_and_the_turn_is_attributed_to_the_serving_model() {
    let stream = sse(&[
        json!({"type": "message_start", "message": {"model": "claude-opus-5", "usage": {"input_tokens": 10}}}),
        json!({"type": "content_block_start", "index": 0, "content_block": fallback_block()}),
        json!({"type": "content_block_stop", "index": 0}),
        json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
        json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "done"}}),
        json!({"type": "content_block_stop", "index": 1}),
        json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
        json!({"type": "message_stop"}),
    ]);
    let endpoint = Endpoint::new([reply(200, &stream)]);
    let events = events_of(&adapter(config(ModelCaps::default()), &endpoint), ask("claude-opus-5", "hi", RequestOptions::default())).await;
    let text: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
    assert_eq!(text, "done", "the fallback block is no text of the turn");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ServedModel(model) if model == "claude-opus-4-8")), "{events:?}");
    assert_eq!(
        recorded_fallbacks(&events),
        Some(
            json!({"anthropicFallbacks": [{"trigger": "refusal", "originalModel": "claude-opus-5", "fallbackModel": "claude-opus-4-8", "category": "cyber"}]})
        )
    );
}

#[tokio::test]
async fn a_fallback_block_names_its_models_as_strings_or_objects_defaults_its_trigger_and_is_ignored_without_both_models() {
    for (block, record) in [
        (
            json!({"type": "fallback", "from": " claude-opus-5 ", "to": "claude-opus-4-8", "trigger": {"type": " refusal ", "category": "  "}}),
            Some(json!({"trigger": "refusal", "originalModel": "claude-opus-5", "fallbackModel": "claude-opus-4-8"})),
        ),
        (
            json!({"type": "fallback", "from": {"model": "claude-opus-5"}, "to": {"model": "claude-opus-4-8"}}),
            Some(json!({"trigger": "refusal", "originalModel": "claude-opus-5", "fallbackModel": "claude-opus-4-8"})),
        ),
        (json!({"type": "fallback", "from": {"model": "claude-opus-5"}}), None),
        (json!({"type": "fallback", "from": "claude-opus-5", "to": {"model": " "}}), None),
    ] {
        let stream = sse(&[
            json!({"type": "message_start", "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1}}}),
            json!({"type": "content_block_start", "index": 0, "content_block": block}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}}),
            json!({"type": "message_stop"}),
        ]);
        let endpoint = Endpoint::new([reply(200, &stream)]);
        let events = events_of(&adapter(config(ModelCaps::default()), &endpoint), ask("claude-opus-5", "hi", RequestOptions::default())).await;
        assert_eq!(recorded_fallbacks(&events), record.map(|r| json!({"anthropicFallbacks": [r]})), "{block}");
    }
}

#[tokio::test]
async fn a_streaming_404_is_reissued_without_streaming_and_its_fallback_block_is_excluded_from_the_text() {
    let message = json!({
        "model": "claude-opus-5",
        "content": [fallback_block(), {"type": "text", "text": "done"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": 2},
    });
    let endpoint = Endpoint::new([refusal(404, "not_found_error", "no streaming here"), reply(200, &message.to_string())]);
    let events = events_of(&adapter(config(ModelCaps::default()), &endpoint), ask("claude-opus-5", "hi", RequestOptions::default())).await;
    let sent = endpoint.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(plain_body(&sent[0])["stream"], true);
    assert_eq!(plain_body(&sent[1])["stream"], false, "the re-issue is `{{ ...params, stream: false }}`");
    assert!(header(&sent[1], "x-stainless-timeout").is_some(), "and carries the SDK's timeout header");
    assert!(header(&sent[0], "x-stainless-timeout").is_none());
    // The whole text arrives at once; the fallback block is no part of it.
    let text: Vec<&str> = events.iter().filter_map(|e| if let StreamEvent::FinalContent(t) = e { Some(t.as_str()) } else { None }).collect();
    assert_eq!(text, ["done"]);
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ServedModel(model) if model == "claude-opus-4-8")), "{events:?}");
    assert_eq!(
        recorded_fallbacks(&events),
        Some(
            json!({"anthropicFallbacks": [{"trigger": "refusal", "originalModel": "claude-opus-5", "fallbackModel": "claude-opus-4-8", "category": "cyber"}]})
        )
    );
}

// ---------------------------------------------------------------------------
// Replay blocks (Node `lib/anthropic-replay-blocks.mjs`)
// ---------------------------------------------------------------------------

fn think(tag: &str) -> Value {
    json!({"type": "thinking", "thinking": tag, "signature": "sig"})
}

fn text(tag: &str) -> Value {
    json!({"type": "text", "text": tag})
}

fn reduced(blocks: &[Value]) -> (Vec<Value>, Vec<&'static str>) {
    use mixdog_ai::providers::anthropic::replay_blocks;
    let mut drops = Vec::new();
    let out = replay_blocks::sanitize(blocks, &mut |dropped, _| drops.push(dropped.kind()));
    (out, drops)
}

#[test]
fn an_empty_text_block_is_never_replayed_and_a_thinking_run_the_removal_would_fuse_keeps_only_its_first_part() {
    let empty = text("");
    let tool = json!({"type": "tool_use", "id": "t1", "name": "read", "input": {}});
    // The turn the model streamed as [thinking, "", thinking, text, tool_use]: the two runs would fuse.
    let (out, drops) = reduced(&[think("t0"), empty.clone(), think("t1"), text("answer"), tool.clone()]);
    assert_eq!(out, [think("t0"), text("answer"), tool.clone()]);
    assert_eq!(drops, ["empty_text", "merged_thinking"]);
    // Thinking the model really did emit back to back is one run already: untouched.
    let (out, drops) = reduced(&[think("t0"), think("t1"), text("answer")]);
    assert_eq!((out, drops), (vec![think("t0"), think("t1"), text("answer")], vec![]));
    // An empty text with a kept block between the thinking blocks separates nothing that was not separate.
    let (out, drops) = reduced(&[think("t0"), text("between"), empty.clone(), think("t1")]);
    assert_eq!((out, drops), (vec![think("t0"), text("between"), think("t1")], vec!["empty_text"]));
    // A text block with no `text` string is empty too; a redacted block is a thinking block; non-objects are skipped.
    let redacted = json!({"type": "redacted_thinking", "data": "x"});
    let (out, drops) = reduced(&[redacted.clone(), json!({"type": "text"}), think("t1"), json!(null), json!("x")]);
    assert_eq!((out, drops), (vec![redacted], vec!["empty_text", "merged_thinking"]));
}

#[test]
fn entries_are_ordered_by_their_stream_index_before_they_are_reduced_and_the_thinking_run_keeps_the_survivors() {
    use mixdog_ai::providers::anthropic::replay_blocks;
    let entries = [(3, text("answer")), (2, think("t1")), (1, text("")), (0, think("t0"))];
    let mut drops = Vec::new();
    let out = replay_blocks::sanitize_entries(&entries, &mut |dropped, _| drops.push(dropped.kind()));
    assert_eq!(out, [think("t0"), text("answer")]);
    assert_eq!(drops, ["empty_text", "merged_thinking"]);
    let run = replay_blocks::thinking_run(&[think("t0"), text(""), think("t1"), text("answer")], &mut |_, _| {});
    assert_eq!(run, [think("t0")]);
}

// ---------------------------------------------------------------------------
// A computer frame the desktop already fitted to its capture size
// ---------------------------------------------------------------------------

#[test]
fn a_bound_computer_frame_goes_out_with_its_bytes_and_media_type_unchanged() {
    use mixdog_ai::providers::anthropic::CacheStrategy;
    use mixdog_core_api::domain::provider::ContentPart;
    use mixdog_core_api::domain::provider::ImageSource;
    use mixdog_core_api::domain::provider::WireCodec;
    // A 1x1 PNG and the same bytes declared as a JPEG: neither is decoded, resized or re-encoded on the way out.
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    let frames = [(png, "image/png", Some((1280, 800))), ("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////", "image/jpeg", None)];
    let mut config = config(ModelCaps::default());
    // The message layer carries no cache breakpoint, so the content is exactly what was given.
    config.cache = CacheStrategy { system: None, tier3: None, messages: None };
    let codec = mixdog_ai::providers::anthropic::AnthropicCodec::new(mixdog_ai::providers::anthropic::Flavor::ApiKey, config);
    for (data, mime, size) in frames {
        let image =
            ContentPart::Image(ImageSource::Base64 { data: data.to_owned(), mime_type: mime.to_owned(), width: size.map(|s| s.0), height: size.map(|s| s.1) });
        let request = ModelRequest {
            model: "claude-sonnet-4-5".into(),
            messages: vec![Message::new(Role::User, Content::Parts(vec![image]))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let wire = codec.encode(&request).expect("the request encodes");
        let body: Value = serde_json::from_slice(&wire.body).unwrap();
        assert_eq!(body["messages"], json!([{"role": "user", "content": [{"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}}]}]));
    }
}

// ---------------------------------------------------------------------------
// The Anthropic SDK's header spelling on the wire of a gateway engine
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_gateway_messages_post_carries_the_sdks_headers_in_the_sdks_spelling_and_order() {
    use mixdog_ai::registry::gateway::GatewayHttp;
    use mixdog_ai::registry::gateway::Sdk;
    let endpoint = Endpoint::new([reply(200, OK)]);
    let http: Arc<dyn HttpSend> = Arc::new(GatewayHttp::new(endpoint.clone()).through_sdk(Sdk::Anthropic, &[]));
    let adapter = AnthropicAdapter::api_key(config(ModelCaps::default()), http, Arc::new(Key), mixdog_rt::testing::tokens().cpu_bulk);
    send(&adapter, ask("claude-sonnet-4-6", "hi", RequestOptions::default())).await.unwrap();
    let all = endpoint.sent();
    let names: Vec<&str> = all[0].headers.iter().map(|(k, _)| k.as_str()).collect();
    // The SDK's own headers first, in the case the SDK writes them; then the codec's key, the body type and the betas.
    assert_eq!(
        names,
        [
            "Accept",
            "User-Agent",
            "X-Stainless-Retry-Count",
            "X-Stainless-Timeout",
            "X-Stainless-Lang",
            "X-Stainless-Package-Version",
            "X-Stainless-OS",
            "X-Stainless-Arch",
            "X-Stainless-Runtime",
            "X-Stainless-Runtime-Version",
            "anthropic-version",
            "x-api-key",
            "content-type",
            "anthropic-beta",
        ]
    );
    let sent = &all[0];
    assert_eq!(header(sent, "user-agent"), Some("Anthropic/JS 0.137.0"));
    assert_eq!(header(sent, "x-stainless-package-version"), Some("0.137.0"));
    assert_eq!(header(sent, "x-stainless-timeout"), Some("600"));
    assert_eq!(header(sent, "x-stainless-lang"), Some("js"));
    assert_eq!(count_of(sent, "accept"), 1, "the codec's own accept is the SDK's");
}
