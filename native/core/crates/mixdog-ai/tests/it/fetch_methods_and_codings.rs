//! The HTTP client's rules for the request method it writes and for the `content-encoding` it undoes, against raw
//! sockets: which methods go out and how they are spelled, which are refused before any socket, and how each
//! compression coding (alone, stacked, cut short, corrupt) comes out of the body.

use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::deadlines;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;

const WITHIN: Duration = Duration::from_secs(20);

fn request(method: &str, addr: SocketAddr) -> WireRequest {
    WireRequest { transport: TransportKind::Http1, method: method.into(), url: format!("http://{addr}/x"), headers: Vec::new(), body: Vec::new() }
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 1024];
    while !data.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
        }
    }
    Some(String::from_utf8_lossy(&data).into_owned())
}

/// A server that answers every connection with `reply`, whole, then closes; it reports each request line's method and
/// the count of connections accepted.
async fn serve(reply: Vec<u8>) -> (SocketAddr, Arc<AtomicUsize>, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let count = accepted.clone();
    let (heads, seen) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            count.fetch_add(1, Ordering::SeqCst);
            let (reply, heads) = (reply.clone(), heads.clone());
            tokio::spawn(async move {
                if let Some(head) = read_head(&mut stream).await {
                    let _ = heads.send(head.split(' ').next().unwrap_or("").to_owned());
                }
                let _ = stream.write_all(&reply).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (addr, accepted, seen)
}

fn link() -> ReqwestLink {
    ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap()
}

async fn fetch(link: &ReqwestLink, req: WireRequest) -> Result<Vec<u8>, ProviderError> {
    let response = mixdog_rt::time::timeout(WITHIN, link.send(req, deadlines::OPENAI_CATALOG)).await.expect("an answer within WITHIN")?;
    Ok(mixdog_rt::time::timeout(WITHIN, response.read_all()).await.expect("a body within WITHIN")?.body)
}

const EMPTY_OK: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

async fn written_method(method: &str) -> String {
    let (addr, _, mut seen) = serve(EMPTY_OK.to_vec()).await;
    fetch(&link(), request(method, addr)).await.unwrap();
    mixdog_rt::time::timeout(WITHIN, seen.recv()).await.expect("the request line within WITHIN").unwrap()
}

#[tokio::test]
async fn the_six_standard_methods_are_written_in_upper_case_however_they_were_given() {
    for (given, written) in [("get", "GET"), ("Post", "POST"), ("put", "PUT"), ("delete", "DELETE"), ("Head", "HEAD"), ("options", "OPTIONS"), ("GET", "GET")] {
        assert_eq!(written_method(given).await, written, "{given}");
    }
}

#[tokio::test]
async fn any_other_method_is_written_as_given() {
    for method in ["patch", "PATCH", "Query", "PROPFIND"] {
        assert_eq!(written_method(method).await, method);
    }
}

#[tokio::test]
async fn connect_trace_and_track_in_any_case_are_refused_with_their_text_before_any_socket() {
    let (addr, accepted, _seen) = serve(EMPTY_OK.to_vec()).await;
    let link = link();
    for method in ["CONNECT", "trace", "Track"] {
        let error = fetch(&link, request(method, addr)).await.expect_err("refused");
        assert_eq!(error.message, format!("'{method}' HTTP method is unsupported."));
    }
    let bad = fetch(&link, request("BAD METHOD", addr)).await.expect_err("not a token");
    assert_eq!(bad.message, "'BAD METHOD' is not a valid HTTP method.");
    let wide = fetch(&link, request("G\u{0100}T", addr)).await.expect_err("past a byte");
    assert_eq!(wide.message, "Cannot convert argument to a ByteString because the character at index 1 has a value of 256 which is greater than 255.");
    assert_eq!(accepted.load(Ordering::SeqCst), 0, "no refused method reached a socket");
}

fn plain() -> Vec<u8> {
    (0..6000u32).flat_map(|n| format!("line {n} of the body, {}\n", n.wrapping_mul(2_654_435_761) % 997).into_bytes()).collect()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn zlib(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn raw_deflate(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn brotli(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    brotli::BrotliCompress(&mut &bytes[..], &mut out, &brotli::enc::BrotliEncoderParams::default()).unwrap();
    out
}

fn zstd(bytes: &[u8]) -> Vec<u8> {
    zstd::encode_all(bytes, 3).unwrap()
}

fn reply(encoding_lines: &[&str], body: &[u8]) -> Vec<u8> {
    let mut head = String::from("HTTP/1.1 200 OK\r\n");
    for line in encoding_lines {
        head.push_str(&format!("content-encoding: {line}\r\n"));
    }
    head.push_str(&format!("content-length: {}\r\nconnection: close\r\n\r\n", body.len()));
    [head.as_bytes(), body].concat()
}

async fn body_of(encoding_lines: &[&str], wire: &[u8]) -> Result<Vec<u8>, ProviderError> {
    let (addr, _, _seen) = serve(reply(encoding_lines, wire)).await;
    fetch(&link(), request("GET", addr)).await
}

#[tokio::test]
async fn each_supported_coding_comes_out_as_the_plain_body() {
    let plain = plain();
    assert!(plain.len() > 100_000);
    for (encoding, wire) in [
        ("gzip", gzip(&plain)),
        ("x-gzip", gzip(&plain)),
        ("GZIP", gzip(&plain)),
        (" gzip ", gzip(&plain)),
        ("deflate", zlib(&plain)),
        ("deflate", raw_deflate(&plain)),
        ("br", brotli(&plain)),
        ("zstd", zstd(&plain)),
    ] {
        assert_eq!(body_of(&[encoding], &wire).await.unwrap(), plain, "{encoding}");
    }
}

#[tokio::test]
async fn stacked_codings_are_undone_last_first_and_a_split_header_is_one_list() {
    let plain = plain();
    let once = gzip(&plain);
    let twice = brotli(&once);
    assert_eq!(body_of(&["gzip, br"], &twice).await.unwrap(), plain, "applied gzip then br: br comes off first");
    assert_eq!(body_of(&["gzip", "br"], &twice).await.unwrap(), plain, "two header lines read as one list");
    let swapped = body_of(&["br, gzip"], &twice).await;
    assert!(swapped.is_err() || swapped.unwrap() != plain, "the order matters");
}

#[tokio::test]
async fn a_coding_the_client_does_not_know_leaves_the_whole_body_as_it_came() {
    let wire = gzip(&plain());
    for encoding in ["identity", "compress", "", "gzip, identity", "snappy, gzip"] {
        assert_eq!(body_of(&[encoding], &wire).await.unwrap(), wire, "{encoding:?}");
    }
}

#[tokio::test]
async fn more_than_five_codings_are_a_refused_response_not_an_unreachable_provider() {
    use mixdog_ai::service::error_text::{ErrorView, PresentOptions, present_error_text};
    use mixdog_core_api::domain::provider::TransportFault;
    let error = body_of(&["gzip, gzip, gzip, gzip, gzip, gzip"], b"x").await.expect_err("too many");
    assert_eq!(error.transport, Some(TransportFault::TooManyEncodings));
    assert_eq!(error.message, "too many content-encodings in response: 6, maximum allowed is 5");
    let shown = present_error_text(&ErrorView::from(&error), &PresentOptions::default());
    assert_eq!(shown, "The provider's response could not be decoded: too many content encodings.");
    assert!(body_of(&["identity, identity, identity, identity, identity"], b"x").await.is_ok(), "five is the most allowed");
}

#[tokio::test]
async fn a_body_that_does_not_decode_is_a_refused_response_and_a_dead_connection_is_still_unreachable() {
    use mixdog_ai::service::error_text::{ErrorView, PresentOptions, present_error_text};
    use mixdog_core_api::domain::provider::{DeliveryState, TransportFault};
    let error = body_of(&["gzip"], b"this is plain text, not compressed data").await.expect_err("corrupt");
    assert_eq!(error.transport, Some(TransportFault::CorruptBody));
    let shown = |e: &mixdog_core_api::domain::provider::ProviderError| present_error_text(&ErrorView::from(e), &PresentOptions::default());
    assert_eq!(shown(&error), "The provider's response could not be decoded: the compressed body is corrupt.");
    let refused = mixdog_core_api::domain::provider::ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
    assert_eq!(shown(&refused), "Could not reach the provider.");
}
#[tokio::test]
async fn gzip_members_follow_one_another_until_a_zero_byte_or_the_end() {
    let (a, b) = (b"first member\n".repeat(500), b"second member\n".repeat(500));
    let joined = [gzip(&a), gzip(&b)].concat();
    assert_eq!(body_of(&["gzip"], &joined).await.unwrap(), [a.clone(), b].concat());
    let padded = [gzip(&a), vec![0, 0, 0, 0], gzip(b"ignored")].concat();
    assert_eq!(body_of(&["gzip"], &padded).await.unwrap(), a, "a zero byte after a member ends the stream; the rest is dropped");
}

#[tokio::test]
async fn a_gzip_or_brotli_body_cut_short_yields_what_it_decoded_and_a_cut_zstd_frame_is_an_error() {
    let plain = plain();
    for (encoding, wire) in [("gzip", gzip(&plain)), ("br", brotli(&plain))] {
        let cut = &wire[..wire.len() / 2];
        let got = body_of(&[encoding], cut).await.unwrap_or_else(|e| panic!("{encoding}: a cut stream is not an error: {}", e.message));
        assert!(plain.starts_with(&got), "{encoding}: what came out is a prefix of the plain body");
    }
    let frame = zstd(&plain);
    assert!(body_of(&["zstd"], &frame[..frame.len() / 2]).await.is_err());
}

#[tokio::test]
async fn a_body_that_is_not_in_its_gzip_or_zstd_coding_is_an_error() {
    assert!(body_of(&["gzip"], b"this is plain text, not compressed data").await.is_err());
    assert!(body_of(&["zstd"], b"this is plain text, not compressed data").await.is_err());
}
