//! Anthropic subscription OAuth: the credential document (`claudeAiOauth`),
//! the token endpoint requests, and the single-flight refresh. The credential
//! file, the HTTP exchange, refresh-failure classification and the PKCE login
//! flow are the shared plumbing's ([`CredentialFile`], [`HttpSend`],
//! [`PkceProvider`]); this module supplies only Anthropic's URLs, client id and
//! token bodies.

use crate::transport::deadlines::TOKEN_ANTHROPIC_REFRESH;
use crate::transport::deadlines::TOKEN_EXCHANGE;
use crate::transport::link::Surface;
use crate::transport::link::deadline_error;
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
use crate::oauth::PkceProvider;
use crate::oauth::Probe;
use crate::oauth::RefreshFailure;
use crate::oauth::Refusal;
use crate::oauth::classify_refresh_failure;
use crate::oauth::http;
use crate::oauth::pages;
use crate::oauth::scrub::oauth_body_summary;
use crate::transport::http::HttpSend;

use super::codec::DEFAULT_CLI_VERSION;

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const SCOPES: [&str; 6] = [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
/// A token that expires within this window is refreshed before use.
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;

/// `claudeAiOauth` of `anthropic-oauth-credentials.json`; unknown fields are
/// kept so a rewrite never drops them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

impl StoredOAuth {
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at != 0 && self.expires_at <= now_ms + REFRESH_SKEW_MS
    }

    pub fn is_enterprise(&self) -> bool {
        self.subscription_type
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case("enterprise"))
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

/// The access+refresh pair a refresh started from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
}

impl From<&StoredOAuth> for TokenPair {
    fn from(stored: &StoredOAuth) -> Self {
        Self {
            access_token: stored.access_token.clone(),
            refresh_token: stored.refresh_token.clone(),
        }
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
async fn load_stored(file: &CredentialFile) -> Result<Option<StoredOAuth>, ProviderError> {
    match file.load::<Document>().await {
        Probe::Present(document) => Ok(Some(document.oauth)),
        Probe::Absent => Ok(None),
        Probe::Unreadable => Err(file_error(&"unreadable")),
    }
}

/// Writes `next` only if the stored pair still equals `from`; returns whether
/// it was written. Another process may have refreshed meanwhile.
async fn publish(file: &CredentialFile, from: &TokenPair, next: &StoredOAuth) -> Result<bool, ProviderError> {
    let expected = from.clone();
    let mut update = Map::new();
    update.insert(
        DOCUMENT_KEY.to_owned(),
        serde_json::to_value(next).map_err(|e| file_error(&e))?,
    );
    file.replace_if(
        move |document| {
            document.get(DOCUMENT_KEY).is_some_and(|stored| {
                stored.get("accessToken").and_then(Value::as_str) == Some(expected.access_token.as_str())
                    && stored.get("refreshToken").and_then(Value::as_str)
                        == Some(expected.refresh_token.as_str())
            })
        },
        update,
    )
    .await
    .map_err(|e| file_error(&e))
}

/// Marks the stored grant dead; tokens stay intact.
async fn mark_reauth_required(file: &CredentialFile, stored: &StoredOAuth) -> Result<(), ProviderError> {
    let mut dead = stored.clone();
    dead.reauth_required = Some(true);
    publish(file, &TokenPair::from(stored), &dead).await.map(drop)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn auth_error(message: &str, reauth_required: bool) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = reauth_required;
    err.message = message.to_owned();
    err
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

fn token_request(url: &str, body: Value, cli_version: &str) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()),
            ("user-agent".to_owned(), format!("claude-cli/{cli_version} (external, sdk-cli)")),
        ],
        body: serde_json::to_vec(&body).unwrap_or_default(),
    }
}

pub fn refresh_request(url: &str, refresh_token: &str, cli_version: &str) -> WireRequest {
    token_request(
        url,
        json!({ "grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": CLIENT_ID }),
        cli_version,
    )
}

