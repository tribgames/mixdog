//! Worktree removal runs the workspace's folder-release hooks (`mixdog_workspace::release`): the
//! same set `project/delete` runs, so what holds a folder open (language servers, terminals) lets
//! go before `git worktree remove`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_workspace::release::FolderReleases;

use crate::worktree::removal::RootCleanup;

pub struct FolderReleaseCleanup {
    releases: Arc<FolderReleases>,
}

impl FolderReleaseCleanup {
    pub fn new(releases: Arc<FolderReleases>) -> Self {
        Self { releases }
    }
}

#[async_trait]
impl RootCleanup for FolderReleaseCleanup {
    fn name(&self) -> &str {
        "folder release"
    }

    async fn run(&self, root: &Path, _entry_id: &str) -> Result<(), String> {
        let failures = self.releases.release_under(root).await;
        if failures.is_empty() {
            return Ok(());
        }
        Err(failures.iter().map(|f| format!("{}: {}", f.name, f.error)).collect::<Vec<_>>().join("; "))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_workspace::release::FolderRelease;

    use super::*;

    struct Fails;

    #[async_trait]
    impl FolderRelease for Fails {
        fn name(&self) -> &str {
            "terminals"
        }
        async fn release_under(&self, _: &Path) -> Result<(), String> {
            Err("busy".into())
        }
    }

    #[tokio::test]
    async fn a_failed_hook_is_the_cleanup_failure_and_none_is_ok() {
        let releases = FolderReleases::new();
        let cleanup = FolderReleaseCleanup::new(releases.clone());
        assert_eq!(cleanup.run(Path::new("/w"), "e1").await, Ok(()));
        releases.add(Arc::new(Fails));
        assert_eq!(cleanup.run(Path::new("/w"), "e1").await, Err("terminals: busy".to_owned()));
    }
}
