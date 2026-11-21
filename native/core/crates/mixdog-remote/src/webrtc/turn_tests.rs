//! TURN over UDP, TCP and TLS against a stand-in server on loopback: the desktop side is this
//! crate's carrier gathering relay candidates only, the phone a plain `webrtc` peer with a host
//! candidate, so every byte between them crosses the stand-in's relay. A case passes on a
//! data-channel exchange in both directions, never on an Allocate alone.
//!
//! The stand-in follows the shape of the `webrtc` crate's own test server (it challenges an
//! Allocate without a nonce and counts releases) and adds what the transports need: TCP and TLS
//! listeners with a test CA, one relayed address per allocation, permissions, channels and the
//! UDP leg to the peer. Like the real server it serves an authenticated request only under a valid
//! MESSAGE-INTEGRITY, and an Allocate only for a UDP relayed address (`REQUESTED-TRANSPORT=17`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::net::IpAddr;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use bytes::BytesMut;
use rtc::shared::turn_framing::TurnStreamDecoder;
use rtc::stun::attributes::ATTR_NONCE;
use rtc::stun::attributes::ATTR_REALM;
use rtc::stun::error_code::CODE_FORBIDDEN;
use rtc::stun::error_code::CODE_STALE_NONCE;
use rtc::stun::error_code::CODE_UNAUTHORIZED;
use rtc::stun::error_code::CODE_UNSUPPORTED_TRANS_PROTO;
use rtc::stun::integrity::MessageIntegrity;
use rtc::stun::message::CLASS_ERROR_RESPONSE;
use rtc::stun::message::CLASS_INDICATION;
use rtc::stun::message::CLASS_SUCCESS_RESPONSE;
use rtc::stun::message::Getter;
use rtc::stun::message::METHOD_ALLOCATE;
use rtc::stun::message::METHOD_CHANNEL_BIND;
use rtc::stun::message::METHOD_CREATE_PERMISSION;
use rtc::stun::message::METHOD_DATA;
use rtc::stun::message::METHOD_REFRESH;
use rtc::stun::message::METHOD_SEND;
use rtc::stun::message::Message as StunMessage;
use rtc::stun::message::MessageType;
use rtc::stun::message::Method;
use rtc::stun::message::Setter;
use rtc::stun::message::TransactionId;
use rtc::stun::textattrs::Nonce;
use rtc::stun::textattrs::Realm;
use rtc::turn::proto::PROTO_UDP;
use rtc::turn::proto::chandata::ChannelData;
use rtc::turn::proto::channum::ChannelNumber;
use rtc::turn::proto::data::Data;
use rtc::turn::proto::lifetime::Lifetime;
use rtc::turn::proto::peeraddr::PeerAddress;
use rtc::turn::proto::relayaddr::RelayedAddress;
use rtc::turn::proto::reqtrans::RequestedTransport;
use rustls::pki_types::CertificateDer;
use rustls::pki_types::PrivateKeyDer;
use rustls::pki_types::PrivatePkcs8KeyDer;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::UdpSocket;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use webrtc::data_channel::DataChannel;
use webrtc::data_channel::DataChannelEvent;
use webrtc::peer_connection::RTCBundlePolicy;
use webrtc::peer_connection::RTCConfigurationBuilder;
use webrtc::peer_connection::RTCIceServer;
use webrtc::peer_connection::RTCIceTransportPolicy;

use super::carrier::CarrierChannel;
use super::carrier::CarrierConnection;
use super::carrier::CarrierEvent;
use super::carrier::CarrierItem;
use super::config::CandidatePair;
use super::config::CandidateType;
use super::config::IceServer;
use super::config::PeerConfig;
use super::config::PeerFailure;
use super::config::RelayProtocol;
use super::config::TRANSPORT_CHANNEL_LABEL;
use super::peer;
use super::tests::Phone;
use super::tests::PhoneEvent;
use super::tests::to_candidate;

/// A test bound, not a protocol timer.
const BOUND: Duration = Duration::from_secs(30);
/// Longer than the seven tries of a UDP transaction (7.8 s at the client's 200 ms first wait).
const UDP_RUNS_OUT: Duration = Duration::from_secs(12);
/// Longer than the one wait of a request over a connection (Ti, 39.5 s).
const STREAM_RUNS_OUT: Duration = Duration::from_secs(50);
const USERNAME: &str = "user";
const PASSWORD: &str = "pass";
const REALM: &str = "mixdog.test";

// ---- the stand-in server ----------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Leg {
    Answers,
    /// Requests arrive (and a TLS handshake completes); nothing is ever answered.
    Silent,
}

#[derive(Clone, Copy)]
enum Writes {
    Whole,
    /// A few bytes per write, so messages and their headers arrive split.
    Fragmented,
    /// Everything queued within a moment in one write, so messages arrive back to back.
    Coalesced,
}

#[derive(Clone, Copy)]
enum Identity {
    /// A certificate for the IP the url names, signed by the CA the client trusts.
    Named,
    /// Signed by that CA, for a DNS name the url does not carry.
    OtherName,
    /// For the right IP, signed by a CA the client does not trust.
    OtherIssuer,
}

#[derive(Clone, Copy)]
struct Script {
    udp: Leg,
    tcp: Leg,
    tls: Leg,
    writes: Writes,
    identity: Identity,
    /// Answer the first authenticated Allocate with 438 and a new nonce.
    stale_allocate: bool,
    /// Answer the first CreatePermission with 438 and a new nonce.
    stale_permission: bool,
    /// Answer every CreatePermission with 403.
    refuse_permission: bool,
    /// Once the Allocate is granted, read every request and answer none.
    mute_after_allocate: bool,
    lifetime: Duration,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            udp: Leg::Answers,
            tcp: Leg::Answers,
            tls: Leg::Answers,
            writes: Writes::Whole,
            identity: Identity::Named,
            stale_allocate: false,
            stale_permission: false,
            refuse_permission: false,
            mute_after_allocate: false,
            lifetime: Duration::from_secs(600),
        }
    }
}

#[derive(Default)]
struct Stats {
    allocations: AtomicUsize,
    /// Allocations the server holds now: granted, and neither released nor gone with their stream.
    held: AtomicUsize,
    /// Authenticated requests refused for their integrity or their requested transport.
    bad_requests: AtomicUsize,
    /// The peer of every CreatePermission, in arrival order.
    permission_peers: Mutex<Vec<SocketAddr>>,
    /// Relayed data that reached the server on a session after its release.
    after_release: AtomicUsize,
    /// Told on every change a test waits for that no peer event follows.
    told: Notify,
    refreshes: AtomicUsize,
    releases: AtomicUsize,
    stale_answers: AtomicUsize,
    refused_permissions: AtomicUsize,
    to_peer: AtomicUsize,
    from_peer: AtomicUsize,
    odd_channel_data_in: AtomicUsize,
    odd_channel_data_out: AtomicUsize,
    udp_requests: AtomicUsize,
    tcp_connections: AtomicUsize,
    tls_connections: AtomicUsize,
    tls_handshakes: AtomicUsize,
    tls_requests: AtomicUsize,
    streams_closed: AtomicUsize,
}

fn count(counter: &AtomicUsize) -> usize {
    counter.load(Ordering::SeqCst)
}

fn bump(counter: &AtomicUsize) {
    counter.fetch_add(1, Ordering::SeqCst);
}

impl Stats {
    /// Counts a change a test may be waiting for, and wakes the waiter.
    fn tell(&self, counter: &AtomicUsize) {
        bump(counter);
        self.told.notify_waiters();
    }
}

fn stun(parts: Vec<Box<dyn Setter>>) -> Vec<u8> {
    let mut message = StunMessage::new();
    message.build(&parts).expect("a response the stand-in can build");
    message.raw
}

/// Where a session's messages to its client go.
#[derive(Clone)]
enum Reply {
    Udp(Arc<UdpSocket>, SocketAddr),
    Stream(mpsc::UnboundedSender<Vec<u8>>),
}

impl Reply {
    fn send(&self, message: Vec<u8>) {
        match self {
            Self::Udp(socket, client) => {
                let _ = socket.try_send_to(&message, *client);
            }
            Self::Stream(queue) => {
                let _ = queue.send(message);
            }
        }
    }
}

#[derive(Default)]
struct Routes {
    permitted: HashSet<IpAddr>,
    channel_of: HashMap<SocketAddr, u16>,
    peer_of: HashMap<u16, SocketAddr>,
}

struct Allocation {
    relay: Arc<UdpSocket>,
    routes: Arc<Mutex<Routes>>,
    pump: tokio::task::JoinHandle<()>,
    stats: Arc<Stats>,
}

impl Drop for Allocation {
    fn drop(&mut self) {
        self.pump.abort();
        self.stats.held.fetch_sub(1, Ordering::SeqCst);
        self.stats.told.notify_waiters();
    }
}

