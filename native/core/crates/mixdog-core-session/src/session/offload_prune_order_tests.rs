//! `pruneCompactedOffloads` against Node's recording (`fixtures/offload-prune-order`, `record-offload-prune-order.mjs`,
//! Node with the prune-after-save fix): a stored session with three sidecars an hour old on the recording's clock
//! (`kept` the compacted transcript names, `queued` a queued message may name, `stray` only a dropped request names) is
//! compacted through the actor's commit (`commit_compaction`, the replacement being the transcript Node's compaction
//! adopted; `auto-clear` through `thread/compact/start` with `requireReduction`, whose engine commits through the
//! directory as the host's does) while the session moves around the prune, or while the save of the compaction does
//! not store it. At each point Node observed, the session's tool-result directory (every file in listing order, its
//! text, the pending prune's marker included) and its stored transcript (the model context read back from the store)
//! are compared whole, the data dir standing for `<DATA>`.
//!
//! The session is driven as Node's recorder drives it. Node marks a turn with its ask markers (`markSessionAskStart`
//! once the compaction is adopted, before its save; `markSessionDone` / `markSessionCancelled` / `markSessionError`
//! for its end): the core marks it in the store's hook as the compaction's batch reaches it (`MemStore::on_compaction`,
//! `ControlCell::ask_marked`) and ends it with `Inbox::AskEnded`, which runs what every turn's end runs for the prune
//! (`run_deferred_prune`, for any outcome). Neither side writes turn rows. Node closes the session without a tombstone
//! (an exit's close) where the core shuts its directory down (`shutdown_for`, the exit close); Node's resume is the
//! core's open of the thread by a new directory, as is the open after a stopped process (the old actor is abandoned,
//! its turn never ending). Node's turn storing a transcript that names `stray` again is the core's store taking that
//! row (`MemStore::seed`, as another writer commits it).
//!
//! Node's save outcomes and the core's: Node's save resolves dropped (a delete's fence) where the core's store refuses
//! the batch (nothing stored, the commit fails); Node's save is refused because another writer recorded after this copy
//! where the core's commit finds the session in a turn (nothing written); Node's fsync fails after the records were
//! written where the core's barrier fails after its write. Either way nothing is pruned.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::SessionHandle;
use super::actor::Inbox;
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
    directory: Arc<SessionDirectory>,
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
fn item(iid: String, body: &Value) -> Record {
    let record = json!({
        "k": "item", "iid": iid, "form": "message", "model": true, "visible": true,
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
    rig.store.seed(&id, transcript.as_array().expect("transcript").iter().enumerate().map(|(index, body)| item(format!("seed{index}"), body)).collect());
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = within("the session opens", directory.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
    World { rig, directory, handle, release, data, case, sidecars }
}

/// The recording's `<DATA>` named as this data dir.
fn unmask(data: &Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    serde_json::from_str(&serde_json::to_string(value).expect("json").replace("<DATA>", &escaped[1..escaped.len() - 1])).expect("unmasked")
}

/// This data dir named `<DATA>`, as the recording names Node's.
fn mask(data: &Path, value: &Value) -> Value {
    let escaped = serde_json::to_string(&data.to_string_lossy()).expect("path");
    serde_json::from_str(&serde_json::to_string(value).expect("json").replace(&escaped[1..escaped.len() - 1], "<DATA>")).expect("masked")
}

/// The compaction Node adopted, committed as the host commits its compactor's output.
fn compaction_of(data: &Path, case: &Value) -> Compaction {
    let compacted = unmask(data, &case["compacted"]);
    let replacement = compacted.as_array().expect("compacted").iter().enumerate().map(|(index, row)| (ItemId::from(format!("compacted{index}")), row.clone())).collect();
    Compaction { replacement, at: golden()["clockMs"].as_i64().expect("clock"), dropped_count: 0, dropped: None }
}

fn header() -> CompactionHeader {
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    Box::new(move |_, _| HeaderChange { set, unset: Vec::new() })
}

/// A completion the thread queues and is not woken by (`live: false`), naming `path`.
fn queued_completion(path: &str) -> Inbox {
    Inbox::TaskNotification { surface: "agent".into(), task_id: "task_agent_1".into(), status: "completed".into(), text: format!("look at {path}"), origin: None, live: false }
}

impl World {
    fn path(&self, role: &str) -> &str {
        self.sidecars.iter().find(|(name, _)| name == role).map(|(_, path)| path.as_str()).expect("a role")
    }

    /// The context the compaction was planned on: its item ids.
    async fn snapshot(&self) -> Vec<ItemId> {
        within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context").into_iter().map(|(iid, _)| iid).collect()
    }

    /// The compaction Node adopted, committed on the context it was planned on.
    async fn commit(&self) -> Result<CompactionCommit, mixdog_core_api::CoreError> {
        let snapshot = self.snapshot().await;
        within("the commit answers", self.directory.commit_compaction(&self.handle.id, snapshot, compaction_of(self.data.path(), &self.case), Some(header()))).await
    }

    /// Node's `markSessionAskStart` once the compaction is adopted, before its save: the store's hook marks the turn
    /// as the compaction's batch reaches it.
    fn turn_at_save(&self) {
        let cell = self.handle.cell.clone();
        *lock(&self.rig.store.on_compaction) = Some(Box::new(move || cell.ask_marked.store(true, std::sync::atomic::Ordering::SeqCst)));
    }

    /// The marked turn ends (`handle`'s), and the prune it stopped has run (the `pruned`-th).
    async fn end_marked_turn(&self, pruned: usize) {
        within("the actor takes the turn's end", self.handle.inbox.send(Inbox::AskEnded)).await.expect("the actor runs");
        self.pruned(&self.handle, pruned).await;
    }

    /// `handle`'s actor has run the `count`-th prune.
    async fn pruned(&self, handle: &SessionHandle, count: usize) {
        within("the prune runs", eventually_on!(&[&handle.cell.stepped], || (lock(&self.rig.compaction.pruned).len() == count).then_some(()))).await;
    }

    /// A completion naming `queued`; told once queued.
    async fn queue_naming_a_sidecar(&self) {
        within("the actor takes the message", self.handle.inbox.send(queued_completion(self.path("queued")))).await.expect("the actor runs");
        self.queued().await;
    }

    async fn queued(&self) {
        within("the message is queued", eventually_on!(&[&self.handle.cell.stepped], || (!self.handle.cell.queued.load().is_empty()).then_some(()))).await;
    }

    /// A completion that wakes the thread: its turn runs, until `release`.
    async fn start_turn(&self) {
        let message = Inbox::TaskNotification { surface: "agent".into(), task_id: "task_agent_2".into(), status: "failed".into(), text: "failed".into(), origin: None, live: true };
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

    /// The thread opened by a new directory over the same store and data dir (Node's `resumeSession`), and the prune left
    /// pending has run there.
    async fn reopened(&self) -> (SessionDirectory, Arc<SessionHandle>) {
        let directory = SessionDirectory::new(self.rig.deps());
        let handle = within("the session opens again", directory.open_handle(&self.handle.id, &CallContext::internal("test"))).await.expect("open");
        self.pruned(&handle, 1).await;
        (directory, handle)
    }

    /// What is on disk now, as Node's `point`: the tool-result directory in listing order with each file's text, and the
    /// stored transcript.
    #[allow(clippy::disallowed_methods, reason = "test reads the sidecar dir")]
    async fn point(&self, at: &str) -> Value {
        let dir = self.data.path().join("tool-results").join(mixdog_core_run::run_host::artifact::safe_segment(self.handle.id.as_str()));
        let tool_results: Vec<Value> = std::fs::read_dir(dir)
            .expect("the sidecar dir")
            .map(|entry| {
                let entry = entry.expect("an entry");
                json!([entry.file_name().to_string_lossy(), std::fs::read_to_string(entry.path()).expect("a sidecar")])
            })
            .collect();
        let rows = within("the context is read", self.directory.model_context(&self.handle.id).read()).await.expect("context");
        let transcript: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
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

    /// The compaction committed under a turn marked at its save: applied, and its prune left pending.
    async fn commit_under_a_turn(&self) -> Value {
        self.turn_at_save();
        assert_eq!(self.commit().await.expect("answered"), CompactionCommit::Applied);
        assert!(lock(&self.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
        self.point("after-commit").await
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
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.commit());
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.queue_naming_a_sidecar().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    let point = world.point("after-commit").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![point]), world.case);
}

/// Node's `queued-before-save`: the message naming `queued` is sent as the compaction's batch reaches the store, before
/// it is durable; the prune's listing waits until it is queued.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_before_the_compaction_is_durable_keeps_the_sidecar_it_names() {
    let world = world("queued-before-save").await;
    let inbox = world.handle.inbox.clone();
    let message = queued_completion(world.path("queued"));
    *lock(&world.rig.store.on_compaction) = Some(Box::new(move || inbox.try_send(message).map_err(|_| ()).expect("the actor takes the message")));
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.commit());
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.queued().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    let point = world.point("after-commit").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![point]), world.case);
}

/// Node's `turn-before-save`, `cancelled-turn` and `failed-turn`: a turn that started before the compaction was
/// durable leaves its prune pending; once the turn has ended (whatever its outcome: the core's end runs the same
/// prune for each) the prune runs, with no second compaction.
async fn turn_ends(name: &str) {
    let world = world(name).await;
    let after_commit = world.commit_under_a_turn().await;
    world.end_marked_turn(1).await;
    let after_turn_end = world.point("after-turn-end").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_turn_end]), world.case);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_before_the_save_defers_the_prune_to_its_end() {
    turn_ends("turn-before-save").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_turn_that_stopped_the_prune_lets_it_run_when_it_ends() {
    turn_ends("cancelled-turn").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_turn_that_stopped_the_prune_lets_it_run_when_it_ends() {
    turn_ends("failed-turn").await;
}

/// Node's `closed-before-turn-end`: the session closes (an exit's close) before the turn that stopped the prune
/// ends; nothing is pruned at the close, and the pending prune runs when the thread is next opened.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_closed_before_the_turn_ends_is_pruned_when_it_is_next_opened() {
    let world = world("closed-before-turn-end").await;
    let after_commit = world.commit_under_a_turn().await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let after_close = world.point("after-close").await;
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a closing session is not pruned");
    let _reopened = world.reopened().await;
    let after_resume = world.point("after-resume").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_close, after_resume]), world.case);
}

