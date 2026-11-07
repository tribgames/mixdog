//! Feeds fold independently: a feed waiting on a blob stub never delays another feed's updates.
// Test code reads the shared scenario files directly.
#![allow(clippy::disallowed_methods)]

use std::{path::PathBuf, sync::Arc, time::Duration};

use mixdog_app_server_client::{
    ConnectOptions, Json, ProtocolClient, ResumeWindow, Target, ThreadId, connect,
    mock::MockNetwork,
};
use serde_json::json;

fn options() -> Json {
    let path = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/protocol-client/conformance/options.json"
    ));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn thread_result(id: &str) -> Json {
    json!({
        "thread": { "id": id, "preview": "", "title": "T", "updatedAt": 1, "messageCount": 0, "cwd": "/w", "classification": {}, "projectPath": null },
        "subscription": { "id": format!("sub-{id}"), "mode": "snapshot", "epoch": "e1", "startSeq": 1 }
    })
}

#[tokio::test(start_paused = true)]
async fn a_feed_waiting_on_a_blob_does_not_delay_another_feed() {
    let options = options();
    let net = Arc::new(MockNetwork::default());
    let mut opts = ConnectOptions::new(
        Target { id: "local".into() },
        net.clone(),
        serde_json::from_value(options["clientInfo"].clone()).unwrap(),
    );
    opts.capabilities = serde_json::from_value(options["capabilities"].clone()).unwrap();
    let connecting = tokio::spawn(connect(opts));

    let conn = net.accept().await;
    let init: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    let mut result = options["initializeResult"].clone();
    result["serverInstanceId"] = json!("s1");
    conn.server_send(&json!({ "id": init["id"], "result": result }));
    conn.next_sent().await; // initialized
    let client = Arc::new(connecting.await.unwrap().unwrap());

    let resume = |id: &'static str| {
        let c = client.clone();
        tokio::spawn(async move {
            c.resume_thread(&ThreadId::from(id), ResumeWindow::LastItems { last_items: 50 })
                .await
        })
    };
    let (a, b) = (resume("t1"), resume("t2"));
    for _ in 0..2 {
        let req: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
        let id = req["params"]["threadId"].as_str().unwrap().to_string();
        conn.server_send(&json!({ "id": req["id"], "result": thread_result(&id) }));
    }
    a.await.unwrap().unwrap();
    b.await.unwrap().unwrap();

    // t1's snapshot holds a text stub whose read the server never answers.
    let digest = format!("sha256:{}", "a".repeat(64));
    conn.server_send(&json!({ "method": "thread/snapshot", "params": { "text": { "blob": { "digest": digest, "bytes": 5, "mediaType": "text/plain" } } }, "feed": { "id": "t1", "epoch": "e1", "seq": 1 } }));
    let read: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
    assert_eq!(read["method"], "blob/read");
    conn.server_send(&json!({ "method": "thread/snapshot", "params": { "plain": 1 }, "feed": { "id": "t2", "epoch": "e1", "seq": 1 } }));

    let store = client.store();
    tokio::time::timeout(Duration::from_secs(2), async {
        while store.thread("t2").is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("t2 folded while t1 waits on its blob");
    assert!(store.thread("t1").is_none());
}
