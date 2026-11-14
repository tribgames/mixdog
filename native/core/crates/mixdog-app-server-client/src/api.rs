//! Frozen client-library API (P0-CLIENT). Mirrors `packages/protocol-client/src/api.ts`; spec: protocol.md §2.5, §3, §4.4, §6,
//! §7.3, §8, §9, SPEC R1, R2, R6, R7, R12, R14, desktop-services.md §2.3.
//!
//! Every wire type is `mixdog-app-protocol` / `mixdog-protocol`'s own; this module defines only client behaviour. Per-method
//! facts (`class`, mutation, op scope) come from `CLIENT_METHODS`, the table the golden `schema/method_table.json` is built from.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Serialize, de::DeserializeOwned};
use tokio::sync::broadcast;

pub use mixdog_app_protocol::{
    ErrorData, FeedStamp, JsonRpcErrorBody, JsonRpcNotification as RpcNotification, OpScopeRule,
    RequestClass, RequestId, ServerRequest,
    limits::Limits,
    v1::{ClientInfo, InitializeCapabilities, InitializeResponse},
    v2::{
        approval::ServerRequestResolvedParams,
        feed::{APP_FEED_ID, ResumeWindow, Subscription},
        op::{OpState, OpStatusEntry},
        thread::ThreadResumeResponse,
    },
};
pub use mixdog_protocol::{
    BlobDescriptor, BlobRef, JsonValue as Json, OpId, SectionName, SectionUpdate, ThreadId,
};

pub type OpScope = String;

// ───────────── method info, derived from the generated table ─────────────

/// What the client needs of a `MethodSpec` row.
#[derive(Debug, Clone, Copy)]
pub struct MethodInfo {
    pub class: RequestClass,
    /// `OpScopeRule::None` for non-mutations; every other rule means `params.opId` is required (§9.1).
    pub op_scope: OpScopeRule,
}

impl MethodInfo {
    pub fn is_mutation(&self) -> bool {
        !matches!(self.op_scope, OpScopeRule::None)
    }

    /// The `op/status` scope of a mutation (§9.2): `thread:<params[field]>` when present, else the domain.
    /// The rule's `field` is a wire path; a dotted path (`args.sessionId`) walks nested objects.
    pub fn op_scope_of(&self, params: &Json) -> Option<OpScope> {
        let thread = |field: &str| {
            field
                .split('.')
                .try_fold(params, |v, seg| v.get(seg))
                .and_then(Json::as_str)
                .map(|id| format!("thread:{id}"))
        };
        match self.op_scope {
            OpScopeRule::None => None,
            OpScopeRule::Domain { domain } => Some(domain.wire().to_string()),
            OpScopeRule::Thread { field } => thread(field),
            OpScopeRule::ThreadOrDomain { field, domain } => {
                thread(field).or_else(|| Some(domain.wire().to_string()))
            }
        }
    }
}

/// `None` for a method not in the table.
pub fn method_info(method: &str) -> Option<MethodInfo> {
    mixdog_app_protocol::client_method_spec(method).map(|s| MethodInfo {
        class: s.class,
        op_scope: s.op_scope,
    })
}
// ───────────── transport (mock-able seam) ─────────────

