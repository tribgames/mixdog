use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::clean_model_parameters;
use mixdog_ai::service::admin_route::find_preset;
use mixdog_ai::service::admin_route::normalize_workflow_route;
use mixdog_ai::service::admin_route::workflow_preset_id;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::ids::Doc;
use super::ids::clean;
use super::ids::truthy;

const AGENT_PROVIDER_ALIASES: [(&str, &str); 3] = [("openai-api", "openai"), ("gemini-api", "gemini"), ("xai-api", "xai")];
const FAST_CAPABLE_PRESET_PROVIDERS: [&str; 6] = ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "cursor-oauth", "cursor-api"];

/// `String(a || b || '')` for a preset's own fields.
fn first_text(preset: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = preset.get(key).filter(|value| truthy(Some(*value))) {
            return value_to_string(value);
        }
    }
    String::new()
}

/// `normalizeMaintenanceRoutes(rawMaint)` (`config-storage.mjs`): a slot that is no object, or whose route lacks a provider or a
/// model, is dropped; a kept route holds the provider (its alias resolved), the model, a non-empty `effort`, `fast: true` and
/// explicit boolean `autoEffort`, nothing else.
pub(crate) fn normalize_maintenance_routes(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (slot, value) in raw {
        let Some(route) = value.as_object() else { continue };
        let provider = js_trim(&first_text(value, &["provider"])).to_owned();
        let provider = AGENT_PROVIDER_ALIASES.iter().find(|(alias, _)| *alias == provider).map_or(provider.clone(), |(_, id)| (*id).to_owned());
        let model = js_trim(&first_text(value, &["model"])).to_owned();
        if provider.is_empty() || model.is_empty() {
            continue;
        }
        let mut kept = Map::new();
        kept.insert("provider".into(), Value::String(provider));
        kept.insert("model".into(), Value::String(model));
        let effort = js_trim(&first_text(value, &["effort"])).to_owned();
        if !effort.is_empty() {
            kept.insert("effort".into(), Value::String(effort));
        }
        if route.get("fast") == Some(&Value::Bool(true)) {
            kept.insert("fast".into(), Value::Bool(true));
        }
        mixdog_ai::effort::EffortAuto::carry_field_map(route, &mut kept);
        out.insert(slot.clone(), Value::Object(kept));
    }
    out
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
    let lead = id == workflow_preset_id("lead");
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
    mixdog_ai::effort::EffortAuto::carry_field_map(map, &mut out);
    // The Lead preset alone holds its saved speed: an explicit Standard and the selected
    // parameters (Ultrafast's `serviceTier`). Dropping them made a reloaded or published Lead
    // read back at another speed; ordinary presets keep their shape.
    if lead {
        if map.get("fast") == Some(&Value::Bool(false)) {
            out.insert("fast".into(), Value::Bool(false));
        }
        let parameters = clean_model_parameters(map.get("modelParameters"));
        if !parameters.is_empty() {
            out.insert("modelParameters".into(), Value::Object(parameters));
        }
    }
    let tools = map.get("tools").and_then(Value::as_str).filter(|tools| ["full", "readonly", "mcp"].contains(tools)).unwrap_or("full");
    out.insert("tools".into(), json!(tools));
    if let Some(fallbacks) = map.get("fallbacks").filter(|fallbacks| fallbacks.as_array().is_some_and(|list| !list.is_empty())) {
        out.insert("fallbacks".into(), fallbacks.clone());
    }
    Some(Value::Object(out))
}

/// The stored web-search selection. The save diffs this projection, so omitting
/// the chain would turn a fallback-only speed change into an empty patch.
pub(crate) fn stored_web_search_route(route: &Value) -> Value {
    let mut primary = stored_search_leaf(route);
    if let Some(fields) = primary.as_object_mut()
        && let Some(chain) = route.get("fallbacks").and_then(Value::as_array)
        && !chain.is_empty()
    {
        fields.insert("fallbacks".into(), Value::Array(chain.iter().map(stored_search_leaf).collect()));
    }
    primary
}

