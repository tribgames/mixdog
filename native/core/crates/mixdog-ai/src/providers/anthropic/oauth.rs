//! Anthropic subscription OAuth: the credential document (`claudeAiOauth`),
//! the token endpoint requests, and the single-flight refresh. The credential
//! file, the HTTP exchange, refresh-failure classification and the PKCE login
//! flow are the shared plumbing's ([`CredentialFile`], [`HttpSend`],
//! [`PkceProvider`]); this module supplies only Anthropic's URLs, client id and
//! token bodies.

use crate::transport::deadlines::TOKEN_ANTHROPIC_REFRESH;
use crate::transport::deadlines::TOKEN_EXCHANGE;
use crate::transport::link::Surface;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use crate::oauth::AuthorizeRequest;
use crate::oauth::CallbackPages;
use crate::oauth::CredentialFile;
use crate::oauth::Pace;
use crate::oauth::PkceProvider;
use crate::oauth::Probe;
use crate::oauth::RefreshFailure;
use crate::oauth::Refusal;
use crate::oauth::SystemPace;
use crate::oauth::classify_refresh_failure;
use crate::oauth::http;
use crate::oauth::is_definitive_oauth_failure;
use crate::oauth::lease::LockProcess;
use crate::oauth::lease::REFRESH_LEASE;
use crate::oauth::lease::lease_error;
use crate::oauth::lease::refresh_lock_path;
use crate::oauth::pages;
use crate::oauth::scrub::oauth_body_summary;
use crate::transport::http::HttpSend;

use super::codec::DEFAULT_CLI_VERSION;

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
/// The hosted page whose redirect shows the authorization code (`OAUTH_MANUAL_REDIRECT_URI`).
const MANUAL_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
pub const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const SCOPES: [&str; 6] = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
/// A token that expires within this window is refreshed before use.
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;

/// `claudeAiOauth` of `anthropic-oauth-credentials.json`; unknown fields are
/// kept so a rewrite never drops them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "StoredOAuthDocument")]
pub struct StoredOAuth {
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch ms; `0` means no recorded expiry.
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reauth_required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The stored document as it reads: both spellings of the expiry, which `StoredOAuth` folds into one the way Node reads
/// them (`oauth.expiresAt ?? oauth.expires_at`) and writes in Node's (`expiresAt`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOAuthDocument {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_at: Option<Value>,
    #[serde(default)]
    scopes: Vec<String>,
    #[serde(default)]
    reauth_required: Option<bool>,
    #[serde(default)]
    subscription_type: Option<String>,
    #[serde(default)]
    identity: Option<Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl From<StoredOAuthDocument> for StoredOAuth {
    fn from(mut document: StoredOAuthDocument) -> Self {
        let alternate = document.extra.shift_remove("expires_at");
        Self {
            access_token: document.access_token,
            refresh_token: document.refresh_token,
            expires_at: crate::accounts::validity::stated_expiry(document.expires_at, alternate),
            scopes: document.scopes,
            reauth_required: document.reauth_required,
            subscription_type: document.subscription_type,
            identity: document.identity,
            extra: document.extra,
        }
    }
}

impl StoredOAuth {
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at != 0 && self.expires_at <= now_ms + REFRESH_SKEW_MS
    }

    pub fn is_enterprise(&self) -> bool {
        self.subscription_type.as_deref().is_some_and(|t| t.eq_ignore_ascii_case("enterprise"))
    }
}

/// Whether the access token lasts less than `lease_ms` more; no recorded expiry counts as short.
fn lease_is_short(stored: &StoredOAuth, now_ms: u64, lease_ms: u64) -> bool {
    stored.expires_at == 0 || stored.expires_at < now_ms + lease_ms
}

/// What [`OAuthSession::ensure_lease`] established; metadata only, never token bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeaseOutcome {
    pub expires_at: u64,
    pub remaining_ms: u64,
    pub refreshed: bool,
}

/// The login one attempt was made on: the bearer it sent, and the refresh grant and account that bearer was served
/// under. A rejection of the attempt acts on that login alone.
#[derive(Clone)]
pub struct Attempt {
    pub access_token: String,
    refresh_token: String,
    owner: Option<Value>,
}

impl Attempt {
    fn of(stored: &StoredOAuth) -> Self {
        Self { access_token: stored.access_token.clone(), refresh_token: stored.refresh_token.clone(), owner: stored.identity.clone() }
    }

    /// The account the login was made for (its stored `identity`), when it names one.
    pub fn owner(&self) -> Option<&Value> {
        self.owner.as_ref()
    }

    /// Whether `stored` is still the login the attempt was made on: the same refresh grant, of the same account. An
    /// account that is not known is the same only as another that is not known.
    fn made_on(&self, stored: &StoredOAuth) -> bool {
        self.refresh_token == stored.refresh_token && self.owner == stored.identity
    }
}

/// The document key of the credential in the shared credential file; other
/// top-level fields of the file are left as they are.
const DOCUMENT_KEY: &str = "claudeAiOauth";

#[derive(Serialize, Deserialize)]
struct Document {
    #[serde(rename = "claudeAiOauth")]
    oauth: StoredOAuth,
}

fn file_error(cause: &dyn std::fmt::Display) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    err.message = format!("Anthropic OAuth credential file: {cause}");
    err
}

