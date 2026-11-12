//! Cursor credentials: the access token and its exchange/refresh.
//!
//! The pure parts live here: the stored token shape, expiry decisions, the
//! exchange request and its error classification, and the API-key flavour
//! (`cursor-api`) of [`AccessToken`]. Credential files, the refresh lock and
//! the poll-login flow belong to the shared OAuth plumbing.

use crate::transport::deadlines::CURSOR_EXCHANGE;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use super::AccessToken;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;
use crate::providers::connect::ConnectFailure;
use crate::transport::http::HttpSend;
use crate::providers::connect::provider_error;
use crate::retry::advice;

pub const EXCHANGE_URL: &str = "https://api2.cursor.sh/auth/exchange_user_api_key";
/// A token this close to its expiry is refreshed first.
pub const REFRESH_SKEW: Duration = Duration::from_secs(5 * 60);
/// A token without a readable expiry is assumed to live an hour.
const DEFAULT_TOKEN_LIFETIME: Duration = Duration::from_secs(60 * 60);
pub const REAUTH_GUIDANCE: &str = "Open /providers in Mixdog to sign in again.";

/// `cursor-oauth.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Milliseconds since the Unix epoch; 0 or absent when unknown.
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub reauth_required: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The `exp` claim of a JWT access token in milliseconds, 0 when absent. The
/// exchange response carries no expiry of its own.
pub fn token_expiry(token: &str) -> u64 {
    let mut parts = token.split('.');
    let (Some(_), Some(payload), Some(_), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return 0;
    };
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload) else {
        return 0;
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("exp").and_then(Value::as_f64))
        .filter(|exp| *exp > 0.0)
        .map_or(0, |exp| (exp * 1000.0) as u64)
}

impl StoredTokens {
    /// The record an exchange or poll produced.
    pub fn from_exchange(access_token: String, refresh_token: Option<String>, now_ms: u64) -> Self {
        let expiry = token_expiry(&access_token);
        Self {
            expires_at: if expiry > 0 {
                expiry
            } else {
                now_ms + DEFAULT_TOKEN_LIFETIME.as_millis() as u64
            },
            access_token,
            refresh_token,
            reauth_required: false,
        }
    }

    /// Whether the token must be exchanged before use at `now_ms`.
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at <= now_ms + REFRESH_SKEW.as_millis() as u64
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at <= now_ms
    }
}

/// A failed exchange: only a credential verdict is permanent; throttles, 5xx
/// and network failures leave the refresh token valid.
pub fn exchange_error(status: u16, headers: &[(String, String)], detail: &str) -> ProviderError {
    let code = match status {
        400 => "invalid_argument",
        401 => "unauthenticated",
        403 => "permission_denied",
        429 => "resource_exhausted",
        500 => "internal",
        502 | 503 => "unavailable",
        504 => "deadline_exceeded",
        _ => "",
    };
    let permanent = matches!(status, 400 | 401 | 403);
    let mut message = format!("Cursor token exchange failed ({status})");
    if !detail.is_empty() {
        message.push_str(&format!(": {detail}"));
    }
    if permanent {
        message.push_str(&format!(". {REAUTH_GUIDANCE}"));
    }
    let mut error = provider_error(
        ConnectFailure {
            code: code.to_owned(),
            message,
            http_status: Some(status),
            retry_after: advice::from_headers(headers, SystemTime::now()),
        },
        DeliveryState::Accepted,
    );
    error.reauth_required = permanent;
    error
}

/// One token exchange: `token` (an API key or a refresh token) for a fresh
/// access token.
pub async fn exchange_token(http: &dyn HttpSend, token: &str) -> Result<StoredTokens, ProviderError> {
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: EXCHANGE_URL.to_owned(),
                headers: vec![
                    // As the caller's `fetch` spells them (cursor-auth.mjs `exchangeCursorToken`).
                    ("Authorization".to_owned(), format!("Bearer {token}")),
                    ("Content-Type".to_owned(), "application/json".to_owned()),
                ],
                body: b"{}".to_vec(),
            },
            CURSOR_EXCHANGE,
        )
        .await?;
    let success = head.is_success();
    let response = head.read_all().await?;
    if !success {
        // The server's text may echo the token this exchange carried; it is redacted wherever it stands.
        let detail = crate::oauth::scrub::scrub_oauth_secrets(&String::from_utf8_lossy(&response.body), &[token]).trim().to_owned();
        return Err(exchange_error(response.status.unwrap_or(0), &response.headers, &detail));
    }
    let data: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let Some(access) = data.get("accessToken").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
        error.message = "Cursor token exchange returned no access token".to_owned();
        return Err(error);
    };
    let refresh = data
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(token);
    Ok(StoredTokens::from_exchange(
        access.to_owned(),
        Some(refresh.to_owned()),
        now_ms(),
    ))
}

