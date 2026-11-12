//! Replays Node's end-to-end gateway and key-pool sends (`fixtures/provider-gateways`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-gateways.mjs` from `b6f10295a`) through the real registry, the
//! real builder and the real codecs: every request the provider makes is compared whole with the one Node sent
//! (method, origin, path, every header in the order the request head carries it, body bytes), in order and count,
//! and the answer Node's endpoint gave is served back, so the events and the result are compared with Node's.
//!
//! The Rust request is put in its head the way the product's HTTP client writes it (`node_http::head`, the
//! Node-equal client of every provider call). The manifest's `replayExclusions` name the two normalizations: the
//! `accept-encoding` undici writes for the recorder's plain-http loopback, and the Node runtime version the SDK
//! names.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::AccountStage;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WirePin;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::builder::BuilderEnv;
use super::builder::DefaultProviderBuilder;
use super::keys::ApiKeyStore;
use super::keys::MemoryVault;
use super::keys::SecretVault;
use super::providers::ProviderRegistry;
use crate::accounts::AccountStore;
use crate::oauth::CredentialIo;
use crate::providers::google::traits::ModelTraits;
use crate::providers::google::traits::ThinkingControl;
use crate::providers::openai::adapter::SessionContext;
use crate::providers::openai::config::CodexIdentity;
use crate::providers::openai::config::NoFacts;
use crate::transport::BodyStream;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;
use crate::transport::KeepaliveDialer;
use crate::transport::KeepaliveSchedule;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/provider-gateways");

fn fixture(id: &str) -> Value {
    let path = format!("{DIR}/{id}.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

/// The Node runtime the recorder ran under (the manifest's `nodeVersion`): the SDK's
/// `x-stainless-runtime-version` names it, where the product names its own (`grok::SDK_RUNTIME_VERSION`).
fn recorder_node() -> String {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(format!("{DIR}/MANIFEST.json")).unwrap()).unwrap();
    manifest["nodeVersion"].as_str().unwrap().to_owned()
}

/// How the answer's body reaches the decoder.
#[derive(Clone, Copy, PartialEq)]
enum Chunking {
    /// One SSE event per chunk, as a streaming server writes it.
    PerEvent,
    /// The whole body in one chunk, as a server that buffers writes it.
    Whole,
}

/// Answers each request with the next recorded answer and keeps what was sent.
struct Endpoint {
    answers: Mutex<VecDeque<(u16, String)>>,
    sent: Mutex<Vec<(WireRequest, crate::transport::node_http::Writer)>>,
    chunking: Chunking,
    /// The send's event log as Node's recorder keeps it: each request's arrival, then the stream's events as the
    /// session takes them.
    log: Mutex<Vec<Value>>,
}

impl Endpoint {
    fn note(&self, event: Value) {
        self.log.lock().unwrap().push(event);
    }
}

/// The answer's body as chunks.
struct Chunks(VecDeque<Bytes>);

impl Chunks {
    fn of(body: String, chunking: Chunking) -> Self {
        let mut chunks = VecDeque::new();
        let mut rest = body.as_str();
        while chunking == Chunking::PerEvent
            && let Some(at) = rest.find("\n\n")
        {
            chunks.push_back(Bytes::from(rest[..at + 2].to_owned()));
            rest = &rest[at + 2..];
        }
        if !rest.is_empty() {
            chunks.push_back(Bytes::from(rest.to_owned()));
        }
        Self(chunks)
    }
}

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        self.sent.lock().unwrap().push((request, exchange.writer));
        let n = self.log.lock().unwrap().iter().filter(|e| e["on"] == "request").count() + 1;
        self.note(json!({"on": "request", "n": n}));
        let (status, body) = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| panic!("no recorded answer for {url}"));
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Chunks::of(body, self.chunking)) })
    }
}

/// The recorder's empty model catalogs: no model is known to be Gemini-family or to take a thinking level.
struct NoTraits;

