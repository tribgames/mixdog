//! The provider-specific shape of the hosted web-search tool, the prompt that
//! drives it and the flattening of its cited sources
//! (`session-runtime/native-web-search/tool-shape.mjs`).

use std::collections::HashSet;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::routes::clean;
use super::routes::truthy;

fn get<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.get(key)
}

/// `normalizeWebSearchAllowedDomain`: a site as a lowercase hostname.
pub fn normalize_allowed_domain(site: &str) -> String {
    let raw = mixdog_js::js_trim(site);
    if raw.is_empty() {
        return String::new();
    }
    let has_scheme = {
        let lower = raw.to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    };
    let candidate = if has_scheme { raw.to_owned() } else { format!("https://{raw}") };
    if let Some(host) = url::Url::parse(&candidate).ok().and_then(|u| u.host_str().map(str::to_lowercase)) {
        return host;
    }
    let lower = raw.to_ascii_lowercase();
    let stripped = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).unwrap_or(&lower);
    stripped.split('/').next().unwrap_or("").to_lowercase()
}

/// `normalizeWebSearchAllowedDomains`: a site filter may name several domains
/// the way a search box takes them (`a.com OR b.com`, `a.com, b.com`,
/// `site:a.com site:b.com`); each becomes its own allowed domain.
pub fn normalize_allowed_domains(site: &str) -> Vec<String> {
    let cleaned = mixdog_js::js_trim(site);
    let mut seen = HashSet::new();
    cleaned
        .split(|c: char| mixdog_js::is_js_space(c) || c == ',' || c == '|')
        .filter(|part| !part.is_empty() && !part.eq_ignore_ascii_case("or"))
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            let bare = if lower.starts_with("site:") { &part[5..] } else { part };
            normalize_allowed_domain(bare)
        })
        .filter(|domain| !domain.is_empty())
        .filter(|domain| seen.insert(domain.clone()))
        .collect()
}

/// `nativeWebSearchUserLocation`: an approximate location, or `None`.
pub fn user_location(locale: Option<&Value>) -> Option<Value> {
    let locale = locale?.as_object()?;
    let mut location = Map::new();
    location.insert("type".into(), json!("approximate"));
    for key in ["country", "region", "city", "timezone"] {
        let value = clean(locale.get(key));
        if !value.is_empty() {
            location.insert(key.into(), Value::String(value));
        }
    }
    (location.len() > 1).then_some(Value::Object(location))
}

use mixdog_js::json_number as number_value;

/// `nativeWebSearchTool`: `family` is the provider's hosted web-search family
/// (`web_search_provider_family`).
pub fn native_web_search_tool(args: &Value, tool_type: &str, family: &str) -> Value {
    let domains = normalize_allowed_domains(&clean(get(args, "site")));
    let tool_type = mixdog_js::js_trim(tool_type);
    let tool_type = if tool_type.is_empty() { "web_search" } else { tool_type };
    let location = user_location(get(args, "locale"));
    match family {
        "gemini" => json!({ "type": tool_type }),
        "anthropic" => {
            let max = Some(mixdog_js::to_number_of(get(args, "maxResults"))).filter(|n| !n.is_nan() && *n != 0.0).unwrap_or(5.0);
            let mut tool = Map::new();
            tool.insert("type".into(), json!("web_search_20250305"));
            tool.insert("name".into(), json!("web_search"));
            tool.insert("max_uses".into(), number_value(max.min(10.0).max(1.0)));
            if !domains.is_empty() {
                tool.insert("allowed_domains".into(), json!(domains));
            }
            if let Some(location) = location {
                tool.insert("user_location".into(), location);
            }
            Value::Object(tool)
        }
        "xai" => {
            let mut tool = Map::new();
            tool.insert("type".into(), json!(tool_type));
            if !domains.is_empty() {
                tool.insert("filters".into(), json!({ "allowed_domains": domains }));
            }
            Value::Object(tool)
        }
        _ => {
            let mut tool = Map::new();
            tool.insert("type".into(), json!(tool_type));
            if tool_type == "web_search" {
                let size = clean(get(args, "contextSize"));
                tool.insert("search_context_size".into(), json!(if size.is_empty() { "low".to_owned() } else { size }));
                if !domains.is_empty() {
                    tool.insert("filters".into(), json!({ "allowed_domains": domains }));
                }
                if let Some(location) = location {
                    tool.insert("user_location".into(), location);
                }
            }
            Value::Object(tool)
        }
    }
}

