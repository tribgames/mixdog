//! The versioned local IPC wire contract between the Mixdog desktop app and the
//! secure-desktop helper. This module is pure (no Windows dependency) so the
//! framing and message shapes can be exercised by unit tests on any host and so
//! the TypeScript client and this helper can be kept in lock-step.
//!
//! Every frame on the wire is:
//!
//! ```text
//!   u32 LE body_len          number of bytes that follow (kind + payload)
//!   u8     kind              1 = control (JSON), 2 = video frame (binary)
//!   u8[body_len-1] payload
//! ```
//!
//! A control payload is UTF-8 JSON (a [`Message`]). A video payload is:
//!
//! ```text
//!   u32 LE header_len
//!   u8[header_len] header     UTF-8 JSON (a [`FrameHeader`])
//!   u8[..]         pixels     raw BGRA, length == stride * height
//! ```
//!
//! BGRA was chosen over a compressed format on purpose: the capture side
//! produces top-down 32-bit BGRA straight from GDI, and the WebRTC effort owns
//! the encoder. Shipping raw pixels keeps this bridge free of a codec
//! dependency and lets the consumer pick its own. Dirty rectangles are included
//! when the capture backend can produce them cheaply; a full-frame update is
//! signalled by an empty `dirty` list.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Bumped on any breaking change to the message set or framing. The handshake
/// rejects a mismatch, so the app and helper must ship together.
///
/// v2 replaced the plaintext-secret `hello` with a mutual HMAC-SHA256
/// challenge-response (`client-hello` / `server-auth` / `client-auth`): the
/// secret is never put on the wire, the server proves knowledge first, and the
/// client aborts before revealing its own proof if the server's is wrong.
///
/// v3 replaced the `default` / `winlogon` / `locked` desktop kinds with the
/// input desktop's real object name (see [`MAX_DESKTOP_NAME`]). The lock and
/// sign-in screens render on the same `Winlogon` desktop as UAC consent, so a
/// separate `locked` kind named a distinction the helper cannot observe.
pub const PROTOCOL_VERSION: u32 = 3;

/// Upper bound on a reported desktop name, in UTF-16 units: the helper reads
/// the name through a 256-unit `UOI_NAME` buffer, so it can never exceed this.
pub const MAX_DESKTOP_NAME: usize = 256;

pub const KIND_CONTROL: u8 = 1;
pub const KIND_VIDEO: u8 = 2;

/// Control messages are small; anything larger is a malformed or hostile peer.
pub const MAX_CONTROL_LEN: usize = 1 << 20; // 1 MiB
/// A full BGRA frame for a large multi-monitor virtual desktop. 192 MiB covers
/// well past dual-4K; a larger body is refused rather than allocated.
pub const MAX_VIDEO_LEN: usize = 192 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PointerButton {
    Left,
    Right,
    Middle,
}

/// A single input action, in desktop pixels (virtual-screen origin at top-left
/// of the primary monitor; negative coordinates are valid on multi-monitor
/// layouts). The helper maps these to `SendInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InputEvent {
    PointerMove {
        x: i32,
        y: i32,
    },
    PointerButton {
        button: PointerButton,
        down: bool,
        x: i32,
        y: i32,
    },
    /// Wheel deltas in WHEEL_DELTA (120) units. `dy` positive scrolls up, `dx`
    /// positive scrolls right.
    PointerWheel {
        x: i32,
        y: i32,
        #[serde(default)]
        dx: i32,
        #[serde(default)]
        dy: i32,
    },
    /// A key by virtual key and scan code. `scan` is preferred by the injector
    /// so layouts and the secure desktop behave; `vk` is a fallback.
    Key {
        down: bool,
        vk: u16,
        #[serde(default)]
        scan: u16,
        #[serde(default)]
        extended: bool,
    },
    /// Literal Unicode text, injected as `KEYEVENTF_UNICODE` key events.
    Text {
        text: String,
    },
}

/// An inclusive-origin, exclusive-extent rectangle in desktop pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The JSON header that precedes the raw BGRA pixels of a video frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHeader {
    /// Monotonic per-connection frame counter.
    pub seq: u64,
    pub width: u32,
    pub height: u32,
    /// Bytes per row, including any padding. `stride * height == pixels.len()`.
    pub stride: u32,
    /// Always `"bgra"`; present so a later format is explicit.
    pub format: String,
    /// Capture time in milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// Virtual-screen coordinate of the frame's top-left pixel.
    pub origin_x: i32,
    pub origin_y: i32,
    /// Object name of the input desktop the frame was captured from, exactly as
    /// Windows reports it (`Default`, `Winlogon`, `Screen-saver`, …).
    pub desktop: String,
    /// Regions changed since the previous frame. Empty means full-frame.
    #[serde(default)]
    pub dirty: Vec<DirtyRect>,
}