impl ModelTraits for NoTraits {
    fn is_gemini_family(&self, model: &str) -> bool {
        model.starts_with("gemini-")
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

/// The Messages capabilities the core's catalog gives with no catalog loaded (`mixdog-core`
/// `run_host::builder_env` caps): a Claude 4.6 generation takes adaptive thinking and the floor's effort ladder;
/// an id it cannot parse as a Claude release (a gateway slug, another vendor) has none.
fn caps(model: &str) -> Option<crate::providers::anthropic::ModelCaps> {
    (model == "claude-sonnet-4-6").then(|| crate::providers::anthropic::ModelCaps {
        adaptive_thinking: true,
        manual_thinking: true,
        effort_levels: vec!["low".into(), "medium".into(), "high".into()],
        ..Default::default()
    })
}

struct World {
    _dir: tempfile::TempDir,
    endpoint: Arc<Endpoint>,
    vault: Arc<MemoryVault>,
    accounts: AccountStore,
    registry: ProviderRegistry,
}

fn world(scenario: &Value, chunking: Chunking) -> World {
    world_with(scenario, chunking, None)
}

fn world_with(scenario: &Value, chunking: Chunking, accounting: Option<super::accounted::AccountingDeps>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let mut answers = VecDeque::new();
    // The shared catalogs (LiteLLM, models.dev) come from the builder's `ListingLookup`, not the provider's
    // transport.
    let listing: Vec<Value> = scenario["listing"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r["origin"] != "https://raw.githubusercontent.com" && r["origin"] != "https://models.dev")
        .collect();
    let sends = scenario["sends"].as_array().unwrap();
    for request in listing.iter().chain(sends.iter().flat_map(|s| s["requests"].as_array().unwrap())) {
        answers.push_back((request["answer"]["status"].as_u64().unwrap() as u16, request["answer"]["body"].as_str().unwrap().to_owned()));
    }
    let endpoint = Arc::new(Endpoint { answers: Mutex::new(answers), sent: Mutex::default(), chunking, log: Mutex::default() });
    let vault = Arc::new(MemoryVault::default());
    let accounts = AccountStore::new(dir.path().to_path_buf(), io);
    let env: Arc<dyn super::keys::Environment> = Arc::new(NoEnv);
    let builder = DefaultProviderBuilder::new(BuilderEnv {
        http: endpoint.clone(),
        bidi: Arc::new(crate::transport::ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap()),
        dial: Arc::new(KeepaliveDialer::new(KeepaliveSchedule::SPEC)),
        keys: ApiKeyStore::new(vault.clone(), env.clone(), false),
        accounts: accounts.clone(),
        anthropic_caps: Arc::new(caps),
        google_traits: Arc::new(NoTraits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: String::new() },
        // The recorder's clock (`at` of the pool's stages, the blocks' `blockedUntil`).
        pace: Arc::new(crate::oauth::pace::FakePace { now: NODE_NOW.into(), ..Default::default() }),
        gzip_lane: tokens.cpu_bulk,
        client_version: "1.0.0".into(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "1.0.0".into(),
        listing: crate::catalog::ListingLookup::new(),
        env,
        home_dir: dir.path().to_path_buf(),
        io,
        gated_off: Arc::new(|_| false),
    });
    let registry = ProviderRegistry::new(Arc::new(builder));
    let registry = match accounting {
        Some(deps) => registry.with_accounting(deps),
        None => registry,
    };
    World { endpoint, vault, accounts, registry, _dir: dir }
}

struct NoEnv;

impl super::keys::Environment for NoEnv {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

/// The login each OAuth gateway reads (the recorder's credential files).
fn login(provider: &str) -> Option<Value> {
    match provider {
        "muse-code-oauth" => Some(json!({"accessToken": "muse-access", "apiKey": "muse-fixture", "accountId": "acct-fixture", "email": "fixture@example.invalid"})),
        "command-code-oauth" => Some(json!({"apiKey": "cc-fixture", "userId": "u1", "userName": "fixture"})),
        "opencode-go-oauth" => Some(json!({"access_token": "go-access", "refresh_token": "go-refresh", "expires_at": 2_109_585_600_000_u64, "account_id": "acct-fixture", "email": "fixture@example.invalid"})),
        _ => None,
    }
}

/// A history message of the recording as the session hands it to the provider: Node's `reasoningContent` rides
/// the Chat replay envelope, `thinkingBlocks` the message's own field, `providerMetadata.accountRouting` the
/// routing the turn loop reads off the stored message (`AgentMessage::wire`).
fn message(provider: &str, value: &Value) -> Message {
    let role = match value["role"].as_str().unwrap() {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("role {other}"),
    };
    let mut message = Message::new(role, Content::Text(value["content"].as_str().unwrap().to_owned()));
    message.tool_call_id = value["toolCallId"].as_str().map(str::to_owned);
    for call in value["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(mixdog_core_api::domain::provider::ToolCall {
            id: call["id"].as_str().unwrap().to_owned(),
            name: call["name"].as_str().unwrap().to_owned(),
            arguments: call["arguments"].clone(),
            native_type: None,
        });
    }
    if let Some(reasoning) = value["reasoningContent"].as_str() {
        message.push_replay(mixdog_core_api::domain::provider::ProviderReplay {
            owner: mixdog_protocol::ProviderId::from(provider),
            items: json!({"reasoningContent": reasoning}),
        });
    }
    message.thinking_blocks = value.get("thinkingBlocks").cloned();
    if let Some(routing) = value.pointer("/providerMetadata/accountRouting") {
        message.account_routing = Some(mixdog_core_api::domain::provider::AccountRouting {
            provider: routing["provider"].as_str().unwrap().to_owned(),
            account_id: routing["accountId"].as_str().unwrap().to_owned(),
            session_account_id: routing["sessionAccountId"].as_str().map(str::to_owned),
        });
    }
    message
}

/// The session's view of one stream event in Node's callback vocabulary, for the events the replay compares.
/// `chunked`: the stream announced its chunks' kinds, so its deltas report none of their own
/// (`StreamEvent::progress_kinds`).
fn shown(event: &StreamEvent, chunked: &mut bool) -> Option<Value> {
    *chunked |= matches!(event, StreamEvent::ChunkProgress(_));
    let reports = !(*chunked && matches!(event, StreamEvent::TextDelta(_) | StreamEvent::ReasoningDelta(_)));
    if reports && event.progress_kind() == Some("reasoning") {
        return Some(json!({"on": "streamDelta", "kind": "reasoning"}));
    }
    match event {
        StreamEvent::TextDelta(text) => Some(json!({"on": "textDelta", "text": text})),
        StreamEvent::AccountStage(AccountStage::Switching { message }) => {
            Some(json!({"on": "stageChange", "stage": "reconnecting", "payload": {"message": message}}))
        }
        StreamEvent::AccountStage(AccountStage::Changed { provider, account_id, at }) => Some(json!({
            "on": "stageChange", "stage": "account-changed", "payload": {"provider": provider, "accountId": account_id, "at": at},
        })),
        _ => None,
    }
}

/// Node's events the replay compares (the manifest's `replayExclusions` name what it leaves out and why).
fn compared(event: &Value) -> bool {
    match event["on"].as_str() {
        Some("request" | "textDelta" | "streamDelta") => true,
        Some("stageChange") => !matches!(event["stage"].as_str(), Some("requesting" | "streaming")),
        _ => false,
    }
}

fn tool(name: &str) -> ToolDefinition {
    assert_eq!(name, "lookup");
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}),
        defer_loading: false,
        freeform: None,
    }
}

