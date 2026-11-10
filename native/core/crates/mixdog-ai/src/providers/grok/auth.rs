//! Grok OAuth tokens: the stored shape, the refresh exchange, the Bearer
//! credential and the PKCE login. The credential file, refresh verdicts and
//! login flow are the shared `oauth` plumbing; this module supplies the
//! URLs, the client id and the token-endpoint bodies.

use crate::transport::deadlines::GROK_DISCOVERY;
use crate::transport::deadlines::TOKEN_GROK;
use crate::transport::link::Exchange;
use crate::transport::link::Redirect;
use crate::transport::link::Surface;
use mixdog_rt::Liveness;
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
use crate::oauth::pages;
use crate::oauth::scrub::oauth_body_summary;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::provider_error;
use crate::providers::connect::rewrite::Credential;
use crate::retry::advice;
use crate::transport::http::HttpSend;

pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
pub const DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;
pub const REAUTH_GUIDANCE: &str = "open /providers in mixdog to sign in again";
const OPERATION: &str = "[grok-oauth] token exchange";
/// The warm-up HEAD: `undici.request(origin, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })`, which follows no
/// redirect and whose failure is swallowed (`shared/llm/http-agent.mjs:496-527`).
const PRECONNECT: Exchange = Exchange::new(Liveness::unary(std::time::Duration::from_secs(10)), Redirect::Manual, Surface::FetchSignal);
/// `MIXDOG_LLM_KEEPALIVE_MS` (60 s) less 10 s: how long a warmed origin is not warmed again (`_preconnectTtlMs`).
const PRECONNECT_TTL_MS: u64 = 50_000;

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
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at <= now_ms + REFRESH_SKEW_MS
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

/// A failed refresh by the shared verdict: a dead grant needs a new sign-in;
/// everything else leaves the refresh token valid.
pub fn refresh_error(status: u16, headers: &[(String, String)], body: &[u8]) -> ProviderError {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let oauth = parsed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let terminal = classify_refresh_failure(Some(status), body) == RefreshFailure::Definitive;
    let mut error = provider_error(
        ConnectFailure {
            code: String::new(),
            message: format!("[grok-oauth] token refresh {status}"),
            http_status: Some(status),
            retry_after: advice::from_headers(headers, SystemTime::now()),
        },
        DeliveryState::Accepted,
    );
    if terminal {
        error.kind = ErrorKind::Auth;
        error.reauth_required = true;
    }
    if !oauth.is_empty() {
        error.code = Some(oauth);
    }
    error
}

