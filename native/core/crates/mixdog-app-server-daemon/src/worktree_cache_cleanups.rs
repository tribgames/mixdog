//! The root cleanups of the path-keyed caches (`shared/worktrees/cache-cleanups.mjs`, `WORKTREE_CACHE_CLEANUPS`):
//! when a managed worktree is removed these drop what the runtime cached under that exact root, so the removal
//! leaves no turn-review shadow repository and no code-graph cache behind. Each touches its own root only; what
//! matched but could not be deleted is the cleanup's failure, reported and retried with the deletion.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_review::turn_review::TurnReview;
use mixdog_scm::worktree::removal::RootCleanup;
use mixdog_tools::code_graph::GraphCache;

fn kept_error(kept: &[PathBuf]) -> Result<(), String> {
    if kept.is_empty() {
        return Ok(());
    }
    Err(format!("kept: {}", kept.iter().map(|path| path.to_string_lossy()).collect::<Vec<_>>().join(", ")))
}

/// `turn-worktree-snapshots`: `forgetTurnWorktreeRoot(root)`, the turn review's shadow repository of the root.
pub struct TurnSnapshotCleanup {
    review: Arc<TurnReview>,
}

impl TurnSnapshotCleanup {
    pub fn new(review: Arc<TurnReview>) -> Self {
        Self { review }
    }
}

#[async_trait]
impl RootCleanup for TurnSnapshotCleanup {
    fn name(&self) -> &str {
        "turn-worktree-snapshots"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let (_removed, kept) = self.review.forget_worktree_root(&root.to_string_lossy()).await;
        kept_error(&kept)
    }
}

/// `code-graph`: the resident graph of the root (`forgetCodeGraphStateRoot`) and its disk cache
/// (`forgetDiskCodeGraphRoot`).
pub struct CodeGraphCleanup {
    cache: Arc<GraphCache>,
    lane: mixdog_rt::MaintenanceIo,
}

impl CodeGraphCleanup {
    pub fn new(cache: Arc<GraphCache>, lane: mixdog_rt::MaintenanceIo) -> Self {
        Self { cache, lane }
    }
}

#[async_trait]
impl RootCleanup for CodeGraphCleanup {
    fn name(&self) -> &str {
        "code-graph"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let (_removed, kept) = self.cache.forget_root(self.lane, &tokio_util::sync::CancellationToken::new(), root).await.map_err(|error| error.to_string())?;
        kept_error(&kept)
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup builds fixture trees")]
mod tests {
    use super::*;

    /// `WORKTREE_CACHE_CLEANUPS['code-graph']` over a root nothing was cached for: nothing to clean is never a failure, and
    /// the cache directory is not created (`forgetDiskCodeGraphRoot`: "Never creates the cache directory").
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_code_graph_cleanup_of_an_uncached_root_cleans_nothing_and_creates_nothing() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("cache");
        let cleanup = CodeGraphCleanup::new(Arc::new(GraphCache::new(dir.clone())), mixdog_rt::testing::tokens().maintenance_io);
        assert_eq!(cleanup.name(), "code-graph");
        cleanup.run(&tmp.path().join("gone"), "entry").await.expect("cleaned");
        assert!(!dir.exists());
        assert_eq!(kept_error(&[PathBuf::from("a"), PathBuf::from("b")]), Err("kept: a, b".to_owned()));
    }
}
