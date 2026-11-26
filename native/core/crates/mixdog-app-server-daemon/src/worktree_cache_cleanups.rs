//! The root cleanups of the path-keyed caches (`shared/worktrees/cache-cleanups.mjs`, `WORKTREE_CACHE_CLEANUPS`):
//! when a managed worktree is removed these drop what the runtime cached under that exact root, so the removal
//! leaves no turn-review shadow repository and no code-graph cache behind. Each touches its own root only; what
//! matched but could not be deleted is the cleanup's failure, reported and retried with the deletion.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_review::turn_review::TurnReview;
use mixdog_graph_host::GraphHost;
use mixdog_graph_host::wire::ForgetRoot;
use mixdog_graph_host::wire::Forgot;
use mixdog_scm::worktree::removal::RootCleanup;
use mixdog_tools::code_graph::engine::DiskCatalog;

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
/// (`forgetDiskCodeGraphRoot`). A running helper forgets both behind the root's refresh; with none, the root's manifest row,
/// payload and heap note under `cache_dir` go on the lane while no helper can start.
pub struct CodeGraphCleanup {
    host: Arc<GraphHost>,
    cache_dir: PathBuf,
    lane: mixdog_rt::MaintenanceIo,
}

impl CodeGraphCleanup {
    pub fn new(host: Arc<GraphHost>, cache_dir: PathBuf, lane: mixdog_rt::MaintenanceIo) -> Self {
        Self { host, cache_dir, lane }
    }
}

#[async_trait]
impl RootCleanup for CodeGraphCleanup {
    fn name(&self) -> &str {
        "code-graph"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let (dir, lane) = (self.cache_dir.clone(), self.lane);
        // Idempotent: the host may run it after a helper that was sent the removal died before answering.
        let on_disk = move |forget: ForgetRoot| async move {
            let cancel = tokio_util::sync::CancellationToken::new();
            let (removed, kept) =
                mixdog_scm::repo::on_lane(lane, &cancel, move || DiskCatalog::new(dir).forget(&forget.root)).await.map_err(|error| error.to_string())?;
            Ok::<_, String>(Forgot { removed, kept })
        };
        let forgot = self.host.forget_root(ForgetRoot { root: root.to_path_buf() }, on_disk).await.map_err(|error| error.to_string())?;
        kept_error(&forgot.kept)
    }
}

