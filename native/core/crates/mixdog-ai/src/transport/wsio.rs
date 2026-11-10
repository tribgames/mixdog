//! The byte stream a WebSocket runs on: the bytes the server sent after its upgrade answer, and, when the server
//! accepted the `permessage-deflate` offer, the translation tungstenite (which has no deflate) needs.
//!
//! Every inbound frame is checked as `ws`'s receiver checks it (`ws/lib/receiver.js` `getInfo`; RFC 6455 5.2, 5.4;
//! RFC 7692 6) before it is translated: a violation closes the connection with the code `ws` uses (1002, 1007 for bad
//! deflate data, 1009 for a message past the limit), and the close frame is queued before the read fails. A compressed
//! message is inflated fragment by fragment, bounded while it inflates, and handed on as one plain frame. Outbound, a
//! single-frame data message is deflated with the negotiated window and sent with RSV1 (`sender.js:373-383`,
//! `permessage-deflate.js` `_compress`). Without the extension this is a plain pass-through.

use std::io;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;

use flate2::Compress;
use flate2::Compression;
use flate2::Decompress;
use flate2::FlushCompress;
use flate2::FlushDecompress;
use flate2::Status;
use ring::rand::SecureRandom;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;

/// `ws`'s default `threshold` for compressing an outgoing message; it applies only when the client's context does not
/// carry over (`sender.js:373-383`).
const THRESHOLD: usize = 1024;
/// `WS_MAX_INCOMING_FRAME_BYTES` (`openai-ws-pool.mjs:58`), the `maxPayload` of the Node client: a message, plain or
/// inflated, past it is refused with 1009.
pub const MAX_PAYLOAD: usize = 16 << 20;
/// The bytes `Z_SYNC_FLUSH` ends a deflate block with; the extension leaves them off the wire.
const TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];
/// How much room one step of the inflater is given, so that the bound is checked at least this often.
const STEP: usize = 16 << 10;
/// How long the close frame of a violation may wait for the socket to be writable before the connection is given up:
/// ws's closeTimeout (websocket.js CLOSE_TIMEOUT, 30 s), the time it allows a closing handshake.
pub const CLOSE_FLUSH: std::time::Duration = std::time::Duration::from_secs(30);

/// What the server accepted of the offer `permessage-deflate; client_max_window_bits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extension {
    pub server_no_context_takeover: bool,
    pub client_no_context_takeover: bool,
    /// The window the client deflates with, and the one the server deflates with (8..=15).
    pub client_max_window_bits: u8,
    pub server_max_window_bits: u8,
}

impl Default for Extension {
    fn default() -> Self {
        Self { server_no_context_takeover: false, client_no_context_takeover: false, client_max_window_bits: 15, server_max_window_bits: 15 }
    }
}

const NAME: &str = "permessage-deflate";

fn is_token(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}

/// One parameter: a name, and a value if it has one (a quoted value is unquoted; it may hold token characters only).
type Param = (String, Option<String>);

/// `ws/lib/extension.js` `parse`: `Sec-WebSocket-Extensions` as a list of offers, each a name and its parameters.
fn parse_offers(header: &str) -> Result<Vec<(String, Vec<Param>)>, String> {
    const BAD: &str = "Invalid Sec-WebSocket-Extensions header";
    const BLANK: [char; 2] = [' ', '\t'];
    let mut offers = Vec::new();
    for offer in header.split(',') {
        let mut parts = offer.split(';');
        let name = parts.next().unwrap_or_default().trim_matches(BLANK);
        if !is_token(name) {
            return Err(BAD.into());
        }
        let mut params = Vec::new();
        for part in parts {
            let part = part.trim_matches(BLANK);
            let (key, value) = match part.split_once('=') {
                Some((key, value)) => {
                    let inner = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
                    if !is_token(inner) {
                        return Err(BAD.into());
                    }
                    (key, Some(inner.to_owned()))
                }
                None => (part, None),
            };
            if !is_token(key) {
                return Err(BAD.into());
            }
            params.push((key.to_owned(), value));
        }
        offers.push((name.to_owned(), params));
    }
    Ok(offers)
}

impl Extension {
    /// The answer to the offer, as `ws` reads it (`websocket.js` `req.on('upgrade')`, `PerMessageDeflate`
    /// `accept`/`normalizeParams`). `value` is the joined `Sec-WebSocket-Extensions` header lines. `Ok(None)` is no
    /// header; a malformed one, an extension other than the one offered, a repeated, unknown or invalid parameter is an
    /// error (`ws` aborts the handshake on each). Of several `permessage-deflate` configurations the first is used.
    pub fn parse(value: Option<&str>) -> Result<Option<Self>, String> {
        let Some(value) = value else { return Ok(None) };
        let offers = parse_offers(value)?;
        if offers.iter().any(|(name, _)| name != NAME) {
            return Err("Server indicated an extension that was not requested".into());
        }
        let mut accepted = None;
        for (_, params) in &offers {
            let mut extension = Self::default();
            let mut seen: Vec<&str> = Vec::new();
            for (key, value) in params {
                if seen.contains(&key.as_str()) {
                    return Err(format!("Parameter \"{key}\" must have only a single value"));
                }
                seen.push(key);
                let bits = |value: &Option<String>| match value.as_deref().map(str::parse::<u8>) {
                    Some(Ok(bits)) if (8..=15).contains(&bits) => Ok(bits),
                    _ => Err(format!("Invalid value for parameter \"{key}\": {}", value.as_deref().unwrap_or("true"))),
                };
                match key.as_str() {
                    "client_max_window_bits" => extension.client_max_window_bits = bits(value)?,
                    "server_max_window_bits" => extension.server_max_window_bits = bits(value)?,
                    "client_no_context_takeover" | "server_no_context_takeover" => {
                        if value.is_some() {
                            return Err(format!("Invalid value for parameter \"{key}\": {}", value.as_deref().unwrap_or_default()));
                        }
                        if key.starts_with("client") {
                            extension.client_no_context_takeover = true;
                        } else {
                            extension.server_no_context_takeover = true;
                        }
                    }
                    _ => return Err(format!("Unknown parameter \"{key}\"")),
                }
            }
            accepted.get_or_insert(extension);
        }
        Ok(accepted)
    }
}

