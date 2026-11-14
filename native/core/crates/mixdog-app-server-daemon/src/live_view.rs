//! The phone's live view of Browser Use, served by the core (SPEC R36, §4.7.3): `browser/stream`
//! subscribes a connection to a browser session, `browser/webrtcSignal` carries its WebRTC
//! signals, `browser/screenDisplays` its display list, and the desktop host tells the core what
//! the page shows (`host/browser/page`) and sends its pictures (`host/browser/viewFrames`, X17).
//! The signalling is `mixdog-remote`'s relay, host and viewer, replayed from Node; this is the
//! glue to the connection table, the host channel and the peers (`LiveViewConnection`, one
//! encoder each over the session's shared newest picture).
//!
//! Page input, resizes and the video limit reach the desktop's browser through
//! `host/browser/command{action:"input"}` and `host/browser/liveControl`; the phone's whole-PC screen is the screen sources'
//! (`PhoneScreens`, composed in `compose_screen`): its displays, each paired connection's screen access, and the sessions the host
//! streams as video sources (`compose_screen::live`).
//!
//! The subscriptions behind `browser/stream` and the JPEG view of a phone without WebRTC (`browser/frame`, acknowledged by
//! `browser/streamAck`) are Node's relay pacing (`live_view_streams`): the host's frame facts (`host/browser/frame`) take the
//! picture of the X17 frame that follows them.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_app_protocol::media::MediaFrameHeader;
use mixdog_app_protocol::v2::host::BrowserStreamAckParams;
use mixdog_app_protocol::v2::host::BrowserStreamParams;
use mixdog_app_protocol::v2::host::BrowserWebrtcSignalParams;
use mixdog_app_protocol::v2::host::HostBrowserFrameParams;
use mixdog_app_protocol::v2::host::HostBrowserPageParams;
use mixdog_app_protocol::v2::host::HostBrowserViewFramesParams;
use mixdog_app_server::HostMedia;
use mixdog_app_server::StreamTarget;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::Reply;
use mixdog_core_api::call::Caller;
use mixdog_core_api::domain::media::FrameSourceKind;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_remote::access::RemoteRuntime;
use mixdog_remote::webrtc::capture::SharedSource;
use mixdog_remote::webrtc::config::IceServer;
use mixdog_remote::webrtc::config::PeerConfig;
use mixdog_remote::webrtc::config::PeerFailure;
use mixdog_remote::webrtc::host::HostEnv;
use mixdog_remote::webrtc::host::LiveHost;
use mixdog_remote::webrtc::host::Picture;
use mixdog_remote::webrtc::host::SenderEvent;
use mixdog_remote::webrtc::host::VideoSource;
use mixdog_remote::webrtc::liveview::LiveViewConnection;
use mixdog_remote::webrtc::liveview::LiveViewEvent;
use mixdog_remote::webrtc::relay::Origin;
use mixdog_remote::webrtc::relay::Relay;
use mixdog_remote::webrtc::relay::RelayDeps;
use mixdog_remote::webrtc::signal::ClientSignal;
use mixdog_remote::webrtc::signal::CloseReason;
use mixdog_remote::webrtc::signal::DesktopSignal;
use mixdog_remote::webrtc::signal::Geometry;
use mixdog_remote::webrtc::signal::Resize;
use mixdog_remote::webrtc::signal::Source;
use mixdog_remote::webrtc::signal::VideoLimit;
use mixdog_remote::webrtc::sources::FrameSink;
use mixdog_remote::webrtc::sources::frame_feed;
use mixdog_rt::MediaThread;
use mixdog_rt::TaskClass;
use mixdog_tools::desktop::screen_source::ScreenSink;
use mixdog_tools::desktop::screen_source::ScreenViewer;
use serde_json::Value;
use serde_json::json;

use crate::compose_screen::live::ScreenLive;
use crate::connection_close::ConnectionOwner;
use crate::live_view_streams::BrowserStreams;
use crate::live_view_streams::Clock;
use crate::live_view_streams::StreamsDeps;
use crate::live_view_streams::SystemClock;
use crate::live_view_streams::normalize_stream_options;
use crate::live_view_streams::required_session_id;

const SESSION_PREFIX: &str = "browser:";

/// Whether a connection may see this PC's screens.
pub trait ScreenAccess: Send + Sync {
    fn allowed(&self, connection: ConnectionId) -> bool;
    /// Whether a connection may still be shown the browser view: its peer is attached and its device was not unpaired while it was
    /// connected (nor admitted while an unpair was in force). Asked at every subscribe (`browser/stream`, a WebRTC `ready` and every
    /// phone signal through the subscription), at every frame and at every WebRTC signal the host sends, so an unpair whose drop was
    /// missed still shows the phone nothing.
    fn view_allowed(&self, connection: ConnectionId) -> bool;
}

/// How a phone's access to this PC's screen ended: its connection left the relay, or its device was unpaired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenEnd {
    ViewerLeft,
    Revoked,
}

/// The phone's whole-PC screen as the live view reaches it: the displays a phone may pick from, the access of its connection (granted
/// before its screen `ready` is forwarded and withdrawn when the connection or its pairing ends) and the sessions it streams
/// (`ScreenSources`, composed in `compose_screen`). Not bound where the PC has no screen control (not Windows): the phone is then told
/// so.
#[async_trait]
pub trait PhoneScreens: Send + Sync {
    /// The picker's displays (an array of summaries).
    async fn displays(&self) -> Result<Value, String>;
    /// `connection` is a paired relay connection past its handshake; its sessions belong to it. Idempotent. The displays are read
    /// the first time, so the phone's `ready` that follows finds its monitors listed.
    async fn grant(&self, connection: ConnectionId) -> Result<(), String>;
    fn withdraw(&self, connection: ConnectionId, ended: ScreenEnd);
    /// The session of `screen_id` for `connection`: the one it owns, or a new one for its `ready` when nobody holds the display.
    fn resolve(&self, screen_id: &str, connection: ConnectionId, ready: bool) -> Option<Arc<ScreenViewer>>;
    /// The pictures of display `screen_id` for the track (the in-process capture, else the desktop's pixels).
    fn capture(&self, screen_id: &str) -> Result<Box<dyn MediaFrameSource>, String>;
    /// Where the sessions report their geometry, track changes, channel messages and helper frames (once, before any phone signal).
    fn attach(&self, sink: Arc<dyn ScreenSink>);
}

/// Node's rule (`screen-access-publisher.ts` `allowed`; "pairing is the approval"): a connection is allowed exactly
/// when it is a paired relay peer past its handshake and its pairing still stands. The core holds that as the credential
/// a connection acts as (`phone_credential`): a local client has none, and a peer whose pairing ended loses it.
pub struct PairedScreenAccess {
    credential: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>,
    /// Whether the connection is revoked for the screen for its lifetime (live at an unpair, or admitted while one was in force):
    /// the peer keeps its credential, and so everything but the screen.
    revoked: Arc<dyn Fn(ConnectionId) -> bool + Send + Sync>,
    /// Whether the relay peer behind the connection is attached (Node's client registry still holds it with its channel).
    attached: Arc<dyn Fn(ConnectionId) -> bool + Send + Sync>,
}

