//! The effective presets and the workflow-route summary of the config
//! (`orchestrator/config-presets.mjs`, `runtime-core/workflow.mjs` `createWorkflowRouteHelpers`):
//! the shipped presets laid under the stored ones, and the Lead / agent / memory routes the
//! onboarding status reports.

use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::find_preset;
use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::ids::Doc;
use super::ids::clean;
use super::ids::truthy;

const AGENT_PROVIDER_ALIASES: [(&str, &str); 3] = [("openai-api", "openai"), ("gemini-api", "gemini"), ("xai-api", "xai")];
const FAST_CAPABLE_PRESET_PROVIDERS: [&str; 6] =
    ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "cursor-oauth", "cursor-api"];

/// `resolveAnthropicFamilyModel(family)`: the environment override, else the shipped model.
fn anthropic_family_model(family: &str) -> String {
    let variable = format!("ANTHROPIC_DEFAULT_{}_MODEL", family.to_uppercase());
    if let Some(model) = std::env::var(&variable).ok().filter(|model| !model.is_empty()) {
        return model;
    }
    match family {
        "opus" => "claude-opus-4-8",
        "sonnet" => "claude-sonnet-4-6",
        _ => "claude-haiku-4-5-20251001",
    }
    .to_owned()
}

/// `DEFAULT_MAINTENANCE`: the shipped route of each maintenance slot.
pub(crate) fn default_maintenance() -> Map<String, Value> {
    let mut slots = Map::new();
    slots.insert("webhook".into(), json!({ "provider": "anthropic-oauth", "model": anthropic_family_model("haiku") }));
    slots
}

/// `DEFAULT_PRESETS`.
pub(crate) fn default_presets() -> Vec<Value> {
    let preset = |id: &str, name: &str, family: &str, effort: Option<&str>| {
        let mut preset = json!({ "id": id, "name": name, "type": "agent", "provider": "anthropic-oauth", "model": anthropic_family_model(family) });
        if let Some(effort) = effort {
            preset["effort"] = json!(effort);
        }
        preset["tools"] = json!("full");
        preset
    };
    vec![
        preset("haiku", "HAIKU", "haiku", None),
        preset("sonnet-mid", "SONNET MID", "sonnet", Some("medium")),
        preset("sonnet-high", "SONNET HIGH", "sonnet", Some("high")),
        preset("opus-mid", "OPUS MID", "opus", Some("medium")),
        preset("opus-high", "OPUS HIGH", "opus", Some("high")),
    ]
}

/// `String(a || b || '')` for a preset's own fields.
fn first_text(preset: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = preset.get(key).filter(|value| truthy(Some(*value))) {
            return value_to_string(value);
        }
    }
    String::new()
}

/// `normalizePreset`.
pub(crate) fn normalize_preset(preset: &Value) -> Option<Value> {
    let map = preset.as_object()?;
    let id = js_trim(&first_text(preset, &["id", "name"])).to_owned();
    let name = js_trim(&first_text(preset, &["name", "id"])).to_owned();
    let model = js_trim(&first_text(preset, &["model"])).to_owned();
    let provider = js_trim(&first_text(preset, &["provider"])).to_owned();
    let provider = AGENT_PROVIDER_ALIASES.iter().find(|(alias, _)| *alias == provider).map_or(provider.clone(), |(_, id)| (*id).to_owned());
    if name.is_empty() || model.is_empty() || provider.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("id".into(), Value::String(id));
    out.insert("name".into(), Value::String(name));
    out.insert("type".into(), json!("agent"));
    out.insert("provider".into(), Value::String(provider.clone()));
    out.insert("model".into(), Value::String(model));
    if map.get("effort").is_some_and(|effort| truthy(Some(effort))) {
        out.insert("effort".into(), Value::String(js_trim(&value_to_string(&map["effort"])).to_owned()));
    }
    if map.get("fast") == Some(&Value::Bool(true)) && FAST_CAPABLE_PRESET_PROVIDERS.contains(&provider.as_str()) {
        out.insert("fast".into(), Value::Bool(true));
    }
    if map.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), Value::Bool(false));
    }
    let tools = map.get("tools").and_then(Value::as_str).filter(|tools| ["full", "readonly", "mcp"].contains(tools)).unwrap_or("full");
    out.insert("tools".into(), json!(tools));
    if let Some(fallbacks) = map.get("fallbacks").filter(|fallbacks| fallbacks.as_array().is_some_and(|list| !list.is_empty())) {
        out.insert("fallbacks".into(), fallbacks.clone());
    }
    Some(Value::Object(out))
}

