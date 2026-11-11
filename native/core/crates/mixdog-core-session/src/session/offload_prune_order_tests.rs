//! `pruneCompactedOffloads` against what joins the session while a committed compaction waits to prune: the
//! session's actor checks it is idle and reads what it references only when it prunes, and handles nothing else
//! until the deletes are done. A message queued after the compaction's snapshot keeps the sidecar it names; a
//! turn started meanwhile stops the prune (Node prunes an idle session only).

use std::sync::Arc;

use mixdog_core_api::ids::ItemId;
use mixdog_store::schema::record::HeaderChange;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::SessionHandle;
use super::run::Compaction;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::tests::start_thread;
use super::turn_ops::CompactionCommit;
use super::turn_ops::CompactionHeader;
use crate::eventually_on;

/// One thread whose turns wait for `release`, with old sidecars the compaction keeps, a message will name, and
/// nothing names.
struct World {
    rig: Rig,
    directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    release: Arc<Notify>,
    dir: tempfile::TempDir,
}

const SIDECARS: [&str; 3] = ["kept.txt", "queued.txt", "stray.txt"];

#[allow(clippy::disallowed_methods, reason = "test setup writes fixture sidecars")]
async fn world() -> World {
    let rig = Rig::new();
    let release: Arc<Notify> = Arc::default();
    let gate = release.clone();
    rig.set_script(Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            gate.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let dir = tempfile::tempdir().expect("sidecar dir");
    for name in SIDECARS {
        std::fs::write(dir.path().join(name), name).expect("sidecar");
    }
    *lock(&rig.compaction.offloads) = Some(dir.path().to_path_buf());
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    World { rig, directory, handle, release, dir }
}

impl World {
    fn compaction() -> Compaction {
        let summary = (ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary names kept.txt" }));
        Compaction { replacement: vec![summary], at: 5, dropped_count: 1, dropped: None }
    }

    /// A completion the thread queues and is not woken by (`live: false`), naming `queued.txt`; told once queued.
    async fn queue_naming_a_sidecar(&self) {
        self.handle
            .inbox
            .send(super::actor::Inbox::TaskNotification {
                surface: "agent".into(),
                task_id: "task_agent_1".into(),
                status: "completed".into(),
                text: "look at queued.txt".into(),
                origin: None,
                live: false,
            })
            .await
            .expect("the actor runs");
        eventually_on!(&[&self.handle.cell.stepped], || (!self.handle.cell.queued.load().is_empty()).then_some(())).await;
    }

    /// A completion that wakes the thread: its turn runs, until `release`.
    async fn start_turn(&self) {
        self.handle
            .inbox
            .send(super::actor::Inbox::TaskNotification {
                surface: "agent".into(),
                task_id: "task_agent_2".into(),
                status: "failed".into(),
                text: "failed".into(),
                origin: None,
                live: true,
            })
            .await
            .expect("the actor runs");
        eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_some().then_some(())).await;
    }

    /// The listing step of the prune, after the compaction is durable, waits: `.0` tells it arrived, `.1` lets it go.
    fn hold_listing(&self) -> (Arc<Notify>, Arc<Notify>) {
        let (arrived, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        *lock(&self.rig.compaction.listing_gate) = Some((arrived.clone(), go.clone()));
        (arrived, go)
    }

    #[allow(clippy::disallowed_methods, reason = "test reads the sidecar dir")]
    fn left(&self) -> Vec<&'static str> {
        SIDECARS.into_iter().filter(|name| self.dir.path().join(name).exists()).collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_after_the_snapshot_keeps_the_sidecar_it_names() {
    let world = world().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), World::compaction(), None));
    // The compaction is durable and its prune lists the old sidecars; the session takes a message meanwhile.
    tokio::select! {
        () = arrived.notified() => {}
        answered = &mut commit => panic!("answered before the prune listed: {answered:?}"),
    }
    world.queue_naming_a_sidecar().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    assert_eq!(world.left(), vec!["kept.txt", "queued.txt"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_before_the_prune_decides_stops_it() {
    let world = world().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), World::compaction(), None));
    tokio::select! {
        () = arrived.notified() => {}
        answered = &mut commit => panic!("answered before the prune listed: {answered:?}"),
    }
    world.start_turn().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    assert_eq!(world.left(), SIDECARS.to_vec(), "a session that is not idle is not pruned");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    world.release.notify_one();
}

/// The review's order: the snapshot is taken, a message naming an old sidecar is queued, the compaction becomes
/// durable, and the prune runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_before_the_compaction_is_durable_keeps_the_sidecar_it_names() {
    let world = world().await;
    let (release, held) = std::sync::mpsc::channel();
    let arrived = Arc::new(Notify::new());
    *lock(&world.rig.store.header_gate) = Some((arrived.clone(), held));
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    let header: CompactionHeader = Box::new(move |_, _| HeaderChange { set, unset: Vec::new() });
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), World::compaction(), Some(header)));
    // The compaction's batch is at the store, not durable: its snapshot is taken.
    tokio::select! {
        () = arrived.notified() => {}
        answered = &mut commit => panic!("answered before the compaction was durable: {answered:?}"),
    }
    world.queue_naming_a_sidecar().await;
    release.send(()).expect("release");
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    assert_eq!(world.left(), vec!["kept.txt", "queued.txt"]);
}
