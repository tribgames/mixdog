//! The canonical stored form of the agent section: Node's `canonicalizeAgentStorage` and
//! `agentConfigStorageNeedsMigration` (`orchestrator/config-storage.mjs`), `storedAgentForm`
//! (`orchestrator/config.mjs`), and the openai-oauth catalog successors they read
//! (`providers/openai-oauth-catalog-store.mjs`, `shared/llm/openai-daybreak.mjs`).
//!
//! Node's `loadConfig` runs it after the defaults separation: a stored section that is not canonical
//! is rewritten once (retired local providers and fields, incomplete routes, routes on a model the
//! saved catalog has superseded, `providers: {}`, `webSearchRoute: null`, …). The boot pass does the
//! same ([`Shared::separate_on`](super::Shared)).

use std::path::Path;

use mixdog_js::js_trim;
use mixdog_js::json_stringify;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::patch::js_deep_equal;
use super::patch::strip_agent_section_defaults;
use crate::workflow::ids::truthy;
use crate::workflow::presets::normalize_preset;
use crate::workflow::presets::redundant_generated;
use crate::workflow::presets::stored_web_search_route;

type Doc = Map<String, Value>;

const RETIRED_LOCAL_PROVIDER_IDS: [&str; 2] = ["ollama", "lmstudio"];
/// `RETIRED_AGENT_FIELDS`.
const RETIRED_AGENT_FIELDS: [&str; 9] =
    ["fastModels", "agentMaintenance", "runtime", "search", "searchRoute", "capabilities", "defaultProvider", "guide", "mcpProjectOverrides"];
const CODEX_PROVIDER_ID: &str = "openai-oauth";
/// `CODEX_MODEL_CACHE_OPTIONS`.
const CODEX_CACHE_FILE: &str = "openai-oauth-models.json";
const CODEX_CACHE_VERSION: i64 = 7;
const DAYBREAK_BLUE_PROGRAM: &str = "daybreak_blue";
const STANDARD_PROGRAM: &str = "standard";

// ---- the saved openai-oauth catalog -----------------------------------------------------------------

/// `loadSavedCodexCatalog()`: the models of the last saved catalog, stale or not; none when no catalog was
/// ever fetched or the file is not a catalog of this version (`makeModelCache(...).loadSync({ allowStale })`).
pub(super) fn saved_catalog(data_dir: &Path) -> Option<Vec<Value>> {
    let bytes = mixdog_statefile::read_content(&data_dir.join(CODEX_CACHE_FILE)).ok()??;
    let record: Value = mixdog_statefile::parse_json_text(&bytes).ok()?;
    if record.get("version").and_then(Value::as_i64) != Some(CODEX_CACHE_VERSION) || !truthy(record.get("fetchedAt")) {
        return None;
    }
    record.get("models").and_then(Value::as_array).cloned()
}

/// `accessProgramOnly(model)`: the program a model exists only for.
fn access_program_only(model: &Value) -> Option<&Value> {
    let programs = model.get("accessPrograms")?.as_array()?;
    if programs.is_empty() || programs.iter().any(|program| program.as_str() == Some(STANDARD_PROGRAM)) {
        return None;
    }
    programs.first()
}

/// A route's catalog successor: the model it moves to, and the parameters that select the access program.
struct Successor {
    model: Value,
    parameters: Option<Value>,
}

/// `codexModelSuccessor(models, modelId, now)`.
fn successor(models: &[Value], model_id: &str, now_ms: i64) -> Option<Successor> {
    if model_id.is_empty() {
        return None;
    }
    let entry = models.iter().find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))?;
    if let Some(program) = access_program_only(entry) {
        // `accessProgramModelParameters`: only Daybreak Blue has a toggle.
        if program.as_str() != Some(DAYBREAK_BLUE_PROGRAM) {
            return None;
        }
        let priority = |model: &Value| model.get("priority").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
        let mut targets: Vec<&Value> = models
            .iter()
            .filter(|model| {
                truthy(model.get("id"))
                    && model.get("id").and_then(Value::as_str) != Some(model_id)
                    && model.get("hidden") != Some(&Value::Bool(true))
                    && access_program_only(model).is_none()
                    && model.get("accessPrograms").and_then(Value::as_array).is_some_and(|programs| programs.contains(program))
            })
            .collect();
        targets.sort_by(|a, b| priority(a).total_cmp(&priority(b)));
        return targets.first().map(|target| Successor { model: target["id"].clone(), parameters: Some(json!({ "daybreak": "on" })) });
    }
    let upgrade = entry.get("upgrade")?;
    let retires_at = chrono::DateTime::parse_from_rfc3339(upgrade.get("retirementAt").and_then(Value::as_str).unwrap_or_default()).ok()?.timestamp_millis();
    (truthy(upgrade.get("model")) && retires_at <= now_ms).then(|| Successor { model: upgrade["model"].clone(), parameters: None })
}

