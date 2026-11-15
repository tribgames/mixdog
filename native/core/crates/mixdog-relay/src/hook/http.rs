//! The public side of the tunnel: `/hook/<routingId>/<rest>` with any method (`handleHookRequest` and its parts). A request
//! is admitted (route, caller limits, a live agent with room), its body is buffered, and it is replayed over the agent's leg
//! as an `http` frame; the caller waits for the agent's `http-response`.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};

use super::{Answer, HookEntry, HookHub, MAX_HOOK_BODY_BYTES};
use crate::http1::util::{client_ip, request_url};
use crate::http1::{HeaderValue, Request, ResponseWriter};
use crate::ids::is_routing_id;
use crate::js;

/// Hop-by-hop and transport headers stay on this hop; signature headers and the rest forward verbatim so the agent's HMAC check
/// sees the sender's bytes (`HOOK_DROP_HEADERS`).
const DROPPED_HEADERS: [&str; 7] = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te"];

/// Where a request line leads.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// The target does not parse as a URL.
    Malformed,
    NotFound,
    /// A webhook for this routing id: `path` is what the agent is told (`(rest or '/') + search`).
    Hook { id: String, path: String },
}

/// `url.pathname.match(/^\/hook\/([^/]+)(\/.*)?$/)` with `isRoutingId`, and the path the agent gets.
fn route(target: &str) -> Route {
    let Some(url) = request_url(target) else { return Route::Malformed };
    let Some(after) = url.path().strip_prefix("/hook/") else { return Route::NotFound };
    let (id, rest) = after.split_at(after.find('/').unwrap_or(after.len()));
    if !is_routing_id(id) {
        return Route::NotFound;
    }
    let search = url.query().filter(|query| !query.is_empty()).map_or_else(String::new, |query| format!("?{query}"));
    Route::Hook { id: id.to_owned(), path: format!("{}{search}", if rest.is_empty() { "/" } else { rest }) }
}

/// `{"error":"<code>"}` with the status and the headers given.
fn reply(response: &mut ResponseWriter, status: u16, code: &str, extra: &[(&str, &str)]) {
    let mut headers = vec![("Content-Type", "application/json")];
    headers.extend_from_slice(extra);
    // A caller that vanished cannot be told.
    if response.write_head(status, &headers).is_ok() {
        response.end(Some(format!("{{\"error\":\"{code}\"}}").as_bytes()));
    }
}

/// Answers, then destroys the request once the answer is out (`destroyRequest`): nothing more of the body is read.
async fn refuse(request: &Request, response: &mut ResponseWriter, status: u16, code: &str, extra: &[(&str, &str)]) {
    let conn = request.conn().clone();
    reply(response, status, code, extra);
    response.finished().await;
    conn.destroy();
}

/// Keeps a parked request in the table only while its caller waits: a caller whose handler ends gives the place back.
struct Parked {
    entry: Arc<HookEntry>,
    id: String,
}

impl Drop for Parked {
    fn drop(&mut self) {
        drop(self.entry.take(&self.id));
    }
}

fn forwarded_headers(request: &Request) -> Value {
    let mut headers = Map::new();
    for (name, value) in request.headers.iter() {
        if DROPPED_HEADERS.contains(&name) {
            continue;
        }
        let value = match value {
            HeaderValue::One(text) => Value::String(text.clone()),
            HeaderValue::Many(texts) => Value::Array(texts.iter().cloned().map(Value::String).collect()),
        };
        headers.insert(name.to_owned(), value);
    }
    Value::Object(headers)
}

