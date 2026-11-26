//! ACP agents: a session run by an external agent over the Agent Client Protocol instead of
//! Mixdog's own loop. The agent owns its loop, its context and its tools; Mixdog starts it for the
//! session, sends the prompt, shows what it streams back and answers its permission requests.
//!
//! - [`preset`]: what tells one agent from another, as data.
//! - [`connection`], [`session`]: the agent's process and its session in it; `shared`: the one process of a preset that
//!   serves all its sessions.
//! - [`turn`], [`rows`], [`surface`]: one turn, reported to the run's port as any other run's.
//! - [`agents`]: the feature's switch and the agent of every session.
//! - [`upkeep`], [`registry`], [`login`]: each agent's readiness, install and update (a CLI's own, or a build of the ACP
//!   registry), and its sign-in.
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
pub mod registry;
pub mod routes;
pub mod rows;
pub mod runs;
pub mod search;
pub mod session;
mod shared;
pub mod surface;
pub mod tiers;
pub mod turn;
pub mod upkeep;

/// The built-in feature's id, on by default and switched in Providers (`modules.acpAgents.enabled`).
pub const FEATURE: &str = "acpAgents";
