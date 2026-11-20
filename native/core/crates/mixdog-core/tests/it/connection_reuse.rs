//! When the product's HTTP link may reuse a connection: one whose response was read to its end is free for the next request; one whose
//! response said `connection: close`, or whose body was let go unread, is not.

use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::deadlines;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;

/// How the server answers the request tagged `first`; every other request is answered `ok` and kept alive.
#[derive(Clone, Copy)]
enum Answer {
    Whole,
    Close,
    LongBody,
}

const LONG_BODY: usize = 16 * 1024 * 1024;

fn request(url: &str, tag: &str) -> WireRequest {
    WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: url.to_owned(),
        headers: vec![("x-req".to_owned(), tag.to_owned())],
        body: b"{}".to_vec(),
    }
}

/// The tag of the next request on `stream` (its `x-req` header), after reading its two-byte body; `None` at the end of the connection.
fn read_request(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).ok()? == 0 {
            return None;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head).to_lowercase();
    let tag = text.lines().find_map(|line| line.strip_prefix("x-req: ")).map(str::to_owned)?;
    stream.read_exact(&mut [0u8; 2]).ok()?;
    Some(tag)
}

/// A loopback server that reports `(tag, connection number)` per request.
fn serve(first: Answer) -> (String, mpsc::Receiver<(String, usize)>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
    let url = format!("http://{}/", listener.local_addr().expect("address"));
    let (seen, requests) = mpsc::channel();
    std::thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let Ok(mut stream) = stream else { return };
            let seen = seen.clone();
            std::thread::spawn(move || {
                while let Some(tag) = read_request(&mut stream) {
                    if seen.send((tag.clone(), n + 1)).is_err() {
                        return;
                    }
                    let answer = if tag != "first" {
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok".to_vec()
                    } else {
                        match first {
                            Answer::Whole => b"HTTP/1.1 400 Bad Request\r\ncontent-length: 2\r\n\r\nno".to_vec(),
                            Answer::Close => b"HTTP/1.1 400 Bad Request\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno".to_vec(),
                            Answer::LongBody => {
                                // Far past what the socket buffers and the client's read-ahead can take in, so the body is still
                                // on its way when the caller lets go of it, whatever the machine's buffer sizes.
                                let mut long = format!("HTTP/1.1 400 Bad Request\r\ncontent-length: {LONG_BODY}\r\n\r\n").into_bytes();
                                long.extend(std::iter::repeat_n(b'a', LONG_BODY));
                                long
                            }
                        }
                    };
                    if stream.write_all(&answer).is_err() {
                        return;
                    }
                }
            });
        }
    });
    (url, requests)
}

/// Lets the link's tasks settle the connection after a body ended or was dropped.
async fn settle() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::ZERO).await;
}

#[derive(Clone, Copy)]
enum Action {
    ReadToTheEnd,
    LetGo,
}

/// The connection numbers `first` and the request after it were served on.
async fn connections(first: Answer, action: Action) -> (usize, usize) {
    let _tokens = mixdog_rt::testing::tokens();
    let (url, requests) = serve(first);
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the link");
    let response = link.send(request(&url, "first"), deadlines::OPENAI_CATALOG).await.expect("first answered");
    assert_eq!(response.status, 400);
    match action {
        Action::ReadToTheEnd => drop(response.read_all().await.expect("the body")),
        Action::LetGo => drop(response),
    }
    settle().await;
    link.send(request(&url, "second"), deadlines::OPENAI_CATALOG).await.expect("second answered").read_all().await.expect("second's body");
    let (a, b) = (requests.recv().expect("first seen"), requests.recv().expect("second seen"));
    assert_eq!((a.0.as_str(), b.0.as_str()), ("first", "second"));
    (a.1, b.1)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_response_read_to_its_end_frees_its_connection_for_the_next_request() {
    let (first, second) = connections(Answer::Whole, Action::ReadToTheEnd).await;
    assert_eq!(first, second);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_response_that_says_connection_close_is_not_reused() {
    let (first, second) = connections(Answer::Close, Action::ReadToTheEnd).await;
    assert_ne!(first, second);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_let_go_unread_leaves_its_connection_unusable_for_the_next_request() {
    let (first, second) = connections(Answer::LongBody, Action::LetGo).await;
    assert_ne!(first, second);
}
