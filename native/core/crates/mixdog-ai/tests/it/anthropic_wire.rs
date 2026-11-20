//! The Anthropic Messages request: tool schema lowering, native web search, tool-search references, the shared
//! cache prefix and where the cache breakpoints sit, reasoning/effort fields, server-side fallback and images.
//! Every test builds a small request and reads the body the codec puts on the wire.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::CacheStrategy;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_ai::providers::anthropic::ModelCaps;
use mixdog_ai::providers::anthropic::anthropic_tool_exclusion;
use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::EffortProjection;
use mixdog_core_api::domain::provider::HostedTool;
use mixdog_core_api::domain::provider::HostedWebSearch;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::domain::provider::UserLocation;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

fn caps_for(caps: Option<ModelCaps>) -> AnthropicConfig {
    AnthropicConfig::new(Arc::new(move |_: &str| caps.clone()))
}

fn codec(flavor: Flavor, caps: Option<ModelCaps>) -> AnthropicCodec {
    AnthropicCodec::new(flavor, caps_for(caps))
}

fn adaptive(levels: &[&str]) -> ModelCaps {
    ModelCaps {
        adaptive_thinking: true,
        manual_thinking: false,
        effort_levels: levels.iter().map(|l| (*l).to_owned()).collect(),
        max_output_tokens: Some(16384),
        ..ModelCaps::default()
    }
}

fn manual(max_tokens: u32) -> ModelCaps {
    ModelCaps { manual_thinking: true, max_output_tokens: Some(max_tokens), ..ModelCaps::default() }
}

fn tool(name: &str, schema: Value) -> ToolDefinition {
    ToolDefinition { name: name.into(), description: format!("{name} tool"), input_schema: schema, defer_loading: false, freeform: None }
}

fn text(role: Role, body: &str) -> Message {
    Message::new(role, Content::Text(body.into()))
}

fn request(model: &str, messages: Vec<Message>, tools: Vec<ToolDefinition>, options: RequestOptions) -> ModelRequest {
    ModelRequest { model: model.into(), messages, tools, options }
}

fn wire(codec: &AnthropicCodec, request: &ModelRequest) -> WireRequest {
    codec.encode(request).expect("the request encodes")
}

fn body_of(wire: &WireRequest) -> Value {
    serde_json::from_slice(&wire.body).expect("the body is JSON")
}

fn body(codec: &AnthropicCodec, request: &ModelRequest) -> Value {
    body_of(&wire(codec, request))
}

fn beta(wire: &WireRequest) -> String {
    wire.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("anthropic-beta")).map(|(_, v)| v.clone()).unwrap_or_default()
}

fn api() -> AnthropicCodec {
    codec(Flavor::ApiKey, None)
}

fn one_tool_body(schema: Value) -> Value {
    body(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], vec![tool("t", schema)], RequestOptions::default()))["tools"][0]["input_schema"]
        .clone()
}

// ---------------------------------------------------------------------------
// Tool schema lowering
// ---------------------------------------------------------------------------