/// One client as the server sees it: a UDP five-tuple or one stream.
struct Session {
    script: Script,
    stats: Arc<Stats>,
    reply: Reply,
    nonce: String,
    released: bool,
    stale_allocate_answered: bool,
    stale_permission_answered: bool,
    allocation: Option<Allocation>,
    /// The long-term key of the one user the stand-in knows.
    key: Vec<u8>,
}

impl Session {
    fn new(script: Script, stats: Arc<Stats>, reply: Reply) -> Self {
        let provider = rtc::crypto::default_provider().expect("a crypto provider");
        let key =
            MessageIntegrity::long_term_integrity_key(USERNAME.to_owned(), REALM.to_owned(), PASSWORD.to_owned(), provider.crypto()).expect("the user's key");
        Self {
            script,
            stats,
            reply,
            nonce: "nonce-1".to_owned(),
            stale_allocate_answered: false,
            stale_permission_answered: false,
            allocation: None,
            key,
            released: false,
        }
    }

    fn error(&self, request: &StunMessage, method: Method, code: rtc::stun::error_code::ErrorCode) {
        self.reply.send(stun(vec![
            Box::new(request.transaction_id),
            Box::new(MessageType::new(method, CLASS_ERROR_RESPONSE)),
            Box::new(code),
            Box::new(Realm::new(ATTR_REALM, REALM.to_owned())),
            Box::new(Nonce::new(ATTR_NONCE, self.nonce.clone())),
        ]));
    }

    fn stale(&mut self, request: &StunMessage, method: Method) {
        self.nonce = "nonce-2".to_owned();
        bump(&self.stats.stale_answers);
        self.error(request, method, CODE_STALE_NONCE);
    }

    async fn on_message(&mut self, raw: &[u8]) {
        if raw.first().is_some_and(|first| first >> 6 == 0b01) {
            self.on_channel_data(raw);
            return;
        }
        let mut request = StunMessage::new();
        request.raw = raw.to_vec();
        if request.decode().is_err() {
            return;
        }
        let method = request.typ.method;
        if method == METHOD_SEND {
            self.on_send(&request);
            return;
        }
        // A request under a nonce the server no longer serves is not served.
        let nonce = Nonce::get_from_as(&request, ATTR_NONCE).ok().map(|nonce| nonce.text);
        if method == METHOD_ALLOCATE && nonce.is_none() {
            self.error(&request, METHOD_ALLOCATE, CODE_UNAUTHORIZED);
            return;
        }
        if nonce.as_deref() != Some(self.nonce.as_str()) {
            self.error(&request, method, CODE_STALE_NONCE);
            return;
        }
        let provider = rtc::crypto::default_provider().expect("a crypto provider");
        if MessageIntegrity::check(&mut request, &self.key, provider.crypto()).is_err() {
            bump(&self.stats.bad_requests);
            self.error(&request, method, CODE_UNAUTHORIZED);
            return;
        }
        if method == METHOD_CREATE_PERMISSION {
            let mut peer = PeerAddress::default();
            if peer.get_from(&request).is_ok() {
                self.stats.permission_peers.lock().unwrap().push(SocketAddr::new(peer.ip, peer.port));
                self.stats.told.notify_waiters();
            }
        }
        if self.script.mute_after_allocate && self.allocation.is_some() {
            return;
        }
        if method == METHOD_ALLOCATE {
            let mut transport = RequestedTransport::default();
            if transport.get_from(&request).is_err() || transport.protocol != PROTO_UDP {
                bump(&self.stats.bad_requests);
                self.error(&request, METHOD_ALLOCATE, CODE_UNSUPPORTED_TRANS_PROTO);
                return;
            }
            if self.script.stale_allocate && !self.stale_allocate_answered {
                self.stale_allocate_answered = true;
                self.stale(&request, METHOD_ALLOCATE);
                return;
            }
            let relay = Arc::new(UdpSocket::bind("127.0.0.1:0").await.expect("a relayed address"));
            let relayed = relay.local_addr().expect("the relayed address");
            let routes = Arc::new(Mutex::new(Routes::default()));
            let pump = tokio::spawn(relay_to_client(Arc::clone(&relay), Arc::clone(&routes), self.reply.clone(), Arc::clone(&self.stats)));
            self.allocation = Some(Allocation { relay, routes, pump, stats: Arc::clone(&self.stats) });
            bump(&self.stats.held);
            self.stats.tell(&self.stats.allocations);
            self.reply.send(stun(vec![
                Box::new(request.transaction_id),
                Box::new(MessageType::new(METHOD_ALLOCATE, CLASS_SUCCESS_RESPONSE)),
                Box::new(RelayedAddress { ip: relayed.ip(), port: relayed.port() }),
                Box::new(Lifetime(self.script.lifetime)),
            ]));
        } else if method == METHOD_REFRESH {
            let mut lifetime = Lifetime::default();
            let release = lifetime.get_from(&request).is_ok() && lifetime.0.is_zero();
            if release {
                self.released = true;
                self.stats.tell(&self.stats.releases);
                self.allocation = None;
            } else {
                self.stats.tell(&self.stats.refreshes);
            }
            self.reply.send(stun(vec![
                Box::new(request.transaction_id),
                Box::new(MessageType::new(METHOD_REFRESH, CLASS_SUCCESS_RESPONSE)),
                Box::new(Lifetime(if release { Duration::ZERO } else { self.script.lifetime })),
            ]));
        } else if method == METHOD_CREATE_PERMISSION {
            if self.script.refuse_permission {
                self.stats.tell(&self.stats.refused_permissions);
                self.error(&request, METHOD_CREATE_PERMISSION, CODE_FORBIDDEN);
                return;
            }
            if self.script.stale_permission && !self.stale_permission_answered {
                self.stale_permission_answered = true;
                self.stale(&request, METHOD_CREATE_PERMISSION);
                return;
            }
            let mut peer = PeerAddress::default();
            if peer.get_from(&request).is_ok()
                && let Some(allocation) = &self.allocation
            {
                allocation.routes.lock().unwrap().permitted.insert(peer.ip);
            }
            self.reply.send(stun(vec![Box::new(request.transaction_id), Box::new(MessageType::new(METHOD_CREATE_PERMISSION, CLASS_SUCCESS_RESPONSE))]));
        } else if method == METHOD_CHANNEL_BIND {
            let (mut peer, mut number) = (PeerAddress::default(), ChannelNumber::default());
            if peer.get_from(&request).is_ok()
                && number.get_from(&request).is_ok()
                && let Some(allocation) = &self.allocation
            {
                let peer = SocketAddr::new(peer.ip, peer.port);
                let mut routes = allocation.routes.lock().unwrap();
                routes.channel_of.insert(peer, number.0);
                routes.peer_of.insert(number.0, peer);
            }
            self.reply.send(stun(vec![Box::new(request.transaction_id), Box::new(MessageType::new(METHOD_CHANNEL_BIND, CLASS_SUCCESS_RESPONSE))]));
        }
    }

    fn on_send(&self, indication: &StunMessage) {
        if self.released {
            bump(&self.stats.after_release);
        }
        let (mut peer, mut data) = (PeerAddress::default(), Data::default());
        if peer.get_from(indication).is_err() || data.get_from(indication).is_err() {
            return;
        }
        self.to_peer(SocketAddr::new(peer.ip, peer.port), &data.0);
    }

    fn on_channel_data(&self, raw: &[u8]) {
        if self.released {
            bump(&self.stats.after_release);
        }
        let mut message = ChannelData { raw: raw.to_vec(), ..Default::default() };
        if message.decode().is_err() {
            return;
        }
        if message.data.len() % 2 == 1 {
            bump(&self.stats.odd_channel_data_in);
        }
        let peer = self.allocation.as_ref().and_then(|allocation| allocation.routes.lock().unwrap().peer_of.get(&message.number.0).copied());
        if let Some(peer) = peer {
            self.to_peer(peer, &message.data);
        }
    }

    fn to_peer(&self, peer: SocketAddr, data: &[u8]) {
        let Some(allocation) = &self.allocation else { return };
        if !allocation.routes.lock().unwrap().permitted.contains(&peer.ip()) {
            return;
        }
        bump(&self.stats.to_peer);
        let _ = allocation.relay.try_send_to(data, peer);
    }
}

