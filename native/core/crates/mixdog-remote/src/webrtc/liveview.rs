//! One phone's live-view connection: the VP8 video track of a source and the reliable ordered
//! input channel `mixdog-input`.
//!
//! The desktop offers. The offer carries only VP8, and only when the phone lists it in
//! `receiveCodecs`; fixed resolution (frame rate gives way under congestion, never size) is the
//! track's `maintain_resolution` rule. Encoded pictures come from the source's [`Vp8Track`]
//! (shared by all viewers of the source); this connection only packetises them. Send-side
//! congestion control (GCC over transport-wide feedback) narrows the track's bitrate to what the
//! path carries, and a viewer's PLI/FIR asks the track for a keyframe.
//!
//! Each connection is one task on RT-W plus a writer task; a slow phone stalls only those. Input
//! channel writes go through [`Outbound`], every awaited step runs under the connection's
//! [`PeerBudget`], and coming up under [`peer::SETUP_BUDGET`].

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::media::EncodingParams;
use mixdog_core_api::domain::media::MediaError;
use mixdog_core_api::domain::media::VideoTrack;
use mixdog_core_api::domain::media::negotiate_codec;
use mixdog_rt::MediaThread;
use mixdog_rt::TaskClass;
use rtc::interceptor::Attribute;
use rtc::interceptor::BandwidthEstimator;
use rtc::interceptor::EstimatorStats;
use rtc::interceptor::Gcc;
use rtc::interceptor::Interceptor;
use rtc::interceptor::Packet;
use rtc::interceptor::PacketReport;
use rtc::interceptor::Slot;
use rtc::interceptor::StreamInfo;
use rtc::interceptor::TaggedPacket;
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::CongestionFeedback;
use rtc::peer_connection::configuration::interceptor_registry::configure_congestion_control;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_VP8;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp_transceiver::RTCRtpTransceiverDirection;
use rtc::rtp_transceiver::RTCRtpTransceiverInit;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodingParameters;
use rtc::rtp_transceiver::rtp_sender::RTCRtpEncodingParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use rtc::sansio::Protocol;
use rtc::shared::error::Error as RtcError;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use webrtc::data_channel::DataChannel;
use webrtc::data_channel::DataChannelEvent;
use webrtc::media_stream::Track;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::TrackLocalEvent;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::PeerConnection;
use webrtc::peer_connection::Registry;
use webrtc::peer_connection::StatsSelector;
use webrtc::rtp_transceiver::RtpSender;

use super::config::Candidate;
use super::config::CandidatePair;
use super::config::INPUT_CHANNEL_LABEL;
use super::config::PeerConfig;
use super::config::PeerFailure;
use super::config::PeerFault;
use super::config::RemoteCertificate;
use super::outbound::Frame;
use super::outbound::Outbound;
use super::peer;
use super::peer::MediaSetup;
use super::peer::PeerBudget;
use super::peer::PeerEvent;
use super::capture::SharedSource;
use super::track::Subscription;
use super::track::TrackStats;
use super::track::Vp8Track;

#[cfg(test)]
pub(crate) static SKIP_FIRST_KEYFRAME: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

const VP8_PAYLOAD_TYPE: u8 = 96;
const VIDEO_CLOCK_RATE: u32 = 90_000;
/// Where the congestion estimator starts, floors and tops out.
const INITIAL_BITRATE_BPS: f64 = 1_000_000.0;
const MIN_BITRATE_BPS: f64 = 100_000.0;
const MAX_BITRATE_BPS: f64 = 8_000_000.0;
/// What may wait to be written to the input channel (the phone's state pushes are small).
const INPUT_QUEUE_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum LiveViewEvent {
    Offer {
        sdp: String,
    },
    /// A local candidate; `None` ends the gathering.
    Candidate {
        candidate: Option<Candidate>,
    },
    Connected {
        remote_certificate: Option<RemoteCertificate>,
    },
    /// The input channel is open: the owner may push its state.
    ChannelOpen,
    /// A text message from the phone, stamped with the wall clock at receipt.
    Channel {
        text: String,
        received_at_ms: u64,
    },
    Failed(PeerFault),
}

