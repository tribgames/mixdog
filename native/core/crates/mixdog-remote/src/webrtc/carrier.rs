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
//! Each connection is one task on RT-W; a slow or dead peer stalls only its own task.

use std::sync::Arc;

use bytes::Bytes;
use bytes::BytesMut;
use mixdog_rt::TaskClass;
use tokio::sync::mpsc;
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
use super::peer;
use super::peer::PeerEvent;

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
}

impl CarrierConnection {
    /// Starts a connection; events arrive on the returned receiver. Nothing is offered until
    /// [`Self::offer`].
    pub fn spawn(config: PeerConfig) -> (Self, mpsc::UnboundedReceiver<CarrierEvent>) {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = mpsc::unbounded_channel();
        mixdog_rt::spawn("webrtc-carrier", TaskClass::Work, run(config, command_rx, events));
        (Self { commands }, event_rx)
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
    app: Arc<dyn DataChannel>,
    control: Arc<dyn DataChannel>,
}

impl Channels {
    fn get(&self, channel: CarrierChannel) -> &Arc<dyn DataChannel> {
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
) {
    let emit = |event: CarrierEvent| {
        let _ = events.send(event);
    };
    let peer::Opened { pc, events: mut peer_events } = match peer::open(&config, None).await {
        Ok(opened) => opened,
        Err(fault) => return emit(CarrierEvent::Failed(fault)),
    };
    let channels = match create_channels(pc.as_ref()).await {
        Ok(channels) => channels,
        Err(fault) => {
            let _ = pc.close().await;
            return emit(CarrierEvent::Failed(fault));
        }
    };
    let (channel_tx, mut channel_rx) = mpsc::unbounded_channel();
    for channel in [CarrierChannel::App, CarrierChannel::Control] {
        pump(channel, Arc::clone(channels.get(channel)), channel_tx.clone());
    }
    drop(channel_tx);

    let mut gate = Gate::default();
    loop {
        tokio::select! {
            raw = peer_events.recv() => {
                let Some(raw) = raw else { break };
                match peer_events.resolve(raw).await {
                    None => {}
                    Some(PeerEvent::Candidate { candidate, relay_protocol, url }) => {
                        emit(CarrierEvent::Candidate { candidate, relay_protocol, url });
                    }
                    Some(PeerEvent::Connected { remote_certificate }) => {
                        emit(CarrierEvent::Connected { remote_certificate });
                        gate.certified = true;
                        maybe_open(&pc, &mut gate, &emit).await;
                    }
                    Some(PeerEvent::Failed(fault)) => fail(&mut gate, &emit, fault),
                }
            }
            Some((channel, event)) = channel_rx.recv() => {
                on_channel_event(channel, event, &channels, &pc, &mut gate, &emit).await;
            }
            command = commands.recv() => match command {
                None => break,
                Some(command) => {
                    on_command(command, &channels, &pc, &mut gate, &emit).await;
                }
            },
        }
    }
    let _ = pc.close().await;
}

async fn create_channels(pc: &dyn PeerConnection) -> Result<Channels, PeerFault> {
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
    Ok(Channels { app, control })
}

fn pump(
    channel: CarrierChannel,
    data_channel: Arc<dyn DataChannel>,
    tx: mpsc::UnboundedSender<(CarrierChannel, DataChannelEvent)>,
) {
    mixdog_rt::spawn("webrtc-carrier-channel", TaskClass::Work, async move {
        while let Some(event) = data_channel.poll().await {
            if tx.send((channel, event)).is_err() {
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
            let buffered_amount = buffered(channels.get(channel)).await;
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

async fn buffered(channel: &Arc<dyn DataChannel>) -> usize {
    channel.outstanding_bytes().await.unwrap_or(0)
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
                let buffered_amount = buffered(channels.get(channel)).await;
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
        let payload = BytesMut::from(item.data.as_ref());
        if let Err(error) = channels.get(item.channel).send(payload).await {
            fail(gate, emit, PeerFault::new(PeerFailure::ChannelFailed, error.to_string()));
        }
    }
    for (channel, bytes) in sent {
        let buffered_amount = if gate.is_open(channel) {
            buffered(channels.get(channel)).await
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
