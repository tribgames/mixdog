//! Grok OAuth tokens: the stored shape, the refresh exchange, the Bearer
//! credential and the PKCE login. The credential file, refresh verdicts and
//! login flow are the shared `oauth` plumbing; this module supplies the
//! URLs, the client id and the token-endpoint bodies.

use crate::transport::deadlines::GROK_DISCOVERY;
use crate::transport::deadlines::TOKEN_GROK;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::oauth::AuthorizeRequest;
use crate::oauth::CallbackPages;
use crate::oauth::CredentialFile;
use crate::oauth::PkceProvider;
use crate::oauth::Probe;
use crate::oauth::RefreshFailure;
use crate::oauth::Refusal;
use crate::oauth::classify_refresh_failure;
use crate::oauth::http;
use crate::oauth::lease::LeaseOpts;
use crate::oauth::lease::LockProcess;
use crate::oauth::pace::Pace;
use crate::oauth::pace::SystemPace;
use crate::oauth::pages;
use crate::oauth::scrub::oauth_body_summary;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::provider_error;
use crate::providers::connect::rewrite::Credential;
use crate::registry::keys::Environment;
use crate::registry::keys::ProcessEnv;
use crate::retry::advice;
use crate::transport::http::HttpSend;

pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
pub const DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;
pub const REAUTH_GUIDANCE: &str = "open /providers in mixdog to sign in again";
const OPERATION: &str = "[grok-oauth] token exchange";

/// `grok-oauth.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Milliseconds since the Unix epoch; 0 when unknown.
    #[serde(default)]
    pub expires_at: u64,
    /// Node stores `null` for an endpoint it has not learned (`saveTokens`); that reads as none.
    #[serde(default, deserialize_with = "null_as_default")]
    pub token_endpoint: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub principal_type: String,
    #[serde(default)]
    pub principal_id: String,
    #[serde(default)]
    pub email: String,
}

fn null_as_default<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

impl StoredTokens {
    /// `ensureAuth`'s `expiring` (`grok-oauth.mjs:392`): an expiry is known and falls before now plus the skew. An
    /// expiry exactly at the margin is not due yet.
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at < now_ms + REFRESH_SKEW_MS
    }

    /// No expiry, or one at or after `valid_after` (`refreshTokens`' test of a generation it may adopt).
    fn valid_at(&self, valid_after: u64) -> bool {
        self.expires_at == 0 || self.expires_at >= valid_after
    }

    /// Still usable at `now`: no expiry, or one after it (`ensureAuth`'s grace test).
    fn unexpired_at(&self, now: u64) -> bool {
        self.expires_at == 0 || self.expires_at > now
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// xAI OAuth endpoints must be https on x.ai or a subdomain: a hostile
/// discovery document or saved token file cannot redirect the exchange.
pub fn trusted_xai_endpoint(endpoint: &str) -> Result<Url, ProviderError> {
    let untrusted = || {
        let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        error.message = format!("[grok-oauth] untrusted token endpoint: {endpoint}");
        error
    };
    let url = Url::parse(endpoint).map_err(|_| untrusted())?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https" || (host != "x.ai" && !host.ends_with(".x.ai")) {
        return Err(untrusted());
    }
    Ok(url)
}

/// The refresh request body.
pub fn refresh_form(tokens: &StoredTokens) -> String {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("grant_type", "refresh_token");
    form.append_pair("client_id", CLIENT_ID);
    form.append_pair("refresh_token", &tokens.refresh_token);
    if !tokens.principal_type.is_empty() {
        form.append_pair("principal_type", &tokens.principal_type);
    }
    if !tokens.principal_id.is_empty() {
        form.append_pair("principal_id", &tokens.principal_id);
    }
    form.finish()
}

/// A failed refresh (`_postRefresh`, `grok-oauth-tokens.mjs:339`): `[grok-oauth] token refresh <status>: <the body,
/// secrets redacted, its first 200 characters>`; the body's OAuth `error`, lower-cased, is its code (none when it names
/// none); `invalid_grant` and `invalid_client` are terminal (no further attempt, a new sign-in), everything else
/// leaves the refresh token valid and is tried again.
pub fn refresh_error(status: u16, headers: &[(String, String)], body: &[u8], secrets: &[&str]) -> ProviderError {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    // `String(json?.error || '').toLowerCase()`.
    let truthy = |value: &&Value| match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    };
    let oauth = mixdog_js::js_to_lowercase(&parsed.get("error").filter(truthy).map(mixdog_js::value_to_string).unwrap_or_default());
    let terminal = oauth == "invalid_grant" || oauth == "invalid_client";
    let text = String::from_utf8_lossy(body);
    let mut error = provider_error(
        ConnectFailure {
            code: String::new(),
            message: format!("[grok-oauth] token refresh {status}: {}", crate::oauth::scrub::scrubbed_prefix(&text, secrets, 200)),
            http_status: Some(status),
            retry_after: advice::from_headers(headers, SystemTime::now()),
        },
        DeliveryState::Accepted,
    );
    if terminal {
        error.kind = ErrorKind::Auth;
        error.reauth_required = true;
    }
    error.code = (!oauth.is_empty()).then_some(oauth);
    error
}

