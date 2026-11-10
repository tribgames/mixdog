//! What the composition root gives the server besides the core.

use std::sync::Arc;

use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v1::ClientInfo;
use mixdog_app_protocol::v1::ServerCapabilities;

/// Where a client's version stands against this core's (`compat::order`, LR §0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VersionOrder {
    /// The client is older: `clientOutdated`.
    ClientOlder,
    Equal,
    /// The client is newer: `serverOutdated`.
    ClientNewer,
}

/// The `initialize` version gate. The daemon's `compat::order` is the only implementation; the
/// server never compares version text itself.
pub type VersionGate = Arc<dyn Fn(&ClientInfo) -> VersionOrder + Send + Sync>;

#[derive(Clone)]
pub struct ServerConfig {
    pub user_agent: String,
    pub platform_family: String,
    pub platform_os: String,
    pub server_version: String,
    pub server_build: String,
    /// Changes on every core start (P §4.4).
    pub server_instance_id: String,
    /// How this start's desktop defaults separation ended; every `initialize` reply carries it.
    pub defaults_separation: mixdog_app_protocol::v1::DefaultsSeparation,
    pub capabilities: ServerCapabilities,
    /// Checked at construction ([`Limits::check`]); the per-class caps are the admission caps.
    pub limits: Limits,
    pub version_gate: VersionGate,
}
