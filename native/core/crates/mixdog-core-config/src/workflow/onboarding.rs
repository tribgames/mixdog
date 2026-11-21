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
use crate::config::AgentRoutes;
use crate::config::ConfigError;

use super::presets::BotRoutes;
use super::presets::Effective;
use super::presets::SUMMARY_AGENTS;
use super::presets::effective;
use super::presets::effective_keeping;
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
    let kept: Vec<&str> =
        STARTER_GUIDE_STEPS.iter().copied().filter(|step| visited.is_some_and(|list| list.iter().any(|entry| entry.as_str() == Some(step)))).collect();
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
pub(crate) fn status(agent: &Doc, bots: &BotRoutes) -> Result<Value, String> {
    status_of(effective(agent).with_bot_routes(bots))
}

/// The routes the bot store holds for the agents the status summarizes.
pub(crate) async fn bot_routes(routes: &AgentRoutes) -> Result<BotRoutes, ConfigError> {
    let mut bots = BotRoutes::new();
    for (_, id) in SUMMARY_AGENTS {
        if let Some(route) = routes.store_bot_route(id).await? {
            bots.push((id.to_owned(), route));
        }
    }
    Ok(bots)
}

/// The status of the config a save adopted: the presets it wrote keep their saved form.
pub(crate) fn adopted_status(before: &Doc, adopted: &Doc, bots: &BotRoutes) -> Result<Value, String> {
    let list = |doc: &Doc| doc.get("presets").and_then(Value::as_array).cloned().unwrap_or_default();
    let old = list(before);
    let written: Vec<String> = list(adopted).iter().filter(|preset| !old.contains(preset)).map(|preset| clean(preset.get("id"))).collect();
    status_of(effective_keeping(adopted, &written).with_bot_routes(bots))
}

fn status_of(view: Effective) -> Result<Value, String> {
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

/// The presets, default, Lead route and agent routes a completion is building.
struct Draft {
    presets: Value,
    default: Option<Value>,
    lead: Option<Value>,
    agents: Map<String, Value>,
}

impl Draft {
    fn of(agent: &Doc) -> Self {
        let presets = agent.get("presets").filter(|presets| presets.is_array()).cloned().unwrap_or_else(|| json!([]));
        Self { presets, default: None, lead: None, agents: agent.get("agents").and_then(Value::as_object).cloned().unwrap_or_default() }
    }

    fn choose_lead(&mut self, route: Value) -> Result<(), String> {
        self.presets = upsert_workflow_preset(&self.presets, "lead", &route)?;
        self.default = Some(Value::String(workflow_preset_id("lead")));
        self.lead = Some(route);
        Ok(())
    }

    fn set_agent(&mut self, id: &str, route: Option<Value>) {
        match route {
            Some(route) => self.agents.insert(id.into(), route),
            None => self.agents.shift_remove(id),
        };
    }

    /// `payload.defaultRoute`: a sent route that normalizes becomes the Lead.
    fn apply_default_route(&mut self, payload: &Value, main: &Value) -> Result<(), String> {
        if has_own(payload, "defaultRoute")
            && let Some(route) = normalize_workflow_route(&payload["defaultRoute"], main, true)?
        {
            self.choose_lead(route)?;
        }
        Ok(())
    }

    /// `payload.workflowRoutes`: the Lead, Agent (`worker`) and Memory (`maintainer`) slots; a slot sent empty clears its agent.
    fn apply_slots(&mut self, payload: &Value, empty: &Value) -> Result<(), String> {
        let slots = object_payload(payload, "workflowRoutes").unwrap_or(empty.clone());
        for slot in WORKFLOW_ROUTE_SLOTS {
            if !has_own(&slots, slot) {
                continue;
            }
            let route = normalize_workflow_route(&slots[slot], empty, true)?;
            match slot {
                "lead" => {
                    if let Some(route) = route {
                        self.choose_lead(route)?;
                    }
                }
                "agent" => self.set_agent("worker", route),
                "memory" => self.set_agent("maintainer", route),
                _ => {}
            }
        }
        Ok(())
    }

    /// `payload.agentRoutes`: only the fixed and the custom agents are configurable.
    fn apply_agent_routes(&mut self, sent: &Value, custom_agents: &[String], empty: &Value) -> Result<(), String> {
        let mut configurable: Vec<String> = FIXED_AGENT_IDS.iter().map(|id| (*id).to_owned()).collect();
        for id in custom_agents {
            if !configurable.contains(id) {
                configurable.push(id.clone());
            }
        }
        for id in configurable {
            if has_own(sent, &id) {
                let route = normalize_workflow_route(&sent[id.as_str()], empty, true)?;
                self.set_agent(&id, route);
            }
        }
        Ok(())
    }
}

/// `completeOnboarding(payload)`. `main` is the live Main route, the fallback of a sent
/// `defaultRoute`; `custom_agents` the ids of the custom agents; `now` the completion time.
pub(crate) fn completed(agent: &Doc, payload: &Value, main: &Value, custom_agents: &[String], now: &str) -> Result<Completion, String> {
    if payload.is_null() {
        return Err("Cannot convert undefined or null to object".into());
    }
    let empty = Value::Object(Map::new());
    let previous = effective(agent).onboarding;
    let mut draft = Draft::of(agent);
    draft.apply_default_route(payload, main)?;
    draft.apply_slots(payload, &empty)?;
    if let Some(sent) = object_payload(payload, "agentRoutes") {
        draft.apply_agent_routes(&sent, custom_agents, &empty)?;
    }
    let mut after = agent.clone();
    if let Some(value) = draft.default {
        after.insert("default".into(), value);
    }
    after.insert("presets".into(), draft.presets);
    after.insert("agents".into(), Value::Object(draft.agents));
    after.insert("onboarding".into(), Value::Object(completion_stamp(&previous, previous.clone(), now, false)));
    if let Some(sent) = payload.get("webSearchRoute").filter(|value| truthy(Some(*value)))
        && let Some(route) = web_search_route_to_save(sent)?
    {
        after.insert("webSearchRoute".into(), route);
    }
    Ok(Completion { after, lead: draft.lead })
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