pub fn exchange_request(
    url: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
    state: &str,
    cli_version: &str,
) -> WireRequest {
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
enum TokenFailure {
    /// The grant is dead: the user must sign in again.
    Dead,
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
    response
        .get("expires_in")
        .and_then(Value::as_f64)
        .map_or(0, |secs| (now_ms as f64 + secs * 1000.0).max(0.0) as u64)
}

/// The account the token endpoint names next to the tokens
/// (`account.uuid`, `account.email_address`, `organization.uuid`); it counts
/// only with an id or an email.
fn token_identity(response: &Value) -> Option<Value> {
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(|s| s.trim().chars().take(200).collect::<String>())
            .filter(|s| !s.is_empty())
    };
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
pub fn apply_token_response(
    previous: &StoredOAuth,
    response: &Value,
    now_ms: u64,
    flow: TokenFlow,
) -> Result<StoredOAuth, ProviderError> {
    let field = |snake: &str, camel: &str| {
        response
            .get(snake)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .or_else(|| response.get(camel))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let access = field("access_token", "accessToken")
        .ok_or_else(|| auth_error("token response is missing access_token", false))?;
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
        (Some(Value::String(text)), TokenFlow::Login) => {
            text.split(' ').filter(|p| !p.is_empty()).map(str::to_owned).collect()
        }
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

fn token_failure(status: u16, body: &[u8]) -> TokenFailure {
    let kind = match classify_refresh_failure(Some(status), body) {
        RefreshFailure::Definitive => return TokenFailure::Dead,
        RefreshFailure::Transient => ErrorKind::Transient,
        RefreshFailure::Unknown => ErrorKind::Auth,
    };
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = Some(status);
    err.message = format!("Anthropic OAuth token endpoint {status}");
    TokenFailure::Failed(err)
}

/// One POST to the token endpoint and its parse into the credential that
/// replaces `previous`.
async fn token_call(
    http: &dyn HttpSend,
    request: WireRequest,
    previous: &StoredOAuth,
    now: u64,
    flow: TokenFlow,
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
        return Err(token_failure(status, &reply.body));
    }
    let parsed: Value = serde_json::from_slice(&reply.body).unwrap_or(Value::Null);
    apply_token_response(previous, &parsed, now, flow).map_err(TokenFailure::Failed)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// What one refresh needs, cloneable into the shared flight.
#[derive(Clone)]
struct RefreshParts {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    token_url: String,
    cli_version: String,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl RefreshParts {
    async fn stored(&self) -> Result<StoredOAuth, ProviderError> {
        match load_stored(&self.file).await? {
            Some(stored) if !stored.access_token.is_empty() => Ok(stored),
            _ => Err(auth_error("Anthropic OAuth credentials not found; sign in again", true)),
        }
    }

    /// `lease_ms`: refresh unless the token outlasts that window (`preflightAnthropicOAuthCredentials`), instead
    /// of the usual skew.
    async fn refresh(self, rejected: Option<String>, lease_ms: Option<u64>) -> Result<String, ProviderError> {
        // Reload first: another process may already have rotated the pair.
        let stored = self.stored().await?;
        let now = (self.clock)();
        let current = match (&rejected, lease_ms) {
            (Some(token), _) => stored.access_token != *token,
            (None, Some(lease)) => !lease_is_short(&stored, now, lease),
            (None, None) => !stored.needs_refresh(now),
        };
        if current {
            return Ok(stored.access_token);
        }
        if stored.refresh_token.is_empty() {
            return Err(auth_error("Anthropic OAuth refresh token is unavailable", true));
        }
        let request = refresh_request(&self.token_url, &stored.refresh_token, &self.cli_version);
        match token_call(self.http.as_ref(), request, &stored, now, TokenFlow::Refresh).await {
            Ok(next) => {
                let access = next.access_token.clone();
                if !publish(&self.file, &TokenPair::from(&stored), &next).await? {
                    // Someone else published first: their pair is the truth.
                    return Ok(self.stored().await?.access_token);
                }
                Ok(access)
            }
            Err(TokenFailure::Dead) => {
                // A rotation by another process may have replaced the pair.
                let latest = self.stored().await?;
                if latest.refresh_token != stored.refresh_token {
                    return Ok(latest.access_token);
                }
                mark_reauth_required(&self.file, &stored).await?;
                Err(auth_error("Anthropic sign-in expired; sign in again", true))
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
                cli_version: DEFAULT_CLI_VERSION.to_owned(),
                clock: Arc::new(now_ms),
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
        self.parts.cli_version = version.into();
        self
    }

    pub async fn stored(&self) -> Result<StoredOAuth, ProviderError> {
        self.parts.stored().await
    }

    /// Names the account: the credential file it signs in from.
    pub fn account(&self) -> String {
        self.parts.file.path().display().to_string()
    }

    /// A usable access token, refreshing first when it is near expiry.
    pub async fn access_token(&self) -> Result<String, ProviderError> {
        let stored = self.stored().await?;
        if stored.reauth_required == Some(true) {
            return Err(auth_error("Anthropic sign-in expired; sign in again", true));
        }
        if !stored.needs_refresh((self.parts.clock)()) {
            return Ok(stored.access_token);
        }
        self.refresh(None).await
    }

    /// A token after the server rejected `rejected`: refreshes unless another
    /// caller already replaced it.
    pub async fn token_after_rejection(&self, rejected: &str) -> Result<String, ProviderError> {
        self.refresh(Some(rejected.to_owned())).await
    }

    async fn refresh(&self, rejected: Option<String>) -> Result<String, ProviderError> {
        self.refresh_for(rejected, None).await
    }

    async fn refresh_for(&self, rejected: Option<String>, lease_ms: Option<u64>) -> Result<String, ProviderError> {
        let parts = self.parts.clone();
        self.parts
            .file
            .refresh_once(async move { parts.refresh(rejected, lease_ms).await })
            .await
            .unwrap_or_else(|expired| Err(deadline_error(expired, DeliveryState::Ambiguous, Surface::Socket)))
    }

    /// `preflightAnthropicOAuthCredentials`: refreshes the credential now unless its access token lasts at least
    /// `lease_ms` more (no recorded expiry counts as short), whatever the usual skew says; the refreshed pair is
    /// persisted before this returns. Errors when signed out, when the grant is dead, or when the endpoint grants less
    /// than the lease. Returns the persisted credential's expiry (epoch ms) and whether a refresh ran.
    pub async fn ensure_lease(&self, lease_ms: u64) -> Result<LeaseOutcome, ProviderError> {
        let before = self.stored().await?;
        if before.reauth_required == Some(true) {
            return Err(auth_error("Anthropic sign-in expired; sign in again", true));
        }
        let refreshed = lease_is_short(&before, (self.parts.clock)(), lease_ms);
        if refreshed {
            self.refresh_for(None, Some(lease_ms)).await?;
        }
        let after = self.stored().await?;
        let remaining_ms = after.expires_at.saturating_sub((self.parts.clock)());
        if remaining_ms < lease_ms {
            return Err(auth_error(&format!("Anthropic OAuth cannot satisfy the {}s credential lease (provider granted {}s)", lease_ms.div_ceil(1000), remaining_ms / 1000), false));
        }
        Ok(LeaseOutcome { expires_at: after.expires_at, remaining_ms, refreshed })
    }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/// The provider side of the shared PKCE login: the authorize URL and the code
/// exchange that writes the credential. Run it with
/// [`PkceLoginFlow`](crate::oauth::PkceLoginFlow).
pub struct AnthropicLogin {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    token_url: String,
    cli_version: String,
    /// The state of the authorize URL last built; the token request repeats it.
    state: Mutex<String>,
}

impl AnthropicLogin {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self {
            file,
            http,
            token_url: TOKEN_URL.to_owned(),
            cli_version: DEFAULT_CLI_VERSION.to_owned(),
            state: Mutex::new(String::new()),
        }
    }

    pub fn with_token_url(mut self, url: impl Into<String>) -> Self {
        self.token_url = url.into();
        self
    }
}

const OPERATION: &str = "[anthropic-oauth] token exchange";

impl AnthropicLogin {
    /// The code exchange's token call (`exchangeAuthorizationCode`), keeping what Node's failure page quotes: the
    /// network cause, the endpoint's status with its redacted body (`_tokenEndpointError`), or a malformed answer.
    async fn token_exchange(
        &self,
        request: WireRequest,
        base: &StoredOAuth,
        secrets: &[&str],
    ) -> Result<StoredOAuth, Refusal> {
        let failed = |message: String| LoginFailure::Failed { code: "token_exchange_failed".into(), message };
        let unanswered = |error: ProviderError| {
            let text = http::request_failed(OPERATION, &error);
            // Only a request that got no answer is worded by `oauthRequestError` (`anthropic-oauth-credentials.mjs:628`).
            let message = if error.transport.is_some() { text.clone() } else { error.message };
            Refusal { failure: failed(message), detail: Some(text) }
        };
        let response = self.http.send(request, TOKEN_EXCHANGE).await.map_err(unanswered)?;
        let reply = response.read_all().await.map_err(unanswered)?;
        let status = reply.status.unwrap_or(0);
        if !(200..300).contains(&status) {
            let summary = oauth_body_summary(&String::from_utf8_lossy(&reply.body), secrets);
            let body = if summary.is_empty() { String::new() } else { format!(": {summary}") };
            let compatibility = if status == 403 {
                format!(
                    " Anthropic returned HTTP 403 for a request sent as claude-cli/{}. Possible causes include OAuth client compatibility, account or scope policy, an intercepting proxy/VPN/WAF, or regional endpoint restrictions. Verify the account has Claude Code access and the required scopes; update Mixdog or set MIXDOG_CLI_VERSION to the installed official Claude Code version; then retry sign-in via /providers without an intercepting network layer if applicable.",
                    self.cli_version
                )
            } else {
                String::new()
            };
            let failure = match token_failure(status, &reply.body) {
                TokenFailure::Dead => LoginFailure::Denied,
                TokenFailure::Failed(err) => failed(err.message),
            };
            return Err(Refusal { failure, detail: Some(format!("{OPERATION} {status}{body}.{compatibility}")) });
        }
        // `oauthResponseJson`: a body that does not parse is named by its status only.
        let Ok(parsed) = serde_json::from_slice::<Value>(&reply.body) else {
            let text = format!("{OPERATION} returned a malformed response (HTTP {status})");
            return Err(Refusal { failure: failed(text.clone()), detail: Some(text) });
        };
        apply_token_response(base, &parsed, now_ms(), TokenFlow::Login)
            .map_err(|err| Refusal::from(failed(err.message)))
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

    fn callback_pages(&self) -> CallbackPages {
        pages::ANTHROPIC
    }

    async fn exchange_checked(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<Option<String>, Refusal> {
        let code = code.trim();
        if code.is_empty() {
            return Err(LoginFailure::Failed {
                code: "invalid_callback".into(),
                message: "[anthropic-oauth] authorization code is required".into(),
            }
            .into());
        }
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let request = exchange_request(&self.token_url, code, redirect_uri, verifier, &state, &self.cli_version);
        // A fresh sign-in replaces the tokens and the account but keeps the
        // plan and any unknown fields of the stored credential.
        let existing = load_stored(&self.file).await.map_err(|e| LoginFailure::Failed {
            code: "credential_read_failed".into(),
            message: e.message,
        })?;
        let base = existing.unwrap_or_else(blank_credential);
        let credential = self.token_exchange(request, &base, &[code, verifier, &state]).await?;
        self.file
            .save(&Document { oauth: credential })
            .await
            .map_err(|e| LoginFailure::Failed {
                code: "credential_write_failed".into(),
                message: e.kind().to_string(),
            })?;
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
        let Err(TokenFailure::Failed(error)) = token_call(transport.as_ref(), request, &blank_credential(), 0, TokenFlow::Refresh).await else {
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

