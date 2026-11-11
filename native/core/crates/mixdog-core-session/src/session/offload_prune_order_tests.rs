//! `pruneCompactedOffloads` against Node's recording (`fixtures/offload-prune-order`, `record-offload-prune-order.mjs`,
//! Node with the prune-after-save fix): a stored session with three sidecars an hour old on the recording's clock
//! (`kept` the compacted transcript names, `queued` a queued message may name, `stray` only a dropped request names) is
//! compacted through the actor's commit (`commit_compaction`, the replacement being the transcript Node's compaction
//! adopted) while the session moves around the prune, or while the save of the compaction does not store it. At each
//! point Node observed, the session's tool-result directory (every file in listing order, its text) and its stored
//! transcript (the model context read back from the store) are compared whole, the data dir standing for `<DATA>`.
//!
//! Node's save outcomes and the core's: Node's save resolves dropped (a delete's fence) where the core's store refuses
//! the batch (nothing stored, the commit fails); Node's save is refused because another writer recorded after this copy
//! where the core's commit finds the conversation moved (a turn started after the plan: nothing written); Node's fsync
//! fails after the records were written where the core's barrier fails after its write. Either way nothing is pruned.
//!
//! Node's recorder marks a turn started without a message (`markSessionAskStart`); the core's turn records its input,
//! so the rows a turn appended after the compared transcript are checked to be that turn's and are not compared.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::Record;
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
use super::turn_ops::CompactionCommit;
use super::turn_ops::CompactionHeader;
use crate::eventually_on;

/// `wait`, failing with `what` when it has not ended within ten seconds.
async fn within<T>(what: &str, wait: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), wait).await.unwrap_or_else(|_| panic!("no answer within 10s: {what}"))
}

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/offload-prune-order/golden.json")).expect("golden.json parses")
}

/// Node's case `name`.
fn node_case(name: &str) -> Value {
    golden()["cases"].as_array().expect("cases").iter().find(|case| case["name"] == name).cloned().unwrap_or_else(|| panic!("no Node case {name}"))
}