/// One refresh exchange (`_postRefresh`). xAI rotates refresh tokens; the prior one is kept only when the response
/// omits it. `pace` is the clock the new expiry counts from.
pub async fn refresh(http: &dyn HttpSend, pace: &dyn Pace, tokens: &StoredTokens) -> Result<StoredTokens, ProviderError> {
    // The discovery answer's connection is held until the exchange went out: Node returns its socket a check phase
    // after the code that read it has run on, and the exchange follows at once, so it does not get it.
    let cached = DISCOVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let (endpoint, discovered) = if !tokens.token_endpoint.is_empty() {
        (trusted_xai_endpoint(&tokens.token_endpoint)?.to_string(), None)
    } else if let Some(endpoint) = cached {
        (endpoint, None)
    } else {
        let (endpoint, held) = discover_token_endpoint(http).await?;
        (endpoint, Some(held))
    };
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: endpoint.clone(),
                // The letter case Node's call writes (`grok-oauth-tokens.mjs` `refreshTokens`).
                headers: vec![("Content-Type".to_owned(), "application/x-www-form-urlencoded".to_owned())],
                body: refresh_form(tokens).into_bytes(),
            },
            TOKEN_GROK,
        )
        .await;
    drop(discovered);
    let head = head?;
    let success = head.is_success();
    let response = head.read_all().await?;
    if !success {
        return Err(refresh_error(response.status.unwrap_or(0), &response.headers, &response.body, &[&tokens.refresh_token, &tokens.access_token]));
    }
    let json: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let Some(access) = json.get("access_token").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
        error.message = "[grok-oauth] token refresh returned no access token".to_owned();
        return Err(error);
    };
    let text = |key: &str, fallback: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_owned()
    };
    let now = pace.now_ms();
    let id_token = json.get("id_token").and_then(Value::as_str).unwrap_or_default();
    Ok(StoredTokens {
        access_token: access.to_owned(),
        refresh_token: text("refresh_token", &tokens.refresh_token),
        expires_at: match json.get("expires_in").and_then(Value::as_f64) {
            Some(seconds) => now + (seconds * 1000.0) as u64,
            None => json.get("expires_at").and_then(Value::as_u64).unwrap_or(0),
        },
        token_endpoint: endpoint,
        // `tokens.user_id || _identityFromAccessToken(accessToken).user_id || ''`.
        user_id: [tokens.user_id.clone(), identity_of(access).user_id].into_iter().find(|id| !id.is_empty()).unwrap_or_default(),
        principal_type: text("principal_type", &tokens.principal_type),
        principal_id: text("principal_id", &tokens.principal_id),
        // `_emailFromJwts(json?.id_token, accessToken) || tokens.email || ''`.
        email: email_from_jwts(&[id_token, access]).unwrap_or_else(|| tokens.email.clone()),
    })
}

/// `decodeJwtPayload`: the object the middle of a three-part token decodes to, else none.
fn jwt_payload(token: &str) -> Option<serde_json::Map<String, Value>> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    // `Buffer.from(part, 'base64')` reads either alphabet and ignores padding.
    let part: String = parts[1].chars().filter(|c| *c != '=').map(|c| match c {
        '+' => '-',
        '/' => '_',
        other => other,
    }).collect();
    let bytes = URL_SAFE_NO_PAD.decode(part).ok()?;
    match serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()? {
        Value::Object(payload) => Some(payload),
        _ => None,
    }
}

/// `emailFromJwts(...tokens)`: the first token's non-blank `email` claim, trimmed.
fn email_from_jwts(tokens: &[&str]) -> Option<String> {
    tokens.iter().find_map(|token| {
        let email = jwt_payload(token)?.get("email")?.as_str()?.trim().to_owned();
        (!email.is_empty()).then_some(email)
    })
}

