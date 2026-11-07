//! What the cycles read of the product configuration, as Node reads it on every use:
//! `readSection('memory')` (`memory-config-flags.mjs` `readMainConfig`), `memoryCyclesEnabled()`
//! and `resolveMaintenancePreset('memory')` (`maintenance-preset.mjs`), all over the one
//! configuration document (`mixdog-config.json`). [`DocCycleConfig`] is the production
//! [`CycleConfig`]; the composition builds it over the core's `Config`:
//! `DocCycleConfig::new(Arc::new(move || config.full()), env)`.

use std::sync::Arc;

use mixdog_js::js_trim;
use serde_json::{Map, Value};

use super::CycleConfig;
use crate::bots::delivery::rows::truthy_of;

/// The configuration document as the core holds it.
pub type Doc = Map<String, Value>;
/// How the environment is read: by name, at each use (`process.env` is polled).
pub type EnvReader = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The environment of this process.
pub fn process_env() -> EnvReader {
    Arc::new(|name| std::env::var(name).ok())
}

/// `envFlag(name, fallback)`: unset or empty keeps `fallback`; only the documented on and off
/// spellings flip it, and a typo keeps the default too.
pub fn env_flag(raw: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = raw else { return fallback };
    match js_trim(raw).to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "off" | "no" => false,
        _ => fallback,
    }
}

/// `readSection(name)`: the section without its generated marker, `{}` when the file has none
/// (a section of another type is returned as it is).
pub fn read_section(doc: &Doc, name: &str) -> Value {
    match doc.get(name) {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(section)) if section.contains_key("_generated") => {
            Value::Object(section.iter().filter(|(key, _)| *key != "_generated").map(|(k, v)| (k.clone(), v.clone())).collect())
        }
        Some(other) => other.clone(),
    }
}

/// `readRecapEnabled`: the recap toggle of the `agent` section; anything but a literal
/// `enabled: false` leaves the cycles on.
pub fn recap_enabled(doc: &Doc) -> bool {
    let agent = read_section(doc, "agent");
    !agent.get("recap").and_then(Value::as_object).is_some_and(|recap| recap.get("enabled") == Some(&Value::Bool(false)))
}

/// `memoryCyclesEnabled()`: not secondary, not switched off by the environment, recap on.
pub fn cycles_enabled(doc: &Doc, env: &EnvReader) -> bool {
    let flag = |name: &str| env_flag(env(name).as_deref(), false);
    !flag("MIXDOG_MEMORY_SECONDARY") && !flag("MIXDOG_MEMORY_DISABLE_CYCLES") && recap_enabled(doc)
}

/// `resolveMaintenancePreset('memory')`: the stored `agent.maintenance.memory` route when it is
/// an object naming a provider and a model, else nothing (the shipped defaults hold only the
/// `webhook` slot).
pub fn memory_maintenance_preset(doc: &Doc) -> Option<Value> {
    let agent = read_section(doc, "agent");
    let slot = agent.get("maintenance")?.as_object()?.get("memory")?.as_object()?;
    (truthy_of(slot.get("provider")) && truthy_of(slot.get("model"))).then(|| Value::Object(slot.clone()))
}

/// [`CycleConfig`] over a document that is read afresh on every call.
pub struct DocCycleConfig {
    doc: Arc<dyn Fn() -> Arc<Doc> + Send + Sync>,
    env: EnvReader,
}

impl DocCycleConfig {
    pub fn new(doc: Arc<dyn Fn() -> Arc<Doc> + Send + Sync>, env: EnvReader) -> Self {
        Self { doc, env }
    }
}

impl CycleConfig for DocCycleConfig {
    fn memory_section(&self) -> Value {
        read_section(&(self.doc)(), "memory")
    }

    fn cycles_enabled(&self) -> bool {
        cycles_enabled(&(self.doc)(), &self.env)
    }

    fn maintenance_preset(&self) -> Option<Value> {
        memory_maintenance_preset(&(self.doc)())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../../fixtures/tools/memory/cycle-config/golden.json");

    fn doc_of(config: &Value) -> Arc<Doc> {
        Arc::new(config.as_object().cloned().unwrap_or_default())
    }

    fn env_of(vars: &Value) -> EnvReader {
        let vars: HashMap<String, String> = vars.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned())).collect();
        Arc::new(move |name| vars.get(name).cloned())
    }

    /// Node's answers for config files of every shape: the memory section, the cycle switch
    /// (recap and the two environment switches) and the maintenance route.
    #[test]
    fn the_cycle_config_matches_node() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
        for case in golden["cases"].as_array().expect("cases") {
            let doc = doc_of(&case["config"]);
            let config = DocCycleConfig::new(Arc::new(move || doc.clone()), env_of(&case["env"]));
            let name = &case["name"];
            assert_eq!(config.memory_section(), case["memory"], "{name}: memory section");
            assert_eq!(config.cycles_enabled(), case["cyclesEnabled"].as_bool().expect("flag"), "{name}: cycles enabled");
            assert_eq!(config.maintenance_preset().unwrap_or(Value::Null), case["preset"], "{name}: maintenance preset");
        }
    }

    #[test]
    fn env_flag_matches_node_on_every_spelling() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden");
        for row in golden["envFlag"].as_array().expect("rows") {
            let raw = row["value"].as_str();
            assert_eq!(env_flag(raw, false), row["whenFalse"].as_bool().expect("flag"), "{raw:?} with fallback false");
            assert_eq!(env_flag(raw, true), row["whenTrue"].as_bool().expect("flag"), "{raw:?} with fallback true");
        }
    }

    /// The document is read on every call: a recap toggled after construction takes effect.
    #[test]
    fn a_toggled_recap_takes_effect_without_rebuilding() {
        let current = Arc::new(std::sync::Mutex::new(doc_of(&serde_json::json!({}))));
        let source = current.clone();
        let config = DocCycleConfig::new(Arc::new(move || source.lock().expect("doc").clone()), Arc::new(|_| None));
        assert!(config.cycles_enabled());
        *current.lock().expect("doc") = doc_of(&serde_json::json!({ "agent": { "recap": { "enabled": false } } }));
        assert!(!config.cycles_enabled());
    }
}
