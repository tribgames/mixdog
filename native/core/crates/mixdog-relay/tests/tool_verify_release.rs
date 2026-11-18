//! `mixdog-relay verify-release` against local stand-ins of a deployed relay: identity and readiness checks, the websocket gates, timeouts, the startup window, the DNS override with TLS name validation and the response cap.

use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use mixdog_relay::tools::verify_release::{Options, ProbeError, Verified, verify_release};
use mixdog_rt::time::{Instant, sleep, timeout};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

const FOREIGN: &str = "https://deployment-probe.invalid";

#[derive(Clone)]
enum Ws {
    /// Same origin: accepted and closed with 4005; foreign origin: 403 on upgrade.
    Gated,
    /// The route does not exist.
    MissingRoute,
    /// Every origin is accepted and closed with 4005.
    AcceptsAnyOrigin,
    /// Same origin: accepted and closed with this code; foreign origin: 403.
    ClosesWith(u16),
    /// Same origin: accepted and never closed; foreign origin: 403.
    Silent,
}

#[derive(Clone)]
struct Fake {
    health: (u16, String),
    ready: (u16, String),
    ws: Ws,
    /// A request on /healthz that is accepted and never answered.
    health_hangs: bool,
    seen: Arc<Mutex<Vec<String>>>,
}

fn index_digest() -> String {
    Sha256::digest(b"<!doctype html><head></head>").iter().map(|b| format!("{b:02x}")).collect()
}

fn ready_body(index: &str) -> String {
    json!({
        "status": "ready",
        "indexSha256": index,
        "version": "a".repeat(64),
        "assets": 8,
        "releases": [{ "id": "r1", "indexSha256": index }, { "id": "legacy", "indexSha256": "c".repeat(64) }],
    })
    .to_string()
}

fn healthy() -> Fake {
    Fake {
        health: (200, json!({ "status": "ok" }).to_string()),
        ready: (200, ready_body(&index_digest())),
        ws: Ws::Gated,
        health_hangs: false,
        seen: Arc::default(),
    }
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 || buffer.len() > 16 * 1024 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

async fn respond<S: AsyncWrite + Unpin>(stream: &mut S, status: u16, body: &str) {
    let text = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(text.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, fake: Fake) {
    let Some(head) = read_head(&mut stream).await else { return };
    let line = head.lines().next().unwrap_or_default().to_owned();
    let origin = header(&head, "origin").unwrap_or_default().to_owned();
    let accept = header(&head, "accept").unwrap_or_default();
    fake.seen.lock().unwrap().push(format!("{line} | origin={origin} | accept={accept}"));
    match line.split(' ').nth(1).unwrap_or_default() {
        "/healthz" if fake.health_hangs => sleep(Duration::from_secs(30)).await,
        "/healthz" => respond(&mut stream, fake.health.0, &fake.health.1).await,
        "/readyz" => respond(&mut stream, fake.ready.0, &fake.ready.1).await,
        "/ws" => serve_ws(stream, &head, &origin, &fake.ws).await,
        _ => respond(&mut stream, 404, "{}").await,
    }
}

async fn serve_ws<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, head: &str, origin: &str, mode: &Ws) {
    if matches!(mode, Ws::MissingRoute) {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n").await;
        return;
    }
    if origin == FOREIGN && !matches!(mode, Ws::AcceptsAnyOrigin) {
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n").await;
        return;
    }
    let key = header(head, "sec-websocket-key").unwrap_or_default();
    let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(key.as_bytes());
    let reply = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    );
    if stream.write_all(reply.as_bytes()).await.is_err() {
        return;
    }
    let mut socket = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    let code = match mode {
        Ws::ClosesWith(code) => *code,
        Ws::Silent => {
            sleep(Duration::from_secs(30)).await;
            return;
        }
        _ => 4005,
    };
    let frame = CloseFrame { code: CloseCode::from(code), reason: "pairing rescan required".into() };
    let _ = socket.close(Some(frame)).await;
    // Let the peer read the close before the socket goes away.
    let _ = timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = socket.next().await {} }).await;
}

fn spawn_plain(listener: TcpListener, fake: Fake) {
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve(stream, fake.clone()));
        }
    });
}

async fn start(fake: &Fake) -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    spawn_plain(listener, fake.clone());
    port
}

/// A port nothing listens on.
async fn closed_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    listener.local_addr().unwrap().port()
}

fn opts(port: u16) -> Options {
    let mut options = Options::new(&format!("http://127.0.0.1:{port}"), &index_digest());
    options.timeout = Duration::from_secs(5);
    options.startup = Duration::from_millis(200);
    options
}

async fn failure(options: &Options) -> String {
    verify_release(options).await.expect_err("the probe fails").to_string()
}

