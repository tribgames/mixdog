//! Per-connection state (P §4.3): the initialize latch, the RPC gate, in-flight counters,
//! subscriptions and the pending `host/*` requests. Everything here belongs to one
//! connection, so its locks are never shared with another connection's work.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_app_protocol::RequestClass;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::v1::ClientInfo;
use mixdog_app_protocol::v1::HostCapabilities;
use mixdog_core_api::ConnectionSink;
use mixdog_core_api::HostError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::sharded::lock;

/// What `initialize` established. Set once; the latch of the gate.
pub(crate) struct Session {
    pub(crate) client: ClientInfo,
    pub(crate) opt_out_notification_methods: HashSet<String>,
    pub(crate) approvals_inbox: bool,
    pub(crate) host: Option<HostCapabilities>,
    /// `capabilities.modelProxy`: serves `model/proxy/execute` with its own accounts.
    pub(crate) model_proxy: bool,
}

/// One subscription of this connection.
pub(crate) struct Sub {
    pub(crate) id: SubscriptionId,
    pub(crate) feed: Arc<dyn FeedSource>,
    /// Set once the attach response has been queued: only then may server requests follow it
    /// (P §8.3 re-delivery).
    pub(crate) live: bool,
}

pub(crate) type HostReply = Result<Value, HostError>;

/// What a streamed host request receives, in the order the connection sent it: any number of
/// events, then the answer.
pub(crate) enum Streamed {
    Event(Value),
    /// The claimant vouches for the request (`model/proxy/heartbeat`); carries nothing.
    Alive,
    Done(HostReply),
}

/// Who waits for the answer of a pending host request.
enum Waiter {
    Reply(oneshot::Sender<HostReply>),
    /// Events and the answer share one queue, so the answer never overtakes an event.
    Stream(mpsc::UnboundedSender<Streamed>),
}

#[derive(Default)]
struct HostState {
    /// Requests sent to this connection as the host claimant; `None` once closed.
    pending: Option<HashMap<RequestId, (Method, Waiter)>>,
}

pub(crate) struct Connection {
    pub(crate) id: ConnectionId,
    pub(crate) sink: Arc<dyn ConnectionSink>,
    /// Cancelled when the connection closes: queued work is dropped, running work is told.
    pub(crate) cancel: CancellationToken,
    session: OnceLock<Session>,
    /// Set once the initialize response is queued. The session is latched earlier, so this
    /// is what keeps a server request from overtaking the response on the control lane.
    handshake_done: AtomicBool,
    inflight: [AtomicU32; 4],
    /// Reads that found their class full, per class in arrival order; `None` once closed. A freed place goes to the
    /// oldest of them, and the count only falls with no read waiting, both under this lock.
    queued: Mutex<Option<[VecDeque<Queued>; 4]>>,
    subs: Mutex<Option<HashMap<FeedId, Sub>>>,
    next_sub: AtomicU64,
    host: Mutex<HostState>,
}

/// A read waiting for an in-flight place: given the connection once it holds one ([`Connection::granted`]).
pub(crate) type Queued = Box<dyn FnOnce(Arc<Connection>) + Send>;

/// What a closing connection leaves behind for the caller to release.
pub(crate) struct Closed {
    pub(crate) subs: Vec<Sub>,
}

pub(crate) enum Registered {
    /// The connection closed first; nothing was registered.
    ConnectionClosed,
    /// The previous subscription to the same feed, replaced.
    Replaced(Option<Sub>),
}

/// An in-flight slot of one request class; dropping it frees the slot. The response is
/// written only after the slot is freed, so a client that retries on a response finds room
/// (P §7.3).
#[must_use]
pub(crate) struct Slot {
    conn: Arc<Connection>,
    class: RequestClass,
    /// What the core holds for the request while it runs ([`mixdog_core_api::handle::CoreHandle::request_started`]); freed with the slot.
    _request: mixdog_core_api::handle::RequestGuard,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let index = class_index(self.class);
        let next = {
            let mut queued = lock(&self.conn.queued);
            let next = queued.as_mut().and_then(|queued| queued[index].pop_front());
            if next.is_none() {
                self.conn.inflight[index].fetch_sub(1, Ordering::AcqRel);
            }
            next
        };
        // The place passes to the oldest waiting read, which runs on its own task (never inside this drop).
        if let Some(next) = next {
            let conn = Arc::clone(&self.conn);
            mixdog_rt::spawn("request", mixdog_rt::TaskClass::Work, async move { next(conn) });
        }
    }
}

fn class_index(class: RequestClass) -> usize {
    match class {
        RequestClass::C0 => 0,
        RequestClass::C1 => 1,
        RequestClass::C2 => 2,
        RequestClass::C3 => 3,
    }
}