/// The sender's view of one connection (the measurement line's outbound half).
#[derive(Clone, Debug)]
pub struct SenderStats {
    pub codec: &'static str,
    pub encoder_implementation: &'static str,
    pub frames_encoded: u64,
    pub frames_sent: u64,
    pub total_encode_time_ms: f64,
    pub frame_width: u32,
    pub frame_height: u32,
    pub target_bitrate: Option<f64>,
    pub bytes_sent: u64,
    pub candidate_pair: Option<CandidatePair>,
}

enum Command {
    Answer(String),
    Candidate(Option<Candidate>),
    ChannelSend(String),
    Stats(oneshot::Sender<Option<SenderStats>>),
}

/// The owner's handle. Dropping it closes the connection and stops its encoder.
pub struct LiveViewConnection {
    commands: mpsc::UnboundedSender<Command>,
    track: Arc<Vp8Track>,
    budget: PeerBudget,
}

impl Drop for LiveViewConnection {
    fn drop(&mut self) {
        self.budget.close();
    }
}

impl LiveViewConnection {
    /// Starts a connection that streams the shared `source` to one phone through an encoder of
    /// its own: this phone's limits, congestion estimate and keyframe requests touch nobody else.
    /// The offer arrives as [`LiveViewEvent::Offer`]; when the phone lists no VP8 in
    /// `receive_codecs` the connection fails `Unsupported` before it offers.
    pub fn spawn(
        config: PeerConfig,
        receive_codecs: Vec<String>,
        source: Arc<SharedSource>,
        media: MediaThread,
    ) -> std::io::Result<(Self, mpsc::UnboundedReceiver<LiveViewEvent>)> {
        let track = Vp8Track::start(media, source)?;
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (events, event_rx) = mpsc::unbounded_channel();
        let budget = PeerBudget::default();
        mixdog_rt::spawn(
            "webrtc-liveview",
            TaskClass::Work,
            run(config, receive_codecs, Arc::clone(&track), command_rx, events, budget.clone()),
        );
        Ok((Self { commands, track, budget }, event_rx))
    }

    /// The phone's `maxBitrate` / `maxFramerate` commands: this connection's encoder only.
    pub fn set_encoding(&self, params: EncodingParams) -> Result<(), MediaError> {
        self.track.set_encoding(params)
    }

    pub fn encoding(&self) -> EncodingParams {
        self.track.encoding()
    }

    /// This viewer's encoder counters.
    pub fn track_stats(&self) -> TrackStats {
        self.track.stats()
    }

    pub fn answer(&self, sdp: String) {
        let _ = self.commands.send(Command::Answer(sdp));
    }

    /// `None` is the phone's end of candidates.
    pub fn candidate(&self, candidate: Option<Candidate>) {
        let _ = self.commands.send(Command::Candidate(candidate));
    }

    /// A desktop → phone message on the input channel (dropped while it is not open).
    pub fn channel_send(&self, text: String) {
        let _ = self.commands.send(Command::ChannelSend(text));
    }

    /// `None` when the connection is gone or does not answer within the step budget.
    pub async fn stats(&self) -> Option<SenderStats> {
        request_stats(&self.budget, &self.commands).await
    }
}

async fn request_stats(budget: &PeerBudget, commands: &mpsc::UnboundedSender<Command>) -> Option<SenderStats> {
    let (tx, rx) = oneshot::channel();
    commands.send(Command::Stats(tx)).ok()?;
    budget.step("stats", rx).await.ok()?.ok().flatten()
}

/// Passes inbound keyframe requests (PLI and FIR) on to the application and drops every other
/// inbound RTCP packet: the rest is for the interceptors that already acted on it.
struct KeyframeRequests {
    read_queue: std::collections::VecDeque<TaggedPacket>,
    write_queue: std::collections::VecDeque<TaggedPacket>,
}

