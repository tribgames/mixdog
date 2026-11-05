//! What the webhook relay leg carries (`webhook/relay-tunnel.mjs`, `relay-tunnel/local-forward.mjs`,
//! `relay-tunnel/limits.mjs`): a request frame from the relay is validated, replayed against the
//! local [`WebhookListener`](super::listener::WebhookListener), and the response goes back as an
//! `http-response` frame. The socket, identity and redial loop are the connection half of the
//! tunnel; none of it lives here. The replay is a hyper HTTP/1.1 client connection.

use std::convert::Infallible;
use std::io::ErrorKind;
use std::net::Ipv4Addr;
use std::time::Duration;

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, StreamBody};
use hyper::body::Frame;
use hyper::header::HeaderValue;
use hyper::{Request, Uri};
use hyper_util::rt::TokioIo;
use mixdog_js::{json_stringify, utf16_len, value_to_string};
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::net::TcpStream;

pub const MAX_TUNNEL_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_HOOK_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_HOOK_HEADER_BYTES: usize = 32 * 1024;
pub const HEARTBEAT: Duration = Duration::from_millis(25_000);
pub const LOCAL_TIMEOUT: Duration = Duration::from_millis(25_000);

/// Hop-by-hop and framing headers the replay sets itself.
const HOP_HEADERS: [&str; 7] = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te"];

/// Node's `Buffer.from(text, 'base64')`: the text is already known to be well formed, but the
/// unused bits of its last group are not required to be zero.
const LENIENT: GeneralPurpose =
    GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// A validated request frame.
#[derive(Debug, PartialEq, Eq)]
pub struct HookFrame {
    pub id: String,
    pub path: String,
    /// Lowercased names in frame order; a frame value that was a list stays a list.
    pub headers: Vec<(String, Vec<String>)>,
    pub body: Option<Vec<u8>>,
}

fn invalid(text: &str) -> String {
    text.to_owned()
}

/// `/webhook/<name>` (1-64 of `[A-Za-z0-9_-]`) with an optional `?query` of up to 2048 units
/// holding no `#`, CR or LF.
fn valid_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/webhook/") else { return false };
    let (name, query) = match rest.split_once('?') {
        Some((name, query)) => (name, Some(query)),
        None => (rest, None),
    };
    let name_ok = (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    name_ok && query.is_none_or(|q| utf16_len(q) <= 2048 && !q.contains(['#', '\r', '\n']))
}

fn token_name(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_lowercase() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// `(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?` over the whole text.
fn well_formed_base64(text: &str) -> bool {
    let bytes = text.as_bytes();
    let data = bytes.len() - bytes.iter().rev().take(2).take_while(|b| **b == b'=').count();
    bytes.len() % 4 == 0 && bytes[..data].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
}

/// `normalizeHookRequestFrame`: the error text is Node's `TypeError` message.
pub fn normalize_request_frame(frame: &Value) -> Result<HookFrame, String> {
    let Some(object) = frame.as_object() else { return Err(invalid("invalid webhook relay frame")) };
    let id = match object.get("id") {
        Some(Value::String(id)) if object.get("type") == Some(&Value::from("http")) && (1..=128).contains(&utf16_len(id)) => id.clone(),
        _ => return Err(invalid("invalid webhook relay frame")),
    };
    if object.get("method") != Some(&Value::from("POST")) {
        return Err(invalid("webhook relay method must be POST"));
    }
    let path = match object.get("path") {
        Some(Value::String(path)) if utf16_len(path) <= 4096 && valid_path(path) => path.clone(),
        _ => return Err(invalid("invalid webhook relay path")),
    };
    let mut headers = Vec::new();
    let mut header_bytes = 0;
    if let Some(Value::Object(input)) = object.get("headers") {
        for (raw_name, raw_value) in input {
            let name = raw_name.to_lowercase();
            if HOP_HEADERS.contains(&name.as_str()) {
                continue;
            }
            if !token_name(&name) {
                return Err(invalid("invalid webhook relay header name"));
            }
            let values: Vec<String> = match raw_value {
                Value::Array(list) => list.iter().map(value_to_string).collect(),
                other => vec![value_to_string(other)],
            };
            if values.iter().any(|v| v.contains(['\r', '\n']) || utf16_len(v) > 8192) {
                return Err(invalid("invalid webhook relay header value"));
            }
            header_bytes += utf16_len(&name) + values.iter().map(|v| utf16_len(v)).sum::<usize>();
            if header_bytes > MAX_HOOK_HEADER_BYTES {
                return Err(invalid("webhook relay headers exceed limit"));
            }
            headers.push((name, values));
        }
    }
    let encoded = match object.get("body") {
        None | Some(Value::Null) => String::new(),
        Some(other) => value_to_string(other),
    };
    if encoded.len() > MAX_TUNNEL_BODY_BYTES.div_ceil(3) * 4 || (!encoded.is_empty() && !well_formed_base64(&encoded)) {
        return Err(invalid("invalid webhook relay body"));
    }
    let body = if encoded.is_empty() {
        None
    } else {
        let bytes = LENIENT.decode(encoded.as_bytes()).map_err(|_| invalid("invalid webhook relay body"))?;
        if bytes.len() > MAX_TUNNEL_BODY_BYTES {
            return Err(invalid("webhook relay body exceeds limit"));
        }
        Some(bytes)
    };
    Ok(HookFrame { id, path, headers, body })
}

#[derive(Serialize)]
struct ResponseFrame<'a> {
    r#type: &'static str,
    id: &'a str,
    status: u16,
    headers: Map<String, Value>,
    body: String,
}

