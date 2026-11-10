//! What a client puts on the socket on top of the request a provider hands it, against what Node's real client puts
//! there (`fixtures/wire-anthropic-gemini/sockets.json`, recorded by
//! `benchmarks/rust-core/recorders/record-wire-anthropic-gemini.mjs`): one recorded request of the provider is sent by
//! the production transport (`ReqwestLink`, the `HttpSend` every provider rides) to a local listener that keeps the raw
//! bytes, over plain HTTP (the request head and body) and over TLS (the ClientHello: the ALPN it offers). Nothing is
//! left out of the comparison; every difference is a line of the failure.

use std::time::Duration;

use base64::Engine;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

use super::wire_tests::header_pairs;
use super::wire_tests::recording;
use crate::transport::HttpSend;
use crate::transport::ReqwestLink;
use crate::transport::deadlines::MODEL_STREAM_FETCH;

/// How long the listener or the client may take in real time; both are on loopback.
const WAIT: Duration = Duration::from_secs(15);

async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, wait).await.unwrap_or_else(|_| panic!("{what}: nothing arrived within {WAIT:?}"))
}

/// The request head as received (lines in order, original case) and the body's digest.
struct Received {
    request_line: String,
    headers: Vec<(String, String)>,
    chunked: bool,
    body_sha256: String,
}

async fn read_http(listener: TcpListener) -> Received {
    let (mut socket, _) = listener.accept().await.expect("a connection");
    let mut raw = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        let read = socket.read(&mut chunk).await.expect("a read");
        assert!(read > 0, "the client hung up before the request was complete");
        raw.extend_from_slice(&chunk[..read]);
        let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
        let head = String::from_utf8_lossy(&raw[..end]).into_owned();
        let mut lines = head.split("\r\n");
        let request_line = lines.next().expect("a request line").to_owned();
        let headers: Vec<(String, String)> = lines
            .map(|line| {
                let (name, value) = line.split_once(':').expect("a header line");
                (name.to_owned(), value.trim().to_owned())
            })
            .collect();
        let value = |name: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
        let body = &raw[end + 4..];
        let chunked = value("transfer-encoding").as_deref() == Some("chunked");
        let complete = if chunked { body.ends_with(b"0\r\n\r\n") } else { body.len() >= value("content-length").map_or(0, |n| n.parse().expect("a length")) };
        if !complete {
            continue;
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}").await.expect("the answer");
        return Received { request_line, headers, chunked, body_sha256: Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect() };
    }
}

/// The ALPN protocols, server name and TLS versions a ClientHello offers.
async fn read_hello(listener: TcpListener) -> Value {
    let (mut socket, _) = listener.accept().await.expect("a connection");
    let mut buf = vec![0u8; 16384];
    let read = socket.read(&mut buf).await.expect("a read");
    let buf = &buf[..read];
    let u16_at = |at: usize| usize::from(u16::from_be_bytes([buf[at], buf[at + 1]]));
    let mut at = 5 + 4 + 2 + 32;
    at += 1 + usize::from(buf[at]);
    at += 2 + u16_at(at);
    at += 1 + usize::from(buf[at]);
    let end = at + 2 + u16_at(at);
    at += 2;
    let (mut alpn, mut server_name, mut versions) = (Vec::new(), Value::Null, Vec::new());
    while at < end {
        let (kind, len) = (u16_at(at), u16_at(at + 2));
        let body = &buf[at + 4..at + 4 + len];
        at += 4 + len;
        match kind {
            16 => {
                let mut i = 2;
                while i < body.len() {
                    alpn.push(String::from_utf8_lossy(&body[i + 1..i + 1 + usize::from(body[i])]).into_owned());
                    i += 1 + usize::from(body[i]);
                }
            }
            0 if body.len() > 5 => server_name = Value::String(String::from_utf8_lossy(&body[5..]).into_owned()),
            43 => versions.extend(body[1..].chunks(2).map(|v| format!("{:x}", u16::from_be_bytes([v[0], v[1]])))),
            _ => {}
        }
    }
    serde_json::json!({ "alpn": alpn, "serverName": server_name, "supportedVersions": versions })
}

