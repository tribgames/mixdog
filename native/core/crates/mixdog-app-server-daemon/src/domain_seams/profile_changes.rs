//! `session-runtime/agent-profile-changes.mjs`: the in-process fan-out of bot changes that reach
//! prompts, and `InstructionsChanged` (`announce()` of `instruction-files.mjs`) over it.
//!
//! The runtime that rebuilds a session's prompt for the saved bots (`refreshAgentProfile`)
//! subscribes a [`ProfileListener`]; with none subscribed a publication reaches nobody, as in
//! Node with no runtime open. `AgentEffects::agents_changed` (agent saves) publishes through the
//! same [`AgentProfileChanges`].

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_domains::domains::instructions::InstructionsChanged;

use super::caches::ContextStatusCaches;

/// One runtime's reaction to a changed bot.
#[async_trait]
pub trait ProfileListener: Send + Sync {
    async fn changed(&self) -> Result<(), String>;
}

#[derive(Default)]
pub struct AgentProfileChanges {
    listeners: Mutex<Vec<(u64, Arc<dyn ProfileListener>)>>,
    next: Mutex<u64>,
}

impl AgentProfileChanges {
    /// `subscribeAgentProfileChanges`: the id to [`unsubscribe`](Self::unsubscribe) with.
    pub fn subscribe(&self, listener: Arc<dyn ProfileListener>) -> u64 {
        let mut next = self.next.lock().unwrap_or_else(PoisonError::into_inner);
        *next += 1;
        self.listeners.lock().unwrap_or_else(PoisonError::into_inner).push((*next, listener));
        *next
    }

    pub fn unsubscribe(&self, id: u64) {
        self.listeners.lock().unwrap_or_else(PoisonError::into_inner).retain(|(held, _)| *held != id);
    }

    /// `publishAgentProfileChange`: settles once every runtime has applied the edit; one failing
    /// runtime never fails the save.
    pub async fn publish(&self) {
        let listeners: Vec<Arc<dyn ProfileListener>> =
            self.listeners.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, listener)| listener.clone()).collect();
        let results = futures::future::join_all(listeners.iter().map(|listener| listener.changed())).await;
        for error in results.into_iter().filter_map(Result::err) {
            tracing::warn!(%error, "a runtime did not apply the agent profile change");
        }
    }
}

/// `InstructionsChanged`: the rules-source and context-status caches are dropped, then the
/// profile change is published. The core keeps no copy of the rules sources (they are read
/// when a prompt is built), so the context-status caches are the only ones to drop.
pub struct InstructionsAnnounce {
    context_status: Arc<dyn ContextStatusCaches>,
    profile: Arc<AgentProfileChanges>,
}

impl InstructionsAnnounce {
    pub fn new(context_status: Arc<dyn ContextStatusCaches>, profile: Arc<AgentProfileChanges>) -> Arc<Self> {
        Arc::new(Self { context_status, profile })
    }
}

#[async_trait]
impl InstructionsChanged for InstructionsAnnounce {
    async fn changed(&self) {
        self.context_status.invalidate_all();
        self.profile.publish().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain_seams::golden;

    type Trace = Arc<Mutex<Vec<String>>>;

    /// A runtime that records that it heard the change and fails when asked to.
    struct Listener(&'static str, bool, Trace);

    #[async_trait]
    impl ProfileListener for Listener {
        async fn changed(&self) -> Result<(), String> {
            self.2.lock().unwrap().push(self.0.to_owned());
            if self.1 { Err("a runtime failed".into()) } else { Ok(()) }
        }
    }

    struct Gauge(Trace);

    impl ContextStatusCaches for Gauge {
        fn invalidate_all(&self) {
            self.0.lock().unwrap().push("context-status".to_owned());
        }
    }

    fn taken(trace: &Trace) -> Vec<String> {
        std::mem::take(&mut *trace.lock().unwrap())
    }

    fn nodes(key: &str) -> Vec<String> {
        golden()["instructions"][key].as_array().unwrap().iter().map(|step| step.as_str().unwrap().to_owned()).collect()
    }

    /// Node's `announce()` after a save: the gauge drops, then every runtime hears it in
    /// subscription order, a failing one stops nobody, and an unsubscribed one hears nothing.
    #[tokio::test]
    async fn an_announce_runs_the_steps_in_nodes_order() {
        let trace = Trace::default();
        let changes = Arc::new(AgentProfileChanges::default());
        changes.subscribe(Arc::new(Listener("listener-a", true, trace.clone())));
        let second = changes.subscribe(Arc::new(Listener("listener-b", false, trace.clone())));
        let announce = InstructionsAnnounce::new(Arc::new(Gauge(trace.clone())), changes.clone());
        announce.changed().await;
        assert_eq!(taken(&trace), nodes("trace"));
        changes.unsubscribe(second);
        announce.changed().await;
        assert_eq!(taken(&trace), nodes("afterUnsubscribe"));
    }
}