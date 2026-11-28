//! The statusline's gateway session routes, `<data>/gateway-session-routes.json`
//! (`vendor/statusline/src/gateway/session-routes.mjs`), as they are read: a session's own route and the newest one its
//! host wrote. The core writes the store (`mixdog_core_session::session::gateway_routes`).

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::statusline_claude::CLAUDE_CURRENT_MODE;

/// `STORE_FILE`.
pub const STORE_FILE: &str = "gateway-session-routes.json";

/// `normalizeGatewaySessionId`: the trimmed id when it matches `/^[0-9a-z][0-9a-z._-]{7,}$/i`.
pub fn normalize_session_id(value: &str) -> Option<&str> {
    let id = mixdog_js::js_trim(value);
    let mut chars = id.chars();
    let first = chars.next()?.is_ascii_alphanumeric();
    let rest = chars.clone().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    (first && rest && chars.count() >= 7).then_some(id)
}

/// `Number(route?.updatedAt) || 0`.
pub fn updated_at(route: &Value) -> f64 {
    let at = mixdog_js::to_number_of(route.as_object().and_then(|object| object.get("updatedAt")));
    if at.is_nan() { 0.0 } else { at }
}

/// `hostRouteKey` of a normalized session id and client host pid.
pub fn host_key(sid: &str, pid: u64) -> String {
    format!("{sid}#{pid}")
}

/// `normalizeClientHostPid`: a positive integer.
pub fn normalize_client_host_pid(value: Option<&Value>) -> Option<u64> {
    let n = mixdog_js::to_number_of(value);
    (n.fract() == 0.0 && n > 0.0 && n < 9_007_199_254_740_992.0).then_some(n as u64)
}

/// `cleanBool` of the route store: a boolean or the flag a word names.
pub fn clean_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) => match mixdog_js::js_to_lowercase(mixdog_js::js_trim(text)).as_str() {
            "1" | "true" | "yes" | "on" | "fast" | "priority" => Some(true),
            "0" | "false" | "no" | "off" | "none" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `cleanString(value)`: the trimmed text of a string, none when empty or not a string.
fn trimmed(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(text)) => Some(mixdog_js::js_trim(text)).filter(|text| !text.is_empty()),
        _ => None,
    }
}

/// `a ?? b`.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if matches!(a, None | Some(Value::Null)) { b } else { a }
}

/// `normalizeGatewayRouteSection(route)`: the section a stored route reads as, `None` without a provider and a
/// model. A route with no `mode` is `claude-current`.
pub fn normalize_route_section(route: &Value) -> Option<Map<String, Value>> {
    let field = |key: &str| route.get(key);
    let mode = trimmed(field("mode")).unwrap_or(CLAUDE_CURRENT_MODE);
    let provider = trimmed(nullish(field("defaultProvider"), field("provider")))?;
    let model = trimmed(nullish(field("defaultModel"), field("model")))?;
    let mut out = Map::new();
    out.insert("mode".into(), json!(mode));
    out.insert("defaultProvider".into(), json!(provider));
    out.insert("defaultModel".into(), json!(model));
    for key in ["presetId", "presetName", "effort", "displayEffort", "modelDisplay"] {
        if let Some(value) = trimmed(field(key)) {
            out.insert(key.into(), json!(value));
        }
    }
    if let Some(object) = route.as_object() {
        if object.contains_key("fast")
            && let Some(fast) = clean_bool(object.get("fast"))
        {
            out.insert("fast".into(), json!(fast));
        }
        if object.contains_key("thinkingBudgetTokens") {
            let n = mixdog_js::to_number_of(object.get("thinkingBudgetTokens"));
            if n.is_finite() && n > 0.0 {
                out.insert("thinkingBudgetTokens".into(), mixdog_js::json_number(n.floor()));
            }
        }
    }
    Some(out)
}

/// `routeWithMeta(route, sessionId, clientHostPid)`: the normalized section with the session id, the host pid
/// (the given one, else the route's own) and the stamp it was written at.
fn route_with_meta(route: Option<&Value>, session_id: &str, client_host_pid: Option<u64>) -> Option<Map<String, Value>> {
    let route = route?;
    let mut out = normalize_route_section(route)?;
    let pid = client_host_pid.or_else(|| normalize_client_host_pid(route.get("clientHostPid")));
    out.insert("sessionId".into(), json!(session_id));
    if let Some(pid) = pid {
        out.insert("clientHostPid".into(), json!(pid));
    }
    let stamped = route.get("updatedAt").filter(|at| match at {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    });
    out.insert("updatedAt".into(), stamped.cloned().unwrap_or(Value::Null));
    Some(out)
}

