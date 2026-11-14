//! SSH `server-ensure` (LR §8.1): install a monotonic version of `mixdogd` under
//! `~/.mixdog-remote/versions`, retire an older core through the one wind-down procedure,
//! and start the new one. It never downgrades and never kills.

// server-ensure is a one-shot synchronous program run over ssh, with no async runtime: blocking
// std::fs and process calls are its whole job (RL §13).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-shot synchronous ssh program, no runtime"
)]

mod args;
mod error;
mod flow;
mod host;
mod idle;
mod install;
mod layout;
mod lock;
mod manage;
mod os;
#[cfg(windows)]
mod winlist;
mod report;
#[cfg(test)]
mod tests;

pub use args::CleanupPhase;
pub use args::Mode;
pub use args::ModelLogin;
pub use args::ProgramArgs;
pub use error::EnsureError;
pub use flow::run;
pub use host::CoreAccess;
pub use host::CoreReport;
pub use host::DrainReport;
pub use host::EnsureHost;
pub use host::Launch;
pub use host::ProcessImage;
pub use host::ServerCore;
pub use install::GcReport;
pub use install::InstallState;
pub use layout::BINARY_NAME;
pub use layout::RemotePaths;
pub use os::main;
pub use report::CleanupResult;
pub use report::Report;
pub use report::Stopped;
pub use report::result_line;