//! `buildSessionProviderCacheOpts(provider, sessionId, agent, config, session)`
//! (`session-lifecycle.mjs`) with `cache-strategy.mjs` behind it: the cache policy a session carries
//! in `providerCacheOpts`. An explicit-breakpoint provider (Anthropic) gets the four-slot
//! `cacheStrategy`; every provider gets `promptCacheScope: "shared"` for a one-shot maintenance role.
//!
//! The one-shot test is `mixdog_agent::cache_scope`, the idle window is `compact::settings`, the
//! internal agents are `ai_admin::hidden_agents` and the session ids are `rooms::ids`; nothing here
//! is a second copy of them.

use mixdog_agent::cache_scope::{SHARED, is_one_shot_maintenance};
use mixdog_agent::compact::settings::{Doc, normalize_auto_clear, resolve_idle_ms};
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use mixdog_core_config::config::hidden_agents::hidden_agent_traits;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;

/// `PROVIDER_CACHE_CAPABILITY`: the providers whose cache is written with explicit breakpoints.
fn is_explicit_breakpoint(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth")
}

fn text(header: &Header, key: &str) -> String {
    match header.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// `isAgentOwner(session)`: a delegated worker.
fn is_agent_owner(header: &Header) -> bool {
    text(header, "owner").trim().to_lowercase() == "agent"
}

/// `resolveSessionMode({ session }).mode === "agent"` for a record with no stored mode.
fn resolves_to_agent_mode(header: &Header) -> bool {
    if is_agent_owner(header) || text(header, "visibility") == "agent-only" {
        return false;
    }
    let id = text(header, "id");
    let owner_agent = text(header, "ownerAgentId");
    let owner_agent = owner_agent.trim();
    room_member_of_session(&id).is_some()
        || agent_id_of_home_session(&id).is_some()
        || (!owner_agent.is_empty() && agent_home_session_id(owner_agent).is_some())
}

/// `isAgentModeSession(session)`: the stored mode, else the one the record's ids resolve to.
pub fn is_agent_mode_session(header: &Header) -> bool {
    match header.get("sessionMode").and_then(Value::as_str) {
        Some("agent") => true,
        Some("coding") => false,
        _ => resolves_to_agent_mode(header),
    }
}

/// `isLeadCacheClass(agent, session)`: the Lead, a raw caller and an agent-mode Lead; never an
/// internal role or a delegated worker.
fn is_lead_cache_class(agent: Option<&str>, header: &Header) -> bool {
    if agent.is_some_and(|a| hidden_agent_traits(a).is_some()) || is_agent_owner(header) {
        return false;
    }
    agent.is_none_or(|a| a == "lead") || is_agent_mode_session(header)
}

/// `isOneShotMaintenanceAgent(agent)`.
fn is_one_shot(agent: Option<&str>) -> bool {
    agent
        .and_then(hidden_agent_traits)
        .is_some_and(|(kind, profile)| is_one_shot_maintenance(kind.as_deref(), profile.as_deref()))
}

/// `resolveLeadMessagesTtl(autoClear)`: the Lead's message tail lives as long as the idle sweep lets it.
fn lead_messages_ttl(auto_clear: &Doc) -> &'static str {
    if auto_clear.get("enabled") == Some(&Value::Bool(false)) {
        return "1h";
    }
    match auto_clear.get("idleMs").and_then(Value::as_f64) {
        Some(idle) if idle >= 3_600_000.0 => "1h",
        _ => "5m",
    }
}

/// `resolveCacheStrategy(agent, { autoClear, session })`; `env_ttl` is `MIXDOG_CACHE_MESSAGES_TTL`.
fn cache_strategy(agent: Option<&str>, header: &Header, auto_clear: &Doc, env_ttl: &str) -> Value {
    if is_one_shot(agent) {
        return json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": "none" });
    }
    let messages = if is_lead_cache_class(agent, header) { lead_messages_ttl(auto_clear) } else { "5m" };
    let messages = if matches!(env_ttl, "1h" | "5m" | "none") { env_ttl } else { messages };
    json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": messages })
}

fn opts_with(provider: &str, agent: Option<&str>, header: &Header, auto_clear: &Value, env_ttl: &str) -> Option<Value> {
    let mut opts = Map::new();
    if is_explicit_breakpoint(provider) {
        // The idle window is read only for a Lead-class session, as Node loads it.
        let mut lead = Doc::new();
        if is_lead_cache_class(agent, header) {
            lead = normalize_auto_clear(Some(auto_clear));
            let config: Doc = [("autoClear".to_owned(), auto_clear.clone())].into_iter().collect();
            lead.insert("idleMs".into(), mixdog_js::json_number(resolve_idle_ms(&config, Some(&Value::from(provider)))));
        }
        opts.insert("cacheStrategy".into(), cache_strategy(agent, header, &lead, env_ttl));
    }
    if is_one_shot(agent) {
        opts.insert("promptCacheScope".into(), Value::from(SHARED));
    }
    (!opts.is_empty()).then_some(Value::Object(opts))
}

/// `buildSessionProviderCacheOpts(provider, sessionId, agent, config, session)` for the session
/// whose header is `header`; `auto_clear` is the config's `autoClear` section (Node loads the
/// config when it is not given one). `None` when the provider and the agent state no policy.
/// `session_id` is not read: the policy is per provider and agent, as in Node.
pub fn session_provider_cache_opts(provider: &str, session_id: &str, agent: Option<&str>, header: &Header, auto_clear: &Value) -> Option<Value> {
    let _ = session_id;
    let agent = agent.filter(|a| !a.is_empty());
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    opts_with(provider, agent, header, auto_clear, env.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every recorded case equals Node's answer: all agents and session shapes on the explicit
    /// providers under each auto-clear setting, and the other providers' shared scope.
    #[test]
    fn every_policy_equals_nodes() {
        let golden: Value = serde_json::from_str(include_str!("golden/session_cache_opts.json")).expect("fixture");
        let cases = golden["cases"].as_array().expect("cases");
        assert!(cases.len() > 1000);
        for case in cases {
            let header: Header = case["header"].as_object().cloned().expect("header");
            let agent = case["agent"].as_str();
            let got = opts_with(case["provider"].as_str().unwrap(), agent, &header, &case["autoClear"], "");
            assert_eq!(got.unwrap_or(Value::Null), case["opts"], "{case}");
        }
    }

    #[test]
    fn the_messages_override_applies_to_every_class_but_the_one_shot_roles() {
        let header = Header::new();
        let policy = |agent, ttl| opts_with("anthropic", agent, &header, &Value::Null, ttl).unwrap()["cacheStrategy"]["messages"].clone();
        assert_eq!(policy(Some("worker"), "1h"), "1h");
        assert_eq!(policy(None, "none"), "none");
        assert_eq!(policy(None, "bogus"), "1h");
        assert_eq!(policy(Some("title-agent"), "1h"), "none");
    }
}
