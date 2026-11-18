//! The assembled relay started in this process on port 0: serving, stopping, start failures, TLS with no ALPN list, the router's order, and the authentication of the desktop and hook legs.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_relay::config::Config;
use mixdog_relay::logline;
use mixdog_relay::server::{RunningRelay, spawn};
use mixdog_rt::LaneTokens;
use mixdog_rt::time::timeout;
use mixdog_testkit as testkit;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const SECRET: &str = "0123456789abcdef";
const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

fn tokens() -> LaneTokens {
    mixdog_rt::testing::tokens()
}

fn config(dir: &Path) -> Config {
    Config {
        port: 0.0,
        data_dir: dir.join("data").to_string_lossy().into_owned(),
        renderer_dir: String::new(),
        renderer_releases_dir: String::new(),
        tls_cert: String::new(),
        tls_key: String::new(),
        env: BTreeMap::new(),
        install_dir: dir.to_path_buf(),
    }
}

async fn started(dir: &TempDir) -> RunningRelay {
    testkit::create_dir_all(dir.path().join("data"));
    spawn(&config(dir.path()), tokens()).await.expect("the relay starts")
}

/// What the relay wrote back to `request` until it closed the connection (or said nothing for five seconds).
async fn exchange(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).into_owned()
}

fn status_of(answer: &str) -> &str {
    answer.lines().next().unwrap_or("")
}

fn get(path: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n\r\n")
}

fn upgrade(path: &str, authorization: Option<String>) -> String {
    let authorization = authorization.map(|value| format!("Authorization: {value}\r\n")).unwrap_or_default();
    format!(
        "GET {path} HTTP/1.1\r\nHost: relay.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {KEY}\r\n{authorization}\r\n"
    )
}

fn basic(device_id: &str, secret: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{device_id}:{secret}")))
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[tokio::test]
async fn the_relay_starts_on_port_zero_serves_and_stops() {
    let dir = TempDir::new().unwrap();
    let relay = started(&dir).await;
    assert_ne!(relay.port, 0, "the port the system chose is reported");
    let line = logline::listening(config(dir.path()).scheme(), relay.port, "");
    assert_eq!(line.text, format!("[relay] http listening on :{} (renderer: none)", relay.port));
    assert_eq!(status_of(&exchange(relay.port, &get("/healthz")).await), "HTTP/1.1 200 OK");
    relay.close().await;
    // Closing twice does nothing the second time, and nothing listens any more.
    relay.close().await;
    assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, relay.port)).await.is_err());
}

#[tokio::test]
async fn a_port_that_is_not_a_port_is_the_failure_the_entry_prints() {
    let dir = TempDir::new().unwrap();
    testkit::create_dir_all(dir.path().join("data"));
    for (port, shown) in [(f64::NAN, "NaN"), (70000.0, "70000"), (-1.0, "-1"), (1.5, "1.5")] {
        let message = spawn(&Config { port, ..config(dir.path()) }, tokens()).await.err().expect("the listen is refused");
        assert_eq!(message, format!("options.port should be >= 0 and < 65536. Received type number ({shown})."));
        assert_eq!(logline::failed_to_start(&message).text, format!("[relay] failed to start: {message}"));
    }
}

#[tokio::test]
async fn a_port_already_bound_refuses_the_start_and_the_first_relay_keeps_serving() {
    let dir = TempDir::new().unwrap();
    let first = started(&dir).await;
    let other = TempDir::new().unwrap();
    testkit::create_dir_all(other.path().join("data"));
    let message = spawn(&Config { port: f64::from(first.port), ..config(other.path()) }, tokens()).await.err().expect("the bind fails");
    assert!(message.starts_with("listen ") && message.ends_with(&format!(" 0.0.0.0:{}", first.port)), "{message}");
    assert_eq!(status_of(&exchange(first.port, &get("/healthz")).await), "HTTP/1.1 200 OK");
    first.close().await;
}

#[tokio::test]
async fn a_malformed_devices_file_refuses_the_start() {
    let dir = TempDir::new().unwrap();
    testkit::create_dir_all(dir.path().join("data"));
    testkit::write(dir.path().join("data").join("devices.json"), "{ not json");
    let message = spawn(&config(dir.path()), tokens()).await.err().expect("the store refuses the file");
    assert!(!message.is_empty());
}

#[tokio::test]
async fn tls_is_served_with_no_alpn_list() {
    let dir = TempDir::new().unwrap();
    testkit::create_dir_all(dir.path().join("data"));
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let (cert, key) = (dir.path().join("cert.pem"), dir.path().join("key.pem"));
    testkit::write(&cert, issued.cert.pem());
    testkit::write(&key, pem::encode(&pem::Pem::new("PRIVATE KEY", issued.signing_key.serialize_der())));
    let config = Config { tls_cert: cert.to_string_lossy().into_owned(), tls_key: key.to_string_lossy().into_owned(), ..config(dir.path()) };
    assert_eq!(config.scheme(), "https");
    let relay = spawn(&config, tokens()).await.expect("the relay starts with TLS");

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(issued.cert.der().clone()).unwrap();
    let mut client = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // The client offers h2; the relay has no ALPN list and so picks nothing.
    client.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let name = rustls::pki_types::ServerName::try_from("localhost".to_owned()).unwrap();
    let tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, relay.port)).await.unwrap();
    let mut stream = connector.connect(name, tcp).await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), None, "h2 is never offered");
    stream.write_all(get("/healthz").as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let _ = timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    assert_eq!(status_of(&String::from_utf8_lossy(&out)), "HTTP/1.1 200 OK");
    drop(stream);
    relay.close().await;
}

