//! `computer`: the in-process front end of the one computer-use backend. The backend validates
//! each action's input against its own contract and reports `InvalidInput`; one call per turn
//! is the tool's scheduling group.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use serde_json::Value;

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

fn map_error(error: ComputerError) -> ToolError {
    match error {
        ComputerError::Unavailable { reason } => unavailable("computer", reason),
        ComputerError::InvalidInput { reason } => invalid("input", reason),
        ComputerError::Denied => denied("computer: PC access is not approved"),
        ComputerError::Cancelled => cancelled(),
        ComputerError::Failed { message, .. } => action_failed("computer", message),
    }
}

pub struct ComputerTool {
    spec: ToolSpec,
    backend: Arc<dyn ComputerBackend>,
}

impl ComputerTool {
    pub fn new(backend: Arc<dyn ComputerBackend>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/computer.json"), false, &["computer"]), backend }
    }
}

#[async_trait]
impl Tool for ComputerTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let request = request(&args).map_err(|m| invalid("action", m))?;
        let parts = self.backend.run(request, ctx.cancel.clone()).await.map_err(map_error)?;
        Ok(ToolOutput { parts, ..ToolOutput::default() })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn action_is_resolved_and_input_defaults_to_empty() {
        let r = request(&json!({"action":"capture"})).unwrap();
        assert_eq!((r.action, r.input), (ComputerAction::Capture, json!({})));
        assert!(request(&json!({"action":"zap"})).unwrap_err().starts_with("unknown computer action \"zap\""));
        assert!(request(&json!({"action":"act","input":[]})).is_err());
    }
}