/// `cursor-api`: the configured API key, exchanged for access tokens that are
/// cached until their refresh skew.
pub struct ApiKeyAccess {
    http: std::sync::Arc<dyn HttpSend>,
    api_key: String,
    cached: ArcSwapOption<StoredTokens>,
    /// One exchange at a time; waiters adopt its result.
    exchanging: tokio::sync::Semaphore,
}

impl ApiKeyAccess {
    pub fn new(http: std::sync::Arc<dyn HttpSend>, api_key: String) -> Self {
        Self {
            http,
            api_key,
            cached: ArcSwapOption::empty(),
            exchanging: tokio::sync::Semaphore::new(1),
        }
    }

    fn fresh(&self) -> Option<String> {
        self.cached
            .load_full()
            .filter(|t| !t.needs_refresh(now_ms()))
            .map(|t| t.access_token.clone())
    }
}

#[async_trait]
impl AccessToken for ApiKeyAccess {
    async fn access_token(&self, force_refresh: bool) -> Result<String, ProviderError> {
        if !force_refresh && let Some(access) = self.fresh() {
            return Ok(access);
        }
        // What this caller saw rejected: a forced refresh that finds another
        // token in the cache after waiting adopts it instead of exchanging again.
        let seen = self.cached.load_full().map(|t| t.access_token.clone());
        let _gate = self.exchanging.acquire().await.map_err(|_| storage("exchange gate closed"))?;
        let current = self.cached.load_full().map(|t| t.access_token.clone());
        if let Some(access) = self.fresh()
            && (!force_refresh || current != seen)
        {
            return Ok(access);
        }
        let tokens = exchange_token(self.http.as_ref(), &self.api_key).await?;
        let access = tokens.access_token.clone();
        self.cached.store(Some(std::sync::Arc::new(tokens)));
        Ok(access)
    }
}
fn reauth(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    error.reauth_required = true;
    error.message = format!("{message} {REAUTH_GUIDANCE}");
    error
}

fn storage(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = format!("[cursor-oauth] {message}");
    error
}

fn document(tokens: &StoredTokens) -> Result<serde_json::Map<String, Value>, ProviderError> {
    match serde_json::to_value(tokens) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(storage("tokens not serializable")),
    }
}

/// `cursor-oauth`: the signed-in account's tokens in `cursor-oauth.json`,
/// refreshed with the stored refresh token. The file is the one source of
/// truth: every call reads it, and a rotation is published only over the pair
/// that was exchanged, so another process that refreshed first wins.
pub struct FileAccess {
    http: std::sync::Arc<dyn HttpSend>,
    file: CredentialFile,
    /// One refresh at a time in this process; waiters adopt its result.
    refreshing: tokio::sync::Semaphore,
}

impl FileAccess {
    pub fn new(http: std::sync::Arc<dyn HttpSend>, file: CredentialFile) -> Self {
        Self {
            http,
            file,
            refreshing: tokio::sync::Semaphore::new(1),
        }
    }

    async fn stored(&self) -> Result<StoredTokens, ProviderError> {
        match self.file.load::<StoredTokens>().await {
            Probe::Present(tokens) => Ok(tokens),
            Probe::Absent => Err(reauth("Cursor OAuth is not connected.")),
            Probe::Unreadable => Err(storage("the credential file cannot be read")),
        }
    }

    /// Records that the refresh token was refused, unless another process has
    /// replaced it since. The tokens stay; a new sign-in clears the marker.
    async fn mark_dead(&self, refresh_token: &str) {
        let expected = refresh_token.to_owned();
        let mut update = serde_json::Map::new();
        update.insert("reauth_required".to_owned(), Value::Bool(true));
        let _ = self
            .file
            .replace_if(
                move |doc| doc.get("refresh_token").and_then(Value::as_str) == Some(expected.as_str()),
                update,
            )
            .await;
    }

    async fn refresh(&self, old: StoredTokens, force: bool) -> Result<StoredTokens, ProviderError> {
        let _gate = self.refreshing.acquire().await.map_err(|_| storage("refresh gate closed"))?;
        // A concurrent refresher (or process) may already have rotated.
        let latest = self.stored().await?;
        let rotated = latest.access_token != old.access_token || latest.refresh_token != old.refresh_token;
        let valid_after = now_ms() + if force { 0 } else { REFRESH_SKEW.as_millis() as u64 };
        if rotated && (latest.expires_at == 0 || latest.expires_at > valid_after) {
            return Ok(latest);
        }
        let Some(refresh_token) = latest.refresh_token.clone() else {
            return Err(reauth("Cursor OAuth refresh token is unavailable."));
        };
        let next = match exchange_token(self.http.as_ref(), &refresh_token).await {
            Ok(next) => next,
            Err(error) => {
                if error.reauth_required {
                    self.mark_dead(&refresh_token).await;
                }
                return Err(error);
            }
        };
        let (access, refresh) = (latest.access_token.clone(), refresh_token);
        let published = self
            .file
            .replace_if(
                move |doc| {
                    doc.get("access_token").and_then(Value::as_str) == Some(access.as_str())
                        && doc.get("refresh_token").and_then(Value::as_str) == Some(refresh.as_str())
                },
                document(&next)?,
            )
            .await
            .map_err(|_| storage("the refreshed tokens could not be stored"))?;
        if published { Ok(next) } else { self.stored().await }
    }
}

