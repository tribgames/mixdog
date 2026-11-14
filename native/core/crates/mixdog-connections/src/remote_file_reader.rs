//! A server file read through this PC's core: the reader a "download to this PC" of a server window steps with. Both answers are
//! the server's raw JSON (the downloader checks every field of them); only the way there is this file's: a ranged read is the
//! server's `transfer/readRange` and a stat its `projectFs/stat`, called on the link's protocol client.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::{ProjectFsStatParams, TransferReadRangeParams};
use mixdog_app_server_client::api::{CallOptions, ClientError, Json, ProtocolClient};
use mixdog_workspace::RemoteFileReader;
use mixdog_workspace::error::{WsError, WsResult};

use crate::link::{LinkPool, ServerLink};

/// The reader of one server's files, over its link.
pub struct ServerLinkReader {
    link: Arc<ServerLink>,
}

impl ServerLinkReader {
    pub fn new(link: Arc<ServerLink>) -> Self {
        Self { link }
    }
}

#[async_trait]
impl RemoteFileReader for ServerLinkReader {
    async fn stat(&self, root: &str, rel: &str) -> WsResult<Json> {
        stat_on(self.link.client().as_ref(), root, rel).await
    }

    async fn read_range(&self, root: &str, rel: &str, offset: u64, length: u64) -> WsResult<Json> {
        read_range_on(self.link.client().as_ref(), root, rel, offset, length).await
    }
}

impl LinkPool {
    /// The file reader of the server this id names; `None` when no link is held for it.
    pub fn reader(&self, server_id: &str) -> Option<Arc<dyn RemoteFileReader>> {
        let link = self.get(server_id)?;
        Some(Arc::new(ServerLinkReader::new(link)))
    }
}

async fn stat_on(client: &dyn ProtocolClient, root: &str, rel: &str) -> WsResult<Json> {
    let params = ProjectFsStatParams { root: root.to_owned(), rel: rel.to_owned(), access_token: None };
    call(client, "projectFs/stat", &params).await
}

async fn read_range_on(client: &dyn ProtocolClient, root: &str, rel: &str, offset: u64, length: u64) -> WsResult<Json> {
    let params = TransferReadRangeParams {
        transfer_id: None,
        root: Some(root.to_owned()),
        rel: Some(rel.to_owned()),
        offset,
        length,
        version: None,
    };
    call(client, "transfer/readRange", &params).await
}

async fn call<P: serde::Serialize>(client: &dyn ProtocolClient, method: &str, params: &P) -> WsResult<Json> {
    let params = serde_json::to_value(params).map_err(|e| WsError::plain(e.to_string()))?;
    client.call_raw(method, params, CallOptions::default()).await.map_err(refusal)
}

/// What the caller shows: the server's own text for a refusal, this PC's wording for a lost connection.
fn refusal(error: ClientError) -> WsError {
    match error {
        ClientError::Rpc(body) => WsError::plain(body.message),
        ClientError::ConnectionLost | ClientError::ClientClosed => WsError::plain("The connection to the server was lost."),
        other => WsError::plain(other.to_string()),
    }
}

#[cfg(test)]
#[path = "remote_file_reader_tests.rs"]
mod tests;
