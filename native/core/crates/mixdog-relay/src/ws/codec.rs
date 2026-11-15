//! The frame layer of RFC 6455 as the `ws` package (`lib/receiver.js`, `lib/sender.js`, `lib/validation.js`) runs it for a
//! server with `perMessageDeflate: false`: the incremental frame parser with every check and every error `ws` makes, and
//! the writer of unmasked server frames.

use std::collections::VecDeque;

use bytes::Bytes;

/// RFC 6455 section 1.3: the constant the accept key is made with.
pub const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The `ws` option defaults the relay does not override: chunks the parser may hold unread, and fragments of one message.
pub const MAX_BUFFERED_CHUNKS: usize = 256 * 1024;
pub const MAX_FRAGMENTS: usize = 16 * 1024;

pub const OP_CONTINUATION: u8 = 0x0;
pub const OP_TEXT: u8 = 0x1;
pub const OP_BINARY: u8 = 0x2;
pub const OP_CLOSE: u8 = 0x8;
pub const OP_PING: u8 = 0x9;
pub const OP_PONG: u8 = 0xa;

/// A protocol error of the receiver: what `ws` emits as the `'error'` event and answers with a close frame carrying
/// `status_code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiverError {
    pub message: String,
    /// The `ws` error code, `WS_ERR_*`.
    pub code: &'static str,
    pub status_code: u16,
}

/// What the parser found in the bytes it was given, in wire order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiverEvent {
    Message {
        data: Bytes,
        binary: bool,
    },
    Ping(Bytes),
    Pong(Bytes),
    /// A close frame: 1005 and no reason when the frame had no payload.
    Conclude {
        code: u16,
        reason: Bytes,
    },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Info,
    Len16,
    Len64,
    Mask,
    Data,
}

/// `Receiver` of `ws` for a server: client frames must be masked, RSV bits must be clear, a message may not exceed
/// `max_payload` (0 is unlimited).
pub struct Receiver {
    max_buffered_chunks: usize,
    max_fragments: usize,
    max_payload: u64,
    buffered: usize,
    buffers: VecDeque<Bytes>,
    payload_length: u64,
    mask: [u8; 4],
    fragmented: u8,
    masked: bool,
    fin: bool,
    opcode: u8,
    total_payload_length: u64,
    num_fragments: usize,
    fragments: Vec<Vec<u8>>,
    state: State,
    done: bool,
}

impl Receiver {
    pub fn new(max_payload: u64) -> Self {
        Self::with_limits(max_payload, MAX_BUFFERED_CHUNKS, MAX_FRAGMENTS)
    }

    pub fn with_limits(max_payload: u64, max_buffered_chunks: usize, max_fragments: usize) -> Self {
        Self {
            max_buffered_chunks,
            max_fragments,
            max_payload,
            buffered: 0,
            buffers: VecDeque::new(),
            payload_length: 0,
            mask: [0; 4],
            fragmented: 0,
            masked: false,
            fin: false,
            opcode: 0,
            total_payload_length: 0,
            num_fragments: 0,
            fragments: Vec::new(),
            state: State::Info,
            done: false,
        }
    }

    /// True once a close frame was parsed or an error was returned: further bytes are not parsed.
    pub fn finished(&self) -> bool {
        self.done
    }