/// The recorded session, stored in the core: its transcript, its sidecars aged as Node's, its turns waiting for `release`.
struct World {
    rig: Rig,
    directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    release: Arc<Notify>,
    data: tempfile::TempDir,
    case: Value,
    /// Each sidecar's role and path.
    sidecars: Vec<(String, String)>,
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup ages a fixture file to the recorded mtime")]
fn age(path: &str, mtime_ms: u64) {
    let file = std::fs::File::options().write(true).open(path).expect("the sidecar");
    file.set_modified(std::time::UNIX_EPOCH + Duration::from_millis(mtime_ms)).expect("aged");
}

/// A stored message row as a writer commits it.
fn item(index: usize, body: &Value) -> Record {
    let record = json!({
        "k": "item", "iid": format!("seed{index}"), "form": "message", "model": true, "visible": true,
        "role": body["role"], "refs": [], "body": { "inline": body },
    });
    serde_json::from_value(record).expect("item record")
}

async fn world(name: &str) -> World {
    let (golden, case) = (golden(), node_case(name));
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
    let id = ThreadId::from(case["seed"]["sessionId"].as_str().expect("session id"));
    let clock = golden["clockMs"].as_u64().expect("clock");
    *lock(&rig.compaction.offloads) = Some((data.path().to_path_buf(), clock));
    let store = offload_store(data.path(), &id);
    let mut sidecars = Vec::new();
    for sidecar in case["seed"]["sidecars"].as_array().expect("sidecars") {
        let path = within("the sidecar is written", store.persist(sidecar["content"].as_str().expect("content"))).await.expect("persisted").path;
        age(&path, golden["sidecarMtimeMs"].as_u64().expect("mtime"));
        sidecars.push((sidecar["role"].as_str().expect("role").to_owned(), path));
    }
    let creator = SessionDirectory::new(rig.deps());
    within("the session is created", creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
    let transcript = unmask(data.path(), &case["seed"]["transcript"]);
    rig.store.seed(&id, transcript.as_array().expect("transcript").iter().enumerate().map(|(index, body)| item(index, body)).collect());
    let directory = SessionDirectory::new(rig.deps());
    let handle = within("the session opens", directory.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
    World { rig, directory, handle, release, data, case, sidecars }
}

/// The recording's `<DATA>` named as this data dir.
fn unmask(data: &std::path::Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    serde_json::from_str(&serde_json::to_string(value).expect("json").replace("<DATA>", &escaped[1..escaped.len() - 1])).expect("unmasked")
}

/// This data dir named `<DATA>`, as the recording names Node's.
fn mask(data: &std::path::Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    serde_json::from_str(&serde_json::to_string(value).expect("json").replace(&escaped[1..escaped.len() - 1], "<DATA>")).expect("masked")
}

impl World {
    fn path(&self, role: &str) -> &str {
        self.sidecars.iter().find(|(name, _)| name == role).map(|(_, path)| path.as_str()).expect("a role")
    }

    /// The compaction Node adopted, committed as the host commits its compactor's output.
    fn compaction(&self) -> Compaction {
        let compacted = unmask(self.data.path(), &self.case["compacted"]);
        let replacement = compacted.as_array().expect("compacted").iter().enumerate().map(|(index, row)| (ItemId::from(format!("compacted{index}")), row.clone())).collect();
        Compaction { replacement, at: golden()["clockMs"].as_i64().expect("clock"), dropped_count: 0, dropped: None }
    }

    /// The context the compaction was planned on: its item ids.
    async fn snapshot(&self) -> Vec<ItemId> {
        within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context").into_iter().map(|(iid, _)| iid).collect()
    }

    fn header() -> CompactionHeader {
        let mut set = serde_json::Map::new();
        set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
        Box::new(move |_, _| HeaderChange { set, unset: Vec::new() })
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

    /// The listing step of the prune waits: `.0` tells it arrived, `.1` lets it go.
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

    /// What is on disk now, as Node's `point`: the tool-result directory in listing order with each file's text, and the
    /// stored transcript. `turn_rows`: rows a core turn appended after the transcript Node holds, checked and left out.
    #[allow(clippy::disallowed_methods, reason = "test reads the sidecar dir")]
    async fn point(&self, at: &str, turn_rows: bool) -> Value {
        let dir = self.data.path().join("tool-results").join(mixdog_core_run::run_host::artifact::safe_segment(self.handle.id.as_str()));
        let tool_results: Vec<Value> = std::fs::read_dir(dir)
            .expect("the sidecar dir")
            .map(|entry| {
                let entry = entry.expect("an entry");
                json!([entry.file_name().to_string_lossy(), std::fs::read_to_string(entry.path()).expect("a sidecar")])
            })
            .collect();
        let rows = within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context");
        let mut transcript: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
        if turn_rows {
            let node = self.case["points"].as_array().expect("points").iter().find(|point| point["at"] == at).expect("Node's point")["transcript"].as_array().expect("transcript").len();
            let appended = transcript.split_off(node.min(transcript.len()));
            assert!(appended.iter().all(|row| row["role"] == "user" || row["role"] == "assistant"), "only the turn's rows follow: {appended:?}");
        }
        json!({ "at": at, "toolResults": mask(self.data.path(), &json!(tool_results)), "transcript": mask(self.data.path(), &json!(transcript)) })
    }

    /// Node's case with the core's answer and points in place of Node's.
    fn got(&self, changed: Value, error: Value, points: Vec<Value>) -> Value {
        let mut got = self.case.clone();
        got["changed"] = changed;
        got["error"] = error;
        got["points"] = json!(points);
        got
    }

    /// The deferred prune of an ended turn has run.
    async fn pruned_once(&self) {
        within("the deferred prune runs", eventually_on!(&[&self.handle.cell.stepped], || (lock(&self.rig.compaction.pruned).len() == 1).then_some(()))).await;
    }
}

/// `commit` once `arrived` told it is held, failing if it answered first.
async fn held<F: Future + Unpin>(what: &str, arrived: &Notify, commit: &mut F)
where
    F::Output: std::fmt::Debug,
{
    within(what, async {
        tokio::select! {
            () = arrived.notified() => {}
            answered = commit => panic!("answered before it was held: {answered:?}"),
        }
    })
    .await;
}

/// Node's `queued-at-listing`: a message naming `queued` is queued while the prune lists the sidecars.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_while_the_sidecars_are_listed_keeps_the_sidecar_it_names() {
    let world = world("queued-at-listing").await;
    let snapshot = world.snapshot().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header())));
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.queue_naming_a_sidecar().await;
    go.notify_one();
    assert_eq!(within("the commit answers", commit).await.expect("answered"), CompactionCommit::Applied);
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![point]), world.case);
}

