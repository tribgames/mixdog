//! Onboarding: the status the config reports and the two ways to finish it
//! (`settings-profile-api.mjs` `getOnboardingStatus` / `skipOnboarding`,
//! `workflow-agents-api/onboarding.mjs` `completeOnboarding`, `starter-guide-state.mjs`).
//!
//! The functions here build the config the save writes; the service stores it, then adopts the
//! Lead route it chose.

use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_ai::service::admin_route::upsert_workflow_preset;
use mixdog_ai::service::admin_route::workflow_preset_id;
use mixdog_ai::service::routes::WEB_SEARCH_DEFAULT_MODEL;
use mixdog_ai::service::routes::WEB_SEARCH_DEFAULT_PROVIDER;
use mixdog_ai::service::routes::normalize_web_search_route_config;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::ids::Doc;
use super::ids::clean;
use super::ids::has_own;
use super::ids::truthy;
use super::presets::effective;
use super::presets::summarize_workflow_routes;

/// `ONBOARDING_VERSION`.
pub(crate) const ONBOARDING_VERSION: u32 = 1;
const STARTER_GUIDE_STEPS: [&str; 5] = ["provider", "project", "workflow", "extensions", "remote"];
const WORKFLOW_ROUTE_SLOTS: [&str; 3] = ["lead", "agent", "memory"];
/// `FIXED_AGENT_SLOTS` ids.
const FIXED_AGENT_IDS: [&str; 2] = ["maintainer", "explore"];

/// `storedStarterGuide(value)`: the stored copy read tolerantly, `Null` when there is none.
fn stored_starter_guide(value: Option<&Value>) -> Value {
    let Some(map) = value.and_then(Value::as_object) else { return Value::Null };
    let visited = map.get("visited").and_then(Value::as_array);
    let kept: Vec<&str> = STARTER_GUIDE_STEPS
        .iter()
        .copied()
        .filter(|step| visited.is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some(step))))
        .collect();
    json!({
        "closed": map.get("closed") == Some(&Value::Bool(true)),
        "welcomed": map.get("welcomed") == Some(&Value::Bool(true)),
        "visited": kept,
    })
}

/// `withStarterGuideOnCompletion(previous, onboarding)`: a first completion starts the guide
/// fresh.
fn with_starter_guide(previous: &Doc, mut onboarding: Doc) -> Doc {
    if previous.get("completed") == Some(&Value::Bool(true)) || !stored_starter_guide(previous.get("starterGuide")).is_null() {
        return onboarding;
    }
    onboarding.insert("starterGuide".into(), json!({ "closed": false, "welcomed": false, "visited": [] }));
    onboarding
}

/// `getOnboardingStatus()`.
pub(crate) fn status(agent: &Doc) -> Result<Value, String> {
    let view = effective(agent);
    let routes = summarize_workflow_routes(&view)?;
    let version = view.onboarding.get("version").filter(|value| truthy(Some(*value))).cloned().unwrap_or(json!(0));
    let default = view.config.get("default").filter(|value| truthy(Some(*value))).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "completed": view.onboarding.get("completed") == Some(&Value::Bool(true)),
        "version": version,
        "default": default,
        "workflowRoutes": routes,
        "starterGuide": stored_starter_guide(view.onboarding.get("starterGuide")),
    }))
}

fn completion_stamp(previous: &Doc, mut onboarding: Doc, now: &str, skipped: bool) -> Doc {
    onboarding.insert("completed".into(), Value::Bool(true));
    onboarding.insert("version".into(), json!(ONBOARDING_VERSION));
    onboarding.insert("completedAt".into(), Value::String(now.to_owned()));
    if skipped {
        onboarding.insert("skipped".into(), Value::Bool(true));
    }
    with_starter_guide(previous, onboarding)
}

/// `skipOnboarding()`: the config with onboarding marked done and nothing else touched.
pub(crate) fn skipped(agent: &Doc, now: &str) -> Doc {
    let previous = effective(agent).onboarding;
    let mut after = agent.clone();
    let onboarding = completion_stamp(&previous, previous.clone(), now, true);
    after.insert("onboarding".into(), Value::Object(onboarding));
    after
}

/// What a completion saves, and the Lead route it chose (the live Main route follows it).
pub(crate) struct Completion {
    pub after: Doc,
    pub lead: Option<Value>,
}

