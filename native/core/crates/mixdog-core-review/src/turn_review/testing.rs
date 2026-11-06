//! A turn review over the real lane disk and Git, for the tests of the layers that serve it.

use std::path::Path;
use std::sync::Arc;

use super::ports::ReviewDisk;
use super::ports::ReviewGit;
use super::service::Config;
use super::service::TurnReview;

/// A component over the real lane disk and Git.
pub fn test_review(data: &Path) -> TurnReview {
    review_at(data)
}

pub fn review_at(data: &Path) -> TurnReview {
    let tokens = mixdog_rt::testing::tokens();
    let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
    let scm = mixdog_scm::engine::Scm::new(processes, tokens.maintenance_io, data.join("scm-scratch"));
    let disk: Arc<dyn ReviewDisk> = Arc::new(super::LaneDisk::new(tokens));
    let git: Arc<dyn ReviewGit> = Arc::new(super::ScmGit::new(scm.clone()));
    let shadow = Arc::new(super::ShadowRepos::new(data.join("turn-worktree-snapshots-v1"), git.clone(), disk.clone()));
    let worktrees = Arc::new(super::ScmWorktrees::new(shadow));
    TurnReview::new(Config { disabled: false }, tokens.cpu_interactive, data, disk, git, worktrees)
}
