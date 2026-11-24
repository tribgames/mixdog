//! What the session actor leaves settled when work of its own and a caller's request meet: an op answered outside a plan, a
//! second compaction, a scheduled one, an inheritance whose heir moved under it, a prune's scan and its deletes.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_agent::offload::ArtifactStore;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::OpState;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use crate::eventually_on;
use crate::eventually_on_until;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::seams::RunOutcome;
use crate::session::testing::Rig;
use crate::session::testing::awaiting;
use crate::session::testing::lock;
use crate::session::testing::offload_replay::within;
use crate::session::testing::offload_store;
use crate::session::tests::request;
use crate::session::tests::settled_idle;
use crate::session::tests::start_thread;
use crate::session::tests::turn;
use crate::session::thread_ops::OpCall;

async fn call(handle: &SessionHandle, method: &'static str, mut params: Value, op: &str) -> Result<Value, CoreError> {
    params["threadId"] = json!(handle.id);
    params["opId"] = json!(op);
    match handle.request(request(method, params, op)).await? {
        Reply::Value(value) => Ok(value),
        other => panic!("a value reply, got {other:?}"),
    }
}

/// A hand-back that found nothing queued and a retried send its receipt answers have no plan of their own: each op still
/// settles with the answer its caller got, stored under it, so a reconnect's wait on it ends and a repeat replays it.
#[tokio::test(start_paused = true)]
async fn an_op_answered_outside_a_plan_settles_with_its_answer() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let restore = json!({ "restore": true });
    let restored = call(&handle, "thread/queue/delete", restore.clone(), "restore-1").await.expect("nothing to hand back");
    let send = json!({ "input": { "prompt": "hello", "options": { "clientSubmissionId": "sub-1" } } });
    let started = call(&handle, "turn/start", send.clone(), "send-1").await.expect("started");
    eventually_on!(&[&handle.cell.stepped], || settled_idle(&handle).then_some(())).await;
    let retried = call(&handle, "turn/start", send, "send-2").await.expect("the receipt");
    assert_eq!(retried, started, "the retry is answered the send's receipt");
    for (op, answer) in [("restore-1", &restored), ("send-2", &retried)] {
        let waited = awaiting(|| format!("the wait on {op} to end"), handle.op_call(OpCall::Await(OpId::from(op)))).await;
        assert!(waited.is_ok(), "{op}: {waited:?}");
        let stored = rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
            Record::Op(record) if record.op.id.as_str() == op && record.state == OpState::Applied => record.op.result.map(|result| result.get().clone()),
            _ => None,
        });
        assert_eq!(stored.as_ref(), Some(answer), "{op}: its answer is stored under it");
    }
    assert_eq!(call(&handle, "thread/queue/delete", restore, "restore-1").await.expect("replayed"), restored, "a repeat replays the answer");
}

/// A second compaction asked while one runs (a double trigger, another device) is told the first runs and never reaches the
/// engine, so the abort a Stop, a close or a delete sends reaches the one that runs; and only a compaction that changed the
/// history marks the Goal reminder.
#[tokio::test(start_paused = true)]
async fn one_compaction_runs_at_a_time_and_only_a_changed_history_marks_the_goal_reminder() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let hold = Arc::new(Notify::new());
    *lock(&rig.compaction.hold) = Some(hold.clone());
    *lock(&rig.compaction.result) = Some(json!({ "changed": false }));
    let mut first = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "compact-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!lock(&rig.compaction.calls).is_empty()).then_some(()), &mut first).await;
    let second = awaiting(|| "the second compaction's answer".to_owned(), call(&handle, "thread/compact/start", json!({}), "compact-2")).await;
    assert_eq!(second.expect("answered"), json!({ "changed": false, "reason": "compact skipped: compaction in progress" }));
    assert_eq!(*lock(&rig.compaction.calls), ["compact manual false"], "the second never reached the engine");
    handle.cell.abort_compaction(&mixdog_agent::cancel::Abort::runtime_abort(handle.id.as_str(), mixdog_agent::cancel::USER_CANCEL));
    assert!(lock(&rig.compaction.cancels)[0].is_aborted(), "the abort reaches the compaction that runs");
    hold.notify_one();
    assert_eq!(first.await.expect("joined").expect("answered"), json!({ "changed": false }));

    *lock(&rig.compaction.hold) = None;
    *lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.compacting.load(SeqCst)).then_some(())).await;
    assert_eq!(call(&handle, "thread/compact/start", json!({}), "compact-3").await.expect("answered"), json!({ "changed": true }));
    let pending = eventually_on!(&[&handle.cell.stepped], || handle.cell.header.load().get("pendingGoalReminder").cloned()).await;
    assert_eq!((pending["reason"].clone(), pending["revision"].clone()), (json!("compaction"), json!(1)), "the unchanged compaction marked nothing");
}

