//! `pruneCompactedOffloads` against Node's recording (`fixtures/offload-prune-order`, `record-offload-prune-order.mjs`,
//! Node with the prune-after-save fix): a stored session with three sidecars an hour old on the recording's clock
//! (`kept` the compacted transcript names, `queued` a queued message may name, `stray` only a dropped request names) is
//! compacted through the actor's commit (`commit_compaction`, the replacement being the transcript Node's compaction
//! adopted; `auto-clear` through `thread/compact/start` with `requireReduction`, whose engine commits through the
//! directory as the host's does) while the session moves around the prune, or while the save of the compaction does
//! not store it; sessions that do not compact (`unreadable-archive`, `nothing-to-prune`) are opened. At each point Node
//! observed, the session's tool-result directory and its stored transcript are compared whole
//! (`testing::offload_replay`). `cancelled-turn` and `failed-turn` run a real turn through the host's run factory and
//! are replayed there (`mixdog-core`, `run_host/offload_prune_turn_tests.rs`).
//!
//! Every open of a thread reconciles its tool-result directory with what is stored (`reconcile_offloads`, Node's
//! `reconcileOffloadsOnResume`). Node's recorder compacts a session it stored without resuming it: the core opens the
//! recorded session before its sidecars exist, so those opens list nothing (`TestCompaction::listings` tells when they
//! have listed). Node's resume is the core's open of the thread by a new directory, as is the open after a stopped
//! process (the old actor is abandoned, its prune or turn never ending).
//!
//! The session is driven as Node's recorder drives it. Node marks a turn with its ask markers (`markSessionAskStart`
//! once the compaction is adopted, before its save; `markSessionDone` for its end): the core marks it in the store's
//! hook as the compaction's batch reaches it (`MemStore::on_compaction`, `ControlCell::ask_marked`) and ends it with
//! `Inbox::AskEnded`; neither side writes turn rows. Node closes the session without a tombstone (an exit's close)
//! where the core shuts its directory down (`shutdown_for`, the exit close). Node's turn storing a transcript that
//! names `stray` again is the core's store taking that row (`MemStore::seed`, as another writer commits it).
//!
//! Node's save outcomes and the core's: Node's save resolves dropped (a delete's fence) where the core's store refuses
//! the batch (nothing stored, the commit fails); another writer appends a record to the session's log after its last
//! one before the save on both sides (the core's over its real thread store), and Node's save is refused where the
//! core's log writer finds its file grown past what it wrote (nothing of the batch applied); Node's fsync fails after
//! the records were written where the core's barrier fails after its write. Either way nothing is pruned. The ask
//! markers drive the cases where Node's recorder itself only marks the session busy (`turn-before-save`,
//! `closed-before-turn-end`, `process-stopped`, `re-referenced`).
//!
//! `clear-fork`, `heir-fork`, `older-fork`, `unreadable-fork`, `linkless-fork`, `deleted-middle`, `copy-in-progress`,
//! `system-named`, `room-row` and `owner-let-go` are sessions Node's recorder does not compact: the copies of a
//! conversation in other sessions keep the sidecars they name (found from their own reference set in the catalog, which
//! names every session whose sidecars they may name, so a copy whose source was deleted counts; a session Node as
//! shipped made holds the set its transcript names, as the migration stores it), a copy still being made keeps its
//! source whole, a session the store cannot read keeps everything, a system prompt naming a sidecar keeps it, a room
//! log's text keeps nothing, and a session let go while its reconcile runs is left to its next owner. Node's sessions
//! are stored as the migration stores them (`offload_replay::migrated`: the system prompt in the header's prompt
//! blocks); the sessions Node as shipped made and the room log's row are stored in the core as recorded.

use std::future::Future;
use std::sync::Arc;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_protocol::TurnError;
use mixdog_rt::CancellationToken;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::SessionHandle;
use super::actor::Inbox;
use super::seams::RunOutcome;
use super::seams::ThreadStore;
use super::testing::Rig;
use super::testing::lock;
use super::testing::offload_replay::World;
use super::testing::offload_replay::compaction_of;
use super::testing::offload_replay::header;
use super::testing::offload_replay::item;
use super::testing::offload_replay::migrated;
use super::testing::offload_replay::unmask;
use super::testing::offload_replay::within;
use super::testing::offload_store;
use super::turn_ops::CompactionCommit;
use crate::eventually_on;

async fn world(name: &str) -> World {
    World::new(name, mixdog_testkit::fixture!("../../fixtures/offload-prune-order/golden.json"), Rig::new(), Rig::deps).await
}

/// A completion the thread queues and is not woken by (`live: false`), naming `path`.
fn queued_completion(path: &str) -> Inbox {
    Inbox::TaskNotification { surface: "agent".into(), task_id: "task_agent_1".into(), status: "completed".into(), text: format!("look at {path}"), origin: None, live: false }
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: Some(OpId::from(op)), ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()) }
}

/// The replay's session-only steps.
impl World {
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
        within("the prune runs", eventually_on!(&[&handle.cell.stepped], || (lock(&self.rig.compaction.pruned).len() >= count).then_some(()))).await;
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

    /// The listing step of the prune waits: `.0` tells it arrived, `.1` lets it go.
    fn hold_listing(&self) -> (Arc<Notify>, Arc<Notify>) {
        let (arrived, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
        *lock(&self.rig.compaction.listing_gate) = Some((arrived.clone(), go.clone()));
        (arrived, go)
    }

    /// The thread opened by a new directory over the same store and data dir (Node's `resumeSession`), and its
    /// reconcile has run (the `pruned`-th prune).
    async fn reopened(&self, pruned: usize) -> (SessionDirectory, Arc<SessionHandle>) {
        let directory = SessionDirectory::new(self.rig.deps());
        let handle = within("the session opens again", directory.open_handle(&self.handle.id, &CallContext::internal("test"))).await.expect("open");
        self.pruned(&handle, pruned).await;
        (directory, handle)
    }

    /// The compaction committed under a turn marked at its save: applied, and its prune left to the turn's end.
    async fn commit_under_a_turn(&self) -> Value {
        self.turn_at_save();
        assert_eq!(self.commit().await.expect("answered"), CompactionCommit::Applied);
        assert!(lock(&self.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
        self.point("after-commit", false).await
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
    let point = world.point("after-commit", false).await;
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
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![point]), world.case);
}

/// Node's `turn-before-save`: a turn that started before the compaction was durable leaves its prune to the turn's
/// end; once the turn has ended the prune runs, with no second compaction.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_before_the_save_defers_the_prune_to_its_end() {
    let world = world("turn-before-save").await;
    let after_commit = world.commit_under_a_turn().await;
    world.end_marked_turn(1).await;
    let after_turn_end = world.point("after-turn-end", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_turn_end]), world.case);
}

