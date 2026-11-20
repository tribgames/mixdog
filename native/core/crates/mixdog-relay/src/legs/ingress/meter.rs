//! The WebSocket framing of a leg's raw byte stream, read to learn what a message DECLARES before its bytes arrive
//! (`consumeIngressBytes`, `startIngressFrame`, `finishIngressFrame` of `lib/relay-transport.mjs`).
//!
//! The meter reads the framing instead of counting raw bytes, which is what makes it comparable to the application: a frame
//! header declares its payload length, so the exact size of the message is known early (a refusal can quote the final size,
//! and an exact-limit frame is never mistaken for an oversize one); header and mask bytes are transport overhead and never
//! count against an application ceiling; control frames carry no message bytes, so a burst of them cannot look like one endless
//! partial frame. Valid because the relay never negotiates permessage-deflate: the declared length IS the payload length.
//!
//! The meter owns no pool and no socket: what it finds is reported to a [`MeterEvents`], in stream order.

use super::super::policy::OVERSIZE_ID_SCAN_BYTES;

/// 2 bytes of prefix, up to 8 more for an extended length, and the 4-byte mask key of every client -> server frame.
const MAX_HEADER_BYTES: usize = 14;

/// What the meter finds in the stream. Every call happens inside [`WireMeter::feed`], in the order of the bytes.
pub(super) trait MeterEvents {
    /// A data frame header is complete: `pending` application bytes are now committed to the message on the wire (a
    /// continuation adds to the message in progress). The admission decision is taken here.
    fn declared(&mut self, pending: u64);
    /// A message past the transport size is refused while it is still arriving, once per message. `head` is the unmasked
    /// prefix of the message (at most [`OVERSIZE_ID_SCAN_BYTES`]) or `None` when nothing of it was seen.
    fn refused(&mut self, bytes: u64, head: Option<&[u8]>, binary: bool);
    /// The message is complete on the wire and about to be delivered; `announced` says it was already refused.
    fn completed(&mut self, announced: bool);
    /// Payload bytes arrived: the leg is making progress.
    fn progress(&mut self);
}

pub(super) struct WireMeter {
    transport: u64,
    /// Application bytes committed to the message currently on the wire.
    pending: u64,
    announced: bool,
    header: [u8; MAX_HEADER_BYTES],
    header_bytes: usize,
    header_needed: usize,
    payload_remaining: u64,
    payload_seen: u64,
    mask: Option<[u8; 4]>,
    control: bool,
    fin: bool,
    message_binary: bool,
    /// The unmasked prefix of the message on the wire, kept so a refusal decided several fragments later can still be
    /// attributed from the envelope's OWN head. Reused per message.
    head: Vec<u8>,
    refusal_due: bool,
    refusal_bytes: u64,
}

impl WireMeter {
    /// `transport` is the size past which the transport gives up on a message (`maxPayload`).
    pub(super) fn new(transport: u64) -> Self {
        Self {
            transport,
            pending: 0,
            announced: false,
            header: [0; MAX_HEADER_BYTES],
            header_bytes: 0,
            header_needed: 2,
            payload_remaining: 0,
            payload_seen: 0,
            mask: None,
            control: false,
            fin: false,
            message_binary: false,
            head: Vec::with_capacity(OVERSIZE_ID_SCAN_BYTES),
            refusal_due: false,
            refusal_bytes: 0,
        }
    }

    /// Walk one raw chunk as WebSocket frames. The whole chunk is always accounted for, including after a park: pausing stops
    /// the NEXT read, while these bytes are already on their way to the parser, and a meter that skipped them would lose the
    /// frame boundary for good.
    pub(super) fn feed(&mut self, chunk: &[u8], events: &mut impl MeterEvents) {
        let mut offset = 0;
        while offset < chunk.len() {
            if self.payload_remaining > 0 {
                let available = (chunk.len() - offset) as u64;
                let take = self.payload_remaining.min(available) as usize;
                if !self.control {
                    self.capture_head(&chunk[offset..offset + take]);
                }
                self.payload_seen += take as u64;
                self.payload_remaining -= take as u64;
                offset += take;
                events.progress();
                self.flush_refusal(events, false);
                if self.payload_remaining == 0 {
                    self.finish_frame(events);
                }
                continue;
            }
            let take = (self.header_needed - self.header_bytes).min(chunk.len() - offset);
            self.header[self.header_bytes..self.header_bytes + take].copy_from_slice(&chunk[offset..offset + take]);
            self.header_bytes += take;
            offset += take;
            if self.header_bytes == 2 {
                let extended = match self.header[1] & 0x7f {
                    126 => 2,
                    127 => 8,
                    _ => 0,
                };
                let mask = if self.header[1] & 0x80 == 0x80 { 4 } else { 0 };
                self.header_needed = 2 + extended + mask;
            }
            if self.header_bytes < self.header_needed {
                continue;
            }
            self.start_frame(events);
            if self.payload_remaining == 0 {
                self.finish_frame(events);
            }
        }
    }