#[test]
fn alternatives_at_the_top_of_a_tool_schema_are_merged_into_one_object() {
    let schema = one_tool_body(json!({
        "type": "object",
        "description": "Pick one",
        "oneOf": [
            { "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] },
            { "type": "object", "properties": { "b": { "type": "number" } }, "required": ["b"] },
        ],
    }));
    // The wire refuses a root combinator: both branches' fields stay, nothing is required (either branch may be
    // the one sent), and each variant is named in the description.
    assert_eq!(
        schema,
        json!({
            "type": "object",
            "description": "Pick one (variant 1: type:object) (variant 2: type:object)",
            "properties": { "a": { "type": "string" }, "b": { "type": "number" } },
        })
    );
}

#[test]
fn an_intersection_at_the_top_keeps_every_requirement_and_both_constraints_of_a_shared_field() {
    let schema = one_tool_body(json!({
        "type": "object",
        "allOf": [
            { "properties": { "a": { "type": "string" } }, "required": ["a"] },
            { "properties": { "a": { "maxLength": 3 }, "b": { "type": "number" } }, "required": ["b"] },
        ],
    }));
    assert_eq!(
        schema,
        json!({
            "type": "object",
            "properties": { "a": { "allOf": [{ "type": "string" }, { "maxLength": 3 }] }, "b": { "type": "number" } },
            "required": ["a", "b"],
        })
    );
}

#[test]
fn a_schema_that_is_not_an_object_is_sent_as_an_empty_object_schema() {
    assert_eq!(one_tool_body(Value::Null), json!({ "type": "object", "properties": {} }));
}

#[test]
fn a_valid_object_schema_goes_out_as_written() {
    let schema = json!({ "type": "object", "properties": { "z": { "type": "string" }, "a": { "type": "integer" } }, "required": ["z"] });
    // Key order is the wire order: a cached prefix is a byte prefix.
    assert_eq!(one_tool_body(schema.clone()).to_string(), schema.to_string());
}

#[test]
fn a_tool_whose_schema_stays_invalid_is_left_out_and_reported_while_the_others_go() {
    let broken = tool("broken", json!({ "type": "object", "properties": { "a": { "type": "strng" } } }));
    let fine = tool("fine", json!({ "type": "object", "properties": {} }));
    let reports = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&reports);
    let options = RequestOptions {
        on_tool_excluded: Some(ToolExclusionSink(Arc::new(move |report| sink.lock().unwrap().push((report.name, report.index))))),
        ..RequestOptions::default()
    };
    let sent = body(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], vec![broken.clone(), fine.clone()], options));
    let names: Vec<&str> = sent["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["fine"]);
    assert_eq!(*reports.lock().unwrap(), vec![("broken".to_owned(), 0)]);
    assert!(anthropic_tool_exclusion(&broken, "anthropic").is_some());
    assert!(anthropic_tool_exclusion(&fine, "anthropic").is_none());
}

#[test]
fn a_deferred_tool_is_marked_and_names_the_tool_search_beta() {
    let mut deferred = tool("later", json!({ "type": "object", "properties": {} }));
    deferred.defer_loading = true;
    let eager = tool("now", json!({ "type": "object", "properties": {} }));
    let with = wire(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], vec![deferred, eager.clone()], RequestOptions::default()));
    let tools = body_of(&with)["tools"].clone();
    assert_eq!(tools[0]["defer_loading"], true);
    assert!(tools[1].get("defer_loading").is_none());
    assert!(beta(&with).contains("advanced-tool-use-2025-11-20"), "{}", beta(&with));
    let without = wire(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], vec![eager], RequestOptions::default()));
    assert!(!beta(&without).contains("advanced-tool-use"));
}

// ---------------------------------------------------------------------------
// Native web search and tool-search references
// ---------------------------------------------------------------------------

fn search(max_uses: Option<u32>, domains: &[&str], location: Option<UserLocation>) -> HostedTool {
    HostedTool::WebSearch(HostedWebSearch {
        tool_type: "web_search".into(),
        allowed_domains: domains.iter().map(|d| (*d).to_owned()).collect(),
        user_location: location,
        max_uses,
        context_size: None,
        include_sources: false,
    })
}

#[test]
fn native_web_search_is_declared_ahead_of_the_function_tools() {
    let location = UserLocation { country: Some("KR".into()), city: Some("Seoul".into()), ..UserLocation::default() };
    let options = RequestOptions { hosted_tools: vec![search(Some(3), &["example.com", "docs.rs"], Some(location))], ..RequestOptions::default() };
    let sent =
        body(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], vec![tool("lookup", json!({ "type": "object", "properties": {} }))], options));
    let tools = sent["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 2);
    assert_eq!(
        tools[0],
        json!({
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": 3,
            "allowed_domains": ["example.com", "docs.rs"],
            "user_location": { "type": "approximate", "country": "KR", "city": "Seoul" },
        })
    );
    assert_eq!(tools[1]["name"], "lookup");
}

#[test]
fn native_web_search_without_options_carries_only_its_type_and_name() {
    let options = RequestOptions { hosted_tools: vec![search(None, &[], None)], ..RequestOptions::default() };
    let sent = body(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], Vec::new(), options));
    assert_eq!(sent["tools"], json!([{ "type": "web_search_20250305", "name": "web_search" }]));
}

