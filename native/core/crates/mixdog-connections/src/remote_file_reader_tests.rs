//! The two calls over a scripted client: the method and params that leave, and the answer or refusal that comes back.

use std::sync::Mutex;

use mixdog_app_protocol::JsonRpcErrorBody;
use mixdog_app_server_client::api::{
    BlobRef, ClientEvent, ConnectionStatus, FoldStore, InitializeResponse, ResumeWindow, ServerRequest, ServerRequestAnswer, ThreadId,
    ThreadResumeResponse,
};
use serde_json::json;
use tokio::sync::broadcast;

use super::*;

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
async fn a_refusal_of_the_server_keeps_its_text() {
    let client = scripted(Err(ClientError::Rpc(JsonRpcErrorBody { code: -32000, data: None, message: "No such file".into() })));
    let error = read_range_on(&client, "/r", "x", 0, 1).await.unwrap_err();
    assert_eq!(error.message, "No such file");
}

#[tokio::test]
async fn a_lost_connection_is_said_in_this_pcs_words() {
    let client = scripted(Err(ClientError::ConnectionLost));
    let error = stat_on(&client, "/r", "x").await.unwrap_err();
    assert_eq!(error.message, "The connection to the server was lost.");
}
