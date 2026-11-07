//! The sources that may change what the agent tool's `getStatus` answers (`agent-tool.mjs`
//! `stopStatusSources`), as the session layer's emitters call them. One listener answers all of
//! them (`mixdog-core` `AgentActivity`), which asks the owners' threads to re-read their agents.
//!
//! - `worker_rows`: a worker-index row was written (`registry.onWorkerRowsChange`):
//!   [`StoreWorkers::write`](super::StoreWorkers), where every registry row change lands.
//!
//! The approval wait (`onSessionApprovalWaitChange`) and the session record (`sessionRecords.onChange`)
//! are emitted from the session actor, through `AgentSignals` (`session/agent_activity.rs`).
//! `onRolePolicyResolved` has no counterpart: Node resolves a role's watchdog policy lazily
//! after the first status read and announces the change; here the policy is a field of the live state
//! read each time, so nothing changes behind a read.

pub trait StatusSignals: Send + Sync {
    fn worker_rows(&self, session: &str);
}
