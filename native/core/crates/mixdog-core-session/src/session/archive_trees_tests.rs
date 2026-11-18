//! The archive of a tree, held at each step by a barrier (never by timing): a stop or a policy change before the commit is admitted
//! changes nothing, an admitted commit changes every member at once and survives a restart, and every change a preparation judged
//! voids it.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_store::archive_state::ArchiveStates;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::session::testing::Rig;
use crate::session::testing::lock;
use crate::session::thread_settings::ArchivedWorktrees;
use crate::session::worktree::worktree_tests;

const ROOT: &str = "sess_root";
const C1: &str = "sess_c1";
const C2: &str = "sess_c2";

/// The worktree hand-off: the ids each archive handed over.
#[derive(Default)]
struct HandOff(Mutex<Vec<(Vec<String>, bool)>>);

#[async_trait]
impl ArchivedWorktrees for HandOff {
    async fn set_archived(&self, session_ids: &[String], archived: bool) -> Result<(), String> {
        lock(&self.0).push((session_ids.to_vec(), archived));
        Err("daemon unavailable".to_owned())
    }
}

struct NoRows;

impl crate::session::thread_edges::RowsPublished for NoRows {
    fn published(&self) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    trees: Arc<ArchiveTrees>,
    agent_only: Arc<crate::session::thread_settings_rig::AgentOnly>,
    hand_off: Arc<HandOff>,
    _workspace: worktree_tests::Rig,
    _ops: tempfile::TempDir,
}

fn admit() -> Admit {
    Admit { gate: Arc::default(), cancel: CancellationToken::new(), policy: Arc::default(), judged: 0 }
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

/// `ROOT` with the agent-only sessions `C1` and `C2` under it.
async fn world() -> World {
    world_with(false).await
}

/// [`world`], its authority over a state database that replaced one set aside (`lost`): the entries before it are gone.
async fn world_with(lost: bool) -> World {
    let mut rig = Rig::new();
    if lost {
        ArchiveStates::mark_lost(&rig.state).await.expect("marked");
        rig.archive = ArchiveStates::open(rig.state.clone()).await.expect("reopened");
    }
    rig.clock.0.store(1_800_000_000_000, std::sync::atomic::Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let workspace = worktree_tests::rig();
    let registered = vec![workspace.repo.to_string_lossy().into_owned()];
    let task = workspace.data.join("unclassified").to_string_lossy().into_owned();
    let hand_off = Arc::new(HandOff::default());
    let built = crate::session::thread_settings_rig::build_with(
        directory.clone(),
        workspace.ws.clone(),
        workspace.worktrees.clone(),
        Some(hand_off.clone()),
        Arc::new(NoRows),
        registered,
        task,
    )
    .await;
    let world = World { rig, directory, trees: built.trees, agent_only: built.agent_only, hand_off, _workspace: workspace, _ops: built.ops };
    world.session(ROOT, json!({})).await;
    for child in [C1, C2] {
        world.child(child, ROOT).await;
    }
    world
}

impl World {
    async fn session(&self, id: &str, header: Value) {
        let mut header = header.as_object().cloned().unwrap_or_default();
        header.insert("createdAt".into(), json!(1));
        self.directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("created");
    }

    async fn child(&self, id: &str, parent: &str) {
        self.session(id, json!({ "visibility": "agent-only", "parentSessionId": parent })).await;
        lock(&self.agent_only.0).push(id.to_owned());
    }

    fn archived(&self, id: &str) -> Option<f64> {
        self.rig.archive.resolve(id, None).archived_at
    }

    fn untouched(&self) {
        for id in [ROOT, C1, C2] {
            assert_eq!(self.archived(id), None, "{id} unchanged");
        }
    }

    fn spawn(&self, admit: Admit) -> tokio::task::JoinHandle<TreeOutcome> {
        let trees = self.trees.clone();
        tokio::spawn(async move {
            let prep = trees.prepare(ROOT, &admit).await;
            trees.commit(prep, &admit).await
        })
    }

    async fn archive(&self) -> TreeOutcome {
        self.spawn(admit()).await.unwrap()
    }

    /// The archive of `ROOT` held right before its commit is handed to the state writer.
    async fn held(&self) -> (tokio::task::JoinHandle<TreeOutcome>, tokio::sync::oneshot::Sender<()>) {
        let (arrived, go) = self.trees.hold_at(TreeStep::Commit);
        let task = self.spawn(admit());
        arrived.await.expect("the archive reaches its commit");
        (task, go)
    }

    async fn patch(&self, id: &str, set: Value) {
        let handle = self.directory.handle(&ThreadId::from(id)).expect("loaded");
        let params = json!({ "threadId": id, "set": set, "unset": [] });
        let _reply = handle
            .request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") })
            .await
            .expect("patched");
    }
}

async fn finish(task: tokio::task::JoinHandle<TreeOutcome>, go: tokio::sync::oneshot::Sender<()>) -> TreeOutcome {
    go.send(()).expect("the archive waits");
    task.await.unwrap()
}

/// A stop (the admission closed) while the tree is being read: nothing is admitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_during_the_descendant_read_archives_nothing() {
    let world = world().await;
    let admit = admit();
    let (arrived, go) = world.trees.hold_at(TreeStep::Descendants);
    let task = world.spawn(admit.clone());
    arrived.await.unwrap();
    admit.gate.close();
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("stopped".into()));
    world.untouched();
}