    /// A frame header is complete: commit what it declares.
    fn start_frame(&mut self, events: &mut impl MeterEvents) {
        let header = self.header;
        let opcode = header[0] & 0x0f;
        let marker = header[1] & 0x7f;
        let (length, cursor) = match marker {
            126 => (u64::from(u16::from_be_bytes([header[2], header[3]])), 4),
            127 => {
                let mut wide = [0u8; 8];
                wide.copy_from_slice(&header[2..10]);
                (u64::from_be_bytes(wide), 10)
            }
            short => (u64::from(short), 2),
        };
        self.mask = (header[1] & 0x80 == 0x80).then(|| [header[cursor], header[cursor + 1], header[cursor + 2], header[cursor + 3]]);
        self.control = opcode >= 0x8;
        self.fin = header[0] & 0x80 == 0x80;
        self.payload_remaining = length;
        self.payload_seen = 0;
        self.header_bytes = 0;
        self.header_needed = 2;
        // Control frames are answered by the socket itself and never become a message: they hold no memory, so they are
        // charged nothing.
        if self.control {
            return;
        }
        if opcode != 0x0 {
            // A new message starts here; a continuation adds to the one in progress and inherits its wire form.
            self.pending = 0;
            self.announced = false;
            self.head.clear();
            self.refusal_due = false;
            self.message_binary = opcode == 0x2;
        }
        self.pending = self.pending.saturating_add(length);
        // Refuse at DECLARATION only a message the transport can never deliver: past its own ceiling the socket is destroyed
        // (1009) and the user is told nothing but "relay disconnected", so this is the last moment anything can be said.
        // Continuations count: a fragmented message overruns on a later fragment, never on its first. Everything the transport
        // can still carry is refused on DELIVERY, where the size is the assembled message's own: a declaration is a promise,
        // not a message.
        if !self.announced && self.pending > self.transport {
            self.announced = true;
            self.refusal_due = true;
            // This frame's declared bytes plus every fragment already declared for the same message.
            self.refusal_bytes = self.pending;
        }
        events.declared(self.pending);
        // A fragmented message already has its head captured, so its refusal goes out now instead of waiting for payload the
        // transport will never accept.
        self.flush_refusal(events, false);
    }

    /// Keep the unmasked head of the message on the wire (its envelope, never its payload), from the message's FIRST bytes: a
    /// refusal can be decided much later, and an id read from the middle of a payload is attribution nobody may guess at.
    fn capture_head(&mut self, bytes: &[u8]) {
        let room = OVERSIZE_ID_SCAN_BYTES.saturating_sub(self.head.len());
        for (index, byte) in bytes.iter().take(room).enumerate() {
            self.head.push(match self.mask {
                Some(mask) => byte ^ mask[((self.payload_seen as usize) + index) % 4],
                None => *byte,
            });
        }
    }

    /// Report the refusal for the message on the wire once enough of its prefix is in hand to name the client it belongs to
    /// (or once the frame ends without one).
    fn flush_refusal(&mut self, events: &mut impl MeterEvents, frame_ended: bool) {
        if !self.refusal_due || (!frame_ended && self.head.len() < OVERSIZE_ID_SCAN_BYTES) {
            return;
        }
        self.refusal_due = false;
        let head = (!self.head.is_empty()).then_some(self.head.as_slice());
        events.refused(self.refusal_bytes, head, self.message_binary);
    }

