//! The idle delete's refusals: each situation that raises a reason is built from the thread's state, and the reply names it.

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
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;
use crate::eventually_on;

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
        self.handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
    }

    /// `thread/delete {threadId: target, ifIdle: expected}`.
    async fn ask(&self, target: &str, expected: Value) -> Value {
        match self.handle.request(request("thread/delete", json!({ "threadId": target, "opId": "op-d", "ifIdle": expected }), "op-d")).await.expect("delete") {
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
                hop: 0,
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

/// The live state the case `name` builds, for the situations only that state holds.
fn live_of(name: &str) -> Option<Live> {
    match name {
        "turn-waiting" => Some(Live { turn_pending: true, ..Live::default() }),
        "busy-unsettled" => Some(Live { turn_running: true, ..Live::default() }),
        "queued-pending" => Some(Live { queued: true, ..Live::default() }),
        _ => None,
    }
}

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

// ---- the retention's admission is the session actor's ------------------------------------------------------------------------

impl World {
    fn activity(&self) -> f64 {
        super::sub_agent_retention::activity_at(&self.handle.cell.header.load())
    }

    /// A subscriber attaches (the counting `FeedSource::attach` does around the feed).
    fn subscribe(&self) {
        assert!(self.handle.cell.subscribing());
        self.handle.cell.subscribed(true);
    }
}

/// A subscriber that attaches after the pass judged the session but before its delete is admitted refuses the delete; the user's
/// own delete (no `ifIdle`) is not subject to it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subscriber_attaching_after_the_judgment_refuses_the_retention_delete_and_not_the_users() {
    let world = world().await;
    world.flags(true, false).await;
    let id = world.handle.id.as_str().to_owned();
    let used = world.directory.session_meta(&world.handle.id).await.expect("meta").expect("listed").last_used_at;
    let expected = json!({ "lastUsedAt": used, "activity": world.activity() });
    world.subscribe();
    let reply = world.ask(&id, expected).await;
    assert_eq!(reply["deleted"], json!(false), "{reply}");
    assert!(lock(&world.rig.deletes.0).is_empty(), "nothing deleted");
    let user = world.handle.request(request("thread/delete", json!({ "threadId": id, "opId": "op-user" }), "op-user")).await.expect("delete");
    assert!(matches!(user, Reply::Value(Value::Bool(true))), "the user's delete stands: {user:?}");
}

/// The user restores the session while the retention's delete waits between its archive judgment and its admission (no
/// activity moved, nobody attached): the delete is refused against the entry it judged, and the restored session stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_after_the_judgment_refuses_the_retention_delete() {
    let world = world().await;
    world.flags(true, false).await;
    let id = world.handle.id.as_str().to_owned();
    let used = world.directory.session_meta(&world.handle.id).await.expect("meta").expect("listed").last_used_at;
    let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
    let (go, go_rx) = tokio::sync::oneshot::channel();
    super::delete::JUDGED_HOLDS.lock().unwrap().push((id.clone(), arrived_tx, go_rx));
    let restore = async {
        arrived.await.expect("the delete judged");
        let header = world.handle.cell.header.load_full();
        assert!(world.directory.mark_archived(&id, &header, super::archive_trees::Mark::Restore).await.expect("restored"));
        go.send(()).expect("the delete waits");
    };
    let (reply, ()) = tokio::join!(world.ask(&id, json!({ "lastUsedAt": used })), restore);
    assert_eq!(reply, json!({ "deleted": false, "reason": "changed" }));
    assert!(world.directory.is_open(&world.handle.id), "the session stays");
    assert!(!world.rig.archive.resolve(&id, world.handle.cell.header.load().get("archivedAt")).archived(), "restored");
}

