//! The MCP, skill, plugin and connector setup actions (`mixdog-mcp::setup_actions`): the
//! dispatcher of this crate has already checked the caller scope and wraps the answer in the
//! receipt, so this only carries the call to the runtime and a failure's message back.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_mcp::setup_actions::SETUP_ACTIONS;
use mixdog_mcp::setup_actions::SetupRuntime;
use mixdog_mcp::setup_actions::run;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use super::SetupActions;
use super::SetupCall;

pub struct McpSetup {
    runtime: Arc<dyn SetupRuntime>,
}

impl McpSetup {
    pub fn new(runtime: Arc<dyn SetupRuntime>) -> Self {
        Self { runtime }
    }
}

#[async_trait]
impl SetupActions for McpSetup {
    fn actions(&self) -> &'static [&'static str] {
        SETUP_ACTIONS
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        // `validateSetupInput`: GitHub is the signed-in CLI, not a catalog connector.
        if call.action == "connect_connector"
            && call.args.get("connector").map(mixdog_js::value_to_string).is_some_and(|name| mixdog_js::js_trim(&name).to_lowercase() == "github")
        {
            return Err(PortError::Failed {
                capability: "setup".into(),
                message: "GitHub uses the signed-in GitHub CLI; no connector needed. Use the github tool or Settings → Git.".into(),
            });
        }
        run(call.action, call.args, self.runtime.as_ref())
            .await
            .map_err(|message| PortError::Failed { capability: "setup".into(), message })
    }
}
