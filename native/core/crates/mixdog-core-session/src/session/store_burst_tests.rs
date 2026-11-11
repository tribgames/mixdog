//! A burst of rows larger than the durability window: every product path that stores a whole conversation in one request
//! (`thread/inheritedRows/append`, a room post or an import through `thread/roomRows/append`, `inheritFrom`) lands every row,
//! in order, handed to the store as fast as its lane takes them (Node buffers the whole append, `session-log-writer.mjs`
//! `_messageRecord`), behind a store that is slow too; a failed write of it is told once and the thread goes on.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::room_log::RoomLog;
use super::room_log::SessionRoomLog;
use super::testing::Rig;
use super::testing::lock;
use super::tests::start_thread;
use crate::eventually_on;
use crate::eventually_on_until;

const ROWS: usize = 2000;

fn conversation() -> Vec<Value> {
    (0..ROWS).map(|n| json!({ "role": "user", "content": format!("row {n}"), "meta": { "transcript": { "messageId": format!("m{n}") } } })).collect()
}

fn expected() -> Vec<String> {
    (0..ROWS).map(|n| format!("row {n}")).collect()
}

/// The contents of the thread's stored rows, in ordinal order.
fn stored(rig: &Rig, id: &ThreadId) -> Vec<String> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(row) => match &row.body {
                Slot::Inline(body) => body.get("content").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn inherited_append(messages: Vec<Value>) -> CoreRequest {
    CoreRequest { method: Method("thread/inheritedRows/append"), params: json!({ "messages": messages }), op: None, ctx: CallContext::internal("test") }
}

/// The burst went to the store in batches no larger than the durability lane holds, every record of it once.
fn bounded_batches(rig: &Rig) {
    let batches = lock(&rig.store.batches).clone();
    let lane = { let limits = super::SessionLimits::default(); limits.window_records + limits.reserve_records + limits.control_lane + 1 };
    assert!(batches.iter().all(|batch| *batch <= lane), "{batches:?}");
    assert!(batches.iter().sum::<usize>() >= ROWS + 1, "{batches:?}");
}

/// The transcript-window replay's entry: 2000 rows in one request.
#[tokio::test(start_paused = true)]
async fn a_conversation_of_2000_rows_stored_in_one_request_lands_whole_and_in_order() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle.request(inherited_append(conversation())).await.expect("the burst is stored");
    assert_eq!(stored(&rig, &handle.id), expected());
    bounded_batches(&rig);
    assert!(lock(&rig.notices.0).is_empty(), "{:?}", lock(&rig.notices.0));
}

/// A room post or an imported conversation (`createImportedSession` stores its turns as one post) of 2000 rows.
#[tokio::test(start_paused = true)]
async fn a_room_post_or_import_of_2000_rows_lands_whole_and_in_order() {
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    let added = SessionRoomLog::new(directory.clone()).append_rows(handle.id.as_str(), conversation()).await.expect("the post is stored");
    assert_eq!(added, ROWS);
    assert_eq!(stored(&rig, &handle.id), expected());
    bounded_batches(&rig);
}

/// `inheritFrom` carries a source of 2000 rows into its heir.
#[tokio::test(start_paused = true)]
async fn an_inheritance_of_2000_rows_carries_them_all_in_order() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().expect("header");
    let route = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" });
    let (source, heir) = (ThreadId::from("sess_source"), ThreadId::from("sess_heir"));
    directory.create_with_id(source.clone(), header(route.clone()), json!({})).await.expect("create the source");
    directory.create_with_id(heir.clone(), header(route), json!({})).await.expect("create the heir");
    let opened = directory.open_handle(&source, &CallContext::internal("test")).await.expect("open the source");
    opened.request(inherited_append(conversation())).await.expect("the source's conversation");
    let params = json!({ "threadId": source, "intoThreadId": heir, "opId": "op-inherit" });
    let fork = CoreRequest {
        method: Method("thread/fork"),
        params,
        op: Some(OpId::from("op-inherit")),
        ctx: CallContext::connection(mixdog_core_api::ids::ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
    };
    directory.request(fork).await.expect("the inheritance");
    assert_eq!(stored(&rig, &heir), expected());
}

/// The store is slow: an earlier record is held at the store while the burst is accepted. The burst waits for it, whole, and
/// lands once the store goes on. (The test backend runs a lane job on the thread that submits it, so the held commit blocks
/// one worker: the runtime has two.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_behind_a_slow_store_waits_for_it_and_lands_in_order() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle: Arc<SessionHandle> = start_thread(&directory).await;
    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *lock(&rig.store.commit_gate) = Some((arrived.clone(), go.1));
    let arriving = arrived.notified();
    let patch = {
        let handle = handle.clone();
        let params = json!({ "threadId": handle.id, "set": { "title": "held" }, "unset": [] });
        tokio::spawn(async move { handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await })
    };
    arriving.await;
    let mut burst = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.request(inherited_append(conversation())).await })
    };
    // Every row of the burst is accepted and waits behind the held record, which is still not acknowledged.
    eventually_on_until!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == ROWS + 2).then_some(()), &mut burst).await;
    go.0.send(()).expect("the store goes on");
    patch.await.expect("the patch task").expect("the held record lands");
    burst.await.expect("the burst task").expect("the burst lands");
    assert_eq!(stored(&rig, &handle.id), expected());
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
}

/// The write of the burst fails: the request is told once, the thread shows none of it and stores none of it, and goes on - the
/// same burst stored again lands whole.
#[tokio::test(start_paused = true)]
async fn a_failed_write_of_a_burst_is_told_once_and_leaves_none_of_it() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    rig.store.fail_next.store(true, SeqCst);
    let failed = handle.request(inherited_append(conversation())).await;
    assert!(matches!(failed, Err(CoreError::BarrierFailed { .. })), "{failed:?}");
    assert_eq!(*lock(&rig.notices.0), ["save-failed"]);
    assert!(stored(&rig, &handle.id).is_empty());
    assert!(handle.cell.view.load_full().items.is_empty(), "nothing of the failed burst is shown");
    let stored_again = handle.request(inherited_append(conversation())).await;
    assert!(matches!(stored_again, Ok(Reply::Value(_))), "{stored_again:?}");
    assert_eq!(stored(&rig, &handle.id), expected());
    assert_eq!(*lock(&rig.notices.0), ["save-failed"], "the failure was told once");
}