/// An option change (the policy identity moved) while the members are being held: nothing is admitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_option_change_during_the_reservations_archives_nothing() {
    let world = world().await;
    let admit = admit();
    let (arrived, go) = world.trees.hold_at(TreeStep::Reserving);
    let task = world.spawn(admit.clone());
    arrived.await.unwrap();
    admit.policy.moved();
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("policy".into()));
    world.untouched();
}

/// The pass cancelled while the commit waits for the state writer: the writer's admission refuses it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_before_the_state_writer_admits_it_archives_nothing() {
    let world = world().await;
    let admit = admit();
    let (arrived, go) = world.trees.hold_at(TreeStep::Commit);
    let task = world.spawn(admit.clone());
    arrived.await.unwrap();
    admit.cancel.cancel();
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("stopped".into()));
    world.untouched();
}

/// An admitted archive stamps every member at once, hands the whole tree to the worktrees (awaited: no detached task; their
/// failure does not fail it), and is what a restart reads back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_admitted_tree_is_archived_whole_and_survives_a_restart() {
    let world = world().await;
    let TreeOutcome::Archived(ids) = world.archive().await else { panic!("archived") };
    assert_eq!(sorted(ids.clone()), sorted(vec![ROOT.into(), C1.into(), C2.into()]));
    let stamp = world.archived(ROOT).expect("root archived");
    assert_eq!((world.archived(C1), world.archived(C2)), (Some(stamp), Some(stamp)), "one stamp for the tree");
    assert_eq!(*lock(&world.hand_off.0), [(ids, true)], "handed over before the archive answered");
    let restarted = ArchiveStates::open(world.rig.state.clone()).await.expect("reopened");
    for id in [ROOT, C1, C2] {
        assert_eq!(restarted.resolve(id, None).archived_at, Some(stamp), "{id} after a restart");
    }
}

/// The user archives a member while the auto-archive is prepared: the preparation is void, only the user's archive remains.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_users_archive_of_a_member_voids_the_preparation() {
    let world = world().await;
    let (task, go) = world.held().await;
    assert!(world.trees.set_manual(&ThreadId::from(C1), true).await.expect("archived"));
    let users = world.archived(C1);
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("changed".into()));
    assert!(users.is_some());
    assert_eq!((world.archived(ROOT), world.archived(C1), world.archived(C2)), (None, users, None));
}

/// A window attaching to a member voids the preparation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_voids_the_preparation() {
    let world = world().await;
    let (task, go) = world.held().await;
    assert!(world.directory.handle(&ThreadId::from(C2)).expect("held").cell.subscribing());
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("changed".into()));
    world.untouched();
}

/// A favorite mark, or new activity, on the root voids the preparation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_favorite_or_activity_voids_the_preparation() {
    for set in [json!({ "favoriteAt": 1_800_000_000_001_i64 }), json!({ "lastUsedAt": 1_800_000_000_002_i64 })] {
        let world = world().await;
        let (task, go) = world.held().await;
        world.patch(ROOT, set.clone()).await;
        assert_eq!(finish(task, go).await, TreeOutcome::Refused("changed".into()), "{set}");
        world.untouched();
    }
}