/// `readGatewaySessionRoute(sessionId, { clientHostPid, fallbackLegacy })` over the parsed store: with a host pid
/// the route that host wrote for the session (`sessionHosts["<id>#<pid>"]`), else, with `fallback_legacy`, the
/// session's legacy slot; without one the legacy slot.
pub fn read_session_route(store: &Value, session_id: &str, client_host_pid: Option<u64>, fallback_legacy: bool) -> Option<Map<String, Value>> {
    let sid = normalize_session_id(session_id)?;
    let sessions = store.get("sessions").filter(|sessions| sessions.is_object());
    let legacy = || sessions.and_then(|sessions| sessions.get(sid));
    let Some(pid) = client_host_pid else { return route_with_meta(legacy(), sid, None) };
    let hosts = store.get("sessionHosts").filter(|hosts| hosts.is_object());
    let scoped = route_with_meta(hosts.and_then(|hosts| hosts.get(host_key(sid, pid))), sid, Some(pid));
    if scoped.is_some() {
        return scoped;
    }
    if fallback_legacy { route_with_meta(legacy(), sid, None) } else { None }
}

/// `readLatestGatewayHostRoute(clientHostPid, { excludeSessionId })` over the parsed store: the newest route a
/// host wrote for any session but the excluded one (the later entry of equal stamps).
pub fn read_latest_host_route(store: &Value, client_host_pid: Option<u64>, exclude_session_id: Option<&str>) -> Option<Map<String, Value>> {
    let pid = client_host_pid?;
    let exclude = exclude_session_id.and_then(normalize_session_id);
    let hosts = store.get("sessionHosts")?.as_object()?;
    let mut best: Option<Map<String, Value>> = None;
    let mut best_at = -1.0;
    for route in hosts.values().filter(|route| route.is_object()) {
        if normalize_client_host_pid(route.get("clientHostPid")) != Some(pid) {
            continue;
        }
        let Some(sid) = route.get("sessionId").and_then(Value::as_str).and_then(normalize_session_id) else { continue };
        if exclude == Some(sid) {
            continue;
        }
        let Some(normalized) = route_with_meta(Some(route), sid, Some(pid)) else { continue };
        let at = updated_at(route);
        if at >= best_at {
            best = Some(normalized);
            best_at = at;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reader side: a host's own route first, then the legacy slot only when asked, and the newest
    /// route another session of the same host wrote.
    #[test]
    fn a_session_route_is_read_from_its_host_then_the_legacy_slot() {
        let store = json!({
            "sessions": { "sess_legacy01": { "defaultProvider": "openai", "defaultModel": "gpt-5", "updatedAt": 5 } },
            "sessionHosts": {
                "sess_abcdef01#7": { "mode": "fixed", "provider": "anthropic-oauth", "model": "claude-opus-4-8", "effort": " high ", "fast": "priority", "thinkingBudgetTokens": 4096.7, "sessionId": "sess_abcdef01", "clientHostPid": 7, "updatedAt": 10 },
                "sess_older001#7": { "defaultProvider": "p", "defaultModel": "m", "sessionId": "sess_older001", "clientHostPid": 7, "updatedAt": 3 },
                "sess_newer001#7": { "defaultProvider": "p2", "defaultModel": "m2", "sessionId": "sess_newer001", "clientHostPid": 7, "updatedAt": 9 },
                "sess_other001#8": { "defaultProvider": "p3", "defaultModel": "m3", "sessionId": "sess_other001", "clientHostPid": 8, "updatedAt": 99 },
            },
        });
        let scoped = read_session_route(&store, " sess_abcdef01 ", Some(7), false).unwrap();
        assert_eq!(
            Value::Object(scoped),
            json!({ "mode": "fixed", "defaultProvider": "anthropic-oauth", "defaultModel": "claude-opus-4-8", "effort": "high", "fast": true,
                    "thinkingBudgetTokens": 4096, "sessionId": "sess_abcdef01", "clientHostPid": 7, "updatedAt": 10 })
        );
        assert_eq!(read_session_route(&store, "sess_legacy01", Some(7), false), None);
        let legacy = read_session_route(&store, "sess_legacy01", Some(7), true).unwrap();
        assert_eq!((legacy["mode"].clone(), legacy["updatedAt"].clone(), legacy.get("clientHostPid").cloned()), (json!("claude-current"), json!(5), None));
        assert_eq!(read_session_route(&store, "sess_legacy01", None, false).unwrap()["defaultModel"], json!("gpt-5"));
        assert_eq!(read_session_route(&store, "short", None, false), None);
        let latest = read_latest_host_route(&store, Some(7), Some("sess_abcdef01")).unwrap();
        assert_eq!((latest["sessionId"].clone(), latest["defaultModel"].clone()), (json!("sess_newer001"), json!("m2")));
        assert_eq!(read_latest_host_route(&store, Some(9), None), None);
        assert_eq!(read_latest_host_route(&store, None, None), None);
    }

    #[test]
    fn a_stored_route_without_provider_or_model_reads_as_none() {
        assert_eq!(normalize_route_section(&json!({ "provider": "x" })), None);
        let section = normalize_route_section(&json!({ "provider": "x", "model": "y", "fast": "maybe", "thinkingBudgetTokens": -1 })).unwrap();
        assert!(!section.contains_key("fast") && !section.contains_key("thinkingBudgetTokens"));
        assert_eq!(normalize_client_host_pid(Some(&json!("12"))), Some(12));
        assert_eq!(normalize_client_host_pid(Some(&json!(1.5))), None);
        assert_eq!(normalize_client_host_pid(None), None);
    }
}