/// `nativeWebSearchToolTypes`: the environment's tool type
/// (`MIXDOG_NATIVE_WEB_SEARCH_TOOL_TYPE`), else the route's, else the family's.
pub fn native_web_search_tool_types(route: &Value, family: &str, env_tool_type: Option<&str>) -> Vec<String> {
    let from_env = env_tool_type.map(|v| mixdog_js::js_trim(v).to_owned()).unwrap_or_default();
    if !from_env.is_empty() {
        return vec![from_env];
    }
    let configured = clean(get(route, "toolType"));
    if !configured.is_empty() {
        return vec![configured];
    }
    match family {
        "gemini" => vec!["google_search".into()],
        "anthropic" | "xai" => vec!["web_search".into()],
        _ => vec!["web_search".into(), "web_search_preview".into()],
    }
}

/// `nativeWebSearchMessages`: the system prompt and the user's prompt, as
/// `{role, content}` rows.
pub fn native_web_search_messages(args: &Value) -> Vec<Value> {
    // `args.prompt || ''`, passed on as it is.
    let prompt = truthy(get(args, "prompt")).cloned().unwrap_or_else(|| json!(""));
    let system = [
        "You are Mixdog native web search.",
        "Use the hosted web_search tool for current or external facts.",
        "Answer concisely, cite source URLs, and do not request local tools or file edits.",
    ]
    .join("\n");
    vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": prompt })]
}

/// `flattenNativeWebSearchSources`: the cited sources of a result, one row per
/// distinct URL.
pub fn flatten_sources(result: &Value) -> Vec<Value> {
    let mut out: Vec<Map<String, Value>> = Vec::new();
    let mut add = |source: &Value, fallback_title: &str| {
        if !source.is_object() {
            return;
        }
        let first = |keys: &[&str]| keys.iter().find_map(|k| truthy(source.get(k)));
        let url = clean(first(&["url", "uri", "href", "source_url"]));
        if url.is_empty() {
            return;
        }
        let title = match first(&["title", "query", "name"]) {
            Some(v) => clean(Some(v)),
            None if !fallback_title.is_empty() => clean(Some(&json!(fallback_title))),
            None => url.clone(),
        };
        let mut row = Map::new();
        row.insert("title".into(), Value::String(title));
        row.insert("url".into(), Value::String(url));
        row.insert("snippet".into(), Value::String(clean(first(&["snippet", "text", "description"]))));
        row.insert("source".into(), truthy(source.get("source")).cloned().unwrap_or_else(|| json!("native-web-search")));
        row.insert("provider".into(), truthy(source.get("provider")).cloned().unwrap_or_else(|| json!("native-web-search")));
        out.push(row);
    };
    let array = |v: Option<&Value>| v.and_then(Value::as_array).cloned().unwrap_or_default();
    for citation in array(result.get("citations")) {
        add(&citation, "");
    }
    for call in array(result.get("webSearchCalls")) {
        let action = call.get("action").cloned().filter(|a| truthy(Some(a)).is_some()).unwrap_or_else(|| json!({}));
        let query = clean(truthy(action.get("query")));
        for source in array(action.get("sources")) {
            add(&source, &query);
        }
        if truthy(action.get("url")).is_some() {
            add(&json!({ "url": action["url"], "title": query }), "");
        }
        for url in array(action.get("urls")) {
            add(&json!({ "url": url, "title": query }), "");
        }
    }
    let mut seen = HashSet::new();
    out.into_iter()
        .filter(|row| {
            let url = row["url"].as_str().unwrap_or("");
            let key = if url.is_empty() {
                format!("{}\n{}", row["title"].as_str().unwrap_or(""), row["snippet"].as_str().unwrap_or(""))
            } else {
                url.to_owned()
            };
            seen.insert(key)
        })
        .map(Value::Object)
        .collect()
}

#[cfg(test)]
mod tests;
