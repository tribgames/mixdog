//! Credentials of the Google providers. [`RequestAuth`] is what an adapter
//! asks for before every attempt; [`ApiKeyAuth`], [`vertex`] and
//! [`antigravity`] implement it.

pub mod antigravity;
pub mod vertex;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

/// Credentials for one attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub headers: Vec<(String, String)>,
    /// The account behind the credentials; an adapter built for one identity
    /// refuses another.
    pub identity: String,
}

#[async_trait]
pub trait RequestAuth: Send + Sync {
    async fn authorize(&self) -> Result<Authorization, ProviderError>;

    /// The server answered 401 to `rejected`. True when fresh credentials are
    /// ready and one resend is worthwhile; false when nothing can change.
    async fn rejected(&self, rejected: &Authorization) -> bool;
}

/// A static key sent in `x-goog-api-key` (Gemini API, Vertex express mode).
pub struct ApiKeyAuth {
    key: String,
}

impl ApiKeyAuth {
    pub fn new(key: impl Into<String>) -> Self {
        Self { key: key.into() }
    }
}

#[async_trait]
impl RequestAuth for ApiKeyAuth {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        if self.key.trim().is_empty() {
            let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
            err.reauth_required = true;
            err.message = "the API key is not configured".into();
            return Err(err);
        }
        Ok(Authorization {
            headers: vec![("x-goog-api-key".into(), self.key.clone())],
            identity: String::new(),
        })
    }

    async fn rejected(&self, _: &Authorization) -> bool {
        false
    }
}

/// An OAuth token endpoint's answer (RFC 6749 §5).
#[derive(Clone, Debug)]
pub struct TokenGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in_secs: Option<u64>,
}

pub fn form_body(fields: &[(&str, &str)]) -> Vec<u8> {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in fields {
        form.append_pair(key, value);
    }
    form.finish().into_bytes()
}

/// A failed credential exchange as a [`ProviderError`]: the grant is dead
/// only on a typed RFC 6749 error code; a server fault or throttle is
/// transient and the stored credential stays.
pub fn token_failure(status: u16, body: &[u8], what: &str) -> ProviderError {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.as_str().or_else(|| e.get("status").and_then(Value::as_str)))
        .unwrap_or("")
        .to_owned();
    let dead = matches!(status, 400 | 401)
        && matches!(code.as_str(), "invalid_grant" | "invalid_token" | "unauthorized_client");
    let kind = if status >= 500 || status == 429 { ErrorKind::Transient } else { ErrorKind::Auth };
    let mut err = ProviderError::new(kind, DeliveryState::NotSent);
    err.status = Some(status);
    err.reauth_required = dead;
    err.code = (!code.is_empty()).then_some(code);
    err.message = format!("{what} failed with status {status}");
    err
}

pub fn parse_token_grant(body: &[u8], what: &str) -> Result<TokenGrant, ProviderError> {
    let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let Some(access_token) = value.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty()) else {
        let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        err.message = format!("{what} response is missing access_token");
        return Err(err);
    };
    Ok(TokenGrant {
        access_token: access_token.to_owned(),
        refresh_token: value.get("refresh_token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned),
        expires_in_secs: value.get("expires_in").and_then(Value::as_u64),
    })
}
