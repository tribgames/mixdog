//! One phone's transport session on a live relay leg: the [`Coordinator`] state machine, the E2EE
//! channel it seals with, the relay writer, the direct peers (one [`CarrierConnection`] at a time)
//! and the media adapter, run as tasks of the core.
//!
//! The coordinator is synchronous and owns no I/O. Every entry point here locks it, runs one
//! operation, settles its job queue and then performs what the host callbacks asked for (relay
//! writes, deliveries, ICE lookups, peer commands) after the lock is released, so a callback never
//! re-enters the session. What those operations answer comes back through the same entry.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use super::consts::BUFFER_HIGH_BYTES;
use super::consts::CONTROL_RESERVE_BYTES;
use super::consts::MAX_ACK_DELAY_MS;
use super::coordinator::Coordinator;
use super::coordinator::EndReason;
use super::coordinator::Ended;
use super::coordinator::Host;
use super::coordinator::LocalOffer;
use super::coordinator::PeerChannel;
use super::coordinator::PeerInit;
use super::coordinator::SealFault;
use super::coordinator::SendOptions;
use super::coordinator::SendResult;
use super::coordinator::Sent;
use super::coordinator::Settle;
use super::coordinator::StreamChannel;
use super::media::MediaLink;
use super::media::TransportMedia;
use super::signal::CloseReason;
use super::split::AssemblyPool;
use crate::e2ee::Channel;
use crate::e2ee::ControlLane;
use crate::e2ee::ControlOpen;
use crate::e2ee::E2eeError;
use crate::e2ee::Sealed;
use crate::e2ee::Wire;
use crate::media::MediaSources;
use crate::webrtc::carrier::CarrierChannel;
use crate::webrtc::carrier::CarrierConnection;
use crate::webrtc::carrier::CarrierEvent;
use crate::webrtc::carrier::CarrierItem;
use crate::webrtc::config::Candidate;
use crate::webrtc::config::CandidatePath;
use crate::webrtc::config::IceServer;
use crate::webrtc::config::PeerConfig;
use crate::webrtc::config::PeerFailure;
use crate::webrtc::signal::Fingerprint;
use crate::webrtc::signal::certificate_matches;
use crate::webrtc::signal::ice_servers_json;
use crate::webrtc::signal::sdp_fingerprints;

/// The process pool every session's large-message assembly shares.
static ASSEMBLY_POOL: LazyLock<AssemblyPool> = LazyLock::new(AssemblyPool::default);

/// What a session needs from the runtime that owns the leg.
pub trait SessionEnv: Send + Sync + 'static {
    /// Writes one MXT message as one binary relay frame; resolves true once the socket took it.
    fn relay_write(&self, client_id: &str, message: Vec<u8>) -> BoxFuture<'static, bool>;
    /// Hands one application message to the target core, byte for byte.
    fn deliver(&self, client_id: &str, text: String) -> BoxFuture<'static, ()>;
    /// The session ended by itself: the client is closed with `remote transport <reason>`.
    fn ended(&self, client_id: &str, reason: &str);
    /// The ICE/TURN set for a new peer.
    fn resolve_ice(&self) -> BoxFuture<'static, Vec<IceServer>>;
    /// Authenticated inbound arrived on this client's session.
    fn live(&self, client_id: &str);
    /// The phone said it is in the background (`close{suspended}`).
    fn background(&self, client_id: &str);
    fn media_sources(&self) -> Arc<dyn MediaSources>;
}

// ---- the channel ------------------------------------------------------------------------------------------

struct ChannelAdapter(Channel);

impl StreamChannel for ChannelAdapter {
    fn encrypt_binary(&mut self, plaintext: &str) -> Result<Vec<u8>, SealFault> {
        match self.0.seal(plaintext.as_bytes(), true) {
            Ok(Sealed::Binary(box_bytes)) => Ok(box_bytes),
            Ok(Sealed::Text(_)) | Err(E2eeError::Broken) => Err(SealFault::Broken),
            Err(E2eeError::TooLarge) => Err(SealFault::Oversize),
            Err(_) => Err(SealFault::Broken),
        }
    }

