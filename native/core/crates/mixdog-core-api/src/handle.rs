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

    fn ops(&self) -> &dyn OpIndex;

    /// The service that claims exactly `method` ([`DomainService::methods`]); `None` when no
    /// service does.
    fn domain_for(&self, method: &str) -> Option<&dyn DomainService>;

    fn host_media(&self) -> &dyn HostMediaSink;

    fn lifecycle(&self) -> watch::Receiver<CoreState>;
}

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
