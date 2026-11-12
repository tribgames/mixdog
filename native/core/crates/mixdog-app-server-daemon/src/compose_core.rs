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
    /// The grant store the tool gate holds: the agent permissions service (`AgentPermissions::new`) reads and writes the same one.
    pub grants: Arc<FileGrantStore>,
    /// The concrete connector policy `connectors` is: `McpConnectors::new(mcp, policy)` (the agent connector API) takes it.
    pub connector_policy: Arc<ConnectorPolicy>,
}

pub fn build_policy(tokens: &LaneTokens, data_dir: &Path) -> PolicyParts {
    let grants = FileGrantStore::new(data_dir.join("human-gate"), tokens.interactive_io, tokens.durability_io);
    let connector_policy = ConnectorPolicy::new(
        data_dir.to_path_buf(),
        PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
    );
    let connectors: Arc<dyn ConnectorPermissions> = connector_policy.clone();
    PolicyParts { policy: Arc::new(ToolPolicy::new(grants.clone(), connectors.clone())), connectors, grants, connector_policy }
}

/// The one MCP hub and the hook bus that dispatches through it. Tool-result artifacts land under
/// `<data>/tool-results`.
pub struct McpParts {
    pub hub: Arc<McpHub>,
    pub hook_bus: Arc<HookBus>,
}

/// `observer` is the hook event log (`createHookEventLog`) the bus emits every hook event into; `HookStatus` (the doctor, the `hooks` status) reads the same one.
pub fn build_mcp(tokens: &LaneTokens, data_dir: &Path, processes: Arc<dyn ProcessManager>, observer: Arc<dyn mixdog_mcp::hook_bus::HookObserver>) -> McpParts {
    let hub = McpHub::new(
        McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
        data_dir.join("tool-results"),
        OutputPolicy::default(),
    );
    let hook_bus = HookBus::new(data_dir.to_path_buf(), tokens.maintenance_io, processes, Some(hub.clone()), None, Some(observer));
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
        let mcp = build_mcp(&tokens, dir.path(), Arc::new(MockProcessManager::default()), crate::domain_seams::hook_status::HookEventLog::new(dir.path().to_path_buf()));
        assert!(Arc::strong_count(&mcp.hub) >= 2, "the hook bus dispatches through the hub");
        let policy = build_policy(&tokens, dir.path());
        assert!(Arc::strong_count(&policy.connectors) >= 2, "the policy holds the same connector policy");
    }

    struct NoTools;
    impl mixdog_tools::policy::ToolResolver for NoTools {
        fn resolve(&self, _scope: Option<&str>, _name: &str) -> Option<Arc<dyn mixdog_core_api::domain::tool::Tool>> {
            None
        }
    }

    /// A legacy rule in `<data>/hooks.json` that asks before a read is asked about by the policy over the hook bus, composed as
    /// `compose_flip.rs` composes it, as Node's tool gate asks the hook bus before every call (hook-bus/tool-gate.mjs `decisionFromRule`).
    #[tokio::test]
    async fn a_hook_rule_that_asks_puts_the_call_to_the_person() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        std::fs::write(dir.path().join("hooks.json"), r#"[{"tool":"read","match":"asked.json","action":"ask"}]"#).unwrap();
        let mcp = build_mcp(&tokens, dir.path(), Arc::new(MockProcessManager::default()), crate::domain_seams::hook_status::HookEventLog::new(dir.path().to_path_buf()));
        let hook = mixdog_mcp::pre_tool::BusPreToolHook::new(mcp.hook_bus, Arc::new(|_: &mixdog_protocol::ThreadId| mixdog_mcp::hook_bus::HookCommon::default()));
        let parts = build_policy(&tokens, dir.path());
        let policy = ToolPolicy::new(parts.grants, parts.connectors).with_hook(Arc::new(hook));
        let gate = mixdog_core_api::domain::mock::MockApprovalGate::default();
        let grants = mixdog_tools::policy::SessionGrants::default();
        let _ = policy
            .authorize(mixdog_tools::policy::AuthorizeRequest {
                call_id: &mixdog_protocol::ToolCallId::from("call-1"),
                thread_id: &mixdog_protocol::ThreadId::from("thread-1"),
                name: "read",
                args: serde_json::json!({ "path": "asked.json" }),
                cwd: dir.path(),
                facts: &mixdog_tools::policy::SessionFacts::default(),
                surface: &mixdog_tools::policy::SessionSurface::default(),
                schema_name: None,
                settings: mixdog_tools::policy::PolicySettings::default(),
                account: None,
                session_grants: &grants,
                tools: &NoTools,
                approvals: &gate,
                cancel: &tokio_util::sync::CancellationToken::new(),
            })
            .await;
        assert_eq!(gate.asks.lock().unwrap().len(), 1, "the read the rule names is put to the person");
    }
}