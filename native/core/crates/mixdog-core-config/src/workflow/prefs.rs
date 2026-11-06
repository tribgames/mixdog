//! `setModelPreferences`: whether each model of one provider is listed in the model picker and
//! whether it is a favorite (`provider-auth/login.mjs`, `services/provider-admin.mjs`
//! `saveModelPreferences`). Both live in `modelSettings["provider/model"]`; a custom
//! provider's visibility is its own `modelOverrides[id].hidden`.

use mixdog_ai::catalog::is_known_provider;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::WorkflowHost;
use super::ids::Doc;

const CHANGES_MAX: usize = 5_000;

/// What a save of model preferences writes and answers.
pub(crate) struct Preferences {
    pub after: Doc,
    pub result: Value,
    pub custom_catalog_changed: bool,
}

struct Change {
    model: String,
    hidden: Option<bool>,
    favorite: Option<bool>,
}

/// `CUSTOM_ID_RE`.
fn is_custom_provider_id(id: &str) -> bool {
    static RE: std::sync::OnceLock<JsRegex> = std::sync::OnceLock::new();
    RE.get_or_init(|| JsRegex::new_static(r"^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", ""))
        .is_match(id)
}

/// `modelPreferenceChanges(raw)`.
fn changes_of(raw: &Value) -> Result<Vec<Change>, String> {
    let invalid = || "model preference changes are invalid".to_owned();
    let list = raw.as_array().filter(|list| list.len() <= CHANGES_MAX).ok_or_else(invalid)?;
    let mut out = Vec::new();
    for change in list {
        let map = change.as_object().ok_or("model preference change is invalid")?;
        if map.keys().any(|key| !matches!(key.as_str(), "model" | "hidden" | "favorite")) {
            return Err("model preference change has unsupported field".into());
        }
        let model = map.get("model").and_then(Value::as_str).map(|model| js_trim(model).to_owned()).unwrap_or_default();
        if model.is_empty() {
            return Err("model id is required".into());
        }
        let mut flags = [None, None];
        for (slot, key) in flags.iter_mut().zip(["hidden", "favorite"]) {
            match map.get(key) {
                None => {}
                Some(Value::Bool(flag)) => *slot = Some(*flag),
                Some(_) => return Err(format!("model preference {key} is invalid")),
            }
        }
        out.push(Change { model, hidden: flags[0], favorite: flags[1] });
    }
    Ok(out)
}

/// The answer of a save that went through, which `provider` and `changes` alone decide.
pub(crate) fn answer(provider: &Value, changes: &Value) -> Result<Value, String> {
    let provider = provider_text(provider);
    let changes = changes_of(changes)?;
    let custom = is_custom_provider_id(&provider) && changes.iter().any(|change| change.hidden.is_some());
    Ok(json!({ "provider": provider, "changed": changes.len(), "customCatalogChanged": custom }))
}

/// `String(rawProvider || '').trim()`.
fn provider_text(provider: &Value) -> String {
    match provider {
        value if super::ids::truthy(Some(value)) => js_trim(&value_to_string(value)).to_owned(),
        _ => String::new(),
    }
}

fn object_of(value: Option<&Value>) -> Map<String, Value> {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `saveModelPreferences(cfgMod, provider, changes)`: the config to store and the answer.
pub(crate) fn prepare(agent: &Doc, provider: &Value, changes: &Value, host: &dyn WorkflowHost) -> Result<Preferences, String> {
    let provider = provider_text(provider);
    let changes = changes_of(changes)?;
    let full = Value::Object(agent.clone());
    if !is_known_provider(&provider, &full, &|id| host.provider_available(id)) {
        return Err(format!("unknown provider \"{provider}\""));
    }
    let custom = is_custom_provider_id(&provider);
    let mut model_settings = object_of(agent.get("modelSettings"));
    for change in &changes {
        let key = format!("{provider}/{}", change.model);
        let mut setting = object_of(model_settings.get(&key));
        if let Some(hidden) = change.hidden
            && !custom
        {
            setting.insert("hidden".into(), Value::Bool(hidden));
        }
        match change.favorite {
            Some(true) => {
                setting.insert("favorite".into(), Value::Bool(true));
            }
            Some(false) => {
                setting.shift_remove("favorite");
            }
            None => {}
        }
        if setting.is_empty() {
            model_settings.shift_remove(&key);
        } else {
            model_settings.insert(key, Value::Object(setting));
        }
    }
    let mut after = agent.clone();
    after.insert("modelSettings".into(), Value::Object(model_settings));
    let hidden: Vec<&Change> = if custom { changes.iter().filter(|change| change.hidden.is_some()).collect() } else { Vec::new() };
    if !hidden.is_empty() {
        host.require_local_provider_management()?;
        let providers = object_of(agent.get("providers"));
        let entry = providers.get(&provider).cloned().unwrap_or(Value::Null);
        let current = host.normalize_stored_custom_config(&entry)?;
        let mut overrides = object_of(current.get("modelOverrides"));
        for change in &hidden {
            let mut next = object_of(overrides.get(&change.model));
            next.insert("hidden".into(), Value::Bool(change.hidden == Some(true)));
            overrides.insert(change.model.clone(), Value::Object(next));
        }
        let mut next_current = current.as_object().cloned().unwrap_or_default();
        next_current.insert("modelOverrides".into(), Value::Object(overrides));
        let config = host.normalize_stored_custom_config(&Value::Object(next_current))?;
        let mut saved = config.as_object().cloned().unwrap_or_default();
        saved.insert("type".into(), json!("custom"));
        saved.insert("enabled".into(), Value::Bool(entry.get("enabled") != Some(&Value::Bool(false))));
        let mut next_providers = providers;
        next_providers.insert(provider.clone(), Value::Object(saved));
        after.insert("providers".into(), Value::Object(next_providers));
    }
    Ok(Preferences {
        result: json!({ "provider": provider, "changed": changes.len(), "customCatalogChanged": !hidden.is_empty() }),
        custom_catalog_changed: !hidden.is_empty(),
        after,
    })
}
