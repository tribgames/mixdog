//! The `setup` tool's input validation, ported from `validateSetupInput` (setup-tool/executor.mjs):
//! the action enum, the input schema, the per-action field list and the route / object-argument
//! minimums. The services behind the tool validate their own values after this.

use mixdog_core_api::domain::tool::ToolError;
use serde_json::Map;
use serde_json::Value;

use super::schema::value_error;
use super::util::invalid;

/// `SETUP_ACTION_FIELDS`: action -> space-separated fields, a trailing `?` marking optional ones.
const ACTION_FIELDS: &str = include_str!("defs/setup_fields.json");

const VALIDATION: &str = "[tool-input-validation]";

fn refuse(message: String) -> ToolError {
    invalid("setup", message)
}

fn tagged(message: String) -> ToolError {
    refuse(format!("{VALIDATION} {message}"))
}

/// Checks `args` against the `setup` contract; `schema` is the tool's input schema.
/// The `setup` tool's input schema (`defs/setup.json` `inputSchema`): what an owner that validates its own calls
/// is built with.
pub fn input_schema() -> Value {
    let def: Value = serde_json::from_str(include_str!("defs/setup.json")).expect("defs/setup.json is JSON");
    def["inputSchema"].clone()
}

#[allow(clippy::result_large_err, reason = "Preserve the canonical structured ToolError and ToolOutcome contract without per-error boxing.")]
pub fn validate(args: &Value, schema: &Value) -> Result<(), ToolError> {
    let table: Map<String, Value> = serde_json::from_str(ACTION_FIELDS).expect("embedded action table");
    let given = args.get("action").and_then(Value::as_str).map(mixdog_js::js_trim).unwrap_or_default();
    let Some(fields) = table.get(given).and_then(Value::as_str) else {
        let names: Vec<&str> = table.keys().map(String::as_str).collect();
        return Err(refuse(format!("action must be one of {}", names.join(", "))));
    };
    let action = given;
    if action == "connect_connector" && args.get("connector").and_then(Value::as_str).is_some_and(|c| mixdog_js::js_trim(c).to_lowercase() == "github") {
        return Err(refuse("GitHub uses the signed-in GitHub CLI; no connector needed. Use the github tool or Settings → Git.".to_owned()));
    }
    let empty = Map::new();
    let object = args.as_object().unwrap_or(&empty);
    let mut checked = object.clone();
    checked.insert("action".to_owned(), Value::String(action.to_owned()));
    if let Some(error) = value_error(&Value::Object(checked), schema, "setup") {
        return Err(tagged(error));
    }
    let fields: Vec<&str> = fields.split(' ').filter(|f| !f.is_empty()).collect();
    let allowed: Vec<&str> = fields.iter().map(|f| f.trim_end_matches('?')).collect();
    let extras: Vec<&str> = object.keys().map(String::as_str).filter(|k| *k != "action" && !allowed.contains(k)).collect();
    if !extras.is_empty() {
        return Err(tagged(format!("setup.{action} does not accept field(s): {}", extras.join(", "))));
    }
    if let Some(missing) = fields.iter().find(|f| !f.ends_with('?') && !object.contains_key(**f)) {
        return Err(tagged(format!("{missing} is required for setup.{action}")));
    }
    if let Some(route) = object.get("route").and_then(Value::as_object) {
        let has = |field: &str| route.contains_key(field);
        if route.is_empty() {
            return Err(refuse("route with at least one of the supported settings is required".to_owned()));
        }
        if action != "set_agent_route" && has("disabled") {
            return Err(refuse("route.disabled is only accepted by set_agent_route".to_owned()));
        }
        if has("fallbacks") && !["set_route", "set_agent_route", "set_web_search_route"].contains(&action) {
            return Err(refuse("route.fallbacks is only accepted by set_route, set_agent_route and set_web_search_route".to_owned()));
        }
        for field in ["contextPercent", "contextTokens", "autoEffort"] {
            if action != "set_route" && action != "set_agent_route" && has(field) {
                return Err(refuse(format!("route.{field} is only accepted by set_route and set_agent_route")));
            }
        }
    }
    for field in ["desktop", "appearance", "webhook", "compaction", "providerAccount", "worktree", "networkProxy"] {
        if object.get(field).and_then(Value::as_object).is_some_and(Map::is_empty) {
            return Err(refuse(format!("{field} requires at least one setting")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    fn refusal(args: Value) -> String {
        let def: Value = serde_json::from_str(include_str!("defs/setup.json")).unwrap();
        validate(&args, &def["inputSchema"]).expect_err("the input is refused").message_for_model
    }

    #[test]
    fn a_setup_call_with_a_missing_wrong_or_surplus_field_is_refused_with_the_rule_it_broke() {
        for (args, want) in [
            (json!({"action": "install_local_model"}), "[tool-input-validation] modelId is required for setup.install_local_model"),
            (json!({"action": "install_local_model", "modelId": 12}), "[tool-input-validation] setup.modelId must be a string"),
            (
                json!({"action": "start_local_installation", "modelId": "m1", "phase": " model "}),
                "[tool-input-validation] setup.phase must be one of: runtime, model",
            ),
            (json!({"action": "set_local_idle_ttl", "idleTtlSeconds": 86401}), "[tool-input-validation] setup.idleTtlSeconds must be at most 86400"),
            (
                json!({"action": "inspect_hf_model", "contextWindow": 100, "repository": "owner/name"}),
                "[tool-input-validation] setup.contextWindow must be at least 16384",
            ),
            (
                json!({"action": "register_hf_model", "licenseAccepted": "yes", "previewId": "x"}),
                "[tool-input-validation] setup.licenseAccepted must be a boolean",
            ),
            (json!({"action": "register_hf_model", "licenseAccepted": true}), "[tool-input-validation] previewId is required for setup.register_hf_model"),
            (json!({"action": "set_heartbeat_interval", "minutes": "5"}), "[tool-input-validation] setup.minutes must be one of: 30, 60, 120, 240"),
            (json!({"action": "set_memory_enabled"}), "[tool-input-validation] enabled is required for setup.set_memory_enabled"),
            (json!({"action": "status", "bogus": 1}), "[tool-input-validation] setup does not accept field(s): bogus"),
            (json!({"action": "open"}), "[tool-input-validation] target is required for setup.open"),
            (json!({"action": "set_workflow", "route": {"x": 1}}), "[tool-input-validation] setup.route does not accept field(s): x"),
            (
                json!({"action": "set_web_search_route", "route": {"contextPercent": 5}}),
                "[tool-input-validation] setup.route.contextPercent must be at least 10",
            ),
        ] {
            assert_eq!(refusal(args.clone()), want, "{args}");
        }
    }

    #[test]
    fn a_route_or_settings_object_must_hold_a_setting_the_action_accepts() {
        for (args, want) in [
            (json!({"action": "set_route", "route": {}}), "route with at least one of the supported settings is required"),
            (json!({"action": "set_route", "route": {"disabled": true}}), "route.disabled is only accepted by set_agent_route"),
            (json!({"action": "set_compaction", "compaction": {}}), "compaction requires at least one setting"),
        ] {
            assert_eq!(refusal(args.clone()), want, "{args}");
        }
    }

    #[test]
    fn a_valid_setup_call_passes_validation() {
        let def: Value = serde_json::from_str(include_str!("defs/setup.json")).unwrap();
        for args in [json!({"action": "install_local_model", "modelId": " m1 "}), json!({"action": "status"})] {
            assert!(validate(&args, &def["inputSchema"]).is_ok(), "{args}");
        }
    }
}
