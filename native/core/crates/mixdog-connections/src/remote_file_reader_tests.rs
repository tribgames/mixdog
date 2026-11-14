//! The two calls over a scripted client: the method and params that leave, and the answer or refusal that comes back; and the pool's
//! reader over a real link whose server is scripted frame by frame.

use std::sync::Mutex;

use mixdog_app_protocol::JsonRpcErrorBody;
use mixdog_app_server_client::mock::MockConn;
use mixdog_app_server_client::api::{
    BlobRef, ClientEvent, ConnectionStatus, FoldStore, InitializeResponse, ResumeWindow, ServerRequest, ServerRequestAnswer, ThreadId,
    ThreadResumeResponse,
};
use serde_json::json;
use tokio::sync::broadcast;

use super::*;
use crate::link::tests::{open_link, rig, stop_session, within};

struct Scripted {
    reply: Mutex<Option<Result<Json, ClientError>>>,
    calls: Mutex<Vec<(String, Json)>>,
}

fn scripted(reply: Result<Json, ClientError>) -> Scripted {
    Scripted { reply: Mutex::new(Some(reply)), calls: Mutex::new(Vec::new()) }
}

#[async_trait]
impl ProtocolClient for Scripted {
    fn store(&self) -> Arc<dyn FoldStore> {
        unreachable!("a file read never reads the store")
    }
    fn server(&self) -> InitializeResponse {
        unreachable!("a file read never reads the initialize result")
    }
    fn status(&self) -> ConnectionStatus {
        ConnectionStatus::Ready { server_instance_id: "s".into() }
    }
    async fn call_raw(&self, method: &str, params: Json, _options: CallOptions) -> Result<Json, ClientError> {
        self.calls.lock().unwrap().push((method.to_owned(), params));
        self.reply.lock().unwrap().take().expect("one call per script")
    }
    async fn notify(&self, _method: &str, _params: Json) -> Result<(), ClientError> {
        Ok(())
    }
    async fn resume_thread(&self, _thread_id: &ThreadId, _window: ResumeWindow) -> Result<ThreadResumeResponse, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn unsubscribe_thread(&self, _thread_id: &ThreadId) -> Result<(), ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn subscribe_app(&self) -> Result<(), ClientError> {
        Ok(())
    }
    fn pending_server_requests(&self) -> Vec<ServerRequest> {
        Vec::new()
    }
    async fn respond(&self, _id: mixdog_app_server_client::api::RequestId, _answer: ServerRequestAnswer) -> Result<(), ClientError> {
        Ok(())
    }
    async fn read_blob(&self, _blob: &BlobRef) -> Result<Vec<u8>, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn put_blob(&self, _bytes: &[u8], _media_type: &str) -> Result<BlobRef, ClientError> {
        Err(ClientError::ClientClosed)
    }
    fn events(&self) -> broadcast::Receiver<ClientEvent> {
        broadcast::channel(1).1
    }
    async fn close(&self) {}
}

#[tokio::test]
async fn stat_asks_the_servers_project_stat_and_returns_its_answer_untouched() {
    let client = scripted(Ok(json!({ "size": 7, "mtimeMs": 1.5, "directory": false })));
    let answer = stat_on(&client, "/srv/p", "a/b.txt").await.unwrap();
    assert_eq!(answer, json!({ "size": 7, "mtimeMs": 1.5, "directory": false }));
    let calls = client.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "projectFs/stat");
    assert_eq!(calls[0].1, json!({ "root": "/srv/p", "rel": "a/b.txt" }));
}

#[tokio::test]
async fn read_range_asks_the_servers_transfer_read_with_the_offset_and_length() {
    let client = scripted(Ok(json!({ "data": "AAEC", "eof": true })));
    let answer = read_range_on(&client, "/srv/p", "big.bin", 4_194_304, 3).await.unwrap();
    assert_eq!(answer, json!({ "data": "AAEC", "eof": true }));
    let calls = client.calls.lock().unwrap();
    assert_eq!(calls[0].0, "transfer/readRange");
    assert_eq!(calls[0].1, json!({ "root": "/srv/p", "rel": "big.bin", "offset": 4_194_304u64, "length": 3 }));
}

