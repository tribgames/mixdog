//! The snapshot cleanups against a real repository: a snapshot a command still runs in is kept
//! while its session's cleanup retries, and a stop ends exactly that session's retries.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_rt::CancellationToken;

use super::SnapshotCleanups;
use crate::session::worktree::worktree_tests::rig;

/// A retry delay that only a stop can end within the test.
const FOREVER_MS: u64 = 3_600_000;

#[tokio::test]
async fn a_stop_ends_the_retries_of_its_session_only_and_the_snapshot_is_left_for_the_prune() {
    let rig = rig();
    let cancel = CancellationToken::new();
    let entry = rig.worktrees.create_worker_snapshot("worker-1", &rig.repo, "HEAD", "tx-1", false, &cancel).await.unwrap();
    let path = PathBuf::from(entry["path"].as_str().unwrap());
    let lease = rig.worktrees.ledger().admit(&path).unwrap();

    let cleanups = SnapshotCleanups::new();
    let mut run = cleanups.release(rig.worktrees.clone(), "worker-1", Some(FOREVER_MS)).expect("started");
    assert_eq!(cleanups.running(), 1);

    // Another session's stop leaves it retrying.
    cleanups.cancel_hook()(Some("worker-2"));
    assert!(mixdog_rt::time::timeout(Duration::from_millis(300), &mut run).await.is_err());
    assert_eq!(cleanups.running(), 1);

    cleanups.cancel_hook()(Some("worker-1"));
    run.await.unwrap();
    assert_eq!(cleanups.running(), 0);
    assert!(crate::session::fixture_fs::exists(&path).unwrap());
    drop(lease);
}

#[tokio::test]
async fn a_disposed_runtime_starts_no_cleanup() {
    let rig = rig();
    let cleanups = SnapshotCleanups::new();
    cleanups.dispose();
    assert!(cleanups.release(rig.worktrees.clone(), "worker-1", None).is_none());
    assert_eq!(cleanups.running(), 0);
}
