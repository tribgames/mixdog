//! The route a spawned worker runs on (Node `agent-tool/spawn-preset.mjs` and the preset
//! helpers of `agent-tool/helpers.mjs`), and the task meta a spawn carries
//! (`job-views/spawn-meta.mjs`).

use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::admin_route::clean;
use mixdog_ai::service::admin_route::find_preset;
use mixdog_ai::service::admin_route::jnum;
use mixdog_ai::service::admin_route::normalize_context_tokens;
use mixdog_ai::service::admin_route::number;
use mixdog_ai::service::admin_route::truthy;
use mixdog_ai::service::routes::execution_fallbacks;
use serde_json::Map;
use serde_json::Value;

use crate::agent_tool::board::JobMeta;
use crate::agent_tool::scope::normalize_agent_name;

/// `findPreset(config, key)` over a config that is not an object: nothing.
fn preset_in<'a>(config: &'a Obj, key: Option<&Value>) -> Option<&'a Value> {
    find_preset(config, key)
}

/// `presetKey`: `clean(preset?.id || preset?.name)`.
pub fn preset_key(preset: Option<&Value>) -> String {
    let id = preset.and_then(|p| p.get("id"));
    if truthy(id) { clean(id) } else { clean(preset.and_then(|p| p.get("name"))) }
}

/// `agentPresetName`: `AGENT ${agent.toUpperCase()}`.
pub fn agent_preset_name(agent: &str) -> String {
    format!("AGENT {}", agent.to_uppercase())
}

/// `PRESET_ALIASES` and `synthesizePreset`: a named variant of a stored preset.
fn synthesize_preset(config: &Obj, key: &str) -> Option<Value> {
    let (alias, base, effort, name) = match key.to_lowercase().as_str() {
        "opus-xhigh" => ("opus-xhigh", "opus-high", "xhigh", "OPUS XHIGH"),
        _ => return None,
    };
    let base = preset_in(config, Some(&Value::from(base)))?;
    let mut out = base.as_object()?.clone();
    out.insert("id".into(), alias.into());
    out.insert("name".into(), name.into());
    out.insert("effort".into(), effort.into());
    Some(Value::Object(out))
}

/// `normalizeAgentRoute`: the route fields a provider/model pair carries, or nothing.
pub fn normalize_agent_route(route: Option<&Value>) -> Option<Obj> {
    let route = route?;
    let provider = clean(route.get("provider"));
    let model = clean(route.get("model"));
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let mut out = Obj::new();
    out.insert("provider".into(), provider.into());
    out.insert("model".into(), model.into());
    let effort = clean(route.get("effort"));
    if !effort.is_empty() {
        out.insert("effort".into(), effort.into());
    }
    out.insert("fast".into(), (route.get("fast") == Some(&Value::Bool(true))).into());
    if route.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), false.into());
    }
    match route.get("modelParameters") {
        Some(Value::Object(o)) => {
            out.insert("modelParameters".into(), Value::Object(o.clone()));
        }
        // Spreading an array into an object keys it by index.
        Some(Value::Array(a)) => {
            let spread: Map<String, Value> = a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect();
            out.insert("modelParameters".into(), Value::Object(spread));
        }
        _ => {}
    }
    let percent = number(route.get("contextPercent"));
    if percent > 0.0 {
        out.insert("contextPercent".into(), jnum(percent));
    }
    if let Some(tokens) = normalize_context_tokens(route.get("contextTokens")) {
        out.insert("contextTokens".into(), jnum(tokens));
    }
    Some(out)
}

/// What a spawn resolves to: the preset's name (the stored preset's id/name, or the request's)
/// and the preset itself.
#[derive(Clone, PartialEq, Debug)]
pub struct SpawnPreset {
    pub preset_name: Value,
    pub preset: Value,
}

