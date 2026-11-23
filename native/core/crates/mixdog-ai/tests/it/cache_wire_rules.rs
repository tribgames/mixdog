use std::sync::Arc;

use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
use mixdog_ai::providers::compat::{CompatChatCodec, CompatConfig, CompatProfile};
use mixdog_ai::providers::connect::rewrite::RewriteCodec;
use mixdog_ai::providers::custom::{CustomRequestConfig, CustomRewriter, Protocol, ReasoningSource, responses_codec};
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::{CodexIdentity, NoFacts, OpenAiConfig, WireContext};
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::{
    Content, ContentPart, ImageSource, Message, ModelRequest, RequestOptions, RequestThread, Role, ToolCall, WireCodec, WireRequest,
};
use serde_json::{Value, json};

fn request(options: RequestOptions) -> ModelRequest {
    ModelRequest {
        model: "gpt-5".into(),
        messages: vec![Message::new(Role::System, Content::Text("rules".into())), Message::new(Role::User, Content::Text("question".into()))],
        tools: Vec::new(),
        options,
    }
}

fn body(wire: &WireRequest) -> Value {
    serde_json::from_slice(&wire.body).expect("encoded request is JSON")
}

fn header<'a>(wire: &'a WireRequest, name: &str) -> Option<&'a str> {
    wire.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

