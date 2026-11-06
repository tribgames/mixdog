//! Conformance of both Anthropic providers against the recorded Node
//! behaviour: request bytes, stream-to-item folding, usage, typed errors,
//! retry rows with the seeded jitter samples, and the OAuth refresh exchange.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::conformance::check_provider_attempt;
use mixdog_core_api::domain::conformance::check_retry_policy;
use mixdog_core_api::domain::conformance::check_wire_codec;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::AnthropicAdapter;
use super::AnthropicCodec;
use super::AnthropicConfig;
use super::ApiKeySource;
use super::Flavor;
use super::ModelCaps;
use super::OAuthSession;
use super::StoredOAuth;
use crate::oauth::CredentialFile;
use crate::oauth::CredentialIo;
use crate::oauth::Probe;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn read_text(relative: &str) -> String {
    std::fs::read_to_string(fixtures().join(relative)).unwrap_or_else(|e| panic!("{relative}: {e}"))
}

fn read_json(relative: &str) -> Value {
    serde_json::from_str(&read_text(relative)).unwrap_or_else(|e| panic!("{relative}: {e}"))
}

fn api(scenario: &str, file: &str) -> String {
    format!("providers/anthropic/{scenario}/{file}")
}

fn oauth_exchange(scenario: &str) -> Value {
    read_json(&format!("providers-intercepted/anthropic-oauth/{scenario}/exchange.json"))
}

/// The record of the Messages POST in an intercepted exchange.
fn messages_post(exchange: &Value) -> Value {
    exchange["records"]
        .as_array()
        .expect("records")
        .iter()
        .find(|r| r["path"] == "/v1/messages")
        .expect("a /v1/messages record")
        .clone()
}

fn sonnet_caps() -> ModelCaps {
    ModelCaps {
        adaptive_thinking: true,
        manual_thinking: false,
        effort_levels: vec!["low".into(), "medium".into(), "high".into()],
        max_output_tokens: Some(16384),
        fast_mode: false,
        context_window: None,
        thinking_display_updates: false,
    }
}

pub(super) fn config(base_url: &str) -> AnthropicConfig {
    let mut config = AnthropicConfig::new(Arc::new(|model: &str| {
        (model == "claude-sonnet-4-6").then(sonnet_caps)
    }));
    config.base_url = base_url.to_owned();
    config
}

fn tools() -> Vec<ToolDefinition> {
    vec![ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({
            "type": "object",
            "properties": { "key": { "type": "string" } },
            "required": ["key"],
        }),
        defer_loading: false,
    }]
}

pub(super) fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn base_messages() -> Vec<Message> {
    vec![
        text_message(Role::System, "You are a fixture assistant."),
        text_message(Role::User, "Look up the answer."),
    ]
}

fn with_result() -> Vec<Message> {
    let mut messages = base_messages();
    let mut assistant = text_message(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "call_fx1".into(),
        name: "lookup".into(),
        arguments: json!({ "key": "answer" }),
        native_type: None,
    });
    let mut result = text_message(Role::Tool, "42");
    result.tool_call_id = Some("call_fx1".into());
    messages.push(assistant);
    messages.push(result);
    messages
}

pub(super) fn request(messages: Vec<Message>, options: RequestOptions) -> ModelRequest {
    ModelRequest {
        model: "claude-sonnet-4-6".into(),
        messages,
        tools: tools(),
        options,
    }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
    headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .unwrap_or_else(|| panic!("header {name}"))
}

/// Folds an attempt's events into what the recorded `result.json` describes.
#[derive(Debug, Default)]
struct Folded {
    content: String,
    tool_calls: Vec<ToolCall>,
    stop: Option<StopReason>,
    usage: Option<mixdog_core_api::domain::provider::Usage>,
    replay: Vec<ProviderReplay>,
}

fn fold(events: &[StreamEvent]) -> Folded {
    let mut folded = Folded::default();
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => folded.content.push_str(text),
            StreamEvent::ToolCallDone(call) => folded.tool_calls.push(call.clone()),
            StreamEvent::Usage(usage) => folded.usage = Some(usage.clone()),
            StreamEvent::ReasoningReplay(replay) => folded.replay.push(replay.clone()),
            StreamEvent::Completed { stop, .. } => folded.stop = stop.clone(),
            _ => {}
        }
    }
    folded
}

fn decode_all(codec: &AnthropicCodec, body: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
    let mut decoder = codec.decoder(&request(Vec::new(), RequestOptions::default()));
    let mut events = decoder.feed(body)?;
    events.extend(decoder.finish()?);
    Ok(events)
}

fn api_codec() -> AnthropicCodec {
    AnthropicCodec::new(Flavor::ApiKey, config("http://127.0.0.1:1"))
}

fn oauth_codec() -> AnthropicCodec {
    AnthropicCodec::new(Flavor::OAuth, config("https://api.anthropic.com"))
}

fn oauth_codec_without_thinking() -> AnthropicCodec {
    let mut config = AnthropicConfig::new(Arc::new(|model: &str| {
        (model == "claude-sonnet-4-6").then(|| ModelCaps {
            adaptive_thinking: false,
            effort_levels: Vec::new(),
            ..sonnet_caps()
        })
    }));
    config.base_url = "https://api.anthropic.com".to_owned();
    AnthropicCodec::new(Flavor::OAuth, config)
}

// ---------------------------------------------------------------------------
// Scripted transport
// ---------------------------------------------------------------------------

pub(super) struct Scripted {
    status: u16,
    headers: Vec<(String, String)>,
    chunks: Vec<Vec<u8>>,
    /// A fault after the chunks instead of a clean end.
    fault: Option<TransportFault>,
}

impl Scripted {
    pub(super) fn body(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: Vec::new(),
            chunks: vec![body.as_bytes().to_vec()],
            fault: None,
        }
    }
}

struct ScriptedBody {
    chunks: VecDeque<Vec<u8>>,
    fault: Option<TransportFault>,
}

#[async_trait]
impl BodyStream for ScriptedBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, TransportFault>> {
        if let Some(chunk) = self.chunks.pop_front() {
            return Some(Ok(chunk.into()));
        }
        self.fault.take().map(Err)
    }
}