/// Control-channel messages. The spec documents which direction each travels;
/// the enum is shared so both ends decode with one type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Message {
    /// app -> helper, first message. Opens the challenge-response with the
    /// client's base64 nonce. Carries **no secret**.
    ClientHello {
        protocol: u32,
        #[serde(rename = "clientNonce")]
        client_nonce: String,
    },
    /// helper -> app, the server's proof it knows the secret: its own base64
    /// nonce plus `mac = HMAC(secret, "server" ‖ clientNonce ‖ serverNonce)`.
    /// Sent before the client proves anything.
    ServerAuth {
        protocol: u32,
        #[serde(rename = "serverNonce")]
        server_nonce: String,
        mac: String,
    },
    /// app -> helper, the client's reply, sent only after it has verified
    /// `server-auth`: `mac = HMAC(secret, "client" ‖ serverNonce ‖ clientNonce)`.
    ClientAuth { mac: String },
    /// helper -> app, only after the client's proof is accepted.
    ServerHello {
        protocol: u32,
        version: String,
        session: u32,
        /// Real object name of the input desktop (see [`FrameHeader::desktop`]).
        desktop: String,
    },
    /// helper -> app, whenever the input desktop changes.
    DesktopChanged { desktop: String, session: u32 },
    /// app -> helper, a single input action.
    Input { event: InputEvent },
    /// app -> helper, starts or stops the remote-control session. Capture and
    /// injection are inert until `active` is true; `false` stops both.
    Control { active: bool },
    /// helper -> app, a fatal or advisory condition. `code` is stable; the app
    /// shows its own copy, so `message` is for logs only.
    Error { code: String, message: String },
}

impl Message {
    pub fn error(code: &str, message: impl Into<String>) -> Self {
        Message::Error {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// A decoded wire frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Control(Message),
    Video(FrameHeader, Vec<u8>),
}

fn wrap(payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    out
}

/// Serialize a control message into a complete wire frame.
pub fn encode_control(message: &Message) -> Vec<u8> {
    let json = serde_json::to_vec(message).expect("control messages always serialize");
    let mut payload = Vec::with_capacity(1 + json.len());
    payload.push(KIND_CONTROL);
    payload.extend_from_slice(&json);
    wrap(payload)
}

/// Serialize a video frame (header + raw BGRA pixels) into a complete wire
/// frame. The caller guarantees `pixels.len() == header.stride * header.height`.
pub fn encode_video(header: &FrameHeader, pixels: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(header).expect("frame headers always serialize");
    let mut payload = Vec::with_capacity(1 + 4 + json.len() + pixels.len());
    payload.push(KIND_VIDEO);
    payload.extend_from_slice(&(json.len() as u32).to_le_bytes());
    payload.extend_from_slice(&json);
    payload.extend_from_slice(pixels);
    wrap(payload)
}

/// Read exactly one wire frame from a blocking byte stream and decode it.
/// Returns `UnexpectedEof` cleanly when the peer closes between frames.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Decoded> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len)?;
    let body_len = u32::from_le_bytes(len) as usize;
    if body_len == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "empty frame"));
    }
    if body_len > MAX_VIDEO_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame exceeds the maximum size",
        ));
    }
    let mut body = vec![0u8; body_len];
    reader.read_exact(&mut body)?;
    decode_body(&body).map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))
}

/// Decode a frame body (the `kind` byte plus payload) without reading from a
/// stream. Kept separate so it can be fuzzed and unit-tested directly.
pub fn decode_body(body: &[u8]) -> Result<Decoded, String> {
    let (&kind, payload) = body.split_first().ok_or("empty frame body")?;
    match kind {
        KIND_CONTROL => {
            if payload.len() > MAX_CONTROL_LEN {
                return Err("control message exceeds the maximum size".into());
            }
            let message = serde_json::from_slice::<Message>(payload)
                .map_err(|error| format!("invalid control JSON: {error}"))?;
            Ok(Decoded::Control(message))
        }
        KIND_VIDEO => {
            if payload.len() < 4 {
                return Err("video frame is missing its header length".into());
            }
            let header_len = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]])
                as usize;
            let rest = &payload[4..];
            if header_len > rest.len() {
                return Err("video frame header length is out of range".into());
            }
            let (header_bytes, pixels) = rest.split_at(header_len);
            let header = serde_json::from_slice::<FrameHeader>(header_bytes)
                .map_err(|error| format!("invalid frame header JSON: {error}"))?;
            // Checked so a hostile stride/height cannot overflow the product.
            let expected = (header.stride as usize)
                .checked_mul(header.height as usize)
                .ok_or("frame stride*height overflows")?;
            if pixels.len() != expected {
                return Err(format!(
                    "frame pixel length {} does not match stride*height {expected}",
                    pixels.len()
                ));
            }
            Ok(Decoded::Video(header, pixels.to_vec()))
        }
        other => Err(format!("unknown frame kind {other}")),
    }
}

