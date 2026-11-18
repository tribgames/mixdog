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

use crate::memory::core::{action, store::DeleteSettlement};
use crate::memory::recall::RecallOutcome;
use crate::memory::service::maintenance::{Action, parse_action};
use crate::memory::service::LocalMemory;
use crate::memory::service::MemoryModule;
use crate::memory::service::RUNTIME_NOT_READY;

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
    let text = if !outcome.is_error && outcome.text.is_empty() { "(no results)".to_owned() } else { outcome.text };
    reply_parts(text, outcome.is_error, "recall")
}

struct Host {
    memory: Arc<LocalMemory>,
    callers: Arc<dyn MemoryCallers>,
}
/// `requestJson`'s text for a call past its cap (`rpc.mjs`).
const TOOL_CALL_TIMED_OUT: &str = "memory proxy request timed out: POST /api/tool";

struct MemoryToolService(Arc<Host>);

#[async_trait]
impl ToolService for MemoryToolService {
    fn settles_cancellation(&self, args: &Value) -> bool {
        parse_action(args) == Ok(Action::Core) && action::is_delete(args)
    }

    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        if call.cancel.is_cancelled() {
            return Err(PortError::Cancelled);
        }
        let args = tokio::select! {
            biased;
            () = call.cancel.cancelled() => return Err(PortError::Cancelled),
            args = self.0.args(&call) => args,
        };
        let settlement = self.settles_cancellation(&args).then(|| Arc::new(DeleteSettlement::default()));
        let request = call.cancel.child_token();
        let _cancel_on_exit = request.clone().drop_guard();
        let work = self.0.memory.memory_reply_settled(&args, &request, settlement.clone());
        let reply = self.0.within_proxy(&call, "memory", settlement.as_deref(), work).await?;
        reply_parts(reply.text, reply.is_error, "memory")
    }
}

struct RecallToolService(Arc<Host>);

#[async_trait]
impl ToolService for RecallToolService {
    async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
        let args = self.0.args(&call).await;
        let request = call.cancel.child_token();
        let _cancel_on_exit = request.clone().drop_guard();
        let outcome = self.0.within_proxy(&call, "recall", None, self.0.memory.recall_outcome_cancellable(&args, &request)).await?;
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

/// The `memory` and `recall` services under their tools (tests call them without a tool context).
#[cfg(test)]
pub(crate) fn services(memory: Arc<LocalMemory>, callers: Arc<dyn MemoryCallers>) -> [Arc<dyn ToolService>; 2] {
    let host = Arc::new(Host { memory, callers });
    [Arc::new(MemoryToolService(host.clone())), Arc::new(RecallToolService(host))]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[tokio::test]
    async fn the_memory_tool_reports_the_commit_outcome_when_cancelled_during_refresh() {
        use mixdog_core_api::domain::common::AbsPath;
        use mixdog_core_api::domain::mock::{MockApprovalGate, MockFileService, MockProcessManager, MockProgress};
        use mixdog_core_api::domain::tool::{SurfaceKind, ToolContext, ToolIo};
        use tokio::sync::Notify;
        use tokio_util::sync::CancellationToken;

        #[derive(Default)]
        struct Delete {
            committed: Notify,
            refreshed: Notify,
        }
        #[async_trait]
        impl ToolService for Delete {
            fn settles_cancellation(&self, _: &Value) -> bool { true }
            async fn call(&self, call: ServiceCall<'_>) -> Result<Vec<ToolPart>, PortError> {
                let settlement = DeleteSettlement::default();
                wait_for_reply(Some(&settlement), async {
                    call.cancel.cancelled().await;
                    PortError::Cancelled
                }, async {
                    settlement.begin_commit(Some(call.cancel)).unwrap();
                    self.committed.notify_one();
                    self.refreshed.notified().await;
                    vec![ToolPart::Text("core deleted".into())]
                }).await
            }
        }

        let service = Arc::new(Delete::default());
        let tool = ServiceTool::memory(service.clone());
        let tokens = mixdog_rt::testing::tokens();
        let ctx = ToolContext {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            call_id: "call".into(),
            tool: "memory".into(),
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(MockProcessManager::default()),
            options: Default::default(),
            review: None,
        };
        let mut call = Box::pin(tool.call(&ctx, json!({"op":"delete"})));
        assert!(futures::poll!(&mut call).is_pending());
        service.committed.notified().await;
        ctx.cancel.cancel();
        assert!(futures::poll!(&mut call).is_pending(), "the delete must still await snapshot refresh");
        service.refreshed.notify_one();
        assert_eq!(call.await.unwrap().parts, [ToolPart::Text("core deleted".into())]);
    }

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

    #[test]
    fn recall_has_an_explicit_empty_result() {
        let outcome = RecallOutcome { text: String::new(), next_cursor: None, is_error: false, cancelled: false };
        assert_eq!(recall_parts(outcome), Ok(vec![ToolPart::Text("(no results)".into())]));
    }
}


impl Host {
    /// The call's arguments; the calling session's runtime (its owner's, for a delegated worker) has loaded the module (`knowledge-tools.mjs:45`, `getMemoryModule()`).
    async fn args(&self, call: &ServiceCall<'_>) -> Value {
        self.memory.note_session_use(&self.callers.runtime_owner(call.thread).await);
        args_for_caller(call.args, call.cwd.as_path(), self.callers.memory_caller(call.thread).await)
    }

    /// What Node's proxy puts around a tool call: the wait for the runtime (60 s for the child's ready message and 30 s for a live port,
    /// [`RUNTIME_READY_WAIT`] after the opening's launch), refused with the proxy's text when it never comes up, then `work` under
    /// the call's own cap (`calls.mjs:94`). An interrupted delete whose commit won still settles.
    async fn within_proxy<T>(
        &self, call: &ServiceCall<'_>, capability: &str, settlement: Option<&DeleteSettlement>, work: impl std::future::Future<Output = T>,
    ) -> Result<T, PortError> {
        let failed = |message: &str| PortError::Failed { capability: capability.into(), message: message.into() };
        tokio::select! {
            biased;
            () = call.cancel.cancelled() => return Err(PortError::Cancelled),
            ready = self.memory.ready() => if ready.is_err() { return Err(failed(RUNTIME_NOT_READY)) },
        }
        wait_for_reply(settlement, async {
            tokio::select! {
                biased;
                () = call.cancel.cancelled() => PortError::Cancelled,
                () = mixdog_rt::time::sleep(TOOL_CALL_TIMEOUT) => failed(TOOL_CALL_TIMED_OUT),
            }
        }, work).await
    }
}

async fn wait_for_reply<T>(
    settlement: Option<&DeleteSettlement>,
    interrupted: impl std::future::Future<Output = PortError>,
    work: impl std::future::Future<Output = T>,
) -> Result<T, PortError> {
    tokio::pin!(work);
    let error = tokio::select! {
        biased;
        error = interrupted => error,
        result = &mut work => return Ok(result),
    };
    if settlement.is_none_or(DeleteSettlement::interrupt) {
        Err(error)
    } else {
        Ok(work.await)
    }
}
/// The proxy's cap on one tool call (`calls.mjs:94`, `MIXDOG_MEMORY_TOOL_TIMEOUT_MS` unset).
pub(crate) const TOOL_CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