impl Connection {
    pub(crate) fn new(id: ConnectionId, sink: Arc<dyn ConnectionSink>) -> Self {
        Self {
            id,
            sink,
            cancel: CancellationToken::new(),
            session: OnceLock::new(),
            handshake_done: AtomicBool::new(false),
            inflight: Default::default(),
            queued: Mutex::new(Some(Default::default())),
            subs: Mutex::new(Some(HashMap::new())),
            next_sub: AtomicU64::new(1),
            host: Mutex::new(HostState {
                pending: Some(HashMap::new()),
            }),
        }
    }

    pub(crate) fn session(&self) -> Option<&Session> {
        self.session.get()
    }

    /// The initialize latch: the first caller wins.
    pub(crate) fn initialize(&self, session: Session) -> Result<(), Box<Session>> {
        self.session.set(session).map_err(Box::new)
    }

    /// Called right after the initialize response is queued: from here on server requests may
    /// follow it. The caller then re-delivers what was published in between.
    pub(crate) fn finish_handshake(&self) {
        self.handshake_done.store(true, Ordering::Release);
    }

    /// Takes an in-flight slot of `class`, or answers the class cap.
    /// `request_started` runs only for an admitted request: its guard goes into the slot.
    pub(crate) fn admit(
        self: &Arc<Self>,
        class: RequestClass,
        cap: u32,
        request_started: impl FnOnce() -> mixdog_core_api::handle::RequestGuard,
    ) -> Result<Slot, u32> {
        self.inflight[class_index(class)]
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < cap).then_some(count + 1)
            })
            .map(|_| Slot {
                conn: Arc::clone(self),
                class,
                _request: request_started(),
            })
            .map_err(|_| cap)
    }

    /// [`Self::admit`] for a read: a full class queues it (`later` makes what runs once it has a place) unless `bound`
    /// reads already wait. `Ok` gives the slot and `item` back; `Err(None)` is queued; `Err(Some(cap))` is refused.
    pub(crate) fn admit_or_queue<T>(
        self: &Arc<Self>,
        class: RequestClass,
        cap: u32,
        bound: usize,
        item: T,
        request_started: impl FnOnce(&T) -> mixdog_core_api::handle::RequestGuard,
        later: impl FnOnce(T) -> Queued,
    ) -> Result<(Slot, T), Option<u32>> {
        let index = class_index(class);
        let mut queued = lock(&self.queued);
        let Some(queued) = queued.as_mut() else { return Err(Some(cap)) };
        let admitted = queued[index].is_empty()
            && self.inflight[index].try_update(Ordering::AcqRel, Ordering::Acquire, |count| (count < cap).then_some(count + 1)).is_ok();
        if admitted {
            let guard = request_started(&item);
            return Ok((Slot { conn: Arc::clone(self), class, _request: guard }, item));
        }
        if queued[index].len() >= bound {
            return Err(Some(cap));
        }
        queued[index].push_back(later(item));
        Err(None)
    }

    /// The slot a queued read was handed by the slot that freed its place (the count already holds it).
    pub(crate) fn granted(self: &Arc<Self>, class: RequestClass, request: mixdog_core_api::handle::RequestGuard) -> Slot {
        Slot { conn: Arc::clone(self), class, _request: request }
    }

    pub(crate) fn next_subscription_id(&self) -> SubscriptionId {
        let n = self.next_sub.fetch_add(1, Ordering::Relaxed);
        SubscriptionId::from(format!("c{}-{n}", self.id))
    }

    pub(crate) fn register_subscription(&self, feed: FeedId, sub: Sub) -> Registered {
        match lock(&self.subs).as_mut() {
            Some(subs) => Registered::Replaced(subs.insert(feed, sub)),
            None => Registered::ConnectionClosed,
        }
    }

    /// Queues the attach response of subscription `id` on `feed` (`send`) and marks the subscription live, as
    /// one step for every reader of the subscriptions. Marking it after the response was queued, with the lock
    /// free in between, left a moment in which a client already holding its attach response did not count as
    /// attached ([`Self::is_eligible`]): an ask made then was held as if no client could show it. Node sets a
    /// turn's approval hook in the same synchronous step that answers the client.
    pub(crate) fn send_attach_response<E>(
        &self,
        feed: &FeedId,
        id: &SubscriptionId,
        send: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut subs = lock(&self.subs);
        send()?;
        if let Some(sub) = subs.as_mut().and_then(|subs| subs.get_mut(feed))
            && sub.id == *id
        {
            sub.live = true;
        }
        Ok(())
    }

    pub(crate) fn remove_subscription(&self, feed: &FeedId) -> Option<Sub> {
        lock(&self.subs).as_mut().and_then(|subs| subs.remove(feed))
    }

    fn is_live_on(&self, feed: &FeedId) -> bool {
        lock(&self.subs)
            .as_ref()
            .and_then(|subs| subs.get(feed))
            .is_some_and(|sub| sub.live)
    }

    /// A desktop window: `initialize` declared kind `desktop`, and the app feed is live on it.
    pub(crate) fn is_desktop_on(&self, feed: &FeedId) -> bool {
        self.session()
            .is_some_and(|session| session.client.kind == mixdog_protocol::ConnectionKind::Desktop)
            && self.is_live_on(feed)
    }

    /// Whether a server request of `thread` shown on `surface` is for this connection
    /// (P §8.3): a subscriber of either feed, or an `approvalsInbox` connection.
    pub(crate) fn is_eligible(&self, thread: &FeedId, surface: &FeedId) -> bool {
        if !self.handshake_done.load(Ordering::Acquire) {
            return false;
        }
        let Some(session) = self.session() else {
            return false;
        };
        session.approvals_inbox || self.is_live_on(thread) || self.is_live_on(surface)
    }

    /// Registers a `host/*` request sent to this connection; `None` once it closed.
    pub(crate) fn register_host_request(
        &self,
        id: RequestId,
        method: Method,
    ) -> Option<oneshot::Receiver<HostReply>> {
        let (tx, rx) = oneshot::channel();
        lock(&self.host).pending.as_mut()?.insert(id, (method, Waiter::Reply(tx)));
        Some(rx)
    }

    /// [`Self::register_host_request`] for a request whose claimant streams events ahead of its
    /// answer; `None` once the connection closed.
    pub(crate) fn register_host_stream(
        &self,
        id: RequestId,
        method: Method,
    ) -> Option<mpsc::UnboundedReceiver<Streamed>> {
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.host).pending.as_mut()?.insert(id, (method, Waiter::Stream(tx)));
        Some(rx)
    }

    /// The method of the `host/*` request `id` pending here.
    pub(crate) fn host_request_method(&self, id: &RequestId) -> Option<Method> {
        lock(&self.host).pending.as_ref().and_then(|pending| pending.get(id)).map(|(method, _)| *method)
    }

    /// Delivers the claimant's answer; gives it back when the request is not pending here.
    pub(crate) fn complete_host_request(
        &self,
        id: &RequestId,
        reply: HostReply,
    ) -> Result<(), HostReply> {
        let waiter = lock(&self.host)
            .pending
            .as_mut()
            .and_then(|pending| pending.remove(id))
            .map(|(_, waiter)| waiter);
        match waiter {
            // The requester may have abandoned the request; the answer is then unwanted.
            Some(Waiter::Reply(sender)) => {
                let _ = sender.send(reply);
                Ok(())
            }
            Some(Waiter::Stream(sender)) => {
                let _ = sender.send(Streamed::Done(reply));
                Ok(())
            }
            None => Err(reply),
        }
    }

    /// Hands a streamed event to its pending request; `false` when none such is pending here
    /// (a late event after the answer, or a request that is not streamed).
    pub(crate) fn host_stream_event(&self, id: &RequestId, event: Value) -> bool {
        match lock(&self.host).pending.as_ref().and_then(|pending| pending.get(id)) {
            Some((_, Waiter::Stream(sender))) => sender.send(Streamed::Event(event)).is_ok(),
            _ => false,
        }
    }

    /// Tells a pending streamed request its claimant is alive; `false` when none such is pending here.
    pub(crate) fn host_stream_alive(&self, id: &RequestId) -> bool {
        match lock(&self.host).pending.as_ref().and_then(|pending| pending.get(id)) {
            Some((_, Waiter::Stream(sender))) => sender.send(Streamed::Alive).is_ok(),
            _ => false,
        }
    }

    pub(crate) fn forget_host_request(&self, id: &RequestId) {
        if let Some(pending) = lock(&self.host).pending.as_mut() {
            pending.remove(id);
        }
    }

    /// Closes the connection's state: cancels its work, and hands back what must be released
    /// elsewhere. Pending `host/*` requests are dropped, which fails their waiters.
    pub(crate) fn close(&self) -> Closed {
        self.cancel.cancel();
        // Waiting reads are dropped unanswered, as the connection's running work is cancelled.
        let waiting = lock(&self.queued).take();
        drop(waiting);
        let subs = lock(&self.subs)
            .take()
            .map(|subs| subs.into_values().collect())
            .unwrap_or_default();
        let mut host = lock(&self.host);
        host.pending = None;
        Closed { subs }
    }
}
