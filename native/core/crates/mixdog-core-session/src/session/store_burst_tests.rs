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

/// The rows of the burst and the `updatedAt` after them reached the store in one commit (one barrier): a kill lands before it
/// (none of them) or after it (all of them), never between two parts of it, as Node's one `append` record and one fsync.
fn one_unit(rig: &Rig) {
    let batches = lock(&rig.store.batches).clone();
    assert!(batches.contains(&(ROWS + 1)), "the burst is one commit: {batches:?}");
}

/// The transcript-window replay's entry: 2000 rows in one request, with a group commit far smaller than the burst.
#[tokio::test(start_paused = true)]
async fn a_conversation_of_2000_rows_stored_in_one_request_lands_whole_and_in_order() {
    let rig = Rig::new();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.limits.batch_bytes = 1024;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    handle.request(inherited_append(conversation())).await.expect("the burst is stored");
    assert_eq!(stored(&rig, &handle.id), expected());
    one_unit(&rig);
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
    one_unit(&rig);
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

fn header_patch(handle: &SessionHandle, title: &str) -> CoreRequest {
    let params = json!({ "threadId": handle.id, "set": { "title": title }, "unset": [] });
    CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }
}

/// The write of the burst fails (rolled back): the post is told once with one notice (`_recordSaveFailure`), nothing of it is
/// stored or shown, and its rows stay queued: the next write of the thread takes them first, in order, then its own record.
#[tokio::test(start_paused = true)]
async fn a_failed_write_of_a_burst_keeps_its_rows_for_the_next_write() {
    let rig = Rig::new();
    // The product's transcript: stored rows show as the user's would.
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.transcript = Arc::new(super::transcript::RecordTranscript::new());
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    rig.store.fail_next.store(true, SeqCst);
    let failed = handle.request(inherited_append(conversation())).await;
    assert!(matches!(failed, Err(CoreError::BarrierFailed { .. })), "{failed:?}");
    assert_eq!(*lock(&rig.notices.0), ["save-failed"]);
    assert!(stored(&rig, &handle.id).is_empty());
    assert!(handle.cell.view.load_full().items.is_empty(), "no prefix of the burst is shown");
    handle.request(header_patch(&handle, "next")).await.expect("the next write lands");
    assert_eq!(stored(&rig, &handle.id), expected(), "the kept rows landed with it, in order");
    let records = rig.store.records(&handle.id);
    assert!(
        matches!(&records.last().expect("records").1, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.set.get("title") == Some(&json!("next")))),
        "the next write's own record follows the kept rows"
    );
    let shown = handle.cell.view.load_full().items.len();
    assert!(shown > 0, "the rows show once landed");
    assert_eq!(*lock(&rig.notices.0), ["save-failed"], "the failure was told once");
}

/// `inheritFrom` answers as Node's (whose save it does not await) when the heir's write fails: the inheritance succeeds,
/// one notice, and the carried rows land with the heir's next write.
#[tokio::test(start_paused = true)]
async fn an_inheritance_whose_write_fails_answers_and_its_rows_land_with_the_next_write() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().expect("header");
    let route = json!({ "cwd": "/ws", "provider": "custom-harness", "model": "harness-model" });
    let (source, heir) = (ThreadId::from("sess_source"), ThreadId::from("sess_heir"));
    directory.create_with_id(source.clone(), header(route.clone()), json!({})).await.expect("create the source");
    directory.create_with_id(heir.clone(), header(route), json!({})).await.expect("create the heir");
    let opened = directory.open_handle(&source, &CallContext::internal("test")).await.expect("open the source");
    opened.request(inherited_append(conversation())).await.expect("the source's conversation");
    // The copy's own batch fails: the write before it, which stores the reference set and the copy mark, lands.
    let copy = |record: &Record| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.set.contains_key("inheritedFromSessionId")));
    *lock(&rig.store.fail_when) = Some((Box::new(copy), false));
    let fork = CoreRequest {
        method: Method("thread/fork"),
        params: json!({ "threadId": source, "intoThreadId": heir, "opId": "op-inherit" }),
        op: Some(OpId::from("op-inherit")),
        ctx: CallContext::connection(mixdog_core_api::ids::ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
    };
    directory.request(fork).await.expect("the inheritance answers");
    assert_eq!(*lock(&rig.notices.0), ["save-failed"]);
    assert!(stored(&rig, &heir).is_empty());
    let stored_header = rig.store.stored_header(&heir).expect("the heir's header");
    assert!(mixdog_store::offload_sources::mark(&stored_header).is_some(), "the heir's stored header still holds the copy mark: {stored_header:?}");
    let handle = directory.open_handle(&heir, &CallContext::internal("test")).await.expect("open the heir");
    handle.request(header_patch(&handle, "next")).await.expect("the heir's next write");
    assert!(mixdog_store::offload_sources::mark(&rig.store.stored_header(&heir).expect("the heir's header")).is_none(), "the mark went with the rows");
    assert_eq!(stored(&rig, &heir), expected());
    let header = handle.cell.header.load();
    assert_eq!(header.get("inheritedFromSessionId"), Some(&json!("sess_source")), "the inheritance's header keys went with the rows");
}
