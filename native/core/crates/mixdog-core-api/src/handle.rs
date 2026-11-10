//! `CoreHandle`: the only view the server has of the core (P §2.1 construction rules).
//! Built by the composition root, which also hands the core the server's
//! [`crate::server_request::ServerRequestSink`] and [`crate::host::HostChannel`].

use std::sync::Arc;

pub use mixdog_protocol::DrainReason;
use tokio::sync::watch;

use crate::feed::FeedSource;
use crate::host::HostMediaSink;
use crate::ops::OpIndex;
use crate::service::DomainService;
use crate::thread::ThreadDirectory;

pub trait CoreHandle: Send + Sync + 'static {
    fn threads(&self) -> &dyn ThreadDirectory;

    /// The `app` feed (`app/subscribe`, window [`crate::feed::Window::Fixed`]).
    fn app_feed(&self) -> Arc<dyn FeedSource>;

    /// The live scoped feed `id` (`<kind>:<key>`), or `None` when no such feed is held by its
    /// owner (`feed/subscribe`, window [`crate::feed::Window::Fixed`]).
    fn scoped_feed(&self, id: &crate::ids::FeedId) -> Option<Arc<dyn FeedSource>>;

    fn ops(&self) -> &dyn OpIndex;

    /// The service that claims exactly `method` ([`DomainService::methods`]); `None` when no
    /// service does.
    fn domain_for(&self, method: &str) -> Option<&dyn DomainService>;

    fn host_media(&self) -> &dyn HostMediaSink;

    fn lifecycle(&self) -> watch::Receiver<CoreState>;

    /// `connection` has ended, by whichever path: a clean close, a transport error, a heartbeat or slow-consumer close, or the server
    /// stopping. Every owner of per-connection state (terminal focus and size ownership, UI screen sessions, watches, searches and
    /// transfers, port viewers, paired-device rows) releases it here.
    ///
    /// The server calls it exactly once per opened connection, when that connection's `ConnectionHandle` drops (P §4.5). It is
    /// required, with no default, so an implementor cannot ignore connection ends by omission.
    fn connection_closed(&self, connection: crate::ids::ConnectionId);

    /// `connection` finished `initialize`: it has stated who it is (`device` is the title, else the name, of its client info; `kind`
    /// its kind) and came in through `origin`. The owners that need the client's identity (the paired-device registry's local rows)
    /// record it here, and release it at [`connection_closed`](Self::connection_closed). Required, with no default, so an implementor
    /// cannot ignore connection starts by omission.
    fn connection_opened(
        &self,
        connection: crate::ids::ConnectionId,
        origin: mixdog_protocol::Origin,
        device: &str,
        kind: mixdog_protocol::ConnectionKind,
    );

    /// The server admitted a request (took an in-flight slot of its class): the returned guard lives until the slot is freed. A core that
    /// counts service calls (Node's `inFlightWork().activeCalls`, `daemon.mjs:444-449`) holds the count in the guard. Required, with no
    /// default, so an implementor cannot ignore the calls by omission. `method` and `params` are the request's, so a core can tell a
    /// call its stop does not wait for (a new task, host logic in Node) from one it drains.
    fn request_started(&self, method: &str, params: &serde_json::Value) -> RequestGuard;
}

/// What an admitted request holds for as long as it runs (see [`CoreHandle::request_started`]).
pub type RequestGuard = Box<dyn Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum CoreState {
    Booting,
    Migrating(MigrationProgress),
    Serving,
    Draining { reason: DrainReason },
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationProgress {
    pub kind: Arc<str>,
    pub done: u64,
    pub total: u64,
}
