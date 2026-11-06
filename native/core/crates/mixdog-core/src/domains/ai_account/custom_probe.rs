//! The two network probes of the custom-provider section of `provider-admin.mjs`:
//! `discoverCustomProviderModels` (:1725) and `testCustomProvider` (:1672), with their
//! `withTimeout` bound, `discoveryErrorView` and `sanitizeCustomError`.
//!
//! What a probe reads (the input resolved against the stored config and key) and builds (the
//! provider of that config) is the host's: `resolveCustomInput` normalizes with
//! `normalizeCustomProviderConfig`, and the provider is `createCustomProvider`.

use std::sync::Arc;
use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::providers::custom::listing::manual_rows;
use mixdog_ai::providers::custom::listing::public_rows;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::failure::Failure;

/// `CUSTOM_TEST_TIMEOUT_MS`.
pub const TEST_TIMEOUT: Duration = Duration::from_millis(20_000);
/// `CUSTOM_DISCOVERY_TIMEOUT_MS`: a catalog host can sit behind a slow gateway, so the wait
/// outlasts it to surface the service's own answer instead of a local timeout.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(60_000);

/// `resolveCustomInput(cfgMod, input, { requireModels: false })`.
pub struct ResolvedCustom {
    /// The provider id of an existing provider; `None` for an input not yet saved.
    pub id: Option<String>,
    /// The normalized, secret-free config.
    pub config: Value,
    /// The key: typed, else stored, else the environment variable of `apiKeyEnv`; empty when
    /// keyless.
    pub api_key: String,
}

/// A provider built from a resolved input (`createCustomProvider(id, { ...config, apiKey })`).
#[async_trait]
pub trait CustomEndpoint: Send + Sync {
    /// `provider.listModels()`: the effective rows, or the discovery error when nothing is usable.
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError>;

    /// `provider.customDiscoveryError`: the sanitized error of the latest discovery, if it failed.
    fn discovery_error(&self) -> Option<ProviderError>;

    /// One `Reply with OK.` send (`maxTokens: 16`) of `model`. A provider with additional keys
    /// (`key_ids`, in use order) sends through the key pool as a real request does; the answer
    /// names the key that served it.
    async fn send_test(&self, model: &str, key_ids: &[String]) -> Result<Option<String>, ProviderError>;
}

#[async_trait]
pub trait CustomProbeHost: Send + Sync {
    /// `requireLocalProviderManagement()`.
    fn require_local_provider_management(&self) -> Result<(), Failure>;

    /// `resolveCustomInput`; a refusal is the text Node throws.
    async fn resolve_input(&self, input: &Value) -> Result<ResolvedCustom, Failure>;

    /// `createCustomProvider(id, { ...config, apiKey })`.
    async fn create(&self, id: &str, config: &Value, api_key: &str) -> Result<Arc<dyn CustomEndpoint>, Failure>;

    /// `customProviderKeyIds(id)`: the additional keys saved for a provider.
    async fn key_ids(&self, id: &str) -> Vec<String>;

    /// `process.env[name]`.
    fn env(&self, name: &str) -> Option<String>;
}

pub struct CustomProbes {
    host: Arc<dyn CustomProbeHost>,
}

/// What stops a bounded step: its own failure, or the clock (`EPROVIDERTIMEOUT`).
enum Stopped {
    Timeout(String),
    Failed(ProviderError),
}

/// `withTimeout(run, ms, label)`; the run is dropped when the time is up (its abort).
async fn bounded<T>(
    run: impl std::future::Future<Output = Result<T, ProviderError>>,
    limit: Duration,
    label: &str,
) -> Result<T, Stopped> {
    match tokio::time::timeout(limit, run).await {
        Ok(done) => done.map_err(Stopped::Failed),
        Err(_) => Err(Stopped::Timeout(format!("{label} timed out after {}s", (limit.as_millis() as f64 / 1000.0).round()))),
    }
}

impl Stopped {
    fn message(&self) -> &str {
        match self {
            Self::Timeout(message) => message,
            Self::Failed(error) => &error.message,
        }
    }
}

static BEARER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "gi"));
static TOKEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(?:sk|key|tok)[-_][A-Za-z0-9_-]{8,}", "gi"));
static FIELD: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"(api[-_]?key|authorization|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+"#, "gi"));
static NEWLINES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\r\n]+", "g"));

/// `sanitizeCustomError(error, secrets).message`: the secrets and credential-looking text
/// redacted, one line, at most 300 characters.
pub fn sanitize_message(message: &str, secrets: &[String]) -> String {
    let mut text = if message.is_empty() { "request failed".to_owned() } else { message.to_owned() };
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        text = text.split(secret.as_str()).collect::<Vec<_>>().join("[redacted]");
    }
    text = BEARER.replace_all_with(&text, |_| "Bearer [redacted]".to_owned());
    text = TOKEN.replace_all_with(&text, |_| "[redacted]".to_owned());
    text = FIELD.replace_all_with(&text, |caps| format!("{}{}[redacted]", caps.get(1).unwrap_or_default(), caps.get(2).unwrap_or_default()));
    text = NEWLINES.replace_all_with(&text, |_| " ".to_owned());
    let mut text = js_trim(&text).to_owned();
    if utf16_len(&text) > 300 {
        text = format!("{}…", slice_utf16(&text, 300));
    }
    if text.is_empty() { "request failed".to_owned() } else { text }
}

