//! The environment switches of the OpenAI wire: `MIXDOG_OAI_STATELESS_HTTP` and `MIXDOG_OAI_DISABLE_REASONING_REPLAY`
//! change the HTTP/SSE request the Codex route sends, and `MIXDOG_OAI_TRANSPORT` picks the WebSocket mode.

use std::sync::Arc;

use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::REPLAY_OWNER;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_ai::providers::openai::switch::TransportMode;
use mixdog_ai::registry::builder::openai_mode;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

/// A context whose environment is the one variable given.
struct Env(Option<(&'static str, String)>);

impl WireContext for Env {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
    fn var(&self, name: &str) -> Option<String> {
        self.0.as_ref().filter(|(set, _)| *set == name).map(|(_, value)| value.clone())
    }
}

struct Facts;

impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

fn http_request(setting: Option<(&'static str, &str)>) -> (Vec<(String, String)>, Value) {
    let identity = CodexIdentity { installation_id: "inst".into(), user_agent: "codex/1".into(), version: "0.1.0".into(), beta_features: "none".into() };
    let env = Env(setting.map(|(name, value)| (name, value.to_owned())));
    let codec = OpenAiCodec::new(OpenAiConfig::codex(false, identity, Arc::new(Facts), Arc::new(env)), TransportKind::Http1);
    let mut reasoning = Message::new(Role::Assistant, Content::Text("done".into()));
    reasoning.push_replay(ProviderReplay {
        owner: ProviderId::from(REPLAY_OWNER),
        items: json!([{ "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "enc" }]),
    });
    let request = ModelRequest {
        model: "gpt-5".into(),
        messages: vec![Message::new(Role::User, Content::Text("hello".into())), reasoning, Message::new(Role::User, Content::Text("again".into()))],
        tools: Vec::new(),
        options: RequestOptions { session_id: Some("s-1".into()), prompt_cache_key: Some("lane-1".into()), ..Default::default() },
    };
    let wire = codec.encode(&request).unwrap();
    (wire.headers, serde_json::from_slice(&wire.body).unwrap())
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name))
}

fn carries_reasoning(body: &Value) -> bool {
    body["input"].as_array().unwrap().iter().any(|item| item["type"] == "reasoning")
}

#[test]
fn a_codex_http_request_names_its_conversation_in_three_headers_unless_stateless() {
    let (headers, _) = http_request(None);
    for name in ["session_id", "session-id", "thread-id"] {
        assert!(has_header(&headers, name), "{name} anchors the conversation");
    }
    let (headers, _) = http_request(Some(("MIXDOG_OAI_STATELESS_HTTP", "1")));
    for name in ["session_id", "session-id", "thread-id"] {
        assert!(!has_header(&headers, name), "{name} is dropped by the stateless switch");
    }
    assert!(has_header(&headers, "x-client-request-id"), "the rest of the request is unchanged");
}

#[test]
fn only_the_documented_on_spellings_turn_a_switch_on() {
    for on in ["1", "true", "TRUE", "yes", "on", " On "] {
        let (headers, _) = http_request(Some(("MIXDOG_OAI_STATELESS_HTTP", on)));
        assert!(!has_header(&headers, "thread-id"), "{on:?} is on");
    }
    for off in ["0", "false", "off", "", "enabled", "2"] {
        let (headers, _) = http_request(Some(("MIXDOG_OAI_STATELESS_HTTP", off)));
        assert!(has_header(&headers, "thread-id"), "{off:?} is off");
    }
}

#[test]
fn the_reasoning_replay_kill_switch_drops_the_reasoning_items_of_earlier_turns() {
    let (_, body) = http_request(None);
    assert!(carries_reasoning(&body), "reasoning is replayed by default");
    let (_, body) = http_request(Some(("MIXDOG_OAI_DISABLE_REASONING_REPLAY", "true")));
    assert!(!carries_reasoning(&body), "the switch drops it");
    let (_, body) = http_request(Some(("MIXDOG_OAI_DISABLE_REASONING_REPLAY", "no")));
    assert!(carries_reasoning(&body), "an unknown spelling leaves it on");
}

/// The serialized `max_output_tokens` of a request that carries an explicit limit, on the route of `config`.
fn sent_limit(config: OpenAiConfig) -> Option<Value> {
    let request = ModelRequest {
        model: "gpt-5".into(),
        messages: vec![Message::new(Role::User, Content::Text("hello".into()))],
        tools: Vec::new(),
        options: RequestOptions { max_output_tokens_override: Some(321), ..Default::default() },
    };
    let wire = OpenAiCodec::new(config, TransportKind::Http1).encode(&request).unwrap();
    serde_json::from_slice::<Value>(&wire.body).unwrap().get("max_output_tokens").cloned()
}

#[test]
fn the_oauth_limit_follows_the_opt_in_at_each_payload_and_the_public_api_is_independent() {
    let setting = Arc::new(std::sync::Mutex::new(None::<String>));
    let read = setting.clone();
    let context = Arc::new(
        SessionContext::new().with_var(move |name| (name == "MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS").then(|| read.lock().unwrap().clone()).flatten()),
    );
    let identity = CodexIdentity { installation_id: "inst".into(), user_agent: "codex/1".into(), version: "0.1.0".into(), beta_features: "none".into() };
    let oauth = OpenAiConfig::codex(false, identity, Arc::new(Facts), context.clone());
    let public = OpenAiConfig::api_key(false, Arc::new(Facts), context);

    assert_eq!(sent_limit(oauth.clone()), None, "the subscription route omits it by default");
    assert_eq!(sent_limit(public.clone()), Some(json!(321)), "the public API sends it by default");

    *setting.lock().unwrap() = Some("1".into());
    assert_eq!(sent_limit(oauth.clone()), Some(json!(321)), "the opt-in set after construction applies");
    assert_eq!(sent_limit(public.clone()), Some(json!(321)));

    *setting.lock().unwrap() = Some("0".into());
    assert_eq!(sent_limit(oauth), None, "and withdrawing it applies too");
    assert_eq!(sent_limit(public), Some(json!(321)));
}

#[test]
fn the_transport_setting_pins_the_websocket_mode_and_everything_else_is_auto() {
    for (setting, mode) in [
        (Some("ws-full"), TransportMode::WsFull),
        (Some("WS_FULL"), TransportMode::WsFull),
        (Some("full"), TransportMode::WsFull),
        (Some("ws-delta"), TransportMode::WsDelta),
        (Some(" delta "), TransportMode::WsDelta),
        (Some("auto"), TransportMode::Auto),
        (Some("garbage"), TransportMode::Auto),
        (Some(""), TransportMode::Auto),
        (None, TransportMode::Auto),
        // HTTP/SSE is a different codec, not a WebSocket mode.
        (Some("http-sse"), TransportMode::Auto),
    ] {
        assert_eq!(openai_mode(setting.map(str::to_owned)), mode, "{setting:?}");
    }
}