/// A sub-agent session joining the tree after it was read voids the preparation: nobody judged it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_member_voids_the_preparation() {
    let world = world().await;
    let (task, go) = world.held().await;
    world.child("sess_c3", ROOT).await;
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("changed".into()));
    world.untouched();
}

/// A restore of a member while prepared changes its entry: the preparation is void.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_of_a_member_voids_the_preparation() {
    let world = world().await;
    assert!(world.trees.set_manual(&ThreadId::from(C1), true).await.unwrap());
    let (task, go) = world.held().await;
    assert!(world.trees.set_manual(&ThreadId::from(C1), false).await.unwrap());
    assert_eq!(finish(task, go).await, TreeOutcome::Refused("changed".into()));
    assert_eq!((world.archived(ROOT), world.archived(C1), world.archived(C2)), (None, None, None));
}

/// A sub-agent session archived on its own keeps its stamp through the tree's archive and the tree's restore; the restore brings
/// back exactly what carried the root's stamp, records the root's restore, and all of it survives a restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_independent_child_stamp_and_an_explicit_restore_survive_a_restart() {
    let world = world().await;
    assert!(world.trees.set_manual(&ThreadId::from(C1), true).await.unwrap());
    let own = world.archived(C1).expect("c1 archived");
    let TreeOutcome::Archived(ids) = world.archive().await else { panic!("archived") };
    assert_eq!(sorted(ids), sorted(vec![ROOT.into(), C2.into()]), "the archived child is not stamped again");
    assert_eq!(world.archived(C1), Some(own));
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), false).await.unwrap());
    let restarted = ArchiveStates::open(world.rig.state.clone()).await.expect("reopened");
    let legacy = json!(5);
    let root = restarted.resolve(ROOT, Some(&legacy));
    assert!(!root.archived() && root.restored_at().is_some(), "the explicit restore wins over a header stamp");
    assert_eq!(restarted.resolve(C1, None).archived_at, Some(own));
    assert_eq!(restarted.resolve(C2, None).archived_at, None);
    assert_eq!(restarted.resolve("sess_legacy", Some(&legacy)).archived_at, Some(5.0), "no entry: the header decides");
}

/// The user's own archive and restore are unchanged by a preparation of another tree: they are admitted while it is held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_archive_is_not_delayed_by_a_held_preparation() {
    let world = world().await;
    world.session("sess_other", json!({})).await;
    let (task, go) = world.held().await;
    assert!(world.trees.set_manual(&ThreadId::from("sess_other"), true).await.unwrap());
    assert!(world.archived("sess_other").is_some());
    assert!(matches!(finish(task, go).await, TreeOutcome::Archived(_)), "another tree's archive does not void this one");
}

/// The user restored the session (its header carries no stamp), then the state database was set aside: the restore's entry and
/// its exemption are gone. No automatic archive acts on a state that may hide it, of the tree or of a session alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_the_entries_were_lost_no_automatic_archive_acts() {
    let world = world_with(true).await;
    assert_eq!(world.archive().await, TreeOutcome::Refused(LOST.into()));
    world.untouched();
    let header = world.directory.stored_header(&ThreadId::from(C1)).await.expect("stored");
    let marked = world.directory.mark_archived(C1, &header, Mark::Automatic(Box::new(|| 1.0))).await.expect("answered");
    assert!(!marked && world.archived(C1).is_none(), "the sub-agent retention's archive does nothing");
    // The user's own archive is not automatic: it is admitted and, being an entry, trusted from then on.
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), true).await.unwrap());
    assert!(world.rig.archive.resolve(ROOT, None).trusted());
}

/// The user archives and restores the session after the pass read its record and before the tree is held: the preparation holds
/// the restore's entry, and the record the judgment reads under it carries the restore's exemption, so the stale record cannot
/// archive it again (and a restore after the hold is a changed entry at the commit).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_before_the_hold_is_the_exemption_the_judgment_reads() {
    let world = world().await;
    let stale = RetentionRecord::default();
    let (arrived, go) = world.trees.hold_at(TreeStep::Descendants);
    let trees = world.trees.clone();
    let prepared = tokio::spawn(async move { trees.prepare(ROOT, &admit()).await });
    arrived.await.unwrap();
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), true).await.unwrap());
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), false).await.unwrap());
    let restored_at = world.rig.archive.resolve(ROOT, None).restored_at().expect("an explicit restore");
    go.send(()).unwrap();
    let prep = prepared.await.unwrap();
    assert_eq!(prep.refused(), None, "nothing it holds moved after the hold");
    assert_eq!(prep.judged_record(stale).restored.get(ROOT), Some(&restored_at), "the judgment reads the held restore");
    world.trees.abandon(prep).await;
    world.untouched();
}

