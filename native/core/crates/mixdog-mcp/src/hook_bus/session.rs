//! A session's post-tool hooks over the bus (`session-hooks.mjs`: `afterToolHook`,
//! `afterToolFailureHook`, `afterToolBatchHook`): the call as the loop reports it, joined with
//! the session's common payload fields, dispatched, and the answer read as the loop reads it.

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use super::BatchCall;
use super::HookBus;
use super::HookCommon;
use super::ToolCall;

/// The common payload fields of a session (`hookCommonPayload`: transcript file, permission mode,
/// effort), by session id.
pub type CommonOf = Arc<dyn Fn(&str) -> HookCommon + Send + Sync>;

/// A finished tool call as the loop reports it.
pub struct PostCall<'a> {
    pub session_id: &'a str,
    /// The model's id of the call (`toolCallId`): the payload's `tool_use_id`, left out when empty.
    pub call_id: &'a str,
    pub name: &'a str,
    pub args: &'a Value,
    /// The call's effective directory.
    pub cwd: &'a str,
    /// The text the model sees (the error text for a failure).
    pub result: &'a str,
}

/// What a blocking-capable `PostToolBatch` decided: the loop adds `reason` as a note when
/// `blocked`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BatchOutcome {
    pub blocked: bool,
    pub reason: Option<String>,
}

pub struct SessionPostTool {
    bus: Arc<HookBus>,
    common: CommonOf,
}

impl SessionPostTool {
    pub fn new(bus: Arc<HookBus>, common: CommonOf) -> Self {
        Self { bus, common }
    }

    fn call<'a>(call: &'a PostCall<'a>, common: &'a HookCommon) -> ToolCall<'a> {
        ToolCall { session_id: call.session_id, call_id: call.call_id, name: call.name, args: call.args, cwd: Path::new(call.cwd), common }
    }

    /// `PostToolUse`: the result the model sees instead, when a hook replaced it.
    pub async fn tool(&self, call: &PostCall<'_>) -> Option<Value> {
        let common = (self.common)(call.session_id);
        self.bus.post_tool(&Self::call(call, &common), &Value::String(call.result.to_owned())).await
    }

    /// `PostToolUseFailure`.
    pub async fn failure(&self, call: &PostCall<'_>) {
        let common = (self.common)(call.session_id);
        self.bus.post_failure(&Self::call(call, &common), call.result).await;
    }

    /// `PostToolBatch`: `None` for a batch with no calls.
    pub async fn batch(&self, session_id: &str, cwd: &str, tool_count: usize) -> Option<BatchOutcome> {
        let common = (self.common)(session_id);
        let dispatched = self.bus.post_batch_dispatched(&BatchCall { session_id, cwd: Path::new(cwd), common: &common, tool_count }).await?;
        Some(BatchOutcome { blocked: dispatched.blocked, reason: dispatched.reason })
    }
}
