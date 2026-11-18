//! A windowed upload: `transfer/writeChunk` requests of one upload that arrive back to back are applied one at a time, in
//! arrival order, by the request's own serialization key; another upload's chunks are not held behind them.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_app_protocol::ClientRequest;
use mixdog_app_protocol::JsonRpcRequest;
use mixdog_app_protocol::RequestId;
use mixdog_rt::CancellationToken;
use serde_json::json;
use tokio::sync::oneshot;

use crate::serialization::KeyedQueues;
use crate::serialization::QueueKey;

fn chunk_request(upload: &str, offset: u64) -> ClientRequest {
    ClientRequest::from_jsonrpc(JsonRpcRequest {
        id: RequestId::Integer(offset as i64),
        method: "transfer/writeChunk".into(),
        params: Some(json!({ "transferId": upload, "offset": offset, "bytesB64": "aGk=" })),
        trace: None,
        lone_surrogates: Vec::new(),
    })
    .expect("a writeChunk request decodes")
}

fn key_of(request: &ClientRequest) -> (QueueKey, crate::serialization::Access) {
    let scope = request.serialization_scope().expect("writeChunk is serialized by its upload");
    QueueKey::resolve(scope, String::new)
}

#[tokio::test]
async fn the_chunks_of_one_upload_apply_one_at_a_time_in_arrival_order() {
    mixdog_rt::testing::tokens();
    let queues = KeyedQueues::new();
    let applied: Arc<Mutex<Vec<u64>>> = Arc::default();
    let running: Arc<Mutex<(usize, usize)>> = Arc::default();
    let mut finished = Vec::new();
    for offset in 0..24u64 {
        let (key, access) = key_of(&chunk_request("up-1", offset));
        let (applied, running) = (applied.clone(), running.clone());
        let (done, finish) = oneshot::channel::<()>();
        finished.push(finish);
        queues.enqueue(
            key,
            access,
            CancellationToken::new(),
            Box::pin(async move {
                {
                    let mut now = running.lock().unwrap();
                    now.0 += 1;
                    now.1 = now.1.max(now.0);
                }
                // Yielding lets a concurrent neighbour start if the key did not hold it back.
                for _ in 0..3 {
                    tokio::task::yield_now().await;
                }
                applied.lock().unwrap().push(offset);
                running.lock().unwrap().0 -= 1;
                let _ = done.send(());
            }),
        );
    }
    for finish in finished {
        finish.await.unwrap();
    }
    assert_eq!(*applied.lock().unwrap(), (0..24).collect::<Vec<_>>());
    assert_eq!(running.lock().unwrap().1, 1, "no two chunks of one upload ran together");
}

fn request(method: &str, params: serde_json::Value) -> ClientRequest {
    ClientRequest::from_jsonrpc(JsonRpcRequest {
        id: RequestId::Integer(1),
        method: method.into(),
        params: Some(params),
        trace: None,
        lone_surrogates: Vec::new(),
    })
    .expect("the request decodes")
}

#[tokio::test]
async fn an_abort_is_a_barrier_behind_the_writes_already_sent_and_a_commit_follows_them() {
    mixdog_rt::testing::tokens();
    let queues = KeyedQueues::new();
    let log: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let (release, hold) = oneshot::channel::<()>();
    let mut finished = Vec::new();
    let mut put = |request: ClientRequest, what: &'static str, hold: Option<oneshot::Receiver<()>>| {
        let (key, access) = key_of(&request);
        let (done, finish) = oneshot::channel::<()>();
        finished.push(finish);
        let log = log.clone();
        queues.enqueue(
            key,
            access,
            CancellationToken::new(),
            Box::pin(async move {
                if let Some(hold) = hold {
                    let _ = hold.await;
                }
                log.lock().unwrap().push(what);
                let _ = done.send(());
            }),
        );
    };
    put(chunk_request("up-1", 0), "write", Some(hold));
    put(request("transfer/abort", json!({ "transferId": "up-1" })), "abort", None);
    put(request("transfer/commit", json!({ "opId": "0190f3c2-7a31-7c00-8000-000000000288", "transferId": "up-1" })), "commit", None);
    // The first write is still running: neither the abort nor the commit has started.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    assert!(log.lock().unwrap().is_empty());
    release.send(()).unwrap();
    for finish in finished {
        finish.await.unwrap();
    }
    assert_eq!(*log.lock().unwrap(), vec!["write", "abort", "commit"]);
}

#[tokio::test]
async fn another_upload_is_not_held_behind_a_busy_one() {
    mixdog_rt::testing::tokens();
    let queues = KeyedQueues::new();
    let (release, hold) = oneshot::channel::<()>();
    let (key, access) = key_of(&chunk_request("up-1", 0));
    queues.enqueue(key, access, CancellationToken::new(), Box::pin(async move { let _ = hold.await; }));
    let (done, finished) = oneshot::channel::<()>();
    let (key, access) = key_of(&chunk_request("up-2", 0));
    queues.enqueue(key, access, CancellationToken::new(), Box::pin(async move { let _ = done.send(()); }));
    finished.await.unwrap();
    release.send(()).unwrap();
}