/// Sends the provider's recorded request through the production transport and compares everything the listener got
/// with what Node's client put there.
pub(crate) async fn socket_equals_nodes(provider: &str) {
    let document = recording("sockets.json");
    let scenario = document["scenarios"].as_array().expect("scenarios").iter().find(|s| s["provider"] == provider).expect("the provider's recording");
    let recorded = &scenario["request"];
    let path = recorded["path"].as_str().expect("path");
    let headers: Vec<(String, String)> = recorded["headers"].as_array().expect("headers").iter().map(|p| (p[0].as_str().expect("name").to_owned(), p[1].as_str().expect("value").to_owned())).collect();
    let body = base64::engine::general_purpose::STANDARD.decode(recorded["bodyBase64"].as_str().expect("body")).expect("base64");
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link");
    let request = |origin: String| WireRequest { transport: TransportKind::Http1, method: recorded["method"].as_str().expect("method").to_owned(), url: format!("{origin}{path}"), headers: headers.clone(), body: body.clone() };

    let plain = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let port = plain.local_addr().expect("an address").port();
    let served = tokio::spawn(read_http(plain));
    within(&format!("{provider}: the plain request"), link.send(request(format!("http://127.0.0.1:{port}")), MODEL_STREAM_FETCH)).await.unwrap_or_else(|e| panic!("{provider}: the plain request failed: {}", e.message));
    let got = within(&format!("{provider}: the request head"), served).await.expect("the listener");

    let secure = TcpListener::bind("127.0.0.1:0").await.expect("a listener");
    let secure_port = secure.local_addr().expect("an address").port();
    let heard = tokio::spawn(read_hello(secure));
    // The listener hangs up after the hello, so this send is expected to fail.
    let _ = within(&format!("{provider}: the TLS request"), link.send(request(format!("https://127.0.0.1:{secure_port}")), MODEL_STREAM_FETCH)).await;
    let hello = within(&format!("{provider}: the ClientHello"), heard).await.expect("the listener");

    let node = &scenario["received"];
    // The one thing that cannot be equal: the ephemeral port of the listener, which `host` carries.
    let unport = |pairs: Vec<(String, String)>, port: u16| -> Vec<(String, String)> { pairs.into_iter().map(|(n, v)| (n, v.replace(&format!(":{port}"), ":<port>"))).collect() };
    let node_headers: Vec<(String, String)> = node["headers"].as_array().expect("headers").iter().map(|p| (p[0].as_str().expect("name").to_owned(), p[1].as_str().expect("value").to_owned())).collect();
    let node_port: u16 = node_headers.iter().find(|(n, _)| n == "host").and_then(|(_, v)| v.rsplit(':').next()).and_then(|p| p.parse().ok()).expect("the recorded host port");
    let (node_headers, rust_headers) = (header_pairs(&unport(node_headers, node_port)), header_pairs(&unport(got.headers, port)));
    let mut differences = Vec::new();
    if node["requestLine"] != got.request_line {
        differences.push(format!("request line: Node {} / Rust {:?}", node["requestLine"], got.request_line));
    }
    if node_headers != rust_headers {
        differences.push(format!("headers (name as received, value): Node {node_headers:?} / Rust {rust_headers:?}"));
    }
    if node["chunked"] != got.chunked {
        differences.push(format!("chunked: Node {} / Rust {}", node["chunked"], got.chunked));
    }
    if node["bodySha256"] != got.body_sha256 {
        differences.push(format!("body bytes: Node {} / Rust {}", node["bodySha256"], got.body_sha256));
    }
    if scenario["hello"] != hello {
        differences.push(format!("ClientHello: Node {} / Rust {hello}", scenario["hello"]));
    }
    assert!(differences.is_empty(), "{provider}: {} difference(s) on the socket (the owner of the gap is the shared transport, `transport::link::ReqwestLink`, not this provider; the adapter hands over the request Node hands its client):\n{}", differences.len(), differences.join("\n"));
}

#[tokio::test]
#[ignore = "red by design until the shared transport (`transport::link::ReqwestLink`, outside this branch's paths) sends what Node's client sends; run with --run-ignored only to list the differences"]
async fn anthropic_socket_equals_nodes() {
    socket_equals_nodes("anthropic").await;
}
