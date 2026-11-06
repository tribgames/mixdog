//! The outgoing router: the connection table, server-request fan-out and re-delivery
//! (P §8.3), and the host channel (DS §12).
//!
//! It is built before the core (the core is handed its [`ServerRequestSink`] and
//! [`HostChannel`]) and given to the [`crate::AppServer`] afterwards, which registers the
//! connections here.
//!
//! A pending server request records the connections it was delivered to. That one set makes
//! delivery idempotent, so a request reaches a connection exactly once whether it is
//! published after, or the connection becomes eligible after: both paths call [`deliver`].
//!
//! [`deliver`]: Outgoing::deliver

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::v1::HostCapabilities;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::HostId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::server_request::PendingServerRequest;
use serde_json::Value;

use crate::connection::Connection;
use crate::connection::Streamed;
use crate::error::error_data;
use crate::frame::error_notification_frame;
use crate::frame::notification_frame;
use crate::frame::request_frame;
use crate::sharded::Sharded;
use crate::sharded::lock;

struct Pending {
    req: PendingServerRequest,
    /// Position in publication order, for re-delivery in request order.
    order: u64,
    thread_feed: FeedId,
    surface_feed: FeedId,
    delivered: HashSet<ConnectionId>,
}

pub struct Outgoing {
    connections: Sharded<ConnectionId, Arc<Connection>>,
    pending: Sharded<ServerRequestId, Pending>,
    pending_count: AtomicUsize,
    next_order: AtomicU64,
    /// Host claims, oldest first: the latest claim that declared a capability serves it.
    hosts: Mutex<Vec<Claim>>,
    /// Connections that declared `capabilities.modelProxy`, oldest first. They serve from
    /// `initialize` on, without `host/claim`; the latest serves.
    model_proxies: Mutex<Vec<Arc<Connection>>>,
    next_host_request: AtomicU64,
}

struct Claim {
    host: HostId,
    conn: Arc<Connection>,
    serves: Vec<HostCapability>,
}

/// The routed capabilities a desktop declared in `capabilities.host`.
fn serves(declared: &HostCapabilities) -> Vec<HostCapability> {
    [
        (declared.browser, HostCapability::Browser),
        (declared.visualize, HostCapability::Visualize),
        (declared.notifications, HostCapability::Notifications),
        (declared.system_proxy, HostCapability::SystemProxy),
        (declared.power, HostCapability::Power),
        (declared.updater, HostCapability::Updater),
        (declared.files, HostCapability::Files),
    ]
    .into_iter()
    .filter_map(|(on, capability)| on.then_some(capability))
    .collect()
}