/// What a 1.4.5 desktop reads of `id` from the profile's metadata file, through the Rust twin of its `readSessionMetadata`.
fn read_by_1_4_5(profile: &std::path::Path, id: &str) -> Option<mixdog_migrate::desktop_profile::MetaSet> {
    let bytes = std::fs::read(profile.join(mixdog_store::archive_state::DESKTOP_METADATA_FILE)).expect("the metadata file");
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    mixdog_migrate::desktop_profile::SessionMetadata::from_value(&value).meta_for(id).cloned()
}

/// A 1.4.5 build run on the same data after 1.5.0 reads each session's archive state as the authority committed it: the archive
/// of a tree marks every member with the tree's stamp, the restore takes the marks off, and what else the file held stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_1_4_5_reader_sees_the_committed_archive_and_restore() {
    let world = world().await;
    let profile = tempfile::tempdir().unwrap();
    let file = profile.path().join(mixdog_store::archive_state::DESKTOP_METADATA_FILE);
    std::fs::write(&file, serde_json::to_vec(&json!({ "version": 2, "titles": { (ROOT): "Kept title" }, "names": {}, "favorites": { (C2): 5 } })).unwrap()).unwrap();
    world.rig.archive.bind_desktop_mirror(profile.path(), mixdog_rt::testing::tokens().durability_io).expect("bound");
    world.rig.archive.mirror_settled().await;
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), true).await.unwrap());
    world.rig.archive.mirror_settled().await;
    let stamp = world.archived(ROOT).expect("archived");
    for id in [ROOT, C1, C2] {
        let read = read_by_1_4_5(profile.path(), id).expect("listed by 1.4.5");
        assert_eq!(read.archived_at.and_then(|at| at.as_f64()), Some(stamp), "{id} archived for 1.4.5");
    }
    assert_eq!(read_by_1_4_5(profile.path(), ROOT).and_then(|meta| meta.title), Some("Kept title".into()), "the title stays");
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), false).await.unwrap());
    world.rig.archive.mirror_settled().await;
    for id in [ROOT, C1, C2] {
        assert_eq!(read_by_1_4_5(profile.path(), id).and_then(|meta| meta.archived_at), None, "{id} restored for 1.4.5");
    }
    assert!(read_by_1_4_5(profile.path(), C2).and_then(|meta| meta.favorite_at).is_some(), "the favorite stays");
    let value: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(value.get("archived").is_none(), "an empty archive map is left out, as 1.4.5 writes it");
    assert!(!world.rig.archive.mirror_owed());
}

/// A mirror write that fails (the file is a folder) is owed and carried by the next write once it can land.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_mirror_write_is_owed_and_carried_by_the_next() {
    let world = world().await;
    let profile = tempfile::tempdir().unwrap();
    let file = profile.path().join(mixdog_store::archive_state::DESKTOP_METADATA_FILE);
    std::fs::create_dir(&file).unwrap();
    world.rig.archive.bind_desktop_mirror(profile.path(), mixdog_rt::testing::tokens().durability_io).expect("bound");
    assert!(world.trees.set_manual(&ThreadId::from(ROOT), true).await.unwrap(), "the archive stands");
    world.rig.archive.mirror_settled().await;
    assert!(world.rig.archive.mirror_owed(), "the write is owed");
    std::fs::remove_dir(&file).unwrap();
    world.session("sess_other", json!({})).await;
    assert!(world.trees.set_manual(&ThreadId::from("sess_other"), true).await.unwrap());
    world.rig.archive.mirror_settled().await;
    assert!(!world.rig.archive.mirror_owed());
    assert!(read_by_1_4_5(profile.path(), ROOT).and_then(|meta| meta.archived_at).is_some(), "the owed archive landed with the next");
}

