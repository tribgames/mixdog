//! `POST /client/register` (`handleClientRegistration`): a browser exchanges the pairing token it was given, or the token it
//! already holds, for its own credential.

use serde_json::json;
use url::Url;

use super::{MAX_JSON_BODY_BYTES, Oversize, Pairing, field_text, read_json, reply_json, reply_status};
use crate::http1::util::{browser_socket_origin_allowed, request_url};
use crate::http1::{Request, ResponseWriter};
use crate::ids::is_routing_id;
use crate::store::ProfileInput;
use crate::web::headers::{pairing_cookie_headers, request_cookie_token};

/// The token of a request: `Authorization: Bearer <32 to 128 hex digits>`, else `?token=`, else the pairing cookie.
fn request_token(request: &Request, url: &Url) -> String {
    if let Some(bearer) = bearer_token(request.headers.get("authorization").unwrap_or_default()) {
        return bearer.to_owned();
    }
    // `searchParams.get` answers the first `token` only: an empty one falls through to the cookie, not to a later one.
    if let Some((_, token)) = url.query_pairs().find(|(name, _)| name == "token")
        && !token.is_empty()
    {
        return token.into_owned();
    }
    request_cookie_token(&request.headers)
}

/// `/^Bearer\s+([0-9a-f]{32,128})$/i`.
fn bearer_token(header: &str) -> Option<&str> {
    let scheme = header.get(..6).filter(|scheme| scheme.eq_ignore_ascii_case("bearer"))?;
    let rest = &header[scheme.len()..];
    let token = mixdog_js::js_trim_start(rest);
    if token.len() == rest.len() || !(32..=128).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(token)
}

pub(super) async fn handle(pairing: &Pairing, mut request: Request, mut response: ResponseWriter) {
    if request.method != "POST" {
        reply_status(&mut response, 405, &[]);
        return;
    }
    if !browser_socket_origin_allowed(&request.headers, request.encrypted) {
        reply_status(&mut response, 403, &[]);
        return;
    }
    // The request line first, then the body: a target that does not parse is answered without reading it.
    let Some(url) = request_url(&request.url) else {
        reply_status(&mut response, 400, &[]);
        return;
    };
    let Ok(body) = read_json(&mut request, MAX_JSON_BODY_BYTES, Oversize::Destroy).await else {
        reply_status(&mut response, 400, &[]);
        return;
    };
    let token = request_token(&request, &url);
    let store = pairing.hub.store();
    let access = store.client_access_for_token(&token);
    let client_id = field_text(&body, "clientId");
    let Some(access) = access.filter(|_| is_routing_id(&client_id)) else {
        pairing.reject_unauthorized(&request, &mut response, 401);
        return;
    };
    let profile = ProfileInput::from_value(&body);
    match &access.client_id {
        // A browser already bound to this token refreshes its record.
        Some(bound) => {
            if *bound != client_id {
                reply_status(&mut response, 401, &[]);
                return;
            }
            store.touch_client(&access.device_id, &client_id, &profile);
            reply_json(&mut response, 200, &json!({ "clientId": client_id }), &[]);
            // The client has used its credential: it holds the answer, so the re-read window of the claim that minted it closes.
            super::lock(&pairing.claims).release_token(&token);
        }
        // A fresh one is minted its per-browser credential.
        None => {
            let Some(registered) = store.register_client(&access.device_id, &client_id, &profile).await else {
                reply_status(&mut response, 409, &[]);
                return;
            };
            let cookie = pairing_cookie_headers(&registered.token, request.encrypted);
            let extra: Vec<(&str, &str)> = cookie.iter().flat_map(|(name, values)| values.iter().map(move |value| (name, value.as_str()))).collect();
            reply_json(&mut response, 200, &json!({ "clientId": client_id, "token": registered.token }), &extra);
        }
    }
}