#[tokio::test]
async fn a_refusal_of_the_server_reaches_the_caller_as_the_clients_error() {
    let client = scripted(Err(ClientError::Rpc(JsonRpcErrorBody { code: -32000, data: None, message: "No such file".into() })));
    let ClientError::Rpc(body) = read_range_on(&client, "/r", "x", 0, 1).await.unwrap_err() else { panic!("not the server's refusal") };
    assert_eq!(body.message, "No such file");
}

#[tokio::test]
async fn a_lost_connection_reaches_the_caller_as_the_clients_error() {
    let client = scripted(Err(ClientError::ConnectionLost));
    assert!(matches!(stat_on(&client, "/r", "x").await, Err(ClientError::ConnectionLost)));
}

// ----- the pool's reader over a link -----------------------------------------------------------

/// Waits for the call of `method` the client sends and answers it with `answer` (`result` or `error`).
async fn answer(conn: &MockConn, method: &str, mut answer: Json) -> Json {
    within(async {
        loop {
            let frame: Json = serde_json::from_str(&conn.next_sent().await).unwrap();
            if frame["method"] == method {
                answer["id"] = frame["id"].clone();
                conn.server_send(&answer);
                return frame;
            }
        }
    })
    .await
}

#[tokio::test]
async fn the_pool_has_a_reader_for_a_linked_server_and_none_for_any_other() {
    let rig = rig().await;
    assert!(rig.pool.reader("box").is_none(), "no link yet");
    let (_link, conn, _) = open_link(&rig).await;
    let reader = rig.pool.reader("box").expect("a reader for the linked server");
    assert!(rig.pool.reader("other").is_none());

    let stat = {
        let reader = reader.clone();
        tokio::spawn(async move { reader.stat("/srv/p", "a/b.txt").await })
    };
    let sent = answer(&conn, "projectFs/stat", json!({ "result": { "size": 7, "directory": false } })).await;
    assert_eq!(sent["params"], json!({ "root": "/srv/p", "rel": "a/b.txt" }));
    assert_eq!(within(stat).await.unwrap().unwrap(), json!({ "size": 7, "directory": false }));

    let read = tokio::spawn(async move { reader.read_range("/srv/p", "big.bin", 4_194_304, 3).await });
    let sent = answer(&conn, "transfer/readRange", json!({ "result": { "data": "AAEC", "eof": true } })).await;
    assert_eq!(sent["params"], json!({ "root": "/srv/p", "rel": "big.bin", "offset": 4_194_304u64, "length": 3 }));
    assert_eq!(within(read).await.unwrap().unwrap(), json!({ "data": "AAEC", "eof": true }));
}

#[tokio::test]
async fn the_reader_of_a_link_shows_the_servers_own_words_for_a_refusal() {
    let rig = rig().await;
    let (_link, conn, _) = open_link(&rig).await;
    let reader = rig.pool.reader("box").unwrap();
    let stat = tokio::spawn(async move { reader.stat("/srv/p", "gone").await });
    answer(&conn, "projectFs/stat", json!({ "error": { "code": -32000, "message": "No such file" } })).await;
    assert_eq!(within(stat).await.unwrap().unwrap_err().message, "No such file");
}

#[tokio::test]
async fn a_call_the_connection_could_not_carry_fails_with_the_sessions_error_not_a_wording_of_this_file() {
    // A link whose client ended: the client's own error, nothing of this file's.
    let rig = rig().await;
    let (link, _conn, _) = open_link(&rig).await;
    let reader = rig.pool.reader("box").unwrap();
    link.close().await;
    let error = within(reader.stat("/r", "x")).await.unwrap_err();
    assert_eq!(error.message, ClientError::ClientClosed.to_string());

    // A link whose ssh side stopped for a reason: that reason.
    let rig = rig().await;
    let (link, _conn, _) = open_link(&rig).await;
    let reader = rig.pool.reader("box").unwrap();
    stop_session(&link);
    link.close().await;
    let error = within(reader.read_range("/r", "x", 0, 1)).await.unwrap_err();
    assert_eq!(error.message, "Host key verification failed.");
}
