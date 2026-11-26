//! `canonicalizeUnifiedConfig` (`runtime/shared/config.mjs`): the shape Node's config reads
//! serve and its saves write. Retired keys from old installs are dropped, not folded in, so no
//! reader of the document (the agent section among them) meets one: [`read_file`] applies it to
//! every document read, and every save applies it before the document is written and installed.
//!
//! [`read_file`]: super::read_file

use mixdog_ai::effort::EffortAuto;
use mixdog_ai::service::admin_route::config_default_auto_effort;
use serde_json::Map;
use serde_json::Value;

use super::Doc;

fn convert_route_with_fallbacks(route: &mut Map<String, Value>, legacy_switch_on: bool) {
    EffortAuto::convert_on_load(route, legacy_switch_on);
    if let Some(fallbacks) = route.get_mut("fallbacks").and_then(Value::as_array_mut) {
        for entry in fallbacks {
            if let Some(entry_map) = entry.as_object_mut() {
                EffortAuto::convert_on_load(entry_map, legacy_switch_on);
            }
        }
    }
}

/// One-time load conversion for all stored routes in `agent` (`modelSettings`, `presets`, `agents`,
/// `workflowRoutes`, `maintenance`): resolves missing `effortAuto` once from legacy `autoEffort`
/// and the legacy feature switch, writes `effortAuto`, and drops legacy `autoEffort`.
pub(super) fn convert_stored_routes(agent: &mut Doc) {
    let legacy_switch_on = config_default_auto_effort(agent);
    if let Some(settings) = agent.get_mut("modelSettings").and_then(Value::as_object_mut) {
        for entry in settings.values_mut() {
            if let Some(map) = entry.as_object_mut() {
                EffortAuto::convert_on_load(map, legacy_switch_on);
            }
        }
    }
    if let Some(presets) = agent.get_mut("presets").and_then(Value::as_array_mut) {
        for preset in presets {
            if let Some(map) = preset.as_object_mut() {
                convert_route_with_fallbacks(map, legacy_switch_on);
            }
        }
    }
    for key in ["agents", "workflowRoutes"] {
        if let Some(routes) = agent.get_mut(key).and_then(Value::as_object_mut) {
            for route in routes.values_mut() {
                if let Some(map) = route.as_object_mut() {
                    convert_route_with_fallbacks(map, legacy_switch_on);
                }
            }
        }
    }
    if let Some(maint) = agent.get_mut("maintenance").and_then(Value::as_object_mut) {
        for route in maint.values_mut() {
            if let Some(map) = route.as_object_mut() {
                EffortAuto::convert_on_load(map, legacy_switch_on);
            }
        }
    }
}

/// The document a read or a save settles on.
pub(super) fn canonicalize(mut next: Doc) -> Doc {
    let had_agent = next.get("agent").is_some_and(Value::is_object);
    let mut agent = next.get("agent").and_then(Value::as_object).cloned().unwrap_or_default();

    agent.shift_remove("outputStyle");
    for key in ["autoClear", "compaction", "shell", "mcpServers"] {
        next.shift_remove(key);
    }
    agent.shift_remove("search");
    agent.shift_remove("capabilities");

    let mut modules = agent.get("modules").and_then(Value::as_object).cloned().unwrap_or_default();
    if modules.contains_key("memory") {
        modules.shift_remove("memory");
        agent.insert("modules".into(), Value::Object(modules));
    }

    if let Some(memory) = next.get("memory").and_then(Value::as_object) {
        let mut memory = memory.clone();
        let mut user = memory.get("user").and_then(Value::as_object).cloned().unwrap_or_default();
        user.shift_remove("title");
        if user.is_empty() {
            memory.shift_remove("user");
        } else {
            memory.insert("user".into(), Value::Object(user));
        }
        memory.shift_remove("enabled");
        if memory.is_empty() {
            next.shift_remove("memory");
        } else {
            next.insert("memory".into(), Value::Object(memory));
        }
    }

    // `canonicalizeStoredChannelsConfig`: schedules live in the scheduler store and prompt
    // injection moved to runtime hooks. The Discord channel is gone with its token.
    if let Some(channels) = next.get("channels").and_then(Value::as_object) {
        let mut channels = channels.clone();
        channels.shift_remove("promptInjection");
        channels.shift_remove("schedules");
        channels.shift_remove("discord");
        next.insert("channels".into(), Value::Object(channels));
    }

    next.shift_remove("search");
    next.shift_remove("capabilities");
    if had_agent || !agent.is_empty() {
        convert_stored_routes(&mut agent);
        next.insert("agent".into(), Value::Object(agent));
    }
    next
}

#[cfg(test)]
#[path = "canonical_tests.rs"]
mod tests;
