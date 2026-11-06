//! Owner and worker completion notification (Node `agent-tool/notify.mjs`).

use std::sync::Arc;

use serde_json::Value;

use super::seams::NotifyFn;
use super::seams::WorkerInbox;
use crate::agent_tool::scope::clean_str;

/// Who started a job and where its completion goes (Node's immutable `ownerNotifyContext`).
#[derive(Clone, Default, PartialEq, Debug)]
pub struct NotifyContext {
    pub caller_session_id: Option<String>,
    pub owner_session_id: Option<String>,
    pub client_host_pid: Option<u64>,
    /// The bot-chain hop of the turn that started the job; its completion returns at that hop.
    pub hop: Option<Value>,
}

/// `workerNotifyFn`: tool completions produced inside a worker belong to that worker's own
/// session. Mirroring them to the owner made every promoted shell command appear as a second
/// Lead-level card, so only the agent task's terminal handoff crosses the parent boundary.
pub fn worker_notify(inbox: Arc<dyn WorkerInbox>, worker_session_id: &str) -> NotifyFn {
    let worker = clean_str(worker_session_id);
    Arc::new(move |text, meta| {
        if worker.is_empty() {
            return false;
        }
        let queued = inbox.enqueue_completion(&worker, text, meta);
        // A busy worker takes the completion at its next tool boundary; an idle one is woken so
        // the result reaches it now, not at its next message.
        if queued {
            let (inbox, worker) = (inbox.clone(), worker.clone());
            drop(mixdog_rt::spawn("agent-worker-wake", mixdog_rt::TaskClass::Work, async move { inbox.completion_queued(&worker) }));
        }
        queued
    })
}
