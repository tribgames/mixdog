//! The seam between the JSON-RPC client and a wire. A transport sends whole JSON messages and
//! pushes everything it receives into an unbounded channel, ending with exactly one
//! [`Incoming::Closed`]. "Alive" is the transport being open — a fact — never a probe.

use async_trait::async_trait;
use mixdog_rt::Liveness;
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

/// `appendMcpStderrTail`: a failure message followed by the server's stderr tail, as Node prints it.
pub fn append_stderr_tail(message: &str, tail: &str) -> String {
    let tail = tail.trim();
    if tail.is_empty() { message.to_owned() } else { format!("{message}\n--- server stderr (tail) ---\n{tail}") }
}

pub type IncomingRx = mpsc::UnboundedReceiver<Incoming>;
pub type IncomingTx = mpsc::UnboundedSender<Incoming>;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// Node's `ErrnoException` for a failed spawn: `spawn <command> <code>`.
    #[error("spawn {file} {code}")]
    Spawn {
        file: String,
        code: &'static str,
        #[source]
        source: std::io::Error,
    },
    /// The spawn lane refused the start as overloaded (its queue at the far bound); below that
    /// the start waits for a thread.
    #[error("overloaded: io-spawn")]
    LaneFull,
    #[error("transport closed")]
    Closed,
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("request failed: {0}")]
    Request(String),
    /// A request whose socket failed with a system error, shown as [`Request`](Self::Request) is, with the error's code
    /// (`ECONNREFUSED`) beside it.
    #[error("request failed: {message}")]
    Socket { message: String, code: &'static str },
    #[error("the {0} transport is not supported")]
    Unsupported(&'static str),
    /// The server needs a sign-in that cannot be completed without the user.
    #[error("MCP OAuth reauthenticationRequired: sign in to connect")]
    AuthRequired,
    #[error("{0}")]
    Other(String),
}

impl TransportError {
    /// The system error code of a failed socket, if that is what failed.
    pub fn os_code(&self) -> Option<&'static str> {
        match self {
            Self::Socket { code, .. } => Some(*code),
            _ => None,
        }
    }
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
    /// A request sent with sent (the token it carried, none when it carried none) was answered by a
    /// success.
    fn answered(&self, _sent: Option<&str>) {}
    /// The token ttempted was refused, renewed, and the renewed one was refused too.
    /// `challenge` is the `WWW-Authenticate` value of that last refusal.
    fn refused_after_renewal(&self, _attempted: Option<&str>, _challenge: Option<&str>) {}

    fn sign_in_required(&self) -> bool {
        false
    }

    /// Whether the server is known, before any dial, to need a sign-in that is not stored, so a connect cannot succeed until one is.
    async fn sign_in_absent(&self) -> bool {
        false
    }

    /// Which sign-in is stored: another value once another grant's tokens, or none, are stored in its place, the same
    /// value through every renewal.
    fn sign_in(&self) -> u64 {
        0
    }

    /// [`token`](Self::token) with the sign-in it is of, from one read. `Ok(None)`: the store did not answer.
    async fn token_as(&self) -> Result<Option<(u64, Option<String>)>, TransportError> {
        Ok(Some((self.sign_in(), self.token().await?)))
    }
}

/// One connection's use of an [`Authorizer`]: the sign-in the connection was opened as (the one its first token was
/// of), for everything it sends until it closes. Once another sign-in is stored, or none, the connection keeps the last
/// token it had and renews nothing.
pub struct OpenedAs {
    inner: std::sync::Arc<dyn Authorizer>,
    /// The sign-in the connection was opened as and the token it last had; `None` until its first token is read.
    opened: std::sync::Mutex<Option<(u64, Option<String>)>>,
}

impl OpenedAs {
    pub fn new(inner: std::sync::Arc<dyn Authorizer>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { inner, opened: std::sync::Mutex::new(None) })
    }

    /// The sign-in the connection was opened as; `None` while it has sent nothing.
    pub fn opened_as(&self) -> Option<u64> {
        self.opened.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(sign_in, _)| *sign_in)
    }

    fn current(&self) -> bool {
        self.opened_as().is_none_or(|opened| opened == self.inner.sign_in())
    }

    /// The token the connection last had, without asking for it: what its close is sent with.
    pub fn held(&self) -> Option<String> {
        self.opened.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|(_, held)| held.clone())
    }
}

#[async_trait]
impl Authorizer for OpenedAs {
    async fn token(&self) -> Result<Option<String>, TransportError> {
        let read = self.inner.token_as().await?;
        let mut opened = self.opened.lock().unwrap_or_else(|e| e.into_inner());
        let Some((sign_in, token)) = read else { return Ok(opened.as_ref().and_then(|(_, held)| held.clone())) };
        if let Some((opened_as, held)) = opened.as_mut() {
            if *opened_as != sign_in {
                return Ok(held.clone());
            }
            held.clone_from(&token);
        } else {
            *opened = Some((sign_in, token.clone()));
        }
        Ok(token)
    }

    async fn renew(&self, rejected: Option<String>, challenge: Option<String>) -> Result<(), TransportError> {
        if !self.current() {
            return Err(TransportError::AuthRequired);
        }
        self.inner.renew(rejected, challenge).await
    }

    fn answered(&self, sent: Option<&str>) {
        if self.current() {
            self.inner.answered(sent);
        }
    }

    fn refused_after_renewal(&self, attempted: Option<&str>, challenge: Option<&str>) {
        if self.current() {
            self.inner.refused_after_renewal(attempted, challenge);
        }
    }

    fn sign_in_required(&self) -> bool {
        self.inner.sign_in_required()
    }

    async fn sign_in_absent(&self) -> bool {
        self.inner.sign_in_absent().await
    }

    fn sign_in(&self) -> u64 {
        self.opened_as().unwrap_or_else(|| self.inner.sign_in())
    }
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
    /// Sends one message under its [`Liveness`]. Completing means the message was handed to the
    /// wire; a send that outlives its deadline fails instead of waiting for the peer.
    async fn send(&self, message: Value, liveness: Liveness) -> Result<(), TransportError>;

    /// Ends the transport. Idempotent; the receiver then gets `Closed`.
    async fn close(&self);

    /// The protocol version the handshake settled on (HTTP echoes it in a header).
    fn set_protocol_version(&self, _version: &str) {}

    /// Called once after `notifications/initialized` was sent.
    fn initialized(&self) {}

    /// The sign-in the connection was opened as ([`OpenedAs::opened_as`]); `None` for one that carries no sign-in.
    fn opened_as(&self) -> Option<u64> {
        None
    }

    /// The tail of what a stdio server wrote to stderr so far; empty for every other transport.
    fn stderr_tail(&self) -> String {
        String::new()
    }
}
