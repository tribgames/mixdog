//! The files of the data folder that the core writes and the terminal interface's footer reads, with the rules both read them
//! by: the statusline's gateway status, limits, agent rows and Claude-current route, the gateway session routes and usage log,
//! the shipped presets, and the per-cwd prompt history. It holds no session, store or service, so the terminal program links
//! these rules without the core.

pub mod gateway_routes;
pub mod gateway_usage;
pub mod presets;
pub mod prompt_history;
pub mod statusline_agents;
pub mod statusline_claude;
pub mod statusline_limits;
pub mod statusline_status;

/// The config file of the data folder.
pub const CONFIG_FILE: &str = "mixdog-config.json";