/// The peer leg of one allocation: what a permitted peer sends to the relayed address goes to the
/// client, as ChannelData once the peer has a channel and as a Data indication before.
async fn relay_to_client(relay: Arc<UdpSocket>, routes: Arc<Mutex<Routes>>, reply: Reply, stats: Arc<Stats>) {
    let mut buffer = vec![0u8; 4096];
    loop {
        // A send to a peer that has gone surfaces here as an error on Windows; the leg stands.
        let Ok((length, peer)) = relay.recv_from(&mut buffer).await else {
            tokio::task::yield_now().await;
            continue;
        };
        let (permitted, channel) = {
            let routes = routes.lock().unwrap();
            (routes.permitted.contains(&peer.ip()), routes.channel_of.get(&peer).copied())
        };
        if !permitted {
            continue;
        }
        bump(&stats.from_peer);
        let data = buffer[..length].to_vec();
        reply.send(match channel {
            Some(number) => {
                if length % 2 == 1 {
                    bump(&stats.odd_channel_data_out);
                }
                let mut message = ChannelData { data, number: ChannelNumber(number), ..Default::default() };
                message.encode();
                message.raw
            }
            None => stun(vec![
                Box::new(TransactionId::new()),
                Box::new(MessageType::new(METHOD_DATA, CLASS_INDICATION)),
                Box::new(PeerAddress { ip: peer.ip(), port: peer.port() }),
                Box::new(Data(data)),
            ]),
        });
    }
}

async fn serve_udp(socket: Arc<UdpSocket>, script: Script, stats: Arc<Stats>) {
    let mut sessions: HashMap<SocketAddr, Session> = HashMap::new();
    let mut buffer = vec![0u8; 4096];
    loop {
        let Ok((length, client)) = socket.recv_from(&mut buffer).await else {
            tokio::task::yield_now().await;
            continue;
        };
        bump(&stats.udp_requests);
        if script.udp == Leg::Silent {
            continue;
        }
        let session = sessions.entry(client).or_insert_with(|| Session::new(script, Arc::clone(&stats), Reply::Udp(Arc::clone(&socket), client)));
        session.on_message(&buffer[..length]).await;
    }
}

async fn write_stream(mut io: impl AsyncWrite + Unpin, mut queue: mpsc::UnboundedReceiver<Vec<u8>>, writes: Writes) {
    while let Some(mut bytes) = queue.recv().await {
        match writes {
            Writes::Whole => {}
            Writes::Coalesced => {
                tokio::time::sleep(Duration::from_millis(3)).await;
                while let Ok(more) = queue.try_recv() {
                    bytes.extend_from_slice(&more);
                }
            }
            Writes::Fragmented => {
                let mut rest = bytes.as_slice();
                for size in [1usize, 2, 1, 3, 5, 1, 7, 64].into_iter().cycle() {
                    if rest.is_empty() {
                        break;
                    }
                    let (now, later) = rest.split_at(size.min(rest.len()));
                    if io.write_all(now).await.is_err() || io.flush().await.is_err() {
                        return;
                    }
                    tokio::task::yield_now().await;
                    rest = later;
                }
                continue;
            }
        }
        if io.write_all(&bytes).await.is_err() || io.flush().await.is_err() {
            return;
        }
    }
}

/// One stream to its end: the client's close, a byte that is not TURN, or the test's `dropped`.
async fn serve_stream(
    io: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
    answers: bool,
    requests: Option<&AtomicUsize>,
    dropped: &Notify,
    server: &Server,
) {
    let (mut reader, writer) = tokio::io::split(io);
    let (queue, queued) = mpsc::unbounded_channel();
    let writing = tokio::spawn(write_stream(writer, queued, server.script.writes));
    let mut session = Session::new(server.script, Arc::clone(&server.stats), Reply::Stream(queue));
    let mut decoder = TurnStreamDecoder::new();
    let mut buffer = vec![0u8; 4096];
    'stream: loop {
        let length = tokio::select! {
            () = dropped.notified() => break,
            read = reader.read(&mut buffer) => match read {
                Ok(0) | Err(_) => break,
                Ok(length) => length,
            },
        };
        decoder.extend_from_slice(&buffer[..length]);
        loop {
            match decoder.next_message() {
                Ok(Some(message)) => {
                    if let Some(requests) = requests {
                        bump(requests);
                    }
                    if answers {
                        session.on_message(&message).await;
                    }
                }
                Ok(None) => break,
                Err(_) => break 'stream,
            }
        }
    }
    writing.abort();
    // The session, and the allocation it holds, ends with its stream.
    drop(session);
    server.stats.tell(&server.stats.streams_closed);
}

struct Server {
    script: Script,
    stats: Arc<Stats>,
    /// Told to drop the streams of each kind that are open now.
    drop_tcp: Notify,
    drop_tls: Notify,
}

impl Server {
    fn drop_streams(&self) {
        self.drop_tcp.notify_waiters();
        self.drop_tls.notify_waiters();
    }
}

/// The stand-in, its three urls and the roots that verify its good certificate.
struct TurnServer {
    server: Arc<Server>,
    udp_url: String,
    tcp_url: String,
    tls_url: String,
    roots: Arc<rustls::ClientConfig>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for TurnServer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct TestCa {
    certificate: CertificateDer<'static>,
    issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
}

fn test_ca() -> TestCa {
    let key = rcgen::KeyPair::generate().expect("a CA key");
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("CA parameters");
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let certificate = params.self_signed(&key).expect("a CA certificate").der().clone();
    TestCa { certificate, issuer: rcgen::Issuer::new(params, key) }
}

/// A server certificate for `name` (an IP literal becomes an IP identity) under `ca`.
fn acceptor(ca: &TestCa, name: &str) -> TlsAcceptor {
    let key = rcgen::KeyPair::generate().expect("a server key");
    let params = rcgen::CertificateParams::new(vec![name.to_owned()]).expect("server parameters");
    let certificate = params.signed_by(&key, &ca.issuer).expect("a server certificate").der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key)
        .unwrap();
    TlsAcceptor::from(Arc::new(config))
}

impl TurnServer {
    async fn start(script: Script) -> Self {
        let server = Arc::new(Server { script, stats: Arc::new(Stats::default()), drop_tcp: Notify::new(), drop_tls: Notify::new() });
        let trusted = test_ca();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(trusted.certificate.clone()).unwrap();
        let roots = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let acceptor = match script.identity {
            Identity::Named => acceptor(&trusted, "127.0.0.1"),
            Identity::OtherName => acceptor(&trusted, "turn.mixdog.test"),
            Identity::OtherIssuer => acceptor(&test_ca(), "127.0.0.1"),
        };

        let udp = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tls = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (udp_addr, tcp_addr, tls_addr) = (udp.local_addr().unwrap(), tcp.local_addr().unwrap(), tls.local_addr().unwrap());
        let mut tasks = vec![tokio::spawn(serve_udp(udp, script, Arc::clone(&server.stats)))];
        let plain = Arc::clone(&server);
        tasks.push(tokio::spawn(async move {
            while let Ok((stream, _)) = tcp.accept().await {
                bump(&plain.stats.tcp_connections);
                let server = Arc::clone(&plain);
                tokio::spawn(async move { serve_stream(stream, server.script.tcp == Leg::Answers, None, &server.drop_tcp, &server).await });
            }
        }));
        let secure = Arc::clone(&server);
        tasks.push(tokio::spawn(async move {
            while let Ok((stream, _)) = tls.accept().await {
                bump(&secure.stats.tls_connections);
                let (server, acceptor) = (Arc::clone(&secure), acceptor.clone());
                tokio::spawn(async move {
                    let Ok(stream) = acceptor.accept(stream).await else { return };
                    bump(&server.stats.tls_handshakes);
                    serve_stream(stream, server.script.tls == Leg::Answers, Some(&server.stats.tls_requests), &server.drop_tls, &server).await;
                });
            }
        }));
        Self {
            server,
            udp_url: format!("turn:{udp_addr}?transport=udp"),
            tcp_url: format!("turn:{tcp_addr}?transport=tcp"),
            tls_url: format!("turns:{tls_addr}?transport=tcp"),
            roots: Arc::new(roots),
            tasks,
        }
    }

    fn stats(&self) -> &Stats {
        &self.server.stats
    }

    /// A relay-only desktop offered `urls` of this server.
    fn desktop(&self, urls: &[&String]) -> PeerConfig {
        let server =
            IceServer { urls: urls.iter().map(|url| (*url).clone()).collect(), username: Some(USERNAME.to_owned()), credential: Some(PASSWORD.to_owned()) };
        let mut config = PeerConfig::new(vec![server]);
        config.udp_bind = vec!["127.0.0.1:0".to_owned()];
        config.hooks.relay_only = true;
        config.hooks.turn_tls = Some(Arc::clone(&self.roots));
        // The phone signals an IP candidate only; no mDNS socket is needed on either side.
        config.hooks.mdns_socket = Some(|| Err(std::io::Error::from(std::io::ErrorKind::HostUnreachable)));
        config
    }
}

// ---- the two peers ------------------------------------------------------------------------------

#[derive(Debug, Default)]
struct Seen {
    /// The desktop's relay candidates: how the server is reached, and the candidate's priority.
    relays: Vec<(Option<RelayProtocol>, u32)>,
    /// The same candidates' lines, in the same order.
    relay_lines: Vec<String>,
    other_candidates: usize,
    end_of_candidates: bool,
    /// The pair selected at open; the outer `None` is not open yet.
    open: Option<Option<CandidatePair>>,
    open_at_end_of_candidates: bool,
    failed: Option<String>,
    phone_channels: usize,
    at_phone: Vec<Vec<u8>>,
    at_desktop: Vec<Vec<u8>>,
}

