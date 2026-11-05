//! Wire frames between the pool and one worker process. Mirror of `src/ext-host/frame.mjs`:
//! change both together.
//!
//! ```text
//! frame := len:u32be | kind:u8 | id:u32be | body
//! ```
//!
//! `len` counts everything after itself. `id` is the call id, 0 for frames that belong to no call.

use std::future::Future;
use std::pin::pin;
use std::task::Context;
use std::task::Poll;
use std::task::Waker;

use bytes::Buf;
use bytes::Bytes;
use bytes::BytesMut;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;

pub const HEADER_BYTES: usize = 9;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Chunk bytes one call may have outstanding (sent by the worker, not yet taken by the consumer).
pub const CALL_WINDOW_BYTES: u64 = 1024 * 1024;

mod kind {
    pub const CALL: u8 = 1;
    pub const CANCEL: u8 = 2;
    pub const CREDIT: u8 = 3;
    pub const BROWSER: u8 = 4;
    pub const BYE: u8 = 5;
    pub const READY: u8 = 16;
    pub const CHUNK: u8 = 17;
    pub const RESULT: u8 = 18;
    pub const NEED_BROWSER: u8 = 19;
}

/// The error code a worker answers a cancelled call with.
pub const CANCELLED_CODE: &str = "cancelled";

