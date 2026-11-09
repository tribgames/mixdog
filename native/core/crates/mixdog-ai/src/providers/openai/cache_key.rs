//! The `prompt_cache_key` of the Codex route: Node's `buildStableProviderPromptCacheKey` for `openai-oauth`
//! (`agent-runtime/cache-strategy.mjs`, `codexThreadPromptCacheKey`). The key is the thread's identity, clamped to the
//! backend's 64 characters: Codex gives every request of a thread the same id, and the backend derives the thread's
//! prompt-cache slot from it. The provider's namespace (`mixdog-codex`, what the session stores as its `promptCacheKey`)
//! is only the key of a request that has no thread identity. Pure.

use mixdog_core_api::domain::provider::RequestOptions;
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

/// The request's `prompt_cache_key`: the session id of its options (the thread's identity: Node's `codexSessionId`, else
/// its `sessionId`), else the key the options name, else the provider's namespace.
pub fn codex_prompt_cache_key(options: &RequestOptions) -> String {
    let explicit = options.prompt_cache_key.as_deref().map_or("", mixdog_js::js_trim);
    let namespace = normalize(if explicit.is_empty() { NAMESPACE } else { explicit });
    let session = options.session_id.as_deref().map_or("", mixdog_js::js_trim);
    fit(if session.is_empty() { explicit } else { session }, &namespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(session: Option<&str>, key: Option<&str>) -> RequestOptions {
        RequestOptions { session_id: session.map(Into::into), prompt_cache_key: key.map(Into::into), ..RequestOptions::default() }
    }

    /// Node's own function (`buildStableProviderPromptCacheKey('openai-oauth', opts, {})`, `b6f10295a`) on these inputs.
    #[test]
    fn the_key_is_nodes() {
        let thread = "01a1c203-1d1e-7689-970e-9d71ae87052b";
        let long = "x".repeat(80);
        let cases = [
            (options(Some(thread), Some("mixdog-codex")), thread),
            (options(None, Some("mixdog-codex")), "mixdog-codex"),
            (options(None, None), "mixdog-codex"),
            (options(None, Some(" my key! ")), "my-key"),
            (options(None, Some(&long)), "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-9d79e0a38536"),
            (options(Some("sess_1_2_3"), Some("mixdog-codex")), "sess_1_2_3"),
            (options(Some(&"a".repeat(70)), None), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-b90ee15e82e8"),
            (options(None, Some("ä-ö")), "mixdog-shared"),
        ];
        for (options, key) in cases {
            assert_eq!(codex_prompt_cache_key(&options), key, "{options:?}");
        }
    }
}
