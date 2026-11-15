//! The HTTP/1.1 layer against Node. `tests/fixtures/node-http-echo.recording.json` holds what a `node:http` server with the
//! fixed handler of `tests/fixtures/node-http-echo.mjs` answered to raw requests (recorded once by that script, with the
//! `Date` value masked here); [`EchoHandler`] is the same handler written against this layer, and every exchange must come
//! back byte for byte. The other tests are about what a recording cannot show: panics, drops, backpressure, TLS, closing.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_fsio::Unlaned;
use mixdog_relay::http1::{Handler, HandlerFuture, Headers, HeaderValue, Limits, Request, ResponseWriter, UpgradeRequest, fail_request};
use mixdog_relay::net::{Server, tls};
use mixdog_rt::time::{Instant, sleep, timeout};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

// ---- the handler of node-http-echo.mjs ----

#[derive(Default)]
struct EchoHandler {
    events: Arc<Mutex<Vec<String>>>,
    upgrades: Arc<Mutex<Vec<(bool, String)>>>,
}

impl Handler for EchoHandler {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        Box::pin(route(self.events.clone(), request, response))
    }

    fn upgrade(&self, upgrade: UpgradeRequest) {
        let seen = self.upgrades.clone();
        tokio::spawn(async move {
            let UpgradeRequest { method, url, headers, leftover, encrypted, mut io, .. } = upgrade;
            let text = format!("UPGRADE {method} {url} {} head={}", headers_json(&headers), hex(&leftover));
            seen.lock().unwrap().push((encrypted, text.clone()));
            let _ = io.write_all(text.as_bytes()).await;
            let _ = io.shutdown().await;
        });
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn quote(text: &str) -> String {
    let mut out = String::new();
    mixdog_js::json_quote(text, &mut out);
    out
}

/// `JSON.stringify(request.headers)`.
fn headers_json(headers: &Headers) -> String {
    let entries: Vec<String> = headers
        .iter()
        .map(|(name, value)| {
            let value = match value {
                HeaderValue::One(text) => quote(text),
                HeaderValue::Many(items) => format!("[{}]", items.iter().map(|item| quote(item)).collect::<Vec<_>>().join(",")),
            };
            format!("{}:{value}", quote(name))
        })
        .collect();
    format!("{{{}}}", entries.join(","))
}

async fn route(events: Arc<Mutex<Vec<String>>>, mut request: Request, mut response: ResponseWriter) {
    let pathname = request.url.split('?').next().unwrap_or("").to_owned();
    match pathname.as_str() {
        "/hello" => {
            response.set_header("X-Second", "2").unwrap();
            response.set_header("x-first", "1").unwrap();
            response.set_header("Content-Type", "text/plain; charset=utf-8").unwrap();
            response.set_header("x-second", "3").unwrap();
            response.end(Some(b"hello"));
        }
        "/json" => {
            response.write_head(200, &[("Content-Type", "application/json"), ("Cache-Control", "no-store")]).unwrap();
            response.end(Some(b"{\"ok\":true}"));
        }
        "/json-cl" => {
            response.write_head(200, &[("Content-Type", "application/json"), ("Content-Length", "11")]).unwrap();
            response.end(Some(b"{\"ok\":true}"));
        }
        "/stream" => {
            response.write_head(200, &[("Content-Type", "text/plain")]).unwrap();
            response.write(b"one");
            sleep(Duration::from_millis(30)).await;
            response.write(b"two");
            sleep(Duration::from_millis(30)).await;
            response.end(Some(b"three"));
        }
        "/cookies" => {
            response.set_header_values("Set-Cookie", &["a=1; Path=/", "b=2"]).unwrap();
            response.set_header("Content-Type", "text/plain").unwrap();
            response.end(Some(b"c"));
        }
        "/close" => {
            response.set_header("Connection", "close").unwrap();
            response.end(Some(b"bye"));
        }
        "/keepalive-own" => {
            response.set_header("Keep-Alive", "timeout=9").unwrap();
            response.end(Some(b"k"));
        }
        "/nocontent" => {
            response.write_head(204, &[]).unwrap();
            response.end(None);
        }
        "/notmod" => {
            response.write_head(304, &[("ETag", "\"x\"")]).unwrap();
            response.end(None);
        }
        "/echo" => {
            let json = format!(
                "{{\"method\":{},\"url\":{},\"httpVersion\":{},\"headers\":{}}}",
                quote(&request.method),
                quote(&request.url),
                quote(&request.http_version),
                headers_json(&request.headers)
            );
            response.end(Some(json.as_bytes()));
        }
        "/body" => {
            let mut body = Vec::new();
            loop {
                match request.body.next().await {
                    Some(Ok(chunk)) => body.extend_from_slice(&chunk),
                    Some(Err(_)) => {
                        let mut events = events.lock().unwrap();
                        events.push("body-error".to_owned());
                        events.push("body-aborted".to_owned());
                        return;
                    }
                    None => break,
                }
            }
            let text = format!("len={} body={}", body.len(), String::from_utf8_lossy(&body));
            response.end(Some(text.as_bytes()));
        }
        "/big-destroy" => {
            let mut size = 0;
            while let Some(Ok(chunk)) = request.body.next().await {
                size += chunk.len();
                if size > 10 {
                    response.write_head(413, &[("Content-Type", "text/plain; charset=utf-8")]).unwrap();
                    response.end(Some(b"Payload too large."));
                    response.finished().await;
                    request.destroy();
                    return;
                }
            }
        }
        "/drain-400" => {
            let mut size = 0;
            while let Some(Ok(chunk)) = request.body.next().await {
                size += chunk.len();
            }
            let (status, text) = if size > 10 { (400, "Bad request.") } else { (200, "ok") };
            response.write_head(status, &[("Content-Type", "text/plain; charset=utf-8")]).unwrap();
            response.end(Some(text.as_bytes()));
        }
        "/slow" => {
            sleep(Duration::from_millis(200)).await;
            response.end(Some(b"slow"));
        }
        "/events" => {
            let json = format!("[{}]", events.lock().unwrap().iter().map(|e| quote(e)).collect::<Vec<_>>().join(","));
            response.end(Some(json.as_bytes()));
        }
        _ => {
            response.set_status(404).unwrap();
            response.end(Some(b"nf"));
        }
    }
}

// ---- the byte comparison ----

fn latin1_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u8).collect()
}