/// A real turn that starts while the sidecars are listed stops the prune: the core does not read a running turn's
/// messages (Node reads `session.liveTurnMessages`); the prune runs at that turn's own end, whether it completed, was
/// cancelled or failed. Core-only: Node's turn claims a session only once a compaction's save has landed, after the
/// prune began.
async fn listed_under_a_real_turn(outcome: RunOutcome) {
    let world = world("queued-at-listing").await;
    let release = world.release.clone();
    world.rig.set_script(Arc::new(move |run| {
        let (release, outcome) = (release.clone(), outcome.clone());
        Box::pin(async move {
            within("the turn's input is durable", run.port.input_durable()).await.expect("input durable");
            within("the test releases the turn", release.notified()).await;
            outcome
        })
    }));
    let (arrived, go) = world.hold_listing();
    let mut commit = Box::pin(world.commit());
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    world.start_turn().await;
    go.notify_one();
    assert_eq!(commit.await.expect("answered"), CompactionCommit::Applied);
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a session that is not idle is not pruned");
    world.release.notify_one();
    world.ended().await;
    world.pruned(&world.handle, 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_started_while_the_sidecars_are_listed_defers_the_prune_to_its_end() {
    listed_under_a_real_turn(RunOutcome::Completed(Default::default())).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_turn_started_while_the_sidecars_are_listed_runs_the_prune_at_its_end() {
    listed_under_a_real_turn(RunOutcome::Failed(TurnError { message: "the provider failed".into(), data: json!({}), provider_error: None })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interrupted_turn_started_while_the_sidecars_are_listed_runs_the_prune_at_its_end() {
    listed_under_a_real_turn(RunOutcome::Interrupted).await;
}

/// Node's `closed-before-turn-end`: the session closes (an exit's close) before the turn that stopped the prune
/// ends; nothing is pruned at the close, and the next open reconciles the directory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_closed_before_the_turn_ends_is_pruned_when_it_is_next_opened() {
    let world = world("closed-before-turn-end").await;
    let after_commit = world.commit_under_a_turn().await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let after_close = world.point("after-close", false).await;
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a closing session is not pruned");
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_close, after_resume]), world.case);
}

/// Node's `process-stopped`: the process stops before the turn that stopped the prune ends (its actor is abandoned);
/// the next open reconciles the directory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_stopped_before_the_turn_ends_leaves_the_prune_to_the_next_open() {
    let world = world("process-stopped").await;
    let mut after_stop = world.commit_under_a_turn().await;
    after_stop["at"] = json!("after-stop");
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_stop, after_resume]), world.case);
}

/// Node's `saved-then-stopped`: the process stops once the compaction is durable, before its prune lists anything (the
/// listing is held and never let go); nothing remembers the prune, and the next open reconciles the directory.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_process_stopped_between_the_save_and_the_prune_is_pruned_at_the_next_open() {
    let world = world("saved-then-stopped").await;
    let (arrived, _never) = world.hold_listing();
    let mut commit = Box::pin(world.commit());
    held("the prune lists the sidecars", &arrived, &mut commit).await;
    let after_stop = world.point("after-stop", false).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_stop, after_resume]), world.case);
}

/// Node's `unreadable-archive`: the session is opened while the archive its transcript names cannot be read (a
/// directory in its place): nothing is deleted; it is closed, the archive is put back, and the next open prunes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "test replaces the archive as Node's recorder does")]
async fn an_archive_unreadable_at_one_open_is_read_at_the_next_and_the_prune_completes() {
    let world = world("unreadable-archive").await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let archive = world.path("archive").to_owned();
    let content = std::fs::read_to_string(&archive).expect("the archive");
    std::fs::remove_file(&archive).expect("removed");
    std::fs::create_dir(&archive).expect("a directory in its place");
    let (first, _) = world.reopened(1).await;
    let unreadable = world.point("after-unreadable-resume", false).await;
    within("the directory shuts down", first.shutdown_for("test close")).await;
    std::fs::remove_dir(&archive).expect("the directory goes");
    let store = offload_store(world.data.path(), &world.handle.id);
    within("the archive is written", store.persist(&content)).await.expect("persisted");
    let _second = world.reopened(2).await;
    let readable = world.point("after-readable-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![unreadable, readable]), world.case);
}

/// Node's `nothing-to-prune`: an open whose transcript names its old sidecar and whose other sidecar is young deletes
/// and writes nothing: every file is there with its mtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_open_with_nothing_to_prune_deletes_and_writes_nothing() {
    let world = world("nothing-to-prune").await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let before = world.point("before-resume", true).await;
    let _reopened = world.reopened(1).await;
    let after = world.point("after-resume", true).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![before, after]), world.case);
}

/// Node's `re-referenced`: before the turn that stopped the prune ends, the stored transcript names `stray` again;
/// the prune reads the references stored when it deletes and keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sidecar_the_stored_transcript_names_again_before_the_prune_runs_is_kept() {
    let world = world("re-referenced").await;
    let after_commit = world.commit_under_a_turn().await;
    let named = world.case["points"][1]["transcript"].as_array().and_then(|rows| rows.last()).cloned().expect("the row naming stray");
    world.rig.store.seed(&world.handle.id, vec![item("later0".into(), &unmask(world.data.path(), &named))]);
    let after_reference = world.point("after-reference", false).await;
    world.end_marked_turn(1).await;
    let after_turn_end = world.point("after-turn-end", false).await;
    assert_eq!(world.got(json!(true), Value::Null, vec![after_commit, after_reference, after_turn_end]), world.case);
}