#[async_trait]
impl AccessToken for FileAccess {
    async fn access_token(&self, force_refresh: bool) -> Result<String, ProviderError> {
        let tokens = self.stored().await?;
        if !force_refresh && !tokens.needs_refresh(now_ms()) {
            return Ok(tokens.access_token);
        }
        if tokens.refresh_token.is_none() {
            if !tokens.is_expired(now_ms()) {
                return Ok(tokens.access_token);
            }
            return Err(reauth("Cursor access token expired and has no refresh token."));
        }
        Ok(self.refresh(tokens, force_refresh).await?.access_token)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use bytes::Bytes;
    use mixdog_core_api::domain::provider::TransportFault;

    use super::*;
    use crate::transport::http::BodyStream;
    use crate::transport::http::HttpResponse;

    struct Once(Option<Bytes>);

    #[async_trait]
    impl BodyStream for Once {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    /// Answers every exchange after yielding, so concurrent callers overlap.
    struct Exchange {
        calls: AtomicUsize,
        status: u16,
    }

    #[async_trait]
    impl HttpSend for Exchange {
        async fn send(
            &self,
            _request: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            let body = format!(r#"{{"accessToken":"{}","refreshToken":"r"}}"#, jwt(4_000_000_000));
            Ok(HttpResponse {
                status: self.status,
                headers: Vec::new(),
                body: Box::new(Once(Some(Bytes::from(body)))),
            })
        }
    }

    #[tokio::test]
    async fn concurrent_callers_cause_one_exchange() {
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let access = std::sync::Arc::new(ApiKeyAccess::new(http.clone(), "key".into()));
        let calls = (0..8).map(|_| {
            let access = access.clone();
            async move { access.access_token(false).await.unwrap() }
        });
        let tokens = futures::future::join_all(calls).await;
        assert!(tokens.iter().all(|t| *t == tokens[0]));
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
        // A cached, fresh token needs no exchange.
        access.access_token(false).await.unwrap();
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_exchange_surfaces_even_when_the_key_looks_valid() {
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 401 });
        // The key is a JWT that has not expired: it is still not a fallback.
        let key = jwt(4_000_000_000);
        let access = ApiKeyAccess::new(http, key);
        let error = access.access_token(false).await.unwrap_err();
        assert!(error.reauth_required);
    }

    fn jwt(exp: u64) -> String {
        let payload = URL_SAFE_NO_PAD.encode(format!("{{\"exp\":{exp}}}"));
        format!("h.{payload}.s")
    }

    #[test]
    fn expiry_reads_the_exp_claim_in_ms() {
        assert_eq!(token_expiry(&jwt(1_800_000_000)), 1_800_000_000_000);
        assert_eq!(token_expiry("not-a-jwt"), 0);
    }

    #[test]
    fn refresh_is_due_inside_the_skew() {
        let t = StoredTokens::from_exchange(jwt(1_000), Some("r".into()), 0);
        assert_eq!(t.expires_at, 1_000_000);
        assert!(t.needs_refresh(1_000_000 - 299_000));
        assert!(!t.needs_refresh(0));
        assert!(StoredTokens::from_exchange("opaque".into(), None, 10).expires_at > 10);
    }

    #[test]
    fn only_credential_verdicts_force_a_new_sign_in() {
        assert!(exchange_error(401, &[], "").reauth_required);
        let throttled = exchange_error(429, &[("retry-after".into(), "2".into())], "");
        assert!(!throttled.reauth_required);
        assert_eq!(throttled.retry_after, Some(Duration::from_secs(2)));
    }

    /// The refresh that outlives its timer reads as the real Node function did (`sites.cursorRefresh`).
    #[tokio::test(start_paused = true)]
    async fn an_exchange_that_outlives_its_timer_reads_as_nodes() {
        use crate::transport::site_probe::{TimingOut, assert_thrown, assert_transport};

        let transport = TimingOut::new();
        let error = exchange_token(transport.as_ref(), "r").await.expect_err("never answers");
        assert_transport("cursorRefresh", &transport);
        assert_thrown("cursorRefresh", &error.message);
    }
}
