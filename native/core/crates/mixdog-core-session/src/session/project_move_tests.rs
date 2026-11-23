//! `setSessionProject` while the session works and from its managed worktree, over a session directory whose actor decides
//! and carries out the move, the production workspace host and real temporary git repositories.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "tests drive git and the disk directly")]

use std::path::PathBuf;
use std::sync::OnceLock;

use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use mixdog_core_base::support::testing::with_op;
use mixdog_scm::error::ScmFailure;
use mixdog_scm::worktree::manager::Retention;
use mixdog_scm::worktree::registry::WorktreeRecord;
use mixdog_store::schema::record::Record;
use mixdog_tools::git::SessionWorktrees;
use tokio::sync::Notify;

use super::*;
use crate::eventually_on;
use crate::session::SessionHandle;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::testing::lock as locked;
use crate::session::tests::caught_up;
use crate::session::tests::request as session_request;
use crate::session::tests::settled_idle;
use crate::session::tests::turn;
use crate::session::thread_settings_rig::Built;
use crate::session::thread_settings_rig::Hosted;
use crate::session::worktree::Cwd;
use crate::session::worktree::LiveWorkspace;
use crate::session::worktree::SelectBranch;
use crate::session::worktree::TurnAdmission;
use crate::session::worktree::worktree_tests::enter;
use crate::session::worktree::worktree_tests::git;
use crate::session::worktree::worktree_tests::real_tempdir;
use crate::session::worktree::worktree_tests::repo_with_one_commit;

const ID: &str = "sess_move";

/// The session workspaces as the turns' admission and the live workspace, bound once they exist (they are built over the
/// directory); a turn is admitted at once. While `hold` is set, a move the actor began waits for it before it is carried out;
/// `begun` counts the moves the actor began and `carried` those whose carry ended. While `read` is set, a live-workspace read
/// started then answers its workspace once its token is cancelled.
#[derive(Default)]
struct Late {
    workspaces: OnceLock<SessionWorkspaces>,
    hold: Mutex<Option<Arc<Notify>>>,
    begun: std::sync::atomic::AtomicUsize,
    carried: Arc<std::sync::atomic::AtomicUsize>,
    read: Mutex<Option<(Value, CancellationToken)>>,
}

#[async_trait]
impl TurnAdmission for Late {
    async fn admit(&self, _: &str, _: Cwd, _: &CancellationToken) -> Result<Box<dyn Send>, ScmFailure> {
        Ok(Box::new(()))
    }

    fn settled_move(&self, thread: &str, pending: Value) -> Option<futures::future::BoxFuture<'static, Result<(), CoreError>>> {
        let carry = self.workspaces.get()?.settled_move(thread, pending)?;
        self.begun.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (hold, carried) = (locked(&self.hold).clone(), self.carried.clone());
        Some(Box::pin(async move {
            if let Some(hold) = hold {
                hold.notified().await;
            }
            let result = carry.await;
            carried.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            result
        }))
    }
}

#[async_trait]
impl LiveWorkspace for Late {
    async fn live(&self, session: &str) -> Option<Value> {
        let read = locked(&self.read).clone();
        if let Some((workspace, answer)) = read {
            answer.cancelled().await;
            return Some(workspace);
        }
        self.workspaces.get()?.live_workspace(session).await
    }
}

struct Keep;

impl Retention for Keep {
    fn owner_live(&self, _: &WorktreeRecord) -> bool {
        false
    }
    fn retained(&self, _: &WorktreeRecord) -> bool {
        true
    }
}

/// `a`, the repository the session starts in, and the plain folders `b` and `c`: the registered Projects.
struct Folders {
    _dir: tempfile::TempDir,
    a: String,
    b: String,
    c: String,
    task: String,
}

fn folders() -> Folders {
    let dir = real_tempdir();
    let a = repo_with_one_commit(dir.path());
    let text = |path: PathBuf| {
        std::fs::create_dir_all(&path).unwrap();
        path.to_string_lossy().into_owned()
    };
    let (b, c, task) = (text(dir.path().join("b")), text(dir.path().join("c")), text(dir.path().join("tasks")));
    Folders { a: a.to_string_lossy().into_owned(), b, c, task, _dir: dir }
}

struct Served {
    directory: Arc<SessionDirectory>,
    hosted: Hosted,
    built: Built,
    late: Arc<Late>,
}

async fn served(rig: &Rig, folders: &Folders) -> Arc<Served> {
    let late = Arc::new(Late::default());
    let mut parts = rig.deps_parts(rig.store.clone());
    parts.turn_admission = late.clone();
    parts.live_workspace = late.clone();
    let directory = Arc::new(SessionDirectory::new(Arc::new(parts)));
    let hosted = crate::session::thread_settings_rig::hosted(&directory, Arc::new(SessionThreads::new(directory.clone())));
    assert!(late.workspaces.set(hosted.workspaces.clone()).is_ok());
    let registered = vec![folders.a.clone(), folders.b.clone(), folders.c.clone()];
    let built =
        crate::session::thread_settings_rig::build(directory.clone(), hosted.workspaces.clone(), hosted.worktrees.clone(), registered, folders.task.clone())
            .await;
    Arc::new(Served { directory, hosted, built, late })
}

