//! The desktop side of one transport session (`main/remote-transport/coordinator.ts`): the stream
//! cores (sender, receiver, assembler), the relay carrier that is always there and at most one
//! direct peer connection, promoted only after a fresh ping/pong on it and demoted only on a stall
//! or a hard failure.
//!
//! The coordinator is a state machine: it owns no clock, socket or task. Every continuation Node
//! reaches through a promise (a seal, an open, an ICE lookup, an offer, a delivery, a relay write)
//! is a `Job`, run first-in first-out by `settle`, so the order of every effect is the order Node
//! produced (`tests/it/transport_coordinator.rs` replays the recorded effects). A host operation
//! that completes later answers through the `complete_*` methods; one that is done at once says
//! so (`Settle::Now`) and its continuation is queued exactly where Node's microtask would be.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;

use serde_json::Value;
use serde_json::json;

use super::consts::BUFFER_HIGH_BYTES;
use super::consts::CHUNK_BYTES;
use super::consts::CHUNK_HEADER_BYTES;
use super::consts::CONTROL_RESERVE_BYTES;
use super::consts::MAX_APPLICATION_MESSAGE_BYTES;
use super::consts::MAX_RECORDS_IN_FLIGHT;
use super::consts::NEGOTIATION_TIMEOUT_MS;
use super::consts::PING_MS;
use super::consts::PREFIX_BYTES;
use super::consts::carrier_fits;
use super::control::Control;
use super::control::ack_json;
use super::control::ping_json;
use super::control::pong_json;
use super::control::read_control;
use super::control::repair_json;
use super::frame::Message;
use super::frame::decode_message;
use super::frame::encode_control;
use super::frame::encode_record;
use super::path::PathMonitor;
use super::path::RttEstimate;
use super::receiver::AcceptResult;
use super::receiver::Receiver;
use super::sender::Admission;
use super::sender::Sender;
use super::signal::CloseReason;
use super::signal::Role;
use super::signal::Signal;
use super::signal::SignalRef;
use super::signal::parse_signal;
use super::split::Assembly;
use super::split::AssemblyPool;
use super::split::FRAGMENT_TYPE;
use super::split::MessageAssembler;
use super::split::split_payload;
use crate::e2ee::ControlLane;
use crate::e2ee::ControlOpen;
use crate::webrtc::config::Candidate;
use crate::webrtc::config::IceServer;
use crate::webrtc::signal::Fingerprint;
use crate::webrtc::signal::candidate_json;
use crate::webrtc::signal::ice_servers_json;
use crate::webrtc::signal::parse_ice_servers;

// ---- what the host provides -------------------------------------------------------------------

/// The result of a host operation: done now, or reported later through a `complete_*` method.
pub enum Settle<T> {
    Now(T),
    Later,
}

/// The data channels of a direct carrier: `App` carries record kinds 1 and 2, `Control` kind 3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerChannel {
    App,
    Control,
}

impl PeerChannel {
    pub const fn name(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Control => "control",
        }
    }
}

/// What a new direct peer is created with.
#[derive(Clone, Debug, PartialEq)]
pub struct PeerInit {
    pub session_id: String,
    pub connection_id: String,
    pub ice_servers: Vec<IceServer>,
}

/// The offering side's local description and its own `a=fingerprint` set.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalOffer {
    pub sdp: String,
    pub fingerprints: Vec<Fingerprint>,
}

/// Why a stream sealing refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealFault {
    /// The plaintext exceeds one record; refused before a sequence is assigned.
    Oversize,
    Broken,
}

/// The E2EE channel operations the stream needs.
pub trait StreamChannel {
    fn encrypt_binary(&mut self, plaintext: &str) -> Result<Vec<u8>, SealFault>;
    /// The plaintext of one application box (a JSON document).
    fn decrypt_json(&mut self, box_bytes: &[u8]) -> Result<Vec<u8>, ()>;
    fn seal_control(&mut self, message: &Value, lane: &ControlLane) -> Result<Vec<u8>, ()>;
    fn open_control(&mut self, raw: &[u8], lane: &ControlLane) -> Result<ControlOpen, ()>;
    fn register_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()>;
    fn activate_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()>;
    fn retire_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()>;
}

/// Everything the coordinator asks of its surroundings.
pub trait Host {
    fn now(&mut self) -> u64;
    fn log(&mut self, line: &str);
    /// 128 random bits as base64url: unguessable, 22 chars, within the signal token limit.
    fn mint_connection_id(&mut self) -> String;
    /// Writes one MXT message as one binary relay frame on the non-droppable path; `Now(ok)` once
    /// the socket took it (`ok` false: the leg is gone).
    fn relay_send(&mut self, message: &[u8]) -> Settle<bool>;
    /// The relay socket took `bytes` of a payload that asked to be metered.
    fn relay_meter(&mut self, token: u64, bytes: usize);
    /// One complete application message from the client, in stream order.
    fn deliver(&mut self, payload: &[u8], bytes: usize) -> Settle<()>;
    /// The coordinator ended the session itself; not called for `close()`.
    fn ended(&mut self, ended: &Ended);
    /// Authenticated inbound arrived (a record opened, a control box opened).
    fn authenticated(&mut self);
    /// An authenticated `close{reason:'suspended'}` arrived: the leg is in the background.
    fn suspended(&mut self);
    /// The ICE/TURN set for a new peer.
    fn resolve_ice(&mut self) -> Settle<Result<Value, ()>>;
    /// Whether a peer host is attached; absent, the session stays on the relay.
    fn peer_host_attached(&mut self) -> bool;
    /// Creates the offering peer of one session. `Err`: the host cannot run one now.
    fn peer_create(&mut self, init: &PeerInit) -> Result<(), ()>;
    fn peer_offer(&mut self, connection_id: &str) -> Settle<Result<LocalOffer, ()>>;
    fn peer_answer(&mut self, connection_id: &str, sdp: &str, fingerprints: &[Fingerprint]) -> Settle<Result<(), ()>>;
    fn peer_candidate(&mut self, connection_id: &str, candidate: &Option<Candidate>) -> Settle<Result<(), ()>>;
    /// Queues one carrier message; false: refused, nothing queued.
    fn peer_send(&mut self, connection_id: &str, channel: PeerChannel, message: &[u8]) -> bool;
    /// The connection's aggregate load over both channels.
    fn peer_buffered(&mut self, connection_id: &str) -> usize;
    fn peer_close(&mut self, connection_id: &str, reason: CloseReason);
    /// A `send` that was queued is settled.
    fn send_settled(&mut self, ticket: u64, result: SendResult);
}

/// A media adapter riding the session (`remote-transport/media.ts`).
pub trait MediaAdapter {
    /// One authenticated application payload: true when it was a media message (consumed).
    fn receive(&mut self, payload: &Value) -> bool;
    /// Admission may have opened: an ack advance, a carrier drain or change.
    fn writable(&mut self);
    fn close(&mut self);
}

// ---- results ---------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    SessionEnded,
    Revoked,
    RecordExpiry,
    AssemblyStalled,
    ProtocolError,
    SealFailed,
}

impl EndReason {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::SessionEnded => "session-ended",
            Self::Revoked => "revoked",
            Self::RecordExpiry => "record-expiry",
            Self::AssemblyStalled => "assembly-stalled",
            Self::ProtocolError => "protocol-error",
            Self::SealFailed => "seal-failed",
        }
    }
}

/// The session's end: calls whose answers were sealed but never acked, or never sealed. The client
/// fails them as ambiguous (never replayed into a new session).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub reason: EndReason,
    pub ambiguous_call_ids: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The session ended; nothing more will be sealed.
    Ended(EndReason),
    /// Refused before sealing: the message exceeds the relay's frame ceiling.
    Oversize(usize),
    /// The channel refused the plaintext's size before sealing (a RangeError).
    Range,
    Other(String),
}

/// `Ok(Some(wire bytes))` once every record is in the sender; `Ok(None)` when a droppable message
/// was dropped before sealing.
pub type SendResult = Result<Option<usize>, SendError>;