/// The request as Node's endpoint saw it: every header in arrival order, the SDK's runtime version as the product
/// names it.
fn recorded(request: &Value, node: &str) -> Value {
    let headers: Vec<(String, String)> = request["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let v = v.as_str().unwrap();
            if k == "x-stainless-runtime-version" {
                assert_eq!(v, node, "the SDK names the recorder's Node runtime");
                return (k.clone(), crate::providers::grok::SDK_RUNTIME_VERSION.to_owned());
            }
            (k.clone(), v.to_owned())
        })
        .collect();
    json!({"method": request["method"], "origin": request["origin"], "path": request["path"], "headers": headers, "body": request["body"]})
}

/// The request as the product's HTTP client writes its head, for the recorder's plain-http loopback (undici's
/// `accept-encoding` follows the scheme it dials).
fn sent((request, writer): &(WireRequest, crate::transport::node_http::Writer)) -> Value {
    let product = url::Url::parse(&request.url).unwrap();
    let mut dialed = product.clone();
    dialed.set_scheme("http").unwrap();
    let (head, _) = crate::transport::node_http::head(request, &dialed, *writer);
    let head = String::from_utf8(head).unwrap();
    let mut lines = head.split("\r\n").filter(|l| !l.is_empty());
    let line = lines.next().unwrap();
    let mut parts = line.split(' ');
    let (method, path) = (parts.next().unwrap(), parts.next().unwrap());
    let headers: Vec<(String, String)> = lines
        .map(|l| {
            let (name, value) = l.split_once(": ").unwrap();
            (name.to_lowercase(), value.to_owned())
        })
        .collect();
    json!({"method": method, "origin": product.origin().ascii_serialization(), "path": path, "headers": headers, "body": String::from_utf8(request.body.clone()).unwrap()})
}

