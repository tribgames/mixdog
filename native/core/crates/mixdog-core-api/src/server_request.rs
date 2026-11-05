//! Server-initiated requests (approvals, user input, permissions, elicitation; P §8).
//! Implemented by the server's outgoing router; called by thread actors.
//!
//! The owning actor persists `approval.requested` before [`ServerRequestSink::publish`] and
//! `approval.resolved` before [`ServerRequestSink::resolved`]. Frames are encoded once by the
//! core and shared by every eligible connection.

use bytes::Bytes;

use crate::error::CoreError;
use crate::ids::ConnectionId;
use crate::ids::Method;
use crate::ids::ServerRequestId;
use crate::ids::ThreadId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingServerRequest {
    pub id: ServerRequestId,
    /// Server-request method (`item/tool/requestApproval`, …); origin rules filter on it.
    pub method: Method,
    /// The owning thread.
    pub thread: ThreadId,
    /// The top-level thread that shows the request (the owner itself unless a sub-agent).
    pub surface: ThreadId,
    /// Presentation order per surface (P §8.5).
    pub order: u64,
    /// The complete JSON-RPC request frame.
    pub frame: Bytes,
}

pub trait ServerRequestSink: Send + Sync {
    /// Sends to every eligible connection (subscribers of `thread` or `surface`, and
    /// `approvalsInbox` connections) and keeps it for connections that become eligible later,
    /// which receive it right after their attach response, in request order.
    fn publish(&self, req: PendingServerRequest);

    /// The request is resolved: `frame` (`serverRequest/resolved`) goes to every eligible
    /// connection, losers included, and the request is forgotten.
    fn resolved(&self, id: &ServerRequestId, frame: Bytes);

    /// A decision from `to` failed validation (`CoreError::InvalidServerRequestResponse`); the
    /// server sends the `error` notification to that connection only and the request stays
    /// pending (P §8.4 step 5).
    fn response_rejected(&self, to: ConnectionId, error: CoreError);
}