#[derive(Clone, Debug, Default)]
pub struct SendOptions {
    pub droppable: bool,
    /// A bulk media stream id: the message is admitted against the stream's credit.
    pub stream: Option<String>,
    /// Asks the host for `relay_meter` with the bytes of each relay message of this payload.
    pub meter: Option<u64>,
}

pub enum Sent {
    /// Settled at once.
    Settled(SendResult),
    /// Queued: `Host::send_settled` answers with this ticket.
    Queued(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathReason {
    ChannelOpen,
    FingerprintMismatch,
    MessageSize,
    Stall,
    ChannelFailed,
    IceFailed,
    NegotiationTimeout,
    PeerHostUnavailable,
    Suspended,
    SessionEnded,
}

impl PathReason {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::ChannelOpen => "channel-open",
            Self::FingerprintMismatch => "fingerprint-mismatch",
            Self::MessageSize => "message-size",
            Self::Stall => "stall",
            Self::ChannelFailed => "channel-failed",
            Self::IceFailed => "ice-failed",
            Self::NegotiationTimeout => "negotiation-timeout",
            Self::PeerHostUnavailable => "peer-host-unavailable",
            Self::Suspended => "suspended",
            Self::SessionEnded => "session-ended",
        }
    }
}

fn path_reason_of(reason: CloseReason) -> PathReason {
    match reason {
        CloseReason::FingerprintMismatch => PathReason::FingerprintMismatch,
        CloseReason::IceFailed => PathReason::IceFailed,
        CloseReason::NegotiationTimeout => PathReason::NegotiationTimeout,
        CloseReason::PeerHostUnavailable => PathReason::PeerHostUnavailable,
        CloseReason::Suspended => PathReason::Suspended,
        CloseReason::Stall => PathReason::Stall,
        CloseReason::SessionEnded => PathReason::SessionEnded,
        _ => PathReason::ChannelFailed,
    }
}

/// `RemoteTransportCoordinatorDiagnostics`, never content.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostics {
    pub path: &'static str,
    pub reason: Option<PathReason>,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub direct_bytes_sent: u64,
    pub direct_bytes_received: u64,
    pub queue_depth: usize,
    pub outstanding_bytes: usize,
    pub retransmits: u64,
    pub receiver: Value,
    pub turn_allocations: u64,
    pub malformed: u64,
    pub forged: u64,
    pub retained_offers: usize,
}

impl Diagnostics {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "reason": self.reason.map(PathReason::wire_name),
            "bytesSent": self.bytes_sent,
            "bytesReceived": self.bytes_received,
            "directBytesSent": self.direct_bytes_sent,
            "directBytesReceived": self.direct_bytes_received,
            "queueDepth": self.queue_depth,
            "outstandingBytes": self.outstanding_bytes,
            "retransmits": self.retransmits,
            "receiver": self.receiver,
            "turnAllocations": self.turn_allocations,
            "malformed": self.malformed,
            "forged": self.forged,
            "retainedOffers": self.retained_offers,
        })
    }
}

// ---- state ------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum Carrier {
    Relay,
    Direct(String),
}

impl Carrier {
    fn id(&self) -> String {
        match self {
            Self::Relay => "relay".to_owned(),
            Self::Direct(connection) => format!("direct:{connection}"),
        }
    }
}

const RELAY_ID: &str = "relay";

struct Direct {
    connection_id: String,
    lane: ControlLane,
    generation: u64,
    peer: bool,
    monitor: PathMonitor,
    started_at: u64,
    open: bool,
    relayed: bool,
    /// The set this peer was created with, signaled in its offer.
    ice_servers: Vec<IceServer>,
}

impl Direct {
    fn id(&self) -> String {
        format!("direct:{}", self.connection_id)
    }
}

struct OfferRef {
    connection_id: String,
    generation: u64,
    closed_at: Option<u64>,
}

struct Outgoing {
    pieces: Vec<String>,
    index: usize,
    stream: Option<String>,
    droppable: bool,
    call_id: Option<u64>,
    wire_bytes: usize,
    meter: Option<u64>,
    ticket: u64,
}

struct Held {
    plaintext: Vec<u8>,
    bytes: usize,
}

enum Job {
    Wake,
    RelayDone { bytes: usize, ok: bool, meter: Option<u64> },
    ControlSealed { carrier: Carrier, result: Result<Vec<u8>, ()> },
    ControlOpened { key: String, result: Result<ControlOpen, ()> },
    Encrypted(Result<Vec<u8>, SealFault>),
    Decrypted { sequence: u64, bytes: usize, result: Result<Vec<u8>, ()> },
    /// `await deps.deliver(..)` returned; the awaited `assemble` resolves one tick later.
    Delivered,
    Assembled(bool),
    IceResolved { connection_id: String, result: Result<Value, ()> },
    OfferReady { connection_id: String, result: Result<LocalOffer, ()> },
    AnswerFailed { connection_id: String },
}

enum DrainInput {
    Start,
    WhileHead,
    Decrypted { sequence: u64, bytes: usize, result: Result<Vec<u8>, ()> },
    Assembled(bool),
    WhileExit,
}

pub struct Coordinator<C: StreamChannel, H: Host> {
    session_id: String,
    channel: C,
    host: H,
    media: Option<Box<dyn MediaAdapter>>,
    label: String,
    sender: Sender,
    receiver: Receiver,
    assembler: MessageAssembler,
    relay_monitor: PathMonitor,
    jobs: VecDeque<Job>,
    closed: bool,
    ended: Option<Ended>,
    current_direct: bool,
    direct: Option<Direct>,
    generation: u64,
    next_attempt_at: u64,
    direct_unfit: bool,
    suspended: bool,
    reason: Option<PathReason>,
    turn_allocations: u64,
    fragment_id: u64,
    relay_in_flight: usize,
    /// Relay writes the host has not settled, oldest first, with their meters.
    relay_pending: VecDeque<(usize, Option<u64>)>,
    bytes_sent: u64,
    bytes_received: u64,
    direct_bytes_sent: u64,
    direct_bytes_received: u64,
    direct_carried: bool,
    malformed: u64,
    forged: u64,
    pending_opens: u64,
    ping_id: u64,
    pings: HashMap<u64, (String, u64)>,
    last_ping_at: HashMap<String, u64>,
    queue: VecDeque<Outgoing>,
    last_offer: Option<OfferRef>,
    previous_offer: Option<OfferRef>,
    call_ids: BTreeMap<u64, u64>,
    relay_writers: BTreeMap<u64, u64>,
    arrived_on: BTreeMap<u64, String>,
    held: Option<Held>,
    assembling_bytes: usize,
    woken: bool,
    pumping: bool,
    draining: bool,
    drain_again: bool,
    next_ticket: u64,
}

fn call_id_of(payload: &str) -> Option<u64> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let number = value.as_object()?.get("id")?.as_f64()?;
    (number >= 0.0 && number.fract() == 0.0 && number <= 9_007_199_254_740_991.0).then_some(number as u64)
}

/// Wire bytes of one sealed box once framed (`encodeRemoteTransportRecord`).
fn record_wire_bytes(box_bytes: usize) -> usize {
    if box_bytes <= CHUNK_BYTES {
        PREFIX_BYTES + box_bytes
    } else {
        box_bytes + box_bytes.div_ceil(CHUNK_BYTES) * CHUNK_HEADER_BYTES
    }
}

/// Serialized bytes a fragment carries (base64url without padding).
fn fragment_bytes(value: &Value) -> usize {
    value.get("data").and_then(Value::as_str).map_or(0, |data| data.encode_utf16().count() * 3 / 4)
}

fn is_fragment(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some(FRAGMENT_TYPE)
}

fn is_control_tag(value: &Value) -> bool {
    matches!(value.get("t").and_then(Value::as_str), Some("ack" | "repair" | "ping" | "pong"))
}

/// `String(maxMessageSize)`.
fn js_number(value: Option<f64>) -> String {
    match value {
        None => "null".to_owned(),
        Some(n) if n.is_infinite() => if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned(),
        Some(n) if n.fract() == 0.0 && n.abs() < 1e21 => format!("{}", n as i128),
        Some(n) => n.to_string(),
    }
}

