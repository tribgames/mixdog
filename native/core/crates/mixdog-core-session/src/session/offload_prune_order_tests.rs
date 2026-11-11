//! `pruneCompactedOffloads` against what joins the session while a committed compaction waits to prune: the
//! session's actor checks it is idle, then the old sidecars are listed, then it reads what it references and
//! deletes, handling nothing else from the read to the last delete. A message queued after the compaction's
//! snapshot keeps the sidecar it names; a turn started first is not pruned and its sidecars are not listed (Node
//! prunes an idle session only), and the next prune of the idle session deletes what that one left; a turn started
//! while they are listed stops the prune.
//!
//! The first three orders replay Node's recording (`fixtures/offload-prune-order`, Node with the prune-after-save
//! fix: Node prunes once the compacted transcript is saved, as the core prunes once it is durable): the sidecars on
//! disk afterwards, each by its role, equal Node's. The sidecars are the host's own (`ToolResultArtifacts`), listed
//! and pruned by the host's own code.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::ids::ItemId;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::SessionHandle;
use super::run::Compaction;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use super::testing::offload_store;
use super::tests::start_thread;
use super::turn_ops::CompactionCommit;
use super::turn_ops::CompactionHeader;
use crate::eventually_on;

/// One thread whose turns wait for `release`, with the host's sidecars an hour old: `kept` the compaction names,
/// `queued` a queued message may name, and `stray` nothing names.
struct World {
    rig: Rig,
    directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    release: Arc<Notify>,
    data: tempfile::TempDir,
    /// Each sidecar's role and path.
    sidecars: Vec<(&'static str, String)>,
}

const ROLES: [&str; 3] = ["kept", "queued", "stray"];

/// `wait`, failing with `what` when it has not ended within ten seconds.
async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("no answer within 10s: {what}"))
}

/// An hour old: past the ten minutes a sidecar is kept whatever names it.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup ages a fixture file")]
fn age(path: &str) {
    let file = std::fs::File::options().write(true).open(path).expect("the sidecar");
    file.set_modified(std::time::SystemTime::now() - Duration::from_secs(3_600)).expect("aged");
}

async fn world() -> World {
    let rig = Rig::new();
    let release: Arc<Notify> = Arc::default();
    let gate = release.clone();
    rig.set_script(Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            within("the turn's input is durable", run.port.input_durable()).await.expect("input durable");
            within("the test releases the turn", gate.notified()).await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let data = tempfile::tempdir().expect("data dir");
    *lock(&rig.compaction.offloads) = Some(data.path().to_path_buf());
    let directory = SessionDirectory::new(rig.deps());
    let handle = within("the thread starts", start_thread(&directory)).await;
    let store = offload_store(data.path(), &handle.id);
    let mut sidecars = Vec::new();
    for role in ROLES {
        let path = within("the sidecar is written", store.persist(&format!("{role} output"))).await.expect("persisted").path;
        age(&path);
        sidecars.push((role, path));
    }
    World { rig, directory, handle, release, data, sidecars }
}

impl World {
    fn path(&self, role: &str) -> &str {
        self.sidecars.iter().find(|(name, _)| *name == role).map(|(_, path)| path.as_str()).expect("a role")
    }

    /// The compacted transcript: a summary naming `kept`.
    fn compaction(&self) -> Compaction {
        let summary = (ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": format!("the kept result is at {}", self.path("kept")) }));
        Compaction { replacement: vec![summary], at: 5, dropped_count: 1, dropped: None }
    }

    /// A completion the thread queues and is not woken by (`live: false`), naming `queued`; told once queued.
    async fn queue_naming_a_sidecar(&self) {
        let message = super::actor::Inbox::TaskNotification {
            surface: "agent".into(),
            task_id: "task_agent_1".into(),
            status: "completed".into(),
            text: format!("look at {}", self.path("queued")),
            origin: None,
            live: false,
        };
        within("the actor takes the message", self.handle.inbox.send(message)).await.expect("the actor runs");
        within("the message is queued", eventually_on!(&[&self.handle.cell.stepped], || (!self.handle.cell.queued.load().is_empty()).then_some(()))).await;
    }

    /// A completion that wakes the thread: its turn runs, until `release`.
    async fn start_turn(&self) {
        let message = super::actor::Inbox::TaskNotification {
            surface: "agent".into(),
            task_id: "task_agent_2".into(),
            status: "failed".into(),
            text: "failed".into(),
            origin: None,
            live: true,
        };
        within("the actor takes the message", self.handle.inbox.send(message)).await.expect("the actor runs");
        within("the turn starts", eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_some().then_some(()))).await;
    }

    /// The turn is let go and has ended.
    async fn end_turn(&self) {
        self.release.notify_one();
        within("the turn ends", eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_none().then_some(()))).await;
    }

    /// The listing step of the prune, after the compaction is durable, waits: `.0` tells it arrived, `.1` lets it go.
    fn hold_listing(&self) -> (Arc<Notify>, Arc<Notify>) {
        let (arrived, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        *lock(&self.rig.compaction.listing_gate) = Some((arrived.clone(), go.clone()));
        (arrived, go)
    }

    /// The batch of the compaction's header waits before it is durable: `.0` tells it arrived, `.1` lets it go.
    fn hold_durable(&self) -> (Arc<Notify>, std::sync::mpsc::Sender<()>) {
        let (release, held) = std::sync::mpsc::channel();
        let arrived = Arc::new(Notify::new());
        *lock(&self.rig.store.header_gate) = Some((arrived.clone(), held));
        (arrived, release)
    }

    fn header() -> CompactionHeader {
        let mut set = serde_json::Map::new();
        set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
        Box::new(move |_, _| HeaderChange { set, unset: Vec::new() })
    }

    /// The thread's tool-result directory, each file by its role (Node's `left`).
    #[allow(clippy::disallowed_methods, reason = "test reads the sidecar dir")]
    fn left(&self) -> Value {
        let dir = self.data.path().join("tool-results").join(mixdog_core_run::run_host::artifact::safe_segment(self.handle.id.as_str()));
        let role = |name: String| self.sidecars.iter().find(|(_, path)| path.ends_with(&name)).map_or(name.clone(), |(role, _)| (*role).to_owned());
        let mut left: Vec<String> = std::fs::read_dir(dir).expect("the sidecar dir").flatten().map(|entry| role(entry.file_name().to_string_lossy().into_owned())).collect();
        left.sort();
        json!(left)
    }

    /// `changed` of Node's case: the commit applied the compaction.
    fn changed(commit: CompactionCommit) -> Value {
        json!(commit == CompactionCommit::Applied)
    }
}

/// Node's case `name` of `fixtures/offload-prune-order/golden.json`.
fn node_case(name: &str) -> Value {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/offload-prune-order/golden.json")).expect("golden.json parses");
    golden["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no Node case {name}"))
}

