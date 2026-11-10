//! The direct data-channel carrier of the MXT transport.
//!
//! The desktop always offers. Per connection it creates both channels before the offer, applies
//! the phone's answer and candidates, and moves carrier messages as binary in both directions.
//! The owner (the MXT coordinator) validates every signal, checks the DTLS certificate against
//! the signalled fingerprints and keeps the backpressure accounting; this module only runs the
//! connection and reports.
//!
//! Ordering promise to the owner, per connection: `Connected` (the remote certificate) is
//! emitted before `Open`, and `Open` before any `Message`, so the owner has checked the
//! certificate before it sees a byte from the peer. Messages reach it one per event in arrival
//! order, never batched or reordered.
//!
//! Each connection is one task on RT-W; a slow or dead peer stalls only its own task. Channel
//! writes go through a writer task per channel ([`Outbound`]), so a peer that stops reading
//! never stops the task from seeing the peer fail; every awaited step runs under the
//! connection's [`PeerBudget`], and coming up under [`peer::SETUP_BUDGET`].

use std::sync::Arc;

use bytes::Bytes;
use bytes::BytesMut;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use webrtc::data_channel::DataChannel;
use webrtc::data_channel::DataChannelEvent;
use webrtc::peer_connection::PeerConnection;

use super::config::BUFFER_HIGH_BYTES;
use super::config::BUFFER_LOW_BYTES;
use super::config::Candidate;
use super::config::CandidatePath;
use super::config::PeerConfig;
use super::config::PeerFailure;
use super::config::PeerFault;
use super::config::RelayProtocol;
use super::config::RemoteCertificate;
use super::config::TRANSPORT_CHANNEL_LABEL;
use super::config::TRANSPORT_CONTROL_CHANNEL_LABEL;
use super::outbound::Frame;
use super::outbound::Outbound;
use super::peer;
use super::peer::PeerBudget;
use super::peer::PeerEvent;
use super::peer::PeerEvents;
use super::peer::Raw;

/// What may wait to be written to one channel: the owner's own outstanding window, which it
/// never exceeds while the peer reads or not.
const WRITE_QUEUE_BYTES: usize = BUFFER_HIGH_BYTES;

/// `App` is `mixdog-transport` (MXT kinds 1 and 2); `Control` is `mixdog-transport-control`
/// (kind 3, its own SCTP stream so it never waits behind bulk traffic).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CarrierChannel {
    App,
    Control,
}

impl CarrierChannel {
    const fn name(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Control => "control",
        }
    }
}

#[derive(Debug)]
pub enum CarrierEvent {
    Offer {
        sdp: String,
    },
    /// A local candidate; `None` ends the gathering. `relay_protocol` and `url` only on a TURN
    /// relay candidate.
    Candidate {
        candidate: Option<Candidate>,
        relay_protocol: Option<RelayProtocol>,
        url: Option<String>,
    },
    Connected {
        remote_certificate: Option<RemoteCertificate>,
    },
    /// Both channels are open. `max_message_size` is the SCTP transport's limit; `path` the
    /// selected pair's path (direct, then TURN).
    Open {
        max_message_size: Option<u32>,
        path: Option<CandidatePath>,
    },
    Message {
        channel: CarrierChannel,
        data: Bytes,
    },
    /// A `send` item was handed to its channel (or dropped, channel not open): `bytes` leave
    /// the owner's queue, `buffered_amount` is read right after.
    Sent {
        channel: CarrierChannel,
        bytes: usize,
        buffered_amount: usize,
    },
    /// The channel drained to the low mark, or a `sample` was asked.
    Buffered {
        channel: CarrierChannel,
        buffered_amount: usize,
    },
    Failed(PeerFault),
}

pub struct CarrierItem {
    pub channel: CarrierChannel,
    pub data: Bytes,
}

enum Command {
    Offer { ice_restart: bool },
    Answer(String),
    Candidate(Option<Candidate>),
    Send(Vec<CarrierItem>),
    Sample,
}

