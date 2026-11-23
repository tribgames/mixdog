use mixdog_agent::cache_scope::{SHARED, is_one_shot_maintenance};
use mixdog_agent::compact::settings::{Doc, normalize_auto_clear, resolve_idle_ms};
use mixdog_ai::providers::compat::CompatProfile;
use mixdog_ai::providers::compat::profile::Wire;
use mixdog_ai::providers::compat::wire_route::{WireFacts, resolve_wire};
use mixdog_ai::providers::google::maas::vertex_model;
use mixdog_ai::providers::google::serving::Wire as VertexWire;
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::config::hidden_agents::hidden_agent_traits;

/// The route a session's requests take: its provider, its model and the wire pinned for them.
struct CacheRoute<'a> {
    provider: &'a str,
    model: &'a str,
    wire_route: Option<&'a Value>,
}

impl<'a> CacheRoute<'a> {
    fn of(header: &'a Header) -> Self {
        let field = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or("");
        Self { provider: field("provider"), model: field("model"), wire_route: header.get("wireRoute") }
    }
}

/// Claude on OpenRouter's Messages wire, as the adapter resolved it for the session: a Claude model (the family OpenRouter's
/// profile sends on Messages, the one its 1 h guide covers) whose wire pinned for this provider and model is Messages. The
/// pin is the adapter's own answer (a user's per-model wire, an old session's starting wire, the Chat fallback after a
/// Messages refusal), written before the session's first request on the route; while none is written the route states
/// no strategy, as nothing has decided the wire yet. Another model a user pins to Messages is not Claude: none either.
fn openrouter_claude_messages(route: &CacheRoute<'_>) -> bool {
    let family = resolve_wire(&CompatProfile::openrouter(), &WireFacts { model: route.model, known: true, agent: true, ..WireFacts::default() });
    let pinned = route
        .wire_route
        .filter(|pin| pin.get("provider").and_then(Value::as_str) == Some(route.provider) && pin.get("model").and_then(Value::as_str) == Some(route.model))
        .and_then(|pin| pin.get("wire").and_then(Value::as_str).and_then(Wire::parse));
    family.is_some_and(|family| family.wire == Wire::Messages) && pinned == Some(Wire::Messages)
}

/// Claude models Vertex AI documents as not taking the one-hour lifetime (its Claude prompt-caching page).
const VERTEX_CLAUDE_WITHOUT_HOUR: [&str; 4] = ["claude-3-7-sonnet", "claude-3-5-sonnet-v2", "claude-3-5-sonnet", "claude-3-opus"];

/// Claude on Vertex AI, except the models Vertex documents without the one-hour lifetime.
fn vertex_claude_with_hour(model: &str) -> bool {
    vertex_model(model).is_ok_and(|model| {
        let base = model.id.split('@').next().unwrap_or_default().to_ascii_lowercase();
        model.wire == VertexWire::Claude && !VERTEX_CLAUDE_WITHOUT_HOUR.contains(&base.as_str())
    })
}

