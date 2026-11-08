//! The production ports under [`OAuthUsage`]: the usage endpoints' HTTP over the routed
//! [`HttpSend`], the Grok CLI version headers, and the per-account credential of the providers whose
//! usage endpoints need a token (`providerObj.ensureAuth` of `fetchOAuthUsageSnapshot`).
//!
//! The quota history port lives with the ledger (`mixdog-core`'s `run_host/quota_history.rs`).
//!
//! Not here: the `getUsageSnapshot()` of cursor-api, whose key is configuration, not an account
//! credential file. [`ProviderUsageSource`] answers it with an error (the measurement then reads as
//! nothing, as Node's does when the provider call fails).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use mixdog_js::js_trim;
use mixdog_js::slice_utf16;

use super::oauth_usage::GrokClient;
use super::oauth_usage::UsageError;
use super::oauth_usage::UsageHttp;
use super::oauth_usage::UsageResponse;
use super::oauth_usage::UsageSource;
use super::oauth_usage::now_ms;
use super::usage_antigravity;
use super::usage_command_code;
use super::usage_cursor;
use super::usage_muse_code;
use super::usage_opencode_go;
use sha2::Digest;
use sha2::Sha256;
use crate::oauth::Probe;
use crate::oauth::scrub::scrub_oauth_secrets;
use crate::oauth::Pace;
use crate::oauth::SystemPace;
use crate::providers::compat::creds::CommandCodeCredentials;
use crate::providers::cursor::auth::FileAccess as CursorAccess;
use crate::providers::google::auth::RequestAuth as _;
use crate::providers::google::auth::antigravity::AntigravityAuth;
use crate::providers::google::auth::antigravity::FileTokenStore;
use crate::providers::google::auth::antigravity::VERSION_FALLBACK as ANTIGRAVITY_VERSION_FALLBACK;
use crate::providers::compat::creds::MuseCodeCredentials;
use crate::providers::compat::creds::OpenCodeGoCredentials;
use crate::providers::compat::login::opencode_go::OpenCodeGoAuth;
use crate::providers::compat::login::opencode_go::RefreshError;
use crate::accounts::AccountStore;
use crate::client_versions::ClientVersions;
use crate::client_versions::Dialect;
use crate::oauth::CredentialFile;
use crate::providers::anthropic::OAuthSession;
use crate::providers::grok::auth::GrokCredential;
use crate::providers::openai::adapter::CredentialSource;
use crate::providers::openai::oauth::OpenAiOAuth;
use crate::providers::connect::rewrite::Credential as _;
use crate::transport::Exchange;
use crate::transport::FETCH_FAILED;
use crate::transport::Redirect;
use crate::transport::Surface;
use crate::transport::http::HttpSend;
use mixdog_rt::Liveness;

/// [`UsageHttp`] over the routed link. The exchange is Node's `fetchOptions`: a redirect is a network
/// error (`redirect: 'error'`) and the timeout covers the head and the body (`AbortSignal.timeout`),
/// both enforced by the transport.
pub struct RoutedUsageHttp {
    http: Arc<dyn HttpSend>,
    redirect: Redirect,
    surface: Surface,
}

impl RoutedUsageHttp {
    pub fn new(http: Arc<dyn HttpSend>) -> Self {
        Self { http, redirect: Redirect::Error, surface: Surface::FetchSignal }
    }

    /// The same, but redirects are followed and the deadline is an `AbortController`, as the bare `fetch` of
    /// `api-usage.mjs` does; its abort reads differently from `AbortSignal.timeout`.
    pub fn following(http: Arc<dyn HttpSend>) -> Self {
        Self { http, redirect: Redirect::Follow, surface: Surface::FetchAborted }
    }

    /// Redirects are an error and the deadline is an `AbortController` (OpenCode Go's status read).
    pub fn aborting(http: Arc<dyn HttpSend>) -> Self {
        Self { http, redirect: Redirect::Error, surface: Surface::FetchAborted }
    }

