//! The request body: what the handler reads, and the pump that decodes it off the socket.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytes::{Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;

use super::head::Framing;

/// The longest chunk-size or trailer line the decoder keeps waiting for.
const MAX_LINE: usize = 16 * 1024;

/// The request ended before its body did (`request.on('error')` / `'aborted'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("aborted")]
pub struct BodyError;

/// The body of a request as a stream. Reading it is optional: a handler that answers without reading, or drops this, leaves
/// the rest of the body to be read off the socket and discarded after the answer (`IncomingMessage._dump`); the connection
/// then serves its next request. Not reading it for as long as the handler likes stops the socket from being read
/// (backpressure), as a paused `IncomingMessage` does.
#[derive(Debug)]
pub struct Body {
    rx: mpsc::Receiver<Bytes>,
    complete: Arc<AtomicBool>,
    failed: bool,
}

impl Body {
    pub(crate) fn new(rx: mpsc::Receiver<Bytes>, complete: Arc<AtomicBool>) -> Self {
        Self { rx, complete, failed: false }
    }

    /// The next piece of the body; `None` at its end. A request that ended early (the peer went away, the socket was
    /// destroyed, the body was malformed) gives one `Err` and then `None`.
    pub async fn next(&mut self) -> Option<Result<Bytes, BodyError>> {
        if self.failed {
            return None;
        }
        match self.rx.recv().await {
            Some(chunk) => Some(Ok(chunk)),
            None if self.complete.load(Ordering::Acquire) => None,
            None => {
                self.failed = true;
                Some(Err(BodyError))
            }
        }
    }

    /// Stops reading the body: the connection discards what is left of it once the answer is out
    /// (`request.resume()` / `_dump`). Dropping the body does the same.
    pub fn drain(self) {}
}

/// Where the chunked decoder is in the body.
#[derive(Debug, Clone, Copy)]
enum State {
    Size,
    Data(u64),
    DataEnd,
    Trailer,
}

#[derive(Debug)]
enum Decoded {
    Data(Bytes),
    Need,
    Done,
    Bad,
}

/// `Transfer-Encoding: chunked` as llhttp reads it: hexadecimal sizes with optional extensions, CRLF line ends, trailers
/// read and dropped.
#[derive(Debug)]
struct ChunkedDecoder {
    state: State,
}

impl ChunkedDecoder {
    fn decode(&mut self, buf: &mut BytesMut) -> Decoded {
        loop {
            match self.state {
                State::Size => {
                    let Some(end) = buf.iter().position(|&b| b == b'\n') else {
                        return if buf.len() > MAX_LINE { Decoded::Bad } else { Decoded::Need };
                    };
                    let line = buf.split_to(end + 1);
                    let Some(size) = chunk_size(&line[..end]) else { return Decoded::Bad };
                    self.state = if size == 0 { State::Trailer } else { State::Data(size) };
                }
                State::Data(remaining) => {
                    if buf.is_empty() {
                        return Decoded::Need;
                    }
                    let take = remaining.min(buf.len() as u64) as usize;
                    let chunk = buf.split_to(take).freeze();
                    self.state = if remaining == take as u64 { State::DataEnd } else { State::Data(remaining - take as u64) };
                    return Decoded::Data(chunk);
                }
                State::DataEnd => {
                    if buf.len() < 2 {
                        return Decoded::Need;
                    }
                    if &buf[..2] != b"\r\n" {
                        return Decoded::Bad;
                    }
                    let _ = buf.split_to(2);
                    self.state = State::Size;
                }
                State::Trailer => {
                    let Some(end) = buf.iter().position(|&b| b == b'\n') else {
                        return if buf.len() > MAX_LINE { Decoded::Bad } else { Decoded::Need };
                    };
                    let line = buf.split_to(end + 1);
                    if line.strip_suffix(b"\n").map(|l| l.strip_suffix(b"\r").unwrap_or(l)).is_some_and(<[u8]>::is_empty) {
                        return Decoded::Done;
                    }
                }
            }
        }
    }
}

/// The size on a chunk-size line (`1f;ext=1\r`): hexadecimal digits, then an optional extension.
fn chunk_size(line: &[u8]) -> Option<u64> {
    let line = line.strip_suffix(b"\r")?;
    let digits = line.split(|&b| b == b';').next().unwrap_or(line);
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u64::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

#[derive(Debug)]
enum Kind {
    Length(u64),
    Chunked(ChunkedDecoder),
}

/// What one step of the pump did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// A piece moved on; call again.
    Progress,
    /// The body is complete; what follows in the buffer is the next request.
    Done,
    /// The peer closed before the body was complete.
    Eof,
    /// The body is malformed.
    Bad,
}

/// The connection's side of a request body: decodes it off the socket into the channel the handler's [`Body`] reads, or,
/// once that is dropped, into nothing.
#[derive(Debug)]
pub(crate) struct Pump {
    kind: Option<Kind>,
    tx: Option<mpsc::Sender<Bytes>>,
    complete: Arc<AtomicBool>,
}

impl Pump {
    /// The pump for a request with this framing, and the body the handler gets.
    pub(crate) fn new(framing: Framing) -> (Self, Body) {
        let (tx, rx) = mpsc::channel(4);
        let complete = Arc::new(AtomicBool::new(false));
        let kind = match framing {
            Framing::None | Framing::Length(0) => None,
            Framing::Length(length) => Some(Kind::Length(length)),
            Framing::Chunked => Some(Kind::Chunked(ChunkedDecoder { state: State::Size })),
        };
        let mut pump = Self { kind, tx: Some(tx), complete: complete.clone() };
        if pump.kind.is_none() {
            pump.finish();
        }
        (pump, Body::new(rx, complete))
    }

