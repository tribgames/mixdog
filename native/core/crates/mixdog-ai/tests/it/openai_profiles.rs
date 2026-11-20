//! The neutral Responses builder against the recorded gateway and xAI request
//! heads (`compat-responses` and `xai-tool-search` oracles). The profiles are
//! built here from data only, the way a gateway family would.

#![allow(
    clippy::disallowed_methods,
    reason = "test-only: reads recorded oracle files synchronously"
)]

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
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::ProviderState;
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


fn tool(id: &str, content: &str) -> Message {
    let mut m = text(Role::Tool, content);
    m.tool_call_id = Some(id.into());
    m
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



fn def(name: &str, description: &str, schema: Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: description.into(), input_schema: schema, defer_loading: false, freeform: None }
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



// ---- gateway family: OpenCode Go, Muse Code, Command Code, xAI, ... -------

fn gateway(name: &str, prompt_cache_key: bool) -> ResponsesProfile {
    let mut profile = ResponsesProfile::gateway(ProviderId::from(format!("compat-responses:{name}").as_str()));
    profile.prompt_cache_key = prompt_cache_key;
    profile
}

// ---- xAI -----------------------------------------------------------------

fn xai_http() -> ResponsesProfile {
    let mut profile = ResponsesProfile::gateway(ProviderId::from("xai-responses"));
    profile.order = ORDER_ROUTED.to_vec();
    profile.prompt_cache_key = true;
    profile.parallel_tool_calls = ParallelToolCalls::WithTools;
    profile
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
fn a_websocket_delta_keeps_the_hit_body_when_its_source_is_in_the_stripped_prefix() {
    use mixdog_ai::providers::openai::{codec::OpenAiCodec, config::NoFacts, delta};
    use mixdog_core_api::domain::{keepalive::TransportKind, provider::ScopedCacheSource};
    use sha2::{Digest, Sha256};

    let codec = OpenAiCodec::new(
        OpenAiConfig::api_key(false, Arc::new(NoFacts), Arc::new(Ctx)),
        TransportKind::WebSocket,
    );
    let body = "src/first.rs:12: parsed configuration\nsrc/second.rs:35: resolved the workspace";
    let mut req = request("gpt-5", vec![
        text(Role::User, "Find configuration"),
        assistant_calls("", vec![call("call_source", "grep", json!({}))]),
        tool("call_source", body),
    ], vec![], None);
    let first = codec.ws_body(&req, None).0;
    let mut chain = delta::Chain::default();
    chain.anchor("resp_1", &first, &[json!({
        "type": "function_call", "call_id": "call_hit", "name": "grep", "arguments": "{}",
    })]);
    let mut hit = tool("call_hit", body);
    hit.scoped_cache_source = Some(ScopedCacheSource {
        call_id: "call_source".into(),
        body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
    });
    req.messages.push(assistant_calls("", vec![call("call_hit", "grep", json!({}))]));
    req.messages.push(hit);
    let second = codec.ws_body(&req, None).0;
    let frame = delta::compute(true, &chain, &second);
    assert_eq!(frame.mode, delta::Mode::Delta);
    assert_eq!(frame.frame["input"], json!([
        { "type": "function_call_output", "call_id": "call_hit", "output": body }
    ]));
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
        ("openai-oauth", OpenAiConfig::codex(false, identity, Arc::new(Facts), Arc::new(Ctx))),
    ]
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

/// The session's provider state holding `slot` under the route's key.
fn st(slot: Value) -> ProviderState {
    with_slot(None, &spec(), slot)
}

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

    let resumed = resume(&spec(), OWNER, Some(&st(slot)), "gpt-5.5", &history).unwrap();
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
    let resumed = resume(&spec(), OWNER, Some(&st(mine.clone())), "m", &history).unwrap();
    let req = request("m", history.clone(), vec![], None);
    let body = body_of(&gateway("opencode-go", false), &BuildInputs { continuation: Some(&resumed), ..BuildInputs::new(&req) });
    assert_eq!(body["input"].as_array().unwrap().len(), 2);
    assert_eq!(body["input"][1]["encrypted_content"], "ENC9");

    let foreign = resume(&spec(), "compat-responses:other", Some(&st(mine)), "m", &history).unwrap();
    assert!(foreign.reasoning_by_index.is_empty());
}

#[test]
fn a_slot_that_no_longer_fits_is_dropped_with_its_reason() {
    let history = vec![text(Role::User, "go"), text(Role::Assistant, "ok")];
    let base = json!({"previousResponseId": null, "store": false, "seenMessageCount": 1, "model": "a"});
    let r = |slot: Value, model: &str| resume(&spec(), OWNER, Some(&st(slot)), model, &history).unwrap().reset_reason;
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
    let resumed = resume(&spec(), OWNER, Some(&st(slot)), "m", &history).unwrap();
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
    let err = resume(&route, OWNER, Some(&st(stored)), "m", &history).unwrap_err();
    assert!(err.to_string().starts_with("openrouter Responses is stateless"));
    assert!(resume(&route, OWNER, Some(&st(json!({"store": true}))), "m", &history).is_err());
    assert!(resume(&route, OWNER, Some(&st(json!({"store": false, "seenMessageCount": 1}))), "m", &history).is_ok());
}

#[test]
fn the_slot_merges_into_provider_state_without_touching_other_slots() {
    let state: ProviderState =
        serde_json::from_value(json!({"other": {"keep": 1}, "compatResponses": {"old": true}})).unwrap();
    let merged = with_slot(Some(&state), &spec(), json!({"new": true}));
    assert_eq!(
        serde_json::to_value(&merged).unwrap(),
        json!({"other": {"keep": 1}, "compatResponses": {"new": true}})
    );
}

/// `response.completed` and `response.done` can arrive in one chunk; the first
/// terminal frame ends the turn and the buffered rest is ignored (as Node's
/// loop does), so the history gets one replay, one state and one completion.
#[test]
fn a_second_terminal_frame_in_the_same_chunk_is_ignored() {
    use mixdog_ai::providers::openai::decoder::Framing;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireDecoder;
    let profile = gateway("opencode-go", false);
    let req = request("m", vec![text(Role::User, "go")], vec![], None);
    let item = r#"{"type":"reasoning","id":"rs_1","encrypted_content":"E","summary":[]}"#;
    let response = format!(r#"{{"id":"resp_1","output":[{item}],"usage":{{"input_tokens":1,"output_tokens":2}}}}"#);
    let sse = format!(
        "data: {{\"type\":\"response.completed\",\"response\":{response}}}\n\ndata: {{\"type\":\"response.done\",\"response\":{response}}}\n\n"
    );
    let mut decoder = profile.decoder_for(&req, Framing::Sse, Arc::new(Ctx));
    let mut events = decoder.feed(sse.as_bytes()).unwrap();
    events.extend(decoder.finish().unwrap());
    let count = |f: fn(&StreamEvent) -> bool| events.iter().filter(|e| f(e)).count();
    assert_eq!(count(|e| matches!(e, StreamEvent::ReasoningReplay(_))), 1);
    assert_eq!(count(|e| matches!(e, StreamEvent::ProviderState(_))), 1);
    assert_eq!(count(|e| matches!(e, StreamEvent::Usage(_))), 1);
    assert_eq!(count(|e| matches!(e, StreamEvent::Completed { .. })), 1);
    assert!(decoder.terminal_seen());
}

/// Node `convertMessagesToResponsesInput` with an owned replay and a carried
/// history at the same message (probe: `scratch/openai-replay/prec.mjs`): an
/// owned replay with anything left to send replaces the message and the
/// history; history serves only a message with no owned replay.
#[test]
fn an_owned_replay_wins_over_carried_history_exactly_as_node_does() {
    let owner = "compat-responses:x";
    let reasoning = |id: &str, enc: &str| json!({"type": "reasoning", "id": id, "encrypted_content": enc, "summary": []});
    let message_item = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": "ok", "annotations": []}]});
    let user = |t: &str| json!({"role": "user", "content": [{"type": "input_text", "text": t}]});
    let assistant = json!({"role": "assistant", "content": [{"type": "output_text", "text": "ok"}]});
    let history = Continuation {
        reasoning_by_index: std::collections::BTreeMap::from([(1, vec![reasoning("rs_h", "ENC-H")])]),
        ..Continuation::default()
    };
    let input = |items: Option<Value>, replay_reasoning: bool| {
        let mut reply = text(Role::Assistant, "ok");
        if let Some(items) = items {
            reply.push_replay(ProviderReplay { owner: ProviderId::from(owner), items });
        }
        let req = request("m", vec![text(Role::User, "go"), reply, text(Role::User, "more")], vec![], None);
        let mut profile = gateway("x", false);
        profile.input.replay_reasoning = replay_reasoning;
        let body = body_of(&profile, &BuildInputs { continuation: Some(&history), ..BuildInputs::new(&req) });
        body["input"].clone()
    };
    let only = json!([reasoning("rs_1", "ENC-1")]);
    assert_eq!(input(Some(only.clone()), true), json!([user("go"), reasoning("rs_1", "ENC-1"), user("more")]));
    assert_eq!(
        input(Some(json!([reasoning("rs_1", "ENC-1"), message_item.clone()])), true),
        json!([user("go"), reasoning("rs_1", "ENC-1"), message_item, user("more")])
    );
    assert_eq!(input(None, true), json!([user("go"), reasoning("rs_h", "ENC-H"), assistant, user("more")]));
    // Reasoning replay off: nothing owned is left, so the history serves.
    assert_eq!(input(Some(only), false), json!([user("go"), reasoning("rs_h", "ENC-H"), assistant, user("more")]));
}

/// The same through the live compat route: the replay and the slot the decoder
/// emits for one response feed the next request, and reasoning goes out once.
#[test]
fn the_emitted_replay_and_slot_send_reasoning_once_on_the_next_turn() {
    use mixdog_ai::providers::compat::CompatConfig;
    use mixdog_ai::providers::compat::CompatProfile;
    use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireCodec;

    let profile = CompatProfile::opencode_go();
    let codec = CompatResponsesCodec::new(profile.clone(), CompatConfig::for_profile(&profile), TransportKind::Http1);
    let reasoning = json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC-1", "summary": []});
    let message_item = json!({"type": "message", "id": "msg_1", "role": "assistant", "status": "completed",
        "content": [{"type": "output_text", "text": "ok", "annotations": []}]});
    let user = |t: &str| json!({"role": "user", "content": [{"type": "input_text", "text": t}]});
    let assistant = json!({"role": "assistant", "content": [{"type": "output_text", "text": "ok"}]});

    // One response's emitted replay and state, then the next request built on both.
    let next_input = |output: Value, attach_replay: bool| {
        let first = request("gpt-5.5", vec![text(Role::User, "go")], vec![], None);
        let sse = format!(
            "data: {}\n\n",
            json!({"type": "response.completed", "response": {"id": "resp_1", "output": output}})
        );
        let events = codec.decoder(&first).feed(sse.as_bytes()).unwrap();
        let mut reply = text(Role::Assistant, "ok");
        let mut state = None;
        for event in events {
            match event {
                StreamEvent::ReasoningReplay(replay) if attach_replay => reply.push_replay(replay),
                StreamEvent::ProviderState(s) => state = Some(s),
                _ => {}
            }
        }
        let mut next = request("gpt-5.5", vec![text(Role::User, "go"), reply, text(Role::User, "more")], vec![], None);
        next.options.provider_state = state;
        let wire = codec.encode(&next).unwrap();
        serde_json::from_slice::<Value>(&wire.body).unwrap()["input"].clone()
    };
    assert_eq!(
        next_input(json!([reasoning.clone()]), true),
        json!([user("go"), reasoning.clone(), user("more")]),
        "a reasoning-only replay goes out once"
    );
    assert_eq!(
        next_input(json!([reasoning.clone(), message_item.clone()]), true),
        json!([user("go"), reasoning.clone(), message_item, user("more")])
    );
    assert_eq!(
        next_input(json!([reasoning.clone()]), false),
        json!([user("go"), reasoning, assistant, user("more")]),
        "history alone"
    );
}

/// One mechanism end to end: the request's `ProviderState` in, the decoder's
/// `StreamEvent::ProviderState` out, other slots untouched, and the next
/// request resumes from what the event carried.
#[test]
fn the_decoder_reports_the_slot_through_provider_state_and_the_next_request_resumes_it() {
    use mixdog_ai::providers::openai::decoder::Framing;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireDecoder;
    let profile = gateway("opencode-go", false);
    let prior: ProviderState = serde_json::from_value(json!({"gemini": null, "other": {"keep": 1}})).unwrap();
    let mut req = request("m", vec![text(Role::User, "go")], vec![], None);
    req.options.provider_state = Some(prior);
    let mut decoder = profile.decoder_for(&req, Framing::Sse, Arc::new(Ctx));
    let item = r#"{"type":"reasoning","id":"rs_1","encrypted_content":"E","summary":[]}"#;
    let sse = format!(
        "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_1\",\"output\":[{item}]}}}}\n\n"
    );
    let events = decoder.feed(sse.as_bytes()).unwrap();
    let states: Vec<_> = events.iter().filter_map(|e| if let StreamEvent::ProviderState(s) = e { Some(s) } else { None }).collect();
    assert_eq!(states.len(), 1);
    let state = states[0];
    assert_eq!(state.rest["other"], json!({"keep": 1}));
    assert_eq!(state.rest["compatResponses"]["responseId"], "resp_1");
    assert_eq!(state.rest["compatResponses"]["seenMessageCount"], 1);

    let mut next = request("m", vec![text(Role::User, "go"), text(Role::Assistant, "ok"), text(Role::User, "more")], vec![], None);
    next.options.provider_state = Some(state.clone());
    let resumed = profile.resume(&next).unwrap();
    assert_eq!(resumed.reasoning_by_index[&1][0]["encrypted_content"], "E");
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

data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}

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

#[test]
fn frames_buffered_behind_a_terminal_frame_finish_the_turn_once() {
    use mixdog_ai::providers::openai::decoder::Framing;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireDecoder;
    let item = r#"{"type":"reasoning","id":"rs_1","encrypted_content":"E","summary":[]}"#;
    let chunk = format!(
        "data: {{\"type\":\"response.output_item.done\",\"item\":{item}}}\n\n\
         data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"r\",\"output\":[{item}]}}}}\n\n\
         data: {{\"type\":\"response.done\",\"response\":{{\"id\":\"r\",\"status\":\"completed\",\"output\":[{item}]}}}}\n\n"
    );
    let mut decoder = gateway("opencode-go", false).decoder(Framing::Sse, Arc::new(Ctx));
    let mut events = decoder.feed(chunk.as_bytes()).unwrap();
    events.extend(decoder.finish().unwrap());
    let count = |f: fn(&StreamEvent) -> bool| events.iter().filter(|e| f(e)).count();
    assert_eq!(count(|e| matches!(e, StreamEvent::ReasoningReplay(_))), 1);
    assert_eq!(count(|e| matches!(e, StreamEvent::Completed { .. })), 1);
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

/// The live compat route: the codec's decoder reads the request, reports the
/// updated `compatResponses` slot as `StreamEvent::ProviderState`, and the next
/// request's `encode` resumes the encrypted reasoning from it. The first-party
/// routes report no slot (Node keeps none; the ordered replay carries history).
#[test]
fn live_routes_flow_provider_state_through_the_request_aware_decoder() {
    use mixdog_ai::providers::compat::CompatConfig;
    use mixdog_ai::providers::compat::CompatProfile;
    use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireCodec;

    let profile = CompatProfile::opencode_go();
    let codec = CompatResponsesCodec::new(profile.clone(), CompatConfig::for_profile(&profile), TransportKind::Http1);
    let item = r#"{"type":"reasoning","id":"rs_1","encrypted_content":"E","summary":[]}"#;
    let sse = format!(
        "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_1\",\"output\":[{item}]}}}}\n\n"
    );
    let first = request("gpt-5.5", vec![text(Role::User, "go")], vec![], None);
    let mut decoder = codec.decoder(&first);
    let events = decoder.feed(sse.as_bytes()).unwrap();
    let state = events
        .into_iter()
        .find_map(|e| if let StreamEvent::ProviderState(s) = e { Some(s) } else { None })
        .expect("the compat route reports its slot");
    assert_eq!(state.rest["compatResponses"]["responseId"], "resp_1");

    let mut next = request(
        "gpt-5.5",
        vec![text(Role::User, "go"), text(Role::Assistant, "ok"), text(Role::User, "more")],
        vec![],
        None,
    );
    next.options.provider_state = Some(state);
    let wire = codec.encode(&next).unwrap();
    let body: Value = serde_json::from_slice(&wire.body).unwrap();
    let kinds: Vec<_> = body["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["type"].as_str().or(i["role"].as_str()).unwrap().to_owned())
        .collect();
    assert_eq!(kinds, ["user", "reasoning", "assistant", "user"]);

    let (_, config) = first_party_configs().into_iter().next().unwrap();
    let openai = mixdog_ai::providers::openai::codec::OpenAiCodec::new(config, TransportKind::Http1);
    let mut decoder = openai.decoder(&first);
    let events = decoder.feed(sse.as_bytes()).unwrap();
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::ProviderState(_))));
}


/// Migration's legacy-`reasoningItems` envelopes: the `items` of a migrated
/// message's ProviderReplay must pass through the first-party request builder
/// unchanged, in order and with their JSON field order (the outputs it
/// synthesizes for the unanswered calls aside), for the public and Codex routes.
/// The five cases are tracked inline, with keys deliberately not alphabetical.
#[test]
fn migrated_legacy_reasoning_envelopes_are_sent_unchanged_and_in_order() {
    let reasoning = r#"{"type":"reasoning","id":"rs_before","encrypted_content":"ENC_BEFORE","summary":[{"type":"summary_text","text":"plan"}]},{"type":"reasoning","encrypted_content":"ENC_NO_ID","summary":[]}"#;
    let after = r#"{"type":"reasoning","id":"rs_after","encrypted_content":"ENC_AFTER","summary":[]}"#;
    let calls = r#"{"type":"function_call","call_id":"call_one","name":"list","arguments":"{\"path\":\"a\",\"meta\":true,\"limit\":0}"},{"type":"function_call","call_id":"call_two","name":"list","arguments":"{\"path\":\"b\",\"limit\":0}"}"#;
    let cases: Vec<(&str, bool, String)> = vec![
        (
            "text and tool calls on the codex route",
            false,
            format!(
                r#"[{reasoning},{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"Checking the folders first."}}],"internal_chat_message_metadata_passthrough":{{}}}},{after},{calls}]"#
            ),
        ),
        (
            "text and tool calls on the public route",
            true,
            format!(
                r#"[{reasoning},{{"role":"assistant","content":[{{"type":"output_text","text":"Checking the folders first."}}]}},{after},{calls}]"#
            ),
        ),
        (
            "tool call without text",
            false,
            format!(
                r#"[{reasoning},{after},{{"type":"function_call","call_id":"call_sh","name":"shell","arguments":"{{\"timeout_ms\":20000,\"command\":\"echo hi\"}}"}}]"#
            ),
        ),
        (
            "text only",
            false,
            format!(
                r#"[{reasoning},{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"Status: done\n\nNothing else to run."}}],"internal_chat_message_metadata_passthrough":{{}}}}]"#
            ),
        ),
        (
            "native search, custom and namespaced calls with a phase",
            false,
            format!(
                r#"[{reasoning},{{"type":"message","role":"assistant","content":[{{"type":"output_text","text":"Loading the tools first."}}],"phase":"commentary","internal_chat_message_metadata_passthrough":{{}}}},{after},{{"type":"tool_search_call","call_id":"call_search","execution":"client","arguments":{{"names":["shell"]}}}},{{"type":"custom_tool_call","call_id":"call_patch","name":"apply_patch","input":"*** Begin Patch"}}]"#
            ),
        ),
    ];
    assert_eq!(cases.len(), 5);
    let mut configs = first_party_configs().into_iter();
    let (public, codex) = (configs.next().unwrap().1, configs.next().unwrap().1);
    for (name, is_public, items) in cases {
        let case = serde_json::json!({ "name": name, "items": serde_json::from_str::<Value>(&items).unwrap() });
        let config = if is_public { &public } else { &codex };
        let mut reply = text(Role::Assistant, "");
        reply.push_replay(ProviderReplay { owner: ProviderId::from("openai-responses"), items: case["items"].clone() });
        let req = request("gpt-5.5", vec![text(Role::User, "go"), reply, text(Role::User, "next")], vec![], None);
        let sent = build(config, &req).map["input"].as_array().unwrap().clone();
        let sent: Vec<&Value> = sent.iter().filter(|i| !i["type"].as_str().unwrap_or("").ends_with("_output")).collect();
        let items = case["items"].as_array().unwrap();
        assert_eq!(sent.len(), items.len() + 2, "{name}");
        for (sent, expected) in sent[1..sent.len() - 1].iter().zip(items) {
            assert_eq!(serde_json::to_string(sent).unwrap(), serde_json::to_string(expected).unwrap(), "{name}");
        }
    }
}
/// A two-step tool turn: each step's decoded envelope holds every output item of the response, reasoning verbatim, and the next
/// request replays the reasoning of both steps verbatim and in place around the call and its result.
#[test]
fn a_multi_step_reasoning_turn_replays_each_steps_reasoning_in_place() {
    use mixdog_ai::providers::openai::decoder::Framing;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::WireDecoder;
    let reasoning_1 = r#"{"type":"reasoning","id":"rs_1","encrypted_content":"ENC_ONE","summary":[{"type":"summary_text","text":"plan"}]}"#;
    let call = r#"{"type":"function_call","id":"fc_1","call_id":"call_a","name":"list","arguments":"{\"path\":\"a\"}"}"#;
    let reasoning_2 = r#"{"type":"reasoning","id":"rs_2","encrypted_content":"ENC_TWO","summary":[]}"#;
    let steps: [(&str, &[&str]); 2] = [("resp_1", &[reasoning_1, call]), ("resp_2", &[reasoning_2])];
    let profile = gateway("opencode-go", false);
    let mut history = vec![text(Role::User, "go")];
    let mut envelopes = Vec::new();
    for (response, items) in steps {
        let mut sse = String::new();
        for item in items {
            sse.push_str(&format!("data: {{\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{item}}}\n\n"));
        }
        sse.push_str(&format!(
            "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"{response}\",\"status\":\"completed\",\"output\":[{}]}}}}\n\n",
            items.join(",")
        ));
        let mut decoder = profile.decoder(Framing::Sse, Arc::new(Ctx));
        let mut events = Vec::new();
        // Odd chunking exercises framing across unit boundaries.
        for chunk in sse.as_bytes().chunks(13) {
            events.extend(decoder.feed(chunk).unwrap());
        }
        events.extend(decoder.finish().unwrap());
        let mut calls = Vec::new();
        let mut replay = Vec::new();
        for event in events {
            match event {
                StreamEvent::ToolCallDone(c) => calls.push(c),
                StreamEvent::ReasoningReplay(r) => replay.push(r),
                _ => {}
            }
        }
        assert_eq!(replay.len(), 1, "one ordered envelope per response");
        assert_eq!(replay[0].owner, ProviderId::from(OWNER));
        let want: Value = serde_json::from_str(&format!("[{}]", items.join(","))).unwrap();
        assert_eq!(replay[0].items, want, "every output item, reasoning verbatim");
        envelopes.push(replay[0].items.clone());
        let ids: Vec<String> = calls.iter().map(|c| c.id.clone()).collect();
        let mut assistant = assistant_calls("", calls);
        assistant.push_replay(replay.remove(0));
        history.push(assistant);
        for id in ids {
            history.push(tool(&id, "listed"));
        }
    }
    let req = request("m", history, vec![], None);
    let body = body_of(&profile, &BuildInputs::new(&req));
    let input = body["input"].as_array().unwrap();
    let at = |wanted: &dyn Fn(&Value) -> bool| input.iter().position(wanted).unwrap_or_else(|| panic!("no such item in {input:?}"));
    let reasoning_at = |id: &str| at(&|item| item["type"] == "reasoning" && item["id"] == id);
    let (first, call_at, output_at, second) = (
        reasoning_at("rs_1"),
        at(&|item| item["type"] == "function_call" && item["call_id"] == "call_a"),
        at(&|item| item["type"] == "function_call_output" && item["call_id"] == "call_a"),
        reasoning_at("rs_2"),
    );
    assert!(first < call_at && call_at < output_at && output_at < second, "{first} {call_at} {output_at} {second}");
    let sent: Vec<String> = input.iter().filter(|item| item["type"] == "reasoning").map(|item| item.to_string()).collect();
    let want: Vec<String> = [reasoning_1, reasoning_2].iter().map(|item| serde_json::from_str::<Value>(item).unwrap().to_string()).collect();
    assert_eq!(sent, want, "the reasoning of both steps is sent verbatim, with its field order");
}


// ---- the whole request head of each route, with small tracked inputs ---------------------------------------------
//
// Node 1.4.5 `openai-compat-responses` / `openai-oauth` / xAI heads: the key order is part of the contract (the prompt
// cache is a byte prefix), so the bodies are compared as text. The expected bodies are written out here from Node's
// recorded heads (first-party/openai, first-party/openai-oauth, compat/<gateway>, compat/custom-cmd and the xAI
// http/ws heads), over a four-message history of this test.

fn head_history() -> Vec<Message> {
    vec![
        text(Role::User, "find it"),
        assistant_calls("looking", vec![call("c1", "Read", json!({"path": "a.txt"}))]),
        tool("c1", "file text"),
        text(Role::User, "next"),
    ]
}

/// The lowered history of the public API and every gateway: plain role messages.
fn plain_input() -> Value {
    json!([
        {"role": "user", "content": [{"type": "input_text", "text": "find it"}]},
        {"role": "assistant", "content": [{"type": "output_text", "text": "looking"}]},
        {"type": "function_call", "call_id": "c1", "name": "Read", "arguments": "{\"path\":\"a.txt\"}"},
        {"type": "function_call_output", "call_id": "c1", "output": "file text"},
        {"role": "user", "content": [{"type": "input_text", "text": "next"}]}
    ])
}

/// The Codex route's messages are typed and carry the metadata passthrough.
fn codex_input() -> Value {
    json!([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "find it"}], "internal_chat_message_metadata_passthrough": {}},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "looking"}], "internal_chat_message_metadata_passthrough": {}},
        {"type": "function_call", "call_id": "c1", "name": "Read", "arguments": "{\"path\":\"a.txt\"}"},
        {"type": "function_call_output", "call_id": "c1", "output": "file text"},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "next"}], "internal_chat_message_metadata_passthrough": {}}
    ])
}

