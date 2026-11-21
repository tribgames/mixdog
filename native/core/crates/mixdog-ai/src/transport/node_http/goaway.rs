//! What an HTTP/2 connection's frames say about its streams, read off the connection's bytes. `h2` keeps the peer's
//! last-stream-id to itself, fails the streams below the cutoff with the same error as the ones above it, and skips
//! informational responses before it reports a reset; only the frames tell a stream the peer never processed (RFC 9113
//! §6.8, §8.7) from one it may have, and whether any response HEADERS arrived on it.

use std::collections::HashMap;
use std::collections::HashSet;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;

use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;

const NO_CUTOFF: u32 = u32::MAX;
const CLIENT_PREFACE: usize = 24;
const FRAME_HEAD: usize = 9;
const DATA: u8 = 0x0;
const HEADERS: u8 = 0x1;
const RST_STREAM: u8 = 0x3;
const GOAWAY: u8 = 0x7;
const CONTINUATION: u8 = 0x9;
const END_STREAM: u8 = 0x1;
const END_HEADERS: u8 = 0x4;
const LOCAL_ENDED: u8 = 1;
const REMOTE_ENDED: u8 = 2;

/// One frame the tap has classified.
#[derive(Debug, PartialEq, Eq)]
enum Frame {
    /// A frame's header was read; its payload may still be arriving.
    Begun { kind: u8, stream: u32 },
    /// A frame was read whole; for HEADERS, its whole header block, with the HEADERS frame's flags.
    Whole { kind: u8, flags: u8, stream: u32 },
    /// A whole GOAWAY on stream 0.
    GoAway { last: u32, code: u32 },
}

/// The streams of one connection, behind one lock.
#[derive(Default)]
struct Streams {
    /// Stream id to which sides have ended; a stream leaves when both have, or on RST_STREAM.
    open: HashMap<u32, u8>,
    /// The streams an exchange holds.
    held: HashSet<u32>,
    /// Exchanges that may have opened a stream they do not hold yet.
    reserved: usize,
    /// The streams the peer has sent response HEADERS on.
    answered: HashSet<u32>,
}

impl Streams {
    fn end(&mut self, stream: u32, side: u8) {
        if let Some(sides) = self.open.get_mut(&stream) {
            *sides |= side;
            if *sides == LOCAL_ENDED | REMOTE_ENDED {
                self.open.remove(&stream);
            }
        }
    }

    /// Drops the evidence no exchange can ask for: of a stream that is neither open nor held, while no exchange is between
    /// opening a stream and holding it (whose stream it may be).
    fn prune(&mut self) {
        if self.reserved == 0 {
            let Self { open, held, answered, .. } = self;
            answered.retain(|stream| open.contains_key(stream) || held.contains(stream));
        }
    }
}

/// One connection's frame facts: the peer's GOAWAY cutoff, the streams open at the protocol level, the streams the peer
/// has sent response HEADERS on, and the streams an exchange holds.
pub struct ConnState {
    id: u64,
    cutoff: AtomicU32,
    streams: Mutex<Streams>,
}

impl ConnState {
    pub fn new(id: u64) -> Arc<Self> {
        Arc::new(Self { id, cutoff: AtomicU32::new(NO_CUTOFF), streams: Mutex::default() })
    }

    fn streams(&self) -> std::sync::MutexGuard<'_, Streams> {
        self.streams.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Streams open at the protocol level: sent HEADERS, not yet ended on both sides nor reset, nor cut by a GOAWAY.
    pub fn open_streams(&self) -> usize {
        self.streams().open.len()
    }

    /// The exchanges that hold a stream on this connection, which outlives the stream's end until the body is dropped.
    pub fn exchanges(&self) -> usize {
        self.streams().held.len()
    }

    pub fn counts(&self) -> String {
        format!("open_streams={} exchanges={}", self.open_streams(), self.exchanges())
    }

    /// An exchange is about to open a stream; until it [holds](Self::hold) one or [gives up](Self::unreserve), the
    /// response HEADERS of a stream that closes are kept, as they may be that exchange's.
    pub fn reserve(&self) {
        self.streams().reserved += 1;
    }

    pub fn unreserve(&self) {
        let mut streams = self.streams();
        streams.reserved = streams.reserved.saturating_sub(1);
        streams.prune();
    }

