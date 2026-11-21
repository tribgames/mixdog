//! The browser side of relay-owned Web Push (`lib/web-push-http.mjs`).
//!
//! ```text
//! GET  /webpush/key                                   -> { publicKey }
//! POST /webpush/register   Bearer <client token>  { endpoint, sealed } -> { registered: true }
//!                          409 { error: 'unsupported' } for a PC that never sent `webpush-ready`
//! POST /webpush/unregister Bearer <client token>  { endpoint }         -> { removed }
//! POST /webpush/status     Bearer <client token>  { endpoint? }        -> { registered, supported }
//! ```
//!
//! register and unregister are rate limited per credential (429), write nothing when nothing changes, and answer 503 (retry) when
//! the change could not be stored: memory is rolled back by the registry, so the relay never reports a state it would lose on
//! restart.
//!
//! The token is ONE PC's per-browser credential, so every association is made (and removed) with that PC's own pairing: a browser
//! paired with three PCs calls register three times. Only an explicit Bearer header counts, never the pairing cookie, which names
//! whichever PC the browser opened last.

use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::js_trim_start;
use serde_json::{Value, json};

use super::WebPush;
use super::endpoint::valid_endpoint;
use super::frames::publish;
use super::registry::{Bind, Sealed, Unbind};
use crate::http1::util::{browser_socket_origin_allowed, client_ip, request_url};
use crate::http1::{Headers, Request, ResponseWriter};
use crate::js;
use crate::legs::hub::Hub;
use crate::rate_limit::RateLimiter;

/// The largest request body.
pub const MAX_BODY_BYTES: usize = 4 * 1024;

/// `isWebPushRequest`: the paths this handler answers.
pub fn is_web_push_request(url: &str) -> bool {
    url == "/webpush" || url.starts_with("/webpush/") || url.starts_with("/webpush?")
}

/// `bearer`: the token of `Authorization: Bearer <32 to 128 hex digits>`, empty when the header is anything else.
fn bearer(headers: &Headers) -> &str {
    let header = headers.get("authorization").unwrap_or("");
    let Some(rest) = header.get(..6).filter(|word| word.eq_ignore_ascii_case("bearer")).map(|_| &header[6..]) else { return "" };
    let token = js_trim_start(rest);
    let spaced = token.len() < rest.len();
    if spaced && (32..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit()) { token } else { "" }
}

/// What reading the body came to.
enum Read {
    Body(Value),
    /// The body is not JSON, or the request failed: 400.
    Invalid,
    /// Over the cap: the connection was destroyed, nothing is answered.
    TooLarge,
}

async fn read_json(request: &mut Request) -> Read {
    let mut raw: Vec<u8> = Vec::new();
    loop {
        match request.body.next().await {
            None => break,
            Some(Err(_)) => return Read::Invalid,
            Some(Ok(chunk)) => {
                if raw.len() + chunk.len() > MAX_BODY_BYTES {
                    request.destroy();
                    return Read::TooLarge;
                }
                raw.extend_from_slice(&chunk);
            }
        }
    }
    if raw.is_empty() {
        return Read::Body(json!({}));
    }
    js::parse_bytes(&raw).map_or(Read::Invalid, Read::Body)
}

/// `writeHead(status, headers).end()`.
fn bare(response: &mut ResponseWriter, status: u16, headers: &[(&str, &str)]) {
    if response.write_head(status, headers).is_ok() {
        response.end(None);
    } else {
        response.destroy();
    }
}