/// The stored credential, or `None` when signed out. An unreadable file is
/// an error, never a logout.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
async fn load_stored(file: &CredentialFile) -> Result<Option<StoredOAuth>, ProviderError> {
    match file.load::<Document>().await {
        Probe::Present(mut document) => {
            file.keep(&[&document.oauth.access_token, &document.oauth.refresh_token]);
            // `_normalizeExpiresAt(oauth.expiresAt ?? oauth.expires_at) || expiryFromAccessToken(oauth.accessToken)`.
            document.oauth.expires_at = crate::accounts::validity::expiry_or_claim(document.oauth.expires_at, &document.oauth.access_token);
            Ok(Some(document.oauth))
        }
        Probe::Absent => Ok(None),
        Probe::Unreadable => Err(file_error(&"unreadable")),
    }
}

/// Writes `next` only if the stored login is still `from`: its token pair, for its account. Returns whether it was
/// written. Another process may have refreshed meanwhile, or a sign-in stored the same pair for another account.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
async fn publish(file: &CredentialFile, from: &StoredOAuth, next: &StoredOAuth) -> Result<bool, ProviderError> {
    file.keep(&[&next.access_token, &next.refresh_token]);
    let (access, refresh, owner) = (from.access_token.clone(), from.refresh_token.clone(), from.identity.clone());
    let mut update = Map::new();
    update.insert(DOCUMENT_KEY.to_owned(), serde_json::to_value(next).map_err(|e| file_error(&e))?);
    file.replace_if(
        move |document| {
            document.get(DOCUMENT_KEY).is_some_and(|stored| {
                stored.get("accessToken").and_then(Value::as_str) == Some(access.as_str())
                    && stored.get("refreshToken").and_then(Value::as_str) == Some(refresh.as_str())
                    && stored.get("identity").filter(|identity| !identity.is_null()) == owner.as_ref()
            })
        },
        update,
    )
    .await
    .map_err(|e| file_error(&e))
}

/// Marks the stored grant dead; tokens stay intact.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
async fn mark_reauth_required(file: &CredentialFile, stored: &StoredOAuth, status: u16) -> Result<(), ProviderError> {
    let mut dead = stored.clone();
    dead.reauth_required = Some(true);
    if publish(file, stored, &dead).await? {
        file.note_marked_reauth("anthropic-oauth", status).await;
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn auth_error(message: &str, reauth_required: bool) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = reauth_required;
    err.message = message.to_owned();
    err
}

// Token endpoint

fn token_request(url: &str, body: Value, cli_version: &str) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: vec![
            // `tokenEndpointHeaders` (anthropic-oauth-credentials.mjs:272) spells it as written here.
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()),
            ("user-agent".to_owned(), super::client_version::user_agent(cli_version)),
        ],
        body: serde_json::to_vec(&body).unwrap_or_default(),
    }
}

pub fn refresh_request(url: &str, refresh_token: &str, cli_version: &str) -> WireRequest {
    token_request(url, json!({ "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CLIENT_ID }), cli_version)
}

pub fn exchange_request(url: &str, code: &str, redirect_uri: &str, verifier: &str, state: &str, cli_version: &str) -> WireRequest {
    token_request(
        url,
        json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }),
        cli_version,
    )
}

/// The browser URL of the authorization-code login.
pub fn authorize_url(redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = Url::parse(AUTHORIZE_URL).expect("constant URL");
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    url.into()
}

/// How the token endpoint failed.
#[derive(Debug)]
#[allow(clippy::large_enum_variant, reason = "Forward canonical ProviderError from the token endpoint without a second allocation for this private classifier")]
enum TokenFailure {
    /// The grant is dead: the user must sign in again. Carries the message the sign-in prompt shows.
    Dead(String, u16),
    /// Try again later, or a rejection that states no reason.
    Failed(ProviderError),
}

/// Which flow a token response belongs to; Node reads the two differently.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TokenFlow {
    /// A refresh keeps what the response omits: the refresh token, the
    /// scopes (it takes an array only) and the account identity.
    Refresh,
    /// A fresh sign-in needs both tokens, takes the scopes as a list or a
    /// space-separated string, and replaces the account identity.
    Login,
}

/// Epoch ms of an absolute expiry: seconds below 1e12 are scaled up; anything
/// that is not a positive finite number is no expiry.
fn absolute_expiry(value: Option<&Value>) -> u64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v.is_finite() && v > 0.0 => (if v < 1e12 { v * 1000.0 } else { v }) as u64,
        _ => 0,
    }
}

/// Node's `expiresAtFromTokenResponse`: an absolute `expires_at`/`expiresAt`
/// wins, else `expires_in` seconds from now.
fn token_expiry(response: &Value, now_ms: u64) -> u64 {
    let absolute = absolute_expiry(response.get("expires_at").filter(|v| !v.is_null()).or_else(|| response.get("expiresAt")));
    if absolute != 0 {
        return absolute;
    }
    response.get("expires_in").and_then(Value::as_f64).map_or(0, |secs| (now_ms as f64 + secs * 1000.0).max(0.0) as u64)
}

/// The account the token endpoint names next to the tokens
/// (`account.uuid`, `account.email_address`, `organization.uuid`); it counts
/// only with an id or an email.
fn token_identity(response: &Value) -> Option<Value> {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(|s| s.trim().chars().take(200).collect::<String>()).filter(|s| !s.is_empty());
    let id = text(response.pointer("/account/uuid"));
    let email = text(response.pointer("/account/email_address"));
    let organization = text(response.pointer("/organization/uuid"));
    if id.is_none() && email.is_none() {
        return None;
    }
    let mut identity = Map::new();
    for (key, value) in [("id", id), ("email", email), ("organizationId", organization)] {
        if let Some(value) = value {
            identity.insert(key.to_owned(), Value::String(value));
        }
    }
    Some(Value::Object(identity))
}

