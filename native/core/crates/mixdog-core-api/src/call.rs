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
    /// What the service keeps alive until its answer is in the caller's outgoing queue (see [`AfterAnswer`]).
    pub after_answer: AfterAnswer,
    /// Where in the params an unpaired surrogate escape on the wire was read as U+FFFD (the request's
    /// `lone_surrogates`): such a value equals, matches or selects nothing a service reads from disk, and
    /// a service refuses it where Node refuses a lone code unit. Empty for an internal producer.
    pub lone_surrogates: Vec<mixdog_js::LoneAt>,
}

/// Guards a service hands the server to keep until the request's answer has been handed to the connection's outgoing queue (written,
/// or the connection gone, or the request dropped): what the call holds back must not overtake its answer. The server releases them right
/// after it queues the answer; every clone shares them, so they also end when the last clone of the request goes.
#[derive(Clone, Default)]
pub struct AfterAnswer(Arc<std::sync::Mutex<Vec<Box<dyn Send>>>>);

impl AfterAnswer {
    /// Keeps `guard` until the answer is queued.
    pub fn keep(&self, guard: impl Send + 'static) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(Box::new(guard));
    }

    /// Drops what was kept: the server calls it once the answer is in the outgoing queue.
    pub fn release(&self) {
        let kept = std::mem::take(&mut *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
        drop(kept);
    }
}

impl std::fmt::Debug for AfterAnswer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kept = self.0.lock().map_or(0, |kept| kept.len());
        f.debug_tuple("AfterAnswer").field(&kept).finish()
    }
}

impl CallContext {
    pub fn connection(id: ConnectionId, origin: Origin, cancel: CancellationToken) -> Self {
        Self {
            caller: Caller::Connection(id),
            origin,
            cancel,
            after_answer: AfterAnswer::default(),
            lone_surrogates: Vec::new(),
        }
    }

    /// An in-process producer. It runs on this machine, so it has the `Local` origin, which
    /// every method-table row admits.
    pub fn internal(name: &'static str) -> Self {
        Self {
            caller: Caller::Internal(name),
            origin: Origin::Local,
            cancel: CancellationToken::new(),
            after_answer: AfterAnswer::default(),
            lone_surrogates: Vec::new(),
        }
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