fn latin1_text(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// The text with the value of every `Date` header replaced.
fn mask_date(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("\r\nDate: ") {
        let value_start = at + "\r\nDate: ".len();
        out.push_str(&rest[..value_start]);
        out.push_str("<date>");
        let value_end = rest[value_start..].find("\r\n").map_or(rest.len(), |end| value_start + end);
        rest = &rest[value_end..];
    }
    out.push_str(rest);
    out
}

struct Outcome {
    received: Vec<u8>,
    closed_by_server: bool,
    elapsed_ms: u128,
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} is not a number"))
}

/// Plays the steps of a recorded connection against `addr` and reads as the recording's `end` says.
async fn play(addr: SocketAddr, conn: &Value) -> Outcome {
    let stream = TcpStream::connect(addr).await.unwrap();
    let (mut rd, mut wr) = stream.into_split();
    let received = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let last_data = Arc::new(Mutex::new(Instant::now()));
    let reader = {
        let (received, closed, last_data) = (received.clone(), closed.clone(), last_data.clone());
        tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            loop {
                match rd.read(&mut chunk).await {
                    Ok(0) | Err(_) => {
                        closed.store(true, Ordering::SeqCst);
                        return;
                    }
                    Ok(read) => {
                        received.lock().unwrap().extend_from_slice(&chunk[..read]);
                        *last_data.lock().unwrap() = Instant::now();
                    }
                }
            }
        })
    };
    let started = Instant::now();
    let mut dropped = false;
    for step in conn["steps"].as_array().unwrap() {
        if let Some(text) = step["send"].as_str() {
            wr.write_all(&latin1_bytes(text)).await.unwrap();
        } else if step["wait"].is_number() {
            sleep(Duration::from_millis(number(step, "wait"))).await;
        } else if step["close"].as_bool() == Some(true) {
            reader.abort();
            dropped = true;
            let _ = wr.shutdown().await;
        }
    }
    if dropped {
        // The connection is closed from this side: nothing to wait for.
    } else if conn["end"] == "eof" {
        let limit = Duration::from_millis(number(conn, "maxMs"));
        while !closed.load(Ordering::SeqCst) && started.elapsed() < limit {
            sleep(Duration::from_millis(20)).await;
        }
    } else {
        let quiet = Duration::from_millis(number(conn, "quietMs"));
        *last_data.lock().unwrap() = Instant::now();
        while !closed.load(Ordering::SeqCst) && last_data.lock().unwrap().elapsed() < quiet {
            sleep(Duration::from_millis(20)).await;
        }
    }
    let closed_by_server = closed.load(Ordering::SeqCst) && !dropped;
    let elapsed_ms = started.elapsed().as_millis();
    reader.abort();
    let received = received.lock().unwrap().clone();
    Outcome { received, closed_by_server, elapsed_ms }
}