/// Node's result fields from the stream the adapter returned.
fn folded(events: &[StreamEvent]) -> Value {
    let (mut content, mut usage, mut stop, mut calls) = (String::new(), Value::Null, Value::Null, Vec::new());
    let (mut reasoning_content, mut metadata, mut reroute) = (Value::Null, Value::Null, Value::Null);
    for event in events {
        match event {
            StreamEvent::WireRerouted(route) => reroute = route.clone(),
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::ReasoningReplay(replay) => {
                if let Some(text) = replay.items.get("reasoningContent") {
                    reasoning_content = text.clone();
                }
            }
            StreamEvent::AccountRouting(routing) => {
                metadata = json!({"accountRouting": {"provider": routing.provider, "accountId": routing.account_id, "sessionAccountId": routing.session_account_id}});
            }
            StreamEvent::FinalContent(text) => content = text.clone(),
            StreamEvent::ToolCallDone(call) => calls.push(json!({"id": call.id, "name": call.name, "arguments": call.arguments})),
            StreamEvent::Usage(u) => {
                // The cache read and the gateway's cost are compared only when the answer reported them.
                let mut shown = json!({"inputTokens": u.input_tokens, "outputTokens": u.output_tokens});
                if u.cache_read_tokens > 0 {
                    shown["cachedTokens"] = json!(u.cache_read_tokens);
                }
                if let Some(cost) = u.cost {
                    shown["costUsd"] = json!(cost.0 as f64 / 1e10);
                }
                usage = shown;
            }
            StreamEvent::Completed { stop: s, .. } => {
                stop = match s {
                    None => Value::Null,
                    Some(StopReason::EndTurn) => json!("end_turn"),
                    Some(StopReason::ToolUse) => json!("tool_use"),
                    Some(StopReason::Other(v)) => json!(v),
                    Some(other) => json!(format!("{other:?}")),
                }
            }
            _ => {}
        }
    }
    // Node's `reasoning` result field: no engine of these wires returns one, and the core has no such field (the
    // reasoning shown is the `streamDelta` events, the reasoning kept is `reasoningContent`).
    json!({"content": content, "reasoning": null, "toolCalls": calls, "reasoningContent": reasoning_content, "stopReason": stop, "usage": usage, "providerMetadata": metadata, "wireReroute": reroute})
}