/// A deleted bot's archived home chat deleted again takes the bot's definition for good (`deleteSessionLocked`); a home chat of a
/// bot that still exists is only deleted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deleting_a_retired_bots_home_chat_purges_the_bot() {
    let world = world().await;
    for (agent, retired) in [("probe", true), ("kept", false)] {
        let id = mixdog_core_base::rooms::ids::agent_home_session_id(agent).expect("a home session id");
        let mut header = serde_json::Map::new();
        header.insert("cwd".into(), json!("/ws"));
        if retired {
            header.insert("retiredAt".into(), json!(1_793_306_570_000_i64));
        }
        world.directory.create_with_id(mixdog_core_api::ids::ThreadId::from(id.clone()), header, json!({})).await.expect("home chat");
        let handle = world.directory.handle(&mixdog_core_api::ids::ThreadId::from(id.clone())).expect("loaded");
        handle.request(request("thread/delete", json!({ "threadId": id, "opId": "op-del" }), "op-del")).await.expect("delete");
    }
    let steps = lock(&world.rig.deletes.0).clone();
    assert!(steps.contains(&"purgeAgentDefinition:probe".to_owned()), "{steps:?}");
    assert!(!steps.iter().any(|step| step == "purgeAgentDefinition:kept"), "{steps:?}");
}

/// The user favorites the session while the idle delete waits between its judgment and its admission: the delete rereads the
/// flag at its close and refuses, and the favorite stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_favorite_after_the_judgment_refuses_the_idle_delete() {
    let world = world().await;
    world.flags(true, false).await;
    let id = world.handle.id.as_str().to_owned();
    let used = world.directory.session_meta(&world.handle.id).await.expect("meta").expect("listed").last_used_at;
    let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
    let (go, go_rx) = tokio::sync::oneshot::channel();
    super::delete::JUDGED_HOLDS.lock().unwrap().push((id.clone(), arrived_tx, go_rx));
    let favorite = async {
        arrived.await.expect("the delete judged");
        world.flags(true, true).await;
        go.send(()).expect("the delete waits");
    };
    let (reply, ()) = tokio::join!(world.ask(&id, json!({ "lastUsedAt": used })), favorite);
    assert_eq!(reply, json!({ "deleted": false, "reason": "favorite" }));
    assert!(world.directory.is_open(&world.handle.id), "the session stays");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_favorite_accepted_but_not_yet_saved_refuses_the_idle_delete() {
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;
    let world = world().await;
    world.flags(true, false).await;
    let id = world.handle.id.as_str().to_owned();
    let used = world.directory.session_meta(&world.handle.id).await.expect("meta").expect("listed").last_used_at;
    let (saving, save) = world
        .rig
        .store
        .hold_record(|record| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.set.contains_key("favoriteAt"))));
    let params = json!({ "threadId": world.handle.id, "expect": { "favoriteAt": null }, "set": { "favoriteAt": 1_793_306_570_000_i64 }, "unset": [] });
    let favorite = world.handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("thread-settings") });
    tokio::pin!(favorite);
    tokio::select! {
        answered = &mut favorite => panic!("the favorite was answered past the gate: {answered:?}"),
        () = saving.notified() => {}
    }
    // Inside the interval: accepted, its save held at the store, not yet shown.
    assert!(!super::delete::sidebar_flag(&world.handle.cell.header.load(), "favoriteAt"), "the shown header waits for the save");
    assert!(!super::delete::sidebar_flag(&world.rig.store.stored_header(&world.handle.id).expect("stored"), "favoriteAt"), "nothing is durable yet");
    let reply = world.ask(&id, json!({ "lastUsedAt": used })).await;
    save.send(()).expect("the save waits");
    let answered = favorite.await.expect("the favorite is saved");
    assert!(matches!(&answered, Reply::Value(value) if value.get("conflict").is_none()), "{answered:?}");
    assert_eq!(reply, json!({ "deleted": false, "reason": "favorite" }));
    assert!(world.directory.is_open(&world.handle.id), "the session stays");
    assert!(super::delete::sidebar_flag(&world.handle.cell.header.load(), "favoriteAt"), "the favorite is kept");
}

/// After the archive entries were lost (the state database was set aside), an archive only a header still states is not one the
/// retention may act on (`trusted`, which the idle delete and the pass's archive stamp ask): it may be a restore the user made.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_header_archive_after_the_entries_were_lost_is_not_trusted() {
    let world = world().await;
    world.flags(true, false).await;
    mixdog_store::archive_state::ArchiveStates::mark_lost(&world.rig.state).await.expect("marked");
    let lost = mixdog_store::archive_state::ArchiveStates::open(world.rig.state.clone()).await.expect("opened");
    assert!(lost.snapshot().lost());
    let header = world.handle.cell.header.load_full();
    let state = lost.resolve(world.handle.id.as_str(), header.get("archivedAt"));
    assert!(state.archived() && !state.trusted(), "archived by its header alone, which retention does not trust");
}