    async fn exchange(&self, method: &str, url: &str, headers: &[(String, String)], body: Vec<u8>, timeout: Duration) -> Result<UsageResponse, UsageError> {
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: method.to_owned(),
            url: url.to_owned(),
            headers: headers.to_vec(),
            body,
        };
        let exchange = Exchange::new(Liveness::unary(timeout), self.redirect, self.surface);
        let failed = |error: ProviderError| {
            // A transport fault already carries the call site's Node text (`fetch failed`, or the
            // `AbortSignal.timeout` message); a refusal before any transport (a route the proxy policy
            // could not decide) reads as Node's `fetch failed`.
            UsageError::new(if error.transport.is_some() { error.message } else { FETCH_FAILED.to_owned() })
        };
        let head = self.http.send(request, exchange).await.map_err(failed)?;
        let status = head.status;
        let whole = head.read_all().await.map_err(failed)?;
        Ok(UsageResponse { status, body: String::from_utf8_lossy(&whole.body).into_owned() })    }
}

#[async_trait]
impl UsageHttp for RoutedUsageHttp {
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<UsageResponse, UsageError> {
        self.exchange("GET", url, headers, Vec::new(), timeout).await
    }

    async fn post_json(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration) -> Result<UsageResponse, UsageError> {
        // `JSON.stringify(body)`: compact, in insertion order.
        let bytes = serde_json::to_vec(body).map_err(|e| UsageError::new(e.to_string()))?;
        self.exchange("POST", url, headers, bytes, timeout).await
    }
}

/// [`GrokClient`] over the process's client versions (`grok-client-version.mjs`): the version is
/// read at every call, so a minimum learned from a 426 reaches the next request.
pub struct GrokVersionHeaders {
    versions: Arc<ClientVersions>,
}

impl GrokVersionHeaders {
    pub fn new(versions: Arc<ClientVersions>) -> Self {
        Self { versions }
    }
}

#[async_trait]
impl GrokClient for GrokVersionHeaders {
    async fn warm(&self) {
        self.versions.warm(Dialect::Grok).await;
    }

    /// `grokClientVersionHeaders()`.
    fn headers(&self) -> Vec<(String, String)> {
        let version = self.versions.grok();
        vec![("x-grok-client-version".to_owned(), version.clone()), ("User-Agent".to_owned(), format!("xai-grok-build/{version}"))]
    }
}

fn failure(error: ProviderError) -> UsageError {
    UsageError { status: error.status, message: error.message }
}

#[derive(Clone)]
enum Held {
    OpenAi(Arc<OpenAiOAuth>),
    Anthropic(Arc<OAuthSession>),
    Grok(Arc<GrokCredential>),
    OpenCode(Arc<OpenCodeGoAuth>),
    Antigravity(Arc<AntigravityAuth>),
    Cursor(Arc<CursorAccess>),
}

/// [`UsageSource`] over the account store: each account's credential file, one credential object per
/// (provider, account) so a refresh in flight is shared by the readings that wait on it.
pub struct ProviderUsageSource {
    accounts: AccountStore,
    http: Arc<dyn HttpSend>,
    held: Mutex<HashMap<(String, String), Held>>,
    pace: Arc<dyn Pace>,
    /// The cooldown and last good reading of each Muse Code account (`_usageFailure`, `_usageLastGood`).
    muse: Mutex<HashMap<String, MuseState>>,
    /// `Math.random()`: spreads the cooldown by ± 25 % so accounts do not retry in lockstep.
    jitter: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// The client versions the Antigravity hub identity is built from (`ensureAntigravityVersion`).
    versions: Option<Arc<ClientVersions>>,
}

struct MuseFailure {
    identity: String,
    until: f64,
    error: Option<UsageError>,
}

#[derive(Default)]
struct MuseState {
    failure: Option<MuseFailure>,
    last_good: Option<(String, Value)>,
}

impl ProviderUsageSource {
    pub fn new(accounts: AccountStore, http: Arc<dyn HttpSend>) -> Self {
        Self::with_pace(accounts, http, Arc::new(SystemPace))
    }

