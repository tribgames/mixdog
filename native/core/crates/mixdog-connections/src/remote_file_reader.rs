//! A server file read through this PC's core: the reader a "download to this PC" of a server window steps with. Both answers are
//! the server's raw JSON (the downloader checks every field of them); only the way there is this file's: a ranged read is the
//! server's `transfer/readRange` and a stat its `projectFs/stat`, called on the link's protocol client. A call the connection could
//! not carry fails with the session's own words (why the ssh side stopped), else the client's.

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
        stat_on(self.link.client().as_ref(), root, rel).await.map_err(|error| self.refusal(error))
    }

    async fn read_range(&self, root: &str, rel: &str, offset: u64, length: u64) -> WsResult<Json> {
        read_range_on(self.link.client().as_ref(), root, rel, offset, length).await.map_err(|error| self.refusal(error))
    }
}

impl ServerLinkReader {
    /// What the caller shows: the server's own text for a refusal; for a call the connection could not carry, the words of the
    /// failure that stopped the session when there is one, else the client's own.
    fn refusal(&self, error: ClientError) -> WsError {
        match error {
            ClientError::Rpc(body) => WsError::plain(body.message),
            other => WsError::plain(self.link.stop_reason().unwrap_or_else(|| other.to_string())),
        }
    }
}

impl LinkPool {
    /// The file reader of the server this id names; `None` when no link is held for it.
    pub fn reader(&self, server_id: &str) -> Option<Arc<dyn RemoteFileReader>> {
        let link = self.get(server_id)?;
        Some(Arc::new(ServerLinkReader::new(link)))
    }
}

async fn stat_on(client: &dyn ProtocolClient, root: &str, rel: &str) -> Result<Json, ClientError> {
    let params = ProjectFsStatParams { root: root.to_owned(), rel: rel.to_owned(), access_token: None };
    call(client, "projectFs/stat", &params).await
}

async fn read_range_on(client: &dyn ProtocolClient, root: &str, rel: &str, offset: u64, length: u64) -> Result<Json, ClientError> {
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

async fn call<P: serde::Serialize>(client: &dyn ProtocolClient, method: &str, params: &P) -> Result<Json, ClientError> {
    let params = serde_json::to_value(params).map_err(|e| ClientError::ProtocolViolation(e.to_string()))?;
    client.call_raw(method, params, CallOptions::default()).await
}

#[cfg(test)]
#[path = "remote_file_reader_tests.rs"]
mod tests;
