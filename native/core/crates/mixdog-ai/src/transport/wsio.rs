//! The byte stream a WebSocket runs on: the bytes the server sent after its upgrade answer, and, when the server
//! accepted the `permessage-deflate` offer, the translation tungstenite (which has no deflate) needs.
//!
//! Inbound, a compressed message (RSV1 on its first frame) is inflated and handed on as one plain frame; every other
//! frame passes unchanged. Outbound, a data message of at least [`THRESHOLD`] bytes is deflated and sent with RSV1
//! (what `ws` does: `sender.js:382`, `permessage-deflate.js:56-57`); smaller ones and control frames pass unchanged.
//! Without the extension this is a plain pass-through.

use std::io;
use std::pin::Pin;
use std::task::Context;
use std::task::Poll;

use flate2::Compress;
use flate2::Compression;
use flate2::Decompress;
use flate2::FlushCompress;
use flate2::FlushDecompress;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::ReadBuf;

/// `ws`'s default `threshold` for compressing an outgoing message.
const THRESHOLD: usize = 1024;
/// The largest message the translation will hold (tungstenite's own default limit).
const MAX_MESSAGE: usize = 64 << 20;
/// The bytes `Z_SYNC_FLUSH` ends a deflate block with; the extension leaves them off the wire.
const TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];

/// What the server accepted of the offer `permessage-deflate; client_max_window_bits`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extension {
    pub server_no_context_takeover: bool,
    pub client_no_context_takeover: bool,
    /// The server narrowed the client's window: outgoing messages then go uncompressed (always valid), because the
    /// deflate backend cannot be asked for a smaller window.
    pub client_window_limited: bool,
}

impl Extension {
    /// Reads the `Sec-WebSocket-Extensions` answer. `Ok(None)` is no extension; an extension other than the one
    /// offered, or a parameter that is not the RFC 7692 ones, is an error (`ws` aborts the handshake on both).
    pub fn parse(value: Option<&str>) -> Result<Option<Self>, String> {
        let Some(value) = value else { return Ok(None) };
        if value.trim().is_empty() {
            return Ok(None);
        }
        let mut offers = value.split(',');
        let first = offers.next().unwrap_or_default();
        if offers.next().is_some() {
            return Err("Server indicated more than one extension".into());
        }
        let mut parts = first.split(';').map(str::trim);
        if parts.next() != Some("permessage-deflate") {
            return Err(format!("Server indicated an extension that was not requested: {first}"));
        }
        let mut extension = Self::default();
        for param in parts {
            let (name, argument) = match param.split_once('=') {
                Some((name, argument)) => (name.trim(), Some(argument.trim().trim_matches('"'))),
                None => (param, None),
            };
            match (name, argument) {
                ("server_no_context_takeover", None) => extension.server_no_context_takeover = true,
                ("client_no_context_takeover", None) => extension.client_no_context_takeover = true,
                ("server_max_window_bits", Some(bits)) if bits.parse::<u8>().is_ok_and(|b| (8..=15).contains(&b)) => {}
                ("client_max_window_bits", Some(bits)) if bits.parse::<u8>().is_ok_and(|b| (8..=15).contains(&b)) => {
                    extension.client_window_limited = bits != "15";
                }
                _ => return Err(format!("Unknown extension parameter: {param}")),
            }
        }
        Ok(Some(extension))
    }
}

fn corrupt(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_owned())
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

