//! A folder going away (a managed worktree removed, a project deleted) first disposes the terminals started inside it, so no
//! PTY keeps the folder locked (Node `registerWorktreeTerminalReleaser`, which called the `termDisposeUnder` operation; the
//! operation is core-internal now, desktop-services.md §4.1). The terminals are one hook of the shared set
//! (`mixdog_workspace::release::FolderReleases`) that `project/delete` and worktree removal both run.
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_spawn::TerminalTabs;
use mixdog_workspace::release::FolderRelease;

/// Disposes the tabs whose cwd is at or under the folder.
pub struct TerminalFolderRelease {
    tabs: Arc<TerminalTabs>,
}

impl TerminalFolderRelease {
    pub fn new(tabs: Arc<TerminalTabs>) -> Self {
        Self { tabs }
    }
}

#[async_trait]
impl FolderRelease for TerminalFolderRelease {
    fn name(&self) -> &str {
        "terminals"
    }

    async fn release_under(&self, root: &Path) -> Result<(), String> {
        self.tabs.dispose_under(&root.to_string_lossy());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::call::CoreRequest;
    use mixdog_core_api::call::Reply;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::service::DomainService;
    use mixdog_protocol::Origin;
    use mixdog_spawn::LocalProcessManager;
    use mixdog_spawn::ProcessConfig;
    use mixdog_spawn::service::ProcessFeeds;
    use mixdog_spawn::service::TerminalService;
    use mixdog_spawn::service::TerminalServiceConfig;
    use mixdog_workspace::release::FolderReleases;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    async fn ensure(terminal: &TerminalService, tab: &str, cwd: &Path) -> String {
        let params = json!({ "opId": "op-ensure", "tabId": tab, "options": { "cwd": cwd.to_string_lossy() } });
        let request = CoreRequest {
            method: Method("terminal/ensure"),
            params,
            op: None,
            ctx: CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new()),
        };
        let Reply::Value(ensured) = terminal.call(request).await.unwrap() else {
            panic!("terminal/ensure answers with a value");
        };
        ensured["id"].as_str().expect("the ensured tab has an id").to_owned()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_going_away_disposes_the_terminals_inside_it_and_no_other() {
        let tokens = mixdog_rt::testing::tokens();
        let manager = LocalProcessManager::new(tokens.spawn_io, ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager.clone(), Arc::new(MockScopedFeeds::new(MockLimits::default())));
        let terminal = TerminalService::new(manager, feeds, Arc::new(MockStatePublisher::default()), TerminalServiceConfig::default());
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().join("wt");
        let sibling = dir.path().join("wt-other");
        std::fs::create_dir_all(worktree.join("sub")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let inside = ensure(&terminal, "term_inside", &worktree.join("sub")).await;
        let outside = ensure(&terminal, "term_outside", &sibling).await;

        let releases = FolderReleases::new();
        releases.add(Arc::new(TerminalFolderRelease::new(terminal.tabs().clone())));
        let failures = releases.release_under(&worktree).await;
        assert!(failures.is_empty(), "{failures:?}");

        assert!(terminal.tabs().snapshot(&inside, None).is_none(), "the tab started in the worktree is disposed");
        assert!(terminal.tabs().snapshot(&outside, None).is_some(), "a tab in a folder that only shares the name prefix stays");
        terminal.tabs().dispose_all();
    }
}