/// Node's `auto-clear`: the automatic compaction (`thread/compact/start` with `requireReduction`, the idle auto-clear's)
/// commits through the directory and prunes once its result is durable.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_automatic_compaction_prunes_once_its_result_is_durable() {
    let world = world("auto-clear").await;
    let (directory, data, case, clock) = (Arc::downgrade(&world.directory), world.data.path().to_path_buf(), world.case.clone(), world.clock_ms);
    *lock(&world.rig.compaction.commits) = Some(Arc::new(move |thread| {
        let (directory, compaction) = (directory.clone(), compaction_of(&data, &case, clock));
        Box::pin(async move {
            let directory = directory.upgrade().expect("the directory");
            let snapshot = directory.model_context(&thread).read().await?.into_iter().map(|(iid, _)| iid).collect();
            let applied = directory.commit_compaction(&thread, snapshot, compaction, Some(header())).await? == CompactionCommit::Applied;
            Ok(Some(json!({ "changed": applied })))
        })
    }));
    let params = json!({ "threadId": world.handle.id, "opId": "op-auto", "options": { "requireReduction": true } });
    let Reply::Value(answer) = within("the compaction answers", world.handle.request(request("thread/compact/start", params, "op-auto"))).await.expect("answered") else {
        panic!("a value reply");
    };
    assert_eq!(lock(&world.rig.compaction.calls).first().map(String::as_str), Some("compact auto_clear true"), "the automatic compaction");
    let point = world.point("after-commit", false).await;
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
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `superseded`: another writer appends a record (a header patch setting `status`) to the session's log after
/// its last frame, once the compaction is adopted and before its save. Over the real thread store: the save's
/// barrier finds the log grown past what its writer wrote (`LogWriter::alone`) and writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "the foreign writer appends to the session's log file")]
async fn a_compaction_another_writer_overtook_prunes_nothing() {
    let data = tempfile::tempdir().expect("data dir");
    let store = super::tests::real_store(data.path()).await;
    let fixture = mixdog_testkit::fixture!("../../fixtures/offload-prune-order/golden.json");
    let world = World::through_session("superseded", fixture, Rig::new(), move |rig| rig.deps_on(store.clone()), data).await;
    let log = world.data.path().join("sessions").join(world.handle.id.as_str()).join(mixdog_store::log::log_name(0));
    let bytes = std::fs::read(&log).expect("the session's log");
    let last = mixdog_store::framing::scan(&bytes, 0, 0, 0).frames.last().map(|frame| frame.ordinal).expect("a frame");
    let foreign: Record = serde_json::from_value(json!({ "k": "meta", "change": { "inline": { "set": { "status": "error" }, "unset": [] } } })).expect("meta record");
    let mut frame = Vec::new();
    mixdog_store::framing::encode_into(&mut frame, last + 1, &serde_json::to_vec(&foreign).expect("payload"));
    std::fs::OpenOptions::new().append(true).open(&log).and_then(|mut file| std::io::Write::write_all(&mut file, &frame)).expect("the foreign record is appended");
    let answer = world.commit().await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}

/// Node's `clear-fork`: an agent home's fresh start (`clearSessionMessages` with `archiveAs`; the host's `thread/fork`
/// into the archive id, then `thread/clear`, `agent_home_deps.rs`). The fork holds the conversation, which names
/// `named`; the cleared session is closed and opened again: its reconcile keeps what the fork names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_clear_fork_keeps_the_sidecars_it_names_when_the_cleared_session_is_opened() {
    let world = world("clear-fork").await;
    let (id, fork) = (world.handle.id.as_str().to_owned(), world.case["seed"]["forkId"].as_str().expect("the fork id").to_owned());
    let forked = json!({ "threadId": id, "opId": "op-fork", "intoThreadId": fork });
    within("the fork answers", world.handle.request(request("thread/fork", forked, "op-fork"))).await.expect("thread/fork");
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// Node's `heir-fork`: a new session inherits the conversation (`thread/fork`, the desktop's `inheritSession`); the heir
/// is cleared with a fork (`thread/fork` into the fork's id, then `thread/clear`) and the source without one. The
/// source's reconcile reads its heir and the heir's fork, which names `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_heirs_fork_keeps_the_sources_sidecars_it_names() {
    let world = world("heir-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let Reply::Value(inherited) = within("the fork answers", world.handle.request(request("thread/fork", json!({ "threadId": id, "opId": "op-heir" }), "op-heir"))).await.expect("thread/fork") else {
        panic!("thread/fork answers a value");
    };
    let heir_id = mixdog_core_api::ids::ThreadId::from(inherited["thread"]["id"].as_str().expect("the heir id").to_owned());
    let heir = within("the heir opens", world.directory.open_handle(&heir_id, &CallContext::internal("test"))).await.expect("the heir");
    let forked = json!({ "threadId": heir_id, "opId": "op-heir-fork", "intoThreadId": format!("{}_fork", heir_id.as_str()) });
    within("the heir's fork answers", heir.request(request("thread/fork", forked, "op-heir-fork"))).await.expect("thread/fork");
    within("the heir's clear answers", heir.request(request("thread/clear", json!({ "threadId": heir_id, "opId": "op-heir-clear" }), "op-heir-clear"))).await.expect("thread/clear");
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// A session Node as shipped stored (`transcript`, its whole `messages`), stored as the migration stores it: its system
/// prompt in the header, the reference set its transcript names (`offload_sources::stamp`), its own `fields`.
async fn shipped_session(world: &World, id: &ThreadId, transcript: Value, fields: Value) {
    let (mut header, rows) = migrated(transcript.clone());
    header.extend(fields.as_object().cloned().expect("fields"));
    mixdog_store::offload_sources::stamp(&mut header, id.as_str(), transcript.as_array().expect("transcript"));
    let sessions = SessionDirectory::new(world.rig.deps());
    within("the session is created", sessions.create_with_id(id.clone(), header, json!({}))).await.expect("create");
    world.rig.store.seed(id, rows.as_array().expect("rows").iter().enumerate().map(|(index, body)| item(format!("{}{index}", id.as_str()), body)).collect());
    within("its directory shuts down", sessions.shutdown_for("test close")).await;
}

