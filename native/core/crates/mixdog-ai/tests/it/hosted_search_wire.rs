//! The hosted web-search tool as each wire but Anthropic's declares it (Responses for OpenAI and xAI, Gemini), how
//! Node's tool object is read into it, and the native tool-search items a Responses request carries.

use std::sync::Arc;

use mixdog_ai::providers::hosted::SEARCH_SOURCES_INCLUDE;
use mixdog_ai::providers::hosted::gemini_tools;
use mixdog_ai::providers::hosted::responses_include;
use mixdog_ai::providers::hosted::responses_tools;
use mixdog_ai::providers::hosted::web_search_from_node;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::HostedTool;
use mixdog_core_api::domain::provider::HostedWebSearch;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::UserLocation;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;
use serde_json::json;

fn options_of(tool: HostedTool) -> RequestOptions {
    RequestOptions { hosted_tools: vec![tool], ..RequestOptions::default() }
}

fn search(tool_type: &str) -> HostedWebSearch {
    HostedWebSearch {
        tool_type: tool_type.into(),
        allowed_domains: Vec::new(),
        user_location: None,
        max_uses: None,
        context_size: None,
        include_sources: false,
    }
}

#[test]
fn a_tool_object_is_read_into_the_hosted_search_the_codecs_render() {
    let tool = json!({
        "type": "web_search", "search_context_size": "medium", "filters": {"allowed_domains": ["a.com", "b.com", 3]},
        "user_location": {"type": "approximate", "country": "KR", "city": "Seoul", "region": 7},
    });
    let HostedTool::WebSearch(read) = web_search_from_node(&tool, false, &[SEARCH_SOURCES_INCLUDE.to_owned()]);
    assert_eq!(read.tool_type, "web_search");
    assert_eq!(read.allowed_domains, ["a.com", "b.com"], "only text domains are kept");
    assert_eq!(read.context_size.as_deref(), Some("medium"));
    assert!(read.include_sources);
    let at = read.user_location.expect("a location");
    assert_eq!(
        (at.country.as_deref(), at.city.as_deref(), at.region, at.timezone),
        (Some("KR"), Some("Seoul"), None, None),
        "a field that is not text is dropped"
    );
}

#[test]
fn the_anthropic_family_reads_its_uses_and_domains_and_a_fixed_tool_type() {
    let tool = json!({"type": "web_search_20250305", "name": "web_search", "max_uses": 4, "allowed_domains": ["a.com"]});
    let HostedTool::WebSearch(read) = web_search_from_node(&tool, true, &[]);
    assert_eq!(
        (read.tool_type.as_str(), read.max_uses, read.allowed_domains.as_slice(), read.include_sources),
        ("web_search", Some(4), ["a.com".to_owned()].as_slice(), false)
    );
    let HostedTool::WebSearch(bare) = web_search_from_node(&json!({}), false, &["other".to_owned()]);
    assert_eq!(bare.tool_type, "web_search", "no type: the plain search");
    assert!(!bare.include_sources && bare.max_uses.is_none() && bare.user_location.is_none());
    let HostedTool::WebSearch(huge) = web_search_from_node(&json!({"max_uses": 99999999999u64}), true, &[]);
    assert_eq!(huge.max_uses, None, "a count that does not fit is dropped");
}

#[test]
fn the_responses_tool_carries_context_size_filters_and_location_in_that_order() {
    let mut full = search("web_search");
    full.context_size = Some("high".into());
    full.allowed_domains = vec!["a.com".into()];
    full.user_location = Some(UserLocation { country: Some("US".into()), timezone: Some("America/New_York".into()), ..UserLocation::default() });
    let tools = responses_tools(&options_of(HostedTool::WebSearch(full)));
    assert_eq!(
        tools[0].to_string(),
        r#"{"type":"web_search","search_context_size":"high","filters":{"allowed_domains":["a.com"]},"user_location":{"type":"approximate","country":"US","timezone":"America/New_York"}}"#
    );
    assert_eq!(responses_tools(&options_of(HostedTool::WebSearch(search("web_search_preview")))), [json!({"type": "web_search_preview"})]);
    assert!(responses_tools(&RequestOptions::default()).is_empty());
}

