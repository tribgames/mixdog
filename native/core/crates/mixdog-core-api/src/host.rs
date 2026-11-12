//! The typed host channel to the desktop (DS §12): ordinary server requests and
//! notifications under `host/*` on the connection that claimed the host scope. Implemented by
//! the server's outgoing router.

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_rt::CancellationToken;
use mixdog_rt::Scope;
use mixdog_rt::Scoped;
use serde_json::Value;
use std::time::Duration;

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
    /// `host/computer/capture` and `host/computer/displays`: the screen reads of Computer Use.
    Computer,
    /// `model/proxy/execute`: runs a model call with the connection's own accounts. Declared
    /// by `capabilities.modelProxy` (not under `capabilities.host`), so a connection serves it
    /// from `initialize` on, without `host/claim`.
    ModelProxy,
}

impl HostCapability {
    /// The longest a `host/*` request to this capability may stay unanswered while its claimant
    /// stays connected (a modal dialog, a wedged handler), where Node bounds it; `None` where
    /// Node does not, and the caller's cancel is then the only end. One table for the whole
    /// channel: `Outgoing::ask` is the only place that enforces it. A request that outlives it
    /// fails as `capabilityUnavailable{desktopHost, timedOut}`.
    ///
    /// Node's values: `systemProxy` 3 s (`apps/desktop/src/main/system-proxy.ts:16`
    /// `SYSTEM_PROXY_RESOLVE_TIMEOUT_MS`, applied at `desktop-service.ts:1120`); the notification
    /// status read 3 s (`desktop-service.ts:842`). Browser, visualize, files, updater, power and
    /// the model proxy have none in Node: a browser takeover may wait for a person for minutes. A Computer Use command
    /// ends at the client's `REQUEST_TIMEOUT_MS`, 150 s (`computer-bridge/client.mjs:36`).
    pub const fn deadline(self) -> Option<Duration> {
        match self {
            Self::SystemProxy | Self::Notifications => Some(Duration::from_secs(3)),
            Self::Computer => Some(Duration::from_secs(150)),
            Self::Browser | Self::Visualize | Self::Files | Self::Updater | Self::Power | Self::ModelProxy => None,
        }
    }

    /// The liveness a streamed request to this capability keeps (see [`Lease`]); `None` where the
    /// claimant is not asked to vouch for the request while it works. Enforced by the one streamed
    /// wait, `Outgoing::request_streamed`.
    pub const fn lease(self) -> Option<Lease> {
        match self {
            Self::ModelProxy => Some(Lease::MODEL_PROXY),
            _ => None,
        }
    }
}

/// How long a claimant may stay silent on a request it was sent: the claim window until its first
/// sign of life (a heartbeat or a streamed event), the lease after every one. A request that
/// outlives either ends as `capabilityUnavailable{desktopHost, notClaimed | leaseLapsed}`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Lease {
    pub claim: Duration,
    pub renew: Duration,
}

impl Lease {
    /// Node's model proxy channel: `CLAIM_TIMEOUT_MS` 10 s and `MODEL_PROXY_LEASE_MS` 20 s
    /// (`model-proxy-channel.mjs`); the PC's heartbeat comes every `MODEL_PROXY_HEARTBEAT_MS`
    /// 5 s, well inside the lease.
    pub const MODEL_PROXY: Self = Self { claim: Duration::from_secs(10), renew: Duration::from_secs(20) };
}

/// The detail of a `capabilityUnavailable{desktopHost}` that ended a streamed request: no claimant.
pub const NO_CLAIMANT: &str = "noClaimant";
/// The claimant closed before it answered.
pub const CLAIMANT_CLOSED: &str = "claimantClosed";
/// The claimant never claimed the request inside [`Lease::claim`].
pub const NOT_CLAIMED: &str = "notClaimed";
/// The claimant stopped vouching for a claimed request for longer than [`Lease::renew`].
pub const LEASE_LAPSED: &str = "leaseLapsed";