/// Opaque to the client; the connector resolves it (local discovery, an SSH tunnel endpoint, the relay). One ladder per target.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportEvent {
    Frame(String),
    /// Delivered once; the only reconnect trigger (SPEC H17).
    Closed {
        code: u16,
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub struct TransportClosed;

/// Outbound half. One JSON message per text frame.
#[async_trait]
pub trait TransportWriter: Send {
    async fn send(&mut self, text: String) -> Result<(), TransportClosed>;
    /// After `close`, the reader still yields its `Closed` event.
    async fn close(&mut self, code: u16, reason: String);
}

#[async_trait]
pub trait TransportReader: Send {
    async fn recv(&mut self) -> TransportEvent;
}

pub struct TransportHalves {
    pub writer: Box<dyn TransportWriter>,
    pub reader: Box<dyn TransportReader>,
}

#[async_trait]
pub trait Connector: Send + Sync {
    /// Re-resolves credentials on every call (the discovery token may have changed). `Err` if no socket could be opened.
    async fn open(&self, target: &Target) -> Result<TransportHalves, String>;
}

#[async_trait]
pub trait Clock: Send + Sync {
    async fn sleep(&self, ms: u64);
    /// Uniform in [0, 1) for ladder jitter.
    fn jitter(&self) -> f64;
}

#[derive(Debug, Clone, Copy)]
pub struct LadderConfig {
    pub base_ms: u64,
    pub cap_ms: u64,
}
/// SPEC H17: 250 ms → 5 s, full jitter.
pub const DEFAULT_LADDER: LadderConfig = LadderConfig {
    base_ms: 250,
    cap_ms: 5000,
};

// ───────────── errors ─────────────

#[derive(Debug, Clone, thiserror::Error)]
pub enum ClientError {
    /// A JSON-RPC error. Branch on `code` + `reason()`; `error_data()` is the typed form.
    #[error("rpc error {}: {}", .0.code, .0.message)]
    Rpc(JsonRpcErrorBody),
    /// Non-mutation request in flight when the socket closed. Never retried by the library.
    #[error("connection lost")]
    ConnectionLost,
    #[error("client closed")]
    ClientClosed,
    /// initialize refused by the version gate; terminal, no ladder (§4.4). `reason`: clientOutdated | serverOutdated.
    #[error("version refused: {reason}")]
    VersionRefused {
        reason: String,
        server_version: String,
        client_version: String,
    },
    #[error("unknown method {0}")]
    UnknownMethod(String),
    /// `op/status` said the mutation never ran and now never will (fenced). The caller decides whether to issue a new op.
    #[error("op {0} not applied")]
    OpNotApplied(String),
    /// The outcome cannot be known: `expired` or `externalUnknown` (§9.4, §9.6), or `statusFailed` when the `op/status`
    /// call itself failed for good (`cause`).
    #[error("op {op_id} outcome unknown ({state})")]
    OpOutcomeUnknown {
        op_id: String,
        state: String,
        cause: Option<Box<ClientError>>,
    },
    /// The blob is permanently unavailable (`blobNotFound`). Fails only the one read or stub resolution.
    #[error("blob {0} not found")]
    BlobNotFound(String),
    /// The stored bytes failed verification (`blobCorrupt`). Fails only the one read or stub resolution.
    #[error("blob {0} corrupt")]
    BlobCorrupt(String),
    #[error("protocol violation: {0}")]
    ProtocolViolation(String),
    /// The connector could not open a socket.
    #[error("connector: {0}")]
    Connector(String),
}

impl ClientError {
    /// Same strings as `ClientErrorDetail.kind` in api.ts.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Rpc(_) => "rpc",
            Self::ConnectionLost => "connectionLost",
            Self::ClientClosed => "clientClosed",
            Self::VersionRefused { .. } => "versionRefused",
            Self::UnknownMethod(_) => "unknownMethod",
            Self::OpNotApplied(_) => "opNotApplied",
            Self::OpOutcomeUnknown { .. } => "opOutcomeUnknown",
            Self::BlobNotFound(_) => "blobNotFound",
            Self::BlobCorrupt(_) => "blobCorrupt",
            Self::ProtocolViolation(_) => "protocolViolation",
            Self::Connector(_) => "connector",
        }
    }

    pub fn error_data(&self) -> Option<ErrorData> {
        match self {
            Self::Rpc(body) => ErrorData::from_body(body),
            _ => None,
        }
    }

    pub fn reason(&self) -> Option<String> {
        self.error_data().map(|d| d.reason())
    }
}

// ───────────── feeds, store, fold ─────────────

/// The folded view of one thread feed. `state` is the reducer's output (the DesktopSessionState projection, WP-CLIENT-RS/TS).
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadFold {
    /// Position of the last notification folded in.
    pub feed: FeedStamp,
    pub state: Json,
}

/// Pure fold. `snapshot` is the `thread/snapshot` params; notifications have every text blob stub already resolved.
/// Called in feed order, never concurrently.
pub trait ThreadReducer: Send + Sync {
    fn initial(&self, snapshot: &Json) -> Json;
    fn apply(&self, state: &Json, notification: &RpcNotification) -> Json;
}

