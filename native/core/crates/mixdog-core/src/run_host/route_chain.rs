//! The fallback chain a running session follows (Node `session/manager/route-fallback-chain.mjs`,
//! `owner-route-fallbacks.mjs`, and `primaryRoute` of `setup-tool/session-route-actions.mjs`).
//!
//! A session is its stored header (`Value`), read as Node reads the live object. Every reader
//! takes the config and the bot route store at the moment of the call, so an edit made while the
//! session runs applies from its next hop.

use mixdog_ai::service::admin_route::{find_preset, normalize_workflow_route};
use mixdog_ai::service::routes::{canonical_route_provider, execution_fallbacks};
use mixdog_js::{js_trim, value_to_string};
use serde_json::{json, Map, Value};

use crate::rooms::ids::{agent_home_session_id, agent_id_of_home_session, room_member_of_session};

pub type Obj = Map<String, Value>;

pub const CODING_MODE: &str = "coding";
pub const AGENT_MODE: &str = "agent";
/// `MIXY_AGENT_ID`: the primary assistant's runtime id.
pub const MIXY_AGENT_ID: &str = "lead";

/// Where a bot's route lives (`agent-store.mjs`): the store Node keeps beside the config.
pub trait BotRoutes {
    /// The resolver `configuredAgentRouteCandidates` asks first: `None` when `agent_id` is no
    /// bot (the config decides), `Some(None)` for a bot without a route.
    fn bot_route(&self, agent_id: &str) -> Option<Option<Value>>;
    /// `storedBotRoute`: the own route of the bot a session acts as, Mixy's from its folder.
    fn stored_bot_route(&self, agent_id: &str) -> Option<Value>;
}

const LEAF_FIELDS: [&str; 6] = ["effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];

fn truthy(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| match x {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        _ => true,
    })
}

