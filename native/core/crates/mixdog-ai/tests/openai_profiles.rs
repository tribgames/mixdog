//! The neutral Responses builder against the recorded gateway and xAI request
//! heads (`compat-responses` and `xai-tool-search` oracles). The profiles are
//! built here from data only, the way a gateway family would.

#![allow(
    clippy::disallowed_methods,
    reason = "test-only: reads recorded oracle files synchronously"
)]

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_ai::providers::openai::body::build;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_ai::providers::openai::input::ToolSearchReplay;
use mixdog_ai::providers::openai::profile::BuildInputs;
use mixdog_ai::providers::openai::profile::ORDER_ROUTED;
use mixdog_ai::providers::openai::profile::ParallelToolCalls;
use mixdog_ai::providers::openai::profile::ResponsesProfile;
use mixdog_ai::providers::openai::profile::SystemPlacement;
use mixdog_ai::providers::openai::profile::ToolLowering;
use mixdog_ai::providers::openai::profile::build_body as build_request;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::Phase;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn body_of(profile: &ResponsesProfile, inputs: &BuildInputs<'_>) -> Map<String, Value> {
    build_request(profile, inputs).body
}

fn oracle(name: &str) -> Map<String, Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/providers/oracles")
        .join(name);
    let text = std::fs::read_to_string(path).unwrap();
    serde_json::from_str::<Value>(&text).unwrap().as_object().unwrap().clone()
}

// ---- histories (the fixtures' transcripts) --------------------------------

fn text(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn assistant_calls(content: &str, calls: Vec<ToolCall>) -> Message {
    let mut m = text(Role::Assistant, content);
    m.tool_calls = calls;
    m
}

fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), arguments, native_type: None }
}

fn native_call(id: &str, name: &str, arguments: Value, native_type: &str) -> ToolCall {
    ToolCall { native_type: Some(native_type.into()), ..call(id, name, arguments) }
}

fn tool(id: &str, content: &str) -> Message {
    let mut m = text(Role::Tool, content);
    m.tool_call_id = Some(id.into());
    m
}

fn search(provider: &str) -> Value {
    json!({"provider": provider, "openaiTools": [
        {"type": "function", "name": "x", "description": "d",
         "parameters": {"type": "object", "properties": {}}}]})
}

fn native_history() -> Vec<Message> {
    vec![
        text(Role::User, "go"),
        assistant_calls(
            "",
            vec![
                native_call("ts1", "load_tool", json!({"names": ["x"]}), "tool_search_call"),
                native_call("cu1", "apply_patch", json!({"patch": "P"}), "custom_tool_call"),
                call("fn1", "Read", json!({"path": "a"})),
            ],
        ),
        tool("ts1", "loaded"),
        tool("cu1", "patched"),
        tool("fn1", "file"),
        text(Role::User, "next"),
    ]
}

fn own_search_history(name: &str) -> Vec<Message> {
    let mut h = native_history();
    h[2].native_tool_search = Some(search(name));
    h
}

fn oauth_history() -> Vec<Message> {
    let mut working = text(Role::Assistant, "working");
    working.phase = Some(Phase::Commentary);
    let mut looking = assistant_calls(
        "looking",
        vec![
            native_call("ts1", "load_tool", json!({"names": ["x"]}), "tool_search_call"),
            native_call("cu1", "apply_patch", json!({"patch": "P"}), "custom_tool_call"),
            call("sk1", "Skill", json!({"name": "s"})),
        ],
    );
    looking.phase = Some(Phase::Commentary);
    looking.push_replay(ProviderReplay {
        owner: ProviderId::from("openai-responses"),
        items: json!([{"type": "reasoning", "id": "rs", "encrypted_content": "ENC", "summary": []}]),
    });
    let mut ts1 = tool("ts1", "loaded");
    ts1.native_tool_search = Some(search("openai-oauth"));
    let mut sk1 = tool("sk1", "skill");
    sk1.native_tool_search = Some(search("openai-oauth"));
    let mut f2 = assistant_calls("", vec![call("f2", "Read", json!({"path": "a"}))]);
    f2.push_replay(ProviderReplay {
        owner: ProviderId::from("openai-responses"),
        items: json!([{"type": "tool_search_call", "call_id": "ts9", "execution": "client", "arguments": {}}]),
    });
    vec![
        text(Role::System, "sys"),
        text(Role::User, "go"),
        working,
        looking,
        ts1,
        tool("cu1", "patched"),
        sk1,
        f2,
        tool("f2", "file"),
        text(Role::User, "next"),
    ]
}

