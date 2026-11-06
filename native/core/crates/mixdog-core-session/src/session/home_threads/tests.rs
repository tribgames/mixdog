//! The home delivery's thread store over a real session directory and log store.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_services::bots::delivery::env::HomeThreads;
use serde_json::{Value, json};

use super::DirectoryHomeThreads;
use crate::session::SessionDirectory;
use crate::session::testing::Rig;
use crate::session::tests::{real_store, start_thread};

fn row(message_id: &str, text: &str) -> Value {
    json!({
        "role": "assistant",
        "content": text,
        "meta": { "transcript": { "at": 5, "messageId": message_id } },
    })
}

fn texts(messages: &[Value]) -> Vec<String> {
    messages.iter().filter_map(|m| m["content"].as_str().map(str::to_owned)).collect()
}

/// `loadSession` / `saveSessionAsync` / `isSessionTurnInFlight`: a stored thread loads with its
/// messages, posted rows land once and show on the next load, a thread with no record loads as
/// nothing and is proven deleted, and a loaded idle thread runs no turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn posts_rows_once_and_tells_a_missing_thread_from_a_stored_one() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let handle = start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    let threads = DirectoryHomeThreads::new(directory.clone());

    let loaded = threads.load(&id).await.expect("load").expect("a stored thread");
    assert!(!loaded.closed);
    let before = loaded.messages.len();
    assert!(!threads.turn_in_flight(&id), "an idle thread runs no turn");
    assert!(!threads.session_deleted(&id).await);

    threads.append(&id, vec![row("m1", "one"), row("m2", "two"), row("m1", "again")], Some(5)).await.expect("post");
    threads.append(&id, vec![row("m2", "two"), row("m3", "three")], None).await.expect("post again");
    threads.append(&id, Vec::new(), None).await.expect("nothing to store");
    // The rows are durable when `append` answers; the load reads the store.
    let posted = threads.load(&id).await.expect("load").expect("stored").messages;
    assert_eq!(&texts(&posted)[before..], ["one", "two", "three"], "a messageId held, or repeated in the post, is stored once");

    assert!(threads.load("sess_home_gone").await.expect("load").is_none());
    assert!(threads.session_deleted("sess_home_gone").await, "no record and no loaded copy proves it deleted");
    assert!(threads.append("sess_home_gone", vec![row("m9", "x")], None).await.is_err(), "a missing thread takes no rows");
}

/// A thread the header marks closed loads as closed (`session.closed === true`), also after the
/// directory is reopened from the store, when the thread is not loaded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_thread_loads_as_closed_loaded_or_not() {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let header = json!({ "closed": true }).as_object().cloned().expect("object");
    let id = ThreadId::from("sess_home_closed");
    directory.create_with_id(id.clone(), header, json!({})).await.expect("create");
    let threads = DirectoryHomeThreads::new(directory);
    assert!(threads.load(id.as_str()).await.expect("load").expect("stored").closed);

    let reopened = DirectoryHomeThreads::new(Arc::new(SessionDirectory::new(rig.deps_on(store))));
    assert!(reopened.load(id.as_str()).await.expect("load").expect("stored").closed);
    assert!(!reopened.session_deleted(id.as_str()).await);
}
