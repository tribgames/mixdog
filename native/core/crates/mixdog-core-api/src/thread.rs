//! Threads: the directory, a loaded thread's handle, and its control plane.
//!
//! Control-plane priority is carried by the types: [`RunControl`] methods (C0: abort, steer,
//! server-request decisions) are synchronous. They run on RT-C against the thread's control
//! cell and the actor's control lane, so they cannot wait on the actor inbox, a storage lane,
//! an encode or another thread (RL §5.3, D-L1); persistence follows asynchronously. Control
//! paths look threads up with [`ThreadDirectory::get`], which never loads.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_protocol::ConnectionKind;
use serde_json::Value;

use crate::call::CallContext;
use crate::call::CoreRequest;
use crate::call::Reply;
use crate::error::CoreError;
use crate::feed::FeedSource;
use crate::ids::ConnectionId;
use crate::ids::OpId;
use crate::ids::ServerRequestId;
use crate::ids::ThreadId;
use crate::ids::TurnId;

/// Every thread of the core.
#[async_trait]
pub trait ThreadDirectory: Send + Sync {
    /// The loaded thread, if any. O(1) under a sharded `std` lock; never loads or waits.
    fn get(&self, id: &ThreadId) -> Option<Arc<dyn ThreadHandle>>;

    /// The loaded thread, or a cold open: concurrent opens of one thread share one load
    /// (two serial read jobs, RL §5.5, §7.3). Cancelling `ctx` stops this waiter only.
    async fn open(
        &self,
        id: &ThreadId,
        ctx: &CallContext,
    ) -> Result<Arc<dyn ThreadHandle>, CoreError>;

    /// Thread-namespace methods not addressed to one loaded thread (`thread/start`,
    /// `thread/list`, …).
    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError>;
}

/// A loaded thread. Its feed is the thread feed (`feed.id = threadId`).
#[async_trait]
pub trait ThreadHandle: FeedSource + RunControl {
    fn id(&self) -> &ThreadId;

    /// C1 reads and C2 mutations of this thread. A mutation resolves once its command is
    /// durable in the actor (P §7.2), never after model or tool work. A full actor inbox
    /// answers `queueFull` to a connection caller at once.
    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError>;
}

/// The C0 control plane of a thread. Every method returns without waiting.
pub trait RunControl: Send + Sync {
    /// `turn/interrupt`: cancels the run's token, enqueues the abort on the actor's control
    /// lane and publishes the cancel hint; the reply does not wait for the abort record.
    /// Errors: `turnNotActive` (no or another active turn), `queueFull` (control lane full).
    fn interrupt(&self, turn: &TurnId) -> Result<Value, CoreError>;

    /// `turn/steer`: validates against the run's control cell (active regular run, matching
    /// turn, non-empty input) and queues the input; the run injects it at its next model-call
    /// boundary after the entry is durable. Errors: `turnNotActive`, `queueFull`.
    fn steer(&self, expected_turn: &TurnId, input: Value, op: OpId) -> Result<Value, CoreError>;

    /// The turn the thread's run is in, `None` between runs: what a `turn/steer` that names no
    /// turn steers.
    fn active_turn(&self) -> Option<TurnId>;

    /// A client's response to a server request owned by this thread (P §8.4 step 1). Routed to
    /// the actor's control lane; the actor validates it, and the first valid decision wins.
    /// A decision that fails validation is answered through
    /// [`crate::server_request::ServerRequestSink::response_rejected`].
    fn decide(&self, decision: Decision) -> Result<(), CoreError>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct Decision {
    pub request: ServerRequestId,
    pub connection: ConnectionId,
    /// The answering device as the connection's `initialize` named it (`connection.device`
    /// of the initialize response); recorded in `ApprovalResolution::Decided.device`.
    pub device: String,
    /// The answering connection's `clientInfo.kind`; recorded as `connectionKind`.
    pub connection_kind: ConnectionKind,
    /// The JSON-RPC `result` of the client's response.
    pub result: Value,
}