fn server_search_history(owner: &str) -> Vec<Message> {
    let mut m = assistant_calls("done", vec![call("c1", "Read", json!({}))]);
    m.push_replay(ProviderReplay {
        owner: ProviderId::from(owner),
        items: json!([
            {"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []},
            {"type": "tool_search_call", "id": "ts_srv", "call_id": null, "execution": "server", "arguments": {"query": "q"}},
            {"type": "tool_search_output", "id": "tso_srv", "call_id": null, "execution": "server", "tools": []},
            {"type": "function_call", "call_id": "c1", "name": "Read", "arguments": "{}"}
        ]),
    });
    vec![text(Role::User, "find tools"), m, tool("c1", "ok"), text(Role::User, "next")]
}

fn xai_turn() -> Value {
    json!([
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []},
        {"type": "tool_search_call", "id": "tsc_1", "call_id": null, "execution": "server",
         "status": "completed", "arguments": {"query": "mcp__weather__forecast", "limit": 1}},
        {"type": "tool_search_output", "id": "tso_1", "call_id": null, "execution": "server",
         "status": "completed", "tools": [{"type": "function", "name": "mcp__weather__forecast",
         "description": "Forecast", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
         "defer_loading": true}]},
        {"type": "function_call", "id": "fc_1", "call_id": "call_w", "name": "mcp__weather__forecast",
         "arguments": "{\"city\":\"Seoul\"}", "status": "completed"}
    ])
}

fn xai_server_history() -> Vec<Message> {
    let mut m = assistant_calls(
        "",
        vec![call("call_w", "mcp__weather__forecast", json!({"city": "Seoul"}))],
    );
    m.push_replay(ProviderReplay { owner: ProviderId::from("xai-responses"), items: xai_turn() });
    vec![
        text(Role::User, "weather in Seoul?"),
        m,
        tool("call_w", "sunny"),
        text(Role::User, "and Busan?"),
    ]
}

fn def(name: &str, description: &str, schema: Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: description.into(), input_schema: schema, defer_loading: false }
}

fn session_tools() -> Vec<ToolDefinition> {
    vec![
        def("Read", "Read a file", json!({"type": "object", "properties": {"path": {"type": "string"}}})),
        def("load_tool", "Load tools", json!({"type": "object", "properties": {"names": {"type": "array"}}})),
    ]
}

fn deferred_tools() -> Vec<ToolDefinition> {
    let mut tools = session_tools();
    let mut forecast = def(
        "mcp__weather__forecast",
        "Forecast",
        json!({"type": "object", "properties": {"city": {"type": "string"}}}),
    );
    forecast.defer_loading = true;
    tools.push(forecast);
    tools
}

fn request(model: &str, messages: Vec<Message>, tools: Vec<ToolDefinition>, cache_key: Option<&str>) -> ModelRequest {
    ModelRequest {
        model: model.into(),
        messages,
        tools,
        options: RequestOptions { prompt_cache_key: cache_key.map(str::to_owned), ..Default::default() },
    }
}

/// Key order is part of the contract, so the comparison is on the text.
fn same(actual: &Map<String, Value>, expected: &Value, label: &str) {
    let (a, e) = (&actual["input"], &expected["input"]);
    if let (Some(a), Some(e)) = (a.as_array(), e.as_array()) {
        for i in 0..a.len().max(e.len()) {
            assert_eq!(a.get(i), e.get(i), "{label}: input[{i}]");
        }
    }
    assert_eq!(
        serde_json::to_string(actual).unwrap(),
        serde_json::to_string(expected).unwrap(),
        "{label}"
    );
}

// ---- gateway family: OpenCode Go, Muse Code, Command Code, xAI, ... -------

fn gateway(name: &str, prompt_cache_key: bool) -> ResponsesProfile {
    let mut profile = ResponsesProfile::gateway(ProviderId::from(format!("compat-responses:{name}").as_str()));
    profile.prompt_cache_key = prompt_cache_key;
    profile
}