/// Node's `ModelProxyUnavailableError` message (`model proxy unavailable: <detail>`) for a
/// `model/proxy/execute` that got no answer. Every consumer of the model proxy reads a missing PC
/// through this one table: the broker's server end and the quota channel.
pub fn model_proxy_unavailable_text(error: &CoreError) -> &'static str {
    let detail = match error {
        CoreError::CapabilityUnavailable { detail, .. } => &**detail,
        _ => CLAIMANT_CLOSED,
    };
    match detail {
        NO_CLAIMANT => "model proxy unavailable: no desktop client is connected to run model calls",
        NOT_CLAIMED => "model proxy unavailable: the desktop client did not pick up the model call",
        LEASE_LAPSED => "model proxy unavailable: the desktop client stopped responding",
        _ => "model proxy unavailable: the desktop client disconnected",
    }
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

    /// [`HostChannel::request`] that also ends when `cancel` fires, as
    /// `capabilityUnavailable{desktopHost, cancelled}`, and abandons the request.
    async fn request_scoped(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, HostError> {
        match Scope::new().cancel(cancel).run(self.request(capability, method, params)).await {
            Scoped::Done(answer) => answer,
            _ => Err(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "cancelled".into() }.into()),
        }
    }

    /// Whether a claimant serving `capability` is connected now: the check Node's client makes first, by reading the
    /// bridge's discovery file, before it validates or dispatches anything. A channel that cannot tell answers true and
    /// leaves the refusal to the request.
    fn serves(&self, capability: HostCapability) -> bool {
        let _ = capability;
        true
    }

    /// A `host/*` notification to the claimant serving `capability`.
    fn notify(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(), CoreError>;

    /// [`HostChannel::request`] whose claimant streams events while it works (`model/proxy/execute`
    /// answers with `model/proxy/event{requestId, event}` notifications ahead of its response).
    /// Each event reaches `on_event` in the order sent, all of them before the result. A
    /// capability with a [`HostCapability::lease`] must vouch for the request (`stream_alive`, or
    /// an event) inside it, or the request ends `notClaimed` / `leaseLapsed`. A channel that
    /// carries no streamed request has no claimant for it.
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

    /// `from` vouches for request `request` (the heartbeat of a streamed request): the first
    /// claims it, each renews its lease ([`Lease`]). `false` when that connection has no such
    /// request pending.
    fn stream_alive(&self, from: ConnectionId, request: &Value) -> bool {
        let _ = (from, request);
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

/// The model-proxy client's generation, as Node's `ModelProxyChannel.generation`: the value changes
/// whenever the client behind the channel may have changed (one connects, one goes away), and the
/// receiver wakes then. An answer learned under one generation is not served to the next, and a read
/// that found no client waits on it for one to connect.
pub trait ClientEpoch: Send + Sync {
    fn client_epoch(&self) -> tokio::sync::watch::Receiver<u64>;
}

/// Whether a connection that can answer a server request of `thread`, shown on `surface`, is
/// attached right now: the eligibility rule of P §8.3 (a live subscriber of either feed, or an
/// `approvalsInbox` connection past its handshake), asked of the connections as they are.
pub trait ApprovalPresence: Send + Sync {
    fn answerable(&self, thread: &crate::ids::ThreadId, surface: &crate::ids::ThreadId) -> bool;
}

/// Whether a person's approval card can be answered for a thread: a client that answers its
/// approvals is attached to the thread's feed (Node: the run has a `toolApprovalHook`, which a
/// client's turn sets for the turn's length; `resolvePreToolAskApproval` holds a run's request
/// only when it has none).
pub trait ApprovalSurfaces: Send + Sync {
    fn attached(&self, thread: &crate::ids::ThreadId) -> bool;
}

/// Binary media frames from a host-role connection (X17: 16-byte header + payload), routed
/// into the live-view encoder. Never waits; the receiver keeps only what its encoder can take.
pub trait HostMediaSink: Send + Sync {
    fn frame(&self, from: ConnectionId, frame: Bytes);
}
