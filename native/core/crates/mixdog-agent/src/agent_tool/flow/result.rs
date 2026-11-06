//! A worker turn's result value (Node `completionValueFor`): the worker's identity, the turn's
//! report, and the error an abnormal finish is promoted to.

use mixdog_js::js_trim;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::Map;
use serde_json::Value;

use super::seams::AssistantText;
use super::seams::TurnResult;
use crate::response::Termination;

/// The value a worker's job reports: `{ …identity, content, handoffOnly?, error? }`.
#[derive(Clone, PartialEq, Debug)]
pub struct WorkerResult {
    pub value: Value,
    pub error: Option<String>,
}

impl WorkerResult {
    pub fn content(&self) -> &str {
        self.value.get("content").and_then(Value::as_str).unwrap_or_default()
    }

    pub fn task_result(&self) -> TaskResult {
        TaskResult::Json(self.value.clone())
    }
}

/// `abnormalEmptyFinishError`: an abnormal finish promoted to an explicit error, so the owner
/// receives a failure with its reason instead of a silent empty `completed`. `agent` reads into
/// the message as JavaScript would print it.
pub fn abnormal_empty_finish_error(result: &TurnResult, agent: &str) -> Option<String> {
    let stop = result.stop_reason.as_deref();
    let shape = format!("{} iterations, {} tool calls", result.iterations, result.tool_calls_total);
    match result.termination? {
        Termination::Truncated => {
            Some(format!("agent '{agent}' response was truncated (stopReason={}) before a final answer ({shape})", stop.unwrap_or("null")))
        }
        Termination::Empty => Some(format!("agent '{agent}' finished without a final answer (stopReason={}, {shape})", stop.unwrap_or("none"))),
        Termination::Refusal => Some(format!("agent '{agent}' response was refused by the safety classifier ({shape})")),
    }
}

/// `completionValueFor`: `canonical` surfaces hand the answer off without a header.
pub fn completion_value(identity: &Map<String, Value>, result: &TurnResult, canonical: bool, agent: &str) -> WorkerResult {
    let error = abnormal_empty_finish_error(result, agent);
    let mut value = identity.clone();
    value.insert("content".into(), Value::String(result.report_text().to_owned()));
    if canonical {
        value.insert("handoffOnly".into(), Value::Bool(true));
    }
    if let Some(error) = &error {
        value.insert("error".into(), Value::String(error.clone()));
    }
    WorkerResult { value: Value::Object(value), error }
}

/// `collectSessionAssistantHandoffText`: the assistant text a turn produced, row by row. A row
/// contributes its content, else its replay text; a bare `.` is no text.
fn assistant_handoff_text(rows: &[AssistantText]) -> String {
    rows.iter()
        .filter_map(|row| {
            let content = js_trim(&row.content);
            let text = if content.is_empty() { js_trim(&row.replay) } else { content };
            (!text.is_empty() && text != ".").then(|| text.to_owned())
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `turnPartialHandoff`: what a stopped turn produced before it stopped. The error's own handoff
/// wins (even an empty one), else the assistant text the session gained.
pub fn turn_partial_handoff(error_handoff: Option<&str>, rows: &[AssistantText]) -> Option<String> {
    if let Some(handoff) = error_handoff {
        return Some(handoff.to_owned());
    }
    let text = assistant_handoff_text(rows);
    (!js_trim(&text).is_empty()).then_some(text)
}
