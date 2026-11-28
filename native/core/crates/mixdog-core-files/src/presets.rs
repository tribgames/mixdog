//! The shipped agent presets (`DEFAULT_PRESETS`, `config-storage.mjs`) under the stored ones (`withDefaultPresets`): what the
//! config loader lists, and what the footer names a route's preset from.

use mixdog_ai::effort::EffortAuto;
use mixdog_js::value_to_string;
use serde_json::Value;
use serde_json::json;

use crate::gateway_usage::truthy;

/// `String(a || b || '')` for a preset's own fields.
pub fn first_text(preset: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = preset.get(key).filter(|value| truthy(Some(*value))) {
            return value_to_string(value);
        }
    }
    String::new()
}

/// `resolveAnthropicFamilyModel(family)`: the environment override, else the shipped model.
pub fn anthropic_family_model(family: &str) -> String {
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
pub fn default_presets_for(legacy_switch_on: bool) -> Vec<Value> {
    let effort_auto = EffortAuto::default_for_new(legacy_switch_on).as_bool();
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
