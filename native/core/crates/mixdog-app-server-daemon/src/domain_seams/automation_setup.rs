//! The setup tool's automation actions (`save_automation`, `delete_automation`,
//! `set_automation_enabled`, `run_automation`, `set_webhook_config`) as a `SetupActions` owner:
//! [`AutomationSetup`] (`setup-tool/extended-actions.mjs` over `channel-admin.mjs`) behind the
//! calling session's `scheduleCallerScope`. The reply text is the dispatcher's receipt around
//! what the handler returns, so the recorded Node replies are replayed through `SetupService`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_ports::ports::setup_actions::SetupCallers;
use mixdog_services::channels::setup::AccessScope;
use mixdog_services::channels::setup::AgentDirectory;
use mixdog_services::channels::setup::AutomationAdmin;
use mixdog_services::channels::setup::AutomationSetup;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

/// `rt.listAgents()`: the fixed services, then every custom agent.
struct DefinitionDirectory(Arc<AgentDefinitions>);

#[async_trait]
impl AgentDirectory for DefinitionDirectory {
    async fn agent_ids(&self) -> Result<Vec<String>, String> {
        let rows = self.0.rows().await.map_err(|error| error.to_string())?;
        Ok(rows.into_iter().map(|row| row.id).collect())
    }
}

pub struct AutomationActions {
    setup: AutomationSetup,
    callers: Arc<dyn SetupCallers>,
}

impl AutomationActions {
    /// `admin` is the daemon's one `ChannelAdmin`; `callers` the one `SetupCallers` of the setup
    /// service, so the scope here is the scope its gate decided on; `agents` the agent catalog.
    pub fn new(admin: Arc<dyn AutomationAdmin>, agents: Arc<AgentDefinitions>, callers: Arc<dyn SetupCallers>) -> Self {
        Self::with_directory(admin, Arc::new(DefinitionDirectory(agents)), callers)
    }

    fn with_directory(admin: Arc<dyn AutomationAdmin>, agents: Arc<dyn AgentDirectory>, callers: Arc<dyn SetupCallers>) -> Self {
        Self { setup: AutomationSetup::new(admin, agents), callers }
    }
}

/// `scheduleCallerScope`: an unattended run is its bot's agent scope (it only narrows).
fn access_scope(scope: CallerScope) -> AccessScope {
    match scope {
        CallerScope::Human => AccessScope::Human,
        CallerScope::Agent { agent_id, .. } => AccessScope::Agent { agent_id },
        CallerScope::RoomMember => AccessScope::RoomMember,
        CallerScope::Headless => AccessScope::Headless,
    }
}

#[async_trait]
impl SetupActions for AutomationActions {
    fn actions(&self) -> &'static [&'static str] {
        self.setup.actions()
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        let scope = access_scope(self.callers.scope(call.thread).await);
        self.setup.run(call.action, call.args, call.thread, &scope).await
    }
}

/// The `schedules` and `webhooks` domains of `status`: the same owner (and so the same
/// `ChannelAdmin`) as the actions; the listing is the caller-independent `getChannelSetup`.
#[async_trait]
impl StatusReader for AutomationActions {
    fn domains(&self) -> &'static [&'static str] {
        &["schedules", "webhooks"]
    }

    async fn read(&self, domain: &str, _detail: bool, _thread: &mixdog_core_api::ids::ThreadId) -> Result<Value, PortError> {
        self.setup.status(domain).await
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn a_callers_scope_is_the_scope_of_the_access_rules() {
        assert_eq!(access_scope(CallerScope::Human), AccessScope::Human);
        assert_eq!(access_scope(CallerScope::Agent { agent_id: "reviewer".into(), unattended: true }), AccessScope::Agent { agent_id: "reviewer".into() });
        assert_eq!(access_scope(CallerScope::RoomMember), AccessScope::RoomMember);
        assert_eq!(access_scope(CallerScope::Headless), AccessScope::Headless);
    }
}