#[test]
fn the_sources_are_asked_for_only_when_a_search_wants_them() {
    let mut wants = search("web_search");
    wants.include_sources = true;
    assert_eq!(responses_include(&options_of(HostedTool::WebSearch(wants))), ["web_search_call.action.sources"]);
    assert!(responses_include(&options_of(HostedTool::WebSearch(search("web_search")))).is_empty());
    assert!(responses_include(&RequestOptions::default()).is_empty());
}

#[test]
fn gemini_hosts_only_its_google_search_types() {
    for tool_type in ["google_search", "google_search_retrieval", " Google_Search "] {
        assert_eq!(gemini_tools(&options_of(HostedTool::WebSearch(search(tool_type)))), [json!({"googleSearch": {}})], "{tool_type}");
    }
    for tool_type in ["web_search", "web_search_preview", ""] {
        assert!(gemini_tools(&options_of(HostedTool::WebSearch(search(tool_type)))).is_empty(), "{tool_type}");
    }
    let mut filtered = search("google_search");
    filtered.allowed_domains = vec!["a.com".into()];
    assert_eq!(gemini_tools(&options_of(HostedTool::WebSearch(filtered))), [json!({"googleSearch": {}})], "Gemini takes no filter");
}

struct Ctx;
impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
}

struct Facts(Option<bool>);
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts { native_tool_search: self.0, ..ModelFacts::default() }
    }
}

fn codec(native_tool_search: bool) -> OpenAiCodec {
    let identity =
        CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "0.166.0".into(), beta_features: "remote_compaction_v2".into() };
    OpenAiCodec::new(OpenAiConfig::codex(false, identity, Arc::new(Facts(Some(native_tool_search))), Arc::new(Ctx)), TransportKind::Http1)
}

/// The public API route, where the model's own declaration decides.
fn api_body(declared: Option<bool>, messages: Vec<Message>) -> Value {
    let codec = OpenAiCodec::new(OpenAiConfig::api_key(false, Arc::new(Facts(declared)), Arc::new(Ctx)), TransportKind::Http1);
    let request = ModelRequest { model: "gpt-5.2".to_owned(), messages, tools: vec![eager("Skill")], options: RequestOptions::default() };
    serde_json::from_slice(&codec.encode(&request).expect("the request encodes").body).expect("the body is JSON")
}

fn text(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.to_owned().into()))
}

fn eager(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_owned(),
        description: format!("{name} tool"),
        input_schema: json!({"type": "object", "properties": {}}),
        defer_loading: false,
        freeform: None,
    }
}

fn body(native_tool_search: bool, messages: Vec<Message>, tools: Vec<ToolDefinition>, options: RequestOptions) -> Value {
    let request = ModelRequest { model: "gpt-6-astra".to_owned(), messages, tools, options };
    let wire = codec(native_tool_search).encode(&request).expect("the request encodes");
    serde_json::from_slice(&wire.body).expect("the body is JSON")
}

#[test]
fn the_responses_request_declares_the_hosted_search_ahead_of_the_function_tools_and_asks_for_sources() {
    let mut wants = search("web_search");
    wants.context_size = Some("low".into());
    wants.include_sources = true;
    let sent = body(false, vec![text(Role::User, "hi")], vec![eager("read")], options_of(HostedTool::WebSearch(wants)));
    let tools = sent["tools"].as_array().unwrap();
    assert_eq!(tools[0], json!({"type": "web_search", "search_context_size": "low"}));
    assert_eq!(tools[1]["name"], "read");
    assert!(sent["include"].as_array().unwrap().iter().any(|i| i == "web_search_call.action.sources"), "{}", sent["include"]);
    let plain = body(false, vec![text(Role::User, "hi")], vec![eager("read")], RequestOptions::default());
    assert_eq!(plain["tools"].as_array().unwrap().len(), 1);
    assert!(!plain["include"].as_array().is_some_and(|i| i.iter().any(|i| i == "web_search_call.action.sources")));
}