/// The session `id` in the folder `cwd`, a registered Project, with `extra` on its record; the catalog lists it there.
async fn create_in(rig: &Rig, directory: &SessionDirectory, id: &str, cwd: &str, extra: Value) -> Arc<SessionHandle> {
    let row = json!({ "cwd": cwd, "desktopSession": { "classification": "project", "projectPath": cwd } });
    locked(&rig.store.summaries).insert(ThreadId::from(id), row.clone());
    let mut header = row.as_object().cloned().unwrap_or_default();
    header.insert("createdAt".into(), json!(1));
    header.extend(extra.as_object().cloned().unwrap_or_default());
    directory.create_with_id(ThreadId::from(id), header, json!({})).await.expect("created");
    directory.handle(&ThreadId::from(id)).expect("loaded")
}

/// The session in Project `a`, with `extra` on its record.
async fn create(rig: &Rig, directory: &SessionDirectory, folders: &Folders, extra: Value) -> Arc<SessionHandle> {
    create_in(rig, directory, ID, &folders.a, extra).await
}

async fn move_to(served: &Served, project: &str, op: u64) -> Result<Value, CoreError> {
    value(&served.built.settings, request(METADATA_UPDATE, with_op(json!({ "threadId": ID, "projectPath": project }), op), Some(op))).await
}

/// [`move_to`] in a task of its own: a move the actor begins at once answers only when it ended.
fn moving(served: &Arc<Served>, project: &str, op: u64) -> tokio::task::JoinHandle<Result<Value, CoreError>> {
    let (served, project) = (served.clone(), project.to_owned());
    tokio::spawn(async move { move_to(&served, &project, op).await })
}

/// [`turn`] in a task of its own: a start held back answers once it started.
fn submitted(handle: &Arc<SessionHandle>, prompt: &'static str, op: &'static str) -> tokio::task::JoinHandle<Value> {
    let handle = handle.clone();
    tokio::spawn(async move { turn(&handle, prompt, op).await })
}

/// Moves the actor begins wait until the returned gate is opened.
fn held_moves(served: &Served) -> Arc<Notify> {
    let gate = Arc::new(Notify::new());
    *locked(&served.late.hold) = Some(gate.clone());
    gate
}

