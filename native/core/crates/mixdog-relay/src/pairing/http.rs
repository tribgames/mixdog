//! `/pair-code/resolve`, `/pair-code/presence`, `/pair-code/support` (`handlePairCodeRequest`), and the desktop's `pair-code-request`
//! and `pair-code-clear` frames. None of them grants access: the code only lets the following claim say "entered a code" on the
//! approval dialog, and the desktop still decides.
//!
//! The phone app reads exactly these shapes (200, 404 and 429; anything else it shows as "update the PC").

use serde_json::{Map, Value, json};

use super::codes::{MAX_PAIR_CODE_BODY_BYTES, Resolve, issued_answer, presence_ids};
use super::{Oversize, Pairing, lock, read_json, reply_json, reply_status};
use crate::http1::util::{browser_socket_origin_allowed, client_ip, request_url};
use crate::http1::{Request, ResponseWriter};
use crate::ids::is_routing_id;

/// The bundled phone-app pairing screen is the only cross-origin caller.
const CORS_ORIGINS: [&str; 2] = ["https://localhost", "capacitor://localhost"];

fn origin_of(request: &Request) -> &str {
    request.headers.get("origin").unwrap_or_default()
}

/// Same-origin or the bundled phone screen; a request with no Origin at all is a native client (the desktop app) and is fine.
fn origin_allowed(request: &Request) -> bool {
    let origin = origin_of(request);
    origin.is_empty() || CORS_ORIGINS.contains(&origin) || browser_socket_origin_allowed(&request.headers, request.encrypted)
}

fn cors_headers(origin: &str) -> Vec<(&str, &str)> {
    if CORS_ORIGINS.contains(&origin) {
        vec![("Access-Control-Allow-Origin", origin), ("Vary", "Origin"), ("Access-Control-Allow-Headers", "Content-Type")]
    } else {
        Vec::new()
    }
}

/// `reply`: the answer with the CORS headers of the request's origin.
fn reply(response: &mut ResponseWriter, origin: &str, status: u16, body: &Value, extra: &[(&str, &str)]) {
    let mut headers = cors_headers(origin);
    headers.extend_from_slice(extra);
    reply_json(response, status, body, &headers);
}

/// The keys of a JavaScript object that are array indexes (`"0"` to `"4294967294"`, no leading zero) come first, in ascending
/// order, then the others in the order they were set; `JSON.stringify` writes them in that order.
fn js_key_order(ids: Vec<(String, bool)>) -> Map<String, Value> {
    let index = |key: &str| key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key);
    let (mut indexed, others): (Vec<_>, Vec<_>) = ids.into_iter().partition(|(key, _)| index(key.as_str()).is_some());
    indexed.sort_by_key(|(key, _)| index(key.as_str()));
    indexed.into_iter().chain(others).map(|(key, online)| (key, Value::Bool(online))).collect()
}

impl Pairing {
    /// Answers 429 and returns true when this source is over its presence budget (`presenceThrottled`).
    fn presence_throttled(&self, request: &Request, response: &mut ResponseWriter, origin: &str) -> bool {
        if lock(&self.presence).allow(client_ip(request.remote_address.as_deref())) {
            return false;
        }
        reply(response, origin, 429, &json!({ "status": "rate-limited" }), &[("Retry-After", "60")]);
        true
    }

    async fn resolve(&self, mut request: Request, mut response: ResponseWriter) {
        let origin = origin_of(&request).to_owned();
        let Ok(body) = read_json(&mut request, MAX_PAIR_CODE_BODY_BYTES, Oversize::Drain).await else {
            reply(&mut response, &origin, 400, &json!({ "status": "bad-request" }), &[]);
            return;
        };
        let code = body.get("code").and_then(Value::as_str);
        let result = lock(&self.codes).resolve(code, client_ip(request.remote_address.as_deref()));
        match result {
            Resolve::Limited { retry_after_ms } => {
                let retry_after = u64::try_from(retry_after_ms).unwrap_or(0).div_ceil(1000);
                let header = retry_after.to_string();
                reply(&mut response, &origin, 429, &json!({ "status": "rate-limited", "retryAfter": retry_after }), &[("Retry-After", header.as_str())]);
            }
            Resolve::Invalid => reply(&mut response, &origin, 404, &json!({ "status": "invalid-code" }), &[]),
            Resolve::Ok { device_id, name, ticket, lease } => {
                // The shown code is spent: the main PC rolls a fresh one. A desktop that is gone redials and republishes.
                self.hub.send_to_desktop(&device_id, &json!({ "type": "pair-code-used", "lease": lease }));
                reply(&mut response, &origin, 200, &json!({ "deviceId": device_id, "name": name, "ticket": ticket }), &[]);
            }
        }
    }