/// `resolveAgentSpawnPreset(config, args)`. `candidates` are the agent's configured routes
/// (`configuredAgentRouteCandidates(config, agent)`), looked up by the host.
///
/// A spawn that pins a model (`provider` + `model`) runs on that model with what the model picker
/// selects for it (`args.modelDefaults`: its effort and fast), the effort and fast the caller asked
/// for over that. It has no fallback chain: the named model answers or the failure is the answer.
/// When the agent's route is already on that model, the agent's own settings are the ones that
/// apply, an effort the model does not offer replaced by the model's default; the worker still
/// carries the direct preset identity, so it never follows the agent's configured route later.
pub fn resolve_agent_spawn_preset(config: &Obj, args: &Value, candidates: &[Value]) -> Result<SpawnPreset, String> {
    let arg = |key: &str| args.get(key);
    let agent = normalize_agent_name(&clean(arg("agent")));
    let named = clean(arg("preset"));
    let stored: Option<&Value> = if named.is_empty() { candidates.iter().find(|c| normalize_agent_route(Some(c)).is_some()) } else { None };
    let agent_route = stored.and_then(|c| normalize_agent_route(Some(c)));
    let stored_chain = |route: &Value, candidate: &Value| {
        let mut for_chain = route.clone();
        if let Some(fallbacks) = candidate.get("fallbacks") {
            for_chain["fallbacks"] = fallbacks.clone();
        }
        execution_fallbacks(&for_chain)
    };
    let fallbacks_of = |fallbacks: &[Value]| -> Vec<Value> {
        fallbacks.iter().map(|f| normalize_agent_route(Some(f)).map_or(Value::Null, Value::Object)).collect()
    };
    // The agent's stored fallbacks, as they run behind the agent's own model.
    let agent_chain = match (&agent_route, stored) {
        (Some(route), Some(candidate)) => Some(stored_chain(&Value::Object(route.clone()), candidate)?),
        _ => None,
    };
    let fallback_source = || {
        let mut source = Obj::new();
        source.insert("agent".into(), agent.clone().into());
        Value::Object(source)
    };
    // `strict`: the spawn named its model, so no other model may answer it (no chain, no source).
    let agent_preset = |route: &Obj, fallbacks: &[Value], effort: Option<String>, fast: Option<bool>, strict: bool| {
        // A strict preset is a direct one by identity: the send flow follows the agent's configured
        // route only for a worker on the agent's own preset identity, and a named model is kept for
        // the worker's life, whether or not it is the agent's own.
        let (id, name, preset_name): (String, String, Value) = if strict {
            let named = if truthy(arg("preset")) { arg("preset").cloned().unwrap_or(Value::Null) } else { "__direct__".into() };
            ("__direct__".into(), "__DIRECT__".into(), named)
        } else {
            let name = agent_preset_name(&agent);
            (format!("agent-{agent}"), name.clone(), name.into())
        };
        let mut preset = Obj::new();
        preset.insert("id".into(), id.into());
        preset.insert("name".into(), name.into());
        preset.insert("type".into(), "agent".into());
        preset.insert("provider".into(), route["provider"].clone());
        preset.insert("model".into(), route["model"].clone());
        if !strict {
            if !fallbacks.is_empty() {
                preset.insert("fallbacks".into(), Value::Array(fallbacks_of(fallbacks)));
            }
            preset.insert("fallbackSource".into(), fallback_source());
        }
        if let Some(effort) = effort {
            preset.insert("effort".into(), effort.into());
        }
        preset.insert("fast".into(), fast.map_or_else(|| route["fast"].clone(), Value::from));
        for key in ["autoEffort", "modelParameters", "contextPercent", "contextTokens"] {
            if let Some(v) = route.get(key) {
                preset.insert(key.into(), v.clone());
            }
        }
        preset.insert("tools".into(), "full".into());
        SpawnPreset { preset_name, preset: Value::Object(preset) }
    };

    if truthy(arg("provider")) && truthy(arg("model")) {
        let (provider, model) = (clean(arg("provider")), clean(arg("model")));
        let asked_effort = Some(clean(arg("effort"))).filter(|e| !e.is_empty());
        let asked_fast = arg("fast").map(|f| f == &Value::Bool(true));
        let defaults = arg("modelDefaults");
        let default_effort = Some(clean(defaults.and_then(|d| d.get("effort")))).filter(|e| !e.is_empty());
        if let Some(route) = &agent_route
            && route["provider"] == provider.as_str()
            && route["model"] == model.as_str()
        {
            // The asked effort, else the agent's own, held to what the model offers (when the catalog said).
            let own = asked_effort.or_else(|| Some(clean(route.get("effort"))).filter(|e| !e.is_empty()));
            let offered = defaults.and_then(|d| d.get("efforts")).and_then(Value::as_array);
            let effort = match (&own, offered) {
                (Some(effort), Some(offered)) if !offered.iter().any(|o| *o == effort.as_str()) => default_effort,
                _ => own,
            };
            return Ok(agent_preset(route, &[], effort, asked_fast, true));
        }
        let mut preset = Obj::new();
        preset.insert("id".into(), "__direct__".into());
        preset.insert("name".into(), "__DIRECT__".into());
        preset.insert("type".into(), "agent".into());
        preset.insert("provider".into(), provider.clone().into());
        preset.insert("model".into(), model.clone().into());
        // No fallbacks: a spawn that names its model is answered by that model or fails.
        if let Some(effort) = asked_effort.or(default_effort) {
            preset.insert("effort".into(), effort.into());
        }
        let fast = asked_fast.unwrap_or_else(|| defaults.and_then(|d| d.get("fast")) == Some(&Value::Bool(true)));
        preset.insert("fast".into(), fast.into());
        if arg("autoEffort") == Some(&Value::Bool(false)) {
            preset.insert("autoEffort".into(), false.into());
        }
        preset.insert("tools".into(), "full".into());
        let name = if truthy(arg("preset")) { arg("preset").cloned().unwrap_or(Value::Null) } else { "__direct__".into() };
        return Ok(SpawnPreset { preset_name: name, preset: Value::Object(preset) });
    }

    if let (Some(route), Some(chain)) = (&agent_route, &agent_chain) {
        let effort = Some(clean(route.get("effort"))).filter(|e| !e.is_empty());
        return Ok(agent_preset(route, chain, effort, None, false));
    }

    let main = if named.is_empty() { preset_in(config, config.get("default")) } else { None };
    if let Some(main) = main.filter(|m| normalize_agent_route(Some(m)).is_some()) {
        let name = if truthy(main.get("id")) { main.get("id") } else { main.get("name") };
        let mut preset = main.as_object().cloned().unwrap_or_default();
        preset.insert("fallbackSource".into(), fallback_source());
        return Ok(SpawnPreset { preset_name: name.cloned().unwrap_or(Value::Null), preset: Value::Object(preset) });
    }

    if named.is_empty() {
        return Err(format!("agent: agent \"{agent}\" has no Main model assignment"));
    }
    let stored = preset_in(config, Some(&Value::from(named.as_str())));
    let preset = match stored {
        Some(found) => {
            let mut preset = found.as_object().cloned().unwrap_or_default();
            let mut source = Obj::new();
            source.insert("preset".into(), named.clone().into());
            preset.insert("fallbackSource".into(), Value::Object(source));
            Value::Object(preset)
        }
        None => synthesize_preset(config, &named).ok_or_else(|| format!("agent: preset \"{named}\" not found"))?,
    };
    if normalize_agent_route(Some(&preset)).is_none() {
        return Err(format!("agent: preset \"{named}\" has no complete route"));
    }
    Ok(SpawnPreset { preset_name: named.into(), preset })
}

