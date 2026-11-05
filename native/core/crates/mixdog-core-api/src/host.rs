//! The typed host channel to the desktop (DS §12): ordinary server requests and
//! notifications under `host/*` on the connection that claimed the host scope. Implemented by
//! the server's outgoing router.

use async_trait::async_trait;
use bytes::Bytes;
use serde_json::Value;

use crate::error::CoreError;
use crate::ids::ConnectionId;
use crate::ids::HostId;
use crate::ids::Method;

#[async_trait]
pub trait HostChannel: Send + Sync {
    /// A `host/*` server request to the connection that claimed `host` (`host/claim`). Without
    /// a claimant, or if the claimant closes before answering:
    /// `capabilityUnavailable{capability:"desktopHost"}`. Dropping the future abandons the
    /// request.
    async fn request(
        &self,
        host: &HostId,
        method: Method,
        params: Value,
    ) -> Result<Value, CoreError>;

    /// A `host/*` notification to the claimant of `host`.
    fn notify(&self, host: &HostId, method: Method, params: Value) -> Result<(), CoreError>;
}

/// Binary media frames from a host-role connection (X17: 16-byte header + payload), routed
/// into the live-view encoder. Never waits; the receiver keeps only what its encoder can take.
pub trait HostMediaSink: Send + Sync {
    fn frame(&self, from: ConnectionId, frame: Bytes);
}
