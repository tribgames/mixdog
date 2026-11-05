//! Vertex AI credentials: Application Default Credentials (a gcloud login,
//! a service-account key, an impersonated service account), a stored
//! service-account key, or an express-mode API key ([`super::ApiKeyAuth`]).
//! A token is minted once per credential identity and shared by every
//! attempt until five minutes before it expires.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::keepalive::TransportKind;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::Authorization;
use super::RequestAuth;
use super::TokenGrant;
use super::form_body;
use super::parse_token_grant;
use super::token_failure;
use crate::transport::HttpSend;

pub const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
pub const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
pub const EXPRESS_BASE: &str = "https://aiplatform.googleapis.com/v1";
const IAM_CREDENTIALS: &str = "https://iamcredentials.googleapis.com/v1";
const JWT_BEARER_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const REFRESH_SKEW_MS: u64 = 5 * 60_000;
/// Project sources ahead of the credential's own, in precedence order.
pub const PROJECT_ENV: [&str; 6] = [
    "GOOGLE_VERTEX_PROJECT",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "GCLOUD_PROJECT",
    "VERTEXAI_PROJECT",
    "ANTHROPIC_VERTEX_PROJECT_ID",
];

/// One grant of an ADC file or a stored key.
#[derive(Clone, Debug)]
pub enum Grant {
    ServiceAccount {
        client_email: String,
        private_key: String,
        project_id: String,
    },
    AuthorizedUser {
        client_id: String,
        client_secret: String,
        refresh_token: String,
    },
}

#[derive(Clone, Debug)]
pub enum Kind {
    Grant(Grant),
    Impersonated {
        target: String,
        delegates: Vec<String>,
        source: Grant,
    },
}

/// A parsed credential and the identity every token it mints is bound to.
#[derive(Clone, Debug)]
pub struct Credential {
    pub kind: Kind,
    pub account: String,
    pub project_id: String,
    pub quota_project_id: String,
    /// Hash of the credential's non-secret and secret parts; never the secret.
    pub identity: String,
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_owned()
}

fn invalid(message: impl Into<String>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = true;
    err.message = message.into();
    err
}

fn fingerprint(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn grant_of(value: &Value, path: &str, nested: bool) -> Result<(Grant, String, String), ProviderError> {
    let missing = |type_: &str, names: &[&str]| {
        let lacking: Vec<&str> = names.iter().copied().filter(|n| text(value, n).is_empty()).collect();
        (!lacking.is_empty())
            .then(|| invalid(format!("The {type_} credentials in {path} are missing {}.", lacking.join(", "))))
    };
    match text(value, "type").as_str() {
        "service_account" => {
            if let Some(err) = missing("service_account", &["client_email", "private_key"]) {
                return Err(err);
            }
            let (email, key) = (text(value, "client_email"), text(value, "private_key"));
            let print = fingerprint(&["service_account", &email, &key]);
            Ok((
                Grant::ServiceAccount { client_email: email.clone(), private_key: key, project_id: text(value, "project_id") },
                email,
                print,
            ))
        }
        "authorized_user" => {
            if let Some(err) = missing("authorized_user", &["client_id", "client_secret", "refresh_token"]) {
                return Err(err);
            }
            let (id, secret, refresh) =
                (text(value, "client_id"), text(value, "client_secret"), text(value, "refresh_token"));
            let print = fingerprint(&["authorized_user", &id, &secret, &refresh]);
            Ok((
                Grant::AuthorizedUser { client_id: id, client_secret: secret, refresh_token: refresh },
                text(value, "account"),
                print,
            ))
        }
        other => Err(invalid(format!(
            "Vertex AI does not support \"{}\" credentials{} ({path}). Use a service-account key, or sign in with \
             `gcloud auth application-default login`.",
            if other.is_empty() { "unknown" } else { other },
            if nested { " as an impersonation source" } else { "" },
        ))),
    }
}

/// One ADC file (`path` names it in messages and in the identity).
pub fn parse_adc(raw: &str, path: &str) -> Result<Credential, ProviderError> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| invalid(format!("The credentials file {path} is not valid JSON.")))?;
    let quota_project_id = text(&value, "quota_project_id");
    let (kind, account, project_id, print) = if text(&value, "type") == "impersonated_service_account" {
        let url = text(&value, "service_account_impersonation_url");
        let target = url
            .rsplit_once("/serviceAccounts/")
            .and_then(|(_, tail)| tail.strip_suffix(":generateAccessToken"))
            .filter(|t| !t.is_empty() && !t.contains(['/', ':', '?', '#']))
            .ok_or_else(|| {
                invalid(format!(
                    "The impersonated_service_account credentials in {path} have no valid \
                     service_account_impersonation_url."
                ))
            })?
            .to_owned();
        let (source, _, source_print) = grant_of(value.get("source_credentials").unwrap_or(&Value::Null), path, true)?;
        let delegates: Vec<String> = value
            .get("delegates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(|d| if d.starts_with("projects/") { d.to_owned() } else { format!("projects/-/serviceAccounts/{d}") })
            .collect();
        let print = fingerprint(&["impersonated", &target, &delegates.join(","), &source_print]);
        (Kind::Impersonated { target: target.clone(), delegates, source }, target, String::new(), print)
    } else {
        let (grant, account, print) = grant_of(&value, path, false)?;
        let project = match &grant {
            Grant::ServiceAccount { project_id, .. } => project_id.clone(),
            Grant::AuthorizedUser { .. } => String::new(),
        };
        (Kind::Grant(grant), account, project, print)
    };
    let identity = fingerprint(&["adc", path, &account, &project_id, &quota_project_id, &print]);
    Ok(Credential { kind, account, project_id, quota_project_id, identity })
}