/// Node's `older-fork`: the heir an inheritance made with Node as shipped holds no reference set; migrated, its header
/// holds the one its transcript names (the migration's `offload_sources::stamp`). The source is cleared, closed and
/// opened again: the catalog lists the heir as naming it (`copies_of`), and its transcript keeps `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_heir_its_source_never_recorded_keeps_the_sidecars_it_names() {
    let world = world("older-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let heir_id = ThreadId::from(format!("{id}_heir"));
    let heir = &world.case["seed"]["heir"];
    let carried = serde_json::to_string(&unmask(world.data.path(), &heir["transcript"])).expect("json").replace("<HEIR>", heir_id.as_str());
    let carried: Value = serde_json::from_str(&carried).expect("the heir's transcript");
    shipped_session(&world, &heir_id, carried, json!({ "inheritedFromSessionId": heir["inheritedFromSessionId"] })).await;
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// Signalled at each write to [`logged`].
static LOGGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// The warnings this test process logged (`tracing`, as the product's subscriber writes them), from the first call on.
fn logged() -> String {
    #[derive(Clone)]
    struct Captured(Arc<std::sync::Mutex<Vec<u8>>>);
    impl std::io::Write for Captured {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(bytes);
            LOGGED.notify_waiters();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    static LOG: std::sync::OnceLock<Captured> = std::sync::OnceLock::new();
    let log = LOG.get_or_init(|| {
        let log = Captured(Arc::default());
        let writer = log.clone();
        let subscriber = tracing_subscriber::fmt().with_ansi(false).with_max_level(tracing::Level::WARN).with_writer(move || writer.clone()).finish();
        tracing::subscriber::set_global_default(subscriber).expect("the only subscriber");
        log
    });
    String::from_utf8_lossy(&lock(&log.0)).into_owned()
}

/// Node's `unreadable-fork`: as `clear-fork`; the fork's log is then damaged and the cleared session opened again: a
/// session the store cannot read may be a copy, so nothing is deleted and the skip is logged with why. Closed, the
/// fork readable again, opened again: the reconcile prunes `stray`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_that_cannot_be_read_keeps_every_sidecar() {
    logged();
    let world = world("unreadable-fork").await;
    let (id, fork) = (world.handle.id.as_str().to_owned(), world.case["seed"]["forkId"].as_str().expect("the fork id").to_owned());
    let forked = json!({ "threadId": id, "opId": "op-fork", "intoThreadId": fork });
    within("the fork answers", world.handle.request(request("thread/fork", forked, "op-fork"))).await.expect("thread/fork");
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    lock(&world.rig.store.damaged).insert(fork.clone());
    let (directory, _handle) = world.reopened(1).await;
    let unreadable = world.point("after-unreadable-resume", false).await;
    assert_eq!(unreadable, world.case["points"][1], "a copy that cannot be read: the open deletes nothing");
    let skipped = logged().lines().filter(|line| line.contains("offload prune skipped") && line.contains(id.as_str()) && line.contains(fork.as_str())).count();
    assert_eq!(skipped, 1, "the skip is logged once, naming the session and the copy it could not read:\n{}", logged());
    assert!(lock(&world.rig.notices.0).contains(&format!("offload-prune-blocked:{fork}")), "the desktop is told nothing is pruned while the copy cannot be read");
    within("the directory shuts down", directory.shutdown_for("test close")).await;
    lock(&world.rig.store.damaged).remove(&fork);
    let _reopened = world.reopened(2).await;
    let readable = world.point("after-readable-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, unreadable, readable]), world.case);
}

/// Node's `linkless-fork`: the fork of an agent home's fresh start made by Node as shipped names no source and holds no
/// reference set; migrated, its header holds the set its transcript names. The source, cleared as Node's clear left
/// it, is opened again: the fork keeps `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_made_without_a_link_keeps_the_sidecars_its_transcript_names() {
    let world = world("linkless-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let fork = &world.case["seed"]["fork"];
    let fork_id = ThreadId::from(fork["sessionId"].as_str().expect("the fork id").to_owned());
    shipped_session(&world, &fork_id, unmask(world.data.path(), &fork["transcript"]), json!({})).await;
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// `thread/fork` of `handle` (an inheritance into a new session): the heir's id.
async fn heir_of(handle: &SessionHandle, op: &str) -> ThreadId {
    let forked = json!({ "threadId": handle.id.as_str(), "opId": op });
    let Reply::Value(inherited) = within("the fork answers", handle.request(request("thread/fork", forked, op))).await.expect("thread/fork") else {
        panic!("thread/fork answers a value");
    };
    ThreadId::from(inherited["thread"]["id"].as_str().expect("the heir id").to_owned())
}

/// Node's `deleted-middle`: a new session inherits the conversation and a third inherits the second's; the second is
/// deleted, and the source cleared, closed and opened again: the third names the source in its own reference set (its
/// source's set and its source), so no session between them is needed, and it keeps `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_of_a_copy_keeps_the_sidecars_it_names_once_the_copy_between_is_deleted() {
    let world = world("deleted-middle").await;
    // The catalog lists the sessions (a delete removes only a listed one, `isAvailableSession`).
    world.rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    let id = world.handle.id.as_str().to_owned();
    let middle = heir_of(&world.handle, "op-middle").await;
    let middle_handle = within("the middle copy opens", world.directory.open_handle(&middle, &CallContext::internal("test"))).await.expect("open");
    heir_of(&middle_handle, "op-last").await;
    let deleted = request("thread/delete", json!({ "threadId": middle, "opId": "op-delete" }), "op-delete");
    let Reply::Value(gone) = within("the delete answers", world.handle.request(deleted)).await.expect("thread/delete") else {
        panic!("thread/delete answers a value");
    };
    assert_eq!(gone, json!(true), "the copy between them is deleted");
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// Node's `copy-in-progress`: a new session inherits the conversation; between the copy of the source's rows and their
/// append to the heir (the heir's fit measurement, held), the source is cleared and opened again by a second owner:
/// the heir names the source in its reference set and is still inheriting, so nothing is deleted and the skip says
/// why. The copy is then stored, and the source opened again: the heir keeps `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_being_made_keeps_its_source_unpruned() {
    logged();
    let world = world("copy-in-progress").await;
    let id = world.handle.id.as_str().to_owned();
    let (arrived, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *lock(&world.rig.inherit.fit_gate) = Some((arrived.clone(), go.clone()));
    let source = world.handle.clone();
    let forking = tokio::spawn(async move { heir_of(&source, "op-heir").await });
    within("the copy is measured", arrived.notified()).await;
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    let (owner, _handle) = world.reopened(1).await;
    let copying = world.point("after-copying-resume", false).await;
    assert_eq!(copying, world.case["points"][1], "while the copy is being made, the open deletes nothing");
    let skipped = logged().lines().filter(|line| line.contains("offload prune skipped") && line.contains(id.as_str()) && line.contains("is still inheriting")).count();
    assert_eq!(skipped, 1, "the skip says a copy is still being made:\n{}", logged());
    within("the second owner lets the session go", owner.shutdown_for("test close")).await;
    go.notify_one();
    within("the copy is stored", forking).await.expect("the fork");
    let _reopened = world.reopened(2).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, copying, after_resume]), world.case);
}

