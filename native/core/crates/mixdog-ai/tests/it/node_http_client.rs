//! The Node-equal HTTP client against raw sockets: what it refuses to write, when it replays, how it bounds and frames
//! a response, which route a pooled connection obeys, and which protocol it ends on. Each test names the review finding
//! it holds (A1-A8). Every wait is bounded by [`WITHIN`].

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mixdog_ai::netproxy::{EnvLookup, NetworkProxy, SystemProxy};
use mixdog_ai::transport::{HttpResponse, HttpSend, ReqwestLink, deadlines};
use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
use mixdog_core_api::domain::provider::{ProviderError, WireRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The deadline of every wait in this file.
const WITHIN: Duration = Duration::from_secs(20);

fn request(method: &str, url: String, headers: &[(&str, &str)], body: &[u8]) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: method.into(),
        url,
        headers: headers.iter().map(|(n, v)| ((*n).to_owned(), (*v).to_owned())).collect(),
        body: body.to_vec(),
    }
}

async fn send(link: &ReqwestLink, req: WireRequest) -> Result<HttpResponse, ProviderError> {
    tokio::time::timeout(WITHIN, link.send(req, deadlines::OPENAI_CATALOG)).await.expect("a response or an error within WITHIN")
}

async fn body(response: HttpResponse) -> Result<Vec<u8>, ProviderError> {
    Ok(tokio::time::timeout(WITHIN, response.read_all()).await.expect("a body or an error within WITHIN")?.body)
}

fn link() -> ReqwestLink {
    ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap()
}

/// One whole request off the socket: the head, and a `content-length` body.
async fn read_request(stream: &mut TcpStream) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
    let length: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")?.trim().parse().ok()).unwrap_or(0);
    while data.len() < end + length {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
        }
    }
    Some(data)
}

/// A listener whose connections are each handled by `handler(connection number, stream)`; the count of connections
/// accepted so far is returned alongside the address.
async fn listen<F, Fut>(handler: F) -> (SocketAddr, Arc<AtomicUsize>)
where
    F: Fn(usize, TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let count = accepted.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let n = count.fetch_add(1, Ordering::SeqCst) + 1;
            tokio::spawn(handler(n, stream));
        }
    });
    (addr, accepted)
}

const OK: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";

// A1: names and values that would split or smuggle a request never reach the socket, and the headers undici owns are
// refused (`core/request.js` `processHeader`).
#[tokio::test]
async fn a1_unsafe_headers_are_refused_before_the_socket() {
    let heads = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = heads.clone();
    let (addr, _) = listen(move |_, mut stream| {
        let seen = seen.clone();
        async move {
            while let Some(head) = read_request(&mut stream).await {
                seen.lock().unwrap().push(String::from_utf8_lossy(&head).into_owned());
                stream.write_all(OK).await.unwrap();
            }
        }
    })
    .await;
    let url = format!("http://{addr}/");
    let link = link();
    for (name, value) in [
        ("x-a", "1\r\nevil: yes"),
        ("x-a", "1\nevil: yes"),
        ("x-a", "1\0"),
        ("x-a\r\nevil", "yes"),
        ("x:a", "1"),
        ("transfer-encoding", "chunked"),
        ("expect", "100-continue"),
        ("content-length", "5, 5"),
    ] {
        let refused = link.send(request("POST", url.clone(), &[(name, value)], b"{}"), deadlines::OPENAI_CATALOG).await;
        assert!(refused.is_err(), "{name:?}: {value:?} must be refused");
    }
    body(send(&link, request("POST", url, &[("x-a", "fine")], b"{}")).await.unwrap()).await.unwrap();
    let heads = heads.lock().unwrap();
    assert_eq!(heads.len(), 1, "only the valid request reached the server: {heads:?}");
    assert!(!heads[0].contains("evil"));
}

