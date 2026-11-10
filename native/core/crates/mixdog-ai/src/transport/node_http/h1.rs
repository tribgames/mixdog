//! HTTP/1.1 over `hyper`'s connection-level client, used for what no library gives and what every library does well.
//!
//! The request is written by hand (`super::head`): hyper lowercases every header name, and Node writes the
//! provider's names in their own letter case (`OpenAI-Beta`, `session_id`), which no hyper API can set. Everything
//! after the request is hyper's: the response head is parsed with a bounded size and a bounded header count, the framing
//! (`content-length`, chunked, until close) is strict, and whether the connection can serve another request is
//! hyper's own rule. The two meet in [`ReadOnly`]: hyper believes it sent the request and reads the response from the
//! socket, while the bytes it "writes" are dropped.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Empty;
use hyper::body::Body;
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use mixdog_core_api::domain::provider::TransportFault;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::ReadBuf;
use tokio::io::ReadHalf;
use tokio::io::WriteHalf;

use super::Stream;
use super::decode::Decoder;
use super::pool::Pool;
use crate::transport::fault::fault_from_chain;
use crate::transport::fault::fault_from_io;
use crate::transport::link::BodyStream;

/// `maxHeaderSize`: Node's default for the head of a response (`--max-http-header-size`, 16 KiB).
const MAX_HEAD: usize = 16 * 1024;
/// How many header lines hyper reserves room for; more is "message header too large".
const MAX_HEADERS: usize = 128;
/// `bodyTimeout` of the agent (`http-agent.mjs` `llmAgentOptions`): the longest a body may be silent.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(600);

/// The read half of the connection, handed to hyper in place of the whole: what hyper writes goes nowhere.
struct ReadOnly(ReadHalf<Stream>);

impl AsyncRead for ReadOnly {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for ReadOnly {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// One HTTP/1.1 connection: hyper reads it, the request bytes go out through `write`.
pub struct Conn {
    send: http1::SendRequest<Empty<Bytes>>,
    write: WriteHalf<Stream>,
    pub born: u64,
    /// The pool's route generation when the connection opened ([super::pool::Pool::generation]).
    pub generation: u64,
}

impl Conn {
    pub async fn open(io: Stream, born: u64, generation: u64) -> Result<Self, hyper::Error> {
        let (read, write) = tokio::io::split(io);
        let (send, connection) = http1::Builder::new()
            .max_buf_size(MAX_HEAD)
            .max_headers(MAX_HEADERS)
            .handshake::<_, Empty<Bytes>>(TokioIo::new(ReadOnly(read)))
            .await?;
        tokio::spawn(async move {
            // An error here reaches the request in flight through hyper (its send_request future fails with it);
            // one on an idle connection has no request to reach and is logged, as the reqwest client's driver was.
            if let Err(error) = connection.await {
                tracing::debug!(%error, "http/1.1 connection ended with an error");
            }
        });
        Ok(Self { send, write, born, generation })
    }

    /// The connection has ended (the peer closed it, or hyper found it unusable).
    pub fn is_closed(&self) -> bool {
        self.send.is_closed()
    }

    /// Waits until hyper can take a request: `Err` is a connection that is gone.
    pub async fn ready(&mut self) -> Result<(), hyper::Error> {
        self.send.ready().await
    }

