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
///
/// Departure from Node 1.4.5, chosen by the product: Node gave a delegated worker and an internal role a flat `5m` tail
/// (`isLeadCacheClass` false → `messages: '5m'`) and linked only Lead-class sessions to `autoClear`. Every session that is
/// not a one-shot maintenance role now takes the Lead rule, so an agent's tail lives as long as the idle sweep lets it. A
/// one-shot role has no later request to read a tail and keeps `messages: none`.
fn cache_strategy(agent: Option<&str>, auto_clear: &Doc, env_ttl: &str) -> Value {
    if is_one_shot(agent) {
        return json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": "none" });
    }
    let messages = lead_messages_ttl(auto_clear);
    let messages = if matches!(env_ttl, "1h" | "5m" | "none") { env_ttl } else { messages };
    json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": messages })
}

fn opts_with(provider: &str, agent: Option<&str>, auto_clear: &Value, env_ttl: &str) -> Option<Value> {
    let mut opts = Map::new();
    if is_explicit_breakpoint(provider) {
        // Node read the idle window only for a Lead-class session; every non-one-shot session reads it now (see `cache_strategy`).
        let mut idle = Doc::new();
        if !is_one_shot(agent) {
            idle = normalize_auto_clear(Some(auto_clear));
            let config: Doc = [("autoClear".to_owned(), auto_clear.clone())].into_iter().collect();
            idle.insert("idleMs".into(), mixdog_js::json_number(resolve_idle_ms(&config, Some(&Value::from(provider)))));
        }
        opts.insert("cacheStrategy".into(), cache_strategy(agent, &idle, env_ttl));
    }
    if is_one_shot(agent) {
        opts.insert("promptCacheScope".into(), Value::from(SHARED));
    }
    (!opts.is_empty()).then_some(Value::Object(opts))
}

/// `buildSessionProviderCacheOpts(provider, sessionId, agent, config, session)`; `auto_clear` is the config's `autoClear`
/// section (Node loads the config when it is not given one). `None` when the provider and the agent state no policy.
/// The policy is per provider and agent: neither the session id nor the session record is read (Node read the record only
/// to tell a Lead class from an agent, which no longer decides anything).
pub fn session_provider_cache_opts(provider: &str, agent: Option<&str>, auto_clear: &Value) -> Option<Value> {
    let agent = agent.filter(|a| !a.is_empty());
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    opts_with(provider, agent, auto_clear, env.trim())
}

/// What `createSession` records at creation (`session-lifecycle.mjs:267,295`, `sessionOriginFields`): `providerCacheOpts`
/// (null when the provider and the agent state no policy) and `providerCacheOptsOverride: false`. A delegated worker or an
/// internal role is created straight on its route, so no route change seats it and this is the only place it gets its
/// policy; without it the ledger and the tail TTL see no strategy at all. `header`
/// must already name the route (`provider`) and `agent`; `auto_clear` is the saved `autoClear` section, as the Lead path reads it.
pub fn stamp_cache_opts(header: &mut Header, auto_clear: &Value) {
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    stamp_cache_opts_with_env(header, auto_clear, env.trim());
}

/// [`stamp_cache_opts`] with `MIXDOG_CACHE_MESSAGES_TTL` stated (it overrides every non-one-shot tail).
pub fn stamp_cache_opts_with_env(header: &mut Header, auto_clear: &Value, env_ttl: &str) {
    let agent = Some(text(header, "agent")).filter(|agent| !agent.is_empty());
    let opts = opts_with(&text(header, "provider"), agent.as_deref(), auto_clear, env_ttl);
    header.insert("providerCacheOpts".into(), opts.unwrap_or(Value::Null));
    header.insert("providerCacheOptsOverride".into(), Value::Bool(false));
}

/// `refreshSessionProviderCacheOpts(session, config)` (`session-lifecycle.mjs:95`): the `providerCacheOpts` a live or resumed
/// session holds once it follows the saved `autoClear`, when that differs from the header's. Node refreshed Lead-class
/// sessions only; a delegated worker and an internal role follow it now too (see `cache_strategy`). `None` leaves the
/// session alone: an explicit caller/profile policy (`providerCacheOptsOverride`), a provider that states no policy, or a
/// header already on it.
pub fn refreshed_cache_opts(header: &Header, auto_clear: &Value) -> Option<Value> {
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    refreshed_with_env(header, auto_clear, env.trim())
}