/// One refresh exchange. xAI rotates refresh tokens; the prior one is kept
/// only when the response omits it.
pub async fn refresh(http: &dyn HttpSend, tokens: &StoredTokens) -> Result<StoredTokens, ProviderError> {
    if tokens.refresh_token.is_empty() {
        let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
        error.reauth_required = true;
        error.message = format!("[grok-oauth] refresh token not available: {REAUTH_GUIDANCE}");
        return Err(error);
    }
    let endpoint = if tokens.token_endpoint.is_empty() {
        discover_token_endpoint(http).await?
    } else {
        trusted_xai_endpoint(&tokens.token_endpoint)?.to_string()
    };
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "POST".to_owned(),
                url: endpoint.clone(),
                headers: vec![(
                    "content-type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                )],
                body: refresh_form(tokens).into_bytes(),
            },
            TOKEN_GROK,
        )
        .await?;
    let success = head.is_success();
    let response = head.read_all().await?;
    if !success {
        return Err(refresh_error(response.status.unwrap_or(0), &response.headers, &response.body));
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
    let now = now_ms();
    Ok(StoredTokens {
        access_token: access.to_owned(),
        refresh_token: text("refresh_token", &tokens.refresh_token),
        expires_at: match json.get("expires_in").and_then(Value::as_f64) {
            Some(seconds) => now + (seconds * 1000.0) as u64,
            None => json.get("expires_at").and_then(Value::as_u64).unwrap_or(0),
        },
        token_endpoint: endpoint,
        user_id: tokens.user_id.clone(),
        principal_type: text("principal_type", &tokens.principal_type),
        principal_id: text("principal_id", &tokens.principal_id),
        email: tokens.email.clone(),
    })
}

async fn discover_token_endpoint(http: &dyn HttpSend) -> Result<String, ProviderError> {
    let head = http
        .send(
            WireRequest {
                transport: TransportKind::Http1,
                method: "GET".to_owned(),
                url: DISCOVERY_URL.to_owned(),
                headers: vec![("accept".to_owned(), "application/json".to_owned())],
                body: Vec::new(),
            },
            GROK_DISCOVERY,
        )
        .await?;
    let success = head.is_success();
    let response = head.read_all().await?;
    let json: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    match json.get("token_endpoint").and_then(Value::as_str) {
        Some(endpoint) if success => Ok(trusted_xai_endpoint(endpoint)?.to_string()),
        _ => {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
            error.status = response.status;
            error.message = "[grok-oauth] discovery returned no token endpoint".to_owned();
            Err(error)
        }
    }
}

/// The Bearer credential of the Grok CLI proxy. A turn refreshes first when
/// the token is inside its skew; a rejected token is refreshed once more.
pub struct GrokCredential {
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    current: ArcSwapOption<StoredTokens>,
    /// When the proxy origin was last warmed (`_preconnectedAt`); cleared when the warm-up fails.
    warmed_at: Arc<std::sync::Mutex<Option<u64>>>,
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
            current: ArcSwapOption::empty(),
            warmed_at: Arc::default(),
        }
    }

    /// `preconnect(PROXY_BASE_URL)` (`grok-oauth.mjs:243-249`, `:383-387`): before a turn, a fire-and-forget HEAD lands a
    /// kept-alive socket, once per [`PRECONNECT_TTL_MS`]. Any failure only clears the stamp.
    fn preconnect(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let now = now_ms();
        {
            let mut warmed = self.warmed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if warmed.is_some_and(|last| now.saturating_sub(last) < PRECONNECT_TTL_MS) {
                return;
            }
            *warmed = Some(now);
        }
        let (http, warmed_at) = (self.http.clone(), self.warmed_at.clone());
        runtime.spawn(async move {
            let head = WireRequest {
                transport: TransportKind::Http1,
                method: "HEAD".to_owned(),
                url: format!("{}/", super::PROXY_ORIGIN),
                headers: Vec::new(),
                body: Vec::new(),
            };
            let warmed = match http.send(head, PRECONNECT).await {
                Ok(response) => response.read_all().await.is_ok(),
                Err(_) => false,
            };
            if !warmed {
                *warmed_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            }
        });
    }

    /// The identity header value for the signed-in user, once a turn loaded it.
    pub fn user_id(&self) -> Option<String> {
        self.current
            .load_full()
            .map(|t| t.user_id.clone())
            .filter(|id| !id.is_empty())
    }

    async fn stored(&self) -> Result<StoredTokens, ProviderError> {
        match self.file.load::<StoredTokens>().await {
            Probe::Present(tokens) => Ok(tokens),
            Probe::Absent => Err(not_connected()),
            Probe::Unreadable => Err(storage_error("the credential file cannot be read")),
        }
    }

    async fn tokens(&self) -> Result<StoredTokens, ProviderError> {
        match self.current.load_full() {
            Some(tokens) => Ok((*tokens).clone()),
            None => self.stored().await,
        }
    }

    /// Exchanges the refresh token and publishes the rotation only over the
    /// pair that was exchanged, so a process that rotated first wins.
    async fn rotate(&self, old: StoredTokens) -> Result<StoredTokens, ProviderError> {
        let fresh = refresh(self.http.as_ref(), &old).await?;
        let Value::Object(update) = serde_json::to_value(&fresh).map_err(|_| storage_error("tokens not serializable"))?
        else {
            return Err(storage_error("tokens not serializable"));
        };
        let (access, refresh_token) = (old.access_token.clone(), old.refresh_token.clone());
        let published = self
            .file
            .replace_if(
                move |doc| {
                    doc.get("access_token").and_then(Value::as_str).unwrap_or_default() == access
                        && doc.get("refresh_token").and_then(Value::as_str).unwrap_or_default() == refresh_token
                },
                update,
            )
            .await
            .map_err(|_| storage_error("the refreshed tokens could not be stored"))?;
        // Another process rotated first: its generation is the live one.
        if published { Ok(fresh) } else { self.stored().await }
    }
}

#[async_trait]
impl Credential for GrokCredential {
    async fn header(&self, force_refresh: bool) -> Result<Option<(String, String)>, ProviderError> {
        self.preconnect();
        let mut tokens = self.tokens().await?;
        if force_refresh || tokens.needs_refresh(now_ms()) {
            // The file may hold a newer generation than this process knows.
            let stored = self.stored().await?;
            let changed = stored.access_token != tokens.access_token || stored.refresh_token != tokens.refresh_token;
            tokens = if changed && !stored.needs_refresh(now_ms()) {
                stored
            } else {
                self.rotate(stored).await?
            };
        }
        self.current.store(Some(Arc::new(tokens.clone())));
        Ok(Some(("authorization".to_owned(), format!("Bearer {}", tokens.access_token))))
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
        let dead = refresh_error(400, &[], br#"{"error":"invalid_grant"}"#);
        assert!(dead.reauth_required);
        assert_eq!(dead.code.as_deref(), Some("invalid_grant"));
        let throttled = refresh_error(429, &[], b"slow down");
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
        let error = refresh(transport.as_ref(), &tokens).await.expect_err("the token endpoint never answers");
        assert_transport("grokRefresh", &transport);
        assert_thrown("grokRefresh", &error.message);

        let transport = TimingOut::new();
        let error = refresh(transport.as_ref(), &StoredTokens { token_endpoint: String::new(), ..tokens.clone() })
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

    #[test]
    fn expiry_is_due_inside_the_skew() {
        let t = StoredTokens {
            expires_at: 1_000_000,
            ..StoredTokens::default()
        };
        assert!(t.needs_refresh(1_000_000 - REFRESH_SKEW_MS));
        assert!(!t.needs_refresh(0));
        assert!(!StoredTokens::default().needs_refresh(u64::MAX / 2));
    }
}
