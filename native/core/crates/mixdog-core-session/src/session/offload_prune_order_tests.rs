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
//! `clear-fork`, `heir-fork` and `owner-let-go` are sessions Node's recorder does not compact: the copies of a
//! conversation in other sessions keep the sidecars they name, and a session let go while its reconcile runs is left
//! to its next owner.

use std::future::Future;
use std::sync::Arc;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
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
use super::testing::Rig;
use super::testing::lock;
use super::testing::offload_replay::World;
use super::testing::offload_replay::compaction_of;
use super::testing::offload_replay::header;
use super::testing::offload_replay::item;
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

/// Node's `older-fork`: the heir an inheritance made before its source recorded its copies (Node as shipped) names its
/// source in its own header only (`inheritedFromSessionId`); the source is cleared, closed and opened again: the
/// catalog lists the heir as a copy (`copies_of`), and its transcript keeps `named`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_heir_its_source_never_recorded_keeps_the_sidecars_it_names() {
    let world = world("older-fork").await;
    let id = world.handle.id.as_str().to_owned();
    let heir_id = mixdog_core_api::ids::ThreadId::from(format!("{id}_heir"));
    let heir = &world.case["seed"]["heir"];
    let header = json!({ "cwd": "/ws", "inheritedFromSessionId": heir["inheritedFromSessionId"] }).as_object().cloned().expect("object");
    let heirs = SessionDirectory::new(world.rig.deps());
    within("the heir is created", heirs.create_with_id(heir_id.clone(), header, json!({}))).await.expect("create");
    let carried = serde_json::to_string(&unmask(world.data.path(), &heir["transcript"])).expect("json").replace("<HEIR>", heir_id.as_str());
    let carried: Value = serde_json::from_str(&carried).expect("the heir's transcript");
    world.rig.store.seed(&heir_id, carried.as_array().expect("transcript").iter().enumerate().map(|(index, body)| item(format!("heir{index}"), body)).collect());
    within("the heir's directory shuts down", heirs.shutdown_for("test close")).await;
    within("the clear answers", world.handle.request(request("thread/clear", json!({ "threadId": id, "opId": "op-clear" }), "op-clear"))).await.expect("thread/clear");
    let after_clear = world.point("after-clear", false).await;
    within("the directory shuts down", world.directory.shutdown_for("test close")).await;
    let _reopened = world.reopened(1).await;
    let after_resume = world.point("after-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, after_resume]), world.case);
}

/// Node's `unreadable-fork`: as `clear-fork`; the fork's log is then damaged and the cleared session opened again: a
/// session the store cannot read may be a copy, so nothing is deleted. Closed, the fork readable again, opened again:
/// the reconcile prunes `stray`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_that_cannot_be_read_keeps_every_sidecar() {
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
    within("the directory shuts down", directory.shutdown_for("test close")).await;
    lock(&world.rig.store.damaged).remove(&fork);
    let _reopened = world.reopened(2).await;
    let readable = world.point("after-readable-resume", false).await;
    assert_eq!(world.got(world.case["changed"].clone(), world.case["error"].clone(), vec![after_clear, unreadable, readable]), world.case);
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