/// Node's `system-named`: the session's system prompt (the header's prompt blocks, as the migration stores Node's
/// leading system messages) names `named` and nothing names `stray`; opened again: `named` is kept, as Node's
/// `messages` holds its system prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sidecar_the_system_prompt_names_is_kept() {
    let world = world("system-named").await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_resume]), world.case);
}

/// Node's `room-row`: a room log (`sess_room_<id>`) takes a member's speech naming `stray` (`thread/roomRows/append`,
/// the stored row Node's `appendRoomRows` wrote); the session is opened again: a room log is not a copy of the
/// conversation, so the text naming `stray` there keeps nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_room_row_naming_a_sidecar_keeps_nothing() {
    let world = world("room-row").await;
    let room_log = &world.case["seed"]["roomLog"];
    let room = mixdog_core_api::ids::ThreadId::from(room_log["sessionId"].as_str().expect("the room log id").to_owned());
    let rooms = SessionDirectory::new(world.rig.deps());
    within("the room log is created", rooms.create_with_id(room.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
    let log = within("the room log opens", rooms.open_handle(&room, &CallContext::internal("test"))).await.expect("open");
    let params = json!({ "threadId": room, "messages": unmask(world.data.path(), &room_log["messages"]) });
    let append = CoreRequest { method: Method("thread/roomRows/append"), params, op: None, ctx: CallContext::internal("test") };
    within("the room row is appended", log.request(append)).await.expect("thread/roomRows/append");
    within("the room log's directory shuts down", rooms.shutdown_for("test close")).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_resume]), world.case);
}

/// Node's `owner-let-go`: the session is opened, and let go (its directory shut down, its actor ended) while the
/// open's reconcile lists its directory: the decision is the actor's, so nothing is deleted. The next owner's open
/// reconciles it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_let_go_while_its_reconcile_lists_is_left_to_its_next_owner() {
    let world = world("owner-let-go").await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let mut listed = world.rig.compaction.listed.subscribe();
    let before = *listed.borrow();
    let (arrived, go) = world.hold_listing();
    let owner = SessionDirectory::new(world.rig.deps());
    within("the session opens", owner.open_handle(&world.handle.id, &CallContext::internal("test"))).await.expect("open");
    within("the reconcile lists", arrived.notified()).await;
    within("the owner lets the session go", owner.shutdown_for("test close")).await;
    go.notify_one();
    within("the listing answers", listed.wait_for(|count| *count > before)).await.expect("listed");
    let after_close = world.point("after-close", false).await;
    assert!(lock(&world.rig.compaction.pruned).is_empty(), "a session let go is not pruned by its old owner");
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_close, after_resume]), world.case);
}

/// A session an older core build stored as `transcript`: its header holds no reference set under the present rules
/// (the create's one is taken out again; `held`, when given, is the set it holds under no rules number), its rows as
/// recorded.
async fn older_core_session(world: &World, id: &ThreadId, transcript: Value, held: Option<Value>) {
    use mixdog_store::offload_sources as sets;
    let (header, rows) = migrated(transcript);
    let sessions = SessionDirectory::new(world.rig.deps());
    within("the session is created", sessions.create_with_id(id.clone(), header, json!({}))).await.expect("create");
    let handle = within("the session opens", sessions.open_handle(id, &CallContext::internal("test"))).await.expect("open");
    let params = match held {
        Some(held) => json!({ "threadId": id, "set": { sets::SOURCES: held }, "unset": [sets::SOURCES_RULES] }),
        None => json!({ "threadId": id, "set": {}, "unset": [sets::SOURCES, sets::SOURCES_RULES] }),
    };
    let unset = CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") };
    within("its set is taken out", handle.request(unset)).await.expect("thread/header/patch");
    world.rig.store.seed(id, rows.as_array().expect("rows").iter().enumerate().map(|(index, body)| item(format!("{}{index}", id.as_str()), body)).collect());
    within("its directory shuts down", sessions.shutdown_for("test close")).await;
}

/// The linkless fork's recorded transcript naming `named` in upper case (a model quoting its path), and naming
/// `tool-results/sess_b/` as well.
fn upper_case_transcript(world: &World) -> Value {
    let text = serde_json::to_string(&unmask(world.data.path(), &world.case["seed"]["fork"]["transcript"])).expect("json");
    let quoted = serde_json::to_string(world.path("named")).expect("json");
    let path = &quoted[1..quoted.len() - 1];
    assert!(text.contains(path), "the fork names `named`");
    let mut transcript: Value = serde_json::from_str(&text.replace(path, &path.to_uppercase())).expect("the transcript");
    transcript.as_array_mut().expect("messages").push(json!({ "role": "user", "content": "see tool-results/sess_b/x.txt" }));
    transcript
}