/// The head of the frame at the start of `bytes`, once all of it has arrived.
fn parse(bytes: &[u8]) -> io::Result<Option<Head>> {
    if bytes.len() < 2 {
        return Ok(None);
    }
    let masked = bytes[1] & 0x80 != 0;
    let (extra, payload) = match bytes[1] & 0x7f {
        126 if bytes.len() >= 4 => (2, u16::from_be_bytes([bytes[2], bytes[3]]) as u64),
        127 if bytes.len() >= 10 => (8, u64::from_be_bytes(bytes[2..10].try_into().expect("eight bytes"))),
        126 | 127 => return Ok(None),
        small => (0, u64::from(small)),
    };
    if payload > MAX_MESSAGE as u64 {
        return Err(corrupt("frame beyond the message limit"));
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

fn inflate(decoder: &mut Decompress, data: &[u8]) -> io::Result<Vec<u8>> {
    let mut input = [data, &TAIL].concat();
    let mut out = Vec::with_capacity(data.len().saturating_mul(4).max(256));
    loop {
        out.reserve(out.capacity().max(4096));
        let before = decoder.total_in();
        decoder.decompress_vec(&input, &mut out, FlushDecompress::Sync).map_err(|e| corrupt(&e.to_string()))?;
        let used = (decoder.total_in() - before) as usize;
        input.drain(..used);
        if out.len() > MAX_MESSAGE {
            return Err(corrupt("inflated message beyond the limit"));
        }
        if input.is_empty() && out.len() < out.capacity() {
            return Ok(out);
        }
        if used == 0 && out.len() < out.capacity() {
            return Err(corrupt("deflate stream stalled"));
        }
    }
}

fn deflate(encoder: &mut Compress, data: &[u8]) -> io::Result<Vec<u8>> {
    let mut input = data;
    let mut out = Vec::with_capacity(data.len() / 2 + 64);
    loop {
        out.reserve(out.capacity().max(1024));
        let before = encoder.total_in();
        encoder.compress_vec(input, &mut out, FlushCompress::Sync).map_err(|e| corrupt(&e.to_string()))?;
        input = &input[(encoder.total_in() - before) as usize..];
        if input.is_empty() && out.len() < out.capacity() {
            break;
        }
    }
    if out.ends_with(&TAIL) {
        out.truncate(out.len() - TAIL.len());
    }
    Ok(out)
}

struct Codec {
    extension: Extension,
    decoder: Decompress,
    encoder: Compress,
    /// The opcode and payload so far of the compressed message being received.
    message: Option<(u8, Vec<u8>)>,
}

impl Codec {
    /// Translates every complete server frame of `raw` into `out`.
    fn inbound(&mut self, raw: &mut Vec<u8>, out: &mut Vec<u8>) -> io::Result<()> {
        while let Some(head) = parse(raw)? {
            if head.masked {
                return Err(corrupt("a server frame was masked"));
            }
            let payload = &raw[head.header..head.total()];
            let compressed = (head.opcode() < 8 && head.opcode() != 0 && head.rsv1()) || (head.opcode() == 0 && self.message.is_some());
            if !compressed {
                out.extend_from_slice(&raw[..head.total()]);
            } else {
                let (opcode, mut data) = match self.message.take() {
                    Some((opcode, data)) if head.opcode() == 0 => (opcode, data),
                    _ => (head.opcode(), Vec::new()),
                };
                data.extend_from_slice(payload);
                if data.len() > MAX_MESSAGE {
                    return Err(corrupt("message beyond the limit"));
                }
                if head.fin() {
                    let plain = inflate(&mut self.decoder, &data)?;
                    if self.extension.server_no_context_takeover {
                        self.decoder.reset(false);
                    }
                    frame(0x80 | opcode, None, &plain, out);
                } else {
                    self.message = Some((opcode, data));
                }
            }
            raw.drain(..head.total());
        }
        Ok(())
    }

    /// Translates every complete client frame of `raw` into `out`.
    fn outbound(&mut self, raw: &mut Vec<u8>, out: &mut Vec<u8>) -> io::Result<()> {
        while let Some(head) = parse(raw)? {
            let single = head.fin() && (head.opcode() == 1 || head.opcode() == 2) && head.first & 0x70 == 0;
            if !(single && head.masked && head.payload >= THRESHOLD && !self.extension.client_window_limited) {
                out.extend_from_slice(&raw[..head.total()]);
            } else {
                let key: [u8; 4] = raw[head.header - 4..head.header].try_into().expect("four bytes");
                let plain: Vec<u8> =
                    raw[head.header..head.total()].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
                let packed = deflate(&mut self.encoder, &plain)?;
                if self.extension.client_no_context_takeover {
                    self.encoder.reset();
                }
                frame(head.first | 0x40, Some(key), &packed, out);
            }
            raw.drain(..head.total());
        }
        Ok(())
    }
}

/// The stream under a WebSocket; see the module.
pub struct WsIo<S> {
    inner: S,
    /// Bytes the server sent behind its upgrade answer, before anything else.
    early: Vec<u8>,
    codec: Option<Box<Codec>>,
    /// Inbound bytes not yet a whole frame, and the translated ones not yet taken.
    in_raw: Vec<u8>,
    in_ready: Vec<u8>,
    in_taken: usize,
    /// Outbound bytes not yet a whole frame, and the translated ones not yet written.
    out_raw: Vec<u8>,
    out_ready: Vec<u8>,
}

impl<S> WsIo<S> {
    pub fn new(inner: S, early: Vec<u8>, extension: Option<Extension>) -> Self {
        let codec = extension.map(|extension| {
            Box::new(Codec {
                extension,
                decoder: Decompress::new(false),
                encoder: Compress::new(Compression::default(), false),
                message: None,
            })
        });
        Self { inner, early, codec, in_raw: Vec::new(), in_ready: Vec::new(), in_taken: 0, out_raw: Vec::new(), out_ready: Vec::new() }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for WsIo<S> {
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
            let Some(codec) = this.codec.as_mut() else {
                if !this.early.is_empty() {
                    let n = this.early.len().min(buf.remaining());
                    buf.put_slice(&this.early[..n]);
                    this.early.drain(..n);
                    return Poll::Ready(Ok(()));
                }
                return Pin::new(&mut this.inner).poll_read(cx, buf);
            };
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
            codec.inbound(&mut this.in_raw, &mut this.in_ready)?;
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

impl<S: AsyncWrite + Unpin> AsyncWrite for WsIo<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        let Some(codec) = this.codec.as_mut() else {
            return Pin::new(&mut this.inner).poll_write(cx, buf);
        };
        this.out_raw.extend_from_slice(buf);
        codec.outbound(&mut this.out_raw, &mut this.out_ready)?;
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        std::task::ready!(self.drain(cx))?;
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        std::task::ready!(self.drain(cx))?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_frame(first: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        frame(first, None, payload, &mut out);
        out
    }

    fn codec(extension: Extension) -> Codec {
        Codec { extension, decoder: Decompress::new(false), encoder: Compress::new(Compression::default(), false), message: None }
    }

    #[test]
    fn the_answer_is_read_as_the_extension_it_accepts() {
        assert_eq!(Extension::parse(None), Ok(None));
        assert_eq!(Extension::parse(Some("permessage-deflate")), Ok(Some(Extension::default())));
        let narrowed = Extension::parse(Some("permessage-deflate; client_no_context_takeover; client_max_window_bits=10")).unwrap().unwrap();
        assert!(narrowed.client_no_context_takeover && narrowed.client_window_limited && !narrowed.server_no_context_takeover);
        assert!(Extension::parse(Some("x-webkit-deflate-frame")).is_err());
        assert!(Extension::parse(Some("permessage-deflate; bogus")).is_err());
    }

    /// What the client sends, a server reads back as the same message, and the reverse, across two messages so the
    /// shared window is exercised.
    #[test]
    fn compressed_messages_round_trip_through_both_directions() {
        let mut client = codec(Extension::default());
        let mut server_decoder = Decompress::new(false);
        let text = "{\"type\":\"response.create\",\"input\":\"".to_owned() + &"abc ".repeat(600) + "\"}";
        for _ in 0..2 {
            let mut raw = Vec::new();
            frame(0x81, Some([1, 2, 3, 4]), text.as_bytes(), &mut raw);
            let mut wire = Vec::new();
            client.outbound(&mut raw, &mut wire).unwrap();
            let head = parse(&wire).unwrap().expect("one frame");
            assert!(head.rsv1() && head.payload < text.len());
            let key: [u8; 4] = wire[head.header - 4..head.header].try_into().unwrap();
            let packed: Vec<u8> = wire[head.header..].iter().enumerate().map(|(i, b)| b ^ key[i % 4]).collect();
            assert_eq!(inflate(&mut server_decoder, &packed).unwrap(), text.as_bytes());
        }
        let mut server_encoder = Compress::new(Compression::default(), false);
        let packed = deflate(&mut server_encoder, text.as_bytes()).unwrap();
        let mut raw = server_frame(0xc1, &packed);
        let mut plain = Vec::new();
        client.inbound(&mut raw, &mut plain).unwrap();
        assert!(raw.is_empty());
        assert_eq!(plain, server_frame(0x81, text.as_bytes()));
    }

    #[test]
    fn small_messages_and_control_frames_pass_unchanged() {
        let mut client = codec(Extension::default());
        let mut raw = Vec::new();
        frame(0x81, Some([9, 9, 9, 9]), b"short", &mut raw);
        frame(0x89, Some([9, 9, 9, 9]), b"", &mut raw);
        let expected = raw.clone();
        let mut wire = Vec::new();
        client.outbound(&mut raw, &mut wire).unwrap();
        assert_eq!(wire, expected);
        let ping = server_frame(0x89, b"x");
        let mut raw = ping.clone();
        let mut plain = Vec::new();
        client.inbound(&mut raw, &mut plain).unwrap();
        assert_eq!(plain, ping);
    }

    #[test]
    fn a_fragmented_compressed_message_is_one_plain_frame_and_a_partial_frame_waits() {
        let mut client = codec(Extension::default());
        let mut encoder = Compress::new(Compression::default(), false);
        let packed = deflate(&mut encoder, b"hello hello hello").unwrap();
        let (a, b) = packed.split_at(packed.len() / 2);
        let mut raw = [server_frame(0x41, a), server_frame(0x80, b)].concat();
        let mut plain = Vec::new();
        let whole = raw.clone();
        raw.truncate(3);
        client.inbound(&mut raw, &mut plain).unwrap();
        assert!(plain.is_empty());
        raw = whole[3..].to_vec();
        raw.splice(0..0, whole[..3].iter().copied());
        client.inbound(&mut raw, &mut plain).unwrap();
        assert_eq!(plain, server_frame(0x81, b"hello hello hello"));
    }
}
