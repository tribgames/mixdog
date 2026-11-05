//! Connect streaming envelope: `flags(1) | length(4, big-endian) | payload`.
//! The reader is incremental and bounded by the advertised length, so an
//! oversize peer-controlled length fails on the header instead of buffering.

pub const COMPRESSED: u8 = 0x01;
pub const END_STREAM: u8 = 0x02;
const HEADER: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub flags: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn is_end_stream(&self) -> bool {
        self.flags & END_STREAM != 0
    }

    pub fn is_compressed(&self) -> bool {
        self.flags & COMPRESSED != 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameTooLarge {
    pub length: u64,
    pub max: usize,
}

pub fn encode(payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.push(flags);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Splits a byte stream into frames.
#[derive(Debug)]
pub struct FrameReader {
    buf: Vec<u8>,
    max_frame: usize,
}

impl FrameReader {
    pub fn new(max_frame: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_frame,
        }
    }

    /// Bytes of an incomplete frame still buffered.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Every frame completed by `chunk`, in wire order.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FrameTooLarge> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut at = 0;
        while self.buf.len() - at >= HEADER {
            let flags = self.buf[at];
            let length = u32::from_be_bytes(self.buf[at + 1..at + HEADER].try_into().expect("4 bytes"));
            if length as usize > self.max_frame {
                return Err(FrameTooLarge {
                    length: u64::from(length),
                    max: self.max_frame,
                });
            }
            let end = at + HEADER + length as usize;
            if self.buf.len() < end {
                break;
            }
            frames.push(Frame {
                flags,
                payload: self.buf[at + HEADER..end].to_vec(),
            });
            at = end;
        }
        self.buf.drain(..at);
        Ok(frames)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_across_chunks() {
        let mut bytes = encode(b"abc", 0);
        bytes.extend(encode(b"{}", END_STREAM));
        let mut reader = FrameReader::new(1024);
        let mut frames = Vec::new();
        for chunk in bytes.chunks(3) {
            frames.extend(reader.push(chunk).unwrap());
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].payload, b"abc");
        assert!(frames[1].is_end_stream());
        assert_eq!(reader.buffered(), 0);
    }

    #[test]
    fn oversize_length_fails_on_the_header() {
        let mut reader = FrameReader::new(8);
        assert!(reader.push(&[0, 0, 0, 1, 0]).is_err());
    }

    #[test]
    fn partial_frame_stays_buffered() {
        let mut reader = FrameReader::new(1024);
        assert!(reader.push(&encode(b"abcdef", 0)[..8]).unwrap().is_empty());
        assert_eq!(reader.buffered(), 8);
    }
}