/// `normalizeWebSearchRoute` of `config-storage.mjs`: the stored shape of the route, which keeps
/// neither fallbacks nor a false `fast`.
pub(crate) fn stored_web_search_route(route: &Value) -> Value {
    let Some(map) = route.as_object() else { return Value::Null };
    let text = |key: &str| js_trim(&first_text(route, &[key])).to_owned();
    let provider = text("provider");
    let provider = AGENT_PROVIDER_ALIASES.iter().find(|(alias, _)| *alias == provider).map_or(provider.clone(), |(_, id)| (*id).to_owned());
    let model = text("model");
    let tool_type = text("toolType");
    if provider.is_empty() && !model.is_empty() {
        let mut out = Map::new();
        out.insert("provider".into(), json!("default"));
        out.insert("model".into(), json!("default"));
        if !tool_type.is_empty() {
            out.insert("toolType".into(), Value::String(tool_type));
        }
        return Value::Object(out);
    }
    if provider.is_empty() || model.is_empty() {
        return Value::Null;
    }
    let mut out = Map::new();
    out.insert("provider".into(), Value::String(provider));
    out.insert("model".into(), Value::String(model));
    let effort = text("effort");
    if !effort.is_empty() {
        out.insert("effort".into(), Value::String(effort));
    }
    if map.get("fast") == Some(&Value::Bool(true)) {
        out.insert("fast".into(), Value::Bool(true));
    }
    if !tool_type.is_empty() {
        out.insert("toolType".into(), Value::String(tool_type));
    }
    Value::Object(out)
}

/// `isRedundantGeneratedRoutePreset(preset, default)`.
pub(crate) fn redundant_generated(preset: &Value, default: &str) -> bool {
    let id = clean(preset.get("id"));
    !id.is_empty() && id != default && (id == "workflow-agent" || id == "workflow-memory" || id.starts_with("workflow-agent-"))
}

/// What the loader makes of the stored config that the onboarding reads: the effective
/// presets (stored ones normalized, `workflow-search` dropped, the shipped ones appended,
/// redundant generated ones scrubbed), the default, the complete agent routes.
pub(crate) struct Effective {
    pub config: Obj,
    pub agents: Map<String, Value>,
    pub onboarding: Doc,
}

/// The effective presets of `agent`: what `loadConfig().presets` holds.
pub fn effective_presets(agent: &Doc) -> Vec<Value> {
    effective(agent).config.get("presets").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub(crate) fn effective(agent: &Doc) -> Effective {
    effective_keeping(agent, &[])
}

/// `effective`, except that the presets with an id in `written` stay as a save wrote them. The
/// runtime adopts the config it just saved without a reload, so those still hold what the
/// loader's `normalizePreset` drops (`modelParameters`).
pub(crate) fn effective_keeping(agent: &Doc, written: &[String]) -> Effective {
    let stored = crate::config::patch::stored_form(agent);
    let default = stored.get("default").cloned().unwrap_or(Value::Null);
    let normalized = |preset: &Value| {
        let id = first_text(preset, &["id", "name"]);
        if written.contains(&id) { Some(preset.clone()) } else { normalize_preset(preset) }
    };
    let mut presets: Vec<Value> = agent
        .get("presets")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(normalized).filter(|preset| preset.get("id").and_then(Value::as_str) != Some("workflow-search")).collect())
        .unwrap_or_default();
    let key = |preset: &Value| first_text(preset, &["id", "name"]);
    let present: Vec<String> = presets.iter().map(key).collect();
    presets.extend(default_presets().into_iter().filter(|shipped| !present.contains(&key(shipped))));
    let default_id = if truthy(Some(&default)) { js_trim(&value_to_string(&default)).to_owned() } else { String::new() };
    presets.retain(|preset| !redundant_generated(preset, &default_id));
    let mut config = Obj::new();
    config.insert("presets".into(), Value::Array(presets));
    config.insert("default".into(), default);
    let agents = stored.get("agents").and_then(Value::as_object).cloned().unwrap_or_default();
    let onboarding = agent.get("onboarding").and_then(Value::as_object).cloned().unwrap_or_default();
    Effective { config, agents, onboarding }
}

