//! The Codex route's `prompt_cache_key`: the thread's identity clamped to the backend's 64 characters; the backend
//! derives the thread's prompt-cache slot from it. Pure.

mod lanes;

/// The lane slots assigned so far, forgotten as a new process has them.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_lane_assignments() {
    lanes::reset_assignments();
}

use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::{Value, json};
use sha2::Digest;
use sha2::Sha256;

const NAMESPACE: &str = "mixdog-codex";
const SHARED: &str = "mixdog-shared";
/// The backend's limit.
const LIMIT: usize = 64;

pub(super) use lanes::LaneConfig;

/// `normalizePromptCacheNamespace`: runs of characters outside `[A-Za-z0-9_-]` become one `-`, edge dashes go.
fn normalize(value: &str) -> String {
    let trimmed = mixdog_js::js_trim(value);
    let mut out = String::new();
    let mut gap = false;
    for c in if trimmed.is_empty() { SHARED } else { trimmed }.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('-');
    }
    let kept = out.trim_matches('-');
    if kept.is_empty() { SHARED.to_owned() } else { kept.to_owned() }
}

/// `fitPromptCacheKey(value, fallback)`: normalized, and over the limit cut with a hash of the whole.
fn fit(value: &str, fallback: &str) -> String {
    let s = normalize(if value.is_empty() { fallback } else { value });
    if s.len() <= LIMIT {
        return s;
    }
    // `shortHash(s, 12)`: the sha256 of `stableHashStringify(s)`, which for a string is its JSON text.
    let digest = Sha256::digest(serde_json::to_string(&s).expect("a string serializes").as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).take(6).collect();
    format!("{}-{hash}", &s[..(LIMIT - hash.len() - 1).max(1)])
}

/// What the request's prefix is made of, for the keys that identify the prefix and not the thread.
pub struct Prefix<'a> {
    pub model: &'a str,
    pub instructions: &'a str,
    /// The tools as they go on the wire.
    pub tools: &'a [Value],
    pub effort: Option<&'a str>,
    pub service_tier: Option<&'a str>,
}

/// `cleanString` of `shared/clean.mjs`: a string trimmed, anything else empty.
fn clean(value: Option<&str>) -> &str {
    value.map_or("", mixdog_js::js_trim)
}

fn named_keys(options: &RequestOptions) -> impl Iterator<Item = &str> {
    let param = |key| options.model_parameters.as_ref().and_then(|p| p.get(key)).and_then(Value::as_str);
    [param("providerCacheKey"), param("promptCacheKey"), options.prompt_cache_key.as_deref()].into_iter().flatten().filter(|key| !key.is_empty())
}

/// `summarizePromptCacheTools`.
fn summarize_tools(tools: &[Value]) -> Vec<Value> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map_or("", mixdog_js::js_trim).to_owned();
    // JS truthiness of the value.
    let truthy = |value: Option<&Value>| {
        value
            .filter(|v| match v {
                Value::Null | Value::Bool(false) => false,
                Value::String(s) => !s.is_empty(),
                Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
                _ => true,
            })
            .cloned()
    };
    // `cleanString(a || b)`
    let either = |a: Option<&Value>, b: Option<&Value>| text(truthy(a).or_else(|| truthy(b)).as_ref());
    tools
        .iter()
        .map(|tool| {
            let function = tool.get("function");
            let kind = text(tool.get("type"));
            let name = either(tool.get("name"), function.and_then(|f| f.get("name")));
            let description = either(tool.get("description"), function.and_then(|f| f.get("description")));
            let parameters = truthy(tool.get("parameters"))
                .or_else(|| truthy(tool.get("inputSchema")))
                .or_else(|| truthy(function.and_then(|f| f.get("parameters"))))
                .unwrap_or(Value::Null);
            json!({
                "type": if kind.is_empty() { "function".to_owned() } else { kind },
                "name": name,
                "description": description,
                "parameters": parameters,
            })
        })
        .collect()
}

/// The request's `prompt_cache_key`: the thread identity, else the key the options name, else the provider's namespace;
/// `MIXDOG_OAI_CACHE_KEY_SHARED=1` keys on the named key alone. A `shared` `promptCacheScope`, or
/// `MIXDOG_OAI_CODEX_THREAD_CACHE_KEY` of `0`/`false`, keys on the namespace and a hash of the prefix.
pub fn codex_prompt_cache_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>) -> String {
    codex_key(options, var, prefix, &LaneConfig::default())
}

