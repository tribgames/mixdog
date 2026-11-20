//! Managed worktrees: typed refusals, names, settings, disk checks, includes, ownership, the
//! merge backend, the registry and the manager.

pub mod activity;
pub mod branches;
pub mod carry;
pub mod dependencies;
pub mod disk;
pub mod errors;
pub mod housekeeping;
pub mod include;
pub mod listing;
pub mod maintenance;
pub mod manager;
pub mod measure;
pub mod menu;
pub mod merge;
pub mod names;
pub mod ownership;
pub(crate) mod path_lock;
pub mod reconcile;
pub mod registry;
pub mod release;
pub mod removal;
pub mod retention;
pub mod review_bases;
pub mod settings;
pub mod setup_claim;
pub mod snapshots;
pub mod texts;