impl KeyframeRequests {
    fn new() -> Self {
        Self {
            read_queue: Default::default(),
            write_queue: Default::default(),
        }
    }
}

fn is_keyframe_request(packet: &dyn rtc::rtcp::Packet) -> bool {
    let any = packet.as_any();
    any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for KeyframeRequests {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = RtcError;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let requests: Vec<Box<dyn rtc::rtcp::Packet>> = packets
                .iter()
                .filter(|packet| is_keyframe_request(packet.as_ref()))
                .cloned()
                .collect();
            if requests.is_empty() {
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(requests);
            // Inbound RTCP stops at the end of the chain unless something vouches for it.
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read_queue.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read_queue.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.write_queue.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write_queue.pop_front()
    }
}

impl Interceptor for KeyframeRequests {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

/// Publishes the wrapped estimator's target after every update, where the writer reads it.
struct ReportingEstimator<E: BandwidthEstimator> {
    inner: E,
    target: Arc<AtomicU64>,
}

impl<E: BandwidthEstimator> ReportingEstimator<E> {
    fn publish(&self) {
        self.target
            .store(self.inner.target_bitrate().to_bits(), Ordering::Relaxed);
    }
}

impl<E: BandwidthEstimator> BandwidthEstimator for ReportingEstimator<E> {
    fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
        self.inner.on_reports(now, reports);
        self.publish();
    }

    fn target_bitrate(&self) -> f64 {
        self.inner.target_bitrate()
    }

    fn handle_timeout(&mut self, now: Instant) {
        self.inner.handle_timeout(now);
        self.publish();
    }

    fn poll_timeout(&self) -> Option<Instant> {
        self.inner.poll_timeout()
    }

    fn stats(&self) -> EstimatorStats {
        self.inner.stats()
    }
}

fn vp8_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: MIME_TYPE_VP8.to_owned(),
            clock_rate: VIDEO_CLOCK_RATE,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        },
        payload_type: VP8_PAYLOAD_TYPE,
    }
}

fn media_setup(target: Arc<AtomicU64>) -> Result<MediaSetup, PeerFault> {
    let fault = |e: RtcError| PeerFault::new(PeerFailure::PeerHostUnavailable, e.to_string());
    let mut engine = MediaEngine::default();
    // The only codec the core implements.
    engine
        .register_codec(vp8_codec(), RtpCodecKind::Video)
        .map_err(fault)?;
    let estimator = ReportingEstimator {
        inner: Gcc::new(INITIAL_BITRATE_BPS, MIN_BITRATE_BPS, MAX_BITRATE_BPS),
        target,
    };
    estimator.publish();
    let registry = configure_congestion_control(
        Registry::new(),
        estimator,
        CongestionFeedback::Twcc,
        &mut engine,
    )
    .map_err(fault)?;
    let registry = register_default_interceptors(registry, &mut engine).map_err(fault)?;
    // Application-most, so every interceptor has seen all inbound RTCP before it is narrowed.
    let registry = registry.with(Slot::from(14_000), KeyframeRequests::new());
    Ok(MediaSetup { engine, registry })
}

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

struct Live {
    pc: Arc<dyn PeerConnection>,
    input: Outbound,
    sender: Arc<dyn RtpSender>,
    track: Arc<Vp8Track>,
    connected: bool,
    input_open: bool,
    failed: bool,
}

