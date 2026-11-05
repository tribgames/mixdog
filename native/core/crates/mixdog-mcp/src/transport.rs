//! The seam between the JSON-RPC client and a wire. A transport sends whole JSON messages and
//! pushes everything it receives into an unbounded channel, ending with exactly one
//! [`Incoming::Closed`]. "Alive" is the transport being open — a fact — never a probe.

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;

/// Why a transport ended, with the stdio stderr tail when there is one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CloseCause {
    pub reason: String,
    pub stderr_tail: String,
}

#[derive(Debug)]
pub enum Incoming {
    Message(Value),
    Closed(CloseCause),
}

pub type IncomingRx = mpsc::UnboundedReceiver<Incoming>;
pub type IncomingTx = mpsc::UnboundedSender<Incoming>;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("command not found: {0}")]
    CommandNotFound(String),
    #[error("spawn failed: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("the spawn lane is full")]
    LaneFull,
    #[error("transport closed")]
    Closed,
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("request failed: {0}")]
    Request(String),
    #[error("the {0} transport is not supported")]
    Unsupported(&'static str),
    /// The server needs a sign-in that cannot be completed without the user.
    #[error("MCP OAuth reauthenticationRequired: sign in to connect")]
    AuthRequired,
    #[error("{0}")]
    Other(String),
}

/// Authorization of requests to one remote server (MCP OAuth). The token is sent only to the
/// server's own endpoints.
#[async_trait]
pub trait Authorizer: Send + Sync {
    /// The bearer token to send, if the server has one stored.
    async fn token(&self) -> Result<Option<String>, TransportError>;
    /// The server rejected `rejected` (see [`refused`]): renews the sign-in from its refresh
    /// token. `challenge` is the response's `WWW-Authenticate` value. `Ok(())` means a new token
    /// may be fetched with [`token`](Self::token); `AuthRequired` means the user must sign in again.
    async fn renew(&self, rejected: Option<String>, challenge: Option<String>) -> Result<(), TransportError>;
}

/// Whether a response refuses the request's credentials: a 401, or a 403 that asks for more
/// scope. Any other 403 is the server's answer, not a sign-in problem.
pub fn refused(status: u16, www_authenticate: Option<&str>) -> bool {
    status == 401 || (status == 403 && www_authenticate.is_some_and(|v| v.contains("insufficient_scope")))
}

/// The `WWW-Authenticate` value of a response.
pub fn challenge_of(response: &reqwest::Response) -> Option<String> {
    response.headers().get(reqwest::header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

#[async_trait]
pub trait Transport: Send + Sync {
    /// Sends one message. Completing means the message was handed to the wire.
    async fn send(&self, message: Value) -> Result<(), TransportError>;

    /// Ends the transport. Idempotent; the receiver then gets `Closed`.
    async fn close(&self);

    /// The protocol version the handshake settled on (HTTP echoes it in a header).
    fn set_protocol_version(&self, _version: &str) {}

    /// Called once after `notifications/initialized` was sent.
    fn initialized(&self) {}
}
