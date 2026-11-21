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
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::login::LoginFailure;
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
use crate::oauth::lease::LockProcess;
use crate::oauth::lease::REFRESH_LEASE;
use crate::oauth::lease::lease_error;
use crate::oauth::lease::refresh_lock_path;
use crate::oauth::pace::Pace;
use crate::oauth::pace::SystemPace;
use crate::oauth::pages;
use crate::oauth::scrub::oauth_body_summary;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::provider_error;
use crate::providers::connect::rewrite::Attempt;
use crate::providers::connect::rewrite::Credential;
use crate::providers::connect::rewrite::Recovered;
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
#[serde(from = "StoredDocument")]
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

/// The stored document as it reads: `_normalizeExpiresAt(raw.expires_at ?? raw.expiresAt)`; it is written back with
/// `expires_at` only (Node's `saveTokens`), and a stale `expiresAt` left in the file loses to it.
#[derive(Deserialize)]
struct StoredDocument {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_at: Option<Value>,
    #[serde(default, rename = "expiresAt")]
    expires_at_camel: Option<Value>,
    #[serde(default, deserialize_with = "null_as_default")]
    token_endpoint: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    principal_type: String,
    #[serde(default)]
    principal_id: String,
    #[serde(default)]
    email: String,
}

impl From<StoredDocument> for StoredTokens {
    fn from(document: StoredDocument) -> Self {
        Self {
            access_token: document.access_token,
            refresh_token: document.refresh_token,
            expires_at: crate::accounts::validity::stated_expiry(document.expires_at, document.expires_at_camel),
            token_endpoint: document.token_endpoint,
            user_id: document.user_id,
            principal_type: document.principal_type,
            principal_id: document.principal_id,
            email: document.email,
        }
    }
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

    /// Whether `other` is this generation of the sign-in: the same access token under the same refresh token.
    fn same_login(&self, other: &Self) -> bool {
        self.access_token == other.access_token && self.refresh_token == other.refresh_token
    }

