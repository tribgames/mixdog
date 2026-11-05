//! Domain services: every non-thread namespace of the method table (config, account, agent,
//! project, terminal, git, remote, …), registered by the composition root.

use std::future::Future;
use std::pin::Pin;

use async_trait::async_trait;
use serde_json::Value;

use crate::call::CoreRequest;
use crate::call::Reply;
use crate::error::CoreError;
use crate::ids::ConnectionId;
use crate::ids::Method;

#[async_trait]
pub trait DomainService: Send + Sync {
    /// Requests of this namespace. Mutations carry `req.op` and their op record commits with
    /// the effect, in the scope owner's store (P §9.2).
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError>;

    /// Client notifications of this namespace (`terminal/input`, `process/input`,
    /// `client/activity`, `host/*` notifications). They take no admission slot and are never
    /// dropped: the input is always taken, and [`Admit::Pause`] tells the connection reader to
    /// stop reading that socket until the future resolves (P §7.3 TCP backpressure).
    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit;
}

/// Outcome of a client notification.
pub enum Admit {
    Accepted,
    /// The domain's bounded input buffer is full; resume reading when this resolves.
    Pause(Pin<Box<dyn Future<Output = ()> + Send>>),
}

impl std::fmt::Debug for Admit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Admit::Accepted => f.write_str("Accepted"),
            Admit::Pause(_) => f.write_str("Pause"),
        }
    }
}
