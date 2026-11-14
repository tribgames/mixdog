//! The `memory` and `recall` tools an agent calls (`internal-tool-executor/knowledge-tools.mjs`
//! `memory`, then the memory runtime's `handleToolCall`, `runtime/memory/lib/tool-call-handler.mjs`).
//! The definitions are [`ServiceTool::memory`] / [`ServiceTool::recall`]; this is the service behind
//! them: the call's working directory and the calling session's memory scope go into the
//! arguments, and [`LocalMemory`] answers.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::js_trim;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::service::ServiceCall;
use mixdog_tools::orch::service::ServiceTool;
use mixdog_tools::orch::service::ToolService;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use crate::memory::recall::RecallOutcome;
use crate::memory::service::LocalMemory;
use crate::memory::service::MemoryModule;

/// Whose memory a session reads and writes.
#[async_trait]
pub trait MemoryCallers: Send + Sync {
    /// `memoryCallerScope(session)` of the calling thread: `{ kind, agentId }`.
    async fn memory_caller(&self, thread: &ThreadId) -> Value;
    /// The session whose runtime loads the memory module for a call of `thread`: a delegated worker's calls run in its owner's runtime
    /// (the top of its headers' `parentSessionId` chain), so the owner is the session marked, never the worker; any other thread is its own.
    async fn runtime_owner(&self, thread: &ThreadId) -> String;
}

/// `{ ...memoryToolArgsForCaller(args, callerCwd), memory_caller }`: the model's own `cwd`, if it
/// names one, else the call's; the model never names the caller.
fn args_for_caller(args: &Value, cwd: &Path, caller: Value) -> Value {
    let mut input = args.as_object().cloned().unwrap_or_default();
    if !input.get("cwd").and_then(Value::as_str).is_some_and(|named| !js_trim(named).is_empty()) {
        input.insert("cwd".into(), Value::String(cwd.to_string_lossy().into_owned()));
    }
    input.insert("memory_caller".into(), caller);
    Value::Object(input)
}

/// The reply text, or the same text as a failure when the memory runtime flagged `isError`.
fn reply_parts(text: String, is_error: bool, capability: &str) -> Result<Vec<ToolPart>, PortError> {
    if is_error {
        return Err(PortError::Failed { capability: capability.into(), message: text });
    }
    Ok(vec![ToolPart::Text(text)])
}

/// The `recall` tool's reply parts. A call its request's cancel ended is the caller's cancellation: in Node the memory proxy
/// rejects the call itself (`rpc.mjs:74-78`), so no reply text, flagged or not, reaches the caller.
fn recall_parts(outcome: RecallOutcome) -> Result<Vec<ToolPart>, PortError> {
    if outcome.cancelled {
        return Err(PortError::Cancelled);
    }
    reply_parts(outcome.text, outcome.is_error, "recall")
}

struct Host {
    memory: Arc<LocalMemory>,
    callers: Arc<dyn MemoryCallers>,
}

impl Host {
    /// The call's arguments; the calling session's runtime (its owner's, for a delegated worker) has loaded the module (`knowledge-tools.mjs:45`, `getMemoryModule()`).
    async fn args(&self, call: &ServiceCall<'_>) -> Value {
        self.memory.note_session_use(&self.callers.runtime_owner(call.thread).await);
        args_for_caller(call.args, call.cwd.as_path(), self.callers.memory_caller(call.thread).await)
    }
}

struct MemoryToolService(Arc<Host>);

#[async_trait]
impl ToolService for MemoryToolService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let reply = self.0.memory.memory_reply(&self.0.args(&call).await).await;
        reply_parts(reply.text, reply.is_error, "memory")
    }
}

struct RecallToolService(Arc<Host>);

#[async_trait]
impl ToolService for RecallToolService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let outcome = self.0.memory.recall_outcome_cancellable(&self.0.args(&call).await, call.cancel).await;
        recall_parts(outcome)
    }
}

/// `memory` then `recall`, in the order of the memory runtime's definitions (`TOOL_DEFS`).
pub fn tools(memory: Arc<LocalMemory>, callers: Arc<dyn MemoryCallers>) -> Vec<Arc<dyn Tool>> {
    let host = Arc::new(Host { memory, callers });
    vec![
        Arc::new(ServiceTool::memory(Arc::new(MemoryToolService(host.clone())))),
        Arc::new(ServiceTool::recall(Arc::new(RecallToolService(host)))),
    ]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_call_directory_fills_a_blank_cwd_and_the_caller_is_always_the_runtimes() {
        let caller = json!({ "kind": "human", "agentId": "lead" });
        let cwd = Path::new("/work/project");
        let got = args_for_caller(&json!({ "op": "list", "memory_caller": { "kind": "host" } }), cwd, caller.clone());
        assert_eq!(got, json!({ "op": "list", "memory_caller": caller, "cwd": "/work/project" }));
        let got = args_for_caller(&json!({ "op": "list", "cwd": "  " }), cwd, caller.clone());
        assert_eq!(got["cwd"], "/work/project");
        let got = args_for_caller(&json!({ "query": "x", "cwd": "/elsewhere" }), cwd, caller.clone());
        assert_eq!(got["cwd"], "/elsewhere");
        assert_eq!(args_for_caller(&json!(null), cwd, caller.clone())["cwd"], "/work/project");
    }

    #[test]
    fn a_recall_its_request_cancelled_is_the_callers_cancellation_not_a_reply() {
        let outcome = |is_error: bool, cancelled: bool| RecallOutcome { text: "recall failed: This operation was aborted".into(), next_cursor: None, is_error, cancelled };
        assert_eq!(recall_parts(outcome(true, true)), Err(PortError::Cancelled));
        assert_eq!(
            recall_parts(outcome(true, false)),
            Err(PortError::Failed { capability: "recall".into(), message: "recall failed: This operation was aborted".into() })
        );
    }

    #[test]
    fn a_flagged_reply_is_a_failure_with_the_same_text() {
        assert_eq!(reply_parts("ok".into(), false, "memory"), Ok(vec![ToolPart::Text("ok".into())]));
        assert_eq!(
            reply_parts("core list failed: x".into(), true, "memory"),
            Err(PortError::Failed { capability: "memory".into(), message: "core list failed: x".into() })
        );
    }
}