/// `String(value ?? undefined)`.
fn js_str(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `route?.[key] || ''`.
fn or_empty(v: Option<&Value>) -> Value {
    truthy(v).cloned().unwrap_or_else(|| Value::String(String::new()))
}

/// `String(value || '').trim()`.
fn clean_or_empty(v: Option<&Value>) -> String {
    truthy(v).map_or_else(String::new, |v| js_trim(&value_to_string(v)).to_owned())
}

use mixdog_js::json_number as number_value;
use mixdog_js::to_number_of as js_number;

fn model_of(route: Option<&Value>) -> Value {
    let mut out = Obj::new();
    out.insert("provider".into(), or_empty(route.and_then(|r| r.get("provider"))));
    out.insert("model".into(), or_empty(route.and_then(|r| r.get("model"))));
    Value::Object(out)
}

/// `sameRouteModel`: whether two routes name the same model, provider aliases folded.
pub fn same_route_model(a: Option<&Value>, b: Option<&Value>) -> bool {
    let provider = a.and_then(|r| r.get("provider"));
    let model = a.and_then(|r| r.get("model"));
    if truthy(provider).is_none() || truthy(model).is_none() {
        return false;
    }
    canonical_route_provider(&clean_or_empty(provider)) == canonical_route_provider(&clean_or_empty(b.and_then(|r| r.get("provider"))))
        && js_str(model) == js_str(b.and_then(|r| r.get("model")))
}

/// `routeLeaf`: the switchable fields of a route or session record (no chain).
pub fn route_leaf(route: Option<&Value>) -> Obj {
    let mut leaf = Obj::new();
    leaf.insert("provider".into(), or_empty(route.and_then(|r| r.get("provider"))));
    leaf.insert("model".into(), or_empty(route.and_then(|r| r.get("model"))));
    for key in LEAF_FIELDS {
        if let Some(v) = route.and_then(|r| r.get(key)).filter(|v| !v.is_null()) {
            leaf.insert(key.to_owned(), v.clone());
        }
    }
    leaf
}

/// `sessionRoutePrimary`: the route the session ran on before its first hop; its own while it
/// has not hopped.
pub fn session_route_primary(session: &Value) -> Value {
    if let Some(primary) = session.get("routeFallbackPrimary") {
        if truthy(primary.get("provider")).is_some() {
            return primary.clone();
        }
    }
    if let Some(first) = session.get("routeFallbackFailures").and_then(Value::as_array).and_then(|f| f.first()) {
        if truthy(first.get("provider")).is_some() && truthy(first.get("model")).is_some() {
            return json!({ "provider": first["provider"], "model": first["model"] });
        }
    }
    Value::Object(route_leaf(Some(session)))
}

/// `routeFallbackHopped`: whether the session has left its primary for a fallback model.
pub fn route_fallback_hopped(session: &Value) -> bool {
    js_number(session.get("routeFallbackIndex")) > 0.0
        || session.get("routeFallbackFailures").and_then(Value::as_array).is_some_and(|f| !f.is_empty())
}

/// `resolveSessionMode({ session })`: `(mode, agentId)`; `agentId` is the agent the session acts
/// as — empty for a delegated worker, Mixy for a coding Lead.
pub fn resolve_session_mode(session: &Value) -> (&'static str, String) {
    let owner = clean_or_empty(session.get("owner")).to_lowercase();
    if owner == "agent" || session.get("visibility").and_then(Value::as_str) == Some("agent-only") {
        return (CODING_MODE, String::new());
    }
    let id = clean_or_empty(session.get("id"));
    let valid = |v: Option<&Value>| match v {
        Some(Value::String(s)) => {
            let t = js_trim(s);
            if !t.is_empty() && agent_home_session_id(t).is_some() { t.to_owned() } else { String::new() }
        }
        _ => String::new(),
    };
    let agent = room_member_of_session(&id)
        .map(|m| m.agent_id)
        .filter(|a| !a.is_empty())
        .or_else(|| agent_id_of_home_session(&id).filter(|a| !a.is_empty()))
        .unwrap_or_else(|| valid(session.get("ownerAgentId")));
    if agent.is_empty() { (CODING_MODE, MIXY_AGENT_ID.to_owned()) } else { (AGENT_MODE, agent) }
}

fn normalized_or_null(stored: &Value) -> Option<Value> {
    truthy(Some(stored))?;
    normalize_workflow_route(stored, &json!({}), false).ok().flatten()
}

/// `configuredAgentRouteCandidates(config, agentId)`.
fn route_candidates(config: &Obj, agent_id: &str, bots: &dyn BotRoutes) -> Vec<Value> {
    let id = js_trim(agent_id);
    if id.is_empty() {
        return Vec::new();
    }
    if let Some(bot) = bots.bot_route(id) {
        return bot.filter(|r| truthy(Some(r)).is_some()).into_iter().collect();
    }
    config.get("agents").and_then(|a| a.get(id)).filter(|r| truthy(Some(r)).is_some()).cloned().into_iter().collect()
}

/// `ownerConfiguredRoute`: the owner's stored route (primary plus `fallbacks`), normalized; `None`
/// when the owner has none or it cannot be read.
pub fn owner_configured_route(mode: &str, agent_id: &str, config: &Obj, bots: &dyn BotRoutes) -> Option<Value> {
    if agent_id.is_empty() {
        return None;
    }
    let stored = if mode == CODING_MODE {
        find_preset(config, config.get("default")).cloned()
    } else {
        // Before the bot split a bot's route is still in the config (Mixy's never).
        bots.stored_bot_route(agent_id)
            .filter(|r| truthy(Some(r)).is_some())
            .or_else(|| if agent_id == MIXY_AGENT_ID { None } else { route_candidates(config, agent_id, bots).into_iter().next() })
    }?;
    normalized_or_null(&stored)
}

/// `ownerRouteFallbacks`: the owner's chain while the session runs on its configured primary.
pub fn owner_route_fallbacks(mode: &str, agent_id: &str, provider: &str, model: &str, config: &Obj, bots: &dyn BotRoutes) -> Vec<Value> {
    let Some(route) = owner_configured_route(mode, agent_id, config, bots) else { return Vec::new() };
    if !route.get("fallbacks").and_then(Value::as_array).is_some_and(|f| !f.is_empty()) {
        return Vec::new();
    }
    if same_route_model(Some(&route), Some(&json!({ "provider": provider, "model": model }))) {
        execution_fallbacks(&route).unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// `sessionChainSource`: the stored route the session's chain comes from, read now; `None` when
/// it has no readable source (it then keeps its own chain).
pub fn session_chain_source(session: &Value, config: &Obj, bots: &dyn BotRoutes) -> Option<Value> {
    let (mode, agent_id) = resolve_session_mode(session);
    if !agent_id.is_empty() {
        return owner_configured_route(mode, &agent_id, config, bots);
    }
    let source = session.get("routeFallbackSource");
    if let Some(agent) = truthy(source.and_then(|s| s.get("agent"))) {
        // As the spawn resolved it: the agent's own route, else Main's.
        let own = route_candidates(config, &value_to_string(agent), bots).iter().map(normalized_or_null).find(Option::is_some).flatten();
        return own.or_else(|| find_preset(config, config.get("default")).and_then(normalized_or_null));
    }
    if let Some(preset) = truthy(source.and_then(|s| s.get("preset"))) {
        return find_preset(config, Some(preset)).and_then(normalized_or_null);
    }
    None
}

/// `liveRouteFallbacks`: `(chain, fromSettings)`, the fallback routes the session follows now.
pub fn live_route_fallbacks(session: &Value, config: &Obj, bots: &dyn BotRoutes) -> (Vec<Value>, bool) {
    let Some(source) = session_chain_source(session, config, bots) else {
        return (session.get("routeFallbacks").and_then(Value::as_array).cloned().unwrap_or_default(), false);
    };
    let on_source_primary = same_route_model(Some(&source), Some(&session_route_primary(session)));
    (if on_source_primary { execution_fallbacks(&source).unwrap_or_default() } else { Vec::new() }, true)
}

/// `nextRouteFallbackIndex`: the index in `chain` of the next route to try — the first after the
/// session's current model that it has not already run; `chain.len()` when none is left.
pub fn next_route_fallback_index(session: &Value, chain: &[Value]) -> usize {
    let mut tried = vec![session_route_primary(session)];
    if let Some(failures) = session.get("routeFallbackFailures").and_then(Value::as_array) {
        tried.extend(failures.iter().cloned());
    }
    tried.push(session.clone());
    let start = chain.iter().position(|entry| same_route_model(Some(entry), Some(session))).map_or(0, |at| at + 1);
    (start..chain.len()).find(|&i| !tried.iter().any(|route| same_route_model(chain.get(i), Some(route)))).unwrap_or(chain.len())
}

/// `routeFallbackPosition`: the public fallback position of one session.
pub fn route_fallback_position(session: &Value, config: &Obj, bots: &dyn BotRoutes) -> Value {
    let (chain, from_settings) = live_route_fallbacks(session, config, bots);
    let next = chain.get(next_route_fallback_index(session, &chain));
    let primary = session_route_primary(session);
    let (mode, agent_id) = resolve_session_mode(session);
    let kind = if agent_id.is_empty() { "agent" } else if mode == CODING_MODE { "lead" } else { "bot" };
    let agent = if agent_id.is_empty() { truthy(session.get("agent")).cloned() } else { Some(Value::String(agent_id)) };
    let failures: Vec<Value> = session
        .get("routeFallbackFailures")
        .and_then(Value::as_array)
        .map(|f| {
            f.iter()
                .map(|row| {
                    let mut out = Obj::new();
                    for (key, from) in [("provider", "provider"), ("model", "model"), ("kind", "kind"), ("error", "error")] {
                        if let Some(v) = row.get(from) {
                            out.insert(key.to_owned(), v.clone());
                        }
                    }
                    Value::Object(out)
                })
                .collect()
        })
        .unwrap_or_default();
    let index = js_number(session.get("routeFallbackIndex"));
    json!({
        "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
        "kind": kind,
        "agent": agent.unwrap_or(Value::Null),
        "current": model_of(Some(session)),
        "primary": model_of(Some(&primary)),
        "onPrimary": same_route_model(Some(&primary), Some(session)),
        "fallbackIndex": number_value(if index.is_nan() { 0.0 } else { index }),
        "fallbacks": chain.iter().map(|r| model_of(Some(r))).collect::<Vec<_>>(),
        "chainFrom": if from_settings { "settings" } else { "session" },
        "next": next.map_or(Value::Null, |r| model_of(Some(r))),
        "failures": failures,
    })
}

/// `primaryRoute`: the route a reset returns `session` to — the one it left at its first hop,
/// else its settings' route when that is still its primary.
pub fn primary_route(session: &Value, config: &Obj, bots: &dyn BotRoutes) -> Obj {
    if let Some(primary) = session.get("routeFallbackPrimary") {
        if truthy(primary.get("provider")).is_some() {
            return route_leaf(Some(primary));
        }
    }
    let primary = session_route_primary(session);
    match session_chain_source(session, config, bots) {
        Some(source) if same_route_model(Some(&source), Some(&primary)) => route_leaf(Some(&source)),
        _ => route_leaf(Some(&primary)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bots;
    impl BotRoutes for Bots {
        fn bot_route(&self, id: &str) -> Option<Option<Value>> {
            match id {
                "botty" => Some(Some(json!({ "provider": "xai", "model": "grok-4", "fallbacks": [{ "provider": "anthropic", "model": "claude-sonnet-4" }] }))),
                "nobot" => Some(None),
                _ => None,
            }
        }
        fn stored_bot_route(&self, _: &str) -> Option<Value> {
            None
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/route_chain.json")).expect("fixture")
    }

    /// Every reader against Node's real `route-fallback-chain.mjs` on one config and 16 sessions.
    #[test]
    fn the_readers_follow_node() {
        let golden = golden();
        let config = golden["config"].as_object().unwrap();
        for (name, row) in golden["sessions"].as_object().unwrap() {
            let session = &row["session"];
            let mode = resolve_session_mode(session);
            assert_eq!(json!({ "mode": mode.0, "agentId": mode.1 }), row["mode"], "{name} mode");
            assert_eq!(json!(route_fallback_hopped(session)), row["hopped"], "{name} hopped");
            assert_eq!(session_route_primary(session), row["primary"], "{name} primary");
            assert_eq!(session_chain_source(session, config, &Bots).unwrap_or(Value::Null), row["source"], "{name} source");
            let (chain, from_settings) = live_route_fallbacks(session, config, &Bots);
            assert_eq!(json!({ "chain": chain, "fromSettings": from_settings }), row["live"], "{name} live");
            assert_eq!(json!(next_route_fallback_index(session, &chain)), row["next"], "{name} next");
            assert_eq!(route_fallback_position(session, config, &Bots), row["position"], "{name} position");
            assert_eq!(Value::Object(primary_route(session, config, &Bots)), row["primaryRoute"], "{name} primaryRoute");
            assert_eq!(Value::Object(route_leaf(Some(session))), row["leaf"], "{name} leaf");
        }
    }

    #[test]
    fn same_route_model_follows_node() {
        for row in golden()["same"].as_array().unwrap() {
            let side = |v: &Value| (!v.is_null()).then(|| v.clone());
            let (a, b) = (side(&row[0]), side(&row[1]));
            assert_eq!(json!(same_route_model(a.as_ref(), b.as_ref())), row[2], "{row}");
        }
    }

    #[test]
    fn a_session_on_the_owners_primary_takes_the_owners_chain() {
        let golden = golden();
        let config = golden["config"].as_object().unwrap();
        let chain = owner_route_fallbacks(CODING_MODE, "lead", "openai-oauth", "gpt-5", config, &Bots);
        assert_eq!(chain.len(), 3);
        assert!(owner_route_fallbacks(CODING_MODE, "lead", "groq", "llama-3", config, &Bots).is_empty());
        assert!(owner_route_fallbacks(AGENT_MODE, "nobot", "xai", "grok-4", config, &Bots).is_empty());
    }
}