/// One entry of the section store (desktop-services.md §2.1, §2.3). A stubbed section keeps `value = null`.
#[derive(Debug, Clone, PartialEq)]
pub struct SectionEntry {
    pub section: SectionName,
    pub key: Option<String>,
    pub revision: u64,
    pub value: Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreChange {
    Thread {
        thread_id: String,
    },
    Section {
        section: SectionName,
        key: Option<String>,
    },
}

/// Read side of the fold store. `store[section][key] = value` iff `revision > stored.revision`; `removed` deletes.
pub trait FoldStore: Send + Sync {
    fn thread(&self, thread_id: &str) -> Option<ThreadFold>;
    fn section(&self, section: SectionName, key: Option<&str>) -> Option<SectionEntry>;
    fn sections(&self, section: SectionName) -> Vec<SectionEntry>;
    fn app_feed(&self) -> Option<FeedStamp>;
    /// Notified after each fold, in order.
    fn subscribe(&self) -> broadcast::Receiver<StoreChange>;
}

// ───────────── server requests (§8) ─────────────

#[derive(Debug, Clone)]
pub enum ServerRequestAnswer {
    Result(Json),
    Error {
        code: i64,
        message: String,
        data: Option<Json>,
    },
}

// ───────────── client ─────────────

#[derive(Debug, Clone)]
pub enum ConnectionStatus {
    Ready {
        server_instance_id: String,
    },
    /// Socket closed; `attempt` counts ladder rounds since the last successful initialize.
    Reconnecting {
        attempt: u32,
    },
    /// Terminal: `close()` or a version refusal.
    Closed {
        reason: ClientError,
    },
}

#[derive(Debug, Clone)]
pub enum ClientEvent {
    Status(ConnectionStatus),
    /// Delivered in order. One offered to every eligible connection (an approval, P §8.3) is held in
    /// `pending_server_requests` until `serverRequest/resolved` arrives or the socket closes (the core re-delivers). One
    /// addressed to a capability this client declared (`ServerRequest::requires`) is not held: its handler's answer ends it. A
    /// method this client's protocol does not know (a newer core's) does not parse: it is a `ProtocolViolation`, never held.
    ServerRequest(ServerRequest),
    /// The core resolved a held request, or stopped waiting for a `host/*` one it got no answer to (its handler stops; a
    /// `model/proxy/execute` one is given up with the `model/proxy/cancel` notification instead).
    ServerRequestResolved(ServerRequestResolvedParams),
    /// Connection-scoped notifications (no `feed`) other than `serverRequest/resolved`, and app-feed notifications that are
    /// not sections.
    Notification(RpcNotification),
    /// Restoring a subscription after reconnect failed with a typed error; the subscription is dropped.
    SubscriptionLost {
        thread_id: String,
        error: ClientError,
    },
    /// A blob stub inside a feed notification could not be resolved. The stub stays in the folded notification, the feed
    /// continues and the connection stays open.
    BlobUnavailable {
        feed: FeedStamp,
        error: ClientError,
    },
    /// The library closed the socket with 1002/1007 because the peer broke an invariant (a feed gap, bad JSON); the ladder follows.
    ProtocolViolation(String),
}

#[derive(Debug, Clone, Default)]
pub struct CallOptions {
    /// Mutations only: reuse an existing op id (default: a fresh UUIDv7).
    pub op_id: Option<String>,
}

/// Object-safe client contract. Semantics (identical to api.ts `ProtocolClient`):
/// - Mutations get `params.opId` and are never auto-retried with a new one: on socket loss the library reconciles through
///   `op/status{fence:true}` after reconnect and settles the call from the answer (see `ClientError`).
/// - `-32001` is retried on its trigger (SPEC R7): `inflightLimit`/`queueFull` after a response to an own request, `windowFull`
///   after the next feed event of that thread. Never time based.
/// - Non-mutations in flight at socket loss fail `ConnectionLost`.
/// - While reconnecting, calls wait for the connection (in order); after `Closed` they fail.
#[async_trait]
pub trait ProtocolClient: Send + Sync {
    fn store(&self) -> Arc<dyn FoldStore>;
    /// Latest `initialize` result (replaced on every reconnect).
    fn server(&self) -> InitializeResponse;
    fn status(&self) -> ConnectionStatus;