impl Seen {
    fn relays_over(&self, protocol: RelayProtocol) -> usize {
        self.relays.iter().filter(|(over, _)| *over == Some(protocol)).count()
    }

    fn priority_over(&self, protocol: RelayProtocol) -> u32 {
        self.relays.iter().find(|(over, _)| *over == Some(protocol)).expect("a relay candidate over the transport").1
    }

    fn selected(&self) -> CandidatePair {
        self.open.expect("the carrier opened").expect("the stats named the selected pair")
    }
}

enum Incoming {
    Carrier(Option<CarrierEvent>),
    Phone(PhoneEvent),
    AtPhone(Vec<u8>),
}

struct Rig {
    carrier: CarrierConnection,
    events: mpsc::UnboundedReceiver<CarrierEvent>,
    ended: bool,
    phone: Phone,
    app: Option<Arc<dyn DataChannel>>,
    to_phone: mpsc::UnboundedSender<Vec<u8>>,
    at_phone: mpsc::UnboundedReceiver<Vec<u8>>,
    seen: Seen,
}

impl Rig {
    async fn start(config: PeerConfig) -> Self {
        mixdog_rt::testing::tokens();
        let (carrier, events) = CarrierConnection::spawn(config);
        let phone = Phone::new(false).await;
        carrier.offer(false);
        let (to_phone, at_phone) = mpsc::unbounded_channel();
        Self { carrier, events, ended: false, phone, app: None, to_phone, at_phone, seen: Seen::default() }
    }

    /// The next thing either peer reports. Cancel-safe: dropped while it waits, nothing is lost.
    async fn next(&mut self) -> Incoming {
        tokio::select! {
            event = self.events.recv(), if !self.ended => Incoming::Carrier(event),
            Some(event) = self.phone.events.recv() => Incoming::Phone(event),
            Some(data) = self.at_phone.recv() => Incoming::AtPhone(data),
        }
    }

    async fn handle(&mut self, incoming: Incoming) {
        match incoming {
            Incoming::Carrier(Some(event)) => self.on_carrier(event).await,
            Incoming::Carrier(None) => self.ended = true,
            Incoming::Phone(event) => self.on_phone(event).await,
            Incoming::AtPhone(data) => self.seen.at_phone.push(data),
        }
    }

    async fn step(&mut self) {
        let incoming = self.next().await;
        self.handle(incoming).await;
    }

    /// Runs both peers until `done`, which reads the server's counters: the server tells the wait
    /// of each change, since no peer event need follow one.
    async fn until_server(&mut self, what: &str, bound: Duration, stats: &Stats, done: impl Fn() -> bool) {
        let reached = mixdog_rt::time::timeout(bound, async {
            loop {
                let told = stats.told.notified();
                tokio::pin!(told);
                // Registered before the check, so a change between the check and the wait wakes it.
                told.as_mut().enable();
                if done() {
                    break;
                }
                let incoming = tokio::select! {
                    () = &mut told => continue,
                    incoming = self.next() => incoming,
                };
                self.handle(incoming).await;
            }
        })
        .await;
        assert!(reached.is_ok(), "{what}: {:?}, permissions asked of the server: {:?}", self.seen, stats.permission_peers.lock().unwrap());
    }

    async fn on_carrier(&mut self, event: CarrierEvent) {
        match event {
            CarrierEvent::Offer { sdp } => {
                let answer = self.phone.answer(sdp).await;
                self.carrier.answer(answer);
            }
            CarrierEvent::Candidate { candidate: Some(candidate), relay_protocol, .. } => {
                let words: Vec<&str> = candidate.candidate.split_ascii_whitespace().collect();
                if words.windows(2).any(|pair| pair == ["typ", "relay"]) {
                    self.seen.relays.push((relay_protocol, words[3].parse().expect("a candidate priority")));
                    self.seen.relay_lines.push(candidate.candidate.clone());
                } else {
                    self.seen.other_candidates += 1;
                }
                let _ = self.phone.pc.add_ice_candidate(candidate.into_init()).await;
            }
            CarrierEvent::Candidate { candidate: None, .. } => {
                self.seen.end_of_candidates = true;
                self.seen.open_at_end_of_candidates = self.seen.open.is_some();
            }
            CarrierEvent::Open { pair, .. } => self.seen.open = Some(pair),
            CarrierEvent::Message { data, .. } => self.seen.at_desktop.push(data.to_vec()),
            CarrierEvent::Failed(fault) => self.seen.failed = Some(fault.to_string()),
            CarrierEvent::Connected { .. } | CarrierEvent::Sent { .. } | CarrierEvent::Buffered { .. } => {}
        }
    }

    async fn on_phone(&mut self, event: PhoneEvent) {
        match event {
            PhoneEvent::Candidate(init) => self.carrier.candidate(Some(to_candidate(init))),
            PhoneEvent::Channel(channel) => {
                self.seen.phone_channels += 1;
                if channel.label().await.unwrap() == TRANSPORT_CHANNEL_LABEL {
                    self.app = Some(Arc::clone(&channel));
                }
                let to_phone = self.to_phone.clone();
                tokio::spawn(async move {
                    while let Some(event) = channel.poll().await {
                        if let DataChannelEvent::OnMessage(message) = event {
                            let _ = to_phone.send(message.data.to_vec());
                        }
                    }
                });
            }
            PhoneEvent::Track(_) => {}
        }
    }

    /// Runs both peers until `done`, failing the test with `what` at `bound`.
    async fn until(&mut self, what: &str, bound: Duration, done: impl Fn(&Seen) -> bool) {
        let reached = mixdog_rt::time::timeout(bound, async {
            while !done(&self.seen) {
                self.step().await;
            }
        })
        .await;
        assert!(reached.is_ok(), "{what}: {:?}", self.seen);
    }

    /// Runs both peers for `time`.
    async fn run_for(&mut self, time: Duration) {
        let _ = mixdog_rt::time::timeout(time, async {
            loop {
                self.step().await;
            }
        })
        .await;
    }

    async fn opened(&mut self) {
        self.until("the carrier opens and the phone has both channels", BOUND, |seen| {
            (seen.open.is_some() && seen.phone_channels == 2) || seen.failed.is_some()
        })
        .await;
        assert_eq!(self.seen.failed, None);
    }

    /// Messages of odd and even sizes in both directions on the application channel, each side
    /// receiving the other's in order.
    async fn exchange(&mut self, mark: u8) {
        const SIZES: [usize; 6] = [1, 2, 3, 5, 254, 1021];
        let (phone_had, desktop_had) = (self.seen.at_phone.len(), self.seen.at_desktop.len());
        self.carrier.send(SIZES.iter().map(|size| CarrierItem { channel: CarrierChannel::App, data: Bytes::from(vec![mark; *size]) }).collect());
        let app = self.app.clone().expect("the phone has the application channel");
        for size in SIZES {
            app.send(BytesMut::from(&vec![mark; size][..])).await.expect("the phone sends");
        }
        self.until("both sides receive the other's messages", BOUND, |seen| {
            seen.at_phone.len() >= phone_had + SIZES.len() && seen.at_desktop.len() >= desktop_had + SIZES.len()
        })
        .await;
        let expected: Vec<Vec<u8>> = SIZES.iter().map(|size| vec![mark; *size]).collect();
        assert_eq!(self.seen.at_phone[phone_had..], expected, "desktop to phone");
        assert_eq!(self.seen.at_desktop[desktop_had..], expected, "phone to desktop");
    }
}

async fn eventually(what: &str, done: impl Fn() -> bool) {
    let reached = mixdog_rt::time::timeout(BOUND, async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(reached.is_ok(), "{what}");
}

fn relayed_over(pair: CandidatePair, protocol: RelayProtocol) {
    assert_eq!((pair.local_type, pair.relay_protocol), (CandidateType::Relay, Some(protocol)), "the selected pair's local candidate");
}

// ---- cases --------------------------------------------------------------------------------------

/// This PC's fault: the server's UDP answers never arrive. The TCP relay candidate trickles and the
/// channels open over it while the UDP Allocate is still retransmitting; that gatherer then runs
/// out on its own deadline, which ends the gathering and nothing else.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn udp_answers_that_never_arrive_leave_the_tcp_relay_carrying_both_ways() {
    let server = TurnServer::start(Script { udp: Leg::Silent, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.udp_url, &server.tcp_url])).await;
    rig.opened().await;
    relayed_over(rig.seen.selected(), RelayProtocol::Tcp);
    assert!(!rig.seen.end_of_candidates, "the open did not wait for the silent UDP gatherer");
    rig.exchange(1).await;
    assert_eq!((rig.seen.relays_over(RelayProtocol::Tcp), rig.seen.relays_over(RelayProtocol::Udp), rig.seen.other_candidates), (1, 0, 0));
    assert!(count(&server.stats().udp_requests) > 0, "the UDP requests reached the server");

    rig.until("the UDP gatherer runs out and the gathering ends", UDP_RUNS_OUT, |seen| seen.end_of_candidates).await;
    assert!(rig.seen.open_at_end_of_candidates);
    assert_eq!(rig.seen.failed, None, "one gatherer's end is not the connection's");
    rig.exchange(2).await;
    assert!(count(&server.stats().to_peer) > 0 && count(&server.stats().from_peer) > 0, "the exchange crossed the relay");
}