pub(super) fn codex_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>, config: &LaneConfig) -> String {
    let explicit = named_keys(options).map(mixdog_js::js_trim).find(|key| !key.is_empty()).unwrap_or_default();
    let named = named_keys(options).next();
    let namespace = normalize(named.unwrap_or(NAMESPACE));
    let shared_scope = options.prompt_cache_scope.as_deref() == Some("shared");
    let shared_key = var("MIXDOG_OAI_CACHE_KEY_SHARED").as_deref() == Some("1");
    let gate = var("MIXDOG_OAI_CODEX_THREAD_CACHE_KEY").unwrap_or_default().to_lowercase();
    let lane = config.resolve("openai-oauth", &namespace, options, var);
    if !shared_scope && gate != "0" && gate != "false" {
        if shared_key {
            return fit(if explicit.is_empty() { &namespace } else { explicit }, NAMESPACE);
        }
        let thread = clean(options.thread.as_ref().map(|t| t.id.as_str()).or(options.session_id.as_deref()));
        return fit(if thread.is_empty() { explicit } else { thread }, &namespace);
    }
    let session = if shared_scope || shared_key { "" } else { clean(options.session_id.as_deref()) };
    prefix_key("openai-oauth", &namespace, options, prefix, session, lane)
}

/// The namespace and a hash of the prefix (the second half of `buildStableProviderPromptCacheKey`), `session` empty
/// for a key shared across sessions.
fn prefix_key(provider: &str, namespace: &str, options: &RequestOptions, prefix: &Prefix<'_>, session: &str, lane: lanes::Lane) -> String {
    let (slot, shards, suffix) = lane.key_parts();
    let seed = json!({
        "provider": provider,
        "model": clean(Some(prefix.model)),
        "instructions": clean(Some(prefix.instructions)),
        "tools": summarize_tools(prefix.tools),
        "effort": clean(prefix.effort.or(options.effort.as_deref())),
        "fast": options.fast,
        "serviceTier": clean(prefix.service_tier),
        "parallelToolCalls": true,
        "cacheLaneSlot": slot,
        "cacheLaneShards": shards,
        "session": if session.is_empty() { Value::Null } else { json!(session) },
    });
    let digest = Sha256::digest(mixdog_js::json_stringify_sorted(&seed).as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).take(9).collect();
    let head: String = namespace.chars().take((LIMIT - hash.len() - suffix.len() - 1).max(1)).collect();
    format!("{head}-{hash}{suffix}")
}

/// The public API's `prompt_cache_key` (`buildStableProviderPromptCacheKey('openai', opts, prefix)`): the named key (else
/// `mixdog-openai`) as the namespace, and a hash of the prefix and the session (none under the shared scope or
/// `MIXDOG_OAI_CACHE_KEY_SHARED=1`).
pub fn public_prompt_cache_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>) -> String {
    public_key(options, var, prefix, &LaneConfig::default())
}

pub(super) fn public_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>, config: &LaneConfig) -> String {
    let named = named_keys(options).next();
    let namespace = normalize(named.unwrap_or("mixdog-openai"));
    let shared = options.prompt_cache_scope.as_deref() == Some("shared") || var("MIXDOG_OAI_CACHE_KEY_SHARED").as_deref() == Some("1");
    let session = clean(options.session_id.as_deref());
    let lane = config.resolve("openai", &namespace, options, var);
    prefix_key("openai", &namespace, options, prefix, if shared { "" } else { session }, lane)
}

/// The process environment, for the callers that have no injected one.
pub fn process_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("cache_key_cases.json");

    /// The prompt cache key is stable across releases: each case of `cache_key_cases.json` (options, prefix and
    /// environment) keeps the key it has always had, so a provider-side cache keeps hitting.
    #[test]
    fn every_key_is_the_one_it_always_was() {
        let recorded: Value = serde_json::from_str(CASES).unwrap();
        for case in recorded.as_array().unwrap() {
            let text = |v: &Value| v.as_str().map(str::to_owned);
            let o = &case["options"];
            let options = RequestOptions {
                session_id: text(&o["sessionId"]),
                // Node's `codexSessionId` is the thread identity here; it outranks `sessionId`.
                thread: text(&o["codexSessionId"]).map(|id| mixdog_core_api::domain::provider::RequestThread {
                    id: id.as_str().into(),
                    window: 0,
                    turn: None,
                    turn_started_at_ms: None,
                }),
                prompt_cache_key: text(&o["promptCacheKey"]),
                prompt_cache_scope: text(&o["promptCacheScope"]),
                effort: text(&o["effort"]),
                fast: o["fast"] == true,
                ..RequestOptions::default()
            };
            let p = &case["prefix"];
            let tools = p["tools"].as_array().cloned().unwrap_or_default();
            let prefix = Prefix {
                model: p["model"].as_str().unwrap_or_default(),
                instructions: p["instructions"].as_str().unwrap_or_default(),
                tools: &tools,
                effort: p["effort"].as_str(),
                service_tier: p["serviceTier"].as_str(),
            };
            let env = |name: &str| case["env"][name].as_str().map(str::to_owned);
            assert_eq!(codex_prompt_cache_key(&options, &env, &prefix), case["key"].as_str().unwrap(), "{}", case["name"]);
        }
    }
}
