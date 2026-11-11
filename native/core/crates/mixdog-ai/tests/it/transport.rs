//! Half-open peers become transport faults within the keepalive schedule.

use std::time::Duration;
use std::time::Instant;

use mixdog_ai::transport::fault::fault_from_reqwest;
use mixdog_ai::transport::http;
use mixdog_ai::transport::tcp;
use mixdog_ai::transport::ws;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::LinkLiveness;
use mixdog_core_api::domain::keepalive::PingKeepalive;
use mixdog_core_api::domain::keepalive::TcpKeepalive;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::TransportFault;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

/// The spec schedule scaled to test time; the shape is unchanged.
fn fast() -> KeepaliveSchedule {
    let ping = PingKeepalive {
        interval: Duration::from_millis(150),
        timeout: Duration::from_millis(100),
        while_idle: true,
    };
    KeepaliveSchedule {
        tcp: TcpKeepalive {
            idle: Duration::from_secs(60),
            interval: Duration::from_secs(60),
            count: 5,
        },
        h2: ping,
        ws: ping,
        ws_max_age: None,
    }
}

#[test]
fn spec_schedule_is_the_documented_one() {
    let s = KeepaliveSchedule::SPEC;
    assert_eq!(
        (s.tcp.idle, s.tcp.interval, s.tcp.count),
        (Duration::from_secs(60), Duration::from_secs(60), 5)
    );
    for ping in [s.h2, s.ws] {
        assert_eq!(
            (ping.interval, ping.timeout, ping.while_idle),
            (Duration::from_secs(30), Duration::from_secs(10), true)
        );
    }
    mixdog_core_api::domain::conformance::check_keepalive_schedule(&s);
}

#[tokio::test]
async fn tcp_connect_sets_the_os_keepalive_before_use() {
    mixdog_rt::testing::tokens();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let schedule = KeepaliveSchedule::SPEC;
    let stream = tcp::connect(addr, &schedule.tcp).await.unwrap();
    assert!(tcp::is_enabled(&stream).unwrap());
}

/// A server that completes the WebSocket upgrade and then never reads again:
/// the TCP connection stays up and acknowledged, but no PONG ever comes.
async fn silent_ws_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let _ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        std::future::pending::<()>().await;
    });
    (addr, task)
}

#[tokio::test]
async fn silent_websocket_peer_ends_as_keepalive_expired_within_the_schedule() {
    mixdog_rt::testing::tokens();
    let (addr, server) = silent_ws_server().await;
    let schedule = fast();
    let (mut conn, _) = ws::connect(format!("ws://{addr}/"), &schedule)
        .await
        .unwrap();
    let link = conn.link();
    assert_eq!(link.liveness(), LinkLiveness::Alive);
    let started = Instant::now();
    let fault = conn.recv().await.expect("a fault is delivered").unwrap_err();
    let bound = schedule.ws.interval + schedule.ws.timeout;
    assert_eq!(
        fault,
        TransportFault::KeepaliveExpired {
            transport: TransportKind::WebSocket
        }
    );
    assert!(started.elapsed() >= bound, "not before the probe timeout");
    assert!(
        started.elapsed() < bound * 3,
        "within the schedule, took {:?}",
        started.elapsed()
    );
    assert_eq!(link.liveness(), LinkLiveness::Dead(fault));
    assert!(conn.recv().await.is_none(), "one fault, then the end");
    server.abort();
}