    fn decrypt_json(&mut self, box_bytes: &[u8]) -> Result<Vec<u8>, ()> {
        self.0.open(Wire::Binary(box_bytes)).map_err(|_| ())
    }

    fn seal_control(&mut self, message: &Value, lane: &ControlLane) -> Result<Vec<u8>, ()> {
        self.0.seal_control(message.to_string().as_bytes(), lane).map_err(|_| ())
    }

    fn open_control(&mut self, raw: &[u8], lane: &ControlLane) -> Result<ControlOpen, ()> {
        self.0.open_control(raw, lane).map_err(|_| ())
    }

    fn register_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        self.0.register_control_lane(lane).map_err(|_| ())
    }

    fn activate_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        self.0.activate_control_lane(lane).map_err(|_| ())
    }

    fn retire_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        self.0.retire_control_lane(lane).map_err(|_| ())
    }
}

// ---- the host ---------------------------------------------------------------------------------------------

/// What a host callback asked for; performed once the coordinator is unlocked.
enum Action {
    Deliver(String),
    ResolveIce(String),
    Ended(EndReason),
}

/// One direct peer: the connection, what the phone's answer declared and the load the data
/// channels carry (`peer-window.ts`'s accounting: bytes handed to the channel writer and not yet
/// reported, plus each channel's last reported `bufferedAmount`).
struct Peer {
    connection: CarrierConnection,
    declared: Option<Vec<Fingerprint>>,
    certified: bool,
    queued: usize,
    buffered: [usize; 2],
}

impl Peer {
    fn load(&self) -> usize {
        self.queued + self.buffered[0] + self.buffered[1]
    }
}

const fn slot(channel: CarrierChannel) -> usize {
    match channel {
        CarrierChannel::App => 0,
        CarrierChannel::Control => 1,
    }
}

struct SessionHost {
    env: Arc<dyn SessionEnv>,
    client_id: String,
    started: Instant,
    peers: HashMap<String, Peer>,
    actions: Vec<Action>,
    waiters: HashMap<u64, oneshot::Sender<SendResult>>,
    /// Sends the coordinator settled before their caller registered.
    settled: HashMap<u64, SendResult>,
    session: Weak<TransportSession>,
    relay_out: mpsc::UnboundedSender<Vec<u8>>,
}

impl SessionHost {
    fn wait_for(&mut self, ticket: u64, waiter: oneshot::Sender<SendResult>) {
        match self.settled.remove(&ticket) {
            Some(result) => {
                let _ = waiter.send(result);
            }
            None => {
                self.waiters.insert(ticket, waiter);
            }
        }
    }
}

impl Host for SessionHost {
    fn now(&mut self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn log(&mut self, line: &str) {
        tracing::info!("{line}");
    }

    fn mint_connection_id(&mut self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>())
    }

    fn relay_send(&mut self, message: &[u8]) -> Settle<bool> {
        let _ = self.relay_out.send(message.to_vec());
        Settle::Later
    }

    fn relay_meter(&mut self, _token: u64, _bytes: usize) {}

    fn deliver(&mut self, payload: &[u8], _bytes: usize) -> Settle<()> {
        match String::from_utf8(payload.to_vec()) {
            Ok(text) => self.actions.push(Action::Deliver(text)),
            Err(_) => self.actions.push(Action::Ended(EndReason::ProtocolError)),
        }
        Settle::Later
    }

    fn ended(&mut self, ended: &Ended) {
        self.actions.push(Action::Ended(ended.reason));
    }

    fn authenticated(&mut self) {
        self.env.live(&self.client_id);
    }

    fn suspended(&mut self) {
        self.env.background(&self.client_id);
    }

    fn resolve_ice(&mut self, connection_id: &str) -> Settle<Result<Value, ()>> {
        self.actions.push(Action::ResolveIce(connection_id.to_owned()));
        Settle::Later
    }

    fn peer_host_attached(&mut self) -> bool {
        true
    }