/// TLS alone, the server's bytes arriving a few at a time: the handshake verifies the url's IP,
/// and ChannelData of odd lengths crosses in both directions with its padding.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_alone_carries_both_ways_with_the_server_writing_in_fragments() {
    let server = TurnServer::start(Script { writes: Writes::Fragmented, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.tls_url])).await;
    rig.opened().await;
    relayed_over(rig.seen.selected(), RelayProtocol::Tls);
    rig.exchange(1).await;
    rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
    assert_eq!((rig.seen.relays.len(), rig.seen.relays_over(RelayProtocol::Tls)), (1, 1));
    let stats = server.stats();
    assert_eq!((count(&stats.tls_handshakes), count(&stats.tcp_connections), count(&stats.udp_requests)), (1, 0, 0));
    assert!(count(&stats.odd_channel_data_in) > 0 && count(&stats.odd_channel_data_out) > 0, "odd-length ChannelData both ways");
}

/// TCP with the server's messages arriving back to back, a 438 on the Allocate and on the first
/// CreatePermission (each retried under the new nonce), a refresh at the server's short lifetime
/// and, when the desktop closes, a release on the same connection before it ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tcp_carries_through_stale_nonces_refreshes_and_releases_on_close() {
    let script = Script { writes: Writes::Coalesced, stale_allocate: true, stale_permission: true, lifetime: Duration::from_secs(2), ..Script::default() };
    let server = TurnServer::start(script).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url])).await;
    rig.opened().await;
    relayed_over(rig.seen.selected(), RelayProtocol::Tcp);
    rig.exchange(1).await;
    let stats = server.stats();
    assert_eq!((count(&stats.allocations), count(&stats.stale_answers)), (1, 2), "one allocation, after one 438 for each request kind");
    assert!(count(&stats.odd_channel_data_in) > 0 && count(&stats.odd_channel_data_out) > 0, "odd-length ChannelData both ways");

    rig.until_server("the allocation is refreshed", BOUND, stats, || count(&stats.refreshes) > 0).await;
    rig.exchange(2).await;
    assert_eq!(count(&stats.releases), 0);
    let Rig { carrier, mut events, .. } = rig;
    drop(carrier);
    eventually("the release arrives and the connection ends", || count(&stats.releases) == 1 && count(&stats.streams_closed) == 1).await;
    while events.recv().await.is_some() {}
    assert_eq!((count(&stats.allocations), count(&stats.tcp_connections)), (1, 1), "nothing was opened again");
}

/// Offered all three, every transport allocates in the one gathering, and relays that differ only
/// in how the server is reached rank UDP, then TLS, then TCP whatever order the urls came in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_offered_transport_gathers_at_once_and_ranks_udp_tls_tcp() {
    let server = TurnServer::start(Script::default()).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url, &server.tls_url, &server.udp_url, &server.tcp_url])).await;
    rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
    let seen = &rig.seen;
    assert_eq!((seen.relays_over(RelayProtocol::Udp), seen.relays_over(RelayProtocol::Tls), seen.relays_over(RelayProtocol::Tcp)), (1, 1, 1), "{seen:?}");
    let (udp, tls, tcp) = (seen.priority_over(RelayProtocol::Udp), seen.priority_over(RelayProtocol::Tls), seen.priority_over(RelayProtocol::Tcp));
    assert!(udp > tls && tls > tcp, "udp {udp}, tls {tls}, tcp {tcp}");
    assert!(udp >> 24 == 0, "the order is below the candidate-type preference");
    assert_eq!(count(&server.stats().allocations), 3, "one allocation per transport, the repeated url opening nothing");
    assert_eq!(count(&server.stats().bad_requests), 0, "every request was signed, and every Allocate asked for a UDP relayed address");
    rig.opened().await;
    rig.exchange(1).await;
}

/// A `turns:` server that cannot prove the url's name, or whose issuer is not trusted, yields no
/// candidate and ends its gatherer; nothing is retried without TLS.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tls_server_with_the_wrong_name_or_issuer_gathers_nothing_and_is_never_tried_in_the_clear() {
    for identity in [Identity::OtherName, Identity::OtherIssuer] {
        let server = TurnServer::start(Script { identity, ..Script::default() }).await;
        let mut rig = Rig::start(server.desktop(&[&server.tls_url])).await;
        rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
        rig.run_for(Duration::from_millis(500)).await;
        let stats = server.stats();
        assert_eq!((rig.seen.relays.len(), rig.seen.open), (0, None));
        assert_eq!(count(&stats.tls_connections), 1, "one attempt");
        assert_eq!((count(&stats.tls_requests), count(&stats.tcp_connections), count(&stats.udp_requests), count(&stats.allocations)), (0, 0, 0, 0));
    }
}

/// Every transport silent: the UDP gatherer runs out on its deadline, the stream gatherers are
/// still inside theirs, so no end of candidates is made up. When the owner gives the attempt up
/// (its negotiation window), the connections end with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn silent_transports_end_with_the_attempt_and_no_end_of_candidates_is_made_up() {
    let server = TurnServer::start(Script { udp: Leg::Silent, tcp: Leg::Silent, tls: Leg::Silent, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.udp_url, &server.tcp_url, &server.tls_url])).await;
    rig.run_for(UDP_RUNS_OUT).await;
    let stats = server.stats();
    assert_eq!((rig.seen.relays.len(), rig.seen.open, rig.seen.end_of_candidates), (0, None, false), "{:?}", rig.seen);
    assert_eq!((count(&stats.tcp_connections), count(&stats.tls_handshakes), count(&stats.streams_closed)), (1, 1, 0));
    let Rig { carrier, mut events, .. } = rig;
    drop(carrier);
    eventually("both connections end", || count(&stats.streams_closed) == 2).await;
    while events.recv().await.is_some() {}
    assert_eq!(count(&stats.allocations), 0);
}

/// A server that refuses the permission: the candidate is gathered, each check asks again and is
/// refused again, nothing reaches the peer and the path never opens.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_permission_keeps_the_relay_from_carrying() {
    let server = TurnServer::start(Script { refuse_permission: true, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url])).await;
    let stats = server.stats();
    rig.until_server("the permission is asked for again after its refusal", BOUND, stats, || count(&stats.refused_permissions) >= 2).await;
    assert_eq!((rig.seen.relays_over(RelayProtocol::Tcp), rig.seen.open, count(&stats.to_peer)), (1, None, 0));
    let Rig { carrier, .. } = rig;
    drop(carrier);
    eventually("the allocation is released", || count(&stats.releases) == 1).await;
}

/// The server drops the connection under an open path. Its allocation is gone with it: nothing
/// reconnects behind the candidate. The next attempt is a new connection, with a new allocation,
/// and the ended one reports nothing more.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_connection_is_not_reopened_and_the_next_attempt_starts_clean() {
    let server = TurnServer::start(Script::default()).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url])).await;
    rig.opened().await;
    rig.exchange(1).await;
    let stats = server.stats();
    server.server.drop_streams();
    eventually("the server's end closes", || count(&stats.streams_closed) == 1).await;
    rig.run_for(Duration::from_secs(2)).await;
    assert_eq!((count(&stats.tcp_connections), count(&stats.allocations)), (1, 1), "no reconnect behind the old candidate");
    assert_eq!(rig.seen.relays.len(), 1, "and no new candidate");
    let Rig { carrier, mut events, .. } = rig;
    drop(carrier);
    while events.recv().await.is_some() {}

    let mut next = Rig::start(server.desktop(&[&server.tcp_url])).await;
    next.opened().await;
    relayed_over(next.seen.selected(), RelayProtocol::Tcp);
    next.exchange(2).await;
    assert_eq!((count(&stats.tcp_connections), count(&stats.allocations), count(&stats.releases)), (2, 2, 0));
    assert!(events.try_recv().is_err(), "the ended attempt reports nothing more");
}

