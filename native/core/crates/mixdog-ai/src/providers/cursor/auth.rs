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

use super::Access;
use super::AccessToken;
use crate::oauth::CredentialFile;
use crate::oauth::Pace;
use crate::oauth::Probe;
use crate::oauth::lease::LockProcess;
use crate::oauth::lease::REFRESH_LEASE;
use crate::oauth::lease::lease_error;
use crate::oauth::lease::refresh_lock_path;
use crate::oauth::pace::SystemPace;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::provider_error;
use crate::retry::advice;
use crate::transport::http::HttpSend;
use crate::transport::link::Surface;

pub const EXCHANGE_URL: &str = "https://api2.cursor.sh/auth/exchange_user_api_key";
pub const OAUTH_REFRESH_URL: &str = "https://api2.cursor.sh/oauth/token";
pub const OAUTH_CLIENT_ID: &str = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
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
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
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
            expires_at: if expiry > 0 { expiry } else { now_ms + DEFAULT_TOKEN_LIFETIME.as_millis() as u64 },
            access_token,
            refresh_token,
            reauth_required: false,
        }
    }

    /// `CURSOR_ACCESS_TOKEN` as the tokens it stands in for (`loadStoredCredentials`): no refresh token, its own expiry.
    pub fn standing_in(token: String) -> Self {
        Self { expires_at: token_expiry(&token), access_token: token, refresh_token: None, reauth_required: false }
    }

    /// Whether the token must be exchanged before use at `now_ms`.
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at <= now_ms + REFRESH_SKEW.as_millis() as u64
    }

    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at <= now_ms
    }

    /// What a request is sent on with these tokens.
    fn access(&self) -> Access {
        Access::served_under(self.access_token.clone(), self.refresh_token.clone())
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
        ConnectFailure { code: code.to_owned(), message, http_status: Some(status), retry_after: advice::from_headers(headers, SystemTime::now()) },
        DeliveryState::Accepted,
    );
    error.reauth_required = permanent;
    error
}

/// A failed OAuth refresh on `/oauth/token`: only HTTP 400 and 401 are
/// permanent credential verdicts; 403, 429, 5xx, and network faults leave the
/// stored refresh token valid.
pub fn oauth_refresh_error(status: u16, headers: &[(String, String)], detail: &str) -> ProviderError {
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
    let permanent = matches!(status, 400 | 401);
    let mut message = format!("Cursor token refresh failed ({status})");
    if !detail.is_empty() {
        message.push_str(&format!(": {detail}"));
    }
    if permanent {
        message.push_str(&format!(". {REAUTH_GUIDANCE}"));
    }
    let mut error = provider_error(
        ConnectFailure { code: code.to_owned(), message, http_status: Some(status), retry_after: advice::from_headers(headers, SystemTime::now()) },
        DeliveryState::Accepted,
    );
    error.reauth_required = permanent;
    error
}

/// `cursor-api`: the configured API key, exchanged for access tokens that are
/// cached until their refresh skew.
pub struct ApiKeyAccess {
    http: std::sync::Arc<dyn HttpSend>,
    api_key: String,
    /// Where the key was read from: the account this key belongs to, the same when the key is replaced.
    slot: String,
    cached: ArcSwapOption<StoredTokens>,
    /// One exchange at a time; waiters adopt its result.
    exchanging: tokio::sync::Semaphore,
}

impl ApiKeyAccess {
    pub fn new(http: std::sync::Arc<dyn HttpSend>, api_key: String, slot: String) -> Self {
        Self { http, api_key, slot, cached: ArcSwapOption::empty(), exchanging: tokio::sync::Semaphore::new(1) }
    }

