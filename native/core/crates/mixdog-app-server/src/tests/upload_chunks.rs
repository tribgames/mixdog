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
    queues.enqueue(
        key,
        access,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = hold.await;
        }),
    );
    let (done, finished) = oneshot::channel::<()>();
    let (key, access) = key_of(&chunk_request("up-2", 0));
    queues.enqueue(
        key,
        access,
        CancellationToken::new(),
        Box::pin(async move {
            let _ = done.send(());
        }),
    );
    finished.await.unwrap();
    release.send(()).unwrap();
}

#[tokio::test]
async fn the_chunks_of_one_blob_upload_apply_in_arrival_order_and_the_blob_completes() {
    use mixdog_app_protocol::limits::Limits;
    use mixdog_core_api::CallContext;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::service::DomainService;
    use mixdog_core_domains::domains::blob::BlobService;
    use mixdog_store::blobs::BlobStore;

    mixdog_rt::testing::tokens();
    let dir = std::env::temp_dir().join(format!(
        "mixdog-blob-put-order-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let limits = Limits { max_blob_page_bytes: 64, max_blob_put_chunk_bytes: 3, ..Limits::default() };
    let service = BlobService::new(BlobStore::new(&dir), &mixdog_rt::testing::tokens(), &limits);
    let bytes = b"abc".repeat(8);
    let digest = mixdog_store::blobs::digest_of(&bytes).as_str().to_owned();
    let queues = KeyedQueues::new();
    let mut finished = Vec::new();
    for index in 0..8u64 {
        let params = json!({ "digest": digest, "offset": index * 3, "bytesB64": "YWJj" });
        let (key, access) = key_of(&request("blob/put", params.clone()));
        let (done, finish) = oneshot::channel::<Result<(), String>>();
        finished.push(finish);
        let service = service.clone();
        queues.enqueue(
            key,
            access,
            CancellationToken::new(),
            Box::pin(async move {
                let req = CoreRequest { method: Method("blob/put"), params, op: None, ctx: CallContext::internal("test") };
                let _ = done.send(service.call(req).await.map(|_| ()).map_err(|e| format!("{e:?}")));
            }),
        );
    }
    for finish in finished {
        let outcome = finish.await.unwrap();
        assert!(outcome.is_ok(), "a chunk dispatched with its neighbours is never refused: {outcome:?}");
    }
    let read = CoreRequest { method: Method("blob/read"), params: json!({ "digest": digest }), op: None, ctx: CallContext::internal("test") };
    let Reply::Value(page) = service.call(read).await.unwrap() else { panic!("blob/read answers a value") };
    assert_eq!(page, json!({ "bytesB64": "YWJj".repeat(8) }));
    let _ = std::fs::remove_dir_all(&dir);
}
