//! End-to-end checks over loopback UDP: the desktop side is this module's code, the phone side is
//! a plain `webrtc` peer built here (answerer).

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use bytes::BytesMut;
use mixdog_core_api::domain::media::EncodingParams;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::PixelFormat;
use mixdog_core_api::domain::media::VideoTrack;
use rtc::ice::mdns::MulticastDnsMode;
use rtc::peer_connection::configuration::media_engine::MIME_TYPE_VP8;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp::codec::vp8::Vp8Packet;
use rtc::rtp::packetizer::Depacketizer;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodec;
use rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use tokio::sync::mpsc;
use webrtc::data_channel::DataChannel;
use webrtc::data_channel::DataChannelEvent;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::media_stream::track_remote::TrackRemoteEvent;
use webrtc::peer_connection::MediaEngine;
use webrtc::peer_connection::PeerConnection;
use webrtc::peer_connection::PeerConnectionBuilder;
use webrtc::peer_connection::PeerConnectionEventHandler;
use webrtc::peer_connection::RTCConfigurationBuilder;
use webrtc::peer_connection::RTCIceCandidateInit;
use webrtc::peer_connection::RTCPeerConnectionIceEvent;
use webrtc::peer_connection::RTCPeerConnectionState;
use webrtc::peer_connection::SettingEngineBuilder;

use super::carrier::CarrierChannel;
use super::carrier::CarrierConnection;
use super::carrier::CarrierEvent;
use super::carrier::CarrierItem;
use super::config::Candidate;
use super::config::CandidatePath;
use super::config::PeerConfig;
use super::config::PeerFailure;
use super::liveview::LiveViewConnection;
use super::liveview::LiveViewEvent;
use super::sources::frame_feed;
use super::capture::SharedSource;
use super::track::Vp8Track;

/// A test bound, not a protocol timer.
const BOUND: Duration = Duration::from_secs(20);

fn loopback() -> PeerConfig {
    let mut config = PeerConfig::new(vec![]);
    config.udp_bind = vec!["127.0.0.1:0".to_owned()];
    config.include_loopback = true;
    config
}

enum PhoneEvent {
    Candidate(RTCIceCandidateInit),
    Channel(Arc<dyn DataChannel>),
    Track(Arc<dyn TrackRemote>),
}

struct PhoneHandler {
    tx: mpsc::UnboundedSender<PhoneEvent>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PhoneHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(init) = event.candidate.to_json() {
            let _ = self.tx.send(PhoneEvent::Candidate(init));
        }
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let _ = self.tx.send(PhoneEvent::Channel(channel));
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let _ = self.tx.send(PhoneEvent::Track(track));
    }

    async fn on_connection_state_change(&self, _state: RTCPeerConnectionState) {}
}

struct Phone {
    pc: Arc<dyn PeerConnection>,
    events: mpsc::UnboundedReceiver<PhoneEvent>,
}

impl Phone {
    async fn new(with_video: bool) -> Self {
        let (tx, events) = mpsc::unbounded_channel();
        let mut engine = MediaEngine::default();
        if with_video {
            engine
                .register_codec(
                    RTCRtpCodecParameters {
                        rtp_codec: RTCRtpCodec {
                            mime_type: MIME_TYPE_VP8.to_owned(),
                            clock_rate: 90_000,
                            channels: 0,
                            sdp_fmtp_line: String::new(),
                            rtcp_feedback: vec![],
                        },
                        payload_type: 96,
                    },
                    RtpCodecKind::Video,
                )
                .unwrap();
        }
        let registry = rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors(
            webrtc::peer_connection::Registry::new(),
            &mut engine,
        )
        .unwrap();
        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(RTCConfigurationBuilder::new().build())
                .with_media_engine(engine)
                .with_interceptor_registry(registry)
                .with_setting_engine(
                    // The phone signals IP candidates only (127.0.0.1), so it needs no mDNS socket,
                    // whose multicast join depends on the machine's adapters.
                    SettingEngineBuilder::new()
                        .with_include_loopback_candidate(true)
                        .with_multicast_dns_mode(MulticastDnsMode::Disabled)
                        .build(),
                )
                .with_handler(Arc::new(PhoneHandler { tx }))
                .with_udp_addrs(vec!["127.0.0.1:0".to_owned()])
                .build()
                .await
                .unwrap(),
        );
        Self { pc, events }
    }

    /// Applies the desktop's offer and returns the answer SDP.
    async fn answer(&self, offer_sdp: String) -> String {
        self.pc
            .set_remote_description(RTCSessionDescription::offer(offer_sdp).unwrap())
            .await
            .unwrap();
        let answer = self.pc.create_answer(None).await.unwrap();
        self.pc.set_local_description(answer.clone()).await.unwrap();
        self.pc.local_description().await.unwrap().sdp
    }
}