impl<C: StreamChannel, H: Host> Coordinator<C, H> {
    pub fn new(session_id: &str, channel: C, mut host: H, pool: AssemblyPool) -> Self {
        let now = host.now();
        let session: String = session_id.chars().take(8).collect();
        Self {
            session_id: session_id.to_owned(),
            channel,
            host,
            media: None,
            label: format!("[mixdog-remote-transport] session={session}"),
            sender: Sender::new(),
            receiver: Receiver::new(),
            assembler: MessageAssembler::new(pool),
            relay_monitor: PathMonitor::new(now),
            jobs: VecDeque::new(),
            closed: false,
            ended: None,
            current_direct: false,
            direct: None,
            generation: 0,
            next_attempt_at: now,
            direct_unfit: false,
            suspended: false,
            reason: None,
            turn_allocations: 0,
            fragment_id: 0,
            relay_in_flight: 0,
            relay_pending: VecDeque::new(),
            bytes_sent: 0,
            bytes_received: 0,
            direct_bytes_sent: 0,
            direct_bytes_received: 0,
            direct_carried: false,
            malformed: 0,
            forged: 0,
            pending_opens: 0,
            ping_id: 0,
            pings: HashMap::new(),
            last_ping_at: HashMap::new(),
            queue: VecDeque::new(),
            last_offer: None,
            previous_offer: None,
            call_ids: BTreeMap::new(),
            relay_writers: BTreeMap::new(),
            arrived_on: BTreeMap::new(),
            held: None,
            assembling_bytes: 0,
            woken: false,
            pumping: false,
            draining: false,
            drain_again: false,
            next_ticket: 0,
        }
    }