async fn run(
    config: PeerConfig,
    receive_codecs: Vec<String>,
    track: Arc<Vp8Track>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events: mpsc::UnboundedSender<LiveViewEvent>,
    budget: PeerBudget,
) {
    let emit = |event: LiveViewEvent| {
        let _ = events.send(event);
    };
    if negotiate_codec(&receive_codecs).is_none() {
        return emit(LiveViewEvent::Failed(PeerFault::new(
            PeerFailure::Unsupported,
            "no common video codec",
        )));
    }
    let estimate = Arc::new(AtomicU64::new(INITIAL_BITRATE_BPS.to_bits()));
    let setup = match media_setup(Arc::clone(&estimate)) {
        Ok(setup) => setup,
        Err(fault) => return emit(LiveViewEvent::Failed(fault)),
    };
    let setup_deadline = mixdog_rt::time::sleep(peer::SETUP_BUDGET);
    tokio::pin!(setup_deadline);
    let opened = budget
        .step("open", peer::open(&config, Some(setup)))
        .await
        .and_then(|opened| opened);
    let peer::Opened { pc, events: mut peer_events } = match opened {
        Ok(opened) => opened,
        Err(fault) => return emit(LiveViewEvent::Failed(fault)),
    };
    let local_track = match build_track() {
        Ok(local_track) => local_track,
        Err(fault) => {
            budget.close();
            peer::close(&pc).await;
            return emit(LiveViewEvent::Failed(fault));
        }
    };
    let attached = budget
        .step("attach", attach(pc.as_ref(), &local_track))
        .await
        .and_then(|attached| attached);
    let (input, sender) = match attached {
        Ok(parts) => parts,
        Err(fault) => {
            budget.close();
            peer::close(&pc).await;
            return emit(LiveViewEvent::Failed(fault));
        }
    };
    let key_wanted = Arc::new(Notify::new());
    spawn_feedback_reader(Arc::clone(&local_track), Arc::clone(&key_wanted), budget.token());
    let (input_tx, mut input_rx) = mpsc::unbounded_channel();
    {
        let input = Arc::clone(&input);
        let closed = budget.token();
        mixdog_rt::spawn("webrtc-liveview-input", TaskClass::Work, async move {
            loop {
                let event = tokio::select! {
                    biased;
                    () = closed.cancelled() => break,
                    event = input.poll() => event,
                };
                let Some(event) = event else { break };
                if input_tx.send(event).is_err() {
                    break;
                }
            }
        });
    }
    let mut live = Live {
        pc,
        // A failed input write was never reported; the channel's own close or error is.
        input: Outbound::new("webrtc-liveview-input-writer", Arc::new(input), INPUT_QUEUE_BYTES, |_| {}),
        sender,
        track,
        connected: false,
        input_open: false,
        failed: false,
    };
    match budget.step("create offer", peer::make_offer(live.pc.as_ref(), false)).await.and_then(|sdp| sdp) {
        Ok(sdp) => emit(LiveViewEvent::Offer { sdp }),
        Err(fault) => fail(&mut live, &emit, fault),
    }

    let mut writer: Option<tokio::task::JoinHandle<()>> = None;
    loop {
        tokio::select! {
            raw = peer_events.recv() => {
                let Some(raw) = raw else { break };
                let handled = budget.step("peer event", async {
                    match peer_events.resolve(raw).await {
                        None => {}
                        Some(PeerEvent::Candidate { candidate, .. }) => {
                            emit(LiveViewEvent::Candidate { candidate });
                        }
                        Some(PeerEvent::Connected { remote_certificate }) => {
                            live.connected = true;
                            emit(LiveViewEvent::Connected { remote_certificate });
                            if writer.is_none() {
                                writer = start_writer(&live, &local_track, &key_wanted, &estimate).await;
                            }
                        }
                        Some(PeerEvent::Failed(fault)) => fail(&mut live, &emit, fault),
                    }
                }).await;
                if let Err(fault) = handled {
                    fail(&mut live, &emit, fault);
                }
            }
            Some(event) = input_rx.recv() => on_input_event(event, &mut live, &emit),
            command = commands.recv() => match command {
                None => break,
                Some(command) => {
                    let handled = budget.step("command", on_command(command, &mut live, &emit)).await;
                    if let Err(fault) = handled {
                        fail(&mut live, &emit, fault);
                    }
                }
            },
            () = &mut setup_deadline, if !live.connected && !live.failed => {
                fail(&mut live, &emit, PeerFault::new(PeerFailure::IceFailed, "setup timed out"));
            }
        }
    }
    if let Some(writer) = writer {
        writer.abort();
    }
    budget.close();
    peer::close(&live.pc).await;
}