impl PairedScreenAccess {
    pub fn new(
        credential: Arc<dyn Fn(ConnectionId) -> Option<String> + Send + Sync>,
        revoked: Arc<dyn Fn(ConnectionId) -> bool + Send + Sync>,
        attached: Arc<dyn Fn(ConnectionId) -> bool + Send + Sync>,
    ) -> Self {
        Self { credential, revoked, attached }
    }
}

impl ScreenAccess for PairedScreenAccess {
    fn allowed(&self, connection: ConnectionId) -> bool {
        (self.credential)(connection).is_some() && !(self.revoked)(connection)
    }

    fn view_allowed(&self, connection: ConnectionId) -> bool {
        (self.attached)(connection) && !(self.revoked)(connection)
    }
}

/// One streamed browser session: the host's pictures arrive on `stream_id`, and every viewer's
/// encoder reads the newest from `shared`.
struct Stream {
    stream_id: u32,
    sink: Mutex<FrameSink>,
    shared: Arc<SharedSource>,
}

type Page = (Option<String>, Option<Geometry>);

#[derive(Default)]
struct State {
    /// What each streamed session shows now (`host/browser/page`).
    pages: HashMap<String, Page>,
    streams: HashMap<String, Arc<Stream>>,
    /// Per session, the host's frame facts whose picture is the next X17 frame of its stream (`host/browser/frame`).
    awaiting_picture: HashMap<String, Value>,
    /// Connections that closed while subscribed: Node's `isLive` is false for them, so the next frame or the lapse drops
    /// their subscriptions (`remote-browser-streams.ts` `publish`).
    closed: HashSet<u64>,
    timers: HashMap<u64, tokio::task::JoinHandle<()>>,
    next_stream: u32,
}

struct Inner {
    host_channel: Arc<dyn HostChannel>,
    notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
    media: Arc<HostMedia>,
    access: Arc<dyn ScreenAccess>,
    runtime: Arc<RemoteRuntime>,
    peers: Arc<dyn Peers>,
    state: Mutex<State>,
    relay: OnceLock<Arc<Relay<RelayAdapter>>>,
    host: OnceLock<LiveHost>,
    streams: OnceLock<Arc<BrowserStreams>>,
    timer_seq: AtomicU64,
    /// The phone's whole-PC screen, bound once it is composed.
    screens: OnceLock<Arc<dyn PhoneScreens>>,
    /// The sessions of `screens` as the host streams them, made when they are bound.
    screen_live: OnceLock<Arc<ScreenLive>>,
    /// Each push of the view to a phone holds this from its `view_allowed` check through its `notify` (synchronous, nothing awaited),
    /// and an unpair's cleanup passes through it after the revocation and the drop (`LiveViewService::unpaired`): once the cleanup has
    /// returned, a push that passed its check has been enqueued and every later one is refused. Taken by nothing a push's check or
    /// enqueue holds a lock for.
    view_gate: Mutex<()>,
    #[cfg(test)]
    pub(crate) seams: Mutex<Seams>,
}

/// Test-only points of a push to a phone and of an unpair's cleanup, where a test holds one side while the other runs.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Seams {
    /// A push on its way, before the view gate, with its method.
    pub(crate) on_its_way: Option<Arc<dyn Fn(u64, &str) + Send + Sync>>,
    /// A push that passed its check, before its `notify`, the view gate held.
    pub(crate) checked: Option<Arc<dyn Fn(u64) + Send + Sync>>,
    /// An unpair's cleanup that found the view gate held by a push and waits for it.
    pub(crate) cleanup_waits: Option<Arc<dyn Fn() + Send + Sync>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn domain_error(message: impl Into<String>) -> CoreError {
    CoreError::DomainError { domain: "remote".into(), code: None, message: Some(message.into().into()), detail: None }
}

fn host_error(error: HostError) -> String {
    match error {
        HostError::Rpc { message, .. } => message,
        HostError::Core(error) => format!("{error:?}"),
    }
}

fn client_connection(client: &str) -> Option<ConnectionId> {
    client.parse().ok().map(ConnectionId)
}

fn source_key(session: &str) -> String {
    format!("{SESSION_PREFIX}{session}")
}

impl Inner {
    fn relay(&self) -> &Arc<Relay<RelayAdapter>> {
        self.relay.get().expect("the live view is built with its relay")
    }

    fn host(&self) -> &LiveHost {
        self.host.get().expect("the live view is built with its host")
    }

    fn streams(&self) -> &Arc<BrowserStreams> {
        self.streams.get().expect("the live view is built with its streams")
    }

    fn subscribed(&self, connection: u64, session: &str) -> bool {
        self.streams().subscribed(&connection.to_string(), session)
    }

    #[cfg(test)]
    fn seam(&self, pick: impl FnOnce(&Seams) -> Option<Arc<dyn Fn(u64) + Send + Sync>>, connection: u64) {
        let hook = pick(&lock(&self.seams));
        if let Some(hook) = hook {
            hook(connection);
        }
    }

    /// One push of the view to a phone (a frame, or a WebRTC signal), refused (`Ok(false)`) unless the phone may still view and, for a
    /// frame (`open_only`), its connection is open: the check and the enqueue are one step under the view gate.
    fn push_view(&self, connection: ConnectionId, method: &'static str, params: Value, open_only: bool) -> Result<bool, CoreError> {
        #[cfg(test)]
        {
            let hook = lock(&self.seams).on_its_way.clone();
            if let Some(hook) = hook {
                hook(connection.0, method);
            }
        }
        let _gate = lock(&self.view_gate);
        if (open_only && lock(&self.state).closed.contains(&connection.0)) || !self.access.view_allowed(connection) {
            return Ok(false);
        }
        #[cfg(test)]
        self.seam(|seams| seams.checked.clone(), connection.0);
        self.notifier.notify(connection, Method(method), params).map(|()| true)
    }