/// Every turn runs until the returned gate is opened, then completes; `started` collects the session's folder as each turn starts.
fn held_turns_seen(rig: &Rig, directory: Option<Arc<SessionDirectory>>) -> (Arc<Notify>, Arc<Mutex<Vec<String>>>) {
    let (gate, started) = (Arc::new(Notify::new()), Arc::new(Mutex::new(Vec::new())));
    let (held, seen) = (gate.clone(), started.clone());
    rig.set_script(Arc::new(move |_run| {
        let held = held.clone();
        if let Some(handle) = directory.as_ref().and_then(|directory| directory.handle(&ThreadId::from(ID))) {
            locked(&seen).push(cwd(&handle));
        }
        Box::pin(async move {
            held.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    (gate, started)
}

fn held_turns(rig: &Rig) -> Arc<Notify> {
    held_turns_seen(rig, None).0
}

/// A client subscribed as the server attaches a `thread/resume`, as subscription `name` (one of its own per client): its
/// connection, its feed (kept attached) and its snapshot frame.
async fn subscribed(handle: &SessionHandle, connection: u64, name: &'static str) -> (MockConnection, Arc<dyn FeedSource>, Value) {
    let op = format!("op-resume-{connection}");
    let resume = session_request("thread/resume", json!({ "threadId": ID, "window": { "lastItems": 10 } }), &op);
    let Reply::Subscribe(resumed) = handle.request(resume).await.expect("thread/resume") else { panic!("thread/resume subscribes") };
    let client = MockConnection::new(ConnectionId(connection), MockLimits::default());
    let attached =
        mixdog_core_api::feed::subscribe(&resumed.feed, mixdog_core_api::ids::SubscriptionId::from(name), resumed.window, None, &client).expect("attach");
    client.send_control_release(bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
    let first = client.drain_text_until(|frames| frames.iter().any(|frame| frame.contains("thread/snapshot"))).await;
    let snapshot = lane_frames(&first).into_iter().find(|frame| frame["method"] == "thread/snapshot").expect("a snapshot");
    (client, resumed.feed, snapshot)
}

fn lane_frames(frames: &[String]) -> Vec<Value> {
    frames
        .iter()
        .filter(|frame| !frame.starts_with("control:"))
        .filter_map(|frame| frame.split_once(':'))
        .filter_map(|(_, frame)| serde_json::from_str(frame).ok())
        .collect()
}

/// The next `thread/workspace/updated` the client receives that `wanted` accepts: its workspace.
async fn workspace_note(client: &MockConnection, wanted: impl Fn(&Value) -> bool) -> Value {
    let note = |frame: &Value| frame["method"] == "thread/workspace/updated" && wanted(&frame["params"]["value"]);
    let frames = client.drain_text_until(|frames| lane_frames(frames).iter().any(note)).await;
    lane_frames(&frames).into_iter().find(note).expect("the notification")["params"]["value"].clone()
}

/// The value `key` holds anywhere inside `value`.
fn found(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(map) => map.get(key).cloned().or_else(|| map.values().find_map(|value| found(value, key))),
        Value::Array(rows) => rows.iter().find_map(|value| found(value, key)),
        _ => None,
    }
}

fn pending(handle: &SessionHandle) -> Option<Value> {
    handle.header_snapshot().get(PENDING_PROJECT_MOVE).cloned()
}

/// The pending move the thread's published state shows.
fn shown(handle: &SessionHandle) -> Option<Value> {
    handle.cell.view.load_full().state.workspace.as_ref().and_then(|workspace| workspace.get(PENDING_PROJECT_MOVE)).cloned()
}

fn cwd(handle: &SessionHandle) -> String {
    handle.header_snapshot().get("cwd").and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn worktree_id(handle: &SessionHandle) -> Option<String> {
    handle.header_snapshot().get("workspace").and_then(|workspace| workspace.get("worktreeId")).and_then(Value::as_str).map(str::to_owned)
}

fn same(left: &str, right: &str) -> bool {
    project_identity(Some(left)) == project_identity(Some(right))
}

async fn running(handle: &SessionHandle) {
    turn(handle, "work", "op-turn").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
}

/// The session in its own managed worktree `feat`, with an uncommitted file there: the worktree's folder.
async fn in_worktree(served: &Served) -> PathBuf {
    let entered = served.hosted.workspaces.run(enter("feat", "w1"), ID, &CancellationToken::new()).await.expect("entered");
    let folder = PathBuf::from(entered["workspace"]["cwd"].as_str().expect("the worktree's folder"));
    std::fs::write(folder.join("wip.txt"), "unsaved\n").unwrap();
    folder
}

/// The managed worktrees as the worktree list shows them.
async fn listed(served: &Served) -> Vec<Value> {
    served.hosted.worktrees.list(None, &Keep, &CancellationToken::new()).await.expect("listed")
}

/// A move asked for while a turn runs is accepted and pending, the thread's state shows it, the turn keeps its folder, and
/// the move is carried out when the turn ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_during_a_turn_waits_for_it_to_end_and_the_turn_keeps_its_folder() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    running(&handle).await;

    assert_eq!(move_to(&served, &folders.b, 1).await.expect("accepted"), json!({}));
    assert_eq!(pending(&handle).map(|move_| move_["projectPath"].clone()), Some(json!(folders.b)));
    eventually_on!(&[&handle.cell.stepped], || shown(&handle).filter(|move_| move_["projectPath"] == folders.b.as_str()).map(drop)).await;
    assert!(same(&cwd(&handle), &folders.a), "the running turn keeps its folder: {}", cwd(&handle));
    assert!(handle.cell.run.load().is_some(), "the turn still runs");

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (pending(&handle).is_none() && same(&cwd(&handle), &folders.b)).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || shown(&handle).is_none().then_some(())).await;
    assert!(handle.header_snapshot().get(PROJECT_MOVE_FAILED).is_none());
}

/// Workspace reads published out of order around a move (the actor's own re-read finishes after the move's last publish):
/// whatever move a read carries, the published state shows the record's move as it is when the read is published.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_workspace_read_published_late_shows_the_records_move_not_its_own() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let early = CancellationToken::new();
    *locked(&served.late.read) = Some((json!({ "cwd": folders.a, "marker": "early" }), early.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    let published = |cwd: &str| {
        let workspace = handle.cell.view.load_full().state.workspace.clone();
        workspace.filter(|workspace| workspace["cwd"] == cwd)
    };
    running(&handle).await;
    move_to(&served, &folders.b, 1).await.expect("accepted");

    // The session's reads from before the move was asked for, published after it: the pending move still shows.
    early.cancel();
    eventually_on!(&[&handle.cell.stepped], || published(&folders.a).filter(|workspace| workspace["marker"] == "early").map(drop)).await;
    assert_eq!(shown(&handle).map(|move_| move_["projectPath"].clone()), Some(json!(folders.b)));

    // The re-read the move's new folder starts carries the move as a read made while it was pending, and answers only after
    // the carry, whose own last publish is the move's.
    let late = CancellationToken::new();
    let stale = json!({ "cwd": folders.a, "marker": "late", "pendingProjectMove": { "projectPath": folders.b, "requestedAt": 1 } });
    *locked(&served.late.read) = Some((stale, late.clone()));
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || {
        let carried = served.late.carried.load(std::sync::atomic::Ordering::SeqCst) == 1;
        (carried && pending(&handle).is_none() && same(&cwd(&handle), &folders.b)).then_some(())
    })
    .await;

    // Published last, the move it carries is gone from the record, so it does not show.
    late.cancel();
    eventually_on!(&[&handle.cell.stepped], || published(&folders.a).filter(|workspace| workspace["marker"] == "late").map(drop)).await;
    assert_eq!(shown(&handle), None, "the published workspace carries no move the record no longer has");
}

/// A second move asked for during the turn replaces the pending one; asking for the current Project cancels it, and the
/// session stays where it is once the turn ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_move_is_replaced_by_the_next_and_cancelled_by_the_current_project() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    running(&handle).await;

    move_to(&served, &folders.b, 1).await.expect("accepted");
    move_to(&served, &folders.c, 2).await.expect("replaced");
    assert_eq!(pending(&handle).map(|move_| move_["projectPath"].clone()), Some(json!(folders.c)));
    eventually_on!(&[&handle.cell.stepped], || shown(&handle).filter(|move_| move_["projectPath"] == folders.c.as_str()).map(drop)).await;

    move_to(&served, &folders.a, 3).await.expect("cancelled");
    assert_eq!(pending(&handle), None);
    eventually_on!(&[&handle.cell.stepped], || shown(&handle).is_none().then_some(())).await;

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    assert!(same(&cwd(&handle), &folders.a), "a cancelled move moves nothing: {}", cwd(&handle));
    assert_eq!(pending(&handle), None);
}

/// A move from the session's managed worktree returns to the project folder first, as the `git` tool's `return` does: the
/// worktree, its uncommitted file included, stays listed and kept by the session, and the session lands in the new Project.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_from_a_worktree_leaves_it_intact_and_listed() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let worktree = in_worktree(&served).await;
    assert!(worktree_id(&handle).is_some());

    assert_eq!(move_to(&served, &folders.b, 1).await.expect("moved"), json!({}));
    assert!(same(&cwd(&handle), &folders.b), "{}", cwd(&handle));
    assert_eq!(worktree_id(&handle), None);
    assert_eq!(std::fs::read_to_string(worktree.join("wip.txt")).unwrap(), "unsaved\n", "nothing is discarded");
    let rows = listed(&served).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(same(rows[0]["path"].as_str().unwrap_or_default(), &worktree.to_string_lossy()), "{rows:?}");
    assert_eq!(rows[0]["ownerSessionId"], ID, "the session still keeps it");
}

/// Return needs the branch checked out in the project folder; with that folder on a detached HEAD the return is refused, the
/// move answers its reason and nothing moves: the session stays in its worktree with its uncommitted file.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_whose_return_is_refused_reports_it_and_moves_nothing() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let worktree = in_worktree(&served).await;
    let bound = worktree_id(&handle);
    git(std::path::Path::new(&folders.a), &["checkout", "-q", "--detach"]);

    let refused = move_to(&served, &folders.b, 1).await.expect_err("the return is refused");
    assert!(matches!(&refused, CoreError::DomainError { message: Some(_), .. }), "{refused:?}");
    assert!(same(&cwd(&handle), &worktree.to_string_lossy()), "{}", cwd(&handle));
    assert_eq!(worktree_id(&handle), bound);
    assert_eq!(pending(&handle), None);
    assert_eq!(std::fs::read_to_string(worktree.join("wip.txt")).unwrap(), "unsaved\n");
    assert_eq!(listed(&served).await.len(), 1);
}

/// A move and a queued prompt an earlier process left are still there when the core starts again. Loading the session for a
/// read carries out the move, and nothing else: the restored prompt waits for the resume, as it would without the move, and
/// then runs in the new Project.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_pending_across_a_restart_is_carried_out_when_the_session_loads() {
    let (rig, folders) = (Rig::new(), folders());
    let first = SessionDirectory::new(rig.deps());
    let left = create(&rig, &first, &folders, json!({})).await;
    eventually_on!(&[&left.cell.stepped], || settled_idle(&left).then_some(())).await;
    drop(left);
    first.shutdown().await;
    let record = |record: Value| -> Record { serde_json::from_value(record).expect("a record") };
    let id = ThreadId::from(ID);
    let pending_move = json!({ "projectPath": folders.b, "requestedAt": 1 });
    rig.store.append_record(&id, record(json!({ "k": "meta", "change": { "inline": { "set": { "pendingProjectMove": pending_move }, "unset": [] } } })));
    let queued = json!({ "message": "after the restart", "enqueuedAt": 1, "priority": "next" });
    rig.store.append_record(&id, record(json!({ "k": "queue", "qid": "restored-1", "action": "enqueue", "entry": { "inline": queued } })));

    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = served.directory.open_handle(&id, &CallContext::internal("test")).await.expect("opened");
    eventually_on!(&[&handle.cell.stepped], || (pending(&handle).is_none() && same(&cwd(&handle), &folders.b)).then_some(())).await;
    assert!(handle.header_snapshot().get(PROJECT_MOVE_FAILED).is_none());
    caught_up(&handle).await;
    assert!(locked(&started).is_empty(), "the move starts no restored work");
    assert_eq!(handle.cell.queue.load().len(), 1, "the restored prompt is still queued");

    handle.cell.deliver(crate::session::control::Ctl::Resumed);
    eventually_on!(&[&handle.cell.stepped], || (!locked(&started).is_empty()).then_some(())).await;
    assert!(same(&locked(&started)[0], &folders.b), "{:?}", locked(&started));
    gate.notify_one();
}