impl HookHub {
    /// `handleHookRequest`: answers the whole request.
    pub async fn handle_request(&self, mut request: Request, mut response: ResponseWriter) {
        let (device_id, path) = match route(&request.url) {
            Route::Malformed => {
                if response.write_head(400, &[]).is_ok() {
                    response.end(None);
                }
                return;
            }
            Route::NotFound => {
                reply(&mut response, 404, "not found", &[]);
                return;
            }
            Route::Hook { id, path } => (id, path),
        };
        // Device-keyed alone lets one source spread a burst across ids; the caller bucket is what bounds the total an
        // unauthenticated peer can push in.
        if !self.allow(&format!("device:{device_id}")) || !self.allow(&format!("ip:{}", client_ip(request.remote_address.as_deref()))) {
            refuse(&request, &mut response, 429, "rate limited", &[("Retry-After", "60")]).await;
            return;
        }
        let Some(entry) = self.live(&device_id) else {
            reply(&mut response, 503, "agent offline", &[]);
            return;
        };
        // An agent that is not keeping up must not turn into relay memory: refuse before the body is read. Bodies still
        // streaming in count too, so any number of slow uploads cannot arrive together and pass the cap before the first one
        // lands.
        let Some(slot) = entry.admit(self.options.max_pending) else {
            refuse(&request, &mut response, 503, "agent busy", &[("Retry-After", "1")]).await;
            return;
        };
        // The place is given back on every exit: oversize, a hang-up, a dropped handler, or the completed body.
        let mut body = Vec::new();
        loop {
            match request.body.next().await {
                None => break,
                Some(Err(_)) => return,
                Some(Ok(chunk)) => {
                    if body.len() + chunk.len() > MAX_HOOK_BODY_BYTES {
                        drop(slot);
                        refuse(&request, &mut response, 413, "payload too large", &[]).await;
                        return;
                    }
                    body.extend_from_slice(&chunk);
                }
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let encoded = if body.is_empty() { String::new() } else { STANDARD.encode(&body) };
        let frame = json!({
            "type": "http",
            "id": id,
            "method": request.method,
            "path": path,
            "headers": forwarded_headers(&request),
            "body": encoded,
        });
        let mut receiver = entry.park(slot, &id);
        let _parked = Parked { entry: Arc::clone(&entry), id: id.clone() };
        entry.socket.send_text(js::wire(&frame), None);
        let answer = tokio::select! {
            answer = &mut receiver => answer.ok(),
            // `timer.unref()`: the answer timer never keeps the process up.
            () = mixdog_rt::time::sleep_unrefed(self.options.timeout) => {
                if entry.take(&id).is_some() {
                    reply(&mut response, 504, "agent timeout", &[]);
                    return;
                }
                // The agent answered at the same moment: its answer is already on the way.
                receiver.await.ok()
            }
        };
        match answer {
            Some(Answer::Reply { status, content_type, body }) => {
                let length = body.len().to_string();
                if response.write_head(status, &[("Content-Type", content_type.as_str()), ("Content-Length", length.as_str())]).is_ok() {
                    response.end(Some(&body));
                }
            }
            Some(Answer::Failed(code)) => reply(&mut response, 502, code, &[]),
            None => reply(&mut response, 502, "agent disconnected", &[]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    fn hook(path: &str) -> Route {
        Route::Hook { id: ID.to_owned(), path: path.to_owned() }
    }

    #[test]
    fn a_target_is_routed_by_its_path_and_the_agent_gets_the_rest_with_the_query() {
        assert_eq!(route(&format!("/hook/{ID}")), hook("/"));
        assert_eq!(route(&format!("/hook/{ID}/")), hook("/"));
        assert_eq!(route(&format!("/hook/{ID}/webhook/test")), hook("/webhook/test"));
        assert_eq!(route(&format!("/hook/{ID}/a/b?x=1&y=%20")), hook("/a/b?x=1&y=%20"));
        assert_eq!(route(&format!("/hook/{ID}?x=1")), hook("/?x=1"));
        // An empty query is no query (`url.search` is empty), a fragment never travels.
        assert_eq!(route(&format!("/hook/{ID}/a?")), hook("/a"));
        assert_eq!(route(&format!("/hook/{ID}/a#frag")), hook("/a"));
        assert_eq!(route(&format!("http://other.example/hook/{ID}/a")), hook("/a"));
    }

    #[test]
    fn what_is_not_a_hook_route_is_not_found_and_what_is_not_a_url_is_malformed() {
        assert_eq!(route("http://["), Route::Malformed);
        for target in ["/nope", "/hook", "/hook/", "/hookx/aaaaaaaa", &format!("/hooks/{ID}"), "/hook//x", "/hook/short/x", "/hook/AAAAAAAA-BBBB/x", "/hook/zzzzzzzz/x"] {
            assert_eq!(route(target), Route::NotFound, "{target}");
        }
        // Dot segments are resolved before the match, as the URL parser resolves them.
        assert_eq!(route(&format!("/hook/{ID}/../x")), Route::NotFound);
        assert_eq!(route(&format!("/other/../hook/{ID}/y")), hook("/y"));
    }
}
