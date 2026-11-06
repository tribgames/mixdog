//! MCP client hub, skills, plugins and the hooks catalog (T §4–§5; LR §8.3; SPEC R41).
//!
//! Elicitation, sampling and roots requests from servers are answered with the typed
//! `unsupported` error and no capability is advertised (D-ELICIT: later). Every server
//! connection is independent of every other.

pub mod admission;
pub mod config;
pub mod connector_accounts;
mod containment;
pub mod declaration_cache;
pub mod extension_service;
pub mod hook_bus;
pub mod hook_runner;
pub mod hooks;
pub mod http;
pub mod hub;
pub mod launcher;
pub mod connectors;
pub mod naming;
pub mod oauth;
pub mod outbound;
pub mod permissions;
pub mod plugin_admin;
pub mod plugin_servers;
pub mod plugins;
pub mod policy;
pub mod pre_tool;
pub mod result;
pub mod rpc;
pub mod server;
pub mod scopes;
pub mod skill_catalog;
pub mod skill_deps;
pub mod skill_frontmatter;
pub mod skill_port;
pub mod skill_state;
pub mod skills;
pub mod skills_watch;
pub mod sse;
pub mod stdio;
pub mod tools;
pub mod transport;
pub mod ws;

pub use config::McpServerConfig;
pub use hub::McpHub;
pub use server::McpIo;
pub use server::McpServer;