#[tokio::test]
async fn answering_websocket_peer_stays_alive_and_delivers_frames() {
    mixdog_rt::testing::tokens();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        use futures::SinkExt;
        use futures::StreamExt;
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        // Reading answers pings; the echo proves frames flow.
        while let Some(Ok(msg)) = ws.next().await {
            if msg.is_text() {
                ws.send(msg).await.unwrap();
            }
        }
    });
    let schedule = fast().with_ws_max_age(Duration::from_millis(400));
    let (mut conn, _) = ws::connect(format!("ws://{addr}/"), &schedule)
        .await
        .unwrap();
    assert!(conn.link().may_start_response());
    // Several probe rounds pass with no data in flight.
    tokio::time::sleep(schedule.ws.interval * 4).await;
    assert_eq!(conn.link().liveness(), LinkLiveness::Alive);
    assert!(
        !conn.link().may_start_response(),
        "a connection at the provider's age limit takes no new response"
    );
    conn.send(ws::Message::text("hello")).await.unwrap();
    let echoed = conn.recv().await.unwrap().unwrap();
    assert_eq!(echoed.into_text().unwrap().as_str(), "hello");
    server.abort();
}

#[tokio::test]
async fn shared_http_link_returns_status_headers_and_a_streaming_body() {
    use mixdog_ai::transport::HttpSend;
    use mixdog_ai::transport::ReqwestLink;
    use mixdog_core_api::domain::keepalive::TransportKind as Kind;
    use mixdog_core_api::domain::provider::WireRequest;
    use tokio::io::AsyncWriteExt;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 2048];
        let _ = stream.read(&mut buf).await.unwrap();
        stream
            .write_all(b"HTTP/1.1 429 Too Many Requests\r\nretry-after: 3\r\ncontent-length: 2\r\n\r\nhi")
            .await
            .unwrap();
    });
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap();
    let response = link
        .send(
            WireRequest {
                transport: Kind::Http1,
                method: "POST".into(),
                url: format!("http://{addr}/"),
                headers: vec![("x-test".into(), "1".into())],
                body: b"{}".to_vec(),
            },
            mixdog_ai::transport::deadlines::MODEL_STREAM,
        )
        .await
        .unwrap();
    assert_eq!(response.status, 429);
    assert!(response.headers.iter().any(|(k, v)| k == "retry-after" && v == "3"));
    let all = response.read_all().await.unwrap();
    assert_eq!(all.body, b"hi");
}

// Driven by the paused clock with explicit advances: hyper's HTTP/2 keep-alive takes its timers from tokio, so virtual time
// is moved by this test, a step at a time, once the peer has the client's preface; the instants asserted are the
// schedule's own, whatever the machine's load.
#[tokio::test(start_paused = true)]
async fn silent_http2_peer_fails_the_request_within_the_schedule() {
    // A cleartext peer that accepts and swallows bytes: it never sends its
    // SETTINGS or a PING ack. It says when it has the client's preface.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (has_preface, preface) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut sink = [0u8; 4096];
        let mut has_preface = Some(has_preface);
        while stream.read(&mut sink).await.map_or(false, |n| n > 0) {
            if let Some(tx) = has_preface.take() {
                let _ = tx.send(());
            }
        }
    });
    let schedule = fast();
    let client = http::client_builder(&schedule)
        .http2_prior_knowledge()
        .build()
        .unwrap();
    let url = format!("http://{addr}/");
    let request = tokio::spawn(async move { client.get(url).send().await });
    // Real I/O first (connect, preface); no virtual time has to pass for it.
    tokio::time::timeout(Duration::from_secs(10), preface).await.expect("the peer receives the preface within 10 s").unwrap();
    let started = tokio::time::Instant::now();
    let bound = (schedule.h2.interval + schedule.h2.timeout) * 3;
    let step = Duration::from_millis(10);
    while !request.is_finished() {
        assert!(started.elapsed() < bound, "the request is still open {:?} into the schedule", started.elapsed());
        tokio::time::advance(step).await;
    }
    let err = request.await.unwrap().expect_err("the request ends as a socket error");
    let (fault, _) = fault_from_reqwest(&err);
    assert!(started.elapsed() < bound, "within the schedule, took {:?} ({fault:?})", started.elapsed());
    server.abort();
}
/// A server whose `/final` answers 200 `land` and whose every other path answers a 302 to it.
async fn redirecting_server() -> std::net::SocketAddr {
    use tokio::io::AsyncWriteExt;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let read = stream.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..read]).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let reply: &[u8] = if path == "/final" {
                    b"HTTP/1.1 200 OK\r\ncontent-length: 4\r\nconnection: close\r\n\r\nland"
                } else {
                    b"HTTP/1.1 302 Found\r\nlocation: /final\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                };
                let _ = stream.write_all(reply).await;
            });
        }
    });
    addr
}