    /// The reserving exchange holds `stream`.
    pub fn hold(&self, stream: u32) {
        let mut streams = self.streams();
        streams.reserved = streams.reserved.saturating_sub(1);
        streams.held.insert(stream);
        streams.prune();
    }

    pub fn release(&self, stream: u32) {
        let mut streams = self.streams();
        streams.held.remove(&stream);
        streams.prune();
    }

    /// The peer's GOAWAY named a last-stream-id below `stream`: the peer did not process it.
    pub fn excluded(&self, stream: u32) -> bool {
        stream > self.cutoff.load(Ordering::SeqCst)
    }

    /// Any response HEADERS frame, informational or final, has arrived on `stream`.
    pub fn answered(&self, stream: u32) -> bool {
        self.streams().answered.contains(&stream)
    }

    fn frame(&self, peer: bool, frame: Frame) {
        match frame {
            // A response HEADERS counts from its first byte: a peer that goes before the block is whole may have processed
            // the request all the same.
            Frame::Begun { kind: HEADERS, stream } if peer && stream != 0 => {
                let mut streams = self.streams();
                if streams.open.contains_key(&stream) || streams.held.contains(&stream) {
                    streams.answered.insert(stream);
                }
            }
            Frame::Begun { .. } | Frame::Whole { stream: 0, .. } => {}
            Frame::Whole { kind, flags, stream } => {
                let mut streams = self.streams();
                let side = if peer { REMOTE_ENDED } else { LOCAL_ENDED };
                match kind {
                    HEADERS => {
                        if !peer {
                            streams.open.entry(stream).or_insert(0);
                        }
                        if flags & END_STREAM != 0 {
                            streams.end(stream, side);
                        }
                    }
                    DATA if flags & END_STREAM != 0 => streams.end(stream, side),
                    RST_STREAM => {
                        streams.open.remove(&stream);
                    }
                    _ => {}
                }
                streams.prune();
            }
            Frame::GoAway { last, code } => {
                // The count is the one the GOAWAY found; the streams it cuts leave afterwards. Only ids, codes and counts
                // are logged, never the frame's debug data.
                mixdog_rt::node_stderr!(
                    "[http] connection={} protocol=h2 goaway by={} code={code} last_stream_id={last} {}",
                    self.id,
                    if peer { "peer" } else { "local" },
                    self.counts()
                );
                if peer {
                    self.cutoff.fetch_min(last, Ordering::SeqCst);
                    let mut streams = self.streams();
                    streams.open.retain(|stream, _| *stream <= last);
                    streams.prune();
                }
            }
        }
    }
}

/// Reads one direction's frames as they pass.
struct Frames {
    skip: usize,
    head: [u8; FRAME_HEAD],
    head_len: usize,
    len: usize,
    left: usize,
    payload: [u8; 8],
    got: usize,
    /// The flags of a HEADERS frame whose header block goes on in CONTINUATION frames.
    block: Option<u8>,
}

impl Frames {
    fn new(skip: usize) -> Self {
        Self { skip, head: [0; FRAME_HEAD], head_len: 0, len: 0, left: 0, payload: [0; 8], got: 0, block: None }
    }

    /// The frame whose header is in `head` has been read to its end.
    fn finish(&mut self, report: &mut impl FnMut(Frame)) {
        self.head_len = 0;
        let (kind, flags, stream) = (self.head[3], self.head[4], self.stream());
        match kind {
            GOAWAY => {
                if stream == 0 && self.len >= 8 {
                    let last = u32::from_be_bytes([self.payload[0] & 0x7f, self.payload[1], self.payload[2], self.payload[3]]);
                    let code = u32::from_be_bytes([self.payload[4], self.payload[5], self.payload[6], self.payload[7]]);
                    report(Frame::GoAway { last, code });
                }
            }
            HEADERS if flags & END_HEADERS == 0 => self.block = Some(flags),
            CONTINUATION => {
                if flags & END_HEADERS != 0
                    && let Some(flags) = self.block.take()
                {
                    report(Frame::Whole { kind: HEADERS, flags, stream });
                }
            }
            _ => report(Frame::Whole { kind, flags, stream }),
        }
    }