/// Node's `queued-at-listing`: a message naming `queued` is queued while the prune lists the sidecars.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_while_the_sidecars_are_listed_keeps_the_sidecar_it_names() {
    let world = world().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), world.compaction(), None));
    // The compaction is durable and its prune lists the old sidecars; the session takes a message meanwhile.
    within("the prune lists the sidecars", async {
        tokio::select! {
            () = arrived.notified() => {}
            answered = &mut commit => panic!("answered before the prune listed: {answered:?}"),
        }
    })
    .await;
    world.queue_naming_a_sidecar().await;
    go.notify_one();
    let changed = World::changed(within("the commit answers", commit).await.expect("answered"));
    assert_eq!(json!({ "name": "queued-at-listing", "changed": changed, "left": world.left() }), node_case("queued-at-listing"));
}

/// A turn that starts while the sidecars are listed stops the prune: the core does not read a running turn's messages
/// (Node reads `session.liveTurnMessages`), so it leaves the prune to the next one of the idle session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_while_the_sidecars_are_listed_stops_the_prune() {
    let world = world().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), world.compaction(), None));
    within("the prune lists the sidecars", async {
        tokio::select! {
            () = arrived.notified() => {}
            answered = &mut commit => panic!("answered before the prune listed: {answered:?}"),
        }
    })
    .await;
    world.start_turn().await;
    go.notify_one();
    assert_eq!(within("the commit answers", commit).await.expect("answered"), CompactionCommit::Applied);
    assert_eq!(world.left(), json!(ROLES), "a session that is not idle is not pruned");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    world.end_turn().await;
}

/// Node's `turn-before-save`: a turn that started before the compaction was durable. The idle check comes first, so
/// nothing is listed; once the turn has ended, the next compaction's prune deletes what this one left.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_before_the_idle_check_is_not_listed_and_the_next_prune_deletes_what_it_left() {
    let world = world().await;
    let (durable_arrived, durable) = world.hold_durable();
    let (listed, _go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), world.compaction(), Some(World::header())));
    within("the compaction reaches the store", async {
        tokio::select! {
            () = durable_arrived.notified() => {}
            answered = &mut commit => panic!("answered before the compaction was durable: {answered:?}"),
        }
    })
    .await;
    world.start_turn().await;
    durable.send(()).expect("release");
    let answered = within("the commit answers", async {
        tokio::select! {
            () = listed.notified() => panic!("the sidecars of a session that is not idle were listed"),
            answered = &mut commit => answered,
        }
    })
    .await;
    let changed = World::changed(answered.expect("answered"));
    let after = world.left();
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    world.end_turn().await;
    *lock(&world.rig.compaction.listing_gate) = None;
    let next = within("the next commit answers", world.directory.commit_compaction(&world.handle.id, Vec::new(), world.compaction(), None)).await.expect("answered");
    let next_error = if next == CompactionCommit::Applied { Value::Null } else { json!(format!("{next:?}")) };
    let got = json!({ "name": "turn-before-save", "changed": changed, "left": after, "nextError": next_error, "afterNext": world.left() });
    assert_eq!(got, node_case("turn-before-save"));
}

/// Node's `queued-before-save`, the review's order: the snapshot is taken, a message naming an old sidecar is queued,
/// the compaction becomes durable, and the prune runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_before_the_compaction_is_durable_keeps_the_sidecar_it_names() {
    let world = world().await;
    let (arrived, release) = world.hold_durable();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, Vec::new(), world.compaction(), Some(World::header())));
    // The compaction's batch is at the store, not durable: its snapshot is taken.
    within("the compaction reaches the store", async {
        tokio::select! {
            () = arrived.notified() => {}
            answered = &mut commit => panic!("answered before the compaction was durable: {answered:?}"),
        }
    })
    .await;
    world.queue_naming_a_sidecar().await;
    release.send(()).expect("release");
    let changed = World::changed(within("the commit answers", commit).await.expect("answered"));
    assert_eq!(json!({ "name": "queued-before-save", "changed": changed, "left": world.left() }), node_case("queued-before-save"));
}