/// The source of `world` (Node's `linkless-fork`) is cleared and opened again, its prune runs (the `pruned`-th):
/// whether `named` (only the fork names it, in upper case) is still on disk, compared with the recording where the
/// file system ignores case (Windows, where the fork's text names it).
async fn cleared_and_reopened(world: &World, pruned: usize) {
    let id = world.handle.id.as_str().to_owned();
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let (_directory, handle) = world.reopened(1).await;
    if pruned > 1 {
        assert_eq!(lock(&world.rig.compaction.pruned_deleted)[0], 0, "a pass that finds a set unknown deletes nothing");
    }
    world.pruned(&handle, pruned).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(std::path::Path::new(world.path("named")).exists(), cfg!(windows), "the sidecar the fork names in another letter case");
    if cfg!(windows) {
        assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
    }
}

/// A fork naming its source's sidecar in another letter case (stored as the migration stores it, its set computed
/// from its transcript): where the file system ignores case the sidecar is the same file, so it is kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_naming_the_sources_sidecar_in_another_letter_case_keeps_it_on_disk() {
    let world = world("linkless-fork").await;
    let fork_id = ThreadId::from(world.case["seed"]["fork"]["sessionId"].as_str().expect("the fork id").to_owned());
    shipped_session(&world, &fork_id, upper_case_transcript(&world), json!({})).await;
    cleared_and_reopened(&world, 1).await;
}

/// The review's counter-example: the fork's header holds the set an earlier build computed under rules that matched
/// case everywhere (`["sess_b"]`, no rules number), although its transcript names the source's sidecar in upper case.
/// A set of earlier rules is unknown: the transcript is read again before the prune, and the sidecar is kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_set_stored_under_earlier_rules_is_read_again_and_the_file_it_misses_is_kept() {
    let world = world("linkless-fork").await;
    let fork_id = ThreadId::from(world.case["seed"]["fork"]["sessionId"].as_str().expect("the fork id").to_owned());
    older_core_session(&world, &fork_id, upper_case_transcript(&world), Some(json!(["sess_b"]))).await;
    // The first prune finds the fork's set unknown and reads it; the second prunes.
    cleared_and_reopened(&world, 2).await;
    let scanned = lock(&world.rig.store.scans).get(fork_id.as_str()).map(|(_, sources)| sources.clone());
    assert!(scanned.is_some(), "the fork's set is read again under the present rules");
}

/// Node's `linkless-fork` with the fork an older core build stored (its header holds no set at all, not an empty one):
/// its set is unknown, so the prune reads its transcript first (off the actor) and stores what it names
/// (`record_offload_scan`), then runs again; the fork keeps `named` as Node's check of a record without a set does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_stored_without_a_set_is_read_before_the_prune_and_its_set_stored() {
    let world = world("linkless-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let fork = &world.case["seed"]["fork"];
    let fork_id = ThreadId::from(fork["sessionId"].as_str().expect("the fork id").to_owned());
    older_core_session(&world, &fork_id, unmask(world.data.path(), &fork["transcript"]), None).await;
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let (_directory, handle) = world.reopened(1).await;
    world.pruned(&handle, 2).await;
    assert!(std::path::Path::new(world.path("named")).exists(), "the sidecar the fork names is on disk");
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
    let own = mixdog_store::offload_sources::segment_key(&mixdog_store::offload_sources::safe_segment(&id));
    let scanned = lock(&world.rig.store.scans).get(fork_id.as_str()).map(|(_, sources)| sources.clone());
    assert!(scanned.as_ref().is_some_and(|sources| sources.contains(&own)), "the fork's set, read from its transcript, is stored: {scanned:?}");
}