    /// An unpair's cleanup passes the view gate, its revocation already in force: a push past its check finishes its enqueue first.
    fn pass_view_gate(&self) {
        #[cfg(test)]
        if let Err(std::sync::TryLockError::WouldBlock) = self.view_gate.try_lock() {
            let hook = lock(&self.seams).cleanup_waits.clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        drop(lock(&self.view_gate));
    }

    /// The streams' request to the desktop (Node's `browserRemote('stream', [sessionId, options])`): the session's stream starts
    /// with its first subscriber, every change sends the largest options, and the last subscriber's end stops the host's pictures.
    fn stream_request(self: &Arc<Self>, session: &str, options: Option<Value>) {
        let Some(options) = options else {
            let ended = {
                let mut state = lock(&self.state);
                state.pages.remove(session);
                state.awaiting_picture.remove(session);
                state.streams.remove(session)
            };
            if let Some(stream) = ended {
                self.media.unbind(stream.stream_id);
                stream.shared.stop();
                self.view_frames(session, stream.stream_id, false, Value::Null);
            }
            return;
        };
        let (stream_id, created) = {
            let mut state = lock(&self.state);
            match state.streams.get(session) {
                Some(stream) => (stream.stream_id, false),
                None => {
                    state.next_stream += 1;
                    let stream_id = state.next_stream;
                    let (sink, feed) = frame_feed(FrameSourceKind::BrowserView { tab_id: session.to_owned() });
                    let shared = SharedSource::start(Box::new(feed));
                    state.streams.insert(session.to_owned(), Arc::new(Stream { stream_id, sink: Mutex::new(sink), shared }));
                    (stream_id, true)
                }
            }
        };
        if created {
            self.media.bind(stream_id, Arc::new(LiveViewFeed { inner: Arc::downgrade(self), session: session.to_owned() }));
        }
        self.view_frames(session, stream_id, true, options);
    }

    /// The host's facts of a frame: published at once, or, when they announce a picture, with the X17 frame that follows.
    fn frame_facts(&self, params: HostBrowserFrameParams) {
        if params.frame.get("image").is_some_and(|image| !image.is_null()) {
            // Only a viewed session has a stream for its picture to arrive on.
            let mut state = lock(&self.state);
            if state.streams.contains_key(&params.tab_id) {
                state.awaiting_picture.insert(params.tab_id, params.frame);
            }
        } else {
            self.streams().publish(params.frame);
        }
    }

    fn view_frames(&self, session: &str, stream_id: u32, on: bool, request: Value) {
        let params = HostBrowserViewFramesParams { tab_id: session.to_owned(), stream_id, on, request };
        let Ok(params) = serde_json::to_value(params) else { return };
        if let Err(error) = self.host_channel.notify(HostCapability::Browser, Method("host/browser/viewFrames"), params) {
            tracing::warn!(?error, session, on, "host/browser/viewFrames was not delivered");
        }
    }

    /// A picture of the session's stream: counted against the page it shows, then the newest one.
    fn picture(&self, session: &str, width: u16, height: u16, jpeg: Bytes) {
        let (document_id, generation, facts) = {
            let mut state = lock(&self.state);
            let facts = state.awaiting_picture.remove(session);
            match state.pages.get(session) {
                Some((document_id, Some(geometry))) if geometry.pixel_width == u64::from(width) && geometry.pixel_height == u64::from(height) => (document_id.clone(), geometry.generation, facts),
                _ => (None, 0, facts),
            }
        };
        // The JPEG view's frame: the facts the host sent before this picture, with the picture as Node's base64 `image.data`.
        if let Some(mut frame) = facts {
            if let Some(image) = frame.get_mut("image").and_then(Value::as_object_mut) {
                image.insert("data".to_owned(), Value::String(base64::engine::general_purpose::STANDARD.encode(&jpeg)));
            }
            self.streams().publish(frame);
        }
        self.host().frame(&source_key(session), Picture { document_id, generation, data: jpeg });
    }

    fn page_changed(&self, params: HostBrowserPageParams) {
        let geometry = match params.geometry.as_ref().map(Geometry::parse) {
            None | Some(Err(_)) => None,
            Some(Ok(geometry)) => Some(geometry),
        };
        let session = params.tab_id;
        let previous = lock(&self.state).pages.insert(session.clone(), (params.document_id, geometry.clone()));
        let previous_generation = previous.and_then(|(_, geometry)| geometry).map(|g| g.generation);
        match geometry {
            None => self.host().geometry_changed(&source_key(&session), None),
            Some(geometry) if previous_generation != Some(geometry.generation) => self.host().geometry_changed(&source_key(&session), Some(&geometry)),
            Some(_) => {}
        }
    }

    async fn host_request(&self, method: &'static str, params: Value) -> Result<Value, String> {
        self.host_channel.request(HostCapability::Browser, Method(method), params).await.map_err(host_error)
    }
}

/// The host's pictures of one streamed session.
struct LiveViewFeed {
    inner: Weak<Inner>,
    session: String,
}

impl StreamTarget for LiveViewFeed {
    fn jpeg(&self, header: MediaFrameHeader, jpeg: Bytes) {
        if let Some(inner) = self.inner.upgrade() {
            inner.picture(&self.session, header.width, header.height, jpeg);
        }
    }
}

/// The relay's view of the connection table, the host and the desktop.
struct RelayAdapter(Weak<Inner>);

#[async_trait]
impl RelayDeps for RelayAdapter {
    fn subscribed(&self, client: &str, session: &str) -> bool {
        match (self.0.upgrade(), client_connection(client)) {
            (Some(inner), Some(connection)) => inner.subscribed(connection.0, session),
            _ => false,
        }
    }

    fn awaiting_fit(&self, client: &str, session: &str) -> bool {
        self.0.upgrade().is_some_and(|inner| inner.streams().awaiting_fit(client, session))
    }

    async fn screen_authorized(&self, client: &str, _origin: Origin) -> bool {
        match (self.0.upgrade(), client_connection(client)) {
            (Some(inner), Some(connection)) => {
                if !inner.access.allowed(connection) {
                    return false;
                }
                match inner.screens.get() {
                    Some(screens) => screens.grant(connection).await.is_ok(),
                    None => true,
                }
            }
            _ => false,
        }
    }

    fn set_images(&self, client: &str, session: &str, enabled: bool) {
        if let Some(inner) = self.0.upgrade() {
            inner.streams().set_images(client, session, enabled);
        }
    }

    fn released(&self) {
        if let Some(inner) = self.0.upgrade() {
            inner.streams().deliver_queued();
        }
    }

    async fn resolve_ice_servers(&self) -> Result<Vec<IceServer>, String> {
        let inner = self.0.upgrade().ok_or("the live view stopped.")?;
        Ok(inner.runtime.resolve_ice().await.into_iter().map(|s| IceServer { urls: s.urls, username: s.username, credential: s.credential }).collect())
    }

    async fn forward(&self, client: &str, signal: &ClientSignal, ice_servers: Option<&[IceServer]>, _origin: Origin) -> Result<(), String> {
        let inner = self.0.upgrade().ok_or("the live view stopped.")?;
        inner.host().signal(client, signal, ice_servers.unwrap_or(&[])).await
    }

    fn viewer_left(&self, client: &str, source_key: &str) {
        if let Some(inner) = self.0.upgrade() {
            inner.host().viewer_left(client, source_key);
        }
    }

    async fn screen_displays(&self) -> Result<Value, String> {
        let inner = self.0.upgrade().ok_or("the live view stopped.")?;
        match inner.screens.get() {
            Some(screens) => screens.displays().await,
            None => Err("Remote screen is unavailable.".to_owned()),
        }
    }

