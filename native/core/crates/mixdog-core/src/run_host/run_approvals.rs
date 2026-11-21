use std::sync::Arc;

use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::ids::ThreadId;

pub trait RunApprovals: Send + Sync {
    /// The approval entry point of `thread`'s run; `own` is the thread's session port.
    fn gate_for(&self, thread: &ThreadId, own: Arc<dyn ApprovalGate>) -> Arc<dyn ApprovalGate>;
}
