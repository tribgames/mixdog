//! `--route-profile <file-or-json>`: the routes a routing profile gives the run's agent roles and the Lead's fallback,
//! `{"routes": {"<role>": route, ...}, "leadFallback": route}` with a route `{provider, model, effort?, fast?}`. The run
//! config holds them where the app keeps them (`agents.<role>`, the default preset's `fallbacks`), so a spawned role and a
//! Lead fallback resolve as the app resolves them. Anything the exec cannot apply is refused by name.
#![allow(clippy::disallowed_methods, reason = "the profile is read before the core starts, as the boundary's provider config is")]

use std::path::Path;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::route::EFFORTS;
use super::route::clean;

const ROUTE_FIELDS: [&str; 4] = ["provider", "model", "effort", "fast"];
const LEAD: &str = "lead";
const FALLBACK: &str = "leadFallback";

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RouteProfile {
    /// `agents.<role>` of the run config.
    pub agents: Map<String, Value>,
    pub lead_fallback: Option<Value>,
}

/// The run's own Lead route, which a profile's `lead` route must repeat.
pub struct LeadRoute<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    /// Lower-cased; empty when none.
    pub effort: &'a str,
    pub fast: bool,
}

impl RouteProfile {
    /// Every provider a role or the fallback runs on, once each, in profile order.
    pub fn providers(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for route in self.agents.values().chain(self.lead_fallback.iter()) {
            let provider = clean(route["provider"].as_str()).to_owned();
            if !out.contains(&provider) {
                out.push(provider);
            }
        }
        out
    }

    /// Each route by the name the profile gives it: the roles, then `leadFallback`.
    pub fn routes(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.agents.iter().map(|(role, route)| (role.as_str(), route)).chain(self.lead_fallback.iter().map(|route| (FALLBACK, route)))
    }

    pub fn is_empty(&self) -> bool {
        self.agents.is_empty() && self.lead_fallback.is_none()
    }
}

fn read_document(raw: &str) -> Result<Value, String> {
    let raw = clean(Some(raw));
    let text = if raw.starts_with('{') { raw.to_owned() } else { std::fs::read_to_string(raw).map_err(|err| format!("--route-profile {raw}: {err}"))? };
    serde_json::from_str(&text).map_err(|err| format!("--route-profile is not valid JSON: {err}"))
}

/// The providers a profile names, read before the boundary validates it: the host credentials of each are looked up
/// while the host's environment and keychain are still reachable. A document that does not parse names none.
pub fn providers_named(raw: &str) -> Vec<String> {
    let Ok(document) = read_document(raw) else { return Vec::new() };
    let routes = document.get("routes").and_then(Value::as_object).into_iter().flat_map(|routes| routes.values());
    let mut out: Vec<String> = Vec::new();
    for route in routes.chain(document.get(FALLBACK)) {
        let provider = clean(route.get("provider").and_then(Value::as_str)).to_owned();
        if !provider.is_empty() && !out.contains(&provider) {
            out.push(provider);
        }
    }
    out
}

fn route(name: &str, value: &Value) -> Result<Value, String> {
    let Some(fields) = value.as_object() else { return Err(format!("--route-profile route \"{name}\" must be an object")) };
    if let Some(field) = fields.keys().find(|key| !ROUTE_FIELDS.contains(&key.as_str())) {
        return Err(format!("--route-profile route \"{name}\" field \"{field}\" cannot be applied by mixdog exec"));
    }
    let text = |key: &str| clean(fields.get(key).and_then(Value::as_str)).to_owned();
    let (provider, model) = (text("provider"), text("model"));
    if provider.is_empty() || model.is_empty() {
        return Err(format!("--route-profile route \"{name}\" needs provider and model"));
    }
    let effort = text("effort").to_lowercase();
    if fields.get("effort").is_some_and(|effort| !effort.is_string()) || (!effort.is_empty() && !EFFORTS.contains(&effort.as_str())) {
        return Err(format!("--route-profile route \"{name}\" field \"effort\" must be low, medium, high, xhigh, or max"));
    }
    let fast = match fields.get("fast") {
        None => false,
        Some(Value::Bool(fast)) => *fast,
        Some(_) => return Err(format!("--route-profile route \"{name}\" field \"fast\" must be boolean")),
    };
    let mut out = json!({ "provider": provider, "model": model, "fast": fast });
    if !effort.is_empty() {
        out["effort"] = json!(effort);
    }
    Ok(out)
}

/// The names of the shipped agents: the directories of `agents_dir` that hold an `agent.json`, spelled as on disk.
fn shipped_agents(agents_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(agents_dir) else { return Vec::new() };
    entries.flatten().filter(|entry| entry.path().join("agent.json").is_file()).filter_map(|entry| entry.file_name().into_string().ok()).collect()
}

/// Reads and checks the profile: a `lead` route must be the run's own, every other role must be exactly the name of a
/// shipped agent under `agents_dir`, and no field may be one the exec cannot apply.
pub fn parse(raw: &str, lead: &LeadRoute<'_>, agents_dir: &Path) -> Result<RouteProfile, String> {
    let document = read_document(raw)?;
    let Some(fields) = document.as_object() else { return Err("--route-profile must be a JSON object".into()) };
    if let Some(field) = fields.keys().find(|key| !matches!(key.as_str(), "routes" | FALLBACK)) {
        return Err(format!("--route-profile field \"{field}\" cannot be applied by mixdog exec"));
    }
    let Some(routes) = fields.get("routes").and_then(Value::as_object) else { return Err("--route-profile needs a routes object".into()) };
    let shipped = shipped_agents(agents_dir);
    let mut profile = RouteProfile::default();
    for (role, value) in routes {
        let resolved = route(role, value)?;
        if role == LEAD {
            let own = json!({ "provider": lead.provider, "model": lead.model, "fast": lead.fast });
            let same = resolved["provider"] == own["provider"]
                && resolved["model"] == own["model"]
                && resolved["fast"] == own["fast"]
                && clean(resolved["effort"].as_str()) == lead.effort;
            if !same {
                return Err("--route-profile route \"lead\" differs from the run's --provider, --model, --effort and --fast".into());
            }
            continue;
        }
        if !shipped.iter().any(|name| name == role) {
            return Err(format!("--route-profile role \"{role}\" is not an agent mixdog exec can run"));
        }
        profile.agents.insert(role.clone(), resolved);
    }
    profile.lead_fallback = fields.get(FALLBACK).map(|value| route(FALLBACK, value)).transpose()?;
    Ok(profile)
}
