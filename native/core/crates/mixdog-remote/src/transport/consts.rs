//! The MXT bounds (`shared/remote-transport.ts`), each derived from a relay limit the same way
//! the product derives it. Changing one changes the wire contract with the phone.

/// One E2EE box header: `MXE\x01 | u64 sequence | nonce(12)`.
pub const BOX_HEADER_BYTES: usize = 24;
pub const GCM_TAG_BYTES: usize = 16;
/// Message prefix: magic(4) and kind(1).
pub const PREFIX_BYTES: usize = 5;
/// Chunk header: prefix, u64 sequence, u32 index, u32 count, u32 total.
pub const CHUNK_HEADER_BYTES: usize = PREFIX_BYTES + 8 + 4 + 4 + 4;
/// Largest message either carrier is handed (the relay's undeclared-capacity ceiling minus the
/// binary envelope and the longest routing id).
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024 - 6 - 64;
pub const CHUNK_BYTES: usize = MAX_MESSAGE_BYTES - CHUNK_HEADER_BYTES;
/// Largest application plaintext per record, and the largest box that carries it.
pub const MAX_RECORD_PLAINTEXT_BYTES: usize = 1024 * 1024;
pub const MAX_RECORD_BYTES: usize = BOX_HEADER_BYTES + MAX_RECORD_PLAINTEXT_BYTES + GCM_TAG_BYTES;
/// The relay's per-leg queue bound.
const RELAY_LEG_QUEUE_BYTES: usize = 8 * 1024 * 1024;
/// Records in flight at most (the window over the minimum charge).
pub const MAX_RECORDS_IN_FLIGHT: u64 = (RELAY_LEG_QUEUE_BYTES / MAX_MESSAGE_BYTES) as u64;
/// Competing assemblies one slot may hold while their geometry is unauthenticated.
pub const CANDIDATES_PER_SLOT: usize = 2;
/// Peak memory of opening one maximal record beyond its own assembly buffer.
pub const OPEN_WORKING_BYTES: usize = 2 * MAX_RECORD_BYTES + 5 * MAX_RECORD_PLAINTEXT_BYTES;
pub const HEAD_RESERVE_BYTES: usize = CANDIDATES_PER_SLOT * MAX_RECORD_BYTES + OPEN_WORKING_BYTES;
pub const FUTURE_BUDGET_BYTES: usize = RELAY_LEG_QUEUE_BYTES;
pub const RECEIVE_BUDGET_BYTES: usize = FUTURE_BUDGET_BYTES + HEAD_RESERVE_BYTES;
pub const MAX_OUTSTANDING_BYTES: usize = RELAY_LEG_QUEUE_BYTES;
pub const BULK_OUTSTANDING_BYTES: usize = MAX_OUTSTANDING_BYTES - MAX_RECORD_BYTES;
/// Unacked bytes one media stream may hold.
pub const MEDIA_STREAM_CREDIT_BYTES: usize = 1024 * 1024;
/// No ack progress for this long, with records outstanding, ends the session.
pub const RECORD_EXPIRY_MS: u64 = 60_000;
/// RFC 9002 §6.2.2 kInitialRtt.
pub const INITIAL_RTT_MS: f64 = 333.0;
/// RFC 9002 §6.1.2 kGranularity.
pub const GRANULARITY_MS: f64 = 1.0;
/// RFC 9002 §6.1.1 kPacketThreshold.
pub const PACKET_THRESHOLD: u64 = 3;
/// RFC 9002 §6.1.2 kTimeThreshold = 9/8.
pub const TIME_THRESHOLD_NUM: f64 = 9.0;
pub const TIME_THRESHOLD_DEN: f64 = 8.0;
/// RFC 9002 §6.2.4: probes per PTO expiry.
pub const PTO_PROBES: usize = 2;
/// RFC 9000 §18.2 max_ack_delay.
pub const MAX_ACK_DELAY_MS: u64 = 25;
/// RFC 9000 §13.2.2 ack-eliciting threshold.
pub const ACK_ELICITING_THRESHOLD: u64 = 2;
/// Liveness pings on the direct carrier.
pub const PING_MS: u64 = 2_000;
/// The relay's bound before it closes a desktop leg that missed a turn.
pub const MAX_IDLE_TIMEOUT_MS: f64 = 4_000.0 + 2_000.0;
/// Offer to channel-open.
pub const NEGOTIATION_TIMEOUT_MS: u64 = 39_500;
/// Data-channel backpressure marks.
pub const BUFFER_LOW_BYTES: usize = 1024 * 1024;
pub const BUFFER_HIGH_BYTES: usize = RELAY_LEG_QUEUE_BYTES;
/// Room on a direct carrier that app records leave free for the control lane.
pub const CONTROL_RESERVE_BYTES: usize = BUFFER_LOW_BYTES;
/// A phone leg counts as foreground only while its session showed liveness within this span.
pub const FOREGROUND_STALE_MS: u64 = 25_000 + 10_000;
/// Concurrent media adapter streams per session.
pub const MAX_MEDIA_STREAMS: usize = 32;
const MEDIA_FRAME_MAX_BYTES: usize = 4 + 12 + 64 * 1024 + GCM_TAG_BYTES;
pub const MEDIA_CHUNK_MAX_CHARS: usize = (MEDIA_FRAME_MAX_BYTES * 4).div_ceil(3);
pub const MAX_CONTROL_BOX_BYTES: usize = MAX_MESSAGE_BYTES - PREFIX_BYTES;
pub const MAX_CONTROL_PLAINTEXT_BYTES: usize = MAX_CONTROL_BOX_BYTES - BOX_HEADER_BYTES - GCM_TAG_BYTES;