#[derive(Default)]
pub(super) struct ScriptedHttp {
    script: Mutex<VecDeque<Scripted>>,
    sent: Mutex<Vec<mixdog_core_api::domain::provider::WireRequest>>,
}

impl ScriptedHttp {
    pub(super) fn new(script: impl IntoIterator<Item = Scripted>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into_iter().collect()),
            sent: Mutex::default(),
        })
    }

    pub(super) fn sent(&self) -> Vec<mixdog_core_api::domain::provider::WireRequest> {
        self.sent.lock().expect("sent").clone()
    }
}

#[async_trait]
impl HttpSend for ScriptedHttp {
    async fn send(
        &self,
        request: mixdog_core_api::domain::provider::WireRequest,
    ) -> Result<HttpResponse, ProviderError> {
        self.sent.lock().expect("sent").push(request);
        let next = self.script.lock().expect("script").pop_front().expect("scripted response");
        Ok(HttpResponse {
            status: next.status,
            headers: next.headers,
            body: Box::new(ScriptedBody {
                chunks: next.chunks.into(),
                fault: next.fault,
            }),
        })
    }
}

pub(super) struct FixedKey;

#[async_trait]
impl ApiKeySource for FixedKey {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("fixture-key-not-a-credential".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        self.key().await
    }
}

/// A real shared credential file in a temp directory.
pub(super) struct MemoryStore {
    _dir: tempfile::TempDir,
    path: PathBuf,
    file: CredentialFile,
}

impl MemoryStore {
    fn credential() -> StoredOAuth {
        StoredOAuth {
            access_token: "fixture-access-token".into(),
            refresh_token: "fixture-refresh-token".into(),
            expires_at: 4_000_000_000_000,
            scopes: vec!["user:inference".into(), "user:profile".into()],
            reauth_required: None,
            subscription_type: Some("max".into()),
            identity: None,
            extra: Default::default(),
        }
    }

    pub(super) fn signed_in() -> Arc<Self> {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("anthropic-oauth-credentials.json");
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(
            path.clone(),
            CredentialIo {
                read: tokens.interactive_io,
                write: tokens.durability_io,
            },
        );
        let store = Arc::new(Self { _dir: dir, path, file });
        store.write(&Self::credential());
        store
    }

    #[allow(clippy::disallowed_methods, reason = "test-only seeding of a credential file")]
    fn write(&self, stored: &StoredOAuth) {
        let document = json!({ "claudeAiOauth": stored, "unrelated": { "kept": true } });
        std::fs::write(&self.path, serde_json::to_vec(&document).expect("json")).expect("write");
    }

    async fn load(&self) -> Option<StoredOAuth> {
        let Probe::Present(document) = self.file.load_document().await else {
            return None;
        };
        Some(serde_json::from_value(document["claudeAiOauth"].clone()).expect("stored credential"))
    }

    async fn document(&self) -> serde_json::Map<String, Value> {
        let Probe::Present(document) = self.file.load_document().await else {
            panic!("credential file");
        };
        document
    }
}

fn api_adapter(http: Arc<ScriptedHttp>) -> AnthropicAdapter {
    AnthropicAdapter::api_key(config("http://127.0.0.1:1"), http, Arc::new(FixedKey), cpu_bulk())
}

pub(super) fn cpu_bulk() -> mixdog_rt::CpuBulk {
    mixdog_rt::testing::tokens().cpu_bulk
}

pub(super) fn oauth_adapter(http: Arc<ScriptedHttp>, store: Arc<MemoryStore>) -> AnthropicAdapter {
    let session = Arc::new(OAuthSession::new(store.file.clone(), http.clone()));
    AnthropicAdapter::oauth(config("https://api.anthropic.com"), http, session, false, cpu_bulk())
}

async fn drain(stream: &mut dyn ModelStream) -> Vec<Result<StreamEvent, ProviderError>> {
    let mut items = Vec::new();
    while let Some(item) = stream.next().await {
        items.push(item);
    }
    items
}

// ---------------------------------------------------------------------------
// Request bytes
// ---------------------------------------------------------------------------

fn recorded_api_body(scenario: &str) -> (String, Value) {
    let recorded = read_json(&api(scenario, "request.json"));
    let request = &recorded["requests"][0];
    (
        request["bodyText"].as_str().expect("bodyText").to_owned(),
        request["headers"].clone(),
    )
}

#[test]
fn api_key_request_bytes_equal_the_recording() {
    for (scenario, messages) in [
        ("text", base_messages()),
        ("tool-call", base_messages()),
        ("error-400", base_messages()),
        ("tool-result-followup", with_result()),
    ] {
        let (expected, headers) = recorded_api_body(scenario);
        let wire = api_codec()
            .encode(&request(messages, RequestOptions::default()))
            .expect("encode");
        assert_eq!(String::from_utf8(wire.body).expect("utf8"), expected, "{scenario}");
        assert_eq!(wire.url, "http://127.0.0.1:1/v1/messages");
        assert_eq!(wire.method, "POST");
        assert_eq!(header(&wire.headers, "anthropic-beta"), headers["anthropic-beta"]);
        assert_eq!(header(&wire.headers, "anthropic-version"), headers["anthropic-version"]);
    }
}

#[test]
fn oauth_request_bytes_equal_the_recording() {
    for scenario in ["text", "tool-call", "error-400", "error-401", "truncated-eof", "truncated-reset"] {
        let record = messages_post(&oauth_exchange(scenario));
        // Only the `text` recording ran with a model catalog that knew thinking;
        // the others recorded the model's output limit without it.
        let codec = if scenario == "text" { oauth_codec() } else { oauth_codec_without_thinking() };
        let wire = codec
            .encode(&request(base_messages(), RequestOptions::default()))
            .expect("encode");
        assert_eq!(
            String::from_utf8(wire.body).expect("utf8"),
            record["bodyText"].as_str().expect("bodyText"),
            "{scenario}"
        );
        for name in [
            "anthropic-beta",
            "anthropic-version",
            "anthropic-dangerous-direct-browser-access",
            "user-agent",
            "x-app",
        ] {
            assert_eq!(header(&wire.headers, name), record["headers"][name], "{scenario} {name}");
        }
    }
}