/// `json(response, status, body)`.
fn reply(response: &mut ResponseWriter, status: u16, payload: &Value) {
    let headers = [("Content-Type", "application/json"), ("Cache-Control", "no-store")];
    if response.write_head(status, &headers).is_ok() {
        response.end(Some(js::wire(payload).as_bytes()));
    } else {
        response.destroy();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Register,
    Unregister,
    Status,
}

/// The handler of the `/webpush` family. `web_push` is `None` when the relay holds no identity.
pub struct WebPushEndpoint {
    web_push: Option<Arc<WebPush>>,
    hub: Arc<Hub>,
    unauthorized_limiter: Arc<Mutex<RateLimiter>>,
}

impl WebPushEndpoint {
    /// `hub` holds the device store the credentials are read from and the legs a changed set is announced to;
    /// `unauthorized_limiter` is the relay's one, shared with its other routes.
    pub fn new(web_push: Option<Arc<WebPush>>, hub: Arc<Hub>, unauthorized_limiter: Arc<Mutex<RateLimiter>>) -> Self {
        Self { web_push, hub, unauthorized_limiter }
    }

    /// `handleWebPushRequest({ webPush, store, unauthorizedLimiter }, request, response)`.
    pub async fn handle(&self, mut request: Request, mut response: ResponseWriter) {
        let pathname = request_url(&request.url).map(|url| url.path().to_owned()).unwrap_or_default();
        // An older relay never answers here at all; this one without an identity says so the same way, and the browser keeps its
        // legacy per-PC path.
        let Some(web_push) = self.web_push.as_deref() else {
            bare(&mut response, 404, &[]);
            return;
        };
        if pathname == "/webpush/key" {
            if request.method != "GET" && request.method != "HEAD" {
                bare(&mut response, 405, &[]);
                return;
            }
            reply(&mut response, 200, &json!({ "publicKey": web_push.public_key() }));
            return;
        }
        let action = match pathname.as_str() {
            "/webpush/register" => Action::Register,
            "/webpush/unregister" => Action::Unregister,
            "/webpush/status" => Action::Status,
            _ => {
                bare(&mut response, 404, &[]);
                return;
            }
        };
        if request.method != "POST" {
            bare(&mut response, 405, &[]);
            return;
        }
        if !browser_socket_origin_allowed(&request.headers, request.encrypted) {
            bare(&mut response, 403, &[]);
            return;
        }
        let store = self.hub.store();
        let access = store.client_access_for_token(bearer(&request.headers));
        // Per-browser credentials only: a legacy shared desktop token names no client, so nothing it could bind would ever be
        // revocable on its own.
        let Some((device_id, client_id)) = access.and_then(|access| {
            let client_id = access.client_id?;
            store.has_client(&access.device_id, &client_id).then_some((access.device_id, client_id))
        }) else {
            let address = client_ip(request.remote_address.as_deref());
            let allowed = self.unauthorized_limiter.lock().unwrap_or_else(PoisonError::into_inner).allow(address);
            if allowed {
                bare(&mut response, 401, &[]);
            } else {
                bare(&mut response, 429, &[("Retry-After", "60")]);
            }
            return;
        };
        let body = match read_json(&mut request).await {
            Read::Body(body) => body,
            Read::Invalid => {
                bare(&mut response, 400, &[]);
                return;
            }
            Read::TooLarge => return,
        };
        self.act(web_push, action, (&device_id, &client_id), &body, &mut response);
    }

    /// What one authenticated call does to the registry.
    fn act(&self, web_push: &WebPush, action: Action, (device_id, client_id): (&str, &str), body: &Value, response: &mut ResponseWriter) {
        // `supported`: this PC delivers through the relay. A PC that never said so (an older desktop) keeps its own legacy
        // registration instead.
        let supported = web_push.registry().is_capable(device_id);
        let given = body.get("endpoint");
        // Status may be asked before there is a subscription at all.
        if action == Action::Status && given.is_none_or(Value::is_null) {
            reply(response, 200, &json!({ "registered": false, "supported": supported }));
            return;
        }
        let Some(endpoint) = given.and_then(Value::as_str).and_then(valid_endpoint) else {
            bare(response, 400, &[]);
            return;
        };
        if action == Action::Status {
            let registered = web_push.registry().has(device_id, client_id, &endpoint);
            reply(response, 200, &json!({ "registered": registered, "supported": supported }));
            return;
        }
        if !web_push.allow_mutation(&format!("{device_id}\n{client_id}")) {
            bare(response, 429, &[("Retry-After", "60")]);
            return;
        }
        if action == Action::Unregister {
            self.unregister(web_push, (device_id, client_id), &endpoint, response);
        } else {
            self.register(web_push, (device_id, client_id), &endpoint, body, supported, response);
        }
    }

    fn unregister(&self, web_push: &WebPush, (device_id, client_id): (&str, &str), endpoint: &str, response: &mut ResponseWriter) {
        let result = web_push.registry().unbind(device_id, client_id, endpoint);
        if result == Unbind::StoreFailed {
            bare(response, 503, &[("Retry-After", "30")]);
            return;
        }
        let removed = result == Unbind::Removed;
        if removed {
            publish(&self.hub, web_push, device_id);
        }
        reply(response, 200, &json!({ "removed": removed }));
    }

    fn register(&self, web_push: &WebPush, (device_id, client_id): (&str, &str), endpoint: &str, body: &Value, supported: bool, response: &mut ResponseWriter) {
        let Some(sealed) = body.get("sealed").and_then(Sealed::from_value) else {
            bare(response, 400, &[]);
            return;
        };
        if !supported {
            reply(response, 409, &json!({ "error": "unsupported" }));
            return;
        }
        let result = web_push.registry().bind(device_id, client_id, &endpoint, &sealed);
        match result {
            Bind::Quota => {
                reply(response, 409, &json!({ "error": "quota" }));
                return;
            }
            Bind::StoreFailed => {
                bare(response, 503, &[("Retry-After", "30")]);
                return;
            }
            // Re-stating what the relay already holds writes and announces nothing.
            Bind::Ok => publish(&self.hub, web_push, device_id),
            Bind::Unchanged => {}
        }
        reply(response, 200, &json!({ "registered": true }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(value: &str) -> Headers {
        let mut headers = Headers::default();
        headers.add("authorization", value.to_owned());
        headers
    }

    #[test]
    fn only_the_web_push_paths_are_this_handlers() {
        for yes in ["/webpush", "/webpush/key", "/webpush/register?x=1", "/webpush?x"] {
            assert!(is_web_push_request(yes), "{yes}");
        }
        for no in ["/webpusher", "/webpush2/key", "/", "/api/webpush/key"] {
            assert!(!is_web_push_request(no), "{no}");
        }
    }

    #[test]
    fn a_bearer_token_is_32_to_128_hex_digits_after_the_scheme_in_any_case() {
        let token = "a".repeat(64);
        assert_eq!(bearer(&headers(&format!("Bearer {token}"))), token);
        assert_eq!(bearer(&headers(&format!("bEaReR   {}", "AbCd".repeat(8)))), "AbCd".repeat(8));
        for no in [
            String::new(),
            token.clone(),
            format!("Bearer{token}"),
            format!("Basic {token}"),
            format!("Bearer {}", "a".repeat(31)),
            format!("Bearer {}", "a".repeat(129)),
            format!("Bearer {}z", "a".repeat(40)),
            format!("Bearer {token} "),
        ] {
            assert_eq!(bearer(&headers(&no)), "", "{no:?}");
        }
        assert_eq!(bearer(&Headers::default()), "");
    }
}