fn text_of(body: &Map<String, Value>) -> String {
    serde_json::to_string(body).unwrap()
}

#[test]
fn the_first_party_head_of_the_public_api_and_of_the_codex_route_is_nodes_whole_request() {
    let [(_, public), (_, codex)] = first_party_configs();
    let mut req = request("gpt-5.5", head_history(), vec![], None);
    req.options.session_id = Some("sess-1".into());
    let sent = build(&public, &req).map;
    // The public API's cache key is derived from the prefix: `mixdog-openai-` and eighteen hex digits.
    let key = sent["prompt_cache_key"].as_str().unwrap().to_owned();
    let digits = key.strip_prefix("mixdog-openai-").expect("the derived key's prefix");
    assert!(digits.len() == 18 && digits.chars().all(|c| c.is_ascii_hexdigit()), "{key}");
    let want = json!({
        "model": "gpt-5.5", "instructions": "You are a helpful assistant.", "input": plain_input(), "tool_choice": "auto",
        "parallel_tool_calls": true, "reasoning": {"effort": "medium", "summary": "auto"}, "store": false, "stream": true,
        "include": ["reasoning.encrypted_content"], "prompt_cache_key": key, "text": {"verbosity": "low"}
    });
    assert_eq!(text_of(&sent), want.to_string(), "public API");

    // The Codex route sends the session's own cache namespace and the reasoning-summary delivery option.
    let mut req = request("gpt-5.5", head_history(), vec![], Some("sess-1"));
    req.options.session_id = Some("sess-1".into());
    let want = json!({
        "model": "gpt-5.5", "instructions": "You are a helpful assistant.", "input": codex_input(), "tool_choice": "auto",
        "parallel_tool_calls": true, "reasoning": {"effort": "medium", "summary": "auto"}, "store": false, "stream": true,
        "stream_options": {"reasoning_summary_delivery": "sequential_cutoff"}, "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": "sess-1", "text": {"verbosity": "low"}
    });
    assert_eq!(text_of(&build(&codex, &req).map), want.to_string(), "Codex route");
}