    /// Feed one chunk of the stream. Events found before an error are in `out` before the error is returned.
    pub fn feed(&mut self, chunk: Bytes, out: &mut Vec<ReceiverEvent>) -> Result<(), ReceiverError> {
        if self.done || chunk.is_empty() {
            return Ok(());
        }
        if self.max_buffered_chunks > 0 && self.buffers.len() >= self.max_buffered_chunks {
            return Err(self.fail("Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
        }
        self.buffered += chunk.len();
        self.buffers.push_back(chunk);
        loop {
            if self.done {
                return Ok(());
            }
            match self.state {
                State::Info => {
                    if self.buffered < 2 {
                        return Ok(());
                    }
                    self.get_info()?;
                }
                State::Len16 => {
                    if self.buffered < 2 {
                        return Ok(());
                    }
                    let buf = self.consume(2);
                    self.payload_length = u64::from(u16::from_be_bytes([buf[0], buf[1]]));
                    self.have_length()?;
                }
                State::Len64 => {
                    if self.buffered < 8 {
                        return Ok(());
                    }
                    let buf = self.consume(8);
                    let high = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
                    if u64::from(high) > (1u64 << 21) - 1 {
                        return Err(self.fail(
                            "Unsupported WebSocket frame: payload length > 2^53 - 1",
                            false,
                            1009,
                            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
                        ));
                    }
                    let low = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                    self.payload_length = (u64::from(high) << 32) + u64::from(low);
                    self.have_length()?;
                }
                State::Mask => {
                    if self.buffered < 4 {
                        return Ok(());
                    }
                    let buf = self.consume(4);
                    self.mask = [buf[0], buf[1], buf[2], buf[3]];
                    self.state = State::Data;
                }
                State::Data => {
                    if !self.get_data(out)? {
                        return Ok(());
                    }
                }
            }
        }
    }

    fn fail(&mut self, message: &str, prefix: bool, status_code: u16, code: &'static str) -> ReceiverError {
        self.done = true;
        ReceiverError {
            message: if prefix { format!("Invalid WebSocket frame: {message}") } else { message.to_string() },
            code,
            status_code,
        }
    }

    fn consume(&mut self, n: usize) -> Vec<u8> {
        self.buffered -= n;
        let mut dst = Vec::with_capacity(n);
        let mut need = n;
        while need > 0 {
            let len = self.buffers[0].len();
            if need >= len {
                let buf = self.buffers.pop_front().unwrap_or_default();
                dst.extend_from_slice(&buf);
                need -= len;
            } else {
                let part = self.buffers[0].split_to(need);
                dst.extend_from_slice(&part);
                need = 0;
            }
        }
        dst
    }

    fn get_info(&mut self) -> Result<(), ReceiverError> {
        let buf = self.consume(2);
        if (buf[0] & 0x30) != 0 {
            return Err(self.fail("RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3"));
        }
        // No extension is negotiated, so a compressed frame is never acceptable.
        if (buf[0] & 0x40) == 0x40 {
            return Err(self.fail("RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
        }
        self.fin = (buf[0] & 0x80) == 0x80;
        self.opcode = buf[0] & 0x0f;
        self.payload_length = u64::from(buf[1] & 0x7f);
        match self.opcode {
            OP_CONTINUATION => {
                if self.fragmented == 0 {
                    return Err(self.fail("invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE"));
                }
                self.opcode = self.fragmented;
            }
            OP_TEXT | OP_BINARY => {
                if self.fragmented != 0 {
                    let message = format!("invalid opcode {}", self.opcode);
                    return Err(self.fail(&message, true, 1002, "WS_ERR_INVALID_OPCODE"));
                }
            }
            OP_CLOSE | OP_PING | OP_PONG => {
                if !self.fin {
                    return Err(self.fail("FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN"));
                }
                if self.payload_length > 0x7d || (self.opcode == OP_CLOSE && self.payload_length == 1) {
                    let message = format!("invalid payload length {}", self.payload_length);
                    return Err(self.fail(&message, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"));
                }
            }
            other => {
                let message = format!("invalid opcode {other}");
                return Err(self.fail(&message, true, 1002, "WS_ERR_INVALID_OPCODE"));
            }
        }
        if !self.fin && self.fragmented == 0 {
            self.fragmented = self.opcode;
        }
        self.masked = (buf[1] & 0x80) == 0x80;
        if !self.masked {
            return Err(self.fail("MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK"));
        }
        match self.payload_length {
            126 => self.state = State::Len16,
            127 => self.state = State::Len64,
            _ => self.have_length()?,
        }
        Ok(())
    }

    fn have_length(&mut self) -> Result<(), ReceiverError> {
        if self.payload_length != 0 && self.opcode < 0x08 {
            self.total_payload_length = self.total_payload_length.saturating_add(self.payload_length);
            if self.total_payload_length > self.max_payload && self.max_payload > 0 {
                return Err(self.fail("Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
            }
        }
        self.state = if self.masked { State::Mask } else { State::Data };
        Ok(())
    }

    /// Returns false when the frame is not complete yet.
    fn get_data(&mut self, out: &mut Vec<ReceiverEvent>) -> Result<bool, ReceiverError> {
        let mut data = Vec::new();
        if self.payload_length != 0 {
            let Ok(length) = usize::try_from(self.payload_length) else {
                return Ok(false);
            };
            if self.buffered < length {
                return Ok(false);
            }
            data = self.consume(length);
            if self.masked && (self.mask[0] | self.mask[1] | self.mask[2] | self.mask[3]) != 0 {
                unmask(&mut data, self.mask);
            }
        }
        if self.opcode > 0x07 {
            self.control_message(data, out)?;
            return Ok(true);
        }
        if self.max_fragments > 0 {
            self.num_fragments += 1;
            if self.num_fragments > self.max_fragments {
                return Err(self.fail("Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
            }
        }
        if !data.is_empty() {
            self.fragments.push(data);
        }
        self.data_message(out)?;
        Ok(true)
    }

    fn data_message(&mut self, out: &mut Vec<ReceiverEvent>) -> Result<(), ReceiverError> {
        if !self.fin {
            self.state = State::Info;
            return Ok(());
        }
        let mut fragments = std::mem::take(&mut self.fragments);
        self.total_payload_length = 0;
        self.num_fragments = 0;
        let binary = self.opcode == OP_BINARY;
        self.fragmented = 0;
        let message = if fragments.len() == 1 { fragments.pop().unwrap_or_default() } else { fragments.concat() };
        if !binary && std::str::from_utf8(&message).is_err() {
            return Err(self.fail("invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
        }
        out.push(ReceiverEvent::Message { data: Bytes::from(message), binary });
        self.state = State::Info;
        Ok(())
    }

    fn control_message(&mut self, data: Vec<u8>, out: &mut Vec<ReceiverEvent>) -> Result<(), ReceiverError> {
        self.state = State::Info;
        match self.opcode {
            OP_CLOSE => {
                if data.is_empty() {
                    out.push(ReceiverEvent::Conclude { code: 1005, reason: Bytes::new() });
                } else {
                    let code = u16::from_be_bytes([data[0], data[1]]);
                    if !is_valid_status_code(code) {
                        let message = format!("invalid status code {code}");
                        return Err(self.fail(&message, true, 1002, "WS_ERR_INVALID_CLOSE_CODE"));
                    }
                    let reason = &data[2..];
                    if std::str::from_utf8(reason).is_err() {
                        return Err(self.fail("invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
                    }
                    out.push(ReceiverEvent::Conclude { code, reason: Bytes::copy_from_slice(reason) });
                }
                self.done = true;
            }
            OP_PING => out.push(ReceiverEvent::Ping(Bytes::from(data))),
            _ => out.push(ReceiverEvent::Pong(Bytes::from(data))),
        }
        Ok(())
    }
}

/// `isValidStatusCode` of `ws`: the codes either side may put in a close frame.
pub fn is_valid_status_code(code: u16) -> bool {
    ((1000..=1014).contains(&code) && code != 1004 && code != 1005 && code != 1006) || (3000..=4999).contains(&code)
}

fn unmask(data: &mut [u8], mask: [u8; 4]) {
    let wide = u64::from_ne_bytes([mask[0], mask[1], mask[2], mask[3], mask[0], mask[1], mask[2], mask[3]]);
    let mut blocks = data.chunks_exact_mut(8);
    for block in &mut blocks {
        let value =
            u64::from_ne_bytes([block[0], block[1], block[2], block[3], block[4], block[5], block[6], block[7]]) ^ wide;
        block.copy_from_slice(&value.to_ne_bytes());
    }
    for (index, byte) in blocks.into_remainder().iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
}

/// The header of one unmasked server frame: 2, 4 or 10 bytes; the second value is its length.
pub fn frame_header(opcode: u8, fin: bool, payload_length: usize) -> ([u8; 10], usize) {
    let mut head = [0u8; 10];
    head[0] = if fin { opcode | 0x80 } else { opcode };
    if payload_length >= 65536 {
        head[1] = 127;
        head[2..10].copy_from_slice(&(payload_length as u64).to_be_bytes());
        (head, 10)
    } else if payload_length > 125 {
        head[1] = 126;
        head[2..4].copy_from_slice(&(payload_length as u16).to_be_bytes());
        (head, 4)
    } else {
        head[1] = payload_length as u8;
        (head, 2)
    }
}

/// A close frame's payload: the code and the reason, or nothing when there is no code. A code `ws` would not send, or a
/// reason over 123 bytes, is the error `ws` throws.
pub fn close_payload(code: Option<u16>, reason: &[u8]) -> Result<Vec<u8>, FrameError> {
    let Some(code) = code else { return Ok(Vec::new()) };
    if !is_valid_status_code(code) {
        return Err(FrameError::InvalidCloseCode);
    }
    if reason.len() > 123 {
        return Err(FrameError::CloseReasonTooLong);
    }
    let mut payload = Vec::with_capacity(2 + reason.len());
    payload.extend_from_slice(&code.to_be_bytes());
    payload.extend_from_slice(reason);
    Ok(payload)
}

/// What `ws` throws instead of writing a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("First argument must be a valid error code number")]
    InvalidCloseCode,
    #[error("The message must not be greater than 123 bytes")]
    CloseReasonTooLong,
    #[error("The data size must not be greater than 125 bytes")]
    ControlTooLong,
}