/// The owner's handle. Dropping it closes the connection.
pub struct CarrierConnection {
    commands: mpsc::UnboundedSender<Command>,
    budget: PeerBudget,
}

impl Drop for CarrierConnection {
    fn drop(&mut self) {
        self.budget.close();
    }
}

impl CarrierConnection {
    /// Starts a connection; events arrive on the returned receiver. Nothing is offered until
    /// [`Self::offer`].
    pub fn spawn(config: PeerConfig) -> (Self, mpsc::UnboundedReceiver<CarrierEvent>) {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = mpsc::unbounded_channel();
        let budget = PeerBudget::default();
        mixdog_rt::spawn(
            "webrtc-carrier",
            TaskClass::Work,
            run(config, command_rx, events, budget.clone()),
        );
        (Self { commands, budget }, event_rx)
    }

    /// The first offer, or an ICE restart (`ice_restart`) on the same connection.
    pub fn offer(&self, ice_restart: bool) {
        let _ = self.commands.send(Command::Offer { ice_restart });
    }

    pub fn answer(&self, sdp: String) {
        let _ = self.commands.send(Command::Answer(sdp));
    }

    /// `None` is the peer's end of candidates.
    pub fn candidate(&self, candidate: Option<Candidate>) {
        let _ = self.commands.send(Command::Candidate(candidate));
    }

    /// Carrier messages in order; every item is answered by a `Sent` report.
    pub fn send(&self, items: Vec<CarrierItem>) {
        let _ = self.commands.send(Command::Send(items));
    }

    /// Reports both channels' buffered amount now.
    pub fn sample(&self) {
        let _ = self.commands.send(Command::Sample);
    }
}

struct Channels {
    app: Outbound,
    control: Outbound,
}

/// What the pumps and the writers tell the connection's loop.
enum ChannelInput {
    Event(DataChannelEvent),
    WriteFailed(String),
}

impl Channels {
    fn get(&self, channel: CarrierChannel) -> &Outbound {
        match channel {
            CarrierChannel::App => &self.app,
            CarrierChannel::Control => &self.control,
        }
    }
}

#[derive(Default)]
struct Gate {
    certified: bool,
    app_open: bool,
    control_open: bool,
    opened: bool,
    held: Vec<(CarrierChannel, Bytes)>,
    held_bytes: usize,
    failed: bool,
}

impl Gate {
    fn channel_open(&mut self, channel: CarrierChannel) {
        match channel {
            CarrierChannel::App => self.app_open = true,
            CarrierChannel::Control => self.control_open = true,
        }
    }

    fn is_open(&self, channel: CarrierChannel) -> bool {
        match channel {
            CarrierChannel::App => self.app_open,
            CarrierChannel::Control => self.control_open,
        }
    }

    fn ready(&self) -> bool {
        !self.opened && !self.failed && self.certified && self.app_open && self.control_open
    }
}

