//! Provider-hosted tools (Node `opts.nativeTools`): the one reading of Node's tool object into [`HostedTool`], and the
//! rendering each wire gives it. Every wire declares hosted tools ahead of the function tools.

use mixdog_core_api::domain::provider::HostedTool;
use mixdog_core_api::domain::provider::HostedWebSearch;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::UserLocation;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The Responses `include` value that asks for a web search's sources (`nativeInclude`).
pub const SEARCH_SOURCES_INCLUDE: &str = "web_search_call.action.sources";

fn text_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// Node's hosted web-search tool object (`nativeWebSearchTool`) as a [`HostedTool`]. `anthropic`: the Anthropic family,
/// whose versioned tool type its codec fixes; `include`: the send's `nativeInclude`.
pub fn web_search_from_node(tool: &Value, anthropic: bool, include: &[String]) -> HostedTool {
    let domains = tool.get("allowed_domains").or_else(|| tool.pointer("/filters/allowed_domains"));
    let location = tool.get("user_location").and_then(Value::as_object).map(|location| UserLocation {
        country: text_of(location.get("country")),
        region: text_of(location.get("region")),
        city: text_of(location.get("city")),
        timezone: text_of(location.get("timezone")),
    });
    let tool_type =
        if anthropic { "web_search".to_owned() } else { text_of(tool.get("type")).unwrap_or_else(|| "web_search".to_owned()) };
    HostedTool::WebSearch(HostedWebSearch {
        tool_type,
        allowed_domains: domains
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|domain| domain.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        user_location: location,
        max_uses: tool.get("max_uses").and_then(Value::as_u64).and_then(|uses| u32::try_from(uses).ok()),
        context_size: text_of(tool.get("search_context_size")),
        include_sources: include.iter().any(|field| field == SEARCH_SOURCES_INCLUDE),
    })
}

fn location(location: &UserLocation) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), json!("approximate"));
    for (key, value) in [
        ("country", &location.country),
        ("region", &location.region),
        ("city", &location.city),
        ("timezone", &location.timezone),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    Value::Object(out)
}

/// Responses (OpenAI, xAI): the tool as Node built it, `{type, search_context_size?, filters?, user_location?}`.
pub fn responses_tools(options: &RequestOptions) -> Vec<Value> {
    options
        .hosted_tools
        .iter()
        .map(|HostedTool::WebSearch(search)| {
            let mut out = Map::new();
            out.insert("type".into(), json!(search.tool_type));
            if let Some(size) = &search.context_size {
                out.insert("search_context_size".into(), json!(size));
            }
            if !search.allowed_domains.is_empty() {
                out.insert("filters".into(), json!({ "allowed_domains": search.allowed_domains }));
            }
            if let Some(at) = &search.user_location {
                out.insert("user_location".into(), location(at));
            }
            Value::Object(out)
        })
        .collect()
}

/// Responses `include` entries the hosted tools ask for (`nativeInclude`), in order.
pub fn responses_include(options: &RequestOptions) -> Vec<&'static str> {
    let wants = options.hosted_tools.iter().any(|HostedTool::WebSearch(search)| search.include_sources);
    if wants { vec![SEARCH_SOURCES_INCLUDE] } else { Vec::new() }
}

/// Anthropic Messages: `{type: "web_search_20250305", name: "web_search", max_uses, allowed_domains?, user_location?}`.
pub fn anthropic_tools(options: &RequestOptions) -> Vec<Value> {
    options
        .hosted_tools
        .iter()
        .map(|HostedTool::WebSearch(search)| {
            let mut out = Map::new();
            out.insert("type".into(), json!("web_search_20250305"));
            out.insert("name".into(), json!("web_search"));
            if let Some(uses) = search.max_uses {
                out.insert("max_uses".into(), json!(uses));
            }
            if !search.allowed_domains.is_empty() {
                out.insert("allowed_domains".into(), json!(search.allowed_domains));
            }
            if let Some(at) = &search.user_location {
                out.insert("user_location".into(), location(at));
            }
            Value::Object(out)
        })
        .collect()
}

/// Gemini (`toGeminiNativeTools`, gemini-schema.mjs:789-801): `{googleSearch: {}}` for `google_search` and
/// `google_search_retrieval`; any other type has no Gemini form.
pub fn gemini_tools(options: &RequestOptions) -> Vec<Value> {
    options
        .hosted_tools
        .iter()
        .filter(|HostedTool::WebSearch(search)| {
            matches!(search.tool_type.trim().to_lowercase().as_str(), "google_search" | "google_search_retrieval")
        })
        .map(|_| json!({ "googleSearch": {} }))
        .collect()
}