    async fn send(&self, client: &str, payload: Value) -> Result<(), String> {
        let inner = self.0.upgrade().ok_or("the live view stopped.")?;
        let connection = client_connection(client).ok_or("remote webrtc client id is invalid.")?;
        // A phone that may no longer view gets no signal, also one the host sent before the unpair and that is only now going out (the
        // patched Node's `mayWrite` at the write in `remote-relay.ts`); like a push to a phone that left, that is no failure of the
        // host's send.
        inner.push_view(connection, "browser/webrtcSignal", json!({ "signal": payload["payload"] }), false).map(|_| ()).map_err(|error| format!("{error:?}"))
    }
}

/// The streams' view of the connection table, the phones and the desktop (`remote-relay.ts:360-367`).
struct StreamsAdapter(Weak<Inner>);

impl StreamsDeps for StreamsAdapter {
    fn is_live(&self, client: &str) -> bool {
        match (self.0.upgrade(), client_connection(client)) {
            (Some(inner), Some(connection)) => !lock(&inner.state).closed.contains(&connection.0),
            _ => false,
        }
    }

    fn send(&self, client: &str, frame: Value) {
        let (Some(inner), Some(connection)) = (self.0.upgrade(), client_connection(client)) else { return };
        // As Node's `sendEncryptedFrame` (`remote-relay-delivery.ts:90-93`) a phone that left gets nothing; and nor does one whose
        // device was unpaired, even when the unpair's drop of its subscriptions was missed. Node's push is droppable and its failure
        // ignored.
        if let Err(error) = inner.push_view(connection, "browser/frame", frame, true) {
            tracing::debug!(?error, client, "a browser/frame push was not delivered");
        }
    }

    fn request(&self, session: &str, options: Option<Value>) {
        if let Some(inner) = self.0.upgrade() {
            inner.stream_request(session, options);
        }
    }

    fn allowed(&self, client: &str) -> bool {
        match (self.0.upgrade(), client_connection(client)) {
            (Some(inner), Some(connection)) => inner.access.view_allowed(connection),
            _ => false,
        }
    }

    fn on_drop(&self, client: &str, session: &str) {
        let Some(inner) = self.0.upgrade() else { return };
        inner.relay().viewer_left(client, session);
        if let Some(connection) = client_connection(client)
            && !inner.streams().subscribes_any(client)
        {
            lock(&inner.state).closed.remove(&connection.0);
        }
    }
}

/// A streamed browser page as the host sees it.
struct BrowserPage {
    inner: Weak<Inner>,
    session: String,
}

#[async_trait]
impl VideoSource for BrowserPage {
    // The page is captured by its stream already.
    fn start(&self) {}

    fn stop(&self) {}

    fn page(&self) -> Page {
        self.inner.upgrade().and_then(|inner| lock(&inner.state).pages.get(&self.session).cloned()).unwrap_or_default()
    }

    async fn dispatch(&self, control: &Value) -> Result<(), String> {
        let inner = self.inner.upgrade().ok_or("the live view stopped.")?;
        inner.host_request("host/browser/command", json!({ "action": "input", "threadId": self.session, "input": control })).await.map(|_| ())
    }

    async fn resize(&self, request: &Resize) -> Result<(), String> {
        let inner = self.inner.upgrade().ok_or("the live view stopped.")?;
        inner.host_request("host/browser/liveControl", json!({ "sessionId": self.session, "kind": "resize", "request": request.to_json() })).await.map(|_| ())
    }

    fn video_limit(&self, limit: VideoLimit) {
        let Some(inner) = self.inner.upgrade() else { return };
        let params = json!({ "sessionId": self.session, "kind": "videoLimit", "request": { "maxWidth": limit.max_width, "maxHeight": limit.max_height } });
        mixdog_rt::spawn("live-view-limit", TaskClass::Work, async move {
            if let Err(error) = inner.host_request("host/browser/liveControl", params).await {
                tracing::warn!(error, "the video limit was not applied");
            }
        });
    }
}

fn close_reason(failure: PeerFailure) -> CloseReason {
    match failure {
        PeerFailure::IceFailed => CloseReason::IceFailed,
        PeerFailure::DtlsFailed => CloseReason::DtlsFailed,
        PeerFailure::ChannelFailed => CloseReason::ChannelFailed,
        PeerFailure::ProtocolError => CloseReason::ProtocolError,
        PeerFailure::PeerHostUnavailable => CloseReason::SenderFailed,
        PeerFailure::Unsupported => CloseReason::Unsupported,
    }
}

/// The peer connections of the live view: one per viewer, each with an encoder of its own over the
/// session's shared newest picture. The production peers are [`RtcPeers`].
pub trait Peers: Send + Sync {
    /// Starts a connection; its events go to `events`. `Err` is a detail for the log.
    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String], source: Arc<SharedSource>, events: Box<dyn Fn(SenderEvent) + Send + Sync>) -> Result<(), String>;
    fn answer(&self, connection_id: &str, sdp: &str);
    fn candidate(&self, connection_id: &str, candidate: &Option<mixdog_remote::webrtc::config::Candidate>);
    fn channel_send(&self, connection_id: &str, text: &str);
    /// Ends the connection and stops its encoder.
    fn close(&self, connection_id: &str);
    /// The id of a new connection: unguessable, url-safe.
    fn new_connection_id(&self) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 18]>())
    }
}

pub struct RtcPeers {
    media_thread: MediaThread,
    peers: Mutex<HashMap<String, Arc<LiveViewConnection>>>,
}

impl RtcPeers {
    pub fn new(media_thread: MediaThread) -> Self {
        Self { media_thread, peers: Mutex::default() }
    }

    fn peer(&self, connection_id: &str) -> Option<Arc<LiveViewConnection>> {
        lock(&self.peers).get(connection_id).cloned()
    }
}

impl Peers for RtcPeers {
    fn open(&self, connection_id: &str, ice_servers: &[IceServer], receive_codecs: &[String], source: Arc<SharedSource>, events: Box<dyn Fn(SenderEvent) + Send + Sync>) -> Result<(), String> {
        let (peer, mut rx) = LiveViewConnection::spawn(PeerConfig::new(ice_servers.to_vec()), receive_codecs.to_vec(), source, self.media_thread).map_err(|error| error.to_string())?;
        lock(&self.peers).insert(connection_id.to_owned(), Arc::new(peer));
        let id = connection_id.to_owned();
        mixdog_rt::spawn("live-view-events", TaskClass::Work, async move {
            while let Some(event) = rx.recv().await {
                let routed = match event {
                    LiveViewEvent::Offer { sdp } => SenderEvent::Offer { connection_id: id.clone(), sdp },
                    LiveViewEvent::Candidate { candidate } => SenderEvent::Candidate { connection_id: id.clone(), candidate },
                    LiveViewEvent::Connected { remote_certificate } => SenderEvent::Connected {
                        connection_id: id.clone(),
                        certificate: remote_certificate.map(|c| json!({ "fingerprintAlgorithm": c.fingerprint_algorithm, "fingerprint": c.fingerprint })),
                    },
                    LiveViewEvent::ChannelOpen => continue,
                    LiveViewEvent::Channel { text, received_at_ms } => SenderEvent::Channel { connection_id: id.clone(), text, received_at: received_at_ms as f64 },
                    LiveViewEvent::Failed(fault) => SenderEvent::Failed { connection_id: id.clone(), reason: close_reason(fault.reason) },
                };
                events(routed);
            }
        });
        Ok(())
    }