    pub(crate) fn is_done(&self) -> bool {
        self.kind.is_none()
    }

    fn finish(&mut self) {
        self.kind = None;
        self.complete.store(true, Ordering::Release);
        self.tx = None;
    }

    /// Moves the next piece of the body from `buf`, reading `rd` when `buf` holds none. Waits for room in the handler's
    /// channel first. Safe to drop between calls: nothing is taken from `buf` until the room is held.
    pub(crate) async fn step<R: AsyncRead + Unpin>(&mut self, rd: &mut R, buf: &mut BytesMut) -> Step {
        let permit = match self.tx.clone() {
            Some(tx) => match tx.reserve_owned().await {
                Ok(permit) => Some(permit),
                Err(_) => {
                    self.tx = None;
                    None
                }
            },
            None => None,
        };
        loop {
            let piece = match self.kind.as_mut() {
                None => return Step::Done,
                Some(Kind::Length(remaining)) => {
                    if buf.is_empty() {
                        None
                    } else {
                        let take = (*remaining).min(buf.len() as u64) as usize;
                        *remaining -= take as u64;
                        let chunk = buf.split_to(take).freeze();
                        if *remaining == 0 {
                            if let Some(permit) = permit {
                                drop(permit.send(chunk));
                            }
                            self.finish();
                            return Step::Done;
                        }
                        Some(chunk)
                    }
                }
                Some(Kind::Chunked(decoder)) => match decoder.decode(buf) {
                    Decoded::Data(chunk) => Some(chunk),
                    Decoded::Need => None,
                    Decoded::Done => {
                        self.finish();
                        return Step::Done;
                    }
                    Decoded::Bad => return Step::Bad,
                },
            };
            if let Some(chunk) = piece {
                if let Some(permit) = permit {
                    drop(permit.send(chunk));
                }
                return Step::Progress;
            }
            match rd.read_buf(buf).await {
                Ok(0) | Err(_) => return Step::Eof,
                Ok(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(framing: Framing, wire: &[u8], split: usize) -> (Vec<u8>, Step, BytesMut) {
        let (mut pump, mut body) = Pump::new(framing);
        let mut rd = wire;
        let mut buf = BytesMut::new();
        let reader = tokio::spawn(async move {
            let mut out = Vec::new();
            while let Some(Ok(chunk)) = body.next().await {
                out.extend_from_slice(&chunk);
            }
            out
        });
        // A reader that gives `split` bytes at a time: the next piece arrives when the pump has asked the socket for more.
        let mut starved = true;
        let last = loop {
            if (starved || buf.is_empty()) && !rd.is_empty() {
                let take = split.min(rd.len());
                buf.extend_from_slice(&rd[..take]);
                rd = &rd[take..];
            }
            let mut empty: &[u8] = &[];
            match pump.step(&mut empty, &mut buf).await {
                Step::Progress => starved = false,
                Step::Eof if !rd.is_empty() => starved = true,
                other => break other,
            }
        };
        drop(pump);
        buf.extend_from_slice(rd);
        (reader.await.unwrap(), last, buf)
    }

    #[tokio::test]
    async fn a_content_length_body_is_cut_where_the_next_request_starts() {
        let (body, last, rest) = run(Framing::Length(5), b"helloGET /next", 4).await;
        assert_eq!((body.as_slice(), last), (&b"hello"[..], Step::Done));
        assert_eq!(&rest[..], b"GET /next");
    }

    #[tokio::test]
    async fn a_chunked_body_is_decoded_whatever_the_read_sizes_are() {
        let wire = b"5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nTrailer: x\r\n\r\nNEXT";
        for split in [1, 2, 3, 7, 64] {
            let (body, last, rest) = run(Framing::Chunked, wire, split).await;
            assert_eq!((body.as_slice(), last), (&b"hello world"[..], Step::Done), "split {split}");
            assert_eq!(&rest[..], b"NEXT", "split {split}");
        }
    }

    #[tokio::test]
    async fn a_malformed_chunked_body_is_bad_and_a_short_one_is_eof() {
        assert_eq!(run(Framing::Chunked, b"zz\r\n", 8).await.1, Step::Bad);
        assert_eq!(run(Framing::Chunked, b"3\r\nabcX\r\n", 9).await.1, Step::Bad);
        assert_eq!(run(Framing::Length(10), b"abc", 8).await.1, Step::Eof);
    }

    #[tokio::test]
    async fn a_body_that_ended_early_reads_as_aborted_and_a_complete_one_as_ended() {
        let (mut pump, mut body) = Pump::new(Framing::Length(4));
        drop(pump.tx.take());
        assert_eq!(body.next().await, Some(Err(BodyError)));
        assert_eq!(body.next().await, None);
        let (_pump, mut empty) = Pump::new(Framing::None);
        assert_eq!(empty.next().await, None);
    }

    #[tokio::test]
    async fn a_dropped_body_discards_the_rest() {
        let (mut pump, body) = Pump::new(Framing::Length(6));
        drop(body);
        let mut buf = BytesMut::from(&b"abcdef"[..]);
        let mut empty: &[u8] = &[];
        assert_eq!(pump.step(&mut empty, &mut buf).await, Step::Done);
        assert!(pump.is_done() && buf.is_empty());
    }
}
