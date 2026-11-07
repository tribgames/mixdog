//! The `setup` tool's local-model actions as a `SetupActions` owner: the services crate holds the
//! handlers (`LocalModelSetupActions`, replayed against Node's executor in its own tests); the
//! dispatcher that wraps their answers in receipts lives in `mixdog-core-agents`, which does not
//! depend on the services crate, so composition joins the two here.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_services::local_provider::LocalModelSetupActions;
use mixdog_services::local_provider::LocalProviderService;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

pub(super) struct LocalSetup(LocalModelSetupActions);

impl LocalSetup {
    pub(super) fn new(service: Arc<LocalProviderService>) -> Arc<Self> {
        Arc::new(Self(LocalModelSetupActions::new(service)))
    }
}

#[async_trait]
impl SetupActions for LocalSetup {
    fn actions(&self) -> &'static [&'static str] {
        LocalModelSetupActions::ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        self.0.run(call.action, call.args).await
    }
}