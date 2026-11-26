//! Frames on the helper's standard pipes, private to the two ends.
//!
//! ```text
//! frame   := len:u32be | flags:u8 | payload       len counts the flags and the payload
//! message := the payloads of consecutive frames, each but the last flagged MORE
//! ```
//!
//! A message is one JSON document. One longer than a frame's payload ([`CHUNK_BYTES`]) is written as several frames back to
//! back, never cut; one longer than [`MAX_MESSAGE_BYTES`] is refused by the writer and by the reader.

use std::io;
use std::io::Read;

use serde::Serialize;
use serde::de::DeserializeOwned;

/// The largest payload of one frame.
pub const CHUNK_BYTES: usize = 1 << 20;
/// The largest message.
pub const MAX_MESSAGE_BYTES: usize = 256 << 20;

/// The message continues in the next frame.
const MORE: u8 = 0x01;
const HEADER_BYTES: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub chunk: usize,
    pub message: usize,
}

impl Limits {
    pub const DEFAULT: Self = Self { chunk: CHUNK_BYTES, message: MAX_MESSAGE_BYTES };
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// The stream ended inside a frame, or after a frame flagged MORE.
    Truncated,
    /// A frame shorter than its flags.
    Empty,
    Unflagged(u8),
    FrameTooLarge(usize),
    MessageTooLarge(usize),
    Body(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(error) => write!(f, "pipe failed: {error}"),
            FrameError::Truncated => f.write_str("the stream ended inside a message"),
            FrameError::Empty => f.write_str("a frame shorter than its flags"),
            FrameError::Unflagged(flags) => write!(f, "unknown frame flags {flags:#04x}"),
            FrameError::FrameTooLarge(bytes) => write!(f, "a frame of {bytes} bytes exceeds the frame limit"),
            FrameError::MessageTooLarge(bytes) => write!(f, "a message of {bytes} bytes exceeds the message limit"),
            FrameError::Body(error) => write!(f, "malformed message: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// `message` as the frames that carry it.
pub fn encode<T: Serialize>(message: &T) -> Result<Vec<u8>, FrameError> {
    encode_with(message, Limits::DEFAULT)
}

pub fn encode_with<T: Serialize>(message: &T, limits: Limits) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(message).map_err(|error| FrameError::Body(error.to_string()))?;
    if body.len() > limits.message {
        return Err(FrameError::MessageTooLarge(body.len()));
    }
    let chunk = limits.chunk.max(1);
    let mut out = Vec::with_capacity(body.len() + HEADER_BYTES * body.len().div_ceil(chunk).max(1));
    let mut parts = body.chunks(chunk).peekable();
    if parts.peek().is_none() {
        push_frame(&mut out, &[], 0);
    }
    while let Some(part) = parts.next() {
        push_frame(&mut out, part, if parts.peek().is_some() { MORE } else { 0 });
    }
    Ok(out)
}

fn push_frame(out: &mut Vec<u8>, payload: &[u8], flags: u8) {
    out.extend_from_slice(&((payload.len() + 1) as u32).to_be_bytes());
    out.push(flags);
    out.extend_from_slice(payload);
}

/// Reads whole messages from a pipe, blocking.
pub struct FrameReader<R> {
    input: R,
    limits: Limits,
}

impl<R: Read> FrameReader<R> {
    pub fn new(input: R) -> Self {
        Self::with_limits(input, Limits::DEFAULT)
    }

    pub fn with_limits(input: R, limits: Limits) -> Self {
        Self { input, limits }
    }

    /// The next message, `None` at a clean end of the stream (between messages).
    pub fn read<T: DeserializeOwned>(&mut self) -> Result<Option<T>, FrameError> {
        let mut message = Vec::new();
        let mut frames = 0usize;
        loop {
            let mut header = [0u8; HEADER_BYTES];
            match fill(&mut self.input, &mut header)? {
                0 if frames == 0 => return Ok(None),
                HEADER_BYTES => {}
                _ => return Err(FrameError::Truncated),
            }
            let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
            let flags = header[4];
            let Some(size) = len.checked_sub(1) else { return Err(FrameError::Empty) };
            if flags & !MORE != 0 {
                return Err(FrameError::Unflagged(flags));
            }
            if size > self.limits.chunk {
                return Err(FrameError::FrameTooLarge(size));
            }
            if message.len() + size > self.limits.message {
                return Err(FrameError::MessageTooLarge(message.len() + size));
            }
            let start = message.len();
            message.resize(start + size, 0);
            if fill(&mut self.input, &mut message[start..])? != size {
                return Err(FrameError::Truncated);
            }
            frames += 1;
            if flags & MORE == 0 {
                return serde_json::from_slice(&message).map(Some).map_err(|error| FrameError::Body(error.to_string()));
            }
        }
    }
}

/// Reads until `buf` is full or the stream ends; how much it read.
fn fill(input: &mut impl Read, buf: &mut [u8]) -> Result<usize, FrameError> {
    let mut read = 0;
    while read < buf.len() {
        match input.read(&mut buf[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(FrameError::Io(error)),
        }
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: Limits = Limits { chunk: 7, message: 64 };

    fn frames(bytes: &[u8]) -> Vec<(usize, u8)> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let len = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            out.push((len - 1, bytes[at + 4]));
            at += 4 + len;
        }
        out
    }

    #[test]
    fn a_message_over_one_frame_is_chunked_and_read_back_whole() {
        let text = "a message longer than three frames".to_owned();
        let bytes = encode_with(&text, SMALL).unwrap();
        let sizes = frames(&bytes);
        assert!(sizes.len() > 3, "{sizes:?}");
        assert!(sizes[..sizes.len() - 1].iter().all(|&(size, flags)| size == 7 && flags == MORE));
        assert_eq!(sizes.last().unwrap().1, 0);
        let mut reader = FrameReader::with_limits(&bytes[..], SMALL);
        assert_eq!(reader.read::<String>().unwrap(), Some(text));
        assert_eq!(reader.read::<String>().unwrap(), None);
    }

    #[test]
    fn a_message_over_the_limit_is_refused_not_cut() {
        let text = "x".repeat(80);
        assert!(matches!(encode_with(&text, SMALL), Err(FrameError::MessageTooLarge(82))));
        let bytes = encode_with(&text, Limits { chunk: 7, message: 1024 }).unwrap();
        assert!(matches!(FrameReader::with_limits(&bytes[..], SMALL).read::<String>(), Err(FrameError::MessageTooLarge(_))));
    }

    #[test]
    fn a_frame_over_the_chunk_limit_is_refused() {
        let bytes = encode_with(&"x".repeat(20), Limits { chunk: 64, message: 64 }).unwrap();
        assert!(matches!(FrameReader::with_limits(&bytes[..], SMALL).read::<String>(), Err(FrameError::FrameTooLarge(22))));
    }

    #[test]
    fn a_stream_ending_inside_a_message_is_truncated() {
        let bytes = encode_with(&"a message longer than one frame", SMALL).unwrap();
        let first = 4 + 1 + 7;
        for cut in [3, first - 2, first, first + 2] {
            assert!(matches!(FrameReader::with_limits(&bytes[..cut], SMALL).read::<String>(), Err(FrameError::Truncated)), "cut at {cut}");
        }
    }

    #[test]
    fn unknown_flags_an_empty_frame_and_a_bad_body_are_refused() {
        assert!(matches!(FrameReader::new(&[0u8, 0, 0, 1, 0x02][..]).read::<String>(), Err(FrameError::Unflagged(0x02))));
        assert!(matches!(FrameReader::new(&[0u8, 0, 0, 0, 0][..]).read::<String>(), Err(FrameError::Empty)));
        assert!(matches!(FrameReader::new(&[0u8, 0, 0, 3, 0, b'n', b'o'][..]).read::<String>(), Err(FrameError::Body(_))));
    }
}
