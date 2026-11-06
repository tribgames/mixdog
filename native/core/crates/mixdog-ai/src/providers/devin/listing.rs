//! `devin-oauth` model listing: every enabled, visible uid of the account as
//! one picker row. Routers (`adaptive`) are listed; a row's routing and
//! presentation flags stay with the turn that sends to it.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::PROVIDER_ID;
use super::models::ModelRow;

/// One picker row of the account's catalog row.
pub fn row(model: &ModelRow) -> Map<String, Value> {
    let mut row = Map::new();
    // Collapsed effort families advertise their tiers the way other providers do.
    if !model.reasoning_levels.is_empty() {
        row.insert("reasoningLevels".into(), json!(model.reasoning_levels));
        row.insert("reasoningOptions".into(), json!([{"type": "effort", "values": model.reasoning_levels}]));
        row.insert("defaultEffort".into(), json!(model.default_effort));
        // No thinking-off route: `none` is absent from the levels.
        if model.requires_effort {
            row.insert("requiresEffort".into(), json!(true));
        }
    }
    if model.is_default {
        row.insert("isDefault".into(), json!(true));
    }
    row.insert("id".into(), json!(model.id));
    row.insert("display".into(), json!(model.name));
    row.insert("provider".into(), json!(PROVIDER_ID));
    row.insert("mode".into(), json!("chat"));
    row.insert("contextWindow".into(), json!(model.context_window));
    row.insert("outputTokens".into(), json!(model.max_output_tokens));
    row.insert("description".into(), json!(model.description));
    row.insert("supportsVision".into(), json!(model.supports_vision));
    row.insert("supportsFunctionCalling".into(), json!(model.supports_tools));
    row.insert("reasoning".into(), json!(model.reasoning));
    row.insert("supportsReasoning".into(), json!(model.reasoning));
    row
}