    fn fresh(&self) -> Option<String> {
        self.cached.load_full().filter(|t| !t.needs_refresh(now_ms())).map(|t| t.access_token.clone())
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

pub(crate) fn document(tokens: &StoredTokens) -> Result<serde_json::Map<String, Value>, ProviderError> {
    match serde_json::to_value(tokens) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(storage("tokens not serializable")),
    }
}

/// `cursor-oauth`: the signed-in account's tokens in `cursor-oauth.json`,
/// refreshed with the stored refresh token. The file is the one source of
/// truth: every call reads it. One refresh of an account runs at a time: in this
/// process every handle on the account's file shares it, and across processes it
/// runs holding the refresh lease beside that file, where a pair another refresher
/// stored first is taken instead of exchanging the old token again. A rotation is
/// published only over the pair that was exchanged.
pub struct FileAccess {
    http: std::sync::Arc<dyn HttpSend>,
    file: CredentialFile,
    /// The process as the refresh lease's lock protocol sees it, and the clock and waits of its attempts.
    process: std::sync::Arc<LockProcess>,
    pace: std::sync::Arc<dyn Pace>,
    /// `CURSOR_ACCESS_TOKEN`: stands in for the file (`loadStoredCredentials`), with no refresh token.
    env_token: Option<String>,
}

#[async_trait]
impl AccessToken for FileAccess {
    async fn access_token(&self) -> Result<Access, ProviderError> {
        let tokens = self.stored().await?;
        if !tokens.needs_refresh(now_ms()) {
            return Ok(tokens.access());
        }
        self.exchanged_from(tokens, false).await
    }

    async fn after_rejection(&self, rejected: &Access) -> Result<Access, ProviderError> {
        let tokens = self.stored().await?;
        // A login stored since the refused request was sent is used as it is.
        if tokens.access() != *rejected {
            return Ok(tokens.access());
        }
        self.exchanged_from(tokens, true).await
    }