    /// The clock the OpenCode Go token expiry is judged by.
    pub fn with_pace(accounts: AccountStore, http: Arc<dyn HttpSend>, pace: Arc<dyn Pace>) -> Self {
        Self { accounts, http, held: Mutex::new(HashMap::new()), pace, muse: Mutex::new(HashMap::new()), jitter: Arc::new(|| rand::random::<f64>()), versions: None }
    }

    /// The process's client versions: Antigravity's requests carry the hub version they discover
    /// (without them, the pinned fallback).
    pub fn with_versions(mut self, versions: Arc<ClientVersions>) -> Self {
        self.versions = Some(versions);
        self
    }

    /// The source of the cooldown's jitter (a number in [0, 1)).
    pub fn with_jitter(mut self, jitter: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        self.jitter = jitter;
        self
    }

    fn file(&self, provider: &str, account_id: &str) -> Result<CredentialFile, UsageError> {
        self.accounts.credential_file(provider, account_id).map_err(|e| UsageError::new(e.to_string()))
    }

    fn held(&self, provider: &str, account_id: &str) -> Result<Option<Held>, UsageError> {
        let key = (provider.to_owned(), account_id.to_owned());
        if let Some(known) = self.held.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return Ok(Some(known.clone()));
        }
        let made = match provider {
            "openai-oauth" => Held::OpenAi(Arc::new(OpenAiOAuth::new(self.file(provider, account_id)?, self.http.clone()))),
            "anthropic-oauth" => Held::Anthropic(Arc::new(OAuthSession::new(self.file(provider, account_id)?, self.http.clone()))),
            "grok-oauth" => Held::Grok(Arc::new(GrokCredential::new(self.http.clone(), self.file(provider, account_id)?))),
            usage_antigravity::PROVIDER_ID => {
                let pace = self.pace.clone();
                Held::Antigravity(Arc::new(AntigravityAuth::new(self.http.clone(), Arc::new(FileTokenStore(self.file(provider, account_id)?)), Box::new(move || pace.now_ms()))))
            }
            usage_cursor::PROVIDER_ID => Held::Cursor(Arc::new(CursorAccess::new(self.http.clone(), self.file(provider, account_id)?))),
            usage_opencode_go::PROVIDER_ID => Held::OpenCode(Arc::new(OpenCodeGoAuth::new(self.http.clone(), self.pace.clone(), self.file(provider, account_id)?))),
            _ => return Ok(None),
        };
        // Two builders racing keep the first: both read the same file.
        Ok(Some(self.held.lock().unwrap_or_else(PoisonError::into_inner).entry(key).or_insert(made).clone()))
    }
}

/// `ensureAuth()` of the command-code provider: no file, an unreadable one or a blank key.
const COMMAND_CODE_SIGNED_OUT: &str = "[command-code-oauth] credentials not found — open /providers in mixdog to sign in first";

/// `ensureAuth()` of the Muse Code provider: no file, an unreadable one, or a pair with a blank token.
const MUSE_SIGNED_OUT: &str = "[muse-code-oauth] credentials not found — open /providers in mixdog to sign in first";

/// `reauthError(detail, status)` of `muse-code-oauth.mjs`.
fn muse_reauth(detail: &str, status: u16) -> UsageError {
    UsageError { status: Some(status), message: format!("[muse-code-oauth] {detail} — open /providers in mixdog to sign in again") }
}

/// `ensureAuth()` of the OpenCode Go provider: no file, an unreadable one, or a pair with a blank token.
const OPENCODE_SIGNED_OUT: &str = "[opencode-go-oauth] credentials not found — open /providers in mixdog to sign in first";

/// `openCodeGoReauthError(detail, status)`.
fn opencode_reauth(detail: &str, status: u16) -> UsageError {
    let shown = if detail.is_empty() { String::new() } else { format!(" ({detail})") };
    UsageError { status: Some(status), message: format!("[opencode-go-oauth] invalid_grant: OpenCode sign-in expired{shown} — open /providers in mixdog to sign in again") }
}

