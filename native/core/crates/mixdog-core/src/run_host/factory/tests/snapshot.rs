use super::*;

/// A thread with history: the snapshot is `nextMainRequest`'s, the stored header and transcript as they are with the
/// asked user message after them, so for a thread whose settings did not move since (and a model whose rules give no
/// tail reminder) it is the request the next turn sends. Taking it stores nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_of_a_thread_with_history_is_its_next_request() {
    let (provider, mut heard) = handing();
    let world = turn_world(provider.clone()).await;
    let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
    let covered_before = handle.header_snapshot().get("turnCoverage").cloned();
    let started =
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
    assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
    mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the first turn's request"))
        .expect("the provider is alive");
    settled_turns(&world, &id, &handle, 1, covered_before).await;
    let before = stored_state(&world, &id, &handle);
    let first = snapshot_call(&tools_status(&world), &id, "go").await;
    assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
    let (snapshot, handed) = snapshot_then_turn(&world, &provider, &mut heard, &id, &handle, "op-2").await;
    assert!(snapshot.is_object(), "a thread with a conversation has a request");
    assert_eq!(first["requestSnapshot"], snapshot, "two snapshots of the same thread differ");
    assert_eq!(snapshot, handed, "the snapshot is not the request the next turn handed the provider");
}

/// `nextMainRequest` is null for a session with no user conversation (`side-question.mjs:67`), so is the snapshot:
/// nothing is composed for it, and the thread's whole stored state (records, live header, accounting, files) is the
/// same after the call as before it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_with_no_conversation_has_no_snapshot_and_the_call_stores_nothing() {
    let (provider, _heard) = handing();
    let world = turn_world(provider).await;
    let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
    let before = stored_state(&world, &id, &handle);
    let status = snapshot_call(&tools_status(&world), &id, "go").await;
    assert_eq!(status["requestSnapshot"], Value::Null, "Node's nextMainRequest is null without a user conversation");
    assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
}