#[test]
fn gateway_profile_matches_the_compat_heads() {
    let heads = oracle("openai-compat-responses-head-parity.json");
    let routes = [
        ("opencode-go", "gpt-5.5"),
        ("muse-code", "muse-spark"),
        ("command-code", "gpt-5.5"),
        ("xai", "grok-4"),
        ("opencode-go", "grok-4"),
    ];
    let mut checked = 0;
    for (name, model) in routes {
        let profile = gateway(name, false);
        let cases: [(&str, Vec<Message>); 4] = [
            ("native", native_history()),
            ("oauth", oauth_history()),
            ("own-search-output", own_search_history(name)),
            ("server-replay", server_search_history(&format!("compat-responses:{name}"))),
        ];
        for (label, history) in cases {
            let key = format!("compat/{name}/{model}/{label}");
            let body = body_of(&profile, &BuildInputs::new(&request(model, history, vec![], None)));
            same(&body, &heads[&key], &key);
            checked += 1;
        }
    }
    assert_eq!(checked, 20);
}

#[test]
fn a_profile_that_sends_the_cache_key_matches_the_custom_route_heads() {
    let heads = oracle("openai-compat-responses-head-parity.json");
    let profile = gateway("custom-cmd", true);
    let model = "openai/gpt-5.6-sol";
    let body = body_of(
        &profile,
        &BuildInputs::new(&request(model, native_history(), vec![], Some("sess-1"))),
    );
    same(&body, &heads["compat/custom-cmd/openai/gpt-5.6-sol/native"], "custom native");
}

// ---- xAI -----------------------------------------------------------------

fn xai_http() -> ResponsesProfile {
    let mut profile = ResponsesProfile::gateway(ProviderId::from("xai-responses"));
    profile.order = ORDER_ROUTED.to_vec();
    profile.prompt_cache_key = true;
    profile.parallel_tool_calls = ParallelToolCalls::WithTools;
    profile
}

fn xai_ws() -> ResponsesProfile {
    let mut profile = xai_http();
    profile.stream = false;
    profile.system = SystemPlacement::Instructions { fallback: None, environment_message: false };
    profile.input.system_in_input = false;
    profile
}

#[test]
fn xai_profiles_match_the_http_and_websocket_heads() {
    let heads = oracle("xai-tool-search-head-parity.json");
    let key = "f0858c98-2db1-4764-9d18-e6e1ec2ea4c7";
    let cases: [(&str, Vec<Message>, Vec<ToolDefinition>); 5] = [
        ("native/plain-tools", native_history(), session_tools()),
        ("oauth/plain-tools", oauth_history(), session_tools()),
        ("server-replay/plain-tools", xai_server_history(), session_tools()),
        ("server-replay/deferred-tools", xai_server_history(), deferred_tools()),
        ("native/deferred-tools", native_history(), deferred_tools()),
    ];
    for (label, history, tools) in cases {
        let req = request("grok-4", history, tools, Some(key));
        for (transport, profile) in [("http", xai_http()), ("ws", xai_ws())] {
            let name = format!("{transport}/{label}");
            let body = body_of(&profile, &BuildInputs::new(&req));
            same(&body, &heads[&name], &name);
        }
    }
}

#[test]
fn server_search_declares_one_server_tool_and_marks_deferred_tools() {
    let mut profile = xai_http();
    profile.tools = ToolLowering::ServerSearch;
    let req = request("grok-4", vec![text(Role::User, "hi")], deferred_tools(), None);
    let body = body_of(
        &profile,
        &BuildInputs::new(&req),
    );
    let types: Vec<(&str, bool)> = body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["type"].as_str().unwrap(), t.get("defer_loading").is_some()))
        .collect();
    assert_eq!(types, vec![("function", false), ("tool_search", false), ("function", true)]);

    let no_loader: Vec<ToolDefinition> = deferred_tools().into_iter().filter(|t| t.name != "load_tool").collect();
    let req = request("grok-4", vec![text(Role::User, "hi")], no_loader, None);
    let body = body_of(
        &profile,
        &BuildInputs::new(&req),
    );
    let searches = body["tools"].as_array().unwrap().iter().filter(|t| t["type"] == "tool_search").count();
    assert_eq!(searches, 1);
}