/// A mirror write held in its task delays neither the bind (the start) nor a commit's answer; released, it writes the state the
/// authority holds then, the commits made while it was held included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_mirror_write_delays_neither_the_start_nor_the_commit_and_writes_the_latest() {
    let world = world().await;
    world.session("sess_other", json!({})).await;
    let profile = tempfile::tempdir().unwrap();
    let (arrived, go) = world.rig.archive.hold_mirror();
    world.rig.archive.bind_desktop_mirror(profile.path(), mixdog_rt::testing::tokens().durability_io).expect("bound without waiting");
    arrived.await.expect("the start's mirror write is held");
    tokio::time::timeout(std::time::Duration::from_secs(30), world.trees.set_manual(&ThreadId::from(ROOT), true)).await.expect("the archive answered while the mirror write is held").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), world.trees.set_manual(&ThreadId::from(ROOT), false)).await.expect("the restore answered while the mirror write is held").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(30), world.trees.set_manual(&ThreadId::from("sess_other"), true)).await.expect("the archive answered while the mirror write is held").unwrap();
    assert!(!profile.path().join(mixdog_store::archive_state::DESKTOP_METADATA_FILE).exists(), "nothing written while held");
    assert!(world.rig.archive.mirror_owed());
    go.send(()).unwrap();
    world.rig.archive.mirror_settled().await;
    assert!(!world.rig.archive.mirror_owed());
    for id in [ROOT, C1, C2] {
        assert_eq!(read_by_1_4_5(profile.path(), id).and_then(|meta| meta.archived_at), None, "{id}: restored, as the authority holds it");
    }
    assert!(read_by_1_4_5(profile.path(), "sess_other").and_then(|meta| meta.archived_at).is_some(), "the last archive is written");
    world.rig.archive.close_mirror().await;
}

/// Opens `id` with its open's continuation decision held at the gate ([`crate::session::goal_lane::decision_hold`]): neither completed
/// nor dropped until the returned sender says how it ends (dropped: it runs as usual).
async fn open_with_held_decision(world: &World, id: &str) -> (Arc<SessionHandle>, tokio::sync::oneshot::Sender<crate::session::goal_lane::DecisionFault>) {
    let thread = ThreadId::from(id);
    let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
    let (go, go_rx) = tokio::sync::oneshot::channel();
    crate::session::goal_lane::DECISION_HOLDS.lock().unwrap().push((id.to_owned(), arrived_tx, go_rx));
    let handle = world.directory.open_handle(&thread, &CallContext::internal("test")).await.expect("opened");
    arrived.await.expect("the open's continuation decision is held");
    // The decision's task is spawned inside the actor's step and can reach the gate before that step ends, which is when the
    // actor publishes its pending state: wait for the step.
    crate::eventually_on!(&[&handle.cell.stepped], || handle.cell.goal_pending.load(std::sync::atomic::Ordering::SeqCst).then_some(())).await;
    (handle, go)
}

/// `id` created, then let go of: not loaded.
async fn stored_only(world: &World, id: &str) {
    world.session(id, json!({})).await;
    let thread = ThreadId::from(id);
    release_idle(world, &thread).await;
    assert!(world.directory.handle(&thread).is_none(), "{id}: released before the test opens it");
}

/// Lets go of a loaded `thread` once its pending continuation decision ended (a release never waits for one).
async fn release_idle(world: &World, thread: &ThreadId) {
    if let Some(handle) = world.directory.handle(thread) {
        decision_ended(&handle).await;
    }
    world.directory.release(thread).await;
}

