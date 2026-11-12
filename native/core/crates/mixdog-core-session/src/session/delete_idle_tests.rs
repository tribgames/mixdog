//! The idle delete's refusals against `fixtures/delete-idle/golden.json`, recorded by
//! `record-delete-idle.mjs` from the real service call over the real turn gate and runtime delete
//! (`session-action.mjs` `deleteIdleSession`, `session-delete.mjs` `deleteSessionIfIdle`): each
//! situation that raises a reason there is built here from the thread's state, and the reply is
//! the recorded one.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::delete::Live;
use super::delete::live_refusal;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::lock;
use crate::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/delete-idle/golden.json")).expect("golden.json")
}

/// The recorded idle-delete case `name`.
pub(super) fn recorded(name: &str) -> Value {
    golden()["idle"].as_array().expect("idle").iter().find(|case| case["name"] == name).cloned().expect("a recorded case")
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
    }
}

/// One thread whose first turn waits for `release`, over a store that lists it.
struct World {
    rig: Rig,
    directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    release: Arc<tokio::sync::Notify>,
}

async fn world() -> World {
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let release: Arc<tokio::sync::Notify> = Arc::default();
    let gate = release.clone();
    rig.set_script(Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            gate.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    World { rig, directory, handle, release }
}

impl World {
    /// The desktop's archive and favorite marks are the session's header fields.
    async fn flags(&self, archived: bool, favorite: bool) {
        let (mut set, mut unset) = (serde_json::Map::new(), Vec::new());
        for (key, on) in [("archivedAt", archived), ("favoriteAt", favorite)] {
            if on {
                set.insert(key.into(), json!(1_793_306_570_000_i64));
            } else {
                unset.push(key);
            }
        }
        let params = json!({ "threadId": self.handle.id, "set": set, "unset": unset });
        self.handle
            .request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") })
            .await
            .expect("patch");
    }

    /// `thread/delete {threadId: target, ifIdle: expected}`.
    async fn ask(&self, target: &str, expected: Value) -> Value {
        match self
            .handle
            .request(request("thread/delete", json!({ "threadId": target, "opId": "op-d", "ifIdle": expected }), "op-d"))
            .await
            .expect("delete")
        {
            Reply::Value(value) => value,
            other => panic!("{other:?}"),
        }
    }

    /// A completion wakes the thread: its turn runs, until `release`.
    async fn wake(&self) {
        self.handle
            .inbox
            .send(super::actor::Inbox::TaskNotification {
                surface: "agent".into(),
                task_id: "task_agent_1".into(),
                status: "failed".into(),
                text: "failed".into(),
                origin: None,
                live: true,
                durable: None,
            })
            .await
            .expect("the actor runs");
        eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_some().then_some(())).await;
    }

    /// The thread's turn runs, until `release`.
    async fn run_turn(&self) {
        turn(&self.handle, "work", "op-turn").await;
        eventually_on!(&[&self.handle.cell.stepped], || self.handle.cell.run.load().is_some().then_some(())).await;
    }
}

/// The live state the recorded case `name` built in Node, for the situations only that state holds.
fn live_of(name: &str) -> Option<Live> {
    match name {
        "turn-waiting" => Some(Live { turn_pending: true, ..Live::default() }),
        "busy-unsettled" => Some(Live { turn_running: true, ..Live::default() }),
        "queued-pending" => Some(Live { queued: true, ..Live::default() }),
        _ => None,
    }
}

