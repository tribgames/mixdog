//! ACP agents: a session run by an external agent over the Agent Client Protocol instead of
//! Mixdog's own loop. The agent owns its loop, its context and its tools; Mixdog starts it for the
//! session, sends the prompt, shows what it streams back and answers its permission requests.
//!
//! - [`preset`]: what tells one agent from another, as data.
//! - [`connection`], [`session`]: the agent's process and its session in it.
//! - [`turn`], [`rows`], [`surface`]: one turn, reported to the run's port as any other run's.
//! - [`agents`]: the feature's switch and the agent of every session.
//! - [`upkeep`], [`login`]: each CLI's readiness, install and update, and the CLI's own sign-in.
//! - [`runs`], [`routes`]: a begun turn run in the agent, and the route services over a session on an agent.
//! - [`mcp`], [`mcp_bridge`]: the session's tools handed to its agent, and the stdio end of that
//!   server for an agent that takes no HTTP one.

pub mod agents;
pub mod connection;
pub mod files;
pub mod login;
pub mod mcp;
pub mod mcp_bridge;
pub mod preset;
pub mod routes;
pub mod rows;
pub mod runs;
pub mod session;
pub mod surface;
pub mod tiers;
pub mod turn;
pub mod upkeep;

/// The built-in feature's id in the settings (`modules.acpAgents`, `builtins.acpAgents`).
pub const FEATURE: &str = "acpAgents";