    fn answer(&self, connection_id: &str, sdp: &str) {
        if let Some(peer) = self.peer(connection_id) {
            peer.answer(sdp.to_owned());
        }
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<mixdog_remote::webrtc::config::Candidate>) {
        if let Some(peer) = self.peer(connection_id) {
            peer.candidate(candidate.clone());
        }
    }

    fn channel_send(&self, connection_id: &str, text: &str) {
        if let Some(peer) = self.peer(connection_id) {
            peer.channel_send(text.to_owned());
        }
    }

    fn close(&self, connection_id: &str) {
        // Dropping the handle closes the connection and stops its encoder.
        lock(&self.peers).remove(connection_id);
    }
}
/// The host's surroundings: the peers, the relay, time and tasks.
struct LiveEnv(Weak<Inner>);

impl LiveEnv {
    fn inner(&self) -> Option<Arc<Inner>> {
        self.0.upgrade()
    }
}

impl HostEnv for LiveEnv {
    fn spawn(&self, work: BoxFuture<'static, ()>) {
        mixdog_rt::spawn("live-view", TaskClass::Work, work);
    }

    fn send_signal(&self, client: &str, signal: &DesktopSignal) -> BoxFuture<'static, Result<(), String>> {
        let Some(inner) = self.inner() else { return Box::pin(async { Err("the live view stopped.".to_owned()) }) };
        let (client, raw) = (client.to_owned(), signal.to_json());
        Box::pin(async move { inner.relay().clone().send(&client, &raw).await })
    }

    fn source(&self, source: &Source, client: &str, signal: &str) -> Option<Arc<dyn VideoSource>> {
        let inner = self.inner()?;
        let connection = client_connection(client)?;
        match source {
            Source::Browser { session_id } => {
                inner.subscribed(connection.0, session_id).then(|| Arc::new(BrowserPage { inner: self.0.clone(), session: session_id.clone() }) as Arc<dyn VideoSource>)
            }
            // A screen is opened per client, and only by its `ready`.
            Source::Screen { screen_id } => inner.screen_live.get()?.source(screen_id, connection, signal == "ready"),
        }
    }

    fn open(&self, connection_id: &str, source_key: &str, ice_servers: &[IceServer], receive_codecs: &[String]) {
        let Some(inner) = self.inner() else { return };
        // The source every connection of the stream or the screen encodes.
        let shared = match source_key.strip_prefix(SESSION_PREFIX) {
            Some(session) => lock(&inner.state).streams.get(session).map(|stream| stream.shared.clone()).ok_or_else(|| "no stream".to_owned()),
            None => inner.screen_live.get().ok_or_else(|| "no screens".to_owned()).and_then(|live| live.track(source_key)),
        };
        let (weak, id) = (self.0.clone(), connection_id.to_owned());
        let events: Box<dyn Fn(SenderEvent) + Send + Sync> = Box::new(move |event| {
            if let Some(inner) = weak.upgrade() {
                inner.host().sender_event(event);
            }
        });
        let started = shared.and_then(|shared| inner.peers.open(connection_id, ice_servers, receive_codecs, shared, events));
        if let Err(detail) = started {
            tracing::warn!(detail, id, "the live-view peer did not start");
            // The viewer is locked while it opens its connection: the failure reaches it from a task of its own.
            mixdog_rt::spawn("live-view-peer-failed", TaskClass::Work, async move {
                inner.host().sender_event(SenderEvent::Failed { connection_id: id, reason: CloseReason::SenderFailed });
            });
        }
    }

    fn answer(&self, connection_id: &str, sdp: &str) {
        if let Some(inner) = self.inner() {
            inner.peers.answer(connection_id, sdp);
        }
    }

    fn candidate(&self, connection_id: &str, candidate: &Option<mixdog_remote::webrtc::config::Candidate>) {
        if let Some(inner) = self.inner() {
            inner.peers.candidate(connection_id, candidate);
        }
    }

    fn channel_send(&self, connection_id: &str, text: &str) {
        if let Some(inner) = self.inner() {
            inner.peers.channel_send(connection_id, text);
        }
    }

    fn close(&self, connection_id: &str) {
        if let Some(inner) = self.inner() {
            inner.peers.close(connection_id);
        }
    }
    fn push_picture(&self, source_key: &str, frame_id: u64, picture: &Picture) {
        let Some(inner) = self.inner() else { return };
        let Some(stream) = source_key.strip_prefix(SESSION_PREFIX).and_then(|session| lock(&inner.state).streams.get(session).cloned()) else { return };
        // A picture that cannot describe itself is dropped like any junk frame. The sink takes the
        // picture at once (it keeps only the newest), so the frame is done when the push returns.
        let ok = lock(&stream.sink).push_jpeg(picture.data.clone()).is_ok();
        inner.host().sender_event(SenderEvent::FrameDone { source_key: source_key.to_owned(), frame_id, ok });
    }

    fn source_closed(&self, source_key: &str) {
        if let Some(live) = self.inner().and_then(|inner| inner.screen_live.get().cloned()) {
            live.closed(source_key);
        }
    }

    fn report(&self, event: &str, data: Value) {
        tracing::info!(target: "remote-webrtc", event, %data);
    }

    fn new_connection_id(&self) -> String {
        self.inner().map_or_else(String::new, |inner| inner.peers.new_connection_id())
    }

    fn now(&self) -> f64 {
        mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    fn set_timer(&self, ms: u64, run: Arc<dyn Fn(u64) + Send + Sync>) -> u64 {
        let Some(inner) = self.inner() else { return 0 };
        let handle = inner.timer_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let task = mixdog_rt::spawn("live-view-timer", TaskClass::Work, async move {
            mixdog_rt::time::sleep(Duration::from_millis(ms)).await;
            run(handle);
        });
        lock(&inner.state).timers.insert(handle, task);
        handle
    }

    fn clear_timer(&self, handle: u64) {
        if let Some(task) = self.inner().and_then(|inner| lock(&inner.state).timers.remove(&handle)) {
            task.abort();
        }
    }
}

pub struct LiveViewService {
    inner: Arc<Inner>,
}

impl LiveViewService {
    pub fn new(
        host_channel: Arc<dyn HostChannel>,
        notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
        media: Arc<HostMedia>,
        runtime: Arc<RemoteRuntime>,
        media_thread: MediaThread,
        access: Arc<dyn ScreenAccess>,
    ) -> Self {
        Self::with_peers(host_channel, notifier, media, runtime, Arc::new(RtcPeers::new(media_thread)), access)
    }

    pub fn with_peers(
        host_channel: Arc<dyn HostChannel>,
        notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
        media: Arc<HostMedia>,
        runtime: Arc<RemoteRuntime>,
        peers: Arc<dyn Peers>,
        access: Arc<dyn ScreenAccess>,
    ) -> Self {
        Self::with_clock(host_channel, notifier, media, runtime, peers, access, SystemClock::new())
    }