    fn feed(&mut self, mut data: &[u8], mut report: impl FnMut(Frame)) {
        while !data.is_empty() {
            if self.skip > 0 {
                let n = self.skip.min(data.len());
                self.skip -= n;
                data = &data[n..];
            } else if self.head_len < FRAME_HEAD {
                let n = (FRAME_HEAD - self.head_len).min(data.len());
                self.head[self.head_len..self.head_len + n].copy_from_slice(&data[..n]);
                self.head_len += n;
                data = &data[n..];
                if self.head_len == FRAME_HEAD {
                    self.len = u32::from_be_bytes([0, self.head[0], self.head[1], self.head[2]]) as usize;
                    self.left = self.len;
                    self.got = 0;
                    report(Frame::Begun { kind: self.head[3], stream: self.stream() });
                    if self.left == 0 {
                        self.finish(&mut report);
                    }
                }
            } else {
                let n = self.left.min(data.len());
                if self.head[3] == GOAWAY && self.got < 8 {
                    let take = n.min(8 - self.got);
                    self.payload[self.got..self.got + take].copy_from_slice(&data[..take]);
                    self.got += take;
                }
                self.left -= n;
                data = &data[n..];
                if self.left == 0 {
                    self.finish(&mut report);
                }
            }
        }
    }

    fn stream(&self) -> u32 {
        u32::from_be_bytes([self.head[5] & 0x7f, self.head[6], self.head[7], self.head[8]])
    }
}

/// `inner` with its frames noted in `state`; the bytes pass through unchanged.
pub struct Tapped<T> {
    inner: T,
    state: Arc<ConnState>,
    read: Frames,
    write: Frames,
}