/// Goal recovery's materialization (`recoverActiveGoals` -> `materializeSession`) is an admitted
/// start too: refused (a failed session of the summary, as a closed session is) while an
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

/// What the delete answers in the situation the case `name` builds.
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
            let late =
                world.handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-late", "input": { "prompt": "late" } }), "op-late")).await;
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
        // A turn in flight that holds no ask lock: a completion wakes the idle thread with a turn that holds no ask lock,
        // so the archive flag is read first and the turn still makes it busy.
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
        // thread (`threadNotFound` there reads as `not-archived`: the id has no mark).
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
        other => panic!("no situation for the case {other}"),
    }
}
/// Every reason the idle delete refuses with, in the situation that raises it, answers `{deleted: false, reason}` and deletes
/// nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_refusal_of_the_idle_delete_gives_its_reason_and_deletes_nothing() {
    let cases: [(&str, &str); 20] = [
        ("no-target", "invalid"),
        ("bad-id", "invalid"),
        ("turn-starting-admitted", "turn-starting"),
        ("turn-starting-fenced", "turn-starting"),
        ("unguarded", "unguarded"),
        ("current", "current"),
        ("busy-lock-not-archived", "busy"),
        ("busy-lock-archived", "busy"),
        ("not-archived", "not-archived"),
        ("unknown-session", "not-archived"),
        ("favorite", "favorite"),
        ("turn-waiting", "turn-waiting"),
        ("busy-unsettled", "busy"),
        ("in-flight-not-archived", "not-archived"),
        ("in-flight-archived", "busy"),
        ("queued-pending", "queued"),
        ("queued-hosted", "queued"),
        ("missing", "missing"),
        ("changed", "changed"),
        ("close-failed", "close-failed"),
    ];
    for (name, reason) in cases {
        // The states the actor publishes for the turn about to start, the turn not settled yet and input in the thread's own
        // queue are not held by anything a test can reach in a loaded thread: their checks run on the state they read.
        if let Some(live) = live_of(name) {
            assert_eq!(live_refusal(&live), Some(reason), "{name}");
            continue;
        }
        let world = world().await;
        let out = replay(name, &world).await;
        assert_eq!(out["reply"], json!({ "deleted": false, "reason": reason }), "{name}");
        // A start that was admitted and then ended, or a fence that was released, no longer holds the delete off.
        for key in ["afterwards", "firstReply"] {
            if out.get(key).is_some() {
                assert_eq!(out[key], json!({ "deleted": false, "reason": "changed" }), "{name}: {key}");
            }
        }
        assert!(lock(&world.rig.deletes.0).is_empty(), "{name}: a refusal deletes nothing");
    }
}

/// A turn in flight with no run (the ask's mark) makes the session not idle for the desktop (`ui_busy`, the session working) until
/// the ask ends: the end clears the mark and the actor publishes the session idle again.
#[tokio::test(start_paused = true)]
async fn a_marked_ask_keeps_the_session_busy_until_it_ends() {
    use super::actor::Inbox;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    assert!(!handle.cell.ui_busy.load(SeqCst), "an idle session is not busy");

    handle.cell.ask_marked.store(true, SeqCst);
    let (tx, taken) = tokio::sync::oneshot::channel();
    handle.inbox.send(Inbox::QuotaFacts { tx }).await.expect("the actor takes the inbox");
    taken.await.expect("the actor answers");
    crate::eventually_on!(&[&handle.cell.stepped], || handle.cell.ui_busy.load(SeqCst).then_some(())).await;

    handle.inbox.send(Inbox::AskEnded).await.expect("the actor takes the inbox");
    crate::eventually_on!(&[&handle.cell.stepped], || (!handle.cell.ui_busy.load(SeqCst) && !handle.cell.ask_marked.load(SeqCst)).then_some(())).await;
}
