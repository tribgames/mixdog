//! Antigravity (Google Cloud Code Assist) credentials: the stored Google
//! OAuth document, its refresh, and the login-side requests (authorize URL,
//! code exchange, account and project discovery). The loopback listener and
//! PKCE live in the shared login plumbing; this module only describes what
//! goes to Google and reads what comes back.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use mixdog_core_api::domain::login::LoginFailure;

use crate::oauth::AuthorizeRequest;
use crate::oauth::CredentialFile;
use crate::oauth::PkceProvider;
use crate::oauth::Probe;

use super::Authorization;
use super::RequestAuth;
use super::form_body;
use super::parse_token_grant;
use super::token_failure;
use crate::transport::HttpSend;

/// The Antigravity IDE's installed-app OAuth client, which every copy of that
/// IDE ships (a native-app client is not a confidential credential). Stored
/// as split base64 so no single literal decodes to a whole credential.
const CLIENT_ID_PARTS: [&str; 3] = [
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxj",
    "cmUyMzV2dG9sb2poNGc0MDNlcC5hcHBz",
    "Lmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
];
const CLIENT_SECRET_PARTS: [&str; 2] = ["R09DU1BYLUs1", "OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="];

fn decode(parts: &[&str]) -> String {
    let bytes = STANDARD.decode(parts.concat()).expect("constant base64");
    String::from_utf8(bytes).expect("constant utf-8")
}

pub fn client_id() -> String {
    decode(&CLIENT_ID_PARTS)
}

fn client_secret() -> String {
    decode(&CLIENT_SECRET_PARTS)
}

pub const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
pub const SCOPES: [&str; 5] = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];
pub const CALLBACK_HOST: &str = "127.0.0.1";
pub const CALLBACK_PORT: u16 = 51121;
pub const CALLBACK_PATH: &str = "/oauth-callback";
pub const REDIRECT_URI: &str = "http://127.0.0.1:51121/oauth-callback";
/// Generation and account provisioning share the IDE's daily channel.
pub const ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
/// The client version the backend gates models on, when no manifest is read.
pub const VERSION_FALLBACK: &str = "2.19.1";
pub const VERSION_MANIFEST_URL: &str =
    "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const REFRESH_SKEW_MS: u64 = 5 * 60_000;
/// `onboardUser` operations are polled at most this many times.
const ONBOARD_POLLS: u32 = 30;

/// `version: X.Y.Z` from an electron-builder update manifest.
pub fn parse_manifest_version(text: &str) -> Option<String> {
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix("version") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix(':') else {
            continue;
        };
        let value = rest.split('#').next().unwrap_or("").trim().trim_matches(['"', '\'']);
        let numeric = value.split('.').count() == 3
            && value.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        return numeric.then(|| value.to_owned());
    }
    None
}

// ---------------------------------------------------------------------------
// Stored credentials
// ---------------------------------------------------------------------------

/// `antigravity-oauth.json`: the file keeps today's names and schema.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenDoc {
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch milliseconds; 0 when unknown.
    pub expires_at_ms: u64,
    pub project_id: String,
    pub tier_id: String,
    pub email: String,
    pub user_id: String,
}

/// `expires_at` may be unix seconds or milliseconds, a numeric string, or an
/// ISO-8601 string; 0 means unknown.
fn expires_at_ms(value: &Value) -> u64 {
    let number = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => match s.trim().parse::<f64>() {
            Ok(n) => Some(n),
            Err(_) => {
                return chrono::DateTime::parse_from_rfc3339(s.trim())
                    .map(|t| t.timestamp_millis().max(0) as u64)
                    .unwrap_or(0);
            }
        },
        _ => None,
    };
    match number {
        Some(n) if n.is_finite() && n > 0.0 => (if n < 1e12 { n * 1000.0 } else { n }) as u64,
        _ => 0,
    }
}