/// A turn closes with a prompt queued behind it and a move asked for meanwhile: the move is carried out before the queue goes
/// on, so the queued prompt runs in the new Project, at the same settlement.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_asked_before_the_next_queued_prompt_is_carried_out_before_it() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    running(&handle).await;
    assert_eq!(turn(&handle, "next", "op-next").await["kind"], "queued");
    move_to(&served, &folders.b, 1).await.expect("accepted");

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 2).then_some(())).await;
    let seen = locked(&started).clone();
    assert!(same(&seen[0], &folders.a) && same(&seen[1], &folders.b), "{seen:?}");
    assert_eq!(pending(&handle), None);
    gate.notify_one();
}

/// A move asked for as a prompt is submitted to the idle session: whichever the actor takes first, the move is never refused,
/// nothing is lost, and the session ends in the new Project.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_raced_by_a_prompt_is_never_refused_and_is_carried_out() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;

    let moved = moving(&served, &folders.b, 1);
    let next = submitted(&handle, "now", "op-now");
    assert_eq!(moved.await.expect("joined").expect("never refused"), json!({}));
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 1).then_some(())).await;
    gate.notify_one();
    next.await.expect("joined");
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && pending(&handle).is_none() && same(&cwd(&handle), &folders.b)).then_some(())).await;
    assert!(handle.header_snapshot().get(PROJECT_MOVE_FAILED).is_none());
}