/// `JSON.stringify({v:1,t:'ack',through:MAX_SAFE_INTEGER,ranges:[]})`.
const LONGEST_ACK_ENVELOPE: &str = r#"{"v":1,"t":"ack","through":9007199254740991,"ranges":[]}"#;
/// `${JSON.stringify([MAX_SAFE_INTEGER, MAX_SAFE_INTEGER])},`.
const LONGEST_ACK_RANGE: &str = "[9007199254740991,9007199254740991],";
/// Most selective-ack ranges one ack carries.
pub const MAX_ACK_RANGES: usize = (MAX_CONTROL_PLAINTEXT_BYTES - LONGEST_ACK_ENVELOPE.len()) / LONGEST_ACK_RANGE.len();

/// `JSON.stringify({type:'transport-fragment', id, index, count: MAX_SAFE_INTEGER, data: ''})`.
const LONGEST_FRAGMENT_ENVELOPE: &str =
    r#"{"type":"transport-fragment","id":9007199254740991,"index":9007199254740991,"count":9007199254740991,"data":""}"#;
/// Fragment payload bytes: the largest multiple of 3 whose base64url form plus the envelope fits
/// one record's plaintext.
pub const FRAGMENT_BYTES: usize = (MAX_RECORD_PLAINTEXT_BYTES - LONGEST_FRAGMENT_ENVELOPE.len()) / 4 * 3;
/// The relay's single-frame policy ceiling, both directions.
pub const MAX_APPLICATION_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FRAGMENTS: usize = MAX_APPLICATION_MESSAGE_BYTES.div_ceil(FRAGMENT_BYTES);
/// Process-wide serialized bytes of large messages assembling at once.
pub const ASSEMBLY_POOL_BYTES: usize = MAX_APPLICATION_MESSAGE_BYTES + RELAY_LEG_QUEUE_BYTES;
/// A large message with no new fragment for this long ends its session.
pub const ASSEMBLY_IDLE_MS: u64 = 60_000;
/// Longest diagnostic detail text a close signal or peer report carries.
pub const MAX_DETAIL_CHARS: usize = 200;

/// Every record is charged at least one carrier message against the window.
pub fn record_charge(bytes: usize) -> usize {
    bytes.max(MAX_MESSAGE_BYTES)
}

/// Largest record a media adapter `chunk` seals to.
pub const MEDIA_RECORD_MAX_BYTES: usize = r#"{"type":"transport-media","op":"chunk","id":"","frame":""}"#.len()
    + 64
    + MEDIA_CHUNK_MAX_CHARS
    + BOX_HEADER_BYTES
    + GCM_TAG_BYTES;

/// A carrier is promotable only if its negotiated SCTP max message size takes our largest
/// message (`None` when unknown).
pub fn carrier_fits(max_message_size: Option<f64>) -> bool {
    max_message_size.is_some_and(|size| size >= MAX_MESSAGE_BYTES as f64)
}
