//! The `prompt_cache_key` of the Codex route: Node's `buildStableProviderPromptCacheKey` for `openai-oauth`
//! (`agent-runtime/cache-strategy.mjs`, `codexThreadPromptCacheKey`). The key is the thread's identity, clamped to the
//! backend's 64 characters: Codex gives every request of a thread the same id, and the backend derives the thread's
//! prompt-cache slot from it. The provider's namespace (`mixdog-codex`, what the session stores as its `promptCacheKey`)
//! is only the key of a request that has no thread identity. Pure.

use mixdog_core_api::domain::provider::RequestOptions;
use serde_json::{Value, json};
use sha2::Digest;
use sha2::Sha256;

const NAMESPACE: &str = "mixdog-codex";
const SHARED: &str = "mixdog-shared";
/// The backend's limit.
const LIMIT: usize = 64;

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

/// The request's `prompt_cache_key` (`buildStableProviderPromptCacheKey('openai-oauth', opts, prefix)`).
///
/// By default the thread's identity (Node's `codexSessionId`, else its `sessionId`), else the key the options name,
/// else the provider's namespace; `MIXDOG_OAI_CACHE_KEY_SHARED=1` keys on the named key alone. A one-shot role
/// (`promptCacheScope: shared`) or `MIXDOG_OAI_CODEX_THREAD_CACHE_KEY` of `0`/`false` keys on the prefix instead: the
/// namespace and a hash of the prefix (without the session under the shared scope or the shared-key switch).
pub fn codex_prompt_cache_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>) -> String {
    let explicit = clean(options.prompt_cache_key.as_deref());
    // `resolveProviderCacheKey`: the key as given (untrimmed) when it is not empty.
    let named = options.prompt_cache_key.as_deref().filter(|k| !k.is_empty());
    let namespace = normalize(named.unwrap_or(NAMESPACE));
    let shared_scope = options.prompt_cache_scope.as_deref() == Some("shared");
    let shared_key = var("MIXDOG_OAI_CACHE_KEY_SHARED").as_deref() == Some("1");
    // Node keys on `codexSessionId`, the wire identity the thread names, before the session's own id.
    let session = clean(options.thread.as_ref().map(|t| t.id.as_str()).or(options.session_id.as_deref()));
    let gate = var("MIXDOG_OAI_CODEX_THREAD_CACHE_KEY").unwrap_or_default().to_lowercase();
    if !shared_scope && gate != "0" && gate != "false" {
        if shared_key {
            return fit(if explicit.is_empty() { &namespace } else { explicit }, NAMESPACE);
        }
        return fit(if session.is_empty() { explicit } else { session }, &namespace);
    }
    prefix_key("openai-oauth", &namespace, options, prefix, if shared_scope || shared_key { "" } else { session })
}

/// The namespace and a hash of the prefix (the second half of `buildStableProviderPromptCacheKey`), `session` empty
/// for a key shared across sessions.
fn prefix_key(provider: &str, namespace: &str, options: &RequestOptions, prefix: &Prefix<'_>, session: &str) -> String {
    // The default lane (no shard setting) leaves the lane fields out of the seed.
    let seed = json!({
        "provider": provider,
        "model": clean(Some(prefix.model)),
        "instructions": clean(Some(prefix.instructions)),
        "tools": summarize_tools(prefix.tools),
        "effort": clean(prefix.effort.or(options.effort.as_deref())),
        "fast": options.fast,
        "serviceTier": clean(prefix.service_tier),
        "parallelToolCalls": true,
        "cacheLaneSlot": Value::Null,
        "cacheLaneShards": Value::Null,
        "session": if session.is_empty() { Value::Null } else { json!(session) },
    });
    let digest = Sha256::digest(mixdog_js::json_stringify_sorted(&seed).as_bytes());
    let hash: String = digest.iter().map(|b| format!("{b:02x}")).take(9).collect();
    let head: String = namespace.chars().take((LIMIT - hash.len() - 1).max(1)).collect();
    format!("{head}-{hash}")
}

/// The public API's `prompt_cache_key` (`buildStableProviderPromptCacheKey('openai', opts, prefix)`): the named key (else
/// `mixdog-openai`) as the namespace, and a hash of the prefix and the session (none under the shared scope or
/// `MIXDOG_OAI_CACHE_KEY_SHARED=1`).
pub fn public_prompt_cache_key(options: &RequestOptions, var: &dyn Fn(&str) -> Option<String>, prefix: &Prefix<'_>) -> String {
    let named = options.prompt_cache_key.as_deref().filter(|k| !k.is_empty());
    let namespace = normalize(named.unwrap_or("mixdog-openai"));
    let shared = options.prompt_cache_scope.as_deref() == Some("shared") || var("MIXDOG_OAI_CACHE_KEY_SHARED").as_deref() == Some("1");
    let session = clean(options.session_id.as_deref());
    prefix_key("openai", &namespace, options, prefix, if shared { "" } else { session })
}

/// The process environment, for the callers that have no injected one.
pub fn process_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/cache-key-cases.json");
    const CAPTURE: &str = include_str!("../../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/node-cache-key-capture.mjs");
    const RECORDING: &str = include_str!("../../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/node-cache-keys.json");

    fn sha256(text: &str) -> String {
        Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Node's own function (`buildStableProviderPromptCacheKey('openai-oauth', opts, prefix)`, b6f10295a) recorded on
    /// every case of `cache-key-cases.json` (`node-cache-key-capture.mjs`): the key of each is the recording's.
    #[test]
    fn every_key_is_nodes() {
        let recording: Value = serde_json::from_str(RECORDING).unwrap();
        let manifest = &recording["manifest"];
        assert_eq!(manifest["exact"], true);
        assert_eq!(manifest["nodeCommit"], "b6f10295a");
        assert_eq!(manifest["casesSha256"], sha256(CASES), "cache-key-cases.json changed since the recording");
        assert_eq!(manifest["harness"]["node-cache-key-capture.mjs"], sha256(CAPTURE), "the capture script changed since the recording");
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let recorded = recording["cases"].as_array().unwrap();
        assert_eq!(cases["cases"].as_array().unwrap().len(), recorded.len(), "the recording has other cases than the inputs");
        for case in recorded {
            let text = |v: &Value| v.as_str().map(str::to_owned);
            let o = &case["options"];
            let options = RequestOptions {
                session_id: text(&o["sessionId"]),
                // Node's `codexSessionId` is the thread identity here; it outranks `sessionId`.
                thread: text(&o["codexSessionId"]).map(|id| mixdog_core_api::domain::provider::RequestThread { id: id.as_str().into(), window: 0, turn: None, turn_started_at_ms: None }),
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
            assert_eq!(
                codex_prompt_cache_key(&options, &env, &prefix),
                case["key"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}