//! Replays Node's end-to-end gateway and key-pool sends (`fixtures/provider-gateways`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-gateways.mjs` from `b6f10295a`) through the real registry, the
//! real builder and the real codecs: every request the provider makes is compared with the one Node sent (method,
//! URL, the headers the product sets, body bytes), in order and count, and the answer Node's endpoint gave is served
//! back, so the folded result is compared with Node's.
//!
//! Headers the HTTP client or the vendor SDK adds on its own (`TRANSPORT_HEADERS`: undici's `host`, `connection`,
//! `content-length`, `accept-encoding`, `accept-language`, `sec-fetch-mode`; the SDK's `user-agent` and
//! `x-stainless-*`, and `fetch`'s own `user-agent: node`) are not product behaviour and are left out on both sides; every other recorded header must be
//! sent with Node's value and no other header may be sent. Header order is not compared (HTTP gives it no meaning).

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use bytes::Bytes;
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

/// What the HTTP client or the vendor SDK writes on its own.
fn transport_header(name: &str, value: &str) -> bool {
    matches!(name, "host" | "connection" | "content-length" | "accept-encoding" | "accept-language" | "sec-fetch-mode")
        || name.starts_with("x-stainless-")
        || (name == "user-agent" && (value == "node" || value.starts_with("OpenAI/JS") || value.starts_with("Anthropic/JS")))
}

/// Answers each request with the next recorded answer and keeps what was sent.
struct Endpoint {
    answers: Mutex<VecDeque<(u16, String)>>,
    sent: Mutex<Vec<WireRequest>>,
}

struct Once(Option<Bytes>);

#[async_trait]
impl BodyStream for Once {
    async fn next(&mut self) -> Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.take().map(Ok)
    }
}

#[async_trait]
impl HttpSend for Endpoint {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let url = request.url.clone();
        self.sent.lock().unwrap().push(request);
        let (status, body) = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| panic!("no recorded answer for {url}"));
        Ok(HttpResponse { status, headers: vec![], body: Box::new(Once(Some(Bytes::from(body)))) })
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