/// A successful token response applied to the credential it replaces.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
pub fn apply_token_response(previous: &StoredOAuth, response: &Value, now_ms: u64, flow: TokenFlow) -> Result<StoredOAuth, ProviderError> {
    let field = |snake: &str, camel: &str| {
        response
            .get(snake)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .or_else(|| response.get(camel))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let access = field("access_token", "accessToken").ok_or_else(|| auth_error("token response is missing access_token", false))?;
    let refresh = match (field("refresh_token", "refreshToken"), flow) {
        (Some(refresh), _) => refresh,
        (None, TokenFlow::Refresh) => previous.refresh_token.as_str(),
        (None, TokenFlow::Login) => {
            return Err(auth_error("token response is missing refresh_token", false));
        }
    };
    let strings = |items: &[Value]| items.iter().filter_map(Value::as_str).map(str::to_owned).collect();
    let scopes = match (response.get("scope"), flow) {
        (Some(Value::Array(items)), _) => strings(items),
        (Some(Value::String(text)), TokenFlow::Login) => text.split(' ').filter(|p| !p.is_empty()).map(str::to_owned).collect(),
        (_, TokenFlow::Refresh) => previous.scopes.clone(),
        (_, TokenFlow::Login) => Vec::new(),
    };
    let named = token_identity(response);
    let identity = match flow {
        TokenFlow::Refresh => named.or_else(|| previous.identity.clone()),
        TokenFlow::Login => named,
    };
    Ok(StoredOAuth {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        expires_at: token_expiry(response, now_ms),
        scopes,
        reauth_required: None,
        identity,
        ..previous.clone()
    })
}

const SIGN_IN_EXPIRED_PREFIX: &str = "Anthropic sign-in expired. Sign in again from Providers.";

/// `_tokenEndpointError`: `<operation> <status>: <redacted body>.` plus the hint a 403 carries.
fn endpoint_message(operation: &str, status: u16, body: &[u8], secrets: &[&str], cli_version: &str) -> String {
    let summary = oauth_body_summary(&String::from_utf8_lossy(body), secrets);
    let detail = if summary.is_empty() { String::new() } else { format!(": {summary}") };
    let compatibility = if status == 403 {
        format!(
            " Anthropic returned HTTP 403 for a request sent as claude-cli/{cli_version}. Possible causes include OAuth client compatibility, account or scope policy, an intercepting proxy/VPN/WAF, or regional endpoint restrictions. Verify the account has Claude Code access and the required scopes; update Mixdog or set MIXDOG_CLI_VERSION to the installed official Claude Code version; then retry sign-in via /providers without an intercepting network layer if applicable."
        )
    } else {
        String::new()
    };
    format!("{operation} {status}{detail}.{compatibility}")
}

/// The login's reading of a refused code exchange: only a coded dead grant is a denial.
fn token_failure(status: u16, body: &[u8]) -> TokenFailure {
    let kind = match classify_refresh_failure(Some(status), body) {
        RefreshFailure::Definitive => return TokenFailure::Dead(String::new(), status),
        RefreshFailure::Transient => ErrorKind::Transient,
        RefreshFailure::Unknown => ErrorKind::Auth,
    };
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = Some(status);
    err.message = format!("Anthropic OAuth token endpoint {status}");
    TokenFailure::Failed(err)
}

/// A refused refresh (`_refreshOAuthCredentialsUnlocked`): a dead grant by `isDefinitiveOAuthFailure` carries the
/// sign-in prompt; any other answer states its status and redacted body.
fn refresh_failure(status: u16, body: &[u8], previous: &StoredOAuth, cli_version: &str) -> TokenFailure {
    let message = endpoint_message("token refresh", status, body, &[previous.refresh_token.as_str(), previous.access_token.as_str()], cli_version);
    if is_definitive_oauth_failure(&String::from_utf8_lossy(body), status) {
        return TokenFailure::Dead(format!("{SIGN_IN_EXPIRED_PREFIX} {message}"), status);
    }
    let kind = if matches!(status, 403 | 429 | 500..) { ErrorKind::Transient } else { ErrorKind::Auth };
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = Some(status);
    err.message = message;
    TokenFailure::Failed(err)
}

/// One POST to the token endpoint and its parse into the credential that
/// replaces `previous`.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
async fn token_call(
    http: &dyn HttpSend,
    request: WireRequest,
    previous: &StoredOAuth,
    now: u64,
    flow: TokenFlow,
    cli_version: &str,
) -> Result<StoredOAuth, TokenFailure> {
    // The refresh is a bare `setTimeout` abort (`anthropic-oauth-credentials.mjs:313`), the code exchange an
    // `AbortSignal.timeout` (`:609`).
    let exchange = match flow {
        TokenFlow::Refresh => TOKEN_ANTHROPIC_REFRESH,
        TokenFlow::Login => TOKEN_EXCHANGE,
    };
    let response = http.send(request, exchange).await.map_err(|mut error| {
        // Node words the refresh's `AbortError` itself (`anthropic-oauth-credentials.mjs:404-409`).
        if flow == TokenFlow::Refresh && error.timed_out {
            error.message = "Anthropic OAuth token refresh timed out after 30000ms".to_owned();
        }
        TokenFailure::Failed(error)
    })?;
    let reply = response.read_all().await.map_err(TokenFailure::Failed)?;
    let status = reply.status.unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(match flow {
            TokenFlow::Refresh => refresh_failure(status, &reply.body, previous, cli_version),
            TokenFlow::Login => token_failure(status, &reply.body),
        });
    }
    let parsed: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
    apply_token_response(previous, &parsed, now, flow).map_err(TokenFailure::Failed)
}