/// A start held back while one move is under way, with a second move recorded behind it: the start waits for both and runs in
/// the Project of the last.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_start_waits_for_every_recorded_move_and_runs_after_them() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let moves = held_moves(&served);

    let first = moving(&served, &folders.c, 1);
    eventually_on!(&[&handle.cell.stepped], || pending(&handle).map(drop)).await;
    let next = submitted(&handle, "held", "op-held");
    eventually_on!(&[&handle.cell.stepped], || handle.turn_busy().then_some(())).await;
    move_to(&served, &folders.b, 2).await.expect("recorded behind the move under way");
    caught_up(&handle).await;
    assert!(locked(&started).is_empty() && handle.cell.run.load().is_none(), "no turn starts while a move is recorded");

    moves.notify_one();
    assert_eq!(first.await.expect("joined").expect("moved"), json!({}));
    caught_up(&handle).await;
    assert!(locked(&started).is_empty(), "the start waits for the move recorded behind the first");
    moves.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 1).then_some(())).await;
    assert!(same(&locked(&started)[0], &folders.b), "{:?}", locked(&started));
    assert_eq!(pending(&handle), None);
    gate.notify_one();
    next.await.expect("joined");
}

/// From an idle managed worktree, the return and the switch are one transition: a prompt from a second window sent while the
/// move is under way starts only once the session is in the new Project, the worktree kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_sent_during_a_move_out_of_a_worktree_starts_in_the_new_project() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let worktree = in_worktree(&served).await;
    let moves = held_moves(&served);

    let moved = moving(&served, &folders.b, 1);
    eventually_on!(&[&handle.cell.stepped], || pending(&handle).map(drop)).await;
    let next = submitted(&handle, "second window", "op-second");
    eventually_on!(&[&handle.cell.stepped], || handle.turn_busy().then_some(())).await;
    caught_up(&handle).await;
    assert!(locked(&started).is_empty(), "no turn starts while the move is under way");

    moves.notify_one();
    assert_eq!(moved.await.expect("joined").expect("moved"), json!({}));
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 1).then_some(())).await;
    assert!(same(&locked(&started)[0], &folders.b), "{:?}", locked(&started));
    assert_eq!(worktree_id(&handle), None);
    assert_eq!(std::fs::read_to_string(worktree.join("wip.txt")).unwrap(), "unsaved\n");
    assert_eq!(listed(&served).await.len(), 1);
    gate.notify_one();
    next.await.expect("joined");
}

