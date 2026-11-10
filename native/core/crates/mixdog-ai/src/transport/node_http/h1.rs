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
}

impl Conn {
    pub async fn open(io: Stream, born: u64) -> Result<Self, hyper::Error> {
        let (read, write) = tokio::io::split(io);
        let (send, connection) = http1::Builder::new()
            .max_buf_size(MAX_HEAD)
            .max_headers(MAX_HEADERS)
            .handshake::<_, Empty<Bytes>>(TokioIo::new(ReadOnly(read)))
            .await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Self { send, write, born })
    }

    /// The connection has ended (the peer closed it, or hyper found it unusable).
    pub fn is_closed(&self) -> bool {
        self.send.is_closed()
    }

    /// Waits until hyper can take a request: `Err` is a connection that is gone.
    pub async fn ready(&mut self) -> Result<(), hyper::Error> {
        self.send.ready().await
    }

    /// Writes the request bytes. An `Err` means the request did not leave whole.
    pub async fn write_request(&mut self, head: &[u8], body: &[u8]) -> io::Result<()> {
        self.write.write_all(head).await?;
        self.write.write_all(body).await?;
        self.write.flush().await
    }

    /// hyper's reading of the response to the request just written. `method` and `close` tell hyper what it needs to know
    /// to frame the answer (a `HEAD` has no body; `connection: close` ends the connection after it).
    pub async fn response(&mut self, method: &str, close: bool) -> Result<hyper::Response<Incoming>, hyper::Error> {
        let mut request = hyper::Request::builder().method(method).uri("/");
        if close {
            request = request.header("connection", "close");
        }
        let request = request.body(Empty::<Bytes>::new()).expect("a request hyper reads no more of than its method");
        self.send.send_request(request).await
    }
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
    /// Set by [`BodyStream::hold_connection`]: the whole body's connection waits for this body to be dropped.
    pub hold: bool,
    parked: Option<(Reuse, Conn)>,
}

impl H1Body {
    pub fn new(incoming: Incoming, conn: Conn, decoder: Option<Decoder>, reuse: Option<Reuse>) -> Self {
        let mut body = Self { incoming: Some(incoming), conn: Some(conn), decoder, reuse, hold: false, parked: None };
        if body.incoming.as_ref().is_some_and(Body::is_end_stream) {
            body.release();
        }
        body
    }

    /// The exchange is whole: the connection goes back to the pool (after this body is dropped, if it is held).
    fn release(&mut self) {
        if let (Some(conn), Some(reuse)) = (self.conn.take(), self.reuse.take()) {
            if self.hold {
                self.parked = Some((reuse, conn));
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
        Some(Err(fault))
    }
}

impl Drop for H1Body {
    fn drop(&mut self) {
        if let Some((reuse, conn)) = self.parked.take() {
            reuse.pool.put_h1(reuse.key, conn, reuse.ttl);
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
            let incoming = self.incoming.as_mut()?;
            let frame = match tokio::time::timeout(BODY_TIMEOUT, incoming.frame()).await {
                Err(_) => return self.fail(TransportFault::Io { os_code: None }),
                Ok(frame) => frame,
            };
            match frame {
                None => {
                    self.incoming = None;
                    let tail = match self.decoder.take().map(Decoder::finish) {
                        Some(Err(e)) => return self.fail(fault_from_io(&e, false)),
                        Some(Ok(tail)) => tail,
                        None => Vec::new(),
                    };
                    self.release();
                    return (!tail.is_empty()).then(|| Ok(Bytes::from(tail)));
                }
                Some(Err(e)) => return self.fail(fault_from_chain(&e, false)),
                Some(Ok(frame)) => {
                    let Ok(raw) = frame.into_data() else { continue };
                    let out = match self.decoder.as_mut() {
                        Some(decoder) => match decoder.feed(&raw) {
                            Ok(out) => Bytes::from(out),
                            Err(e) => return self.fail(fault_from_io(&e, false)),
                        },
                        None => raw,
                    };
                    if self.incoming.as_ref().is_some_and(Body::is_end_stream) && self.decoder.is_none() {
                        self.incoming = None;
                        self.release();
                    }
                    if !out.is_empty() {
                        return Some(Ok(out));
                    }
                }
            }
        }
    }
}
