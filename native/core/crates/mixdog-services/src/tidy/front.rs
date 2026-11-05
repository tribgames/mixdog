//! The `tidy` tool's model-facing entry: [`mixdog_tools::orch::service::ServiceTool::tidy`] carries
//! Node's exact definition and this adapter runs [`TidyTool`] behind it. (The adapter lives here
//! because this crate depends on `mixdog-tools`, not the other way round.)

use async_trait::async_trait;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_tools::orch::service::ServiceCall;
use mixdog_tools::orch::service::ToolService;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use super::tool::TidyTool;

/// The report text of a [`tidy_tool_result`](super::report::tidy_tool_result) envelope, or the
/// same text as a failure when the envelope is flagged `isError`.
fn envelope_to_parts(envelope: &Value) -> Result<Vec<ToolPart>, PortError> {
    let text = envelope["content"][0]["text"].as_str().unwrap_or_default().to_owned();
    if envelope["isError"] == Value::Bool(true) {
        return Err(PortError::Failed { capability: "tidy".into(), message: text });
    }
    Ok(vec![ToolPart::Text(text)])
}

pub struct TidyToolService(pub TidyTool);

#[async_trait]
impl ToolService for TidyToolService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let envelope = self.0.execute(call.args, call.cwd.as_path(), Some(call.thread.as_str()), Some(call.cancel)).await;
        envelope_to_parts(&envelope)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_tools::orch::service::ServiceTool;
    use mixdog_core_api::domain::tool::Tool;
    use serde_json::json;

    use super::super::tool::TIDY_ACTIONS;
    use super::*;

    #[test]
    fn definition_offers_exactly_the_actions_the_tool_runs() {
        let spec = ServiceTool::tidy(std::sync::Arc::new(Never)).spec().clone();
        assert_eq!(spec.input_schema["properties"]["action"]["enum"], json!(TIDY_ACTIONS));
    }

    #[test]
    fn error_envelope_keeps_the_report_text() {
        let report = json!({"ok": true});
        let ok = super::super::report::tidy_tool_result(&report, None);
        let Ok(parts) = envelope_to_parts(&ok) else { panic!("ok report") };
        assert!(matches!(&parts[..], [ToolPart::Text(t)] if *t == report.to_string()));
        let report = json!({"ok": false, "error": "x"});
        let bad = super::super::report::tidy_tool_result(&report, None);
        assert_eq!(envelope_to_parts(&bad).err(), Some(PortError::Failed { capability: "tidy".into(), message: report.to_string() }));
    }

    struct Never;

    #[async_trait]
    impl ToolService for Never {
        async fn call(&self, _: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
            unreachable!()
        }
    }
}