    fn peer_create(&mut self, init: &PeerInit) -> Result<(), ()> {
        let (connection, events) = CarrierConnection::spawn(PeerConfig::new(init.ice_servers.clone()));
        self.peers.insert(
            init.connection_id.clone(),
            Peer { connection, declared: None, certified: false, queued: 0, buffered: [0, 0] },
        );
        let (session, id) = (self.session.clone(), init.connection_id.clone());
        tokio::spawn(pump_events(session, id, events));
        Ok(())
    }

    fn peer_offer(&mut self, connection_id: &str) -> Settle<Result<LocalOffer, ()>> {
        match self.peers.get(connection_id) {
            Some(peer) => {
                peer.connection.offer(false);
                Settle::Later
            }
            None => Settle::Now(Err(())),
        }
    }

    fn peer_answer(&mut self, connection_id: &str, sdp: &str, fingerprints: &[Fingerprint]) -> Settle<Result<(), ()>> {
        let Some(peer) = self.peers.get_mut(connection_id) else { return Settle::Now(Err(())) };
        peer.declared = Some(fingerprints.to_vec());
        peer.connection.answer(sdp.to_owned());
        Settle::Now(Ok(()))
    }

    fn peer_candidate(&mut self, connection_id: &str, candidate: &Option<Candidate>) -> Settle<Result<(), ()>> {
        let Some(peer) = self.peers.get(connection_id) else { return Settle::Now(Err(())) };
        peer.connection.candidate(candidate.clone());
        Settle::Now(Ok(()))
    }

    fn peer_send(&mut self, connection_id: &str, channel: PeerChannel, message: &[u8]) -> bool {
        let Some(peer) = self.peers.get_mut(connection_id) else { return false };
        // Refused before the first answer; app records stop CONTROL_RESERVE short of the high mark
        // so a control box always finds room, and a refusal queues nothing.
        let limit = match channel {
            PeerChannel::App => BUFFER_HIGH_BYTES - CONTROL_RESERVE_BYTES,
            PeerChannel::Control => BUFFER_HIGH_BYTES,
        };
        if peer.declared.is_none() || peer.load() + message.len() > limit {
            return false;
        }
        peer.queued += message.len();
        let channel = match channel {
            PeerChannel::App => CarrierChannel::App,
            PeerChannel::Control => CarrierChannel::Control,
        };
        peer.connection.send(vec![CarrierItem { channel, data: Bytes::copy_from_slice(message) }]);
        true
    }

    fn peer_buffered(&mut self, connection_id: &str) -> usize {
        self.peers.get(connection_id).map_or(0, Peer::load)
    }

    fn peer_close(&mut self, connection_id: &str, _reason: CloseReason) {
        self.peers.remove(connection_id);
    }

    fn send_settled(&mut self, ticket: u64, result: SendResult) {
        match self.waiters.remove(&ticket) {
            Some(waiter) => {
                let _ = waiter.send(result);
            }
            None => {
                self.settled.insert(ticket, result);
            }
        }
    }
}

const fn close_reason(failure: PeerFailure) -> CloseReason {
    match failure {
        PeerFailure::IceFailed => CloseReason::IceFailed,
        PeerFailure::DtlsFailed => CloseReason::DtlsFailed,
        PeerFailure::ProtocolError => CloseReason::ProtocolError,
        PeerFailure::PeerHostUnavailable => CloseReason::PeerHostUnavailable,
        PeerFailure::ChannelFailed | PeerFailure::Unsupported => CloseReason::ChannelFailed,
    }
}

/// Carries one connection's events into the coordinator, in order.
async fn pump_events(session: Weak<TransportSession>, connection_id: String, mut events: mpsc::UnboundedReceiver<CarrierEvent>) {
    while let Some(event) = events.recv().await {
        let Some(session) = session.upgrade() else { return };
        if session.is_closed() {
            return;
        }
        session.on_carrier_event(&connection_id, event);
    }
}

// ---- the session ------------------------------------------------------------------------------------------

type Coord = Coordinator<ChannelAdapter, SessionHost>;

