//! Where a run's approval asks go: the one choice `resolvePreToolAskApproval` makes per ask
//! (`loop/tool-helpers.mjs:204`), a hold for the run's owner or the surface's own card.
//!
//! The assembly (`assemble.rs`) puts the thread's session port through [`RunApprovals::gate_for`]
//! for the two places a tool call's approval is asked: the policy gate of the turn and the
//! `ToolEnv` a nested call (`call_tool`) is judged with. The held-request layer lives in the
//! daemon (its home delivery and push need the composition), so the choice is injected.

use std::sync::Arc;

use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::ids::ThreadId;

pub trait RunApprovals: Send + Sync {
    /// The approval entry point of `thread`'s run; `own` is the thread's session port.
    fn gate_for(&self, thread: &ThreadId, own: Arc<dyn ApprovalGate>) -> Arc<dyn ApprovalGate>;
}