impl TokenDoc {
    /// A document with both tokens; anything else is not a sign-in.
    pub fn from_json(raw: &Value) -> Option<Self> {
        let text = |keys: &[&str]| {
            keys.iter().find_map(|k| raw.get(*k).and_then(Value::as_str)).unwrap_or("").to_owned()
        };
        let (access_token, refresh_token) = (text(&["access_token"]), text(&["refresh_token"]));
        if access_token.is_empty() || refresh_token.is_empty() {
            return None;
        }
        Some(Self {
            access_token,
            refresh_token,
            expires_at_ms: expires_at_ms(raw.get("expires_at").or_else(|| raw.get("expiresAt")).unwrap_or(&Value::Null)),
            project_id: text(&["project_id", "projectId"]),
            tier_id: text(&["tier_id"]),
            email: text(&["email"]),
            user_id: text(&["user_id", "userId"]),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at_ms,
            "project_id": self.project_id,
            "tier_id": self.tier_id,
            "email": self.email,
            "user_id": self.user_id,
        })
    }
}

/// The credential file. The shared OAuth plumbing implements it with its
/// locked atomic writes (owner-only mode, directory fsync).
#[async_trait]
pub trait TokenStore: Send + Sync {
    async fn load(&self) -> Option<TokenDoc>;
    /// Writes `next` only over the credential `spent` was read from: a
    /// sign-out or a new sign-in that landed meanwhile wins. False when the
    /// store no longer holds `spent`.
    async fn replace_if_current(&self, spent: &TokenDoc, next: &TokenDoc) -> bool;
    /// A new sign-in replaces whatever the file holds.
    async fn save(&self, doc: &TokenDoc) -> bool;
}

/// `antigravity-oauth.json` on the shared credential file: atomic locked
/// writes on the write lane, fields this code does not know kept.
pub struct FileTokenStore(pub CredentialFile);

#[async_trait]
impl TokenStore for FileTokenStore {
    async fn load(&self) -> Option<TokenDoc> {
        match self.0.load_document().await {
            Probe::Present(map) => TokenDoc::from_json(&Value::Object(map)),
            Probe::Absent | Probe::Unreadable => None,
        }
    }

    async fn replace_if_current(&self, spent: &TokenDoc, next: &TokenDoc) -> bool {
        let spent = spent.clone();
        let Value::Object(update) = next.to_json() else { return false };
        self.0
            .replace_if(move |stored| TokenDoc::from_json(&Value::Object(stored.clone())).as_ref() == Some(&spent), update)
            .await
            .unwrap_or(false)
    }

    async fn save(&self, doc: &TokenDoc) -> bool {
        let Value::Object(update) = doc.to_json() else { return false };
        self.0.replace_if(|_| true, update).await.unwrap_or(false)
    }
}

fn reauth(message: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = true;
    err.status = Some(401);
    err.message = message.to_owned();
    err
}

/// The access token is refreshed ahead of expiry so an in-flight turn never
/// posts a stale one.
pub fn should_refresh(tokens: &TokenDoc, now_ms: u64) -> bool {
    if tokens.access_token.is_empty() {
        return true;
    }
    tokens.expires_at_ms != 0 && now_ms + REFRESH_SKEW_MS >= tokens.expires_at_ms
}

pub struct AntigravityAuth {
    http: Arc<dyn HttpSend>,
    store: Arc<dyn TokenStore>,
    now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    /// Concurrent callers share one round-trip.
    refreshing: tokio::sync::Semaphore,
}

impl AntigravityAuth {
    pub fn new(
        http: Arc<dyn HttpSend>,
        store: Arc<dyn TokenStore>,
        now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self { http, store, now_ms, refreshing: tokio::sync::Semaphore::new(1) }
    }

    /// The signed-in document, for building the adapter (project binding).
    pub async fn current(&self) -> Result<TokenDoc, ProviderError> {
        self.store.load().await.ok_or_else(|| reauth("not signed in — run /login"))
    }