async fn run(
    config: PeerConfig,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<CarrierEvent>,
    budget: PeerBudget,
) {
    let emit = |event: CarrierEvent| {
        let _ = events.send(event);
    };
    let setup = tokio::time::sleep(peer::SETUP_BUDGET);
    tokio::pin!(setup);
    let opened = budget.step("open", peer::open(&config, || Ok(None))).await.and_then(|opened| opened);
    let peer::Opened { pc, events: mut peer_events } = match opened {
        Ok(opened) => opened,
        Err(fault) => return emit(CarrierEvent::Failed(fault)),
    };
    let created = budget.step("create channels", create_channels(pc.as_ref())).await.and_then(|created| created);
    let (app, control) = match created {
        Ok(channels) => channels,
        Err(fault) => {
            budget.close();
            peer::close(&pc).await;
            return emit(CarrierEvent::Failed(fault));
        }
    };
    let (channel_tx, mut channel_rx) = mpsc::unbounded_channel();
    let outbound = |channel: CarrierChannel, data_channel: Arc<dyn DataChannel>| {
        pump(channel, Arc::clone(&data_channel), channel_tx.clone(), budget.token());
        let write_failed = channel_tx.clone();
        Outbound::new("webrtc-carrier-writer", Arc::new(data_channel), WRITE_QUEUE_BYTES, move |detail| {
            let _ = write_failed.send((channel, ChannelInput::WriteFailed(detail)));
        })
    };
    let channels = Channels {
        app: outbound(CarrierChannel::App, app),
        control: outbound(CarrierChannel::Control, control),
    };
    drop(channel_tx);

    let mut gate = Gate::default();
    loop {
        tokio::select! {
            raw = peer_events.recv() => {
                let Some(raw) = raw else { break };
                let handled = budget.step("peer event", on_peer_event(raw, &peer_events, &pc, &mut gate, &emit)).await;
                if let Err(fault) = handled {
                    fail(&mut gate, &emit, fault);
                }
            }
            Some((channel, input)) = channel_rx.recv() => {
                let handled = budget
                    .step("channel event", on_channel_input(channel, input, &channels, &pc, &mut gate, &emit))
                    .await;
                if let Err(fault) = handled {
                    fail(&mut gate, &emit, fault);
                }
            }
            command = commands.recv() => match command {
                None => break,
                Some(command) => {
                    let handled = budget.step("command", on_command(command, &channels, &pc, &mut gate, &emit)).await;
                    if let Err(fault) = handled {
                        fail(&mut gate, &emit, fault);
                    }
                }
            },
            () = &mut setup, if !gate.opened && !gate.failed => {
                let reason = if gate.certified { PeerFailure::ChannelFailed } else { PeerFailure::IceFailed };
                fail(&mut gate, &emit, PeerFault::new(reason, "setup timed out"));
            }
        }
    }
    budget.close();
    peer::close(&pc).await;
}

async fn on_peer_event(
    raw: Raw,
    peer_events: &PeerEvents,
    pc: &Arc<dyn PeerConnection>,
    gate: &mut Gate,
    emit: &impl Fn(CarrierEvent),
) {
    match peer_events.resolve(raw).await {
        None => {}
        Some(PeerEvent::Candidate { candidate, relay_protocol, url }) => {
            emit(CarrierEvent::Candidate { candidate, relay_protocol, url });
        }
        Some(PeerEvent::Connected { remote_certificate }) => {
            emit(CarrierEvent::Connected { remote_certificate });
            gate.certified = true;
            maybe_open(pc, gate, emit).await;
        }
        Some(PeerEvent::Failed(fault)) => fail(gate, emit, fault),
    }
}

async fn on_channel_input(
    channel: CarrierChannel,
    input: ChannelInput,
    channels: &Channels,
    pc: &Arc<dyn PeerConnection>,
    gate: &mut Gate,
    emit: &impl Fn(CarrierEvent),
) {
    match input {
        ChannelInput::Event(event) => on_channel_event(channel, event, channels, pc, gate, emit).await,
        ChannelInput::WriteFailed(detail) => fail(gate, emit, PeerFault::new(PeerFailure::ChannelFailed, detail)),
    }
}

async fn create_channels(pc: &dyn PeerConnection) -> Result<(Arc<dyn DataChannel>, Arc<dyn DataChannel>), PeerFault> {
    // Both channels exist before the offer, so it negotiates SCTP for them. Both ordered: the
    // `direct:<connectionId>` control lane opens its boxes in seal order.
    let fault = |e: webrtc::error::Error| PeerFault::new(PeerFailure::PeerHostUnavailable, e.to_string());
    let app = pc
        .create_data_channel(TRANSPORT_CHANNEL_LABEL, None)
        .await
        .map_err(fault)?;
    let control = pc
        .create_data_channel(TRANSPORT_CONTROL_CHANNEL_LABEL, None)
        .await
        .map_err(fault)?;
    // Before the first send: the drain signal the owner resumes on.
    for channel in [&app, &control] {
        channel
            .set_buffered_amount_low_threshold(BUFFER_LOW_BYTES)
            .await
            .map_err(fault)?;
    }
    Ok((app, control))
}