/// [`refreshed_cache_opts`] with `MIXDOG_CACHE_MESSAGES_TTL` stated (it overrides every non-one-shot tail, so a machine that sets it
/// is not a machine the saved window can show on).
fn refreshed_with_env(header: &Header, auto_clear: &Value, env_ttl: &str) -> Option<Value> {
    if header.get("providerCacheOptsOverride") == Some(&Value::Bool(true)) {
        return None;
    }
    let agent = Some(text(header, "agent")).filter(|agent| !agent.is_empty());
    let next = opts_with(&text(header, "provider"), agent.as_deref(), auto_clear, env_ttl)?;
    (header.get("providerCacheOpts") != Some(&next)).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lead(opts: Value) -> Header {
        let mut header = Header::new();
        for (key, value) in [("id", json!("sess_1")), ("provider", json!("anthropic-oauth")), ("providerCacheOpts", opts)] {
            header.insert(key.into(), value);
        }
        header
    }

    fn messages_of(header: &Header, auto_clear: Value) -> Option<Value> {
        refreshed_with_env(header, &auto_clear, "").map(|opts| opts["cacheStrategy"]["messages"].clone())
    }

    /// Auto-clear off, or an idle window of an hour or more, moves a Lead session's message tail to 1h; a shorter window back to 5m.
    #[test]
    fn a_lead_session_follows_the_saved_auto_clear() {
        let on_5m = lead(opts_with("anthropic-oauth", None, &json!({ "enabled": true, "idleMs": 600_000 }), "").unwrap());
        assert_eq!(on_5m["providerCacheOpts"]["cacheStrategy"]["messages"], "5m");
        assert_eq!(messages_of(&on_5m, json!({ "enabled": true, "idleMs": 600_000 })), None, "a header on the saved window is left alone");
        assert_eq!(messages_of(&on_5m, json!({ "enabled": false })), Some(json!("1h")));
        assert_eq!(messages_of(&on_5m, json!({ "enabled": true, "idleMs": 3_600_000 })), Some(json!("1h")));
        let on_1h = lead(refreshed_with_env(&on_5m, &json!({ "enabled": false }), "").unwrap());
        assert_eq!(messages_of(&on_1h, json!({ "enabled": true, "idleMs": 600_000 })), Some(json!("5m")));
    }

    /// An explicit policy and a provider with no policy keep what they hold; a delegated worker and an internal role follow
    /// the saved `autoClear` like a Lead.
    #[test]
    fn only_an_explicit_policy_or_a_provider_without_one_is_left_alone() {
        let held = json!({ "cacheStrategy": { "messages": "5m" } });
        let off = json!({ "enabled": false });
        let mut overridden = lead(held.clone());
        overridden.insert("providerCacheOptsOverride".into(), json!(true));
        assert_eq!(refreshed_cache_opts(&overridden, &off), None);
        let mut other = lead(held.clone());
        other.insert("provider".into(), json!("xai"));
        assert_eq!(refreshed_cache_opts(&other, &off), None);
        for (key, value) in [("owner", "agent"), ("agent", "explore-agent")] {
            let mut follower = lead(held.clone());
            follower.insert(key.into(), json!(value));
            assert_eq!(refreshed_with_env(&follower, &off, "").map(|opts| opts["cacheStrategy"]["messages"].clone()), Some(json!("1h")), "{key}");
        }
    }

    fn created(provider: &str, agent: &str) -> Header {
        let mut header = Header::new();
        for (key, value) in [("provider", provider), ("agent", agent), ("owner", "agent")] {
            header.insert(key.into(), json!(value));
        }
        header
    }

    fn stamped(provider: &str, agent: &str, auto_clear: Value) -> Header {
        let mut header = created(provider, agent);
        stamp_cache_opts_with_env(&mut header, &auto_clear, "");
        header
    }

    /// A delegated worker is created straight on its route, so creation itself records the policy, resolved as a Lead with the
    /// saved `autoClear` would resolve it (the product's departure from Node's flat `5m`), not left to a route change.
    #[test]
    fn a_created_agent_session_records_the_lead_rule_for_its_saved_auto_clear() {
        let tail = |auto_clear| stamped("anthropic-oauth", "worker", auto_clear)["providerCacheOpts"]["cacheStrategy"]["messages"].clone();
        assert_eq!(tail(json!({ "enabled": false })), "1h");
        assert_eq!(tail(json!({ "enabled": true, "idleMs": 3_600_000 })), "1h");
        assert_eq!(tail(json!({ "enabled": true, "idleMs": 600_000 })), "5m");
        let worker = stamped("anthropic-oauth", "worker", json!({ "enabled": true, "idleMs": 600_000 }));
        assert_eq!(worker["providerCacheOpts"], json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "5m" } }));
        assert_eq!(worker["providerCacheOptsOverride"], json!(false));
        let role = stamped("anthropic-oauth", "title-agent", json!({ "enabled": false }));
        assert_eq!(role["providerCacheOpts"]["cacheStrategy"]["messages"], "none", "a one-shot role marks no tail whatever autoClear says");
        assert_eq!(role["providerCacheOpts"]["promptCacheScope"], "shared");
        assert_eq!(stamped("openai-oauth", "worker", Value::Null)["providerCacheOpts"], Value::Null, "a key-prefix provider states no breakpoint policy");
    }

    /// A changed saved `autoClear` reaches a live agent session the way it reaches a Lead.
    #[test]
    fn a_changed_auto_clear_refreshes_a_live_agent_sessions_policy() {
        let short = json!({ "enabled": true, "idleMs": 600_000 });
        let worker = stamped("anthropic-oauth", "worker", short.clone());
        assert_eq!(messages_of(&worker, short.clone()), None);
        assert_eq!(messages_of(&worker, json!({ "enabled": false })), Some(json!("1h")));
        let mut one_shot = stamped("anthropic-oauth", "title-agent", short);
        one_shot.insert("id".into(), json!("sess_2"));
        assert_eq!(messages_of(&one_shot, json!({ "enabled": false })), None, "a one-shot role keeps marking no tail");
    }

    #[test]
    fn the_messages_override_applies_to_every_class_but_the_one_shot_roles() {
        let policy = |agent, ttl| opts_with("anthropic", agent, &Value::Null, ttl).unwrap()["cacheStrategy"]["messages"].clone();
        assert_eq!(policy(Some("worker"), "1h"), "1h");
        assert_eq!(policy(None, "none"), "none");
        assert_eq!(policy(None, "bogus"), "1h");
        assert_eq!(policy(Some("title-agent"), "1h"), "none");
    }
}