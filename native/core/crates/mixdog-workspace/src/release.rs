//! The one release hook for "a folder is going away" (DS §4.1): a project deleted, a managed
//! worktree removed. Whatever holds the folder open (language servers, terminals, watches) registers
//! a [`FolderRelease`]; `project/delete` and worktree removal (`mixdog-scm`) both run all of them.
//! This replaces the wire operations `lspDisposeUnder` and `termDisposeUnder`.

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;

#[async_trait]
pub trait FolderRelease: Send + Sync {
    fn name(&self) -> &str;
    /// Lets go of everything held at or under `root`. A failure is reported, never swallowed.
    async fn release_under(&self, root: &Path) -> Result<(), String>;
}

/// A hook that did not release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFailure {
    pub name: String,
    pub error: String,
}

#[derive(Default)]
pub struct FolderReleases {
    hooks: Mutex<Vec<Arc<dyn FolderRelease>>>,
}

impl FolderReleases {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn add(&self, hook: Arc<dyn FolderRelease>) {
        self.hooks.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(hook);
    }

    /// Runs every hook for `root`, one after the other; the failures of those that failed.
    pub async fn release_under(&self, root: &Path) -> Vec<ReleaseFailure> {
        let hooks: Vec<_> = self.hooks.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let mut failures = Vec::new();
        for hook in hooks {
            if let Err(error) = hook.release_under(root).await {
                failures.push(ReleaseFailure { name: hook.name().to_owned(), error });
            }
        }
        failures
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Hook {
        name: &'static str,
        fail: bool,
        seen: Mutex<Vec<PathBuf>>,
    }

    #[async_trait]
    impl FolderRelease for Hook {
        fn name(&self) -> &str {
            self.name
        }
        async fn release_under(&self, root: &Path) -> Result<(), String> {
            self.seen.lock().unwrap().push(root.to_path_buf());
            if self.fail { Err("busy".into()) } else { Ok(()) }
        }
    }

    #[tokio::test]
    async fn every_hook_runs_for_the_folder_and_a_failure_does_not_stop_the_rest() {
        let releases = FolderReleases::new();
        let first = Arc::new(Hook { name: "first", fail: true, seen: Mutex::default() });
        let second = Arc::new(Hook { name: "second", fail: false, seen: Mutex::default() });
        releases.add(first.clone());
        releases.add(second.clone());
        let failures = releases.release_under(Path::new("/w/a")).await;
        assert_eq!(failures, vec![ReleaseFailure { name: "first".into(), error: "busy".into() }]);
        assert_eq!(*second.seen.lock().unwrap(), vec![PathBuf::from("/w/a")]);
    }
}