fn pump(
    channel: CarrierChannel,
    data_channel: Arc<dyn DataChannel>,
    tx: mpsc::UnboundedSender<(CarrierChannel, ChannelInput)>,
    closed: CancellationToken,
) {
    mixdog_rt::spawn("webrtc-carrier-channel", TaskClass::Work, async move {
        loop {
            let event = tokio::select! {
                biased;
                () = closed.cancelled() => break,
                event = data_channel.poll() => event,
            };
            let Some(event) = event else { break };
            if tx.send((channel, ChannelInput::Event(event))).is_err() {
                break;
            }
        }
    });
}

fn fail(gate: &mut Gate, emit: &impl Fn(CarrierEvent), fault: PeerFault) {
    if !gate.failed {
        gate.failed = true;
        emit(CarrierEvent::Failed(fault));
    }
}

async fn maybe_open(pc: &Arc<dyn PeerConnection>, gate: &mut Gate, emit: &impl Fn(CarrierEvent)) {
    if !gate.ready() {
        return;
    }
    let path = peer::selected_pair(pc.as_ref()).await.map(|pair| pair.path());
    let max_message_size = match pc.sctp().await {
        Some(sctp) => sctp.max_message_size().await.ok(),
        None => None,
    };
    emit(CarrierEvent::Open {
        max_message_size,
        path,
    });
    gate.opened = true;
    gate.held_bytes = 0;
    for (channel, data) in std::mem::take(&mut gate.held) {
        emit(CarrierEvent::Message { channel, data });
    }
}

async fn on_channel_event(
    channel: CarrierChannel,
    event: DataChannelEvent,
    channels: &Channels,
    pc: &Arc<dyn PeerConnection>,
    gate: &mut Gate,
    emit: &impl Fn(CarrierEvent),
) {
    match event {
        DataChannelEvent::OnOpen => {
            gate.channel_open(channel);
            maybe_open(pc, gate, emit).await;
        }
        DataChannelEvent::OnMessage(message) => {
            // The carriers move binary transport messages only.
            if gate.failed || message.is_string {
                return;
            }
            let data = message.data.freeze();
            if gate.opened {
                emit(CarrierEvent::Message { channel, data });
            } else if gate.held_bytes + data.len() <= BUFFER_HIGH_BYTES {
                // Before the owner checked the certificate: held, at most the high-water mark
                // (beyond it the records are lost and the receiver repairs them).
                gate.held_bytes += data.len();
                gate.held.push((channel, data));
            }
        }
        DataChannelEvent::OnBufferedAmountLow => {
            let buffered_amount = channels.get(channel).buffered().await;
            emit(CarrierEvent::Buffered {
                channel,
                buffered_amount,
            });
        }
        DataChannelEvent::OnClose => fail(
            gate,
            emit,
            PeerFault::new(PeerFailure::ChannelFailed, format!("{} channel closed", channel.name())),
        ),
        DataChannelEvent::OnError => fail(
            gate,
            emit,
            PeerFault::new(PeerFailure::ChannelFailed, format!("{} channel error", channel.name())),
        ),
        _ => {}
    }
}

async fn on_command(
    command: Command,
    channels: &Channels,
    pc: &Arc<dyn PeerConnection>,
    gate: &mut Gate,
    emit: &impl Fn(CarrierEvent),
) {
    match command {
        Command::Offer { ice_restart } => match peer::make_offer(pc.as_ref(), ice_restart).await {
            Ok(sdp) => emit(CarrierEvent::Offer { sdp }),
            Err(fault) => fail(gate, emit, fault),
        },
        Command::Answer(sdp) => {
            if let Err(fault) = peer::apply_answer(pc.as_ref(), sdp).await {
                fail(gate, emit, fault);
            }
        }
        Command::Candidate(candidate) => peer::add_candidate(pc.as_ref(), candidate).await,
        Command::Send(items) => send(items, channels, gate, emit).await,
        Command::Sample => {
            for channel in [CarrierChannel::App, CarrierChannel::Control] {
                let buffered_amount = channels.get(channel).buffered().await;
                emit(CarrierEvent::Buffered {
                    channel,
                    buffered_amount,
                });
            }
        }
    }
}