// Session

/// What one refresh needs, cloneable into the shared flight.
#[derive(Clone)]
struct RefreshParts {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    token_url: String,
    cli_version: Option<Arc<super::ClaudeClientVersion>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// The process as the refresh lease's lock protocol sees it, and its clock and waits.
    process: Arc<LockProcess>,
    pace: Arc<dyn Pace>,
}

impl RefreshParts {
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn stored(&self) -> Result<StoredOAuth, ProviderError> {
        match load_stored(&self.file).await? {
            Some(stored) if !stored.access_token.is_empty() => Ok(stored),
            _ => Err(auth_error("Anthropic OAuth credentials not found; sign in again", true)),
        }
    }

    /// The refresh grant is single-use: the exchange runs holding the cross-process lease beside the credential file,
    /// from the read of the stored pair to its replacement, so another process (or another handle in this one) that
    /// refreshes first has stored its pair before this one reads the file, and this one never spends the old grant. The
    /// file is the one the flight was pinned to (`file`), held for the whole refresh: a handle that follows the
    /// selected account and one bound to that account's file take the same lease.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn refresh(mut self, file: CredentialFile, held: Attempt, rejected: bool, lease_ms: Option<u64>) -> Result<Attempt, ProviderError> {
        self.file = file;
        let lock = refresh_lock_path(self.file.path());
        self.file.lease(&lock, &self.process, &*self.pace, REFRESH_LEASE, self.exchange(held, rejected, lease_ms)).await.map_err(lease_error)?
    }

    /// `rejected`: the server refused `held`'s access token. `lease_ms`: refresh unless the token outlasts that window
    /// (`preflightAnthropicOAuthCredentials`), instead of the usual skew.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn exchange(&self, held: Attempt, rejected: bool, lease_ms: Option<u64>) -> Result<Attempt, ProviderError> {
        // Reload first: another process may already have rotated the pair. The flight acts only on the login its callers
        // hold (`held`); one stored since is used as it is, never refreshed or marked on their behalf.
        let stored = self.stored().await?;
        if !held.made_on(&stored) {
            return Ok(Attempt::of(&stored));
        }
        let now = (self.clock)();
        let current = match (rejected, lease_ms) {
            (true, _) => stored.access_token != held.access_token,
            (false, Some(lease)) => !lease_is_short(&stored, now, lease),
            (false, None) => !stored.needs_refresh(now),
        };
        if current {
            return Ok(Attempt::of(&stored));
        }
        if stored.refresh_token.is_empty() {
            return Err(auth_error("Anthropic OAuth refresh token is unavailable", true));
        }
        let version = token_version(self.cli_version.as_deref()).await;
        let request = refresh_request(&self.token_url, &stored.refresh_token, &version);
        match token_call(self.http.as_ref(), request, &stored, now, TokenFlow::Refresh, &version).await {
            Ok(next) => {
                if !publish(&self.file, &stored, &next).await? {
                    // Someone else published first: their pair is the truth.
                    return Ok(Attempt::of(&self.stored().await?));
                }
                Ok(Attempt::of(&next))
            }
            Err(TokenFailure::Dead(message, status)) => {
                // A writer outside the lease (a sign-in) may have replaced the pair.
                let latest = self.stored().await?;
                if !held.made_on(&latest) {
                    return Ok(Attempt::of(&latest));
                }
                mark_reauth_required(&self.file, &stored, status).await?;
                Err(auth_error(&message, true))
            }
            Err(TokenFailure::Failed(err)) => Err(err),
        }
    }
}

/// One credential account: serves access tokens and runs the refresh. The
/// shared credential file single-flights the refresh across every handle on it.
pub struct OAuthSession {
    parts: RefreshParts,
}

impl OAuthSession {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self {
            parts: RefreshParts {
                file,
                http,
                token_url: TOKEN_URL.to_owned(),
                cli_version: None,
                clock: Arc::new(now_ms),
                process: LockProcess::this_process(),
                pace: Arc::new(SystemPace),
            },
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.parts.clock = clock;
        self
    }

    pub fn with_token_url(mut self, url: impl Into<String>) -> Self {
        self.parts.token_url = url.into();
        self
    }

    pub fn with_cli_version(mut self, version: impl Into<String>) -> Self {
        self.parts.cli_version = Some(Arc::new(super::ClaudeClientVersion::fixed(&version.into())));
        self
    }

    pub fn with_cli_version_source(mut self, version: Arc<super::ClaudeClientVersion>) -> Self {
        self.parts.cli_version = Some(version);
        self
    }

    pub(super) fn cli_version_source(&self) -> Option<Arc<super::ClaudeClientVersion>> {
        self.parts.cli_version.clone()
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn stored(&self) -> Result<StoredOAuth, ProviderError> {
        self.parts.stored().await
    }

    /// Names the account: the credential file it signs in from.
    pub fn account(&self) -> String {
        self.parts.file.path().display().to_string()
    }

    /// A usable access token, refreshing first when it is near expiry.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn access_token(&self) -> Result<String, ProviderError> {
        self.attempt().await.map(|attempt| attempt.access_token)
    }

