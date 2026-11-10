//! When the session releases its turns' snapshots (`turn_snapshots.rs`, Node
//! `turn-settle.mjs` `releaseWorkspace()` and the side checkouts' `dispose`).

use super::SessionDirectory;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn calls(rig: &Rig) -> Vec<String> {
    lock(&rig.snapshots.0).clone()
}

/// Every settled turn starts one release for its thread, once its run has ended.
#[tokio::test(start_paused = true)]
async fn each_settled_turn_releases_its_snapshots_once() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    assert!(calls(&rig).is_empty(), "nothing before a turn settles");
    let settled = format!("settled:{}", handle.id.as_str());

    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&rig.snapshots.1], || (calls(&rig).len() == 1).then_some(())).await;
    turn(&handle, "second", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&rig.snapshots.1], || (calls(&rig).len() == 2).then_some(())).await;
    assert_eq!(calls(&rig), vec![settled.clone(), settled]);
}

/// Shutdown stops each thread's cleanups as its runtime ends and disposes them all, so nothing
/// runs on. The two may land in either order: each stops everything the thread had.
#[tokio::test(start_paused = true)]
async fn shutdown_stops_each_threads_cleanups_and_disposes() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.shutdown().await;
    let stopped = format!("stopped:{}", handle.id.as_str());
    eventually_on!(&[&rig.snapshots.1], || (calls(&rig).len() == 2).then_some(())).await;
    let mut seen = calls(&rig);
    seen.sort();
    assert_eq!(seen, vec!["dispose".to_owned(), stopped]);
}