// ---- first-party profile (the same builder) --------------------------------

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts {
            reasoning: Some(true),
            reasoning_summaries: Some(true),
            verbosity: Some(true),
            native_tool_search: Some(true),
            ..Default::default()
        }
    }
}

struct Ctx;
impl WireContext for Ctx {
    fn request_id(&self) -> String { "0".repeat(32) }
    fn now_unix_ms(&self) -> u64 { 0 }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> { None }
}

#[test]
fn first_party_server_replay_heads_still_hold() {
    let heads = oracle("openai-compat-responses-head-parity.json");
    let identity = CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "1".into(),
        beta_features: "b".into(),
    };
    let configs = [
        ("openai", OpenAiConfig::api_key(false, Arc::new(Facts), Arc::new(Ctx))),
        ("openai-oauth", OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx))),
    ];
    for (name, config) in configs {
        let key = format!("first-party/{name}/server-replay");
        let expected = heads[&key].clone();
        let cache = expected["prompt_cache_key"].as_str().unwrap().to_owned();
        let req = request(
            "gpt-5.5",
            server_search_history("openai-responses"),
            vec![],
            Some(&cache),
        );
        same(&build(&config, &req).map, &expected, &key);
    }
}

#[test]
fn downgrade_replay_drops_server_search_where_verbatim_keeps_it() {
    let mut profile = gateway("x", false);
    profile.input.tool_search_replay = ToolSearchReplay::Downgrade;
    let req = request("m", server_search_history("compat-responses:x"), vec![], None);
    let body = body_of(&profile, &BuildInputs::new(&req));
    assert!(!serde_json::to_string(&body).unwrap().contains("tool_search"));
}

// ---- first-party heads that need the contract's native call types ---------

fn first_party_configs() -> [(&'static str, OpenAiConfig); 2] {
    let identity = CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "1".into(),
        beta_features: "b".into(),
    };
    [
        ("openai", OpenAiConfig::api_key(false, Arc::new(Facts), Arc::new(Ctx))),
        ("openai-oauth", OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx))),
    ]
}

#[test]
fn first_party_native_oauth_and_own_search_heads_hold() {
    let heads = oracle("openai-compat-responses-head-parity.json");
    for (name, config) in first_party_configs() {
        let cases: [(&str, Vec<Message>); 3] = [
            ("native", native_history()),
            ("oauth", oauth_history()),
            ("own-search-output", own_search_history(name)),
        ];
        for (label, history) in cases {
            let key = format!("first-party/{name}/{label}");
            let expected = heads[&key].clone();
            let cache = expected["prompt_cache_key"].as_str().unwrap().to_owned();
            let req = request("gpt-5.5", history, vec![], Some(&cache));
            same(&build(&config, &req).map, &expected, &key);
        }
    }
}

// ---- tool choice, parallel calls, schema exclusion --------------------------

#[test]
fn forced_tool_choice_names_the_function_and_parallel_override_is_honored_per_profile() {
    let config = first_party_configs().into_iter().next().unwrap().1;
    let mut req = request("gpt-5.5", vec![text(Role::User, "x")], session_tools(), None);
    req.options.tool_choice = Some("Read".into());
    assert_eq!(build(&config, &req).map["tool_choice"], json!({"type": "function", "name": "Read"}));
    req.options.tool_choice = Some("required".into());
    assert_eq!(build(&config, &req).map["tool_choice"], json!("required"));

    req.options.parallel_tool_calls = Some(false);
    let mut profile = xai_http();
    assert_eq!(body_of(&profile, &BuildInputs::new(&req))["parallel_tool_calls"], json!(true));
    profile.honor_parallel_override = true;
    assert_eq!(body_of(&profile, &BuildInputs::new(&req))["parallel_tool_calls"], json!(false));
}

#[test]
fn a_tool_with_an_unusable_schema_is_left_out_and_reported_once() {
    let mut tools = session_tools();
    tools.push(def("Broken", "bad", json!({"type": "array"})));
    let req = request("grok-4", vec![text(Role::User, "x")], tools, None);
    let mut profile = xai_http();
    profile.tool_label = "[xai] tool".into();
    let built = build_request(&profile, &BuildInputs::new(&req));
    let names: Vec<_> = built.body["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Read", "load_tool"]);
    assert_eq!(built.excluded.len(), 1);
    assert_eq!(built.excluded[0].name, "Broken");
    assert!(built.excluded[0].message.starts_with("[xai] tool \"Broken\""));
}