/// Where two texts first differ, with a little of each side.
fn first_difference(expected: &str, actual: &str) -> String {
    let at = expected.chars().zip(actual.chars()).take_while(|(a, b)| a == b).count();
    let clip = |text: &str| text.chars().skip(at.saturating_sub(20)).take(70).collect::<String>();
    format!("at {at}: expected {:?} got {:?}", clip(expected), clip(actual))
}

async fn run_scenario(scenario: Value) -> Vec<String> {
    let name = scenario["name"].as_str().unwrap().to_owned();
    let limits = if scenario["server"] == "short" {
        Limits { headers_timeout: Duration::from_millis(600), request_timeout: Duration::from_millis(1200), ..Limits::default() }
    } else {
        Limits::default()
    };
    let server = Server::start(0, None, Arc::new(EchoHandler::default()), limits).await.unwrap();
    let addr: SocketAddr = ([127, 0, 0, 1], server.port()).into();
    let mut failures = Vec::new();
    for (index, conn) in scenario["conns"].as_array().unwrap().iter().enumerate() {
        let outcome = play(addr, conn).await;
        let expected = mask_date(conn["received"].as_str().unwrap());
        let actual = mask_date(&latin1_text(&outcome.received));
        if expected != actual {
            failures.push(format!("{name} #{index}: {}", first_difference(&expected, &actual)));
        }
        if conn["closedByServer"].as_bool().unwrap() != outcome.closed_by_server {
            failures.push(format!("{name} #{index}: the server's close differs (node {})", conn["closedByServer"]));
        }
        if name == "idle close after 5 s" && !(5800..=7500).contains(&outcome.elapsed_ms) {
            failures.push(format!("{name} #{index}: closed after {} ms, node after {}", outcome.elapsed_ms, conn["elapsedMs"]));
        }
    }
    server.terminate_connections();
    failures
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_exchange_recorded_from_node_comes_back_byte_for_byte() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/node-http-echo.recording.json");
    let recording: Value = serde_json::from_str(&mixdog_fsio::read_to_string(&Unlaned, path).unwrap()).unwrap();
    let scenarios = recording["scenarios"].as_array().unwrap().clone();
    assert!(scenarios.len() >= 16, "the recording lost scenarios");
    let tasks: Vec<_> = scenarios.into_iter().map(|scenario| tokio::spawn(run_scenario(scenario))).collect();
    let mut failures = Vec::new();
    for task in tasks {
        failures.extend(task.await.unwrap());
    }
    assert!(failures.is_empty(), "{} exchanges differ from node:\n{}", failures.len(), failures.join("\n"));
}

// ---- what a recording cannot show ----

struct Custom<F>(F);

impl<F> Handler for Custom<F>
where
    F: Fn(Request, ResponseWriter) -> HandlerFuture + Send + Sync + 'static,
{
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        (self.0)(request, response)
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

async fn serve_with<F>(handler: F) -> (Server, SocketAddr)
where
    F: Fn(Request, ResponseWriter) -> HandlerFuture + Send + Sync + 'static,
{
    let server = Server::start(0, None, Arc::new(Custom(handler)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], server.port()).into();
    (server, addr)
}

/// Sends `request` and reads until the server closes or nothing has come for 300 ms.
async fn exchange(addr: SocketAddr, request: &[u8]) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match timeout(Duration::from_millis(300), stream.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => out.extend_from_slice(&chunk[..read]),
            _ => break,
        }
    }
    mask_date(&latin1_text(&out))
}