/// A protocol violation: the close code `ws` answers it with, and the error `ws`'s receiver emits for it (`receiver.js`
/// `createError`: its `code`, and its message, which carries the prefix `Invalid WebSocket frame: ` where ws adds it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub code: u16,
    pub ws_code: &'static str,
    pub text: String,
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text)
    }
}

impl std::error::Error for Fault {}

fn fault(code: u16, ws_code: &'static str, text: impl Into<String>) -> Fault {
    Fault { code, ws_code, text: text.into() }
}

/// The message of a receiver error `ws` creates with its prefix.
fn framed(text: impl std::fmt::Display) -> String {
    format!("Invalid WebSocket frame: {text}")
}

/// A frame's fixed fields and where its payload lies in the buffer.
struct Head {
    first: u8,
    masked: bool,
    header: usize,
    payload: usize,
}

impl Head {
    fn opcode(&self) -> u8 {
        self.first & 0x0f
    }
    fn fin(&self) -> bool {
        self.first & 0x80 != 0
    }
    fn rsv1(&self) -> bool {
        self.first & 0x40 != 0
    }
    fn total(&self) -> usize {
        self.header + self.payload
    }
}

/// The longest payload `ws` reads a 64-bit length as (`receiver.js` `getPayloadLength64`: 2^53 - 1, the largest
/// integer a JavaScript number holds exactly); a longer one is refused with 1009 before the length is used.
const MAX_DECLARED: u64 = (1 << 53) - 1;