/// `discoveryErrorView`.
fn error_view(message: &str, status: Option<u16>, timed_out: bool, secrets: &[String]) -> Value {
    let auth_kind = if matches!(status, Some(401 | 403)) { "authentication" } else { "request" };
    let kind = if matches!(status, Some(404 | 405)) { "unavailable" } else { auth_kind };
    let mut view = Map::new();
    view.insert("kind".into(), json!(if timed_out { "timeout" } else { kind }));
    if let Some(status) = status {
        view.insert("status".into(), json!(status));
    }
    view.insert("message".into(), json!(sanitize_message(message, secrets)));
    Value::Object(view)
}

fn provider_error_view(error: &ProviderError, secrets: &[String]) -> Value {
    error_view(&error.message, error.status, false, secrets)
}

fn stopped_view(stopped: &Stopped, secrets: &[String]) -> Value {
    match stopped {
        Stopped::Timeout(message) => error_view(message, None, true, secrets),
        Stopped::Failed(error) => provider_error_view(error, secrets),
    }
}

/// `customSecrets`: every key the operation may have sent. Env mode re-reads the variable on an
/// auth retry, so its current value is redacted beside the initial key.
fn secrets_of(host: &dyn CustomProbeHost, api_key: &str, config: &Value) -> Vec<String> {
    let env = config.get("apiKeyEnv").and_then(Value::as_str).filter(|name| !name.is_empty()).and_then(|name| host.env(name));
    vec![api_key.to_owned(), env.unwrap_or_default()]
}

impl CustomProbes {
    pub fn new(host: Arc<dyn CustomProbeHost>) -> Self {
        Self { host }
    }

    /// `discoverCustomProviderModels`: `{ models }`, or `{ models, error }` when discovery failed.
    pub async fn discover_models(&self, input: Value) -> Result<Value, Failure> {
        self.host.require_local_provider_management()?;
        let resolved = self.host.resolve_input(&input).await?;
        let secrets = secrets_of(self.host.as_ref(), &resolved.api_key, &resolved.config);
        let id = resolved.id.as_deref().unwrap_or("custom-discovery");
        let provider = match self.host.create(id, &resolved.config, &resolved.api_key).await {
            Ok(provider) => provider,
            Err(failure) => return Ok(json!({ "models": [], "error": error_view(failure.message(), None, false, &secrets) })),
        };
        let listed = bounded(provider.list_models(), DISCOVERY_TIMEOUT, "model discovery").await;
        Ok(match listed {
            Ok(rows) => {
                let models = public_rows(&rows);
                // A failed discovery that still left manual rows reports its error too.
                match provider.discovery_error() {
                    Some(failure) => json!({ "models": models, "error": provider_error_view(&failure, &secrets) }),
                    None => json!({ "models": models }),
                }
            }
            Err(stopped) => json!({ "models": [], "error": stopped_view(&stopped, &secrets) }),
        })
    }

    /// `testCustomProvider`: `{ ok: true }` (with the pooled key that served), or `{ ok: false,
    /// phase: 'discovery', error }`. A send that fails is thrown, sanitized.
    pub async fn test(&self, input: Value) -> Result<Value, Failure> {
        self.host.require_local_provider_management()?;
        let resolved = self.host.resolve_input(&input).await?;
        let secrets = secrets_of(self.host.as_ref(), &resolved.api_key, &resolved.config);
        let thrown = |message: &str| Failure::error(sanitize_message(message, &secrets));
        // The first visible manual model needs no discovery; otherwise the first visible
        // discovered one.
        let mut model = manual_rows(&resolved.config).into_iter().find(|row| !row.hidden).map(|row| row.id);
        if model.is_none() {
            let discovery = self.discover_models(input.clone()).await.map_err(|failure| thrown(failure.message()))?;
            if let Some(error) = discovery.get("error").filter(|error| !error.is_null()) {
                return Ok(json!({ "ok": false, "phase": "discovery", "error": error }));
            }
            model = discovery["models"]
                .as_array()
                .and_then(|models| models.iter().find(|row| row["hidden"] != Value::Bool(true)))
                .and_then(|row| row["id"].as_str().map(str::to_owned));
        }
        let Some(model) = model else {
            return Ok(json!({ "ok": false, "phase": "discovery", "error": { "kind": "empty", "message": "No models were found for this provider" } }));
        };
        let id = resolved.id.as_deref().unwrap_or("custom-test");
        let provider = self.host.create(id, &resolved.config, &resolved.api_key).await.map_err(|failure| thrown(failure.message()))?;
        // A provider with additional keys tests through the same key pool as a real request: an
        // explicit quota refusal moves on to the next key.
        let own_keys = resolved.id.is_some()
            && resolved.config.get("apiKeyEnv").and_then(Value::as_str).is_none_or(str::is_empty)
            && resolved.config.get("auth").and_then(Value::as_str) != Some("none");
        let key_ids = match (&resolved.id, own_keys) {
            (Some(id), true) => self.host.key_ids(id).await,
            _ => Vec::new(),
        };
        let served = bounded(provider.send_test(&model, &key_ids), TEST_TIMEOUT, "connection test")
            .await
            .map_err(|stopped| thrown(stopped.message()))?;
        // Key numbers count the primary key as 1.
        let index = served.as_ref().and_then(|served| key_ids.iter().position(|key| key == served));
        Ok(match (index, served) {
            (Some(index), Some(served)) => json!({ "ok": true, "key": { "id": served, "number": index + 2 } }),
            _ => json!({ "ok": true }),
        })
    }
}
