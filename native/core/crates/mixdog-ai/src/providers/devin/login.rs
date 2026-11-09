//! The Devin sign-in (`providers/devin-auth.mjs` `generateDevinOAuthParams` / `exchangeDevinCode` /
//! `tokenRecord`) as the provider side of the shared PKCE flow. The loopback listener on
//! 127.0.0.1:59653, the pasted-address path, the state check and the five-minute deadline are the
//! shared flow's; this supplies the authorize URL, the code exchange and the stored credential.
//!
//! The login token is the only credential and cannot be refreshed: a token without a readable
//! `exp` claim is assumed to live for a year. Response bodies may carry the token itself, so an
//! error names the status only. A request that got no answer is worded by its cause as Node words it
//! (`oauthNetworkCause`): "timed out" or the error code the typed fault names, else "network error".

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::login::LoginFailure;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::oauth::AuthorizeRequest;
use crate::oauth::CredentialFile;
use crate::oauth::PkceProvider;
use crate::oauth::Redirect;
use crate::oauth::http;
use crate::transport::HttpSend;

pub const AUTHORIZE_URL: &str = "https://app.devin.ai/auth/cli/continue";
pub const TOKEN_URL: &str = "https://api.devin.ai/auth/cli/token";
pub const REDIRECT: Redirect = Redirect { host: "127.0.0.1", port: 59653, path: "/callback" };
const DEFAULT_TOKEN_LIFETIME_MS: u64 = 365 * 24 * 60 * 60_000;

pub struct DevinLogin {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl DevinLogin {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self { file, http, clock: Arc::new(now_ms) }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `DEVIN_OAUTH_<CODE>: <text>`: the message the desktop words in the user's language.
fn coded(code: &str, text: impl AsRef<str>) -> LoginFailure {
    let failure_code = format!("DEVIN_OAUTH_{code}");
    LoginFailure::Failed { message: format!("{failure_code}: {}", text.as_ref()), code: failure_code }
}

/// The claims of a JWT (`decodeJwtPayload`), if the token has three parts and an object payload.
fn claims_of(token: &str) -> Option<Map<String, Value>> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1].trim_end_matches('=').replace('+', "-").replace('/', "_");
    match serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()? {
        Value::Object(claims) => Some(claims),
        _ => None,
    }
}

/// `cleanIdentityText`: a string, trimmed, cut to 200 UTF-16 units.
fn identity_text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|s| mixdog_js::slice_utf16(mixdog_js::js_trim(s), 200)).unwrap_or_default()
}

/// `tokenRecord(accessToken)` at `now`.
pub fn token_record(access_token: &str, now: u64) -> Value {
    let claims = claims_of(access_token);
    let exp = claims.as_ref().and_then(|c| c.get("exp")).and_then(Value::as_f64).filter(|e| e.is_finite() && *e > 0.0);
    let expires_at = exp.map_or(now + DEFAULT_TOKEN_LIFETIME_MS, |e| (e * 1000.0) as u64);
    let (id, email) = claims.as_ref().map_or((String::new(), String::new()), |c| (identity_text(c.get("sub")), identity_text(c.get("email"))));
    let mut record = Map::new();
    record.insert("access_token".into(), json!(access_token));
    record.insert("refresh_token".into(), Value::Null);
    record.insert("expires_at".into(), json!(expires_at));
    if !id.is_empty() || !email.is_empty() {
        let mut identity = Map::new();
        if !id.is_empty() {
            identity.insert("id".into(), json!(id));
        }
        if !email.is_empty() {
            identity.insert("email".into(), json!(email));
        }
        record.insert("identity".into(), Value::Object(identity));
    }
    Value::Object(record)
}

#[async_trait]
impl PkceProvider for DevinLogin {
    fn redirect(&self) -> Redirect {
        REDIRECT
    }

    fn authorize_url(&self, request: &AuthorizeRequest<'_>) -> String {
        let mut url = url::Url::parse(AUTHORIZE_URL).expect("a constant URL parses");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", request.redirect_uri)
            .append_pair("code_challenge", request.code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", request.state)
            .append_pair("prompt", "select_account");
        url.into()
    }

    async fn exchange(&self, code: &str, verifier: &str, _redirect_uri: &str) -> Result<Option<String>, LoginFailure> {
        let body = serde_json::to_vec(&json!({ "code": code, "code_verifier": verifier })).expect("a JSON value serializes");
        let headers = vec![("Accept", "application/json".to_owned()), ("Content-Type", "application/json".to_owned())];
        let reply = http::try_call(self.http.as_ref(), "POST", TOKEN_URL, headers, body)
            .await
            .map_err(|error| coded("TOKEN_EXCHANGE_FAILED", format!("Devin token exchange request failed ({}). {}", http::network_cause(&error), http::NETWORK_HINT)))?;
        // Response bodies may carry the login token: only the status is reported.
        if !reply.ok() {
            return Err(coded("TOKEN_EXCHANGE_FAILED", format!("Devin token exchange failed ({})", reply.status)));
        }
        let token = reply.json().as_ref().and_then(|data| data.get("token")).and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_owned);
        let Some(token) = token else {
            return Err(coded("TOKEN_EXCHANGE_FAILED", "Devin token exchange returned no token"));
        };
        let record = token_record(&token, (self.clock)());
        let label = record.get("identity").and_then(|i| i.get("email")).and_then(Value::as_str).map(str::to_owned);
        self.file.save(&record).await.map_err(|_| http::failed("storage", "the tokens could not be stored"))?;
        Ok(label)
    }
}