#[test]
fn a_gateway_head_has_no_instructions_and_sends_a_cache_key_only_where_its_profile_does() {
    for (name, model) in [("opencode-go", "gpt-5.5"), ("muse-code", "muse-spark"), ("command-code", "gpt-5.5"), ("xai", "grok-4")] {
        let req = request(model, head_history(), vec![], Some("sess-1"));
        let want = json!({"model": model, "input": plain_input(), "store": false, "include": ["reasoning.encrypted_content"], "stream": true});
        assert_eq!(text_of(&body_of(&gateway(name, false), &BuildInputs::new(&req))), want.to_string(), "{name}");
    }
    // A custom route whose profile sends the cache key puts it last.
    let req = request("openai/gpt-5.6-sol", head_history(), vec![], Some("sess-1"));
    let want = json!({
        "model": "openai/gpt-5.6-sol", "input": plain_input(), "store": false, "include": ["reasoning.encrypted_content"],
        "stream": true, "prompt_cache_key": "sess-1"
    });
    assert_eq!(text_of(&body_of(&gateway("custom-cmd", true), &BuildInputs::new(&req))), want.to_string());
}

#[test]
fn the_xai_http_and_websocket_heads_differ_only_in_the_stream_flag_and_carry_the_tools_after_the_cache_key() {
    let key = "f0858c98-2db1-4764-9d18-e6e1ec2ea4c7";
    let req = request("grok-4", head_history(), session_tools(), Some(key));
    let tools = json!([
        {"type": "function", "name": "Read", "description": "Read a file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}, "strict": false},
        {"type": "function", "name": "load_tool", "description": "Load tools", "parameters": {"type": "object", "properties": {"names": {"type": "array"}}}, "strict": false}
    ]);
    let head = json!({
        "model": "grok-4", "input": plain_input(), "store": false, "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": key, "tools": tools, "parallel_tool_calls": true, "stream": true
    });
    assert_eq!(text_of(&body_of(&xai_http(), &BuildInputs::new(&req))), head.to_string(), "http");
    let mut ws = xai_http();
    ws.stream = false;
    ws.system = SystemPlacement::Instructions { fallback: None, environment_message: false };
    ws.input.system_in_input = false;
    let mut over_ws = head;
    over_ws.as_object_mut().unwrap().shift_remove("stream");
    assert_eq!(text_of(&body_of(&ws, &BuildInputs::new(&req))), over_ws.to_string(), "websocket");
}