    /// Writes the request and reads the answer, both at once: a server that answers before it has read the whole body
    /// (a 401, a 413) is heard, as it is by undici, which parses the response while it is still writing.
    ///
    /// hyper is told what it needs to frame the answer to a request it did not write: the method (a `HEAD` has no
    /// body) and `connection: close`. It is never told `Expect` (refused before the socket, `check_headers`) or a
    /// `CONNECT` (refused in `NodeClient::send`), the two requests whose answers hyper frames differently.
    pub async fn exchange(&mut self, head: &[u8], body: &[u8], method: &str, close: bool) -> Exchange {
        let Self { send, write, .. } = self;
        let mut request = hyper::Request::builder().method(method).uri("/");
        if close {
            request = request.header("connection", "close");
        }
        let request = request.body(Empty::<Bytes>::new()).expect("a request hyper reads no more of than its method");
        let response = send.send_request(request);
        tokio::pin!(response);
        let written = async {
            write.write_all(head).await?;
            write.write_all(body).await?;
            write.flush().await
        };
        tokio::pin!(written);
        let answer = |result: Result<hyper::Response<Incoming>, hyper::Error>, written: bool| match result {
            Ok(response) => Exchange::Answered { response, written },
            Err(error) => Exchange::Unanswered(error),
        };
        tokio::select! {
            biased;
            outcome = &mut written => match outcome {
                Ok(()) => answer((&mut response).await, true),
                // An answer already in hand outranks the failed write: undici has parsed what arrived before the
                // socket's error is seen. A read error beside it does not: the write's is the request's error.
                Err(error) => match tokio::time::timeout(Duration::ZERO, &mut response).await {
                    Ok(result @ Ok(_)) => answer(result, false),
                    _ => Exchange::NotWritten(error),
                },
            },
            result = &mut response => answer(result, false),
        }
    }
}

/// What came of writing a request and reading its answer.
pub enum Exchange {
    /// The answer's head. `written` is false when it came before the whole request was out: the connection cannot
    /// serve another request.
    Answered { response: hyper::Response<Incoming>, written: bool },
    /// The write failed and nothing answered.
    NotWritten(io::Error),
    /// The request was out and the answer failed or never came whole.
    Unanswered(hyper::Error),
}
pub struct Reuse {
    pub pool: Arc<Pool>,
    pub key: String,
    pub ttl: Duration,
}

pub struct H1Body {
    pub incoming: Option<Incoming>,
    pub conn: Option<Conn>,
    pub decoder: Option<Decoder>,
    /// Where the connection goes back to once the body is whole; `None` when the exchange ends it.
    pub reuse: Option<Reuse>,
    /// Set by [`BodyStream::hold_connection`]: the whole body's connection is held ([`Pool::hold_h1`]).
    pub hold: bool,
    /// The hold of the connection, ended when this body is dropped if no request has freed it first.
    parked: Option<(Arc<Pool>, String, u64)>,
}

impl H1Body {
    pub fn new(incoming: Incoming, conn: Conn, decoder: Option<Decoder>, reuse: Option<Reuse>) -> Self {
        let mut body = Self { incoming: Some(incoming), conn: Some(conn), decoder, reuse, hold: false, parked: None };
        if body.incoming.as_ref().is_some_and(Body::is_end_stream) {
            body.release();
        }
        body
    }

    /// The exchange is whole: the connection goes back to the pool (held for the next request, if this body is held).
    fn release(&mut self) {
        if let (Some(conn), Some(reuse)) = (self.conn.take(), self.reuse.take()) {
            if self.hold {
                let hold = reuse.pool.hold_h1(reuse.key.clone(), conn, reuse.ttl);
                self.parked = Some((reuse.pool, reuse.key, hold));
            } else {
                reuse.pool.put_h1(reuse.key, conn, reuse.ttl);
            }
        }
    }

