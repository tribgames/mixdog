//! Requests into the core and their replies.
//!
//! Non-control methods cross the seam as `(method, params)` with params already validated
//! against the protocol method table by the server; the owner decodes them into its own types.
//! This keeps every seam stable while method rows are added. Control-plane operations (C0) do
//! not use this path: they are the synchronous methods of [`crate::thread::RunControl`].

use std::sync::Arc;

use mixdog_protocol::Origin;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::feed::FeedSource;
use crate::feed::ResumeFrom;
use crate::feed::Window;
use crate::ids::ConnectionId;
use crate::ids::Method;
use crate::ids::OpId;

/// Who submitted a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    /// A client connection: a full core queue answers `queueFull` at once (RL §0.2).
    Connection(ConnectionId),
    /// An internal producer (scheduler, bots, webhooks, goal recovery): waits for queue
    /// capacity and is never answered with overload (P §7.3).
    Internal(&'static str),
}

/// Per-request context.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct CallContext {
    pub caller: Caller,
    /// The origin the method table scopes this call by. For a connection, the transport's
    /// `ConnectionOrigin::origin()`, filled by the server when it decodes the request; for an
    /// internal producer, [`Origin::Local`]. Services read it here, never through a lookup.
    pub origin: Origin,
    /// Cancelled when the caller's connection closes (RL §4.4): queued lane jobs of the request
    /// are dropped at dequeue; admitted mutations still complete (they carry an op id).
    pub cancel: CancellationToken,
    /// When the reply has been queued to the caller: what the call starts that must not reach a
    /// client before its reply waits on [`ReplyQueued::hold`].
    pub reply_queued: ReplyQueued,
}

impl CallContext {
    pub fn connection(id: ConnectionId, origin: Origin, cancel: CancellationToken) -> Self {
        Self {
            caller: Caller::Connection(id),
            origin,
            cancel,
            reply_queued: ReplyQueued::new(),
        }
    }

    /// An in-process producer. It runs on this machine, so it has the `Local` origin, which
    /// every method-table row admits.
    pub fn internal(name: &'static str) -> Self {
        Self {
            caller: Caller::Internal(name),
            origin: Origin::Local,
            cancel: CancellationToken::new(),
            reply_queued: ReplyQueued::new(),
        }
    }
}

/// Marked by the server right after it has queued the response of the request on the caller's
/// connection (`AppServer` `on_message`); a frame queued on the connection after that is written
/// after the response. A caller that queues no reply has none to wait for: the last copy of the
/// context dropped marks it.
#[derive(Clone)]
pub struct ReplyQueued {
    queued: CancellationToken,
    _last: Arc<tokio_util::sync::DropGuard>,
}

impl ReplyQueued {
    pub fn new() -> Self {
        let queued = CancellationToken::new();
        Self {
            _last: Arc::new(queued.clone().drop_guard()),
            queued,
        }
    }

    /// The reply has been queued.
    pub fn mark(&self) {
        self.queued.cancel();
    }

    /// Cancelled once the reply has been queued, or earlier by its holder.
    pub fn hold(&self) -> CancellationToken {
        self.queued.child_token()
    }
}

impl Default for ReplyQueued {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for ReplyQueued {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ReplyQueued").field(&self.queued.is_cancelled()).finish()
    }
}

/// One request to a thread, the thread directory, or a domain service.
#[derive(Clone)]
pub struct CoreRequest {
    pub method: Method,
    pub params: Value,
    /// Required by methods marked `mutation` in the method table (the server checks presence).
    pub op: Option<OpId>,
    pub ctx: CallContext,
}

/// Methods whose params carry a secret value: a {:?} of the request hides them.
const SECRET_PARAMS: [&str; 1] = ["approval/provideSecret"];

impl std::fmt::Debug for CoreRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let params: &dyn std::fmt::Debug = if SECRET_PARAMS.contains(&self.method.as_str()) { &"<redacted>" } else { &self.params };
        f.debug_struct("CoreRequest").field("method", &self.method).field("params", params).field("op", &self.op).field("ctx", &self.ctx).finish()
    }
}

/// The reply of a request.
pub enum Reply {
    /// The response `result`.
    Value(Value),
    /// A subscribing method (`thread/resume`, `thread/start`, `terminal/attach`, search, login
    /// flows, …): the server allocates the subscription id, calls [`crate::feed::subscribe`], adds
    /// `subscription{id, mode, epoch, startSeq}` to `result`, and writes the response with the
    /// attach's lane release.
    Subscribe(Subscribe),
}

pub struct Subscribe {
    pub result: Value,
    pub feed: Arc<dyn FeedSource>,
    /// Parsed from the request params by the owner.
    pub window: Window,
    pub resume_from: Option<ResumeFrom>,
}

impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Reply::Value(value) => f.debug_tuple("Value").field(value).finish(),
            Reply::Subscribe(sub) => f
                .debug_struct("Subscribe")
                .field("result", &sub.result)
                .field("feed", &sub.feed.feed_id())
                .field("window", &sub.window)
                .field("resume_from", &sub.resume_from)
                .finish(),
        }
    }
}
