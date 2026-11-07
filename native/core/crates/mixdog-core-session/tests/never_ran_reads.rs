//! A lane read that never ran is an error, not an absent value (F1: a refused or wedged lane).
//! Own test binary: it installs a backend that refuses every job.

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_session::session::shell_jobs::WorkspaceSight;
use mixdog_core_session::session::user_cwd::UserCwd;
use mixdog_core_session::session::workspace_sight::GitSight;
use mixdog_mcp::oauth::store::MarkerFiles;
use mixdog_rt::Backend;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::QueuedJob;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;

/// A backend whose every lane refuses its jobs, as a lane with no healthy worker does.
struct Refusing;

impl Backend for Refusing {
    fn handle(&self, _class: TaskClass) -> tokio::runtime::Handle {
        tokio::runtime::Handle::current()
    }

    fn record_poll(&self, _task: &'static str, _class: TaskClass, _elapsed: Duration) {}

    fn submit(&self, job: QueuedJob) -> Result<(), LaneFull> {
        Err(LaneFull { lane: job.lane() })
    }

    fn enter_thread(&self, _kind: ThreadKind) {}

    fn lane_wedged(&self, _lane: LaneKind) -> bool {
        true
    }
}

#[tokio::test]
async fn reads_that_never_ran_are_errors_not_absence() {
    let tokens = mixdog_rt::install(Arc::new(Refusing)).expect("first install of this process");
    let data = tempfile::tempdir().unwrap();

    // Node: a missing or unreadable `user-cwd.txt` is `null`. A read that did not run is not that.
    let cwd = UserCwd::new(data.path(), tokens.interactive_io);
    assert!(cwd.explicit_cwd(None).await.is_err());
    assert!(cwd.last_cwd(Some("1")).await.is_err());

    // Node: `workspaceSees` answers false when a file cannot be read. An unrun check is not false.
    let sight = GitSight::new(tokens.maintenance_io);
    assert!(sight.sees("/a", "/b").await.is_err());

    // Node: `hasStoredMcpOAuthTokens` answers false when the marker cannot be read. An unrun
    // read must not sign the account out.
    let markers = MarkerFiles::new(data.path().to_path_buf(), tokens.durability_io);
    assert!(markers.has_tokens("acme").await.is_err());
    assert!(markers.identity("acme").await.is_err());
}
