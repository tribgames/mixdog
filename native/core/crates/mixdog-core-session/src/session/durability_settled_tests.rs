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
    assert_eq!(directory.durability_settled().await, Ok(0), "no thread loaded: settled at once");
    let handle = start_thread(&directory).await;
    assert_eq!(directory.durability_settled().await, Ok(1), "a loaded thread with nothing pending: settled at once");

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
    let mut settled = Box::pin(directory.durability_settled());
    assert!(futures::poll!(settled.as_mut()).is_pending());
    // The inbox is in order: once this answers, the actor has taken the settled question too.
    let (tx, taken) = tokio::sync::oneshot::channel();
    handle.inbox.send(super::actor::Inbox::QuotaFacts { tx }).await.expect("the actor takes the inbox");
    tokio::time::timeout(DEADLINE, taken).await.expect("the actor did not answer QuotaFacts within 10 s").expect("the actor answers");
    assert!(futures::poll!(settled.as_mut()).is_pending(), "a record is still held at the store");

    go.0.send(()).expect("the commit waits");
    assert_eq!(tokio::time::timeout(DEADLINE, settled).await.expect("settled did not answer within 10 s of the commit"), Ok(1));
    tokio::time::timeout(DEADLINE, renamed).await.expect("the rename did not answer within 10 s").expect("joined").expect("the held record was committed");
}

const DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