#[test]
fn oauth_request_builders_match_the_vectors() {
    let vectors = read_json("providers/request-builders/anthropic-oauth.json");
    let cases = [
        ("text", base_messages(), RequestOptions::default()),
        ("toolResult", with_result(), RequestOptions::default()),
        (
            "effortHigh",
            base_messages(),
            RequestOptions {
                effort: Some("high".into()),
                ..RequestOptions::default()
            },
        ),
    ];
    for (name, messages, options) in cases {
        let wire = oauth_codec().encode(&request(messages, options)).expect("encode");
        let body: Value = serde_json::from_slice(&wire.body).expect("json");
        assert_eq!(body, vectors[name], "{name}");
    }
}

#[test]
fn gateway_base_url_drops_first_party_tool_streaming() {
    let wire = api_codec()
        .encode(&request(base_messages(), RequestOptions::default()))
        .expect("encode");
    let body: Value = serde_json::from_slice(&wire.body).expect("json");
    assert!(body["tools"][0].get("eager_input_streaming").is_none());
    let official = AnthropicCodec::new(Flavor::ApiKey, config("https://api.anthropic.com"))
        .encode(&request(base_messages(), RequestOptions::default()))
        .expect("encode");
    let body: Value = serde_json::from_slice(&official.body).expect("json");
    assert_eq!(body["tools"][0]["eager_input_streaming"], true);
}

#[test]
fn unknown_model_gets_no_thinking_and_the_floor_max_tokens() {
    let mut req = request(base_messages(), RequestOptions::default());
    req.model = "claude-unlisted".into();
    let wire = api_codec().encode(&req).expect("encode");
    let body: Value = serde_json::from_slice(&wire.body).expect("json");
    assert_eq!(body["max_tokens"], 8192);
    assert!(body.get("thinking").is_none());
}

#[test]
fn manual_budget_on_an_adaptive_only_model_is_a_local_error() {
    let options = RequestOptions {
        model_parameters: Some(json!({ "thinkingBudgetTokens": 4096 })),
        ..RequestOptions::default()
    };
    let err = api_codec()
        .encode(&request(base_messages(), options))
        .expect_err("rejected locally");
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(err.delivery, DeliveryState::NotSent);
}

#[test]
fn cache_breakpoints_follow_the_layout() {
    let mut messages = base_messages();
    let mut tier3 = text_message(Role::System, "session marker");
    tier3.cache_tier = Some(mixdog_core_api::domain::provider::CacheTier::Tier3);
    let mut env = text_message(Role::System, "environment");
    env.cache_tier = Some(mixdog_core_api::domain::provider::CacheTier::Env);
    messages.insert(1, tier3);
    messages.insert(2, env);
    let wire = oauth_codec()
        .encode(&request(messages, RequestOptions::default()))
        .expect("encode");
    let body: Value = serde_json::from_slice(&wire.body).expect("json");
    let system = body["system"].as_array().expect("system");
    assert_eq!(system.len(), 4);
    assert!(system[0].get("cache_control").is_none(), "gating prefix is never cached");
    assert_eq!(system[1]["cache_control"], json!({ "type": "ephemeral", "ttl": "1h" }));
    assert_eq!(system[2]["cache_control"], json!({ "type": "ephemeral", "ttl": "1h" }));
    assert!(system[3].get("cache_control").is_none(), "env rides the message tail");
    assert_eq!(system[3]["text"], "\n\nenvironment");
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

fn lowered(messages: Vec<Message>) -> Value {
    let wire = api_codec()
        .encode(&request(messages, RequestOptions::default()))
        .expect("encode");
    serde_json::from_slice::<Value>(&wire.body).expect("json")["messages"].clone()
}

#[test]
fn user_text_after_a_tool_result_folds_into_it() {
    let mut messages = with_result();
    messages.push(text_message(Role::User, "  thanks  "));
    let out = lowered(messages);
    let last = out.as_array().expect("array").last().expect("last").clone();
    assert_eq!(last["role"], "user");
    assert_eq!(last["content"].as_array().expect("blocks").len(), 1);
    assert_eq!(last["content"][0]["content"], "42\n\nthanks");
}

#[test]
fn invalid_tool_ids_get_one_deterministic_stand_in_for_call_and_result() {
    let mut messages = base_messages();
    let mut assistant = text_message(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "call:fx.1".into(),
        name: "lookup".into(),
        arguments: json!({}),
        native_type: None,
    });
    let mut result = text_message(Role::Tool, "ok");
    result.tool_call_id = Some("call:fx.1".into());
    messages.extend([assistant, result]);
    let out = lowered(messages);
    let call_id = out[1]["content"][0]["id"].as_str().expect("id").to_owned();
    assert!(call_id.starts_with("call_fx_1_"), "{call_id}");
    assert_eq!(out[2]["content"][0]["tool_use_id"], call_id.as_str());
}

#[test]
fn unanswered_tool_use_gets_an_error_stub() {
    let mut messages = base_messages();
    let mut assistant = text_message(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "toolu_1".into(),
        name: "lookup".into(),
        arguments: json!({}),
        native_type: None,
    });
    messages.push(assistant);
    let out = lowered(messages);
    assert_eq!(out[2]["role"], "user");
    assert_eq!(out[2]["content"][0]["tool_use_id"], "toolu_1");
    assert_eq!(out[2]["content"][0]["is_error"], true);
}

#[test]
fn replay_blocks_come_back_verbatim_and_only_for_their_owner() {
    let mut messages = base_messages();
    let mut assistant = text_message(Role::Assistant, "ignored text");
    let blocks = json!([
        { "type": "thinking", "thinking": "hm", "signature": "sig" },
        { "type": "tool_use", "id": "toolu_9", "name": "lookup", "input": {"key": "k"} },
    ]);
    assistant.push_replay(ProviderReplay {
        owner: ProviderId::from("anthropic"),
        items: blocks.clone(),
    });
    assistant.push_replay(ProviderReplay {
        owner: ProviderId::from("openai"),
        items: json!([{ "type": "foreign" }]),
    });
    let mut result = text_message(Role::Tool, "v");
    result.tool_call_id = Some("toolu_9".into());
    messages.extend([assistant, result]);
    let out = lowered(messages);
    assert_eq!(out[1]["content"], blocks);
}

