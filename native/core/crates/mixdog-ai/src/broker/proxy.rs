//! Server side of the model proxy (DS §12.4). A server core's call runs on a
//! connection that declared `capabilities.modelProxy`, with that machine's
//! accounts. The request has an external effect on another core, so an
//! unknown outcome is never retried here.

use async_trait::async_trait;
use mixdog_protocol::JsonValue;
use tokio_util::sync::CancellationToken;

#[derive(Clone, PartialEq, Debug)]
pub enum ProxyError {
    /// No PC answered: none is connected, it left, did not pick the call up, or stopped
    /// responding. Carries Node's `ModelProxyUnavailableError` message
    /// (`model proxy unavailable: <detail>`).
    Unavailable(String),
    /// The caller cancelled, or the connection was lost: in-flight calls
    /// resolve cancelled and no orphan runs on the remote core.
    Cancelled,
    /// The remote core answered with an error result.
    Remote(JsonValue),
}

/// One `model/proxy/execute` round trip over the claimed connection. Events
/// arrive as `model/proxy/event` notifications and are passed to `events`; the
/// response is the result.
#[async_trait]
pub trait ModelProxyTransport: Send + Sync {
    async fn execute(
        &self,
        call: JsonValue,
        events: &mut (dyn FnMut(JsonValue) + Send),
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ProxyError>;
}

/// Runs `call` through the transport once. There is no retry loop here: the
/// remote core owns retries, and a lost connection is `Cancelled`.
pub async fn execute_via_proxy(
    transport: &dyn ModelProxyTransport,
    call: JsonValue,
    events: &mut (dyn FnMut(JsonValue) + Send),
    cancel: &CancellationToken,
) -> Result<JsonValue, ProxyError> {
    if cancel.is_cancelled() {
        return Err(ProxyError::Cancelled);
    }
    transport.execute(call, events, cancel).await
}