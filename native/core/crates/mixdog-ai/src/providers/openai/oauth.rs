//! The `openai-oauth` credential: the stored ChatGPT login (`openai-oauth.json`)
//! as an adapter [`CredentialSource`]. The access token is refreshed ahead of
//! its expiry and after a 401, once at a time per process (a rotated refresh
//! token is single-use), and a refresh only replaces the stored pair if the
//! file still holds the pair it read, so another process's newer login is
//! never overwritten.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::adapter::Credential;
use super::adapter::CredentialSource;
use crate::oauth::RefreshFailure;
use crate::oauth::classify_refresh_failure;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;
use crate::transport::HttpSend;

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// A token this close to its expiry is refreshed before use.
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;
const AUTH_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Deserialize, Clone, Debug)]
struct Stored {
    access_token: String,
    refresh_token: Option<String>,
    /// Milliseconds since the epoch; 0 when unknown.
    #[serde(default)]
    expires_at: u64,
    account_id: Option<String>,
}

impl Stored {
    fn credential(&self) -> Credential {
        Credential { bearer: self.access_token.clone(), account_id: self.account_id.clone() }
    }

    fn usable_at(&self, now: u64, skew: u64) -> bool {
        self.expires_at == 0 || self.expires_at > now + skew
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The ChatGPT account id an access token's claims name.
fn account_of(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    Some(claims.get(AUTH_CLAIM)?.get("chatgpt_account_id")?.as_str()?.to_owned())
}

fn login_required(message: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = true;
    err.message = message.to_owned();
    err
}

type Refreshing = Shared<BoxFuture<'static, Result<Credential, ProviderError>>>;

struct Inner {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    inflight: Mutex<Option<Refreshing>>,
}

pub struct OpenAiOAuth {
    inner: Arc<Inner>,
}

impl OpenAiOAuth {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self { inner: Arc::new(Inner { file, http, inflight: Mutex::new(None) }) }
    }
}

impl Inner {
    async fn stored(&self) -> Result<Stored, ProviderError> {
        match self.file.load::<Stored>().await {
            Probe::Present(stored) => Ok(stored),
            Probe::Absent => Err(login_required("not signed in to ChatGPT")),
            Probe::Unreadable => {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = "the stored ChatGPT login cannot be read right now".into();
                Err(err)
            }
        }
    }

    /// A usable credential: the stored one when it is newer than `rejected`
    /// and not expiring, otherwise a refreshed one.
    async fn renew(self: Arc<Self>, rejected: Option<String>) -> Result<Credential, ProviderError> {
        let stored = self.stored().await?;
        let newer = rejected.as_deref().is_none_or(|bearer| bearer != stored.access_token);
        if newer && stored.usable_at(now_ms(), REFRESH_SKEW_MS) {
            return Ok(stored.credential());
        }
        let Some(refresh_token) = stored.refresh_token.clone().filter(|t| !t.is_empty()) else {
            return Err(login_required("the stored ChatGPT login has no refresh token"));
        };
        // The serializer is not `Send`: it is finished before the await.
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &refresh_token)
            .append_pair("client_id", CLIENT_ID)
            .finish()
            .into_bytes();
        let response = self
            .http
            .send(WireRequest {
                transport: TransportKind::Http1,
                method: "POST".into(),
                url: TOKEN_URL.into(),
                headers: vec![("Content-Type".into(), "application/x-www-form-urlencoded".into())],
                body,
            })
            .await;
        let (status, body) = match response {
            Ok(response) => {
                let read = response.read_all().await?;
                (read.status, read.body)
            }
            Err(_) => (None, Vec::new()),
        };
        let json: Option<Value> = serde_json::from_slice(&body).ok();
        let Some(tokens) = json
            .as_ref()
            .filter(|_| status.is_some_and(|s| (200..300).contains(&s)))
            .and_then(|v| v.get("access_token")?.as_str().map(|a| (v, a.to_owned())))
        else {
            return self.failed(&stored, status, &body);
        };
        let (json, access_token) = tokens;
        let expires_at = json
            .get("expires_in")
            .and_then(Value::as_u64)
            .map_or(0, |secs| now_ms() + secs * 1000);
        let mut update = Map::new();
        update.insert("access_token".into(), json!(access_token));
        update.insert(
            "refresh_token".into(),
            json!(json.get("refresh_token").and_then(Value::as_str).unwrap_or(&refresh_token)),
        );
        update.insert("expires_at".into(), json!(expires_at));
        if let Some(account) = account_of(&access_token) {
            update.insert("account_id".into(), json!(account));
        }
        let expected = refresh_token.clone();
        let published = self
            .file
            .replace_if(
                move |doc| doc.get("refresh_token").and_then(Value::as_str) == Some(expected.as_str()),
                update,
            )
            .await
            .map_err(|_| {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = "the refreshed ChatGPT login could not be stored".into();
                err
            })?;
        // Published or not, the file now holds the live pair: when another
        // process refreshed first, its pair wins.
        let _ = published;
        Ok(self.stored().await?.credential())
    }

    /// A refresh that did not produce tokens. A dead grant needs a new login;
    /// anything else coasts on the current token while it still has life.
    fn failed(&self, stored: &Stored, status: Option<u16>, body: &[u8]) -> Result<Credential, ProviderError> {
        match classify_refresh_failure(status, body) {
            RefreshFailure::Definitive => Err(login_required("the ChatGPT login was revoked or expired")),
            verdict => {
                if stored.usable_at(now_ms(), 0) {
                    return Ok(stored.credential());
                }
                let kind = if verdict == RefreshFailure::Transient {
                    ErrorKind::Transient
                } else {
                    ErrorKind::Auth
                };
                let mut err = ProviderError::new(kind, DeliveryState::NotSent);
                err.status = status;
                err.message = "the ChatGPT token refresh failed".into();
                Err(err)
            }
        }
    }
}

impl OpenAiOAuth {
    async fn renewed(&self, rejected: Option<String>) -> Result<Credential, ProviderError> {
        let shared = {
            let mut inflight = self.inner.inflight.lock().unwrap_or_else(PoisonError::into_inner);
            inflight
                .get_or_insert_with(|| self.inner.clone().renew(rejected).boxed().shared())
                .clone()
        };
        let result = shared.await;
        self.inner.inflight.lock().unwrap_or_else(PoisonError::into_inner).take();
        result
    }
}

#[async_trait]
impl CredentialSource for OpenAiOAuth {
    async fn current(&self) -> Result<Credential, ProviderError> {
        let stored = self.inner.stored().await?;
        if stored.usable_at(now_ms(), REFRESH_SKEW_MS) {
            return Ok(stored.credential());
        }
        self.renewed(None).await
    }

    async fn after_rejection(&self, rejected: &Credential) -> Result<Option<Credential>, ProviderError> {
        let next = self.renewed(Some(rejected.bearer.clone())).await?;
        Ok((next != *rejected).then_some(next))
    }
}