fn opencode_failure(error: RefreshError) -> UsageError {
    match error {
        RefreshError::Reauth(detail, status) => opencode_reauth(&detail, status),
        RefreshError::Failed(message, status) => UsageError { status, message: format!("[opencode-go-oauth] {message}") },
    }
}

/// The identity fields Node reads with `text()`: trimmed, empty when absent.
fn identity(value: Option<&str>) -> &str {
    value.map_or("", js_trim)
}

impl ProviderUsageSource {
    /// `getUsageSnapshot()` of antigravity-oauth: `retrieveUserQuotaSummary` with the stored access
    /// token (refreshed when it is about to expire), as the hub client.
    async fn antigravity_snapshot(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        let version = match &self.versions {
            Some(versions) => {
                versions.warm(Dialect::Antigravity).await;
                versions.antigravity()
            }
            None => ANTIGRAVITY_VERSION_FALLBACK.to_owned(),
        };
        let Some(Held::Antigravity(auth)) = self.held(usage_antigravity::PROVIDER_ID, account_id)? else { unreachable!("the provider is held") };
        // `ensureAccessToken` throws a plain `Error` (no status) when nothing is signed in. The turn path's auth types
        // that same failure as a 401 re-auth, so the usage read tells it apart by asking for the sign-in first.
        auth.current().await.map_err(|error| UsageError::new(format!("[antigravity-oauth] {}", error.message)))?;
        let authorization = auth.authorize().await.map_err(|error| UsageError { status: error.status, message: format!("[antigravity-oauth] {}", error.message) })?;
        let bearer = authorization.headers.into_iter().find(|(name, _)| name == "authorization").map(|(_, value)| value).unwrap_or_default();
        let headers = vec![
            ("Authorization".to_owned(), bearer),
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("User-Agent".to_owned(), usage_antigravity::user_agent(&version)),
        ];
        let body = if authorization.identity.is_empty() { json!({}) } else { json!({ "project": authorization.identity }) };
        let timeout = Duration::from_millis(usage_antigravity::REQUEST_TIMEOUT_MS);
        let reply = RoutedUsageHttp::new(self.http.clone()).post_json(usage_antigravity::QUOTA_URL, &headers, &body, timeout).await?;
        if !(200..300).contains(&reply.status) {
            let detail = slice_utf16(&scrub_oauth_secrets(&reply.body, &[]), 300);
            return Err(UsageError::new(format!("[antigravity-oauth] retrieveUserQuotaSummary failed: {} {detail}", reply.status)));
        }
        let summary: Value = serde_json::from_str(&reply.body).map_err(|error| UsageError::new(mixdog_js::v8_json_parse_error(&reply.body).unwrap_or_else(|| error.to_string())))?;
        Ok(Some(usage_antigravity::snapshot(&summary)))
    }

    /// `getUsageSnapshot()` of cursor-oauth: the dashboard's plan usage with the stored access token
    /// (exchanged when it is about to expire), carrying the Cursor client version.
    async fn cursor_snapshot(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        let version = match &self.versions {
            Some(versions) => {
                versions.warm(Dialect::Cursor).await;
                versions.cursor_live()
            }
            None => crate::providers::cursor::CLIENT_VERSION_FLOOR.into(),
        };
        let Some(Held::Cursor(access)) = self.held(usage_cursor::PROVIDER_ID, account_id)? else { unreachable!("the provider is held") };
        let reading = usage_cursor::CursorUsage::new(usage_cursor::PROVIDER_ID, self.http.clone(), None, version, access);
        reading.read().await.map(Some)
    }