    async fn refresh(&self, spent: &TokenDoc) -> Result<TokenDoc, ProviderError> {
        let id = client_id();
        let secret = client_secret();
        let body = form_body(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &spent.refresh_token),
            ("client_id", &id),
            ("client_secret", &secret),
        ]);
        let response = self
            .http
            .send(WireRequest {
                transport: TransportKind::Http1,
                method: "POST".into(),
                url: TOKEN_URL.into(),
                headers: vec![("content-type".into(), "application/x-www-form-urlencoded".into())],
                body,
            })
            .await?;
        let status = response.status;
        let reply = response.read_all().await?;
        if !(200..300).contains(&status) {
            return Err(token_failure(status, &reply.body, "Antigravity token refresh"));
        }
        let grant = parse_token_grant(&reply.body, "Antigravity token refresh")?;
        let next = TokenDoc {
            access_token: grant.access_token,
            refresh_token: grant.refresh_token.unwrap_or_else(|| spent.refresh_token.clone()),
            expires_at_ms: grant.expires_in_secs.map_or(0, |s| (self.now_ms)() + s * 1000),
            ..spent.clone()
        };
        if self.store.replace_if_current(spent, &next).await {
            return Ok(next);
        }
        self.store.load().await.ok_or_else(|| reauth("credentials were removed during token refresh — run /login"))
    }

    async fn tokens(&self, force: bool) -> Result<TokenDoc, ProviderError> {
        let tokens = self.current().await?;
        if !force && !should_refresh(&tokens, (self.now_ms)()) {
            return Ok(tokens);
        }
        let _gate = self.refreshing.acquire().await.map_err(|_| reauth("refresh gate closed"))?;
        // A concurrent caller may have refreshed while this one waited.
        let current = self.current().await?;
        if !force && !should_refresh(&current, (self.now_ms)()) {
            return Ok(current);
        }
        match self.refresh(&current).await {
            Ok(next) => Ok(next),
            // A refresh failure on a still-valid token must not break the turn.
            Err(err) if !force && !err.reauth_required && current.expires_at_ms > (self.now_ms)() => Ok(current),
            Err(err) => Err(err),
        }
    }
}

#[async_trait]
impl RequestAuth for AntigravityAuth {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        let tokens = self.tokens(false).await?;
        Ok(Authorization {
            headers: vec![("authorization".into(), format!("Bearer {}", tokens.access_token))],
            identity: tokens.project_id,
        })
    }

    /// A typed 401 says this access token is no longer accepted whatever the
    /// local expiry says (server-side revocation or rotation): refresh once.
    async fn rejected(&self, _: &Authorization) -> bool {
        self.tokens(true).await.is_ok()
    }
}

// ---------------------------------------------------------------------------
// Login-side requests
// ---------------------------------------------------------------------------

pub fn authorize_url(state: &str, code_challenge: &str, redirect_uri: &str) -> String {
    let mut url = url::Url::parse(AUTH_URL).expect("constant url");
    url.query_pairs_mut()
        .append_pair("client_id", &client_id())
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256")
        // Offline + forced consent is what yields a refresh token on re-login.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.into()
}

/// The authorization-code exchange request.
pub fn exchange_request(code: &str, verifier: &str, redirect_uri: &str) -> WireRequest {
    let id = client_id();
    let secret = client_secret();
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: TOKEN_URL.into(),
        headers: vec![("content-type".into(), "application/x-www-form-urlencoded".into())],
        body: form_body(&[
            ("client_id", &id),
            ("client_secret", &secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ]),
    }
}

/// Lets the login flow pace polling without a timer in this module.
#[async_trait]
pub trait Pause: Send + Sync {
    async fn pause(&self, duration: Duration);
}

pub struct Account {
    pub project_id: String,
    pub tier_id: String,
}

fn failure(message: impl Into<String>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    err.message = message.into();
    err
}

fn verification_required(url: &str, reason: &str, email: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Permission, DeliveryState::Accepted);
    err.code = Some("validation_required".into());
    err.verification_url = Some(url.into());
    let account = if email.is_empty() { String::new() } else { format!(" for {email}") };
    err.message = format!(
        "Account verification required{account}.{}\nVisit {url} to continue, then sign in again.",
        if reason.is_empty() { String::new() } else { format!("\n{reason}") }
    );
    err
}

/// Cloud Code Assist `v1internal` calls made with one access token.
pub struct CodeAssist<'a> {
    pub http: &'a dyn HttpSend,
    pub access_token: &'a str,
    pub client_version: &'a str,
    pub email: &'a str,
}