/// `routeFromPreset(config, slotValue)`.
fn route_from_preset(config: &Obj, slot: &Value) -> Result<Option<Value>, String> {
    let empty = Value::Object(Map::new());
    if slot.is_object()
        && let Some(direct) = normalize_workflow_route(slot, &empty, false)?
    {
        return Ok(Some(direct));
    }
    match find_preset(config, Some(slot)) {
        Some(preset) => normalize_workflow_route(preset, &empty, false),
        None => Ok(None),
    }
}

/// `agentRouteFromConfig(config, agentId)` for an id that is no fixed role alias.
fn agent_route(effective: &Effective, id: &str) -> Result<Option<Value>, String> {
    let Some(candidate) = effective.agents.get(id).filter(|route| truthy(Some(*route))) else { return Ok(None) };
    route_of_candidate(&effective.config, candidate)
}

/// One candidate of `agentRouteFromConfig`: a route as it is, else the preset it names (the
/// legacy preset-name form).
pub(crate) fn route_of_candidate(config: &Obj, candidate: &Value) -> Result<Option<Value>, String> {
    let empty = Value::Object(Map::new());
    if let Some(route) = normalize_workflow_route(candidate, &empty, false)? {
        return Ok(Some(route));
    }
    route_from_preset(config, candidate)
}

/// The agents whose routes `summarizeWorkflowRoutes` reads, by the slot they fill.
pub(crate) const SUMMARY_AGENTS: [(&str, &str); 2] = [("agent", "worker"), ("memory", "maintainer")];

/// What the bot store answered for the agents of [`SUMMARY_AGENTS`] (`AgentRoutes::store_bot_route`): the agent and its
/// route, `None` for a store bot with none. An agent that is no store bot is absent.
pub(crate) type BotRoutes = Vec<(String, Option<Value>)>;

impl Effective {
    /// A store bot's route lives with the bot, never in the config (`configuredAgentRouteCandidates` asks the bot store
    /// first): its answer replaces the config's, and a bot without a route has none.
    pub(crate) fn with_bot_routes(mut self, bots: &BotRoutes) -> Self {
        for (id, route) in bots {
            match route {
                Some(route) => {
                    self.agents.insert(id.clone(), route.clone());
                }
                None => {
                    self.agents.shift_remove(id);
                }
            }
        }
        self
    }
}

/// `summarizeWorkflowRoutes(config)`: the Lead route of the default preset, the worker route as
/// `agent`, the maintainer route as `memory`.
pub(crate) fn summarize_workflow_routes(effective: &Effective) -> Result<Value, String> {
    let mut out = Map::new();
    let default = effective.config.get("default").cloned().unwrap_or(Value::Null);
    if let Some(lead) = route_from_preset(&effective.config, &default)? {
        out.insert("lead".into(), lead);
    }
    for (slot, id) in SUMMARY_AGENTS {
        if let Some(route) = agent_route(effective, id)? {
            out.insert(slot.into(), route);
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_presets_lie_under_the_stored_ones() {
        let agent: Doc = serde_json::from_value(json!({
            "default": "sonnet-high",
            "presets": [{ "id": "mine", "provider": "openai-api", "model": "gpt-x", "fast": true }],
        }))
        .unwrap();
        let view = effective(&agent);
        let presets = view.config["presets"].as_array().unwrap();
        assert_eq!(presets[0]["provider"], "openai");
        assert_eq!(presets[0]["fast"], true);
        assert_eq!(presets.len(), 6);
        let summary = summarize_workflow_routes(&view).unwrap();
        assert_eq!(summary["lead"]["effort"], "high");
    }
}