fn build_track() -> Result<Arc<TrackLocalStaticSample>, PeerFault> {
    let ssrc = rand::random::<u32>();
    let stream = MediaStreamTrack::new(
        format!("mixdog-stream-{ssrc:08x}"),
        format!("mixdog-video-{ssrc:08x}"),
        "mixdog-live-view".to_owned(),
        RtpCodecKind::Video,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: vp8_codec().rtp_codec,
            ..Default::default()
        }],
    );
    TrackLocalStaticSample::new(Instant::now(), stream)
        .map(Arc::new)
        .map_err(|e| PeerFault::new(PeerFailure::PeerHostUnavailable, e.to_string()))
}

async fn attach(
    pc: &dyn PeerConnection,
    local_track: &Arc<TrackLocalStaticSample>,
) -> Result<(Arc<dyn DataChannel>, Arc<dyn RtpSender>), PeerFault> {
    let fault = |e: webrtc::error::Error| PeerFault::new(PeerFailure::Unsupported, e.to_string());
    let input = pc
        .create_data_channel(INPUT_CHANNEL_LABEL, None)
        .await
        .map_err(fault)?;
    let transceiver = pc
        .add_transceiver_from_track(
            Arc::clone(local_track) as Arc<dyn TrackLocal>,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Sendonly,
                ..Default::default()
            }),
        )
        .await
        .map_err(fault)?;
    let sender = transceiver
        .sender()
        .await
        .map_err(fault)?
        .ok_or_else(|| PeerFault::new(PeerFailure::Unsupported, "no sender"))?;
    Ok((input, sender))
}

/// PLI/FIR from the phone become keyframe requests.
fn spawn_feedback_reader(
    local_track: Arc<TrackLocalStaticSample>,
    key_wanted: Arc<Notify>,
    closed: tokio_util::sync::CancellationToken,
) {
    mixdog_rt::spawn("webrtc-liveview-rtcp", TaskClass::Work, async move {
        loop {
            let event = tokio::select! {
                biased;
                () = closed.cancelled() => break,
                event = local_track.poll() => event,
            };
            let Some(event) = event else { break };
            if let TrackLocalEvent::OnRtcpPacket(_) = event {
                key_wanted.notify_one();
            }
        }
    });
}

async fn start_writer(
    live: &Live,
    local_track: &Arc<TrackLocalStaticSample>,
    key_wanted: &Arc<Notify>,
    estimate: &Arc<AtomicU64>,
) -> Option<tokio::task::JoinHandle<()>> {
    let payload_type = live
        .sender
        .get_parameters()
        .await
        .ok()?
        .rtp_parameters
        .codecs
        .first()?
        .payload_type;
    let ssrc = *local_track.ssrcs().await.first()?;
    let mut subscription = live.track.subscribe();
    let local_track = Arc::clone(local_track);
    let key_wanted = Arc::clone(key_wanted);
    let estimate = Arc::clone(estimate);
    Some(mixdog_rt::spawn("webrtc-liveview-writer", TaskClass::Work, async move {
        write_loop(local_track, ssrc, payload_type, &mut subscription, key_wanted, estimate).await;
    }))
}