/// Node's `process-stopped`: the process stops before the turn that stopped the prune ends (its actor is abandoned);
/// the pending prune runs when the thread is opened again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_stopped_before_the_turn_ends_leaves_the_prune_to_the_next_open() {
    let world = world("process-stopped").await;
    let mut after_stop = world.commit_under_a_turn().await;
    after_stop["at"] = json!("after-stop");
    let _reopened = world.reopened().await;
    let after_resume = world.point("after-resume").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_stop, after_resume]), world.case);
}

/// Node's `re-referenced`: before the turn that stopped the prune ends, the stored transcript names `stray` again;
/// the prune reads the references stored when it deletes and keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sidecar_the_stored_transcript_names_again_before_the_prune_runs_is_kept() {
    let world = world("re-referenced").await;
    let after_commit = world.commit_under_a_turn().await;
    let named = world.case["points"][1]["transcript"].as_array().and_then(|rows| rows.last()).cloned().expect("the row naming stray");
    world.rig.store.seed(&world.handle.id, vec![item("later0".into(), &unmask(world.data.path(), &named))]);
    let after_reference = world.point("after-reference").await;
    world.end_marked_turn(1).await;
    let after_turn_end = world.point("after-turn-end").await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_reference, after_turn_end]), world.case);
}

/// Node's `auto-clear`: the automatic compaction (`thread/compact/start` with `requireReduction`, the idle auto-clear's)
/// commits through the directory and prunes once its result is durable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_automatic_compaction_prunes_once_its_result_is_durable() {
    let world = world("auto-clear").await;
    let (directory, data, case) = (Arc::downgrade(&world.directory), world.data.path().to_path_buf(), world.case.clone());
    *lock(&world.rig.compaction.commits) = Some(Arc::new(move |thread| {
        let (directory, compaction) = (directory.clone(), compaction_of(&data, &case));
        Box::pin(async move {
            let directory = directory.upgrade().expect("the directory");
            let snapshot = directory.model_context(&thread).read().await?.into_iter().map(|(iid, _)| iid).collect();
            let applied = directory.commit_compaction(&thread, snapshot, compaction, Some(header())).await? == CompactionCommit::Applied;
            Ok(Some(json!({ "changed": applied })))
        })
    }));
    let request = CoreRequest {
        method: Method("thread/compact/start"),
        params: json!({ "threadId": world.handle.id, "opId": "op-auto", "options": { "requireReduction": true } }),
        op: Some(OpId::from("op-auto")),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    };
    let Reply::Value(answer) = within("the compaction answers", world.handle.request(request)).await.expect("answered") else {
        panic!("a value reply");
    };
    assert_eq!(lock(&world.rig.compaction.calls).first().map(String::as_str), Some("compact auto_clear true"), "the automatic compaction");
    let point = world.point("after-commit").await;
    assert_eq!(world.got(answer["changed"].clone(), Value::Null, vec![point]), world.case);
}