    async fn renewed(&self) -> Result<Access, ProviderError> {
        // The one read of this decision: a sign-out or an unreadable file ends it here.
        let tokens = self.stored().await?;
        match self.exchanged_from(tokens, true).await {
            Ok(access) => Ok(access),
            // What the file holds after the failed exchange, as an ordinary send reads it: gone is the error.
            Err(_) => self.access_token().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use bytes::Bytes;

    use super::*;
    use crate::oauth::pace::Parked;
    use crate::transport::http::HttpResponse;
    use crate::transport::testing::Once;

    /// Answers every exchange after yielding, so concurrent callers overlap.
    struct Exchange {
        calls: AtomicUsize,
        status: u16,
    }

    #[async_trait]
    impl HttpSend for Exchange {
        async fn send(&self, _request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            let body = format!(r#"{{"accessToken":"{}","refreshToken":"r"}}"#, jwt(4_100_000_000));
            Ok(HttpResponse { status: self.status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
        }
    }

    #[tokio::test]
    async fn concurrent_callers_cause_one_exchange() {
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let access = std::sync::Arc::new(ApiKeyAccess::new(http.clone(), "key".into(), "env CURSOR_API_KEY (concurrent-callers test)".into()));
        let calls = (0..8).map(|_| {
            let access = access.clone();
            async move { access.access_token().await.unwrap().token }
        });
        let tokens = futures::future::join_all(calls).await;
        assert!(tokens.iter().all(|t| *t == tokens[0]));
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
        // A cached, fresh token needs no exchange.
        access.access_token().await.unwrap();
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    }

    /// Answers each exchange with a token of its own.
    struct Rotating(AtomicUsize);

    #[async_trait]
    impl HttpSend for Rotating {
        async fn send(&self, _request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            let n = self.0.fetch_add(1, Ordering::SeqCst) as u64;
            let body = format!(r#"{{"accessToken":"{}","refreshToken":"rotating-refresh-{n:04}"}}"#, jwt(4_200_000_000 + n));
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
        }
    }

    /// The exchange token of a key the user replaced is retired, not pinned for ever: after more retirements than the
    /// registry keeps, it is forgotten while the current one stays.
    #[tokio::test]
    async fn an_exchange_token_of_a_replaced_key_retires_instead_of_staying_pinned() {
        let http = std::sync::Arc::new(Rotating(AtomicUsize::new(0)));
        let mut seen = Vec::new();
        for n in 0..3 {
            let access = ApiKeyAccess::new(http.clone(), format!("rotating-api-key-{n}"), "env CURSOR_API_KEY".into());
            seen.push(access.access_token().await.unwrap().token);
        }
        for i in 0..=crate::oauth::carried::RETIRED_CAP {
            crate::oauth::carried::keep("file the-unrelated-account-of-the-cursor-test.json", &[&format!("cursor-test-unrelated-{i:05}")]);
        }
        let registry = crate::oauth::carried::registry();
        assert!(!registry.holds(&seen[0]) && !registry.holds(&seen[1]), "the replaced keys' exchange tokens were forgotten");
        assert!(registry.holds(&seen[2]), "the current one stays");
    }

    #[tokio::test]
    async fn a_failed_exchange_surfaces_even_when_the_key_looks_valid() {
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 401 });
        // The key is a JWT that has not expired: it is still not a fallback.
        let key = jwt(4_300_000_000);
        let access = ApiKeyAccess::new(http, key, "env CURSOR_API_KEY (failed-exchange test)".into());
        let error = access.access_token().await.unwrap_err();
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

    fn file_in(dir: &tempfile::TempDir) -> CredentialFile {
        use crate::oauth::CredentialIo;
        let rt = mixdog_rt::testing::tokens();
        CredentialFile::new(dir.path().join("cursor-oauth.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io })
    }
    /// `CURSOR_ACCESS_TOKEN` stands in for the file (`loadStoredCredentials`): it is served without any exchange.
    #[tokio::test]
    async fn the_environment_token_is_served_in_place_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let access = FileAccess::new(http.clone(), file_in(&dir)).with_env_token(Some(jwt(4_000_000_000)));
        assert_eq!(access.access_token().await.unwrap().token, jwt(4_000_000_000));
        assert_eq!(http.calls.load(Ordering::SeqCst), 0);
    }
    /// A send goes out on one stored pair, another is stored (already past its expiry), and the first send is then
    /// refused. The refusal is of the pair that send carried: the one stored now is used as it is, with nothing exchanged
    /// on the old send's behalf. Once the pair stored now was itself sent and refused, it is exchanged.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
    async fn a_refusal_does_not_exchange_a_pair_stored_since_its_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let file = file_in(&dir);
        let pair = |access: &str, refresh: &str| format!(r#"{{"access_token":"{access}","refresh_token":"{refresh}"}}"#);
        std::fs::write(file.path(), pair(&jwt(4_000_000_000), "r0")).unwrap();
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let access = FileAccess::new(http.clone(), file.clone());
        let sent = access.access_token().await.unwrap();
        // The same bearer under another refresh token is another pair, as one whose tokens both changed is.
        for stored in [pair(&jwt(4_000_000_000), "r9"), pair(&jwt(1), "r9")] {
            std::fs::write(file.path(), &stored).unwrap();
            let next = access.after_rejection(&sent).await.unwrap();
            assert!(stored.contains(&next.token), "the pair stored now, as it is");
            assert_eq!(http.calls.load(Ordering::SeqCst), 0, "the new pair was exchanged for the old attempt");
            assert_eq!(std::fs::read_to_string(file.path()).unwrap(), stored);
        }
        let stored = access.access_token().await;
        assert_eq!(http.calls.load(Ordering::SeqCst), 1, "the expired pair takes its own refresh on its own send");
        let renewed = access.after_rejection(&stored.unwrap()).await.unwrap();
        assert_eq!(renewed.token, jwt(4_100_000_000));
        assert_eq!(http.calls.load(Ordering::SeqCst), 2, "a refused attempt on the pair stored now exchanges it");
    }

    /// Two requests go out on one exchanged token and both are refused. The first refusal exchanges the key again; the
    /// second is of a token no longer held, so the one exchanged since is used as it is.
    #[tokio::test]
    async fn a_refusal_of_a_token_exchanged_away_does_not_exchange_the_key_again() {
        let http = std::sync::Arc::new(Rotating(AtomicUsize::new(0)));
        let access = ApiKeyAccess::new(http.clone(), "key".into(), "env CURSOR_API_KEY (stale-refusal test)".into());
        let sent = access.access_token().await.unwrap();
        let renewed = access.after_rejection(&sent).await.unwrap();
        assert_ne!(renewed.token, sent.token);
        assert_eq!(http.0.load(Ordering::SeqCst), 2);
        let late = access.after_rejection(&sent).await.unwrap();
        assert_eq!(late.token, renewed.token);
        assert_eq!(http.0.load(Ordering::SeqCst), 2, "the stale refusal exchanged the key again");
    }

    /// With another account selected (`boundProviderAuthPath` names its file) the environment token is not used: the
    /// selected account's own file is read, and it is absent here.
    #[tokio::test]
    async fn a_selected_account_does_not_send_with_the_environment_token() {
        let dir = tempfile::tempdir().unwrap();
        let other = dir.path().join("provider-accounts").join("cursor-oauth").join("a2.json");
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let file = file_in(&dir).following(std::sync::Arc::new(move || {
            let other = other.clone();
            Box::pin(async move { other })
        }));
        let access = FileAccess::new(http, file).with_env_token(Some(jwt(4_000_000_000)));
        let error = access.access_token().await.expect_err("the selected account is not signed in");
        assert!(error.reauth_required);
    }
    /// A stored document without `expires_at` expires with its token's `exp` claim (`cursorTokenExpiry`).
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
    async fn a_file_without_an_expiry_expires_with_its_token() {
        let dir = tempfile::tempdir().unwrap();
        let file = file_in(&dir);
        std::fs::write(file.path(), format!(r#"{{"access_token":"{}","refresh_token":"r0"}}"#, jwt(1))).unwrap();
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let access = FileAccess::new(http.clone(), file);
        assert_eq!(access.access_token().await.unwrap().token, jwt(4_100_000_000));
        assert_eq!(http.calls.load(Ordering::SeqCst), 1);
    }

    /// A token endpoint that counts each exchange, announces it and answers it once the test lets it through.
    struct GatedExchange {
        calls: AtomicUsize,
        arrived: tokio::sync::Semaphore,
        gate: tokio::sync::Semaphore,
        body: String,
    }

    #[async_trait]
    impl HttpSend for GatedExchange {
        async fn send(&self, _request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.arrived.add_permits(1);
            self.gate.acquire().await.expect("an open gate").forget();
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(self.body.clone())))) })
        }
    }

    /// Two handles of one account (one following the selected account to its file, one bound to that file) find its
    /// pair expired at once: the second joins the exchange the first started, so the refresh token is spent once. The
    /// pair that exchange answers is itself due for renewal, so a handle that ran a refresh of its own would exchange
    /// again.
    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
    async fn two_handles_of_one_account_refreshing_at_once_exchange_once() {
        use crate::oauth::CredentialIo;

        let dir = tempfile::tempdir().unwrap();
        let account = dir.path().join("selected.json");
        std::fs::write(&account, format!(r#"{{"access_token":"{}","refresh_token":"r1"}}"#, jwt(1))).unwrap();
        let rt = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: rt.interactive_io, write: rt.durability_io };
        let selected = account.clone();
        let following = CredentialFile::new(dir.path().join("cursor-oauth.json"), io).following(std::sync::Arc::new(move || {
            let selected = selected.clone();
            Box::pin(async move { selected })
        }));
        let http = std::sync::Arc::new(GatedExchange {
            calls: AtomicUsize::new(0),
            arrived: tokio::sync::Semaphore::new(0),
            gate: tokio::sync::Semaphore::new(0),
            body: format!(r#"{{"accessToken":"{}","refreshToken":"r2"}}"#, jwt(now_ms() / 1000 + 60)),
        });
        let first = FileAccess::new(http.clone(), following);
        let second = FileAccess::new(http.clone(), CredentialFile::new(account, io));
        let held = second.stored().await.unwrap();
        let leading = tokio::spawn(async move { first.access_token().await.map(|access| access.token) });
        http.arrived.acquire().await.unwrap().forget();
        let mut joining = std::pin::pin!(second.refresh(held, false));
        assert!(futures::poll!(joining.as_mut()).is_pending(), "the second handle's refresh waits");
        http.gate.add_permits(2);
        let joined = joining.await.unwrap();
        assert_eq!(leading.await.unwrap().unwrap(), joined.access_token);
        assert_eq!(http.calls.load(Ordering::SeqCst), 1, "the refresh token was exchanged twice");
    }

    /// Another process holds the refresh lease of the account's file when this one finds its pair expired: this one
    /// waits for the lease, and under it takes the pair the other stored, exchanging nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::disallowed_methods, reason = "test: writes fixture credential files synchronously")]
    async fn a_refresh_waits_for_another_processs_lease_and_takes_the_pair_it_stored() {
        let dir = tempfile::tempdir().unwrap();
        let file = file_in(&dir);
        std::fs::write(file.path(), format!(r#"{{"access_token":"{}","refresh_token":"r1"}}"#, jwt(1))).unwrap();
        let (taken, release) = (std::sync::Arc::new(tokio::sync::Semaphore::new(0)), std::sync::Arc::new(tokio::sync::Semaphore::new(0)));
        let holding = tokio::spawn({
            let (file, taken, release) = (file.clone(), taken.clone(), release.clone());
            async move {
                let other = LockProcess::new(mixdog_statefile::LockOwner::another_in_process());
                let held = async move {
                    taken.add_permits(1);
                    release.acquire().await.expect("an open gate").forget();
                };
                file.lease(&refresh_lock_path(file.path()), &other, &SystemPace, REFRESH_LEASE, held).await.is_ok()
            }
        });
        taken.acquire().await.unwrap().forget();
        let http = std::sync::Arc::new(Exchange { calls: AtomicUsize::new(0), status: 200 });
        let parked = std::sync::Arc::new(Parked::new());
        let mut access = FileAccess::new(http.clone(), file.clone());
        let pace: std::sync::Arc<dyn Pace> = parked.clone();
        access.pace = pace;
        let mut refreshing = tokio::spawn(async move { access.access_token().await.map(|access| access.token) });
        let waited = tokio::select! {
            _ = parked.waiting.acquire() => true,
            _ = &mut refreshing => false,
        };
        assert!(waited, "the refresh went ahead while another process held the lease");
        let stored_since = jwt(4_200_000_000);
        std::fs::write(file.path(), format!(r#"{{"access_token":"{stored_since}","refresh_token":"r2"}}"#)).unwrap();
        release.add_permits(1);
        parked.go.add_permits(1_000);
        assert!(holding.await.unwrap());
        assert_eq!(refreshing.await.unwrap().unwrap(), stored_since);
        assert_eq!(http.calls.load(Ordering::SeqCst), 0, "the refresh token the other process renewed was exchanged again");
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

    struct CaptureHttp {
        requests: std::sync::Mutex<Vec<WireRequest>>,
        responses: std::sync::Mutex<std::collections::VecDeque<(u16, String)>>,
    }

    impl CaptureHttp {
        fn new(responses: Vec<(u16, String)>) -> std::sync::Arc<Self> {
            std::sync::Arc::new(Self { requests: std::sync::Mutex::new(Vec::new()), responses: std::sync::Mutex::new(responses.into()) })
        }
    }

    #[async_trait]
    impl HttpSend for CaptureHttp {
        async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.requests.lock().unwrap().push(request);
            let (status, body) = self.responses.lock().unwrap().pop_front().unwrap_or((500, String::new()));
            Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from(body)))) })
        }
    }

    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes fixture credential files synchronously")]
    async fn file_access_uses_oauth_token_endpoint_and_api_key_keeps_exchange_url() {
        let dir = tempfile::tempdir().unwrap();
        let file = file_in(&dir);
        std::fs::write(file.path(), format!(r#"{{"access_token":"{}","refresh_token":"r-orig"}}"#, jwt(1))).unwrap();

        let next_jwt_1 = jwt(4_100_000_000);
        let next_jwt_2 = jwt(4_200_000_000);
        let api_jwt = jwt(4_300_000_000);
        let http = CaptureHttp::new(vec![
            // OAuth refresh omitting refresh_token preserves r-orig.
            (200, format!(r#"{{"access_token":"{next_jwt_1}"}}"#)),
            // OAuth refresh returning rotated refresh_token updates it.
            (200, format!(r#"{{"access_token":"{next_jwt_2}","refresh_token":"r-new"}}"#)),
            // ApiKeyAccess continues to use EXCHANGE_URL.
            (200, format!(r#"{{"accessToken":"{api_jwt}","refreshToken":"api-r"}}"#)),
        ]);

        let file_access = FileAccess::new(http.clone(), file.clone());
        let first = file_access.access_token().await.expect("first refresh");
        assert_eq!(first.token, next_jwt_1);
        let stored_after_first: StoredTokens = serde_json::from_str(&std::fs::read_to_string(file.path()).unwrap()).unwrap();
        assert_eq!(stored_after_first.refresh_token.as_deref(), Some("r-orig"));

        let second = file_access.after_rejection(&first).await.expect("second refresh");
        assert_eq!(second.token, next_jwt_2);
        let stored_after_second: StoredTokens = serde_json::from_str(&std::fs::read_to_string(file.path()).unwrap()).unwrap();
        assert_eq!(stored_after_second.refresh_token.as_deref(), Some("r-new"));

        let api_access = ApiKeyAccess::new(http.clone(), "api-key-val".into(), "env CURSOR_API_KEY (oauth-endpoint test)".into());
        assert_eq!(api_access.access_token().await.expect("api exchange").token, api_jwt);

        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].url, OAUTH_REFRESH_URL);
        let body0: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body0["grant_type"], "refresh_token");
        assert_eq!(body0["client_id"], OAUTH_CLIENT_ID);
        assert_eq!(body0["refresh_token"], "r-orig");
        assert_eq!(requests[1].url, OAUTH_REFRESH_URL);
        assert_eq!(requests[2].url, EXCHANGE_URL);
    }

    #[tokio::test]
    #[allow(clippy::disallowed_methods, reason = "test: writes fixture credential files synchronously")]
    async fn oauth_refresh_reauth_verdicts_for_should_logout_400_401_vs_403_429_5xx() {
        // Permanent verdicts: shouldLogout=true, 400, 401 -> reauth_required=true and file marked dead.
        for (status, body) in [(200, r#"{"shouldLogout":true,"access_token":""}"#), (400, r#"{"error":"invalid_grant"}"#), (401, r#"{"error":"unauthorized"}"#)]
        {
            let dir = tempfile::tempdir().unwrap();
            let file = file_in(&dir);
            std::fs::write(file.path(), format!(r#"{{"access_token":"{}","refresh_token":"r-dead"}}"#, jwt(1))).unwrap();
            let http = CaptureHttp::new(vec![(status, body.to_owned())]);
            let access = FileAccess::new(http, file.clone());
            let err = access.access_token().await.expect_err("permanent refusal");
            assert!(err.reauth_required, "status={status} body={body}");
            let stored: StoredTokens = serde_json::from_str(&std::fs::read_to_string(file.path()).unwrap()).unwrap();
            assert!(stored.reauth_required, "credential marked dead for status={status}");
        }

        // Transient verdicts: 403, 429, 500, 503 -> reauth_required=false and file stays usable.
        for status in [403, 429, 500, 503] {
            let dir = tempfile::tempdir().unwrap();
            let file = file_in(&dir);
            std::fs::write(file.path(), format!(r#"{{"access_token":"{}","refresh_token":"r-keep"}}"#, jwt(1))).unwrap();
            let http = CaptureHttp::new(vec![(status, "temporary error".to_owned())]);
            let access = FileAccess::new(http, file.clone());
            let err = access.access_token().await.expect_err("transient failure");
            assert!(!err.reauth_required, "status={status} must stay transient");
            let stored: StoredTokens = serde_json::from_str(&std::fs::read_to_string(file.path()).unwrap()).unwrap();
            assert!(!stored.reauth_required, "status={status} must not mark credential dead");
        }
    }
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
    let refresh = data.get("refreshToken").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(token);
    Ok(StoredTokens::from_exchange(access.to_owned(), Some(refresh.to_owned()), now_ms()))
}

/// One OAuth token refresh on `/oauth/token` for `cursor-oauth` refresh tokens.
pub async fn refresh_oauth_token(http: &dyn HttpSend, refresh_token: &str) -> Result<StoredTokens, ProviderError> {
    let body = serde_json::to_vec(&serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    }))
    .map_err(|_| storage("refresh request not serializable"))?;
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: OAUTH_REFRESH_URL.to_owned(),
                headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
                body,
            },
            CURSOR_EXCHANGE,
        )
        .await?;
    let success = head.is_success();
    let response = head.read_all().await?;
    if !success {
        let detail = crate::oauth::scrub::scrub_oauth_secrets(&String::from_utf8_lossy(&response.body), &[refresh_token]).trim().to_owned();
        return Err(oauth_refresh_error(response.status.unwrap_or(0), &response.headers, &detail));
    }
    let data: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if data.get("shouldLogout").and_then(Value::as_bool) == Some(true) {
        let mut error = reauth("Cursor ended this session.");
        error.code = Some("invalid_grant".to_owned());
        error.status = Some(401);
        return Err(error);
    }
    let Some(access) = data.get("access_token").or_else(|| data.get("accessToken")).and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
        error.message = "Cursor token refresh returned no access token".to_owned();
        return Err(error);
    };
    let refresh = data.get("refresh_token").or_else(|| data.get("refreshToken")).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(refresh_token);
    Ok(StoredTokens::from_exchange(access.to_owned(), Some(refresh.to_owned()), now_ms()))
}
#[async_trait]
impl AccessToken for ApiKeyAccess {
    async fn access_token(&self) -> Result<Access, ProviderError> {
        self.exchanged(None).await.map(Access::plain)
    }

    async fn after_rejection(&self, rejected: &Access) -> Result<Access, ProviderError> {
        self.exchanged(Some(&rejected.token)).await.map(Access::plain)
    }

    async fn renewed(&self) -> Result<Access, ProviderError> {
        let held = self.cached.load_full().map(|t| t.access_token.clone()).unwrap_or_default();
        match self.exchanged(Some(&held)).await {
            Ok(token) => Ok(Access::plain(token)),
            Err(_) => self.access_token().await,
        }
    }
}

impl ApiKeyAccess {
    /// The cached token while it is fresh, else a new one. `rejected` is the token a refused request was sent on: the
    /// key is exchanged again while that is still the one cached, and a token exchanged since is used as it is.
    async fn exchanged(&self, rejected: Option<&str>) -> Result<String, ProviderError> {
        if rejected.is_none()
            && let Some(access) = self.fresh()
        {
            return Ok(access);
        }
        let _gate = self.exchanging.acquire().await.map_err(|_| storage("exchange gate closed"))?;
        let held = match rejected {
            None => self.fresh(),
            Some(refused) => self.cached.load_full().map(|t| t.access_token.clone()).filter(|held| held != refused),
        };
        if let Some(access) = held {
            return Ok(access);
        }
        let tokens = exchange_token(self.http.as_ref(), &self.api_key).await?;
        // The exchanged token is a credential before any request carries it; the key's next one replaces it.
        crate::oauth::carried::keep(
            &crate::oauth::carried::derived_source("cursor exchange", &self.slot),
            &[&tokens.access_token, tokens.refresh_token.as_deref().unwrap_or_default()],
        );
        let access = tokens.access_token.clone();
        self.cached.store(Some(std::sync::Arc::new(tokens)));
        Ok(access)
    }
}
impl FileAccess {
    pub fn new(http: std::sync::Arc<dyn HttpSend>, file: CredentialFile) -> Self {
        Self { http, file, process: LockProcess::this_process(), pace: std::sync::Arc::new(SystemPace), env_token: None }
    }

    pub fn with_env_token(mut self, token: Option<String>) -> Self {
        self.env_token = token.filter(|t| !t.is_empty());
        self
    }

    async fn stored(&self) -> Result<StoredTokens, ProviderError> {
        // Only where Node read it: no account bound (`!boundProviderAuthPath('cursor-oauth')`, cursor-auth.mjs:100).
        if let Some(token) = &self.env_token
            && self.file.is_own_now().await
        {
            return Ok(StoredTokens::standing_in(token.clone()));
        }
        stored_in(&self.file).await
    }

    /// `tokens` exchanged for new ones; without a refresh token they serve until they expire.
    async fn exchanged_from(&self, tokens: StoredTokens, force: bool) -> Result<Access, ProviderError> {
        if tokens.refresh_token.is_none() {
            if !tokens.is_expired(now_ms()) {
                return Ok(tokens.access());
            }
            return Err(reauth("Cursor access token expired and has no refresh token."));
        }
        Ok(self.refresh(tokens, force).await?.access())
    }

    /// `force` is the refresh behind a refused attempt, which was sent on `old`: a pair stored since is that attempt's
    /// answer as it is, never exchanged on its behalf. Callers holding `old`'s refresh token share the refresh running
    /// for the account's file this handle reads now, made on that file pinned.
    async fn refresh(&self, old: StoredTokens, force: bool) -> Result<StoredTokens, ProviderError> {
        let held = old.refresh_token.clone().unwrap_or_default();
        let (http, process, pace) = (self.http.clone(), self.process.clone(), self.pace.clone());
        self.file
            .refresh_once(&held, move |file| refresh_leased(http, file, process, pace, old, force))
            .await
            .unwrap_or_else(|lost| Err(lost.provider_error(DeliveryState::Ambiguous, Surface::Socket)))
    }
}

/// The tokens `file` holds, as every send reads them.
async fn stored_in(file: &CredentialFile) -> Result<StoredTokens, ProviderError> {
    match file.load::<StoredTokens>().await {
        // The service refused this sign-in and its renewal: nothing is sent on it until the user signs in again.
        Probe::Present(tokens) if tokens.reauth_required => {
            let mut error = reauth("Cursor refused this sign-in.");
            error.status = Some(401);
            Err(error)
        }
        Probe::Present(mut tokens) => {
            file.keep(&[&tokens.access_token, tokens.refresh_token.as_deref().unwrap_or_default()]);
            // `Number(raw.expires_at) || cursorTokenExpiry(raw.access_token)`: a file that records no expiry
            // still expires when its token's own claim says so.
            if tokens.expires_at == 0 {
                tokens.expires_at = token_expiry(&tokens.access_token);
            }
            Ok(tokens)
        }
        Probe::Absent => Err(reauth("Cursor OAuth is not connected.")),
        Probe::Unreadable => Err(storage("the credential file cannot be read")),
    }
}

/// Records that the refresh token was refused, unless another process has
/// replaced it since. The tokens stay; a new sign-in clears the marker.
async fn mark_dead(file: &CredentialFile, refresh_token: &str, status: u16) {
    let expected = refresh_token.to_owned();
    let mut update = serde_json::Map::new();
    update.insert("reauth_required".to_owned(), Value::Bool(true));
    if let Ok(true) = file.replace_if(move |doc| doc.get("refresh_token").and_then(Value::as_str) == Some(expected.as_str()), update).await {
        file.note_marked_reauth("cursor-oauth", status).await;
    }
}

/// The refresh of the account's tokens in `file` (pinned), holding the cross-process refresh lease beside it: another
/// process (or another handle in this one) that refreshes first has stored its pair before this one reads the file.
async fn refresh_leased(
    http: std::sync::Arc<dyn HttpSend>,
    file: CredentialFile,
    process: std::sync::Arc<LockProcess>,
    pace: std::sync::Arc<dyn Pace>,
    old: StoredTokens,
    force: bool,
) -> Result<StoredTokens, ProviderError> {
    let lock = refresh_lock_path(file.path());
    file.lease(&lock, &process, &*pace, REFRESH_LEASE, exchange_stored(http.as_ref(), &file, old, force)).await.map_err(lease_error)?
}

/// Under the lease the file is read again: a pair stored since `old` is taken as it is while it is still good (and for
/// a refused attempt on `old` always); otherwise the stored refresh token is exchanged.
async fn exchange_stored(http: &dyn HttpSend, file: &CredentialFile, old: StoredTokens, force: bool) -> Result<StoredTokens, ProviderError> {
    let latest = stored_in(file).await?;
    let rotated = latest.access_token != old.access_token || latest.refresh_token != old.refresh_token;
    let valid_after = now_ms() + REFRESH_SKEW.as_millis() as u64;
    if rotated && (force || latest.expires_at == 0 || latest.expires_at > valid_after) {
        return Ok(latest);
    }
    let Some(refresh_token) = latest.refresh_token.clone() else {
        return Err(reauth("Cursor OAuth refresh token is unavailable."));
    };
    let next = match refresh_oauth_token(http, &refresh_token).await {
        Ok(next) => next,
        Err(error) => {
            if error.reauth_required {
                mark_dead(file, &refresh_token, error.status.unwrap_or(0)).await;
            }
            return Err(error);
        }
    };
    file.keep(&[&next.access_token, next.refresh_token.as_deref().unwrap_or(&refresh_token)]);
    let (access, refresh) = (latest.access_token.clone(), refresh_token);
    let published = file
        .replace_if(
            move |doc| {
                doc.get("access_token").and_then(Value::as_str) == Some(access.as_str())
                    && doc.get("refresh_token").and_then(Value::as_str) == Some(refresh.as_str())
            },
            document(&next)?,
        )
        .await
        .map_err(|_| storage("the refreshed tokens could not be stored"))?;
    if published { Ok(next) } else { stored_in(file).await }
}