fn verified(result: Result<Verified, ProbeError>) -> Verified {
    result.unwrap_or_else(|error| panic!("the probe passes: {error}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deployment_with_both_gates_shut_verifies_and_reports_its_identity() {
    let fake = healthy();
    let port = start(&fake).await;
    let mut options = opts(port);
    options.expected_release = "r1".to_owned();
    let result = verified(verify_release(&options).await);
    assert_eq!(result, Verified { index_sha256: index_digest(), assets: json!(8), releases: 2 });
    assert_eq!(
        result.to_line(),
        format!(
            "{{\"status\":\"verified\",\"indexSha256\":\"{}\",\"assets\":8,\"releases\":2,\"websocket\":\"gated\"}}",
            index_digest()
        )
    );
    let seen = fake.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 4, "liveness, readiness and the two upgrades: {seen:?}");
    assert!(seen[0].starts_with("GET /healthz HTTP/1.1") && seen[0].ends_with("accept=application/json"), "{seen:?}");
    assert!(seen[1].starts_with("GET /readyz HTTP/1.1"), "{seen:?}");
    assert!(seen[2].starts_with("GET /ws HTTP/1.1") && seen[2].contains(&format!("origin=http://127.0.0.1:{port} ")), "{seen:?}");
    assert!(seen[3].contains(&format!("origin={FOREIGN} ")), "{seen:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_digest_that_is_not_the_expected_one_is_an_identity_mismatch() {
    let port = start(&healthy()).await;
    let mut options = opts(port);
    options.expected_index = "b".repeat(64);
    assert_eq!(failure(&options).await, "Renderer readiness or deployed release identity does not match.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readiness_that_is_not_ready_or_lacks_version_or_assets_fails() {
    let index = index_digest();
    let cases = [
        json!({ "status": "not-ready", "indexSha256": index, "version": "a".repeat(64), "assets": 8 }),
        json!({ "status": "ready", "indexSha256": index, "version": "A".repeat(64), "assets": 8 }),
        json!({ "status": "ready", "indexSha256": index, "version": "a".repeat(63), "assets": 8 }),
        json!({ "status": "ready", "indexSha256": index, "version": "a".repeat(64), "assets": 0 }),
        json!({ "status": "ready", "indexSha256": index, "version": "a".repeat(64) }),
        json!({ "status": "ready", "version": "a".repeat(64), "assets": 8 }),
    ];
    for body in cases {
        let mut fake = healthy();
        fake.ready.1 = body.to_string();
        let port = start(&fake).await;
        assert_eq!(failure(&opts(port)).await, "Renderer readiness or deployed release identity does not match.", "{body}");
    }
    // A numeric string counts as the number it spells, as the comparison did in the script.
    let mut fake = healthy();
    fake.ready.1 = json!({ "status": "ready", "indexSha256": index, "version": "a".repeat(64), "assets": "3" }).to_string();
    let port = start(&fake).await;
    assert_eq!(verified(verify_release(&opts(port)).await).assets, json!("3"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_added_release_must_be_served_with_the_uploaded_digest() {
    let port = start(&healthy()).await;
    let mut options = opts(port);
    options.expected_release = "r2".to_owned();
    assert_eq!(failure(&options).await, "Added renderer release is not served side by side.");

    let mut fake = healthy();
    fake.ready.1 = json!({
        "status": "ready", "indexSha256": index_digest(), "version": "a".repeat(64), "assets": 8,
        "releases": [{ "id": "r2", "indexSha256": "d".repeat(64) }],
    })
    .to_string();
    let port = start(&fake).await;
    let mut options = opts(port);
    options.expected_release = "r2".to_owned();
    assert_eq!(failure(&options).await, "Added renderer release is not served side by side.");

    // Without an expected release the list is not consulted, and its absence counts as zero releases.
    let mut fake = healthy();
    fake.ready.1 = json!({ "status": "ready", "indexSha256": index_digest(), "version": "a".repeat(64), "assets": 8 }).to_string();
    let port = start(&fake).await;
    assert_eq!(verified(verify_release(&opts(port)).await).releases, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_readiness_status_that_is_not_200_names_the_path_and_status() {
    let mut fake = healthy();
    fake.ready = (503, json!({ "status": "not-ready" }).to_string());
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "/readyz returned HTTP 503.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn liveness_that_is_not_ok_fails() {
    let mut fake = healthy();
    fake.health.1 = json!({ "status": "degraded" }).to_string();
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "Relay liveness check failed.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_that_is_not_json_or_exceeds_64_kib_fails() {
    let mut fake = healthy();
    fake.health.1 = "not json".to_owned();
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "/healthz returned invalid JSON.");

    let mut fake = healthy();
    fake.ready.1 = format!("{{\"status\":\"ready\",\"pad\":\"{}\"}}", "x".repeat(64 * 1024));
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "Deployment probe response exceeds limit.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_http_cannot_hide_a_broken_websocket_gate_missing_route() {
    let mut fake = healthy();
    fake.ws = Ws::MissingRoute;
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "WebSocket upgrade returned HTTP 404.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn healthy_http_cannot_hide_a_broken_websocket_gate_foreign_origin_accepted() {
    let mut fake = healthy();
    fake.ws = Ws::AcceptsAnyOrigin;
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "WebSocket accepted a foreign origin.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pairing_gate_that_closes_with_another_code_fails_and_a_silent_one_times_out() {
    let mut fake = healthy();
    fake.ws = Ws::ClosesWith(1000);
    let port = start(&fake).await;
    assert_eq!(failure(&opts(port)).await, "WebSocket pairing gate returned close 1000.");

    let mut fake = healthy();
    fake.ws = Ws::Silent;
    let port = start(&fake).await;
    let mut options = opts(port);
    options.timeout = Duration::from_millis(300);
    assert_eq!(failure(&options).await, "Deployment WebSocket probe timed out.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unanswered_request_times_out() {
    let mut fake = healthy();
    fake.health_hangs = true;
    let port = start(&fake).await;
    let mut options = opts(port);
    options.timeout = Duration::from_millis(300);
    assert_eq!(failure(&options).await, "Deployment HTTP probe timed out.");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_a_refused_connection_is_waited_out_for_the_startup_window() {
    // The relay binds its port 400 ms after the probe starts: the probe retries until it is there.
    let late_port = closed_port().await;
    let late = healthy();
    tokio::spawn(async move {
        sleep(Duration::from_millis(400)).await;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, late_port)).await.unwrap();
        spawn_plain(listener, late);
    });
    let mut options = opts(late_port);
    options.startup = Duration::from_secs(10);
    verified(verify_release(&options).await);

    // Nothing ever listens: the failure arrives with the end of the window, not before and not long after.
    let mut options = opts(closed_port().await);
    options.startup = Duration::from_millis(600);
    let started = Instant::now();
    assert!(!failure(&options).await.is_empty());
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(500) && waited < Duration::from_secs(4), "{waited:?}");

    // An HTTP failure is real at once, however long the window.
    let mut fake = healthy();
    fake.health = (500, "{}".to_owned());
    let port = start(&fake).await;
    let mut options = opts(port);
    options.startup = Duration::from_secs(60);
    let started = Instant::now();
    assert_eq!(failure(&options).await, "/healthz returned HTTP 500.");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn the_origin_and_the_arguments_are_validated_before_any_request() {
    let digest = index_digest();
    for origin in [
        "http://user@127.0.0.1:1",
        "http://:pw@127.0.0.1:1",
        "http://127.0.0.1:1/path",
        "http://127.0.0.1:1/?q=1",
        "http://127.0.0.1:1/#f",
        "ftp://127.0.0.1:1",
    ] {
        let message = failure(&Options::new(origin, &digest)).await;
        assert_eq!(message, "Deployment probe requires an HTTP(S) origin without credentials.", "{origin}");
    }
    assert_eq!(failure(&Options::new("", &digest)).await, "Invalid URL");
    assert_eq!(failure(&Options::new("http://127.0.0.1:1", "")).await, "Expected renderer digest is required.");
    assert_eq!(failure(&Options::new("http://127.0.0.1:1", &"A".repeat(64))).await, "Expected renderer digest is required.");
    let mut options = Options::new("http://127.0.0.1:1", &digest);
    options.address = "10.0.0.1".to_owned();
    assert_eq!(failure(&options).await, "Only loopback may override deployment DNS.");
}

/// A TLS stand-in for `relay.test` whose certificate only the probe's extra root trusts; the name does not resolve, so a pass
/// proves the address override and the validation against the public host name.
async fn start_tls(fake: &Fake) -> (u16, Vec<u8>) {
    let issued = rcgen::generate_simple_self_signed(vec!["relay.test".to_owned()]).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![issued.cert.der().clone()], key.into())
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let fake = fake.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, fake) = (acceptor.clone(), fake.clone());
            tokio::spawn(async move {
                if let Ok(stream) = acceptor.accept(tcp).await {
                    serve(stream, fake).await;
                }
            });
        }
    });
    (port, issued.cert.der().to_vec())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn https_connects_to_the_override_address_and_validates_the_public_host_name() {
    let fake = healthy();
    let (port, root) = start_tls(&fake).await;
    let mut options = Options::new(&format!("https://relay.test:{port}"), &index_digest());
    options.address = "127.0.0.1".to_owned();
    options.startup = Duration::from_millis(200);
    options.extra_roots = vec![root];
    assert_eq!(verified(verify_release(&options).await).releases, 2);
    let seen = fake.seen.lock().unwrap().clone();
    assert!(seen[2].contains(&format!("origin=https://relay.test:{port} ")), "{seen:?}");

    // The certificate is not one of the web roots: the same probe without the extra root fails at once, however long the window.
    let mut untrusted = options.clone();
    untrusted.extra_roots.clear();
    untrusted.startup = Duration::from_secs(60);
    let started = Instant::now();
    assert!(!failure(&untrusted).await.is_empty());
    assert!(started.elapsed() < Duration::from_secs(10));

    // The certificate is for relay.test: the name localhost on the same listener does not match it.
    let mut wrong_name = options.clone();
    wrong_name.origin = format!("https://localhost:{port}");
    assert!(!failure(&wrong_name).await.is_empty());
}