#[test]
fn error_results_keep_only_text_and_hoist_media() {
    let mut messages = base_messages();
    let mut assistant = text_message(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "toolu_1".into(),
        name: "lookup".into(),
        arguments: json!({}),
        native_type: None,
    });
    let mut result = Message::new(
        Role::Tool,
        Content::Parts(vec![
            ContentPart::Text("failed".into(), false),
            ContentPart::Image(mixdog_core_api::domain::provider::ImageSource::Base64 {
                data: "AAAA".into(),
                mime_type: "image/png".into(),
            }),
        ]),
    );
    result.tool_call_id = Some("toolu_1".into());
    result.is_error = true;
    messages.extend([assistant, result]);
    let out = lowered(messages);
    let blocks = out[2]["content"].as_array().expect("blocks");
    assert_eq!(blocks[0]["is_error"], true);
    assert_eq!(blocks[0]["content"][0]["type"], "text");
    assert_eq!(blocks[1]["type"], "image");
}

// ---------------------------------------------------------------------------
// Stream decoding
// ---------------------------------------------------------------------------

#[test]
fn recorded_streams_fold_to_the_recorded_results() {
    for scenario in ["text", "tool-call", "tool-result-followup", "cache-write-1h"] {
        let body = read_text(&api(scenario, "response.sse"));
        let result = read_json(&api(scenario, "result.json"));
        let events = decode_all(&api_codec(), body.as_bytes()).expect("decodes");
        let folded = fold(&events);
        let ok = &result["ok"];
        assert_eq!(folded.content, ok["content"].as_str().expect("content"), "{scenario}");
        assert_eq!(folded.tool_calls.len(), ok["toolCalls"].as_array().expect("calls").len());
        for (call, expected) in folded.tool_calls.iter().zip(ok["toolCalls"].as_array().expect("calls")) {
            assert_eq!(call.id, expected["id"].as_str().expect("id"));
            assert_eq!(call.name, expected["name"].as_str().expect("name"));
            assert_eq!(call.arguments, expected["arguments"]);
        }
        let stop = match ok["stopReason"].as_str().expect("stop") {
            "end_turn" => StopReason::EndTurn,
            "tool_use" => StopReason::ToolUse,
            other => panic!("{other}"),
        };
        assert_eq!(folded.stop, Some(stop), "{scenario}");
        let usage = folded.usage.expect("usage");
        // Mixdog input is Node's `promptTokens`: fresh input plus cache read and write.
        assert_eq!(usage.input_tokens, ok["usage"]["promptTokens"].as_u64().expect("in"), "{scenario}");
        assert_eq!(usage.output_tokens, ok["usage"]["outputTokens"].as_u64().expect("out"));
        assert_eq!(usage.cache_read_tokens, ok["usage"]["cachedTokens"].as_u64().expect("cached"));
        assert_eq!(usage.cache_write_tokens, ok["usage"]["cacheWriteTokens"].as_u64().expect("write"));
        // Node reports `cacheWrite1hTokens` only when positive.
        assert_eq!(
            usage.cache_write_1h_tokens,
            ok["usage"]["cacheWrite1hTokens"].as_u64().unwrap_or(0),
            "{scenario} 1h cache write"
        );
        assert_eq!(usage.raw, Some(ok["usage"]["raw"].clone()), "{scenario} raw usage");
        assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })));
    }
}

#[test]
fn oauth_recorded_streams_fold_to_the_recorded_results() {
    for scenario in ["text", "tool-call"] {
        let record = messages_post(&oauth_exchange(scenario));
        let result = read_json(&format!(
            "providers-intercepted/anthropic-oauth/{scenario}/result.json"
        ));
        let events = decode_all(&oauth_codec(), record["served"].as_str().expect("served").as_bytes())
            .expect("decodes");
        let folded = fold(&events);
        assert_eq!(folded.content, result["ok"]["content"].as_str().expect("content"));
        assert_eq!(folded.tool_calls.len(), result["ok"]["toolCalls"].as_array().expect("calls").len());
        assert_eq!(folded.usage.expect("usage").output_tokens, result["ok"]["usage"]["outputTokens"].as_u64().expect("out"));
    }
}

#[test]
fn recorded_stream_satisfies_the_codec_conformance() {
    let complete = read_text(&api("text", "response.sse"));
    let truncated = read_text(&api("truncated-no-terminal", "response.sse"));
    for split_at in [0, 7, 100, complete.len() / 2, complete.len()] {
        check_wire_codec(&api_codec(), &request(Vec::new(), RequestOptions::default()), complete.as_bytes(), truncated.as_bytes(), split_at);
    }
}

#[test]
fn crlf_framing_and_comments_decode_like_lf() {
    let body = read_text(&api("text", "response.sse")).replace('\n', "\r\n");
    let with_comments = format!(": keepalive\r\n{body}");
    let events = decode_all(&api_codec(), with_comments.as_bytes()).expect("decodes");
    assert_eq!(fold(&events).content, "The result is 42.");
}

#[test]
fn a_stream_cut_after_text_is_truncated_with_exposure() {
    let body = read_text(&api("truncated-no-terminal", "response.sse"));
    let err = decode_all(&api_codec(), body.as_bytes()).expect_err("truncated");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert_eq!(err.kind, ErrorKind::Transient);
    assert!(err.exposure.text_emitted);
    assert!(!err.exposure.tool_dispatched);
}

#[test]
fn a_stop_with_tool_input_still_streaming_is_a_cut() {
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"lookup\",\"input\":{}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"k\"}}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n",
    );
    let err = decode_all(&api_codec(), body.as_bytes()).expect_err("cut");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert!(err.exposure.tool_input_cut);
    assert!(!err.exposure.tool_dispatched);
}