    async fn call_raw(
        &self,
        method: &str,
        params: Json,
        options: CallOptions,
    ) -> Result<Json, ClientError>;
    /// Client notification (`terminal/input`, `terminal/resize`, `client/perfLog`, ...). `ConnectionLost` when not ready.
    async fn notify(&self, method: &str, params: Json) -> Result<(), ClientError>;

    /// `thread/resume`. Registers the subscription for restore after reconnect, sending the folded position as `resumeFrom`.
    async fn resume_thread(
        &self,
        thread_id: &ThreadId,
        window: ResumeWindow,
    ) -> Result<ThreadResumeResponse, ClientError>;
    /// `thread/unsubscribe`; drops the folded thread. Never stops work (X10).
    async fn unsubscribe_thread(&self, thread_id: &ThreadId) -> Result<(), ClientError>;
    /// `app/subscribe`, restored on reconnect with `resumeFrom`.
    async fn subscribe_app(&self) -> Result<(), ClientError>;

    /// The held requests (see [`ClientEvent::ServerRequest`]): the ones offered to every eligible connection that the core
    /// has not resolved.
    fn pending_server_requests(&self) -> Vec<ServerRequest>;
    /// A held request's validity is the core's decision (`serverRequest/resolved` follows); an addressed one is ended by the
    /// answer. `ConnectionLost` when not ready.
    async fn respond(&self, id: RequestId, answer: ServerRequestAnswer) -> Result<(), ClientError>;

    /// Reads all pages of a blob (`blob/read`, page ≤ `server().limits.max_blob_page_bytes`). `BlobNotFound`/`BlobCorrupt`
    /// fail this read only.
    async fn read_blob(&self, blob: &BlobRef) -> Result<Vec<u8>, ClientError>;
    /// Uploads in raw chunks ≤ `server().limits.max_blob_put_chunk_bytes` (`blob/put`, SPEC R1) and returns the ref to put
    /// into a request.
    async fn put_blob(&self, bytes: &[u8], media_type: &str) -> Result<BlobRef, ClientError>;

    fn events(&self) -> broadcast::Receiver<ClientEvent>;
    /// Closes the socket with 1000 and stops the ladder. Pending calls fail `ClientClosed`. Idempotent.
    async fn close(&self);
}

/// Typed calls over the raw one. Mutation detection and opId assignment stay in `call_raw`, driven by the table.
#[async_trait]
pub trait ProtocolClientExt: ProtocolClient {
    async fn call_typed<P, R>(
        &self,
        method: &str,
        params: &P,
        options: CallOptions,
    ) -> Result<R, ClientError>
    where
        P: Serialize + Sync,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params)
            .map_err(|e| ClientError::ProtocolViolation(e.to_string()))?;
        let result = self.call_raw(method, params, options).await?;
        serde_json::from_value(result).map_err(|e| ClientError::ProtocolViolation(e.to_string()))
    }
}
impl<T: ProtocolClient + ?Sized> ProtocolClientExt for T {}

pub struct ConnectOptions {
    pub target: Target,
    pub connector: Arc<dyn Connector>,
    pub client_info: ClientInfo,
    pub capabilities: InitializeCapabilities,
    /// Required to fold thread feeds; without it `ThreadFold.state` is the raw snapshot params.
    pub thread_reducer: Option<Arc<dyn ThreadReducer>>,
    pub clock: Arc<dyn Clock>,
    /// UUIDv7 by default (§9.1).
    pub new_op_id: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub ladder: LadderConfig,
}

/// Wire names the client acts on.
pub mod wire {
    pub const THREAD_SNAPSHOT: &str = "thread/snapshot";
    pub const APP_SNAPSHOT: &str = "app/snapshot";
    pub const SERVER_REQUEST_RESOLVED: &str = "serverRequest/resolved";
}