/// A connection that is dropped, not closed: its driver ends with it and gives back what it
/// allocated, over each transport, instead of refreshing the allocations for the life of the
/// process.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_connection_leaves_no_allocation_on_the_server() {
    let server = TurnServer::start(Script::default()).await;
    mixdog_rt::testing::tokens();
    let config = server.desktop(&[&server.udp_url, &server.tcp_url, &server.tls_url]);
    let opened = peer::open(&config, None).await.expect("the connection is built");
    opened.pc.create_data_channel(TRANSPORT_CHANNEL_LABEL, None).await.expect("a channel for the offer to negotiate");
    peer::make_offer(opened.pc.as_ref(), false).await.expect("the offer, which starts the gathering");
    let stats = server.stats();
    eventually("every transport allocates", || count(&stats.held) == 3).await;
    drop(opened);
    eventually("the server holds nothing of the dropped connection", || count(&stats.held) == 0 && count(&stats.streams_closed) == 2).await;
    assert_eq!((count(&stats.allocations), count(&stats.releases)), (3, 3), "each allocation was released, not left to its stream's end or its lifetime");
}

/// A close with relayed data still on its way out: each connection writes its release and ends,
/// and what was queued for it is dropped: none of it reaches the server behind the release.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_with_data_still_queued_releases_on_each_connection() {
    let server = TurnServer::start(Script::default()).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url, &server.tls_url])).await;
    rig.opened().await;
    rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
    rig.exchange(1).await;
    let stats = server.stats();
    assert_eq!(count(&stats.held), 2);
    rig.carrier.send((0..64).map(|_| CarrierItem { channel: CarrierChannel::App, data: Bytes::from(vec![7; 1021]) }).collect());
    let Rig { carrier, mut events, .. } = rig;
    drop(carrier);
    eventually("both releases arrive and both connections end", || count(&stats.releases) == 2 && count(&stats.streams_closed) == 2).await;
    while events.recv().await.is_some() {}
    assert_eq!((count(&stats.held), count(&stats.after_release)), (0, 0), "what was queued is dropped, not written behind the release");
}

/// The server drops the connection under the selected pair, the only one, after the gathering has
/// ended. The candidate goes with its allocation, so the path fails now, not when consent on it
/// runs out (30 s).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_lost_under_the_selected_pair_fails_the_path_at_once() {
    let server = TurnServer::start(Script::default()).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url])).await;
    rig.opened().await;
    rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
    rig.exchange(1).await;
    server.server.drop_streams();
    rig.until("the path fails without waiting for consent to run out", Duration::from_secs(3), |seen| seen.failed.is_some()).await;
    assert_eq!(rig.seen.failed.as_deref(), Some(PeerFailure::IceFailed.wire_name()));
}

/// A server that grants the Allocate and then answers nothing. A request over a connection is sent
/// once: each permission is asked for once however many checks wait on it, and when the first
/// runs out its wait (Ti, 39.5 s, which is how long this case takes) the connection is given up,
/// with nothing written on it afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_never_answered_is_sent_once_and_ends_its_connection_when_it_runs_out() {
    let server = TurnServer::start(Script { mute_after_allocate: true, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url])).await;
    let stats = server.stats();
    rig.until_server("a permission is asked for", BOUND, stats, || !stats.permission_peers.lock().unwrap().is_empty()).await;
    assert_eq!(count(&stats.streams_closed), 0);
    rig.until_server("the connection ends when the request runs out", STREAM_RUNS_OUT, stats, || count(&stats.streams_closed) == 1).await;
    let asked = stats.permission_peers.lock().unwrap().clone();
    let peers: HashSet<SocketAddr> = asked.iter().copied().collect();
    assert_eq!(asked.len(), peers.len(), "no permission was asked for twice: {asked:?}");
    assert_eq!((rig.seen.open, count(&stats.releases), count(&stats.tcp_connections)), (None, 0, 1), "given up, not released, not reopened");
}

/// An entry whose url the parser refuses never reaches a gatherer: the configuration is refused
/// when the connection is built, so the attempt ends there and nothing is asked of the server.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ice_server_entry_that_does_not_parse_ends_the_open_before_any_gathering() {
    let server = TurnServer::start(Script::default()).await;
    let mut config = server.desktop(&[&server.udp_url]);
    config.ice_servers.push(IceServer { urls: vec!["stun:127.0.0.1:9?transport=udp".to_owned()], username: None, credential: None });
    let mut rig = Rig::start(config).await;
    rig.until("the open fails", BOUND, |seen| seen.failed.is_some()).await;
    assert!(rig.seen.failed.as_deref().is_some_and(|fault| fault.starts_with(PeerFailure::PeerHostUnavailable.wire_name())), "{:?}", rig.seen);
    assert_eq!((rig.seen.relays.len(), rig.seen.end_of_candidates, count(&server.stats().udp_requests)), (0, false, 0));
}

/// The `raddr`/`rport` of a relay candidate line: the local address its allocation was made from.
fn related_address(line: &str) -> SocketAddr {
    let words: Vec<&str> = line.split_ascii_whitespace().collect();
    let after = |name: &str| words.iter().position(|word| *word == name).and_then(|at| words.get(at + 1)).expect("a related address");
    format!("{}:{}", after("raddr"), after("rport")).parse().expect("a socket address")
}

/// The relayed address of a relay candidate line, as a line or an SDP carries it.
fn relayed_address(line: &str) -> String {
    let words: Vec<&str> = line.split_ascii_whitespace().collect();
    format!(" {} {} typ relay", words[4], words[5])
}

/// The selected connection is lost while another transport is still allocating: the gathering has
/// not ended, so an empty checklist is not the path's failure. (The fallback here never comes: the
/// server leaves its Allocate unanswered.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_lost_while_another_transport_still_gathers_does_not_fail_the_path() {
    let server = TurnServer::start(Script { tls: Leg::Silent, ..Script::default() }).await;
    let mut rig = Rig::start(server.desktop(&[&server.tcp_url, &server.tls_url])).await;
    rig.opened().await;
    relayed_over(rig.seen.selected(), RelayProtocol::Tcp);
    rig.exchange(1).await;
    let stats = server.stats();
    assert!(!rig.seen.end_of_candidates && count(&stats.tls_handshakes) == 1, "the TLS gatherer is still waiting on its Allocate");
    server.server.drop_tcp.notify_waiters();
    eventually("the server's end of the TCP connection closes", || count(&stats.streams_closed) == 1).await;
    rig.run_for(Duration::from_secs(3)).await;
    assert_eq!((rig.seen.failed.clone(), rig.seen.end_of_candidates), (None, false), "still gathering, so not failed");
}

/// The next relay candidate the connection reports, as its relayed address.
async fn next_relay(events: &mut peer::PeerEvents) -> String {
    let found = mixdog_rt::time::timeout(BOUND, async {
        loop {
            match events.recv().await.expect("the connection reports") {
                peer::Raw::Candidate { candidate: Some(candidate), .. } if candidate.candidate.contains(" typ relay") => {
                    break relayed_address(&candidate.candidate);
                }
                _ => {}
            }
        }
    })
    .await;
    found.expect("a relay candidate within the test bound")
}

/// A relay retired on purpose: the configuration names another server, so the next gathering
/// releases the allocation it has and allocates at the new one. ICE keeps its local candidates
/// across the restart that starts that gathering, and is told the released one is gone: the
/// following offer names the live relayed address and not the released one.
///
/// (A restart alone retires nothing here: without
/// `discard_local_candidates_during_ice_restart` the allocation and its candidate are kept.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_configuration_change_takes_the_released_relay_candidate_back() {
    let (old, new) = (TurnServer::start(Script::default()).await, TurnServer::start(Script::default()).await);
    mixdog_rt::testing::tokens();
    let config = old.desktop(&[&old.tcp_url]);
    let mut opened = peer::open(&config, None).await.expect("the connection is built");
    let pc = Arc::clone(&opened.pc);
    pc.create_data_channel(TRANSPORT_CHANNEL_LABEL, None).await.expect("a channel for the offer to negotiate");
    peer::make_offer(pc.as_ref(), false).await.expect("the offer, which starts the gathering");
    let released = next_relay(&mut opened.events).await;

    let servers = vec![RTCIceServer { urls: vec![new.tcp_url.clone()], username: USERNAME.to_owned(), credential: PASSWORD.to_owned() }];
    let changed = RTCConfigurationBuilder::new()
        .with_ice_servers(servers)
        .with_ice_transport_policy(RTCIceTransportPolicy::Relay)
        .with_bundle_policy(RTCBundlePolicy::MaxBundle)
        .build();
    pc.set_configuration(changed).await.expect("the configuration is accepted");
    peer::make_offer(pc.as_ref(), true).await.expect("a restart offer, which gathers under the new configuration");
    let live = next_relay(&mut opened.events).await;
    assert_ne!(released, live);
    eventually("the old allocation is released and the new server holds one", || {
        (count(&old.stats().releases), count(&old.stats().held), count(&new.stats().held)) == (1, 0, 1)
    })
    .await;

    let offer = peer::make_offer(pc.as_ref(), true).await.expect("the next offer");
    assert!(offer.contains(&live), "the offer names the live relay{live}: {offer}");
    assert!(!offer.contains(&released), "and not the released one{released}: {offer}");
}

/// The crate's Tokio runtime whose UDP sockets fail every receive, for good, once told to.
#[derive(Debug)]
struct BreakableUdp {
    inner: webrtc::runtime::TokioRuntime,
    broken: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug)]