#[test]
fn malformed_tool_input_is_a_call_carrying_the_parse_failure() {
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"lookup\",\"input\":{}}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{oops\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":3}}\n\n",
    );
    let folded = fold(&decode_all(&api_codec(), body.as_bytes()).expect("decodes"));
    assert_eq!(folded.tool_calls.len(), 1);
    assert_eq!(folded.tool_calls[0].arguments["__invalidToolArgs"], true);
    assert_eq!(folded.tool_calls[0].arguments["__rawArguments"], "{oops");
}

#[test]
fn thinking_blocks_replay_with_their_signature_and_never_fuse_runs() {
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"a\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"s1\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"s2\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":3}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    let folded = fold(&decode_all(&api_codec(), body.as_bytes()).expect("decodes"));
    assert_eq!(folded.replay.len(), 1);
    assert_eq!(folded.replay[0].owner, ProviderId::from("anthropic"));
    assert_eq!(
        folded.replay[0].items,
        json!([
            { "type": "thinking", "thinking": "a", "signature": "s1" },
            { "type": "text", "text": "done" },
        ])
    );
}

#[test]
fn an_error_event_is_a_typed_provider_error() {
    let body = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n",
    );
    let err = decode_all(&api_codec(), body.as_bytes()).expect_err("error event");
    assert_eq!(err.kind, ErrorKind::Overloaded);
    assert_eq!(err.status, Some(529));
    assert_eq!(err.code.as_deref(), Some("overloaded_error"));
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

fn response(status: u16, headers: &[(&str, &str)], body: &str) -> ErrorResponse {
    ErrorResponse {
        status: Some(status),
        headers: headers.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
        body: body.as_bytes().to_vec(),
    }
}

#[test]
fn recorded_upstream_errors_classify_to_the_recorded_status() {
    let recorded = read_text(&api("error-400", "response.sse"));
    let err = api_codec().classify(&response(400, &[], &recorded));
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(err.status, Some(400));
    assert_eq!(err.code.as_deref(), Some("invalid_request_error"));
    assert_eq!(err.delivery, DeliveryState::Accepted);
    for (scenario, status, kind) in [("error-400", 400, ErrorKind::InvalidRequest), ("error-401", 401, ErrorKind::Auth)] {
        let record = messages_post(&oauth_exchange(scenario));
        let err = oauth_codec().classify(&response(status, &[], record["served"].as_str().expect("served")));
        assert_eq!(err.kind, kind, "{scenario}");
        assert_eq!(err.status, Some(status));
    }
}

#[test]
fn status_table_headers_and_quota_flags() {
    let codec = api_codec();
    let kind = |status, headers: &[(&str, &str)]| codec.classify(&response(status, headers, "")).kind;
    assert_eq!(kind(401, &[]), ErrorKind::Auth);
    assert_eq!(kind(402, &[]), ErrorKind::Billing);
    assert_eq!(kind(403, &[]), ErrorKind::Permission);
    assert_eq!(kind(413, &[]), ErrorKind::RequestTooLarge);
    assert_eq!(kind(429, &[]), ErrorKind::RateLimited);
    assert_eq!(kind(529, &[]), ErrorKind::Overloaded);
    assert_eq!(kind(500, &[]), ErrorKind::Transient);
    assert_eq!(kind(409, &[]), ErrorKind::Transient);
    assert_eq!(kind(525, &[]), ErrorKind::Unknown);
    assert_eq!(kind(404, &[]), ErrorKind::InvalidRequest);
    let quota = codec.classify(&response(
        429,
        &[
            ("Anthropic-Ratelimit-Unified-Representative-Claim", "five_hour"),
            ("anthropic-ratelimit-unified-reset", "1800000000"),
            ("retry-after", "30"),
            ("x-should-retry", "false"),
        ],
        "",
    ));
    assert_eq!(quota.kind, ErrorKind::QuotaExhausted);
    assert_eq!(quota.retry_after, Some(Duration::from_secs(30)));
    assert_eq!(quota.should_retry, Some(false));
    assert_eq!(
        quota.reset_at,
        Some(std::time::UNIX_EPOCH + Duration::from_secs(1_800_000_000))
    );
    let by_ms = codec.classify(&response(429, &[("retry-after-ms", "1500"), ("retry-after", "30")], ""));
    assert_eq!(by_ms.retry_after, Some(Duration::from_millis(1500)));
    assert_eq!(codec.classify(&response(413, &[], "{}")).code.as_deref(), Some("request_too_large"));
}

// ---------------------------------------------------------------------------
// Retry rows
// ---------------------------------------------------------------------------

#[test]
fn retry_rows_hold_the_recorded_numbers() {
    let policy = super::policy::retry_policy(true);
    check_retry_policy(&policy);
    let request = policy.row(RetryClass::Request).expect("request row");
    assert_eq!(request.schedule.max_retries, 10);
    assert_eq!(request.schedule.jitter.ratio, 0.25);
    assert_eq!(policy.overload.fallback_after, Some(3));
    assert!(policy.honor_should_retry_true);
    assert!(policy.status.retry_529);
    assert!(!super::policy::retry_policy(false).status.retry_429);
}

#[test]
fn midstream_row_reproduces_the_recorded_sleeps() {
    let policy = super::policy::retry_policy(false);
    let row = policy.row(RetryClass::Midstream).expect("midstream row");
    let Backoff::Ladder(steps) = &row.schedule.backoff else {
        panic!("a ladder");
    };
    for scenario in ["truncated-eof", "truncated-reset"] {
        let exchange = oauth_exchange(scenario);
        let sleeps = exchange["determinism"]["retrySleeps"].as_array().expect("sleeps");
        let samples = exchange["determinism"]["rng"]["samples"].as_array().expect("samples");
        assert_eq!(sleeps.len() as u32, row.schedule.max_retries, "{scenario}");
        for (n, sleep) in sleeps.iter().enumerate() {
            let step = steps[n.min(steps.len() - 1)];
            let delay = row.schedule.jitter.apply(step, samples[n]["value"].as_f64().expect("sample"));
            assert_eq!(delay.as_millis() as u64, sleep["delayMs"].as_u64().expect("delay"), "{scenario} #{n}");
        }
        let posts = exchange["records"].as_array().expect("records").len();
        assert_eq!(posts as u32, row.schedule.max_retries + 1, "{scenario}");
    }
}

