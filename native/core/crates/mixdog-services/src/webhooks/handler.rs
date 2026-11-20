//! `POST /webhook/<name>`: endpoint gate, signature check, test probe, delivery claim,
//! body parse, dispatch. Pure over its store and dispatcher, so the transport only moves
//! bytes. Each request is independent; nothing here is shared between requests.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};

use async_trait::async_trait;
use mixdog_rt::{Scope, Scoped};
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
    /// Every answer the webhook endpoint writes carries this one header (`Content-Type`).
    pub const CONTENT_TYPE: &'static str = "application/json";

    fn error(status: u16, message: &str) -> Self {
        Self { status, body: json!({ "error": message }) }
    }
}

/// An answer the transport writes and then drops the request after (Node's `rejectRequest`
/// and the 413: `req.destroy()`), so the connection closes behind it.
#[derive(Debug, Clone, PartialEq)]
pub struct Rejection(pub HttpReply);

/// The transport's body reader (`collectRawBody`): feed it each wire chunk as it arrives.
/// The first chunk that takes the total past the cap yields the 413 reply, once; the
/// transport sends it and drops the connection. Later chunks are discarded, so the buffer
/// never holds more than `MAX_BODY_BYTES`.
#[derive(Default)]
pub struct BodyCollector {
    bytes: Vec<u8>,
    too_large: bool,
}

impl BodyCollector {
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), Rejection> {
        if self.too_large {
            return Ok(());
        }
        if self.bytes.len() + chunk.len() > MAX_BODY_BYTES {
            self.too_large = true;
            self.bytes = Vec::new();
            return Err(Rejection(WebhookService::body_too_large(MAX_BODY_BYTES + 1).expect("over the cap")));
        }
        self.bytes.extend_from_slice(chunk);
        Ok(())
    }

    /// The request was aborted or its socket failed mid-body. Node's collector has no handler
    /// for either, so nothing more happens: no answer, no `destroy`, no processing of the
    /// partial body. A 413 already sent stays the one answer. Returns what the read had settled
    /// with: None while it is still pending (the partial body is dropped), `Some(None)` when the
    /// overflow had already settled it with no body.
    pub fn cut_short(self) -> Option<Option<Vec<u8>>> {
        self.too_large.then_some(None)
    }

    /// The whole body at the end of the stream; None when it overflowed.
    pub fn finish(self) -> Option<Vec<u8>> {
        (!self.too_large).then_some(self.bytes)
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
    /// Whether the endpoint table holds an endpoint that is not switched off: the receiver has something to receive
    /// for. A store that cannot list says none.
    async fn any_enabled_endpoint(&self) -> Result<bool, String> {
        Ok(false)
    }
    /// Atomic claim and dedup in one step; only a failed handoff (not a failed bot run) can be reclaimed.
    async fn claim_delivery(&self, endpoint: &str, delivery_id: &str, claim: Claim<'_>) -> Result<bool, String>;
    /// Release a claim whose request did not hand off a job.
    async fn fail_handoff(&self, endpoint: &str, delivery_id: &str, error: &str) -> Result<(), String> {
        self.update_delivery_status(endpoint, delivery_id, "failed", Some(error)).await
    }
    async fn resuming_rule_handoff(&self, _name: &str, _id: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn update_delivery_status(&self, endpoint: &str, delivery_id: &str, status: &str, error: Option<&str>) -> Result<(), String>;
}

pub enum WebhookRoute {
    Reply(HttpReply),
    Rule(Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send>>),
}

/// Hands an accepted event to the owner's routine run and answers the sender.
#[async_trait]
pub trait WebhookDispatch: Send + Sync {
    /// Bot dispatch stays in the request scope. Only an identified rule's durability handoff
    /// can take ownership of the claim and outlive the HTTP waiter.
    async fn route(&self, name: &str, payload: Value, headers: &Headers, delivery_id: &str, endpoint_in_table: bool) -> Result<WebhookRoute, String> {
        self.handle(name, payload, headers, delivery_id, endpoint_in_table).await.map(WebhookRoute::Reply)
    }

    async fn handle(&self, name: &str, payload: Value, headers: &Headers, delivery_id: &str, endpoint_in_table: bool) -> Result<HttpReply, String>;
}

/// How long `process` may take. Node's request handler has no deadline, but the relay that forwards
/// a public delivery stops waiting for the local listener after `LOCAL_TIMEOUT_MS = 25_000`
/// (`relay-tunnel/limits.mjs:6`), so a reply later than that has no reader. The 504 is a new outcome
/// (`decisions.md`, "hang-services").
pub(crate) const PROCESS: std::time::Duration = std::time::Duration::from_secs(25);

type ActiveDeliveries = Arc<Mutex<HashSet<(String, String)>>>;

struct ActiveDelivery {
    active: ActiveDeliveries,
    key: (String, String),
}

impl ActiveDelivery {
    fn begin(active: &ActiveDeliveries, name: &str, id: &str) -> Option<Self> {
        let key = (name.to_owned(), id.to_owned());
        active.lock().unwrap().insert(key.clone()).then(|| Self { active: active.clone(), key })
    }
}

impl Drop for ActiveDelivery {
    fn drop(&mut self) {
        self.active.lock().unwrap().remove(&self.key);
    }
}

/// The writer can commit even when the request has stopped waiting for its answer. Send
/// a ticket, not a bool: if the receiver is gone (even after send), dropping it closes
/// the claim before the next request can acquire this delivery.
struct ClaimedDelivery {
    owner: Option<ActiveDelivery>,
    store: Arc<dyn WebhookStore>,
    work: Option<WorkGuard>,
}

impl ClaimedDelivery {
    async fn fail(mut self, error: &str, retryable: bool) {
        let Some(owner) = &self.owner else { return };
        fail(&*self.store, &owner.key.0, &owner.key.1, error, retryable).await;
        self.owner.take();
    }

    fn settled(mut self) {
        self.owner.take();
    }
}

impl Drop for ClaimedDelivery {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let store = self.store.clone();
            let work = self.work.take();
            drop(tokio::spawn(async move {
                let _work = work;
                fail(&*store, &owner.key.0, &owner.key.1, "processing cancelled", true).await;
                drop(owner);
            }));
        }
    }
}