    /// Still usable at `now`: no expiry, or one after it (`ensureAuth`'s grace test).
    fn unexpired_at(&self, now: u64) -> bool {
        self.expires_at == 0 || self.expires_at > now
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
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

/// `decodeJwtPayload`: the object the middle of a three-part token decodes to, else none.
fn jwt_payload(token: &str) -> Option<serde_json::Map<String, Value>> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    // `Buffer.from(part, 'base64')` reads either alphabet and ignores padding.
    let part: String = parts[1]
        .chars()
        .filter(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    let bytes = URL_SAFE_NO_PAD.decode(part).ok()?;
    match serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()? {
        Value::Object(payload) => Some(payload),
        _ => None,
    }
}

/// `emailFromJwts(...tokens)`: the first token's non-blank `email` claim, trimmed.
pub(super) fn email_from_jwts(tokens: &[&str]) -> Option<String> {
    tokens.iter().find_map(|token| {
        let email = jwt_payload(token)?.get("email")?.as_str()?.trim().to_owned();
        (!email.is_empty()).then_some(email)
    })
}

/// `_identityFromAccessToken`: the account a token's claims name.
#[derive(Default)]
pub(super) struct Identity {
    pub(super) user_id: String,
    pub(super) principal_type: String,
    pub(super) principal_id: String,
}

pub(super) fn identity_of(token: &str) -> Identity {
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
pub(super) fn saved_document(tokens: &StoredTokens) -> serde_json::Map<String, Value> {
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

fn is_invalid_grant(error: &ProviderError) -> bool {
    error.reauth_required && error.code.as_deref() == Some("invalid_grant")
}

/// What a credential file holds at one read.
enum Stored {
    /// A sign-in that decodes, with both tokens.
    Tokens(StoredTokens),
    /// The file is gone, or reads and holds no sign-in (one of its two tokens is missing or empty).
    SignedOut,
    /// The file cannot be read now, or holds a sign-in that does not decode: no evidence of a sign-out.
    Unreadable,
}

/// What `file` says now; the one place its three states are told apart.
async fn stored_in(file: &CredentialFile) -> Stored {
    let document = match file.load_document().await {
        Probe::Present(document) => document,
        Probe::Absent => return Stored::SignedOut,
        Probe::Unreadable => return Stored::Unreadable,
    };
    let holds = |token: &str| document.get(token).and_then(Value::as_str).is_some_and(|text| !text.is_empty());
    if !(holds("access_token") && holds("refresh_token")) {
        return Stored::SignedOut;
    }
    match serde_json::from_value::<StoredTokens>(Value::Object(document)) {
        Ok(tokens) => {
            file.keep(&[&tokens.access_token, &tokens.refresh_token]);
            Stored::Tokens(tokens)
        }
        Err(_) => Stored::Unreadable,
    }
}

/// `_normalizeExpiresAt(raw.expires_at ?? raw.expiresAt) || expiryFromAccessToken(raw.access_token)`.
fn with_claimed_expiry(mut tokens: StoredTokens) -> StoredTokens {
    tokens.expires_at = crate::accounts::validity::expiry_or_claim(tokens.expires_at, &tokens.access_token);
    tokens
}

/// How a refresh that did not fail ended.
#[derive(Clone)]
enum Refreshed {
    /// The tokens this refresh's own exchange produced and stored.
    Tokens(StoredTokens),
    /// The file holds another generation than the one this refresh was started for, and nothing was exchanged: it was
    /// left as it is, whatever its expiry. Each send that shared the refresh reads it against its own attempt: it is
    /// what a refused send goes out on unless it is the very generation that send was refused on, which is then
    /// refreshed for it; an ordinary send treats it as any login read from the file.
    Replaced(StoredTokens),
    /// The file was found signed out, by the read at the start of the lease or by the one after an exchange whose
    /// write the file declined. Every send joined to the refresh gets this, and none goes out on a held token.
    SignedOut,
}

/// One exchange that produced nothing.
enum Unrefreshed {
    /// The exchange or its write failed: another may follow.
    Exchange(ProviderError),
    /// The exchange was made, its write declined, and what the file holds instead cannot be read. The refresh token is
    /// spent: no other exchange follows.
    Unread(ProviderError),
}

type SharedRefresh = futures::future::Shared<futures::future::BoxFuture<'static, Result<Refreshed, ProviderError>>>;

/// Which refresh a flight is: the credential file and the refresh token it exchanges. A login that replaced the file holds
/// another refresh token, so it never joins (and is never handed the tokens of) the previous login's refresh.
type FlightKey = (std::path::PathBuf, String);

/// What the Grok credentials of one process share: the process as the lease's lock protocol sees it, and the refresh
/// in flight per credential (`_refreshesInFlight`, `grok-oauth-tokens.mjs:313`), shared by every send of the
/// process that needs one while it runs and gone once it settled.
pub struct RefreshProcess {
    lock: Arc<LockProcess>,
    flights: std::sync::Mutex<std::collections::HashMap<FlightKey, (u64, SharedRefresh)>>,
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

    fn flights(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<FlightKey, (u64, SharedRefresh)>> {
        self.flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
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

/// `EXPIRED_TOKEN_CODES` (`grok-oauth.mjs:53`): the typed codes that say the bearer itself expired or was revoked.
const EXPIRED_TOKEN_CODES: [&str; 6] = ["token_expired", "expired_token", "access_token_expired", "token_revoked", "revoked_token", "invalid_token"];

/// `hasExpiredTokenSignature`: the refusal's error object names one of [`EXPIRED_TOKEN_CODES`] as its `code` or `type`
/// (the fields Node's client lifts from the body's `error`), trimmed and lower-cased.
fn has_expired_token_signature(body: &[u8]) -> bool {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let error = &parsed["error"];
    ["code", "type"]
        .iter()
        .any(|field| error.get(field).and_then(Value::as_str).is_some_and(|text| EXPIRED_TOKEN_CODES.contains(&text.trim().to_lowercase().as_str())))
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
    pub fn new(http: Arc<dyn HttpSend>, file: CredentialFile, authorization_endpoint: &str, token_endpoint: &str) -> Result<Self, ProviderError> {
        Ok(Self { http, file, authorization_endpoint: trusted_xai_endpoint(authorization_endpoint)?, token_endpoint: trusted_xai_endpoint(token_endpoint)? })
    }
}

fn failed(code: &str, message: String) -> LoginFailure {
    LoginFailure::Failed { code: code.to_owned(), message }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `raw.expires_at ?? raw.expiresAt`: both spellings present is read, with `expires_at` first.
    #[test]
    fn a_document_with_both_expiry_spellings_reads_with_nodes_precedence() {
        let read = |extra: &str| serde_json::from_str::<StoredTokens>(&format!(r#"{{"access_token":"a","refresh_token":"r",{extra}}}"#)).unwrap();
        assert_eq!(read(r#""expires_at":1893456000000,"expiresAt":1"#).expires_at, 1_893_456_000_000);
        assert_eq!(read(r#""expiresAt":1893456000"#).expires_at, 1_893_456_000_000);
    }

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
        let t = StoredTokens { refresh_token: "r&1".into(), principal_type: "user".into(), ..StoredTokens::default() };
        assert_eq!(refresh_form(&t), format!("grant_type=refresh_token&client_id={CLIENT_ID}&refresh_token=r%261&principal_type=user"));
    }

    /// `expiring = expires_at < now + TOKEN_REFRESH_SKEW_MS` (`grok-oauth.mjs:392`): an expiry exactly at the margin is
    /// not due, one a millisecond inside it is.
    #[test]
    fn expiry_is_due_inside_the_skew() {
        let t = StoredTokens { expires_at: 1_000_000, ..StoredTokens::default() };
        assert!(!t.needs_refresh(1_000_000 - REFRESH_SKEW_MS));
        assert!(t.needs_refresh(1_000_000 - REFRESH_SKEW_MS + 1));
        assert!(!t.needs_refresh(0));
        assert!(!StoredTokens::default().needs_refresh(u64::MAX / 2));
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
        let file = CredentialFile::new(dir.path().join("grok-oauth.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let login = GrokLogin::new(transport.clone(), file, "https://auth.x.ai/authorize", "https://auth.x.ai/oauth2/token").unwrap();
        let failure = login.exchange("abc", "v", "http://127.0.0.1:56121/callback").await.expect_err("the exchange never answers");
        assert_transport("grokCodeExchange", &transport);
        // Node words the exchange's failure itself (`oauthRequestError`), and so does the Rust login.
        assert_thrown("grokCodeExchange", login_message(&failure));
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
    /// One grant-to-tokens step for the PKCE exchange and the device poll: both tokens are required, the expiry counts from
    /// now, and the identity the grant does not name comes from the access token's claims.
    #[test]
    fn a_grant_becomes_tokens_with_the_identity_of_its_access_token() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"sub":"u-1","principal_type":"user","principal_id":"p-1","email":"a@x.ai"}"#);
        let access = format!("h.{claims}.s");
        let grant = serde_json::json!({ "access_token": access, "refresh_token": "r", "expires_in": 60, "principal_id": "" });
        let tokens = tokens_from_grant(&grant, "https://auth.x.ai/oauth2/token", 1_000).unwrap();
        assert_eq!(tokens.expires_at, 61_000);
        assert_eq!((tokens.user_id.as_str(), tokens.principal_type.as_str(), tokens.principal_id.as_str()), ("p-1", "user", "p-1"));
        assert_eq!(tokens.email, "a@x.ai");
        let missing = serde_json::json!({ "access_token": "a" });
        assert!(tokens_from_grant(&missing, "https://auth.x.ai/oauth2/token", 0).is_err());
    }

    /// A token endpoint that announces each refresh that arrives and answers one per permit, in script order.
    struct Gated {
        replies: std::sync::Mutex<std::collections::VecDeque<(u16, &'static str)>>,
        seen: std::sync::Mutex<usize>,
        arrived: tokio::sync::Semaphore,
        gate: tokio::sync::Semaphore,
    }

    struct Body(Option<bytes::Bytes>);

    #[async_trait]
    impl crate::transport::BodyStream for Body {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    #[async_trait]
    impl HttpSend for Gated {
        async fn send(&self, request: WireRequest, _: crate::transport::Exchange) -> Result<crate::transport::HttpResponse, ProviderError> {
            // The proxy origin is warmed before a turn; that is not a token request.
            if request.method != "POST" {
                return Ok(crate::transport::HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Body(None)) });
            }
            *self.seen.lock().unwrap() += 1;
            self.arrived.add_permits(1);
            self.gate.acquire().await.expect("an open gate").forget();
            let (status, body) = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
            Ok(crate::transport::HttpResponse { status, headers: Vec::new(), body: Box::new(Body(Some(bytes::Bytes::from(body)))) })
        }
    }

    /// A contender for the lease whose every wait for it is announced and parks until the test lets it go.
    struct Parked {
        waiting: tokio::sync::Semaphore,
        go: tokio::sync::Semaphore,
    }

    #[async_trait]
    impl Pace for Parked {
        fn now_ms(&self) -> u64 {
            now_ms()
        }

        async fn wait(&self, _: std::time::Duration) {
            self.waiting.add_permits(1);
            self.go.acquire().await.expect("an open gate").forget();
        }
    }

    /// Two credentials reach one file, one following the selected account to it and one bound to it, and refresh its
    /// expiring tokens at once. The second finds the first one's lease taken and waits, then adopts the generation the
    /// first stored: the refresh token is spent once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_routes_to_one_file_refreshing_one_token_spend_it_once() {
        use crate::oauth::CredentialIo;
        use futures::FutureExt;

        let dir = tempfile::tempdir().unwrap();
        let slot = dir.path().join("slot.json");
        let stored = serde_json::json!({
            "access_token": "a1",
            "refresh_token": "r1",
            "expires_at": now_ms() + 60_000,
            "token_endpoint": "https://auth.x.ai/oauth2/token",
        });
        std::fs::write(&slot, stored.to_string()).unwrap();
        let rt = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: rt.interactive_io, write: rt.durability_io };
        let selected = slot.clone();
        let following = CredentialFile::new(dir.path().join("grok-oauth.json"), io).following(Arc::new(move || {
            let selected = selected.clone();
            async move { selected }.boxed()
        }));
        let endpoint = Arc::new(Gated {
            replies: std::sync::Mutex::new(
                [(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#), (400, r#"{"error":"invalid_grant"}"#)].into_iter().collect(),
            ),
            seen: std::sync::Mutex::new(0),
            arrived: tokio::sync::Semaphore::new(0),
            gate: tokio::sync::Semaphore::new(0),
        });
        let parked = Arc::new(Parked { waiting: tokio::sync::Semaphore::new(0), go: tokio::sync::Semaphore::new(0) });
        let first = GrokCredential::new(endpoint.clone(), following);
        let mut contender = GrokCredential::new(endpoint.clone(), CredentialFile::new(slot, io)).with_pace(parked.clone());
        contender.process = Arc::new(RefreshProcess::new(Arc::new(LockProcess::new(mixdog_statefile::LockOwner::another_in_process()))));

        let leading = tokio::spawn(async move { first.header().await });
        endpoint.arrived.acquire().await.unwrap().forget();
        let trailing = tokio::spawn(async move { contender.header().await });
        // Whichever comes first: the contender waiting for the lease, or its own exchange reaching the endpoint.
        let waited = tokio::select! {
            _ = parked.waiting.acquire() => true,
            _ = endpoint.arrived.acquire() => false,
        };
        assert!(waited, "the second route entered the exchange while the first one's was in flight");
        endpoint.gate.add_permits(2);
        let bearer = |header: Option<(String, String)>| header.map(|(_, value)| value);
        assert_eq!(bearer(leading.await.unwrap().unwrap()).as_deref(), Some("Bearer a2"));
        parked.go.add_permits(1_000);
        assert_eq!(bearer(trailing.await.unwrap().unwrap()).as_deref(), Some("Bearer a2"), "the second route adopts the stored generation");
        assert_eq!(*endpoint.seen.lock().unwrap(), 1);
    }

    /// The sign-out lands while a refresh of a token still in date is at the endpoint: the file is gone when the answer
    /// comes. That is no outage to coast through: no header is returned, on that call or the next, and the user the
    /// credential served before is forgotten.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sign_out_during_a_refresh_yields_no_header_though_the_token_is_in_date() {
        use crate::oauth::CredentialIo;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grok-oauth.json");
        let stored = |left_ms: u64| {
            serde_json::json!({
                "access_token": "a1",
                "refresh_token": "r1",
                "expires_at": now_ms() + left_ms,
                "token_endpoint": "https://auth.x.ai/oauth2/token",
                "user_id": "user-1",
            })
            .to_string()
        };
        std::fs::write(&path, stored(3_600_000)).unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let endpoint = Arc::new(Gated {
            replies: std::sync::Mutex::new([(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)].into_iter().collect()),
            seen: std::sync::Mutex::new(0),
            arrived: tokio::sync::Semaphore::new(0),
            gate: tokio::sync::Semaphore::new(0),
        });
        let credential = Arc::new(GrokCredential::new(endpoint.clone(), file));
        assert!(credential.header().await.unwrap().is_some_and(|(_, value)| value == "Bearer a1"));
        assert_eq!(credential.user_id().as_deref(), Some("user-1"));

        // The same sign-in, now inside its refresh margin and still a minute from its expiry.
        std::fs::write(&path, stored(60_000)).unwrap();
        let refreshing = tokio::spawn({
            let credential = credential.clone();
            async move { credential.header().await }
        });
        endpoint.arrived.acquire().await.unwrap().forget();
        std::fs::remove_file(&path).unwrap();
        endpoint.gate.add_permits(1);
        let error = refreshing.await.unwrap().expect_err("no header after the sign-out");
        assert!(error.reauth_required && error.message.starts_with("Grok OAuth is not connected"), "{}", error.message);
        assert_eq!(credential.user_id(), None);
        assert!(credential.header().await.is_err(), "nor on the next call");
        assert_eq!(*endpoint.seen.lock().unwrap(), 1);
    }

    fn gated(replies: &[(u16, &'static str)]) -> Arc<Gated> {
        Arc::new(Gated {
            replies: std::sync::Mutex::new(replies.iter().copied().collect()),
            seen: std::sync::Mutex::new(0),
            arrived: tokio::sync::Semaphore::new(0),
            gate: tokio::sync::Semaphore::new(0),
        })
    }

    /// A sign-in of `a1` with `left_ms` to its expiry, and the credential file it is written to.
    fn signed_in(dir: &tempfile::TempDir, left_ms: u64) -> (std::path::PathBuf, CredentialFile) {
        let path = dir.path().join("grok-oauth.json");
        let stored = serde_json::json!({
            "access_token": "a1",
            "refresh_token": "r1",
            "expires_at": now_ms() + left_ms,
            "token_endpoint": "https://auth.x.ai/oauth2/token",
            "user_id": "user-1",
        });
        std::fs::write(&path, stored.to_string()).unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), crate::oauth::CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        (path, file)
    }

    /// A forced refresh is at the endpoint when the sign-out removes the file. The refresh's failure is that sign-out:
    /// the token served before goes with it, so a later read that finds the file unreadable has nothing held to fall
    /// back on and sends no header, though that token is still in date.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sign_out_during_a_forced_refresh_leaves_nothing_held_for_an_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        let (path, file) = signed_in(&dir, 3_600_000);
        let endpoint = gated(&[(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)]);
        let credential = Arc::new(GrokCredential::new(endpoint.clone(), file));
        let sent = credential.attempt().await.unwrap();
        assert!(sent.header.as_ref().is_some_and(|(_, value)| value == "Bearer a1"));

        let refreshing = tokio::spawn({
            let credential = credential.clone();
            async move { credential.after_rejection(&sent).await.map(|next| next.attempt.header) }
        });
        endpoint.arrived.acquire().await.unwrap().forget();
        std::fs::remove_file(&path).unwrap();
        endpoint.gate.add_permits(1);
        let error = refreshing.await.unwrap().expect_err("no header after the sign-out");
        assert!(error.reauth_required && error.message.starts_with("Grok OAuth is not connected"), "{}", error.message);
        assert_eq!(credential.user_id(), None, "the token served before the sign-out is no longer held");

        std::fs::write(&path, "[ half").unwrap();
        let error = credential.header().await.expect_err("an unreadable file brings the signed-out token back");
        assert!(error.message.contains("cannot be read"), "{}", error.message);
        assert_eq!(*endpoint.seen.lock().unwrap(), 1);
    }

    /// A forced refresh is at the endpoint when the sign-out removes the file, and every read after the refresh's own
    /// finds the file unreadable (the credential follows the selected account, which names an unreadable file from the
    /// moment the sign-in is removed; the refresh keeps the file it began with). The refresh saw the sign-out itself:
    /// the forced call fails as signed out, the token served before is dropped with no second read, and the ordinary
    /// call that follows sends no header though that token is still in date.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sign_out_only_the_forced_refresh_saw_still_drops_the_held_token() {
        forced_refresh_alone_sees_the_sign_out((200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)).await;
    }

    /// The same order with the endpoint refusing the grant: the read after the refusal finds the sign-in gone, and the
    /// refresh ends as that sign-out.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_sign_out_seen_after_a_refused_grant_still_drops_the_held_token() {
        forced_refresh_alone_sees_the_sign_out((400, r#"{"error":"invalid_grant"}"#)).await;
    }

    async fn forced_refresh_alone_sees_the_sign_out(reply: (u16, &'static str)) {
        use futures::FutureExt;

        let dir = tempfile::tempdir().unwrap();
        let (signed_in_path, bound) = signed_in(&dir, 3_600_000);
        let unreadable = dir.path().join("unreadable.json");
        std::fs::write(&unreadable, "[ half").unwrap();
        let moved = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rt = mixdog_rt::testing::tokens();
        let io = crate::oauth::CredentialIo { read: rt.interactive_io, write: rt.durability_io };
        let following = CredentialFile::new(dir.path().join("default.json"), io).following(Arc::new({
            let (moved, first, then) = (moved.clone(), signed_in_path.clone(), unreadable);
            move || {
                let path = if moved.load(std::sync::atomic::Ordering::SeqCst) { then.clone() } else { first.clone() };
                async move { path }.boxed()
            }
        }));
        drop(bound);
        let endpoint = gated(&[reply]);
        let credential = Arc::new(GrokCredential::new(endpoint.clone(), following));
        let sent = credential.attempt().await.unwrap();
        assert!(sent.header.as_ref().is_some_and(|(_, value)| value == "Bearer a1"));
        assert_eq!(credential.user_id().as_deref(), Some("user-1"));

        let refreshing = tokio::spawn({
            let credential = credential.clone();
            async move { credential.after_rejection(&sent).await.map(|next| next.attempt.header) }
        });
        endpoint.arrived.acquire().await.unwrap().forget();
        std::fs::remove_file(&signed_in_path).unwrap();
        moved.store(true, std::sync::atomic::Ordering::SeqCst);
        endpoint.gate.add_permits(1);
        let error = refreshing.await.unwrap().expect_err("the forced call fails");
        assert!(error.reauth_required && error.message.starts_with("Grok OAuth is not connected"), "{}", error.message);
        assert_eq!(credential.user_id(), None, "the token served before the sign-out is no longer held");
        let error = credential.header().await.expect_err("the signed-out token is sent again");
        assert!(error.message.contains("cannot be read"), "{}", error.message);
        assert_eq!(*endpoint.seen.lock().unwrap(), 1);
    }

    /// A send on `(a1, r1)` is refused and its refresh waits for the lease another process holds. Meanwhile the same
    /// refresh token is stored under another bearer, a send goes out on that and is refused in its turn: its refresh is
    /// the one already waiting, which then finds the file holding a generation other than the one it was started for
    /// and exchanges nothing. Each send reads that answer against its own attempt: the first goes out on the stored
    /// generation as it is, and the second, refused on that very generation, has it exchanged instead of being handed
    /// its refused bearer back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_send_that_shared_another_generations_refresh_has_its_own_refreshed() {
        let dir = tempfile::tempdir().unwrap();
        let (path, file) = signed_in(&dir, 3_600_000);
        let endpoint = gated(&[(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)]);
        let parked = Arc::new(Parked { waiting: tokio::sync::Semaphore::new(0), go: tokio::sync::Semaphore::new(0) });
        let credential = Arc::new(GrokCredential::new(endpoint.clone(), file.clone()).with_pace(parked.clone()));
        let first = credential.attempt().await.unwrap();

        let (taken, release) = (Arc::new(tokio::sync::Semaphore::new(0)), Arc::new(tokio::sync::Semaphore::new(0)));
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
        let stale = tokio::spawn({
            let credential = credential.clone();
            async move { credential.after_rejection(&first).await }
        });
        parked.waiting.acquire().await.unwrap().forget();

        let rewritten = serde_json::json!({
            "access_token": "b1",
            "refresh_token": "r1",
            "expires_at": now_ms() + 3_600_000,
            "token_endpoint": "https://auth.x.ai/oauth2/token",
        });
        std::fs::write(&path, rewritten.to_string()).unwrap();
        let second = credential.attempt().await.unwrap();
        assert!(second.header.as_ref().is_some_and(|(_, value)| value == "Bearer b1"));
        let mut refused = Box::pin(credential.after_rejection(&second));
        assert!(futures::poll!(refused.as_mut()).is_pending(), "the second refusal shares the refresh already waiting");

        release.add_permits(1);
        parked.go.add_permits(1_000);
        endpoint.gate.add_permits(1);
        assert!(holding.await.unwrap());
        let bearer = |recovered: &Recovered| recovered.attempt.header.clone().map(|(_, value)| value);
        let stale = stale.await.unwrap().unwrap();
        assert_eq!((bearer(&stale).as_deref(), stale.exchanged), (Some("Bearer b1"), false), "the first send goes out on the generation stored now");
        let renewed = refused.await.unwrap();
        assert_eq!((bearer(&renewed).as_deref(), renewed.exchanged), (Some("Bearer a2"), true), "the second send was handed its refused bearer back");
        assert_eq!(*endpoint.seen.lock().unwrap(), 1);
    }

    /// `(a1, r1)` is at the endpoint when a login with another bearer under the same refresh token is stored. Whether
    /// the exchange is granted or refused as a dead grant, the stored login is another one than the exchange was made
    /// for: it stays in the file as it is and is what the send goes out on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_login_stored_under_the_same_refresh_token_during_the_exchange_is_left_intact() {
        for reply in [(200, r#"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#), (400, r#"{"error":"invalid_grant"}"#)] {
            let dir = tempfile::tempdir().unwrap();
            let (path, file) = signed_in(&dir, 60_000);
            let endpoint = gated(&[reply]);
            let credential = Arc::new(GrokCredential::new(endpoint.clone(), file));
            let sending = tokio::spawn({
                let credential = credential.clone();
                async move { credential.header().await }
            });
            endpoint.arrived.acquire().await.unwrap().forget();
            let other = serde_json::json!({
                "access_token": "b1",
                "refresh_token": "r1",
                "expires_at": now_ms() + 3_600_000,
                "token_endpoint": "https://auth.x.ai/oauth2/token",
            });
            std::fs::write(&path, other.to_string()).unwrap();
            endpoint.gate.add_permits(1);
            let header = sending.await.unwrap().unwrap_or_else(|error| panic!("{}: {}", reply.0, error.message));
            assert!(header.is_some_and(|(_, value)| value == "Bearer b1"), "{}: the send goes out on the login stored now", reply.0);
            let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!((&stored["access_token"], &stored["refresh_token"]), (&Value::from("b1"), &Value::from("r1")), "{}", reply.0);
            assert_eq!(*endpoint.seen.lock().unwrap(), 1);
        }
    }

    /// The first send reads a token inside its refresh margin; the refresh fails and the file has become unreadable by
    /// then. An unreadable file is no sign-out: the send goes out on the token it read, though nothing was held before.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_first_send_whose_refresh_fails_over_an_unreadable_file_uses_the_token_it_read() {
        use crate::oauth::pace::FakePace;

        let dir = tempfile::tempdir().unwrap();
        let (path, file) = signed_in(&dir, 60_000);
        let endpoint = gated(&[(503, "busy"), (503, "busy"), (503, "busy")]);
        let pace = Arc::new(FakePace { now: std::sync::atomic::AtomicU64::new(now_ms()), ..FakePace::default() });
        let credential = Arc::new(GrokCredential::new(endpoint.clone(), file).with_pace(pace));
        let sending = tokio::spawn({
            let credential = credential.clone();
            async move { credential.header().await }
        });
        endpoint.arrived.acquire().await.unwrap().forget();
        std::fs::write(&path, "[ half").unwrap();
        endpoint.gate.add_permits(3);
        let header = sending.await.unwrap().expect("the token the send read is still in date");
        assert!(header.is_some_and(|(_, value)| value == "Bearer a1"));
        assert_eq!(*endpoint.seen.lock().unwrap(), 3, "the refresh was tried to its end");
    }
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
    let text = |key: &str, fallback: &str| json.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(fallback).to_owned();
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
/// `tokensFromGrant`: the stored tokens a granted code (the PKCE exchange or the device poll) yields, the identity
/// claims of the access token filling what the grant does not name.
pub(super) fn tokens_from_grant(grant: &Value, token_endpoint: &str, now_ms: u64) -> Result<StoredTokens, LoginFailure> {
    let text = |key: &str| grant.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or_default();
    let (access, refresh) = (text("access_token"), text("refresh_token"));
    if access.is_empty() || refresh.is_empty() {
        return Err(failed("token_exchange", "[grok-oauth] token exchange response missing access_token or refresh_token".to_owned()));
    }
    let identity = identity_of(access);
    let first = |own: &str, claimed: String| if own.is_empty() { claimed } else { own.to_owned() };
    Ok(StoredTokens {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        expires_at: match grant.get("expires_in").and_then(Value::as_f64) {
            Some(seconds) => now_ms + (seconds * 1000.0) as u64,
            None => grant.get("expires_at").and_then(Value::as_u64).unwrap_or(0),
        },
        token_endpoint: token_endpoint.to_owned(),
        user_id: identity.user_id,
        principal_type: first(text("principal_type"), identity.principal_type),
        principal_id: first(text("principal_id"), identity.principal_id),
        email: email_from_jwts(&[text("id_token"), access]).unwrap_or_default(),
    })
}
/// `_postRefresh`: one exchange, its tokens saved over the whole file (`saveTokens`, under the file's write lock) as the
/// same sign-in, and only while the file still holds the generation it exchanged: a sign-in stored meanwhile is not
/// overwritten, and its tokens are the answer. That is the rule, not a leak: the roster row is the identity, as in Node
/// 1.4.5. A file the sign-out emptied meanwhile is a sign-out, and one that cannot be read is a failure, not a sign-out.
async fn post_refresh(http: &dyn HttpSend, pace: &dyn Pace, file: &CredentialFile, tokens: &StoredTokens) -> Result<Refreshed, Unrefreshed> {
    let fresh = refresh(http, pace, tokens).await.map_err(Unrefreshed::Exchange)?;
    file.keep(&[&fresh.access_token, &fresh.refresh_token]);
    let (access, exchanged) = (tokens.access_token.clone(), tokens.refresh_token.clone());
    let written = file
        .replace_refreshed(
            move |stored| {
                let held = |key: &str| stored.get(key).and_then(Value::as_str);
                held("access_token") == Some(access.as_str()) && held("refresh_token") == Some(exchanged.as_str())
            },
            saved_document(&fresh),
        )
        .await
        .map_err(|_| Unrefreshed::Exchange(storage_error("the refreshed tokens could not be stored")))?;
    if written {
        return Ok(Refreshed::Tokens(fresh));
    }
    match stored_in(file).await {
        Stored::Tokens(stored) => Ok(Refreshed::Replaced(with_claimed_expiry(stored))),
        Stored::SignedOut => Ok(Refreshed::SignedOut),
        Stored::Unreadable => Err(Unrefreshed::Unread(storage_error("the credential file cannot be read"))),
    }
}
/// `_postRefreshWithRetry` (`grok-oauth-tokens.mjs:376`): three exchanges (each saved) at most. A terminal refusal
/// (`invalid_grant`, `invalid_client`) ends it at once; between two, a pause of `min(2 s, 200 ms·2^n)` plus up to as
/// much again at random.
async fn refresh_with_retry(http: &dyn HttpSend, pace: &dyn Pace, file: &CredentialFile, tokens: &StoredTokens) -> Result<Refreshed, ProviderError> {
    let mut attempt = 0;
    loop {
        match post_refresh(http, pace, file, tokens).await {
            Ok(ended) => return Ok(ended),
            Err(Unrefreshed::Unread(error)) => return Err(error),
            // `refresh_error` marks exactly the terminal refusals as needing a new sign-in.
            Err(Unrefreshed::Exchange(error)) if error.reauth_required || attempt == 2 => return Err(error),
            Err(Unrefreshed::Exchange(_)) => {
                let base = 2_000f64.min(200.0 * 2f64.powi(attempt));
                let delay = (base + pace.draw() * base).round() as u64;
                pace.wait(std::time::Duration::from_millis(delay)).await;
                attempt += 1;
            }
        }
    }
}
/// `refreshTokens` (`grok-oauth-tokens.mjs:387-433`): xAI rotates refresh tokens single-use, so the whole refresh runs
/// holding the cross-process lease beside the credential file. Under it the file is read again: a generation another
/// writer stored meanwhile (either token differs from `tokens`) is adopted without an exchange when it has no expiry or
/// one at or after `now + skew`; otherwise the stored generation (or `tokens`) is exchanged, and a refused grant adopts
/// or exchanges a generation a writer outside the lease rotated in meanwhile. A forced refresh is for the login a
/// refused attempt was sent on (`tokens`) and for no other: a generation stored meanwhile is its answer as it is,
/// never exchanged on that attempt's behalf.
async fn refresh_tokens(
    http: &dyn HttpSend,
    pace: &dyn Pace,
    file: &CredentialFile,
    process: &LockProcess,
    tokens: StoredTokens,
    force: bool,
) -> Result<Refreshed, ProviderError> {
    if tokens.refresh_token.is_empty() {
        let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        error.reauth_required = true;
        error.message = format!("[grok-oauth] refresh token not available: {REAUTH_GUIDANCE}");
        return Err(error);
    }
    // The file read and written now, held for the whole refresh: a handle that follows the selected account and one
    // bound to that account's file take the same lease.
    let file = &file.pinned().await;
    let held = async {
        let valid_after = pace.now_ms() + REFRESH_SKEW_MS;
        let disk = match stored_in(file).await {
            Stored::Tokens(disk) => Some(with_claimed_expiry(disk)),
            // Signed out before anything was exchanged: nothing is, and that is how the refresh ends.
            Stored::SignedOut => return Ok(Refreshed::SignedOut),
            Stored::Unreadable => None,
        };
        if let Some(disk) = &disk
            && !disk.same_login(&tokens)
            && (force || disk.valid_at(valid_after))
        {
            return Ok(Refreshed::Replaced(disk.clone()));
        }
        let current = disk.unwrap_or(tokens);
        match refresh_with_retry(http, pace, file, &current).await {
            Err(error) if is_invalid_grant(&error) => match stored_in(file).await {
                Stored::Tokens(rotated) if !rotated.same_login(&current) => {
                    let rotated = with_claimed_expiry(rotated);
                    if force || rotated.valid_at(valid_after) { Ok(Refreshed::Replaced(rotated)) } else { refresh_with_retry(http, pace, file, &rotated).await }
                }
                // The sign-in the grant was refused for is gone: the refresh ends as that sign-out, not as the refusal.
                Stored::SignedOut => Ok(Refreshed::SignedOut),
                Stored::Tokens(_) | Stored::Unreadable => Err(error),
            },
            outcome => outcome,
        }
    };
    file.lease(&refresh_lock_path(file.path()), process, pace, REFRESH_LEASE, held).await.map_err(lease_error)?
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

    /// `preconnect(PROXY_BASE_URL)` (`grok-oauth.mjs:328-335`, `:425-428`): before a turn, the proxy origin is warmed,
    /// once per keep-alive window for the process.
    fn preconnect(&self) {
        crate::transport::preconnect::preconnect(&self.http, super::PROXY_ORIGIN, now_ms(), ProcessEnv.var("MIXDOG_LLM_KEEPALIVE_MS"));
    }

    /// The identity header value for the signed-in user, once a turn loaded it.
    pub fn user_id(&self) -> Option<String> {
        self.current.load_full().map(|t| t.user_id.clone()).filter(|id| !id.is_empty())
    }

    /// The tokens in use: the file's generation when it holds one (another process may have rotated it since this one
    /// last read it: `ensureAuth`'s scan of the file). A file that is gone, or that reads and holds no sign-in (one of
    /// its two tokens is missing or empty), is a sign-out: the generation this process held goes with it. A file that
    /// cannot be read now, or whose sign-in does not decode, leaves that one in use.
    async fn tokens(&self) -> Result<StoredTokens, ProviderError> {
        match self.probe().await {
            Stored::Tokens(tokens) => Ok(tokens),
            Stored::SignedOut => Err(self.signed_out()),
            Stored::Unreadable => self.held(),
        }
    }

    async fn probe(&self) -> Stored {
        stored_in(&self.file).await
    }

    fn held(&self) -> Result<StoredTokens, ProviderError> {
        match self.current.load_full() {
            Some(held) => Ok((*held).clone()),
            None => Err(storage_error("the credential file cannot be read")),
        }
    }

    fn signed_out(&self) -> ProviderError {
        self.current.store(None);
        not_connected()
    }

    fn flight_key(&self, tokens: &StoredTokens) -> FlightKey {
        (self.file.path().to_path_buf(), tokens.refresh_token.clone())
    }

    /// The refresh in flight for the credential `tokens` holds, if one is.
    fn in_flight(&self, tokens: &StoredTokens) -> Option<SharedRefresh> {
        self.process.flights().get(&self.flight_key(tokens)).map(|(_, shared)| shared.clone())
    }

    /// Starts the refresh of `tokens` every send holding them shares until it settled.
    fn start(&self, tokens: StoredTokens, force: bool) -> SharedRefresh {
        use futures::FutureExt;
        let generation = self.process.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (http, pace, file, process) = (self.http.clone(), self.pace.clone(), self.file.clone(), self.process.clone());
        let key = self.flight_key(&tokens);
        let settled = key.clone();
        let shared = async move {
            let outcome = refresh_tokens(http.as_ref(), pace.as_ref(), &file, &process.lock, tokens, force).await;
            let mut flights = process.flights();
            if flights.get(&settled).is_some_and(|(id, _)| *id == generation) {
                flights.remove(&settled);
            }
            outcome
        }
        .boxed()
        .shared();
        self.process.flights().insert(key, (generation, shared.clone()));
        shared
    }

    /// `ensureAuth({ forceRefresh })`. `rejected` is the generation a refused request was sent on: the refresh is forced,
    /// and it is of that generation alone. Another one stored since is returned as it is, whatever its expiry, with
    /// nothing exchanged on the refused request's behalf.
    ///
    /// The second value says whether the tokens come from an exchange made for this call.
    async fn ensure(&self, rejected: Option<&StoredTokens>) -> Result<(StoredTokens, bool), ProviderError> {
        use std::sync::atomic::Ordering;
        let mut tokens = self.tokens().await?;
        loop {
            // The generation at hand, read from the file or handed back by a refresh this call shared, is judged against
            // this call's own attempt: the refused one is refreshed, any other is what the refused send goes out on.
            let force = match rejected {
                Some(rejected) if rejected.same_login(&tokens) => true,
                Some(_) => return Ok((tokens, false)),
                None => false,
            };
            let now = self.pace.now_ms();
            if !force && self.fallback_until.load(Ordering::SeqCst) > now && tokens.unexpired_at(now) {
                return Ok((tokens, false));
            }
            if !force && !tokens.needs_refresh(now) {
                return Ok((tokens, false));
            }
            let outcome = match self.in_flight(&tokens) {
                Some(shared) => shared.await,
                None => self.start(tokens.clone(), force).await,
            };
            return match outcome {
                Ok(Refreshed::Tokens(fresh)) => {
                    self.fallback_until.store(0, Ordering::SeqCst);
                    Ok((fresh, true))
                }
                Ok(Refreshed::Replaced(stored)) => {
                    tokens = stored;
                    continue;
                }
                // The refresh itself found the sign-out: the held token goes with it, whatever the file reads as by now.
                Ok(Refreshed::SignedOut) => Err(self.signed_out()),
                Err(error) => {
                    // A sign-out that happened while a refresh failed for another reason is no outage either, forced or
                    // not. A file that cannot be read says nothing: the token read above still stands.
                    if matches!(self.probe().await, Stored::SignedOut) {
                        return Err(self.signed_out());
                    }
                    let now = self.pace.now_ms();
                    if !force && !tokens.access_token.is_empty() && tokens.unexpired_at(now) {
                        self.fallback_until.store(now + REFRESH_SKEW_MS, Ordering::SeqCst);
                        tracing::warn!(error = %error.message, "[grok-oauth] Refresh failed; using still-valid current token");
                        return Ok((tokens, false));
                    }
                    Err(error)
                }
            };
        }
    }

    /// The attempt a request is sent on: its bearer, and the generation it is of.
    async fn served(&self, rejected: Option<&StoredTokens>) -> Result<Recovered, ProviderError> {
        self.preconnect();
        let (tokens, exchanged) = self.ensure(rejected).await?;
        self.current.store(Some(Arc::new(tokens.clone())));
        let header = ("authorization".to_owned(), format!("Bearer {}", tokens.access_token));
        Ok(Recovered { attempt: Attempt::served_under(Some(header), tokens), exchanged })
    }
}
#[async_trait]
impl Credential for GrokCredential {
    async fn attempt(&self) -> Result<Attempt, ProviderError> {
        Ok(self.served(None).await?.attempt)
    }

    /// The generation `rejected` carries is refreshed. An attempt this credential did not serve names none of its
    /// generations, so nothing is refreshed for it either.
    async fn after_rejection(&self, rejected: &Attempt) -> Result<Recovered, ProviderError> {
        self.served(rejected.login::<StoredTokens>()).await
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

    /// The user the access token's claims name; a token whose claims name none (or that is not a bearer) has no account.
    fn account_of(&self, header: &(String, String)) -> Option<String> {
        let token = header.1.strip_prefix("Bearer ")?;
        Some(identity_of(token).user_id).filter(|id| !id.is_empty())
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
        let tokens = tokens_from_grant(&json, self.token_endpoint.as_str(), now_ms())?;
        self.file.keep(&[&tokens.access_token, &tokens.refresh_token]);
        self.file.replace(saved_document(&tokens)).await.map_err(|_| failed("storage", "the tokens could not be stored".to_owned()))?;
        Ok((!tokens.email.is_empty()).then_some(tokens.email))
    }
}