async fn get_through_redirect(
    exchange: mixdog_ai::transport::Exchange,
) -> Result<mixdog_ai::transport::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
    use mixdog_ai::transport::HttpSend;
    use mixdog_ai::transport::ReqwestLink;
    use mixdog_core_api::domain::provider::WireRequest;

    let addr = redirecting_server().await;
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap();
    link.send(
        WireRequest {
            transport: TransportKind::Http1,
            method: "GET".into(),
            url: format!("http://{addr}/start"),
            headers: Vec::new(),
            body: Vec::new(),
        },
        exchange,
    )
    .await
}

#[tokio::test]
async fn a_follow_site_lands_on_the_redirect_target() {
    // Model calls, model lists and the updater: `fetch` follows by default.
    let response = get_through_redirect(mixdog_ai::transport::deadlines::OPENAI_CATALOG)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.read_all().await.unwrap().body, b"land");
}

#[tokio::test]
async fn a_manual_site_gets_the_302_itself() {
    // The Cursor wire is raw HTTP/2 in Node: the answer is returned, never followed.
    let response = get_through_redirect(mixdog_ai::transport::deadlines::CURSOR_MODELS)
        .await
        .unwrap();
    assert_eq!(response.status, 302);
    assert!(
        response
            .headers
            .iter()
            .any(|(k, v)| k == "location" && v == "/final")
    );
}

#[tokio::test]
async fn an_error_site_fails_on_the_302_as_a_network_error() {
    // Token exchange and every credential-bearing call: `redirect: 'error'`.
    let error = get_through_redirect(mixdog_ai::transport::deadlines::TOKEN_EXCHANGE)
        .await
        .err()
        .expect("a redirect is refused");
    assert_eq!(error.transport, Some(TransportFault::Io { os_code: None }));
    // A raw `fetch` call site: a refused redirect is `TypeError: fetch failed`.
    assert_eq!(error.message, "fetch failed");
}

/// A loopback port nobody listens on.
async fn closed_port_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{addr}/v1")
}

async fn refused(exchange: mixdog_ai::transport::Exchange, url: String) -> mixdog_core_api::domain::provider::ProviderError {
    use mixdog_ai::transport::HttpSend;
    use mixdog_ai::transport::ReqwestLink;
    use mixdog_core_api::domain::provider::WireRequest;

    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap();
    link.send(
        WireRequest { transport: TransportKind::Http1, method: "GET".into(), url, headers: Vec::new(), body: Vec::new() },
        exchange,
    )
    .await
    .err()
    .expect("nothing listens there")
}

/// What Node's call classes threw for each failure kind (`golden/connect_errors.json` `transports`, recorded by
/// `connect-errors/record.mjs --only transports`), and the `Surface` each class is on the Rust side. The exchange
/// carries the recorded timer for a timeout kind (so it reads the same milliseconds) and a long one otherwise: a
/// refused loopback connect takes seconds on Windows and must not be mistaken for a timeout.
fn recorded_texts(kind: &str) -> Vec<(mixdog_ai::transport::Exchange, String, String)> {
    use mixdog_ai::transport::Exchange;
    use mixdog_ai::transport::Redirect;
    use mixdog_ai::transport::Surface;
    use mixdog_rt::Liveness;

    let golden: serde_json::Value =
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/connect-errors/golden/connect_errors.json")).unwrap();
    let transports = &golden["transports"];
    let timer = if kind == "responseTimeout" { Duration::from_millis(transports["timeoutMs"].as_u64().unwrap()) } else { Duration::from_secs(60) };
    [
        ("sdkOpenAI", Surface::Sdk),
        ("sdkAnthropic", Surface::Sdk),
        ("fetchDispatcher", Surface::Fetch),
        ("fetchSignal", Surface::FetchSignal),
        ("fetchLabeled", Surface::FetchLabeled("probe label")),
        ("fetchAborted", Surface::FetchAborted),
    ]
    .into_iter()
    .map(|(class, surface)| {
        let message = transports["kinds"][kind][class]["message"].as_str().unwrap_or_else(|| panic!("{kind}/{class} recorded")).to_owned();
        (Exchange::new(Liveness::unary(timer), Redirect::Follow, surface), class.to_owned(), message)
    })
    .collect()
}