fn world(scenario: &Value) -> World {
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
    let endpoint = Arc::new(Endpoint { answers: Mutex::new(answers), sent: Mutex::default() });
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
    World { endpoint, vault, accounts, registry: ProviderRegistry::new(Arc::new(builder)), _dir: dir }
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

fn message(value: &Value) -> Message {
    let role = match value["role"].as_str().unwrap() {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        other => panic!("role {other}"),
    };
    Message::new(role, Content::Text(value["content"].as_str().unwrap().to_owned()))
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

/// The request as Node's endpoint saw it, the transport's own headers left out.
fn recorded(request: &Value) -> Value {
    let headers: BTreeMap<String, String> = request["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .filter(|(k, v)| !transport_header(k, v))
        .collect();
    json!({"method": request["method"], "url": format!("{}{}", request["origin"].as_str().unwrap(), request["path"].as_str().unwrap()), "headers": headers, "body": request["body"]})
}

fn sent(request: &WireRequest) -> Value {
    let headers: BTreeMap<String, String> = request
        .headers
        .iter()
        .map(|(k, v)| (k.to_lowercase(), v.clone()))
        .filter(|(k, v)| !transport_header(k, v))
        .collect();
    json!({"method": request.method, "url": request.url, "headers": headers, "body": String::from_utf8(request.body.clone()).unwrap()})
}

/// Node's result fields from the stream the adapter returned.
fn folded(events: &[StreamEvent]) -> (Value, Vec<String>) {
    let (mut content, mut usage, mut stop, mut deltas, mut calls) = (String::new(), Value::Null, Value::Null, Vec::new(), Vec::new());
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => {
                content.push_str(text);
                deltas.push(text.clone());
            }
            StreamEvent::FinalContent(text) => content = text.clone(),
            StreamEvent::ToolCallDone(call) => calls.push(json!({"id": call.id, "name": call.name, "arguments": call.arguments})),
            StreamEvent::Usage(u) => usage = json!({"inputTokens": u.input_tokens, "outputTokens": u.output_tokens}),
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
    (json!({"content": content, "toolCalls": calls, "stopReason": stop, "usage": usage}), deltas)
}

async fn replay(id: &str) {
    let scenario = fixture(id);
    let w = world(&scenario);
    let provider = scenario["provider"].as_str().unwrap();
    if let Some(doc) = login(provider) {
        std::fs::write(w._dir.path().join(format!("{provider}.json")), doc.to_string()).unwrap();
    }
    if let Some(keys) = scenario["keys"].as_array() {
        let ids: Vec<String> = scenario["keyIds"].as_array().unwrap()[1..].iter().map(|k| k.as_str().unwrap().to_owned()).collect();
        for (id, key) in ids.iter().zip(&keys[1..]) {
            w.vault.set(&format!("agent.{provider}.apiKey.{id}"), key.as_str().unwrap()).await.unwrap();
        }
        w.accounts.set_custom_key_ids(provider, ids).await.unwrap();
    }
    let mut config = serde_json::Map::new();
    config.insert(provider.to_owned(), scenario["config"].clone());
    w.registry.init_providers(&config).await.unwrap_or_else(|e| panic!("{id}: {e}"));
    let adapter: Arc<dyn ProviderAdapter> = w.registry.get(provider).await.expect("registered");
    if scenario["listing"].is_array() {
        let before = w.endpoint.sent.lock().unwrap().len();
        adapter.models().expect("a listing").list_models().await.unwrap_or_else(|e| panic!("{id}: listing: {e:?}"));
        let sent_now: Vec<Value> = w.endpoint.sent.lock().unwrap()[before..].iter().map(sent).collect();
        let node_now: Vec<Value> = scenario["listing"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["origin"] != "https://raw.githubusercontent.com" && r["origin"] != "https://models.dev")
            .map(recorded)
            .collect();
        assert_eq!(sent_now, node_now, "{id}: the listing requests");
    }
    for (n, send) in scenario["sends"].as_array().unwrap().iter().enumerate() {
        let before = w.endpoint.sent.lock().unwrap().len();
        let mut messages = vec![message(&json!({"role": "system", "content": "You are a fixture assistant."}))];
        messages.extend(send["history"].as_array().unwrap().iter().map(message));
        messages.push(message(&json!({"role": "user", "content": "Look up the answer."})));
        let mut options = RequestOptions { session_id: send["sessionId"].as_str().map(str::to_owned), ..RequestOptions::default() };
        if let Some(pin) = send.get("pin") {
            options.wire_pin = pin["wire"].as_str().map(|wire| WirePin { provider: provider.to_owned(), model: send["model"].as_str().unwrap().to_owned(), wire: wire.to_owned() });
        }
        let request = ModelRequest {
            model: send["model"].as_str().unwrap().to_owned(),
            messages,
            tools: send["tools"].as_array().unwrap().iter().map(|t| tool(t.as_str().unwrap())).collect(),
            options,
        };
        let outcome = match adapter.attempt(Arc::new(request)).await {
            Ok(mut stream) => {
                let mut events = Vec::new();
                let mut failed = None;
                while let Some(item) = stream.next().await {
                    match item {
                        Ok(event) => events.push(event),
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
        let node_now: Vec<Value> = send["requests"].as_array().unwrap().iter().map(recorded).collect();
        assert_eq!(sent_now, node_now, "{id} send {n}: the requests");
        match (&outcome, send.get("result")) {
            (Ok((result, deltas)), Some(node)) => {
                let node_result = json!({"content": node["content"], "toolCalls": node["toolCalls"], "stopReason": node["stopReason"], "usage": node["usage"]});
                assert_eq!(result, &node_result, "{id} send {n}: the result");
                let node_deltas: Vec<String> = send["events"].as_array().unwrap().iter().filter(|e| e["on"] == "textDelta").map(|e| e["text"].as_str().unwrap().to_owned()).collect();
                assert_eq!(deltas, &node_deltas, "{id} send {n}: the text the session was shown");
            }
            (Err(error), Some(_)) => panic!("{id} send {n}: Node answered, Rust failed: {error:?}"),
            (Ok(_), None) => panic!("{id} send {n}: Node failed with {}, Rust answered", send["error"]),
            (Err(error), None) => {
                let node = &send["error"];
                assert_eq!(error.message, node["message"].as_str().unwrap(), "{id} send {n}: the error");
                assert_eq!(error.status.map(u64::from), node["status"].as_u64(), "{id} send {n}: the status");
            }
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
    a_quota_refusal_moves_to_the_next_key_which_the_next_send_keeps => "custom-keys-switch",
    every_key_refused_reports_the_exhausted_roster => "custom-keys-exhausted",
    a_refusal_that_is_not_quota_ends_the_send_on_its_key => "custom-keys-not-quota",
    a_refusal_after_output_started_is_never_resent => "custom-keys-after-output",
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