impl<T> Tapped<T> {
    pub fn new(inner: T, state: Arc<ConnState>) -> Self {
        Self { inner, state, read: Frames::new(0), write: Frames::new(CLIENT_PREFACE) }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for Tapped<T> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(polled, Poll::Ready(Ok(()))) {
            let this = &mut *self;
            let state = &this.state;
            this.read.feed(&buf.filled()[before..], |frame| state.frame(true, frame));
        }
        polled
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Tapped<T> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write(cx, data);
        if let Poll::Ready(Ok(n)) = polled {
            let this = &mut *self;
            let state = &this.state;
            this.write.feed(&data[..n], |frame| state.frame(false, frame));
        }
        polled
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: u8, flags: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
        let len = payload.len() as u32;
        let mut out = vec![(len >> 16) as u8, (len >> 8) as u8, len as u8, kind, flags];
        out.extend_from_slice(&stream.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn goaway(stream: u32, last: u32, code: u32) -> Vec<u8> {
        let mut payload = last.to_be_bytes().to_vec();
        payload.extend_from_slice(&code.to_be_bytes());
        payload.extend_from_slice(b"dbg");
        frame(GOAWAY, 0, stream, &payload)
    }

    fn read(state: &Arc<ConnState>, wire: &[u8]) {
        let mut frames = Frames::new(0);
        for byte in wire {
            frames.feed(std::slice::from_ref(byte), |f| state.frame(true, f));
        }
    }

    /// A GOAWAY split across reads, between other frames, is reported once, and only when whole.
    #[test]
    fn a_goaway_counts_only_when_whole_and_on_stream_zero() {
        let state = ConnState::new(1);
        let whole = goaway(0, 7, 11);
        read(&state, &whole[..whole.len() - 1]);
        assert!(!state.excluded(9), "the debug data was cut: no frame arrived");
        read(&state, &goaway(3, 1, 11));
        assert!(!state.excluded(9), "a GOAWAY on a stream is not one");
        let mut wire = frame(4, 0, 0, &[]);
        wire.extend(&whole);
        read(&state, &wire);
        assert!(state.excluded(9) && !state.excluded(7));
    }

    /// Successive GOAWAYs only lower the cutoff, and the connection's first stream is excluded by a cutoff of zero.
    #[test]
    fn the_cutoff_only_lowers() {
        let state = ConnState::new(1);
        assert!(!state.excluded(1));
        read(&state, &goaway(0, 5, 0));
        read(&state, &goaway(0, 9, 0));
        assert!(state.excluded(7) && !state.excluded(5));
        read(&state, &goaway(0, 0, 0));
        assert!(state.excluded(1));
    }

    fn feed(state: &Arc<ConnState>, frames: &mut Frames, peer: bool, wire: &[u8]) {
        frames.feed(wire, |f| state.frame(peer, f));
    }

    /// Streams count from their HEADERS to the end of both sides, a reset, or a GOAWAY cutting them; each change takes
    /// effect when its frame, or its header block, is whole.
    #[test]
    fn open_streams_change_when_their_frames_are_whole() {
        let state = ConnState::new(1);
        let (mut out, mut inn) = (Frames::new(0), Frames::new(0));
        for stream in [1, 3, 5] {
            feed(&state, &mut out, false, &frame(HEADERS, END_HEADERS, stream, &[0x83]));
            feed(&state, &mut out, false, &frame(DATA, END_STREAM, stream, b"x"));
        }
        assert_eq!(state.open_streams(), 3);
        feed(&state, &mut inn, true, &frame(HEADERS, END_HEADERS, 1, &[0x88]));
        let last = frame(DATA, END_STREAM, 1, b"ok");
        feed(&state, &mut inn, true, &last[..last.len() - 1]);
        assert_eq!(state.open_streams(), 3, "the final DATA is not whole");
        feed(&state, &mut inn, true, &last[last.len() - 1..]);
        assert_eq!(state.open_streams(), 2);
        let reset = frame(RST_STREAM, 0, 3, &7u32.to_be_bytes());
        feed(&state, &mut inn, true, &reset[..FRAME_HEAD]);
        assert_eq!(state.open_streams(), 2, "the reset is not whole");
        feed(&state, &mut inn, true, &reset[FRAME_HEAD..]);
        assert_eq!(state.open_streams(), 1);
        feed(&state, &mut inn, true, &frame(HEADERS, END_STREAM, 5, &[0x88]));
        assert_eq!(state.open_streams(), 1, "the header block goes on");
        feed(&state, &mut inn, true, &frame(CONTINUATION, END_HEADERS, 5, &[]));
        assert_eq!(state.open_streams(), 0);
        feed(&state, &mut out, false, &frame(HEADERS, END_HEADERS, 7, &[0x83]));
        assert_eq!(state.open_streams(), 1);
        feed(&state, &mut inn, true, &goaway(0, 5, 0));
        assert_eq!(state.open_streams(), 0, "stream 7 is above the cutoff");
    }

    /// A response HEADERS counts from its first byte, whatever follows it, while an exchange holds its stream or may be
    /// about to; after that nothing of the stream is kept.
    #[test]
    fn response_headers_are_kept_for_a_live_exchange_and_no_longer() {
        let state = ConnState::new(1);
        let (mut out, mut inn) = (Frames::new(0), Frames::new(0));
        // A `103` and a refusal arrive before the exchange holds the stream it opened.
        state.reserve();
        feed(&state, &mut out, false, &frame(HEADERS, END_HEADERS, 1, &[0x83]));
        let hint = frame(HEADERS, END_HEADERS, 1, &[0x08, 0x03, b'1', b'0', b'3']);
        feed(&state, &mut inn, true, &hint[..FRAME_HEAD]);
        assert!(state.answered(1), "from the frame's first byte");
        feed(&state, &mut inn, true, &hint[FRAME_HEAD..]);
        feed(&state, &mut inn, true, &frame(RST_STREAM, 0, 1, &7u32.to_be_bytes()));
        assert_eq!(state.open_streams(), 0);
        state.hold(1);
        assert!(state.answered(1), "the refusal closed the stream before the exchange held it");
        state.release(1);
        assert!(!state.answered(1));
        // A cancelled exchange's response arrives after it has gone, before and after the stream's reset.
        state.reserve();
        feed(&state, &mut out, false, &frame(HEADERS, END_HEADERS, 3, &[0x83]));
        state.hold(3);
        state.release(3);
        feed(&state, &mut inn, true, &frame(HEADERS, END_HEADERS, 3, &[0x88]));
        feed(&state, &mut out, false, &frame(RST_STREAM, 0, 3, &8u32.to_be_bytes()));
        feed(&state, &mut inn, true, &frame(HEADERS, END_HEADERS, 3, &[0x88]));
        // An exchange that never got a stream.
        state.reserve();
        state.unreserve();
        let streams = state.streams();
        assert!(streams.answered.is_empty() && streams.held.is_empty() && streams.open.is_empty() && streams.reserved == 0);
    }
}