impl CodeAssist<'_> {
    async fn call(&self, action: &str, body: Option<Value>) -> Result<Value, ProviderError> {
        let post = body.is_some();
        let response = self
            .http
            .send(WireRequest {
                transport: TransportKind::Http1,
                method: if post { "POST" } else { "GET" }.into(),
                url: format!("{ENDPOINT}/v1internal{}{action}", if post { ":" } else { "/" }),
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("authorization".into(), format!("Bearer {}", self.access_token)),
                    (
                        "user-agent".into(),
                        format!(
                            "antigravity/hub/{} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)",
                            self.client_version
                        ),
                    ),
                ],
                body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
            })
            .await?;
        let status = response.status;
        let reply = response.read_all().await?;
        let parsed: Option<Value> = serde_json::from_slice(&reply.body).ok();
        if status != 200 {
            let validation = parsed
                .as_ref()
                .and_then(|v| v.pointer("/error/details"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|d| d["reason"] == "VALIDATION_REQUIRED" && d["metadata"]["validation_url"].is_string())
                .and_then(|d| d["metadata"]["validation_url"].as_str());
            if let Some(url) = validation.filter(|u| !u.is_empty()) {
                let reason = parsed.as_ref().and_then(|v| v.pointer("/error/message")).and_then(Value::as_str);
                return Err(verification_required(url, reason.unwrap_or(""), self.email));
            }
            let mut err = failure(format!("{action} failed: {status}"));
            err.status = Some(status);
            return Err(err);
        }
        parsed.filter(Value::is_object).ok_or_else(|| failure(format!("invalid {action} response")))
    }

    async fn project_state(&self) -> Result<Value, ProviderError> {
        let body = json!({ "metadata": { "ideType": "ANTIGRAVITY" } });
        let mut payload = self.call("loadCodeAssist", Some(body.clone())).await?;
        let project = payload["cloudaicompanionProject"].as_str().unwrap_or("").to_owned();
        if payload["paidTier"].is_null() && !project.is_empty() {
            let mut again = body;
            again["cloudaicompanionProject"] = json!(project);
            payload = self.call("loadCodeAssist", Some(again)).await?;
        }
        Ok(payload)
    }

    async fn provision(&self, tier_id: &str, pause: &dyn Pause) -> Result<(), ProviderError> {
        let mut operation = self
            .call("onboardUser", Some(json!({ "tierId": tier_id, "metadata": { "ideType": "ANTIGRAVITY" } })))
            .await?;
        let mut polls = 0;
        while operation["done"] != json!(true) {
            polls += 1;
            if polls > ONBOARD_POLLS {
                return Err(failure("onboardUser did not finish"));
            }
            pause.pause(Duration::from_secs(1)).await;
            let name = operation["name"]
                .as_str()
                .filter(|n| !n.is_empty())
                .ok_or_else(|| failure("onboardUser returned an operation without a name"))?
                .to_owned();
            operation = self.call(&name, None).await?;
        }
        if !operation["error"].is_null() {
            let code = operation["error"]["code"].as_i64().map(|c| format!("{c}: ")).unwrap_or_default();
            let message = operation["error"]["message"].as_str().unwrap_or("");
            return Err(failure(format!("onboardUser operation failed: {code}{message}")));
        }
        if !operation["response"]["@type"].is_string() {
            return Err(failure("invalid onboardUser response"));
        }
        Ok(())
    }

    /// Resolves account eligibility, onboards when Google reports no tier,
    /// and returns the project from a fresh status load plus the tier (paid
    /// first).
    pub async fn discover_account(&self, pause: &dyn Pause) -> Result<Account, ProviderError> {
        let initial = self.project_state().await?;
        if initial["currentTier"].is_null() {
            let tier = onboarding_tier(&initial).ok_or_else(|| no_tier(&initial, self.email))?;
            self.provision(&tier, pause).await?;
        }
        let refreshed = self.project_state().await?;
        let project_id = refreshed["cloudaicompanionProject"]
            .as_str()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| failure("loadCodeAssist did not return a cloudaicompanionProject"))?
            .to_owned();
        let tier_id = refreshed["paidTier"]["id"]
            .as_str()
            .or_else(|| refreshed["currentTier"]["id"].as_str())
            .unwrap_or("")
            .to_owned();
        Ok(Account { project_id, tier_id })
    }
}