// ---------------------------------------------------------------------------
// Adapter attempts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn api_key_attempts_replay_the_recordings() {
    for (scenario, reached) in [
        ("text", DeliveryState::Accepted),
        ("tool-call", DeliveryState::Accepted),
        ("error-400", DeliveryState::Accepted),
        ("truncated-no-terminal", DeliveryState::Accepted),
    ] {
        let status = if scenario == "error-400" { 400 } else { 200 };
        let http = ScriptedHttp::new([Scripted::body(status, &read_text(&api(scenario, "response.sse")))]);
        let adapter = api_adapter(http.clone());
        check_provider_attempt(&adapter, Arc::new(request(base_messages(), RequestOptions::default())), reached).await;
        let sent = http.sent();
        assert_eq!(sent.len(), 1, "{scenario}: one attempt is one request");
        assert_eq!(header(&sent[0].headers, "x-api-key"), "fixture-key-not-a-credential");
    }
}

#[tokio::test]
async fn attempt_stream_folds_and_ends_at_the_terminal_event() {
    let mut body = read_text(&api("text", "response.sse"));
    // Pings after message_stop are dropped with the stream.
    body.push_str("event: ping\ndata: {\"type\":\"ping\"}\n\n");
    let http = ScriptedHttp::new([Scripted::body(200, &body)]);
    let adapter = api_adapter(http);
    let mut stream = adapter
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
        .expect("stream");
    let events: Vec<StreamEvent> = drain(stream.as_mut()).await.into_iter().map(|e| e.expect("ok")).collect();
    assert_eq!(fold(&events).content, "The result is 42.");
    assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })));
}

#[tokio::test]
async fn a_reset_mid_body_is_a_transport_fault_with_exposure() {
    let record = messages_post(&oauth_exchange("truncated-reset"));
    let served = record["served"].as_str().expect("served");
    let http = ScriptedHttp::new([Scripted {
        status: 200,
        headers: Vec::new(),
        chunks: vec![served.as_bytes().to_vec()],
        fault: Some(TransportFault::Reset),
    }]);
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http, store.clone());
    let mut stream = adapter
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
        .expect("stream");
    let items = drain(stream.as_mut()).await;
    let err = items.into_iter().find_map(Result::err).expect("an error");
    assert_eq!(err.transport, Some(TransportFault::Reset));
    assert_eq!(err.kind, ErrorKind::Transient);
    assert_eq!(err.delivery, DeliveryState::Accepted);
}

fn sse(name: &str, data: Value) -> String {
    format!("event: {name}\ndata: {data}\n\n")
}

/// Usage, a dispatched tool call, then a stream error: all of it can land in
/// one chunk.
fn dispatch_then_error_stream() -> String {
    [
        sse(
            "message_start",
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 11, "output_tokens": 1 } } }),
        ),
        sse(
            "content_block_start",
            json!({ "type": "content_block_start", "index": 0,
                    "content_block": { "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} } }),
        ),
        sse(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": 0,
                    "delta": { "type": "input_json_delta", "partial_json": "{\"key\":\"a\"}" } }),
        ),
        sse("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
        sse(
            "error",
            json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } }),
        ),
    ]
    .concat()
}

async fn run_chunked(chunks: Vec<Vec<u8>>, fault: Option<TransportFault>) -> Vec<Result<StreamEvent, ProviderError>> {
    let http = ScriptedHttp::new([Scripted {
        status: 200,
        headers: Vec::new(),
        chunks,
        fault,
    }]);
    let mut stream = api_adapter(http)
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
        .expect("stream");
    drain(stream.as_mut()).await
}

#[tokio::test]
async fn an_error_keeps_the_events_decoded_before_it_whatever_the_chunking() {
    let body = dispatch_then_error_stream().into_bytes();
    let whole = run_chunked(vec![body.clone()], None).await;
    let (last, events) = whole.split_last().expect("items");
    let err = last.as_ref().expect_err("the stream ends in the error");
    let events: Vec<&StreamEvent> = events.iter().map(|e| e.as_ref().expect("event")).collect();
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Usage(_))), "usage delivered");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallDone(_))), "tool call delivered");
    assert!(err.exposure.tool_dispatched, "the error reports the dispatch");
    assert_eq!(err.partial_usage.as_ref().expect("partial usage").input_tokens, 11);

    // The same stream cut at every byte boundary, and one byte at a time.
    for cut in 1..body.len() {
        let split = run_chunked(vec![body[..cut].to_vec(), body[cut..].to_vec()], None).await;
        assert_eq!(split, whole, "cut at {cut}");
    }
    let bytes = body.iter().map(|b| vec![*b]).collect();
    assert_eq!(run_chunked(bytes, None).await, whole, "byte by byte");
}

#[tokio::test]
async fn a_failure_after_thinking_alone_is_an_exposure_and_is_not_retried() {
    use mixdog_core_api::domain::retry::JitterSamples;
    use mixdog_core_api::domain::retry::RetryDecider;
    use mixdog_core_api::domain::retry::RetryState;
    use mixdog_core_api::domain::retry::Verdict;

    let body = [
        sse(
            "message_start",
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": 3 } } }),
        ),
        sse(
            "content_block_start",
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
        ),
        sse(
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": 0,
                    "delta": { "type": "thinking_delta", "thinking": "let me think" } }),
        ),
    ]
    .concat();
    let items = run_chunked(vec![body.into_bytes()], Some(TransportFault::Reset)).await;
    assert!(items.iter().any(|i| matches!(i, Ok(StreamEvent::ReasoningDelta(_)))));
    let err = items.into_iter().find_map(Result::err).expect("an error");
    assert!(err.exposure.text_emitted, "emitted thinking is an exposure boundary");
    let policy = super::policy::retry_policy(true);
    let state = RetryState::new(mixdog_core_api::domain::retry::RetryClass::Midstream, "claude-sonnet-4-6");
    let samples = JitterSamples { step: 0.5, advice: 0.5 };
    let decision = crate::retry::StandardRetryDecider.verdict(&err, &state, &policy, samples);
    assert!(matches!(decision.verdict, Verdict::Surface), "{:?}", decision.verdict);
}

