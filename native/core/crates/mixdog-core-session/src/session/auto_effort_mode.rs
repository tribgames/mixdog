//! `autoEffortMode(config)` (`ask-turn-auto-effort.mjs`): whether Auto effort is off, observing or on.

use serde_json::Map;
use serde_json::Value;

/// `AUTO_EFFORT_MODES`.
const AUTO_EFFORT_MODES: [&str; 3] = ["off", "observe", "on"];

/// `autoEffortMode(config)`: a set `MIXDOG_AUTO_EFFORT` (`normalizeAutoEffortMode`), else the
/// `autoEffort` builtin feature of the agent config.
pub fn auto_effort_mode(env_mode: Option<&str>, agent: &Map<String, Value>, feature_env: &dyn Fn(&str) -> Option<String>) -> &'static str {
    if let Some(raw) = env_mode.filter(|raw| !raw.is_empty()) {
        let mode = mixdog_js::js_trim(raw).to_lowercase();
        return AUTO_EFFORT_MODES.into_iter().find(|m| *m == mode).unwrap_or("off");
    }
    let onnx = mixdog_services::tool_state::onnx_runtime_supported();
    if mixdog_core_config::tool_modules::builtin_feature_active(agent, "autoEffort", feature_env, onnx) { "on" } else { "off" }
}