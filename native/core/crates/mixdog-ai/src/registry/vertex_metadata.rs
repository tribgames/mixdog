//! The GCE / Cloud Run / GKE metadata server as Vertex AI's credential source
//! when there is no gcloud login (`vertex-ai-auth.mjs`: `probeVertexMetadata`,
//! `metadataCredential`, the `metadata` kind of `_grant`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

use crate::providers::google::auth::Authorization;
use crate::providers::google::auth::RequestAuth;
use crate::transport::HttpSend;

const METADATA_URL: &str = "http://metadata.google.internal/computeMetadata/v1";
const PROBE_TIMEOUT: Duration = Duration::from_millis(1000);
const REFRESH_SKEW_MS: u64 = 5 * 60_000;

fn get(url: String) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "GET".into(),
        url,
        headers: vec![("Metadata-Flavor".into(), "Google".into())],
        body: Vec::new(),
    }
}

/// Whether a metadata server answers, and its project. Only the server itself
/// answers with the `Metadata-Flavor: Google` header; any failure is "none".
pub async fn probe_project(http: &Arc<dyn HttpSend>) -> Option<String> {
    let ask = async {
        let response = http.send(get(format!("{METADATA_URL}/project/project-id"))).await.ok()?;
        let flavored = response.headers.iter().any(|(n, v)| n.eq_ignore_ascii_case("metadata-flavor") && v == "Google");
        if !response.is_success() || !flavored {
            return None;
        }
        let body = response.read_all().await.ok()?.body;
        let project = String::from_utf8_lossy(&body).trim().to_owned();
        (!project.is_empty()).then_some(project)
    };
    tokio::time::timeout(PROBE_TIMEOUT, ask).await.ok().flatten()
}

/// The identity of the metadata server's default service account in `project`.
pub fn identity(project: &str) -> String {
    serde_json::json!(["adc", "metadata", project]).to_string()
}

struct Minted {
    token: String,
    expires_at_ms: u64,
}

/// Mints and caches the default service account's access token.
pub struct MetadataAuth {
    http: Arc<dyn HttpSend>,
    identity: String,
    now_ms: Box<dyn Fn() -> u64 + Send + Sync>,
    cached: Mutex<Option<Minted>>,
    minting: tokio::sync::Semaphore,
}

fn auth_failure(detail: &str, status: Option<u16>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.status = status;
    err.message = format!("Vertex AI authentication failed: {detail}");
    err
}

/// `errorDetail`: the payload's own words, else the HTTP status.
fn detail(payload: &Value, status: u16) -> String {
    let error = payload.get("error");
    let text = payload
        .get("error_description")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| error.and_then(|e| e.get("message")).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .or_else(|| error.and_then(Value::as_str).filter(|s| !s.is_empty()))
        .map_or_else(|| format!("HTTP {status}"), str::to_owned);
    text.chars().take(240).collect()
}

impl MetadataAuth {
    pub fn new(http: Arc<dyn HttpSend>, project: &str, now_ms: Box<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            http,
            identity: identity(project),
            now_ms,
            cached: Mutex::new(None),
            minting: tokio::sync::Semaphore::new(1),
        }
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    fn fresh(&self) -> Option<String> {
        let cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        cached.as_ref().filter(|m| (self.now_ms)() + REFRESH_SKEW_MS < m.expires_at_ms).map(|m| m.token.clone())
    }

    async fn mint(&self) -> Result<Minted, ProviderError> {
        let now = (self.now_ms)();
        let response = self
            .http
            .send(get(format!("{METADATA_URL}/instance/service-accounts/default/token")))
            .await
            .map_err(|e| auth_failure(if e.message.is_empty() { "token request failed" } else { &e.message }, None))?;
        let status = response.status;
        let body = response.read_all().await?.body;
        let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let token = payload.get("access_token").and_then(Value::as_str).filter(|t| !t.is_empty());
        let (true, Some(token)) = ((200..300).contains(&status), token) else {
            return Err(auth_failure(&detail(&payload, status), Some(status)));
        };
        let expires_in = payload.get("expires_in").and_then(Value::as_f64).filter(|n| *n > 0.0).unwrap_or(3600.0);
        Ok(Minted { token: token.to_owned(), expires_at_ms: now + (expires_in.max(1.0) as u64) * 1000 })
    }
}

#[async_trait]
impl RequestAuth for MetadataAuth {
    async fn authorize(&self) -> Result<Authorization, ProviderError> {
        let token = match self.fresh() {
            Some(token) => token,
            None => {
                let _gate = self.minting.acquire().await.map_err(|_| auth_failure("mint gate closed", None))?;
                match self.fresh() {
                    Some(token) => token,
                    None => {
                        let minted = self.mint().await?;
                        let token = minted.token.clone();
                        *self.cached.lock().unwrap_or_else(PoisonError::into_inner) = Some(minted);
                        token
                    }
                }
            }
        };
        Ok(Authorization {
            headers: vec![("authorization".into(), format!("Bearer {token}"))],
            identity: self.identity.clone(),
        })
    }

    /// Drops only the token the server rejected; a fresher one stays.
    async fn rejected(&self, rejected: &Authorization) -> bool {
        let bearer = rejected.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        if cached.as_ref().is_some_and(|m| bearer == Some(format!("Bearer {}", m.token).as_str())) {
            *cached = None;
        }
        true
    }
}

#[cfg(test)]
mod tests;