#[tokio::test]
async fn oauth_401_refreshes_once_and_replays_once() {
    let exchange = oauth_exchange("error-401");
    let records = exchange["records"].as_array().expect("records");
    let refresh = records.iter().find(|r| r["path"] == "/v1/oauth/token").expect("token record");
    let unauthorised = records[0]["served"].as_str().expect("served");
    let http = ScriptedHttp::new([
        Scripted::body(401, unauthorised),
        Scripted::body(200, refresh["served"].as_str().expect("token response")),
        Scripted::body(401, unauthorised),
    ]);
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http.clone(), store.clone());
    let req = Arc::new(request(base_messages(), RequestOptions::default()));
    check_provider_attempt(&adapter, req.clone(), DeliveryState::Accepted).await;
    let sent = http.sent();
    assert_eq!(sent.len(), 3, "POST, refresh, replay");
    assert_eq!(sent[1].url, "https://platform.claude.com/v1/oauth/token");
    assert_eq!(
        String::from_utf8(sent[1].body.clone()).expect("utf8"),
        refresh["bodyText"].as_str().expect("bodyText")
    );
    assert_eq!(header(&sent[0].headers, "authorization"), "Bearer fixture-access-token");
    assert_eq!(sent[0].body, sent[2].body, "the replay carries the same request");
    assert_eq!(store.load().await.expect("stored").access_token, "fixture-access-token");
}

#[tokio::test]
async fn oauth_401_survivor_requires_sign_in() {
    let unauthorised = r#"{"error":{"message":"fixture upstream error","type":"fixture_error","code":"401"}}"#;
    let token = r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}"#;
    let http = ScriptedHttp::new([
        Scripted::body(401, unauthorised),
        Scripted::body(200, token),
        Scripted::body(401, unauthorised),
    ]);
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http.clone(), store.clone());
    let Err(err) = adapter
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
    else {
        panic!("a refused request");
    };
    assert_eq!(err.kind, ErrorKind::Auth);
    assert_eq!(err.status, Some(401));
    assert!(err.reauth_required);
    assert_eq!(header(&http.sent()[2].headers, "authorization"), "Bearer new-access");
    let stored = store.load().await.expect("stored");
    assert_eq!(stored.refresh_token, "new-refresh");
    assert!(stored.expires_at > 0);
    assert_eq!(store.document().await["unrelated"], json!({ "kept": true }), "foreign fields survive");
}

