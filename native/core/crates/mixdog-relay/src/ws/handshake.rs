//! The opening handshake as `WebSocketServer.handleUpgrade` of `ws` runs it (`lib/websocket-server.js`): which requests are
//! accepted, the refusal bytes `abortHandshake` writes, and the 101 answer.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha1::{Digest, Sha1};

use super::codec::GUID;

/// The parts of an upgrade request the handshake reads: the method and the headers in arrival order, names in any case.
/// Repeated headers are read the way Node's `req.headers` holds them: the values joined with `, `.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HandshakeRequest {
    pub method: String,
    pub headers: Vec<(String, String)>,
}

impl HandshakeRequest {
    pub fn new(method: &str, headers: &[(&str, &str)]) -> Self {
        Self {
            method: method.to_string(),
            headers: headers.iter().map(|(name, value)| ((*name).to_string(), (*value).to_string())).collect(),
        }
    }

    /// `req.headers[name]` for a lower-case `name`.
    pub fn header(&self, name: &str) -> Option<String> {
        let mut joined: Option<String> = None;
        for (key, value) in &self.headers {
            if key.eq_ignore_ascii_case(name) {
                match joined.as_mut() {
                    Some(text) => {
                        text.push_str(", ");
                        text.push_str(value);
                    }
                    None => joined = Some(value.clone()),
                }
            }
        }
        joined
    }
}

/// A request `handleUpgrade` refuses: the status, the body text and the headers added to the standard three.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub message: &'static str,
    pub headers: Vec<(&'static str, &'static str)>,
}

/// A request that passed every check: the key to answer and the subprotocol the answer names, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    pub key: String,
    pub protocol: Option<String>,
}

fn refuse(status: u16, message: &'static str) -> Refusal {
    Refusal { status, message, headers: Vec::new() }
}

/// The checks of `handleUpgrade`, in its order. `shouldHandle` is not asked: the relay sets no `path` option.
pub fn validate(request: &HandshakeRequest) -> Result<Accepted, Refusal> {
    if request.method != "GET" {
        return Err(refuse(405, "Invalid HTTP method"));
    }
    match request.header("upgrade") {
        Some(upgrade) if mixdog_js::js_to_lowercase(&upgrade) == "websocket" => {}
        _ => return Err(refuse(400, "Invalid Upgrade header")),
    }
    let key = match request.header("sec-websocket-key") {
        Some(key) if is_key(&key) => key,
        _ => return Err(refuse(400, "Missing or invalid Sec-WebSocket-Key header")),
    };
    let version = request.header("sec-websocket-version").map_or(f64::NAN, |text| mixdog_js::string_to_number(&text));
    if version != 13.0 && version != 8.0 {
        return Err(Refusal {
            status: 400,
            message: "Missing or invalid Sec-WebSocket-Version header",
            headers: vec![("Sec-WebSocket-Version", "13, 8")],
        });
    }
    let protocol = match request.header("sec-websocket-protocol") {
        Some(header) => match first_subprotocol(&header) {
            Some(first) => Some(first),
            None => return Err(refuse(400, "Invalid Sec-WebSocket-Protocol header")),
        },
        None => None,
    };
    Ok(Accepted { key, protocol })
}

/// `/^[+/0-9A-Za-z]{22}==$/`
fn is_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() == 24
        && bytes.ends_with(b"==")
        && bytes[..22].iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

/// `subprotocol.parse` of `ws`: the offered protocols in order, or `None` where it throws (a character that is neither a
/// token character, a space or tab not at the start, nor a comma; an empty entry; the end of input inside an entry; a
/// repeated protocol). Only the first one matters: with no `handleProtocols` it is the one the answer names.
fn first_subprotocol(header: &str) -> Option<String> {
    let bytes = header.as_bytes();
    let mut seen: Vec<&str> = Vec::new();
    let mut start: Option<usize> = None;
    let mut end: Option<usize> = None;
    for (index, &byte) in bytes.iter().enumerate() {
        if end.is_none() && is_token_char(byte) {
            if start.is_none() {
                start = Some(index);
            }
        } else if index != 0 && (byte == b' ' || byte == b'\t') {
            if end.is_none() && start.is_some() {
                end = Some(index);
            }
        } else if byte == b',' {
            let from = start?;
            let to = end.unwrap_or(index);
            let protocol = &header[from..to];
            if seen.contains(&protocol) {
                return None;
            }
            seen.push(protocol);
            start = None;
            end = None;
        } else {
            return None;
        }
    }
    let from = start?;
    if end.is_some() {
        return None;
    }
    let protocol = &header[from..];
    if seen.contains(&protocol) {
        return None;
    }
    seen.push(protocol);
    Some(seen[0].to_string())
}

/// `STATUS_CODES` of Node for the statuses a handshake can end in.
pub fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// The bytes `abortHandshake` writes before it ends and destroys the socket.
pub fn refusal_bytes(status: u16, message: Option<&str>, extra: &[(&str, &str)]) -> Vec<u8> {
    let message = message.filter(|text| !text.is_empty()).unwrap_or_else(|| status_text(status));
    let mut headers: Vec<(String, String)> = vec![
        ("Connection".to_string(), "close".to_string()),
        ("Content-Type".to_string(), "text/html".to_string()),
        ("Content-Length".to_string(), message.len().to_string()),
    ];
    for (name, value) in extra {
        match headers.iter_mut().find(|(known, _)| known == name) {
            Some(slot) => slot.1 = (*value).to_string(),
            None => headers.push(((*name).to_string(), (*value).to_string())),
        }
    }
    let mut text = format!("HTTP/1.1 {status} {}\r\n", status_text(status));
    text.push_str(&headers.iter().map(|(name, value)| format!("{name}: {value}")).collect::<Vec<_>>().join("\r\n"));
    text.push_str("\r\n\r\n");
    text.push_str(message);
    text.into_bytes()
}

/// The 101 answer: the three standard headers and the accept digest, and the chosen subprotocol when there is one.
pub fn accept_bytes(key: &str, protocol: Option<&str>) -> Vec<u8> {
    let digest = Sha1::digest(format!("{key}{GUID}").as_bytes());
    let mut lines = vec![
        "HTTP/1.1 101 Switching Protocols".to_string(),
        "Upgrade: websocket".to_string(),
        "Connection: Upgrade".to_string(),
        format!("Sec-WebSocket-Accept: {}", STANDARD.encode(digest)),
    ];
    if let Some(protocol) = protocol {
        lines.push(format!("Sec-WebSocket-Protocol: {protocol}"));
    }
    lines.push(String::new());
    lines.push(String::new());
    lines.join("\r\n").into_bytes()
}