const GET: &[u8] = b"GET /x HTTP/1.1\r\nHost: h\r\n\r\n";

#[tokio::test]
async fn a_panic_in_a_handler_answers_500_and_the_server_keeps_serving() {
    let (server, addr) = serve_with(|request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            if request.url == "/boom" {
                panic!("boom");
            }
            response.end(Some(b"fine"));
        })
    })
    .await;
    let text = exchange(addr, b"GET /boom HTTP/1.1\r\nHost: h\r\n\r\nGET /ok HTTP/1.1\r\nHost: h\r\n\r\n").await;
    let expected_500 = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\nDate: <date>\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nTransfer-Encoding: chunked\r\n\r\nf\r\nInternal error.\r\n0\r\n\r\n";
    assert!(text.starts_with(expected_500), "{text:?}");
    assert!(text.ends_with("\r\n\r\nfine"), "{text:?}");
    server.terminate_connections();
}

#[tokio::test]
async fn a_panic_after_the_head_has_gone_closes_the_connection() {
    let (server, addr) = serve_with(|_request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            response.write_head(200, &[("Content-Type", "text/plain")]).unwrap();
            response.write(b"x");
            panic!("late");
        })
    })
    .await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(GET).await.unwrap();
    let mut out = Vec::new();
    let read = timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    assert!(matches!(read, Ok(Ok(_))), "the server closed the connection");
    assert!(latin1_text(&out).starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(!latin1_text(&out).ends_with("0\r\n\r\n"), "the response was cut, not ended");
    server.terminate_connections();
}

#[tokio::test]
async fn a_response_dropped_without_end_closes_the_connection() {
    let (server, addr) = serve_with(|_request: Request, response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            drop(response);
        })
    })
    .await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(GET).await.unwrap();
    let mut out = Vec::new();
    assert!(matches!(timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await, Ok(Ok(0) | Err(_))));
    assert!(out.is_empty());
    server.terminate_connections();
}

#[tokio::test]
async fn fail_request_answers_500_and_ends_a_response_whose_head_has_gone() {
    let (server, addr) = serve_with(|request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            if request.url == "/late" {
                response.write_head(200, &[("Content-Type", "text/plain")]).unwrap();
                response.write(b"x");
            }
            fail_request("probe", "it failed", &mut response);
        })
    })
    .await;
    let early = exchange(addr, b"GET /early HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await;
    assert!(early.starts_with("HTTP/1.1 500 Internal Server Error\r\n") && early.ends_with("f\r\nInternal error.\r\n0\r\n\r\n"), "{early:?}");
    let late = exchange(addr, b"GET /late HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await;
    assert!(late.starts_with("HTTP/1.1 200 OK\r\n") && late.ends_with("1\r\nx\r\n0\r\n\r\n"), "{late:?}");
    server.terminate_connections();
}

#[tokio::test]
async fn a_body_the_handler_never_reads_is_discarded_and_the_connection_serves_on() {
    let (server, addr) = serve_with(|_request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            response.end(Some(b"ok"));
        })
    })
    .await;
    let mut request = b"POST /skip HTTP/1.1\r\nHost: h\r\nContent-Length: 300000\r\n\r\n".to_vec();
    request.extend(std::iter::repeat_n(b'x', 300_000));
    request.extend_from_slice(b"GET /next HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
    let text = exchange(addr, &request).await;
    assert_eq!(text.matches("HTTP/1.1 200 OK").count(), 2, "{text:?}");
    server.terminate_connections();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_reader_is_told_to_wait_and_the_buffer_drains_when_it_reads() {
    let saw_false = Arc::new(AtomicBool::new(false));
    let drained_empty = Arc::new(AtomicBool::new(false));
    let (flag, empty) = (saw_false.clone(), drained_empty.clone());
    let (server, addr) = serve_with(move |_request: Request, mut response: ResponseWriter| -> HandlerFuture {
        let (flag, empty) = (flag.clone(), empty.clone());
        Box::pin(async move {
            response.write_head(200, &[("Content-Type", "application/octet-stream")]).unwrap();
            let chunk = vec![7u8; 64 * 1024];
            for _ in 0..32 {
                if !response.write(&chunk) {
                    flag.store(true, Ordering::SeqCst);
                    response.drain().await;
                    empty.store(response.writable_length() == 0, Ordering::SeqCst);
                }
            }
            response.end(None);
        })
    })
    .await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(b"GET /flood HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await.unwrap();
    sleep(Duration::from_millis(300)).await;
    let mut out = Vec::new();
    assert!(matches!(timeout(Duration::from_secs(20), stream.read_to_end(&mut out)).await, Ok(Ok(_))));
    assert!(out.len() > 32 * 64 * 1024 && out.ends_with(b"0\r\n\r\n"));
    assert!(saw_false.load(Ordering::SeqCst), "write said the buffer was full");
    assert!(drained_empty.load(Ordering::SeqCst), "drain resolved with the buffer empty");
    server.terminate_connections();
}

#[tokio::test]
async fn the_peer_address_is_the_socket_address_in_ipv4_form() {
    let (server, addr) = serve_with(|request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            let text = format!("{:?} {}", request.remote_address, request.encrypted);
            response.end(Some(text.as_bytes()));
        })
    })
    .await;
    let text = exchange(addr, b"GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").await;
    assert!(text.ends_with("Some(\"127.0.0.1\") false"), "{text:?}");
    server.terminate_connections();
}