pub struct TransportSession {
    coordinator: Mutex<Coord>,
    closed: AtomicBool,
    env: Arc<dyn SessionEnv>,
    client_id: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl TransportSession {
    /// Starts the session of a handshake that negotiated the transport. Nothing has been sent on
    /// the channel yet: the first message sent through [`Self::send`] is its record 1.
    pub fn open(env: Arc<dyn SessionEnv>, client_id: &str, device: String, session_id: &str, channel: Channel) -> Arc<Self> {
        let media_key = channel.media_key().copied();
        let (relay_out, relay_rx) = mpsc::unbounded_channel();
        let session = Arc::new_cyclic(|weak: &Weak<TransportSession>| {
            let host = SessionHost {
                env: env.clone(),
                client_id: client_id.to_owned(),
                started: Instant::now(),
                peers: HashMap::new(),
                actions: Vec::new(),
                waiters: HashMap::new(),
                settled: HashMap::new(),
                session: weak.clone(),
                relay_out,
            };
            Self {
                coordinator: Mutex::new(Coordinator::new(session_id, ChannelAdapter(channel), host, ASSEMBLY_POOL.clone())),
                closed: AtomicBool::new(false),
                env: env.clone(),
                client_id: client_id.to_owned(),
            }
        });
        let link = Arc::new(SessionLink { session: Arc::downgrade(&session) });
        let media = TransportMedia::new(link, env.media_sources(), media_key, Some(device));
        lock(&session.coordinator).set_media(Box::new(media));
        tokio::spawn(relay_writer(Arc::downgrade(&session), relay_rx));
        tokio::spawn(ticker(Arc::downgrade(&session)));
        session
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Runs one operation on the coordinator, settles its continuations, then performs what the
    /// host asked for.
    fn run<R>(self: &Arc<Self>, operation: impl FnOnce(&mut Coord) -> R) -> R {
        let (result, actions, closed) = {
            let mut coordinator = lock(&self.coordinator);
            let result = operation(&mut coordinator);
            coordinator.settle();
            let actions = std::mem::take(&mut coordinator.host_mut().actions);
            (result, actions, coordinator.is_closed())
        };
        if closed {
            self.closed.store(true, Ordering::Release);
        }
        for action in actions {
            self.perform(action);
        }
        result
    }

    fn perform(self: &Arc<Self>, action: Action) {
        match action {
            Action::Deliver(text) => {
                let (session, future) = (self.clone(), self.env.deliver(&self.client_id, text));
                tokio::spawn(async move {
                    future.await;
                    session.run(Coord::complete_deliver);
                });
            }
            Action::ResolveIce(connection_id) => {
                let (session, future) = (self.clone(), self.env.resolve_ice());
                tokio::spawn(async move {
                    let servers = future.await;
                    session.run(|c| c.complete_ice(&connection_id, Ok(ice_servers_json(&servers))));
                });
            }
            Action::Ended(reason) => self.env.ended(&self.client_id, reason.wire_name()),
        }
    }

    /// One MXT message from the relay carrier (a binary relay frame's payload).
    pub fn receive_relay(self: &Arc<Self>, message: &[u8]) {
        self.run(|c| c.receive("relay", message));
    }

    /// Seals and sends one application message to the phone. Resolves once it is in the stream
    /// (`Ok(None)`: dropped before sealing); fails when the session has ended.
    pub fn send(self: &Arc<Self>, text: &str, droppable: bool) -> BoxFuture<'static, SendResult> {
        let (waiter, result) = oneshot::channel();
        self.run(|c| match c.send(text, SendOptions { droppable, stream: None, meter: None }) {
            Sent::Settled(result) => {
                let _ = waiter.send(result);
            }
            Sent::Queued(ticket) => c.host_mut().wait_for(ticket, waiter),
        });
        Box::pin(async move { result.await.unwrap_or(Err(super::coordinator::SendError::Ended(EndReason::SessionEnded))) })
    }

    /// Ends the session from outside (client removed, revoked, replaced).
    pub fn close(self: &Arc<Self>, reason: EndReason) {
        self.run(|c| {
            c.close(reason);
        });
    }

    fn on_carrier_event(self: &Arc<Self>, connection_id: &str, event: CarrierEvent) {
        self.run(|c| match event {
            CarrierEvent::Offer { sdp } => {
                let local = sdp_fingerprints(&sdp).map(|fingerprints| LocalOffer { sdp, fingerprints }).map_err(|_| ());
                c.complete_offer(connection_id, local);
            }
            CarrierEvent::Candidate { candidate, .. } => c.peer_candidate_event(connection_id, candidate),
            CarrierEvent::Connected { remote_certificate } => {
                let matched = c.host_mut().peers.get_mut(connection_id).is_some_and(|peer| {
                    let ok = match (&peer.declared, &remote_certificate) {
                        (Some(declared), Some(certificate)) => certificate_matches(declared, certificate),
                        _ => false,
                    };
                    peer.certified = ok;
                    ok
                });
                // The certificate is checked before a byte from the peer is trusted.
                if !matched {
                    c.peer_closed(connection_id, CloseReason::FingerprintMismatch);
                }
            }
            CarrierEvent::Open { max_message_size, path } => {
                if c.host_mut().peers.get(connection_id).is_some_and(|peer| peer.certified) {
                    c.peer_open(connection_id, max_message_size.map(f64::from), path == Some(CandidatePath::Relay));
                }
            }
            CarrierEvent::Message { data, .. } => c.peer_message(connection_id, &data),
            CarrierEvent::Sent { channel, bytes, buffered_amount } => {
                let drained = c.host_mut().peers.get_mut(connection_id).is_some_and(|peer| {
                    let before = peer.load();
                    peer.queued = peer.queued.saturating_sub(bytes);
                    peer.buffered[slot(channel)] = buffered_amount;
                    peer.load() < before
                });
                if drained {
                    c.peer_drain(connection_id);
                }
            }
            CarrierEvent::Buffered { channel, buffered_amount } => {
                let drained = c.host_mut().peers.get_mut(connection_id).is_some_and(|peer| {
                    let before = peer.load();
                    peer.buffered[slot(channel)] = buffered_amount;
                    peer.load() < before
                });
                if drained {
                    c.peer_drain(connection_id);
                }
            }
            CarrierEvent::Failed(fault) => c.peer_closed(connection_id, close_reason(fault.reason)),
        });
    }
}

/// Writes the relay carrier's messages in the order the coordinator produced them.
async fn relay_writer(session: Weak<TransportSession>, mut messages: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(message) = messages.recv().await {
        let Some(session) = session.upgrade() else { return };
        let ok = session.env.relay_write(&session.client_id, message).await;
        session.run(|c| c.complete_relay_send(ok));
    }
}

/// The delayed-ack timer, loss recovery, probes, keep-alive and path health.
async fn ticker(session: Weak<TransportSession>) {
    let mut every = tokio::time::interval(Duration::from_millis(MAX_ACK_DELAY_MS));
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        let Some(session) = session.upgrade() else { return };
        if session.is_closed() {
            return;
        }
        session.run(Coord::tick);
    }
}

/// The media adapter's view of its session.
struct SessionLink {
    session: Weak<TransportSession>,
}

#[async_trait]
impl MediaLink for SessionLink {
    fn can_admit(&self, stream: &str) -> bool {
        self.session.upgrade().is_some_and(|session| session.run(|c| c.media_can_admit(stream)))
    }

    async fn send(&self, message: Value, stream: Option<&str>) -> Result<bool, ()> {
        let session = self.session.upgrade().ok_or(())?;
        let (waiter, result) = oneshot::channel();
        let options = SendOptions { droppable: false, stream: stream.map(str::to_owned), meter: None };
        session.run(|c| match c.send(&message.to_string(), options) {
            Sent::Settled(result) => {
                let _ = waiter.send(result);
            }
            Sent::Queued(ticket) => c.host_mut().wait_for(ticket, waiter),
        });
        match result.await {
            Ok(Ok(sent)) => Ok(sent.is_some()),
            _ => Err(()),
        }
    }

    fn protocol_error(&self) {
        // Called from inside the coordinator's own callback: ended on the next turn.
        let session = self.session.clone();
        tokio::spawn(async move {
            if let Some(session) = session.upgrade() {
                session.run(Coord::media_protocol_error);
            }
        });
    }
}