async fn send(items: Vec<CarrierItem>, channels: &Channels, gate: &mut Gate, emit: &impl Fn(CarrierEvent)) {
    // One `Sent` per channel, in first-seen order.
    let mut sent: Vec<(CarrierChannel, usize)> = Vec::new();
    for item in items {
        match sent.iter_mut().find(|(channel, _)| *channel == item.channel) {
            Some((_, bytes)) => *bytes += item.data.len(),
            None => sent.push((item.channel, item.data.len())),
        }
        if gate.failed || !gate.is_open(item.channel) {
            continue;
        }
        // Queued for the channel's writer task; a full queue means the peer is not reading.
        let payload = Frame::Binary(BytesMut::from(item.data.as_ref()));
        if channels.get(item.channel).push(payload).is_err() {
            fail(
                gate,
                emit,
                PeerFault::new(PeerFailure::ChannelFailed, format!("{} send queue overflow", item.channel.name())),
            );
        }
    }
    for (channel, bytes) in sent {
        let buffered_amount = if gate.is_open(channel) {
            channels.get(channel).buffered().await
        } else {
            0
        };
        emit(CarrierEvent::Sent {
            channel,
            bytes,
            buffered_amount,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::time::Duration;

    use super::super::outbound::fakes::Stalled;
    use super::*;

    fn stalled_channels(cap: usize) -> Channels {
        mixdog_rt::testing::tokens();
        let outbound = || Outbound::new("test-writer", Arc::new(Stalled), cap, |_| {});
        Channels {
            app: outbound(),
            control: outbound(),
        }
    }

    fn item(channel: CarrierChannel, len: usize) -> CarrierItem {
        CarrierItem {
            channel,
            data: Bytes::from(vec![0u8; len]),
        }
    }

    fn open_gate() -> Gate {
        Gate {
            app_open: true,
            control_open: true,
            ..Gate::default()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_send_to_a_peer_that_stopped_reading_returns_and_reports_what_waits() {
        let channels = stalled_channels(1_000);
        let mut gate = open_gate();
        let events = RefCell::new(Vec::new());
        let emit = |event: CarrierEvent| events.borrow_mut().push(event);
        let items = vec![item(CarrierChannel::App, 10), item(CarrierChannel::App, 20)];
        tokio::time::timeout(Duration::from_secs(1), send(items, &channels, &mut gate, &emit))
            .await
            .expect("the send does not wait on the peer");
        assert!(!gate.failed);
        let events = events.into_inner();
        assert!(
            matches!(
                events.as_slice(),
                [CarrierEvent::Sent { channel: CarrierChannel::App, bytes: 30, buffered_amount: 30 }]
            ),
            "{events:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_queue_that_overflows_fails_the_carrier_once() {
        let channels = stalled_channels(8);
        let mut gate = open_gate();
        let events = RefCell::new(Vec::new());
        let emit = |event: CarrierEvent| events.borrow_mut().push(event);
        let items = vec![item(CarrierChannel::Control, 9), item(CarrierChannel::Control, 9)];
        tokio::time::timeout(Duration::from_secs(1), send(items, &channels, &mut gate, &emit))
            .await
            .expect("the send does not wait on the peer");
        assert!(gate.failed);
        let events = events.into_inner();
        let failures: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                CarrierEvent::Failed(fault) => Some(fault),
                _ => None,
            })
            .collect();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].reason, PeerFailure::ChannelFailed);
        assert_eq!(failures[0].detail.as_deref(), Some("control send queue overflow"));
    }
}