struct BreakableSocket {
    inner: Arc<dyn webrtc::runtime::AsyncUdpSocket>,
    broken: Arc<std::sync::atomic::AtomicBool>,
}

impl webrtc::runtime::AsyncUdpSocket for BreakableSocket {
    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }

    fn poll_send(&self, cx: &mut std::task::Context<'_>, transmit: &webrtc::runtime::Transmit<'_>) -> std::task::Poll<std::io::Result<usize>> {
        self.inner.poll_send(cx, transmit)
    }

    fn poll_recv(
        &self,
        cx: &mut std::task::Context<'_>,
        bufs: &mut [std::io::IoSliceMut<'_>],
        meta: &mut [webrtc::runtime::RecvMeta],
    ) -> std::task::Poll<std::io::Result<usize>> {
        if self.broken.load(Ordering::SeqCst) {
            // Not one of the kinds the driver takes for transient.
            return std::task::Poll::Ready(Err(std::io::Error::other("injected: the socket is gone")));
        }
        self.inner.poll_recv(cx, bufs, meta)
    }
}

impl webrtc::runtime::Runtime for BreakableUdp {
    fn spawn(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) -> Box<dyn webrtc::runtime::JoinHandle> {
        self.inner.spawn(future)
    }

    fn spawn_reactor(&self, size: usize, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>) -> Box<dyn webrtc::runtime::JoinHandle> {
        self.inner.spawn_reactor(size, future)
    }

    fn wrap_udp_socket(&self, socket: std::net::UdpSocket) -> std::io::Result<Arc<dyn webrtc::runtime::AsyncUdpSocket>> {
        Ok(Arc::new(BreakableSocket { inner: self.inner.wrap_udp_socket(socket)?, broken: Arc::clone(&self.broken) }))
    }

    fn wrap_tcp_listener(&self, listener: std::net::TcpListener) -> std::io::Result<Arc<dyn webrtc::runtime::AsyncTcpListener>> {
        self.inner.wrap_tcp_listener(listener)
    }

    fn connect_tcp<'a>(
        &'a self,
        remote_addr: SocketAddr,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<Arc<dyn webrtc::runtime::AsyncTcpStream>>> + Send + 'a>> {
        self.inner.connect_tcp(remote_addr)
    }

    fn resolve_host<'a>(&'a self, host: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        self.inner.resolve_host(host)
    }

    fn now(&self) -> std::time::Instant {
        self.inner.now()
    }

    fn sleep(&self, duration: Duration) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        self.inner.sleep(duration)
    }

    fn interval(&self, period: Duration) -> Box<dyn webrtc::runtime::AsyncInterval> {
        self.inner.interval(period)
    }

    fn block_on(&self, future: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>>) {
        self.inner.block_on(future)
    }

    fn yield_now(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        self.inner.yield_now()
    }

    fn name(&self) -> &'static str {
        self.inner.name()
    }
}

/// The desktop's UDP socket fails for good under a pair selected on its UDP relay, with a TCP relay
/// beside it. The UDP relay is retired with its socket, so the desktop moves to the TCP relay: what
/// it sends afterwards reaches the phone through the server's TCP leg. (Only that direction is
/// shown: the phone here keeps the pair it had.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lost_udp_socket_retires_its_relay_and_the_desktop_moves_to_the_tcp_relay() {
    let server = TurnServer::start(Script::default()).await;
    let broken = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut config = server.desktop(&[&server.udp_url, &server.tcp_url]);
    config.hooks.runtime = Some(Arc::new(BreakableUdp { inner: webrtc::runtime::TokioRuntime, broken: Arc::clone(&broken) }));
    let mut rig = Rig::start(config).await;
    rig.opened().await;
    rig.until("the gathering ends", BOUND, |seen| seen.end_of_candidates).await;
    relayed_over(rig.seen.selected(), RelayProtocol::Udp);
    rig.exchange(1).await;

    let udp_relay = rig.seen.relays.iter().position(|(over, _)| *over == Some(RelayProtocol::Udp)).expect("the UDP relay candidate");
    let socket = related_address(&rig.seen.relay_lines[udp_relay]);
    broken.store(true, Ordering::SeqCst);
    // A datagram wakes the receive that is waiting, which then fails.
    UdpSocket::bind("127.0.0.1:0").await.unwrap().send_to(&[0], socket).await.unwrap();

    let had = rig.seen.at_phone.len();
    let mut sent = 0u8;
    let arrived = mixdog_rt::time::timeout(BOUND, async {
        // Until the desktop has moved, what it sends is lost with the socket: keep sending.
        while rig.seen.at_phone.len() == had {
            sent += 1;
            rig.carrier.send(vec![CarrierItem { channel: CarrierChannel::App, data: Bytes::from(vec![sent; 3]) }]);
            rig.run_for(Duration::from_millis(500)).await;
        }
    })
    .await;
    assert!(arrived.is_ok(), "the desktop reaches the phone again: {:?}", rig.seen);
    assert_eq!(rig.seen.failed, None);
}

// ---- a candidate taken back -------------------------------------------------------------------

mod removal {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;
    use std::time::Instant;

    use rtc::ice::Agent;
    use rtc::ice::AgentConfig;
    use rtc::ice::Event;
    use rtc::ice::candidate::Candidate;
    use rtc::ice::candidate::CandidateConfig;
    use rtc::ice::candidate::CandidateType;
    use rtc::ice::candidate::candidate_host::CandidateHostConfig;
    use rtc::ice::state::ConnectionState;
    use rtc::sansio::Protocol;
    use rtc::shared::TaggedBytesMut;
    use rtc::shared::TransportContext;
    use rtc::shared::TransportProtocol;

    fn agent(now: Instant) -> Agent {
        Agent::new(now, Arc::new(AgentConfig::default()), rtc::crypto::default_provider().expect("a crypto provider")).expect("an agent")
    }

    fn host(addr: SocketAddr) -> Candidate {
        let base_config = CandidateConfig { network: "udp".to_owned(), address: addr.ip().to_string(), port: addr.port(), component: 1, ..Default::default() };
        CandidateHostConfig { base_config, ..Default::default() }.new_candidate_host().expect("a host candidate")
    }

    /// What `from` has to send, read by `to`.
    fn carry(from: &mut Agent, to: &mut Agent, now: Instant) {
        while let Some(sent) = from.poll_write() {
            let transport = TransportContext {
                local_addr: sent.transport.peer_addr,
                peer_addr: sent.transport.local_addr,
                ecn: None,
                transport_protocol: TransportProtocol::UDP,
            };
            let _ = to.handle_read(TaggedBytesMut { now, transport, message: sent.message });
        }
    }

    /// The order a driver can produce: the agent selects a pair, the pair's candidate is taken back
    /// before the selection was read, and only then are the agent's events read. The selection of
    /// the pair that is gone is not among them, so nothing downstream records it as current.
    #[test]
    fn a_selection_not_yet_read_is_not_reported_after_its_candidate_is_taken_back() {
        let mut now = Instant::now();
        let (mut desktop, mut phone) = (agent(now), agent(now));
        let (ours, theirs): (SocketAddr, SocketAddr) = ("10.0.0.1:4000".parse().unwrap(), "10.0.0.2:5000".parse().unwrap());
        desktop.add_local_candidate(host(ours)).unwrap();
        desktop.add_remote_candidate(host(theirs)).unwrap();
        phone.add_local_candidate(host(theirs)).unwrap();
        phone.add_remote_candidate(host(ours)).unwrap();
        let (desktops, phones) = (desktop.get_local_credentials().clone(), phone.get_local_credentials().clone());
        desktop.start_connectivity_checks(now, true, phones.ufrag, phones.pwd).unwrap();
        phone.start_connectivity_checks(now, false, desktops.ufrag, desktops.pwd).unwrap();

        // The desktop's events stay unread throughout.
        for _ in 0..400 {
            if desktop.get_selected_candidate_pair().is_some() {
                break;
            }
            now += Duration::from_millis(50);
            desktop.handle_timeout(now).unwrap();
            phone.handle_timeout(now).unwrap();
            carry(&mut desktop, &mut phone, now);
            carry(&mut phone, &mut desktop, now);
            carry(&mut desktop, &mut phone, now);
        }
        assert!(desktop.get_selected_candidate_pair().is_some(), "the agents select their one pair");

        assert!(desktop.remove_local_candidate(now, CandidateType::Host, ours, false), "the candidate is known");
        let mut states = Vec::new();
        while let Some(queued) = desktop.poll_event() {
            match queued.event {
                Event::SelectedCandidatePairChange(..) => panic!("the pair that is gone is reported as selected"),
                Event::ConnectionStateChange(state) => states.push(state),
                _ => {}
            }
        }
        assert!(desktop.get_selected_candidate_pair().is_none());
        assert_eq!(states.last(), Some(&ConnectionState::Failed), "gathering had ended and no pair is left: {states:?}");
    }
}