/// Two windows on one session, a turn running: a move asked for reaches both subscribed clients as a workspace update that
/// carries it, and its end reaches them as one without it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_subscribed_client_is_told_of_a_pending_move_and_its_end() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let (one, _one_feed, _) = subscribed(&handle, 1, "one").await;
    let (two, _two_feed, _) = subscribed(&handle, 2, "two").await;
    running(&handle).await;

    move_to(&served, &folders.b, 1).await.expect("accepted");
    for client in [&one, &two] {
        let told =
            crate::session::testing::awaiting(|| "the pending move notified".to_owned(), workspace_note(client, |ws| ws.get(PENDING_PROJECT_MOVE).is_some()))
                .await;
        assert_eq!(told[PENDING_PROJECT_MOVE]["projectPath"], json!(folders.b));
    }

    gate.notify_one();
    for client in [&one, &two] {
        let told =
            crate::session::testing::awaiting(|| "the move's end notified".to_owned(), workspace_note(client, |ws| ws.get(PENDING_PROJECT_MOVE).is_none()))
                .await;
        assert!(told.get(PROJECT_MOVE_FAILED).is_none(), "{told}");
    }
    eventually_on!(&[&handle.cell.stepped], || same(&cwd(&handle), &folders.b).then_some(())).await;
}

/// A session in a plain folder (no Git workspace) whose pending move fails at settlement keeps the failure on its record; once
/// unloaded and opened again, the snapshot a client subscribes to still shows it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_move_of_a_plain_folder_session_shows_after_it_is_opened_again() {
    let (rig, folders) = (Rig::new(), folders());
    let first = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let handle = create_in(&rig, &first.directory, ID, &folders.b, json!({})).await;
    running(&handle).await;
    move_to(&first, &folders.c, 1).await.expect("accepted");
    std::fs::remove_dir_all(&folders.c).unwrap();

    gate.notify_one();
    let failed = |handle: &SessionHandle| handle.header_snapshot().get(PROJECT_MOVE_FAILED).cloned();
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && pending(&handle).is_none()).then(|| failed(&handle)).flatten().map(drop)).await;
    assert_eq!(failed(&handle).map(|failure| failure["projectPath"].clone()), Some(json!(folders.c)));
    assert!(same(&cwd(&handle), &folders.b));
    drop(handle);
    first.directory.shutdown().await;

    let reopened = served(&rig, &folders).await;
    let handle = reopened.directory.open_handle(&ThreadId::from(ID), &CallContext::internal("test")).await.expect("opened");
    let shown_failure =
        |handle: &SessionHandle| handle.cell.view.load_full().state.workspace.as_ref().and_then(|workspace| workspace.get(PROJECT_MOVE_FAILED)).cloned();
    eventually_on!(&[&handle.cell.stepped], || shown_failure(&handle).map(drop)).await;
    let (_client, _feed, snapshot) = subscribed(&handle, 1, "client").await;
    assert_eq!(found(&snapshot, PROJECT_MOVE_FAILED).map(|failure| failure["projectPath"].clone()), Some(json!(folders.c)), "{snapshot}");
}

/// A fork copies neither the move its source asked for nor the failure its source keeps, and loading the heir moves nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fork_takes_neither_its_sources_pending_move_nor_its_failure() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let failure = json!({ "projectPath": folders.c, "message": "gone", "at": 1 });
    let handle = create(&rig, &served.directory, &folders, json!({ "projectMoveFailed": failure })).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    // A fork carries a conversation: one without any is refused.
    let messages = json!([{ "role": "user", "content": "hello" }, { "role": "assistant", "content": "hi" }]);
    let append = mixdog_core_api::call::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/inheritedRows/append"),
        params: json!({ "messages": messages }),
        op: None,
        ctx: CallContext::internal("test"),
    };
    handle.request(append).await.expect("the conversation is appended");
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let fork = |op: &'static str| {
        let handle = handle.clone();
        async move {
            let Reply::Value(fork) = handle.request(session_request("thread/fork", json!({ "threadId": ID, "opId": op }), op)).await.expect("fork") else {
                panic!("a fork answers its heir")
            };
            ThreadId::from(fork["thread"]["id"].as_str().expect("the heir's id"))
        }
    };
    let carries = |heir: &SessionHandle| PROJECT_MOVE_KEYS.into_iter().filter(|key| heir.header_snapshot().contains_key(*key)).count();

    let failed_heir = served.directory.open_handle(&fork("fork-failed").await, &CallContext::internal("test")).await.expect("opened");
    assert_eq!(carries(&failed_heir), 0);

    let moves = held_moves(&served);
    let moved = moving(&served, &folders.b, 1);
    eventually_on!(&[&handle.cell.stepped], || pending(&handle).map(drop)).await;
    let heir = served.directory.open_handle(&fork("fork-pending").await, &CallContext::internal("test")).await.expect("opened");
    caught_up(&heir).await;
    assert_eq!(carries(&heir), 0);
    let made = cwd(&heir);
    moves.notify_one();
    moved.await.expect("joined").expect("moved");
    caught_up(&heir).await;
    assert_eq!(cwd(&heir), made, "the heir stays where the fork placed it");
    assert_eq!(carries(&heir), 0);
    assert!(same(&cwd(&handle), &folders.b));
}