    pub fn set_media(&mut self, media: Box<dyn MediaAdapter>) {
        self.media = Some(media);
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    pub fn channel(&self) -> &C {
        &self.channel
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    // ---- the job queue --------------------------------------------------------------------------

    /// Runs queued continuations until none is left (a microtask drain).
    pub fn settle(&mut self) {
        while let Some(job) = self.jobs.pop_front() {
            self.run(job);
        }
    }

    fn run(&mut self, job: Job) {
        match job {
            Job::Wake => {
                self.woken = false;
                if self.closed {
                    return;
                }
                self.flush_carrier();
                self.pump_outbound();
                if let Some(media) = self.media.as_mut() {
                    media.writable();
                }
            }
            Job::RelayDone { bytes, ok, meter } => {
                if ok {
                    // Diagnostics only: none runs once the session is closed.
                    if !self.closed
                        && let Some(token) = meter
                    {
                        self.host.relay_meter(token, bytes);
                    }
                }
                self.relay_in_flight = self.relay_in_flight.saturating_sub(bytes);
                self.wake();
            }
            Job::ControlSealed { carrier, result } => match result {
                Ok(box_bytes) => {
                    if self.closed || !self.carrier_usable(&carrier) {
                        return;
                    }
                    if let Ok(message) = encode_control(&box_bytes) {
                        self.write(&carrier, PeerChannel::Control, message, None);
                    }
                }
                Err(()) => self.fail(EndReason::SealFailed),
            },
            Job::ControlOpened { key, result } => {
                self.pending_opens = self.pending_opens.saturating_sub(1);
                match result {
                    Ok(opened) => self.handle_opened(&key, opened),
                    Err(()) => self.forged += 1,
                }
            }
            Job::Encrypted(result) => self.on_encrypted(result),
            Job::Decrypted { sequence, bytes, result } => self.drain_run(DrainInput::Decrypted { sequence, bytes, result }),
            Job::Delivered => self.jobs.push_back(Job::Assembled(!self.closed)),
            Job::Assembled(keep_going) => self.drain_run(DrainInput::Assembled(keep_going)),
            Job::IceResolved { connection_id, result } => self.on_ice(&connection_id, result),
            Job::OfferReady { connection_id, result } => self.on_offer(&connection_id, result),
            Job::AnswerFailed { connection_id } => {
                if self.live(&connection_id) {
                    self.close_direct(&connection_id, CloseReason::ChannelFailed, true, None, None);
                }
            }
        }
    }

    // ---- completions of operations the host reported `Later` -----------------------------------

    /// The relay socket took (or lost) the oldest write the host reported `Later`.
    pub fn complete_relay_send(&mut self, ok: bool) {
        if let Some((bytes, meter)) = self.relay_pending.pop_front() {
            self.jobs.push_back(Job::RelayDone { bytes, ok, meter });
        }
    }

    pub fn complete_deliver(&mut self) {
        self.jobs.push_back(Job::Delivered);
    }

    pub fn complete_ice(&mut self, connection_id: &str, result: Result<Value, ()>) {
        self.jobs.push_back(Job::IceResolved { connection_id: connection_id.to_owned(), result });
    }

    pub fn complete_offer(&mut self, connection_id: &str, result: Result<LocalOffer, ()>) {
        self.jobs.push_back(Job::OfferReady { connection_id: connection_id.to_owned(), result });
    }

    pub fn complete_answer(&mut self, connection_id: &str, result: Result<(), ()>) {
        if result.is_err() {
            self.jobs.push_back(Job::AnswerFailed { connection_id: connection_id.to_owned() });
        }
    }

    // ---- carriers -------------------------------------------------------------------------------

    fn current_carrier(&self) -> Carrier {
        match (&self.direct, self.current_direct) {
            (Some(direct), true) => Carrier::Direct(direct.connection_id.clone()),
            _ => Carrier::Relay,
        }
    }

    fn live(&self, connection_id: &str) -> bool {
        !self.closed && self.direct.as_ref().is_some_and(|direct| direct.connection_id == connection_id)
    }

    fn carrier_usable(&self, carrier: &Carrier) -> bool {
        match carrier {
            Carrier::Relay => true,
            Carrier::Direct(connection) => self.direct.as_ref().is_some_and(|direct| &direct.connection_id == connection && direct.peer),
        }
    }

    fn lane_of(&self, carrier: &Carrier) -> ControlLane {
        match carrier {
            Carrier::Relay => ControlLane::Relay,
            Carrier::Direct(_) => self.direct.as_ref().map_or(ControlLane::Relay, |direct| direct.lane.clone()),
        }
    }

    fn retire_lane(&mut self, lane: &ControlLane) {
        // Never registered when the peer failed before its lane was.
        let _ = self.channel.retire_control_lane(lane);
    }

    fn buffered_of(&mut self, carrier: &Carrier) -> usize {
        match carrier {
            Carrier::Relay => self.relay_in_flight,
            Carrier::Direct(connection) => {
                if self.direct.as_ref().is_some_and(|direct| &direct.connection_id == connection && direct.peer) {
                    self.host.peer_buffered(connection)
                } else {
                    0
                }
            }
        }
    }

    fn monitor_of(&mut self, key: &str) -> Option<&mut PathMonitor> {
        if key == RELAY_ID {
            return Some(&mut self.relay_monitor);
        }
        self.direct.as_mut().filter(|direct| direct.id() == key).map(|direct| &mut direct.monitor)
    }

    fn current_monitor(&mut self) -> &mut PathMonitor {
        if self.current_direct
            && let Some(direct) = self.direct.as_mut()
        {
            return &mut direct.monitor;
        }
        &mut self.relay_monitor
    }

    fn note_outstanding(&mut self, at: u64) {
        let outstanding = self.sender.stats().outstanding_bytes;
        self.current_monitor().outstanding(outstanding, at);
    }

    fn wake(&mut self) {
        if self.woken || self.closed {
            return;
        }
        self.woken = true;
        self.jobs.push_back(Job::Wake);
    }

    fn write_relay(&mut self, message: Vec<u8>, meter: Option<u64>) {
        let bytes = message.len();
        self.relay_in_flight += bytes;
        self.bytes_sent += bytes as u64;
        // A failed write means the relay leg is gone; the registry ends every session on it.
        match self.host.relay_send(&message) {
            Settle::Now(ok) => self.jobs.push_back(Job::RelayDone { bytes, ok, meter }),
            Settle::Later => self.relay_pending.push_back((bytes, meter)),
        }
    }

    /// False: the direct peer refused it (nothing queued).
    fn write(&mut self, carrier: &Carrier, channel: PeerChannel, message: Vec<u8>, meter: Option<u64>) -> bool {
        match carrier {
            Carrier::Relay => {
                self.write_relay(message, meter);
                true
            }
            Carrier::Direct(connection) => {
                let Some(direct) = self.direct.as_ref().filter(|direct| &direct.connection_id == connection && direct.peer) else { return false };
                let (relayed, generation) = (direct.relayed, direct.generation);
                if !self.host.peer_send(connection, channel, &message) {
                    return false;
                }
                self.bytes_sent += message.len() as u64;
                self.direct_bytes_sent += message.len() as u64;
                if channel == PeerChannel::App && !self.direct_carried {
                    self.direct_carried = true;
                    let line = format!("{} carrying path={} generation={generation}", self.label, if relayed { "turn" } else { "direct" });
                    self.host.log(&line);
                }
                true
            }
        }
    }

    /// Hands every due record to the current carrier, within its room. On a direct carrier app
    /// records take at most HIGH − CONTROL_RESERVE of the connection's aggregate load, so control
    /// boxes always find room; a record that does not fit whole waits for a drain.
    fn flush_carrier(&mut self) {
        if self.closed {
            return;
        }
        let at = self.host.now();
        let carrier = self.current_carrier();
        let key = carrier.id();
        let limit = if carrier == Carrier::Relay { BUFFER_HIGH_BYTES } else { BUFFER_HIGH_BYTES - CONTROL_RESERVE_BYTES };
        let budget = limit as f64 - self.buffered_of(&carrier) as f64;
        for record in self.sender.due(at, budget) {
            let Ok(messages) = encode_record(&record.box_bytes) else { break };
            if carrier != Carrier::Relay {
                let bytes: usize = messages.iter().map(Vec::len).sum();
                if self.buffered_of(&carrier) + bytes > limit {
                    break;
                }
            }
            let mut sent = true;
            let meter = self.relay_writers.get(&record.sequence).copied();
            for message in messages {
                if !self.write(&carrier, PeerChannel::App, message, meter) {
                    sent = false;
                    break;
                }
            }
            if !sent {
                break;
            }
            self.sender.mark_sent(record.sequence, &key, at);
        }
    }

    /// Seals one control message FOR `carrier`'s lane and writes it there the moment the seal
    /// resolves. A box sealed for a direct carrier that is gone by then is dropped, never moved to
    /// the relay: acks are regenerated on the surviving carrier, repairs by the receiver's PTO,
    /// pings by the keep-alive.
    fn send_control(&mut self, message: &Value, carrier: &Carrier) {
        if self.closed || (*carrier != Carrier::Relay && !self.carrier_present(carrier)) {
            return;
        }
        let lane = self.lane_of(carrier);
        let result = self.channel.seal_control(message, &lane);
        self.jobs.push_back(Job::ControlSealed { carrier: carrier.clone(), result });
    }

    fn carrier_present(&self, carrier: &Carrier) -> bool {
        match carrier {
            Carrier::Relay => true,
            Carrier::Direct(connection) => self.direct.as_ref().is_some_and(|direct| &direct.connection_id == connection),
        }
    }

    fn flush_ack(&mut self, at: u64) {
        if self.closed {
            return;
        }
        let Some(due) = self.receiver.ack_due(at) else { return };
        self.receiver.ack_sent(due.through);
        let message = parse_text(&ack_json(due.through, &due.ranges));
        let carrier = self.current_carrier();
        self.send_control(&message, &carrier);
    }

    fn clear_pings(&mut self, key: &str) {
        self.pings.retain(|_, entry| entry.0 != key);
    }

    /// Every ping carries `sent`, so the receiver can find a lost final record.
    fn ping(&mut self, carrier: &Carrier, at: u64) {
        let key = carrier.id();
        let Some(idle) = self.monitor_of(&key).map(|monitor| monitor.idle_timeout_ms()) else { return };
        let horizon = at as f64 - idle;
        self.pings.retain(|_, entry| !(entry.0 == key && (entry.1 as f64) < horizon));
        self.ping_id = if self.ping_id >= 9_007_199_254_740_991 { 1 } else { self.ping_id + 1 };
        self.pings.insert(self.ping_id, (key.clone(), at));
        self.last_ping_at.insert(key.clone(), at);
        let buffered = self.buffered_of(carrier);
        let sent = self.sender.probe_through(&key, buffered);
        let message = parse_text(&ping_json(self.ping_id, Some(sent)));
        self.send_control(&message, carrier);
    }

    // ---- path changes ---------------------------------------------------------------------------

    fn promote(&mut self, at: u64) {
        let Some(direct) = self.direct.as_ref() else { return };
        let lane = direct.lane.clone();
        let _ = self.channel.activate_control_lane(&lane);
        let Some(direct) = self.direct.as_mut() else { return };
        self.current_direct = true;
        // RFC 9000 §9.4: a new path starts from fresh RTT and progress state.
        direct.monitor.reset(at);
        let (relayed, generation, key) = (direct.relayed, direct.generation, direct.id());
        self.clear_pings(&key);
        self.reason = Some(PathReason::ChannelOpen);
        let line = format!("{} path={} reason=channel-open generation={generation}", self.label, if relayed { "turn" } else { "direct" });
        self.host.log(&line);
        self.receiver.carrier_changed(at);
        self.flush_ack(at);
        self.wake();
    }

    fn demote(&mut self, connection_id: &str, at: u64, why: PathReason, detail: Option<&str>) {
        if !(self.current_direct && self.direct.as_ref().is_some_and(|direct| direct.connection_id == connection_id)) {
            return;
        }
        self.current_direct = false;
        let key = format!("direct:{connection_id}");
        // Held for one PTO of the surviving carrier, or until the resume ack.
        let hold = self.relay_monitor.pto_ms();
        self.sender.carrier_failed(&key, at, hold);
        self.relay_monitor.reset(at);
        self.clear_pings(RELAY_ID);
        self.reason = Some(why);
        let tail = detail.filter(|detail| !detail.is_empty()).map(|detail| format!(" detail={detail}")).unwrap_or_default();
        let line = format!("{} path=relay reason={}{tail}", self.label, why.wire_name());
        self.host.log(&line);
        self.receiver.carrier_changed(at);
        self.flush_ack(at);
        self.note_outstanding(at);
        self.wake();
    }

    fn signal_ref(&self, direct: &Direct) -> SignalRef {
        SignalRef { session_id: self.session_id.clone(), connection_id: direct.connection_id.clone(), generation: direct.generation }
    }

    fn signal_value(&self, direct: &Direct, tail: Value) -> Value {
        let at = self.signal_ref(direct);
        let mut out = json!({ "v": 1, "sessionId": at.session_id, "connectionId": at.connection_id, "generation": at.generation });
        if let (Some(out), Value::Object(tail)) = (out.as_object_mut(), tail) {
            out.extend(tail);
        }
        out
    }

    /// Drops the direct carrier: demotes it first when it carried traffic.
    fn close_direct(&mut self, connection_id: &str, close_reason: CloseReason, signal: bool, why: Option<PathReason>, detail: Option<&str>) {
        if !self.live(connection_id) {
            return;
        }
        let at = self.host.now();
        let why = why.unwrap_or_else(|| path_reason_of(close_reason));
        if self.current_direct {
            self.demote(connection_id, at, why, detail);
        } else {
            self.reason = Some(why);
            let tail = detail.filter(|detail| !detail.is_empty()).map(|detail| format!(" detail={detail}")).unwrap_or_default();
            let line = format!("{} direct-closed reason={}{tail}", self.label, close_reason.wire_name());
            self.host.log(&line);
        }
        let Some(state) = self.direct.take() else { return };
        if let Some(offer) = self.last_offer.as_mut().filter(|offer| offer.connection_id == state.connection_id) {
            offer.closed_at = Some(at);
        }
        self.clear_pings(&state.id());
        self.last_ping_at.remove(&state.id());
        self.retire_lane(&state.lane);
        if state.peer {
            self.host.peer_close(&state.connection_id, close_reason);
        }
        if signal {
            let message = self.signal_value(&state, json!({ "t": "close", "reason": close_reason.wire_name() }));
            self.send_control(&message, &Carrier::Relay);
        }
        // A new attempt runs in parallel to the relay, at most one per negotiation window, so a
        // path that fails at once cannot spin. Nothing shortens this deadline, a restart included.
        self.next_attempt_at = at.max(state.started_at + NEGOTIATION_TIMEOUT_MS);
    }

    // ---- peer events ----------------------------------------------------------------------------

    /// A local ICE candidate (`None`: gathering complete), signaled as is.
    pub fn peer_candidate_event(&mut self, connection_id: &str, candidate: Option<Candidate>) {
        if self.live(connection_id)
            && let Some(direct) = self.direct.as_ref()
        {
            let message = self.signal_value(direct, json!({ "t": "candidate", "candidate": candidate_json(&candidate) }));
            self.send_control(&message, &Carrier::Relay);
        }
    }

    /// Both channels are open and the certificate matched the answer's fingerprints.
    /// `max_message_size` is the negotiated SCTP maximum (infinite when unlimited).
    pub fn peer_open(&mut self, connection_id: &str, max_message_size: Option<f64>, relayed: bool) {
        self.peer_open_inner(connection_id, max_message_size, relayed);
    }

    fn peer_open_inner(&mut self, connection_id: &str, max_message_size: Option<f64>, relayed: bool) {
        if !self.live(connection_id) || self.direct.as_ref().is_some_and(|direct| direct.open) {
            return;
        }
        if !carrier_fits(max_message_size) {
            self.direct_unfit = true;
            let detail = js_number(max_message_size);
            self.close_direct(connection_id, CloseReason::ChannelFailed, true, Some(PathReason::MessageSize), Some(&detail));
            return;
        }
        let at = self.host.now();
        if let Some(direct) = self.direct.as_mut() {
            direct.open = true;
            direct.relayed = relayed;
        }
        if relayed {
            self.turn_allocations += 1;
            let generation = self.direct.as_ref().map_or(0, |direct| direct.generation);
            let line = format!("{} turn-allocations={} path=turn generation={generation}", self.label, self.turn_allocations);
            self.host.log(&line);
        }
        // Path validation (RFC 9000 §8.2): one ping/pong round trip on it since it became healthy;
        // promotion follows the matched pong.
        let key = format!("direct:{connection_id}");
        if let Some(direct) = self.direct.as_mut() {
            direct.monitor.reset(at);
        }
        self.clear_pings(&key);
        self.ping(&Carrier::Direct(connection_id.to_owned()), at);
    }

    pub fn peer_message(&mut self, connection_id: &str, message: &[u8]) {
        if self.live(connection_id) {
            self.receive_inner(&format!("direct:{connection_id}"), message);
        }
    }

    pub fn peer_drain(&mut self, connection_id: &str) {
        if self.live(connection_id) {
            self.wake();
        }
    }

    /// The peer is gone: the channel closed or failed, ICE failed, DTLS or the fingerprint check
    /// failed, or the host is unavailable. Never fired after the coordinator closed it.
    pub fn peer_closed(&mut self, connection_id: &str, reason: CloseReason) {
        if self.live(connection_id) {
            self.close_direct(connection_id, reason, true, None, None);
        }
    }

    // ---- starting a peer ------------------------------------------------------------------------

    fn start_peer(&mut self, at: u64) {
        if !self.host.peer_host_attached() {
            return;
        }
        self.generation += 1;
        let connection_id = self.host.mint_connection_id();
        let Ok(lane) = ControlLane::direct(self.generation, &connection_id) else {
            self.direct = None;
            return;
        };
        self.direct = Some(Direct {
            connection_id: connection_id.clone(),
            lane,
            generation: self.generation,
            peer: false,
            monitor: PathMonitor::new(at),
            started_at: at,
            open: false,
            relayed: false,
            ice_servers: Vec::new(),
        });
        if let Settle::Now(result) = self.host.resolve_ice() {
            self.jobs.push_back(Job::IceResolved { connection_id, result });
        }
    }

    fn on_ice(&mut self, connection_id: &str, result: Result<Value, ()>) {
        let ice_servers = result.ok().and_then(|value| parse_ice_servers(&value).ok()).unwrap_or_default();
        if !self.live(connection_id) {
            return;
        }
        let init = PeerInit { session_id: self.session_id.clone(), connection_id: connection_id.to_owned(), ice_servers };
        if self.host.peer_create(&init).is_err() {
            // No peer host right now: the session stays on the relay and tries again once per
            // negotiation window, so an app that attaches later serves the next offer.
            self.close_direct(connection_id, CloseReason::PeerHostUnavailable, false, None, None);
            return;
        }
        if let Some(direct) = self.direct.as_mut() {
            direct.peer = true;
            direct.ice_servers = init.ice_servers;
        }
        if let Settle::Now(result) = self.host.peer_offer(connection_id) {
            self.jobs.push_back(Job::OfferReady { connection_id: connection_id.to_owned(), result });
        }
    }

    fn on_offer(&mut self, connection_id: &str, result: Result<LocalOffer, ()>) {
        let Ok(local) = result else {
            self.close_direct(connection_id, CloseReason::ChannelFailed, false, None, None);
            return;
        };
        if !self.live(connection_id) {
            return;
        }
        let Some(direct) = self.direct.as_ref() else { return };
        let ice_servers = direct.ice_servers.clone();
        // What the client will parse, held to one control box before sealing.
        let candidate = self.signal_value(
            direct,
            json!({
                "t": "offer",
                "sdp": local.sdp,
                "fingerprints": local.fingerprints.iter().map(Fingerprint::to_json).collect::<Vec<_>>(),
                "iceServers": ice_servers_json(&ice_servers),
            }),
        );
        let offer: Signal = match parse_signal(&candidate, Role::Desktop) {
            Ok(offer) => offer,
            Err(_) => {
                self.close_direct(connection_id, CloseReason::ProtocolError, false, Some(PathReason::MessageSize), None);
                return;
            }
        };
        // The new connection's lane, pending until promotion (epoch = this offer's generation);
        // nothing at or below it can come back.
        let lane = direct.lane.clone();
        let generation = direct.generation;
        if self.channel.register_control_lane(&lane).is_err() {
            self.close_direct(connection_id, CloseReason::ChannelFailed, false, None, None);
            return;
        }
        // Only one direct carrier at a time: the previous offer is closed here.
        self.previous_offer = self.last_offer.take();
        self.last_offer = Some(OfferRef { connection_id: connection_id.to_owned(), generation, closed_at: None });
        self.send_control(&offer.to_json(), &Carrier::Relay);
    }

    fn maybe_start_peer(&mut self, at: u64) {
        if self.direct.is_some() || !self.host.peer_host_attached() || self.direct_unfit || self.suspended || at < self.next_attempt_at {
            return;
        }
        self.start_peer(at);
    }

    // ---- signals --------------------------------------------------------------------------------

    fn names_offer(offer: &Option<OfferRef>, connection_id: &str, generation: u64) -> bool {
        offer.as_ref().is_some_and(|offer| offer.connection_id == connection_id && offer.generation == generation)
    }

    /// Which retained offer a client close names: the newest offer (live or closed), or the one
    /// before it while its close is younger than one negotiation window. Returns 1 for the newest,
    /// 2 for the previous, 0 for none.
    fn retained_offer(&mut self, connection_id: &str, generation: u64, at: u64) -> u8 {
        if self.previous_offer.as_ref().is_some_and(|previous| previous.closed_at.is_some_and(|closed| at.saturating_sub(closed) >= NEGOTIATION_TIMEOUT_MS)) {
            self.previous_offer = None;
        }
        if Self::names_offer(&self.last_offer, connection_id, generation) {
            1
        } else if Self::names_offer(&self.previous_offer, connection_id, generation) {
            2
        } else {
            0
        }
    }

    fn handle_signal(&mut self, signal: Signal) {
        if signal.at().session_id != self.session_id {
            return;
        }
        let at_ref = signal.at().clone();
        let matches = self
            .direct
            .as_ref()
            .is_some_and(|direct| direct.connection_id == at_ref.connection_id && direct.generation == at_ref.generation);
        match signal {
            Signal::Answer { sdp, fingerprints, .. } => {
                if matches && self.direct.as_ref().is_some_and(|direct| direct.peer) {
                    match self.host.peer_answer(&at_ref.connection_id, &sdp, &fingerprints) {
                        Settle::Now(Err(())) => self.jobs.push_back(Job::AnswerFailed { connection_id: at_ref.connection_id.clone() }),
                        Settle::Now(Ok(())) | Settle::Later => {}
                    }
                }
            }
            Signal::Candidate { candidate, .. } => {
                if matches && self.direct.as_ref().is_some_and(|direct| direct.peer) {
                    let _ = self.host.peer_candidate(&at_ref.connection_id, &candidate);
                }
            }
            Signal::Close { reason, .. } => {
                let at = self.host.now();
                let named = self.retained_offer(&at_ref.connection_id, at_ref.generation, at);
                // The backstop for a foreground flag stuck behind a full window: the leg stops
                // counting as foreground first. It may name a connection already closed here.
                if reason == CloseReason::Suspended && named != 0 {
                    self.host.suspended();
                }
                if reason == CloseReason::Restart {
                    // Only the newest offer, live or closed; a stale or unknown reference is a
                    // no-op. The next offer keeps the negotiation pacing.
                    if named != 1 {
                        return;
                    }
                    self.suspended = false;
                    if matches {
                        self.close_direct(&at_ref.connection_id, CloseReason::Superseded, false, Some(PathReason::ChannelFailed), Some("restart"));
                    }
                    self.maybe_start_peer(at);
                    return;
                }
                if !matches {
                    return;
                }
                if reason == CloseReason::Suspended {
                    self.suspended = true;
                }
                self.close_direct(&at_ref.connection_id, reason, false, None, None);
            }
            Signal::Offer { .. } => {}
        }
    }

    // ---- control inbound ------------------------------------------------------------------------

    fn match_pong(&mut self, key: &str, id: u64, at: u64) {
        // Only a pong for a locally timed ping still outstanding on THIS carrier, consumed once.
        let Some(entry) = self.pings.get(&id).cloned() else { return };
        if entry.0 != key {
            return;
        }
        self.pings.remove(&id);
        if key == self.current_carrier().id() {
            let latest = at as f64 - entry.1 as f64;
            if let Some(monitor) = self.monitor_of(key) {
                monitor.rtt_sample(latest);
            }
        }
        let promotable = self.direct.as_ref().is_some_and(|direct| direct.id() == key && direct.open) && !self.current_direct;
        if promotable {
            self.promote(at);
        }
    }

    fn handle_opened(&mut self, key: &str, opened: ControlOpen) {
        if self.closed {
            return;
        }
        let (value, sequence, stale) = match opened {
            ControlOpen::Stale { sequence } => (Value::Null, sequence, true),
            ControlOpen::Fresh { sequence, value } => match serde_json::from_slice::<Value>(&value) {
                Ok(value) => (value, sequence, false),
                Err(_) => {
                    self.forged += 1;
                    return;
                }
            },
        };
        if stale {
            return;
        }
        let control = match read_control(&value, sequence, false).map_err(|_| ()).and_then(|control| match control {
            Some(Control::Signal(raw)) => parse_signal(&raw, Role::Client).map(|signal| Some(ReadControl::Signal(signal))).map_err(|_| ()),
            Some(Control::Ack(ack)) => Ok(Some(ReadControl::Ack(ack))),
            Some(Control::Repair(repair)) => Ok(Some(ReadControl::Repair(repair))),
            Some(Control::Ping(ping)) => Ok(Some(ReadControl::Ping(ping))),
            None => Ok(None),
        }) {
            Ok(control) => control,
            Err(()) => {
                // An authentic stream message the client could not have meant is the end of the
                // session; a signal it could not express ends this attempt.
                if is_control_tag(&value) {
                    self.fail(EndReason::ProtocolError);
                } else if let Some(connection) = self.direct.as_ref().map(|direct| direct.connection_id.clone()) {
                    self.close_direct(&connection, CloseReason::ProtocolError, true, None, None);
                }
                return;
            }
        };
        let Some(control) = control else { return };
        let at = self.host.now();
        if let Some(monitor) = self.monitor_of(key) {
            monitor.inbound(at);
        }
        self.host.authenticated();
        match control {
            ReadControl::Ack(ack) => {
                let released = match self.sender.acknowledge(&ack, at) {
                    Ok(released) => released,
                    Err(_) => {
                        self.fail(EndReason::ProtocolError);
                        return;
                    }
                };
                if released > 0 {
                    self.current_monitor().ack_advanced(at);
                    let through = self.sender.stats().acked_through;
                    self.call_ids.retain(|sequence, _| *sequence > through);
                    self.relay_writers.retain(|sequence, _| *sequence > through);
                }
                self.note_outstanding(at);
                self.wake();
            }
            ReadControl::Repair(repair) => {
                if self.sender.repair(&repair) > 0 {
                    self.wake();
                }
            }
            ReadControl::Ping(ping) => {
                let message = ping.message().clone();
                if message.pong {
                    self.match_pong(key, message.id, at);
                    return;
                }
                let carrier = if key == RELAY_ID {
                    Some(Carrier::Relay)
                } else {
                    self.direct.as_ref().filter(|direct| direct.id() == key).map(|direct| Carrier::Direct(direct.connection_id.clone()))
                };
                if let Some(carrier) = carrier {
                    let pong = parse_text(&pong_json(message.id));
                    self.send_control(&pong, &carrier);
                }
                if let Some(sent) = message.sent {
                    self.receiver.probe(sent, at);
                }
            }
            ReadControl::Signal(signal) => {
                // Signaling travels on the relay lane only.
                if key == RELAY_ID {
                    self.handle_signal(signal);
                }
            }
        }
    }

    fn open_control(&mut self, key: &str, box_bytes: &[u8]) {
        // An honest client has far fewer control boxes in flight than records; a flood beyond the
        // reorder span is dropped (acks are cumulative, pings repeat, repairs are re-requested).
        let lane = if key == RELAY_ID {
            Some(ControlLane::Relay)
        } else {
            self.direct.as_ref().filter(|direct| direct.id() == key).map(|direct| direct.lane.clone())
        };
        let Some(lane) = lane.filter(|_| self.pending_opens < MAX_RECORDS_IN_FLIGHT) else {
            self.forged += 1;
            return;
        };
        self.pending_opens += 1;
        let result = self.channel.open_control(box_bytes, &lane);
        self.jobs.push_back(Job::ControlOpened { key: key.to_owned(), result });
    }

    // ---- application inbound --------------------------------------------------------------------

    /// Offers one opened payload to the assembler and, when whole, to the application. The
    /// result reaches `drain_run` as `Job::Assembled` (Node awaits this).
    fn assemble(&mut self, plaintext: Vec<u8>, record_bytes: usize) {
        let now = self.host.now();
        let result = match self.assembler.accept(&plaintext, now) {
            Ok(result) => result,
            Err(_) => {
                self.fail(EndReason::ProtocolError);
                self.jobs.push_back(Job::Assembled(false));
                return;
            }
        };
        let payload = match result {
            Assembly::Wait => {
                self.held = Some(Held { plaintext, bytes: record_bytes });
                self.jobs.push_back(Job::Assembled(false));
                return;
            }
            Assembly::Partial => None,
            Assembly::Complete(payload) => Some(payload),
        };
        self.held = None;
        let parsed: Value = serde_json::from_slice(&plaintext).unwrap_or(Value::Null);
        let fragment = is_fragment(&parsed);
        if fragment {
            self.assembling_bytes += fragment_bytes(&parsed);
        }
        let Some(payload) = payload else {
            self.jobs.push_back(Job::Assembled(true));
            return;
        };
        let bytes = if fragment { self.assembling_bytes } else { record_bytes };
        self.assembling_bytes = 0;
        let whole: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        let consumed = self.media.as_mut().is_some_and(|media| media.receive(&whole));
        if consumed {
            self.jobs.push_back(Job::Assembled(!self.closed));
            return;
        }
        // The application answers its own failures; the stream goes on.
        if let Settle::Now(()) = self.host.deliver(&payload, bytes) {
            self.jobs.push_back(Job::Delivered);
        }
    }

    fn drain_inbound(&mut self) {
        if self.draining {
            self.drain_again = true;
            return;
        }
        self.draining = true;
        self.drain_run(DrainInput::Start);
    }

    fn drain_run(&mut self, first: DrainInput) {
        let mut input = first;
        loop {
            match input {
                DrainInput::Start => {
                    self.drain_again = false;
                    input = DrainInput::WhileHead;
                }
                DrainInput::WhileHead => {
                    if self.closed {
                        input = DrainInput::WhileExit;
                        continue;
                    }
                    if let Some(held) = self.held.take() {
                        // `assemble` clears or re-arms `held` itself.
                        let Held { plaintext, bytes } = held;
                        self.assemble(plaintext, bytes);
                        return;
                    }
                    let Some((sequence, box_bytes)) = self.receiver.next().map(|(sequence, bytes)| (sequence, bytes.to_vec())) else {
                        input = DrainInput::WhileExit;
                        continue;
                    };
                    let bytes = box_bytes.len();
                    let result = self.channel.decrypt_json(&box_bytes);
                    self.jobs.push_back(Job::Decrypted { sequence, bytes, result });
                    return;
                }
                DrainInput::Decrypted { sequence, bytes, result } => {
                    let plaintext = match result {
                        Err(()) => {
                            if self.closed {
                                self.draining = false;
                                return;
                            }
                            // Failed authentication: that copy goes; a rival or the repair the
                            // receiver asks for refills the slot.
                            self.receiver.discard(sequence);
                            input = DrainInput::WhileHead;
                            continue;
                        }
                        Ok(plaintext) => plaintext,
                    };
                    if self.closed {
                        self.draining = false;
                        return;
                    }
                    let at = self.host.now();
                    if self.receiver.commit(sequence, at).is_err() {
                        self.draining = false;
                        return;
                    }
                    let key = self.arrived_on.get(&sequence).cloned();
                    self.arrived_on.retain(|seen, _| *seen > sequence);
                    if let Some(key) = key
                        && let Some(monitor) = self.monitor_of(&key)
                    {
                        monitor.inbound(at);
                    }
                    self.host.authenticated();
                    self.assemble(plaintext, bytes);
                    return;
                }
                DrainInput::Assembled(keep_going) => {
                    input = if keep_going { DrainInput::WhileHead } else { DrainInput::WhileExit };
                }
                DrainInput::WhileExit => {
                    if self.drain_again && !self.closed && self.held.is_none() {
                        input = DrainInput::Start;
                        continue;
                    }
                    self.draining = false;
                    let at = self.host.now();
                    self.flush_ack(at);
                    return;
                }
            }
        }
    }

    /// One carrier message as received: `relay`, or `direct:<connectionId>`.
    pub fn receive(&mut self, carrier: &str, raw: &[u8]) {
        self.receive_inner(carrier, raw);
    }

    fn receive_inner(&mut self, key: &str, raw: &[u8]) {
        if self.closed || (key != RELAY_ID && self.direct.as_ref().map(Direct::id).as_deref() != Some(key)) {
            return;
        }
        self.bytes_received += raw.len() as u64;
        if key != RELAY_ID {
            self.direct_bytes_received += raw.len() as u64;
        }
        let message = match decode_message(raw) {
            Ok(message) => message,
            Err(_) => {
                // Nothing a conforming client produces; a carrier (the relay) may.
                self.malformed += 1;
                return;
            }
        };
        let record = match message {
            Message::Control { box_bytes } => {
                self.open_control(key, &box_bytes);
                return;
            }
            Message::Record(record) => record,
        };
        let at = self.host.now();
        let result = self.receiver.accept(&record, at);
        if result == AcceptResult::Buffered {
            self.arrived_on.insert(record.sequence(), key.to_owned());
        }
        if result == AcceptResult::Duplicate {
            self.flush_ack(at);
        }
        self.drain_inbound();
    }

    // ---- application outbound -------------------------------------------------------------------

    fn pump_outbound(&mut self) {
        if self.pumping {
            return;
        }
        self.pumping = true;
        self.pump_loop();
    }

    /// The loop up to its next await (the seal), or to its end.
    fn pump_loop(&mut self) {
        loop {
            if self.closed || self.queue.is_empty() {
                self.pumping = false;
                return;
            }
            let (stream, buffered_needed) = {
                let item = &self.queue[0];
                (item.stream.clone(), item.stream.is_some())
            };
            let buffered = if buffered_needed {
                let carrier = self.current_carrier();
                self.buffered_of(&carrier)
            } else {
                0
            };
            let admission = Admission { stream: stream.as_deref(), buffered_amount: buffered };
            if !self.sender.can_admit(&admission) {
                // Dropping happens here, BEFORE sealing, never after.
                let droppable = {
                    let item = &self.queue[0];
                    item.index == 0 && (item.droppable || item.stream.is_some())
                };
                if droppable {
                    if let Some(item) = self.queue.pop_front() {
                        self.host.send_settled(item.ticket, Ok(None));
                    }
                    continue;
                }
                self.pumping = false;
                return;
            }
            let piece = {
                let item = &self.queue[0];
                item.pieces[item.index].clone()
            };
            let result = self.channel.encrypt_binary(&piece);
            self.jobs.push_back(Job::Encrypted(result));
            return;
        }
    }

    fn on_encrypted(&mut self, result: Result<Vec<u8>, SealFault>) {
        let box_bytes = match result {
            Ok(box_bytes) => box_bytes,
            Err(fault) => {
                if self.closed {
                    self.pumping = false;
                    return;
                }
                // A size refusal runs before the sequence is assigned: nothing was consumed.
                // Anything else broke the stream.
                if fault == SealFault::Oversize && self.queue.front().is_some_and(|item| item.index == 0) {
                    if let Some(item) = self.queue.pop_front() {
                        self.host.send_settled(item.ticket, Err(SendError::Range));
                    }
                    self.pump_loop();
                    return;
                }
                self.pumping = false;
                self.fail(EndReason::SealFailed);
                return;
            }
        };
        if self.closed {
            self.pumping = false;
            return;
        }
        let stream = self.queue.front().and_then(|item| item.stream.clone());
        let admission = Admission { stream: stream.as_deref(), buffered_amount: 0 };
        let sequence = match self.sender.push(box_bytes.clone(), &admission) {
            Ok(sequence) => sequence,
            Err(_) => {
                self.pumping = false;
                self.fail(EndReason::SealFailed);
                return;
            }
        };
        let Some(item) = self.queue.front_mut() else {
            self.pumping = false;
            return;
        };
        if let Some(token) = item.meter {
            self.relay_writers.insert(sequence, token);
        }
        item.wire_bytes += record_wire_bytes(box_bytes.len());
        item.index += 1;
        if item.index == item.pieces.len()
            && let Some(item) = self.queue.pop_front()
        {
            if let Some(call_id) = item.call_id {
                self.call_ids.insert(sequence, call_id);
            }
            self.host.send_settled(item.ticket, Ok(Some(item.wire_bytes)));
        }
        let at = self.host.now();
        self.note_outstanding(at);
        self.flush_carrier();
        self.pump_loop();
    }

    /// Seals one application message (its JSON text, byte for byte) and hands it to the stream.
    pub fn send(&mut self, payload: &str, options: SendOptions) -> Sent {
        let sent = self.send_inner(payload, options);
        sent
    }

    fn send_inner(&mut self, payload: &str, options: SendOptions) -> Sent {
        if self.closed {
            return Sent::Settled(Err(SendError::Ended(self.ended.as_ref().map_or(EndReason::SessionEnded, |ended| ended.reason))));
        }
        let pieces = match split_payload(payload, self.fragment_id + 1) {
            Ok(pieces) => pieces,
            Err(error) => {
                let bytes = payload.len();
                return Sent::Settled(Err(if bytes > MAX_APPLICATION_MESSAGE_BYTES {
                    SendError::Oversize(bytes)
                } else {
                    SendError::Other(error.to_string())
                }));
            }
        };
        if pieces.len() > 1 {
            self.fragment_id += 1;
        }
        let droppable = options.droppable;
        if droppable && !self.sender.can_admit(&Admission::default()) {
            return Sent::Settled(Ok(None));
        }
        self.next_ticket += 1;
        let ticket = self.next_ticket;
        self.queue.push_back(Outgoing {
            pieces,
            index: 0,
            stream: options.stream,
            droppable,
            call_id: call_id_of(payload),
            wire_bytes: 0,
            meter: options.meter,
            ticket,
        });
        self.pump_outbound();
        Sent::Queued(ticket)
    }

    /// Whether a (non-bulk) record would be admitted now.
    pub fn can_admit(&self) -> bool {
        !self.closed && self.sender.can_admit(&Admission::default())
    }

    /// The media adapter's view: whether a media record of `stream` may be sealed now.
    pub fn media_can_admit(&mut self, stream: &str) -> bool {
        if self.closed || !self.queue.is_empty() {
            return false;
        }
        let carrier = self.current_carrier();
        let buffered = self.buffered_of(&carrier);
        self.sender.can_admit(&Admission { stream: Some(stream), buffered_amount: buffered })
    }

    /// The phone broke the media bound: the session ends as for any other protocol violation.
    pub fn media_protocol_error(&mut self) {
        self.fail(EndReason::ProtocolError);
    }

    pub fn next_sequence(&self) -> u64 {
        self.sender.next_sequence()
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    /// Timers: delayed acks, loss recovery, probes, keep-alive, path health.
    pub fn tick(&mut self) {
        self.tick_inner();
    }

    fn tick_inner(&mut self) {
        if self.closed {
            return;
        }
        let at = self.host.now();
        if self.sender.expired(at) {
            self.fail(EndReason::RecordExpiry);
            return;
        }
        if self.assembler.stalled(at) {
            self.fail(EndReason::AssemblyStalled);
            return;
        }
        if let Some((connection, started_at, open)) = self.direct.as_ref().map(|direct| (direct.connection_id.clone(), direct.started_at, direct.open)) {
            if !open {
                if at - started_at >= NEGOTIATION_TIMEOUT_MS {
                    self.close_direct(&connection, CloseReason::NegotiationTimeout, true, None, None);
                }
            } else if self.current_direct {
                let carrier = Carrier::Direct(connection.clone());
                let buffered = self.buffered_of(&carrier);
                let outstanding = self.sender.stats().outstanding_bytes;
                let stall = self.direct.as_mut().and_then(|direct| {
                    direct.monitor.buffered(buffered, at);
                    direct.monitor.stalled(at, outstanding)
                });
                if let Some(stall) = stall {
                    self.close_direct(&connection, CloseReason::Stall, true, None, Some(stall_name(stall)));
                }
            } else if self.direct.as_mut().is_some_and(|direct| direct.monitor.stalled(at, 0).is_some()) {
                // Open but never validated, and silent for the idle timeout.
                self.close_direct(&connection, CloseReason::Stall, true, None, Some("silent"));
            }
        }
        let in_flight = self.relay_in_flight;
        self.relay_monitor.buffered(in_flight, at);
        self.maybe_start_peer(at);
        if self.held.is_some() {
            self.drain_inbound();
        }
        let idle = self.current_monitor().idle_timeout_ms();
        self.receiver.sweep(at, idle);
        let repairs = {
            let monitor: &dyn RttEstimate = if self.current_direct && let Some(direct) = self.direct.as_ref() { &direct.monitor } else { &self.relay_monitor };
            self.receiver.repair_due(at, monitor)
        };
        if !repairs.is_empty() {
            let message = parse_text(&repair_json(&repairs));
            let carrier = self.current_carrier();
            self.send_control(&message, &carrier);
        }
        self.flush_ack(at);
        let pto = self.current_monitor().pto_ms();
        if self.sender.probe_due(at, pto) {
            let carrier = self.current_carrier();
            self.ping(&carrier, at);
        }
        let mut carriers = vec![Carrier::Relay];
        if let Some(direct) = self.direct.as_ref().filter(|direct| direct.open) {
            carriers.push(Carrier::Direct(direct.connection_id.clone()));
        }
        for carrier in carriers {
            let last = self.last_ping_at.get(&carrier.id()).copied();
            if last.is_none_or(|last| at - last >= PING_MS) {
                self.ping(&carrier, at);
            }
        }
        self.flush_carrier();
        self.pump_outbound();
    }

    /// Ends the session from outside (client removed, revoked, replaced).
    pub fn close(&mut self, reason: EndReason) -> Ended {
        let ended = self.close_inner(reason);
        ended
    }

    fn close_inner(&mut self, end_reason: EndReason) -> Ended {
        if let Some(ended) = &self.ended {
            return ended.clone();
        }
        self.closed = true;
        let state = self.direct.take();
        self.current_direct = false;
        if let Some(state) = &state {
            self.retire_lane(&state.lane);
            if state.peer {
                let reason = if end_reason == EndReason::Revoked { CloseReason::Revoked } else { CloseReason::SessionEnded };
                self.host.peer_close(&state.connection_id, reason);
            }
        }
        self.assembler.close();
        self.held = None;
        let acked = self.sender.stats().acked_through;
        let mut ambiguous: Vec<u64> = self.call_ids.iter().filter(|(sequence, _)| **sequence > acked).map(|(_, id)| *id).collect();
        for item in &self.queue {
            if let Some(id) = item.call_id {
                ambiguous.push(id);
            }
        }
        self.call_ids.clear();
        self.relay_writers.clear();
        let ended = Ended { reason: end_reason, ambiguous_call_ids: ambiguous };
        self.ended = Some(ended.clone());
        for item in std::mem::take(&mut self.queue) {
            self.host.send_settled(item.ticket, Err(SendError::Ended(end_reason)));
        }
        // Every media pump stops; nothing more is sent.
        if let Some(media) = self.media.as_mut() {
            media.close();
        }
        let line = format!(
            "{} ended reason={} ambiguous-calls={} tx={} rx={} direct-tx={} direct-rx={}",
            self.label,
            end_reason.wire_name(),
            ended.ambiguous_call_ids.len(),
            self.bytes_sent,
            self.bytes_received,
            self.direct_bytes_sent,
            self.direct_bytes_received
        );
        self.host.log(&line);
        ended
    }

    fn fail(&mut self, end_reason: EndReason) {
        if self.closed {
            return;
        }
        let ended = self.close_inner(end_reason);
        self.host.ended(&ended);
    }

    pub fn diagnostics(&self) -> Diagnostics {
        let stats = self.sender.stats();
        let receiver = self.receiver.stats();
        let path = match (&self.direct, self.current_direct) {
            (Some(direct), true) => if direct.relayed { "turn" } else { "direct" },
            _ => "relay",
        };
        Diagnostics {
            path,
            reason: self.reason,
            bytes_sent: self.bytes_sent,
            bytes_received: self.bytes_received,
            direct_bytes_sent: self.direct_bytes_sent,
            direct_bytes_received: self.direct_bytes_received,
            queue_depth: self.queue.len(),
            outstanding_bytes: stats.outstanding_bytes,
            retransmits: stats.retransmits,
            receiver: json!({
                "deliveredThrough": receiver.delivered_through,
                "bufferedRecords": receiver.buffered_records,
                "bufferedBytes": receiver.buffered_bytes,
                "headBytes": receiver.head_bytes,
                "futureBytes": receiver.future_bytes,
                "duplicates": receiver.duplicates,
                "discarded": receiver.discarded,
                "evicted": receiver.evicted,
            }),
            turn_allocations: self.turn_allocations,
            malformed: self.malformed,
            forged: self.forged,
            retained_offers: usize::from(self.last_offer.is_some()) + usize::from(self.previous_offer.is_some()),
        }
    }
}

enum ReadControl {
    Ack(super::control::Authenticated<super::control::Ack>),
    Repair(super::control::Authenticated<super::control::Repair>),
    Ping(super::control::Authenticated<super::control::Ping>),
    Signal(Signal),
}

fn stall_name(stall: super::path::Stall) -> &'static str {
    match stall {
        super::path::Stall::Silent => "silent",
        super::path::Stall::NoProgress => "no-progress",
    }
}

fn parse_text(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}