    fn finish_frame(&mut self, events: &mut impl MeterEvents) {
        self.mask = None;
        if self.control {
            return;
        }
        self.flush_refusal(events, true);
        if !self.fin {
            return;
        }
        // Whether this message was already refused belongs to THAT message: a single flag would be overwritten by the next
        // message's header when both arrive in one read.
        events.completed(self.announced);
        self.announced = false;
        // The bytes stop being in flight here; the reservation goes back on delivery.
        self.pending = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Log {
        declared: Vec<u64>,
        refused: Vec<(u64, Option<Vec<u8>>, bool)>,
        completed: Vec<bool>,
    }

    impl MeterEvents for Log {
        fn declared(&mut self, pending: u64) {
            self.declared.push(pending);
        }
        fn refused(&mut self, bytes: u64, head: Option<&[u8]>, binary: bool) {
            self.refused.push((bytes, head.map(<[u8]>::to_vec), binary));
        }
        fn completed(&mut self, announced: bool) {
            self.completed.push(announced);
        }
        fn progress(&mut self) {}
    }

    const MASK: [u8; 4] = [0x0a, 0x0b, 0x0c, 0x0d];

    fn frame(first: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![first];
        if payload.len() < 126 {
            out.push(0x80 | payload.len() as u8);
        } else if payload.len() <= 0xffff {
            out.push(0x80 | 126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            out.push(0x80 | 127);
            out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        out.extend_from_slice(&MASK);
        out.extend(payload.iter().enumerate().map(|(index, byte)| byte ^ MASK[index % 4]));
        out
    }

    #[test]
    fn a_header_split_across_chunks_declares_the_same_size() {
        let wire = frame(0x81, &[b'a'; 300]);
        let mut meter = WireMeter::new(1 << 20);
        let mut log = Log::default();
        for byte in &wire {
            meter.feed(std::slice::from_ref(byte), &mut log);
        }
        assert_eq!(log.declared, vec![300]);
        assert_eq!(log.completed, vec![false]);
        assert!(log.refused.is_empty());
    }

    #[test]
    fn control_frames_declare_nothing_and_complete_no_message() {
        let mut meter = WireMeter::new(1 << 20);
        let mut log = Log::default();
        for _ in 0..1000 {
            meter.feed(&frame(0x89, b"ping"), &mut log);
        }
        meter.feed(&frame(0x81, b"after"), &mut log);
        assert_eq!(log.declared, vec![5]);
        assert_eq!(log.completed, vec![false]);
    }

    #[test]
    fn a_continuation_adds_to_the_message_and_inherits_its_wire_form() {
        let mut meter = WireMeter::new(100);
        let mut log = Log::default();
        let mut wire = frame(0x02, &[1u8; 60]);
        wire.extend(frame(0x89, b"p"));
        wire.extend(frame(0x80, &[2u8; 60]));
        meter.feed(&wire, &mut log);
        assert_eq!(log.declared, vec![60, 120]);
        // Refused once, at the size declared so far, in the wire form of the first frame; the head is the unmasked prefix of
        // the message and never the interleaved ping.
        assert_eq!(log.refused.len(), 1);
        assert_eq!(log.refused[0].0, 120);
        assert!(log.refused[0].2);
        let head = log.refused[0].1.clone().expect("a head");
        assert_eq!(&head[..60], &[1u8; 60][..]);
        assert_eq!(&head[60..], &[2u8; 60][..]);
        assert_eq!(log.completed, vec![true]);
    }

    #[test]
    fn a_message_exactly_at_the_transport_size_is_not_refused() {
        let mut meter = WireMeter::new(5000);
        let mut log = Log::default();
        meter.feed(&frame(0x81, &[b'x'; 5000]), &mut log);
        assert!(log.refused.is_empty());
        assert_eq!(log.completed, vec![false]);
        meter.feed(&frame(0x81, &[b'x'; 5001]), &mut log);
        assert_eq!(log.refused.len(), 1);
        assert_eq!(log.refused[0].0, 5001);
        assert_eq!(log.completed, vec![false, true]);
    }

    #[test]
    fn the_head_is_capped_and_unmasked_from_the_first_bytes() {
        let mut meter = WireMeter::new(10);
        let mut log = Log::default();
        let payload: Vec<u8> = (0..2000u32).map(|n| (n % 251) as u8).collect();
        let wire = frame(0x81, &payload);
        meter.feed(&wire[..wire.len() / 2], &mut log);
        // Declared past the transport size: the refusal waits for 512 bytes of head and then goes out, mid-frame.
        assert_eq!(log.refused.len(), 1);
        assert_eq!(log.refused[0].1.as_deref(), Some(&payload[..OVERSIZE_ID_SCAN_BYTES]));
        assert!(log.completed.is_empty());
    }
}