    /// What one attempt is made on: a usable access token (refreshed first when it is near expiry) and the login it
    /// was served under, which [`Self::after_rejection`] takes back.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn attempt(&self) -> Result<Attempt, ProviderError> {
        let stored = self.stored().await?;
        if stored.reauth_required == Some(true) {
            return Err(auth_error("Anthropic sign-in expired; sign in again", true));
        }
        if !stored.needs_refresh((self.parts.clock)()) {
            return Ok(Attempt::of(&stored));
        }
        self.refresh_for(Attempt::of(&stored), false, None).await
    }

    /// What to send next after the server rejected `rejected`'s token: the login it was made on is refreshed, unless
    /// another caller already replaced its token. A login stored since the attempt is returned as it is.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn after_rejection(&self, rejected: &Attempt) -> Result<Attempt, ProviderError> {
        self.refresh_for(rejected.clone(), true, None).await
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn refresh_for(&self, held: Attempt, rejected: bool, lease_ms: Option<u64>) -> Result<Attempt, ProviderError> {
        // When the file holds another login by the time this settles, the caller gets that login's token: the roster row is
        // the identity, as in Node 1.4.5, so this is the rule and not a leak.
        let parts = self.parts.clone();
        let grant = held.refresh_token.clone();
        self.parts
            .file
            .refresh_once(&grant, move |file| parts.refresh(file, held, rejected, lease_ms))
            .await
            .unwrap_or_else(|lost| Err(lost.provider_error(DeliveryState::Ambiguous, Surface::Socket)))
    }

    /// `preflightAnthropicOAuthCredentials`: refreshes the credential now unless its access token lasts at least
    /// `lease_ms` more (no recorded expiry counts as short), whatever the usual skew says; the refreshed pair is
    /// persisted before this returns. Errors when signed out, when the grant is dead, or when the endpoint grants less
    /// than the lease. Returns the persisted credential's expiry (epoch ms) and whether a refresh ran.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn ensure_lease(&self, lease_ms: u64) -> Result<LeaseOutcome, ProviderError> {
        let before = self.stored().await?;
        if before.reauth_required == Some(true) {
            return Err(auth_error("Anthropic sign-in expired; sign in again", true));
        }
        let refreshed = lease_is_short(&before, (self.parts.clock)(), lease_ms);
        if refreshed {
            self.refresh_for(Attempt::of(&before), false, Some(lease_ms)).await?;
        }
        let after = self.stored().await?;
        let remaining_ms = after.expires_at.saturating_sub((self.parts.clock)());
        if remaining_ms < lease_ms {
            return Err(auth_error(
                &format!("Anthropic OAuth cannot satisfy the {}s credential lease (provider granted {}s)", lease_ms.div_ceil(1000), remaining_ms / 1000),
                false,
            ));
        }
        Ok(LeaseOutcome { expires_at: after.expires_at, remaining_ms, refreshed })
    }
}

// Login

/// The provider side of the shared PKCE login: the authorize URL and the code
/// exchange that writes the credential. Run it with
/// [`PkceLoginFlow`](crate::oauth::PkceLoginFlow).
pub struct AnthropicLogin {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    token_url: String,
    cli_version: Option<Arc<super::ClaudeClientVersion>>,
    /// The state of the authorize URL last built; the token request repeats it.
    state: Mutex<String>,
}

impl AnthropicLogin {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self { file, http, token_url: TOKEN_URL.to_owned(), cli_version: None, state: Mutex::new(String::new()) }
    }

    pub fn with_token_url(mut self, url: impl Into<String>) -> Self {
        self.token_url = url.into();
        self
    }

    pub fn with_cli_version_source(mut self, version: Arc<super::ClaudeClientVersion>) -> Self {
        self.cli_version = Some(version);
        self
    }
}

async fn token_version(source: Option<&super::ClaudeClientVersion>) -> String {
    let Some(source) = source else { return DEFAULT_CLI_VERSION.to_owned() };
    source.warm().await;
    source.current()
}

const OPERATION: &str = "[anthropic-oauth] token exchange";

impl AnthropicLogin {
    /// The code exchange's token call (`exchangeAuthorizationCode`), keeping what Node's failure page quotes: the
    /// network cause, the endpoint's status with its redacted body (`_tokenEndpointError`), or a malformed answer.
    async fn token_exchange(&self, request: WireRequest, base: &StoredOAuth, secrets: &[&str], version: &str) -> Result<StoredOAuth, Refusal> {
        let failed = |message: String| LoginFailure::Failed { code: "token_exchange_failed".into(), message };
        let unanswered = |error: ProviderError| {
            let text = http::request_failed(OPERATION, &error);
            // Only a request that got no answer is worded by `oauthRequestError` (`anthropic-oauth-credentials.mjs:628`).
            let message = if error.transport.is_some() { text.clone() } else { error.into_message() };
            Refusal { failure: failed(message), detail: Some(text) }
        };
        let response = self.http.send(request, TOKEN_EXCHANGE).await.map_err(unanswered)?;
        let reply = response.read_all().await.map_err(unanswered)?;
        let status = reply.status.unwrap_or(0);
        if !(200..300).contains(&status) {
            let failure = match token_failure(status, &reply.body) {
                TokenFailure::Dead(..) => LoginFailure::Denied,
                TokenFailure::Failed(err) => failed(err.into_message()),
            };
            let detail = endpoint_message(OPERATION, status, &reply.body, secrets, version);
            return Err(Refusal { failure, detail: Some(detail) });
        }
        // `oauthResponseJson`: a body that does not parse is named by its status only.
        let Ok(parsed) = serde_json::from_slice::<Value>(&reply.body) else {
            let text = format!("{OPERATION} returned a malformed response (HTTP {status})");
            return Err(Refusal { failure: failed(text.clone()), detail: Some(text) });
        };
        apply_token_response(base, &parsed, now_ms(), TokenFlow::Login).map_err(|err| Refusal::from(failed(err.into_message())))
    }
}