async fn write_loop(
    local_track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    subscription: &mut Subscription,
    key_wanted: Arc<Notify>,
    estimate: Arc<AtomicU64>,
) {
    loop {
        tokio::select! {
            biased;
            () = key_wanted.notified() => subscription.need_keyframe(),
            next = subscription.next() => {
                let Some(picture) = next else { break };
                // Interop check: the viewer never sees the first keyframe, so it has to ask.
                #[cfg(test)]
                if picture.keyframe && SKIP_FIRST_KEYFRAME.swap(false, Ordering::Relaxed) {
                    continue;
                }
                let sample = Sample {
                    data: picture.data.clone(),
                    duration: picture.duration,
                    ..Sample::new(Instant::now())
                };
                if let Err(error) = local_track.sample_writer(ssrc, payload_type).write_sample(&sample).await {
                    tracing::debug!(%error, "webrtc live view: write ended");
                    break;
                }
                let target = f64::from_bits(estimate.load(Ordering::Relaxed));
                subscription.report_bitrate(target as u32);
            }
        }
    }
}

fn fail(live: &mut Live, emit: &impl Fn(LiveViewEvent), fault: PeerFault) {
    if !live.failed {
        live.failed = true;
        emit(LiveViewEvent::Failed(fault));
    }
}

fn on_input_event(event: DataChannelEvent, live: &mut Live, emit: &impl Fn(LiveViewEvent)) {
    match event {
        DataChannelEvent::OnOpen => {
            live.input_open = true;
            emit(LiveViewEvent::ChannelOpen);
        }
        DataChannelEvent::OnMessage(message) => {
            // The input protocol is text.
            if message.is_string {
                if let Ok(text) = String::from_utf8(message.data.to_vec()) {
                    emit(LiveViewEvent::Channel {
                        text,
                        received_at_ms: wall_clock_ms(),
                    });
                }
            }
        }
        DataChannelEvent::OnClose | DataChannelEvent::OnError => fail(
            live,
            emit,
            PeerFault::bare(PeerFailure::ChannelFailed),
        ),
        _ => {}
    }
}

async fn on_command(command: Command, live: &mut Live, emit: &impl Fn(LiveViewEvent)) {
    match command {
        Command::Answer(sdp) => {
            if let Err(fault) = peer::apply_answer(live.pc.as_ref(), sdp).await {
                fail(live, emit, fault);
            }
        }
        Command::Candidate(candidate) => peer::add_candidate(live.pc.as_ref(), candidate).await,
        Command::ChannelSend(text) => {
            // Queued for the channel's writer task; a full queue means the phone is not reading.
            if live.input_open && !live.failed && live.input.push(Frame::Text(text)).is_err() {
                fail(live, emit, PeerFault::new(PeerFailure::ChannelFailed, "input send queue overflow"));
            }
        }
        Command::Stats(reply) => {
            let _ = reply.send(sender_stats(live).await);
        }
    }
}

async fn sender_stats(live: &Live) -> Option<SenderStats> {
    let report = live
        .pc
        .get_stats(Instant::now(), StatsSelector::None)
        .await;
    let outbound = report.outbound_rtp_streams().next();
    let track = live.track.stats();
    Some(SenderStats {
        codec: "video/VP8",
        encoder_implementation: "libvpx",
        frames_encoded: track.frames_encoded,
        frames_sent: outbound.map_or(0, |o| u64::from(o.frames_sent)),
        total_encode_time_ms: track.total_encode_time.as_secs_f64() * 1_000.0,
        frame_width: track.width,
        frame_height: track.height,
        target_bitrate: outbound.map(|o| o.target_bitrate).filter(|b| *b > 0.0),
        bytes_sent: outbound.map_or(0, |o| o.sent_rtp_stream_stats.bytes_sent),
        candidate_pair: peer::selected_pair(live.pc.as_ref()).await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn stats_from_a_connection_that_never_answers_end_at_the_step_budget() {
        // The loop that would answer is parked: the queued command is never taken.
        let (commands, parked) = mpsc::unbounded_channel();
        let started = tokio::time::Instant::now();
        let stats = request_stats(&PeerBudget::default(), &commands).await;
        assert!(stats.is_none());
        assert_eq!(started.elapsed(), peer::STEP_BUDGET);
        drop(parked);
    }
}