// ---- continuation and effort -------------------------------------------------

use mixdog_ai::providers::openai::continuation::Continuation;
use mixdog_ai::providers::openai::continuation::ContinuationSpec;
use mixdog_ai::providers::openai::continuation::ResetReason;
use mixdog_ai::providers::openai::continuation::TurnResult;
use mixdog_ai::providers::openai::continuation::next_slot;
use mixdog_ai::providers::openai::continuation::resume;
use mixdog_ai::providers::openai::continuation::with_slot;
use mixdog_ai::providers::openai::effort::EffortProjection;

fn spec() -> ContinuationSpec {
    gateway("opencode-go", false).continuation
}

const OWNER: &str = "compat-responses:opencode-go";

fn turn_output() -> Vec<Value> {
    vec![
        json!({"type": "reasoning", "id": "rs_9", "encrypted_content": "ENC9", "summary": []}),
        json!({"type": "reasoning", "id": "rs_empty", "summary": []}),
        json!({"type": "message", "role": "assistant", "content": []}),
    ]
}

#[test]
fn the_slot_records_the_turn_and_resumes_a_stateless_conversation() {
    let output = turn_output();
    let history = vec![text(Role::User, "go"), text(Role::Assistant, "ok"), text(Role::User, "next")];
    let slot = next_slot(
        &spec(),
        OWNER,
        None,
        &TurnResult { response_id: Some("resp_1"), output: &output, model: "gpt-5.5", message_count: 1, updated_at_ms: 7 },
    );
    assert_eq!(
        serde_json::to_string(&slot).unwrap(),
        concat!(
            r#"{"previousResponseId":null,"responseId":"resp_1","store":false,"owner":"compat-responses:opencode-go","#,
            r#""encryptedReasoningItems":[{"type":"reasoning","id":"rs_9","encrypted_content":"ENC9","summary":[]}],"#,
            r#""encryptedReasoningHistory":[{"messageIndex":1,"items":[{"type":"reasoning","id":"rs_9","encrypted_content":"ENC9","summary":[]}],"owner":"compat-responses:opencode-go"}],"#,
            r#""seenMessageCount":1,"model":"gpt-5.5","updatedAt":7}"#
        )
    );

    let resumed = resume(&spec(), OWNER, Some(&slot), "gpt-5.5", &history).unwrap();
    assert_eq!(resumed.previous_response_id, None);
    assert_eq!(resumed.start_index, 0, "a stateless conversation resends everything");
    assert_eq!(resumed.reset_reason, None);
    let profile = gateway("opencode-go", false);
    let req = request("gpt-5.5", history, vec![], None);
    let body = body_of(&profile, &BuildInputs { continuation: Some(&resumed), ..BuildInputs::new(&req) });
    let kinds: Vec<_> = body["input"].as_array().unwrap().iter().map(|i| i["type"].as_str().or(i["role"].as_str()).unwrap()).collect();
    assert_eq!(kinds, ["user", "reasoning", "assistant", "user"], "reasoning goes before the message it followed");
    assert!(body.get("previous_response_id").is_none());
}

#[test]
fn trailing_reasoning_follows_the_last_message_and_other_owners_are_ignored() {
    let output = turn_output();
    let history = vec![text(Role::User, "go")];
    let mine = next_slot(
        &spec(), OWNER, None,
        &TurnResult { response_id: None, output: &output, model: "m", message_count: 1, updated_at_ms: 0 },
    );
    let resumed = resume(&spec(), OWNER, Some(&mine), "m", &history).unwrap();
    let req = request("m", history.clone(), vec![], None);
    let body = body_of(&gateway("opencode-go", false), &BuildInputs { continuation: Some(&resumed), ..BuildInputs::new(&req) });
    assert_eq!(body["input"].as_array().unwrap().len(), 2);
    assert_eq!(body["input"][1]["encrypted_content"], "ENC9");

    let foreign = resume(&spec(), "compat-responses:other", Some(&mine), "m", &history).unwrap();
    assert!(foreign.reasoning_by_index.is_empty());
}