#[tokio::test]
async fn a_dead_grant_marks_the_account_and_does_not_replay() {
    let http = ScriptedHttp::new([
        Scripted::body(401, r#"{"error":{"type":"authentication_error"}}"#),
        Scripted::body(400, r#"{"error":"invalid_grant"}"#),
    ]);
    let store = MemoryStore::signed_in();
    let adapter = oauth_adapter(http.clone(), store.clone());
    let Err(err) = adapter
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
    else {
        panic!("a refused request");
    };
    assert_eq!(err.kind, ErrorKind::Auth);
    assert!(err.reauth_required);
    assert_eq!(http.sent().len(), 2);
    assert_eq!(store.load().await.expect("stored").reauth_required, Some(true));
}

#[tokio::test]
async fn an_expiring_token_is_refreshed_before_the_request() {
    let store = MemoryStore::signed_in();
    store.write(&StoredOAuth {
        expires_at: 1,
        ..MemoryStore::credential()
    });
    let token = r#"{"access_token":"fresh","refresh_token":"fixture-refresh-token","expires_in":3600}"#;
    let http = ScriptedHttp::new([
        Scripted::body(200, token),
        Scripted::body(200, &read_text(&api("text", "response.sse"))),
    ]);
    let adapter = oauth_adapter(http.clone(), store.clone());
    adapter
        .attempt(Arc::new(request(base_messages(), RequestOptions::default())))
        .await
        .map(drop)
        .expect("stream");
    let sent = http.sent();
    assert_eq!(sent[0].url, "https://platform.claude.com/v1/oauth/token");
    assert_eq!(header(&sent[1].headers, "authorization"), "Bearer fresh");
}

#[tokio::test]
async fn a_rejected_gzip_body_is_the_provider_error_and_is_never_resent_plain() {
    let mut messages = base_messages();
    messages[1] = text_message(Role::User, &"x".repeat(20_000));
    let ok = read_text(&api("text", "response.sse"));
    let http = ScriptedHttp::new([
        Scripted::body(400, r#"{"error":{"type":"invalid_request_error"}}"#),
        Scripted::body(200, &ok),
    ]);
    let store = MemoryStore::signed_in();
    let adapter = AnthropicAdapter::oauth(
        config("https://api.anthropic.com"),
        http.clone(),
        Arc::new(OAuthSession::new(store.file.clone(), http.clone())),
        false,
        cpu_bulk(),
    );
    let req = Arc::new(request(messages, RequestOptions::default()));
    let Err(err) = adapter.attempt(req.clone()).await else {
        panic!("the 400 surfaces");
    };
    assert_eq!(err.kind, ErrorKind::InvalidRequest);
    assert_eq!(err.status, Some(400));
    adapter.attempt(req).await.map(drop).expect("stream");
    let sent = http.sent();
    assert_eq!(sent.len(), 2, "one request per attempt, no plain resend");
    assert_eq!(header(&sent[0].headers, "content-encoding"), "gzip");
    assert_eq!(header(&sent[1].headers, "content-encoding"), "gzip", "no latch: still compressed");
}

// ---------------------------------------------------------------------------
// OAuth plumbing
// ---------------------------------------------------------------------------

#[test]
fn token_responses_normalise_like_node() {
    use super::oauth::TokenFlow;
    use super::oauth::apply_token_response;

    let previous = StoredOAuth {
        identity: Some(json!({ "id": "old", "email": "old@example.com" })),
        ..MemoryStore::credential()
    };
    let now = 1_700_000_000_000;
    let account = json!({
        "account": { "uuid": " acct-1 ", "email_address": "name@example.com" },
        "organization": { "uuid": "org-1" },
    });
    let mut response = json!({ "access_token": "a2", "refresh_token": "r2", "expires_in": 3600 });
    response.as_object_mut().expect("object").extend(account.as_object().expect("object").clone());
    let login = apply_token_response(&previous, &response, now, TokenFlow::Login).expect("login");
    assert_eq!(login.expires_at, now + 3_600_000, "expires_in counts from now");
    assert_eq!(
        login.identity,
        Some(json!({ "id": "acct-1", "email": "name@example.com", "organizationId": "org-1" }))
    );

    // An absolute expiry wins over expires_in; seconds are scaled to ms.
    for (field, value, want) in [
        ("expires_at", json!(1_800_000_000), 1_800_000_000_000_u64),
        ("expiresAt", json!(1_800_000_000_123_u64), 1_800_000_000_123),
        ("expires_at", json!(0), now + 3_600_000),
    ] {
        let mut body = json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3600 });
        body[field] = value;
        let got = apply_token_response(&previous, &body, now, TokenFlow::Refresh).expect("refresh");
        assert_eq!(got.expires_at, want, "{field}");
    }

    // A refresh keeps the identity and scopes it is not told about; a login
    // keeps neither and a string scope only counts on a login.
    let bare = json!({ "access_token": "a3", "scope": "user:inference" });
    let refreshed = apply_token_response(&previous, &bare, now, TokenFlow::Refresh).expect("refresh");
    assert_eq!(refreshed.identity, previous.identity);
    assert_eq!(refreshed.scopes, previous.scopes);
    assert_eq!(refreshed.refresh_token, previous.refresh_token);
    assert!(apply_token_response(&previous, &bare, now, TokenFlow::Login).is_err(), "a login needs a refresh token");
    let signed_in = json!({ "access_token": "a3", "refresh_token": "r3", "scope": "user:inference user:profile" });
    let login = apply_token_response(&previous, &signed_in, now, TokenFlow::Login).expect("login");
    assert_eq!(login.scopes, ["user:inference", "user:profile"]);
    assert_eq!(login.identity, None, "a fresh sign-in never keeps the previous account");
}

#[tokio::test]
async fn a_login_exchange_stores_the_account_and_keeps_the_plan() {
    use mixdog_core_api::domain::login::LoginFailure;

    use crate::oauth::PkceProvider;

    let store = MemoryStore::signed_in();
    let token = json!({
        "access_token": "fresh", "refresh_token": "fresh-refresh", "expires_at": 4_100_000_000_000_u64,
        "scope": "user:inference", "account": { "uuid": "acct-9", "email_address": "new@example.com" },
    });
    let http = ScriptedHttp::new([Scripted::body(200, &token.to_string())]);
    let login = super::oauth::AnthropicLogin::new(store.file.clone(), http.clone());
    login.authorize_url(&crate::oauth::AuthorizeRequest {
        redirect_uri: "http://localhost:54545/callback",
        code_challenge: "challenge",
        state: "state-1",
    });
    login
        .exchange("code", "verifier", "http://localhost:54545/callback")
        .await
        .map_err(|e: LoginFailure| format!("{e:?}"))
        .expect("exchange");
    let stored = store.load().await.expect("stored");
    assert_eq!(stored.access_token, "fresh");
    assert_eq!(stored.expires_at, 4_100_000_000_000);
    assert_eq!(stored.scopes, ["user:inference"]);
    assert_eq!(stored.identity, Some(json!({ "id": "acct-9", "email": "new@example.com" })));
    assert_eq!(stored.subscription_type.as_deref(), Some("max"), "the plan survives a new sign-in");
}

#[test]
fn authorize_url_carries_the_login_parameters() {
    let url = url::Url::parse(&super::oauth::authorize_url(
        &crate::oauth::redirects::ANTHROPIC.uri(54545),
        "challenge",
        "state-1",
    ))
    .expect("url");
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(url.origin().ascii_serialization(), "https://claude.com");
    assert_eq!(query["client_id"], super::oauth::CLIENT_ID);
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["scope"], super::oauth::SCOPES.join(" "));
    assert_eq!(query["code"], "true");
    assert_eq!(query["redirect_uri"], "http://localhost:54545/callback");
}

#[test]
fn credential_document_round_trips_unknown_fields() {
    let doc = json!({
        "accessToken": "a", "refreshToken": "r", "expiresAt": 5,
        "scopes": ["user:inference"], "subscriptionType": "max", "future": {"k": 1},
    });
    let stored: StoredOAuth = serde_json::from_value(doc.clone()).expect("parse");
    assert_eq!(serde_json::to_value(&stored).expect("write"), doc);
    assert!(stored.needs_refresh(5 - 1));
    assert!(!stored.is_enterprise());
}

// ---------------------------------------------------------------------------
// No content timer
// ---------------------------------------------------------------------------

#[test]
fn no_timer_exists_in_the_provider_sources() {
    let sources = [
        ("adapter.rs", include_str!("adapter.rs")),
        ("betas.rs", include_str!("betas.rs")),
        ("body.rs", include_str!("body.rs")),
        ("caps.rs", include_str!("caps.rs")),
        ("codec.rs", include_str!("codec.rs")),
        ("decoder.rs", include_str!("decoder.rs")),
        ("errors.rs", include_str!("errors.rs")),
        ("lowering.rs", include_str!("lowering.rs")),
        ("oauth.rs", include_str!("oauth.rs")),
        ("policy.rs", include_str!("policy.rs")),
    ];
    let forbidden = [
        concat!("tokio::time::", "timeout"),
        concat!("tokio::time::", "sleep"),
        concat!("time::", "timeout("),
        concat!("Instant::", "now"),
    ];
    for (name, source) in sources {
        for needle in forbidden {
            assert!(!source.contains(needle), "{name} uses {needle}");
        }
    }
}
