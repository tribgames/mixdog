//! Devin credentials: the stored session token. It cannot be refreshed;
//! once it expired the user signs in again.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use serde::Deserialize;
use serde::Serialize;

use super::SessionToken;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;

/// `devin-oauth.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredCredentials {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub identity: Option<Identity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

pub const REAUTH_GUIDANCE: &str = "Open /providers in Mixdog to sign in again.";

fn reauth(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    error.reauth_required = true;
    error.message = format!("{message} {REAUTH_GUIDANCE}");
    error
}

impl StoredCredentials {
    /// The session token for use at `now_ms`; an absent or expired token is
    /// a re-auth, not a refresh.
    pub fn usable_token(&self, now_ms: u64) -> Result<&str, ProviderError> {
        if self.access_token.is_empty() {
            return Err(reauth("Devin is not signed in."));
        }
        if self.expires_at.is_some_and(|at| at <= now_ms) {
            return Err(reauth("The Devin sign-in expired."));
        }
        Ok(&self.access_token)
    }
}

/// A fixed credential (an environment-provided token, tests).
pub struct StaticSessionToken {
    credentials: StoredCredentials,
    /// Which provider instance holds it: a token with no identity is told apart from another instance's by this.
    instance: u64,
}

impl StaticSessionToken {
    pub fn new(credentials: StoredCredentials) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Self { credentials, instance: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) }
    }
}

#[async_trait]
impl SessionToken for StaticSessionToken {
    async fn session_token(&self) -> Result<String, ProviderError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        self.credentials.usable_token(now).map(str::to_owned)
    }

    /// The identity the sign-in returned; a token that came with none is the one this provider instance holds.
    fn account(&self) -> String {
        match &self.credentials.identity {
            Some(Identity { id: Some(id), .. }) => format!("id {id}"),
            Some(Identity { email: Some(email), .. }) => format!("email {email}"),
            _ => format!("static session token of instance {}", self.instance),
        }
    }
}

/// `devin-oauth.json`: read on every turn, so a sign-in by another process
/// is picked up at once; an unreadable file is a fault, never a logout.
pub struct FileSessionToken(pub CredentialFile);

#[async_trait]
impl SessionToken for FileSessionToken {
    async fn session_token(&self) -> Result<String, ProviderError> {
        match self.0.load::<StoredCredentials>().await {
            Probe::Present(credentials) => {
                self.0.keep(&[&credentials.access_token, credentials.refresh_token.as_deref().unwrap_or_default()]);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64);
                credentials.usable_token(now).map(str::to_owned)
            }
            Probe::Absent => Err(reauth("Devin is not signed in.")),
            Probe::Unreadable => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.message = "[devin-oauth] the credential file cannot be read".to_owned();
                Err(error)
            }
        }
    }

    fn account(&self) -> String {
        format!("file {}", self.0.path().display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(expires_at: Option<u64>) -> StoredCredentials {
        StoredCredentials {
            access_token: "t".into(),
            refresh_token: None,
            expires_at,
            identity: None,
        }
    }

    #[test]
    fn expired_token_asks_for_a_new_sign_in() {
        assert_eq!(creds(Some(10)).usable_token(5).unwrap(), "t");
        let e = creds(Some(10)).usable_token(10).unwrap_err();
        assert!(e.reauth_required);
        assert_eq!(e.kind, ErrorKind::Auth);
    }

    #[test]
    fn stored_file_shape_round_trips() {
        let c: StoredCredentials =
            serde_json::from_str(r#"{"access_token":"a","refresh_token":null,"expires_at":5,"identity":{"id":"1","email":"x@y"}}"#)
                .unwrap();
        assert_eq!(c.expires_at, Some(5));
        assert!(creds(None).usable_token(u64::MAX).is_ok());
    }
}