fn stored_search_leaf(route: &Value) -> Value {
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
    if let Some(fast) = map.get("fast").and_then(Value::as_bool) {
        out.insert("fast".into(), Value::Bool(fast));
    }
    if let Some(params) = map.get("modelParameters").filter(|v| v.is_object()) {
        out.insert("modelParameters".into(), params.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `normalizeMaintenanceRoutes`: only the slots with a provider and a model stay, holding the fields the route states.
    #[test]
    fn a_maintenance_slot_keeps_its_route_fields_and_nothing_else() {
        let raw: Doc = serde_json::from_value(json!({
            "webhook": { "provider": " openai-api ", "model": " gpt-x ", "effort": " high ", "fast": true, "effortAuto": false, "note": "extra" },
            "plain": { "provider": "anthropic", "model": "m", "effort": "  ", "fast": "yes", "effortAuto": true },
            "nomodel": { "provider": "anthropic" },
            "text": "anthropic/m",
            "list": [1],
        }))
        .unwrap();
        let kept = normalize_maintenance_routes(&raw);
        assert_eq!(
            Value::Object(kept),
            json!({
                "webhook": { "provider": "openai", "model": "gpt-x", "effort": "high", "fast": true, "effortAuto": false },
                "plain": { "provider": "anthropic", "model": "m", "effortAuto": true },
            })
        );
    }

    #[test]
    fn explicit_effort_auto_survives_preset_storage_and_default_presets_follow_switch() {
        let route = json!({ "provider": "openai", "model": "gpt-5", "effortAuto": true });
        let mut config = Obj::new();
        mixdog_ai::service::admin_route::persist_lead_route(&mut config, &route).unwrap();
        let mut agent: Doc = config.into_iter().collect();
        agent.insert("modules".into(), json!({ "autoEffort": { "enabled": false } }));
        agent.insert("maintenance".into(), json!({ "webhook": { "provider": "openai", "model": "gpt-5", "effortAuto": true } }));

        let stored = crate::config::patch::stored_form(&agent);
        assert_eq!(stored["presets"][0]["effortAuto"], json!(true), "Lead preset keeps explicit effortAuto: true");
        assert_eq!(effective_presets(&agent)[0]["effortAuto"], json!(true), "effective Lead preset keeps explicit effortAuto: true");
        let maint = normalize_maintenance_routes(agent["maintenance"].as_object().unwrap());
        assert_eq!(maint["webhook"]["effortAuto"], json!(true), "maintenance slot keeps explicit effortAuto: true");

        // Default presets follow the legacy switch on creation (matching shipped_default_presets).
        let on_agent: Doc = serde_json::from_value(json!({ "modules": { "autoEffort": { "enabled": true } } })).unwrap();
        let off_agent: Doc = serde_json::from_value(json!({ "modules": { "autoEffort": { "enabled": false } } })).unwrap();
        for preset in effective_presets(&on_agent) {
            assert_eq!(preset["effortAuto"], json!(true), "switch-on default preset {} uses Auto", preset["id"]);
        }
        for preset in effective_presets(&off_agent) {
            assert_eq!(preset["effortAuto"], json!(false), "switch-off default preset {} uses Manual", preset["id"]);
        }
    }

    /// A saved Lead reads back, reloads and publishes at the speed it was saved at: an explicit Standard and
    /// Ultrafast's service tier survive the preset projection.
    #[test]
    fn a_preset_keeps_its_saved_speed() {
        let lead = |extra: Value| {
            let mut preset = json!({ "id": "workflow-lead", "name": "WORKFLOW LEAD", "provider": "openai-oauth", "model": "gpt-x" });
            preset.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            normalize_preset(&preset).unwrap()
        };
        let ultra = lead(json!({ "fast": true, "modelParameters": { "serviceTier": " ultrafast ", "empty": " " } }));
        assert_eq!((ultra["fast"].clone(), ultra["modelParameters"].clone()), (json!(true), json!({ "serviceTier": "ultrafast" })));
        let standard = lead(json!({ "fast": false, "modelParameters": {} }));
        assert_eq!(standard["fast"], false);
        assert!(standard.get("modelParameters").is_none(), "no selected parameter, nothing kept");
        let ordinary = normalize_preset(
            &json!({ "id": "mine", "provider": "openai-oauth", "model": "gpt-x", "fast": false, "modelParameters": { "serviceTier": "ultrafast" } }),
        )
        .unwrap();
        assert!(ordinary.get("fast").is_none() && ordinary.get("modelParameters").is_none(), "an ordinary preset keeps its shape");
        let agent: Doc = serde_json::from_value(json!({
            "default": "workflow-lead",
            "presets": [{ "id": "workflow-lead", "provider": "openai-oauth", "model": "gpt-x", "fast": true, "modelParameters": { "serviceTier": "ultrafast" } }],
        }))
        .unwrap();
        assert_eq!(effective_presets(&agent)[0]["modelParameters"], json!({ "serviceTier": "ultrafast" }), "the listed presets");
        let stored = crate::config::patch::stored_form(&agent);
        assert_eq!(stored["presets"][0]["modelParameters"], json!({ "serviceTier": "ultrafast" }), "the saved file");
    }

    /// The user's case, persisted: slot 1 saved at Ultrafast with only slot 2's speed edited. The written,
    /// stored and listed Lead keep slot 1's speed and slot 2's new one.
    #[test]
    fn a_slot_two_only_edit_persists_both_speeds() {
        let route = json!({
            "provider": "openai-oauth", "model": "gpt-5", "effort": "high", "fast": true,
            "modelParameters": { "serviceTier": "ultrafast" },
            "fallbacks": [{ "provider": "anthropic-oauth", "model": "claude-opus-4-5", "fast": true }],
        });
        let mut config = Obj::new();
        mixdog_ai::service::admin_route::persist_lead_route(&mut config, &route).unwrap();
        let agent: Doc = serde_json::from_value(Value::Object(config.into_iter().collect())).unwrap();
        let stored = crate::config::patch::stored_form(&agent);
        let listed = effective_presets(&agent);
        for lead in [&stored["presets"][0], listed.iter().find(|preset| preset["id"] == "workflow-lead").unwrap()] {
            assert_eq!((lead["fast"].clone(), lead["modelParameters"].clone()), (json!(true), json!({ "serviceTier": "ultrafast" })), "slot 1");
            assert_eq!(lead["fallbacks"][0]["fast"], true, "slot 2");
        }
    }

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
pub(crate) fn default_maintenance_for(legacy_switch_on: bool) -> Map<String, Value> {
    let mut slots = Map::new();
    slots.insert(
        "webhook".into(),
        json!({
            "provider": "anthropic-oauth",
            "model": anthropic_family_model("haiku"),
            "effortAuto": mixdog_ai::effort::EffortAuto::default_for_new(legacy_switch_on).as_bool(),
        }),
    );
    slots
}
/// `withDefaultPresets(stored)`: the stored presets, then the shipped ones whose id none of them has.
pub fn with_default_presets(stored: Option<&Value>) -> Vec<Value> {
    with_default_presets_for(stored, true)
}
pub fn with_default_presets_for(stored: Option<&Value>, legacy_switch_on: bool) -> Vec<Value> {
    let mut list: Vec<Value> = stored.and_then(Value::as_array).cloned().unwrap_or_default();
    let key = |preset: &Value| first_text(preset, &["id", "name"]);
    let present: Vec<String> = list.iter().map(key).collect();
    list.extend(default_presets_for(legacy_switch_on).into_iter().filter(|shipped| !present.contains(&key(shipped))));
    list
}
/// `DEFAULT_PRESETS`: shipped agent presets take the creation default from the legacy switch.
pub(crate) fn default_presets_for(legacy_switch_on: bool) -> Vec<Value> {
    let effort_auto = mixdog_ai::effort::EffortAuto::default_for_new(legacy_switch_on).as_bool();
    let preset = |id: &str, name: &str, family: &str, effort: Option<&str>| {
        let mut preset = json!({
            "id": id,
            "name": name,
            "type": "agent",
            "provider": "anthropic-oauth",
            "model": anthropic_family_model(family),
            "effortAuto": effort_auto,
        });
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
/// The effective presets of `agent`: what `loadConfig().presets` holds.
pub fn effective_presets(agent: &Doc) -> Vec<Value> {
    effective(agent).config.get("presets").and_then(Value::as_array).cloned().unwrap_or_default()
}
pub(crate) fn effective(agent: &Doc) -> Effective {
    effective_keeping(agent, &[])
}
/// `effective`, except that the presets with an id in `written` stay as a save wrote them. The
/// runtime adopts the config it just saved without a reload, so those still hold what the
/// loader's `normalizePreset` drops (a context window, a non-string parameter).
pub(crate) fn effective_keeping(agent: &Doc, written: &[String]) -> Effective {
    let legacy_switch_on = mixdog_ai::service::admin_route::config_default_auto_effort(agent);
    let stored = crate::config::patch::stored_form(agent);
    let default = stored.get("default").cloned().unwrap_or(Value::Null);
    let normalized = |preset: &Value| {
        let id = first_text(preset, &["id", "name"]);
        if written.contains(&id) {
            Some(preset.clone())
        } else {
            normalize_preset(preset).map(|mut p| {
                if let Some(map) = p.as_object_mut() {
                    mixdog_ai::effort::EffortAuto::convert_on_load(map, legacy_switch_on);
                }
                p
            })
        }
    };
    let mut presets: Vec<Value> = agent
        .get("presets")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(normalized).filter(|preset| preset.get("id").and_then(Value::as_str) != Some("workflow-search")).collect())
        .unwrap_or_default();
    let key = |preset: &Value| first_text(preset, &["id", "name"]);
    let present: Vec<String> = presets.iter().map(key).collect();
    presets.extend(default_presets_for(legacy_switch_on).into_iter().filter(|shipped| !present.contains(&key(shipped))));
    let default_id = if truthy(Some(&default)) { js_trim(&value_to_string(&default)).to_owned() } else { String::new() };
    presets.retain(|preset| !redundant_generated(preset, &default_id));
    let mut config = Obj::new();
    config.insert("presets".into(), Value::Array(presets));
    config.insert("default".into(), default);
    let agents = stored.get("agents").and_then(Value::as_object).cloned().unwrap_or_default();
    let onboarding = agent.get("onboarding").and_then(Value::as_object).cloned().unwrap_or_default();
    Effective { config, agents, onboarding }
}
/// `agentRouteFromConfig(config, agentId)` for an id that is no fixed role alias.
fn agent_route(effective: &Effective, id: &str) -> Result<Option<Value>, String> {
    let Some(candidate) = effective.agents.get(id).filter(|route| truthy(Some(*route))) else { return Ok(None) };
    route_of_candidate(&effective.config, candidate)
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
mod auto_effort_tests {
    use super::*;
    use mixdog_ai::effort::EffortAuto;

    #[test]
    fn effort_auto_states_survive_preset_storage() {
        for (label, state) in [("auto", EffortAuto::Auto), ("manual", EffortAuto::Manual)] {
            let mut raw = json!({
                "id": format!("p-{label}"),
                "name": format!("P {label}"),
                "provider": "openai",
                "model": "gpt-5",
                "effort": "high",
                "fallbacks": [{ "provider": "anthropic", "model": "opus", "effort": "medium" }],
            });
            state.write_to(raw.as_object_mut().unwrap());
            state.write_to(raw["fallbacks"][0].as_object_mut().unwrap());

            let normalized = normalize_preset(&raw).expect("normalized preset");
            assert_eq!(EffortAuto::read_explicit_value(&normalized), Some(state), "normalize_preset preserves {label}");
            assert_eq!(EffortAuto::read_explicit_value(&normalized["fallbacks"][0]), Some(state), "preset fallback preserves {label}");

            let mut doc = Obj::new();
            doc.insert("presets".into(), json!([raw]));
            let presets = effective_presets(&doc);
            let stored = presets.iter().find(|p| p["id"] == json!(format!("p-{label}"))).expect("effective preset");
            assert_eq!(EffortAuto::read_explicit_value(stored), Some(state), "effective_presets preserves {label}");

            let mut maint = json!({ "webhook": { "provider": "openai", "model": "gpt-5", "effort": "low" } });
            state.write_to(maint["webhook"].as_object_mut().unwrap());
            let normalized_maint = normalize_maintenance_routes(maint.as_object().unwrap());
            assert_eq!(EffortAuto::read_explicit_value(&normalized_maint["webhook"]), Some(state), "normalize_maintenance_routes preserves {label}");
        }
    }
}