#[tokio::test]
async fn the_router_answers_in_nodes_order_on_the_raw_target() {
    let dir = TempDir::new().unwrap();
    let relay = started(&dir).await;
    let port = relay.port;
    // /readyz answers 405 with no body for any method but GET and HEAD.
    let refused = exchange(port, "POST /readyz HTTP/1.1\r\nHost: relay.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
    assert_eq!(status_of(&refused), "HTTP/1.1 405 Method Not Allowed");
    // With no renderer directory the probe says the relay is not ready, and says nothing about why.
    let probe = exchange(port, &get("/readyz?probe=1")).await;
    assert_eq!(status_of(&probe), "HTTP/1.1 503 Service Unavailable");
    assert!(probe.contains("Cache-Control: no-store") && probe.ends_with("16\r\n{\"status\":\"not-ready\"}\r\n0\r\n\r\n"), "{probe}");
    // The pages.
    let app = exchange(port, &get("/app")).await;
    assert!(status_of(&app) == "HTTP/1.1 200 OK" && app.contains("Content-Type: text/html; charset=utf-8"), "{app}");
    assert_eq!(status_of(&exchange(port, &get("/app/latest.json")).await), "HTTP/1.1 404 Not Found");
    assert_eq!(status_of(&exchange(port, &get("/connect")).await), "HTTP/1.1 200 OK");
    // Webhook ingress for a device with no agent leg: the route answers 503 (no static file is looked for).
    let hook = format!("POST /hook/{}/x HTTP/1.1\r\nHost: relay.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", uuid());
    assert_eq!(status_of(&exchange(port, &hook).await), "HTTP/1.1 503 Service Unavailable");
    // An absolute-form target reaches the static gate with its path.
    let absolute = exchange(port, "GET http://other.example/healthz HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n\r\n").await;
    assert_eq!(status_of(&absolute), "HTTP/1.1 200 OK");
    relay.close().await;
}

#[tokio::test]
async fn an_unknown_upgrade_path_is_a_destroyed_socket_and_a_leg_without_credentials_is_refused() {
    let dir = TempDir::new().unwrap();
    let relay = started(&dir).await;
    let port = relay.port;
    assert_eq!(exchange(port, &upgrade("/nope", None)).await, "", "nothing is written before the socket is destroyed");
    // An absolute-form target upgrades by its path.
    assert_eq!(exchange(port, &upgrade("http://relay.test/elsewhere", None)).await, "");
    let refusal = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n";
    assert_eq!(exchange(port, &upgrade("/desktop", None)).await, refusal);
    assert_eq!(exchange(port, &upgrade("/hookleg", None)).await, refusal);
    // A secret shorter than sixteen characters is refused before any limiter is charged.
    assert_eq!(exchange(port, &upgrade("/desktop", Some(basic(&uuid(), "short")))).await, refusal);
    relay.close().await;
}

#[tokio::test]
async fn a_new_device_is_registered_by_its_first_dial_and_the_relay_closes_with_the_leg_open() {
    let dir = TempDir::new().unwrap();
    let relay = started(&dir).await;
    let device = uuid();
    let mut stream = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, relay.port)).await.unwrap();
    stream.write_all(upgrade("/desktop", Some(basic(&device, SECRET))).as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        match timeout(Duration::from_secs(5), stream.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => head.extend_from_slice(&chunk[..read]),
            other => panic!("the upgrade was not answered: {other:?}"),
        }
    }
    assert_eq!(status_of(&String::from_utf8_lossy(&head)), "HTTP/1.1 101 Switching Protocols");
    assert!(relay.store().is_known(&device), "trust on first use bound the id");
    // The leg is still open: close() terminates it and returns.
    assert!(timeout(Duration::from_secs(10), relay.close()).await.is_ok(), "close() resolved");
}

#[tokio::test]
async fn a_wrong_secret_for_a_known_device_id_is_charged_and_then_refused() {
    let dir = TempDir::new().unwrap();
    let relay = started(&dir).await;
    let device = uuid();
    assert!(relay.store().authenticate(&device, SECRET).await);
    let request = upgrade("/desktop", Some(basic(&device, "wrong-secret-value")));
    let (mut status, mut unauthorized) = (String::new(), 0);
    for _ in 0..80 {
        status = status_of(&exchange(relay.port, &request).await).to_owned();
        if status == "HTTP/1.1 429 Too Many Requests" {
            break;
        }
        if status == "HTTP/1.1 401 Unauthorized" {
            unauthorized += 1;
        }
    }
    // A registered id must not be a free oracle: every guess is charged like any other unauthenticated attempt, and the bucket runs out.
    assert_eq!(status, "HTTP/1.1 429 Too Many Requests");
    assert!(unauthorized > 0);
    relay.close().await;
}
