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
    /// `model/proxy/execute`: runs a model call with the connection's own accounts. Declared
    /// by `capabilities.modelProxy` (not under `capabilities.host`), so a connection serves it
    /// from `initialize` on, without `host/claim`.
    ModelProxy,
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

    /// [`HostChannel::request`] whose claimant streams events while it works (`model/proxy/execute`
    /// answers with `model/proxy/event{requestId, event}` notifications ahead of its response).
    /// Each event reaches `on_event` in the order sent, all of them before the result. A channel
    /// that carries no streamed request has no claimant for it.
    async fn request_streamed(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
        on_event: &mut (dyn FnMut(Value) + Send),
    ) -> Result<Value, HostError> {
        let _ = (capability, method, params, on_event);
        Err(CoreError::CapabilityUnavailable {
            capability: "desktopHost".into(),
            detail: "noClaimant".into(),
        }
        .into())
    }

    /// One streamed event of request `request` arrived from `from`. `false` when that connection
    /// has no such request pending, so a stray or late event is dropped by the caller.
    fn stream_event(&self, from: ConnectionId, request: &Value, event: Value) -> bool {
        let _ = (from, request, event);
        false
    }
}

/// The claim that served a host request: the desktop's `hostId`, its connection and the number
/// of its claim (new for every `host/claim`, so a reconnect of the same desktop is another claim).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct HostClaim {
    pub host: crate::ids::HostId,
    pub connection: ConnectionId,
    pub generation: u64,
}

/// A host channel whose requests can be bound to the claim that served an earlier one, for a
/// payload that must reach that desktop and no other (a secret value).
#[async_trait]
pub trait ClaimedHostChannel: HostChannel {
    /// [`HostChannel::request`], also naming the claim that served it.
    async fn request_claimed(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(HostClaim, Value), HostError>;

    /// [`HostChannel::request`] addressed to `claim` alone: refused as
    /// `capabilityUnavailable{desktopHost}` unless `claim` is still the one serving
    /// `capability` (a newer claimant, or a reconnect, ends it), checked as the request is sent.
    async fn request_to(
        &self,
        claim: &HostClaim,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<Value, HostError>;
}

/// A notification to one connection by id (the `@connection` delivery of the method table, for
/// example `modelProxy/run/event` to the connection that asked). Never waits.
pub trait ConnectionNotifier: Send + Sync {
    /// `Err` when the connection is gone or closing.
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError>;
}

/// Whether a desktop window is attached: a connection of kind `desktop` live on the app feed
/// (Node's `mainWindow` check in `main/index.ts` `sendToWindow`). Paired phones, remote
/// desktops, TUIs and the CLI are not windows.
pub trait DesktopPresence: Send + Sync {
    fn desktop_attached(&self) -> bool;
}

/// Binary media frames from a host-role connection (X17: 16-byte header + payload), routed
/// into the live-view encoder. Never waits; the receiver keeps only what its encoder can take.
pub trait HostMediaSink: Send + Sync {
    fn frame(&self, from: ConnectionId, frame: Bytes);
}