/// Node's `dropped` (a save that resolves without storing): the store refuses the compaction's batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_the_store_refused_prunes_nothing() {
    let world = world("dropped").await;
    world.rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let answer = world.commit().await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit").await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `superseded` (a save another writer's record overtook): the session is in a turn when the commit comes;
/// nothing is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_refused_for_a_turn_prunes_nothing() {
    let world = world("superseded").await;
    world.handle.cell.ask_marked.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(world.commit().await.expect("answered"), CompactionCommit::Moved);
    let point = world.point("after-commit").await;
    within("the actor takes the turn's end", world.handle.inbox.send(Inbox::AskEnded)).await.expect("the actor runs");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `thrown` (the save's fsync failed after its records were written): the barrier fails after its write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_whose_barrier_failed_after_its_write_prunes_nothing() {
    let world = world("thrown").await;
    world.rig.store.fail_after_write.store(true, std::sync::atomic::Ordering::SeqCst);
    let answer = world.commit().await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit").await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// A real turn that starts while the sidecars are listed stops the prune: the core does not read a running turn's
/// messages (Node reads `session.liveTurnMessages`); the prune runs once that turn has ended. Core-only: no recording.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_while_the_sidecars_are_listed_defers_the_prune_to_its_end() {
    let world = world("queued-at-listing").await;
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.commit());
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.start_turn().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
    world.end_turn().await;
    world.pruned(&world.handle, 1).await;
}
