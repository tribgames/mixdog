//! The sign-in notices of a connector (`mcp/oauth-request.mjs` `signInExpired` / `clearDesktopNotice`):
//! the desktop says once per server that a sign-in which worked was refused and could not be renewed,
//! until a request carrying its token succeeds again. The transports report the events through
//! [`Authorizer`]; this wraps a server's authorizer and tells [`SignInNotices`] under the server's name.

use std::sync::Arc;

use async_trait::async_trait;

use crate::transport::{Authorizer, TransportError};

/// Where a connector's sign-in problem is shown and withdrawn, by server name.
pub trait SignInNotices: Send + Sync {
    /// `signInExpired(serverName)`.
    fn expired(&self, server: &str);
    /// `clearDesktopNotice(signInNoticeKey(serverName))`.
    fn restored(&self, server: &str);
}

/// `inner` for the server `server`, reporting to `notices`.
pub struct NoticingAuthorizer {
    inner: Arc<dyn Authorizer>,
    server: String,
    notices: Arc<dyn SignInNotices>,
}

impl NoticingAuthorizer {
    pub fn new(inner: Arc<dyn Authorizer>, server: &str, notices: Arc<dyn SignInNotices>) -> Self {
        Self { inner, server: server.to_owned(), notices }
    }
}

#[async_trait]
impl Authorizer for NoticingAuthorizer {
    async fn token(&self) -> Result<Option<String>, TransportError> {
        self.inner.token().await
    }

    /// A stored sign-in was sent and refused, and its renewal needs the user
    /// (`attemptedToken && error.code === 'reauthenticationRequired'`, oauth-request.mjs:117).
    async fn renew(&self, rejected: Option<String>, challenge: Option<String>) -> Result<(), TransportError> {
        let carried = rejected.is_some();
        let renewed = self.inner.renew(rejected, challenge).await;
        if carried && matches!(renewed, Err(TransportError::AuthRequired)) {
            self.notices.expired(&self.server);
        }
        renewed
    }

    /// A request carrying a token succeeded (oauth-request.mjs:102 and :137).
    fn answered(&self, sent: Option<&str>) {
        self.inner.answered(sent);
        if sent.is_some() {
            self.notices.restored(&self.server);
        }
    }

    /// The retry was refused again (oauth-request.mjs:131: `if (attemptedToken) signInExpired`).
    fn refused_after_renewal(&self, attempted: Option<&str>) {
        self.inner.refused_after_renewal(attempted);
        if attempted.is_some() {
            self.notices.expired(&self.server);
        }
    }
}