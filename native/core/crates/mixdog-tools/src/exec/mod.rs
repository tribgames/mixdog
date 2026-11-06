//! `shell` and `task` front ends over the process manager (T §3.5–3.6).

use std::time::Duration;

mod archive;
mod bashism;
mod benign;
pub mod codepage;
mod compact;
mod delivery;
mod direct;
mod env;
pub use env::session_scratch_dir;
mod fold;
mod guard;
mod hoist;
mod hygiene;
mod invocation;
mod jobs;
mod psfix;
pub(crate) mod scan;
pub(crate) mod settle;
mod shell;
mod snapshot;
mod spill;
mod task;
mod text;
mod wake;
mod warning;

pub use fold::fold_carriage_return_frames;
pub use fold::fold_consecutive_duplicate_lines;
pub use text::escape_harness_tags;
pub use hoist::ExtSyntax;
pub use invocation::SkillRuntime;
pub use invocation::skill_launcher_dir;
pub use hoist::ScriptSyntax;
pub use jobs::ElevationGate;
pub use jobs::ExecConfig;
pub use jobs::OsPromptElevation;
pub use jobs::OwnerCycles;
pub use jobs::SurvivorWatch;
pub use jobs::Survivors;
pub use jobs::ExecRuntime;
pub use jobs::IoLanes;
pub use jobs::Job;
pub use jobs::JobStatus;
pub use jobs::TaskNotifier;
pub use jobs::most_significant_duration;
pub use shell::ShellTool;
pub use wake::QueuedWake;
pub use wake::Wake;
pub use wake::WakeHub;
pub use wake::WakeReason;
pub use task::TaskTool;

/// How long a cancel waits to see the process exit.
pub(crate) const KILL_VERIFY: Duration = Duration::from_secs(5);

#[cfg(test)]
mod tests;