#[test]
fn a_slot_that_no_longer_fits_is_dropped_with_its_reason() {
    let history = vec![text(Role::User, "go"), text(Role::Assistant, "ok")];
    let base = json!({"previousResponseId": null, "store": false, "seenMessageCount": 1, "model": "a"});
    let r = |slot: Value, model: &str| resume(&spec(), OWNER, Some(&slot), model, &history).unwrap().reset_reason;
    assert_eq!(r(base.clone(), "b"), Some(ResetReason::ModelChanged));
    assert_eq!(r(json!({"store": false, "model": "a"}), "a"), Some(ResetReason::MissingSeenMessageCount));
    assert_eq!(r(json!({"store": false, "seenMessageCount": 3, "model": "a"}), "a"), Some(ResetReason::SeenMessageCountOutOfRange));
    assert_eq!(r(base, "a"), None);
    assert_eq!(resume(&spec(), OWNER, None, "a", &history).unwrap(), Continuation::default());
}

#[test]
fn a_stored_response_sends_only_what_follows_it() {
    let history = vec![text(Role::User, "go"), text(Role::Assistant, "ok"), text(Role::User, "next")];
    let slot = json!({"previousResponseId": "resp_7", "seenMessageCount": 1, "model": "m"});
    let resumed = resume(&spec(), OWNER, Some(&slot), "m", &history).unwrap();
    assert_eq!((resumed.previous_response_id.as_deref(), resumed.start_index), (Some("resp_7"), 2));
    let req = request("m", history, vec![], None);
    let mut profile = gateway("opencode-go", false);
    let body = body_of(&profile, &BuildInputs { continuation: Some(&resumed), ..BuildInputs::new(&req) });
    assert_eq!(body["previous_response_id"], "resp_7");
    assert_eq!(body["input"].as_array().unwrap().len(), 1);
    let keys: Vec<_> = body.keys().map(String::as_str).collect();
    assert_eq!(keys, ["model", "input", "store", "include", "stream", "previous_response_id"]);

    // A route whose continuation anchors the instructions drops them.
    profile.system = SystemPlacement::Instructions { fallback: None, environment_message: false };
    profile.instructions_with_previous_response = false;
    let mut with_system = req.clone();
    with_system.messages.insert(0, text(Role::System, "rules"));
    let continued = body_of(&profile, &BuildInputs { continuation: Some(&resumed), ..BuildInputs::new(&with_system) });
    assert!(continued.get("instructions").is_none());
}

#[test]
fn a_stateless_only_route_refuses_imported_server_state() {
    let mut route = spec();
    route.stateless_only = Some("openrouter".into());
    let history = vec![text(Role::User, "go")];
    let stored = json!({"previousResponseId": "resp_1", "seenMessageCount": 1});
    let err = resume(&route, OWNER, Some(&stored), "m", &history).unwrap_err();
    assert!(err.to_string().starts_with("openrouter Responses is stateless"));
    assert!(resume(&route, OWNER, Some(&json!({"store": true})), "m", &history).is_err());
    assert!(resume(&route, OWNER, Some(&json!({"store": false, "seenMessageCount": 1})), "m", &history).is_ok());
}

#[test]
fn the_slot_merges_into_provider_state_without_touching_other_slots() {
    let state = json!({"other": {"keep": 1}, "compatResponses": {"old": true}});
    let merged = with_slot(Some(&state), &spec(), json!({"new": true}));
    assert_eq!(merged, json!({"other": {"keep": 1}, "compatResponses": {"new": true}}));
}

#[test]
fn effort_updates_ride_as_items_and_the_initial_effort_leads() {
    let history = vec![
        text(Role::User, "a"),
        assistant_calls("", vec![call("c1", "Read", json!({}))]),
        tool("c1", "r"),
        text(Role::User, "b"),
        text(Role::Assistant, "ok"),
    ];
    let wire = |e: &str| Some(e.to_owned());
    let effort = EffortProjection::from_session(
        "low",
        [(0, "low".to_owned()), (2, "high".to_owned()), (3, "high".to_owned())],
        &wire,
    )
    .unwrap();
    assert_eq!(effort.updates.len(), 1, "an unchanged effort is not an update");
    let mut profile = gateway("custom", false);
    profile.reasoning = Some(mixdog_ai::providers::openai::profile::ReasoningSpec {
        summary: false,
        default_effort: None,
        effort_aliases: vec![],
    });
    let req = request("m", history, vec![], None);
    let body = body_of(&profile, &BuildInputs { effort: Some(&effort), ..BuildInputs::new(&req) });
    assert_eq!(body["reasoning"], json!({"effort": "low"}));
    let kinds: Vec<_> = body["input"].as_array().unwrap().iter().map(|i| i["type"].as_str().or(i["role"].as_str()).unwrap()).collect();
    // The update on the tool result applies after its batch, before the next user message.
    assert_eq!(kinds, ["user", "function_call", "function_call_output", "configuration_update", "user", "assistant"]);
    assert_eq!(body["input"][3]["reasoning"], json!({"effort": "high"}));

    let none = |e: &str| (e != "ultra").then(|| e.to_owned());
    assert!(EffortProjection::from_session("low", [(1, "ultra".to_owned())], &none).is_none());
}

