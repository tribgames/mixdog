//! The two seams between the exec flow and the core it runs on. The core is the exec's own
//! in-process one, started on the pristine root and spoken to over the app protocol like any other
//! client; the composition root implements these (it alone knows how a core is assembled).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_server_client::api::ThreadReducer;
use serde_json::Value;

use super::boundary::Boundary;

/// One connection to the exec's core.
#[async_trait]
pub trait CoreSession: Send + Sync {
    /// One protocol request (a mutation carries a fresh op id); the failure is the rendered error.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String>;

    /// Resolves with the reason once the connection is gone for good.
    async fn lost(&self) -> String;

    /// Closes the session: the connection, then everything still in flight to disk (agent trace,
    /// session log) and the usage ledger, so the root can be removed. Background work the model
    /// left running is detached, never reaped: the artifact the caller asked for may be its server.
    async fn close(&self) -> Result<(), String>;

    /// Stops the services the run itself started (extension host, child daemons).
    async fn stop_services(&self) -> Result<(), String>;
}

#[async_trait]
pub trait CoreLauncher: Send + Sync {
    /// Starts the core on `boundary` and connects to it; `feed` is the thread reducer of the
    /// connection, which sees every notification of the run's thread.
    async fn launch(&self, boundary: &Boundary, feed: Arc<dyn ThreadReducer>) -> Result<Arc<dyn CoreSession>, String>;
}
