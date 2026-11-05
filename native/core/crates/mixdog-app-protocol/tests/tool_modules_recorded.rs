//! `ToolModuleSettings` against what Node recorded: the 100-config tool-modules twin
//! (`record-tool-modules.mjs`) and the real local-provider statuses
//! (`record-local-provider-status.mjs`). Every value must deserialize and serialize back to the
//! same JSON, so a field the type lacks, drops or renames fails here.

use std::path::PathBuf;

use mixdog_protocol::LocalProviderModule;
use mixdog_protocol::ToolModuleSettings;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/desktop/settings")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// Numbers compare as f64: Node has no integer/float split.
fn canon(value: &Value) -> Value {
    match value {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(canon).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), canon(v))).collect()),
        other => other.clone(),
    }
}

/// The path of the first difference, so a failure names the field.
fn first_diff(path: &str, ours: &Value, recorded: &Value) -> Option<String> {
    match (ours, recorded) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                let at = format!("{path}.{key}");
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => {
                        if let Some(found) = first_diff(&at, x, y) {
                            return Some(found);
                        }
                    }
                    (x, y) => return Some(format!("{at}: ours {x:?}, recorded {y:?}")),
                }
            }
            None
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            a.iter().zip(b).enumerate().find_map(|(i, (x, y))| first_diff(&format!("{path}[{i}]"), x, y))
        }
        (a, b) if a == b => None,
        (a, b) => Some(format!("{path}: ours {a}, recorded {b}")),
    }
}

fn round_trip<T: DeserializeOwned + Serialize>(recorded: &Value, what: &str) -> T {
    let typed: T = serde_json::from_value(recorded.clone())
        .unwrap_or_else(|error| panic!("{what}: {error}\n{recorded}"));
    let ours = canon(&serde_json::to_value(&typed).unwrap());
    if let Some(found) = first_diff("", &ours, &canon(recorded)) {
        panic!("{what}: round trip differs at {found}");
    }
    typed
}

#[test]
fn recorded_local_provider_statuses_fit_the_type() {
    let recorded = fixture("local-provider-status.json");
    for case in recorded["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // The module is the status plus the three members `getToolModuleSettings` adds.
        let mut module = case["status"].clone();
        let fields = module.as_object_mut().unwrap();
        fields.insert("installationCommandError".into(), Value::Null);
        fields.insert("enabled".into(), Value::Bool(false));
        fields.insert("installed".into(), Value::Bool(false));
        for key in ["running", "starting", "activeModel", "gpu", "loadTimeMs", "lastExit", "lastError"] {
            assert!(fields.contains_key(key), "{name}: status lacks server member {key}");
        }
        round_trip::<LocalProviderModule>(&module, name);
    }
    for (name, status) in recorded["serverStates"].as_object().unwrap() {
        let mut module = recorded["cases"][0]["status"].clone();
        let fields = module.as_object_mut().unwrap();
        fields.insert("installationCommandError".into(), Value::Null);
        fields.insert("enabled".into(), Value::Bool(false));
        fields.insert("installed".into(), Value::Bool(false));
        for (key, value) in status.as_object().unwrap() {
            fields.insert(key.clone(), value.clone());
        }
        round_trip::<LocalProviderModule>(&module, name);
    }
}

#[test]
fn recorded_get_tool_module_settings_fits_the_type() {
    let recorded = fixture("local-provider-status.json");
    round_trip::<ToolModuleSettings>(&recorded["toolModuleSettings"], "getToolModuleSettings");
}

#[test]
fn twin_values_fit_the_type() {
    let recorded = fixture("local-provider-status.json");
    let full = recorded["toolModuleSettings"]["localProvider"].clone();
    let twin = fixture("tool-modules-twin.json");
    let mut checked = 0;
    for entry in twin["entries"].as_array().unwrap() {
        let mut values = vec![&entry["value"]];
        // Only the setters that end in `getToolModuleSettings()`; the others answer their own shape.
        values.extend(
            entry["setters"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|s| s.get("value"))
                .filter(|v| v.get("instructionFiles").is_some()),
        );
        for value in values {
            // The twin feeds stub statuses; the real, full status stands in for `localProvider`,
            // keeping the three members the twin does record.
            let mut value = value.clone();
            let mut provider = full.clone();
            provider["installationCommandError"] = value["localProvider"]["installationCommandError"].clone();
            // The twin's stub gate answers `null` for these two; the production gates answer
            // booleans (`settings-api.mjs` defaults, `boot.localProviderEnabledFn`), as the real
            // recorded value shows, so only a recorded boolean is kept.
            for key in ["enabled", "installed"] {
                if value["localProvider"][key].is_boolean() {
                    provider[key] = value["localProvider"][key].clone();
                }
            }
            value["localProvider"] = provider;
            round_trip::<ToolModuleSettings>(&value, "twin value");
            checked += 1;
        }
    }
    // 100 configs plus 609 setter results that return the settings.
    assert_eq!(checked, 709);
}
