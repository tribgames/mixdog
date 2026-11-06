//! The one 1.4.5-protocol call Mixdog makes (LR §5.4 last row): ask a running 1.4.5
//! daemon to wind down through its own `/upgrade` route (non-forced: drain preserving
//! work, exit when idle; `force:true` once after the user confirmed the abort), and read
//! its busy work from `/health`. Exit is confirmed by the OS, not here.

use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;

/// 1.4.5 `SESSION_PROTOCOL` / `SESSION_REVISION` (`v145:src/standalone/session-wire.mjs`).
pub const LEGACY_SESSION_PROTOCOL: u64 = 1;
pub const LEGACY_SESSION_REVISION: u64 = 6;
/// Connect timeout of the loopback request (transport configuration).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest single read or write of that request, so a daemon that stops answering
/// ends the call instead of holding the migration.
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// The session endpoint of a 1.4.5 daemon (legacy discovery `endpoints.session`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyEndpoint {
    pub port: u16,
    pub token: String,
}

/// `endpoints.session` of the legacy discovery file, if it names one.
pub fn read_discovery(path: &Path) -> Option<LegacyEndpoint> {
    let value: Value = serde_json::from_slice(&crate::durable::read(path).ok()?).ok()?;
    let session = value.get("endpoints")?.get("session")?;
    Some(LegacyEndpoint {
        port: u16::try_from(session.get("port")?.as_u64()?).ok()?,
        token: session.get("token")?.as_str()?.to_string(),
    })
}

/// An HTTP answer: status and JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub body: Value,
}

fn request(endpoint: &LegacyEndpoint, method: &str, path: &str, body: Option<&Value>) -> Result<Answer, String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(IO_TIMEOUT)))
        .map_err(|e| e.to_string())?;
    let payload = body.map(|b| b.to_string()).unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nx-mixdog-daemon-token: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        endpoint.port,
        endpoint.token,
        payload.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(payload.as_bytes()))
        .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no HTTP header end")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no HTTP status")?;
    let mut body = raw[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        body = dechunk(&body)?;
    }
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).map_err(|e| e.to_string())?
    };
    Ok(Answer { status, body })
}

fn dechunk(mut raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = raw.windows(2).position(|w| w == b"\r\n").ok_or("bad chunk")?;
        let size_text = String::from_utf8_lossy(&raw[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|e| e.to_string())?;
        raw = &raw[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        out.extend_from_slice(raw.get(..size).ok_or("short chunk")?);
        raw = raw.get(size + 2..).ok_or("short chunk")?;
    }
}

/// `POST /upgrade {protocol:1, revision:SESSION_REVISION+1, version, force}`.
pub fn request_upgrade(endpoint: &LegacyEndpoint, version: &str, force: bool) -> Result<Answer, String> {
    let mut body = json!({
        "protocol": LEGACY_SESSION_PROTOCOL,
        "revision": LEGACY_SESSION_REVISION + 1,
        "version": version,
    });
    if force {
        body["force"] = Value::Bool(true);
    }
    request(endpoint, "POST", "/upgrade", Some(&body))
}

/// `GET /health`: the daemon's identity and busy work (`busySessions`, `idle`).
pub fn health(endpoint: &LegacyEndpoint) -> Result<Answer, String> {
    request(endpoint, "GET", "/health", None)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn upgrade_is_sent_with_the_token_and_a_newer_revision() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(IO_TIMEOUT)).unwrap();
            let mut buf = vec![0u8; 4096];
            let mut got = Vec::new();
            while !got.windows(4).any(|w| w == b"\r\n\r\n") || !got.ends_with(b"}") {
                let n = s.read(&mut buf).unwrap();
                assert_ne!(n, 0, "the request ended early: {}", String::from_utf8_lossy(&got));
                got.extend_from_slice(&buf[..n]);
            }
            let reply = br#"{"accepted":true}"#;
            write!(s, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", reply.len()).unwrap();
            s.write_all(reply).unwrap();
            String::from_utf8(got).unwrap()
        });
        let ep = LegacyEndpoint { port, token: "tok".into() };
        let answer = request_upgrade(&ep, "1.4.6", false).unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body["accepted"], true);
        let sent = server.join().unwrap();
        assert!(sent.starts_with("POST /upgrade HTTP/1.1"));
        assert!(sent.contains("x-mixdog-daemon-token: tok"));
        let body: Value = serde_json::from_str(&sent[sent.find("\r\n\r\n").unwrap() + 4..]).unwrap();
        assert_eq!(body, json!({"protocol": 1, "revision": 7, "version": "1.4.6"}));
    }
}