#[test]
fn the_decoder_tags_replays_with_the_profile_owner() {
    use mixdog_ai::providers::openai::decoder::Framing;
    use mixdog_core_api::domain::provider::StreamEvent;
    let profile = gateway("opencode-go", false);
    let mut decoder = profile.decoder(Framing::Sse, Arc::new(Ctx));
    let frame = r#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"E","summary":[]}}

"#;
    use mixdog_core_api::domain::provider::WireDecoder;
    let events = decoder.feed(frame.as_bytes()).unwrap();
    let owners: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ReasoningReplay(r) => Some(r.owner.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(owners, [ProviderId::from(OWNER)]);
}

// ---- effort-update rejection ---------------------------------------------------

use mixdog_ai::providers::openai::effort_retry::EffortUpdateSupport;
use mixdog_ai::providers::openai::effort_retry::without_effort_updates;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::WireRequest;

fn effort_request() -> WireRequest {
    let body = json!({"model": "m", "input": [
        {"role": "user", "content": []},
        {"type": "configuration_update", "reasoning": {"effort": "high"}},
        {"role": "user", "content": []}
    ]});
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: "https://example.test/v1/responses".into(),
        headers: vec![("x".into(), "y".into())],
        body: serde_json::to_vec(&body).unwrap(),
    }
}

fn rejection(status: u16, body: Value) -> ErrorResponse {
    ErrorResponse { status: Some(status), headers: vec![], body: serde_json::to_vec(&body).unwrap() }
}

#[test]
fn a_rejected_effort_update_is_retried_once_without_updates() {
    let sent = effort_request();
    let rejected = rejection(400, json!({"error": {"code": "invalid_value", "param": "input[1].reasoning"}}));
    let retry = without_effort_updates(&sent, &rejected).expect("retry");
    let body: Value = serde_json::from_slice(&retry.body).unwrap();
    assert_eq!(body["input"].as_array().unwrap().len(), 2);
    assert_eq!((retry.url.as_str(), retry.headers.clone()), (sent.url.as_str(), sent.headers.clone()));
    // The retried request carries no update, so a second rejection cannot loop.
    assert!(without_effort_updates(&retry, &rejected).is_none());
}

#[test]
fn only_a_structured_pointer_at_an_update_item_counts() {
    let sent = effort_request();
    // Names the update in prose but points at an ordinary message.
    let prose = rejection(400, json!({"error": {"message": "bad configuration_update", "param": "input[0]"}}));
    assert!(without_effort_updates(&sent, &prose).is_none());
    // Prose only, no param.
    let no_param = rejection(400, json!({"error": {"message": "mid-conversation configuration_update rejected"}}));
    assert!(without_effort_updates(&sent, &no_param).is_none());
    // Right pointer, wrong status.
    let server = rejection(500, json!({"error": {"param": "input[1]"}}));
    assert!(without_effort_updates(&sent, &server).is_none());
    // A pointer past the input.
    let beyond = rejection(400, json!({"error": {"param": "input[9]"}}));
    assert!(without_effort_updates(&sent, &beyond).is_none());
}

#[test]
fn a_rejecting_model_is_remembered_per_route() {
    let support = EffortUpdateSupport::default();
    assert!(!support.is_rejected("openai", "gpt-6"));
    support.mark_rejected("openai", "gpt-6");
    assert!(support.is_rejected("openai", "gpt-6"));
    assert!(!support.is_rejected("openai-oauth", "gpt-6"));
}
