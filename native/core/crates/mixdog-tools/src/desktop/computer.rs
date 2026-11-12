//! `computer`: the in-process front end of the one computer-use backend. The backend validates
//! each action's input against its own contract and reports `InvalidInput`; one call per turn
//! is the tool's scheduling group.

use std::sync::Arc;
use std::sync::LazyLock;

use async_trait::async_trait;
use mixdog_ai::providers::action_input::advertise_action_input_union;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use serde_json::Value;

use super::computer_recovery::format_tool_error;
use crate::orch::util::JsStr;
use crate::orch::util::cancelled;
use crate::orch::util::denied;
use crate::orch::util::action_failed;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;
use crate::orch::util::unavailable;

/// The request of a call: a known action and its `input` object (absent means empty).
pub fn request(args: &Value) -> Result<ComputerRequest, String> {
    let object = args.as_object().ok_or("computer arguments must be an object")?;
    let name = object.get("action").and_then(Value::as_str).unwrap_or_default().js_trim();
    let action = ComputerAction::from_wire(name).ok_or_else(|| {
        let known: Vec<&str> = ComputerAction::ALL.iter().map(|a| a.wire_name()).collect();
        format!("unknown computer action \"{name}\"; use one of {}", known.join(", "))
    })?;
    let input = match object.get("input") {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(v @ Value::Object(_)) => v.clone(),
        Some(_) => return Err(format!("computer action \"{name}\" input must be an object")),
    };
    Ok(ComputerRequest { action, input })
}

fn map_error(error: ComputerError, args: &Value) -> ToolError {
    match error {
        ComputerError::Unavailable { reason } => unavailable("computer", reason),
        ComputerError::InvalidInput { reason } => invalid("input", reason),
        ComputerError::Denied => denied("computer: PC access is not approved"),
        ComputerError::Cancelled => cancelled(),
        ComputerError::Failed { code, message } => action_failed("computer", failure_text(&code, &message, args)),
    }
}

/// What the model reads for a failure of the host: Node's `formatComputerToolError` (`Error: …` and what to do next), except for a
/// host reply that is itself the error result (`{"ok":false,…}`), which Node returns as it is.
pub(crate) fn failure_text(code: &str, message: &str, args: &Value) -> String {
    if code == super::computer_backend::REPORTED_CODE { message.to_owned() } else { format_tool_error(message, args) }
}

pub struct ComputerTool {
    spec: ToolSpec,
    sessions: Arc<dyn ComputerSessions>,
}

/// `COMPUTER_ACTION_INPUT_UNION` (`defs/computer.union.json`) registered under its flat projection,
/// which is the `inputSchema` of `defs/computer.json`: a provider path that takes nested per-action
/// input alternatives (first-party Anthropic, Claude behind Antigravity) sends the union for it
/// (`actionInputUnionFor`). The tool advertises the flat form everywhere else.
static ADVERTISED_UNION: LazyLock<JsonValue> = LazyLock::new(|| {
    let nested: JsonValue = serde_json::from_str(include_str!("defs/computer.union.json")).expect("embedded computer union is valid JSON");
    advertise_action_input_union(&nested)
});

impl ComputerTool {
    pub fn new(sessions: Arc<dyn ComputerSessions>) -> Self {
        LazyLock::force(&ADVERTISED_UNION);
        Self { spec: spec_from_def(include_str!("defs/computer.json"), false, &["computer"]), sessions }
    }
}


#[async_trait]
impl Tool for ComputerTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let request = request(&args).map_err(|m| invalid("action", m))?;
        // The calling session's own helper state, as Node sends the session id with the request.
        let backend = self.sessions.backend(ctx.thread_id.as_str());
        let parts = backend.run(request, ctx.cancel.clone()).await.map_err(|error| map_error(error, &args))?;
        Ok(ToolOutput { parts, ..ToolOutput::default() })
    }
}

#[cfg(test)]
mod tests {
    use mixdog_ai::providers::action_input::action_input_union_for;
    use serde_json::json;

    use super::*;

    #[test]
    fn action_is_resolved_and_input_defaults_to_empty() {
        let r = request(&json!({"action":"capture"})).unwrap();
        assert_eq!((r.action, r.input), (ComputerAction::Capture, json!({})));
        assert!(request(&json!({"action":"zap"})).unwrap_err().starts_with("unknown computer action \"zap\""));
        assert!(request(&json!({"action":"act","input":[]})).is_err());
    }

    /// The registered union is the one for exactly the schema the tool advertises, byte for byte
    /// (the registry is keyed by its text), and a provider that takes the union gets it.
    #[test]
    fn the_advertised_schema_resolves_to_the_nested_union() {
        let spec = spec_from_def(include_str!("defs/computer.json"), false, &["computer"]);
        assert_eq!(ADVERTISED_UNION.to_string(), spec.input_schema.to_string());
        let nested = action_input_union_for(&spec.input_schema);
        assert_ne!(nested, spec.input_schema);
        let alternatives = nested["properties"]["input"]["anyOf"].as_array().expect("per-action alternatives");
        assert!(!alternatives.is_empty());
    }
}

#[cfg(test)]
mod failure_tests {
    use serde_json::json;

    use super::*;

    /// A failure of the host reaches the model as Node's `formatComputerToolError` words it: `Error:`, the host's text, and what to
    /// do next for a failure that has a recovery; a failure without one is the text alone.
    #[test]
    fn a_host_failure_reads_with_its_recovery() {
        let args = json!({ "action": "act", "input": { "app": "Notepad" } });
        let failed = |message: &str| ComputerError::Failed { code: "computer_failed".into(), message: message.into() };
        let stale = map_error(failed("stale_frame: unknown frame_id frame-1"), &args);
        assert_eq!(stale.message_for_model, "Error: stale_frame: unknown frame_id frame-1\nRecovery: Capture app \"Notepad\" again and use only the fresh ref, OCR mark, or frame_id.");
        assert_eq!(map_error(failed("something broke"), &args).message_for_model, "Error: something broke");
        assert_eq!(map_error(ComputerError::Cancelled, &args).message_for_model, "cancelled");
    }
}
