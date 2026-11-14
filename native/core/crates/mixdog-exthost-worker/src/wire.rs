//! The worker half of the frame protocol the pool speaks (`mixdog_exthost::frame`): change both together.
//!
//! ```text
//! frame := len:u32be | kind:u8 | id:u32be | body
//! ```
//!
//! `len` counts everything after itself. `id` is the call id, 0 for frames that belong to no call. This side
//! encodes READY, CHUNK, RESULT and NEED_BROWSER and decodes CALL, CANCEL, CREDIT, BROWSER and BYE.

use bytes::Buf;
use bytes::Bytes;
use bytes::BytesMut;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;

pub const HEADER_BYTES: usize = 9;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Chunk bytes one call may have outstanding before the pool takes them; the worker holds this much credit at the start of a
/// call.
pub const CALL_WINDOW_BYTES: u64 = 1024 * 1024;
/// The most bytes one CHUNK frame carries.
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;

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

/// A frame the worker cannot make sense of: the worker reports it on stderr and exits with code 2.
#[derive(Debug, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

fn encode(kind: u8, id: u32, body: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(HEADER_BYTES + body.len());
    out.extend_from_slice(&((5 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(&[kind]);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(body);
    out.freeze()
}

/// Sent once, at start: the worker holds credit for one call.
pub fn ready() -> Bytes {
    encode(kind::READY, 0, &[])
}

pub fn chunk(id: u32, bytes: &[u8]) -> Bytes {
    encode(kind::CHUNK, id, bytes)
}

pub fn need_browser(id: u32) -> Bytes {
    encode(kind::NEED_BROWSER, id, &[])
}

/// `{ok, pin}` or `{err:{code, message}, pin}`.
pub fn result(id: u32, body: &Value) -> Bytes {
    // A `Value` always serializes.
    encode(
        kind::RESULT,
        id,
        &serde_json::to_vec(body).unwrap_or_default(),
    )
}

/// What a CALL frame asks for.
#[derive(Debug, PartialEq)]
pub struct CallRequest {
    pub method: String,
    pub params: Value,
    pub paths: Vec<String>,
    pub thread: String,
    pub cwd: String,
}

#[derive(Deserialize)]
struct CallBody {
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    paths: Option<Vec<String>>,
    #[serde(default)]
    thread: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Inbound {
    Call {
        id: u32,
        request: CallRequest,
    },
    Cancel {
        id: u32,
    },
    Credit {
        id: u32,
        bytes: u32,
    },
    /// The answer to NEED_BROWSER, JSON `{ws}` or `{error}`; read only when a call waits for it.
    Browser {
        id: u32,
        body: Bytes,
    },
    Bye,
}

fn parse(kind: u8, id: u32, body: Bytes) -> Result<Inbound, ProtocolError> {
    match kind {
        kind::CALL => {
            let call: CallBody = serde_json::from_slice(&body)
                .map_err(|e| ProtocolError(format!("ext-host: malformed call body: {e}")))?;
            Ok(Inbound::Call {
                id,
                request: CallRequest {
                    method: call.method,
                    params: call.params,
                    paths: call.paths.unwrap_or_default(),
                    thread: call.thread.unwrap_or_default(),
                    cwd: call.cwd.unwrap_or_default(),
                },
            })
        }
        kind::CANCEL => Ok(Inbound::Cancel { id }),
        kind::CREDIT => match body.first_chunk::<4>() {
            Some(bytes) => Ok(Inbound::Credit {
                id,
                bytes: u32::from_be_bytes(*bytes),
            }),
            None => Err(ProtocolError(
                "ext-host: credit body shorter than 4 bytes".to_owned(),
            )),
        },
        kind::BROWSER => Ok(Inbound::Browser { id, body }),
        kind::BYE => Ok(Inbound::Bye),
        other => Err(ProtocolError(format!(
            "ext-host: unknown frame kind {other}"
        ))),
    }
}

/// Reads frames from the pool's pipe. `next` is cancel-safe: bytes read so far stay buffered.
pub struct FrameReader<R> {
    io: R,
    buf: BytesMut,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(io: R) -> Self {
        Self {
            io,
            buf: BytesMut::new(),
        }
    }

    fn take(&mut self) -> Result<Option<Inbound>, ProtocolError> {
        if self.buf.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        if !(5..=MAX_FRAME_BYTES).contains(&len) {
            return Err(ProtocolError(format!(
                "ext-host frame length {len} is invalid"
            )));
        }
        if self.buf.len() < 4 + len {
            return Ok(None);
        }
        self.buf.advance(4);
        let kind = self.buf.get_u8();
        let id = self.buf.get_u32();
        let body = self.buf.split_to(len - 5).freeze();
        parse(kind, id, body).map(Some)
    }

    /// The next frame. `None` when the pipe ended (a frame cut short by the end is dropped, as the Node worker drops it).
    pub async fn next(&mut self) -> Result<Option<Inbound>, ProtocolError> {
        loop {
            if let Some(frame) = self.take()? {
                return Ok(Some(frame));
            }
            self.buf.reserve(64 * 1024);
            // A read error is the pipe going away: the same as its end.
            match self.io.read_buf(&mut self.buf).await {
                Ok(0) | Err(_) => return Ok(None),
                Ok(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_all(bytes: &[u8]) -> Vec<Result<Option<Inbound>, ProtocolError>> {
        let mut reader = FrameReader::new(bytes);
        let mut out = Vec::new();
        loop {
            let next = reader.next().await;
            let done = !matches!(next, Ok(Some(_)));
            out.push(next);
            if done {
                return out;
            }
        }
    }

    #[tokio::test]
    async fn decodes_every_inbound_kind() {
        let mut wire = encode(
            kind::CALL,
            7,
            br#"{"method":"m","params":{"a":1},"paths":["p"],"thread":"t","cwd":"c"}"#,
        )
        .to_vec();
        wire.extend(encode(kind::CANCEL, 7, &[]));
        wire.extend(encode(kind::CREDIT, 7, &9u32.to_be_bytes()));
        wire.extend(encode(kind::BROWSER, 7, br#"{"ws":"w"}"#));
        wire.extend(encode(kind::BYE, 0, &[]));
        let frames = read_all(&wire).await;
        assert_eq!(
            frames.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            vec![
                Some(Inbound::Call {
                    id: 7,
                    request: CallRequest {
                        method: "m".into(),
                        params: serde_json::json!({"a": 1}),
                        paths: vec!["p".into()],
                        thread: "t".into(),
                        cwd: "c".into(),
                    }
                }),
                Some(Inbound::Cancel { id: 7 }),
                Some(Inbound::Credit { id: 7, bytes: 9 }),
                Some(Inbound::Browser {
                    id: 7,
                    body: Bytes::from_static(br#"{"ws":"w"}"#)
                }),
                Some(Inbound::Bye),
                None,
            ]
        );
    }

    #[tokio::test]
    async fn a_call_without_optional_fields_gets_their_defaults() {
        let wire = encode(kind::CALL, 1, br#"{"method":"m"}"#);
        let got = read_all(&wire).await.remove(0).unwrap().unwrap();
        assert_eq!(
            got,
            Inbound::Call {
                id: 1,
                request: CallRequest {
                    method: "m".into(),
                    params: Value::Null,
                    paths: Vec::new(),
                    thread: String::new(),
                    cwd: String::new(),
                }
            }
        );
    }

    #[tokio::test]
    async fn rejects_bad_lengths_bodies_and_kinds() {
        let too_short = [0u8, 0, 0, 4, 1, 0, 0, 0];
        assert!(read_all(&too_short).await[0].is_err());
        let huge = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        assert!(read_all(&huge).await[0].is_err());
        assert!(read_all(&encode(kind::CALL, 1, b"{not json")).await[0].is_err());
        assert!(read_all(&encode(kind::CREDIT, 1, &[0, 1])).await[0].is_err());
        let unknown = read_all(&encode(99, 0, &[])).await.remove(0).unwrap_err();
        assert_eq!(unknown.0, "ext-host: unknown frame kind 99");
        // The kinds the worker itself sends are not valid inbound.
        assert!(read_all(&ready()).await[0].is_err());
    }

    #[tokio::test]
    async fn a_frame_cut_short_ends_the_stream() {
        let cut = encode(kind::CALL, 1, br#"{"method":"m"}"#);
        assert_eq!(
            read_all(&cut[..cut.len() - 1]).await.remove(0).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn reads_frames_split_at_every_byte() {
        let wire = encode(kind::CREDIT, 3, &5u32.to_be_bytes());
        let (mut tx, rx) = tokio::io::duplex(1);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            tx.write_all(&wire).await.unwrap();
        });
        let mut reader = FrameReader::new(rx);
        assert_eq!(
            reader.next().await.unwrap(),
            Some(Inbound::Credit { id: 3, bytes: 5 })
        );
        assert_eq!(reader.next().await.unwrap(), None);
        writer.await.unwrap();
    }
}