    /// With the clock the phones' subscriptions lapse and their frames are resent by.
    pub fn with_clock(
        host_channel: Arc<dyn HostChannel>,
        notifier: Arc<dyn mixdog_core_api::ConnectionNotifier>,
        media: Arc<HostMedia>,
        runtime: Arc<RemoteRuntime>,
        peers: Arc<dyn Peers>,
        access: Arc<dyn ScreenAccess>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let inner = Arc::new(Inner {
            host_channel,
            notifier,
            media,
            access,
            runtime,
            peers,
            state: Mutex::default(),
            relay: OnceLock::new(),
            host: OnceLock::new(),
            streams: OnceLock::new(),
            timer_seq: AtomicU64::new(0),
            screens: OnceLock::new(),
            screen_live: OnceLock::new(),
            view_gate: Mutex::default(),
            #[cfg(test)]
            seams: Mutex::default(),
        });
        let weak = Arc::downgrade(&inner);
        let _ = inner.streams.set(BrowserStreams::new(Arc::new(StreamsAdapter(weak.clone())), clock));
        let _ = inner.relay.set(Arc::new(Relay::new(RelayAdapter(weak.clone()))));
        let _ = inner.host.set(LiveHost::new(Arc::new(LiveEnv(weak))));
        Self { inner }
    }
}