// A2: a request written whole on a reused connection is never written again when the answer is lost.
#[tokio::test]
async fn a2_a_written_post_is_not_replayed_when_the_connection_dies_unanswered() {
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    let (addr, accepted) = listen(move |_, mut stream| {
        let counted = counted.clone();
        async move {
            let mut first = true;
            while read_request(&mut stream).await.is_some() {
                counted.fetch_add(1, Ordering::SeqCst);
                if !std::mem::take(&mut first) {
                    return; // read it whole, executed it, closes without an answer
                }
                stream.write_all(OK).await.unwrap();
            }
        }
    })
    .await;
    let url = format!("http://{addr}/");
    let link = link();
    body(send(&link, request("POST", url.clone(), &[], b"{}")).await.unwrap()).await.unwrap();
    let lost = send(&link, request("POST", url, &[], b"{}")).await;
    assert!(lost.is_err(), "the lost answer is an error");
    assert_eq!(requests.load(Ordering::SeqCst), 2, "the server saw each POST once");
    assert_eq!(accepted.load(Ordering::SeqCst), 1, "and no connection was opened to send it again");
}

// A3: an unterminated header, chunk-size line or trailer is cut off at a bound, not read until the peer stops.
async fn endless(prefix: &'static [u8], filler: u8) -> (SocketAddr, tokio::task::JoinHandle<usize>) {
    endless_blocks(prefix, vec![filler; 8192]).await
}

async fn endless_blocks(prefix: &'static [u8], block: Vec<u8>) -> (SocketAddr, tokio::task::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let written = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await.unwrap();
        stream.write_all(prefix).await.unwrap();
        let mut total = 0;
        while stream.write_all(&block).await.is_ok() {
            total += block.len();
        }
        total
    });
    (addr, written)
}

const BOUND: usize = 4 << 20;

#[tokio::test]
async fn a3_an_unterminated_header_is_bounded() {
    let (addr, written) = endless(b"HTTP/1.1 200 OK\r\nx-long: ", b'a').await;
    let outcome = send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await;
    assert!(outcome.is_err());
    let total = tokio::time::timeout(WITHIN, written).await.unwrap().unwrap();
    assert!(total < BOUND, "the client stopped reading after {total} bytes");
}

