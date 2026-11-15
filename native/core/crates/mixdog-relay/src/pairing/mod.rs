//! Pairing: the browser registration, the approval handoff and the six-digit codes a phone, another PC or a browser uses to find a
//! desktop route (`lib/relay-pairing.mjs`, and the HTTP and frame parts of `lib/pair-codes.mjs`). The relay routes and stores; it
//! never authorizes: the desktop decides, and the pairing material it returns is sealed to the browser's throwaway public key, so
//! this hop forwards a box it cannot open.
//!
//! One [`Pairing`] per process holds the pending claims and the live codes. The router of the server sends `/client/register` to
//! [`Pairing::handle_registration`], `/claim` and `/claim/<id>` to [`Pairing::handle_claim`] and `/pair-code/...` to
//! [`Pairing::handle_pair_code`]; [`Pairing::register`] puts the four desktop frames (`claim-approve`, `claim-deny`,
//! `pair-code-request`, `pair-code-clear`) and the close of a live leg onto the hub's dispatch.

pub mod claims;
pub mod codes;
mod http;
mod register;

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;

use self::claims::Claims;
use self::codes::PairCodes;
use crate::http1::util::client_ip;
use crate::http1::{Request, ResponseWriter};
use crate::js;
use crate::legs::dispatch::{Handler, HandlerFuture, LegCall, Rejected};
use crate::legs::hub::Hub;
use crate::rate_limit::RateLimiter;

/// What `createPresenceLimiter` allows: calls to `/pair-code/presence` and `/pair-code/support` per address in a window.
pub const PRESENCE_LIMIT: usize = 60;
pub const PRESENCE_WINDOW_MS: i64 = 60_000;

/// The largest body of a registration or a claim (`readBoundedJson`).
const MAX_JSON_BODY_BYTES: usize = 8 * 1024;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub struct Pairing {
    hub: Arc<Hub>,
    codes: Mutex<PairCodes>,
    claims: Mutex<Claims>,
    /// The relay-wide limiter of callers that were refused a credential (`unauthorizedLimiter`), shared with the static gate.
    unauthorized: Arc<Mutex<RateLimiter>>,
    presence: Mutex<RateLimiter>,
}

impl Pairing {
    pub fn new(hub: Arc<Hub>, unauthorized: Arc<Mutex<RateLimiter>>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            codes: Mutex::new(PairCodes::new()),
            claims: Mutex::new(Claims::new()),
            unauthorized,
            presence: Mutex::new(RateLimiter::new(PRESENCE_LIMIT, PRESENCE_WINDOW_MS)),
        })
    }

    /// `POST /client/register`.
    pub async fn handle_registration(&self, request: Request, response: ResponseWriter) {
        register::handle(self, request, response).await;
    }

    /// `POST /claim` and `GET /claim/<claimId>`.
    pub async fn handle_claim(&self, request: Request, response: ResponseWriter) {
        claims::handle(self, request, response).await;
    }

    /// `/pair-code/resolve`, `/pair-code/presence` and `/pair-code/support`.
    pub async fn handle_pair_code(&self, request: Request, response: ResponseWriter) {
        http::handle(self, request, response).await;
    }

    fn frame_handler<F, Fut>(self: &Arc<Self>, frame: F) -> Handler
    where
        F: Fn(Arc<Self>, LegCall) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let pairing = Arc::clone(self);
        Arc::new(move |call: LegCall| -> HandlerFuture { Box::pin(frame(Arc::clone(&pairing), call)) })
    }

    /// Registers the desktop frames this area answers, and clears a device's code when its live leg closes.
    pub fn register(self: &Arc<Self>) -> Result<(), Rejected> {
        let dispatch = self.hub.dispatch();
        dispatch.register("claim-approve", self.frame_handler(|pairing, call| async move { pairing.approve_claim(&call.device_id, &call.message).await }))?;
        dispatch.register("claim-deny", self.frame_handler(|pairing, call| async move { pairing.deny_claim(&call.device_id, &call.message) }))?;
        dispatch.register("pair-code-request", self.frame_handler(|pairing, call| async move { pairing.request_pair_code(&call.device_id, &call.message) }))?;
        dispatch.register("pair-code-clear", self.frame_handler(|pairing, call| async move { pairing.clear_pair_code(&call.device_id) }))?;
        let pairing = Arc::clone(self);
        dispatch.register_close_hook(Arc::new(move |device_id: &str| pairing.clear_pair_code(device_id)));
        Ok(())
    }

    /// `rejectUnauthorized`: 429 with `Retry-After` while the caller is throttled, else the given rejection status.
    pub(crate) fn reject_unauthorized(&self, request: &Request, response: &mut ResponseWriter, status: u16) {
        if lock(&self.unauthorized).allow(client_ip(request.remote_address.as_deref())) {
            reply_status(response, status, &[]);
        } else {
            reply_status(response, 429, &[("Retry-After", "60")]);
        }
    }
}

/// The body could not be read as JSON: too large, malformed, or the request ended early. The answer is 400.
pub(crate) struct Unreadable;

/// What a body over its limit does to the request.
#[derive(Clone, Copy)]
pub(crate) enum Oversize {
    /// The request is destroyed at once (`readBoundedJson`).
    Destroy,
    /// What is left of the body is read and dropped, so the answer can be sent (`readBody` of the pair-code routes).
    Drain,
}

/// `JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')` of a body of at most `max` bytes.
pub(crate) async fn read_json(request: &mut Request, max: usize, oversize: Oversize) -> Result<Value, Unreadable> {
    let mut body = Vec::new();
    let mut size = 0usize;
    let mut too_large = false;
    while let Some(next) = request.body.next().await {
        let Ok(chunk) = next else { return Err(Unreadable) };
        size += chunk.len();
        if too_large {
            continue;
        }
        if size > max {
            if matches!(oversize, Oversize::Destroy) {
                request.destroy();
                return Err(Unreadable);
            }
            too_large = true;
            body.clear();
            continue;
        }
        body.extend_from_slice(&chunk);
    }
    if too_large {
        return Err(Unreadable);
    }
    let text = js::decode_utf8(&body);
    js::parse(if text.is_empty() { "{}" } else { &text }).map_err(|_| Unreadable)
}

/// `writeHead(status, headers).end(JSON.stringify(body))` with the JSON content type and no caching. A caller that is gone
/// cannot be told.
pub(crate) fn reply_json(response: &mut ResponseWriter, status: u16, body: &Value, extra: &[(&str, &str)]) {
    let mut headers = vec![("Content-Type", "application/json"), ("Cache-Control", "no-store")];
    headers.extend_from_slice(extra);
    if response.write_head(status, &headers).is_ok() {
        response.end(Some(js::wire(body).as_bytes()));
    }
}

/// `writeHead(status, headers).end()`.
pub(crate) fn reply_status(response: &mut ResponseWriter, status: u16, headers: &[(&str, &str)]) {
    if response.write_head(status, headers).is_ok() {
        response.end(None);
    }
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(body?.<key> || '')`.
pub(crate) fn field_text(body: &Value, key: &str) -> String {
    match body.get(key) {
        Some(value) if truthy(value) => mixdog_js::value_to_string(value),
        _ => String::new(),
    }
}