/// The compaction the session tool scheduled runs once the turn ends and is nobody's own request: when it changes nothing, nobody
/// is told so.
#[tokio::test(start_paused = true)]
async fn a_scheduled_compaction_that_changed_nothing_tells_nobody() {
    let rig = Rig::new();
    let gate = Arc::new(Notify::new());
    rig.set_script(Arc::new({
        let gate = gate.clone();
        move |run| {
            let gate = gate.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                gate.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    *lock(&rig.compaction.result) = Some(json!({ "changed": false }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    let scheduled = call(&handle, "thread/compact/start", json!({ "options": { "afterTurn": true } }), "k-1").await.expect("answered");
    assert_eq!(scheduled, Value::Null);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (lock(&rig.compaction.calls).len() >= 4 && settled_idle(&handle)).then_some(())).await;
    assert_eq!(*lock(&rig.compaction.calls), ["compact manual false", "post manual", "rearm", "invalidate"]);
    let told = rig
        .feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"].to_string().contains("Nothing to compact"))
        .count();
    assert_eq!(told, 0, "the scheduled compaction is nobody's request");
}

/// An inheritance whose rows were being fitted while its heir took a conversation of its own (the user sent there) writes none
/// of them: the carry fails with the answer its caller sees, the heir keeps its own conversation alone and loses its copy mark.
#[tokio::test(start_paused = true)]
async fn a_carry_into_an_heir_that_took_a_conversation_meanwhile_is_refused() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let header = |value: Value| value.as_object().cloned().expect("header");
    for id in ["sess_source", "sess_heir"] {
        directory
            .create_with_id(ThreadId::from(id), header(json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" })), json!({}))
            .await
            .expect("create");
    }
    let source = directory.open_handle(&ThreadId::from("sess_source"), &CallContext::internal("test")).await.expect("source");
    let heir = directory.open_handle(&ThreadId::from("sess_heir"), &CallContext::internal("test")).await.expect("heir");
    let rows = json!([{ "role": "user", "content": "carry me" }, { "role": "assistant", "content": "carried" }]);
    let append =
        CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": rows }), op: None, ctx: CallContext::internal("test") };
    source.request(append).await.expect("the source's conversation");
    let (arrived, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *lock(&rig.inherit.fit_gate) = Some((arrived.clone(), go.clone()));
    let carry = {
        let directory = directory.clone();
        let params = json!({ "threadId": "sess_source", "intoThreadId": "sess_heir", "opId": "op-inherit" });
        tokio::spawn(async move { directory.request(request("thread/fork", params, "op-inherit")).await })
    };
    awaiting(|| "the carry to fit its rows".to_owned(), arrived.notified()).await;
    turn(&heir, "my own question", "op-mine").await;
    eventually_on!(&[&heir.cell.stepped], || settled_idle(&heir).then_some(())).await;
    go.notify_one();

    let refused = awaiting(|| "the carry's answer".to_owned(), carry).await.expect("joined");
    assert!(
        matches!(&refused, Err(CoreError::DomainError { message: Some(message), .. }) if &**message == "inheritFrom: this session already holds a conversation"),
        "{refused:?}"
    );
    let held: Vec<Value> = directory.model_context(&heir.id).read().await.expect("heir rows").into_iter().map(|(_, row)| row).collect();
    assert!(held.iter().any(|row| row.to_string().contains("my own question")), "{held:?}");
    assert!(held.iter().all(|row| !row.to_string().contains("carry me")), "no carried row: {held:?}");
    let stored = rig.store.stored_header(&heir.id).expect("heir header");
    assert!(stored.get("inheritedFromSessionId").is_none(), "{stored:?}");
    assert!(stored.get(mixdog_store::offload_sources::INHERITING).is_none(), "the copy mark is taken off: {stored:?}");
}

/// A prune's scan (the stored transcript, every copy's) and its deletes run off the actor: while the engine holds the prune, the
/// thread still answers.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_prune_leaves_the_thread_serving() {
    let data = tempfile::tempdir().expect("data dir");
    let rig = Rig::new();
    let id = ThreadId::from("sess_pruned");
    let mut listings = rig.compaction.listings.subscribe();
    let creator = SessionDirectory::new(rig.deps());
    let header = json!({ "cwd": "/ws" }).as_object().cloned().expect("header");
    within("the session is created", creator.create_with_id(id.clone(), header, json!({}))).await.expect("create");
    // The creator's open listed nothing: the sidecar is written once it did.
    within("the creator's open lists", listings.wait_for(|count| *count >= 1)).await.expect("listed");
    let sidecars = crate::session::testing::offload_store(data.path(), &id);
    within("the sidecar is written", sidecars.persist("an offloaded result")).await.expect("persisted");
    *lock(&rig.compaction.offloads) = Some((data.path().to_path_buf(), 0));
    let (arrived, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *lock(&rig.compaction.prune_gate) = Some((arrived.clone(), release.clone()));

    let directory = SessionDirectory::new(rig.deps());
    let handle = within("the session opens", directory.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
    within("the open's prune reaches the engine", arrived.notified()).await;
    within("the thread answers while its prune is held", handle.held_fields(&["cwd"])).await.expect("held fields");
    release.notify_one();
}

#[allow(clippy::disallowed_methods, reason = "the test reads whether the prune deleted the sidecar")]
fn exists(path: &str) -> bool {
    std::path::Path::new(path).exists()
}

/// A prune under way when a turn starts deletes nothing the turn can still need: here an old sidecar its prompt names, which
/// the transcript the prune read before did not. The deletes are judged as they are made, under the actor's grant, which a
/// running turn refuses: the prune waits for the turn's end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prune_under_way_deletes_nothing_a_turn_started_meanwhile_names() {
    let data = tempfile::tempdir().expect("data dir");
    let rig = Rig::new();
    let id = ThreadId::from("sess_named");
    let mut listings = rig.compaction.listings.subscribe();
    let creator = SessionDirectory::new(rig.deps());
    let header = json!({ "cwd": "/ws" }).as_object().cloned().expect("header");
    within("the session is created", creator.create_with_id(id.clone(), header, json!({}))).await.expect("create");
    within("the creator's open lists", listings.wait_for(|count| *count >= 1)).await.expect("listed");
    let sidecar = within("the sidecar is written", offload_store(data.path(), &id).persist("an offloaded result")).await.expect("persisted").path;
    // Every sidecar is old at the prune's clock.
    *lock(&rig.compaction.offloads) = Some((data.path().to_path_buf(), u64::MAX));
    let (arrived, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *lock(&rig.compaction.prune_gate) = Some((arrived.clone(), release.clone()));
    let (durable, hold) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    rig.set_script(Arc::new({
        let (durable, hold) = (durable.clone(), hold.clone());
        move |run| {
            let (durable, hold) = (durable.clone(), hold.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                durable.notify_one();
                hold.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }
    }));

    let directory = SessionDirectory::new(rig.deps());
    let handle = within("the session opens", directory.open_handle(&id, &CallContext::internal("test"))).await.expect("open");
    within("the open's prune reaches the engine", arrived.notified()).await;
    turn(&handle, &format!("read {sidecar}"), "op-1").await;
    within("the turn's prompt is durable", durable.notified()).await;
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!lock(&rig.compaction.pruned).is_empty()).then_some(())).await;
    assert!(exists(&sidecar), "the sidecar the running turn names is kept");
    hold.notify_one();
}
