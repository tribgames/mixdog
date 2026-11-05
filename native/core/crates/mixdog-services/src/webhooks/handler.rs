//! `POST /webhook/<name>`: endpoint gate, signature check, test probe, delivery claim,
//! body parse, dispatch. Pure over its store and dispatcher, so the transport only moves
//! bytes. Each request is independent; nothing here is shared between requests.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use super::deliveries::{delivery_id, headers_summary};
use super::signature::{Headers, extract_signature, verify_signature};
use crate::channels::running::{RunningWork, WorkGuard};

pub const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
pub const WEBHOOK_TEST_HEADER: &str = "x-mixdog-webhook-test";
pub const WEBHOOK_TEST_FIELD: &str = "mixdogWebhookTest";

#[derive(Debug, Clone, PartialEq)]
pub struct HttpReply {
    pub status: u16,
    pub body: Value,
}

impl HttpReply {
    fn error(status: u16, message: &str) -> Self {
        Self { status, body: json!({ "error": message }) }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Endpoint {
    pub enabled: Option<bool>,
    pub parser: Option<String>,
    pub allow_unsigned: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookConfig {
    pub secret: Option<String>,
    pub allow_unsigned_webhooks: bool,
    pub endpoints: HashMap<String, Endpoint>,
}

pub struct Claim<'a> {
    pub status: &'a str,
    pub event: Option<&'a str>,
    pub headers_summary: Value,
    pub payload_preview: String,
}

#[async_trait]
pub trait WebhookStore: Send + Sync {
    async fn load_endpoint(&self, name: &str) -> Result<Option<Endpoint>, String>;
    /// The one explicit read path of an endpoint's signing secret.
    async fn read_secret(&self, name: &str) -> Result<Option<String>, String>;
    /// Atomic claim and dedup in one step; false when the delivery was already claimed.
    async fn claim_delivery(&self, endpoint: &str, delivery_id: &str, claim: Claim<'_>) -> Result<bool, String>;
    async fn update_delivery_status(
        &self,
        endpoint: &str,
        delivery_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String>;
}

/// Hands an accepted event to the owner's routine run and answers the sender.
#[async_trait]
pub trait WebhookDispatch: Send + Sync {
    async fn handle(
        &self,
        name: &str,
        payload: Value,
        headers: &Headers,
        delivery_id: &str,
        endpoint_in_table: bool,
    ) -> Result<HttpReply, String>;
}

pub struct WebhookService {
    store: Arc<dyn WebhookStore>,
    dispatch: Arc<dyn WebhookDispatch>,
    config: RwLock<WebhookConfig>,
    work: RunningWork,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    warned_unsigned: std::sync::atomic::AtomicBool,
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The endpoint name of a `/webhook/<name>[?query]` path.
pub fn parse_endpoint_name(path: &str) -> String {
    let raw = path.strip_prefix("/webhook/").unwrap_or("").split('?').next().unwrap_or("");
    percent_decode(raw).unwrap_or_else(|| raw.to_string())
}

/// Endpoint names are `[a-zA-Z0-9_-]{1,64}`; anything else never reaches a table lookup.
pub fn valid_endpoint_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `Some(true)` for a probe whose header and in-body marker agree, `Some(false)` when
/// they disagree. The marker sits inside the signed body, the header does not, so either
/// alone is rejected. A probe never dispatches.
fn test_probe(headers: &Headers, raw_body: &[u8]) -> Option<bool> {
    let header = headers.get(WEBHOOK_TEST_HEADER).is_some_and(|v| v == "1");
    let marked = serde_json::from_slice::<Value>(raw_body)
        .ok()
        .is_some_and(|v| v.get(WEBHOOK_TEST_FIELD) == Some(&Value::Bool(true)));
    (header || marked).then_some(header && marked)
}

impl WebhookService {
    pub fn new(
        store: Arc<dyn WebhookStore>,
        dispatch: Arc<dyn WebhookDispatch>,
        config: WebhookConfig,
        work: RunningWork,
        now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            dispatch,
            config: RwLock::new(config),
            work,
            now_ms,
            warned_unsigned: Default::default(),
        }
    }

    pub fn set_config(&self, config: WebhookConfig) {
        *self.config.write().unwrap() = config;
    }

    /// Held by the transport while the webhook listener is up: a listening server is work.
    pub fn listening(&self) -> WorkGuard {
        self.work.begin()
    }

    fn config_endpoint(&self, name: &str) -> Option<Endpoint> {
        self.config.read().unwrap().endpoints.get(name).cloned()
    }

    /// Gate before the body is read: name shape, registration, enabled.
    pub async fn precheck(&self, path: &str) -> Result<String, HttpReply> {
        let name = parse_endpoint_name(path);
        if !valid_endpoint_name(&name) {
            tracing::warn!("webhook rejected: invalid endpoint name");
            return Err(HttpReply::error(404, "invalid endpoint name"));
        }
        let endpoint = match self.store.load_endpoint(&name).await {
            Ok(db) => db.or_else(|| self.config_endpoint(&name)),
            Err(err) => {
                tracing::warn!("webhook {name}: endpoint lookup failed — {err}");
                return Err(HttpReply::error(500, "internal error"));
            }
        };
        match endpoint {
            Some(e) if e.enabled == Some(false) => Err(HttpReply::error(404, "disabled endpoint")),
            Some(_) => Ok(name),
            None => Err(HttpReply::error(404, "unknown endpoint")),
        }
    }

    pub fn body_too_large(len: usize) -> Option<HttpReply> {
        (len > MAX_BODY_BYTES).then(|| HttpReply { status: 413, body: json!({"error":"payload too large","limit":MAX_BODY_BYTES}) })
    }

    /// One whole request (the transport has the full body in hand).
    pub async fn handle_post(&self, path: &str, headers: &Headers, raw_body: &[u8]) -> HttpReply {
        let _busy = self.work.begin();
        let name = match self.precheck(path).await {
            Ok(name) => name,
            Err(reply) => return reply,
        };
        if let Some(reply) = Self::body_too_large(raw_body.len()) {
            return reply;
        }
        self.process(&name, headers, raw_body).await
    }

    fn verify(&self, name: &str, endpoint: &Endpoint, in_table: bool, secret: Option<&str>, body: &[u8], headers: &Headers) -> Result<(), HttpReply> {
        let config = self.config.read().unwrap();
        let parser = endpoint.parser.clone().or_else(|| config.endpoints.get(name).and_then(|e| e.parser.clone()));
        let parser = parser.as_deref().filter(|p| !p.is_empty());
        if let Some(secret) = secret {
            let Some(sig) = extract_signature(headers, parser) else {
                tracing::warn!("webhook {name}: rejected — no signature header found");
                return Err(HttpReply { status: 403, body: json!({"ok":false,"error":"missing signature"}) });
            };
            if !verify_signature(secret, body, &sig, parser, (self.now_ms)()) {
                tracing::warn!("webhook {name}: rejected — signature mismatch");
                return Err(HttpReply { status: 403, body: json!({"ok":false,"error":"invalid signature"}) });
            }
            return Ok(());
        }
        // Fail closed: a configured parser implies a signed integration, and a table
        // endpoint is privileged; neither may fall back to unsigned input.
        if let Some(parser) = parser {
            tracing::warn!("webhook {name}: rejected — parser \"{parser}\" configured but no secret set");
            return Err(HttpReply::error(401, "webhook secret required for signed parser"));
        }
        if in_table {
            tracing::warn!("webhook {name}: rejected (table endpoint requires a webhook secret)");
            return Err(HttpReply::error(401, "webhook secret required for endpoint"));
        }
        let allow = endpoint.allow_unsigned == Some(true)
            || config.endpoints.get(name).and_then(|e| e.allow_unsigned) == Some(true)
            || config.allow_unsigned_webhooks;
        if !allow {
            tracing::warn!("webhook {name}: rejected — unsigned request and no secret configured");
            return Err(HttpReply::error(401, "webhook secret required for endpoint"));
        }
        if !self.warned_unsigned.swap(true, std::sync::atomic::Ordering::Relaxed) {
            tracing::warn!("webhook warning — unsigned webhooks explicitly allowed, skipping signature verification");
        }
        Ok(())
    }

    async fn fail(&self, name: &str, id: &str, error: &str) {
        if let Err(err) = self.store.update_delivery_status(name, id, "failed", Some(error)).await {
            tracing::error!("webhook: failed to mark delivery {name}/{id} failed — {err}");
        }
    }

    pub async fn process(&self, name: &str, headers: &Headers, raw_body: &[u8]) -> HttpReply {
        let mut claimed_id: Option<String> = None;
        match self.process_inner(name, headers, raw_body, &mut claimed_id).await {
            Ok(reply) => reply,
            Err(Failure::Invalid(message)) => {
                tracing::warn!("webhook JSON parse error for {name}: {message}");
                if let Some(id) = &claimed_id {
                    self.fail(name, id, &format!("invalid JSON: {message}")).await;
                }
                HttpReply::error(400, "invalid JSON")
            }
            Err(Failure::Internal(message)) => {
                tracing::warn!("webhook {name}: request failed: {message}");
                // A terminal failed row closes the `received` claim so retries don't loop on dedup.
                if let Some(id) = &claimed_id {
                    self.fail(name, id, &message).await;
                }
                HttpReply::error(500, "internal error")
            }
        }
    }

    async fn process_inner(
        &self,
        name: &str,
        headers: &Headers,
        raw_body: &[u8],
        claimed_id: &mut Option<String>,
    ) -> Result<HttpReply, Failure> {
        let db_endpoint = self.store.load_endpoint(name).await.map_err(Failure::Internal)?;
        let endpoint = db_endpoint.clone().or_else(|| self.config_endpoint(name));
        let in_table = db_endpoint.is_some();
        let Some(endpoint) = endpoint else { return Ok(HttpReply::error(404, "unknown endpoint")) };
        if endpoint.enabled == Some(false) {
            tracing::warn!("webhook rejected: disabled endpoint {name}");
            return Ok(HttpReply::error(404, "disabled endpoint"));
        }
        let secret = self
            .store
            .read_secret(name)
            .await
            .map_err(Failure::Internal)?
            .filter(|s| !s.is_empty())
            .or_else(|| self.config.read().unwrap().secret.clone().filter(|s| !s.is_empty()));
        if let Err(reply) = self.verify(name, &endpoint, in_table, secret.as_deref(), raw_body, headers) {
            return Ok(reply);
        }
        if let Some(agree) = test_probe(headers, raw_body) {
            // A probe is "verified" only after a real HMAC check, and never makes a row.
            let reply = if !agree {
                HttpReply::error(400, "invalid test request")
            } else if secret.is_none() {
                HttpReply::error(401, "test requires a signing secret")
            } else {
                HttpReply { status: 200, body: json!({"status":"verified","test":true}) }
            };
            return Ok(reply);
        }
        let body_text = String::from_utf8_lossy(raw_body);
        let id = delivery_id(headers, raw_body);
        let event = headers.get("x-github-event").filter(|v| !v.is_empty()).map(String::as_str);
        let claim = Claim {
            status: "received",
            event,
            headers_summary: headers_summary(headers),
            payload_preview: mixdog_js::slice_utf16(&body_text, 512),
        };
        let claimed = self.store.claim_delivery(name, &id, claim).await.map_err(Failure::Internal)?;
        *claimed_id = Some(id.clone());
        if !claimed {
            tracing::info!("webhook {name}: dedup {id}");
            return Ok(HttpReply { status: 200, body: json!({"status":"dedup","id":id}) });
        }
        let ctype = headers.get("content-type").map(|v| v.to_lowercase()).unwrap_or_default();
        let looks_json = ctype.contains("application/json") || ctype.contains("+json");
        if !raw_body.is_empty() && !looks_json {
            // A terminal failed row resolves the `received` claim so retries don't dedup forever.
            let shown = if ctype.is_empty() { "<none>" } else { &ctype };
            self.fail(name, &id, &format!("unsupported content-type: {shown}")).await;
            return Ok(HttpReply { status: 415, body: json!({"error":"unsupported content-type","expected":"application/json"}) });
        }
        let parsed: Value = if raw_body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(raw_body).map_err(|e| Failure::Invalid(e.to_string()))?
        };
        // Our own issue comments carry this marker; forwarding one would self-trigger.
        let own_comment = event == Some("issue_comment")
            && parsed["comment"]["body"].as_str().is_some_and(|b| b.starts_with("[mixdog "));
        if own_comment {
            self.store.update_delivery_status(name, &id, "self-comment-skip", None).await.map_err(Failure::Internal)?;
            return Ok(HttpReply { status: 202, body: json!({"status":"self-comment-skip","id":id}) });
        }
        self.store.update_delivery_status(name, &id, "pending", None).await.map_err(Failure::Internal)?;
        self.dispatch.handle(name, parsed, headers, &id, in_table).await.map_err(Failure::Internal)
    }
}

enum Failure {
    Invalid(String),
    Internal(String),
}