pub struct WebhookService {
    store: Arc<dyn WebhookStore>,
    dispatch: Arc<dyn WebhookDispatch>,
    config: RwLock<WebhookConfig>,
    work: RunningWork,
    active: ActiveDeliveries,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
    warned_unsigned: std::sync::atomic::AtomicBool,
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            // Two hex digits exactly: `from_str_radix` alone would take a sign ("%+1").
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
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
    let raw = raw_endpoint_name(path);
    percent_decode(raw).unwrap_or_else(|| raw.to_string())
}

/// `rawName` of Node's `parseEndpointName`: the path after `/webhook/`, undecoded, without its query.
pub(super) fn raw_endpoint_name(path: &str) -> &str {
    path.strip_prefix("/webhook/").unwrap_or("").split('?').next().unwrap_or("")
}

/// Endpoint names are `[a-zA-Z0-9_-]{1,64}`; anything else never reaches a table lookup.
pub fn valid_endpoint_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Nesting and size a webhook body may have. `JSON.parse` is bounded by V8's stack; the parsed `Value` here would drop
/// recursively and cost memory per member, so a hostile body is refused before it is built.
const MAX_JSON_DEPTH: usize = 128;
const MAX_JSON_NODES: usize = 200_000;

/// `JSON.parse(text)` (lone surrogate escapes included) for a body within the depth and member budgets: a lexical pass
/// over the text counts them without building anything.
fn parse_body_json(text: &str) -> Result<Value, String> {
    let (mut depth, mut nodes, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for &byte in text.as_bytes() {
        if in_string {
            match (escaped, byte) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                nodes += 1;
                if depth > MAX_JSON_DEPTH {
                    return Err(format!("nesting deeper than {MAX_JSON_DEPTH}"));
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            b',' => nodes += 1,
            _ => {}
        }
        if nodes > MAX_JSON_NODES {
            return Err(format!("more than {MAX_JSON_NODES} members"));
        }
    }
    mixdog_js::json_parse(text).map_err(|e| e.to_string())
}

/// `Some(true)` for a probe whose header and in-body marker agree, `Some(false)` when
/// they disagree. The marker sits inside the signed body, the header does not, so either
/// alone is rejected. A probe never dispatches.
fn test_probe(headers: &Headers, raw_body: &[u8]) -> Option<bool> {
    let header = headers.get(WEBHOOK_TEST_HEADER).is_some_and(|v| v == "1");
    let marked = parse_body_json(&String::from_utf8_lossy(raw_body)).ok().is_some_and(|v| v.get(WEBHOOK_TEST_FIELD) == Some(&Value::Bool(true)));
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
        Self { store, dispatch, config: RwLock::new(config), work, active: Default::default(), now_ms, warned_unsigned: Default::default() }
    }

    pub fn set_config(&self, config: WebhookConfig) {
        *self.config.write().unwrap() = config;
    }

    /// Whether anything that receives through the listener is registered: an endpoint of the table that is not
    /// switched off, or one of the config file's (`channels.endpoints`). Node serves `/webhook/<name>` for exactly
    /// these (`handleWebhookPost`: the table first, the config second, `enabled === false` refused).
    pub async fn has_registered(&self) -> Result<bool, String> {
        if self.config.read().unwrap().endpoints.values().any(|e| e.enabled != Some(false)) {
            return Ok(true);
        }
        self.store.any_enabled_endpoint().await
    }

    /// Held by the transport while the webhook listener is up: a listening server is work.
    pub fn listening(&self) -> WorkGuard {
        self.work.begin()
    }

    fn config_endpoint(&self, name: &str) -> Option<Endpoint> {
        self.config.read().unwrap().endpoints.get(name).cloned()
    }

    /// Gate before the body is read: name shape, registration, enabled.
    pub async fn precheck(&self, path: &str) -> Result<String, Rejection> {
        let name = parse_endpoint_name(path);
        if !valid_endpoint_name(&name) {
            mixdog_rt::node_stderr!("mixdog webhook: rejected: invalid endpoint name \"{}\"", raw_endpoint_name(path));
            return Err(Rejection(HttpReply::error(404, "invalid endpoint name")));
        }
        let endpoint = match self.store.load_endpoint(&name).await {
            Ok(db) => db.or_else(|| self.config_endpoint(&name)),
            Err(err) => {
                mixdog_rt::node_stderr!("mixdog webhook: {name}: endpoint lookup failed — {err}");
                return Err(Rejection(HttpReply::error(500, "internal error")));
            }
        };
        match endpoint {
            Some(e) if e.enabled == Some(false) => Err(Rejection(HttpReply::error(404, "disabled endpoint"))),
            Some(_) => Ok(name),
            None => Err(Rejection(HttpReply::error(404, "unknown endpoint"))),
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
            Err(Rejection(reply)) => return reply,
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
                mixdog_rt::node_stderr!("mixdog webhook: {name}: rejected — no signature header found");
                return Err(HttpReply { status: 403, body: json!({"ok":false,"error":"missing signature"}) });
            };
            if !verify_signature(secret, body, &sig, parser, (self.now_ms)()) {
                mixdog_rt::node_stderr!("mixdog webhook: {name}: rejected — signature mismatch");
                return Err(HttpReply { status: 403, body: json!({"ok":false,"error":"invalid signature"}) });
            }
            return Ok(());
        }
        // Fail closed: a configured parser implies a signed integration, and a table
        // endpoint is privileged; neither may fall back to unsigned input.
        if let Some(parser) = parser {
            mixdog_rt::node_stderr!("mixdog webhook: {name}: rejected — parser \"{parser}\" configured but no secret set");
            return Err(HttpReply::error(401, "webhook secret required for signed parser"));
        }
        if in_table {
            mixdog_rt::node_stderr!("mixdog webhook: {name}: rejected (table endpoint requires a webhook secret)");
            return Err(HttpReply::error(401, "webhook secret required for endpoint"));
        }
        let allow =
            endpoint.allow_unsigned == Some(true) || config.endpoints.get(name).and_then(|e| e.allow_unsigned) == Some(true) || config.allow_unsigned_webhooks;
        if !allow {
            mixdog_rt::node_stderr!("mixdog webhook: {name}: rejected — unsigned request and no secret configured");
            return Err(HttpReply::error(401, "webhook secret required for endpoint"));
        }
        if !self.warned_unsigned.swap(true, std::sync::atomic::Ordering::Relaxed) {
            mixdog_rt::node_stderr!("mixdog webhook: warning — unsigned webhooks explicitly allowed, skipping signature verification");
        }
        Ok(())
    }

    pub async fn process(&self, name: &str, headers: &Headers, raw_body: &[u8]) -> HttpReply {
        let mut claimed = None;
        let bounded = Scope::new().within(PROCESS).run(self.process_inner(name, headers, raw_body, &mut claimed)).await;
        let Scoped::Done(outcome) = bounded else {
            tracing::warn!("webhook {name}: processing timed out");
            // A claim still held here never reached a handoff: a rule handoff or a started
            // bot run takes the ticket out of `claimed` before it can be awaited.
            if let Some(ticket) = claimed {
                ticket.fail("processing timeout", true).await;
            }
            return HttpReply::error(504, "processing timeout");
        };
        match outcome {
            Ok(reply) => reply,
            Err(Failure::Invalid(message)) => {
                mixdog_rt::node_stderr!("mixdog webhook: JSON parse error for {name}: {message}");
                if let Some(ticket) = claimed {
                    ticket.fail(&format!("invalid JSON: {message}"), false).await;
                }
                HttpReply::error(400, "invalid JSON")
            }
            Err(Failure::Internal(message)) => {
                mixdog_rt::node_stderr!("mixdog webhook: {name}: request failed: {message}");
                if let Some(ticket) = claimed {
                    ticket.fail(&message, false).await;
                }
                HttpReply::error(500, "internal error")
            }
        }
    }

    async fn process_inner(&self, name: &str, headers: &Headers, raw_body: &[u8], claimed: &mut Option<ClaimedDelivery>) -> Result<HttpReply, Failure> {
        let db_endpoint = self.store.load_endpoint(name).await.map_err(Failure::Internal)?;
        let endpoint = db_endpoint.clone().or_else(|| self.config_endpoint(name));
        let in_table = db_endpoint.is_some();
        let Some(endpoint) = endpoint else { return Ok(HttpReply::error(404, "unknown endpoint")) };
        if endpoint.enabled == Some(false) {
            mixdog_rt::node_stderr!("mixdog webhook: rejected: disabled endpoint {name}");
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
        let Some(owner) = ActiveDelivery::begin(&self.active, name, &id) else {
            return Ok(HttpReply { status: 503, body: json!({"error":"delivery in progress","id":id}) });
        };
        let event = headers.get("x-github-event").filter(|v| !v.is_empty()).cloned();
        let (store, claim_event, headers_summary, payload_preview, work) =
            (self.store.clone(), event.clone(), headers_summary(headers), mixdog_js::slice_utf16(&body_text, 512), self.work.begin());
        let ticket = tokio::spawn(async move {
            let claim = Claim { status: "received", event: claim_event.as_deref(), headers_summary, payload_preview };
            if store.claim_delivery(&owner.key.0, &owner.key.1, claim).await? {
                Ok(Some(ClaimedDelivery { owner: Some(owner), store, work: Some(work) }))
            } else {
                Ok(None)
            }
        })
        .await
        .map_err(|error| Failure::Internal(error.to_string()))?
        .map_err(Failure::Internal)?;
        let Some(ticket) = ticket else {
            mixdog_rt::node_stderr!("mixdog webhook: {name}: dedup {id}");
            return Ok(HttpReply { status: 200, body: json!({"status":"dedup","id":id}) });
        };
        *claimed = Some(ticket);
        let ctype = headers.get("content-type").map(|v| v.to_lowercase()).unwrap_or_default();
        let looks_json = ctype.contains("application/json") || ctype.contains("+json");
        if !raw_body.is_empty() && !looks_json {
            // A terminal failed row resolves the `received` claim so retries don't dedup forever.
            let shown = if ctype.is_empty() { "<none>" } else { &ctype };
            claimed.take().unwrap().fail(&format!("unsupported content-type: {shown}"), false).await;
            return Ok(HttpReply { status: 415, body: json!({"error":"unsupported content-type","expected":"application/json"}) });
        }
        let parsed: Value = if raw_body.is_empty() {
            json!({})
        } else {
            // Node parses `rawBody.toString('utf8')`: invalid bytes become U+FFFD, not a 400.
            // `JSON.parse`: an escaped lone surrogate is valid there.
            parse_body_json(&body_text).map_err(Failure::Invalid)?
        };
        // Our own issue comments carry this marker; forwarding one would self-trigger.
        let own_comment = event.as_deref() == Some("issue_comment") && parsed["comment"]["body"].as_str().is_some_and(|b| b.starts_with("[mixdog "));
        if own_comment {
            self.store.update_delivery_status(name, &id, "self-comment-skip", None).await.map_err(Failure::Internal)?;
            claimed.take().unwrap().settled();
            return Ok(HttpReply { status: 202, body: json!({"status":"self-comment-skip","id":id}) });
        }
        self.store.update_delivery_status(name, &id, "pending", None).await.map_err(Failure::Internal)?;
        let route = self.dispatch.route(name, parsed, headers, &id, in_table).await.map_err(Failure::Internal)?;
        let ticket = claimed.take().unwrap();
        let handoff = match route {
            WebhookRoute::Reply(reply) => {
                ticket.settled();
                return Ok(reply);
            }
            WebhookRoute::Rule(handoff) => handoff,
        };

        tokio::spawn(async move {
            let outcome = handoff.await;
            match &outcome {
                Ok(_) => ticket.settled(),
                Err(error) => ticket.fail(error, true).await,
            }
            outcome
        })
        .await
        .map_err(|error| Failure::Internal(error.to_string()))?
        .map_err(Failure::Internal)
    }
}

async fn fail(store: &dyn WebhookStore, name: &str, id: &str, error: &str, retryable: bool) {
    let result = if retryable { store.fail_handoff(name, id, error).await } else { store.update_delivery_status(name, id, "failed", Some(error)).await };
    if let Err(err) = result {
        mixdog_rt::node_stderr!("mixdog webhook: failed to mark delivery {name}/{id} failed — {err}");
    }
}

enum Failure {
    Invalid(String),
    Internal(String),
}