/// A stored service-account key (settings), which must name its project.
pub fn parse_service_account(raw: &str) -> Result<Credential, ProviderError> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| invalid("Vertex AI service-account JSON is invalid."))?;
    if !value.is_object() {
        return Err(invalid("Vertex AI service-account JSON is invalid."));
    }
    let (email, key, project) = (text(&value, "client_email"), text(&value, "private_key"), text(&value, "project_id"));
    if email.is_empty() || key.is_empty() || project.is_empty() {
        return Err(invalid("Vertex AI service-account JSON must include client_email, private_key, and project_id."));
    }
    let identity = fingerprint(&["key", &email, &text(&value, "private_key_id"), &project, &key]);
    Ok(Credential {
        kind: Kind::Grant(Grant::ServiceAccount { client_email: email.clone(), private_key: key, project_id: project.clone() }),
        account: email,
        project_id: project,
        quota_project_id: String::new(),
        identity,
    })
}

/// The project a request targets when settings name none: the environment,
/// the credential's quota project, then its own project.
pub fn resolve_project(credential: &Credential, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    PROJECT_ENV
        .iter()
        .find_map(|name| env(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
        .or_else(|| Some(credential.quota_project_id.clone()).filter(|p| !p.is_empty()))
        .or_else(|| Some(credential.project_id.clone()).filter(|p| !p.is_empty()))
}

/// `https://{host}/v1/projects/{project}/locations/{location}`.
pub fn project_base(project: &str, location: &str) -> Result<String, ProviderError> {
    let valid_location = location.len() <= 63
        && location.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && location.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_location {
        return Err(invalid("[vertex-ai] location is invalid"));
    }
    let valid_project = (1..=128).contains(&project.len())
        && project.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid_project {
        return Err(invalid("[vertex-ai] project ID override is invalid"));
    }
    let host = match location {
        "global" => "aiplatform.googleapis.com".to_owned(),
        "us" | "eu" => format!("aiplatform.{location}.rep.googleapis.com"),
        other => format!("{other}-aiplatform.googleapis.com"),
    };
    Ok(format!("https://{host}/v1/projects/{project}/locations/{location}"))
}

fn pem_der(pem: &str) -> Result<(Vec<u8>, bool), ProviderError> {
    let pkcs1 = pem.contains("BEGIN RSA PRIVATE KEY");
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).flat_map(|l| l.trim().chars()).collect();
    let der = STANDARD.decode(body).map_err(|_| invalid("the service-account private key is not valid PEM"))?;
    Ok((der, pkcs1))
}

/// The RS256 assertion for the `jwt-bearer` grant.
pub fn jwt_assertion(client_email: &str, private_key: &str, now_secs: u64) -> Result<String, ProviderError> {
    let encode = |v: &Value| URL_SAFE_NO_PAD.encode(v.to_string());
    let input = format!(
        "{}.{}",
        encode(&json!({ "alg": "RS256", "typ": "JWT" })),
        encode(&json!({
            "iss": client_email, "scope": SCOPE, "aud": TOKEN_URI, "iat": now_secs, "exp": now_secs + 3600
        })),
    );
    let (der, pkcs1) = pem_der(private_key)?;
    let pair = if pkcs1 {
        ring::signature::RsaKeyPair::from_der(&der)
    } else {
        ring::signature::RsaKeyPair::from_pkcs8(&der)
    }
    .map_err(|_| invalid("could not sign the service-account JWT"))?;
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), input.as_bytes(), &mut signature)
        .map_err(|_| invalid("could not sign the service-account JWT"))?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