fn tool_exchange(native: Value, result_text: &str) -> Vec<Message> {
    let mut assistant = text(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall { id: "call_1".into(), name: "Skill".into(), arguments: json!({}), native_type: None });
    let mut result = text(Role::Tool, result_text);
    result.tool_call_id = Some("call_1".into());
    result.native_tool_search = Some(native);
    vec![text(Role::User, "go"), assistant, result]
}

fn lowered_result(native: Value, available: &[&str]) -> Value {
    let tools = available.iter().map(|n| tool(n, json!({ "type": "object", "properties": {} }))).collect();
    let sent = body(&api(), &request("claude-sonnet-4-6", tool_exchange(native, "loaded"), tools, RequestOptions::default()));
    sent["messages"][2]["content"][0]["content"].clone()
}

#[test]
fn a_tool_search_result_becomes_a_reference_for_each_loaded_tool_the_request_offers() {
    let content = lowered_result(json!({ "provider": "anthropic", "toolReferences": ["read", "gone", " write "] }), &["read", "write"]);
    assert_eq!(content, json!([{ "type": "tool_reference", "tool_name": "read" }, { "type": "tool_reference", "tool_name": "write" }]));
}

#[test]
fn a_tool_search_result_with_no_offered_tool_keeps_its_text_and_names_what_dropped() {
    let kept = lowered_result(json!({ "provider": "anthropic", "toolReferences": ["gone"] }), &["read"]);
    assert_eq!(kept, "loaded");
    let mut blank = tool_exchange(json!({ "provider": "anthropic", "toolReferences": ["gone", "also"] }), "  ");
    blank[2].content = Content::Text(String::new());
    let sent = body(&api(), &request("claude-sonnet-4-6", blank, vec![tool("read", json!({ "type": "object", "properties": {} }))], RequestOptions::default()));
    assert_eq!(
        sent["messages"][2]["content"][0]["content"],
        json!([{ "type": "text", "text": "[tool references dropped - no longer available: gone, also]" }])
    );
}

#[test]
fn a_tool_search_result_of_another_provider_is_plain_text() {
    let content = lowered_result(json!({ "provider": "openai", "toolReferences": ["read"] }), &["read"]);
    assert_eq!(content, "loaded");
}

// ---------------------------------------------------------------------------
// Cache breakpoints and the shared prefix
// ---------------------------------------------------------------------------

fn marked(message: &Value) -> bool {
    message["content"].as_array().is_some_and(|blocks| blocks.iter().any(|b| b.get("cache_control").is_some()))
}

fn conversation(turns: &[&str]) -> Vec<Message> {
    let mut messages = vec![text(Role::System, "S")];
    for (i, turn) in turns.iter().enumerate() {
        messages.push(text(if i % 2 == 0 { Role::User } else { Role::Assistant }, turn));
    }
    messages
}

fn messages_of(codec: &AnthropicCodec, messages: Vec<Message>, options: RequestOptions) -> Vec<Value> {
    body(codec, &request("claude-sonnet-4-6", messages, Vec::new(), options))["messages"].as_array().unwrap().clone()
}