/// What Rust answers in the situation the recorded case `name` built in Node.
async fn replay(name: &str, world: &World) -> Value {
    let id = world.handle.id.as_str().to_owned();
    let used = world.directory.session_meta(&world.handle.id).await.expect("meta").expect("listed").last_used_at;
    let (same, stale) = (json!({ "lastUsedAt": used }), json!({ "lastUsedAt": used - 1.0 }));
    let gate = world.directory.turn_gate().clone();
    match name {
        "no-target" => {
            world.flags(true, false).await;
            json!({ "reply": world.ask("", same).await })
        }
        "bad-id" => {
            world.flags(true, false).await;
            json!({ "reply": world.ask("bad id", same).await })
        }
        "turn-starting-admitted" => {
            world.flags(true, false).await;
            let admitted = gate.enter(&world.handle.id).expect("open to starts");
            let reply = world.ask(&id, stale.clone()).await;
            drop(admitted);
            json!({ "reply": reply, "afterwards": world.ask(&id, stale).await })
        }
        "turn-starting-fenced" => {
            world.flags(true, false).await;
            // The running idle delete holds the fence; a start of the thread is refused meanwhile.
            let fence = gate.fence(&world.handle.id).expect("not being admitted");
            let reply = world.ask(&id, stale.clone()).await;
            let late = world
                .handle
                .request(request("turn/start", json!({ "threadId": id, "opId": "op-late", "input": { "prompt": "late" } }), "op-late"))
                .await;
            assert!(matches!(late, Err(CoreError::ThreadClosing { .. })), "a start while the thread is fenced is refused: {late:?}");
            drop(fence);
            json!({ "reply": reply, "firstReply": world.ask(&id, stale).await })
        }
        "unguarded" => {
            world.flags(true, false).await;
            *lock(&world.rig.deletes.4) = true;
            json!({ "reply": world.ask(&id, same).await })
        }
        "current" => {
            world.flags(true, false).await;
            *lock(&world.rig.deletes.3) = Some(id.clone());
            json!({ "reply": world.ask(&id, same).await })
        }
        // A running turn holds the ask lock, which is taken before the archive flag is read.
        "busy-lock-archived" | "busy-lock-not-archived" => {
            world.flags(name == "busy-lock-archived", false).await;
            world.run_turn().await;
            let reply = world.ask(&id, same).await;
            world.release.notify_one();
            eventually_on!(&[&world.handle.cell.stepped], || idle(&world.handle).then_some(())).await;
            json!({ "reply": reply })
        }
        // A turn in flight that holds no ask lock: Rust wakes the idle thread for a completion with a turn Node would not
        // run (it wakes only its current session), so the archive flag is read first and the turn still makes it busy.
        "in-flight-archived" | "in-flight-not-archived" => {
            world.flags(name == "in-flight-archived", false).await;
            world.wake().await;
            let reply = world.ask(&id, same).await;
            world.release.notify_one();
            eventually_on!(&[&world.handle.cell.stepped], || idle(&world.handle).then_some(())).await;
            json!({ "reply": reply })
        }
        "not-archived" => {
            world.flags(false, false).await;
            json!({ "reply": world.ask(&id, same).await })
        }
        // No such session: the app server hands the delete to the directory, which cannot open the
        // thread (`threadNotFound` there is Node's `not-archived`, the id has no mark).
        "unknown-session" => {
            let reply = match world
                .directory
                .request(request("thread/delete", json!({ "threadId": "sess_never_made", "opId": "op-d", "ifIdle": same }), "op-d"))
                .await
                .expect("delete")
            {
                Reply::Value(value) => value,
                other => panic!("{other:?}"),
            };
            json!({ "reply": reply })
        }
        "favorite" => {
            world.flags(true, true).await;
            json!({ "reply": world.ask(&id, same).await })
        }
        "queued-hosted" => {
            world.flags(true, false).await;
            *lock(&world.rig.deletes.5) = true;
            json!({ "reply": world.ask(&id, same).await })
        }
        "missing" => {
            world.flags(true, false).await;
            world.rig.store.listed.store(false, SeqCst);
            json!({ "reply": world.ask(&id, same).await })
        }
        "changed" => {
            world.flags(true, false).await;
            json!({ "reply": world.ask(&id, stale).await })
        }
        // The thread's actor ends as it takes the close: the close cannot be carried out. (An actor that has ended leaves no
        // slot behind, so a later close opens the thread again.)
        "close-failed" => {
            world.handle.inbox.send(super::actor::Inbox::Unwind(super::actor::UnwindAt::Delete)).await.expect("the actor runs");
            // The patch is answered after the actor took the unwind's message (one inbox, in order).
            world.flags(true, false).await;
            let reply = world.ask(&id, same).await;
            json!({ "reply": reply })
        }
        other => panic!("no Rust situation for the recorded case {other}"),
    }
}