/// Write a complete, already-encoded frame and flush it.
pub fn write_all<W: Write>(writer: &mut W, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

/// A non-blocking, incremental frame reader. The helper feeds it whatever bytes
/// are available on the pipe (never more than are present, so it never blocks)
/// and pulls whole frames out as they complete. A length prefix that arrives
/// without its body simply leaves [`pending`](Self::pending) true and yields
/// no frame — it can never stall capture or the desktop monitor the way a
/// blocking `read_frame` on a half-sent frame would. Size caps are enforced on
/// the declared length before any allocation, so a hostile prefix is rejected
/// rather than reserved.
///
/// It also times each frame from its **first** byte, so the helper can apply a
/// *total* per-frame deadline: a peer that dribbles one byte every few seconds
/// keeps resetting an inactivity timer forever, but cannot stretch a frame past
/// a deadline measured from when that frame began.
#[derive(Default)]
pub struct FrameAccumulator {
    buffer: Vec<u8>,
    /// When the first byte of the frame at the front of `buffer` arrived.
    frame_started: Option<std::time::Instant>,
    /// When the most recent bytes arrived (the start of any frame that begins
    /// right after one completed in the same feed).
    last_extend: Option<std::time::Instant>,
}

impl FrameAccumulator {
    pub fn new() -> Self {
        FrameAccumulator::default()
    }

    /// Append bytes read at `now`. A frame that starts in this feed is timed
    /// from `now`.
    pub fn extend(&mut self, bytes: &[u8], now: std::time::Instant) {
        if bytes.is_empty() {
            return;
        }
        if self.buffer.is_empty() {
            self.frame_started = Some(now);
        }
        self.last_extend = Some(now);
        self.buffer.extend_from_slice(bytes);
    }

    /// True while some bytes of an incomplete frame are buffered.
    pub fn pending(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// True when an incomplete frame has been arriving for longer than `limit`
    /// in total, measured from its first byte — not from the latest byte.
    pub fn frame_overdue(&self, now: std::time::Instant, limit: std::time::Duration) -> bool {
        self.pending() && self.frame_started.is_some_and(|started| now > started + limit)
    }

    /// Pop the next complete frame, `Ok(None)` if one is not yet fully
    /// buffered, or `Err` if the framing is malformed or over the size cap, or
    /// if the frame missed its deadline (the caller then disconnects).
    ///
    /// `now` is the dispatch time. A frame whose first byte arrived more than
    /// `limit` before `now` is refused **before** it is decoded or returned, so
    /// a frame that completes (or would be dispatched) past its total deadline
    /// is never executed — a late frame cannot slip through because its last
    /// byte happened to arrive.
    pub fn next_frame(
        &mut self,
        now: std::time::Instant,
        limit: std::time::Duration,
    ) -> Result<Option<Decoded>, String> {
        if self.buffer.len() < 4 {
            return Ok(None);
        }
        let body_len =
            u32::from_le_bytes([self.buffer[0], self.buffer[1], self.buffer[2], self.buffer[3]])
                as usize;
        if body_len == 0 {
            return Err("empty frame".into());
        }
        if body_len > MAX_VIDEO_LEN {
            return Err("frame exceeds the maximum size".into());
        }
        let total = 4 + body_len;
        if self.buffer.len() < total {
            return Ok(None);
        }
        // The frame is complete; its first-byte time decides whether it may be
        // validated and dispatched at all.
        if self.frame_overdue(now, limit) {
            return Err("inbound frame deadline exceeded".into());
        }
        let decoded = decode_body(&self.buffer[4..total])?;
        self.buffer.drain(..total);
        // Frames are drained after every feed, so the bytes left behind began
        // arriving in the latest feed: time the next frame from there.
        self.frame_started = if self.buffer.is_empty() { None } else { self.last_extend };
        Ok(Some(decoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{Duration, Instant};

    /// Frame deadline for tests that are not about timing.
    const LIMIT: Duration = Duration::from_secs(10);

    #[test]
    fn control_round_trips_through_a_stream() {
        let messages = [
            Message::ClientHello {
                protocol: PROTOCOL_VERSION,
                client_nonce: "Y2xpZW50Tm9uY2U=".into(),
            },
            Message::ServerAuth {
                protocol: PROTOCOL_VERSION,
                server_nonce: "c2VydmVyTm9uY2U=".into(),
                mac: "bWFjLXZhbHVl".into(),
            },
            Message::ClientAuth {
                mac: "Y2xpZW50LW1hYw==".into(),
            },
            Message::ServerHello {
                protocol: PROTOCOL_VERSION,
                version: "0.1.0".into(),
                session: 1,
                desktop: "Default".into(),
            },
            Message::DesktopChanged {
                desktop: "Winlogon".into(),
                session: 1,
            },
            Message::Input {
                event: InputEvent::PointerButton {
                    button: PointerButton::Left,
                    down: true,
                    x: -7,
                    y: 42,
                },
            },
            Message::Input {
                event: InputEvent::Key {
                    down: true,
                    vk: 0x41,
                    scan: 0x1e,
                    extended: false,
                },
            },
            Message::Input {
                event: InputEvent::Text {
                    text: "héllo".into(),
                },
            },
            Message::Control { active: true },
            Message::error("capture_failed", "GDI BitBlt returned 0"),
        ];
        let mut buffer = Vec::new();
        for message in &messages {
            buffer.extend_from_slice(&encode_control(message));
        }
        let mut cursor = Cursor::new(buffer);
        for expected in &messages {
            match read_frame(&mut cursor).expect("decode") {
                Decoded::Control(got) => assert_eq!(&got, expected),
                other => panic!("expected control, got {other:?}"),
            }
        }
        // Stream is fully consumed.
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn video_round_trips_with_pixels_and_dirty_regions() {
        let header = FrameHeader {
            seq: 9,
            width: 2,
            height: 2,
            stride: 8,
            format: "bgra".into(),
            timestamp_ms: 1_700_000_000_000,
            origin_x: 0,
            origin_y: 0,
            desktop: "Default".into(),
            dirty: vec![DirtyRect {
                x: 0,
                y: 0,
                width: 1,
                height: 2,
            }],
        };
        let pixels: Vec<u8> = (0..16).collect();
        let frame = encode_video(&header, &pixels);
        let mut cursor = Cursor::new(frame);
        match read_frame(&mut cursor).expect("decode") {
            Decoded::Video(got_header, got_pixels) => {
                assert_eq!(got_header, header);
                assert_eq!(got_pixels, pixels);
            }
            other => panic!("expected video, got {other:?}"),
        }
    }

    #[test]
    fn video_with_mismatched_pixel_length_is_rejected() {
        let header = FrameHeader {
            seq: 0,
            width: 2,
            height: 2,
            stride: 8,
            format: "bgra".into(),
            timestamp_ms: 0,
            origin_x: 0,
            origin_y: 0,
            desktop: "Default".into(),
            dirty: Vec::new(),
        };
        // Claims 16 bytes (stride*height) but ships 4.
        let frame = encode_video(&header, &[1, 2, 3, 4]);
        let mut cursor = Cursor::new(frame);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn unknown_kind_and_empty_body_are_errors() {
        assert!(decode_body(&[]).is_err());
        assert!(decode_body(&[9, 1, 2, 3]).is_err());
    }

    #[test]
    fn oversized_body_length_is_refused_before_allocation() {
        let mut len = ((MAX_VIDEO_LEN + 1) as u32).to_le_bytes().to_vec();
        len.push(KIND_CONTROL);
        let mut cursor = Cursor::new(len);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn accumulator_yields_frames_only_when_complete() {
        let now = Instant::now();
        let mut acc = FrameAccumulator::new();
        let frame = encode_control(&Message::Control { active: true });

        // A lone length prefix (no body) yields nothing and never blocks.
        acc.extend(&frame[..4], now);
        assert!(matches!(acc.next_frame(now, LIMIT), Ok(None)));
        assert!(acc.pending(), "the partial frame is held, not dropped");

        // One more byte: still incomplete.
        acc.extend(&frame[4..5], now);
        assert!(matches!(acc.next_frame(now, LIMIT), Ok(None)));

        // The remainder completes it, plus a second whole frame in the same feed.
        acc.extend(&frame[5..], now);
        acc.extend(&encode_control(&Message::Control { active: false }), now);
        match acc.next_frame(now, LIMIT) {
            Ok(Some(Decoded::Control(Message::Control { active }))) => assert!(active),
            other => panic!("expected active control, got {other:?}"),
        }
        match acc.next_frame(now, LIMIT) {
            Ok(Some(Decoded::Control(Message::Control { active }))) => assert!(!active),
            other => panic!("expected idle control, got {other:?}"),
        }
        assert!(matches!(acc.next_frame(now, LIMIT), Ok(None)));
        assert!(!acc.pending(), "fully drained");
    }

    #[test]
    fn accumulator_refuses_oversized_or_zero_length_frames() {
        let now = Instant::now();
        let mut acc = FrameAccumulator::new();
        acc.extend(&((MAX_VIDEO_LEN + 1) as u32).to_le_bytes(), now);
        acc.extend(&[KIND_CONTROL], now);
        assert!(acc.next_frame(now, LIMIT).is_err());

        let mut zero = FrameAccumulator::new();
        zero.extend(&0u32.to_le_bytes(), Instant::now());
        assert!(zero.next_frame(Instant::now(), LIMIT).is_err());
    }

    #[test]
    fn frame_deadline_is_total_from_the_first_byte_not_inactivity() {
        let limit = Duration::from_secs(10);
        let t0 = Instant::now();
        let frame = encode_control(&Message::Control { active: true });
        let mut acc = FrameAccumulator::new();
        assert!(!acc.frame_overdue(t0 + limit * 5, limit), "nothing pending, nothing overdue");

        // Dribble one byte every 3 s: each byte is "recent", but the frame as a
        // whole began at t0, so it is overdue once 10 s have passed since then.
        for (i, byte) in frame[..frame.len() - 1].iter().enumerate().take(4) {
            let at = t0 + Duration::from_secs(3 * i as u64);
            acc.extend(&[*byte], at);
            assert!(matches!(acc.next_frame(at, limit), Ok(None)));
        }
        assert!(!acc.frame_overdue(t0 + limit, limit));
        assert!(acc.frame_overdue(t0 + limit + Duration::from_millis(1), limit));

        // A frame that completes in time clears the timer; one starting in the
        // same feed is timed from that feed.
        let mut acc = FrameAccumulator::new();
        let t1 = t0 + Duration::from_secs(5);
        acc.extend(&frame[..2], t0);
        let mut rest = frame[2..].to_vec();
        rest.extend_from_slice(&frame[..3]); // the next frame's first bytes
        acc.extend(&rest, t1);
        assert!(matches!(acc.next_frame(t1, limit), Ok(Some(_))));
        assert!(acc.pending());
        let past_t0_deadline = t0 + limit + Duration::from_millis(1);
        assert!(!acc.frame_overdue(past_t0_deadline, limit), "next frame timed from t1, not t0");
        assert!(acc.frame_overdue(t1 + limit + Duration::from_millis(1), limit));
    }

    #[test]
    fn a_frame_completed_one_tick_past_its_deadline_is_never_dispatched() {
        let limit = Duration::from_secs(10);
        let tick = Duration::from_nanos(1);
        let t0 = Instant::now();
        let frame = encode_control(&Message::Control { active: true });

        // Completed exactly at the deadline: dispatched.
        let mut on_time = FrameAccumulator::new();
        on_time.extend(&frame[..1], t0);
        on_time.extend(&frame[1..], t0 + limit);
        assert!(matches!(on_time.next_frame(t0 + limit, limit), Ok(Some(Decoded::Control(_)))));

        // Completed one tick later: refused, and nothing is ever returned for it.
        let mut late = FrameAccumulator::new();
        late.extend(&frame[..1], t0);
        late.extend(&frame[1..], t0 + limit + tick);
        let refused = late.next_frame(t0 + limit + tick, limit);
        assert!(matches!(&refused, Err(reason) if reason.contains("deadline")), "{refused:?}");
        assert!(late.pending(), "the late frame was not consumed as if executed");
        assert!(late.next_frame(t0 + limit + tick, limit).is_err(), "still refused on retry");

        // Completed in time but dispatched one tick past the deadline: refused.
        let mut stale = FrameAccumulator::new();
        stale.extend(&frame[..1], t0);
        stale.extend(&frame[1..], t0 + limit);
        assert!(stale.next_frame(t0 + limit + tick, limit).is_err());
    }
}