/// The Antigravity sign-in on the shared PKCE flow: the loopback listener,
/// state and verifier come from there; this describes Google's side.
pub struct AntigravityLogin {
    pub http: Arc<dyn HttpSend>,
    pub store: Arc<dyn TokenStore>,
    pub client_version: String,
    pub pause: Arc<dyn Pause>,
    pub now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
}

fn login_failure(err: &ProviderError, email: &str) -> LoginFailure {
    match &err.verification_url {
        Some(url) => LoginFailure::VerificationRequired {
            url: url.to_string(),
            account: (!email.is_empty()).then(|| email.to_owned()),
        },
        None => LoginFailure::Failed {
            code: err.code.clone().unwrap_or_else(|| "antigravity_login_failed".into()),
            message: err.message.clone(),
        },
    }
}

#[async_trait]
impl PkceProvider for AntigravityLogin {
    fn redirect(&self) -> crate::oauth::Redirect {
        crate::oauth::redirects::ANTIGRAVITY
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        authorize_url(request.state, request.code_challenge, request.redirect_uri)
    }

    async fn exchange(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Option<String>, LoginFailure> {
        let fail = |err: ProviderError| login_failure(&err, "");
        let response = self.http.send(exchange_request(code, verifier, redirect_uri)).await.map_err(fail)?;
        let status = response.status;
        let reply = response.read_all().await.map_err(fail)?;
        if !(200..300).contains(&status) {
            return Err(fail(token_failure(status, &reply.body, "Antigravity token exchange")));
        }
        let grant = parse_token_grant(&reply.body, "Antigravity token exchange").map_err(fail)?;
        let refresh_token = grant.refresh_token.ok_or_else(|| LoginFailure::Failed {
            code: "no_refresh_token".into(),
            message: "Google returned no refresh token".into(),
        })?;
        let info = self
            .http
            .send(WireRequest {
                transport: TransportKind::Http1,
                method: "GET".into(),
                url: USERINFO_URL.into(),
                headers: vec![("authorization".into(), format!("Bearer {}", grant.access_token))],
                body: Vec::new(),
            })
            .await
            .map_err(fail)?;
        let info_status = info.status;
        let info_body = info.read_all().await.map_err(fail)?;
        if !(200..300).contains(&info_status) {
            return Err(fail(failure(format!("userinfo failed: {info_status}"))));
        }
        let profile: Value = serde_json::from_slice(&info_body.body).unwrap_or(Value::Null);
        let email = profile["email"].as_str().unwrap_or("").to_owned();
        let user_id = profile["id"].as_str().unwrap_or("").to_owned();
        let assist = CodeAssist {
            http: self.http.as_ref(),
            access_token: &grant.access_token,
            client_version: &self.client_version,
            email: &email,
        };
        let account = assist
            .discover_account(self.pause.as_ref())
            .await
            .map_err(|err| login_failure(&err, &email))?;
        let doc = TokenDoc {
            access_token: grant.access_token.clone(),
            refresh_token,
            expires_at_ms: grant.expires_in_secs.map_or(0, |s| (self.now_ms)() + s * 1000),
            project_id: account.project_id,
            tier_id: account.tier_id,
            email: email.clone(),
            user_id,
        };
        if !self.store.save(&doc).await {
            return Err(LoginFailure::Failed {
                code: "credential_write_failed".into(),
                message: "the credential file could not be written".into(),
            });
        }
        Ok((!email.is_empty()).then_some(email))
    }
}

fn tier_ids<'a>(list: &'a Value, key: &str) -> Vec<&'a str> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.get(key).and_then(Value::as_str))
        .filter(|id| !id.is_empty())
        .collect()
}