/// As above, with the fork's log unreadable (the catalog lists it as readable): its set cannot be known, so the open
/// deletes nothing, the block is logged once naming the session and the fork, and the desktop is told. Readable again,
/// the next open prunes as Node does.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_without_a_set_that_cannot_be_read_stops_the_prune() {
    logged();
    let world = world("linkless-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let fork = &world.case["seed"]["fork"];
    let fork_id = ThreadId::from(fork["sessionId"].as_str().expect("the fork id").to_owned());
    older_core_session(&world, &fork_id, unmask(world.data.path(), &fork["transcript"]), None).await;
    lock(&world.rig.store.unscannable).insert(fork_id.as_str().to_owned());
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    // Other tests of this recording (same ids) log their own unknown-set skips; only this one's fork cannot be read.
    let skipped = || logged().lines().filter(|line| line.contains("offload prune blocked") && line.contains(id.as_str()) && line.contains(fork_id.as_str())).count();
    let before = skipped();
    let (directory, handle) = world.reopened(1).await;
    let blocked = format!("offload-prune-blocked:{}", fork_id.as_str());
    // The scan off the actor reads the fork, fails, tells the desktop and logs it, in that order.
    within("the block is logged", eventually_on!(&[&handle.cell.stepped, &LOGGED], || (skipped() > before).then_some(()))).await;
    assert!(lock(&world.rig.notices.0).contains(&blocked), "the desktop is told the prune is blocked: {:?}", lock(&world.rig.notices.0));
    assert_eq!(world.point("after-clear", false).await, world.case["points"][0], "nothing is deleted while a session holding no set cannot be read");
    assert!(std::path::Path::new(world.path("named")).exists(), "the sidecar the fork may name is on disk");
    assert_eq!(skipped() - before, 1, "the open's skip is logged once, naming the session and the one it could not read:\n{}", logged());
    within("the directory shuts down", directory.shutdown_for("test close")).await;
    lock(&world.rig.store.unscannable).remove(fork_id.as_str());
    // Readable again: the next open reads the fork's set (its first prune skips) and prunes.
    let (_directory, handle) = world.reopened(2).await;
    world.pruned(&handle, 3).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// More sessions of unknown set than one pass reads (`OFFLOAD_SCAN_BATCH`): each pass reads one batch off the actor
/// and the prune runs again, so the sets are read over passes that resume where the last stopped, and only once every
/// one is known is anything deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unknown_sets_are_read_in_bounded_batches_that_resume() {
    let batch = super::actor::OFFLOAD_SCAN_BATCH;
    let world = world("linkless-fork").await;
    let fork = &world.case["seed"]["fork"];
    let fork_id = ThreadId::from(fork["sessionId"].as_str().expect("the fork id").to_owned());
    older_core_session(&world, &fork_id, unmask(world.data.path(), &fork["transcript"]), None).await;
    for other in 0..batch {
        let id = ThreadId::from(format!("{}_other_{other:02}", world.handle.id.as_str()));
        older_core_session(&world, &id, json!([{ "role": "user", "content": "hello" }, { "role": "assistant", "content": "noted" }]), None).await;
    }
    let id = world.handle.id.as_str().to_owned();
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let (_directory, handle) = world.reopened(1).await;
    // A pass that finds unknown sets deletes nothing: one reads `batch` of them, the next the last one, the third prunes.
    world.pruned(&handle, 2).await;
    assert_eq!(lock(&world.rig.compaction.pruned_deleted)[..2], [0, 0], "the passes that found sets unknown deleted nothing");
    world.pruned(&handle, 3).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(lock(&world.rig.store.scans).len(), batch + 1, "every set was read");
    assert_eq!(lock(&world.rig.compaction.pruned).len(), 3, "two passes read a batch each, the third pruned");
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// Where an inheritance into an existing session (`carry_into`) fails.
#[derive(Clone, Copy, Debug)]
enum CarryFails {
    /// Refused before anything is appended (the conversation does not fit and cannot be compacted).
    Refused,
    /// The copy's batch (rows, header keys and the end of the copy: one write) fails, nothing written.
    AppendRolledBack,
    /// The copy's batch is written and its sync fails: its rows are in the log.
    AppendWritten,
    /// The same batch fails on its header record (the one naming the source), nothing written.
    HeaderRecord,
}

/// Every failure point of an inheritance, in order, against the heir's reference set and copy mark on disk: the set
/// (the heir's own, the source's and the source) stored before anything is copied is never taken back; the mark goes
/// only when nothing was appended, and stays (stopping the source's prune) while rows of the copy may be in the log
/// unread. A refusal before anything is queued fails the inheritance; a failed write of the copy does not (its rows, header
/// keys and the mark's removal stay queued for the heir's next write). A mark an earlier boot left (the process stopped)
/// stops nothing: the heir is read, under its set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_inheritance_that_fails_anywhere_never_takes_its_reference_set_back() {
    use mixdog_store::offload_sources as sets;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::MetaRecord;
    for point in [CarryFails::Refused, CarryFails::AppendRolledBack, CarryFails::AppendWritten, CarryFails::HeaderRecord] {
        let world = world("copy-in-progress").await;
        let source = world.handle.id.clone();
        let heir = ThreadId::from(format!("{}_heir", source.as_str()));
        within("the heir is created", world.directory.create_with_id(heir.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
        let appended = |record: &Record| !matches!(record, Record::Meta(_) | Record::Session(_));
        let named = |record: &Record| matches!(record, Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) if change.set.contains_key("inheritedFromSessionId"));
        match point {
            CarryFails::Refused => *lock(&world.rig.inherit.basis) = Some((10, 100, false)),
            CarryFails::AppendRolledBack => *lock(&world.rig.store.fail_when) = Some((Box::new(appended), false)),
            CarryFails::AppendWritten => *lock(&world.rig.store.fail_when) = Some((Box::new(appended), true)),
            CarryFails::HeaderRecord => *lock(&world.rig.store.fail_when) = Some((Box::new(named), false)),
        }
        let forked = json!({ "threadId": source, "opId": "op-inherit", "intoThreadId": heir });
        let answer = within("the inheritance answers", world.handle.request(request("thread/fork", forked, "op-inherit"))).await;
        assert_eq!(answer.is_err(), matches!(point, CarryFails::Refused), "{point:?}: only a failure before anything is queued fails the inheritance: {answer:?}");
        let header = world.rig.store.stored_header(&heir).expect("the heir's header");
        assert!(sets::sources(&header).contains(&sets::safe_segment(source.as_str())), "{point:?}: the heir's set names the source: {header:?}");
        let marked = sets::mark(&header);
        let copies = world.rig.store.copies_of(&source).await;
        match point {
            // A batch written whole (its sync failed) holds the rows and the end of the copy together: the log the prune
            // reads has both, so no mark stands over rows it cannot read.
            CarryFails::Refused | CarryFails::AppendWritten => {
                assert_eq!(marked, None, "{point:?}: nothing was appended, or the batch holds the rows and the end of the copy: no mark");
                assert!(copies.is_ok_and(|found| found.copies == [heir.as_str()]), "{point:?}: the source's prune reads the heir");
            }
            _ => {
                assert_eq!(marked, Some((source.as_str().to_owned(), sets::boot().to_owned())), "{point:?}: the copy is queued: the stored header keeps the mark");
                let blocked = copies.expect_err("the source's prune is stopped");
                assert!(format!("{blocked:?}").contains("is still inheriting"), "{point:?}: {blocked:?}");
            }
        }
        // The source is cleared and opened again: only the heir's rows (if any were written) name `named` now. While the
        // mark stands, the prune deletes nothing.
        let source_id = source.as_str().to_owned();
        within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": source_id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
        within("the directory shuts down", world.directory.shutdown_for("test close")).await;
        let (directory, _handle) = world.reopened(1).await;
        let named_on_disk = || std::path::Path::new(world.path("named")).exists();
        assert_eq!(named_on_disk(), !matches!(point, CarryFails::Refused), "{point:?}: kept while the mark stands; with nothing copied nothing names it");
        within("the directory shuts down", directory.shutdown_for("test close")).await;
        // The process stopped: its mark names a boot that no longer owns the data dir.
        let next = SessionDirectory::new(world.rig.deps());
        let handle = within("the heir opens", next.open_handle(&heir, &CallContext::internal("test"))).await.expect("open");
        let params = json!({ "threadId": heir, "set": { sets::INHERITING_BOOT: "an-earlier-boot" }, "unset": [] });
        let earlier = CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") };
        within("the mark is an earlier boot's", handle.request(earlier)).await.expect("thread/header/patch");
        let found = world.rig.store.copies_of(&source).await.expect("an earlier boot's mark stops nothing");
        assert_eq!(found.copies, [heir.as_str()], "{point:?}: the heir is read under its set");
        within("the directory shuts down", next.shutdown_for("test close")).await;
        if matches!(point, CarryFails::Refused) {
            continue;
        }
        // The source opened by the next process: the heir is read, and what its stored rows name stays on disk.
        let (directory, _handle) = world.reopened(2).await;
        // The shutdown's own write takes the rows a failed write left queued with it.
        let rows_written = true;
        assert_eq!(named_on_disk(), rows_written, "{point:?}: the sidecar the heir's stored rows name is kept, and only that");
        within("the directory shuts down", directory.shutdown_for("test close")).await;
    }
}

/// A failed write of the copy leaves the heir's stored header with its set and its mark; the heir's next successful write
/// lands the queued rows with the header keys and the end of the copy, and the source's prune is free of the mark.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_copy_a_failed_write_left_queued_lands_with_the_heirs_next_write() {
    use mixdog_store::offload_sources as sets;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::MetaRecord;
    for point in [CarryFails::AppendRolledBack, CarryFails::AppendWritten, CarryFails::HeaderRecord] {
        let world = world("copy-in-progress").await;
        let source = world.handle.id.clone();
        let heir = ThreadId::from(format!("{}_heir", source.as_str()));
        within("the heir is created", world.directory.create_with_id(heir.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
        let appended = |record: &Record| !matches!(record, Record::Meta(_) | Record::Session(_));
        let named = |record: &Record| matches!(record, Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) if change.set.contains_key("inheritedFromSessionId"));
        match point {
            CarryFails::AppendRolledBack => *lock(&world.rig.store.fail_when) = Some((Box::new(appended), false)),
            CarryFails::AppendWritten => *lock(&world.rig.store.fail_when) = Some((Box::new(appended), true)),
            _ => *lock(&world.rig.store.fail_when) = Some((Box::new(named), false)),
        }
        let forked = json!({ "threadId": source, "opId": "op-inherit", "intoThreadId": heir });
        within("the inheritance answers", world.handle.request(request("thread/fork", forked, "op-inherit"))).await.expect("the inheritance answers");
        let header = world.rig.store.stored_header(&heir).expect("the heir's header");
        assert!(sets::sources(&header).contains(&sets::safe_segment(source.as_str())), "{point:?}: the stored header keeps its set: {header:?}");
        // A batch written whole (its sync failed) already holds the end of the copy.
        assert_eq!(sets::mark(&header).is_some(), !matches!(point, CarryFails::AppendWritten), "{point:?}: the mark stands until the copy lands: {header:?}");
        let handle = within("the heir opens", world.directory.open_handle(&heir, &CallContext::internal("test"))).await.expect("open");
        let patch = json!({ "threadId": heir, "set": { "title": "next" }, "unset": [] });
        let next = CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") };
        within("the heir's next write", handle.request(next)).await.expect("thread/header/patch");
        let header = world.rig.store.stored_header(&heir).expect("the heir's header");
        assert_eq!(sets::mark(&header), None, "{point:?}: the mark went with the rows: {header:?}");
        assert_eq!(header.get("inheritedFromSessionId"), Some(&json!(source.as_str())), "{point:?}: the header keys are stored: {header:?}");
        let contents = |id: &ThreadId| -> Vec<Value> {
            world.rig.store.records(id).into_iter().filter_map(|(_, record)| match record {
                Record::Item(row) => match &row.body {
                    Slot::Inline(body) => body.get("content").cloned(),
                    _ => None,
                },
                _ => None,
            }).collect()
        };
        let carried = contents(&heir);
        let held = contents(&source);
        assert!(!held.is_empty() && held.iter().all(|content| carried.contains(content)), "{point:?}: the rows are stored: {carried:?} of {held:?}");
        within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    }
}

/// A refused carry takes its "being copied" mark off, and a write of that removal that fails once does not leave the heir
/// marked: the source's reference query is not stopped by it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_carry_whose_unmarking_fails_once_leaves_no_mark() {
    use mixdog_store::offload_sources as sets;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::MetaRecord;
    let world = world("copy-in-progress").await;
    let source = world.handle.id.clone();
    let heir = ThreadId::from(format!("{}_heir", source.as_str()));
    within("the heir is created", world.directory.create_with_id(heir.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({}))).await.expect("create");
    *lock(&world.rig.inherit.basis) = Some((10, 100, false));
    let unmarking = |record: &Record| matches!(record, Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) if change.unset.iter().any(|key| key == sets::INHERITING));
    *lock(&world.rig.store.fail_when) = Some((Box::new(unmarking), false));
    let forked = json!({ "threadId": source, "opId": "op-inherit", "intoThreadId": heir });
    let answer = within("the inheritance answers", world.handle.request(request("thread/fork", forked, "op-inherit"))).await;
    assert!(answer.is_err(), "the carry is refused: {answer:?}");
    let header = world.rig.store.stored_header(&heir).expect("the heir's header");
    assert_eq!(sets::mark(&header), None, "the mark is off: {header:?}");
    let copies = world.rig.store.copies_of(&source).await;
    assert!(copies.is_ok_and(|found| found.copies == [heir.as_str()]), "the source's prune reads the heir");
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
}

/// Node's `thrown` (the save's fsync failed after its records were written): the barrier fails after its write.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_whose_barrier_failed_after_its_write_prunes_nothing() {
    let world = world("thrown").await;
    world.rig.store.fail_after_write.store(true, std::sync::atomic::Ordering::SeqCst);
    let answer = world.commit().await;
    assert!(answer.is_err(), "{answer:?}");
    assert!(lock(&world.rig.compaction.pruned).is_empty());
    let point = world.point("after-commit", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![point]), world.case);
}
