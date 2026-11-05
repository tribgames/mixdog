//! The real `PreToolHook` of the approval pipeline: the hook bus's before-tool decision as
//! the pipeline's `HookDecision`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::HookDecision;
use mixdog_tools::policy::HookFailure;
use mixdog_tools::policy::PreToolHook;

use crate::hook_bus::HookBus;
use crate::hook_bus::HookCommon;
use crate::hook_bus::ToolCall;
use crate::hook_bus::after::effective_tool_cwd;

/// The transcript path, permission mode and effort of a thread's hook payloads.
pub type CommonSource = Arc<dyn Fn(&ThreadId) -> HookCommon + Send + Sync>;

pub struct BusPreToolHook {
    bus: Arc<HookBus>,
    common: CommonSource,
}

impl BusPreToolHook {
    pub fn new(bus: Arc<HookBus>, common: CommonSource) -> Self {
        Self { bus, common }
    }
}

#[async_trait]
impl PreToolHook for BusPreToolHook {
    async fn pre_tool(&self, call: &HookCall<'_>) -> Result<Option<HookDecision>, HookFailure> {
        let common = (self.common)(call.thread_id);
        let cwd = effective_tool_cwd(call.name, call.args, call.cwd);
        let tool_call = ToolCall {
            session_id: call.thread_id.as_str(),
            call_id: call.call_id.as_str(),
            name: call.name,
            args: call.args,
            cwd: &cwd,
            common: &common,
        };
        let Some(outcome) = self.bus.before_tool(&tool_call).await else { return Ok(None) };
        let action = match outcome.action {
            "deny" => HookAction::Deny,
            "ask" => HookAction::Ask,
            "modify" => HookAction::Rewrite,
            _ => HookAction::Allow,
        };
        Ok(Some(HookDecision { action, reason: outcome.reason, name: outcome.name, args: outcome.args }))
    }
}