/// The actor's pending continuation decision ended (decided, failed or its task gone).
async fn decision_ended(handle: &SessionHandle) {
    crate::eventually_on!(&[&handle.cell.stepped], || (!handle.cell.goal_pending.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
}

/// A release never waits for a pending Goal decision: with the decision held (neither completed nor dropped), the release is
/// acknowledged at once and the session stays loaded; the sweep goes on to the next tree while the gate is still held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_release_with_a_pending_decision_answers_stays_and_the_sweep_moves_on() {
    let world = world().await;
    stored_only(&world, "sess_next").await;
    for id in [ROOT, C1, C2] {
        release_idle(&world, &ThreadId::from(id)).await;
    }
    let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
    let (go, go_rx) = tokio::sync::oneshot::channel::<crate::session::goal_lane::DecisionFault>();
    crate::session::goal_lane::DECISION_HOLDS.lock().unwrap().push((C1.to_owned(), arrived_tx, go_rx));
    let admit = admit();
    let prep = world.trees.prepare(ROOT, &admit).await;
    arrived.await.expect("the opened member's continuation decision is held");
    assert!(matches!(world.trees.commit(prep, &admit).await, TreeOutcome::Archived(_)), "the tree's commit answered, its release acknowledged");
    assert!(world.directory.handle(&ThreadId::from(C1)).is_some(), "the member with a pending decision stays loaded");
    let prep = world.trees.prepare("sess_next", &admit).await;
    assert!(matches!(world.trees.commit(prep, &admit).await, TreeOutcome::Archived(_)), "the sweep moved on while the gate is held");
    assert!(world.archived("sess_next").is_some());
    drop(go);
}

/// A decision that fails, or whose task panics, clears the pending state; a release after it unloads the idle session.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_or_panicked_decision_clears_the_pending_state_for_the_next_release() {
    use crate::session::goal_lane::DecisionFault;
    let world = world().await;
    for (id, fault) in [("sess_fails", DecisionFault::Fail), ("sess_panics", DecisionFault::Panic)] {
        stored_only(&world, id).await;
        // Returns once the actor published the held decision as pending.
        let (handle, go) = open_with_held_decision(&world, id).await;
        go.send(fault).ok().expect("the decision waits");
        decision_ended(&handle).await;
        world.directory.release(&ThreadId::from(id)).await;
        assert!(world.directory.handle(&ThreadId::from(id)).is_none(), "{id}: unloaded by the release after the decision ended");
    }
}

/// An attached session stays loaded through a release.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attached_session_stays_loaded_through_a_release() {
    let world = world().await;
    let handle = world.directory.handle(&ThreadId::from(ROOT)).expect("loaded");
    assert!(handle.cell.subscribing());
    handle.cell.subscribed(true);
    world.directory.release(&ThreadId::from(ROOT)).await;
    assert!(world.directory.handle(&ThreadId::from(ROOT)).is_some(), "it stays loaded");
}
/// Many trees archived one after another: each releases the sessions it opened, acknowledged, before the next starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_pass_releases_what_it_opened() {
    let world = world().await;
    let roots: Vec<String> = (0..40).map(|at| format!("sess_r{at}")).collect();
    for root in &roots {
        world.session(root, json!({})).await;
        world.child(&format!("{root}_c"), root).await;
    }
    for id in world.directory.loaded_ids() {
        release_idle(&world, &id).await;
    }
    assert!(world.directory.loaded_ids().is_empty(), "nothing loaded before the pass");
    for root in &roots {
        let admit = admit();
        let prep = world.trees.prepare(root, &admit).await;
        assert!(matches!(world.trees.commit(prep, &admit).await, TreeOutcome::Archived(ids) if ids.len() == 2), "{root}");
        // A session its open left a continuation decision pending for stays through the commit's release; once the decision
        // ended, a release unloads it.
        for handle in world.directory.loaded_handles() {
            decision_ended(&handle).await;
            world.directory.release(&handle.id).await;
        }
        let left: Vec<String> = world
            .directory
            .loaded_handles()
            .iter()
            .map(|handle| {
                let cell = &handle.cell;
                format!(
                    "{} attached={} held={} closed={} busy={} pending={} ui_busy={} compacting={} gated={} recovered={} unacked={} drafts_settled={}",
                    handle.id,
                    cell.attached(),
                    cell.retention.held(),
                    cell.closed.load(std::sync::atomic::Ordering::SeqCst),
                    cell.busy.load(std::sync::atomic::Ordering::SeqCst),
                    cell.turn_pending.load(std::sync::atomic::Ordering::SeqCst),
                    cell.ui_busy.load(std::sync::atomic::Ordering::SeqCst),
                    cell.compacting.load(std::sync::atomic::Ordering::SeqCst),
                    cell.gated.load(std::sync::atomic::Ordering::SeqCst),
                    cell.recovered.load(std::sync::atomic::Ordering::SeqCst),
                    cell.unacked.load(std::sync::atomic::Ordering::SeqCst),
                    cell.drafts_settled.load(std::sync::atomic::Ordering::SeqCst),
                )
            })
            .collect();
        assert!(left.is_empty(), "{root}: what it opened is released once its decision ended; still loaded: {left:#?}");
    }
    assert_eq!(lock(&world.hand_off.0).len(), roots.len(), "every hand-off ran inside its archive");
}