/// What each class of `kind` got from its own send to `url()`, with its recorded text. The sends share nothing (a
/// link each), so they go out together: a refused loopback connect alone takes two seconds on Windows.
async fn each_class<U: Future<Output = String>>(
    kind: &str,
    url: impl Fn() -> U,
) -> Vec<(String, String, mixdog_core_api::domain::provider::ProviderError)> {
    let sends = recorded_texts(kind).into_iter().map(|(exchange, class, text)| {
        let url = url();
        async move { (class, text, refused(exchange, url.await).await) }
    });
    futures::future::join_all(sends).await
}

/// Every failure kind against a real socket, each class reading as Node's recorded text, while the fault stays typed.
/// Not covered here: a connect that hangs (192.0.2.1) needs a network that drops instead of rejecting; it expires in
/// `settle` exactly as the unanswered response does.
#[tokio::test]
async fn every_failure_kind_reads_as_each_classes_recorded_text() {
    use tokio::io::AsyncWriteExt;

    // refused: a typed connect fault.
    for (class, text, error) in each_class("refused", closed_port_url).await {
        assert!(matches!(error.transport, Some(TransportFault::Connect { .. })), "{class}: {error:?}");
        assert_eq!(error.message, text, "refused/{class}");
    }
    // badPort: fails before connecting, an I/O fault.
    for (class, text, error) in each_class("badPort", || std::future::ready("http://127.0.0.1:9/v1".to_owned())).await {
        assert_eq!(error.transport, Some(TransportFault::Io { os_code: None }), "{class}");
        assert_eq!(error.message, text, "badPort/{class}");
    }
    // dns: a name that never resolves.
    let no_host = || std::future::ready("https://connect-errors-no-such-host.invalid/v1".to_owned());
    for (class, text, error) in each_class("dns", no_host).await {
        assert_eq!(error.message, text, "dns/{class}");
    }
    // tls: a plain-HTTP peer answering the handshake.
    let tls = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tls_url = format!("https://{}/v1", tls.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = tls.accept().await else { return };
            tokio::spawn(async move {
                let mut hello = [0u8; 512];
                let _ = socket.read(&mut hello).await;
                let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n").await;
            });
        }
    });
    for (class, text, error) in each_class("tls", || std::future::ready(tls_url.clone())).await {
        assert_eq!(error.message, text, "tls/{class}");
    }
    // reset: the peer resets the connection before any header.
    let resetting = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let reset_url = format!("http://{}/v1", resetting.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = resetting.accept().await else { return };
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.set_linger(Some(Duration::ZERO)).unwrap();
            drop(socket);
        }
    });
    for (class, text, error) in each_class("reset", || std::future::ready(reset_url.clone())).await {
        assert_eq!(error.message, text, "reset/{class}");
    }
    // responseTimeout: the peer accepts and never answers; the exchange's own timer expires.
    let quiet = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quiet_url = format!("http://{}/v1", quiet.local_addr().unwrap());
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = quiet.accept().await {
            held.push(socket);
        }
    });
    for (class, text, error) in each_class("responseTimeout", || std::future::ready(quiet_url.clone())).await {
        assert_eq!(error.message, text, "responseTimeout/{class}");
    }
}