    fn muse_states(&self) -> std::sync::MutexGuard<'_, HashMap<String, MuseState>> {
        self.muse.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `getUsageSnapshot()` of muse-code-oauth: the key endpoint with the Meta account token, behind
    /// a 5-minute cooldown after a failure, with the last good reading kept for the account it came from.
    async fn muse_code_snapshot(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        let file = self.file(usage_muse_code::PROVIDER_ID, account_id)?;
        let stored = match file.load::<MuseCodeCredentials>().await {
            Probe::Present(stored) if !js_trim(&stored.access_token).is_empty() && !js_trim(&stored.api_key).is_empty() => stored,
            // A missing file is signed out, whatever was cached.
            Probe::Absent => {
                self.muse_states().remove(account_id);
                return Err(UsageError::new(MUSE_SIGNED_OUT));
            }
            _ => return Err(UsageError::new(MUSE_SIGNED_OUT)),
        };
        let stored_account = stored.account_id.clone().unwrap_or_default();
        let digest = Sha256::digest(stored.access_token.as_bytes());
        let identity = format!("{stored_account}:{}", digest.iter().take(8).map(|b| format!("{b:02x}")).collect::<String>());
        let now = self.pace.now_ms() as f64;
        {
            let mut states = self.muse_states();
            let state = states.entry(account_id.to_owned()).or_default();
            if state.failure.as_ref().is_some_and(|f| f.identity != identity) {
                *state = MuseState::default();
            }
            if state.last_good.as_ref().is_some_and(|(known, _)| *known != identity) {
                state.last_good = None;
            }
            if let Some(failure) = state.failure.as_ref().filter(|f| now < f.until) {
                return match &failure.error {
                    Some(error) => Err(error.clone()),
                    None => Ok(state.last_good.as_ref().map(|(_, snapshot)| snapshot.clone())),
                };
            }
        }
        // `fail`: the cooldown with ± 25 % jitter; a rejected credential must not keep showing stale quota.
        let fail = |error: Option<UsageError>| {
            let cooldown = usage_muse_code::FAILURE_BACKOFF_MS as f64 * (1.0 + ((self.jitter)() * 0.5 - 0.25));
            let mut states = self.muse_states();
            let state = states.entry(account_id.to_owned()).or_default();
            state.failure = Some(MuseFailure { identity: identity.clone(), until: now + cooldown, error: error.clone() });
            if error.is_some() {
                state.last_good = None;
            }
            error
        };
        let last_good = || self.muse_states().get(account_id).and_then(|state| state.last_good.as_ref().map(|(_, snapshot)| snapshot.clone()));
        let headers = vec![
            ("Accept".to_owned(), "application/json".to_owned()),
            ("x-api-version".to_owned(), usage_muse_code::API_VERSION.to_owned()),
            ("Authorization".to_owned(), format!("Bearer {}", stored.access_token)),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ];
        let timeout = Duration::from_millis(usage_muse_code::REQUEST_TIMEOUT_MS);
        let reply = RoutedUsageHttp::new(self.http.clone()).post_json(usage_muse_code::KEY_URL, &headers, &json!({}), timeout).await;
        let payload = match reply {
            Ok(reply) if (200..300).contains(&reply.status) => serde_json::from_str::<Value>(&reply.body).ok().filter(usage_muse_code::payload_is_valid),
            Ok(reply) if matches!(reply.status, 401 | 403) => {
                let error = muse_reauth(&format!("account session rejected ({})", reply.status), reply.status);
                fail(Some(error.clone()));
                return Err(error);
            }
            _ => None,
        };
        let Some(payload) = payload else {
            fail(None);
            return Ok(last_good());
        };
        if payload.get("is_subs_active") == Some(&Value::Bool(false)) {
            let error = muse_reauth("Muse Code subscription is inactive", 403);
            fail(Some(error.clone()));
            return Err(error);
        }
        if let Some(state) = self.muse_states().get_mut(account_id) {
            state.failure = None;
        }
        let snapshot = usage_muse_code::snapshot(&payload, stored.email.as_deref().unwrap_or(""), &stored_account, now as i64);
        if let Some(snapshot) = &snapshot {
            self.muse_states().entry(account_id.to_owned()).or_default().last_good = Some((identity, snapshot.clone()));
        }
        Ok(snapshot)
    }