#[tokio::test]
async fn a3_an_unterminated_chunk_size_line_is_bounded() {
    let (addr, written) = endless(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n", b'f').await;
    let outcome = match send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await {
        Ok(response) => body(response).await.map(|_| ()),
        Err(e) => Err(e),
    };
    assert!(outcome.is_err());
    let total = tokio::time::timeout(WITHIN, written).await.unwrap().unwrap();
    assert!(total < BOUND, "the client stopped reading after {total} bytes");
}

#[tokio::test]
async fn a3_an_unterminated_trailer_is_bounded() {
    let (addr, written) = endless(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\nx-trailer: ", b'a').await;
    let outcome = match send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await {
        Ok(response) => body(response).await.map(|_| ()),
        Err(e) => Err(e),
    };
    assert!(outcome.is_err());
    let total = tokio::time::timeout(WITHIN, written).await.unwrap().unwrap();
    assert!(total < BOUND, "the client stopped reading after {total} bytes");
}

// A6: response framing that Node's parser (llhttp) refuses is refused here, not read as a success.
async fn answered_with(reply: &'static [u8]) -> Result<Vec<u8>, ProviderError> {
    let (addr, _) = listen(move |_, mut stream| async move {
        read_request(&mut stream).await;
        stream.write_all(reply).await.ok();
        stream.shutdown().await.ok();
    })
    .await;
    body(send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await?).await
}

#[tokio::test]
async fn a6_conflicting_content_lengths_are_refused() {
    assert!(answered_with(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\ncontent-length: 7\r\n\r\nhello").await.is_err());
}

#[tokio::test]
async fn a6_an_invalid_content_length_is_refused() {
    assert!(answered_with(b"HTTP/1.1 200 OK\r\ncontent-length: abc\r\n\r\nhello").await.is_err());
}

#[tokio::test]
async fn a6_a_chunk_not_followed_by_crlf_is_refused() {
    assert!(answered_with(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n").await.is_err());
}

#[tokio::test]
async fn a6_a_chunked_coding_is_found_by_token_not_by_substring() {
    // `notchunked` is no transfer coding: llhttp reads this body by `content-length`.
    let got = answered_with(b"HTTP/1.1 200 OK\r\ntransfer-encoding: notchunked\r\ncontent-length: 5\r\n\r\nhello").await;
    assert!(got.is_err() || got.unwrap() != b"", "never an empty success");
}

#[tokio::test]
async fn a6_a_body_cut_short_of_its_content_length_is_an_error() {
    assert!(answered_with(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nhello").await.is_err());
}

#[tokio::test]
async fn a6_a_chunked_body_with_content_length_does_not_keep_the_connection() {
    let (addr, accepted) = listen(move |_, mut stream| async move {
        while read_request(&mut stream).await.is_some() {
            stream.write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ncontent-length: 2\r\n\r\n2\r\nok\r\n0\r\n\r\n").await.ok();
        }
    })
    .await;
    let url = format!("http://{addr}/");
    let link = link();
    for _ in 0..2 {
        let _ = match send(&link, request("GET", url.clone(), &[], b"")).await {
            Ok(response) => body(response).await.map(|_| ()),
            Err(e) => Err(e),
        };
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 2, "the second request is on a new connection");
}

// A7: a gzip body that stops before its trailer is an error at the end of the body.
#[tokio::test]
async fn a7_a_truncated_gzip_body_is_an_error() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&b"a body that is cut short ".repeat(100)).unwrap();
    let whole = encoder.finish().unwrap();
    let cut = whole[..whole.len() - 6].to_vec();
    let (addr, _) = listen(move |_, mut stream| {
        let cut = cut.clone();
        async move {
            read_request(&mut stream).await;
            let head = format!("HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\n\r\n", cut.len());
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(&cut).await.unwrap();
        }
    })
    .await;
    let got = body(send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await.unwrap()).await;
    assert!(got.is_err(), "a truncated stream is not a short success");
}

// A4: a pooled connection opened under one route is not used after the route changed.
struct NoEnv;
impl EnvLookup for NoEnv {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
}

#[tokio::test]
async fn a4_a_route_change_retires_the_pooled_connection() {
    let (server, accepted) = listen(move |_, mut stream| async move {
        while read_request(&mut stream).await.is_some() {
            stream.write_all(OK).await.unwrap();
        }
    })
    .await;
    let (proxy, through_proxy) = listen(move |_, mut stream| async move {
        let mut first = [0u8; 7];
        stream.read_exact(&mut first).await.ok();
        assert_eq!(&first, b"CONNECT", "the proxy is asked to tunnel");
    })
    .await;
    let policy = NetworkProxy::new(Arc::new(NoEnv), SystemProxy::default());
    policy.adopt(&serde_json::json!({ "mode": "off" }));
    let link = ReqwestLink::routed(&KeepaliveSchedule::SPEC, false, policy.clone());
    let url = format!("http://{server}/");
    body(send(&link, request("GET", url.clone(), &[], b"")).await.unwrap()).await.unwrap();
    body(send(&link, request("GET", url.clone(), &[], b"")).await.unwrap()).await.unwrap();
    assert_eq!(accepted.load(Ordering::SeqCst), 1, "the idle connection is reused while the route stands");
    // The loopback host is exempt from a proxy, so the setting changes and the route does not: the connection still
    // retires with the setting.
    policy.adopt(&serde_json::json!({ "mode": "manual", "url": format!("http://{proxy}") }));
    body(send(&link, request("GET", url, &[], b"")).await.unwrap()).await.unwrap();
    assert_eq!(accepted.load(Ordering::SeqCst), 2, "a new connection after the setting changed");
    // A host the proxy applies to goes to the proxy, with no pooled socket consulted first.
    let _ = tokio::time::timeout(WITHIN, link.send(request("GET", "http://203.0.113.7/".into(), &[], b""), deadlines::OPENAI_CATALOG)).await;
    assert_eq!(through_proxy.load(Ordering::SeqCst), 1, "it went to the proxy");
}
// A5 and the protocol: with ALPN `http/1.1`, `h2` offered, a server that picks h2 gets h2 (undici 8.12.3 `allowH2`
// defaults to true, `connect.js:76,98`), and a dead h2 connection is not offered again.
#[tokio::test]
async fn a5_a_dead_h2_connection_is_not_used_again_and_h2_is_what_a_server_that_offers_it_gets() {
    use tokio_rustls::TlsAcceptor;
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let cert = issued.cert.der().clone();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server_config = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.clone()], key)
        .unwrap();
    server_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert).unwrap();
    let client_config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let acceptor = TlsAcceptor::from(Arc::new(server_config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let count = accepted.clone();
    let (kill, killed) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let n = count.fetch_add(1, Ordering::SeqCst) + 1;
            let acceptor = acceptor.clone();
            let mut killed = killed.clone();
            tokio::spawn(async move {
                let tls = acceptor.accept(tcp).await.unwrap();
                assert_eq!(tls.get_ref().1.alpn_protocol(), Some(&b"h2"[..]), "the client offers h2 and the server picks it");
                let mut conn = h2::server::handshake(tls).await.unwrap();
                loop {
                    tokio::select! {
                        next = conn.accept() => {
                            let Some(Ok((_, mut respond))) = next else { return };
                            let mut stream = respond.send_response(hyper::http::Response::new(()), false).unwrap();
                            stream.send_data(bytes::Bytes::from_static(b"ok"), true).unwrap();
                        }
                        // The first connection is killed once the test says so; later ones live.
                        _ = killed.wait_for(|dead| *dead), if n == 1 => return,
                    }
                }
            });
        }
    });
    let link = ReqwestLink::pinned(&KeepaliveSchedule::SPEC, addr, Arc::new(client_config));
    let url = format!("https://localhost:{}/", addr.port());
    assert_eq!(body(send(&link, request("GET", url.clone(), &[], b"")).await.unwrap()).await.unwrap(), b"ok");
    kill.send(true).unwrap();
    // Whether this one meets the dead connection before the client has noticed its end is a race; if it does it fails,
    // and the failed handle must be gone for the next.
    let _ = match link.send(request("GET", url.clone(), &[], b""), deadlines::OPENAI_CATALOG).await {
        Ok(response) => body(response).await.map(|_| ()),
        Err(e) => Err(e),
    };
    assert_eq!(body(send(&link, request("GET", url, &[], b"")).await.unwrap()).await.unwrap(), b"ok", "on a new connection");
    assert_eq!(accepted.load(Ordering::SeqCst), 2);
}

// "A drained error response is held": Node's resend of a rejected request (`resendIfEncodingRejected`) runs before the
// rejected response's socket is free again (undici `pool-base.js:92,135,264`: a client counts as busy until its
// `drain`), so the resend dials a second connection; once the rejected response is dropped the socket serves requests.
// The same case is in the OpenAI recording (the two-connection scenarios).
#[tokio::test]
async fn a_drained_body_that_is_held_keeps_its_connection_out_of_the_pool_until_dropped() {
    let (addr, accepted) = listen(move |_, mut stream| async move {
        while read_request(&mut stream).await.is_some() {
            stream.write_all(b"HTTP/1.1 400 Bad Request\r\ncontent-length: 2\r\n\r\nno").await.unwrap();
        }
    })
    .await;
    let url = format!("http://{addr}/");
    let link = link();
    let mut rejected = send(&link, request("POST", url.clone(), &[], b"{}")).await.unwrap().body;
    rejected.hold_connection();
    while tokio::time::timeout(WITHIN, rejected.next()).await.unwrap().is_some() {}
    let resent = send(&link, request("POST", url.clone(), &[], b"{}")).await.unwrap();
    assert_eq!(accepted.load(Ordering::SeqCst), 2, "the resend dialled while the rejected response was held");
    drop(body(resent).await);
    drop(rejected);
    body(send(&link, request("POST", url, &[], b"{}")).await.unwrap()).await.unwrap();
    assert_eq!(accepted.load(Ordering::SeqCst), 2, "afterwards an idle connection serves the request");
}

// H5: a long chunk extension, and a trailer made of many short lines, are cut off too (the repeated `f` above fails by
// overflowing the chunk size, not by a bound on the line).
async fn bounded_after(prefix: &'static [u8], block: Vec<u8>) {
    let (addr, written) = endless_blocks(prefix, block).await;
    let outcome = match send(&link(), request("GET", format!("http://{addr}/"), &[], b"")).await {
        Ok(response) => body(response).await.map(|_| ()),
        Err(e) => Err(e),
    };
    assert!(outcome.is_err());
    let total = tokio::time::timeout(WITHIN, written).await.unwrap().unwrap();
    assert!(total < BOUND, "the client stopped reading after {total} bytes");
}

#[tokio::test]
async fn h5_a_long_chunk_extension_is_bounded() {
    bounded_after(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5;", vec![b'a'; 8192]).await;
}

#[tokio::test]
async fn h5_many_trailer_lines_are_bounded() {
    bounded_after(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\n", b"x-t: a\r\n".repeat(1024)).await;
}

// H4: the answer to a request hyper did not write is framed by the method it is told: a HEAD answer carries
// `content-length` and no body; and a CONNECT (framed otherwise) or TRACE is refused before the socket.
#[tokio::test]
async fn h4_a_head_answer_with_a_content_length_has_no_body() {
    let (addr, _) = listen(move |_, mut stream| async move {
        read_request(&mut stream).await;
        stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n").await.unwrap();
        std::future::pending::<()>().await;
    })
    .await;
    let response = send(&link(), request("HEAD", format!("http://{addr}/"), &[], b"")).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(body(response).await.unwrap().is_empty());
}

#[tokio::test]
async fn h4_connect_and_trace_never_reach_the_socket() {
    let (addr, accepted) = listen(move |_, mut stream| async move {
        read_request(&mut stream).await;
    })
    .await;
    for method in ["CONNECT", "TRACE", "TRACK"] {
        let outcome = link().send(request(method, format!("http://{addr}/"), &[], b""), deadlines::OPENAI_CATALOG).await;
        assert!(outcome.is_err(), "{method}");
    }
    assert_eq!(accepted.load(Ordering::SeqCst), 0);
}

// H5: a write that fails once bytes may have left is the request's error, not a reason to send it again (undici fails
// the request that was running and re-queues only those not yet written).
#[tokio::test]
async fn h5_a_write_error_on_a_reused_connection_is_not_replayed() {
    let (addr, accepted) = listen(move |n, mut stream| async move {
        if n == 1 {
            read_request(&mut stream).await;
            stream.write_all(OK).await.unwrap();
            // The second request: read its head, then reset the connection while its body is still arriving.
            let mut byte = [0u8; 1];
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            #[allow(deprecated, reason = "a zero linger is the reset the test needs")]
            stream.set_linger(Some(Duration::ZERO)).unwrap();
            drop(stream);
        } else {
            while read_request(&mut stream).await.is_some() {
                stream.write_all(OK).await.unwrap();
            }
        }
    })
    .await;
    let url = format!("http://{addr}/");
    let link = link();
    body(send(&link, request("POST", url.clone(), &[], b"{}")).await.unwrap()).await.unwrap();
    let big = vec![b'x'; 128 << 20];
    let outcome = link.send(request("POST", url, &[], &big), deadlines::OPENAI_CATALOG).await;
    assert!(outcome.is_err(), "the reset is the request's error");
    assert_eq!(accepted.load(Ordering::SeqCst), 1, "and no second connection carried the request again");
}

// H2: a connection checked out when the route changes is closed when its response ends.
#[tokio::test]
async fn h2_a_connection_in_flight_across_a_route_change_is_closed_when_its_response_ends() {
    let (release, released) = tokio::sync::watch::channel(false);
    let (closed_tx, mut closed) = tokio::sync::mpsc::unbounded_channel::<()>();
    let (server, accepted) = listen(move |_, mut stream| {
        let (mut released, closed_tx) = (released.clone(), closed_tx.clone());
        async move {
            read_request(&mut stream).await;
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n").await.unwrap();
            released.wait_for(|go| *go).await.unwrap();
            stream.write_all(b"ok").await.unwrap();
            let mut byte = [0u8; 1];
            // The client's close shows as end of stream; a connection kept in its pool never shows it.
            if stream.read(&mut byte).await.map_or(true, |n| n == 0) {
                closed_tx.send(()).unwrap();
            }
        }
    })
    .await;
    let policy = NetworkProxy::new(Arc::new(NoEnv), SystemProxy::default());
    policy.adopt(&serde_json::json!({ "mode": "off" }));
    let link = ReqwestLink::routed(&KeepaliveSchedule::SPEC, false, policy.clone());
    let response = send(&link, request("GET", format!("http://{server}/"), &[], b"")).await.unwrap();
    policy.adopt(&serde_json::json!({ "mode": "manual", "url": "http://127.0.0.1:9" }));
    release.send(true).unwrap();
    assert_eq!(body(response).await.unwrap(), b"ok");
    tokio::time::timeout(WITHIN, closed.recv()).await.expect("the old route's connection was closed").unwrap();
    assert_eq!(accepted.load(Ordering::SeqCst), 1);
}