/// Every reason of `deleteSessionIfIdle` and of its service call, in the situation that raises it in Node,
/// answers the recorded `{deleted: false, reason}` and deletes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_refusal_of_the_idle_delete_is_nodes() {
    let golden = golden();
    let cases = golden["idle"].as_array().expect("idle");
    let mut replayed = 0;
    for case in cases {
        let name = case["name"].as_str().expect("name");
        // The deletion itself runs over the real store (`an_idle_delete_refuses_as_node_does_...`).
        if name == "deleted" {
            continue;
        }
        // The states the actor publishes for the turn about to start, the turn not settled yet and
        // input in the thread's own queue are not held by anything a test can reach in a loaded
        // thread: their checks are replayed on the state they read.
        if let Some(live) = live_of(name) {
            assert_eq!(live_refusal(&live), case["reply"]["reason"].as_str(), "{name}");
            replayed += 1;
            continue;
        }
        let world = world().await;
        let out = replay(name, &world).await;
        for key in ["reply", "afterwards", "firstReply"] {
            if case.get(key).is_some() {
                assert_eq!(out[key], case[key], "{name}: {key}");
            }
        }
        assert!(lock(&world.rig.deletes.0).is_empty(), "{name}: a refusal deletes nothing");
        replayed += 1;
    }
    assert_eq!(replayed, cases.len() - 1);
}

/// The paths that start a turn behind Node's ask lock besides a submit — an approval answer that
/// resumes it (`approveSession`) and a materialization for a Goal or quota resume
/// (`materializeSession`) — are admitted starts: refused while an idle delete fences the thread, and
/// they hold the idle delete off (`turn-starting`) while they run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approval_answers_and_materializations_pass_the_turn_gate() {
    use mixdog_core_api::ids::ServerRequestId;
    use mixdog_core_api::thread::Decision;
    use mixdog_protocol::ConnectionKind;

    let world = world().await;
    let gate = world.directory.turn_gate().clone();
    let decision = || Decision {
        request: ServerRequestId("srv_1".into()),
        connection: ConnectionId(1),
        device: "desktop-1".into(),
        connection_kind: ConnectionKind::Desktop,
        origin: mixdog_protocol::Origin::Local,
        result: json!({ "approved": true }),
    };
    let ctx = CallContext::internal("test");
    let fence = gate.fence(&world.handle.id).expect("not being admitted");
    assert!(matches!(world.handle.decide(decision()), Err(CoreError::ThreadClosing { .. })), "an answer is refused while fenced");
    assert!(matches!(world.directory.open_admitted(&world.handle.id, &ctx).await, Err(CoreError::ThreadClosing { .. })), "so is a materialization");
    drop(fence);
    assert!(!matches!(world.handle.decide(decision()), Err(CoreError::ThreadClosing { .. })), "an answer is admitted once the fence is gone");
    world.directory.open_admitted(&world.handle.id, &ctx).await.expect("materialized");
    // Neither leaves an admission behind.
    drop(gate.fence(&world.handle.id).expect("none is being admitted"));
}

/// Goal recovery's materialization (`recoverActiveGoals` -> `materializeSession`) is an admitted
/// start too: refused (a failed session of the summary, as Node's `SessionClosedError` is) while an
/// idle delete fences the thread, and resumed once it is open again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_recovery_materializes_through_the_turn_gate() {
    use mixdog_core_goal::goal::recovery::RecoverySource;
    use mixdog_core_goal::goal::recovery::StoredGoals;

    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let data = tempfile::tempdir().expect("data dir");
    let stored = StoredGoals::new(data.path().to_string_lossy().into_owned(), mixdog_rt::testing::tokens().durability_io);
    let recovery = super::goal_recovery_host::SessionGoalRecovery::new(directory.clone(), stored, Arc::new(|_: &str| {}));
    let fence = directory.turn_gate().fence(&handle.id).expect("not being admitted");
    assert!(recovery.materialize_session(handle.id.as_str()).await.is_err(), "refused while an idle delete fences the thread");
    drop(fence);
    recovery.materialize_session(handle.id.as_str()).await.expect("materialized");
    drop(directory.turn_gate().fence(&handle.id).expect("no admission is left behind"));
}

/// Another idle delete's fence and a start in its intake each keep the idle delete from closing the
/// thread, and the thread takes starts again once they end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_turn_gate_admits_and_fences_a_threads_starts() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let gate = directory.turn_gate().clone();
    let (one, other) = (mixdog_core_api::ids::ThreadId::from("sess_one"), mixdog_core_api::ids::ThreadId::from("sess_other"));
    let admitted = gate.enter(&one).expect("open");
    assert!(gate.fence(&one).is_none(), "a start is being admitted");
    drop(admitted);
    let fence = gate.fence(&one).expect("none is being admitted");
    assert!(gate.fence(&one).is_none(), "already fenced");
    assert!(gate.enter(&one).is_none(), "a fenced thread takes no start");
    drop(gate.enter(&other).expect("other threads start as usual"));
    drop(fence);
    drop(gate.enter(&one).expect("reopened"));
}
