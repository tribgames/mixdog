//! The `agentPool` app section (SPEC R14, desktop-services.md §9): the rows `agent/pool/list`
//! answers, pushed after every status signal (`changed`, the agent-status listener's wake) and only
//! when they differ from the last rows pushed. Nothing polls; a burst of signals is one `Notify`
//! permit, so a listing that is running when more signals arrive is followed by exactly one more.
//! A listing that fails is not pushed: the section keeps the last good rows.

use std::sync::Arc;

use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::Notify;

use super::pool_list::AgentPool;

/// One listing: pushed when it differs from `last`.
pub(super) async fn pass(pool: &AgentPool, last: &mut Option<Vec<Value>>, publisher: &dyn StatePublisher) {
    let Ok(rows) = pool.list().await else { return };
    if last.as_ref() != Some(&rows) {
        publisher.publish(SectionName::AgentPool, None, change_of(&rows));
        *last = Some(rows);
    }
}

/// Starts the task that keeps the `agentPool` section pushed: one listing at start, then one per
/// wake of `changed`.
pub fn spawn_pool_section(pool: Arc<AgentPool>, changed: Arc<Notify>, publisher: Arc<dyn StatePublisher>, cancel: CancellationToken) {
    mixdog_rt::spawn("agent-pool-section", TaskClass::Work, async move {
        let mut last: Option<Vec<Value>> = None;
        loop {
            pass(&pool, &mut last, &*publisher).await;
            tokio::select! {
                () = cancel.cancelled() => return,
                () = changed.notified() => {}
            }
        }
    });
}