/// A session working in a managed worktree another session owns moves, and the switch fails once it left the worktree: the
/// session is back in that worktree, the owner's worktree intact, and a later move goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_move_puts_the_session_back_in_the_worktree_it_left() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let owner = create_in(&rig, &served.directory, "sess_owner", &folders.a, json!({})).await;
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && settled_idle(&owner)).then_some(())).await;
    let cancel = CancellationToken::new();
    let entered = served.hosted.workspaces.run(enter("feat", "w1"), "sess_owner", &cancel).await.expect("the owner entered");
    let branch = entered["workspace"]["branch"].as_str().expect("the worktree's branch").to_owned();
    let input = SelectBranch { branch, tx_id: "select".into(), ..SelectBranch::default() };
    served.hosted.workspaces.select_branch(ID, input, false, &cancel).await.expect("selected the owner's branch");
    let bound = worktree_id(&handle);
    assert!(bound.is_some() && bound == worktree_id(&owner), "{bound:?}");
    let folder = cwd(&handle);

    served.hosted.workspaces.fail_next_project_switch(ScmFailure::git("the switch failed"));
    move_to(&served, &folders.b, 1).await.expect_err("the switch fails");
    assert_eq!(worktree_id(&handle), bound, "back in the worktree it left");
    assert!(same(&cwd(&handle), &folder), "{}", cwd(&handle));
    let rows = listed(&served).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["ownerSessionId"], "sess_owner");

    assert_eq!(move_to(&served, &folders.b, 2).await.expect("moved"), json!({}));
    assert!(same(&cwd(&handle), &folders.b));
    assert_eq!(worktree_id(&owner), bound, "the owner keeps its worktree");
}

fn begun(served: &Served) -> usize {
    served.late.begun.load(std::sync::atomic::Ordering::SeqCst)
}

fn recorded_failure(handle: &SessionHandle) -> Option<Value> {
    handle.header_snapshot().get(PROJECT_MOVE_FAILED).cloned()
}

/// The Project the record's pending move asks for.
fn pending_project(handle: &SessionHandle) -> String {
    pending(handle).and_then(|move_| move_["projectPath"].as_str().map(str::to_owned)).unwrap_or_default()
}

/// The Project the session was in, asked for while a move out of it is being carried out, is a request like any other: the
/// carry under way ends where it went, and the session is then carried back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_during_a_carry_carries_the_session_back() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let moves = held_moves(&served);

    let moved = moving(&served, &folders.b, 1);
    eventually_on!(&[&handle.cell.stepped], || (begun(&served) == 1).then_some(())).await;
    assert_eq!(move_to(&served, &folders.a, 2).await.expect("recorded behind the carry"), json!({}));
    assert!(same(&pending_project(&handle), &folders.a), "{:?}", pending(&handle));

    moves.notify_one();
    assert_eq!(moved.await.expect("joined").expect("the carry under way ends where it went"), json!({}));
    assert!(same(&cwd(&handle), &folders.b), "{}", cwd(&handle));
    moves.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && pending(&handle).is_none() && same(&cwd(&handle), &folders.a)).then_some(())).await;
    assert_eq!(begun(&served), 2, "one carry there, one back");
    assert_eq!(recorded_failure(&handle), None);
    eventually_on!(&[&handle.cell.stepped], || shown(&handle).is_none().then_some(())).await;
}

/// A carry that fails after its request was replaced leaves no failure on the record: the result is that request's, and the
/// record asks for another Project by then. The session never left that Project, so nothing is carried out for it either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_of_a_replaced_request_is_not_recorded() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let gate = held_turns(&rig);
    let handle = create_in(&rig, &served.directory, ID, &folders.b, json!({})).await;
    running(&handle).await;
    move_to(&served, &folders.c, 1).await.expect("accepted");
    std::fs::remove_dir_all(&folders.c).unwrap();
    let moves = held_moves(&served);

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (begun(&served) == 1).then_some(())).await;
    move_to(&served, &folders.b, 2).await.expect("recorded behind the carry");
    assert!(same(&pending_project(&handle), &folders.b), "{:?}", pending(&handle));

    moves.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled_idle(&handle) && pending(&handle).is_none()).then_some(())).await;
    assert_eq!(recorded_failure(&handle), None, "the failed carry's request was no longer the wanted one");
    assert!(same(&cwd(&handle), &folders.b), "{}", cwd(&handle));
    assert_eq!(begun(&served), 1, "the session is where it is wanted: nothing more is carried out");
}

/// A move whose record cannot be saved was never accepted: the request answers the failure, and neither the record nor the
/// workspace the state shows carries it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_whose_record_is_not_saved_is_not_shown() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let _gate = held_turns(&rig);
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    running(&handle).await;
    caught_up(&handle).await;

    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    move_to(&served, &folders.b, 1).await.expect_err("the record is not saved");
    caught_up(&handle).await;
    assert_eq!(pending(&handle), None);
    assert_eq!(shown(&handle), None, "a move that was not recorded is not shown");
}