#[derive(Debug)]
pub enum FrameError {
    Undersized,
    Oversized(usize),
    UnknownKind(u8),
    Body(String),
    Truncated,
    Io(std::io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Undersized => f.write_str("frame shorter than its header"),
            FrameError::Oversized(n) => write!(f, "frame of {n} bytes exceeds the limit"),
            FrameError::UnknownKind(k) => write!(f, "unknown frame kind {k}"),
            FrameError::Body(e) => write!(f, "malformed frame body: {e}"),
            FrameError::Truncated => f.write_str("stream ended inside a frame"),
            FrameError::Io(e) => write!(f, "read failed: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

fn encode(kind: u8, id: u32, body: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(HEADER_BYTES + body.len());
    out.extend_from_slice(&((5 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(&[kind]);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(body);
    out.freeze()
}

#[derive(Serialize)]
struct CallBody<'a> {
    method: &'a str,
    params: &'a Value,
    paths: &'a [String],
    thread: &'a str,
}

pub fn call(id: u32, method: &str, params: &Value, paths: &[String], thread: &str) -> Bytes {
    let body = CallBody {
        method,
        params,
        paths,
        thread,
    };
    // A `Value` and plain strings always serialize.
    encode(
        kind::CALL,
        id,
        &serde_json::to_vec(&body).unwrap_or_default(),
    )
}

pub fn cancel(id: u32) -> Bytes {
    encode(kind::CANCEL, id, &[])
}

pub fn credit(id: u32, bytes: u32) -> Bytes {
    encode(kind::CREDIT, id, &bytes.to_be_bytes())
}

/// The answer to `NeedBrowser`: the DevTools endpoint, or why there is none.
pub fn browser(id: u32, answer: &Result<String, String>) -> Bytes {
    let body = match answer {
        Ok(ws) => serde_json::json!({ "ws": ws }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    encode(
        kind::BROWSER,
        id,
        &serde_json::to_vec(&body).unwrap_or_default(),
    )
}

pub fn bye() -> Bytes {
    encode(kind::BYE, 0, &[])
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, PartialEq)]
pub enum Inbound {
    /// The worker holds credit for one call. Sent once, at start; a `Result` returns the credit.
    Ready,
    Chunk {
        call: u32,
        bytes: Bytes,
    },
    Result {
        call: u32,
        /// The worker now holds state for the call's thread.
        pin: bool,
        outcome: Result<Value, WireError>,
    },
    NeedBrowser {
        call: u32,
    },
}

#[derive(Deserialize)]
struct ResultBody {
    #[serde(default)]
    ok: Option<Value>,
    #[serde(default)]
    err: Option<WireError>,
    #[serde(default)]
    pin: bool,
}

struct RawFrame {
    kind: u8,
    id: u32,
    body: Bytes,
}

impl Inbound {
    fn parse(raw: RawFrame) -> Result<Inbound, FrameError> {
        match raw.kind {
            kind::READY => Ok(Inbound::Ready),
            kind::CHUNK => Ok(Inbound::Chunk {
                call: raw.id,
                bytes: raw.body,
            }),
            kind::NEED_BROWSER => Ok(Inbound::NeedBrowser { call: raw.id }),
            kind::RESULT => {
                let body: ResultBody =
                    serde_json::from_slice(&raw.body).map_err(|e| FrameError::Body(e.to_string()))?;
                let outcome = match body.err {
                    Some(error) => Err(error),
                    None => Ok(body.ok.unwrap_or(Value::Null)),
                };
                Ok(Inbound::Result {
                    call: raw.id,
                    pin: body.pin,
                    outcome,
                })
            }
            other => Err(FrameError::UnknownKind(other)),
        }
    }
}

/// Reads frames from a worker's stdout. `next` is cancel-safe: bytes read so far stay buffered.
pub struct FrameReader<R> {
    io: R,
    buf: BytesMut,
    eof: bool,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(io: R) -> Self {
        Self {
            io,
            buf: BytesMut::new(),
            eof: false,
        }
    }

    fn take(&mut self) -> Result<Option<RawFrame>, FrameError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if len < 5 {
            return Err(FrameError::Undersized);
        }
        if len > MAX_FRAME_BYTES {
            return Err(FrameError::Oversized(len));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        self.buf.advance(4);
        let kind = self.buf.get_u8();
        let id = self.buf.get_u32();
        let body = self.buf.split_to(len - 5).freeze();
        Ok(Some(RawFrame { kind, id, body }))
    }

    fn at_eof(&self) -> Result<Option<Inbound>, FrameError> {
        if self.buf.is_empty() {
            Ok(None)
        } else {
            Err(FrameError::Truncated)
        }
    }

    /// The next frame, `None` at a clean end of stream.
    pub async fn next(&mut self) -> Result<Option<Inbound>, FrameError> {
        loop {
            if let Some(raw) = self.take()? {
                return Inbound::parse(raw).map(Some);
            }
            if self.eof {
                return self.at_eof();
            }
            self.buf.reserve(64 * 1024);
            let n = self
                .io
                .read_buf(&mut self.buf)
                .await
                .map_err(FrameError::Io)?;
            if n == 0 {
                self.eof = true;
            }
        }
    }

    /// The next frame from bytes already in the pipe, without waiting for more. After the worker
    /// process exited, everything it wrote is readable this way.
    pub fn next_buffered(&mut self) -> Result<Option<Inbound>, FrameError> {
        loop {
            if let Some(raw) = self.take()? {
                return Inbound::parse(raw).map(Some);
            }
            if self.eof {
                return self.at_eof();
            }
            self.buf.reserve(64 * 1024);
            let mut read = pin!(self.io.read_buf(&mut self.buf));
            match read.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                Poll::Ready(Ok(0)) => self.eof = true,
                Poll::Ready(Ok(_)) => {}
                Poll::Ready(Err(e)) => return Err(FrameError::Io(e)),
                Poll::Pending => return Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(kind: u8, id: u32, body: &[u8]) -> Vec<u8> {
        encode(kind, id, body).to_vec()
    }

    #[tokio::test]
    async fn reads_frames_split_at_every_byte() {
        let mut wire = raw(kind::READY, 0, &[]);
        wire.extend(raw(kind::CHUNK, 7, b"abc"));
        wire.extend(raw(
            kind::RESULT,
            7,
            br#"{"err":{"code":"x","message":"m"},"pin":true}"#,
        ));
        let (mut tx, rx) = tokio::io::duplex(1);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            tx.write_all(&wire).await.unwrap();
        });
        let mut reader = FrameReader::new(rx);
        assert_eq!(reader.next().await.unwrap(), Some(Inbound::Ready));
        assert_eq!(
            reader.next().await.unwrap(),
            Some(Inbound::Chunk {
                call: 7,
                bytes: Bytes::from_static(b"abc")
            })
        );
        assert_eq!(
            reader.next().await.unwrap(),
            Some(Inbound::Result {
                call: 7,
                pin: true,
                outcome: Err(WireError {
                    code: "x".into(),
                    message: "m".into()
                })
            })
        );
        assert_eq!(reader.next().await.unwrap(), None);
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_bad_lengths_kinds_and_truncation() {
        let mut reader = FrameReader::new(&[0u8, 0, 0, 2, 0, 0][..]);
        assert!(matches!(reader.next().await, Err(FrameError::Undersized)));
        let huge = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        let mut reader = FrameReader::new(&huge[..]);
        assert!(matches!(reader.next().await, Err(FrameError::Oversized(_))));
        let unknown = raw(99, 0, &[]);
        let mut reader = FrameReader::new(&unknown[..]);
        assert!(matches!(
            reader.next().await,
            Err(FrameError::UnknownKind(99))
        ));
        let cut = raw(kind::CHUNK, 1, b"abcdef");
        let mut reader = FrameReader::new(&cut[..cut.len() - 2]);
        assert!(matches!(reader.next().await, Err(FrameError::Truncated)));
    }

    #[tokio::test]
    async fn buffered_read_does_not_wait() {
        let (mut tx, rx) = tokio::io::duplex(64);
        let mut reader = FrameReader::new(rx);
        assert_eq!(reader.next_buffered().unwrap(), None);
        use tokio::io::AsyncWriteExt;
        tx.write_all(&raw(kind::READY, 0, &[])).await.unwrap();
        assert_eq!(reader.next_buffered().unwrap(), Some(Inbound::Ready));
        assert_eq!(reader.next_buffered().unwrap(), None);
    }
}