fn mcp_tool() -> Value {
    json!({"type": "function", "name": "mcp__weather__forecast", "description": "Forecast", "parameters": {"type": "object", "properties": {}}, "defer_loading": true})
}

fn skill_exchange(native: Value) -> Vec<Message> {
    let mut assistant = text(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall { id: "call_1".into(), name: "Skill".into(), arguments: json!({"name": "weather"}), native_type: None });
    let mut result = text(Role::Tool, "loaded weather");
    result.tool_call_id = Some("call_1".into());
    result.native_tool_search = Some(native);
    vec![text(Role::User, "go"), assistant, result]
}

fn types(input: &Value) -> Vec<&str> {
    input.as_array().unwrap().iter().map(|i| i["type"].as_str().unwrap_or("")).collect()
}

#[test]
fn tools_a_skill_result_loaded_are_registered_by_a_client_tool_search_pair_after_its_output() {
    let sent = body(true, skill_exchange(json!({"provider": "openai-oauth", "openaiTools": [mcp_tool()]})), vec![eager("Skill")], RequestOptions::default());
    let input = &sent["input"];
    let kinds = types(input);
    let at = kinds.iter().position(|k| *k == "function_call").expect("the Skill call");
    assert_eq!(&kinds[at..], ["function_call", "function_call_output", "tool_search_call", "tool_search_output"]);
    let items = input.as_array().unwrap();
    let call_id = items[at]["call_id"].as_str().unwrap();
    assert_eq!(items[at + 1]["output"], "loaded weather");
    assert_eq!(items[at + 2]["call_id"], format!("{call_id}_load"));
    assert_eq!(items[at + 2]["execution"], "client");
    assert_eq!(items[at + 2]["arguments"], json!({"names": ["mcp__weather__forecast"]}));
    let output = &items[at + 3];
    assert_eq!(
        (output["call_id"].as_str().unwrap(), output["status"].as_str().unwrap(), output["execution"].as_str().unwrap()),
        (format!("{call_id}_load").as_str(), "completed", "client")
    );
    assert_eq!(output["tools"][0]["strict"], false, "a loaded function is declared non-strict");
    assert_eq!(output["tools"][0]["name"], "mcp__weather__forecast");
}

#[test]
fn a_payload_another_provider_made_cannot_register_tools_and_the_result_says_how_to_load_them() {
    let sent = body(true, skill_exchange(json!({"provider": "anthropic", "openaiTools": [mcp_tool()]})), vec![eager("Skill")], RequestOptions::default());
    let kinds = types(&sent["input"]);
    assert!(!kinds.contains(&"tool_search_call") && !kinds.contains(&"tool_search_output"), "{kinds:?}");
    let output = sent["input"].as_array().unwrap().iter().find(|i| i["type"] == "function_call_output").unwrap()["output"].as_str().unwrap().to_owned();
    assert_eq!(
        output,
        "loaded weather\nThis ordinary function result cannot register native tools. Use tool_search with names:[\"mcp__weather__forecast\"] to load their definitions."
    );
}

#[test]
fn a_native_search_call_is_answered_by_a_search_output_and_a_named_skill_keeps_its_status_text_visible() {
    let mut assistant = text(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "ts1".into(),
        name: "tool_search".into(),
        arguments: json!({"name": "weather"}),
        native_type: Some("tool_search_call".into()),
    });
    let mut result = text(Role::Tool, "weather loaded");
    result.tool_call_id = Some("ts1".into());
    result.native_tool_search = Some(json!({"provider": "openai", "openaiTools": [mcp_tool()]}));
    let sent = body(true, vec![text(Role::User, "go"), assistant, result], vec![eager("Skill")], RequestOptions::default());
    let items = sent["input"].as_array().unwrap();
    let call = items.iter().find(|i| i["type"] == "tool_search_call").expect("the native call");
    assert_eq!((call["execution"].as_str(), call["arguments"].clone()), (Some("client"), json!({"name": "weather"})));
    let output = items.iter().find(|i| i["type"] == "tool_search_output").expect("its output");
    assert_eq!(output["call_id"], call["call_id"]);
    assert_eq!(output["tools"].as_array().unwrap().len(), 1);
    let shown = serde_json::to_string(items.last().unwrap()).unwrap();
    assert!(shown.contains("weather loaded"), "the status text follows as a user message: {shown}");
    assert_eq!(items.last().unwrap()["role"], "user");
}