/// `presetDescriptor`: the route fields every worker row and tag record carries.
pub fn preset_descriptor(agent: &str, preset: &Value, preset_name: &Value) -> Obj {
    let mut out = Obj::new();
    out.insert("agent".into(), agent.into());
    let key = preset_key(Some(preset));
    out.insert("preset".into(), if key.is_empty() { preset_name.clone() } else { key.into() });
    out.insert("provider".into(), preset.get("provider").cloned().unwrap_or(Value::Null));
    out.insert("model".into(), preset.get("model").cloned().unwrap_or(Value::Null));
    let effort = preset.get("effort");
    out.insert("effort".into(), if truthy(effort) { effort.cloned().unwrap_or(Value::Null) } else { Value::Null });
    out.insert("fast".into(), (preset.get("fast") == Some(&Value::Bool(true))).into());
    if preset.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), false.into());
    }
    out
}

fn some(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

/// `preparedSpawnMeta`.
pub fn prepared_spawn_meta(tag: &str, session_id: &str, agent: &str, preset: &Value, preset_name: &Value, respawned: bool) -> JobMeta {
    let key = preset_key(Some(preset));
    JobMeta {
        tag: some(clean_str(tag)),
        session_id: some(session_id.to_owned()),
        agent: some(agent.to_owned()),
        preset: if key.is_empty() { some(clean(Some(preset_name))) } else { Some(key) },
        provider: some(clean(preset.get("provider"))),
        model: some(clean(preset.get("model"))),
        effort: some(clean(preset.get("effort"))),
        fast: Some(preset.get("fast") == Some(&Value::Bool(true))),
        respawned,
        resumed: false,
        auto_effort_off: preset.get("autoEffort") == Some(&Value::Bool(false)),
    }
}

fn clean_str(value: &str) -> String {
    mixdog_js::js_trim(value).to_owned()
}

/// `pendingSpawnMeta`: the card a spawn shows before its session exists. `resolved` is the
/// preset the request resolves to when it names no model of its own (never an error: the
/// card then shows what the request carries).
pub fn pending_spawn_meta(args: &Value, resolved: Option<&Value>, respawned: bool) -> JobMeta {
    let arg = |key: &str| clean(args.get(key));
    let from = |key: &str| clean(resolved.and_then(|r| r.get(key)));
    let first = |own: String, key: &str| some(if own.is_empty() { from(key) } else { own });
    let agent = normalize_agent_name(&arg("agent"));
    let preset = arg("preset");
    let resolved_key = preset_key(resolved);
    JobMeta {
        tag: some(arg("tag")),
        session_id: None,
        agent: some(agent),
        preset: some(if preset.is_empty() { resolved_key } else { preset }),
        provider: first(arg("provider"), "provider"),
        model: first(arg("model"), "model"),
        effort: first(arg("effort"), "effort"),
        fast: (args.get("fast") == Some(&Value::Bool(true)) || resolved.and_then(|r| r.get("fast")) == Some(&Value::Bool(true))).then_some(true),
        respawned,
        resumed: false,
        auto_effort_off: false,
    }
}

/// `mergeJobMeta(job, preparedSpawnMeta(..))`: the prepared spawn's meta over the pending card's.
/// A prepared meta defines every identity key (an unset one is `null`, which still replaces), so
/// those come from the update; the flags (`respawned`, `resumed`, `autoEffort: false`) only ever
/// get added.
pub fn merge_prepared_meta(job: &JobMeta, prepared: &JobMeta) -> JobMeta {
    JobMeta {
        respawned: prepared.respawned || job.respawned,
        resumed: prepared.resumed || job.resumed,
        auto_effort_off: prepared.auto_effort_off || job.auto_effort_off,
        ..prepared.clone()
    }
}
