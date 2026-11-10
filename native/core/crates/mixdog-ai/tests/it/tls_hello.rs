//! The first flight (the ClientHello) the production clients put on a TLS connection, taken as raw bytes at a plain TCP
//! listener: `ReqwestLink` for HTTPS, `ws::connect` for WSS. `MIXDOG_TLS_HELLO_OUT` names a file to write them to as
//! JSON; `benchmarks/terminal-bench-2.1/analysis/parity/tls-hello-report.mjs` reads it next to Node's (`tls-hello-capture.mjs`).

use std::time::Duration;

use mixdog_ai::transport::{HttpSend, ReqwestLink, deadlines, ws};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::WireRequest;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

/// One connection's first TLS record: its 5-byte header, then the length it names.
async fn first_record(listener: &TcpListener) -> Vec<u8> {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut head = [0u8; 5];
    stream.read_exact(&mut head).await.unwrap();
    let mut body = vec![0u8; usize::from(u16::from_be_bytes([head[3], head[4]]))];
    stream.read_exact(&mut body).await.unwrap();
    [head.to_vec(), body].concat()
}

/// The protocols of the ALPN extension (type 16) of a ClientHello record, in order.
fn alpn(record: &[u8]) -> Vec<String> {
    let mut at = 5 + 4 + 2 + 32;
    at += 1 + usize::from(record[at]); // session id
    at += 2 + usize::from(u16::from_be_bytes([record[at], record[at + 1]])); // cipher suites
    at += 1 + usize::from(record[at]); // compression
    let end = at + 2 + usize::from(u16::from_be_bytes([record[at], record[at + 1]]));
    at += 2;
    let mut offered = Vec::new();
    while at < end {
        let (kind, len) = (u16::from_be_bytes([record[at], record[at + 1]]), usize::from(u16::from_be_bytes([record[at + 2], record[at + 3]])));
        if kind == 16 {
            let data = &record[at + 4..at + 4 + len];
            let mut i = 2;
            while i < data.len() {
                offered.push(String::from_utf8_lossy(&data[i + 1..i + 1 + usize::from(data[i])]).into_owned());
                i += 1 + usize::from(data[i]);
            }
        }
        at += 4 + len;
    }
    offered
}

#[tokio::test]
async fn the_clients_first_flight_is_a_client_hello() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("https://localhost:{port}/");

    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap();
    let request = WireRequest { transport: TransportKind::Http1, method: "GET".into(), url: url.clone(), headers: Vec::new(), body: Vec::new() };
    let sent = tokio::spawn(async move { link.send(request, deadlines::OPENAI_CATALOG).await.map(|_| ()) });
    let http = tokio::time::timeout(Duration::from_secs(10), first_record(&listener)).await.expect("HTTPS first flight within 10 s");
    sent.abort();

    let dialled = tokio::spawn(async move { ws::connect(url.replacen("https", "wss", 1), &KeepaliveSchedule::SPEC).await.map(|_| ()) });
    let socket = tokio::time::timeout(Duration::from_secs(10), first_record(&listener)).await.expect("WSS first flight within 10 s");
    dialled.abort();

    for hello in [&http, &socket] {
        assert_eq!(&hello[..2], &[0x16, 0x03], "a TLS handshake record");
        assert_eq!(hello[5], 1, "of type ClientHello");
    }
    // The ALPN offer, in its order, is what Node's clients put in theirs (`tls-hello-capture.mjs`, undici 8.12.3 and ws 8.22.0).
    let node: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/node-tls-hello.json"))).unwrap();
    for (kind, ours) in [("https", &http), ("wss", &socket)] {
        let theirs: Vec<u8> = (0..node[kind].as_str().unwrap().len()).step_by(2).map(|i| u8::from_str_radix(&node[kind].as_str().unwrap()[i..i + 2], 16).unwrap()).collect();
        assert_eq!(alpn(ours), alpn(&theirs), "{kind}: the ALPN list");
    }
    if let Ok(out) = std::env::var("MIXDOG_TLS_HELLO_OUT") {
        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        std::fs::write(out, serde_json::json!({ "https": hex(&http), "wss": hex(&socket) }).to_string()).unwrap();
    }
}