/// `payload.<key>` when it is an object (an array is one too).
pub(crate) fn object_payload(payload: &Value, key: &str) -> Option<Value> {
    payload.get(key).filter(|value| truthy(Some(*value)) && (value.is_object() || value.is_array())).cloned()
}

/// `completeOnboarding(payload)`. `main` is the live Main route, the fallback of a sent
/// `defaultRoute`; `custom_agents` the ids of the custom agents; `now` the completion time.
pub(crate) fn completed(
    agent: &Doc,
    payload: &Value,
    main: &Value,
    custom_agents: &[String],
    now: &str,
) -> Result<Completion, String> {
    if payload.is_null() {
        return Err("Cannot convert undefined or null to object".into());
    }
    let empty = Value::Object(Map::new());
    let previous = effective(agent).onboarding;
    let mut after = agent.clone();
    let mut presets = agent.get("presets").cloned().unwrap_or_else(|| json!([]));
    if !presets.is_array() {
        presets = json!([]);
    }
    let mut default: Option<Value> = None;
    let mut agents = agent.get("agents").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut lead: Option<Value> = None;
    if has_own(payload, "defaultRoute") {
        let route = normalize_workflow_route(&payload["defaultRoute"], main, true)?;
        if let Some(route) = route {
            presets = upsert_workflow_preset(&presets, "lead", &route)?;
            default = Some(Value::String(workflow_preset_id("lead")));
            lead = Some(route);
        }
    }
    let slots = object_payload(payload, "workflowRoutes").unwrap_or(empty.clone());
    for slot in WORKFLOW_ROUTE_SLOTS {
        if !has_own(&slots, slot) {
            continue;
        }
        let route = normalize_workflow_route(&slots[slot], &empty, true)?;
        match slot {
            "lead" => {
                if let Some(route) = route {
                    presets = upsert_workflow_preset(&presets, "lead", &route)?;
                    default = Some(Value::String(workflow_preset_id("lead")));
                    lead = Some(route);
                }
            }
            "agent" | "memory" => {
                let id = if slot == "agent" { "worker" } else { "maintainer" };
                match route {
                    Some(route) => agents.insert(id.into(), route),
                    None => agents.shift_remove(id),
                };
            }
            _ => {}
        }
    }
    if let Some(value) = default {
        after.insert("default".into(), value);
    }
    after.insert("presets".into(), presets);
    if let Some(sent) = object_payload(payload, "agentRoutes") {
        let mut configurable: Vec<String> = FIXED_AGENT_IDS.iter().map(|id| (*id).to_owned()).collect();
        for id in custom_agents {
            if !configurable.contains(id) {
                configurable.push(id.clone());
            }
        }
        for id in configurable {
            if !has_own(&sent, &id) {
                continue;
            }
            match normalize_workflow_route(&sent[id.as_str()], &empty, true)? {
                Some(route) => agents.insert(id, route),
                None => agents.shift_remove(&id),
            };
        }
    }
    after.insert("agents".into(), Value::Object(agents));
    after.insert("onboarding".into(), Value::Object(completion_stamp(&previous, previous.clone(), now, false)));
    if let Some(sent) = payload.get("webSearchRoute").filter(|value| truthy(Some(*value)))
        && let Some(route) = web_search_route_to_save(sent)?
    {
        after.insert("webSearchRoute".into(), route);
    }
    Ok(Completion { after, lead })
}

/// `webSearchRouteToSave`: a route without a provider is the follow-Main marker.
fn web_search_route_to_save(sent: &Value) -> Result<Option<Value>, String> {
    let empty = Value::Object(Map::new());
    if !clean(sent.get("provider")).is_empty() {
        return normalize_web_search_route_config(sent, &empty);
    }
    let mut marker = json!({ "provider": WEB_SEARCH_DEFAULT_PROVIDER, "model": WEB_SEARCH_DEFAULT_MODEL });
    if let Some(tool_type) = sent.get("toolType") {
        marker["toolType"] = tool_type.clone();
    }
    normalize_web_search_route_config(&marker, &empty)
}

/// The request the live Main route is resolved from after a Lead save
/// (`{ provider, model, effort }`).
pub(crate) fn lead_selection(lead: &Value) -> Value {
    let mut selection = json!({ "provider": lead["provider"], "model": lead["model"] });
    if let Some(effort) = lead.get("effort") {
        selection["effort"] = effort.clone();
    }
    selection
}