#[test]
fn the_message_breakpoint_sits_on_the_last_message_and_moves_with_each_turn() {
    let first = messages_of(&api(), conversation(&["q1"]), RequestOptions::default());
    let second = messages_of(&api(), conversation(&["q1", "a1", "q2"]), RequestOptions::default());
    assert_eq!(first[0]["content"][0]["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(second.iter().map(marked).collect::<Vec<_>>(), [false, false, true]);
    // The marker left the first message: its text is what the cache holds, and nothing else of it changed.
    assert_eq!(first[0]["content"][0]["text"], "q1");
    assert_eq!(second[0]["content"], "q1");
    assert_eq!(first[0]["role"], second[0]["role"]);
    assert!(!marked(&second[0]));
}

#[test]
fn a_fork_keeps_the_saved_requests_breakpoint_and_writes_none_for_its_suffix() {
    let turns = ["q1", "a1", "q2", "a2", "suffix"];
    let saved = messages_of(&api(), conversation(&turns[..2]), RequestOptions::default());
    let options = RequestOptions { shared_cache_prefix_count: Some(3), ..RequestOptions::default() };
    let fork = messages_of(&api(), conversation(&turns), options);
    // The count includes the system message: [S, q1, a1] is shared, so the marker is a1's.
    assert_eq!(fork.len(), 5);
    assert_eq!(fork[..2], saved[..]);
    assert_eq!(fork.iter().map(marked).collect::<Vec<_>>(), [false, true, false, false, false]);
    let longer = RequestOptions { shared_cache_prefix_count: Some(5), ..RequestOptions::default() };
    let fork = messages_of(&api(), conversation(&turns), longer);
    assert_eq!(fork.iter().map(marked).collect::<Vec<_>>(), [false, false, false, true, false]);
}

#[test]
fn a_fork_whose_prefix_is_not_in_the_request_marks_nothing() {
    let options = RequestOptions { shared_cache_prefix_count: Some(9), ..RequestOptions::default() };
    let fork = messages_of(&api(), conversation(&["q1", "a1", "q2"]), options);
    assert!(fork.iter().all(|m| !marked(m)));
}

#[test]
fn the_breakpoints_are_capped_at_four_and_the_system_layer_comes_first() {
    let system = |n: usize| (0..n).map(|i| text(Role::System, &format!("rule {i}"))).collect::<Vec<_>>();
    let ask = |n: usize| {
        let mut messages = system(n);
        messages.push(text(Role::User, "q"));
        body(&api(), &request("claude-sonnet-4-6", messages, Vec::new(), RequestOptions::default()))
    };
    let three = ask(3);
    assert_eq!(three["system"].as_array().unwrap().iter().filter(|b| b.get("cache_control").is_some()).count(), 3);
    assert!(marked(&three["messages"][0]), "one breakpoint is left for the messages");
    let four = ask(4);
    assert_eq!(four["system"].as_array().unwrap().iter().filter(|b| b.get("cache_control").is_some()).count(), 4);
    assert!(!marked(&four["messages"][0]), "the system layer took all four");
}

#[test]
fn a_longer_lifetime_never_follows_a_shorter_one_and_a_layer_can_be_switched_off() {
    let with = |strategy: Value| {
        let options = RequestOptions { model_parameters: Some(json!({ "cacheStrategy": strategy })), ..RequestOptions::default() };
        let mut messages = conversation(&["q"]);
        let mut tier3 = text(Role::System, "session");
        tier3.cache_tier = Some(CacheTier::Tier3);
        messages.insert(1, tier3);
        body(&api(), &request("claude-sonnet-4-6", messages, Vec::new(), options))
    };
    // System at 5 minutes: the 1-hour tier3 and message layers after it are lowered to 5 minutes.
    let ordered = with(json!({ "system": "5m", "tier3": "1h", "messages": "1h" }));
    let ttl = |v: &Value| v["cache_control"].clone();
    assert_eq!(ttl(&ordered["system"][0]), json!({ "type": "ephemeral" }));
    assert_eq!(ttl(&ordered["system"][1]), json!({ "type": "ephemeral" }));
    assert_eq!(ordered["messages"][0]["content"][0]["cache_control"], json!({ "type": "ephemeral" }));
    let hour = with(json!({ "system": "1h", "tier3": "1h", "messages": "1h" }));
    assert_eq!(ttl(&hour["system"][0]), json!({ "type": "ephemeral", "ttl": "1h" }));
    assert_eq!(hour["messages"][0]["content"][0]["cache_control"], json!({ "type": "ephemeral", "ttl": "1h" }));
    let off = with(json!({ "system": "none", "messages": "none" }));
    assert!(off["system"][0].get("cache_control").is_none());
    assert!(!marked(&off["messages"][0]));
    assert_eq!(ttl(&off["system"][1]), json!({ "type": "ephemeral", "ttl": "1h" }), "an unnamed layer keeps its default");
}

#[test]
fn a_thinking_block_is_never_the_one_that_carries_the_breakpoint() {
    let mut assistant = text(Role::Assistant, "answer");
    assistant.tool_calls.push(ToolCall { id: "call_1".into(), name: "lookup".into(), arguments: json!({}), native_type: None });
    let mut result = text(Role::Tool, "42");
    result.tool_call_id = Some("call_1".into());
    let messages = body(
        &api(),
        &request(
            "claude-sonnet-4-6",
            vec![text(Role::User, "q"), assistant, result],
            vec![tool("lookup", json!({ "type": "object", "properties": {} }))],
            RequestOptions::default(),
        ),
    )["messages"]
        .clone();
    // The tail is the tool result, a block that can carry the marker.
    assert_eq!(messages[2]["content"][0]["type"], "tool_result");
    assert!(messages[2]["content"][0].get("cache_control").is_some());
    assert!(!marked(&messages[1]));
}

fn reminder(body: &str) -> Message {
    let mut message = text(Role::User, body);
    message.source = Some(MessageSource::TailReminder);
    message
}

#[test]
fn a_tail_reminder_is_a_block_after_the_breakpoint_on_a_model_without_turn_scoped_messages() {
    let sent = wire(&api(), &request("claude-sonnet-4-6", vec![text(Role::User, "q"), reminder("R")], Vec::new(), RequestOptions::default()));
    let messages = body_of(&sent)["messages"].clone();
    assert_eq!(messages.as_array().unwrap().len(), 1);
    assert_eq!(messages[0]["content"], json!([{ "type": "text", "text": "q", "cache_control": { "type": "ephemeral" } }, { "type": "text", "text": "R" }]));
    assert!(!beta(&sent).contains("clear-at"));
}

#[test]
fn a_tail_reminder_is_a_turn_scoped_system_message_that_later_requests_replay_before_its_turn() {
    let model = "claude-sonnet-5-5";
    let first = wire(&api(), &request(model, vec![text(Role::User, "q"), reminder("R")], Vec::new(), RequestOptions::default()));
    let messages = body_of(&first)["messages"].clone();
    assert_eq!(messages[0]["content"], json!([{ "type": "text", "text": "q", "cache_control": { "type": "ephemeral" } }]));
    assert_eq!(messages[1], json!({ "role": "system", "content": [{ "type": "text", "text": "R" }], "clear_at": "next_user_message" }));
    assert!(beta(&first).contains("mid-conversation-system-clear-at-2026-08-21"));
    // The next turn: the assistant message remembers the reminder it was generated under; it is re-sent right
    // before that turn and the new reminder ends the request.
    let mut answer = text(Role::Assistant, "a");
    answer.turn_reminder = Some("R".into());
    let second =
        body(&api(), &request(model, vec![text(Role::User, "q"), answer, text(Role::User, "q2"), reminder("R2")], Vec::new(), RequestOptions::default()));
    let roles: Vec<&str> = second["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "system", "assistant", "user", "system"]);
    assert_eq!(second["messages"][1]["content"][0]["text"], "R");
    assert_eq!(second["messages"][4]["content"][0]["text"], "R2");
    // The first request's history is a byte prefix of the second's apart from the moved marker.
    assert_eq!(second["messages"][1], messages[1]);
}

// ---------------------------------------------------------------------------
// A frame the computer tool already sized
// ---------------------------------------------------------------------------

#[test]
fn an_image_frame_the_tool_already_sized_goes_out_with_its_bytes_and_media_type_unchanged() {
    let mut config = caps_for(None);
    config.cache = CacheStrategy { system: None, tier3: None, messages: None };
    let codec = AnthropicCodec::new(Flavor::ApiKey, config);
    let frame = Message::new(
        Role::User,
        Content::Parts(vec![ContentPart::Image(ImageSource::Base64 {
            data: "/9j/AAAA".into(),
            mime_type: "image/jpeg".into(),
            width: Some(1280),
            height: Some(720),
        })]),
    );
    let sent = body(&codec, &request("claude-sonnet-4-6", vec![frame], Vec::new(), RequestOptions::default()));
    assert_eq!(
        sent["messages"],
        json!([{ "role": "user", "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "/9j/AAAA" } }] }])
    );
}

// ---------------------------------------------------------------------------
// Reasoning, effort, tool choice
// ---------------------------------------------------------------------------

fn with_effort(caps: ModelCaps, effort: Option<&str>, parameters: Option<Value>) -> (Value, String) {
    let options = RequestOptions { effort: effort.map(str::to_owned), model_parameters: parameters, ..RequestOptions::default() };
    let sent = wire(&codec(Flavor::ApiKey, Some(caps)), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], Vec::new(), options));
    (body_of(&sent), beta(&sent))
}

#[test]
fn an_adaptive_model_sends_adaptive_thinking_and_the_effort_it_takes() {
    let (sent, betas) = with_effort(adaptive(&["low", "medium", "high"]), Some("medium"), None);
    assert_eq!(sent["thinking"], json!({ "type": "adaptive" }));
    assert_eq!(sent["output_config"], json!({ "effort": "medium" }));
    assert!(betas.contains("effort-2025-11-24"));
    let keys: Vec<&String> = sent.as_object().unwrap().keys().collect();
    let at = |k: &str| keys.iter().position(|key| *key == k).unwrap();
    assert!(at("output_config") < at("thinking"), "{keys:?}");
}

#[test]
fn an_effort_the_model_does_not_list_is_lowered_to_the_highest_it_takes() {
    let up_to_high = adaptive(&["low", "medium", "high"]);
    assert_eq!(with_effort(up_to_high.clone(), Some("xhigh"), None).0["output_config"]["effort"], "high");
    assert_eq!(with_effort(up_to_high, Some("max"), None).0["output_config"]["effort"], "high");
    let with_xhigh = adaptive(&["low", "medium", "high", "xhigh"]);
    assert_eq!(with_effort(with_xhigh, Some(" Extra-High "), None).0["output_config"]["effort"], "xhigh");
}

#[test]
fn an_unknown_effort_is_not_sent_but_the_adaptive_thinking_still_is() {
    let (sent, _) = with_effort(adaptive(&["low", "high"]), Some("turbo"), None);
    assert_eq!(sent["thinking"], json!({ "type": "adaptive" }));
    assert!(sent.get("output_config").is_none());
}

#[test]
fn a_manual_thinking_model_maps_effort_to_a_budget_inside_the_room_max_tokens_leaves() {
    let budget = |caps: ModelCaps, effort: &str| with_effort(caps, Some(effort), None).0["thinking"].clone();
    assert_eq!(budget(manual(32000), "low"), json!({ "type": "enabled", "budget_tokens": 1024 }));
    assert_eq!(budget(manual(32000), "medium"), json!({ "type": "enabled", "budget_tokens": 4096 }));
    assert_eq!(budget(manual(32000), "high"), json!({ "type": "enabled", "budget_tokens": 16384 }));
    // `max` is a level this model does not list (and it lists no `xhigh` to stand in for it): it reads as `high`.
    assert_eq!(budget(manual(32000), "max"), json!({ "type": "enabled", "budget_tokens": 16384 }));
    let with_xhigh = ModelCaps { effort_levels: vec!["xhigh".into()], ..manual(32000) };
    assert_eq!(budget(with_xhigh.clone(), "xhigh"), json!({ "type": "enabled", "budget_tokens": 30976 }), "capped by the room max_tokens leaves");
    assert_eq!(budget(with_xhigh, "max"), json!({ "type": "enabled", "budget_tokens": 30976 }));
    // 1024 tokens stay for the answer.
    assert_eq!(budget(manual(8192), "high"), json!({ "type": "enabled", "budget_tokens": 7168 }));
    // With less room than the smallest budget plus the answer there is no thinking at all.
    assert_eq!(budget(manual(1500), "high"), Value::Null);
    assert_eq!(budget(manual(2048), "high"), json!({ "type": "enabled", "budget_tokens": 1024 }));
}

#[test]
fn an_explicit_thinking_budget_is_kept_above_the_minimum_and_below_the_ceiling() {
    let budget = |tokens: u64| with_effort(manual(8192), None, Some(json!({ "thinkingBudgetTokens": tokens }))).0["thinking"].clone();
    assert_eq!(budget(2000), json!({ "type": "enabled", "budget_tokens": 2000 }));
    assert_eq!(budget(500), json!({ "type": "enabled", "budget_tokens": 1024 }));
    assert_eq!(budget(100_000), json!({ "type": "enabled", "budget_tokens": 7168 }));
}

#[test]
fn a_forced_tool_is_dropped_while_thinking_is_on_and_sequential_calls_can_be_asked_for() {
    let lookup = vec![tool("lookup", json!({ "type": "object", "properties": {} }))];
    let build = |caps: Option<ModelCaps>, choice: Option<&str>, parameters: Option<Value>| {
        let options = RequestOptions { tool_choice: choice.map(str::to_owned), model_parameters: parameters, ..RequestOptions::default() };
        body(&codec(Flavor::ApiKey, caps), &request("claude-sonnet-4-6", vec![text(Role::User, "hi")], lookup.clone(), options))["tool_choice"].clone()
    };
    assert_eq!(build(None, Some("lookup"), None), json!({ "type": "tool", "name": "lookup" }));
    assert_eq!(build(None, Some("required"), None), json!({ "type": "any" }));
    assert_eq!(build(None, Some("none"), None), json!({ "type": "none" }));
    assert_eq!(build(Some(adaptive(&["low"])), Some("lookup"), None), Value::Null);
    assert_eq!(build(Some(adaptive(&["low"])), Some("auto"), None), json!({ "type": "auto" }));
    assert_eq!(build(None, None, Some(json!({ "disableParallelToolUse": true }))), json!({ "type": "auto", "disable_parallel_tool_use": true }));
    assert_eq!(build(None, Some("none"), Some(json!({ "disableParallelToolUse": true }))), json!({ "type": "none" }));
    assert_eq!(build(None, None, None), Value::Null);
}

#[test]
fn max_tokens_follows_the_override_then_the_catalog_then_the_family() {
    let max = |model: &str, caps: Option<ModelCaps>, options: RequestOptions| {
        body(&codec(Flavor::ApiKey, caps), &request(model, vec![text(Role::User, "hi")], Vec::new(), options))["max_tokens"].clone()
    };
    assert_eq!(max("claude-sonnet-4-6", Some(manual(20000)), RequestOptions { max_output_tokens_override: Some(500), ..RequestOptions::default() }), 500);
    assert_eq!(max("claude-sonnet-4-6", Some(manual(20000)), RequestOptions::default()), 20000);
    assert_eq!(max("claude-sonnet-4-6", Some(manual(900_000)), RequestOptions::default()), 65536, "the safety cap");
    assert_eq!(max("claude-opus-4-1", None, RequestOptions::default()), 65536);
    assert_eq!(max("claude-sonnet-4-6", None, RequestOptions::default()), 16384);
    assert_eq!(max("claude-haiku-3", None, RequestOptions::default()), 8192);
}

#[test]
fn effort_changes_inside_a_conversation_ride_as_empty_system_messages_on_models_that_take_them() {
    let projection = EffortProjection { initial_effort: "medium".into(), updates: [(3, "high".to_owned())].into() };
    let options = RequestOptions { effort: Some("high".into()), effort_projection: Some(projection), ..RequestOptions::default() };
    let messages = conversation(&["q1", "a1", "q2"]);
    let take = |model: &str, base: &str, options: &RequestOptions| {
        let mut config = caps_for(Some(adaptive(&["low", "medium", "high"])));
        config.base_url = base.into();
        let sent = wire(&AnthropicCodec::new(Flavor::ApiKey, config), &request(model, messages.clone(), Vec::new(), options.clone()));
        (body_of(&sent), beta(&sent))
    };
    let (sent, betas) = take("claude-opus-5", "https://api.anthropic.com", &options);
    let kinds: Vec<&str> = sent["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["user", "assistant", "system", "user"]);
    assert_eq!(sent["messages"][2]["output_config"], json!({ "effort": "high" }));
    assert_eq!(sent["output_config"], json!({ "effort": "medium" }), "the turn starts at the initial effort");
    assert!(betas.contains("mid-conversation-output-config-2026-07-01"));
    // A model below its family's floor, and a gateway, send no update messages and the request's own effort.
    for (model, base) in [("claude-opus-4-6", "https://api.anthropic.com"), ("claude-opus-5", "https://gateway.example")] {
        let (sent, betas) = take(model, base, &options);
        assert_eq!(sent["messages"].as_array().unwrap().len(), 3, "{model} {base}");
        assert_eq!(sent["output_config"], json!({ "effort": "high" }));
        assert!(!betas.contains("mid-conversation"));
    }
}

// ---------------------------------------------------------------------------
// Server-side fallback
// ---------------------------------------------------------------------------

#[test]
fn a_model_of_the_fallback_families_asks_for_the_servers_fallback() {
    let ask = |flavor: Flavor, model: &str, parameters: Option<Value>| {
        let options = RequestOptions { model_parameters: parameters, ..RequestOptions::default() };
        let sent = wire(&codec(flavor, Some(adaptive(&["low"]))), &request(model, vec![text(Role::User, "hi")], Vec::new(), options));
        (body_of(&sent), beta(&sent))
    };
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let (sent, betas) = ask(flavor, "claude-opus-5", None);
        assert_eq!(sent["fallbacks"], "default");
        assert!(betas.contains("server-side-fallback-2026-07-01"));
        assert_eq!(ask(flavor, "claude-fable-5-20260101", None).0["fallbacks"], "default", "a dated snapshot is the same family");
        assert_eq!(ask(flavor, "claude-opus-5@x", None).0["fallbacks"], "default");
        assert!(ask(flavor, "claude-opus-5", Some(json!({ "serverFallback": false }))).0.get("fallbacks").is_none());
        for other in ["claude-opus-4-6", "claude-sonnet-5", "claude-opus-50", "claude-opus-5x"] {
            assert!(ask(flavor, other, None).0.get("fallbacks").is_none(), "{other}");
        }
    }
    // Where the field sits on the wire (a cached prefix is a byte prefix): the API-key body names it right after
    // the messages, the subscription body right after `stream`.
    let keys = |flavor: Flavor| ask(flavor, "claude-opus-5", None).0.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    let api = keys(Flavor::ApiKey);
    assert_eq!(api[api.iter().position(|k| k == "messages").unwrap() + 1], "fallbacks");
    let oauth = keys(Flavor::OAuth);
    assert_eq!(oauth[..3], ["model", "max_tokens", "messages"]);
    assert_eq!(oauth[oauth.iter().position(|k| k == "stream").unwrap() + 1], "fallbacks");
}

// ---------------------------------------------------------------------------
// Response threads
// ---------------------------------------------------------------------------

#[test]
fn a_conversations_first_request_is_a_thread_create_and_a_fork_of_it_is_never_threaded() {
    let thread_of = |flavor: Flavor, options: RequestOptions| {
        let sent = wire(&codec(flavor, None), &request("claude-sonnet-4-6", conversation(&["q1", "a1", "q2"]), Vec::new(), options));
        (body_of(&sent), beta(&sent))
    };
    let session = |count: Option<usize>| RequestOptions { session_id: Some("session-1".into()), shared_cache_prefix_count: count, ..RequestOptions::default() };
    for flavor in [Flavor::ApiKey, Flavor::OAuth] {
        let (body, betas) = thread_of(flavor, session(None));
        assert_eq!(body["thread"], json!({ "type": "create" }), "{flavor:?}");
        assert!(betas.contains("message-threads-2026-08-12"), "{betas}");
        // A fork reads the saved request's cache and keeps no conversation of its own on the server.
        let (fork, betas) = thread_of(flavor, session(Some(3)));
        assert!(fork.get("thread").is_none(), "{flavor:?}");
        assert!(!betas.contains("message-threads"), "{betas}");
        // A count of zero is no fork.
        assert!(thread_of(flavor, session(Some(0))).0.get("thread").is_some());
    }
}

#[test]
fn a_request_with_no_session_a_compaction_or_a_model_without_threads_is_sent_whole() {
    let build = |model: &str, options: RequestOptions| body(&api(), &request(model, conversation(&["q1"]), Vec::new(), options));
    let session = RequestOptions { session_id: Some("session-1".into()), ..RequestOptions::default() };
    assert!(build("claude-sonnet-4-6", session.clone()).get("thread").is_some());
    assert!(build("claude-sonnet-4-6", RequestOptions::default()).get("thread").is_none());
    let compaction = RequestOptions { request_kind: Some("compaction".into()), ..session.clone() };
    assert!(build("claude-sonnet-4-6", compaction).get("thread").is_none());
    assert!(build("claude-3-5-haiku", session).get("thread").is_none());
}