fn provider_of(route: &Value) -> String {
    route.get("provider").filter(|provider| truthy(Some(*provider))).map(mixdog_js::value_to_string).map(|text| js_trim(&text).to_owned()).unwrap_or_default()
}

/// `migrateCodexRoute(route, models)`: `None` when the route stays.
fn migrated_route(route: &Value, models: &[Value], now_ms: i64) -> Option<Value> {
    if provider_of(route) != CODEX_PROVIDER_ID {
        return None;
    }
    let model = route.get("model").filter(|model| truthy(Some(*model))).map(mixdog_js::value_to_string).unwrap_or_default();
    let moved = successor(models, js_trim(&model), now_ms)?;
    let mut next = route.as_object()?.clone();
    next.insert("model".into(), moved.model);
    if moved.parameters.is_some() || next.contains_key("modelParameters") {
        let mut parameters = route.get("modelParameters").and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, value) in moved.parameters.as_ref().and_then(Value::as_object).into_iter().flatten() {
            parameters.insert(key.clone(), value.clone());
        }
        next.insert("modelParameters".into(), Value::Object(parameters));
    }
    Some(Value::Object(next))
}

fn migrate(route: &Value, models: &[Value], now_ms: i64) -> Value {
    migrated_route(route, models, now_ms).unwrap_or_else(|| route.clone())
}

/// `supersededCodexSettingsKey(key, models)`.
fn superseded_settings_key(key: &str, models: &[Value], now_ms: i64) -> bool {
    key.strip_prefix("openai-oauth/").is_some_and(|model| successor(models, model, now_ms).is_some())
}

// ---- the canonical section ----------------------------------------------------------------------

fn is_retired_local_route(route: &Value) -> bool {
    RETIRED_LOCAL_PROVIDER_IDS.contains(&provider_of(route).as_str())
}

fn is_retired_local_model_key(key: &str) -> bool {
    RETIRED_LOCAL_PROVIDER_IDS.iter().any(|id| key.strip_prefix(*id).is_some_and(|rest| rest.starts_with('/')))
}

fn object_of(value: Option<&Value>) -> Doc {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `normalizeSkillsConfig(value).disabled`: trimmed, unique and sorted.
fn disabled_skills(value: Option<&Value>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in value.and_then(|skills| skills.get("disabled")).and_then(Value::as_array).into_iter().flatten() {
        let name = js_trim(&mixdog_js::value_to_string(name)).to_owned();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort_by(|a, b| mixdog_js::locale_compare(a, b));
    names
}

/// `normalizeExtensionScopes(value)` kept only when it holds an entry.
fn extension_scopes(value: &Value) -> Option<Value> {
    let scopes = mixdog_mcp::scopes::ExtensionScopes::from_config(value).to_config();
    scopes.as_object().is_some_and(|kinds| kinds.values().any(|kind| kind.as_object().is_some_and(|map| !map.is_empty()))).then_some(scopes)
}

fn set_or_delete(target: &mut Doc, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            target.insert(key.into(), value);
        }
        None => {
            target.shift_remove(key);
        }
    }
}

/// `canonicalizeAgentStorage(value)`.
pub(super) fn canonical_agent_storage(value: &Doc, catalog: &[Value], now_ms: i64) -> Doc {
    let mut next = value.clone();
    super::agent_routes::canonicalize(&mut next);
    let retired_presets: Vec<String> = next
        .get("presets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|preset| is_retired_local_route(preset))
        .map(|preset| ["id", "name"].iter().find_map(|key| preset.get(*key).filter(|v| truthy(Some(*v)))).map(mixdog_js::value_to_string).map(|text| js_trim(&text).to_owned()).unwrap_or_default())
        .filter(|id| !id.is_empty())
        .collect();
    let mut providers = object_of(next.get("providers"));
    for id in RETIRED_LOCAL_PROVIDER_IDS {
        providers.shift_remove(id);
    }
    next.insert("providers".into(), Value::Object(providers));
    let presets: Vec<Value> = next
        .get("presets")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|preset| normalize_preset(&migrate(preset, catalog, now_ms))).filter(|preset| !is_retired_local_route(preset)).collect())
        .unwrap_or_default();
    next.insert("presets".into(), Value::Array(presets));
    let default = next.get("default").filter(|v| truthy(Some(*v))).map(mixdog_js::value_to_string).map(|text| js_trim(&text).to_owned()).unwrap_or_default();
    if retired_presets.contains(&default) {
        next.insert("default".into(), Value::Null);
    }
    for key in ["agents", "maintenance"] {
        let routes: Doc = object_of(next.get(key))
            .into_iter()
            .filter(|(_, route)| !is_retired_local_route(route))
            .map(|(id, route)| {
                let route = migrate(&route, catalog, now_ms);
                (id, route)
            })
            .collect();
        next.insert(key.into(), Value::Object(routes));
    }
    // A superseded model's own settings have no model left to apply to.
    let settings: Doc = object_of(value.get("modelSettings"))
        .into_iter()
        .filter(|(key, _)| !is_retired_local_model_key(key) && !superseded_settings_key(key, catalog, now_ms))
        .collect();
    next.insert("modelSettings".into(), Value::Object(settings));
    super::separation::canonicalize_sections(&mut next);
    if next.contains_key("profile") {
        let profile = super::settings::normalize_profile(next.get("profile"));
        next.insert("profile".into(), Value::Object(profile));
    }
    if next.contains_key("skills") {
        let disabled = disabled_skills(next.get("skills"));
        set_or_delete(&mut next, "skills", (!disabled.is_empty()).then(|| json!({ "disabled": disabled })));
    }
    if next.contains_key("extensionScopes") {
        let scopes = extension_scopes(&next["extensionScopes"]);
        set_or_delete(&mut next, "extensionScopes", scopes);
    }
    let web = stored_web_search_route(next.get("webSearchRoute").unwrap_or(&Value::Null));
    next.insert("webSearchRoute".into(), web);
    for key in RETIRED_AGENT_FIELDS {
        next.shift_remove(key);
    }
    next
}

fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    a.map(json_stringify) == b.map(json_stringify)
}

/// `agentRouteStorageNeedsMigration(config)`.
fn route_storage_needs_migration(value: &Doc) -> bool {
    let agents = object_of(value.get("agents"));
    let maintenance = object_of(value.get("maintenance"));
    let disabled = super::agent_routes::id_list(value.get("disabledAgents"));
    let default = value.get("default").filter(|v| truthy(Some(*v))).map(mixdog_js::value_to_string).map(|text| js_trim(&text).to_owned()).unwrap_or_default();
    let stored_disabled = value.get("disabledAgents");
    let canonical_disabled = (!disabled.is_empty()).then(|| json!(disabled));
    value.contains_key("workflowRoutes")
        || (stored_disabled.is_some() && !same_json(stored_disabled, canonical_disabled.as_ref()))
        || agents.contains_key("maintenance")
        || maintenance.contains_key("memory")
        || agents.values().any(|route| !super::agent_routes::is_complete(route))
        || value.get("presets").and_then(Value::as_array).is_some_and(|presets| presets.iter().any(|preset| redundant_generated(preset, &default)))
}

/// `agentConfigStorageNeedsMigration(value)`.
pub(super) fn storage_needs_migration(value: &Doc, catalog: &[Value], now_ms: i64) -> bool {
    let presets: &[Value] = value.get("presets").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let agents = object_of(value.get("agents"));
    let maintenance = object_of(value.get("maintenance"));
    let superseded = |route: &Value| migrated_route(route, catalog, now_ms).is_some();
    let retired_local = value.get("providers").and_then(Value::as_object).is_some_and(|providers| RETIRED_LOCAL_PROVIDER_IDS.iter().any(|id| providers.contains_key(*id)))
        || presets.iter().any(is_retired_local_route)
        || agents.values().any(is_retired_local_route)
        || maintenance.values().any(is_retired_local_route)
        || object_of(value.get("modelSettings")).keys().any(|key| is_retired_local_model_key(key));
    let superseded_routes = presets.iter().any(superseded)
        || agents.values().any(superseded)
        || maintenance.values().any(superseded)
        || object_of(value.get("modelSettings")).keys().any(|key| superseded_settings_key(key, catalog, now_ms));
    if route_storage_needs_migration(value) || retired_local || superseded_routes {
        return true;
    }
    if RETIRED_AGENT_FIELDS.iter().any(|key| *key != "guide" && value.contains_key(*key)) || presets.iter().any(|preset| normalize_preset(preset).is_none()) {
        return true;
    }
    if value.get("modules").and_then(Value::as_object).is_some_and(|modules| modules.contains_key("memory")) {
        return true;
    }
    let canonical = canonical_agent_storage(value, catalog, now_ms);
    ["autoClear", "compaction", "shell", "profile", "skills", "extensionScopes", "modules", "guide"].iter().any(|key| !same_json(value.get(*key), canonical.get(*key)))
}

/// `storedAgentForm(agent)` of a file at the current version: the section defaults and the shipped route
/// defaults are not stored.
pub(super) fn stored_agent_form(agent: &Doc) -> Doc {
    let mut stripped = super::separation::resolve_numeric_default(agent);
    strip_agent_section_defaults(&mut stripped);
    super::separation::strip_stored_route_defaults(&stripped)
}

/// The canonical stored section, or `None` when the stored one already is.
pub(super) fn migrated_agent(agent: &Doc, catalog: &[Value], now_ms: i64) -> Option<Doc> {
    if agent.is_empty() || !storage_needs_migration(agent, catalog, now_ms) {
        return None;
    }
    let next = stored_agent_form(&canonical_agent_storage(agent, catalog, now_ms));
    (!js_deep_equal(&Value::Object(next.clone()), &Value::Object(agent.clone()))).then_some(next)
}