#[async_trait]
impl DomainService for LiveViewService {
    fn methods(&self) -> &'static [&'static str] {
        &["browser/stream", "browser/webrtcSignal", "browser/screenDisplays", "host/browser/page", "host/browser/frame", "browser/streamAck"]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let Caller::Connection(connection) = req.ctx.caller else {
            return Err(CoreError::InvalidParams { path: "caller".into(), expected: "a connection".into() });
        };
        let invalid = |error: serde_json::Error| CoreError::InvalidParams { path: "params".into(), expected: error.to_string().into() };
        let client = connection.0.to_string();
        match req.method.as_str() {
            // `remote-relay-client-calls.ts:241-260`: the session id, then the options; `on: false` is Node's `null` options.
            "browser/stream" => {
                let params: BrowserStreamParams = serde_json::from_value(req.params).map_err(invalid)?;
                let session = required_session_id(&params.session_id).map_err(domain_error)?;
                let streams = self.inner.streams();
                if params.on {
                    streams.subscribe(&client, &session, normalize_stream_options(params.request.as_ref()).map_err(domain_error)?).map_err(domain_error)?;
                } else {
                    streams.unsubscribe(&client, &session);
                }
                Ok(Reply::Value(json!({})))
            }
            "browser/webrtcSignal" => {
                let params: BrowserWebrtcSignalParams = serde_json::from_value(req.params).map_err(invalid)?;
                let relay = self.inner.relay();
                let signal = relay.accept(&client, &params.signal).map_err(domain_error)?;
                relay.forward(&client, &signal, connection.0).await.map_err(domain_error)?;
                Ok(Reply::Value(json!({})))
            }
            "browser/screenDisplays" => {
                let displays = self.inner.relay().screen_displays(&client, connection.0).await.map_err(domain_error)?;
                Ok(Reply::Value(displays))
            }
            other => Err(CoreError::InvalidParams { path: "method".into(), expected: format!("one of this service's methods, not {other}").into() }),
        }
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        match method.as_str() {
            "host/browser/page" => {
                if let Ok(page) = serde_json::from_value::<HostBrowserPageParams>(params) {
                    self.inner.page_changed(page);
                }
            }
            "host/browser/frame" => {
                if let Ok(frame) = serde_json::from_value::<HostBrowserFrameParams>(params) {
                    self.inner.frame_facts(frame);
                }
            }
            // `remote-relay-client-calls.ts:403-409`: anything but a string session and a number seq is ignored.
            "browser/streamAck" => {
                if let Ok(ack) = serde_json::from_value::<BrowserStreamAckParams>(params) {
                    self.inner.streams().acknowledge(&from.0.to_string(), &ack.session_id, ack.seq);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

impl LiveViewService {
    /// The device behind `connection` was unpaired: the connection's browser streams end now, their frames in flight and resends
    /// with them, and so its WebRTC views (`on_drop`). Node's unpair asks this of its streams (`remote-relay.ts:619`, `dropClient`).
    /// Called once the connection is revoked: its streams end first, so the desktop is told at the unpair as Node tells it, then it
    /// passes the view gate, so a push that passed its check before the revocation is enqueued before this returns and every later
    /// one is refused. (Where the bytes enter the phone's stream they are asked again, `DeviceRegistry::write_view`.)
    pub fn unpaired(&self, connection: ConnectionId) {
        if let Some(screens) = self.inner.screens.get() {
            screens.withdraw(connection, ScreenEnd::Revoked);
        }
        self.inner.streams().drop_client(&connection.0.to_string());
        self.inner.pass_view_gate();
    }

    /// Binds the phone's whole-PC screen (once): its sessions report to the live view from here on.
    pub fn bind_screens(&self, screens: Arc<dyn PhoneScreens>) -> Result<(), Arc<dyn PhoneScreens>> {
        self.inner.screens.set(screens.clone())?;
        let live = ScreenLive::new(self.inner.host().clone(), screens.clone());
        screens.attach(live.sink());
        let _ = self.inner.screen_live.set(live);
        Ok(())
    }

    /// The relay closed: every phone's browser stream ends (`remote-relay.ts:658`, `browserStreams.dispose()`).
    pub fn relay_closed(&self) {
        self.inner.streams().dispose();
    }

    /// A signal of the live-view host to a phone, as the host sends it (`HostEnv::send_signal`): the returned future is the send on its
    /// way, run when it is awaited.
    #[cfg(test)]
    pub(crate) fn host_signal(&self, connection: ConnectionId, raw: &Value) -> BoxFuture<'static, Result<(), String>> {
        let signal = DesktopSignal::parse(raw).expect("a recorded host signal");
        LiveEnv(Arc::downgrade(&self.inner)).send_signal(&connection.0.to_string(), &signal)
    }
}

impl ConnectionOwner for LiveViewService {
    /// Node keeps a departed phone's subscriptions until the next frame of their session finds it gone, or they lapse
    /// (`isLive`, `remote-relay.ts:361`); its screen `ready`s still resolving are cancelled now.
    fn connection_closed(&self, connection: ConnectionId) {
        let client = connection.0.to_string();
        if let Some(screens) = self.inner.screens.get() {
            screens.withdraw(connection, ScreenEnd::ViewerLeft);
        }
        if self.inner.streams().subscribes_any(&client) {
            lock(&self.inner.state).closed.insert(connection.0);
        }
        self.inner.relay().connection_removed(&client);
    }
}

#[cfg(test)]
mod tests {
    //! The service end to end against Node's recorded host scenarios (`fixtures/live-view-host`):
    //! a phone's `browser/stream` and `browser/webrtcSignal` calls, the host's `host/browser/page`
    //! and X17 pictures, and the peers' events drive the relay, host and viewer, and what reaches the
    //! phones (the `browser/webrtcSignal` pushes), the peers and the settled calls must equal what
    //! Node recorded. The peers are scripted; the ICE servers come from the relay in the core and
    //! from the test in Node's recording, so they are not compared.

    use std::time::Duration;

    use mixdog_app_protocol::media::MediaFormat;
    use mixdog_app_protocol::media::MediaPurpose;
    use mixdog_core_api::HostMediaSink;
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::ConnectionNotifier;
    use mixdog_protocol::Origin;
    use mixdog_remote::access::runtime::LegLink;
    use mixdog_remote::access::runtime::RemoteEvents;
    use mixdog_remote::access::runtime::RuntimeConfig;
    use mixdog_remote::access::settings::AccessSettings;
    use mixdog_remote::bridge::DialError;
    use mixdog_remote::bridge::Dialer;
    use mixdog_remote::bridge::Upstream;
    use mixdog_remote::pair_code::PairCodeEffects;
    use mixdog_remote::pair_code::PairCodeView;
    use mixdog_remote::registry::DeviceRegistry;
    use mixdog_remote::section::RemoteSection;
    use mixdog_remote::section::RemoteSectionValue;
    use mixdog_remote::webrtc::signal::candidate_json;
    use mixdog_remote::webrtc::signal::parse_candidate;
    use tokio::sync::mpsc;

    use super::*;

    const HOST: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/live-view-host/host.json");

    /// A phone's stream options in the host scenarios (Node's host recording starts from a streamed page, whatever its size).
    fn stream_options() -> Value {
        json!({ "maxWidth": 1170, "maxHeight": 2532 })
    }

    struct Desktop(Mutex<Vec<(String, Value)>>);

    #[async_trait]
    impl HostChannel for Desktop {
        async fn request(&self, _capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            lock(&self.0).push((method.as_str().to_owned(), params));
            Ok(json!({}))
        }

        fn notify(&self, _capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
            lock(&self.0).push((method.as_str().to_owned(), params));
            Ok(())
        }
    }

    struct Phones(mpsc::UnboundedSender<(u64, Value)>);

    impl ConnectionNotifier for Phones {
        fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
            assert_eq!(method.as_str(), "browser/webrtcSignal");
            self.0.send((to.0, params["signal"].clone())).unwrap();
            Ok(())
        }
    }

    #[derive(Default)]
    pub(super) struct Scripted {
        log: Mutex<Vec<Value>>,
        logged: tokio::sync::Notify,
        events: Mutex<HashMap<String, Box<dyn Fn(SenderEvent) + Send + Sync>>>,
        ids: AtomicU64,
    }

    impl Scripted {
        fn record(&self, command: Value) {
            lock(&self.log).push(command);
            self.logged.notify_waiters();
        }

        /// A step's effects run on the host's own tasks; the next step starts once the recorded commands
        /// of this one have all reached the peers, as Node's microtasks had settled them.
        async fn until_logged(&self, count: usize) {
            loop {
                let arrived = self.logged.notified();
                tokio::pin!(arrived);
                arrived.as_mut().enable();
                if lock(&self.log).len() >= count {
                    return;
                }
                mixdog_rt::time::timeout(Duration::from_secs(10), arrived).await.unwrap_or_else(|_| panic!("a peer command never arrived"));
            }
        }
    }

    impl Peers for Scripted {
        fn new_connection_id(&self) -> String {
            format!("connection-id-{:04}", self.ids.fetch_add(1, Ordering::Relaxed) + 1)
        }

        fn open(&self, connection_id: &str, _ice: &[IceServer], receive_codecs: &[String], _source: Arc<SharedSource>, events: Box<dyn Fn(SenderEvent) + Send + Sync>) -> Result<(), String> {
            lock(&self.events).insert(connection_id.to_owned(), events);
            self.record(json!({ "type": "open", "connectionId": connection_id, "receiveCodecs": receive_codecs }));
            Ok(())
        }

        fn answer(&self, connection_id: &str, sdp: &str) {
            self.record(json!({ "type": "answer", "connectionId": connection_id, "sdp": sdp }));
        }

        fn candidate(&self, connection_id: &str, candidate: &Option<mixdog_remote::webrtc::config::Candidate>) {
            self.record(json!({ "type": "candidate", "connectionId": connection_id, "candidate": candidate_json(candidate) }));
        }

        fn channel_send(&self, connection_id: &str, text: &str) {
            self.record(json!({ "type": "channel-send", "connectionId": connection_id, "text": text }));
        }

        fn close(&self, connection_id: &str) {
            self.record(json!({ "type": "close", "connectionId": connection_id }));
        }
    }

    struct NoDial;

    #[async_trait]
    impl Dialer for NoDial {
        async fn dial(&self, _peer: &str) -> Result<Box<dyn Upstream>, DialError> {
            Err(DialError)
        }
    }

    struct Quiet;

    impl RemoteEvents for Quiet {
        fn controller_key_delivered(&self, _: &str) {}
        fn owed_access_changed(&self) {}
        fn status(&self, _: Value) {}
    }

    impl PairCodeEffects for Quiet {
        fn send(&mut self, _: Value) -> bool {
            false
        }
        fn publish(&mut self, _: Option<&PairCodeView>) {}
        fn wake_at(&mut self, _: u64) {}
    }

    pub(super) fn runtime(dir: &std::path::Path) -> Arc<RemoteRuntime> {
        Arc::new(RemoteRuntime::new(
            RuntimeConfig {
                dir: dir.to_path_buf(),
                relay_url: None,
                app_version: None,
                durability: mixdog_rt::testing::tokens().durability_io,
                dialer: Arc::new(NoDial),
                registry: Arc::new(DeviceRegistry::default()),
                section: Arc::new(RemoteSection::new(Arc::new(mixdog_core_api::mock::MockStatePublisher::default()), RemoteSectionValue::default())),
                settings: Arc::new(AccessSettings::new(dir.to_path_buf(), Arc::new(|| "PC".to_owned()))),
                link: LegLink::default(),
                events: Arc::new(Quiet),
            },
            Box::new(|_| Box::new(Quiet)),
        ))
    }

    fn connection_of(client: &str) -> u64 {
        match client {
            "client_A" => 1,
            "client_B" => 2,
            other => panic!("unmapped client {other}"),
        }
    }

    fn request(connection: u64, method: &'static str, params: Value) -> CoreRequest {
        CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Relay, tokio_util::sync::CancellationToken::new()) }
    }

    /// Without what differs by design: the ICE servers (the relay's in the core, the test's in Node's recording).
    fn without_ice(mut value: Value) -> Value {
        if let Some(object) = value.as_object_mut() {
            object.remove("iceServers");
            object.remove("sourceKey");
            object.remove("iceTransportPolicy");
        }
        value
    }

    fn sender_event(event: &Value) -> Option<SenderEvent> {
        let id = || event["connectionId"].as_str().unwrap().to_owned();
        Some(match event["type"].as_str().unwrap() {
            "offer" => SenderEvent::Offer { connection_id: id(), sdp: event["sdp"].as_str().unwrap().to_owned() },
            "candidate" => SenderEvent::Candidate { connection_id: id(), candidate: parse_candidate(&event["candidate"]).unwrap() },
            "connected" => SenderEvent::Connected { connection_id: id(), certificate: Some(event["remoteCertificate"].clone()).filter(|c| !c.is_null()) },
            "frame-done" => return None,
            other => panic!("unmapped sender event {other}"),
        })
    }

    /// The scenarios whose steps map one to one onto the service: no settlement of a pending host call, no timer, and the page is there before a viewer.
    const REPLAYED: [&str; 6] = [
        "negotiation: offer, answer, candidates both ways, DTLS",
        "the viewer leaves: stopped, closed, its connection ended",
        "a sender that is gone fails every live connection",
        "a phone close that demotes sends the demote before the call settles",
        "a static page: the newest delivered picture goes again to a connection that comes up",
        "a static page: a second viewer connecting gets the newest picture too",
    ];

    async fn replay(scenario: &Value, dir: &std::path::Path) {
        let name = scenario["name"].as_str().unwrap();
        let desktop = Arc::new(Desktop(Mutex::default()));
        let (push_tx, mut pushes) = mpsc::unbounded_channel();
        let peers = Arc::new(Scripted::default());
        let media = HostMedia::new(1 << 20);
        let service = LiveViewService::with_peers(desktop.clone(), Arc::new(Phones(push_tx)), media.clone(), runtime(dir), peers.clone(), Arc::new(PairedScreenAccess::new(Arc::new(|_| None), Arc::new(|_| false), Arc::new(|_| true))));
        let session = "sess_1";
        for connection in [1, 2] {
            service.call(request(connection, "browser/stream", json!({ "sessionId": session, "on": true, "request": stream_options() }))).await.unwrap();
        }
        // Node tells the desktop at every subscription (`remote-browser-streams.ts` `subscribe`), each time with the session's stream.
        let started = lock(&desktop.0).clone();
        assert_eq!(started.len(), 2, "{name}: one view request per subscription");
        for (method, params) in &started {
            assert_eq!((method.as_str(), &params["tabId"], &params["on"], &params["streamId"]), ("host/browser/viewFrames", &json!(session), &json!(true), &json!(1)));
        }
        let mut states: Vec<String> = Vec::new();
        for (number, (step, want)) in scenario["steps"].as_array().unwrap().iter().zip(scenario["recorded"].as_array().unwrap()).enumerate() {
            let what = format!("{name} step {number} {}", step["op"]);
            let logged = lock(&peers.log).len();
            match step["op"].as_str().unwrap() {
                "page" => {
                    let params = json!({ "tabId": session, "documentId": step["documentId"], "geometry": step["geometry"] });
                    service.notify(Method("host/browser/page"), params, ConnectionId(99));
                }
                "signal" => {
                    let connection = connection_of(step["client"].as_str().unwrap());
                    let outcome = service.call(request(connection, "browser/webrtcSignal", json!({ "signal": step["raw"] }))).await;
                    states.push(match outcome {
                        Ok(_) => "ok".to_owned(),
                        Err(CoreError::DomainError { message, .. }) => format!("threw:{}", message.unwrap_or_default()),
                        Err(other) => panic!("{what}: {other:?}"),
                    });
                }
                "sender" => {
                    if let Some(event) = sender_event(&step["event"]) {
                        service.inner.host().sender_event(event);
                    }
                }
                "senderGone" => service.inner.host().sender_event(SenderEvent::Gone),
                "viewerLeft" => {
                    let connection = connection_of(step["client"].as_str().unwrap());
                    service.call(request(connection, "browser/stream", json!({ "sessionId": session, "on": false }))).await.unwrap();
                    // The phone streams again (the second connection keeps the stream alive meanwhile).
                    service.call(request(connection, "browser/stream", json!({ "sessionId": session, "on": true, "request": stream_options() }))).await.unwrap();
                }
                "frame" => {
                    let geometry = &step["picture"]["geometry"];
                    let stream_id = lock(&service.inner.state).streams[session].stream_id;
                    let header = MediaFrameHeader {
                        purpose: MediaPurpose::BrowserView,
                        flags: 0,
                        stream_id,
                        width: geometry["pixelWidth"].as_u64().unwrap() as u16,
                        height: geometry["pixelHeight"].as_u64().unwrap() as u16,
                        format: MediaFormat::Jpeg,
                    };
                    let mut frame = header.encode().to_vec();
                    frame.extend_from_slice(step["picture"]["data"].as_str().unwrap().as_bytes());
                    media.frame(ConnectionId(0), Bytes::from(frame));
                }
                other => panic!("{what}: unmapped op {other}"),
            }
            let trace = want["trace"].as_array().unwrap();
            let expected_pushes: Vec<(u64, Value)> = trace
                .iter()
                .filter(|entry| entry[0] == "sendSignal")
                .map(|entry| (connection_of(entry[1].as_str().unwrap()), without_ice(entry[2].clone())))
                .collect();
            let mut got_pushes = Vec::new();
            for _ in 0..expected_pushes.len() {
                let (to, signal) = mixdog_rt::time::timeout(Duration::from_secs(10), pushes.recv()).await.unwrap_or_else(|_| panic!("{what}: a signal never reached its phone")).unwrap();
                got_pushes.push((to, without_ice(signal)));
            }
            // Each phone has its own delivery lane, so the order between two phones is not a contract; each phone's own order is.
            let per_phone = |pushes: Vec<(u64, Value)>| {
                let mut lanes: std::collections::BTreeMap<u64, Vec<Value>> = std::collections::BTreeMap::new();
                for (phone, signal) in pushes {
                    lanes.entry(phone).or_default().push(signal);
                }
                lanes
            };
            assert_eq!(per_phone(got_pushes), per_phone(expected_pushes), "{what}: signals to the phones");
            assert!(pushes.try_recv().is_err(), "{what}: no signal beyond the recorded ones");
            let expected_commands: Vec<Value> = trace
                .iter()
                .filter(|entry| entry[0] == "sender" && entry[1]["type"] != "frame")
                .map(|entry| without_ice(entry[1].clone()))
                .collect();
            peers.until_logged(logged + expected_commands.len()).await;
            let got_commands: Vec<Value> = lock(&peers.log)[logged..].iter().cloned().map(without_ice).collect();
            assert_eq!(got_commands, expected_commands, "{what}: peer commands");
            if step["op"] == "signal" {
                assert_eq!(json!(states), want["signals"], "{what}: settled calls");
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_service_serves_nodes_recorded_host_scenarios_end_to_end() {
        mixdog_rt::testing::tokens();
        let recorded: Value = serde_json::from_str(&HOST).unwrap();
        let scenarios = recorded["scenarios"].as_array().unwrap();
        let dir = tempfile::tempdir().unwrap();
        for name in REPLAYED {
            let scenario = scenarios.iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no recorded scenario {name}"));
            replay(scenario, dir.path()).await;
        }
    }
}

#[cfg(test)]
#[path = "live_view_streams_replay.rs"]
mod streams_replay;