/// Node's `turn-before-save`: a turn that started before the compaction was durable stops its prune; once the turn has
/// ended the prune runs, with no second compaction.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_before_the_save_defers_the_prune_to_its_end() {
    let world = world("turn-before-save").await;
    let snapshot = world.snapshot().await;
    let (arrived, durable) = world.hold_durable();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header())));
    held("the compaction reaches the store", &arrived, &mut commit).await;
    world.start_turn().await;
    durable.send(()).expect("release");
    assert_eq!(within("the commit answers", commit).await.expect("answered"), CompactionCommit::Applied);
    let after_commit = world.point("after-commit", true).await;
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
    world.end_turn().await;
    world.pruned_once().await;
    let after_turn_end = world.point("after-turn-end", true).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_turn_end]), world.case);
}

/// Node's `queued-before-save`: the snapshot is taken, a message naming an old sidecar is queued, the compaction becomes
/// durable, and the prune runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_before_the_compaction_is_durable_keeps_the_sidecar_it_names() {
    let world = world("queued-before-save").await;
    let snapshot = world.snapshot().await;
    let (arrived, release) = world.hold_durable();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header())));
    held("the compaction reaches the store", &arrived, &mut commit).await;
    world.queue_naming_a_sidecar().await;
    release.send(()).expect("release");
    assert_eq!(within("the commit answers", commit).await.expect("answered"), CompactionCommit::Applied);
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![point]), world.case);
}

/// Node's `dropped` (a save that resolves without storing): the store refuses the compaction's batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_the_store_refused_prunes_nothing() {
    let world = world("dropped").await;
    let snapshot = world.snapshot().await;
    world.rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let answer = within("the commit answers", world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header()))).await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `superseded` (a save another writer's record overtook): the conversation moved after the plan, as a turn that
/// started after it; nothing is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_the_conversation_moved_past_prunes_nothing() {
    let world = world("superseded").await;
    let snapshot = world.snapshot().await;
    world.start_turn().await;
    let answer = within("the commit answers", world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header()))).await;
    assert_eq!(answer.expect("answered"), CompactionCommit::Moved);
    let point = world.point("after-commit", true).await;
    world.end_turn().await;
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `thrown` (the save's fsync failed after its records were written): the barrier fails after its write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_whose_barrier_failed_after_its_write_prunes_nothing() {
    let world = world("thrown").await;
    let snapshot = world.snapshot().await;
    world.rig.store.fail_after_write.store(true, std::sync::atomic::Ordering::SeqCst);
    let answer = within("the commit answers", world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header()))).await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// A turn that starts while the sidecars are listed stops the prune: the core does not read a running turn's messages
/// (Node reads `session.liveTurnMessages`); the prune runs once that turn has ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_while_the_sidecars_are_listed_defers_the_prune_to_its_end() {
    let world = world("queued-at-listing").await;
    let snapshot = world.snapshot().await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.directory.commit_compaction(&world.handle.id, snapshot, world.compaction(), Some(World::header())));
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.start_turn().await;
    go.notify_one();
    assert_eq!(within("the commit answers", commit).await.expect("answered"), CompactionCommit::Applied);
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
    world.end_turn().await;
    world.pruned_once().await;
}