    /// The failure ends the connection.
    fn fail(&mut self, fault: TransportFault) -> Option<Result<Bytes, TransportFault>> {
        self.incoming = None;
        self.conn = None;
        self.reuse = None;
        self.decoder = None;
        Some(Err(fault))
    }
}

impl Drop for H1Body {
    fn drop(&mut self) {
        if let Some((pool, key, hold)) = self.parked.take() {
            pool.end_hold(&key, hold);
        }
    }
}

#[async_trait]
impl BodyStream for H1Body {
    fn hold_connection(&mut self) {
        self.hold = true;
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        loop {
            // What the decoder can hand on from what it holds comes first, one step at a time; the socket is read
            // again only when it has nothing left.
            if let Some(decoder) = self.decoder.as_mut() {
                match decoder.step() {
                    Err(e) => return self.fail(fault_from_io(&e, false)),
                    Ok(Some(step)) => return Some(Ok(Bytes::from(step))),
                    Ok(None) if self.incoming.is_none() => {
                        self.decoder = None;
                        self.release();
                        return None;
                    }
                    Ok(None) => {}
                }
            }
            let incoming = self.incoming.as_mut()?;
            let frame = match tokio::time::timeout(BODY_TIMEOUT, incoming.frame()).await {
                Err(_) => return self.fail(TransportFault::Io { os_code: None }),
                Ok(frame) => frame,
            };
            match frame {
                None => {
                    self.incoming = None;
                    match self.decoder.as_mut() {
                        // The body is over: the steps left, and how the stream finishes, are taken at the top of the loop.
                        Some(decoder) => decoder.end(),
                        None => {
                            self.release();
                            return None;
                        }
                    }
                }
                Some(Err(e)) => return self.fail(fault_from_chain(&e, false)),
                Some(Ok(frame)) => {
                    let Ok(raw) = frame.into_data() else { continue };
                    match self.decoder.as_mut() {
                        Some(decoder) => decoder.feed(&raw),
                        None => {
                            if self.incoming.as_ref().is_some_and(Body::is_end_stream) {
                                self.incoming = None;
                                self.release();
                            }
                            if !raw.is_empty() {
                                return Some(Ok(raw));
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::AsyncReadExt;

    use super::*;

    // H4: a server that answers while the body is still being written is heard, and the half-written connection is
    // reported as such (`written: false`), which keeps it out of the pool. The pipe holds 64 bytes, so the write of the
    // 1 MiB body cannot finish before the answer.
    #[tokio::test]
    async fn an_answer_before_the_whole_body_is_written_is_the_answer_and_not_a_complete_exchange() {
        let (near, mut far) = tokio::io::duplex(64);
        let mut conn = Conn::open(Box::new(near), 0, 0).await.unwrap();
        let server = tokio::spawn(async move {
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                far.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            far.write_all(b"HTTP/1.1 413 Payload Too Large\r\ncontent-length: 0\r\n\r\n").await.unwrap();
            far // kept open, unread
        });
        let body = vec![b'x'; 1 << 20];
        let outcome = tokio::time::timeout(Duration::from_secs(20), conn.exchange(b"POST / HTTP/1.1\r\ncontent-length: 1048576\r\n\r\n", &body, "POST", false))
            .await
            .expect("the answer arrives while the write is pending");
        match outcome {
            Exchange::Answered { response, written } => {
                assert_eq!(response.status(), 413);
                assert!(!written, "the request was not whole when the answer came");
            }
            _ => panic!("the answer is the outcome"),
        }
        drop(server);
    }

    // H4: hyper cannot write the head Node writes: it lowercases every header name (the provider's `OpenAI-Beta`,
    // `session_id` keep their case in Node's recording) and writes no `connection` line unless it is given one. This
    // pins what the difference is, so that the hand-written head stays only as long as hyper cannot do it.
    #[tokio::test]
    async fn hyper_writes_the_providers_header_names_in_lower_case_and_the_head_here_does_not() {
        let (near, mut far) = tokio::io::duplex(1 << 16);
        let (mut send, connection) = http1::handshake::<_, http_body_util::Full<Bytes>>(TokioIo::new(near)).await.unwrap();
        tokio::spawn(connection);
        let request = hyper::Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header("host", "chatgpt.com")
            .header("OpenAI-Beta", "responses=v1")
            .header("session_id", "s")
            .body(http_body_util::Full::new(Bytes::from_static(b"{}")))
            .unwrap();
        tokio::spawn(send.send_request(request));
        let mut written = vec![0u8; 512];
        let n = tokio::time::timeout(Duration::from_secs(20), far.read(&mut written)).await.expect("hyper's request within 20 s").unwrap();
        let hyper_head = String::from_utf8(written[..n].to_vec()).unwrap();
        let wire = mixdog_core_api::domain::provider::WireRequest {
            transport: mixdog_core_api::domain::keepalive::TransportKind::Http1,
            method: "POST".into(),
            url: "https://chatgpt.com/v1/responses".into(),
            headers: vec![("OpenAI-Beta".into(), "responses=v1".into()), ("session_id".into(), "s".into())],
            body: b"{}".to_vec(),
        };
        let (ours, _) = super::super::head(&wire, &url::Url::parse(&wire.url).unwrap(), super::super::Writer::Raw);
        let ours = String::from_utf8(ours).unwrap();
        assert!(hyper_head.contains("openai-beta: responses=v1\r\n") && !hyper_head.contains("OpenAI-Beta"), "{hyper_head:?}");
        assert!(ours.contains("OpenAI-Beta: responses=v1\r\n") && ours.contains("session_id: s\r\n"), "{ours:?}");
        assert!(ours.contains("connection: keep-alive\r\n") && !hyper_head.contains("connection:"), "{hyper_head:?}");
    }
}