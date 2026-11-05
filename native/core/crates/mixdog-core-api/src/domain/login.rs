//! The one login-flow mechanism (DS §5.4): GitHub (`gh auth`), provider
//! OAuth and MCP OAuth. A flow's progress is the scoped feed
//! `login:<flowId>`; [`LoginSession::state`] is the snapshot for reconnects.

use std::time::SystemTime;

use async_trait::async_trait;

use mixdog_protocol::ProviderId;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum LoginTarget {
    Github,
    Provider(ProviderId),
    McpServer(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LoginFailure {
    /// The authorization server refused (definitive).
    Denied,
    /// Device code or authorization request expired (provider-stated expiry).
    Expired,
    /// The login program is missing (e.g. no `gh`).
    Unavailable {
        capability: String,
    },
    Failed {
        code: String,
        message: String,
    },
    /// The provider requires the user to verify the account on `url` before
    /// signing in again (Antigravity `VALIDATION_REQUIRED`, from the
    /// response's structured details).
    VerificationRequired {
        url: String,
        account: Option<String>,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LoginState {
    Starting,
    DeviceCode {
        user_code: String,
        verification_uri: String,
        expires_at: Option<SystemTime>,
    },
    /// Open this URL; the loopback callback or a pasted code completes it.
    Authorize {
        url: String,
        /// For a browser on another machine: this URL ends on a page showing a
        /// code to paste (`LoginInput::AuthorizationCode`) instead of the
        /// loopback redirect. `None` where the provider has no such page.
        manual_url: Option<String>,
    },
    Waiting,
    Done {
        account: Option<String>,
    },
    Failed(LoginFailure),
    Cancelled,
}

impl LoginState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done { .. } | Self::Failed(_) | Self::Cancelled)
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LoginInput {
    /// Code pasted by the user for flows without a loopback callback.
    AuthorizationCode(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LoginError {
    /// Another flow for the same target is running.
    Busy,
    InputNotExpected,
    Finished,
    Failed(LoginFailure),
}

/// One running flow, registered by the core under a `LoginFlowId`.
#[async_trait]
pub trait LoginSession: Send + Sync {
    /// Snapshot for reconnects (`*/login/status`).
    fn state(&self) -> LoginState;
    /// Next state change; `None` after the terminal state was delivered.
    async fn next(&self) -> Option<LoginState>;
    async fn provide(&self, input: LoginInput) -> Result<(), LoginError>;
    /// Ends the flow (kills a `gh` child, closes the loopback listener); the
    /// next state is `Cancelled` unless the flow already ended.
    fn cancel(&self);
}

#[async_trait]
pub trait LoginFlow: Send + Sync {
    fn target(&self) -> &LoginTarget;
    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError>;
}