fn to_candidate(init: RTCIceCandidateInit) -> Candidate {
    Candidate::from_init(init)
}

/// The crate's Tokio runtime on a machine that refuses the multicast socket the driver opens on
/// the mDNS port (5353, RFC 6762) to resolve a peer's `.local` candidates, as this PC's adapters
/// refused its group join in the merge run (`os error 10065`, host unreachable). Every other
/// socket and timer is the real one.
#[derive(Debug)]
struct NoMulticast(webrtc::runtime::TokioRuntime);

impl webrtc::runtime::Runtime for NoMulticast {
    fn spawn(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) -> Box<dyn webrtc::runtime::JoinHandle> {
        self.0.spawn(future)
    }

    fn spawn_reactor(&self, size: usize, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) -> Box<dyn webrtc::runtime::JoinHandle> {
        self.0.spawn_reactor(size, future)
    }

    fn wrap_udp_socket(&self, socket: std::net::UdpSocket) -> std::io::Result<Arc<dyn webrtc::runtime::AsyncUdpSocket>> {
        if socket.local_addr()?.port() == 5353 {
            return Err(std::io::Error::from(std::io::ErrorKind::HostUnreachable));
        }
        self.0.wrap_udp_socket(socket)
    }

    fn wrap_tcp_listener(&self, listener: std::net::TcpListener) -> std::io::Result<Arc<dyn webrtc::runtime::AsyncTcpListener>> {
        self.0.wrap_tcp_listener(listener)
    }

    fn connect_tcp<'a>(
        &'a self,
        remote_addr: std::net::SocketAddr,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<Arc<dyn webrtc::runtime::AsyncTcpStream>>> + Send + 'a>> {
        self.0.connect_tcp(remote_addr)
    }

    fn resolve_host<'a>(&'a self, host: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<Vec<std::net::SocketAddr>>> + Send + 'a>> {
        self.0.resolve_host(host)
    }

    fn now(&self) -> std::time::Instant {
        self.0.now()
    }

    fn sleep(&self, duration: Duration) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        self.0.sleep(duration)
    }

    fn interval(&self, period: Duration) -> Box<dyn webrtc::runtime::AsyncInterval> {
        self.0.interval(period)
    }

    fn block_on(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>>) {
        self.0.block_on(future)
    }

    fn yield_now(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        self.0.yield_now()
    }

    fn name(&self) -> &'static str {
        self.0.name()
    }
}