struct Minted {
    token: String,
    expires_at_ms: u64,
}

/// Mints and caches the access token of one credential.
pub struct VertexAuth {
    http: Arc<dyn HttpSend>,
    credential: Credential,
    now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    cached: Mutex<Option<Minted>>,
    /// One mint at a time per credential; callers wait for it and reuse it.
    minting: tokio::sync::Semaphore,
}

impl VertexAuth {
    pub fn new(http: Arc<dyn HttpSend>, credential: Credential, now_ms: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self { http, credential, now_ms, cached: Mutex::new(None), minting: tokio::sync::Semaphore::new(1) }
    }

    pub fn identity(&self) -> &str {
        &self.credential.identity
    }

    fn fresh(&self) -> Option<String> {
        let cached = self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cached
            .as_ref()
            .filter(|m| (self.now_ms)() + REFRESH_SKEW_MS < m.expires_at_ms)
            .map(|m| m.token.clone())
    }

    async fn post(&self, url: &str, headers: Vec<(String, String)>, body: Vec<u8>, what: &str) -> Result<Vec<u8>, ProviderError> {
        let response = self
            .http
            .send(WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: url.into(), headers, body })
            .await?;
        let status = response.status;
        let reply = response.read_all().await?;
        if (200..300).contains(&status) { Ok(reply.body) } else { Err(token_failure(status, &reply.body, what)) }
    }

    async fn grant_token(&self, grant: &Grant) -> Result<TokenGrant, ProviderError> {
        let form_header = vec![("content-type".to_owned(), "application/x-www-form-urlencoded".to_owned())];
        let body = match grant {
            Grant::AuthorizedUser { client_id, client_secret, refresh_token } => form_body(&[
                ("grant_type", "refresh_token"),
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("refresh_token", refresh_token),
            ]),
            Grant::ServiceAccount { client_email, private_key, .. } => {
                let assertion = jwt_assertion(client_email, private_key, (self.now_ms)() / 1000)?;
                form_body(&[("grant_type", JWT_BEARER_GRANT), ("assertion", &assertion)])
            }
        };
        let reply = self.post(TOKEN_URI, form_header, body, "Vertex AI token request").await?;
        parse_token_grant(&reply, "Vertex AI token")
    }

    async fn mint(&self) -> Result<Minted, ProviderError> {
        let now = (self.now_ms)();
        match &self.credential.kind {
            Kind::Grant(grant) => {
                let token = self.grant_token(grant).await?;
                Ok(Minted {
                    expires_at_ms: now + token.expires_in_secs.unwrap_or(3600).max(1) * 1000,
                    token: token.access_token,
                })
            }
            Kind::Impersonated { target, delegates, source } => {
                let source_token = self.grant_token(source).await?;
                let url = format!("{IAM_CREDENTIALS}/projects/-/serviceAccounts/{target}:generateAccessToken");
                let headers = vec![
                    ("content-type".to_owned(), "application/json".to_owned()),
                    ("authorization".to_owned(), format!("Bearer {}", source_token.access_token)),
                ];
                let body = json!({ "delegates": delegates, "scope": [SCOPE], "lifetime": "3600s" }).to_string();
                let reply = self.post(&url, headers, body.into_bytes(), "Vertex AI impersonation").await?;
                let value: Value = serde_json::from_slice(&reply).unwrap_or(Value::Null);
                let token = value
                    .get("accessToken")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| invalid("Vertex AI impersonation response is missing accessToken"))?;
                let expires_at_ms = value
                    .get("expireTime")
                    .and_then(Value::as_str)
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map(|t| t.timestamp_millis().max(0) as u64)
                    .unwrap_or(now + 3_600_000);
                Ok(Minted { token: token.to_owned(), expires_at_ms })
            }
        }
    }
}

#[async_trait]
impl RequestAuth for VertexAuth {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        let token = match self.fresh() {
            Some(token) => token,
            None => {
                let _gate = self.minting.acquire().await.map_err(|_| invalid("mint gate closed"))?;
                // Another caller may have minted while this one waited.
                match self.fresh() {
                    Some(token) => token,
                    None => {
                        let minted = self.mint().await?;
                        let token = minted.token.clone();
                        *self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(minted);
                        token
                    }
                }
            }
        };
        Ok(Authorization {
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
            identity: self.credential.identity.clone(),
        })
    }

    /// Drops only the token the server rejected; a fresher one stays.
    async fn rejected(&self, rejected: &Authorization) -> bool {
        let bearer = rejected.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
        let mut cached = self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if cached.as_ref().is_some_and(|m| bearer == Some(format!("Bearer {}", m.token).as_str())) {
            *cached = None;
        }
        true
    }
}
