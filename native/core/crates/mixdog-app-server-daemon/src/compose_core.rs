//! The core objects the composition root builds from the lane tokens and the data directory and
//! hands to the services that need them: the tool policy, the MCP hub and the hook bus.
//!
//! `TurnPathParts` takes these (`policy`, `connectors`, `hub`, `hook_bus`); the services other
//! owners write plug in through [`ComposeInputs`] (`compose_mcp::mcp_services`).

use std::path::Path;
use std::sync::Arc;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::HostChannel;
use mixdog_core_api::state::StatePublisher;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::permissions::ConnectorPolicy;
use mixdog_mcp::permissions::PolicyIo;
use mixdog_mcp::hub::McpHub;
use mixdog_mcp::server::McpIo;
use mixdog_mcp::result::OutputPolicy;
use mixdog_rt::LaneTokens;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::FileGrantStore;
use mixdog_tools::policy::ToolPolicy;

/// The tool policy over the on-disk grant store (`<data>/human-gate`) and the connector policy.
pub struct PolicyParts {
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
}

pub fn build_policy(tokens: &LaneTokens, data_dir: &Path) -> PolicyParts {
    let grants = FileGrantStore::new(data_dir.join("human-gate"), tokens.interactive_io, tokens.durability_io);
    let connectors: Arc<dyn ConnectorPermissions> = ConnectorPolicy::new(
        data_dir.to_path_buf(),
        PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
    );
    PolicyParts { policy: Arc::new(ToolPolicy::new(grants, connectors.clone())), connectors }
}

/// The one MCP hub and the hook bus that dispatches through it. Tool-result artifacts land under
/// `<data>/tool-results`.
pub struct McpParts {
    pub hub: Arc<McpHub>,
    pub hook_bus: Arc<HookBus>,
}

pub fn build_mcp(tokens: &LaneTokens, data_dir: &Path, processes: Arc<dyn ProcessManager>) -> McpParts {
    let hub = McpHub::new(
        McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io },
        data_dir.join("tool-results"),
        OutputPolicy::default(),
    );
    let hook_bus = HookBus::new(data_dir.to_path_buf(), tokens.maintenance_io, processes, Some(hub.clone()), None, None);
    McpParts { hub, hook_bus }
}

/// What a plug-in service (`compose_mcp::mcp_services`) is built from. The session directory and
/// the provider registry join it when the turn path is composed.
pub struct ComposeInputs {
    pub tokens: LaneTokens,
    pub data_dir: std::path::PathBuf,
    pub user_data_dir: std::path::PathBuf,
    /// The one `StatePublisher` (`state.publisher` of `compose_domains`).
    pub state: Arc<dyn StatePublisher>,
    /// The server's host channel (`Outgoing`).
    pub host: Arc<dyn HostChannel>,
    pub processes: Arc<dyn ProcessManager>,
    pub hub: Arc<McpHub>,
    pub hook_bus: Arc<HookBus>,
    pub policy: Arc<ToolPolicy>,
    pub connectors: Arc<dyn ConnectorPermissions>,
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::mock::MockProcessManager;

    use super::*;

    #[tokio::test]
    async fn the_policy_and_the_hub_are_built_over_the_data_directory() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let policy = build_policy(&tokens, dir.path());
        assert!(Arc::strong_count(&policy.connectors) >= 2, "the policy holds the same connector policy");
        let mcp = build_mcp(&tokens, dir.path(), Arc::new(MockProcessManager::default()));
        assert!(Arc::strong_count(&mcp.hub) >= 2, "the hook bus dispatches through the hub");
    }
}