fn blank_credential() -> StoredOAuth {
    StoredOAuth {
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: 0,
        scopes: Vec::new(),
        reauth_required: None,
        subscription_type: None,
        identity: None,
        extra: Map::new(),
    }
}

#[async_trait]
impl PkceProvider for AnthropicLogin {
    fn redirect(&self) -> crate::oauth::Redirect {
        crate::oauth::redirects::ANTHROPIC
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = request.state.to_owned();
        authorize_url(request.redirect_uri, request.code_challenge, request.state)
    }

    /// The hosted page that shows the code to paste (`OAUTH_MANUAL_REDIRECT_URI`), for a browser that cannot reach the
    /// loopback listener or a listener that could not start.
    fn manual_authorize_url(&self, request: &AuthorizeRequest<'_>) -> Option<String> {
        // The token request repeats this login's state whichever URL the user opened.
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = request.state.to_owned();
        Some(authorize_url(MANUAL_REDIRECT_URI, request.code_challenge, request.state))
    }

    /// `_parseOAuthCodeInput`: a pasted callback URL names the redirect it came from; `code#state` is the hosted page's
    /// code; a bare code belongs to the loopback redirect.
    fn parse_pasted(&self, text: &str, redirect_uri: &str, state: &str) -> Result<(String, String), crate::oauth::CallbackError> {
        use crate::oauth::CallbackError;
        let text = mixdog_js::js_trim(text);
        let pair = |name: &str, url: &Url| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap_or_default();
        let (code, pasted_state, issued_for) = match Url::parse(text).ok().filter(|url| !pair("code", url).is_empty() || !pair("state", url).is_empty()) {
            Some(url) => (pair("code", &url), pair("state", &url), format!("{}{}", url.origin().ascii_serialization(), url.path())),
            None => {
                let (code, pasted_state) = text.split_once('#').unwrap_or((text, ""));
                let issued_for = if pasted_state.is_empty() { redirect_uri } else { MANUAL_REDIRECT_URI };
                (code.to_owned(), pasted_state.to_owned(), issued_for.to_owned())
            }
        };
        if !pasted_state.is_empty() && pasted_state != state {
            return Err(CallbackError::StateMismatch);
        }
        if code.trim().is_empty() {
            return Err(CallbackError::Malformed);
        }
        Ok((code, issued_for))
    }

    fn callback_pages(&self) -> CallbackPages {
        pages::ANTHROPIC
    }

    async fn exchange_checked(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Option<String>, Refusal> {
        let code = code.trim();
        if code.is_empty() {
            return Err(LoginFailure::Failed { code: "invalid_callback".into(), message: "[anthropic-oauth] authorization code is required".into() }.into());
        }
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let version = token_version(self.cli_version.as_deref()).await;
        let request = exchange_request(&self.token_url, code, redirect_uri, verifier, &state, &version);
        // A fresh sign-in replaces the tokens and the account but keeps the
        // plan and any unknown fields of the stored credential.
        let existing = load_stored(&self.file).await.map_err(|e| LoginFailure::Failed { code: "credential_read_failed".into(), message: e.into_message() })?;
        let base = existing.unwrap_or_else(blank_credential);
        let credential = self.token_exchange(request, &base, &[code, verifier, &state], &version).await?;
        self.file.keep(&[&credential.access_token, &credential.refresh_token]);
        self.file
            .save(&Document { oauth: credential })
            .await
            .map_err(|e| LoginFailure::Failed { code: "credential_write_failed".into(), message: e.kind().to_string() })?;
        Ok(None)
    }
}

#[cfg(test)]
mod site_tests {
    use super::*;
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

    /// The refresh that outlives its timer reads as the real Node function did (`sites.anthropicRefresh`): under a bare
    /// `setTimeout` abort, worded by Node's own catch.
    #[tokio::test(start_paused = true)]
    async fn a_refresh_that_outlives_its_timer_reads_as_nodes() {
        let transport = TimingOut::new();
        let request = refresh_request("https://x.test/token", "r", "1.0.0");
        let Err(TokenFailure::Failed(error)) = token_call(transport.as_ref(), request, &blank_credential(), 0, TokenFlow::Refresh, "1.0.0").await else {
            panic!("the token endpoint never answers");
        };
        assert_transport("anthropicRefresh", &transport);
        assert_thrown("anthropicRefresh", &error.message);
    }

    /// The authorization-code exchange is an `AbortSignal.timeout` fetch whose failure Node words itself
    /// (`oauthRequestError`, `sites.anthropicCodeExchange`).
    #[tokio::test(start_paused = true)]
    async fn a_code_exchange_that_outlives_its_timer_reads_as_nodes() {
        use crate::oauth::CredentialIo;
        use crate::transport::site_probe::login_message;

        let dir = tempfile::tempdir().unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("anthropic-oauth.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let transport = TimingOut::new();
        let failure = AnthropicLogin::new(file, transport.clone()).exchange("abc", "v", "http://localhost/cb").await.expect_err("never answers");
        assert_transport("anthropicCodeExchange", &transport);
        assert_thrown("anthropicCodeExchange", login_message(&failure));
    }
}

#[cfg(test)]
mod expiry_tests {
    use super::*;