/// Whether the session's requests are Anthropic Messages bodies whose breakpoints the route takes at a `1h` lifetime:
/// Anthropic itself, Claude on Vertex AI (the API-key body, `vertex_body`) where Vertex documents the hour, and Claude on
/// OpenRouter's Messages wire, whose prompt-caching guide documents `"ttl": "1h"` for every Claude provider. The other
/// Messages routes (custom endpoints, OpenCode Go, Command Code, DeepSeek) keep the codec's default tail: nothing
/// documents that they keep a marked prefix for an hour, and DeepSeek ignores the markers.
fn writes_hour_breakpoints(route: &CacheRoute<'_>) -> bool {
    match route.provider {
        "anthropic" | "anthropic-oauth" => true,
        "vertex-ai" => vertex_claude_with_hour(route.model),
        "openrouter" => openrouter_claude_messages(route),
        _ => false,
    }
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
    agent.and_then(hidden_agent_traits).is_some_and(|(kind, profile)| is_one_shot_maintenance(kind.as_deref(), profile.as_deref()))
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

fn cache_strategy(agent: Option<&str>, auto_clear: &Doc, env_ttl: &str) -> Value {
    if is_one_shot(agent) {
        return json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": "none" });
    }
    let messages = lead_messages_ttl(auto_clear);
    let messages = if matches!(env_ttl, "1h" | "5m" | "none") { env_ttl } else { messages };
    json!({ "tools": "none", "system": "1h", "tier3": "1h", "messages": messages })
}

fn opts_with(route: &CacheRoute<'_>, agent: Option<&str>, auto_clear: &Value, env_ttl: &str) -> Option<Value> {
    let mut opts = Map::new();
    if writes_hour_breakpoints(route) {
        // Node read the idle window only for a Lead-class session; every non-one-shot session reads it now (see `cache_strategy`).
        let mut idle = Doc::new();
        if !is_one_shot(agent) {
            idle = normalize_auto_clear(Some(auto_clear));
            let config: Doc = [("autoClear".to_owned(), auto_clear.clone())].into_iter().collect();
            idle.insert("idleMs".into(), mixdog_js::json_number(resolve_idle_ms(&config, Some(&Value::from(route.provider)))));
        }
        opts.insert("cacheStrategy".into(), cache_strategy(agent, &idle, env_ttl));
    }
    if is_one_shot(agent) {
        opts.insert("promptCacheScope".into(), Value::from(SHARED));
    }
    (!opts.is_empty()).then_some(Value::Object(opts))
}

/// `buildSessionProviderCacheOpts(provider, sessionId, agent, config, session)` for a call outside any session on
/// `provider`'s `model`, sent on `wire` (the adapter's resolution for the call; `None` for a provider of one wire);
/// `auto_clear` is the config's `autoClear` section. `None` when the route and the agent state no policy.
pub fn call_cache_opts(provider: &str, model: &str, wire: Option<&str>, agent: Option<&str>, auto_clear: &Value) -> Option<Value> {
    let agent = agent.filter(|a| !a.is_empty());
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    let pin = wire.map(|wire| json!({ "provider": provider, "model": model, "wire": wire }));
    opts_with(&CacheRoute { provider, model, wire_route: pin.as_ref() }, agent, auto_clear, env.trim())
}

/// [`session_provider_cache_opts`] for the route `header` names: its model and pinned wire decide whether a gateway's
/// requests are Anthropic Messages bodies.
pub fn route_cache_opts(header: &Header, agent: Option<&str>, auto_clear: &Value) -> Option<Value> {
    let agent = agent.filter(|a| !a.is_empty());
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    opts_with(&CacheRoute::of(header), agent, auto_clear, env.trim())
}

pub fn stamp_cache_opts(header: &mut Header, auto_clear: &Value) {
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    stamp_cache_opts_with_env(header, auto_clear, env.trim());
}

/// [`stamp_cache_opts`] with `MIXDOG_CACHE_MESSAGES_TTL` stated (it overrides every non-one-shot tail).
pub fn stamp_cache_opts_with_env(header: &mut Header, auto_clear: &Value, env_ttl: &str) {
    let agent = Some(text(header, "agent")).filter(|agent| !agent.is_empty());
    let opts = opts_with(&CacheRoute::of(header), agent.as_deref(), auto_clear, env_ttl);
    header.insert("providerCacheOpts".into(), opts.unwrap_or(Value::Null));
    header.insert("providerCacheOptsOverride".into(), Value::Bool(false));
}

pub fn refreshed_cache_opts(header: &Header, auto_clear: &Value) -> Option<Value> {
    let env = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    refreshed_with_env(header, auto_clear, env.trim())
}

/// [`refreshed_cache_opts`] with `MIXDOG_CACHE_MESSAGES_TTL` stated (it overrides every non-one-shot tail, so a machine that sets it
/// is not a machine the saved window can show on). A policy the route no longer takes (a wire that moved off Messages) is
/// cleared to `null`, as a header stamped on such a route holds.
fn refreshed_with_env(header: &Header, auto_clear: &Value, env_ttl: &str) -> Option<Value> {
    if header.get("providerCacheOptsOverride") == Some(&Value::Bool(true)) {
        return None;
    }
    let agent = Some(text(header, "agent")).filter(|agent| !agent.is_empty());
    let next = opts_with(&CacheRoute::of(header), agent.as_deref(), auto_clear, env_ttl).unwrap_or(Value::Null);
    (header.get("providerCacheOpts").unwrap_or(&Value::Null) != &next).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct() -> CacheRoute<'static> {
        CacheRoute { provider: "anthropic-oauth", model: "", wire_route: None }
    }

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
        let on_5m = lead(opts_with(&direct(), None, &json!({ "enabled": true, "idleMs": 600_000 }), "").unwrap());
        assert_eq!(on_5m["providerCacheOpts"]["cacheStrategy"]["messages"], "5m");
        assert_eq!(messages_of(&on_5m, json!({ "enabled": true, "idleMs": 600_000 })), None, "a header on the saved window is left alone");
        assert_eq!(messages_of(&on_5m, json!({ "enabled": false })), Some(json!("1h")));
        assert_eq!(messages_of(&on_5m, json!({ "enabled": true, "idleMs": 3_600_000 })), Some(json!("1h")));
        let on_1h = lead(refreshed_with_env(&on_5m, &json!({ "enabled": false }), "").unwrap());
        assert_eq!(messages_of(&on_1h, json!({ "enabled": true, "idleMs": 600_000 })), Some(json!("5m")));
    }

    /// An explicit policy keeps what it holds; a stamped one on a provider that takes no policy is cleared; a delegated
    /// worker and an internal role follow the saved `autoClear` like a Lead.
    #[test]
    fn only_an_explicit_policy_is_left_alone_and_one_no_route_takes_is_cleared() {
        let held = json!({ "cacheStrategy": { "messages": "5m" } });
        let off = json!({ "enabled": false });
        let mut overridden = lead(held.clone());
        overridden.insert("providerCacheOptsOverride".into(), json!(true));
        assert_eq!(refreshed_cache_opts(&overridden, &off), None);
        let mut other = lead(held.clone());
        other.insert("provider".into(), json!("xai"));
        assert_eq!(refreshed_cache_opts(&other, &off), Some(Value::Null));
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
        let anthropic = CacheRoute { provider: "anthropic", model: "", wire_route: None };
        let policy = |agent, ttl| opts_with(&anthropic, agent, &Value::Null, ttl).unwrap()["cacheStrategy"]["messages"].clone();
        assert_eq!(policy(Some("worker"), "1h"), "1h");
        assert_eq!(policy(None, "none"), "none");
        assert_eq!(policy(None, "bogus"), "1h");
        assert_eq!(policy(Some("title-agent"), "1h"), "none");
        let pin = json!({ "provider": "openrouter", "model": "anthropic/claude-sonnet-5", "wire": "messages" });
        let openrouter = CacheRoute { provider: "openrouter", model: "anthropic/claude-sonnet-5", wire_route: Some(&pin) };
        assert_eq!(opts_with(&openrouter, Some("worker"), &Value::Null, "5m").unwrap()["cacheStrategy"]["messages"], "5m");
    }

    fn on_route(provider: &str, model: &str, pin: Option<&str>, agent: &str) -> Header {
        let mut header = Header::new();
        for (key, value) in [("id", "sess_1"), ("provider", provider), ("model", model)] {
            header.insert(key.into(), json!(value));
        }
        if let Some(wire) = pin {
            header.insert("wireRoute".into(), json!({ "provider": provider, "model": model, "wire": wire, "source": "override" }));
        }
        if !agent.is_empty() {
            header.insert("agent".into(), json!(agent));
            header.insert("owner".into(), json!("agent"));
        }
        header
    }

    fn stamped_on(provider: &str, model: &str, pin: Option<&str>, agent: &str, auto_clear: &Value) -> Value {
        let mut header = on_route(provider, model, pin, agent);
        stamp_cache_opts_with_env(&mut header, auto_clear, "");
        header["providerCacheOpts"].clone()
    }

    /// Claude through OpenRouter's Messages wire (the wire the adapter pinned for it) and Claude on Vertex AI are written
    /// with the direct route's breakpoints, so the same settings give them the direct route's strategy, for a Lead, a worker
    /// and a one-shot role alike; a provider's own idle window decides its tail.
    #[test]
    fn a_breakpoint_route_gets_the_direct_routes_strategy_from_the_same_settings() {
        let routes = [
            ("openrouter", "anthropic/claude-sonnet-5", Some("messages")),
            ("openrouter", "~anthropic/claude-opus-latest", Some("messages")),
            ("vertex-ai", "claude-sonnet-4-6", None),
            ("vertex-ai", "publishers/anthropic/models/claude-opus-4-8", None),
        ];
        let settings = [json!({ "enabled": false }), json!({ "enabled": true, "idleMs": 3_600_000 }), json!({ "enabled": true, "idleMs": 600_000 })];
        for auto_clear in &settings {
            for agent in ["", "worker", "title-agent"] {
                let expected = stamped_on("anthropic-oauth", "claude-sonnet-5", None, agent, auto_clear);
                assert!(expected.get("cacheStrategy").is_some(), "{agent} {auto_clear}");
                for (provider, model, pin) in routes {
                    assert_eq!(stamped_on(provider, model, pin, agent, auto_clear), expected, "{provider} {model} {agent} {auto_clear}");
                }
            }
        }
        let own = json!({ "enabled": true, "idleMs": 600_000, "providerIdleMs": { "openrouter": 3_600_000 } });
        assert_eq!(stamped_on("openrouter", "anthropic/claude-sonnet-5", Some("messages"), "worker", &own)["cacheStrategy"]["messages"], "1h");
        assert_eq!(stamped_on("anthropic-oauth", "claude-sonnet-5", None, "worker", &own)["cacheStrategy"]["messages"], "5m");
    }

    /// Routes whose requests are not Anthropic breakpoint bodies, or whose longer tail nothing documents, keep the header
    /// they had: no strategy, and a one-shot role only its shared scope.
    #[test]
    fn routes_left_alone_keep_their_header() {
        let left = [
            ("openrouter", "openai/gpt-6.1-sol", None),
            ("openrouter", "google/gemini-3.1-pro-preview", None),
            ("openrouter", "anthropic/claude-sonnet-5", Some("chat")),
            ("openrouter", "anthropic/claude-sonnet-5", None),
            ("openrouter", "z-ai/glm-5", Some("messages")),
            ("vertex-ai", "claude-3-7-sonnet", None),
            ("vertex-ai", "claude-3-5-sonnet-v2@20241022", None),
            ("vertex-ai", "claude-3-5-sonnet", None),
            ("vertex-ai", "publishers/anthropic/models/claude-3-opus", None),
            ("custom-gw", "claude-sonnet-5", Some("messages")),
            ("opencode-go-oauth", "claude-sonnet-5", None),
            ("command-code-oauth", "claude-sonnet-5", Some("messages")),
            ("deepseek", "deepseek-v4-pro", Some("messages")),
            ("vertex-ai", "gemini-3-pro", None),
            ("openai-oauth", "gpt-6.2-sol", None),
        ];
        let off = json!({ "enabled": false });
        for (provider, model, pin) in left {
            assert_eq!(stamped_on(provider, model, pin, "worker", &off), Value::Null, "{provider} {model}");
            assert_eq!(stamped_on(provider, model, pin, "title-agent", &off), json!({ "promptCacheScope": "shared" }), "{provider} {model}");
            let mut held = on_route(provider, model, pin, "worker");
            held.insert("providerCacheOpts".into(), Value::Null);
            assert_eq!(refreshed_with_env(&held, &off, ""), None, "{provider} {model}");
        }
    }

    /// The policy follows the wire the adapter resolved for the session: a route change into OpenRouter's Claude (whose pin
    /// still names the old route) states none until the adapter pins Messages; a pin moved to Chat (a user's per-model wire,
    /// or the fallback after a Messages refusal) clears it on the next refresh; a model on another wire states none.
    #[test]
    fn the_policy_follows_the_wire_pinned_for_the_route() {
        let off = json!({ "enabled": false });
        let mut header = on_route("anthropic-oauth", "claude-sonnet-5", None, "");
        stamp_cache_opts_with_env(&mut header, &off, "");
        let direct_opts = header["providerCacheOpts"].clone();
        header.insert("wireRoute".into(), json!({ "provider": "anthropic-oauth", "model": "claude-sonnet-5", "wire": "messages" }));
        header.insert("provider".into(), json!("openrouter"));
        header.insert("model".into(), json!("anthropic/claude-sonnet-5"));
        assert_eq!(opts_with(&CacheRoute::of(&header), None, &off, ""), None, "no wire is resolved for the new route yet");
        header.insert("wireRoute".into(), json!({ "provider": "openrouter", "model": "anthropic/claude-sonnet-5", "wire": "messages", "source": "family" }));
        assert_eq!(opts_with(&CacheRoute::of(&header), None, &off, ""), Some(direct_opts.clone()));
        header.insert("providerCacheOpts".into(), direct_opts);
        header.insert("wireRoute".into(), json!({ "provider": "openrouter", "model": "anthropic/claude-sonnet-5", "wire": "chat", "source": "reroute" }));
        assert_eq!(refreshed_with_env(&header, &off, ""), Some(Value::Null), "the fallback to Chat clears the strategy");
        header.insert("wireRoute".into(), json!({ "provider": "openrouter", "model": "openai/gpt-6.1-sol", "wire": "messages" }));
        header.insert("model".into(), json!("openai/gpt-6.1-sol"));
        assert_eq!(opts_with(&CacheRoute::of(&header), None, &off, ""), None);
    }
}
