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
    let ping = PingKeepalive { interval: Duration::from_millis(150), timeout: Duration::from_millis(100), while_idle: true };
    KeepaliveSchedule { tcp: TcpKeepalive { idle: Duration::from_secs(60), interval: Duration::from_secs(60), count: 5 }, h2: ping, ws: ping, ws_max_age: None }
}

#[test]
fn spec_schedule_is_the_documented_one() {
    let s = KeepaliveSchedule::SPEC;
    assert_eq!((s.tcp.idle, s.tcp.interval, s.tcp.count), (Duration::from_secs(60), Duration::from_secs(60), 5));
    for ping in [s.h2, s.ws] {
        assert_eq!((ping.interval, ping.timeout, ping.while_idle), (Duration::from_secs(30), Duration::from_secs(10), true));
    }
    mixdog_core_api::domain::conformance::check_keepalive_schedule(&s);
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
        stream.write_all(b"HTTP/1.1 429 Too Many Requests\r\nretry-after: 3\r\ncontent-length: 2\r\n\r\nhi").await.unwrap();
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
        WireRequest { transport: TransportKind::Http1, method: "GET".into(), url: format!("http://{addr}/start"), headers: Vec::new(), body: Vec::new() },
        exchange,
    )
    .await
}

#[tokio::test]
async fn a_follow_site_lands_on_the_redirect_target() {
    // Model calls, model lists and the updater: `fetch` follows by default.
    let response = get_through_redirect(mixdog_ai::transport::deadlines::OPENAI_CATALOG).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.read_all().await.unwrap().body, b"land");
}

#[tokio::test]
async fn a_manual_site_gets_the_302_itself() {
    // The Cursor wire is raw HTTP/2 in Node: the answer is returned, never followed.
    let response = get_through_redirect(mixdog_ai::transport::deadlines::CURSOR_MODELS).await.unwrap();
    assert_eq!(response.status, 302);
    assert!(response.headers.iter().any(|(k, v)| k == "location" && v == "/final"));
}

#[tokio::test]
async fn an_error_site_fails_on_the_302_as_a_network_error() {
    // Token exchange and every credential-bearing call: `redirect: 'error'`.
    let error = get_through_redirect(mixdog_ai::transport::deadlines::TOKEN_EXCHANGE).await.err().expect("a redirect is refused");
    assert_eq!(error.transport, Some(TransportFault::Io { os_code: None }));
    // A raw `fetch` call site: a refused redirect is `TypeError: fetch failed`.
    assert_eq!(error.message, "fetch failed");
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
#[tokio::test]
async fn silent_websocket_peer_ends_as_keepalive_expired_within_the_schedule() {
    mixdog_rt::testing::tokens();
    let (addr, server) = silent_ws_server().await;
    let schedule = fast();
    let (mut conn, _) = ws::connect(format!("ws://{addr}/"), &schedule).await.unwrap();
    let link = conn.link();
    assert_eq!(link.liveness(), LinkLiveness::Alive);
    let started = Instant::now();
    let fault = conn.recv().await.expect("a fault is delivered").unwrap_err();
    let bound = schedule.ws.interval + schedule.ws.timeout;
    assert_eq!(fault, TransportFault::KeepaliveExpired { transport: TransportKind::WebSocket });
    assert!(started.elapsed() >= bound, "not before the probe timeout");
    assert!(started.elapsed() < bound * 3, "within the schedule, took {:?}", started.elapsed());
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
    let (mut conn, _) = ws::connect(format!("ws://{addr}/"), &schedule).await.unwrap();
    assert!(conn.link().may_start_response());
    // Several probe rounds pass with no data in flight.
    mixdog_rt::time::sleep(schedule.ws.interval * 4).await;
    assert_eq!(conn.link().liveness(), LinkLiveness::Alive);
    assert!(!conn.link().may_start_response(), "a connection at the provider's age limit takes no new response");
    conn.send(ws::Message::text("hello")).await.unwrap();
    let echoed = conn.recv().await.unwrap().unwrap();
    assert_eq!(echoed.into_text().unwrap().as_str(), "hello");
    server.abort();
}
// Driven by the paused clock with explicit advances: hyper's HTTP/2 keep-alive takes its timers from tokio, so virtual time
// is moved by this test, a step at a time, once the peer has the client's preface; the instants asserted are the
// schedule's own, whatever the machine's load. The clock is paused only then: a paused clock jumps to the next timer
// whenever the runtime waits on real I/O, so the connect and the preface run in real time.
#[tokio::test]
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
    let client = http::client_builder(&schedule).http2_prior_knowledge().build().unwrap();
    let url = format!("http://{addr}/");
    let request = tokio::spawn(async move { client.get(url).send().await });
    mixdog_rt::time::timeout(Duration::from_secs(10), preface).await.expect("the peer receives the preface within 10 s").unwrap();
    tokio::time::pause();
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