/// A move being carried out holds the session as a running turn does: a prompt sent meanwhile is queued and shown queued, a
/// compaction and a rewind are refused as during a turn, and the prompt runs in the new Project once the move ended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_carry_holds_the_session_as_a_running_turn_does() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let moves = held_moves(&served);

    let moved = moving(&served, &folders.b, 1);
    eventually_on!(&[&handle.cell.stepped], || (begun(&served) == 1).then_some(())).await;
    assert_eq!(turn(&handle, "during the move", "op-during").await["kind"], "queued");
    // The prompt waits as a queued row.
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1).then_some(())).await;

    let compact = session_request("thread/compact/start", json!({ "threadId": ID, "opId": "op-compact" }), "op-compact");
    let Reply::Value(compacted) = handle.request(compact).await.expect("answered") else { panic!("a compaction answers a value") };
    assert_eq!(compacted["changed"], false, "{compacted}");
    assert!(!handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst), "no compaction begins during the move");
    let rewind = session_request("thread/rewind", json!({ "threadId": ID, "opId": "op-rewind", "itemId": "item_none" }), "op-rewind");
    let refused = handle.request(rewind).await.err().expect("a rewind is refused during the move");
    assert!(matches!(refused, CoreError::PreconditionFailed { .. }), "{refused:?}");
    assert!(locked(&started).is_empty(), "no turn starts while the move is under way");

    moves.notify_one();
    assert_eq!(moved.await.expect("joined").expect("moved"), json!({}));
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 1).then_some(())).await;
    assert!(same(&locked(&started)[0], &folders.b), "{:?}", locked(&started));
    gate.notify_one();
}

/// The session is closed while a move asked of it, a client attached, is being carried out: the close waits for the move
/// as for a turn, and the move that answers success is off the record.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_during_a_carry_waits_for_it_and_the_moved_session_keeps_no_pending_move() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let (_client, _feed, _) = subscribed(&handle, 1, "client").await;
    let moves = held_moves(&served);

    let moved = moving(&served, &folders.b, 1);
    eventually_on!(&[&handle.cell.stepped], || (begun(&served) == 1).then_some(())).await;
    let (taken, mut took) = tokio::sync::oneshot::channel();
    handle.cell.deliver(crate::session::control::Ctl::Closed(taken));
    caught_up(&handle).await;
    assert!(took.try_recv().is_err(), "the close waits for the move");

    moves.notify_one();
    assert_eq!(moved.await.expect("joined").expect("moved"), json!({}));
    assert_eq!(pending(&handle), None, "a move that answered success left nothing pending");
    assert!(same(&cwd(&handle), &folders.b), "{}", cwd(&handle));
    took.await.expect("the close is answered once the move ended");
}

/// A prompt sent while a move is recorded and not yet carried out (a manual compaction runs) is a queued row. Cancelling the
/// move during the compaction releases nothing: the prompt starts once the compaction ended, where the session stayed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_queued_behind_a_recorded_move_is_held_through_a_compaction_when_the_move_is_cancelled() {
    let (rig, folders) = (Rig::new(), folders());
    let served = served(&rig, &folders).await;
    let (gate, started) = held_turns_seen(&rig, Some(served.directory.clone()));
    let handle = create(&rig, &served.directory, &folders, json!({})).await;
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let hold = Arc::new(Notify::new());
    *locked(&rig.compaction.hold) = Some(hold.clone());
    let compacting = {
        let handle = handle.clone();
        let compact = session_request("thread/compact/start", json!({ "threadId": ID, "opId": "op-compact" }), "op-compact");
        tokio::spawn(async move { handle.request(compact).await })
    };
    eventually_on!(&[&handle.cell.stepped], || handle.cell.compacting.load(std::sync::atomic::Ordering::SeqCst).then_some(())).await;

    move_to(&served, &folders.b, 1).await.expect("recorded behind the compaction");
    assert!(same(&pending_project(&handle), &folders.b), "{:?}", pending(&handle));
    assert_eq!(turn(&handle, "behind the move", "op-behind").await["kind"], "queued");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 1).then_some(())).await;

    move_to(&served, &folders.a, 2).await.expect("cancelled");
    caught_up(&handle).await;
    assert_eq!(pending(&handle), None);
    assert!(locked(&started).is_empty(), "the cancel releases nothing during the compaction");
    assert_eq!(begun(&served), 0, "a cancelled move is not carried out");

    hold.notify_one();
    compacting.await.expect("joined").expect("compacted");
    eventually_on!(&[&handle.cell.stepped], || (locked(&started).len() == 1).then_some(())).await;
    assert!(same(&locked(&started)[0], &folders.a), "{:?}", locked(&started));
    gate.notify_one();
}
