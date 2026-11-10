//! One viewer (paired client × browser source) of the WebRTC live view
//! (`apps/desktop/src/main/remote-webrtc/viewer.ts` at b6f10295a): the transport state machine of
//! [`TransportState`], desktop-authoritative. It keeps the JPEG relay view as the fallback that is
//! never torn down first, moves input ownership only across an epoch barrier, and never applies a
//! channel input twice or after its epoch ended.
//!
//! The viewer is driven by sync calls; the input dispatch lane (one input or release at a time, in
//! order) is the future [`Viewer::pump`] returns, which the host runs whenever [`Viewer::wants_pump`].
//! Effects run while the viewer is locked, so they must not call back into it.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::config::Candidate;
use super::config::IceServer;
use super::signal::ChannelMessage;
use super::signal::ClientSignal;
use super::signal::CloseReason;
use super::signal::ConnectionRef;
use super::signal::DesktopSignal;
use super::signal::Fingerprint;
use super::signal::Geometry;
use super::signal::ICE_TRANSPORT_POLICY;
use super::signal::IceTransportPolicy;
use super::signal::Source;
use super::signal::TransportState;
use super::signal::certificate_value_matches;
use super::signal::num_json;
use super::signal::sdp_fingerprints;

/// Offer to promotion: the STUN transaction timeout of RFC 5389 §7.2.1 with its defaults, the
/// longest a single connectivity check may take. JPEG stays on screen meanwhile.
pub const NEGOTIATION_TIMEOUT_MS: u64 = 39_500;
/// `demote` to `demote-ack`: the relay frame ack window.
pub const DEMOTE_ACK_TIMEOUT_MS: u64 = 1_500;
/// Channel input held or queued per viewer: the per-client outstanding frame budget the relay path enforces.
pub const INPUT_LIMIT: usize = 256;

/// What the host knows of the source right now.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub document_id: Option<String>,
    pub geometry: Option<Geometry>,
    /// Frames the sender took for this document and geometry generation.
    pub frames_since_current: u64,
}

#[async_trait]
pub trait ViewerEffects: Send + Sync {
    /// To this viewer's phone, over the E2EE relay.
    fn signal(&self, signal: &DesktopSignal);
    /// Sender: a new peer connection for this source.
    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String]);
    fn answer(&self, connection_id: &str, sdp: &str);
    fn candidate(&self, connection_id: &str, candidate: &Option<Candidate>);
    fn channel_send(&self, connection_id: &str, text: &str);
    fn close(&self, connection_id: &str);
    /// The source's own input path (the relay's guard, authorization and serialization).
    async fn dispatch(&self, control: &Value) -> Result<(), String>;
    /// Input left the channel: release what it holds (the mouse releases the channel still owes a page).
    async fn release(&self, releases: Vec<Value>);
    fn page(&self) -> Page;
    fn new_connection_id(&self) -> String;
    fn now(&self) -> f64;
    /// Arms a timer; the host calls [`Viewer::timer_fired`] with the returned handle when it runs.
    fn set_timer(&self, ms: u64) -> u64;
    fn clear_timer(&self, handle: u64);
    fn report(&self, event: &str, data: Value);
    fn receiver_stats(&self, stats: &Value);
    /// The connection was promoted: its channel is open for desktop pushes.
    fn promoted(&self);
}

struct Connection {
    id: String,
    generation: u64,
    ice_servers: Vec<IceServer>,
    offered: bool,
    answer: Option<Vec<Fingerprint>>,
}

#[derive(Clone)]
struct Held {
    epoch: u64,
    seq: u64,
    geometry_generation: u64,
    sent_at: f64,
    control: Value,
    received_at: f64,
}

#[derive(Clone, Copy)]
enum Timer {
    Negotiation,
    DemoteAck(CloseReason),
}

enum Job {
    Dispatch { entry: Held, input_epoch: u64 },
    Release,
}

