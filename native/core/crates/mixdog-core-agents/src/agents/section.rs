//! The `agents` app section (SPEC R14): the value of `listAgents()` ([`AgentDefinitions::catalog`]),
//! pushed at start and after every change of the config (an agent's route lives there) or of a
//! definition (an `agents_changed` announcement), only when it differs from the last value pushed.
//! A listing that fails (a definition folder that cannot be read) is not pushed: the section
//! keeps the last good value.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_core_config::section_watch::FolderTrigger;
use mixdog_core_config::section_watch::Watched;
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

/// What Node ran when `listAgents` was read (`session-host-lifecycle.ts`: the agent-home retire
/// and the greeting reconcile): called with the catalog after every build. The daemon binds
/// `AgentLifecycle::listed` here once the home sessions it needs exist, which is after the
/// section's task started; a build before that tells nobody (the bind wakes the task for one more).
pub type ListedHook = Arc<dyn Fn(Value) + Send + Sync>;

/// One build of the catalog: pushed when it differs from the last one pushed, and handed to the
/// hook every time. A listing that fails (a definition folder that cannot be read) pushes and
/// tells nothing: the section keeps the last good value.
async fn pass(agents: &AgentDefinitions, last: &mut Option<Value>, publisher: &dyn StatePublisher, listed: &OnceLock<ListedHook>) {
    let Ok(current) = agents.catalog().await else { return };
    if last.as_ref() != Some(&current) {
        publisher.publish(SectionName::Agents, None, change_of(&current));
        *last = Some(current.clone());
    }
    if let Some(hook) = listed.get() {
        hook(current);
    }
}

/// Starts the task that keeps the `agents` section pushed. `config_changes` is `Config::changes()`,
/// `definitions_changed` the notifier given to [`AnnouncingEffects`]. `folders` are the agent
/// folders, shipped and user: another process changing a definition there wakes the task too,
/// as Node's listing reads them afresh on every call.
pub fn spawn_agents_section(
    agents: Arc<AgentDefinitions>,
    mut config_changes: watch::Receiver<u64>,
    definitions_changed: Arc<Notify>,
    folders: Watched,
    listed: Arc<OnceLock<ListedHook>>,
    publisher: Arc<dyn StatePublisher>,
    cancel: CancellationToken,
) -> Result<(), String> {
    let trigger = FolderTrigger::start("agent-definitions", folders, definitions_changed.clone()).map_err(|error| error.to_string())?;
    mixdog_rt::spawn("agents-section", TaskClass::Work, async move {
        // The folder watch lives as long as the task.
        let _trigger = trigger;
        let mut last: Option<Value> = None;
        loop {
            pass(&agents, &mut last, &*publisher, &listed).await;
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = config_changes.changed() => if changed.is_err() { return },
                () = definitions_changed.notified() => {}
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::mock::MockStatePublisher;
    use serde_json::json;

    use super::*;

    // Node ran the agent-home retire and the greeting reconcile on every `listAgents`, changed
    // result or not; the section pushes only a change.
    #[tokio::test]
    async fn every_build_tells_the_hook_and_only_a_changed_catalog_is_pushed() {
        let (_dir, agents) = crate::agents::tests::writable(json!({})).await;
        let publisher = MockStatePublisher::default();
        let listed = OnceLock::new();
        let mut last = None;
        pass(&agents, &mut last, &publisher, &listed).await;
        assert_eq!(publisher.published().len(), 1, "the first build is pushed");
        assert_eq!(publisher.published()[0].0, SectionName::Agents);

        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        assert!(listed.set(Arc::new(move |catalog| sink.lock().unwrap().push(catalog))).is_ok());
        pass(&agents, &mut last, &publisher, &listed).await;
        pass(&agents, &mut last, &publisher, &listed).await;
        assert_eq!(publisher.published().len(), 1, "an unchanged catalog pushes nothing");
        let catalog = agents.catalog().await.unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![catalog.clone(), catalog], "each build reaches the hook, whole");
    }

    #[tokio::test]
    async fn a_build_before_the_hook_is_bound_tells_nobody() {
        let (_dir, agents) = crate::agents::tests::writable(json!({})).await;
        let listed = OnceLock::new();
        let mut last = None;
        pass(&agents, &mut last, &MockStatePublisher::default(), &listed).await;
        assert!(listed.get().is_none());
        assert!(last.is_some());
    }
}