/// `_identityFromAccessToken`: the account a token's claims name.
#[derive(Default)]
struct Identity {
    user_id: String,
    principal_type: String,
    principal_id: String,
}

fn identity_of(token: &str) -> Identity {
    let Some(payload) = jwt_payload(token) else { return Identity::default() };
    // `a || b || ''`, then `String(...)`.
    let first = |keys: &[&str]| {
        keys.iter()
            .filter_map(|key| payload.get(*key))
            .find(|value| !matches!(value, Value::Null | Value::Bool(false)) && value.as_str() != Some("") && value.as_f64() != Some(0.0))
            .map(mixdog_js::value_to_string)
            .unwrap_or_default()
    };
    let principal_id = first(&["principal_id", "principalId"]);
    let principal_type = first(&["principal_type", "principalType"]);
    let user_id = [first(&["user_id", "userId"]), principal_id.clone(), first(&["sub"])].into_iter().find(|id| !id.is_empty()).unwrap_or_default();
    Identity { user_id, principal_type, principal_id }
}

/// `saveTokens` (`grok-oauth-tokens.mjs:213`): the document the whole file becomes, with Node's fallbacks: no expiry is
/// 0, no endpoint `null`, and an identity field or email that is empty (and absent from the access token's claims) is
/// left out.
fn saved_document(tokens: &StoredTokens) -> serde_json::Map<String, Value> {
    let identity = identity_of(&tokens.access_token);
    let mut doc = serde_json::Map::new();
    doc.insert("access_token".into(), Value::String(tokens.access_token.clone()));
    doc.insert("refresh_token".into(), Value::String(tokens.refresh_token.clone()));
    doc.insert("expires_at".into(), Value::from(tokens.expires_at));
    doc.insert("token_endpoint".into(), if tokens.token_endpoint.is_empty() { Value::Null } else { Value::String(tokens.token_endpoint.clone()) });
    for (key, own, claimed) in [
        ("user_id", &tokens.user_id, identity.user_id),
        ("principal_type", &tokens.principal_type, identity.principal_type),
        ("principal_id", &tokens.principal_id, identity.principal_id),
    ] {
        if let Some(value) = [own.clone(), claimed].into_iter().find(|v| !v.is_empty()) {
            doc.insert(key.into(), Value::String(value));
        }
    }
    if let Some(email) = Some(tokens.email.clone()).filter(|e| !e.is_empty()).or_else(|| email_from_jwts(&[&tokens.access_token])) {
        doc.insert("email".into(), Value::String(email));
    }
    doc
}

/// `_discoveryCache` (`grok-oauth-tokens.mjs:112`): the token endpoint a successful discovery named, for the process.
static DISCOVERED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn reset_discovered() {
    *DISCOVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// The token endpoint the discovery document names, and the read answer whose connection is held until it is dropped.
async fn discover_token_endpoint(http: &dyn HttpSend) -> Result<(String, Box<dyn crate::transport::BodyStream>), ProviderError> {
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "GET".to_owned(),
                url: DISCOVERY_URL.to_owned(),
                // The letter case Node's call writes (`grok-oauth-tokens.mjs` discovery).
                headers: vec![("Accept".to_owned(), "application/json".to_owned())],
                body: Vec::new(),
            },
            GROK_DISCOVERY,
        )
        .await?;
    let success = head.is_success();
    let (response, held) = head.read_all_held().await?;
    let json: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    match json.get("token_endpoint").and_then(Value::as_str) {
        Some(endpoint) if success => {
            let endpoint = trusted_xai_endpoint(endpoint)?.to_string();
            *DISCOVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(endpoint.clone());
            Ok((endpoint, held))
        }
        _ => {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
            error.status = response.status;
            error.message = "[grok-oauth] discovery returned no token endpoint".to_owned();
            Err(error)
        }
    }
}

/// `_postRefresh`: one exchange, its tokens saved over the whole file (`saveTokens`, under the file's write lock).
async fn post_refresh(http: &dyn HttpSend, pace: &dyn Pace, file: &CredentialFile, tokens: &StoredTokens) -> Result<StoredTokens, ProviderError> {
    let fresh = refresh(http, pace, tokens).await?;
    file.replace(saved_document(&fresh)).await.map_err(|_| storage_error("the refreshed tokens could not be stored"))?;
    Ok(fresh)
}

