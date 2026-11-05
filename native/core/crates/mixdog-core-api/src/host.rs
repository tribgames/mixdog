//! The typed host channel to the desktop (DS §12): ordinary server requests and
//! notifications under `host/*` on the connection that claimed the host scope. Implemented by
//! the server's outgoing router.

use async_trait::async_trait;
use bytes::Bytes;
use serde_json::Value;

use crate::error::CoreError;
use crate::ids::ConnectionId;
use crate::ids::Method;

/// What a desktop declared in `capabilities.host` at `initialize` and serves for the core. A
/// caller addresses the desktop by the capability it needs, never by the `hostId` the desktop
/// chose for `host/claim`: the channel routes to the latest claimant that declared it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum HostCapability {
    /// `host/browser/command`.
    Browser,
    /// `host/visualize/command`.
    Visualize,
    /// `host/notification/show`.
    Notifications,
    /// `host/systemProxy/resolve`.
    SystemProxy,
    /// `host/power`.
    Power,
    /// `host/update/command`.
    Updater,
    /// File snapshots and the local page server.
    Files,
}

/// Why a `host/*` request produced no result.
#[derive(Clone, PartialEq, Debug)]
pub enum HostError {
    /// The request never got an answer: no claimant, or it closed first
    /// (`capabilityUnavailable{capability:"desktopHost"}`).
    Core(CoreError),
    /// The claimant answered with a JSON-RPC error, passed through intact. `message` is as
    /// the host wrote it (already redacted); `data` (e.g. `data.timing`) is diagnostics for
    /// logs, never model text.
    Rpc {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

impl From<CoreError> for HostError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}

#[async_trait]
pub trait HostChannel: Send + Sync {
    /// A `host/*` server request to the connection that claimed the host role (`host/claim`)
    /// and declared `capability`; the latest such claim wins, and an earlier live one serves
    /// once it is gone. Without one, or if the claimant closes before answering:
    /// `HostError::Core(capabilityUnavailable{capability:"desktopHost"})` at once, never a wait;
    /// a JSON-RPC error answer: `HostError::Rpc`. Dropping the future abandons the request.
    async fn request(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<Value, HostError>;

    /// A `host/*` notification to the claimant serving `capability`.
    fn notify(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(), CoreError>;
}

/// Binary media frames from a host-role connection (X17: 16-byte header + payload), routed
/// into the live-view encoder. Never waits; the receiver keeps only what its encoder can take.
pub trait HostMediaSink: Send + Sync {
    fn frame(&self, from: ConnectionId, frame: Bytes);
}