/// `code-graph` (`forgetTrustedCodeGraphRoot`): the project registry's entries that are the removed root itself, so the root is
/// no longer a trusted code-graph target once its worktree is gone. A path that cannot be unregistered is the cleanup's failure.
pub struct TrustedRootCleanup {
    registry: Arc<mixdog_workspace::catalog::Catalog>,
    /// The key of the managed worktree store (`<data>/worktrees-v1`) as a removal names its roots: the data folder as configured.
    store: String,
    /// The key of the store as the registry names a folder in it: the real path, which is what a registration records.
    real_store: String,
}
impl TrustedRootCleanup {
    /// The store is resolved here, once: a removal reads nothing from the disk, so a root that was replaced by a link since its
    /// registration is still the folder it was registered as, never the one the link names.
    pub async fn new(
        registry: Arc<mixdog_workspace::catalog::Catalog>,
        data_dir: &Path,
        lane: mixdog_rt::MaintenanceIo,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Self, String> {
        let store = data_dir.join(mixdog_scm::worktree::registry::STORE_DIR);
        let named = mixdog_scm::locks::path_key(&store);
        let real =
            mixdog_workspace::lanes::run(lane, cancel, move || mixdog_workspace::pathguard::resolved(&store)).await.map_err(|error| error.to_string())?;
        Ok(Self { registry, store: named, real_store: mixdog_scm::locks::path_key(&real) })
    }

    /// The keys a registration of `root` can have: `root` as named, and under the store its place in the real store.
    fn keys(&self, root: &Path) -> Vec<String> {
        let named = mixdog_scm::locks::path_key(root);
        let real = named.strip_prefix(&self.store).filter(|rest| rest.starts_with('/')).map(|rest| format!("{}{rest}", self.real_store));
        std::iter::once(named.clone()).chain(real).collect()
    }
}
#[async_trait]
impl RootCleanup for TrustedRootCleanup {
    fn name(&self) -> &str {
        "trusted-code-graph-root"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let keys = self.keys(root);
        let rows = self.registry.list().await.map_err(|error| error.to_string())?;
        let mut kept = Vec::new();
        for row in rows.into_iter().filter(|row| !row.path.is_empty() && keys.contains(&mixdog_scm::locks::path_key(Path::new(&row.path)))) {
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

    /// `WORKTREE_CACHE_CLEANUPS['code-graph']` over a root nothing was cached for, with no helper running: nothing to clean is
    /// never a failure, no helper is started for it, and the cache directory is not created (`forgetDiskCodeGraphRoot`: "Never
    /// creates the cache directory").
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_code_graph_cleanup_of_an_uncached_root_cleans_nothing_and_creates_nothing() {
        let tmp = tempfile::tempdir().expect("tmp");
        let dir = tmp.path().join("cache");
        let config = mixdog_graph_host::HostConfig::new(mixdog_graph_host::OwnedCommand::new(tmp.path().join("no-helper")), std::time::Duration::from_secs(1));
        let (host, driver) = GraphHost::new(config);
        drop(tokio::spawn(driver));
        let host = Arc::new(host);
        let cleanup = CodeGraphCleanup::new(host.clone(), dir.clone(), mixdog_rt::testing::tokens().maintenance_io);
        assert_eq!(cleanup.name(), "code-graph");
        cleanup.run(&tmp.path().join("gone"), "entry").await.expect("cleaned");
        assert_eq!(host.status().state, mixdog_graph_host::HostState::Absent, "no helper was started");
        assert!(!dir.exists());
        assert_eq!(kept_error(&[PathBuf::from("a"), PathBuf::from("b")]), Err("kept: a, b".to_owned()));
    }

    /// A directory link: a junction on Windows, a symlink elsewhere. `false` when it cannot be made.
    #[allow(clippy::disallowed_types, reason = "test setup makes a junction with the system's own tool")]
    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success())
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// `forgetTrustedCodeGraphRoot`: the registry entry of the removed root goes (the removal names it through the data folder as
    /// configured, here a link, and the registry holds the real path), a sibling's stays, a checkout that was replaced by a link to
    /// another registered project leaves that project registered, and a root nothing registered is not a failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_trusted_root_cleanup_unregisters_only_the_removed_root() {
        let tokens = mixdog_rt::testing::tokens();
        let tmp = tempfile::tempdir().expect("tmp");
        let (state, _) =
            mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &tmp.path().join("core.sqlite")).expect("state");
        let lanes = mixdog_workspace::lanes::Lanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            cpu_bulk: tokens.cpu_bulk,
        };
        let registry = Arc::new(mixdog_workspace::catalog::Catalog::new(state, lanes));
        let (real_data, linked_data) = (tmp.path().join("real-data"), tmp.path().join("data"));
        std::fs::create_dir_all(&real_data).expect("dir");
        // Where no link can be made the data folder is named as it is, which is the case of a real data folder.
        let data = if link_dir(&real_data, &linked_data) { linked_data } else { real_data };
        let repo = data.join(mixdog_scm::worktree::registry::STORE_DIR).join("hash");
        // A checkout and the session root in it (`projectSubdir`): a removal runs the cleanup for both.
        let (gone, kept) = (repo.join("gone"), tmp.path().join("kept"));
        for dir in [&gone.join("app"), &kept.join("app")] {
            std::fs::create_dir_all(dir).expect("dir");
        }
        for dir in [&gone, &gone.join("app"), &kept, &kept.join("app")] {
            registry.add(&dir.to_string_lossy(), &tokio_util::sync::CancellationToken::new(), None).await.expect("registered");
        }
        let cleanup =
            TrustedRootCleanup::new(registry.clone(), &data, tokens.maintenance_io, &tokio_util::sync::CancellationToken::new()).await.expect("cleanup");
        assert_eq!(cleanup.name(), "trusted-code-graph-root");
        let swapped = repo.join("swapped");
        if link_dir(&kept, &swapped) {
            for root in [swapped.clone(), swapped.join("app")] {
                cleanup.run(&root, "entry").await.expect("nothing of its own to clean");
            }
            assert_eq!(registry.list().await.expect("list").len(), 4, "the project the link names stays registered");
        }
        for root in [gone.clone(), gone.join("app")] {
            cleanup.run(&root, "entry").await.expect("cleaned");
        }
        let mut listed: Vec<String> = registry.list().await.expect("list").into_iter().map(|row| mixdog_scm::locks::path_key(Path::new(&row.path))).collect();
        listed.sort();
        let real_kept = mixdog_workspace::pathguard::canonical(&kept).unwrap();
        let mut expected = vec![mixdog_scm::locks::path_key(&real_kept), mixdog_scm::locks::path_key(&real_kept.join("app"))];
        expected.sort();
        assert_eq!(listed, expected, "the kept project's two rows stay, under their real paths");
        cleanup.run(&tmp.path().join("never"), "entry").await.expect("nothing to clean");
    }
}