/// `_postRefreshWithRetry` (`grok-oauth-tokens.mjs:376`): three exchanges (each saved) at most. A terminal refusal
/// (`invalid_grant`, `invalid_client`) ends it at once; between two, a pause of `min(2 s, 200 ms·2^n)` plus up to as
/// much again at random.
async fn refresh_with_retry(http: &dyn HttpSend, pace: &dyn Pace, file: &CredentialFile, tokens: &StoredTokens) -> Result<StoredTokens, ProviderError> {
    let mut attempt = 0;
    loop {
        match post_refresh(http, pace, file, tokens).await {
            Ok(fresh) => return Ok(fresh),
            // `refresh_error` marks exactly the terminal refusals as needing a new sign-in.
            Err(error) if error.reauth_required || attempt == 2 => return Err(error),
            Err(_) => {
                let base = 2_000f64.min(200.0 * 2f64.powi(attempt));
                let delay = (base + pace.draw() * base).round() as u64;
                pace.wait(std::time::Duration::from_millis(delay)).await;
                attempt += 1;
            }
        }
    }
}

fn is_invalid_grant(error: &ProviderError) -> bool {
    error.reauth_required && error.code.as_deref() == Some("invalid_grant")
}

/// The stored generation `_loadOwnTokens` reads: one with both tokens, else none.
async fn load_own(file: &CredentialFile) -> Option<StoredTokens> {
    match file.load::<StoredTokens>().await {
        Probe::Present(tokens) if !tokens.access_token.is_empty() && !tokens.refresh_token.is_empty() => Some(tokens),
        _ => None,
    }
}

/// `getRefreshLockPath`: `${getOwnTokenPath()}.refresh.lock`.
fn refresh_lock_path(file: &std::path::Path) -> std::path::PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".refresh.lock");
    std::path::PathBuf::from(name)
}

/// `refreshTokens`' lease (`grok-oauth-tokens.mjs:427-431`): a 120 s wait for the lease, a lease that names no owner
/// taken over once 120 s old, the lease file the user's alone.
const REFRESH_LEASE: LeaseOpts = LeaseOpts { timeout: std::time::Duration::from_secs(120), stale: std::time::Duration::from_secs(120), secret: true };

/// A lease that could not be taken, as `withFileLock` throws it (`ELOCKTIMEOUT`, `ELOCKCONTENDED`, or the file error).
fn lease_error(error: mixdog_statefile::LockError) -> ProviderError {
    let mut failure = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    failure.code = error.code().map(str::to_owned);
    failure.message = error.to_string();
    failure
}

/// `refreshTokens` (`grok-oauth-tokens.mjs:387-433`): xAI rotates refresh tokens single-use, so the whole refresh runs
/// holding the cross-process lease beside the credential file. Under it the file is read again: a generation another
/// writer stored meanwhile (either token differs from `tokens`) is adopted without an exchange when it has no expiry or
/// one at or after `now + skew` (`now` for a forced refresh); otherwise the stored generation (or `tokens`) is exchanged,
/// and a refused grant adopts or exchanges a generation a writer outside the lease rotated in meanwhile.
async fn refresh_tokens(
    http: &dyn HttpSend,
    pace: &dyn Pace,
    file: &CredentialFile,
    process: &LockProcess,
    tokens: StoredTokens,
    force: bool,
) -> Result<StoredTokens, ProviderError> {
    if tokens.refresh_token.is_empty() {
        let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        error.reauth_required = true;
        error.message = format!("[grok-oauth] refresh token not available: {REAUTH_GUIDANCE}");
        return Err(error);
    }
    let held = async {
        let valid_after = pace.now_ms() + if force { 0 } else { REFRESH_SKEW_MS };
        let disk = load_own(file).await;
        if let Some(disk) = &disk
            && (disk.access_token != tokens.access_token || disk.refresh_token != tokens.refresh_token)
            && disk.valid_at(valid_after)
        {
            return Ok(disk.clone());
        }
        let current = disk.unwrap_or(tokens);
        match refresh_with_retry(http, pace, file, &current).await {
            Err(error) if is_invalid_grant(&error) => match load_own(file).await {
                Some(rotated) if rotated.refresh_token != current.refresh_token => {
                    if rotated.valid_at(valid_after) {
                        Ok(rotated)
                    } else {
                        refresh_with_retry(http, pace, file, &rotated).await
                    }
                }
                _ => Err(error),
            },
            outcome => outcome,
        }
    };
    file.lease(&refresh_lock_path(file.path()), process, pace, REFRESH_LEASE, held).await.map_err(lease_error)?
}

type SharedRefresh = futures::future::Shared<futures::future::BoxFuture<'static, Result<StoredTokens, ProviderError>>>;