impl Outgoing {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            connections: Sharded::new(),
            pending: Sharded::new(),
            pending_count: AtomicUsize::new(0),
            next_order: AtomicU64::new(0),
            hosts: Mutex::new(Vec::new()),
            model_proxies: Mutex::new(Vec::new()),
            next_host_request: AtomicU64::new(1),
        })
    }

    pub(crate) fn register(&self, conn: Arc<Connection>) {
        self.connections.shard(&conn.id).insert(conn.id, conn);
    }

    /// Forgets a closed connection and the host claims it held. Its delivered marks stay in
    /// the pending requests; they are only looked up by id.
    pub(crate) fn unregister(&self, conn: &Connection) {
        self.connections.shard(&conn.id).remove(&conn.id);
        lock(&self.hosts).retain(|claim| claim.conn.id != conn.id);
        lock(&self.model_proxies).retain(|proxy| proxy.id != conn.id);
    }

    /// Records `conn`, which declared `capabilities.modelProxy` at `initialize`, as the newest
    /// connection to run proxied model calls.
    pub(crate) fn serve_model_proxy(&self, conn: &Arc<Connection>) {
        let mut proxies = lock(&self.model_proxies);
        proxies.retain(|proxy| proxy.id != conn.id);
        proxies.push(Arc::clone(conn));
    }

    pub(crate) fn connection(&self, id: ConnectionId) -> Option<Arc<Connection>> {
        self.connections.shard(&id).get(&id).cloned()
    }

    fn all_connections(&self) -> Vec<Arc<Connection>> {
        self.connections
            .shards()
            .flat_map(|shard| shard.values().cloned().collect::<Vec<_>>())
            .collect()
    }

    /// Sends `id` to `conn` if it is eligible and has not received it yet.
    fn deliver(&self, id: &ServerRequestId, conn: &Connection) {
        let mut shard = self.pending.shard(id);
        let Some(pending) = shard.get_mut(id) else {
            return;
        };
        if pending.delivered.contains(&conn.id)
            || !conn.is_eligible(&pending.thread_feed, &pending.surface_feed)
        {
            return;
        }
        if conn.sink.send_control(pending.req.frame.clone()).is_ok() {
            pending.delivered.insert(conn.id);
        }
    }

    /// Sends every pending request `conn` is eligible for and has not seen, in request order
    /// (right after its attach response, or after `initialize` for an `approvalsInbox`
    /// connection).
    pub(crate) fn redeliver(&self, conn: &Connection) {
        if self.pending_count.load(Ordering::Acquire) == 0 {
            return;
        }
        let mut open: Vec<(u64, ServerRequestId)> = self
            .pending
            .shards()
            .flat_map(|shard| {
                shard
                    .iter()
                    .map(|(id, pending)| (pending.order, id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect();
        open.sort_unstable();
        for (_, id) in open {
            self.deliver(&id, conn);
        }
    }

    /// The owning thread of `id`, if `from` is a connection the request was delivered to
    /// (P §8.4 step 1: only eligible connections decide).
    pub(crate) fn owner_for_response(
        &self,
        id: &ServerRequestId,
        from: ConnectionId,
    ) -> Option<ThreadId> {
        self.pending
            .shard(id)
            .get(id)
            .filter(|pending| pending.delivered.contains(&from))
            .map(|pending| pending.req.thread.clone())
    }

    /// Records `conn` as the newest host claimant for what it declared at `initialize`. A
    /// connection holds one claim, and a `hostId` is held by one connection (a reconnecting
    /// desktop replaces its stale claim).
    pub(crate) fn claim(&self, host: HostId, conn: &Arc<Connection>) {
        let serves = conn
            .session()
            .and_then(|session| session.host.as_ref())
            .map(serves)
            .unwrap_or_default();
        let mut hosts = lock(&self.hosts);
        hosts.retain(|claim| claim.host != host && claim.conn.id != conn.id);
        hosts.push(Claim {
            host,
            conn: Arc::clone(conn),
            serves,
        });
    }

    fn next_host_id(&self) -> RequestId {
        RequestId::String(format!(
            "host-{}",
            self.next_host_request.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn claimant(&self, capability: HostCapability) -> Result<Arc<Connection>, CoreError> {
        if capability == HostCapability::ModelProxy {
            return lock(&self.model_proxies)
                .last()
                .cloned()
                .ok_or_else(|| desktop_host_unavailable("noClaimant"));
        }
        lock(&self.hosts)
            .iter()
            .rev()
            .find(|claim| claim.serves.contains(&capability))
            .map(|claim| Arc::clone(&claim.conn))
            .ok_or_else(|| desktop_host_unavailable("noClaimant"))
    }
}

fn desktop_host_unavailable(detail: &str) -> CoreError {
    CoreError::CapabilityUnavailable {
        capability: "desktopHost".into(),
        detail: detail.into(),
    }
}

impl ServerRequestSink for Outgoing {
    fn publish(&self, req: PendingServerRequest) {
        let id = req.id.clone();
        let pending = Pending {
            order: self.next_order.fetch_add(1, Ordering::Relaxed),
            thread_feed: FeedId::from(req.thread.as_str()),
            surface_feed: FeedId::from(req.surface.as_str()),
            delivered: HashSet::new(),
            req,
        };
        if self.pending.shard(&id).insert(id.clone(), pending).is_none() {
            self.pending_count.fetch_add(1, Ordering::AcqRel);
        }
        for conn in self.all_connections() {
            self.deliver(&id, &conn);
        }
    }

    fn resolved(&self, id: &ServerRequestId, frame: Bytes) {
        let Some(pending) = self.pending.shard(id).remove(id) else {
            return;
        };
        self.pending_count.fetch_sub(1, Ordering::AcqRel);
        for conn_id in pending.delivered {
            if let Some(conn) = self.connection(conn_id) {
                // A closing connection no longer needs the resolution.
                let _ = conn.sink.send_control(frame.clone());
            }
        }
    }

    fn response_rejected(&self, to: ConnectionId, error: CoreError) {
        if let Some(conn) = self.connection(to) {
            let _ = conn
                .sink
                .send_control(error_notification_frame(&error_data(&error)));
        }
    }
}

/// Forgets a `host/*` request when its requester stops waiting.
struct ForgetOnDrop {
    conn: Arc<Connection>,
    id: RequestId,
}

impl Drop for ForgetOnDrop {
    fn drop(&mut self) {
        self.conn.forget_host_request(&self.id);
    }
}

/// Tells the connection running a model/proxy/execute request that its caller gave up: the
/// request ended without an answer (dropped, cancelled), so the run must stop spending.
struct CancelOnDrop {
    conn: Arc<Connection>,
    id: RequestId,
    answered: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if !self.answered {
            let params = serde_json::json!({ "requestId": self.id });
            let _ = self.conn.sink.send_control(notification_frame("model/proxy/cancel", params));
        }
    }
}

#[async_trait]
impl HostChannel for Outgoing {
    async fn request(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<Value, HostError> {
        let claimant = self.claimant(capability)?;
        let id = self.next_host_id();
        let reply = claimant
            .register_host_request(id.clone())
            .ok_or_else(|| HostError::from(desktop_host_unavailable("claimantClosed")))?;
        let _forget = ForgetOnDrop {
            conn: Arc::clone(&claimant),
            id: id.clone(),
        };
        claimant
            .sink
            .send_control(request_frame(id, method.as_str(), params))
            .map_err(|_| HostError::from(desktop_host_unavailable("claimantClosed")))?;
        match reply.await {
            Ok(reply) => reply,
            Err(_) => Err(desktop_host_unavailable("claimantClosed").into()),
        }
    }

    fn notify(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
    ) -> Result<(), CoreError> {
        self.claimant(capability)?
            .sink
            .send_control(notification_frame(method.as_str(), params))
            .map_err(|_| desktop_host_unavailable("claimantClosed"))
    }

    async fn request_streamed(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
        on_event: &mut (dyn FnMut(Value) + Send),
    ) -> Result<Value, HostError> {
        let claimant = self.claimant(capability)?;
        let id = self.next_host_id();
        let mut stream = claimant
            .register_host_stream(id.clone())
            .ok_or_else(|| HostError::from(desktop_host_unavailable("claimantClosed")))?;
        let _forget = ForgetOnDrop {
            conn: Arc::clone(&claimant),
            id: id.clone(),
        };
        let request_id = id.clone();
        claimant
            .sink
            .send_control(request_frame(id, method.as_str(), params))
            .map_err(|_| HostError::from(desktop_host_unavailable("claimantClosed")))?;
        // Only a call the connection runs for us can be told to stop; a closed connection needs no word.
        let mut cancel = (capability == HostCapability::ModelProxy).then(|| CancelOnDrop { conn: Arc::clone(&claimant), id: request_id, answered: false });
        loop {
            match stream.recv().await {
                Some(Streamed::Event(event)) => on_event(event),
                Some(Streamed::Done(reply)) => {
                    if let Some(cancel) = cancel.as_mut() {
                        cancel.answered = true;
                    }
                    return reply;
                }
                None => {
                    if let Some(cancel) = cancel.as_mut() {
                        cancel.answered = true;
                    }
                    return Err(desktop_host_unavailable("claimantClosed").into());
                }
            }
        }
    }

    fn stream_event(&self, from: ConnectionId, request: &Value, event: Value) -> bool {
        let Ok(id) = serde_json::from_value::<RequestId>(request.clone()) else {
            return false;
        };
        self.connection(from)
            .is_some_and(|conn| conn.host_stream_event(&id, event))
    }
}

impl ConnectionNotifier for Outgoing {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.connection(to)
            .ok_or(CoreError::ConnectionClosed)?
            .sink
            .send_control(notification_frame(method.as_str(), params))
            .map_err(|_| CoreError::ConnectionClosed)
    }
}