struct Environment(&'static [(&'static str, &'static str)]);

impl WireContext for Environment {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn var(&self, name: &str) -> Option<String> {
        self.0.iter().find_map(|&(key, value)| (key == name).then(|| value.to_owned()))
    }
}

fn openai_key(config: OpenAiConfig, transport: TransportKind, request: &ModelRequest) -> String {
    let wire = OpenAiCodec::new(config, transport).encode(request).expect("encodes");
    body(&wire)["prompt_cache_key"].as_str().expect("cache key").to_owned()
}

#[test]
fn openai_prefix_keys_match_across_transports_and_use_configured_lanes_only() {
    let mut req = request(RequestOptions {
        session_id: Some("session".into()),
        prompt_cache_key: Some("wire-case".into()),
        model_parameters: Some(json!({ "promptCacheLaneSlot": 39 })),
        ..Default::default()
    });
    let public = |vars| OpenAiConfig::api_key(false, Arc::new(NoFacts), Arc::new(Environment(vars)));
    let unsharded = openai_key(public(&[]), TransportKind::Http1, &req);
    assert_eq!(unsharded, openai_key(public(&[("MIXDOG_OPENAI_CACHE_LANE_SHARDS", "1")]), TransportKind::Http1, &req));

    let config = public(&[("MIXDOG_OPENAI_CACHE_MAX_PARALLEL", "2")]).with_prompt_cache_lanes(&json!({ "promptCacheLaneShards": 4 }));
    let sharded = openai_key(config.clone(), TransportKind::Http1, &req);
    assert!(sharded.ends_with("-s03"), "slot 39 wraps in four configured lanes: {sharded}");
    assert_ne!(sharded.strip_suffix("-s03"), Some(unsharded.as_str()), "the lane also participates in the hash");
    assert_eq!(sharded, openai_key(config.clone(), TransportKind::WebSocket, &req));
    req.options.model_parameters = Some(json!({ "promptCacheLaneAuto": true, "promptCacheLaneSlot": 39 }));
    assert!(openai_key(config, TransportKind::Http1, &req).ends_with("-s13"));
}

#[test]
fn codex_keeps_thread_keys_but_uses_its_lanes_for_shared_prefix_keys() {
    let config = OpenAiConfig::codex(
        false,
        CodexIdentity { installation_id: "install".into(), user_agent: "codex/1".into(), version: "1".into(), beta_features: "none".into() },
        Arc::new(NoFacts),
        Arc::new(Environment(&[("MIXDOG_OPENAI_OAUTH_CACHE_MAX_PARALLEL", "3"), ("MIXDOG_OPENAI_CACHE_MAX_PARALLEL", "2")])),
    );
    let mut req =
        request(RequestOptions { session_id: Some("thread-key".into()), model_parameters: Some(json!({ "cacheLaneSlot": 2 })), ..Default::default() });
    assert_eq!(openai_key(config.clone(), TransportKind::Http1, &req), "thread-key");
    req.options.prompt_cache_scope = Some("shared".into());
    assert!(openai_key(config, TransportKind::Http1, &req).ends_with("-s02"));
}

#[test]
fn a_configured_codex_prefix_lane_hashes_the_session_not_the_thread_id() {
    let config = OpenAiConfig::codex(
        false,
        CodexIdentity { installation_id: "install".into(), user_agent: "codex/1".into(), version: "1".into(), beta_features: "none".into() },
        Arc::new(NoFacts),
        Arc::new(Environment(&[("MIXDOG_OAI_CODEX_THREAD_CACHE_KEY", "0")])),
    )
    .with_prompt_cache_lanes(&json!({ "promptCacheLaneShards": 3 }));
    let mut req =
        request(RequestOptions { session_id: Some("session-a".into()), model_parameters: Some(json!({ "promptCacheLaneSlot": 2 })), ..Default::default() });
    let key = openai_key(config.clone(), TransportKind::Http1, &req);
    assert!(key.ends_with("-s02"));
    req.options.thread = Some(RequestThread { id: "thread-1".into(), window: 0, turn: None, turn_started_at_ms: None });
    assert_eq!(openai_key(config.clone(), TransportKind::Http1, &req), key);
    req.options.session_id = Some("session-b".into());
    assert_ne!(openai_key(config, TransportKind::Http1, &req), key);
}

#[test]
fn xai_chat_tool_results_do_not_add_file_id_placeholders_to_the_prefix() {
    let mut req = request(RequestOptions::default());
    let mut assistant = Message::new(Role::Assistant, Content::Text(String::new().into()));
    assistant.tool_calls.push(ToolCall { id: "call_1".into(), name: "capture".into(), arguments: json!({}), native_type: None });
    let mut tool = Message::new(
        Role::Tool,
        Content::Parts(vec![
            ContentPart::Text("before".into(), None),
            ContentPart::Image(ImageSource::FileId("file-9".into())),
            ContentPart::Text("after".into(), None),
        ]),
    );
    tool.tool_call_id = Some("call_1".into());
    req.messages.extend([assistant, tool]);
    let wire = CompatChatCodec::new(CompatProfile::xai(), CompatConfig::default()).encode(&req).unwrap();
    assert_eq!(body(&wire)["messages"][3], json!({ "role": "tool", "tool_call_id": "call_1", "content": "before\nafter" }));
}

#[test]
fn openrouter_chat_leaves_breakpoints_on_their_text_blocks() {
    let mut req = request(RequestOptions::default());
    let marker = json!({ "type": "ephemeral", "ttl": "1h" });
    let marked = |text: &str| ContentPart::Text(text.into(), Some(json!({ "cache_control": marker }).as_object().unwrap().clone()));
    req.messages[0].content = Content::Parts(vec![marked("rules"), ContentPart::Text("tail".into(), None)]);
    req.messages[1].content = Content::Parts(vec![marked("question")]);
    let encode = |profile| body(&CompatChatCodec::new(profile, CompatConfig::default()).encode(&req).unwrap());
    let supported = encode(CompatProfile::openrouter());
    assert_eq!(
        supported["messages"][0]["content"],
        json!([
            { "type": "text", "text": "rules", "cache_control": marker },
            { "type": "text", "text": "tail" },
        ])
    );
    assert_eq!(supported["messages"][1]["content"][0]["cache_control"], marker);
    let unsupported = encode(CompatProfile::deepseek());
    assert_eq!(unsupported["messages"][0]["content"], "rules\ntail");
    assert!(unsupported["messages"][1]["content"][0].get("cache_control").is_none());
}

#[test]
fn compatible_gateway_responses_opts_in_without_adding_custom_affinity_headers() {
    let codec = |setting| CompatResponsesCodec::new(CompatProfile::openrouter(), CompatConfig::default(), TransportKind::Http1).with_prompt_cache_key(setting);
    let mut req = request(RequestOptions { session_id: Some("session".into()), ..Default::default() });
    assert!(body(&codec(None).encode(&req).unwrap()).get("prompt_cache_key").is_none());
    let configured = codec(Some(true)).encode(&req).unwrap();
    assert_eq!(body(&configured)["prompt_cache_key"], "session");
    assert_eq!(header(&configured, "session-id"), None);
    assert_eq!(header(&configured, "x-client-request-id"), None);
    req.options.model_parameters = Some(json!({ "responsesPromptCacheKey": false }));
    assert!(body(&codec(Some(true)).encode(&req).unwrap()).get("prompt_cache_key").is_none());
    req.options.model_parameters = Some(json!({ "responsesPromptCacheKey": true }));
    assert_eq!(body(&codec(Some(false)).encode(&req).unwrap())["prompt_cache_key"], "session");
}

struct NoRows;

impl mixdog_ai::catalog::CachedModelInfo for NoRows {
    fn cached_row(&self, _: &str) -> Option<Arc<Value>> {
        None
    }
}

#[test]
fn disabling_custom_responses_caching_omits_the_key_and_synthetic_headers() {
    let endpoint = "https://custom.example/v1";
    let config = mixdog_ai::providers::custom::config::normalize(&json!({
        "type": "custom", "schemaVersion": 2, "name": "Custom", "protocol": "openai-responses",
        "baseURL": endpoint, "responsesPromptCacheKey": false,
    }))
    .unwrap();
    let rewriter = CustomRewriter {
        config: CustomRequestConfig {
            responses_prompt_cache_key: config["responsesPromptCacheKey"].as_bool(),
            headers: vec![("X-Client-Request-Id".into(), "supplied".into())],
            ..Default::default()
        },
        wire: Protocol::OpenaiResponses,
        reasoning: ReasoningSource { rows: Arc::new(NoRows), configured: None, base_url: endpoint.into() },
    };
    let codec = RewriteCodec::new(responses_codec("custom-cache", endpoint), rewriter);
    let mut req = request(RequestOptions { session_id: Some("session".into()), prompt_cache_key: Some("saved".into()), ..Default::default() });
    let wire = codec.encode(&req).unwrap();
    assert!(body(&wire).get("prompt_cache_key").is_none());
    assert_eq!(header(&wire, "session-id"), None);
    assert_eq!(header(&wire, "x-client-request-id"), Some("supplied"));

    req.options.model_parameters = Some(json!({ "responsesPromptCacheKey": true, "providerCacheKey": "named", "promptCacheKey": " explicit " }));
    assert_eq!(body(&codec.encode(&req).unwrap())["prompt_cache_key"], "session");
    req.options.prompt_cache_scope = Some("shared".into());
    let wire = codec.encode(&req).unwrap();
    assert_eq!(body(&wire)["prompt_cache_key"], "explicit");
    assert_eq!(header(&wire, "session-id"), Some("explicit"));
    assert_eq!(header(&wire, "x-client-request-id"), Some("supplied"));
    req.options.model_parameters.as_mut().unwrap().as_object_mut().unwrap().remove("promptCacheKey");
    assert_eq!(body(&codec.encode(&req).unwrap())["prompt_cache_key"], "named");
}