// ---- one Allocate, one completion ---------------------------------------------------------------

mod allocate {
    use std::net::SocketAddr;
    use std::time::Instant;

    use bytes::BytesMut;
    use rtc::sansio::Protocol;
    use rtc::shared::TaggedBytesMut;
    use rtc::shared::TransportContext;
    use rtc::shared::TransportProtocol;
    use rtc::stun::attributes::ATTR_NONCE;
    use rtc::stun::attributes::ATTR_REALM;
    use rtc::stun::error_code::CODE_FORBIDDEN;
    use rtc::stun::error_code::CODE_STALE_NONCE;
    use rtc::stun::error_code::CODE_UNAUTHORIZED;
    use rtc::stun::error_code::ErrorCode;
    use rtc::stun::message::CLASS_ERROR_RESPONSE;
    use rtc::stun::message::CLASS_SUCCESS_RESPONSE;
    use rtc::stun::message::METHOD_ALLOCATE;
    use rtc::stun::message::Message as StunMessage;
    use rtc::stun::message::MessageType;
    use rtc::stun::message::TransactionId;
    use rtc::stun::textattrs::Nonce;
    use rtc::stun::textattrs::Realm;
    use rtc::turn::client::Client;
    use rtc::turn::client::ClientConfig;
    use rtc::turn::client::Event;
    use rtc::turn::proto::lifetime::Lifetime;
    use rtc::turn::proto::relayaddr::RelayedAddress;

    use super::stun;

    const LOCAL: &str = "127.0.0.1:50000";
    const SERVER: &str = "127.0.0.1:3478";

    fn client(transport_protocol: TransportProtocol) -> Client {
        let config = ClientConfig {
            turn_serv_addr: SERVER.to_owned(),
            local_addr: LOCAL.parse().unwrap(),
            transport_protocol,
            username: "user".to_owned(),
            password: "pass".to_owned(),
            ..ClientConfig::default()
        };
        Client::new(config, rtc::crypto::default_provider().expect("a crypto provider")).expect("a TURN client")
    }

    /// The transaction id of the one request the client has to send.
    fn sent(client: &mut Client) -> (TransactionId, StunMessage) {
        let wire = client.poll_write().expect("a request to send");
        assert!(client.poll_write().is_none(), "one request");
        let mut request = StunMessage::new();
        request.raw = wire.message.to_vec();
        request.decode().expect("a STUN request");
        (request.transaction_id, request)
    }

    fn answer(client: &mut Client, transport_protocol: TransportProtocol, now: Instant, raw: Vec<u8>) {
        let (local_addr, peer_addr): (SocketAddr, SocketAddr) = (LOCAL.parse().unwrap(), SERVER.parse().unwrap());
        let transport = TransportContext { local_addr, peer_addr, ecn: None, transport_protocol };
        client.handle_read(TaggedBytesMut { now, transport, message: BytesMut::from(&raw[..]) }).expect("the client reads the answer");
    }

    fn refusal(request: TransactionId, code: ErrorCode, nonce: &str) -> Vec<u8> {
        stun(vec![
            Box::new(request),
            Box::new(MessageType::new(METHOD_ALLOCATE, CLASS_ERROR_RESPONSE)),
            Box::new(code),
            Box::new(Realm::new(ATTR_REALM, "mixdog.test".to_owned())),
            Box::new(Nonce::new(ATTR_NONCE, nonce.to_owned())),
        ])
    }

    /// Every deadline the client names, in order, until it names none: what it reports on the way.
    fn run_out(client: &mut Client) -> Vec<Event> {
        let mut events = Vec::new();
        for _ in 0..64 {
            let Some(deadline) = client.poll_timeout() else { break };
            client.handle_timeout(deadline).expect("a timeout is handled");
            while client.poll_write().is_some() {}
            while let Some(event) = client.poll_event() {
                events.push(event);
            }
        }
        assert!(client.poll_timeout().is_none(), "the client still waits after 64 deadlines");
        events
    }

    fn only_timeout_of(events: &[Event], allocate: TransactionId) {
        assert!(matches!(events, [Event::TransactionTimeout(id)] if *id == allocate), "the Allocate's own timeout, once: {events:?}");
    }

    /// The server never answers the first request: the Allocate times out under the id the caller holds.
    #[test]
    fn silence_before_the_challenge_times_out_the_allocate_the_caller_started() {
        for transport_protocol in [TransportProtocol::UDP, TransportProtocol::TCP] {
            let mut client = client(transport_protocol);
            let allocate = client.allocate(Instant::now()).expect("an Allocate");
            let (first, _) = sent(&mut client);
            assert_ne!(first, allocate, "the first request's wire id is not the completion id");
            only_timeout_of(&run_out(&mut client), allocate);
        }
    }

    /// The server challenges and then never answers the authenticated request: the same id.
    #[test]
    fn silence_after_the_challenge_times_out_the_same_allocate() {
        for transport_protocol in [TransportProtocol::UDP, TransportProtocol::TCP] {
            let mut client = client(transport_protocol);
            let now = Instant::now();
            let allocate = client.allocate(now).expect("an Allocate");
            let (first, _) = sent(&mut client);
            answer(&mut client, transport_protocol, now, refusal(first, CODE_UNAUTHORIZED, "nonce-1"));
            let (_, second) = sent(&mut client);
            assert!(second.get(ATTR_NONCE).is_ok(), "the authenticated request");
            assert!(client.poll_event().is_none(), "the challenge completes nothing");
            only_timeout_of(&run_out(&mut client), allocate);
        }
    }

    /// 401, then 438 with a new nonce, then success: three wire transactions, one completion.
    #[test]
    fn a_stale_nonce_is_retried_once_and_the_success_completes_the_same_allocate() {
        let transport_protocol = TransportProtocol::TCP;
        let mut client = client(transport_protocol);
        let now = Instant::now();
        let allocate = client.allocate(now).expect("an Allocate");
        let (first, _) = sent(&mut client);
        answer(&mut client, transport_protocol, now, refusal(first, CODE_UNAUTHORIZED, "nonce-1"));
        let (second, _) = sent(&mut client);
        answer(&mut client, transport_protocol, now, refusal(second, CODE_STALE_NONCE, "nonce-2"));
        let (third, retried) = sent(&mut client);
        assert_ne!(third, second);
        assert_eq!(Nonce::get_from_as(&retried, ATTR_NONCE).expect("a nonce").text, "nonce-2");
        assert!(client.poll_event().is_none(), "the retry completes nothing");

        // A second 438 is the Allocate's failure, not another retry.
        let mut stale_again = self::client(transport_protocol);
        let again = stale_again.allocate(now).expect("an Allocate");
        let (a, _) = sent(&mut stale_again);
        answer(&mut stale_again, transport_protocol, now, refusal(a, CODE_UNAUTHORIZED, "nonce-1"));
        let (b, _) = sent(&mut stale_again);
        answer(&mut stale_again, transport_protocol, now, refusal(b, CODE_STALE_NONCE, "nonce-2"));
        let (c, _) = sent(&mut stale_again);
        answer(&mut stale_again, transport_protocol, now, refusal(c, CODE_STALE_NONCE, "nonce-3"));
        assert!(matches!(stale_again.poll_event(), Some(Event::AllocateError(id, _)) if id == again));
        assert!(stale_again.poll_write().is_none() && run_out(&mut stale_again).is_empty());

        let relayed: SocketAddr = "203.0.113.7:50123".parse().unwrap();
        let granted = stun(vec![
            Box::new(third),
            Box::new(MessageType::new(METHOD_ALLOCATE, CLASS_SUCCESS_RESPONSE)),
            Box::new(RelayedAddress { ip: relayed.ip(), port: relayed.port() }),
            Box::new(Lifetime(std::time::Duration::from_secs(600))),
        ]);
        answer(&mut client, transport_protocol, now, granted);
        assert!(matches!(client.poll_event(), Some(Event::AllocateResponse(id, address)) if id == allocate && address == relayed));
    }

    /// A refusal of the authenticated request fails the Allocate the caller started, and nothing times out after it.
    #[test]
    fn a_refusal_after_the_challenge_fails_the_same_allocate() {
        let transport_protocol = TransportProtocol::UDP;
        let mut client = client(transport_protocol);
        let now = Instant::now();
        let allocate = client.allocate(now).expect("an Allocate");
        let (first, _) = sent(&mut client);
        answer(&mut client, transport_protocol, now, refusal(first, CODE_UNAUTHORIZED, "nonce-1"));
        let (second, _) = sent(&mut client);
        answer(&mut client, transport_protocol, now, refusal(second, CODE_FORBIDDEN, "nonce-1"));
        assert!(matches!(client.poll_event(), Some(Event::AllocateError(id, _)) if id == allocate));
        assert!(run_out(&mut client).is_empty(), "a completed Allocate does not also time out");
    }
}