/// The length a frame's header declares, and how many bytes of the header it takes beyond the first two, once those
/// bytes are in. A 64-bit length past [`MAX_DECLARED`] is refused here, before anything adds to it.
fn declared(bytes: &[u8]) -> Result<Option<(usize, u64)>, Fault> {
    if bytes.len() < 2 {
        return Ok(None);
    }
    Ok(match bytes[1] & 0x7f {
        126 if bytes.len() >= 4 => Some((2, u64::from(u16::from_be_bytes([bytes[2], bytes[3]])))),
        127 if bytes.len() >= 10 => {
            let length = u64::from_be_bytes(bytes[2..10].try_into().expect("eight bytes"));
            if length > MAX_DECLARED {
                return Err(fault(1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH", "Unsupported WebSocket frame: payload length > 2^53 - 1"));
            }
            Some((8, length))
        }
        126 | 127 => None,
        small => Some((0, u64::from(small))),
    })
}

/// The head of the frame at the start of `bytes`, once all of it has arrived. A payload past `limit` is 1009: `ws`'s
/// maxPayload bounds what is received (`receiver.js` `haveLength`), never what is sent.
fn parse(bytes: &[u8], limit: usize) -> Result<Option<Head>, Fault> {
    let Some((extra, payload)) = declared(bytes)? else { return Ok(None) };
    let masked = bytes[1] & 0x80 != 0;
    if payload > limit as u64 {
        return Err(fault(1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Max payload size exceeded"));
    }
    let header = 2 + extra + if masked { 4 } else { 0 };
    let head = Head { first: bytes[0], masked, header, payload: payload as usize };
    Ok((bytes.len() >= head.total()).then_some(head))
}

fn frame(first: u8, mask: Option<[u8; 4]>, payload: &[u8], out: &mut Vec<u8>) {
    out.push(first);
    let flag = if mask.is_some() { 0x80 } else { 0 };
    match payload.len() {
        n if n < 126 => out.push(flag | n as u8),
        n if n <= u16::MAX as usize => {
            out.push(flag | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(flag | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    match mask {
        Some(key) => {
            out.extend_from_slice(&key);
            out.extend(payload.iter().enumerate().map(|(i, b)| b ^ key[i % 4]));
        }
        None => out.extend_from_slice(payload),
    }
}

/// The window a raw deflate stream is run with: zlib lifts 8 to 9 (Node does the same, `zlib.js`).
fn window(bits: u8) -> u8 {
    bits.max(9)
}

/// Inflates `data` (a fragment, with the trailer appended by the caller for the last one) onto `out`, which never
/// grows past `limit`: the bound is checked every [`STEP`] bytes of output, while it inflates.
fn inflate(decoder: &mut Decompress, data: &[u8], out: &mut Vec<u8>, limit: usize) -> Result<(), Fault> {
    let mut input = data;
    loop {
        out.reserve(STEP);
        let (read, wrote) = (decoder.total_in(), decoder.total_out());
        let status = decoder.decompress_vec(input, out, FlushDecompress::Sync).map_err(|e| fault(1007, "Z_DATA_ERROR", e.message().map_or_else(|| e.to_string(), str::to_owned)))?;
        input = &input[(decoder.total_in() - read) as usize..];
        if out.len() > limit {
            return Err(fault(1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Max payload size exceeded"));
        }
        if status == Status::StreamEnd {
            // The server ended its deflate stream (a final block): the next message starts a new one.
            decoder.reset(false);
            return Ok(());
        }
        if input.is_empty() && out.len() < out.capacity() {
            return Ok(());
        }
        if decoder.total_in() == read && decoder.total_out() == wrote {
            return Err(fault(1007, "Z_DATA_ERROR", "invalid deflate stream"));
        }
    }
}

/// `data` deflated and flushed, without the trailing `00 00 ff ff` (`permessage-deflate.js` `_compress`).
fn deflate(encoder: &mut Compress, data: &[u8]) -> Result<Vec<u8>, Fault> {
    let mut input = data;
    let mut out = Vec::with_capacity(data.len() / 2 + 64);
    loop {
        out.reserve(STEP);
        let before = encoder.total_in();
        encoder.compress_vec(input, &mut out, FlushCompress::Sync).map_err(|e| fault(1011, "", e.to_string()))?;
        input = &input[(encoder.total_in() - before) as usize..];
        if input.is_empty() && out.len() < out.capacity() {
            break;
        }
    }
    out.truncate(out.len().saturating_sub(TAIL.len()));
    if out.is_empty() {
        // An empty message after a flush produces no output here; `ws` sends the single byte RFC 7692 7.2.3.6 names,
        // an empty stored block once the trailer is put back.
        out.push(0);
    }
    Ok(out)
}

/// The data message being received, between its first and last frame.
struct Message {
    opcode: u8,
    compressed: bool,
    /// Payload bytes received so far, and (compressed) what they inflated to.
    received: usize,
    plain: Vec<u8>,
    /// A plain text message's UTF-8, judged as its fragments pass and refused when it is complete.
    text: Utf8,
}

/// UTF-8 checked across fragments: the bytes of a character cut by a fragment boundary wait for the next one. `ws`
/// judges a text message when it is complete (`receiver.js` `dataMessage`: `isValidUTF8(buf)`, 1007), so a violation
/// found early is only reported at the last fragment.
#[derive(Default)]
struct Utf8 {
    carry: Vec<u8>,
    bad: bool,
}

impl Utf8 {
    fn feed(&mut self, bytes: &[u8]) {
        if self.bad {
            return;
        }
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(bytes);
        if let Err(error) = std::str::from_utf8(&data) {
            match error.error_len() {
                Some(_) => self.bad = true,
                None => self.carry = data[error.valid_up_to()..].to_vec(),
            }
        }
    }

    fn whole(&self) -> bool {
        !self.bad && self.carry.is_empty()
    }
}

pub struct Codec {
    /// False when the server did not accept the offer: frames are still checked, and RSV1 is then a violation.
    negotiated: bool,
    extension: Extension,
    decoder: Decompress,
    encoder: Compress,
    message: Option<Message>,
    /// A close frame has come from the server, and one has gone to it: `ws` then ends its side of the TCP stream
    /// (`websocket.js` `close`: `_closeFrameSent && _closeFrameReceived` → `socket.end()`).
    close_received: bool,
    close_sent: bool,
}

/// `receiver.js` `controlMessage`: a close payload is empty, or a status code `ws` allows (`validation.js`
/// `isValidStatusCode`) followed by UTF-8; otherwise 1002 or 1007, and the connection is closed as for any violation.
fn check_close(payload: &[u8]) -> Result<(), Fault> {
    if payload.len() < 2 {
        return Ok(()); // empty; a single byte was refused at the header (`admit`)
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    let allowed = ((1000..=1014).contains(&code) && !matches!(code, 1004..=1006)) || (3000..=4999).contains(&code);
    if !allowed {
        return Err(fault(1002, "WS_ERR_INVALID_CLOSE_CODE", framed(format!("invalid status code {code}"))));
    }
    if std::str::from_utf8(&payload[2..]).is_err() {
        return Err(fault(1007, "WS_ERR_INVALID_UTF8", framed("invalid UTF-8 sequence")));
    }
    Ok(())
}

impl Codec {
    pub fn new(extension: Extension) -> Self {
        Self::with(true, extension)
    }

    /// No extension was negotiated; the frames are only checked.
    pub fn plain() -> Self {
        Self::with(false, Extension::default())
    }

    fn with(negotiated: bool, extension: Extension) -> Self {
        Self {
            negotiated,
            extension,
            decoder: Decompress::new_with_window_bits(false, window(extension.server_max_window_bits)),
            encoder: Compress::new_with_window_bits(Compression::default(), false, window(extension.client_max_window_bits)),
            message: None,
            close_received: false,
            close_sent: false,
        }
    }

    /// Judges a frame from its first two bytes, in the order of `ws`'s `getInfo` (`receiver.js:205-385`), so that a
    /// violation is refused as soon as the header shows it and not when the payload it declares has arrived.
    fn admit(&self, first: u8, second: u8) -> Result<(), Fault> {
        let (rsv1, fin, op, masked, marker) = (first & 0x40 != 0, first & 0x80 != 0, first & 0x0f, second & 0x80 != 0, second & 0x7f);
        if first & 0x30 != 0 {
            return Err(fault(1002, "WS_ERR_UNEXPECTED_RSV_2_3", framed("RSV2 and RSV3 must be clear")));
        }
        if rsv1 && !self.negotiated {
            return Err(fault(1002, "WS_ERR_UNEXPECTED_RSV_1", framed("RSV1 must be clear")));
        }
        match op {
            0 => {
                if rsv1 {
                    return Err(fault(1002, "WS_ERR_UNEXPECTED_RSV_1", framed("RSV1 must be clear")));
                }
                if self.message.is_none() {
                    return Err(fault(1002, "WS_ERR_INVALID_OPCODE", framed("invalid opcode 0")));
                }
            }
            1 | 2 => {
                if self.message.is_some() {
                    return Err(fault(1002, "WS_ERR_INVALID_OPCODE", framed(format!("invalid opcode {op}"))));
                }
            }
            8..=10 => {
                if !fin {
                    return Err(fault(1002, "WS_ERR_EXPECTED_FIN", framed("FIN must be set")));
                }
                if rsv1 {
                    return Err(fault(1002, "WS_ERR_UNEXPECTED_RSV_1", framed("RSV1 must be clear")));
                }
                // The 7-bit field is judged as it stands: 126 and 127 announce a longer length, over the limit of 125.
                if marker > 125 || (op == 8 && marker == 1) {
                    return Err(fault(1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH", framed(format!("invalid payload length {marker}"))));
                }
            }
            op => return Err(fault(1002, "WS_ERR_INVALID_OPCODE", framed(format!("invalid opcode {op}")))),
        }
        if masked {
            return Err(fault(1002, "WS_ERR_UNEXPECTED_MASK", framed("MASK must be clear")));
        }
        Ok(())
    }
    /// Translates every complete server frame of `raw` into `out`; a violation is returned with the frames before it
    /// already translated.
    pub fn inbound(&mut self, raw: &mut Vec<u8>, out: &mut Vec<u8>) -> Result<(), Fault> {
        loop {
            if raw.len() >= 2 {
                self.admit(raw[0], raw[1])?;
            }
            // `haveLength`: the message so far plus this frame's declared payload, judged before the payload arrives.
            if let Some((_, payload)) = declared(raw)? {
                let data = matches!(raw[0] & 0x0f, 0..=2);
                let so_far = self.message.as_ref().map_or(0, |m| m.received) as u64;
                if data && payload > 0 && so_far.checked_add(payload).is_none_or(|total| total > MAX_PAYLOAD as u64) {
                    return Err(fault(1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Max payload size exceeded"));
                }
            }
            let Some(head) = parse(raw, MAX_PAYLOAD)? else { break };
            let payload = &raw[head.header..head.total()];
            let op = head.opcode();
            if op >= 8 {
                if op == 8 {
                    check_close(payload)?;
                    self.close_received = true;
                }
                out.extend_from_slice(&raw[..head.total()]);
            } else {
                if op != 0 {
                    self.message = Some(Message { opcode: op, compressed: head.rsv1(), received: 0, plain: Vec::new(), text: Utf8::default() });
                }
                let message = self.message.as_mut().expect("a data frame belongs to a message");
                message.received += payload.len();
                if message.received > MAX_PAYLOAD {
                    return Err(fault(1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH", "Max payload size exceeded"));
                }
                if message.compressed {
                    let room = MAX_PAYLOAD;
                    if head.fin() {
                        let framed = [payload, &TAIL].concat();
                        inflate(&mut self.decoder, &framed, &mut message.plain, room)?;
                    } else {
                        inflate(&mut self.decoder, payload, &mut message.plain, room)?;
                    }
                    if head.fin() {
                        if self.extension.server_no_context_takeover {
                            self.decoder.reset(false);
                        }
                        let done = self.message.take().expect("the message just read");
                        if done.opcode == 1 && std::str::from_utf8(&done.plain).is_err() {
                            return Err(fault(1007, "WS_ERR_INVALID_UTF8", framed("invalid UTF-8 sequence")));
                        }
                        frame(0x80 | done.opcode, None, &done.plain, out);
                    }
                } else {
                    if message.opcode == 1 {
                        message.text.feed(payload);
                        if head.fin() && !message.text.whole() {
                            return Err(fault(1007, "WS_ERR_INVALID_UTF8", framed("invalid UTF-8 sequence")));
                        }
                    }
                    // A text message already known to be invalid is held back: the next layer judges each fragment
                    // as it comes and would fail the socket before ws does, at the last one.
                    if !(message.opcode == 1 && message.text.bad) {
                        out.extend_from_slice(&raw[..head.total()]);
                    }
                    if head.fin() {
                        self.message = None;
                    }
                }
            }
            raw.drain(..head.total());
        }
        Ok(())
    }

    /// Translates every complete client frame of `raw` into `out`.
    pub fn outbound(&mut self, raw: &mut Vec<u8>, out: &mut Vec<u8>) -> Result<(), Fault> {
        // Outbound frames are not bounded by ws's inbound maxPayload. Without the extension they pass unchanged; they
        // are still read, for the close frame.
        while let Some(head) = parse(raw, usize::MAX)? {
            if head.opcode() == 8 {
                self.close_sent = true;
            }
            let single = self.negotiated && head.fin() && (head.opcode() == 1 || head.opcode() == 2) && head.first & 0x70 == 0 && head.masked;
            let small = self.extension.client_no_context_takeover && head.payload < THRESHOLD;
            if single && !small {
                let key: [u8; 4] = raw[head.header - 4..head.header].try_into().expect("four bytes");
                let plain: Vec<u8> = raw[head.header..head.total()].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
                let packed = deflate(&mut self.encoder, &plain)?;
                if self.extension.client_no_context_takeover {
                    self.encoder.reset();
                }
                frame(head.first | 0x40, Some(key), &packed, out);
            } else {
                out.extend_from_slice(&raw[..head.total()]);
            }
            raw.drain(..head.total());
        }
        Ok(())
    }
}

/// The close frame `ws` sends on a violation (`websocket.close(code)`): masked, the code alone.
fn close_frame(code: u16) -> io::Result<Vec<u8>> {
    let mut mask = [0u8; 4];
    ring::rand::SystemRandom::new().fill(&mut mask).map_err(|_| io::Error::other("no random bytes for a mask"))?;
    let mut out = Vec::new();
    frame(0x88, Some(mask), &code.to_be_bytes(), &mut out);
    Ok(out)
}

/// The error a violation fails the stream with; the [`Fault`] inside it is what [`violation_of`] reads back.
fn failure(fault: &Fault) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, fault.clone())
}

/// The protocol violation `error` reports, when it is one this stream found.
pub fn violation_of(error: &io::Error) -> Option<&Fault> {
    error.get_ref()?.downcast_ref::<Fault>()
}

/// The stream under a WebSocket; see the module.
pub struct WsIo<S> {
    inner: S,
    /// Bytes the server sent behind its upgrade answer, before anything else.
    early: Vec<u8>,
    codec: Box<Codec>,
    /// Inbound bytes not yet a whole frame, and the translated ones not yet taken.
    in_raw: Vec<u8>,
    in_ready: Vec<u8>,
    in_taken: usize,
    /// Outbound bytes not yet a whole frame, and the translated ones not yet written.
    out_raw: Vec<u8>,
    out_ready: Vec<u8>,
    /// The violation that ended the connection: every later read fails with it, and a later write is refused, so a
    /// connection whose deflate state is no longer the server's is never used again.
    failed: Option<Fault>,
    /// The close frame of a violation is queued, and the closing it starts is not over.
    closing: bool,
    /// This side of the stream has been shut down after the close handshake.
    ended: bool,
}

impl<S> WsIo<S> {
    pub fn new(inner: S, early: Vec<u8>, extension: Option<Extension>) -> Self {
        Self {
            inner,
            early,
            codec: Box::new(extension.map_or_else(Codec::plain, Codec::new)),
            in_raw: Vec::new(),
            in_ready: Vec::new(),
            in_taken: 0,
            out_raw: Vec::new(),
            out_ready: Vec::new(),
            failed: None,
            closing: false,
            ended: false,
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for WsIo<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        loop {
            if this.in_taken < this.in_ready.len() {
                let n = (this.in_ready.len() - this.in_taken).min(buf.remaining());
                buf.put_slice(&this.in_ready[this.in_taken..this.in_taken + n]);
                this.in_taken += n;
                if this.in_taken == this.in_ready.len() {
                    this.in_ready.clear();
                    this.in_taken = 0;
                }
                return Poll::Ready(Ok(()));
            }
            // `ws` emits the receiver's error at once (`receiverOnError`) and lets its close frame go out behind it; the
            // close is finished by [`poll_flush`](AsyncWrite::poll_flush), which the owner bounds by [CLOSE_FLUSH].
            if let Some(violation) = this.failed.clone() {
                return Poll::Ready(Err(failure(&violation)));
            }
            if !this.early.is_empty() {
                this.in_raw.append(&mut this.early);
            } else {
                let mut chunk = [0u8; 16 * 1024];
                let mut read = ReadBuf::new(&mut chunk);
                std::task::ready!(Pin::new(&mut this.inner).poll_read(cx, &mut read))?;
                if read.filled().is_empty() {
                    return Poll::Ready(Ok(()));
                }
                this.in_raw.extend_from_slice(read.filled());
            }
            if let Err(violation) = this.codec.inbound(&mut this.in_raw, &mut this.in_ready) {
                // The frames before the violation are still delivered; the close frame goes out on the way.
                this.in_raw.clear();
                this.out_ready.extend_from_slice(&close_frame(violation.code)?);
                this.closing = true;
                this.failed = Some(violation);
            }
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> WsIo<S> {
    /// The closing a violation starts, as `ws` runs it: the close frame goes out behind what was already queued, the
    /// stream's write side ends once it is out (`close`: `_closeFrameSent` with the receiver's error emitted →
    /// `socket.end()`), and what the server still sends is read and dropped until it ends its side
    /// (`receiverOnError`: `resume(socket)`; `socketOnEnd`). Ready when the server's end has come; the owner gives up
    /// at [CLOSE_FLUSH] (`setCloseTimer`: `socket.destroy()`).
    fn poll_close_after_violation(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if !self.ended {
            std::task::ready!(self.drain(cx))?;
            std::task::ready!(Pin::new(&mut self.inner).poll_flush(cx))?;
            std::task::ready!(Pin::new(&mut self.inner).poll_shutdown(cx))?;
            self.ended = true;
        }
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let mut read = ReadBuf::new(&mut chunk);
            std::task::ready!(Pin::new(&mut self.inner).poll_read(cx, &mut read))?;
            if read.filled().is_empty() {
                self.closing = false;
                return Poll::Ready(Ok(()));
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> WsIo<S> {
    fn drain(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.out_ready.is_empty() {
            let n = std::task::ready!(Pin::new(&mut self.inner).poll_write(cx, &self.out_ready))?;
            if n == 0 {
                return Poll::Ready(Err(io::ErrorKind::WriteZero.into()));
            }
            self.out_ready.drain(..n);
        }
        Poll::Ready(Ok(()))
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for WsIo<S> {
    fn poll_write(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        if let Some(violation) = &this.failed {
            return Poll::Ready(Err(failure(violation)));
        }
        this.out_raw.extend_from_slice(buf);
        if let Err(violation) = this.codec.outbound(&mut this.out_raw, &mut this.out_ready) {
            this.out_raw.clear();
            let error = failure(&violation);
            this.failed = Some(violation);
            return Poll::Ready(Err(error));
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.closing {
            return self.poll_close_after_violation(cx);
        }
        std::task::ready!(self.drain(cx))?;
        std::task::ready!(Pin::new(&mut self.inner).poll_flush(cx))?;
        // The close handshake is complete on this side once both close frames have passed and ours is out: `ws` ends
        // its side of the stream then (its FIN), and leaves the rest of the connection to the server or its timer.
        if self.codec.close_sent && self.codec.close_received && !self.ended {
            std::task::ready!(Pin::new(&mut self.inner).poll_shutdown(cx))?;
            self.ended = true;
        }
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        std::task::ready!(self.drain(cx))?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Recorded from `ws` 8.22.0 itself (`ws-deflate-vectors.mjs`).
    fn vectors() -> Value {
        let text = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/ws-deflate-vectors.json"));
        serde_json::from_str(text).unwrap()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn plain_of(message: &Value) -> Vec<u8> {
        match message["hex"].as_str() {
            Some(hex) => unhex(hex),
            None => message["text"].as_str().unwrap().as_bytes().to_vec(),
        }
    }

    #[test]
    fn the_answers_ws_negotiates_are_read_as_ws_reads_them() {
        for case in vectors()["cases"].as_array().unwrap() {
            let extension = Extension::parse(case["response"].as_str()).unwrap().unwrap();
            let params = &case["params"];
            assert_eq!(extension.client_no_context_takeover, params["client_no_context_takeover"] == true, "{}", case["name"]);
            assert_eq!(extension.server_no_context_takeover, params["server_no_context_takeover"] == true, "{}", case["name"]);
            assert_eq!(u64::from(extension.client_max_window_bits), params["client_max_window_bits"].as_u64().unwrap_or(15), "{}", case["name"]);
            assert_eq!(u64::from(extension.server_max_window_bits), params["server_max_window_bits"].as_u64().unwrap_or(15), "{}", case["name"]);
        }
        assert_eq!(Extension::parse(None), Ok(None));
        for bad in [
            "", "x-webkit-deflate-frame", "permessage-deflate; bogus", "permessage-deflate; client_max_window_bits",
            "permessage-deflate; client_max_window_bits=7", "permessage-deflate; server_max_window_bits=16",
            "permessage-deflate; client_no_context_takeover; client_no_context_takeover",
            "permessage-deflate; server_max_window_bits=9; server_max_window_bits=10",
            "permessage-deflate; client_no_context_takeover=1", "permessage-deflate, other", "permessage-deflate;", "a b",
        ] {
            assert!(Extension::parse(Some(bad)).is_err(), "{bad:?} is refused");
        }
        // Several configurations: the first is used (`acceptAsClient` reads `response[0]`).
        let first = Extension::parse(Some("permessage-deflate; client_max_window_bits=10, permessage-deflate")).unwrap().unwrap();
        assert_eq!(first.client_max_window_bits, 10);
        assert_eq!(Extension::parse(Some("permessage-deflate; server_max_window_bits=\"11\"")).unwrap().unwrap().server_max_window_bits, 11);
    }

    #[test]
    fn what_ws_sends_is_read_as_the_same_messages_in_every_negotiation() {
        for case in vectors()["cases"].as_array().unwrap() {
            let mut codec = Codec::new(Extension::parse(case["response"].as_str()).unwrap().unwrap());
            for message in case["server"]["messages"].as_array().unwrap() {
                let mut out = Vec::new();
                for wire in message["frames"].as_array().unwrap() {
                    let mut raw = unhex(wire.as_str().unwrap());
                    codec.inbound(&mut raw, &mut out).unwrap();
                    assert!(raw.is_empty());
                }
                // One plain frame, or (a message ws sent uncompressed in fragments) its fragments unchanged.
                let mut joined = Vec::new();
                while let Some(head) = parse(&out, MAX_PAYLOAD).unwrap() {
                    assert_eq!(head.first & 0x70, 0, "no RSV bits reach tungstenite");
                    joined.extend_from_slice(&out[head.header..head.total()]);
                    out.drain(..head.total());
                }
                assert_eq!(joined, plain_of(message), "{} / {}", case["name"], message["name"]);
            }
        }
    }

    #[test]
    fn what_we_send_is_what_ws_sends_in_every_negotiation() {
        let mut all = Vec::new();
        for case in vectors()["cases"].as_array().unwrap() {
            let mut codec = Codec::new(Extension::parse(case["response"].as_str()).unwrap().unwrap());
            let mut server = Decompress::new_with_window_bits(false, window(codec.extension.client_max_window_bits));
            let mut sent = Vec::new();
            for message in case["client"]["messages"].as_array().unwrap() {
                let plain = plain_of(message);
                let parts: Vec<&[u8]> = if message["frames"].as_array().unwrap().len() == 2 {
                    vec![&plain[..700], &plain[700..]]
                } else {
                    vec![&plain[..]]
                };
                if parts.len() == 2 {
                    // tungstenite sends whole messages; a fragmented one goes through unchanged and uncompressed.
                    continue;
                }
                let binary = message["hex"].is_string();
                let mut raw = Vec::new();
                frame(if binary { 0x82 } else { 0x81 }, Some([1, 2, 3, 4]), parts[0], &mut raw);
                let mut out = Vec::new();
                codec.outbound(&mut raw, &mut out).unwrap();
                let recorded = unhex(message["frames"][0].as_str().unwrap());
                assert_eq!(out[0] & 0x40, recorded[0] & 0x40, "compressed or not, {} / {}", case["name"], message["name"]);
                assert_eq!(out[1] & 0x80, recorded[1] & 0x80, "masked");
                // Whole frames, where ws's bytes are the same for the same input: a deflate stream with no history, which is
                // every message when the client's context does not carry over, the first ones of a stream, and ones that
                // do not compress or are empty. Where a message refers back to earlier ones the match zlib picks differs
                // from zlib-rs's (valid either way), so only the meaning is compared there.
                let name = message["name"].as_str().unwrap();
                let deterministic = codec.extension.client_no_context_takeover || ["small text", "medium text", "binary noise", "empty text"].contains(&name);
                if deterministic {
                    assert_eq!(hexed(&out), hexed(&recorded), "{} / {name}: ws's bytes", case["name"]);
                }
                // The bytes of a later message differ with the deflate backend (zlib-rs here, zlib there) but not
                // in meaning: an independent server-side stream reads them back.
                let head = parse(&out, MAX_PAYLOAD).unwrap().unwrap();
                let key: [u8; 4] = out[head.header - 4..head.header].try_into().unwrap();
                let body: Vec<u8> = out[head.header..].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
                let read = if out[0] & 0x40 != 0 {
                    let mut got = Vec::new();
                    inflate(&mut server, &[&body[..], &TAIL].concat(), &mut got, MAX_PAYLOAD).unwrap_or_else(|e| panic!("{} / {}: {e:?}, {} bytes", case["name"], message["name"], body.len()));
                    if codec.extension.client_no_context_takeover {
                        server.reset(false);
                    }
                    got
                } else {
                    body
                };
                assert_eq!(read, plain, "{} / {}", case["name"], message["name"]);
                sent.push(hexed(&out));
            }
            all.push(serde_json::json!({ "name": case["name"], "response": case["response"], "frames": sent }));
        }
        // ws-deflate-verify.mjs reads this and has ws's own receiver take the frames.
        if let Ok(out) = std::env::var("MIXDOG_WS_OUT") {
            std::fs::write(out, serde_json::to_string(&all).unwrap()).unwrap();
        }
        // What ws's receiver read when it took these frames (`ws-deflate-verify.mjs --out`): the frames written now are
        // the ones it read, whole and in order, and it read each as the message sent.
        let read: Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/ws-read-rust.json"))).unwrap();
        let vectors_text = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/ws-deflate-vectors.json"));
        let digest: String = <sha2::Sha256 as sha2::Digest>::digest(vectors_text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(read["manifest"]["vectorsSha256"], digest.as_str(), "ws read the frames of other vectors");
        assert_eq!(read["manifest"]["ws"], "8.22.0");
        let cases = read["cases"].as_array().unwrap();
        assert_eq!(cases.len(), all.len(), "ws read as many negotiations as are written");
        for (ws, ours) in cases.iter().zip(&all) {
            assert_eq!(ws["name"], ours["name"]);
            assert_eq!(ws["response"], ours["response"], "{}", ours["name"]);
            assert_eq!(ws["frames"], ours["frames"], "{}: the frames ws read", ours["name"]);
            let sent: Vec<Value> = vectors()["cases"].as_array().unwrap().iter().find(|c| c["name"] == ours["name"]).unwrap()["client"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["frames"].as_array().unwrap().len() == 1)
                .map(|m| Value::String(hexed(&plain_of(m))))
                .collect();
            assert_eq!(ws["read"], Value::Array(sent), "{}: ws read the messages sent", ours["name"]);
        }
    }

    fn hexed(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn what_ws_refuses_is_refused_with_the_close_code_ws_uses() {
        for negative in vectors()["negatives"].as_array().unwrap() {
            let name = negative["name"].as_str().unwrap();
            let mut codec = if negative["extension"] == false { Codec::plain() } else { Codec::new(Extension::default()) };
            let mut out = Vec::new();
            let mut outcome = Ok(());
            for wire in negative["frames"].as_array().unwrap() {
                let mut raw = unhex(wire.as_str().unwrap());
                outcome = codec.inbound(&mut raw, &mut out);
                if outcome.is_err() {
                    break;
                }
            }
            // The error ws's receiver emits, whole: its message, its code and the close code it answers with.
            let refused = outcome.expect_err(name);
            let rust = serde_json::json!({ "message": refused.text, "code": refused.ws_code, "closeCode": refused.code });
            assert_eq!(rust, negative["result"]["error"], "{name}");
        }
    }

    // Sequences that look wrong and that `ws` accepts: a plain message ahead of a compressed one, and a ping inside a
    // fragmented compressed message. The messages come out as `ws` reads them.
    #[test]
    fn what_ws_accepts_is_accepted_and_read_as_the_same_messages() {
        for accepted in vectors()["accepted"].as_array().unwrap() {
            let name = accepted["name"].as_str().unwrap();
            let mut codec = Codec::new(Extension::default());
            let mut out = Vec::new();
            for wire in accepted["frames"].as_array().unwrap() {
                codec.inbound(&mut unhex(wire.as_str().unwrap()), &mut out).unwrap_or_else(|f| panic!("{name}: {f:?}"));
            }
            let mut got = Vec::new();
            while let Some(head) = parse(&out, MAX_PAYLOAD).unwrap() {
                got.push((head.opcode(), hexed(&out[head.header..head.total()])));
                out.drain(..head.total());
            }
            let expected: Vec<(u8, String)> = accepted["result"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| if m["ping"] == true { (9, hexed(b"p")) } else { (if m["binary"] == true { 2 } else { 1 }, m["hex"].as_str().unwrap().to_owned()) })
                .collect();
            let got: Vec<(u8, String)> = got.into_iter().filter(|(op, _)| *op != 0).collect();
            assert_eq!(got, expected, "{name}");
        }
    }

    #[test]
    fn plain_messages_around_a_compressed_one_pass_in_order() {
        let vectors = vectors();
        let case = vectors["accepted"].as_array().unwrap().iter().find(|n| n["name"] == "plain text and a compressed message after it").unwrap();
        let mut codec = Codec::new(Extension::default());
        let mut out = Vec::new();
        for wire in case["frames"].as_array().unwrap() {
            codec.inbound(&mut unhex(wire.as_str().unwrap()), &mut out).unwrap();
        }
        let first = parse(&out, MAX_PAYLOAD).unwrap().unwrap();
        assert_eq!(&out[first.header..first.total()], b"plain");
    }
    #[test]
    fn a_message_is_bounded_while_it_inflates() {
        let mut codec = Codec::new(Extension::default());
        let mut encoder = Compress::new(Compression::default(), false);
        let bomb = deflate(&mut encoder, &vec![0u8; MAX_PAYLOAD + (1 << 20)]).unwrap();
        assert!(bomb.len() < MAX_PAYLOAD / 100);
        let mut raw = Vec::new();
        frame(0xc1, None, &bomb, &mut raw);
        let outcome = codec.inbound(&mut raw, &mut Vec::new());
        assert_eq!(outcome.unwrap_err().code, 1009);
    }

    const WITHIN: std::time::Duration = std::time::Duration::from_secs(20);

    // W3: the read fails at once with the violation (`receiverOnError` emits it before the close goes out), and every
    // later read with it. The flush then runs the close as ws does: the close frame, flushed through a stream that
    // holds what it is given until it is flushed (TLS does; a `BufWriter` stands for it), then this side's end, then
    // what the server still sends is dropped until it ends its side.
    #[tokio::test]
    async fn a_violation_fails_the_read_at_once_and_the_flush_runs_the_close() {
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;
        let (near, mut far) = tokio::io::duplex(1 << 16);
        let mut ws = WsIo::new(tokio::io::BufWriter::new(near), Vec::new(), Some(Extension::default()));
        let mut rsv2 = Vec::new();
        frame(0xa1, None, b"x", &mut rsv2);
        far.write_all(&rsv2).await.unwrap();
        let mut byte = [0u8; 1];
        let error = tokio::time::timeout(WITHIN, ws.read(&mut byte)).await.expect("the read fails within 20 s").unwrap_err();
        let refused = violation_of(&error).expect("the violation travels in the error");
        assert_eq!((refused.code, refused.ws_code, refused.text.as_str()), (1002, "WS_ERR_UNEXPECTED_RSV_2_3", "Invalid WebSocket frame: RSV2 and RSV3 must be clear"));
        assert!(ws.read(&mut byte).await.is_err(), "and every later read");
        let mut flush = Box::pin(ws.flush());
        assert!(futures::poll!(flush.as_mut()).is_pending(), "the close is not over while the server's side is open");
        let mut sent = Vec::new();
        tokio::time::timeout(WITHIN, far.read_to_end(&mut sent)).await.expect("the close and this side's end within 20 s").unwrap();
        assert_eq!(sent.len(), 8, "{sent:02x?}");
        assert_eq!(&sent[..2], [0x88, 0x82], "a masked close with the code alone");
        assert_eq!(u16::from_be_bytes([sent[6] ^ sent[2], sent[7] ^ sent[3]]), 1002);
        // What the server sends meanwhile is dropped; its end finishes the close.
        far.write_all(b"after").await.unwrap();
        far.shutdown().await.unwrap();
        tokio::time::timeout(WITHIN, flush).await.expect("the close is over within 20 s of the server's end").unwrap();
    }

    // W4: the buffer the inflater grows is bounded while it inflates. A bomb that expands to 64 times the limit leaves
    // a buffer that never reached the size of the whole expansion (a Vec grows by doubling, so twice the limit and a
    // step is the most it may hold).
    #[test]
    fn the_inflaters_own_buffer_stops_growing_at_the_limit() {
        let limit = 1 << 20;
        let mut encoder = Compress::new(Compression::default(), false);
        let bomb = deflate(&mut encoder, &vec![0u8; 64 * limit]).unwrap();
        let mut decoder = Decompress::new(false);
        let mut out = Vec::new();
        let outcome = inflate(&mut decoder, &[&bomb[..], &TAIL].concat(), &mut out, limit);
        assert_eq!(outcome.unwrap_err().code, 1009);
        assert!(out.capacity() <= 2 * (limit + STEP), "{} bytes allocated for a limit of {limit}", out.capacity());
    }

    // W1: `ws`'s maxPayload bounds what is received; a message to send may be any size.
    #[test]
    fn an_outgoing_message_past_the_receive_limit_is_sent_compressed() {
        let mut codec = Codec::new(Extension::default());
        let plain = vec![b'a'; MAX_PAYLOAD + 1024];
        let mut raw = Vec::new();
        frame(0x81, Some([1, 2, 3, 4]), &plain, &mut raw);
        let mut out = Vec::new();
        codec.outbound(&mut raw, &mut out).unwrap();
        assert!(raw.is_empty());
        assert_eq!(out[0], 0xc1, "compressed, final");
    }

    // W2: a violation is refused at the header, with `ws`'s close code, before the payload it declares arrives.
    #[test]
    fn a_header_that_shows_a_violation_is_refused_without_its_payload() {
        for (name, header, code) in [
            ("a fragmented ping that declares 64 KiB", vec![0x09, 0x7e, 0xff, 0xff], 1002),
            ("a ping that declares more than 125", vec![0x89, 0x7e], 1002),
            ("a close with a one byte payload", vec![0x88, 0x01], 1002),
            ("a reserved opcode", vec![0x83, 0x00], 1002),
            ("RSV3", vec![0x91, 0x00], 1002),
            ("a masked frame", vec![0x81, 0x80], 1002),
            ("a text frame declaring more than the limit", vec![0x81, 0x7f, 0, 0, 0, 0, 0x02, 0, 0, 0], 1009),
        ] {
            let mut codec = Codec::new(Extension::default());
            let outcome = codec.inbound(&mut header.clone(), &mut Vec::new());
            assert_eq!(outcome.unwrap_err().code, code, "{name}");
        }
        // A continuation that takes the message past the limit is refused when its header comes.
        let mut codec = Codec::new(Extension::default());
        let mut raw = Vec::new();
        frame(0x01, None, &vec![b'a'; MAX_PAYLOAD - 10], &mut raw);
        let mut out = Vec::new();
        codec.inbound(&mut raw, &mut out).unwrap();
        let outcome = codec.inbound(&mut vec![0x80, 0x7e, 0x00, 0x20], &mut out);
        assert_eq!(outcome.unwrap_err().code, 1009);
    }

    // W6: a send and a receive in flight on one connection. The 64 byte pipe stops the send of a 200 KB message until
    // the far side reads; the far side first writes its own two messages, which the client must read while its send
    // is stuck (the gate: the far side reads nothing until both have been written), and only then reads the client's.
    // Both directions' deflate contexts carry over from the first message to the second, so a shifted context would
    // fail the second message in either direction.
    #[tokio::test]
    async fn a_send_stuck_on_a_full_socket_does_not_hold_up_a_receive_and_neither_shifts_a_deflate_context() {
        use futures::SinkExt;
        use futures::StreamExt;
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;
        use tokio_tungstenite::tungstenite::Message;
        const WITHIN: std::time::Duration = std::time::Duration::from_secs(20);
        let text = |seed: usize| -> String { (0..4000).map(|i| format!("{{\"n\":{},\"s\":{}}}", i * seed % 977, seed)).collect() };
        let (client_messages, server_messages) = ([text(3), text(5)], [text(7), text(11)]);
        let (near, mut far) = tokio::io::duplex(64);
        let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
            WsIo::new(near, Vec::new(), Some(Extension::default())),
            tokio_tungstenite::tungstenite::protocol::Role::Client,
            None,
        )
        .await;
        let (mut sink, mut stream) = socket.split();
        let sending = client_messages.clone();
        let sender = tokio::spawn(async move {
            for message in sending {
                sink.send(Message::text(message)).await.unwrap();
            }
        });
        let receiver = tokio::spawn(async move {
            let mut got = Vec::new();
            for _ in 0..2 {
                match stream.next().await.unwrap().unwrap() {
                    Message::Text(text) => got.push(text.to_string()),
                    other => panic!("{other:?}"),
                }
            }
            got
        });
        // The server's side, in the order the gate fixes.
        let mut encoder = Compress::new(Compression::default(), false);
        for message in &server_messages {
            let packed = deflate(&mut encoder, message.as_bytes()).unwrap();
            let mut wire = Vec::new();
            frame(0xc1, None, &packed, &mut wire);
            tokio::time::timeout(WITHIN, far.write_all(&wire)).await.expect("the client reads while its send is stuck").unwrap();
        }
        assert_eq!(tokio::time::timeout(WITHIN, receiver).await.unwrap().unwrap(), server_messages);
        let mut decoder = Decompress::new(false);
        let (mut raw, mut chunk, mut read_back) = (Vec::new(), [0u8; 8192], Vec::new());
        while read_back.len() < 2 {
            let n = tokio::time::timeout(WITHIN, far.read(&mut chunk)).await.expect("the stuck send goes on once the far side reads").unwrap();
            assert!(n > 0, "the client closed");
            raw.extend_from_slice(&chunk[..n]);
            while let Some(head) = parse(&raw, usize::MAX).unwrap() {
                let key: [u8; 4] = raw[head.header - 4..head.header].try_into().unwrap();
                let body: Vec<u8> = raw[head.header..head.total()].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
                assert_eq!(head.first, 0xc1, "compressed and final");
                let mut plain = Vec::new();
                inflate(&mut decoder, &[&body[..], &TAIL].concat(), &mut plain, usize::MAX).unwrap();
                read_back.push(String::from_utf8(plain).unwrap());
                raw.drain(..head.total());
            }
        }
        tokio::time::timeout(WITHIN, sender).await.expect("the sender ends within 20 s").unwrap();
        assert_eq!(read_back, client_messages);
    }
}