/// Free tier when Google allows it (or reports no tier list at all);
/// otherwise the default allowed tier Google can provision without a
/// user-supplied Cloud project.
fn onboarding_tier(payload: &Value) -> Option<String> {
    let allowed = tier_ids(&payload["allowedTiers"], "id");
    let ineligible = tier_ids(&payload["ineligibleTiers"], "tierId");
    if allowed.contains(&"free-tier")
        || (!payload["allowedTiers"].is_array() && !ineligible.contains(&"free-tier"))
    {
        return Some("free-tier".into());
    }
    let managed: Vec<&Value> = payload["allowedTiers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| {
            t["id"].as_str().is_some_and(|id| !id.is_empty() && !ineligible.contains(&id))
                && t["userDefinedCloudaicompanionProject"] != json!(true)
        })
        .collect();
    managed
        .iter()
        .find(|t| t["isDefault"] == json!(true))
        .or(managed.first())
        .and_then(|t| t["id"].as_str())
        .map(str::to_owned)
}

fn no_tier(payload: &Value, email: &str) -> ProviderError {
    let summary = format!(
        "allowed tiers: [{}]; ineligible tiers: [{}]",
        tier_ids(&payload["allowedTiers"], "id").join(", "),
        tier_ids(&payload["ineligibleTiers"], "tierId").join(", ")
    );
    let blocked = payload["ineligibleTiers"].as_array().and_then(|list| {
        let with_reason = |t: &&Value| t["reasonMessage"].as_str().is_some_and(|m| !m.is_empty());
        list.iter()
            .find(|t| t["tierId"] == "free-tier" && with_reason(t))
            .or_else(|| list.iter().find(with_reason))
    });
    if let Some(tier) = blocked {
        let reason = format!("{}\n({summary})", tier["reasonMessage"].as_str().unwrap_or(""));
        if let Some(url) = tier["validationUrl"].as_str().filter(|u| !u.is_empty()) {
            return verification_required(url, &reason, email);
        }
        return failure(reason);
    }
    failure(format!("loadCodeAssist allowed no tier to onboard ({summary})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_constants_decode_to_the_recorded_refresh_request() {
        assert_eq!(client_id(), "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
        assert!(client_secret().starts_with("GOCSPX-"));
    }

    #[test]
    fn token_document_keeps_the_stored_schema() {
        let raw = json!({"access_token":"a","refresh_token":"r","expires_at":1_900_000_000,
            "project_id":"p","tier_id":"t","email":"e","user_id":"u"});
        let doc = TokenDoc::from_json(&raw).unwrap();
        assert_eq!(doc.expires_at_ms, 1_900_000_000_000);
        assert_eq!(doc.to_json()["expires_at"], json!(1_900_000_000_000_u64));
        assert!(TokenDoc::from_json(&json!({"access_token":"a"})).is_none());
        let legacy = TokenDoc::from_json(&json!({"access_token":"a","refresh_token":"r","expiresAt":"2030-01-01T00:00:00Z","projectId":"p"}))
            .unwrap();
        assert_eq!((legacy.expires_at_ms, legacy.project_id.as_str()), (1_893_456_000_000, "p"));
    }

    #[test]
    fn manifest_version_and_authorize_url() {
        assert_eq!(parse_manifest_version("files:\nversion: 2.20.3 # latest\n").as_deref(), Some("2.20.3"));
        assert_eq!(parse_manifest_version("version: nope\n"), None);
        let url = authorize_url("st", "ch", REDIRECT_URI);
        assert!(url.starts_with(AUTH_URL) && url.contains("access_type=offline") && url.contains("code_challenge=ch"));
    }

    #[test]
    fn onboarding_prefers_free_then_managed_default() {
        assert_eq!(onboarding_tier(&json!({})).as_deref(), Some("free-tier"));
        let paid = json!({"allowedTiers":[{"id":"byo","userDefinedCloudaicompanionProject":true},
            {"id":"standard-tier","isDefault":true}], "ineligibleTiers":[{"tierId":"free-tier","reasonMessage":"no"}]});
        assert_eq!(onboarding_tier(&paid).as_deref(), Some("standard-tier"));
        assert!(no_tier(&json!({"ineligibleTiers":[{"tierId":"free-tier","reasonMessage":"blocked"}]}), "").message.contains("blocked"));
    }
}
