//! The control thread of paired phones (`SessionDirectory::remote_control`): one for every relay connection, as Node's host had one
//! control session for every phone.

use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_core_api::CoreError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockConnection;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::sink::ConnectionSink;
use mixdog_protocol::Origin;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;

fn on(connection: u64, origin: Origin, method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: Some(OpId::from(op)), ctx: CallContext::connection(ConnectionId(connection), origin, CancellationToken::new()) }
}

/// A control `thread/start` of `connection`: its subscribing reply, not attached yet.
async fn started(directory: &SessionDirectory, connection: u64, origin: Origin, op: &str) -> Subscribe {
    match directory.request(on(connection, origin, "thread/start", json!({ "opId": op, "kind": "control" }), op)).await.expect("thread/start") {
        Reply::Subscribe(started) => started,
        Reply::Value(_) => panic!("thread/start subscribes"),
    }
}

fn id_of(started: &Subscribe) -> ThreadId {
    ThreadId::from(started.result["thread"]["id"].as_str().expect("thread id"))
}

/// The thread id a control start of `connection` answers with (its reply never attached).
async fn start_control(directory: &SessionDirectory, connection: u64, origin: Origin, op: &str) -> ThreadId {
    id_of(&started(directory, connection, origin, op).await)
}

/// What the server does with the reply (`finish_subscribe`): attaches its feed on `connection`. The feed, to detach it again.
fn attach(started: Subscribe, connection: &MockConnection, sub: &str) -> Result<Arc<dyn FeedSource>, CoreError> {
    let feed = started.feed.clone();
    let attached = mixdog_core_api::feed::subscribe(&feed, SubscriptionId::from(sub), started.window, started.resume_from, connection)?;
    connection.send_control_release(bytes::Bytes::from(started.result.to_string()), attached.release).expect("release");
    Ok(feed)
}

#[tokio::test(start_paused = true)]
async fn every_phone_is_answered_with_one_control_thread_until_it_is_gone() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    // Two phones arriving together, then a reload of one of them (a new connection): one thread.
    let (first, second) = tokio::join!(
        start_control(&directory, 1, Origin::Relay, "op-a"),
        start_control(&directory, 2, Origin::Relay, "op-b"),
    );
    assert_eq!(first, second);
    assert_eq!(start_control(&directory, 3, Origin::Relay, "op-c").await, first);
    // The desktop window's control thread is its own.
    assert_ne!(start_control(&directory, 4, Origin::Local, "op-local").await, first);
}

/// The shared thread deleted (`thread/delete`): the next phone's start is answered with a new thread, whose feed attaches, and the
/// phones after it share that one.
#[tokio::test(start_paused = true)]
async fn a_deleted_shared_control_thread_is_replaced_by_the_next_phone_start() {
    let rig = Rig::new();
    rig.store.listed.store(true, SeqCst);
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    let phone = MockConnection::new(ConnectionId(1), MockLimits::default());
    let first = started(&directory, 1, Origin::Relay, "op-a").await;
    let deleted_id = id_of(&first);
    let feed = attach(first, &phone, "s1").expect("the first phone attaches");
    feed.detach(SubscriptionId::from("s1"));
    // The daemon routes `thread/delete` to the thread's handle, as a client's call reaches it.
    let shared = directory.handle(&deleted_id).expect("the shared thread is loaded");
    let delete = on(9, Origin::Local, "thread/delete", json!({ "threadId": deleted_id, "opId": "op-del" }), "op-del");
    let deleted = mixdog_core_api::ThreadHandle::request(shared.as_ref(), delete).await.expect("thread/delete");
    assert!(matches!(deleted, Reply::Value(Value::Bool(true))), "the shared thread is deleted: {deleted:?}");
    let next = started(&directory, 2, Origin::Relay, "op-b").await;
    let next_id = id_of(&next);
    assert_ne!(next_id, deleted_id);
    let second = MockConnection::new(ConnectionId(2), MockLimits::default());
    attach(next, &second, "s2").expect("the replacement's feed attaches");
    assert_eq!(start_control(&directory, 3, Origin::Relay, "op-c").await, next_id);
}

/// A close against an attach: the shared thread is asked to unload (`release`, the idle decision) after a phone's start found it
/// and before that phone's subscription is attached. The attach admitted with the reply keeps it loaded, and the attach succeeds;
/// once nobody holds it, it unloads, and the next phone's start opens the same thread again.
#[tokio::test(start_paused = true)]
async fn an_unload_between_a_phone_start_and_its_attach_neither_closes_the_thread_nor_fails_the_attach() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(Arc::new(rig.deps_parts(rig.store.clone())));
    // The first phone's reply is lost (its socket closed before the attach): nobody holds the thread.
    let id = start_control(&directory, 1, Origin::Relay, "op-a").await;
    let reply = started(&directory, 2, Origin::Relay, "op-b").await;
    assert_eq!(id_of(&reply), id);
    directory.release(&id).await;
    assert!(directory.handle(&id).is_some(), "the admitted attach keeps the shared thread loaded");
    let phone = MockConnection::new(ConnectionId(2), MockLimits::default());
    let feed = attach(reply, &phone, "s2").expect("the phone's subscription attaches");
    feed.detach(SubscriptionId::from("s2"));
    directory.release(&id).await;
    assert_eq!(start_control(&directory, 3, Origin::Relay, "op-c").await, id, "the same thread is opened again");
}
