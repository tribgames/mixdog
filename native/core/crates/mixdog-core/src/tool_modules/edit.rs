//! The config edits the setters make, ported from `config-helpers.mjs`,
//! `builtin-grandfathering.mjs` and `settings-builtin-tools-api.mjs`. Each edits the full
//! document in place, so every other key (credentials among them) stays.

use serde_json::Value;

use super::value::Doc;
use super::value::LOCAL_PROVIDER_ID;

/// `{...doc[section]}`: a copy of the section's object, empty when it is not one.
fn section(doc: &mut Doc, name: &str) -> Doc {
    doc.get(name).and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `section[key] = {...section[key], enabled}` (or any other field).
fn set_field(doc: &mut Doc, name: &str, key: &str, field: &str, value: bool) {
    let mut map = section(doc, name);
    let mut entry = map.get(key).and_then(Value::as_object).cloned().unwrap_or_default();
    entry.insert(field.into(), Value::Bool(value));
    map.insert(key.into(), Value::Object(entry));
    doc.insert(name.into(), Value::Object(map));
}

pub fn set_module_enabled(doc: &mut Doc, name: &str, enabled: bool) {
    set_field(doc, "modules", name, "enabled", enabled);
}

pub fn set_local_provider_enabled(doc: &mut Doc, enabled: bool) {
    set_field(doc, "providers", LOCAL_PROVIDER_ID, "enabled", enabled);
}

pub fn set_memory_tools_enabled(doc: &mut Doc, enabled: bool) {
    let mut tools = section(doc, "memoryTools");
    tools.insert("enabled".into(), Value::Bool(enabled));
    doc.insert("memoryTools".into(), Value::Object(tools));
}

/// `setBuiltinInstalledInConfig(doc, id, true)`.
pub fn set_builtin_installed(doc: &mut Doc, id: &str) {
    set_field(doc, "builtins", id, "installed", true);
}

/// `setRecapEnabledInConfig`: also drops the legacy `modules.memory` flag that carried the
/// disabled state.
pub fn set_recap_enabled(doc: &mut Doc, enabled: bool) {
    let mut recap = section(doc, "recap");
    recap.insert("enabled".into(), Value::Bool(enabled));
    doc.insert("recap".into(), Value::Object(recap));
    let Some(modules) = doc.get("modules").and_then(Value::as_object) else {
        return;
    };
    let mut modules = modules.clone();
    match modules.get("memory") {
        Some(Value::Bool(false)) => {
            modules.shift_remove("memory");
        }
        Some(Value::Object(memory)) => {
            let mut memory = memory.clone();
            memory.shift_remove("enabled");
            if memory.is_empty() {
                modules.shift_remove("memory");
            } else {
                modules.insert("memory".into(), Value::Object(memory));
            }
        }
        _ => return,
    }
    doc.insert("modules".into(), Value::Object(modules));
}