    /// `ensureAuth()` of the OpenCode Go provider: the stored sign-in, refreshed when it is about to expire (or `force`).
    async fn opencode_tokens(&self, account_id: &str, force: bool) -> Result<OpenCodeGoCredentials, UsageError> {
        let file = self.file(usage_opencode_go::PROVIDER_ID, account_id)?;
        match file.load::<OpenCodeGoCredentials>().await {
            Probe::Present(stored) if !js_trim(&stored.access_token).is_empty() && !js_trim(&stored.refresh_token).is_empty() => {}
            _ => return Err(UsageError { status: Some(401), message: OPENCODE_SIGNED_OUT.into() }),
        }
        let Some(Held::OpenCode(auth)) = self.held(usage_opencode_go::PROVIDER_ID, account_id)? else { unreachable!("the provider is held") };
        auth.ensure_fresh(force).await.map_err(opencode_failure)
    }

    /// One `/api/go/status` read with `tokens` (`requestGoStatus`).
    async fn opencode_status(&self, tokens: &OpenCodeGoCredentials) -> Result<Value, UsageError> {
        let mut headers = vec![
            ("Accept".to_owned(), "application/json".to_owned()),
            ("User-Agent".to_owned(), usage_opencode_go::USER_AGENT.to_owned()),
            ("Authorization".to_owned(), format!("Bearer {}", tokens.access_token)),
        ];
        let org = identity(tokens.org_id.as_deref());
        if !org.is_empty() {
            headers.push(("x-org-id".to_owned(), org.to_owned()));
        }
        let timeout = Duration::from_millis(usage_opencode_go::FETCH_TIMEOUT_MS);
        let reply = RoutedUsageHttp::aborting(self.http.clone()).get(usage_opencode_go::STATUS_URL, &headers, timeout).await?;
        if !(200..300).contains(&reply.status) {
            let message = if reply.status == 401 { "OpenCode console credential was rejected".to_owned() } else { format!("OpenCode Go usage fetch failed ({})", reply.status) };
            return Err(UsageError { status: Some(reply.status), message });
        }
        let body: Value = serde_json::from_str(&reply.body).unwrap_or(Value::Null);
        usage_opencode_go::snapshot_from_status(&body).ok_or_else(|| UsageError::new("OpenCode Go subscription meters were not found"))
    }

    /// `getUsageSnapshot()` of opencode-go-oauth: the status read, behind one refresh when the token is
    /// rejected (`withConsoleTokenRetry`).
    async fn opencode_go_snapshot(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        let tokens = self.opencode_tokens(account_id, false).await?;
        let parsed = match self.opencode_status(&tokens).await {
            Err(error) if error.status == Some(401) => {
                let Some(Held::OpenCode(auth)) = self.held(usage_opencode_go::PROVIDER_ID, account_id)? else { unreachable!("the provider is held") };
                let next = auth.ensure_fresh(true).await.map_err(opencode_failure)?;
                if identity(next.account_id.as_deref()) != identity(tokens.account_id.as_deref()) || identity(next.org_id.as_deref()) != identity(tokens.org_id.as_deref()) {
                    return Err(UsageError::new("[opencode-go-oauth] the OpenCode sign-in changed during the request"));
                }
                match self.opencode_status(&next).await {
                    Err(error) if error.status == Some(401) => return Err(opencode_reauth("console 401", 401)),
                    other => other?,
                }
            }
            other => other?,
        };
        Ok(Some(usage_opencode_go::snapshot(parsed, identity(tokens.email.as_deref()), identity(tokens.account_id.as_deref()), now_ms())))
    }