/// A machine that refuses the mDNS socket still connects the carrier: the connection comes up
/// without that socket and opens over its loopback host candidates, as Node's Chromium peer
/// comes up whatever mDNS can do (`peer::open`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_carrier_connects_on_a_machine_that_refuses_the_mdns_socket() {
    mixdog_rt::testing::tokens();
    let mut config = loopback();
    config.runtime = Some(Arc::new(NoMulticast(webrtc::runtime::TokioRuntime)));
    let (carrier, mut events) = CarrierConnection::spawn(config);
    let mut phone = Phone::new(false).await;
    carrier.offer(false);
    let path = tokio::time::timeout(BOUND, async {
        loop {
            tokio::select! {
                Some(event) = events.recv() => match event {
                    CarrierEvent::Offer { sdp } => carrier.answer(phone.answer(sdp).await),
                    CarrierEvent::Candidate { candidate: Some(candidate), .. } => {
                        let _ = phone.pc.add_ice_candidate(candidate.into_init()).await;
                    }
                    CarrierEvent::Open { path, .. } => break path,
                    CarrierEvent::Failed(fault) => panic!("carrier failed: {fault}"),
                    _ => {}
                },
                Some(event) = phone.events.recv() => {
                    if let PhoneEvent::Candidate(init) = event {
                        carrier.candidate(Some(to_candidate(init)));
                    }
                }
            }
        }
    })
    .await
    .expect("the carrier opens within the test bound");
    assert_eq!(path, Some(CandidatePath::Direct));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn carrier_connects_orders_events_and_moves_binary_both_ways() {
    mixdog_rt::testing::tokens();
    let (carrier, mut events) = CarrierConnection::spawn(loopback());
    let mut phone = Phone::new(false).await;
    carrier.offer(false);

    // Phone-side channel pumps: label → received binary messages.
    let (message_tx, mut message_rx) = mpsc::unbounded_channel::<(String, Vec<u8>)>();
    let mut phone_channels: Vec<(String, Arc<dyn DataChannel>)> = Vec::new();

    let mut log: Vec<&'static str> = Vec::new();
    let mut messages_on_carrier: Vec<(CarrierChannel, Bytes)> = Vec::new();
    let mut offered = false;
    let result = tokio::time::timeout(BOUND, async {
        let mut opened = false;
        let mut written = false;
        loop {
            tokio::select! {
                Some(event) = events.recv() => match event {
                    CarrierEvent::Offer { sdp } => {
                        offered = true;
                        let answer = phone.answer(sdp).await;
                        carrier.answer(answer);
                    }
                    CarrierEvent::Candidate { candidate, .. } => {
                        if let Some(candidate) = candidate {
                            let _ = phone.pc.add_ice_candidate(candidate.into_init()).await;
                        }
                    }
                    CarrierEvent::Connected { remote_certificate } => {
                        assert!(remote_certificate.is_some_and(|c| c.fingerprint_algorithm.starts_with("sha-")));
                        log.push("connected");
                    }
                    CarrierEvent::Open { path, max_message_size } => {
                        assert_eq!(path, Some(CandidatePath::Direct));
                        assert!(max_message_size.is_some_and(|size| size > 0));
                        log.push("open");
                        opened = true;
                    }
                    CarrierEvent::Message { channel, data } => {
                        assert!(opened, "no message before open");
                        messages_on_carrier.push((channel, data));
                    }
                    CarrierEvent::Sent { .. } | CarrierEvent::Buffered { .. } => log.push("report"),
                    CarrierEvent::Failed(fault) => panic!("carrier failed: {fault}"),
                },
                Some(event) = phone.events.recv() => match event {
                    PhoneEvent::Candidate(init) => carrier.candidate(Some(to_candidate(init))),
                    PhoneEvent::Channel(channel) => {
                        let label = channel.label().await.unwrap();
                        phone_channels.push((label.clone(), Arc::clone(&channel)));
                        let tx = message_tx.clone();
                        tokio::spawn(async move {
                            while let Some(event) = channel.poll().await {
                                if let DataChannelEvent::OnMessage(m) = event {
                                    let _ = tx.send((label.clone(), m.data.to_vec()));
                                }
                            }
                        });
                    }
                    PhoneEvent::Track(_) => {}
                },
                else => break,
            }
            // Once the carrier is open and the phone has seen both channels, each side writes.
            if opened && !written && phone_channels.len() == 2 {
                written = true;
                carrier.send(vec![
                    CarrierItem { channel: CarrierChannel::App, data: Bytes::from_static(b"down-app") },
                    CarrierItem { channel: CarrierChannel::Control, data: Bytes::from_static(b"down-control") },
                    CarrierItem { channel: CarrierChannel::App, data: Bytes::from_static(b"down-app-2") },
                ]);
                for (_, channel) in &phone_channels {
                    channel.send(BytesMut::from(&b"up"[..])).await.unwrap();
                }
            }
            if messages_on_carrier.len() == 2 && log.contains(&"report") {
                break;
            }
        }
        // The phone received the three desktop messages, in order per channel.
        let mut received: Vec<(String, Vec<u8>)> = Vec::new();
        while received.len() < 3 {
            received.push(message_rx.recv().await.unwrap());
        }
        received
    })
    .await
    .expect("carrier scenario within bound");
    assert!(offered);
    let position = |what| log.iter().position(|entry| *entry == what);
    assert!(position("connected") < position("open"), "connected precedes open");
    let app: Vec<_> = result.iter().filter(|(l, _)| l == "mixdog-transport").map(|(_, d)| d.clone()).collect();
    assert_eq!(app, vec![b"down-app".to_vec(), b"down-app-2".to_vec()]);
    assert!(result.iter().any(|(l, d)| l == "mixdog-transport-control" && d == b"down-control"));
    let channels: std::collections::HashSet<_> = messages_on_carrier.iter().map(|(c, _)| *c).collect();
    assert_eq!(channels.len(), 2, "one inbound message per channel");
    assert!(messages_on_carrier.iter().all(|(_, d)| d.as_ref() == b"up"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_view_streams_vp8_that_decodes_answers_picture_loss_and_carries_input() {
    let tokens = mixdog_rt::testing::tokens();
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    // A producer that keeps painting a moving picture.
    let producer = tokio::spawn(async move {
        let mut shift = 0u8;
        loop {
            let mut data = vec![0u8; 64 * 48 * 4];
            for (n, px) in data.chunks_mut(4).enumerate() {
                px[0] = shift.wrapping_add((n % 64) as u8 * 3);
                px[1] = (n / 64) as u8 * 4;
                px[2] = 90;
            }
            if sink.push(PixelFormat::Bgrx, 64, 48, 256, Bytes::from(data)).is_err() {
                break;
            }
            shift = shift.wrapping_add(7);
            tokio::time::sleep(Duration::from_millis(33)).await;
        }
    });

    let (live, mut events) = LiveViewConnection::spawn(loopback(), vec!["video/vp8".to_owned()], Arc::clone(&shared), tokens.media_thread).unwrap();
    let mut phone = Phone::new(true).await;
    let (frames_tx, mut frames_rx) = mpsc::unbounded_channel::<(u32, u32, bool)>();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    let mut phone_input: Option<Arc<dyn DataChannel>> = None;
    let mut keyframes_before_loss = None;
    let mut sent_pli = false;
    let mut desktop_input = Vec::new();

    let outcome = tokio::time::timeout(BOUND, async {
        let mut decoded_frames = 0;
        loop {
            tokio::select! {
                Some(event) = events.recv() => match event {
                    LiveViewEvent::Offer { sdp } => {
                        assert!(sdp.contains("VP8"), "the offer carries VP8");
                        assert!(!sdp.contains("H264"), "and only VP8");
                        let answer = phone.answer(sdp).await;
                        live.answer(answer);
                    }
                    LiveViewEvent::Candidate { candidate } => {
                        if let Some(candidate) = candidate {
                            let _ = phone.pc.add_ice_candidate(candidate.into_init()).await;
                        }
                    }
                    LiveViewEvent::Connected { remote_certificate } => assert!(remote_certificate.is_some()),
                    LiveViewEvent::ChannelOpen => {
                        live.channel_send("hello phone".to_owned());
                    }
                    LiveViewEvent::Channel { text, received_at_ms } => {
                        assert!(received_at_ms > 0);
                        desktop_input.push(text);
                    }
                    LiveViewEvent::Failed(fault) => panic!("live view failed: {fault}"),
                },
                Some(event) = phone.events.recv() => match event {
                    PhoneEvent::Candidate(init) => live.candidate(Some(to_candidate(init))),
                    PhoneEvent::Channel(channel) => {
                        assert_eq!(channel.label().await.unwrap(), "mixdog-input");
                        phone_input = Some(Arc::clone(&channel));
                        let tx = input_tx.clone();
                        tokio::spawn(async move {
                            while let Some(event) = channel.poll().await {
                                if let DataChannelEvent::OnMessage(m) = event {
                                    let _ = tx.send(String::from_utf8(m.data.to_vec()).unwrap());
                                }
                            }
                        });
                    }
                    PhoneEvent::Track(remote) => {
                        let tx = frames_tx.clone();
                        tokio::spawn(async move { collect_frames(remote, tx).await });
                    }
                },
                Some(text) = input_rx.recv() => {
                    // The desktop's push reached the phone; the phone answers with input.
                    assert_eq!(text, "hello phone");
                    phone_input.as_ref().unwrap().send_text("{\"type\":\"input\"}").await.unwrap();
                },
                Some((w, h, key)) = frames_rx.recv() => {
                    assert_eq!((w, h), (64, 48), "decoded at the source's size");
                    decoded_frames += 1;
                    if decoded_frames == 1 {
                        assert!(key, "a viewer starts on a keyframe");
                    }
                    if decoded_frames == 5 && !sent_pli {
                        keyframes_before_loss = Some(live.track_stats().keyframes);
                        sent_pli = true;
                        request_picture_loss(&phone).await;
                    }
                    if sent_pli && key && decoded_frames > 5 && !desktop_input.is_empty() {
                        break;
                    }
                },
            }
        }
        decoded_frames
    })
    .await
    .expect("live view scenario within bound");
    assert!(outcome > 5);
    assert_eq!(desktop_input, vec!["{\"type\":\"input\"}".to_owned()]);
    let after = live.track_stats();
    assert!(
        after.keyframes > keyframes_before_loss.unwrap(),
        "picture loss produced a keyframe: {after:?}"
    );
    assert_eq!((after.width, after.height), (64, 48));
    // The selected candidate pair is reported by the stack a moment after media flows.
    let last = std::sync::Mutex::new(String::new());
    let stats = tokio::time::timeout(BOUND, async {
        loop {
            let stats = live.stats().await.unwrap();
            if stats.candidate_pair.is_some() && stats.bytes_sent > 0 {
                return stats;
            }
            *last.lock().unwrap() = format!("{stats:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("sender stats report a candidate pair: {}", last.lock().unwrap()));
    assert_eq!(stats.codec, "video/VP8");
    assert!(stats.frames_encoded > 0);
    assert_eq!(stats.candidate_pair.map(|p| p.path()), Some(CandidatePath::Direct));
    producer.abort();
    shared.stop();
}

async fn request_picture_loss(phone: &Phone) {
    for receiver in phone.pc.get_receivers().await {
        let remote = receiver.track();
        if let Some(ssrc) = remote.ssrcs().await.first() {
            let pli = PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: *ssrc,
            };
            remote.write_rtcp(vec![Box::new(pli)]).await.unwrap();
        }
    }
}

/// Reassembles VP8 frames from RTP and decodes them with libvpx: `(width, height, keyframe)`.
async fn collect_frames(remote: Arc<dyn TrackRemote>, tx: mpsc::UnboundedSender<(u32, u32, bool)>) {
    let mut decoder = shiguredo_libvpx::Decoder::new(shiguredo_libvpx::DecoderConfig::new(
        shiguredo_libvpx::DecoderCodec::Vp8,
    ))
    .unwrap();
    let mut frame = Vec::new();
    let mut depacketizer = Vp8Packet::default();
    while let Some(event) = remote.poll().await {
        let TrackRemoteEvent::OnRtpPacket(packet) = event else {
            continue;
        };
        let payload = depacketizer.depacketize(&packet.payload).unwrap();
        frame.extend_from_slice(&payload);
        if !packet.header.marker {
            continue;
        }
        let key = frame.first().is_some_and(|b| b & 1 == 0);
        if decoder.decode(&frame).is_ok()
            && let Ok(Some(decoded)) = decoder.next_frame()
        {
            let _ = tx.send((decoded.width() as u32, decoded.height() as u32, key));
        }
        while let Ok(Some(_)) = decoder.next_frame() {}
        frame.clear();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phone_without_vp8_gets_no_offer() {
    let tokens = mixdog_rt::testing::tokens();
    let (_sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    let (_live, mut events) = LiveViewConnection::spawn(loopback(), vec!["video/H264".to_owned()], Arc::clone(&shared), tokens.media_thread).unwrap();
    let event = tokio::time::timeout(BOUND, events.recv()).await.unwrap().unwrap();
    match event {
        LiveViewEvent::Failed(fault) => {
            assert_eq!(fault.reason, PeerFailure::Unsupported);
            assert_eq!(fault.detail.as_deref(), Some("no common video codec"));
        }
        other => panic!("expected a failure, got {other:?}"),
    }
    shared.stop();
}

/// Paused clock: the runtime advances it only when idle, so the setup deadline passes without a
/// wall-clock wait. The phone never answers the offer.
#[tokio::test(start_paused = true)]
async fn a_carrier_whose_peer_never_answers_fails_at_the_setup_budget() {
    mixdog_rt::testing::tokens();
    let (carrier, mut events) = CarrierConnection::spawn(loopback());
    carrier.offer(false);
    let started = tokio::time::Instant::now();
    let fault = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            if let CarrierEvent::Failed(fault) = events.recv().await.expect("the carrier reports before it ends") {
                break fault;
            }
        }
    })
    .await
    .expect("the carrier fails instead of waiting for ever");
    assert_eq!(fault.reason, PeerFailure::IceFailed);
    assert_eq!(fault.detail.as_deref(), Some("setup timed out"));
    assert!(started.elapsed() >= super::peer::SETUP_BUDGET);
}

/// The frame-rate cap is judged against the time the source actually ran (measured), never an
/// absolute frame count: sleeps overshoot under load, the cap's bound does not move.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn max_framerate_and_bitrate_bind_the_encoder() {
    let tokens = mixdog_rt::testing::tokens();
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    let track = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let mut viewer = track.subscribe();
    let drain = tokio::spawn(async move { while viewer.next().await.is_some() {} });
    // Paints for `ms` of source time at about 30 fps; returns (frames pushed, seconds run).
    async fn run(sink: &mut super::sources::FrameSink, ms: u64) -> (u64, f64) {
        let start = std::time::Instant::now();
        let mut pushed = 0u8;
        let mut count = 0;
        while start.elapsed() < Duration::from_millis(ms) {
            pushed = pushed.wrapping_add(9);
            sink.push(PixelFormat::Bgrx, 64, 48, 256, Bytes::from(vec![pushed; 64 * 48 * 4]))
                .unwrap();
            count += 1;
            tokio::time::sleep(Duration::from_millis(33)).await;
        }
        (count, start.elapsed().as_secs_f64())
    }
    // Every frame is settled (encoded or replaced) once the counters add up.
    async fn settled(track: &Vp8Track) -> super::track::TrackStats {
        loop {
            let s = track.stats();
            if s.frames_captured > 0 && s.frames_encoded + s.frames_superseded >= s.frames_captured {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let (pushed, _) = run(&mut sink, 1000).await;
    let free = settled(&track).await;
    assert!(free.frames_encoded * 2 >= pushed, "unconstrained keeps most frames: {free:?}");
    track
        .set_encoding(mixdog_core_api::domain::media::EncodingParams {
            max_bitrate_bps: Some(200_000),
            max_framerate: Some(10),
            maintain_resolution: true,
        })
        .unwrap();
    let before = settled(&track).await.frames_encoded;
    let (_, seconds) = run(&mut sink, 2000).await;
    let limited = settled(&track).await;
    let encoded = (limited.frames_encoded - before) as f64;
    assert!(encoded <= seconds * 10.0 + 2.0, "10 fps cap over {seconds:.2}s ({encoded})");
    assert!(encoded >= 3.0, "the cap does not starve the stream ({encoded})");
    assert_eq!(limited.bitrate_bps, 200_000);
    drain.abort();
    track.stop();
    shared.stop();
}
/// Pushes `count` frames at about 30 fps from the one shared source.
async fn feed(sink: &mut super::sources::FrameSink, count: u32) {
    for n in 0..count {
        let v = (n as u8).wrapping_mul(7);
        sink.push(PixelFormat::Bgrx, 64, 48, 256, Bytes::from(vec![v; 64 * 48 * 4])).unwrap();
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
}

/// Keeps the shared source producing until `done` holds: a loaded host supersedes frames, so a
/// fixed number of pictures does not guarantee a fixed number of encodes.
async fn feed_until(sink: &mut super::sources::FrameSink, done: impl Fn() -> bool) {
    tokio::time::timeout(BOUND, async {
        while !done() {
            feed(sink, 1).await;
        }
    })
    .await
    .expect("the condition holds while the source keeps producing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_viewers_of_one_source_each_get_their_own_rate() {
    let tokens = mixdog_rt::testing::tokens();
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    let slow = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let fast = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let (mut a, mut b) = (slow.subscribe(), fast.subscribe());
    let drains = [
        tokio::spawn(async move { while a.next().await.is_some() {} }),
        tokio::spawn(async move { while b.next().await.is_some() {} }),
    ];
    slow.set_encoding(EncodingParams { max_bitrate_bps: Some(150_000), max_framerate: Some(5), maintain_resolution: true }).unwrap();
    fast.set_encoding(EncodingParams { max_bitrate_bps: Some(900_000), max_framerate: None, maintain_resolution: true }).unwrap();
    let start = std::time::Instant::now();
    feed(&mut sink, 90).await;
    let seconds = start.elapsed().as_secs_f64();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (s, f) = (slow.stats(), fast.stats());
    assert!(s.frames_encoded as f64 <= seconds * 5.0 + 2.0, "slow viewer capped at 5 fps: {s:?}");
    assert!(f.frames_encoded > s.frames_encoded * 2, "the other viewer is not held to that cap: {f:?} vs {s:?}");
    assert_eq!((s.bitrate_bps, f.bitrate_bps), (150_000, 900_000));
    assert_eq!(slow.encoding().max_framerate, Some(5));
    assert_eq!(fast.encoding().max_framerate, None);
    drains.iter().for_each(|d| d.abort());
    slow.stop();
    fast.stop();
    shared.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_keyframe_request_reaches_only_its_own_viewer() {
    let tokens = mixdog_rt::testing::tokens();
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    let one = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let two = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let (mut a, mut b) = (one.subscribe(), two.subscribe());
    let drains = [
        tokio::spawn(async move { while a.next().await.is_some() {} }),
        tokio::spawn(async move { while b.next().await.is_some() {} }),
    ];
    feed_until(&mut sink, || one.stats().frames_encoded >= 5 && two.stats().frames_encoded >= 5).await;
    let (one_before, two_before) = (one.stats().keyframes, two.stats().keyframes);
    one.request_keyframe();
    feed_until(&mut sink, || one.stats().keyframes > one_before).await;
    feed(&mut sink, 6).await;
    assert_eq!(one.stats().keyframes, one_before + 1, "the requester got its keyframe");
    assert_eq!(two.stats().keyframes, two_before, "the other viewer did not");
    drains.iter().for_each(|d| d.abort());
    one.stop();
    two.stop();
    shared.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_viewer_that_never_reads_does_not_slow_the_other() {
    let tokens = mixdog_rt::testing::tokens();
    let (mut sink, source) = frame_feed(FrameSourceKind::Screen { display: 0 });
    let shared = SharedSource::start(Box::new(source));
    let stalled = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    let healthy = Vp8Track::start(tokens.media_thread, Arc::clone(&shared)).unwrap();
    // The stalled viewer subscribes and never reads: its ring overflows.
    let _never_read = stalled.subscribe();
    let mut reader = healthy.subscribe();
    let delivered = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = Arc::clone(&delivered);
    let reading = tokio::spawn(async move {
        while reader.next().await.is_some() {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    });
    feed(&mut sink, 60).await;
    // Under load the encoder may replace frames with newer ones; settled means all are accounted.
    let settle = async {
        loop {
            let s = healthy.stats();
            if s.frames_captured > 0 && s.frames_encoded + s.frames_superseded >= s.frames_captured {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let healthy_stats = tokio::time::timeout(BOUND, settle).await.expect("the healthy encoder settles");
    assert!(healthy_stats.frames_encoded >= 20, "{healthy_stats:?}");
    assert!(stalled.stats().frames_encoded >= 20, "its own encoder keeps running too");
    tokio::time::sleep(Duration::from_millis(200)).await;
    reading.abort();
    let delivered = delivered.load(std::sync::atomic::Ordering::Relaxed);
    assert!(delivered >= healthy_stats.frames_encoded - 4, "the healthy viewer got its pictures ({delivered})");
    healthy.stop();
    stalled.stop();
    shared.stop();
}