/// What the Grok credentials of one process share: the process as the lease's lock protocol sees it, and the refresh
/// in flight per credential file (`_refreshesInFlight`, `grok-oauth-tokens.mjs:313`), shared by every send of the
/// process that needs one while it runs and gone once it settled.
pub struct RefreshProcess {
    lock: Arc<LockProcess>,
    flights: std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (u64, SharedRefresh)>>,
    generation: std::sync::atomic::AtomicU64,
}

impl RefreshProcess {
    /// This process's.
    fn this_process() -> Arc<Self> {
        static THIS: std::sync::LazyLock<Arc<RefreshProcess>> = std::sync::LazyLock::new(|| Arc::new(RefreshProcess::new(LockProcess::this_process())));
        THIS.clone()
    }

    fn new(lock: Arc<LockProcess>) -> Self {
        Self { lock, flights: std::sync::Mutex::default(), generation: std::sync::atomic::AtomicU64::new(0) }
    }

    fn flights(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<std::path::PathBuf, (u64, SharedRefresh)>> {
        self.flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The Bearer credential of the Grok CLI proxy (`ensureAuth`, `grok-oauth.mjs:370`). A turn refreshes first when the
/// token is inside its skew; a rejected token is refreshed once more; a refresh that fails while the token is still
/// valid leaves the token in use for the skew (the grace window) instead of failing the turn.
pub struct GrokCredential {
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    pace: Arc<dyn Pace>,
    process: Arc<RefreshProcess>,
    current: ArcSwapOption<StoredTokens>,
    /// `_refreshFallbackUntil`: until when (Unix ms) a failed unforced refresh is not tried again.
    fallback_until: std::sync::atomic::AtomicU64,
}

fn storage_error(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = format!("[grok-oauth] {message}");
    error
}

fn not_connected() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    error.reauth_required = true;
    error.message = format!("Grok OAuth is not connected: {REAUTH_GUIDANCE}");
    error
}

impl GrokCredential {
    pub fn new(http: Arc<dyn HttpSend>, file: CredentialFile) -> Self {
        Self {
            http,
            file,
            pace: Arc::new(SystemPace),
            process: RefreshProcess::this_process(),
            current: ArcSwapOption::empty(),
            fallback_until: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The clock, pause and random draw of the refreshes.
    pub fn with_pace(mut self, pace: Arc<dyn Pace>) -> Self {
        self.pace = pace;
        self
    }

    /// A credential of another process sharing this one's credential file: its own lease owner and line, its own
    /// refreshes in flight (two copies of Node's token module in one process are two such processes).
    #[cfg(test)]
    fn in_process(mut self, process: Arc<RefreshProcess>) -> Self {
        self.process = process;
        self
    }

    /// `preconnect(PROXY_BASE_URL)` (`grok-oauth.mjs:328-335`, `:425-428`): before a turn, the proxy origin is warmed,
    /// once per keep-alive window for the process.
    fn preconnect(&self) {
        crate::transport::preconnect::preconnect(&self.http, super::PROXY_ORIGIN, now_ms(), ProcessEnv.var("MIXDOG_LLM_KEEPALIVE_MS"));
    }

    /// The identity header value for the signed-in user, once a turn loaded it.
    pub fn user_id(&self) -> Option<String> {
        self.current
            .load_full()
            .map(|t| t.user_id.clone())
            .filter(|id| !id.is_empty())
    }

    /// The tokens in use: the file's generation when it holds one (another process may have rotated it since this one
    /// last read it: `ensureAuth`'s scan of the file), else the one this process holds.
    async fn tokens(&self) -> Result<StoredTokens, ProviderError> {
        let probe = self.file.load::<StoredTokens>().await;
        if let Probe::Present(tokens) = &probe
            && !tokens.access_token.is_empty()
            && !tokens.refresh_token.is_empty()
        {
            return Ok(tokens.clone());
        }
        if let Some(held) = self.current.load_full() {
            return Ok((*held).clone());
        }
        match probe {
            Probe::Unreadable => Err(storage_error("the credential file cannot be read")),
            _ => Err(not_connected()),
        }
    }

    /// The refresh in flight for this credential's file, if one is.
    fn in_flight(&self) -> Option<SharedRefresh> {
        self.process.flights().get(self.file.path()).map(|(_, shared)| shared.clone())
    }

    /// Starts the refresh of `tokens` every send needing one shares until it settled.
    fn start(&self, tokens: StoredTokens, force: bool) -> SharedRefresh {
        use futures::FutureExt;
        let generation = self.process.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (http, pace, file, process) = (self.http.clone(), self.pace.clone(), self.file.clone(), self.process.clone());
        let path = file.path().to_path_buf();
        let shared = async move {
            let outcome = refresh_tokens(http.as_ref(), pace.as_ref(), &file, &process.lock, tokens, force).await;
            let mut flights = process.flights();
            if flights.get(&path).is_some_and(|(id, _)| *id == generation) {
                flights.remove(&path);
            }
            outcome
        }
        .boxed()
        .shared();
        self.process.flights().insert(self.file.path().to_path_buf(), (generation, shared.clone()));
        shared
    }

    /// `ensureAuth({ forceRefresh })`.
    async fn ensure(&self, force: bool) -> Result<StoredTokens, ProviderError> {
        use std::sync::atomic::Ordering;
        let mut tokens = self.tokens().await?;
        let now = self.pace.now_ms();
        if !force && self.fallback_until.load(Ordering::SeqCst) > now && tokens.unexpired_at(now) {
            return Ok(tokens);
        }
        if !force && !tokens.needs_refresh(now) {
            return Ok(tokens);
        }
        let refused = tokens.access_token.clone();
        let outcome = match self.in_flight() {
            Some(shared) => match shared.await {
                // A forced caller does not take back the token that was refused: it starts its own forced refresh.
                Ok(shared) if force && shared.access_token == refused => {
                    tokens = shared.clone();
                    self.current.store(Some(Arc::new(shared.clone())));
                    self.in_flight().unwrap_or_else(|| self.start(shared, true)).await
                }
                outcome => outcome,
            },
            None => self.start(tokens.clone(), force).await,
        };
        match outcome {
            Ok(fresh) => {
                self.fallback_until.store(0, Ordering::SeqCst);
                Ok(fresh)
            }
            Err(error) => {
                let now = self.pace.now_ms();
                if !force && !refused.is_empty() && tokens.unexpired_at(now) {
                    self.fallback_until.store(now + REFRESH_SKEW_MS, Ordering::SeqCst);
                    tracing::warn!(error = %error.message, "[grok-oauth] Refresh failed; using still-valid current token");
                    return Ok(tokens);
                }
                Err(error)
            }
        }
    }
}

/// `EXPIRED_TOKEN_CODES` (`grok-oauth.mjs:53`): the typed codes that say the bearer itself expired or was revoked.
const EXPIRED_TOKEN_CODES: [&str; 6] = ["token_expired", "expired_token", "access_token_expired", "token_revoked", "revoked_token", "invalid_token"];

/// `hasExpiredTokenSignature`: the refusal's error object names one of [`EXPIRED_TOKEN_CODES`] as its `code` or `type`
/// (the fields Node's client lifts from the body's `error`), trimmed and lower-cased.
fn has_expired_token_signature(body: &[u8]) -> bool {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let error = &parsed["error"];
    ["code", "type"].iter().any(|field| {
        error.get(field).and_then(Value::as_str).is_some_and(|text| EXPIRED_TOKEN_CODES.contains(&text.trim().to_lowercase().as_str()))
    })
}

#[async_trait]
impl Credential for GrokCredential {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        self.preconnect();
        let tokens = self.ensure(force_refresh).await?;
        self.current.store(Some(Arc::new(tokens.clone())));
        Ok(Some(("authorization".to_owned(), format!("Bearer {}", tokens.access_token))))
    }

    /// `send`'s refresh-and-retry (`grok-oauth.mjs:466`): a 401, or a 403 whose error carries an expired-token code.
    fn refreshes_on(&self, status: u16, body: &[u8]) -> bool {
        status == 401 || (status == 403 && has_expired_token_signature(body))
    }

    /// Node resends after the refresh whatever token it gave back.
    fn resend_needs_new(&self) -> bool {
        false
    }

    /// A resend refused with a 401 on a token just refreshed needs a new sign-in.
    fn refused_again(&self, status: u16, error: &mut ProviderError) {
        if status == 401 {
            error.reauth_required = true;
        }
    }

    /// Node's OpenAI client writes its auth header right after its platform headers, before the provider's own
    /// (`openai/client.js` `buildHeaders`).
    fn place(&self, headers: &mut Vec<(String, String)>, header: (String, String)) {
        let at = headers.iter().rposition(|(name, _)| name.starts_with("x-stainless-")).map_or(headers.len(), |last| last + 1);
        headers.insert(at, header);
    }

    fn refreshable(&self) -> bool {
        true
    }
}

/// The `email` claim of a JWT, if it carries one.
fn email_claim(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    claims.get("email")?.as_str().map(str::to_owned)
}

pub const CALLBACK_PORT: u16 = 56121;
pub const CALLBACK_PATH: &str = "/callback";

/// The PKCE sign-in: authorization endpoint from the discovery document, the
/// registered loopback redirect, and the code exchange.
pub struct GrokLogin {
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    authorization_endpoint: Url,
    token_endpoint: Url,
}

impl GrokLogin {
    pub fn new(
        http: Arc<dyn HttpSend>,
        file: CredentialFile,
        authorization_endpoint: &str,
        token_endpoint: &str,
    ) -> Result<Self, ProviderError> {
        Ok(Self {
            http,
            file,
            authorization_endpoint: trusted_xai_endpoint(authorization_endpoint)?,
            token_endpoint: trusted_xai_endpoint(token_endpoint)?,
        })
    }
}

fn failed(code: &str, message: String) -> LoginFailure {
    LoginFailure::Failed {
        code: code.to_owned(),
        message,
    }
}

#[async_trait]
impl PkceProvider for GrokLogin {
    fn redirect(&self) -> crate::oauth::Redirect {
        crate::oauth::redirects::GROK
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        let mut url = self.authorization_endpoint.clone();
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", request.redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("state", request.state)
            .append_pair("nonce", &crate::oauth::random_state())
            .append_pair("code_challenge", request.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("plan", "generic")
            .append_pair("referrer", "mixdog");
        url.into()
    }

    fn callback_pages(&self) -> CallbackPages {
        pages::GROK
    }

    async fn exchange_checked(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Option<String>, Refusal> {
        let code = code.trim();
        if code.is_empty() {
            return Err(failed("invalid_callback", "authorization code is required".to_owned()).into());
        }
        // xAI re-validates the PKCE challenge at the exchange, not only the
        // verifier: it is echoed back like the Grok CLI does.
        let challenge = crate::oauth::Pkce::from_verifier(verifier.to_owned()).challenge;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("code", code)
            .append_pair("code_verifier", verifier)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .finish();
        let reply = http::try_call(
            self.http.as_ref(),
            "POST",
            self.token_endpoint.as_str(),
            vec![("content-type", "application/x-www-form-urlencoded".to_owned())],
            body.into_bytes(),
        )
        .await
        .map_err(|error| {
            let text = http::request_failed(OPERATION, &error);
            Refusal { failure: failed("transport", text.clone()), detail: Some(text) }
        })?;
        if !reply.ok() {
            // `oauthHttpError`: `<operation> <status>: <redacted body>`.
            let summary = oauth_body_summary(&reply.text(), &[code, verifier, &challenge]);
            let detail = if summary.is_empty() { String::new() } else { format!(": {summary}") };
            let text = format!("{OPERATION} {}{detail}", reply.status);
            let failure = match classify_refresh_failure(Some(reply.status), &reply.body) {
                RefreshFailure::Definitive => LoginFailure::Denied,
                _ => failed("token_exchange", text.clone()),
            };
            return Err(Refusal { failure, detail: Some(text) });
        }
        // `oauthResponseJson`: a body that does not parse is named by its status only.
        let Some(json) = reply.json() else {
            let text = format!("{OPERATION} returned a malformed response (HTTP {})", reply.status);
            return Err(Refusal { failure: failed("token_exchange", text.clone()), detail: Some(text) });
        };
        let text = |key: &str| json.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let (Some(access), Some(refresh_token)) = (text("access_token"), text("refresh_token")) else {
            return Err(failed(
                "token_exchange",
                "[grok-oauth] token exchange response missing access_token or refresh_token".to_owned(),
            )
            .into());
        };
        let email = text("id_token")
            .and_then(email_claim)
            .or_else(|| email_claim(access))
            .unwrap_or_default();
        let tokens = StoredTokens {
            access_token: access.to_owned(),
            refresh_token: refresh_token.to_owned(),
            expires_at: match json.get("expires_in").and_then(Value::as_f64) {
                Some(seconds) => now_ms() + (seconds * 1000.0) as u64,
                None => json.get("expires_at").and_then(Value::as_u64).unwrap_or(0),
            },
            token_endpoint: self.token_endpoint.to_string(),
            user_id: String::new(),
            principal_type: text("principal_type").unwrap_or_default().to_owned(),
            principal_id: text("principal_id").unwrap_or_default().to_owned(),
            email: email.clone(),
        };
        self.file
            .save(&tokens)
            .await
            .map_err(|_| failed("storage", "the tokens could not be stored".to_owned()))?;
        Ok((!email.is_empty()).then_some(email))
    }
}
#[cfg(test)]
#[path = "refresh_lease/tests.rs"]
mod refresh_lease_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_x_ai_https_endpoints_are_trusted() {
        assert!(trusted_xai_endpoint("https://auth.x.ai/oauth2/token").is_ok());
        assert!(trusted_xai_endpoint("https://x.ai/token").is_ok());
        for bad in ["http://auth.x.ai/t", "https://evilx.ai/t", "https://x.ai.evil.com/t", "nope"] {
            assert!(trusted_xai_endpoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn refresh_form_carries_the_principal_when_known() {
        let t = StoredTokens {
            refresh_token: "r&1".into(),
            principal_type: "user".into(),
            ..StoredTokens::default()
        };
        assert_eq!(
            refresh_form(&t),
            format!("grant_type=refresh_token&client_id={CLIENT_ID}&refresh_token=r%261&principal_type=user")
        );
    }

    #[test]
    fn dead_grants_need_a_new_sign_in_and_throttles_do_not() {
        let dead = refresh_error(400, &[], br#"{"error":"invalid_grant"}"#, &[]);
        assert!(dead.reauth_required);
        assert_eq!(dead.code.as_deref(), Some("invalid_grant"));
        let throttled = refresh_error(429, &[], b"slow down", &[]);
        assert!(!throttled.reauth_required);
        assert_eq!(throttled.kind, ErrorKind::RateLimited);
    }

    /// Each Grok request that outlives its timer reads as the real Node function of the same site did
    /// (`sites.grokDiscovery`, `grokRefresh`, `grokCodeExchange`): the refresh and the discovery under their labelled
    /// timers, the authorization-code exchange under `AbortSignal.timeout` (not the refresh's label).
    #[tokio::test(start_paused = true)]
    async fn a_grok_request_that_outlives_its_timer_reads_as_nodes_site() {
        use crate::oauth::CredentialIo;
        use crate::transport::site_probe::TimingOut;
        use crate::transport::site_probe::assert_thrown;
        use crate::transport::site_probe::assert_transport;
        use crate::transport::site_probe::login_message;

        let tokens = StoredTokens {
            access_token: "a".into(),
            refresh_token: "r".into(),
            token_endpoint: "https://auth.x.ai/oauth2/token".into(),
            ..StoredTokens::default()
        };
        let transport = TimingOut::new();
        let error = refresh(transport.as_ref(), &SystemPace, &tokens).await.expect_err("the token endpoint never answers");
        assert_transport("grokRefresh", &transport);
        assert_thrown("grokRefresh", &error.message);

        let transport = TimingOut::new();
        let error = refresh(transport.as_ref(), &SystemPace, &StoredTokens { token_endpoint: String::new(), ..tokens.clone() })
            .await
            .expect_err("the discovery never answers");
        assert_transport("grokDiscovery", &transport);
        assert_thrown("grokDiscovery", &error.message);

        let transport = TimingOut::new();
        let dir = tempfile::tempdir().unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(
            dir.path().join("grok-oauth.json"),
            CredentialIo { read: rt.interactive_io, write: rt.durability_io },
        );
        let login = GrokLogin::new(transport.clone(), file, "https://auth.x.ai/authorize", "https://auth.x.ai/oauth2/token").unwrap();
        let failure = login.exchange("abc", "v", "http://127.0.0.1:56121/callback").await.expect_err("the exchange never answers");
        assert_transport("grokCodeExchange", &transport);
        // Node words the exchange's failure itself (`oauthRequestError`), and so does the Rust login.
        assert_thrown("grokCodeExchange", login_message(&failure));
    }

    /// `expiring = expires_at < now + TOKEN_REFRESH_SKEW_MS` (`grok-oauth.mjs:392`): an expiry exactly at the margin is
    /// not due, one a millisecond inside it is.
    #[test]
    fn expiry_is_due_inside_the_skew() {
        let t = StoredTokens {
            expires_at: 1_000_000,
            ..StoredTokens::default()
        };
        assert!(!t.needs_refresh(1_000_000 - REFRESH_SKEW_MS));
        assert!(t.needs_refresh(1_000_000 - REFRESH_SKEW_MS + 1));
        assert!(!t.needs_refresh(0));
        assert!(!StoredTokens::default().needs_refresh(u64::MAX / 2));
    }
}