    fn support(&self, request: &Request, response: &mut ResponseWriter) {
        let origin = origin_of(request);
        if self.presence_throttled(request, response, origin) {
            return;
        }
        let device_id = request_url(&request.url)
            .and_then(|url| url.query_pairs().find(|(name, _)| name == "deviceId").map(|(_, value)| value.into_owned()))
            .unwrap_or_default();
        if !is_routing_id(&device_id) || !self.hub.store().is_known(&device_id) {
            reply(response, origin, 404, &json!({ "status": "unknown" }), &[]);
            return;
        }
        let (online, pair_v2) = self.hub.desktop_info(&device_id).map_or((false, false), |info| (info.open, info.pair_v2));
        reply(response, origin, 200, &json!({ "online": online, "pairV2": pair_v2 }), &[]);
    }

    async fn presence(&self, mut request: Request, mut response: ResponseWriter) {
        let origin = origin_of(&request).to_owned();
        if self.presence_throttled(&request, &mut response, &origin) {
            return;
        }
        let Ok(body) = read_json(&mut request, MAX_PAIR_CODE_BODY_BYTES, Oversize::Drain).await else {
            reply(&mut response, &origin, 400, &json!({ "status": "bad-request" }), &[]);
            return;
        };
        let mut online: Vec<(String, bool)> = Vec::new();
        for id in presence_ids(&body) {
            let Some(id) = id.as_str().filter(|id| is_routing_id(id) && self.hub.store().is_known(id)) else { continue };
            let open = self.hub.desktop_open(id);
            match online.iter_mut().find(|entry| entry.0 == id) {
                Some(entry) => entry.1 = open,
                None => online.push((id.to_owned(), open)),
            }
        }
        reply(&mut response, &origin, 200, &json!({ "online": js_key_order(online) }), &[]);
    }

    /// `requestPairCode`: the main PC publishes its current code (only while Settings -> Connection is open). The code is never
    /// logged; the answer says only whether the relay accepted it.
    pub(super) fn request_pair_code(&self, device_id: &str, message: &Value) {
        let lease = message.get("lease").and_then(Value::as_str);
        let name = message.get("name").and_then(Value::as_str);
        let result = lock(&self.codes).issue(device_id, lease, name);
        self.hub.send_to_desktop(device_id, &issued_answer(lease, &result));
    }

    /// `clearPairCode`: the desktop withdrew its code (that screen closed), or its live leg did.
    pub(super) fn clear_pair_code(&self, device_id: &str) {
        lock(&self.codes).clear(device_id);
    }
}

pub(super) async fn handle(pairing: &Pairing, request: Request, mut response: ResponseWriter) {
    let pathname = request_url(&request.url).map(|url| url.path().to_owned()).unwrap_or_default();
    if request.method == "OPTIONS" {
        let mut headers = cors_headers(origin_of(&request));
        headers.extend_from_slice(&[("Access-Control-Allow-Methods", "GET, POST"), ("Access-Control-Max-Age", "600")]);
        reply_status(&mut response, 204, &headers);
        return;
    }
    if !origin_allowed(&request) {
        reply_status(&mut response, 403, &[]);
        return;
    }
    let method = request.method.clone();
    match (method.as_str(), pathname.as_str()) {
        ("POST", "/pair-code/resolve") => pairing.resolve(request, response).await,
        ("POST", "/pair-code/presence") => pairing.presence(request, response).await,
        ("GET", "/pair-code/support") => pairing.support(&request, &mut response),
        _ => reply_status(&mut response, 404, &[]),
    }
}