    /// `_normalizeExpiresAt(oauth.expiresAt ?? oauth.expires_at)`: the snake spelling, seconds and date strings read.
    #[test]
    fn a_stored_expiry_in_another_spelling_or_unit_reads_as_node_reads_it() {
        let read =
            |expiry: &str| -> StoredOAuth { serde_json::from_str(&format!(r#"{{"accessToken":"a","refreshToken":"r",{expiry}}}"#)).expect("a credential") };
        assert_eq!(read(r#""expires_at":1893456000"#).expires_at, 1_893_456_000_000);
        assert_eq!(read(r#""expiresAt":"2030-01-01T00:00:00Z""#).expires_at, 1_893_456_000_000);
        // Both spellings at once (an imported file a refresh then wrote into): Node's `expiresAt` wins, nothing is
        // rejected, and the stale snake key does not travel on.
        let both = read(r#""expiresAt":1893456000000,"expires_at":1"#);
        assert_eq!(both.expires_at, 1_893_456_000_000);
        assert!(both.extra.get("expires_at").is_none());
        assert_eq!(read(r#""expiresAt":null,"expires_at":1893456000"#).expires_at, 1_893_456_000_000);
    }
}

#[cfg(test)]
mod hosted_paste_tests {
    use super::*;
    use crate::oauth::CredentialIo;
    use crate::oauth::PkceLoginFlow;
    use mixdog_core_api::domain::login::LoginFlow;
    use mixdog_core_api::domain::login::LoginInput;
    use mixdog_core_api::domain::login::LoginState;
    use mixdog_core_api::domain::login::LoginTarget;

    struct Recorder(Mutex<Vec<WireRequest>>);

    struct Empty;

    #[async_trait]
    impl crate::transport::BodyStream for Empty {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            None
        }
    }

    #[async_trait]
    impl HttpSend for Recorder {
        async fn send(&self, request: WireRequest, _: crate::transport::Exchange) -> Result<crate::transport::HttpResponse, ProviderError> {
            self.0.lock().unwrap().push(request);
            Ok(crate::transport::HttpResponse { status: 400, headers: vec![], body: Box::new(Empty) })
        }
    }

    /// With the loopback port taken, the hosted page's `code#state` is exchanged with this login's own state and the
    /// hosted redirect: the token request is what the server would check.
    #[tokio::test]
    async fn a_pasted_code_posts_this_logins_state_and_the_hosted_redirect() {
        let _held = tokio::net::TcpListener::bind(("127.0.0.1", 54545)).await;
        let dir = tempfile::tempdir().unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("anthropic-oauth.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let http = Arc::new(Recorder(Mutex::default()));
        let flow = PkceLoginFlow::new(LoginTarget::Provider("anthropic-oauth".into()), Arc::new(AnthropicLogin::new(file, http.clone())));
        let session = flow.start().await.expect("a taken port is not a failed sign-in");
        let LoginState::Authorize { url, .. } = session.started() else { panic!("authorize first") };
        let state = Url::parse(&url).unwrap().query_pairs().find(|(k, _)| k == "state").unwrap().1.into_owned();
        session.provide(LoginInput::AuthorizationCode(format!("the-code#{state}"))).await.unwrap();
        while session.next().await.is_some() {}
        let post = http.0.lock().unwrap()[0].clone();
        let body: Value = serde_json::from_slice(&post.body).unwrap();
        assert_eq!(body["state"], json!(state));
        assert_eq!(body["code"], "the-code");
        assert_eq!(body["redirect_uri"], MANUAL_REDIRECT_URI);
    }
}

#[cfg(test)]
mod grant_tests {
    use super::*;
    use crate::oauth::CredentialIo;
    use crate::oauth::pace::Parked;
    use crate::transport::testing::Once;
    use mixdog_statefile::LockOwner;
    use std::collections::VecDeque;
    use std::path::Path;

    /// A token endpoint that counts the refreshes it is sent and answers one per permit, in script order.
    struct Endpoint {
        replies: Mutex<VecDeque<(u16, &'static str)>>,
        seen: Mutex<usize>,
        /// One permit per refresh that arrived.
        arrived: tokio::sync::Semaphore,
        gate: tokio::sync::Semaphore,
    }

    impl Endpoint {
        fn new(permits: usize, replies: &[(u16, &'static str)]) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.iter().copied().collect()),
                seen: Mutex::new(0),
                arrived: tokio::sync::Semaphore::new(0),
                gate: tokio::sync::Semaphore::new(permits),
            })
        }

        fn seen(&self) -> usize {
            *self.seen.lock().unwrap()
        }
    }

    #[async_trait]
    impl HttpSend for Endpoint {
        async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<crate::transport::HttpResponse, ProviderError> {
            *self.seen.lock().unwrap() += 1;
            self.arrived.add_permits(1);
            self.gate.acquire().await.expect("an open gate").forget();
            let (status, body) = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
            Ok(crate::transport::HttpResponse { status, headers: Vec::new(), body: Box::new(Once(Some(bytes::Bytes::from(body)))) })
        }
    }

    const DEAD: (u16, &str) = (400, r#"{"error":"invalid_grant"}"#);

    #[allow(clippy::disallowed_methods, reason = "test-only seeding of a credential file")]
    fn store(path: &Path, access: &str, refresh: &str, expires_at: u64, identity: Option<Value>) {
        let oauth = StoredOAuth { access_token: access.into(), refresh_token: refresh.into(), expires_at, identity, ..blank_credential() };
        std::fs::write(path, serde_json::to_vec(&Document { oauth }).unwrap()).unwrap();
    }

    fn file(dir: &tempfile::TempDir) -> CredentialFile {
        let rt = mixdog_rt::testing::tokens();
        CredentialFile::new(dir.path().join("anthropic-oauth-credentials.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io })
    }

    const FAR: u64 = 4_000_000_000_000;

    /// An attempt goes out on one login; the slot is then rewritten with the same bearer under another refresh grant (or
    /// the same pair for an account the attempt did not name), and the attempt is refused. The login stored now is
    /// returned as it is: its grant is not spent and it is not marked as needing a sign-in, though the endpoint would
    /// refuse it.
    #[tokio::test]
    async fn a_rejection_does_not_refresh_or_mark_a_login_stored_since_its_attempt() {
        for (refresh, identity) in [("r2", None), ("r1", Some(json!({ "id": "another-account" })))] {
            let dir = tempfile::tempdir().unwrap();
            let file = file(&dir);
            store(file.path(), "a", "r1", FAR, None);
            let endpoint = Endpoint::new(1, &[DEAD]);
            let session = OAuthSession::new(file.clone(), endpoint.clone());
            let attempt = session.attempt().await.expect("the first login");
            store(file.path(), "a", refresh, FAR, identity.clone());
            let next = session.after_rejection(&attempt).await.expect("the login stored now");
            assert_eq!(next.access_token, "a");
            assert_eq!(endpoint.seen(), 0, "the new login's grant was spent for the old attempt ({refresh})");
            let stored = session.stored().await.unwrap();
            assert_eq!((stored.refresh_token.as_str(), stored.reauth_required, stored.identity), (refresh, None, identity));
            // The attempt the new login serves is refreshed on its own rejection.
            assert!(session.after_rejection(&next).await.is_err_and(|error| error.reauth_required));
            assert_eq!(endpoint.seen(), 1);
        }
    }

    /// Two processes hold the same expiring login and refresh it at once, by the two routes to its file: one handle
    /// follows the selected account to the file, the other is bound to it. The second finds the first one's lease taken
    /// and waits; it then reads the pair the first stored and returns it: the grant is spent once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_routes_to_one_file_refreshing_one_grant_spend_it_once() {
        use futures::FutureExt;

        let dir = tempfile::tempdir().unwrap();
        let bound = file(&dir);
        let selected = bound.path().to_path_buf();
        let rt = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: rt.interactive_io, write: rt.durability_io };
        let following = CredentialFile::new(dir.path().join("default.json"), io).following(Arc::new(move || {
            let selected = selected.clone();
            async move { selected }.boxed()
        }));
        store(bound.path(), "a", "r1", now_ms() + 1_000, None);
        let endpoint = Endpoint::new(0, &[(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#), DEAD]);
        let held = Attempt::of(&load_stored(&bound).await.unwrap().unwrap());
        let parked = Arc::new(Parked::new());

        let session = OAuthSession::new(following, endpoint.clone());
        let first = tokio::spawn({
            let held = held.clone();
            async move { session.refresh_for(held, false, None).await }
        });
        endpoint.arrived.acquire().await.unwrap().forget();
        let mut contender = OAuthSession::new(bound.clone(), endpoint.clone()).parts;
        contender.process = Arc::new(LockProcess::new(LockOwner::another_in_process()));
        contender.pace = parked.clone();
        let second = tokio::spawn(contender.refresh(bound.clone(), held, false, None));
        // Whichever comes first: the contender waiting for the lease, or its own exchange reaching the endpoint.
        let waited = tokio::select! {
            _ = parked.waiting.acquire() => true,
            _ = endpoint.arrived.acquire() => false,
        };
        assert!(waited, "the second route entered the exchange while the first one's was in flight");
        endpoint.gate.add_permits(2);
        assert_eq!(first.await.unwrap().map(|next| next.access_token).unwrap(), "a2");
        parked.go.add_permits(1_000);
        assert_eq!(second.await.unwrap().map(|next| next.access_token).unwrap(), "a2", "the second route adopts the stored pair");
        assert_eq!(endpoint.seen(), 1);
        assert_eq!(load_stored(&bound).await.unwrap().unwrap().refresh_token, "r2");
    }

    /// A sign-in stores the same token pair for another account while the exchange is at the endpoint. Neither the
    /// refreshed pair nor a refusal's mark is written over it: the login stored now is returned as it is.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refresh_does_not_write_over_the_same_pair_stored_for_another_account() {
        for reply in [(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#), DEAD] {
            let dir = tempfile::tempdir().unwrap();
            let file = file(&dir);
            let expiry = now_ms() + 1_000;
            store(file.path(), "a", "r1", expiry, None);
            let endpoint = Endpoint::new(0, &[reply]);
            let session = Arc::new(OAuthSession::new(file.clone(), endpoint.clone()));
            let refreshing = tokio::spawn({
                let session = session.clone();
                async move { session.attempt().await }
            });
            endpoint.arrived.acquire().await.unwrap().forget();
            let other = json!({ "id": "another-account" });
            store(file.path(), "a", "r1", expiry, Some(other.clone()));
            endpoint.gate.add_permits(1);
            let next = refreshing.await.unwrap().map(|next| next.access_token);
            assert_eq!(next.unwrap(), "a", "the login stored now ({})", reply.0);
            let stored = load_stored(&file).await.unwrap().unwrap();
            assert_eq!((stored.access_token.as_str(), stored.refresh_token.as_str(), stored.reauth_required), ("a", "r1", None), "{}", reply.0);
            assert_eq!(stored.identity, Some(other), "{}", reply.0);
        }
    }
}
