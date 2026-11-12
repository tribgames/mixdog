//! `SessionDirectory::durability_settled`, the replay's barrier on the session store (`replay/storesSettled`): it answers only
//! once every record a loaded thread accepted before it is committed, and at once when nothing is pending.

use std::sync::Arc;

use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_rt::CancellationToken;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::tests::start_thread;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_waits_for_a_record_held_at_the_store_and_answers_once_it_is_committed() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    assert_eq!(directory.durability_settled().wait().await, Ok(0), "no thread loaded: settled at once");
    let handle = start_thread(&directory).await;
    assert_eq!(directory.durability_settled().wait().await, Ok(1), "a loaded thread with nothing pending: settled at once");

    let (arrived, go) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *super::testing::lock(&rig.store.commit_gate) = Some((arrived.clone(), go.1));
    let renamed = {
        let (handle, id) = (handle.clone(), handle.id.clone());
        tokio::spawn(async move {
            let rename = CoreRequest {
                method: Method("thread/name/set"),
                params: json!({ "threadId": id, "opId": "op-name", "title": "renamed" }),
                op: Some(OpId::from("op-name")),
                ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
            };
            handle.request(rename).await
        })
    };
    // The record is at the store, unacknowledged.
    tokio::time::timeout(DEADLINE, arrived.notified()).await.expect("the rename's record did not reach the store within 10 s");
    let mut settled = Box::pin(directory.durability_settled().wait());
    assert!(futures::poll!(settled.as_mut()).is_pending());
    super::tests::caught_up(&handle).await;
    assert!(futures::poll!(settled.as_mut()).is_pending(), "a record is still held at the store");

    go.0.send(()).expect("the commit waits");
    assert_eq!(tokio::time::timeout(DEADLINE, settled).await.expect("settled did not answer within 10 s of the commit"), Ok(1));
    tokio::time::timeout(DEADLINE, renamed).await.expect("the rename did not answer within 10 s").expect("joined").expect("the held record was committed");
}

fn rename(handle: &super::SessionHandle, op: &'static str, title: &str) -> CoreRequest {
    CoreRequest {
        method: Method("thread/name/set"),
        params: json!({ "threadId": handle.id, "opId": op, "title": title }),
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_answers_at_the_records_accepted_before_it_while_later_ones_are_still_unsynced() {
    let rig = Rig::new();
    // One record per group commit: a record accepted after the call is never committed in the same batch as one from before
    // it, so the gates below hold exactly the record they name.
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.limits.batch_bytes = 1;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;

    // A record accepted before the call, held at the store unsynced.
    let (before_arrived, before_go) = rig.store.hold_title("before");
    let before = {
        let (handle, request) = (handle.clone(), rename(&handle, "op-before", "before"));
        tokio::spawn(async move { handle.request(request).await })
    };
    tokio::time::timeout(DEADLINE, before_arrived.notified()).await.expect("the record from before the call did not reach the store within 10 s");
    let mut settled = Box::pin(directory.durability_settled().wait());
    assert!(futures::poll!(settled.as_mut()).is_pending());
    super::tests::caught_up(&handle).await;

    // Records accepted after the call keep arriving: the next one is held at the store too, unsynced.
    let (after_arrived, after_go) = rig.store.hold_title("after");
    let mut after = Box::pin(handle.request(rename(&handle, "op-after", "after")));
    assert!(futures::poll!(after.as_mut()).is_pending(), "the later record waits for its commit");
    super::tests::caught_up(&handle).await;
    assert!(futures::poll!(settled.as_mut()).is_pending(), "the record from before the call is still unsynced");

    // The record from before syncs; the later one reaches the store and is held there: settled answers anyway.
    before_go.send(()).expect("the commit waits");
    tokio::time::timeout(DEADLINE, after_arrived.notified()).await.expect("the later record did not reach the store within 10 s");
    let answer = tokio::time::timeout(DEADLINE, settled).await.expect("settled did not answer within 10 s although the record from before the call was committed");
    assert_eq!(answer, Ok(1));
    assert!(futures::poll!(after.as_mut()).is_pending(), "the later record was still unsynced when settled answered");
    tokio::time::timeout(DEADLINE, before).await.expect("the earlier rename did not answer within 10 s").expect("joined").expect("committed");

    after_go.send(()).expect("the commit waits");
    tokio::time::timeout(DEADLINE, after).await.expect("the later rename did not answer within 10 s").expect("committed");
}

/// A record accepted before the call whose commit failed: the call answers that failure, naming the thread, not success.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_answers_an_error_when_a_record_from_before_it_failed() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let failed = tokio::time::timeout(DEADLINE, handle.request(rename(&handle, "op-failed", "failed"))).await.expect("the rename did not answer within 10 s");
    assert!(failed.is_err(), "the store failed the record: {failed:?}");
    let answer = tokio::time::timeout(DEADLINE, directory.durability_settled().wait()).await.expect("settled did not answer within 10 s");
    let error = answer.expect_err("a failed record from before the call is the call's error");
    assert!(error.starts_with(&format!("thread {}: the thread's records: write ", handle.id.as_str())) && error.contains("accepted before the barrier, failed: "), "{error}");
}

/// A thread whose actor ends with a record from before the call not yet acked: nobody commits it now, so the call answers
/// that failure, naming the thread, instead of waiting for ever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settled_answers_an_error_when_the_thread_ends_with_a_record_unwritten() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let (arrived, _go) = rig.store.hold_title("held");
    let mut renamed = Box::pin(handle.request(rename(&handle, "op-held", "held")));
    assert!(futures::poll!(renamed.as_mut()).is_pending());
    tokio::time::timeout(DEADLINE, arrived.notified()).await.expect("the record did not reach the store within 10 s");
    let settling = directory.durability_settled();
    assert_eq!(settling.pending(), vec![format!("thread {}: the thread's records", handle.id.as_str())]);
    handle.inbox.send(super::actor::Inbox::Unwind(super::actor::UnwindAt::Now)).await.expect("the actor takes the inbox");
    let answer = tokio::time::timeout(DEADLINE, settling.wait()).await.expect("settled did not answer within 10 s of the thread's end");
    let error = answer.expect_err("an unwritten record from before the call is the call's error");
    assert!(error.starts_with(&format!("thread {}: the thread's records: write ", handle.id.as_str())) && error.ends_with("failed: the thread ended before the record was committed"), "{error}");
}

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
