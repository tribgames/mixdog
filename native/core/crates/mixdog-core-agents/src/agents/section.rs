//! The `agents` app section (SPEC R14): the value of `listAgents()` ([`AgentDefinitions::catalog`]),
//! pushed at start and after every change of the config (an agent's route lives there) or of a
//! definition (an `agents_changed` announcement), only when it differs from the last value pushed.
//! A listing that fails (a definition folder that cannot be read) is not pushed: the section
//! keeps the last good value.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::watch;

use super::AgentDefinitions;
use super::AgentEffects;
use super::OwnedRoutines;

/// [`AgentEffects`] that also wakes the `agents` section after a definition changed.
pub struct AnnouncingEffects {
    pub inner: Arc<dyn AgentEffects>,
    pub changed: Arc<Notify>,
}

#[async_trait]
impl AgentEffects for AnnouncingEffects {
    async fn agents_changed(&self) {
        self.inner.agents_changed().await;
        self.changed.notify_one();
    }

    async fn reload_routines(&self) -> Result<(), String> {
        self.inner.reload_routines().await
    }

    async fn set_agent_route(&self, agent_id: &str, route: &Value) -> Result<(), String> {
        self.inner.set_agent_route(agent_id, route).await
    }

    async fn delete_owned_routines(&self, agent_id: &str) -> Result<OwnedRoutines, String> {
        self.inner.delete_owned_routines(agent_id).await
    }
}

/// Starts the task that keeps the `agents` section pushed. `config_changes` is `Config::changes()`,
/// `changed` the notifier given to [`AnnouncingEffects`].
pub fn spawn_agents_section(
    agents: Arc<AgentDefinitions>,
    mut config_changes: watch::Receiver<u64>,
    definitions_changed: Arc<Notify>,
    publisher: Arc<dyn StatePublisher>,
    cancel: CancellationToken,
) {
    mixdog_rt::spawn("agents-section", TaskClass::Work, async move {
        let mut last: Option<Value> = None;
        loop {
            if let Ok(current) = agents.catalog().await
                && last.as_ref() != Some(&current)
            {
                publisher.publish(SectionName::Agents, None, change_of(&current));
                last = Some(current);
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = config_changes.changed() => if changed.is_err() { return },
                () = definitions_changed.notified() => {}
            }
        }
    });
}
