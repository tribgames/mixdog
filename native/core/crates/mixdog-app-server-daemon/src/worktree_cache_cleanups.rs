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

/// `code-graph` (`forgetTrustedCodeGraphRoot`): the project registry's entries that are the removed root itself, so the root is
/// no longer a trusted code-graph target once its worktree is gone. A path that cannot be unregistered is the cleanup's failure.
pub struct TrustedRootCleanup {
    registry: Arc<mixdog_workspace::catalog::Catalog>,
}

impl TrustedRootCleanup {
    pub fn new(registry: Arc<mixdog_workspace::catalog::Catalog>) -> Self {
        Self { registry }
    }
}

#[async_trait]
impl RootCleanup for TrustedRootCleanup {
    fn name(&self) -> &str {
        "trusted-code-graph-root"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let key = mixdog_scm::locks::path_key(root);
        let rows = self.registry.list().await.map_err(|error| error.to_string())?;
        let mut kept = Vec::new();
        for row in rows.into_iter().filter(|row| !row.path.is_empty() && mixdog_scm::locks::path_key(Path::new(&row.path)) == key) {
            match self.registry.remove(&row.path, None).await {
                Ok(answer) if answer["removed"] == true => {}
                _ => kept.push(PathBuf::from(row.path)),
            }
        }
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

    /// `forgetTrustedCodeGraphRoot`: the registry entry of the removed root goes, a sibling's stays, and a root nothing registered
    /// is not a failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_trusted_root_cleanup_unregisters_only_the_removed_root() {
        let tokens = mixdog_rt::testing::tokens();
        let tmp = tempfile::tempdir().expect("tmp");
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &tmp.path().join("core.sqlite")).expect("state");
        let lanes = mixdog_workspace::lanes::Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let registry = Arc::new(mixdog_workspace::catalog::Catalog::new(state, lanes));
        let (gone, kept) = (tmp.path().join("gone"), tmp.path().join("kept"));
        for dir in [&gone, &kept] {
            std::fs::create_dir_all(dir).expect("dir");
            registry.add(&dir.to_string_lossy(), &tokio_util::sync::CancellationToken::new(), None).await.expect("registered");
        }
        let cleanup = TrustedRootCleanup::new(registry.clone());
        assert_eq!(cleanup.name(), "trusted-code-graph-root");
        cleanup.run(&gone, "entry").await.expect("cleaned");
        let listed: Vec<String> = registry.list().await.expect("list").into_iter().map(|row| row.path).collect();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(mixdog_scm::locks::path_key(Path::new(&listed[0])), mixdog_scm::locks::path_key(&kept));
        cleanup.run(&tmp.path().join("never"), "entry").await.expect("nothing to clean");
    }
}
