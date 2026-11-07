//! The `setup` tool's `status` action (`setup-tool/executor.mjs` `readStatus`): the dispatcher
//! and the one self-contained domain (`capabilities`). Each other domain reads state another
//! owner holds (routes, agents, providers, MCP, ...), so its reader is that owner's, registered
//! with [`SetupService::with_status`](super::SetupService::with_status).

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

/// `SETUP_STATUS_DOMAINS`.
pub(super) const STATUS_DOMAINS: [&str; 31] = [
    "summary", "model", "agents", "workflow", "websearch", "output-style", "profile", "autoclear",
    "compaction", "memory", "features", "local-provider", "shell", "providers", "mcp", "skills",
    "plugins", "update", "onboarding", "worktree", "network-proxy", "capabilities", "developer",
    "desktop", "appearance", "projects", "connection", "schedules", "webhooks", "hooks", "media",
];

/// `SETUP_DESKTOP_DOMAINS`: read by the window that hosts them.
pub(super) const DESKTOP_DOMAINS: [&str; 4] = ["desktop", "appearance", "projects", "connection"];

/// `capabilities`: the action field table, the status domains, the desktop scope and the
/// hand-offs, as Node's executor prints them (`status-capabilities.json` is its own output).
pub(super) fn capabilities() -> Value {
    serde_json::from_str(include_str!("status_capabilities.json")).expect("the capabilities table is valid JSON")
}

/// One domain's reader: `SETUP_STATUS_READERS[domain](rt, { domain, detail, caller, getConfig })`.
#[async_trait]
pub trait StatusReader: Send + Sync {
    /// The domains this reader answers (names from `STATUS_DOMAINS`, never `capabilities` or a
    /// desktop domain).
    fn domains(&self) -> &'static [&'static str];
    /// The public status shape of `domain` for the calling thread.
    async fn read(&self, domain: &str, detail: bool, thread: &ThreadId) -> Result<Value, PortError>;
}