/// `respondOverLeg`'s frame, as the JSON text sent over the leg.
pub fn response_frame(id: &str, status: u16, headers: &[(&str, &str)], body: &[u8]) -> String {
    let headers = headers.iter().map(|(k, v)| ((*k).to_owned(), Value::from(*v))).collect();
    let body = if body.is_empty() { String::new() } else { base64::engine::general_purpose::STANDARD.encode(body) };
    serde_json::to_string(&ResponseFrame { r#type: "http-response", id, status, headers, body }).unwrap_or_default()
}

/// `respondJsonError`: `{"error": <message>}` with a JSON content type.
pub fn error_frame(id: &str, status: u16, message: &str) -> String {
    let body = json_stringify(&serde_json::json!({ "error": message }));
    response_frame(id, status, &[("content-type", "application/json")], body.as_bytes())
}

/// `handleLegMessage` and the replay: the frame to send back for one text message from the relay,
/// if any. Text that is not JSON gets no reply; an invalid frame that still carries a string id
/// is answered 400 so the relay does not wait for its timeout. `local_port` is the listener's
/// port, `None` while it is not listening.
pub async fn answer(raw: &str, local_port: Option<u16>) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    match normalize_request_frame(&value) {
        Err(message) => value.get("id").and_then(Value::as_str).map(|id| error_frame(id, 400, &message)),
        Ok(frame) => Some(forward(&frame, local_port).await),
    }
}

async fn forward(frame: &HookFrame, local_port: Option<u16>) -> String {
    let Some(port) = local_port.filter(|port| *port != 0) else {
        return response_frame(&frame.id, 503, &[("content-type", "application/json")], br#"{"error":"webhook server not listening"}"#);
    };
    match replay(frame, port).await {
        Ok(reply) => response_frame(&frame.id, reply.status, &[("content-type", reply.content_type.as_deref().unwrap_or("application/json"))], &reply.body),
        // The local response broke off or outgrew the limit: Node destroys it and answers an
        // empty 502.
        Err(Replay::Aborted) => response_frame(&frame.id, 502, &[], &[]),
        Err(Replay::Rejected(message)) => error_frame(&frame.id, 400, &message),
        Err(Replay::Failed(message)) => error_frame(&frame.id, 502, &message),
    }
}

struct LocalReply {
    status: u16,
    content_type: Option<String>,
    body: Vec<u8>,
}

enum Replay {
    /// The request could not be made (`http.request` threw): 400.
    Rejected(String),
    /// The local server could not be reached or went quiet: 502 with the message.
    Failed(String),
    /// The response broke off mid-body or outgrew the limit: an empty 502.
    Aborted,
}

/// One step of the exchange, idle for no longer than [`LOCAL_TIMEOUT`] (Node's socket timeout).
async fn within<T>(step: impl Future<Output = T>) -> Result<T, Replay> {
    tokio::time::timeout(LOCAL_TIMEOUT, step).await.map_err(|_| Replay::Failed("local webhook timeout".to_owned()))
}

type RequestBody = BoxBody<Bytes, Infallible>;

/// The POST of the frame. A body goes out as one chunk (what Node's `write` then `end`
/// produces); no body is `Content-Length: 0`.
fn local_request(frame: &HookFrame, port: u16) -> Result<Request<RequestBody>, Replay> {
    let uri: Uri = frame.path.parse().map_err(|_| Replay::Rejected("Request path contains unescaped characters".to_owned()))?;
    let mut builder = Request::builder().method("POST").uri(uri).header("host", format!("127.0.0.1:{port}"));
    for (name, values) in &frame.headers {
        for value in values {
            let value = HeaderValue::from_str(value).map_err(|_| Replay::Rejected(format!("Invalid character in header content [\"{name}\"]")))?;
            builder = builder.header(name.as_str(), value);
        }
    }
    let body: RequestBody = match frame.body.as_deref().filter(|b| !b.is_empty()) {
        Some(bytes) => {
            let chunk = Bytes::copy_from_slice(bytes);
            StreamBody::new(futures::stream::once(async move { Ok::<_, Infallible>(Frame::data(chunk)) })).boxed()
        }
        None => Empty::<Bytes>::new().boxed(),
    };
    builder.body(body).map_err(|e| Replay::Rejected(e.to_string()))
}

async fn replay(frame: &HookFrame, port: u16) -> Result<LocalReply, Replay> {
    let request = local_request(frame, port)?;
    let stream = match within(TcpStream::connect((Ipv4Addr::LOCALHOST, port))).await? {
        Ok(stream) => stream,
        Err(e) if e.kind() == ErrorKind::ConnectionRefused => return Err(Replay::Failed(format!("connect ECONNREFUSED 127.0.0.1:{port}"))),
        Err(e) => return Err(Replay::Failed(e.to_string())),
    };
    let (mut sender, connection) =
        within(hyper::client::conn::http1::handshake(TokioIo::new(stream))).await?.map_err(|e| Replay::Failed(e.to_string()))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = within(sender.send_request(request)).await?.map_err(|e| Replay::Failed(e.to_string()))?;
    let (parts, mut body) = response.into_parts();
    let mut bytes = Vec::new();
    while let Some(next) = within(body.frame()).await? {
        let Ok(next) = next else { return Err(Replay::Aborted) };
        if let Some(data) = next.data_ref() {
            bytes.extend_from_slice(data);
            if bytes.len() > MAX_TUNNEL_BODY_BYTES {
                return Err(Replay::Aborted);
            }
        }
    }
    let content_type = parts.headers.get("content-type").map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
    Ok(LocalReply { status: parts.status.as_u16(), content_type, body: bytes })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn frame(extra: Value) -> Value {
        let mut base = json!({
            "type": "http", "id": "request-id", "method": "POST", "path": "/webhook/github?source=test",
            "headers": {"content-type": "application/json", "host": "ignored.example"},
            "body": base64::engine::general_purpose::STANDARD.encode("{}"),
        });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base
    }

    /// Node `relay-tunnel.test.mjs`: frames are bounded and confined to POST webhook routes.
    #[test]
    fn frames_are_bounded_and_confined_to_post_webhook_routes() {
        let ok = normalize_request_frame(&frame(json!({}))).unwrap();
        assert_eq!(ok.body.as_deref(), Some(&b"{}"[..]));
        assert!(ok.headers.iter().all(|(name, _)| name != "host"));
        let message = |extra| normalize_request_frame(&frame(extra)).unwrap_err();
        assert_eq!(message(json!({"method": "GET", "body": ""})), "webhook relay method must be POST");
        assert_eq!(message(json!({"path": "/", "body": ""})), "invalid webhook relay path");
        let long = "A".repeat(MAX_TUNNEL_BODY_BYTES.div_ceil(3) * 4 + 4);
        assert_eq!(message(json!({"body": long})), "invalid webhook relay body");
    }

    #[test]
    fn every_refusal_carries_nodes_text() {
        let message = |extra| normalize_request_frame(&frame(extra)).unwrap_err();
        assert_eq!(normalize_request_frame(&json!([])).unwrap_err(), "invalid webhook relay frame");
        assert_eq!(message(json!({"type": "ping"})), "invalid webhook relay frame");
        assert_eq!(message(json!({"id": ""})), "invalid webhook relay frame");
        assert_eq!(message(json!({"id": "x".repeat(129)})), "invalid webhook relay frame");
        assert_eq!(message(json!({"path": "/webhook/a#b"})), "invalid webhook relay path");
        assert_eq!(message(json!({"path": "/webhook/"})), "invalid webhook relay path");
        assert_eq!(message(json!({"headers": {"bad name": "x"}})), "invalid webhook relay header name");
        assert_eq!(message(json!({"headers": {"x-a": "a\nb"}})), "invalid webhook relay header value");
        assert_eq!(message(json!({"headers": {"x-a": "a".repeat(8193)}})), "invalid webhook relay header value");
        let many: Map<String, Value> = (0..5).map(|i| (format!("x-{i}"), Value::from("a".repeat(8000)))).collect();
        assert_eq!(message(json!({"headers": many})), "webhook relay headers exceed limit");
        assert_eq!(message(json!({"body": "AB="})), "invalid webhook relay body");
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_TUNNEL_BODY_BYTES + 1]);
        assert_eq!(message(json!({"body": big})), "webhook relay body exceeds limit");
    }

    /// Node `legs.test.mjs`: the response frame, with an absent body encoded as the empty string.
    #[test]
    fn a_response_frame_is_the_relays_http_response() {
        let sent: Value = serde_json::from_str(&response_frame("r1", 200, &[("content-type", "text/plain")], b"ok")).unwrap();
        assert_eq!(sent, json!({"type": "http-response", "id": "r1", "status": 200, "headers": {"content-type": "text/plain"}, "body": "b2s="}));
        let empty: Value = serde_json::from_str(&response_frame("r2", 502, &[], &[])).unwrap();
        assert_eq!(empty["body"], "");
    }

    #[tokio::test]
    async fn bad_json_gets_no_answer_and_a_bad_frame_with_an_id_gets_a_400() {
        assert_eq!(answer("not json", None).await, None);
        assert_eq!(answer(r#"{"type":"http"}"#, None).await, None);
        let reply: Value = serde_json::from_str(&answer(r#"{"type":"http","id":"bad-1","method":"GET","path":"/webhook/x"}"#, None).await.unwrap()).unwrap();
        assert_eq!((reply["status"].as_u64(), reply["id"].as_str()), (Some(400), Some("bad-1")));
        let text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(reply["body"].as_str().unwrap()).unwrap()).unwrap();
        assert!(text.contains("method must be POST"));
    }

    #[tokio::test]
    async fn without_a_local_listener_the_answer_is_503() {
        let raw = frame(json!({"id": "req-503", "body": ""})).to_string();
        let reply: Value = serde_json::from_str(&answer(&raw, None).await.unwrap()).unwrap();
        assert_eq!(reply["status"], 503);
        let body = base64::engine::general_purpose::STANDARD.decode(reply["body"].as_str().unwrap()).unwrap();
        assert_eq!(body, br#"{"error":"webhook server not listening"}"#);
    }

    /// A one-shot local server: reads the request head, then writes `reply` and closes. Returns
    /// the port and what the request looked like.
    async fn local_server(reply: Vec<u8>) -> (u16, tokio::task::JoinHandle<String>) {
        let server = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut got = Vec::new();
            let mut chunk = [0u8; 4096];
            while !got.windows(4).any(|w| w == b"\r\n\r\n") || (got.windows(8).any(|w| w == b"chunked\r") && !got.ends_with(b"0\r\n\r\n")) {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                got.extend_from_slice(&chunk[..n]);
            }
            socket.write_all(&reply).await.unwrap();
            socket.shutdown().await.ok();
            String::from_utf8_lossy(&got).into_owned()
        });
        (port, seen)
    }

    fn decoded(reply: &Value) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(reply["body"].as_str().unwrap()).unwrap()
    }

    /// Node `relay-tunnel.tunnel.test.mjs`: the frame is replayed against the local server and the
    /// response comes back verbatim.
    #[tokio::test]
    async fn a_frame_is_replayed_against_the_local_server() {
        let (port, seen) = local_server(b"HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstored".to_vec()).await;
        let raw = json!({
            "type": "http", "id": "req-1", "method": "POST", "path": "/webhook/demo",
            "headers": {"content-type": "application/json", "x-demo": "yes"},
            "body": base64::engine::general_purpose::STANDARD.encode(r#"{"hello":1}"#),
        })
        .to_string();
        let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
        assert_eq!(
            reply,
            json!({"type": "http-response", "id": "req-1", "status": 201, "headers": {"content-type": "text/plain"}, "body": base64::engine::general_purpose::STANDARD.encode("stored")})
        );
        let request = seen.await.unwrap().to_ascii_lowercase();
        assert!(request.starts_with("post /webhook/demo http/1.1\r\n"));
        assert!(request.contains("x-demo: yes\r\n") && request.contains("transfer-encoding: chunked\r\n"));
        assert!(request.ends_with("b\r\n{\"hello\":1}\r\n0\r\n\r\n"));
    }

    #[tokio::test]
    async fn a_refused_connection_is_a_502_with_the_os_message() {
        let free = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let raw = frame(json!({"id": "r", "body": ""})).to_string();
        let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
        assert_eq!(reply["status"], 502);
        assert_eq!(String::from_utf8(decoded(&reply)).unwrap(), format!(r#"{{"error":"connect ECONNREFUSED 127.0.0.1:{port}"}}"#));
    }

    /// A body that stops short of its framing is not a success: Node's response `error` answers an
    /// empty 502, whatever the status line said.
    #[tokio::test]
    async fn a_local_response_cut_short_is_an_empty_502() {
        let raw = frame(json!({"id": "r", "body": ""})).to_string();
        let cases: [&[u8]; 3] = [
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\n",
        ];
        for case in cases {
            let (port, _seen) = local_server(case.to_vec()).await;
            let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
            assert_eq!((reply["status"].as_u64(), reply["body"].as_str(), reply["headers"].as_object().map(Map::len)), (Some(502), Some(""), Some(0)), "{}", String::from_utf8_lossy(case));
        }
    }

    #[tokio::test]
    async fn a_chunked_local_response_is_decoded_and_an_oversized_one_is_an_empty_502() {
        let raw = frame(json!({"id": "r", "body": ""})).to_string();
        let (port, _seen) = local_server(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n".to_vec()).await;
        let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
        assert_eq!((reply["status"].as_u64(), decoded(&reply)), (Some(200), b"abcde".to_vec()));
        assert_eq!(reply["headers"]["content-type"], "application/json", "an absent content type defaults");

        let mut big = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_TUNNEL_BODY_BYTES + 1).into_bytes();
        big.extend(std::iter::repeat_n(b'x', MAX_TUNNEL_BODY_BYTES + 1));
        let (port, _seen) = local_server(big).await;
        let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
        assert_eq!((reply["status"].as_u64(), reply["body"].as_str()), (Some(502), Some("")));
    }

    /// The local server that accepts and goes quiet: the exchange ends at Node's 25 s socket
    /// timeout with a 502, not never. The clock is paused, so this takes no wall time.
    #[tokio::test(start_paused = true)]
    async fn a_silent_local_server_times_out_at_25_seconds() {
        let server = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = server.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (_socket, _) = server.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let raw = frame(json!({"id": "r", "body": ""})).to_string();
        let started = tokio::time::Instant::now();
        let reply: Value = serde_json::from_str(&answer(&raw, Some(port)).await.unwrap()).unwrap();
        assert_eq!(reply["status"], 502);
        assert_eq!(String::from_utf8(decoded(&reply)).unwrap(), r#"{"error":"local webhook timeout"}"#);
        assert_eq!(started.elapsed(), LOCAL_TIMEOUT);
    }
}
