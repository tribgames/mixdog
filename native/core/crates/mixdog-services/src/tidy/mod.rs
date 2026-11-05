//! Code Tidy's status surface: the engine inventory the desktop card renders and the progress of
//! the one-click core install. Status never downloads and never spawns; how an engine resolves
//! (manifest, PATH, managed tools dir) sits behind [`EngineResolver`] with the engine runner.

pub mod apply;
pub mod catalog;
pub mod core_install;
pub mod extract;
pub mod front;
pub mod function_length;
pub mod graph_outline;
pub mod history_comment;
pub mod install;
pub mod install_job;
pub mod languages;
pub mod process;
pub mod report;
pub mod resolve;
pub mod rule_files;
pub mod run_engines;
pub mod runners;
pub mod service;
pub mod shadow;
pub mod status;
pub mod structural;
pub mod tool;
pub mod worktree;

pub use install_job::{EngineProgress, InstallJob, TIDY_CORE_ENGINE_IDS};
pub use service::TidyService;
pub use status::{EngineResolver, ResolvedEngine, ResolvedSource, tidy_engine_status};