#[test]
fn a_native_search_answered_by_another_providers_payload_is_an_empty_search_output() {
    let mut assistant = text(Role::Assistant, "");
    assistant.tool_calls.push(ToolCall {
        id: "ts1".into(),
        name: "tool_search".into(),
        arguments: json!({"query": "x"}),
        native_type: Some("tool_search_call".into()),
    });
    let mut result = text(Role::Tool, "nothing found");
    result.tool_call_id = Some("ts1".into());
    result.native_tool_search = Some(json!({"provider": "anthropic", "openaiTools": [mcp_tool()]}));
    let sent = body(true, vec![text(Role::User, "go"), assistant, result], vec![eager("Skill")], RequestOptions::default());
    let items = sent["input"].as_array().unwrap();
    let output = items.iter().find(|i| i["type"] == "tool_search_output").expect("an output still answers the call");
    assert_eq!(output["tools"], json!([]));
    assert!(serde_json::to_string(items.last().unwrap()).unwrap().contains("nothing found"), "the result text stays visible");
}

#[test]
fn on_the_public_api_only_a_model_that_declares_native_tool_search_gets_it() {
    let native = json!({"provider": "openai", "openaiTools": [mcp_tool()]});
    let declared = api_body(Some(true), skill_exchange(native.clone()));
    assert!(types(&declared["input"]).contains(&"tool_search_output"), "a declaring model registers loaded tools natively");
    for undeclared in [Some(false), None] {
        let sent = api_body(undeclared, skill_exchange(native.clone()));
        let kinds = types(&sent["input"]);
        assert!(!kinds.contains(&"tool_search_call") && !kinds.contains(&"tool_search_output"), "{undeclared:?}: {kinds:?}");
        let output = sent["input"].as_array().unwrap().iter().find(|i| i["type"] == "function_call_output").unwrap();
        assert_eq!(output["output"], "loaded weather", "the plain function result");
    }
}

#[test]
fn on_the_codex_route_native_tool_search_is_always_on_whatever_the_model_facts_say() {
    for declared in [true, false] {
        let sent =
            body(declared, skill_exchange(json!({"provider": "openai-oauth", "openaiTools": [mcp_tool()]})), vec![eager("Skill")], RequestOptions::default());
        assert!(types(&sent["input"]).contains(&"tool_search_output"), "declared {declared}");
    }
}
/// The public API's native tool search follows the model's version: gpt-5.4 and later (`gpt-N[.M]`, a dated snapshot
/// reading as its alias). The fact the route is given is this rule over the id, never a catalog row's own field, so a
/// model the catalog does not list answers the same as a listed one.
#[test]
fn the_version_rule_for_public_native_tool_search_by_model_id() {
    let native = |id: &str| mixdog_ai::service::routes::gpt_version(id).is_some_and(|(major, minor)| major > 5 || (major == 5 && minor >= 4));
    for id in [
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.4-2026-03-05",
        "gpt-5.5",
        "gpt-5.5-pro",
        "gpt-5.6-sol",
        "gpt-5.10",
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-7",
        "gpt-5.99-unlisted",
    ] {
        assert!(native(id), "{id}");
    }
    for id in [
        "gpt-5",
        "gpt-5-2025-08-07",
        "gpt-5-chat-latest",
        "gpt-5.1",
        "gpt-5.2",
        "gpt-5.3-codex",
        "gpt-4.1",
        "gpt-4o",
        "o3",
        "o4-mini",
        "gpt-60",
        "gpt-5.4x",
        "text-embedding-3-large",
        "",
    ] {
        assert!(!native(id), "{id}");
    }
}