#[tokio::test]
async fn closing_the_server_closes_idle_connections_and_stops_listening() {
    let (server, addr) = serve_with(|_request: Request, mut response: ResponseWriter| -> HandlerFuture {
        Box::pin(async move {
            response.end(Some(b"ok"));
        })
    })
    .await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(GET).await.unwrap();
    let mut chunk = [0u8; 1024];
    let read = stream.read(&mut chunk).await.unwrap();
    assert!(latin1_text(&chunk[..read]).ends_with("ok"));
    assert!(timeout(Duration::from_secs(5), server.close()).await.is_ok(), "close() resolved");
    assert_eq!(stream.read(&mut chunk).await.unwrap_or(0), 0, "the idle connection was closed");
    assert!(TcpStream::connect(addr).await.is_err(), "nothing listens any more");
}

// ---- TLS ----

#[tokio::test]
async fn tls_is_served_with_no_alpn_and_an_upgrade_hands_over_the_decrypted_stream() {
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let cert_pem = issued.cert.pem();
    let key_pem = pem::encode(&pem::Pem::new("PRIVATE KEY", issued.signing_key.serialize_der()));
    let config = tls::from_pem(cert_pem.as_bytes(), key_pem.as_bytes()).unwrap();
    let handler = Arc::new(EchoHandler::default());
    let upgrades = handler.upgrades.clone();
    let server = Server::start(0, Some(config), handler, Limits::default()).await.unwrap();

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(issued.cert.der().clone()).unwrap();
    let mut client = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    // The client offers h2; the server has no ALPN list and so picks nothing.
    client.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let name = rustls::pki_types::ServerName::try_from("localhost".to_owned()).unwrap();

    let tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port())).await.unwrap();
    let mut stream = connector.connect(name.clone(), tcp).await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), None, "h2 is never offered");
    stream.write_all(b"GET /hello HTTP/1.1\r\nHost: relay.test\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = Vec::new();
    let _ = timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    let text = latin1_text(&out);
    assert!(text.starts_with("HTTP/1.1 200 OK\r\n") && text.ends_with("hello"), "{text:?}");

    let tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, server.port())).await.unwrap();
    let mut stream = connector.connect(name, tcp).await.unwrap();
    stream
        .write_all(b"GET /ws HTTP/1.1\r\nHost: relay.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n\x81\x80abcd")
        .await
        .unwrap();
    let mut out = Vec::new();
    let _ = timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    assert!(latin1_text(&out).ends_with("head=818061626364"), "the leftover is the decrypted bytes: {:?}", latin1_text(&out));
    let seen = upgrades.lock().unwrap().clone();
    assert!(matches!(seen.as_slice(), [(true, _)]), "the request knew it was encrypted");
    server.terminate_connections();
}
