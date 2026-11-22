//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. The terminal UI child a
//! pseudo-terminal test starts from this executable is named with its module path (`tests/support/daemon.rs`).

#[path = "../app_screens.rs"]
mod app_screens;
#[path = "../app_state.rs"]
mod app_state;
#[path = "../e2e_pty.rs"]
mod e2e_pty;
#[path = "../handlers.rs"]
mod handlers;
#[path = "../live_gaps.rs"]
mod live_gaps;
#[path = "../mouse.rs"]
mod mouse;
#[path = "../panels.rs"]
mod panels;
#[path = "../perf_pty.rs"]
mod perf_pty;
#[path = "../pickers_extensions.rs"]
mod pickers_extensions;
#[path = "../pickers_model.rs"]
mod pickers_model;
#[path = "../pickers_provider_flows.rs"]
mod pickers_provider_flows;
#[path = "../pickers_settings.rs"]
mod pickers_settings;
#[path = "../slash_dispatch.rs"]
mod slash_dispatch;
#[path = "../surface_epoch.rs"]
mod surface_epoch;
#[path = "../transcript_scroll.rs"]
mod transcript_scroll;
#[path = "../transcript_window.rs"]
mod transcript_window;