struct Inner {
    state: TransportState,
    generation: u64,
    connection: Option<Connection>,
    /// The input epoch; relay owns epoch 1.
    epoch: u64,
    last_seq: u64,
    acked_geometry: u64,
    /// A failed attempt that never reached `webrtc` means the path does not work: no new attempt
    /// until the viewer comes back. One that did may retry.
    retry_allowed: bool,
    timer: Option<(u64, Timer)>,
    pending_ready: Option<(Vec<String>, Vec<IceServer>)>,
    held: Vec<Held>,
    queued: usize,
    lane: VecDeque<Job>,
    pumping: bool,
    /// Mouse buttons channel input pressed and has not released, as the release each needs.
    pressed: Vec<(String, Value)>,
    demote_reason: CloseReason,
}

pub struct Viewer<E> {
    source: Source,
    effects: E,
    inner: Mutex<Inner>,
}

/// The viewer's observable position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub state: TransportState,
    pub epoch: u64,
    pub connection_id: Option<String>,
    pub generation: u64,
}

type Step = Result<(), String>;

struct Machine<'a, E> {
    i: &'a mut Inner,
    e: &'a E,
    source: &'a Source,
}

impl<E: ViewerEffects> Machine<'_, E> {
    fn move_to(&mut self, to: TransportState) -> Step {
        if !self.i.state.can_move_to(to) {
            return Err(format!("remote webrtc: {} → {} is not a transition.", self.i.state.name(), to.name()));
        }
        self.e.report("state", json!({ "from": self.i.state.name(), "to": to.name(), "generation": self.i.generation, "epoch": self.i.epoch }));
        self.i.state = to;
        Ok(())
    }

    fn clear_timer(&mut self) {
        if let Some((handle, _)) = self.i.timer.take() {
            self.e.clear_timer(handle);
        }
    }

    fn arm(&mut self, ms: u64, timer: Timer) {
        self.clear_timer();
        self.i.timer = Some((self.e.set_timer(ms), timer));
    }

    fn connection_ref(&self) -> ConnectionRef {
        let connection = self.i.connection.as_ref().expect("a connection");
        ConnectionRef { source: self.source.clone(), connection_id: connection.id.clone(), generation: connection.generation }
    }

    fn start(&mut self, receive_codecs: Vec<String>, ice_servers: Vec<IceServer>) -> Step {
        if self.e.page().geometry.is_none() {
            // The offer carries the locked geometry; it starts once there is one.
            self.i.pending_ready = Some((receive_codecs, ice_servers));
            return Ok(());
        }
        self.i.pending_ready = None;
        self.i.generation += 1;
        let id = self.e.new_connection_id();
        // Attempted with whatever ICE servers there are, none included: direct pairs need no TURN,
        // and a failed attempt ends in the JPEG view that is showing meanwhile.
        self.i.connection = Some(Connection { id: id.clone(), generation: self.i.generation, ice_servers: ice_servers.clone(), offered: false, answer: None });
        self.move_to(TransportState::Negotiating)?;
        self.arm(NEGOTIATION_TIMEOUT_MS, Timer::Negotiation);
        self.e.open(&id, &ice_servers, &receive_codecs);
        Ok(())
    }

    /// Back to JPEG. Before promotion nothing moved; after, input crosses a new epoch and unsent
    /// or late channel input is never applied.
    fn fail(&mut self, reason: CloseReason) -> Step {
        let Some(failed) = self.i.connection.as_ref().map(|c| c.id.clone()) else { return Ok(()) };
        self.e.close(&failed);
        match self.i.state {
            TransportState::Negotiating | TransportState::Connected => {
                self.clear_timer();
                self.i.retry_allowed = reason == CloseReason::Superseded;
                self.close_connection(reason);
                self.move_to(TransportState::Cooldown)
            }
            TransportState::Promoting | TransportState::Webrtc => {
                self.i.retry_allowed = self.i.state == TransportState::Webrtc || reason == CloseReason::Superseded;
                self.i.demote_reason = reason;
                self.hand_back();
                let connection = self.connection_ref();
                self.e.signal(&DesktopSignal::Demote { connection, input_epoch: self.i.epoch, reason });
                self.move_to(TransportState::Demoting)?;
                self.arm(DEMOTE_ACK_TIMEOUT_MS, Timer::DemoteAck(reason));
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// A held `ready` starts once the hand-back ended, when retry is welcome.
    fn start_pending(&mut self) -> Step {
        if self.i.retry_allowed
            && let Some((codecs, servers)) = self.i.pending_ready.clone()
        {
            self.start(codecs, servers)?;
        }
        Ok(())
    }

    /// `close` for the current connection; `retryAfterMs: 0` exactly when another attempt is
    /// welcome (never a timer of ours).
    fn close_connection(&mut self, reason: CloseReason) {
        let connection = self.connection_ref();
        self.e.signal(&DesktopSignal::Close { connection, reason, retry_after_ms: self.i.retry_allowed.then_some(0) });
        self.i.connection = None;
    }

    /// Input leaves the channel (demotion, or the viewer leaving while it owned input): a new
    /// epoch, nothing held or queued is applied, and every mouse button the channel pressed is
    /// released. The one place the source's release runs.
    fn hand_back(&mut self) {
        self.i.epoch += 1;
        self.i.last_seq = 0;
        self.i.held.clear();
        // Collected in the dispatch lane, once every dispatch already running has settled: a
        // press that lands meanwhile is released too.
        self.i.lane.push_back(Job::Release);
    }

    fn enqueue(&mut self, entry: Held) -> Step {
        if self.i.queued >= INPUT_LIMIT {
            return self.fail(CloseReason::ProtocolError);
        }
        self.i.queued += 1;
        let input_epoch = self.i.epoch;
        self.i.lane.push_back(Job::Dispatch { entry, input_epoch });
        Ok(())
    }

    fn ack(&self, entry: &Held, applied: bool, queued_ms: f64, dispatch_ms: f64) {
        let Some(connection) = &self.i.connection else { return };
        let text = format!(
            r#"{{"v":1,"kind":"input-ack","epoch":{},"seq":{},"outcome":"{}","sentAt":{},"queuedMs":{},"dispatchMs":{}}}"#,
            entry.epoch,
            entry.seq,
            if applied { "applied" } else { "rejected" },
            num_json(entry.sent_at),
            num_json(queued_ms),
            num_json(dispatch_ms),
        );
        self.e.channel_send(&connection.id, &text);
    }
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<E: ViewerEffects> Viewer<E> {
    /// A viewer of a browser source; a screen source's viewer is not ported (its helper and
    /// input messages are the screen contract, not this one).
    pub fn new(source: Source, effects: E) -> Result<Self, String> {
        if !matches!(source, Source::Browser { .. }) {
            return Err("a screen source has no viewer here.".to_owned());
        }
        Ok(Self {
            source,
            effects,
            inner: Mutex::new(Inner {
                state: TransportState::Relay,
                generation: 0,
                connection: None,
                epoch: 1,
                last_seq: 0,
                acked_geometry: 0,
                retry_allowed: true,
                timer: None,
                pending_ready: None,
                held: Vec::new(),
                queued: 0,
                lane: VecDeque::new(),
                pumping: false,
                pressed: Vec::new(),
                demote_reason: CloseReason::ProtocolError,
            }),
        })
    }

    fn with<T>(&self, run: impl FnOnce(&mut Machine<'_, E>) -> T) -> T {
        let mut inner = lock(&self.inner);
        run(&mut Machine { i: &mut inner, e: &self.effects, source: &self.source })
    }

    pub fn view(&self) -> View {
        let i = lock(&self.inner);
        View {
            state: i.state,
            epoch: i.epoch,
            connection_id: i.connection.as_ref().map(|c| c.id.clone()),
            generation: i.connection.as_ref().map_or(0, |c| c.generation),
        }
    }

    /// A desktop → phone channel message: sent while the channel is up (promoting or webrtc), dropped otherwise.
    pub fn push(&self, text: &str) {
        self.with(|m| {
            if let Some(connection) = &m.i.connection
                && matches!(m.i.state, TransportState::Promoting | TransportState::Webrtc)
            {
                m.e.channel_send(&connection.id, text);
            }
        });
    }

    /// The phone can receive video: offer, unless a failure holds it back.
    pub fn ready(&self, receive_codecs: Vec<String>, ice_servers: Vec<IceServer>) -> Step {
        self.with(|m| {
            let state = m.i.state;
            if state == TransportState::Closed {
                return Ok(());
            }
            if state == TransportState::Relay || (state == TransportState::Cooldown && m.i.retry_allowed) {
                return m.start(receive_codecs, ice_servers);
            }
            if state == TransportState::Cooldown {
                return Ok(());
            }
            // The phone started over: the old connection is superseded.
            m.i.pending_ready = Some((receive_codecs.clone(), ice_servers.clone()));
            if matches!(state, TransportState::Negotiating | TransportState::Connected) {
                m.fail(CloseReason::Superseded)?;
                m.start(receive_codecs, ice_servers)
            } else if matches!(state, TransportState::Promoting | TransportState::Webrtc) {
                m.fail(CloseReason::Superseded)
            } else {
                Ok(())
            }
        })
    }

    /// The source's geometry changed or was locked: tell the phone.
    pub fn geometry_changed(&self) -> Step {
        self.with(|m| {
            let Some(geometry) = m.e.page().geometry else { return Ok(()) };
            if m.i.state == TransportState::Closed {
                return Ok(());
            }
            m.e.signal(&DesktopSignal::Geometry { source: m.source.clone(), geometry });
            let welcome = m.i.state == TransportState::Relay || (m.i.state == TransportState::Cooldown && m.i.retry_allowed);
            match m.i.pending_ready.clone() {
                Some((codecs, servers)) if welcome => m.start(codecs, servers),
                _ => Ok(()),
            }
        })
    }

    pub fn geometry_ack(&self, generation: u64) {
        self.with(|m| {
            if m.e.page().geometry.is_some_and(|g| g.generation == generation) {
                m.i.acked_geometry = generation;
            }
        });
    }

    /// A validated phone signal of a connection (`ready`, geometry acks and resize requests are the relay's).
    pub fn signal(&self, message: &ClientSignal) -> Step {
        self.with(|m| {
            let connection = match message {
                ClientSignal::Answer { connection, .. }
                | ClientSignal::Candidate { connection, .. }
                | ClientSignal::MediaReady { connection, .. }
                | ClientSignal::PromoteAck { connection, .. }
                | ClientSignal::DemoteAck { connection, .. }
                | ClientSignal::Close { connection, .. } => connection,
                ClientSignal::Ready { .. } | ClientSignal::GeometryAck { .. } | ClientSignal::ResizeRequest { .. } => return Ok(()),
            };
            let is_current = m.i.connection.as_ref().is_some_and(|c| c.id == connection.connection_id && c.generation == connection.generation);
            if !is_current {
                return Ok(());
            }
            let state = m.i.state;
            match message {
                ClientSignal::Answer { sdp, fingerprints, .. } => {
                    let connection = m.i.connection.as_mut().expect("current");
                    if state != TransportState::Negotiating || !connection.offered || connection.answer.is_some() {
                        return Ok(());
                    }
                    connection.answer = Some(fingerprints.clone());
                    m.e.answer(&connection.id, sdp);
                    Ok(())
                }
                ClientSignal::Candidate { candidate, .. } => {
                    if matches!(state, TransportState::Negotiating | TransportState::Connected | TransportState::Promoting | TransportState::Webrtc) {
                        let id = m.i.connection.as_ref().expect("current").id.clone();
                        m.e.candidate(&id, candidate);
                    }
                    Ok(())
                }
                ClientSignal::MediaReady { document_id, geometry_generation, pixel_width, pixel_height, .. } => {
                    if state != TransportState::Connected {
                        return Ok(());
                    }
                    let page = m.e.page();
                    let Some(geometry) = page.geometry else { return Ok(()) };
                    // An absent document id never equals the page's, whatever that is.
                    if document_id.is_none()
                        || *document_id != page.document_id
                        || *geometry_generation != geometry.generation
                        || m.i.acked_geometry != geometry.generation
                        || *pixel_width != geometry.pixel_width
                        || *pixel_height != geometry.pixel_height
                        || page.frames_since_current < 1
                    {
                        return Ok(());
                    }
                    m.i.epoch += 1;
                    m.i.last_seq = 0;
                    m.move_to(TransportState::Promoting)?;
                    let connection = m.connection_ref();
                    m.e.signal(&DesktopSignal::Promote { connection, input_epoch: m.i.epoch, geometry_generation: geometry.generation });
                    // Both ends' channel is open (the phone sends media-ready only then).
                    m.e.promoted();
                    Ok(())
                }
                ClientSignal::PromoteAck { input_epoch, .. } => {
                    if state != TransportState::Promoting || *input_epoch != m.i.epoch {
                        return Ok(());
                    }
                    m.clear_timer();
                    m.i.retry_allowed = true;
                    m.move_to(TransportState::Webrtc)?;
                    for entry in std::mem::take(&mut m.i.held) {
                        m.enqueue(entry)?;
                    }
                    Ok(())
                }
                ClientSignal::DemoteAck { input_epoch, .. } => {
                    if state != TransportState::Demoting || *input_epoch != m.i.epoch {
                        return Ok(());
                    }
                    m.clear_timer();
                    // The hand-back is complete: the connection closes, saying whether another
                    // attempt is welcome.
                    m.close_connection(m.i.demote_reason);
                    m.move_to(TransportState::Cooldown)?;
                    m.start_pending()
                }
                ClientSignal::Close { reason, .. } => m.fail(*reason),
                ClientSignal::Ready { .. } | ClientSignal::GeometryAck { .. } | ClientSignal::ResizeRequest { .. } => Ok(()),
            }
        })
    }

    pub fn sender_offer(&self, connection_id: &str, sdp: &str) -> Step {
        self.with(|m| {
            let Some(connection) = m.i.connection.as_ref() else { return Ok(()) };
            if connection.id != connection_id || m.i.state != TransportState::Negotiating || connection.offered {
                return Ok(());
            }
            let ice_servers = connection.ice_servers.clone();
            let geometry = m.e.page().geometry;
            let fingerprints = sdp_fingerprints(sdp)?;
            let Some(geometry) = geometry.filter(|_| !fingerprints.is_empty()) else {
                return m.fail(CloseReason::ProtocolError);
            };
            m.i.connection.as_mut().expect("current").offered = true;
            let connection = m.connection_ref();
            m.e.signal(&DesktopSignal::Offer {
                connection,
                sdp: sdp.to_owned(),
                fingerprints,
                ice_servers,
                ice_transport_policy: if ICE_TRANSPORT_POLICY == "relay" { IceTransportPolicy::Relay } else { IceTransportPolicy::All },
                geometry,
                input_epoch: m.i.epoch,
            });
            Ok(())
        })
    }

    pub fn sender_candidate(&self, connection_id: &str, candidate: Option<Candidate>) {
        self.with(|m| {
            if m.i.connection.as_ref().map(|c| c.id.as_str()) != Some(connection_id) || matches!(m.i.state, TransportState::Demoting | TransportState::Cooldown) {
                return;
            }
            let connection = m.connection_ref();
            m.e.signal(&DesktopSignal::Candidate { connection, candidate });
        });
    }

    /// DTLS is up: the peer certificate must be the one the E2EE answer named.
    pub fn sender_connected(&self, connection_id: &str, certificate: Option<&Value>) -> Step {
        self.with(|m| {
            let Some(connection) = &m.i.connection else { return Ok(()) };
            if connection.id != connection_id || m.i.state != TransportState::Negotiating {
                return Ok(());
            }
            let Some(answer) = connection.answer.clone() else { return Ok(()) };
            if !certificate.is_some_and(|certificate| certificate_value_matches(&answer, certificate)) {
                return m.fail(CloseReason::FingerprintMismatch);
            }
            m.move_to(TransportState::Connected)
        })
    }

    pub fn sender_failed(&self, connection_id: &str, reason: CloseReason) -> Step {
        self.with(|m| if m.i.connection.as_ref().map(|c| c.id.as_str()) == Some(connection_id) { m.fail(reason) } else { Ok(()) })
    }

    /// A data-channel message of this connection.
    pub fn channel(&self, connection_id: &str, text: &str, received_at: f64) -> Step {
        self.with(|m| {
            if m.i.connection.as_ref().map(|c| c.id.as_str()) != Some(connection_id) || !matches!(m.i.state, TransportState::Promoting | TransportState::Webrtc) {
                return Ok(());
            }
            // A message that does not parse, or is a screen source's, ends the connection (the
            // text is not kept: it may carry a password).
            let (epoch, seq, geometry_generation, sent_at, control) = match ChannelMessage::parse(text) {
                Ok(ChannelMessage::Input { epoch, seq, geometry_generation, sent_at, control }) => (epoch, seq, geometry_generation, sent_at, control),
                Ok(ChannelMessage::Stats(stats)) => {
                    m.e.receiver_stats(&stats);
                    return Ok(());
                }
                Ok(ChannelMessage::Screen) | Err(_) => return m.fail(CloseReason::ProtocolError),
            };
            let entry = Held { epoch, seq, geometry_generation, sent_at, control, received_at };
            if epoch != m.i.epoch {
                m.ack(&entry, false, 0.0, 0.0);
                return Ok(());
            }
            // A repeat (or a reorder, which an ordered channel never produces).
            if seq <= m.i.last_seq {
                return Ok(());
            }
            m.i.last_seq = seq;
            if m.i.state == TransportState::Webrtc {
                return m.enqueue(entry);
            }
            // Promoting: held until the relay's promote-ack proves every earlier relay input settled.
            if m.i.held.len() >= INPUT_LIMIT {
                return m.fail(CloseReason::ProtocolError);
            }
            m.i.held.push(entry);
            Ok(())
        })
    }

    /// A failure seen by the host (sender crash, source gone).
    pub fn fail(&self, reason: CloseReason) -> Step {
        self.with(|m| m.fail(reason))
    }

    /// The timer of this handle ran; a handle that is no longer armed does nothing.
    pub fn timer_fired(&self, handle: u64) -> Step {
        self.with(|m| {
            let Some((armed, timer)) = m.i.timer else { return Ok(()) };
            if armed != handle {
                return Ok(());
            }
            m.i.timer = None;
            match timer {
                Timer::Negotiation => m.fail(CloseReason::NegotiationTimeout),
                Timer::DemoteAck(reason) => {
                    // No answer (the phone may already have dropped this connection): close it so
                    // relay input is not held back for ever, and start a `ready` that arrived meanwhile.
                    m.close_connection(reason);
                    m.move_to(TransportState::Cooldown)?;
                    m.start_pending()
                }
            }
        })
    }

    /// The viewer left: everything ends.
    pub fn stop(&self) -> Step {
        self.with(|m| {
            if m.i.state == TransportState::Closed {
                return Ok(());
            }
            m.clear_timer();
            // Leaving while the channel owned input hands it back like a demotion, without one:
            // the viewer is closed, not demoted.
            if matches!(m.i.state, TransportState::Promoting | TransportState::Webrtc) {
                m.hand_back();
            } else {
                m.i.held.clear();
                m.i.epoch += 1;
            }
            if let Some(id) = m.i.connection.as_ref().map(|c| c.id.clone()) {
                m.e.close(&id);
                let connection = m.connection_ref();
                m.e.signal(&DesktopSignal::Close { connection, reason: CloseReason::ViewerLeft, retry_after_ms: None });
                m.i.connection = None;
            }
            m.i.pending_ready = None;
            m.move_to(TransportState::Closed)
        })
    }

    /// Whether jobs wait for a [`pump`](Self::pump) that is not already running.
    pub fn wants_pump(&self) -> bool {
        let i = lock(&self.inner);
        !i.pumping && !i.lane.is_empty()
    }

    /// The dispatch lane: runs the queued inputs and releases one at a time, in order, until none
    /// is left. At most one pump runs; a second returns at once.
    pub async fn pump(&self) {
        {
            let mut i = lock(&self.inner);
            if i.pumping {
                return;
            }
            i.pumping = true;
        }
        loop {
            let job = {
                let mut i = lock(&self.inner);
                let job = i.lane.pop_front();
                if job.is_none() {
                    i.pumping = false;
                }
                job
            };
            match job {
                None => return,
                Some(Job::Release) => {
                    let releases: Vec<Value> = {
                        let mut i = lock(&self.inner);
                        std::mem::take(&mut i.pressed).into_iter().map(|(_, release)| release).collect()
                    };
                    self.effects.release(releases).await;
                }
                Some(Job::Dispatch { entry, input_epoch }) => self.dispatch(entry, input_epoch).await,
            }
        }
    }

    async fn dispatch(&self, entry: Held, input_epoch: u64) {
        let started = {
            let mut inner = lock(&self.inner);
            inner.queued -= 1;
            let m = Machine { i: &mut inner, e: &self.effects, source: &self.source };
            // Demoted meanwhile: this epoch's input is never applied.
            if m.i.epoch != input_epoch || m.i.state != TransportState::Webrtc {
                m.ack(&entry, false, 0.0, 0.0);
                return;
            }
            let geometry = m.e.page().geometry;
            let coordinate = matches!(entry.control["type"].as_str(), Some("pointer" | "wheel"));
            if coordinate && !geometry.is_some_and(|g| entry.geometry_generation == g.generation && m.i.acked_geometry == g.generation) {
                m.ack(&entry, false, 0.0, 0.0);
                return;
            }
            self.effects.now()
        };
        let outcome = self.effects.dispatch(&entry.control).await;
        let mut inner = lock(&self.inner);
        let m = Machine { i: &mut inner, e: &self.effects, source: &self.source };
        let (queued_ms, dispatch_ms) = (started - entry.received_at, m.e.now() - started);
        if outcome.is_ok() {
            track(&mut m.i.pressed, &entry.control);
        }
        m.ack(&entry, outcome.is_ok(), queued_ms, dispatch_ms);
    }
}

/// Tracks what an applied channel pointer input leaves pressed.
fn track(pressed: &mut Vec<(String, Value)>, control: &Value) {
    let Some(button) = control["button"].as_str().filter(|b| control["type"] == "pointer" && *b != "none") else { return };
    match control["phase"].as_str() {
        Some("mousePressed") => {
            let release = json!({
                "type": "pointer",
                "phase": "mouseReleased",
                "x": control["x"],
                "y": control["y"],
                "button": button,
                "buttons": 0,
                "modifiers": 0,
                "clickCount": control["clickCount"],
                "documentId": control["documentId"],
            });
            match pressed.iter_mut().find(|(held, _)| held == button) {
                Some(slot) => slot.1 = release,
                None => pressed.push((button.to_owned(), release)),
            }
        }
        Some("mouseReleased") => pressed.retain(|(held, _)| held != button),
        _ => {}
    }
}