    /// `getUsageSnapshot()` of command-code-oauth: the credits request with the account's key.
    async fn command_code_snapshot(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        let file = self.file(usage_command_code::PROVIDER_ID, account_id)?;
        let Probe::Present(stored) = file.load::<CommandCodeCredentials>().await else {
            return Err(UsageError::new(COMMAND_CODE_SIGNED_OUT));
        };
        let key = js_trim(&stored.api_key);
        if key.is_empty() {
            return Err(UsageError::new(COMMAND_CODE_SIGNED_OUT));
        }
        let headers = vec![("Accept".to_owned(), "application/json".to_owned()), ("Authorization".to_owned(), format!("Bearer {key}"))];
        let reply = RoutedUsageHttp::new(self.http.clone()).get(usage_command_code::CREDITS_URL, &headers, Duration::from_millis(usage_command_code::REQUEST_TIMEOUT_MS)).await?;
        if !(200..300).contains(&reply.status) {
            let detail = slice_utf16(js_trim(&scrub_oauth_secrets(&reply.body, &[key])), 300);
            let detail = if detail.is_empty() { String::new() } else { format!(": {detail}") };
            let message = if reply.status == 401 {
                format!("[command-code-oauth] API key rejected (401) — open /providers in mixdog to sign in again{detail}")
            } else {
                format!("[command-code-oauth] /alpha/billing/credits {}{detail}", reply.status)
            };
            return Err(UsageError { status: Some(reply.status), message });
        }
        let body: Value = serde_json::from_str(&reply.body).map_err(|_| UsageError::new("[command-code-oauth] /alpha/billing/credits returned invalid JSON"))?;
        Ok(usage_command_code::snapshot(&body, js_trim(&stored.user_id), now_ms()))
    }
}

#[async_trait]
impl UsageSource for ProviderUsageSource {
    /// The credential as Node's `ensureAuth` returns it (`access_token`/`accessToken`, `account_id`,
    /// `user_id`); `force_refresh` is the retry behind a refused token, and exchanges the refresh
    /// token when the file still holds the one that was refused.
    async fn ensure_auth(&self, provider: &str, account_id: &str, force_refresh: bool) -> Result<Option<Value>, UsageError> {
        let Some(held) = self.held(provider, account_id)? else { return Ok(None) };
        let auth = match held {
            Held::OpenAi(oauth) => {
                let current = oauth.current().await.map_err(failure)?;
                let credential = if force_refresh { oauth.after_rejection(&current).await.map_err(failure)?.unwrap_or(current) } else { current };
                let mut doc = json!({ "access_token": credential.bearer });
                if let Some(id) = credential.account_id {
                    doc["account_id"] = Value::String(id);
                }
                doc
            }
            Held::Anthropic(session) => {
                let token = session.access_token().await.map_err(failure)?;
                let token = if force_refresh { session.token_after_rejection(&token).await.map_err(failure)? } else { token };
                json!({ "accessToken": token })
            }
            Held::Antigravity(_) | Held::Cursor(_) => return Ok(None),
            Held::OpenCode(_) => {
                let tokens = self.opencode_tokens(account_id, force_refresh).await?;
                json!({ "access_token": tokens.access_token })
            }
            Held::Grok(credential) => {
                let header = credential.header(force_refresh).await.map_err(failure)?;
                let token = header.and_then(|(_, value)| value.strip_prefix("Bearer ").map(str::to_owned));
                let Some(token) = token else { return Ok(None) };
                let mut doc = json!({ "access_token": token });
                if let Some(user) = credential.user_id() {
                    doc["user_id"] = Value::String(user);
                }
                doc
            }
        };
        Ok(Some(auth))
    }

    /// The Antigravity and Cursor provider objects have no `ensureAuth()`, so a rejected token is not retried.
    fn can_refresh(&self, provider: &str) -> bool {
        provider != usage_antigravity::PROVIDER_ID && provider != usage_cursor::PROVIDER_ID
    }

    async fn provider_snapshot(&self, provider: &str, account_id: &str) -> Result<Option<Value>, UsageError> {
        match provider {
            usage_command_code::PROVIDER_ID => self.command_code_snapshot(account_id).await,
            usage_opencode_go::PROVIDER_ID => self.opencode_go_snapshot(account_id).await,
            usage_muse_code::PROVIDER_ID => self.muse_code_snapshot(account_id).await,
            usage_antigravity::PROVIDER_ID => self.antigravity_snapshot(account_id).await,
            usage_cursor::PROVIDER_ID => self.cursor_snapshot(account_id).await,
            _ => Err(UsageError::new(format!("{provider} plan usage is not available from this build"))),
        }
    }
}

#[cfg(test)]
#[path = "usage_ports_tests.rs"]
mod tests;