/// Node's error fields from the error the send ended with.
fn error_of(error: &ProviderError, provider: &str, model: &str) -> Value {
    let quota = (error.kind == mixdog_core_api::domain::provider::ErrorKind::QuotaExhausted).then(|| {
        let reset = error.reset_at.map(|at| at.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
        json!({"provider": provider, "model": model, "resetAt": reset})
    });
    json!({"message": error.message, "status": error.status, "code": error.code, "quotaExhausted": quota})
}

async fn replay(id: &str) {
    replay_as(id, Chunking::PerEvent).await;
}

/// The scenario's provider as the registry registers it, its logins and key roster stored first.
async fn register(w: &World, scenario: &Value, id: &str) -> Arc<dyn ProviderAdapter> {
    let provider = scenario["provider"].as_str().unwrap();
    if let Some(doc) = login(provider) {
        std::fs::write(w._dir.path().join(format!("{provider}.json")), doc.to_string()).unwrap();
    }
    if let Some(keys) = scenario["keys"].as_array() {
        // A provider with no additional key has no roster (`keyIds` is empty).
        let ids: Vec<String> = scenario["keyIds"].as_array().unwrap().iter().skip(1).map(|k| k.as_str().unwrap().to_owned()).collect();
        for (id, key) in ids.iter().zip(&keys[1..]) {
            w.vault.set(&format!("agent.{provider}.apiKey.{id}"), key.as_str().unwrap()).await.unwrap();
        }
        w.accounts.set_custom_key_ids(provider, ids).await.unwrap();
    }
    let mut config = serde_json::Map::new();
    config.insert(provider.to_owned(), scenario["config"].clone());
    w.registry.init_providers(&config).await.unwrap_or_else(|e| panic!("{id}: {e}"));
    w.registry.get(provider).await.expect("registered")
}

/// The request of one recorded send.
fn send_request(provider: &str, send: &Value) -> ModelRequest {
    let mut messages = vec![message(provider, &json!({"role": "system", "content": "You are a fixture assistant."}))];
    messages.extend(send["history"].as_array().unwrap().iter().map(|m| message(provider, m)));
    messages.push(message(provider, &json!({"role": "user", "content": "Look up the answer."})));
    let mut options = RequestOptions {
        session_id: send["sessionId"].as_str().map(str::to_owned),
        effort: send["opts"]["effort"].as_str().map(str::to_owned),
        ..RequestOptions::default()
    };
    // OpenRouter's own reasoning control rides the model parameters (`openRouterReasoningEffort`).
    if let Some(effort) = send["opts"]["openRouterReasoningEffort"].as_str() {
        options.model_parameters = Some(json!({"openRouterReasoningEffort": effort}));
    }
    if let Some(pin) = send.get("pin") {
        options.wire_pin = WirePin::from_route(pin);
    }
    ModelRequest {
        model: send["model"].as_str().unwrap().to_owned(),
        messages,
        tools: send["tools"].as_array().unwrap().iter().map(|t| tool(t.as_str().unwrap())).collect(),
        options,
    }
}

async fn replay_as(id: &str, chunking: Chunking) {
    let scenario = fixture(id);
    let node_version = recorder_node();
    let w = world(&scenario, chunking);
    let provider = scenario["provider"].as_str().unwrap();
    let adapter = register(&w, &scenario, id).await;
    if scenario["listing"].is_array() {
        let before = w.endpoint.sent.lock().unwrap().len();
        adapter.models().expect("a listing").list_models().await.unwrap_or_else(|e| panic!("{id}: listing: {e:?}"));
        let sent_now: Vec<Value> = w.endpoint.sent.lock().unwrap()[before..].iter().map(sent).collect();
        let node_now: Vec<Value> = scenario["listing"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["origin"] != "https://raw.githubusercontent.com" && r["origin"] != "https://models.dev")
            .map(|r| recorded(r, &node_version))
            .collect();
        assert!(sent_now == node_now, "{id}: the listing requests\nrust: {}\nnode: {}", json!(sent_now), json!(node_now));
    }
    for (n, send) in scenario["sends"].as_array().unwrap().iter().enumerate() {
        let before = w.endpoint.sent.lock().unwrap().len();
        w.endpoint.log.lock().unwrap().clear();
        let request = send_request(provider, send);
        let pinned = request.options.wire_pin.clone();
        let outcome = match adapter.attempt(Arc::new(request)).await {
            Ok(mut stream) => {
                let mut events = Vec::new();
                let mut failed = None;
                let mut chunked = false;
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(event) => {
                            if let Some(view) = shown(&event, &mut chunked) {
                                w.endpoint.note(view);
                            }
                            events.push(event);
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                match failed {
                    None => Ok(folded(&events)),
                    Some(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        };
        let sent_now: Vec<Value> = w.endpoint.sent.lock().unwrap()[before..].iter().map(sent).collect();
        let node_now: Vec<Value> = send["requests"].as_array().unwrap().iter().map(|r| recorded(r, &node_version)).collect();
        assert!(sent_now == node_now, "{id} send {n}: the requests\nrust: {}\nnode: {}", json!(sent_now), json!(node_now));
        let node_events: Vec<Value> = send["events"].as_array().unwrap().iter().filter(|e| compared(e)).cloned().collect();
        assert_eq!(*w.endpoint.log.lock().unwrap(), node_events, "{id} send {n}: the requests and what the session was shown, in order");
        let model = send["model"].as_str().unwrap();
        match (&outcome, send.get("result")) {
            (Ok(result), Some(node)) => assert_eq!(result, node, "{id} send {n}: the result"),
            (Err(error), Some(_)) => panic!("{id} send {n}: Node answered, Rust failed: {error:?}"),
            (Ok(_), None) => panic!("{id} send {n}: Node failed with {}, Rust answered", send["error"]),
            (Err(error), None) => {
                let mut node = send["error"].clone();
                if let Some(code) = node["code"].as_u64() {
                    node["code"] = json!(code.to_string());
                }
                assert_eq!(error_of(error, provider, model), node, "{id} send {n}: the error");
            }
        }
        // The session's pin after the send: the reroute when the session's pin named this provider and model (the
        // agent's rule for `StreamEvent::WireRerouted`), else the pin it had.
        if let Some(node_after) = send.get("pinAfter") {
            let reroute = outcome.as_ref().ok().map(|r| r["wireReroute"].clone()).filter(|r| !r.is_null());
            let after = match (reroute, &pinned) {
                (Some(route), Some(pin)) if WirePin::from_route(&route).is_some_and(|new| new.provider == pin.provider && new.model == pin.model) => route,
                _ => send["pin"].clone(),
            };
            assert_eq!(&after, node_after, "{id} send {n}: the session's pin after the send");
        }
    }
    assert!(w.endpoint.answers.lock().unwrap().is_empty(), "{id}: Node made requests Rust did not");
    if let Some(pool) = scenario.get("pool") {
        let roster = serde_json::to_value(w.accounts.pool(provider).await.unwrap()).unwrap();
        assert_eq!(&roster, pool, "{id}: the key roster after the sends");
    }
}

const NODE_NOW: u64 = 1_794_225_600_000;

macro_rules! scenarios {
    ($($name:ident => $id:literal),* $(,)?) => {
        /// Every recorded scenario has its test here.
        const REPLAYED: &[&str] = &[$($id),*];
        $(
            #[tokio::test]
            async fn $name() {
                replay($id).await;
            }
        )*
    };
}

scenarios! {
    xai_sends_on_responses => "xai-responses",
    xai_in_chat_api_mode_sends_on_chat => "xai-chat-api-mode",
    muse_code_sends_on_responses => "muse-responses",
    openrouter_claude_sends_on_messages => "openrouter-messages",
    openrouter_gpt_sends_on_responses => "openrouter-responses",
    openrouter_other_models_send_on_chat => "openrouter-chat",
    openrouter_a_model_switch_takes_the_new_models_wire => "openrouter-model-switch",
    deepseek_with_tools_sends_on_messages => "deepseek-messages-tools",
    deepseek_without_tools_sends_on_chat => "deepseek-chat-toolless",
    deepseek_a_pinned_session_keeps_messages_without_tools => "deepseek-pinned-toolless",
    opencode_go_gpt_sends_on_responses => "opencode-go-responses",
    opencode_go_minimax_sends_on_messages => "opencode-go-messages",
    opencode_go_gemini_sends_on_generate_content => "opencode-go-gemini",
    opencode_go_other_models_send_on_chat => "opencode-go-chat",
    command_code_claude_sends_on_messages => "command-code-messages",
    command_code_gpt_sends_on_responses => "command-code-responses",
    command_code_other_models_send_on_chat => "command-code-chat",
    a_custom_model_replays_its_reasoning => "custom-reasoning-replay",
    the_chat_reasoning_goes_to_whichever_key_serves => "custom-keys-reasoning",
    a_turn_another_key_served_goes_without_its_thinking => "custom-keys-anthropic-thinking",
    a_quota_refusal_moves_to_the_next_key_which_the_next_send_keeps => "custom-keys-switch",
    every_key_refused_reports_the_exhausted_roster => "custom-keys-exhausted",
    a_refusal_that_is_not_quota_ends_the_send_on_its_key => "custom-keys-not-quota",
    a_refusal_after_output_started_is_never_resent => "custom-keys-after-output",
    reasoning_before_a_quota_refusal_is_shown_and_the_key_is_kept => "custom-keys-reasoning-then-quota",
    an_unsupported_wire_refusal_moves_the_send_and_the_pin_to_the_next_wire => "openrouter-reroute-unsupported",
    a_refusal_that_names_no_unsupported_wire_ends_the_send => "openrouter-refusal-stays",
    the_wire_switches_once => "openrouter-reroute-once",
    openrouter_capabilities_come_from_the_alias_target_and_the_slug_stays_on_the_wire => "openrouter-alias-slug",
    openrouter_reasoning_control_replaces_the_turn_effort_on_messages => "openrouter-messages-reasoning",
    openrouter_reasoning_control_applies_on_responses_as_on_chat => "openrouter-responses-reasoning",
    openrouter_messages_usage_keeps_the_cache_read_and_the_gateways_cost => "openrouter-messages-usage",
    the_messages_engine_never_follows_a_redirect => "openrouter-messages-redirect",
}

/// The same answers with the whole body in one chunk: the events decoded before an in-band refusal still reach
/// the caller first, so the pool sees the output and keeps the key.
#[tokio::test]
async fn reasoning_then_a_quota_refusal_in_one_chunk() {
    replay_as("custom-keys-reasoning-then-quota", Chunking::Whole).await;
}

#[tokio::test]
async fn text_then_a_quota_refusal_in_one_chunk() {
    replay_as("custom-keys-after-output", Chunking::Whole).await;
}

/// Prices nothing; the composition tests read only when rows are written.
struct Unpriced;

impl super::accounting::UsagePricing for Unpriced {
    fn price_usage(&self, args: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
        crate::catalog::PricedUsage { input: args.input_tokens, cost_usd: None, rates: Default::default() }
    }
}

/// The ledger: notes, as each row is written, whether the consumer was already told the wire is done.
struct Ledger(Arc<std::sync::atomic::AtomicBool>, Mutex<Vec<bool>>);

#[async_trait]
impl super::accounting::UsageSink for Ledger {
    async fn record_queued(&self, _: super::accounting::UsageRow) -> Result<(), String> {
        self.1.lock().unwrap().push(self.0.load(std::sync::atomic::Ordering::SeqCst));
        Ok(())
    }
}

/// What the consumer of the first recorded send sees (`ModelStream::on_wire_left`), through the stream the
/// production registry stacks for the scenario's provider (accounting outermost): the events in order with the
/// callback's place among them (`None`), and, per ledger row, whether the callback had come.
async fn wire_left_through(id: &str) -> (Vec<Option<StreamEvent>>, Vec<bool>) {
    let scenario = fixture(id);
    let left = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ledger = Arc::new(Ledger(Arc::clone(&left), Mutex::default()));
    let sink: Arc<dyn super::accounting::UsageSink> = ledger.clone();
    let deps = super::accounted::AccountingDeps::new(Arc::new(Unpriced), Arc::new(move || Some(Arc::clone(&sink))));
    let w = world_with(&scenario, Chunking::PerEvent, Some(deps));
    let adapter = register(&w, &scenario, id).await;
    let send = &scenario["sends"][0];
    let mut stream = adapter.attempt(Arc::new(send_request(scenario["provider"].as_str().unwrap(), send))).await.expect("the send streams");
    let seen: Arc<Mutex<Vec<Option<StreamEvent>>>> = Arc::default();
    {
        let (seen, left) = (Arc::clone(&seen), Arc::clone(&left));
        stream.on_wire_left(Arc::new(move || {
            if !left.swap(true, std::sync::atomic::Ordering::SeqCst) {
                seen.lock().unwrap().push(None);
            }
        }));
    }
    // Every answer is served from the recording: a stream still pending after this hangs.
    mixdog_rt::time::timeout(std::time::Duration::from_secs(30), async {
        while let Some(item) = stream.next().await {
            seen.lock().unwrap().push(Some(item.unwrap_or_else(|e| panic!("{id}: {e:?}"))));
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{id}: the stream did not end within 30 s"));
    let events = std::mem::take(&mut *seen.lock().unwrap());
    let rows = ledger.1.lock().unwrap().clone();
    (events, rows)
}

fn place(events: &[Option<StreamEvent>], what: impl Fn(&StreamEvent) -> bool) -> usize {
    events.iter().position(|e| e.as_ref().is_some_and(&what)).expect("the event is in the stream")
}

/// Every production stack hands the consumer's callback to the stream that awaits after the wire: the ledger's
/// row is written only after it came, on a plain route, a gateway's rerouted send and a key pool's send.
#[tokio::test]
async fn the_ledger_row_of_every_stack_is_written_after_the_consumer_is_told_the_wire_is_done() {
    for id in ["custom-reasoning-replay", "openrouter-reroute-unsupported", "custom-keys-reasoning", "custom-keys-anthropic-thinking"] {
        let (events, rows) = wire_left_through(id).await;
        assert!(events.iter().any(Option::is_none), "{id}: the callback came");
        assert!(!rows.is_empty() && rows.iter().all(|told| *told), "{id}: every ledger row after the callback: {rows:?}");
    }
}

/// The key pool binds the serving key (its store work, then the routing stamp) after the serving attempt's wire is
/// done and before it releases `Completed`: the consumer is told as that attempt's `Completed` comes in, before the
/// stamp, not once the accounting sees the pool's `Completed`.
#[tokio::test]
async fn a_key_pool_tells_the_consumer_before_it_binds_the_serving_key() {
    for id in ["custom-keys-reasoning", "custom-keys-anthropic-thinking"] {
        let (events, _) = wire_left_through(id).await;
        let told = events.iter().position(Option::is_none).expect("the callback came");
        assert!(told < place(&events, |e| matches!(e, StreamEvent::AccountRouting(_))), "{id}: told before the stamp: {events:?}");
    }
}

#[test]
fn every_recording_has_a_replay() {
    let mut recorded: Vec<String> = std::fs::read_dir(DIR)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json") && n != "MANIFEST.json")
        .map(|n| n.trim_end_matches(".json").to_owned())
        .collect();
    recorded.sort();
    let mut replayed: Vec<String> = REPLAYED.iter().map(|s| (*s).to_owned()).collect();
    replayed.sort();
    assert_eq!(replayed, recorded);
}
