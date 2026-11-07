//! The `openai-oauth` browser sign-in (`openai-oauth-login.mjs`
//! `beginBrowserLogin` / `exchangeAuthorizationCode`) as the provider side of
//! the shared PKCE flow. The loopback listener, the pasted-code path and the
//! five-minute deadline are the shared flow's; this supplies the authorize
//! URL, the code exchange and the stored credential.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginFailure;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::config::CODEX_ORIGINATOR;
use super::oauth::AUTH_CLAIM;
use super::oauth::CLIENT_ID;
use super::oauth::TOKEN_URL;
use super::oauth::account_of;
use super::oauth::claims_of;
use crate::oauth::AuthorizeRequest;
use crate::oauth::CredentialFile;
use crate::oauth::PkceProvider;
use crate::oauth::RefreshFailure;
use crate::oauth::Redirect;
use crate::oauth::classify_refresh_failure;
use crate::oauth::http;
use crate::oauth::scrub::oauth_body_summary;
use crate::transport::HttpSend;

pub const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
pub const SCOPE: &str = "openid profile email offline_access api.connectors.read api.connectors.invoke";
/// Bytes of the PKCE verifier (`createOAuthPkce(64)`).
const VERIFIER_BYTES: usize = 64;
const PROFILE_CLAIM: &str = "https://api.openai.com/profile";

fn failed(code: &str, message: &str) -> LoginFailure {
    LoginFailure::Failed { code: code.into(), message: message.into() }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Who the tokens belong to (`identityFromTokens`): `<sub>:<account id>` and
/// the email, each from the first token that carries it; `None` when neither.
fn identity_of(tokens: &[&str]) -> Option<Value> {
    let (mut email, mut account, mut sub) = (String::new(), String::new(), String::new());
    for claims in tokens.iter().filter_map(|t| claims_of(t)) {
        let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
        let auth = claims.get(AUTH_CLAIM);
        let profile = claims.get(PROFILE_CLAIM);
        if email.is_empty() {
            email = Some(text(claims.get("email"))).filter(|e| !e.is_empty()).unwrap_or_else(|| text(profile.and_then(|p| p.get("email"))));
        }
        if account.is_empty() {
            account = text(auth.and_then(|a| a.get("chatgpt_account_id")));
        }
        if sub.is_empty() {
            sub = text(claims.get("sub"));
        }
    }
    let id = [sub, account].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(":");
    let mut identity = Map::new();
    if !id.is_empty() {
        identity.insert("id".into(), json!(id.trim().chars().take(200).collect::<String>()));
    }
    let email = email.trim().to_owned();
    if !email.is_empty() {
        identity.insert("email".into(), json!(email.chars().take(200).collect::<String>()));
    }
    (!identity.is_empty()).then_some(Value::Object(identity))
}

pub struct OpenAiLogin {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    token_url: String,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl OpenAiLogin {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self { file, http, token_url: TOKEN_URL.to_owned(), clock: Arc::new(now_ms) }
    }

    /// Points the code exchange at another issuer's token endpoint.
    pub fn with_token_url(mut self, url: impl Into<String>) -> Self {
        self.token_url = url.into();
        self
    }

    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }
}

#[async_trait]
impl PkceProvider for OpenAiLogin {
    fn redirect(&self) -> Redirect {
        crate::oauth::redirects::OPENAI
    }

    fn verifier_bytes(&self) -> usize {
        VERIFIER_BYTES
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        let mut url = url::Url::parse(AUTHORIZE_URL).expect("a constant URL parses");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", request.redirect_uri)
            .append_pair("scope", SCOPE)
            .append_pair("code_challenge", request.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true")
            .append_pair("state", request.state)
            .append_pair("originator", CODEX_ORIGINATOR);
        url.into()
    }

    async fn exchange(&self, code: &str, verifier: &str, redirect_uri: &str) -> Result<Option<String>, LoginFailure> {
        let code = code.trim();
        if code.is_empty() {
            return Err(failed("invalid_callback", "[openai-oauth] authorization code is required"));
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "authorization_code")
            .append_pair("code", code)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("client_id", CLIENT_ID)
            .append_pair("code_verifier", verifier)
            .finish()
            .into_bytes();
        let reply = http::call(
            self.http.as_ref(),
            "POST",
            &self.token_url,
            vec![("Content-Type", "application/x-www-form-urlencoded".to_owned())],
            body,
        )
        .await?;
        if !reply.ok() {
            return Err(match classify_refresh_failure(Some(reply.status), &reply.body) {
                RefreshFailure::Definitive => LoginFailure::Denied,
                _ => {
                    // `oauthHttpError`: `<operation> <status>: <redacted body>`.
                    let summary = oauth_body_summary(&reply.text(), &[code, verifier]);
                    let detail = if summary.is_empty() { String::new() } else { format!(": {summary}") };
                    failed("token_exchange", &format!("[openai-oauth] token exchange {}{detail}", reply.status))
                }
            });
        }
        let json = reply.json().unwrap_or(Value::Null);
        let text = |key: &str| json.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
        let (Some(access), Some(refresh)) = (text("access_token"), text("refresh_token")) else {
            return Err(failed(
                "token_exchange",
                "[openai-oauth] token exchange response missing access_token or refresh_token",
            ));
        };
        // `expires_in` when the server sends a number, else the token's own `exp`.
        let expires_at = json
            .get("expires_in")
            .and_then(Value::as_f64)
            .map(|seconds| (self.clock)() + (seconds * 1000.0) as u64)
            .filter(|at| *at > 0)
            .or_else(|| {
                let exp = claims_of(access)?.get("exp")?.as_f64()?;
                (exp.is_finite() && exp > 0.0).then(|| (exp * 1000.0) as u64)
            })
            .unwrap_or(0);
        let identity = identity_of(&[text("id_token").unwrap_or_default(), access]);
        let label = identity
            .as_ref()
            .and_then(|i| i.get("email")?.as_str().map(str::to_owned));
        let mut stored = Map::new();
        stored.insert("access_token".into(), json!(access));
        stored.insert("refresh_token".into(), json!(refresh));
        stored.insert("expires_at".into(), json!(expires_at));
        if let Some(account) = account_of(access) {
            stored.insert("account_id".into(), json!(account));
        }
        stored.insert("identity".into(), identity.unwrap_or(Value::Null));
        self.file
            .save(&Value::Object(stored))
            .await
            .map_err(|_| failed("storage", "the tokens could not be stored"))?;
        Ok(label)
    }
}
