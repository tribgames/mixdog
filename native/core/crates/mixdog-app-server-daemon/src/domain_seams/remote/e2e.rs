#[path = "../../../../mixdog-remote/tests/it/common/mod.rs"]
mod common;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server::AppServer;
use mixdog_app_server::HostMedia;
use mixdog_app_server::Outgoing;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Incoming;
use mixdog_app_server_transport::SocketClosed;
use mixdog_app_server_transport::SocketRead;
use mixdog_app_server_transport::SocketWrite;
use mixdog_core_api::ConnectionNotifier;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::feed::FeedSource;
use mixdog_core_api::handle::CoreHandle;
use mixdog_core_api::handle::CoreState;
use mixdog_core_api::handle::RequestGuard;
use mixdog_core_api::host::HostMediaSink;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::ops::OpIndex;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_core_api::thread::ThreadDirectory;
use mixdog_core_domains::notify::screen::ScreenSessions;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::Origin;
use mixdog_protocol::SectionName;
use mixdog_remote::access::RemoteRuntime;
use mixdog_remote::e2ee::ClientHandshakeOptions;
use mixdog_remote::e2ee::Sealed;
use mixdog_remote::e2ee::ServerIdentity;
use mixdog_remote::e2ee::create_client_handshake;
use mixdog_remote::identity::load_or_create_e2ee_identity;
use mixdog_remote::registry::DeviceRegistry;
use mixdog_remote::registry::LinkKind;
use mixdog_remote::registry::LocalKind;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::watch;

use super::LateDialer;
use super::LatePublisher;
use super::RemoteInputs;
use super::build_remote;
use super::phone_credential;
use super::register_local;
use super::start_remote;
use crate::connection_close::ConnectionOwner;
use crate::connection_close::ConnectionOwners;
use crate::live_view::LiveViewService;
use crate::live_view::PairedScreenAccess;
use crate::live_view::PhoneScreens;
use crate::live_view::ScreenEnd;
use common::Event;
use common::LegEnd;
use common::Phone;
use common::Relay;
use common::driven_relay_with;
use common::on_lane;
#[cfg(windows)]
use mixdog_core_api::domain::media::MediaFrameSource;
#[cfg(windows)]
use mixdog_tools::desktop::screen_source::ScreenSink;
#[cfg(windows)]
use mixdog_tools::desktop::screen_source::ScreenViewer;

const CRED: &str = "aaaaaaa1";
const OTHER_CRED: &str = "bbbbbbb2";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Publications of the core, with the latest `hostState.remoteViewing` readable by waiting.
struct Published {
    remote_viewing: watch::Sender<Vec<String>>,
}

impl StatePublisher for Published {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        if section == SectionName::HostState && key.as_deref() == Some("remoteViewing") {
            let SectionChange::Set(bytes) = &change else { panic!("remoteViewing is always a full value") };
            let value: Value = serde_json::from_slice(bytes).unwrap();
            let ids = value["sessionIds"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
            self.remote_viewing.send_replace(ids);
        }
    }
}

fn listed() -> Value {
    json!({ "threads": [{ "id": "t1", "title": "Fix the build" }] })
}

/// Every conversation exists, a project conversation of the harness folder (the catalog the grants are checked against has none to remove).
struct AllSessions(String);

fn path_of(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().to_path_buf()
}

struct ChannelRead(mpsc::UnboundedReceiver<Incoming>);

impl SocketRead for ChannelRead {
    async fn next(&mut self) -> Option<Incoming> {
        self.0.recv().await
    }
}

struct ChannelWrite(mpsc::UnboundedSender<String>);

impl SocketWrite for ChannelWrite {
    async fn text(&mut self, frame: Bytes) -> Result<(), SocketClosed> {
        self.0.send(String::from_utf8_lossy(&frame).into_owned()).map_err(|_| SocketClosed)
    }

    async fn ping(&mut self) -> Result<(), SocketClosed> {
        Ok(())
    }

    async fn close(&mut self, _code: CloseCode) -> Result<(), SocketClosed> {
        Ok(())
    }
}

/// A client of this process on the server's hub.
struct Client {
    to_server: mpsc::UnboundedSender<Incoming>,
    from_server: mpsc::UnboundedReceiver<String>,
}

/// How long a frame the server owes is waited for before the test says it never came.
const FRAME_WAIT: Duration = Duration::from_secs(10);

/// Where a test reads the frames a phone is sent.
trait Frames {
    async fn next_frame(&mut self) -> String;
}

impl Frames for Phone {
    async fn next_frame(&mut self) -> String {
        self.recv().await
    }
}

/// The clock Node's recorder started at (`record-unpair-access.mjs` `CLOCK_START`, 2031-01-01).
const DOWNLOAD_CLOCK_START: i64 = 1_924_992_000_000;

/// The frame Node's phone received for the core's wire frame, with the error code Node's frame carries.
fn node_of(wire: &Value) -> Value {
    let mut frame = wire.as_object().unwrap().clone();
    if let Some(result) = frame.shift_remove("result") {
        frame.insert("ok".to_owned(), json!(true));
        frame.insert("value".to_owned(), result);
    } else {
        let error = frame.shift_remove("error").unwrap();
        frame.insert("ok".to_owned(), json!(false));
        frame.insert("error".to_owned(), error["data"]["message"].clone());
        if let Some(code) = error["data"].get("code") {
            frame.insert("errorCode".to_owned(), code.clone());
        }
    }
    Value::Object(frame)
}

/// The core the server sees: the mock directory for threads, the production `ScreenSessions` for the phone's screen report, and the
/// registry hooks `ComposedCore` runs when a connection starts (`register_local`) and ends (`ConnectionOwners`).
/// The desktop as the live view meets it: it records what it was asked and, when a window supplies displays, answers the display list.
struct Desktop {
    asked: Mutex<Vec<String>>,
    /// How many asks reached the desktop so far, for a test to wait on.
    reached: watch::Sender<usize>,
    /// Whether a window supplies the display list. Without one an ask stays pending, as it does in Node's desktop when no window answers.
    displays: bool,
    /// What the live view told the desktop (`host/browser/viewFrames`), in order.
    notified: Mutex<Vec<(String, Value)>>,
    /// What the live view pushed to a phone's connection (frames and WebRTC signals), in order.
    pushed: Mutex<Vec<(ConnectionId, String, Value)>>,
}
impl Desktop {
    fn new(displays: bool) -> Self {
        Self { asked: Mutex::default(), reached: watch::channel(0).0, displays, notified: Mutex::default(), pushed: Mutex::default() }
    }

    /// The view requests so far, as Node's `browserRemote('stream', [sessionId, options])` (`off` is `null`).
    fn view_requests(&self) -> Vec<Value> {
        self.notified
            .lock()
            .unwrap()
            .iter()
            .map(|(method, params)| match method.as_str() {
                "host/browser/viewFrames" => {
                    json!(["request", params["tabId"], if params["on"] == json!(true) { params["request"].clone() } else { Value::Null }])
                }
                other => json!([other, params]),
            })
            .collect()
    }
}
struct DesktopScreens(Arc<Desktop>);
#[async_trait::async_trait]
impl PhoneScreens for DesktopScreens {
    async fn displays(&self) -> Result<Value, String> {
        self.0.request(HostCapability::Computer, Method("host/computer/displays"), json!({})).await.map_err(|error| format!("{error:?}"))
    }

    async fn grant(&self, _: ConnectionId) -> Result<(), String> {
        Ok(())
    }

    fn withdraw(&self, _: ConnectionId, _: ScreenEnd) {}

    #[cfg(windows)]
    fn resolve(&self, _: &str, _: ConnectionId, _: bool) -> Option<Arc<ScreenViewer>> {
        None
    }

    #[cfg(windows)]
    fn capture(&self, _: &str) -> Result<Box<dyn MediaFrameSource>, String> {
        Err("no screen session is run by this replay".to_owned())
    }

    #[cfg(windows)]
    fn attach(&self, _: Arc<dyn ScreenSink>) {}
}
/// The live view's pushes to the phones, kept by the desktop stand-in for a test to read.
struct PhonePushes(Arc<Desktop>);
impl ConnectionNotifier for PhonePushes {
    fn notify(&self, to: ConnectionId, method: Method, params: Value) -> Result<(), CoreError> {
        self.0.pushed.lock().unwrap().push((to, method.as_str().to_owned(), params));
        Ok(())
    }
}
struct Core {
    live: Arc<LiveViewService>,
    workspace: Arc<mixdog_workspace::service::WorkspaceService>,
    access: Arc<mixdog_core_domains::domains::remote_access::RemoteAccessService>,
    mock: MockCore,
    screen: Arc<ScreenSessions>,
    registry: Arc<DeviceRegistry>,
    owners: ConnectionOwners,
    closed: watch::Sender<Vec<ConnectionId>>,
}
impl CoreHandle for Core {
    fn threads(&self) -> &dyn ThreadDirectory {
        self.mock.threads()
    }

    fn app_feed(&self) -> Arc<dyn FeedSource> {
        self.mock.app_feed()
    }

    fn scoped_feed(&self, id: &FeedId) -> Option<Arc<dyn FeedSource>> {
        self.mock.scoped_feed(id)
    }

    fn ops(&self) -> &dyn OpIndex {
        self.mock.ops()
    }

    fn domain_for(&self, method: &str) -> Option<&dyn DomainService> {
        if self.live.methods().contains(&method) {
            return Some(self.live.as_ref());
        }
        if self.screen.methods().contains(&method) {
            return Some(self.screen.as_ref());
        }
        if self.workspace.methods().contains(&method) {
            return Some(self.workspace.as_ref());
        }
        if self.access.methods().contains(&method) {
            return Some(self.access.as_ref());
        }
        self.mock.domain_for(method)
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        self.mock.host_media()
    }

    fn lifecycle(&self) -> watch::Receiver<CoreState> {
        self.mock.lifecycle()
    }

    fn connection_closed(&self, connection: ConnectionId) {
        self.owners.connection_closed(connection);
        self.workspace.connection_closed(&connection);
        self.mock.connection_closed(connection);
        self.closed.send_modify(|closed| closed.push(connection));
    }

    fn connection_opened(&self, connection: ConnectionId, origin: Origin, device: &str, kind: ConnectionKind) -> String {
        self.mock.connection_opened(connection, origin, device, kind);
        register_local(&self.registry, connection, origin, device, kind)
    }

    fn request_started(&self, method: &str, params: &serde_json::Value) -> RequestGuard {
        self.mock.request_started(method, params)
    }
}
/// The core booted as `compose` and `serving::attach` boot it, with one paired device ("Pixel", `CRED`) in the relay's roster.
struct Harness {
    dir: tempfile::TempDir,
    core: Arc<Core>,
    registry: Arc<DeviceRegistry>,
    runtime: Arc<RemoteRuntime>,
    published: Arc<Published>,
    relay: Relay,
    identity: ServerIdentity,
    /// `thread/list` calls that reached the directory.
    desktop: Arc<Desktop>,
    reads: Arc<AtomicUsize>,
    /// `turn/start` params that reached the thread.
    turns: Arc<Mutex<Vec<Value>>>,
    closed: watch::Receiver<Vec<ConnectionId>>,
    /// The server's own hub and server: a client in this process attaches to them as the daemon's listeners do.
    hub: ConnectionHub,
    server: AppServer,
}
#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for AllSessions {
    async fn row(&self, _: &str) -> mixdog_workspace::error::WsResult<Option<mixdog_workspace::grants::SessionRow>> {
        Ok(Some(mixdog_workspace::grants::SessionRow { project: true, project_path: Some(self.0.clone()), cwd: self.0.clone() }))
    }

    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}
impl Client {
    /// Sends the request and returns the frame the server wrote for its id, as written.
    async fn call(&mut self, request: &Value) -> Value {
        self.to_server.send(Incoming::Text(request.to_string())).unwrap();
        loop {
            let next = mixdog_rt::time::timeout(FRAME_WAIT, self.from_server.recv()).await.expect("the server wrote no frame for the request");
            let frame: Value = serde_json::from_str(&next.expect("the server ended")).unwrap();
            if frame["id"] == request["id"] {
                return frame;
            }
        }
    }
}
/// The frame carrying `id`, with the frames for other ids that came before it. One deadline covers the whole wait: frames for other ids
/// (Node's desktop also sends a phone frames nobody asked for) neither extend it nor are lost, so a reply that never comes fails here.
async fn reply_within(from: &mut impl Frames, id: u64, within: Duration) -> (Value, Vec<Value>) {
    let mut others = Vec::new();
    let waited = mixdog_rt::time::timeout(within, async {
        loop {
            let frame: Value = serde_json::from_str(&from.next_frame().await).unwrap();
            if frame["id"] == id {
                return frame;
            }
            others.push(frame);
        }
    })
    .await;
    match waited {
        Ok(frame) => (frame, others),
        Err(_) => panic!("no frame with id {id} reached the phone within {within:?}; {} frame(s) for other ids came meanwhile", others.len()),
    }
}
async fn answer(phone: &mut Phone, id: u64) -> Value {
    reply_within(phone, id, FRAME_WAIT).await.0
}
#[tokio::test(start_paused = true)]
async fn a_reply_that_never_comes_fails_at_one_deadline_while_other_frames_keep_arriving() {
    // A phone that is sent a frame for another id every second (each one used to restart the wait). The clock is paused and moves only by
    // the `advance` calls below, so the frames and the instants are the test's, not the runtime's.
    struct Chatter(mpsc::UnboundedReceiver<String>);
    impl Frames for Chatter {
        async fn next_frame(&mut self) -> String {
            self.0.recv().await.expect("the test ended the frames before the wait failed")
        }
    }
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }
    let (send, frames) = mpsc::unbounded_channel();
    let started = tokio::time::Instant::now();
    let waiting = tokio::spawn(async move { reply_within(&mut Chatter(frames), 7, FRAME_WAIT).await });
    settle().await;
    let unrelated = || json!({ "e": "T", "s": 1 }).to_string();
    for second in 1..=9 {
        tokio::time::advance(Duration::from_secs(1)).await;
        send.send(unrelated()).unwrap();
        settle().await;
        assert!(!waiting.is_finished(), "the wait failed at {second}s, before its {FRAME_WAIT:?} deadline");
    }
    // Just before the deadline the wait is still pending, though nine frames for other ids have come.
    tokio::time::advance(FRAME_WAIT - Duration::from_secs(9) - Duration::from_millis(1)).await;
    send.send(unrelated()).unwrap();
    settle().await;
    assert_eq!(started.elapsed(), FRAME_WAIT - Duration::from_millis(1));
    assert!(!waiting.is_finished(), "the wait failed 1ms before its {FRAME_WAIT:?} deadline");
    // At the deadline it has failed, though a frame for another id had just come (a per-frame timeout would still be pending).
    tokio::time::advance(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(started.elapsed(), FRAME_WAIT);
    assert!(waiting.is_finished(), "the wait was still pending at its {FRAME_WAIT:?} deadline: a frame for another id restarted it");
    let message = *waiting.await.expect_err("the reply never came, so the wait must fail").into_panic().downcast::<String>().unwrap();
    assert!(message.contains("no frame with id 7") && message.contains("10 frame(s) for other ids"), "{message}");
}
async fn list(phone: &mut Phone, id: u64) -> Value {
    phone.send(&json!({ "id": id, "method": "thread/list", "params": {} }).to_string());
    answer(phone, id).await
}
#[tokio::test(flavor = "multi_thread")]
async fn a_paired_phone_connects_over_the_relay_lists_threads_sends_a_turn_and_is_seen_viewing() {
    let h = Harness::start(true).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;

    // The relay connection is in the registry as the paired device, not as a local client.
    let opened = h.core.mock.opened_connections();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].origin, Origin::Relay);
    let described = h.registry.describe(connection.0).expect("the relay connection is registered");
    assert_eq!((described.device.as_str(), described.credential.as_str(), described.kind), ("Pixel", CRED, LinkKind::Phone));

    // It reads the sessions and drives one.
    assert_eq!(list(&mut phone, 1).await["result"], listed());
    let turn = json!({ "threadId": "t1", "opId": "op-1", "input": { "prompt": "hello" } });
    phone.send(&json!({ "id": 2, "method": "turn/start", "params": turn }).to_string());
    let started = answer(&mut phone, 2).await;
    assert_eq!(started["result"], json!({ "kind": "started", "turnId": "turn-1" }), "{started}");
    assert_eq!(*h.turns.lock().unwrap(), [turn]);

    // What it reports of its screen is the phone's, not the desktop's, and counts as remote viewing by Node's rule.
    assert!(h.published.remote_viewing.borrow().is_empty());
    phone.send(
        &json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": ["t1"], "visualizeSessionIds": ["t1"], "foreground": true } }).to_string(),
    );
    h.viewing(&["t1"]).await;
    assert!(!h.core.screen.shows("t1"), "the phone's set is not the desktop's");
    phone.send(&json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": [], "foreground": false } }).to_string());
    h.viewing(&[]).await;
    phone.send(&json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": [], "foreground": true } }).to_string());
    h.viewing(&["t1"]).await;

    // The phone leaves: its row and what it showed go.
    phone.leave();
    h.viewing(&[]).await;
    h.closed(connection).await;
    assert!(h.registry.describe(connection.0).is_none());
    h.runtime.close().await;
}
#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_device_loses_its_access_at_once_and_its_connection_when_the_relay_ends_it() {
    let h = Harness::start(true).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    let credential_of = phone_credential(h.registry.clone());
    assert_eq!(credential_of(connection).as_deref(), Some(CRED), "a paired relay connection acts as its device (phone file grants)");
    assert_eq!(list(&mut phone, 1).await["result"], listed());

    h.runtime.revoke_client(CRED).await.unwrap();
    let revoke = h.relay.frame(|frame| frame["type"] == "revoke-client").await;
    assert_eq!(revoke["clientId"], CRED);
    // Node closes nothing itself: the relay removed the pairing, so it ends the phone's leg and reports it gone.
    phone.leave();
    h.closed(connection).await;
    assert_eq!(credential_of(connection), None, "the connection holds no grant of the device once it is unpaired");
    assert!(h.registry.describe(connection.0).is_none());

    // What the revoked phone still sends reaches nothing; another paired phone's call, sent after it, is answered.
    phone.send(&json!({ "id": 2, "method": "thread/list", "params": {} }).to_string());
    let (mut other, other_connection) = h.connect("p2", OTHER_CRED).await;
    assert_eq!(credential_of(other_connection).as_deref(), Some(OTHER_CRED));
    assert_eq!(list(&mut other, 1).await["result"], listed());
    assert_eq!(h.reads.load(Ordering::SeqCst), 2, "the revoked phone's second read never reached the directory");
    h.runtime.close().await;
}
/// One call of `phone`, as the frame Node's phone would have got, without its id.
async fn download_frame(phone: &mut Phone, id: u64, method: &str, params: Value) -> Value {
    phone.send(&json!({ "id": id, "method": method, "params": params }).to_string());
    let mut frame = node_of(&answer(phone, id).await);
    frame.as_object_mut().unwrap().shift_remove("id");
    frame
}

/// The display list a window supplies the desktop with.
fn displays() -> Value {
    json!([{ "id": "display-1", "label": "Display 1", "primary": true, "width": 1920, "height": 1080 }])
}

#[async_trait::async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, _params: Value) -> Result<Value, HostError> {
        self.asked.lock().unwrap().push(method.as_str().to_owned());
        // Counted under the channel's own lock: two asks at once each published the length they saw, and the later
        // publication could be the smaller one, leaving the count one short for good.
        self.reached.send_modify(|reached| *reached += 1);
        if !self.displays {
            std::future::pending::<()>().await;
        }
        Ok(displays())
    }

    fn notify(&self, _capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        self.notified.lock().unwrap().push((method.as_str().to_owned(), params));
        Ok(())
    }
}
#[allow(
    clippy::disallowed_methods,
    reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
)]
fn identity_in(path: std::path::PathBuf) -> ServerIdentity {
    std::fs::create_dir_all(&path).unwrap();
    on_lane(move |lane| load_or_create_e2ee_identity(lane, &path).unwrap())
}
impl Harness {
    /// `revoke_ok`: whether the relay confirms an unpair. A window supplies the display list.
    async fn start(revoke_ok: bool) -> Self {
        Self::start_with(revoke_ok, true).await
    }

    /// [`Harness::start`] where `displays` says whether a window supplies the display list.
    #[allow(
        clippy::disallowed_methods,
        reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
    )]
    async fn start_with(revoke_ok: bool, displays: bool) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        // The downloads' clock is the file `talk/clock` (a build with `replay-controls`, told its folder), read when the workspace is made.
        // The replay controls name their folder once for the process (every scenario of a test shares it), so the folder outlives a harness.
        static TALK: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        let talk = TALK.get_or_init(|| {
            let folder = tempfile::tempdir().unwrap();
            let talk = folder.path().to_path_buf();
            std::mem::forget(folder);
            // SAFETY: set before the first workspace is made; each test of this module is a process of its own under nextest.
            unsafe { std::env::set_var("MIXDOG_DOWNLOAD_REPLAY_DIR", &talk) };
            talk
        });
        let wall = talk.join("clock");
        std::fs::write(&wall, DOWNLOAD_CLOCK_START.to_string()).unwrap();
        let path = dir.path().to_path_buf();
        // A migrated install with activation in config and no native stamp or relay device file.
        let identity = identity_in(path.clone());
        let mut relay = driven_relay_with(json!([{ "id": CRED, "name": "Pixel", "browser": "Chrome" }]), revoke_ok).await;

        // The wiring `compose` and `serving::attach` do, in their order.
        let (remote_viewing, _) = watch::channel(Vec::new());
        let published = Arc::new(Published { remote_viewing });
        let late_publisher = Arc::new(LatePublisher::default());
        let late_dialer = Arc::new(LateDialer::default());
        let remote = build_remote(RemoteInputs {
            dir: path,
            migrated_activation: true,
            relay_env: Some(format!("ws://127.0.0.1:{}", relay.port)),
            app_version: (VERSION.to_owned(), None),
            durability: tokens.durability_io,
            dialer: late_dialer.clone(),
            publisher: late_publisher.clone(),
        })
        .unwrap();
        late_publisher.bind(published.clone());
        let mock = MockCore::new(&[], MockLimits::default());
        let reads = Arc::new(AtomicUsize::new(0));
        let turns: Arc<Mutex<Vec<Value>>> = Arc::default();
        let thread = mock.directory().insert(ThreadId::from("t1"));
        {
            let turns = turns.clone();
            thread.set_handler(Arc::new(move |request: &CoreRequest| {
                turns.lock().unwrap().push(request.params.clone());
                Ok(Reply::Value(json!({ "kind": "started", "turnId": "turn-1" })))
            }));
        }
        {
            let reads = reads.clone();
            mock.directory().set_handler(Arc::new(move |_| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(Reply::Value(listed()))
            }));
        }
        // The services that hold a device's state, built as `compose_flip` builds them and bound to the unpair the way it binds them.
        let (config, _) = mixdog_core_config::config::Config::open(
            path_of(&dir).join("mixdog-config.json"),
            published.clone(),
            mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        )
        .await
        .unwrap();
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &path_of(&dir).join("core.sqlite")).unwrap();
        let workspace = mixdog_workspace::service::WorkspaceService::new(mixdog_workspace::service::Deps {
            lanes: mixdog_workspace::lanes::Lanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                cpu_bulk: tokens.cpu_bulk,
            },
            feeds: Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(MockLimits::default())),
            processes: Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default()),
            tracked: Arc::new(mixdog_scm::tracked::GixTrackedFiles::new(tokens.maintenance_io)),
            state,
            recovery_dir: path_of(&dir).join("recovery"),
            user_data_dir: path_of(&dir).join("userData"),
            sources: Vec::new(),
            code_graph: None,
            turn_review: None,
            releases: mixdog_workspace::release::FolderReleases::new(),
            upload_chunk_bytes: mixdog_app_protocol::limits::Limits::default().max_blob_put_chunk_bytes,
        })
        .unwrap();
        let grants = Arc::new(mixdog_workspace::grants::GrantStore::new(
            Arc::new(mixdog_workspace::transfer::SystemClock),
            Arc::new(AllSessions(dir.path().to_string_lossy().into_owned())),
        ));
        workspace.set_phone_grants(grants.clone(), phone_credential(remote.registry.clone()));
        let live_view_slot: Arc<std::sync::OnceLock<std::sync::Weak<LiveViewService>>> = Arc::default();
        remote
            .events
            .bind(Arc::new(super::PairedDeviceCleanup {
                grants,
                registry: remote.registry.clone(),
                end_transfers: {
                    let workspace = workspace.clone();
                    Arc::new(move |owner| workspace.revoke_device(owner))
                },
                end_downloads: {
                    let workspace = workspace.clone();
                    Arc::new(move || workspace.revoke_all_downloads())
                },
                config: config.clone(),
                live_view: live_view_slot.clone(),
            }))
            .unwrap();
        let access = Arc::new(mixdog_core_domains::domains::remote_access::RemoteAccessService::new(
            remote.runtime.clone(),
            remote.registry.clone(),
            mixdog_core_base::support::testing::scopes(&path_of(&dir), "remoteAccess").await,
        ));
        let screen = Arc::new(ScreenSessions::new(remote.registry.clone()));
        let owners = ConnectionOwners::of(vec![screen.clone() as Arc<dyn ConnectionOwner>, remote.registry.clone()]);
        let (closed_tx, closed) = watch::channel(Vec::new());
        // The live view as `compose_flip` registers it: the same access rule over the same registry.
        let desktop = Arc::new(Desktop::new(displays));
        let live = Arc::new(LiveViewService::new(
            desktop.clone(),
            Arc::new(PhonePushes(desktop.clone())),
            HostMedia::new(1 << 20),
            remote.runtime.clone(),
            tokens.media_thread,
            Arc::new(PairedScreenAccess::new(
                phone_credential(remote.registry.clone()),
                super::screen_revoked(remote.registry.clone()),
                super::peer_attached(remote.registry.clone()),
            )),
        ));
        let _ = live_view_slot.set(Arc::downgrade(&live));
        assert!(live.bind_screens(Arc::new(DesktopScreens(desktop.clone()))).is_ok(), "the screens are bound once");
        let core = Arc::new(Core { live, workspace, access, mock, screen, registry: remote.registry.clone(), owners, closed: closed_tx });
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let origins = hub.clone();
        let own_hub = hub.clone();
        let server = AppServer::new(
            core.clone(),
            Outgoing::new(),
            Arc::new(move |id| origins.origin_of(id)),
            crate::server::server_config(Limits::default(), Default::default()),
        )
        .unwrap();
        let own_server = server.clone();
        late_dialer.bind(hub, Arc::new(move |accepted| crate::server::spawn_drive(server.clone(), accepted)), remote.registry.clone()).unwrap();
        start_remote(&remote, published.clone()).await;

        // The relay answers the boot's leg, the roster names the paired device.
        relay.legs.recv().await.expect("the relay ended");
        remote.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
        remote.runtime.list_clients().await.unwrap();
        Self {
            dir,
            core,
            registry: remote.registry,
            runtime: remote.runtime,
            published,
            relay,
            identity,
            desktop,
            reads,
            turns,
            closed,
            hub: own_hub,
            server: own_server,
        }
    }

    /// The phone `id` of `credential` pairs and states who it is; the connection the core opened for it.
    async fn connect(&self, id: &str, credential: &str) -> (Phone, ConnectionId) {
        let mut phone = self.relay.pair_phone(&self.identity, id, credential).await;
        phone.send(
            &json!({ "id": 0, "method": "initialize", "params": {
                "clientInfo": { "name": "mixdog-phone", "title": "Mixdog Phone", "version": VERSION, "kind": "phone" }, "capabilities": {},
            } })
            .to_string(),
        );
        let initialized = answer(&mut phone, 0).await;
        assert!(initialized.get("result").is_some(), "{initialized}");
        assert_eq!(initialized["result"]["connection"]["origin"], "relay");
        let opened = self.core.mock.opened_connections();
        let connection = opened.last().expect("the core opened a connection").connection;
        // The reply names the phone as its prompts are stamped: the paired device, not the title its client stated.
        let paired = self.registry.describe(connection.0).expect("the paired phone is described").device;
        assert_ne!(paired, "Mixdog Phone");
        assert_eq!(initialized["result"]["connection"]["device"], json!(paired));
        (phone, connection)
    }

    /// A connection the server's hub holds for a client of this process, of `origin` and stated `kind`, named `Pixel`; what the server
    /// writes to it is what the client reads.
    async fn client(&self, origin: ConnectionOrigin, kind: &str) -> Client {
        let (to_server, read) = mpsc::unbounded_channel();
        let (write, from_server) = mpsc::unbounded_channel();
        let accepted = self.hub.attach(origin, ChannelRead(read), ChannelWrite(write)).unwrap();
        crate::server::spawn_drive(self.server.clone(), accepted);
        let mut client = Client { to_server, from_server };
        let initialized = client
            .call(&json!({ "id": 0, "method": "initialize", "params": { "clientInfo": { "name": "Pixel", "version": VERSION, "kind": kind }, "capabilities": {} } }))
            .await;
        assert!(initialized.get("result").is_some(), "{initialized}");
        client
    }

    async fn closed(&self, connection: ConnectionId) {
        let mut seen = self.closed.clone();
        let got = mixdog_rt::time::timeout(FRAME_WAIT, seen.wait_for(|closed| closed.contains(&connection))).await;
        got.unwrap_or_else(|_| panic!("connection {connection:?} was never closed")).expect("the core ended");
    }

    async fn viewing(&self, wanted: &[&str]) {
        let wanted: Vec<String> = wanted.iter().map(|id| (*id).to_owned()).collect();
        let mut seen = self.published.remote_viewing.subscribe();
        let got = mixdog_rt::time::timeout(FRAME_WAIT, seen.wait_for(|ids| *ids == wanted)).await;
        got.unwrap_or_else(|_| panic!("the viewed sessions never became {wanted:?}")).expect("the publisher ended");
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_peer_is_refused_before_any_session_read_or_turn() {
    let h = Harness::start(true).await;
    let strangers = identity_in(h.dir.path().join("stranger"));

    // Without the pairing key nothing it sends is an application frame: the first frame must be the hello, and anything else
    // is dropped, not answered and not forwarded.
    let plain = h.relay.open_peer("u1", OTHER_CRED);
    plain.challenge().await;
    plain.send_frame(
        &json!({ "id": 0, "method": "initialize", "params": { "clientInfo": { "name": "x", "version": "1", "kind": "phone" }, "capabilities": {} } })
            .to_string(),
    );
    plain.send_frame(&json!({ "id": 1, "method": "thread/list", "params": {} }).to_string());
    plain.send_frame(&json!({ "id": 2, "method": "turn/start", "params": { "threadId": "t1", "opId": "op-x", "input": { "prompt": "hi" } } }).to_string());

    // A peer that completes the handshake with another key than this PC's is closed.
    let forger = h.relay.open_peer("u2", OTHER_CRED);
    let challenge = forger.challenge().await;
    let (hello, mut channel) = create_client_handshake(&strangers.pairing(), &challenge, ClientHandshakeOptions::default()).unwrap();
    forger.send_frame(&hello.to_string());
    let Event::Closed(reason) = forger.next().await else { panic!("the PC answered a forged handshake") };
    assert_eq!(reason, "relay encryption authentication failed");
    // And whatever it seals with the channel it made itself reaches nothing.
    let Sealed::Text(boxed) = channel.seal(json!({ "id": 3, "method": "thread/list", "params": {} }).to_string().as_bytes(), false).unwrap() else {
        panic!("text carrier")
    };
    forger.send_frame(&boxed);

    // The runtime takes the relay's events in order: a paired phone that completes after them proves they were all handled.
    let (mut phone, _) = h.connect("p1", CRED).await;
    assert_eq!(list(&mut phone, 1).await["result"], listed());
    assert_eq!(plain.arrived().await, 0, "an unauthenticated peer is never answered");
    assert_eq!(forger.arrived().await, 0, "a forged handshake is closed once and never answered");
    assert_eq!(h.core.mock.opened_connections().len(), 1, "only the paired phone has a connection in the core");
    assert_eq!(h.reads.load(Ordering::SeqCst), 1, "only the paired phone read the sessions");
    assert!(h.turns.lock().unwrap().is_empty(), "no turn was started");
    h.runtime.close().await;
}
#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_or_the_relay_closing_ends_the_phones_browser_stream_at_once() {
    let request = json!({ "maxWidth": 800, "maxHeight": 600 });
    let want = vec![json!(["request", "sess_1", request]), json!(["request", "sess_1", null])];
    let call = json!({ "id": 5, "method": "browser/stream", "params": { "sessionId": "sess_1", "on": true, "request": request } });

    let h = Harness::start(false).await;
    let (mut phone, _) = h.connect("p1", CRED).await;
    phone.send(&call.to_string());
    assert_eq!(answer(&mut phone, 5).await["result"], json!({}), "the subscribe");
    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    assert_eq!(h.desktop.view_requests(), want, "the unpair ended the stream");
    h.runtime.close().await;

    let h = Harness::start(true).await;
    let (mut phone, _) = h.connect("p1", CRED).await;
    phone.send(&call.to_string());
    assert_eq!(answer(&mut phone, 5).await["result"], json!({}), "the subscribe");
    h.runtime.close().await;
    assert_eq!(h.desktop.view_requests(), want, "the relay's close ended the stream");
}
/// An unpair the relay refuses closes the device's phone at once and refuses its next connection, and nothing is shown to it on any
/// live-view path: not the host's signal on its way at the unpair, not what the closed phone still asks for.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpaired_device_is_closed_and_shown_nothing_on_any_live_view_path() {
    let request = json!({ "maxWidth": 1200, "maxHeight": 900 });
    let offer = json!({
        "v": 1, "source": { "kind": "browser", "sessionId": "sess_1" }, "connectionId": "connection-id-0001", "generation": 1, "type": "offer",
        "sdp": "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 01:08:0F:16:1D:24:2B:32:39:40:47:4E:55:5C:63:6A:71:78:7F:86:8D:94:9B:A2:A9:B0:B7:BE:C5:CC:D3:DA\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
        "fingerprints": [{ "algorithm": "sha-256", "value": "01:08:0F:16:1D:24:2B:32:39:40:47:4E:55:5C:63:6A:71:78:7F:86:8D:94:9B:A2:A9:B0:B7:BE:C5:CC:D3:DA" }],
        "iceServers": [], "iceTransportPolicy": "all",
        "geometry": { "generation": 1, "cssWidth": 390, "cssHeight": 844, "deviceScaleFactor": 3, "pixelWidth": 1170, "pixelHeight": 2532 }, "inputEpoch": 1
    });
    let ready = json!({ "v": 1, "source": { "kind": "browser", "sessionId": "sess_1" }, "type": "ready", "receiveCodecs": ["video/VP8", "video/H264"] });
    let stream = |id: u64| json!({ "id": id, "method": "browser/stream", "params": { "sessionId": "sess_1", "on": true, "request": request } });
    let nothing = Vec::<(ConnectionId, String, Value)>::new();

    let h = Harness::start(false).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    phone.send(&stream(5).to_string());
    assert_eq!(answer(&mut phone, 5).await["result"], json!({}), "the subscribe");
    // The host's signal to the phone, on its way when the unpair comes.
    let pending = h.core.live.host_signal(connection, &offer);
    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    assert_eq!(pending.await, Ok(()), "the host's send succeeds, as Node's resolves");
    assert_eq!(*h.desktop.pushed.lock().unwrap(), nothing, "nothing reached the unpaired phone");
    let ended = h.desktop.view_requests();
    assert_eq!(ended, vec![json!(["request", "sess_1", request]), json!(["request", "sess_1", null])], "the unpair ended the stream");

    assert_eq!(phone.closed().await, "relay encryption authentication failed", "the desktop closed the phone itself");
    h.closed(connection).await;
    // What the closed phone still asks for reaches no live view.
    phone.send(&stream(6).to_string());
    phone.send(&json!({ "id": 7, "method": "browser/webrtcSignal", "params": { "signal": ready } }).to_string());

    // The device's next connection is refused at the open. The relay's events are handled in order, so the refusal also follows the
    // closed phone's frames.
    let again = h.relay.open_peer("p2", CRED);
    let Event::Closed(reason) = again.next().await else { panic!("the PC challenged the unpaired device's next connection") };
    assert_eq!(reason, "relay encryption authentication failed");
    assert_eq!(h.desktop.view_requests(), ended, "no stream was asked for the device again");
    assert_eq!(*h.desktop.pushed.lock().unwrap(), nothing, "nothing reached the unpaired device");
    h.runtime.close().await;
}
#[tokio::test(flavor = "multi_thread")]
async fn a_local_client_naming_itself_after_a_paired_device_gets_no_grant_and_no_view() {
    let h = Harness::start(true).await;
    let (_phone, phone_connection) = h.connect("p1", CRED).await;
    let credential_of = phone_credential(h.registry.clone());
    assert_eq!(credential_of(phone_connection).as_deref(), Some(CRED));

    // A local client says it is "Pixel": it is recorded as itself, with no credential.
    let named = ConnectionId(9001);
    h.core.connection_opened(named, Origin::Local, "Pixel", ConnectionKind::Cli);
    let described = h.registry.describe(named.0).expect("a local client is recorded under what it stated");
    assert_eq!((described.device.as_str(), described.kind), ("Pixel", LinkKind::Local(LocalKind::Cli)));
    assert_eq!(credential_of(named), None);
    // Claiming to be a phone, or a remote desktop, or arriving as a relay or SSH connection, records no paired device either.
    for (id, origin, kind) in [
        (9002, Origin::Local, ConnectionKind::Phone),
        (9003, Origin::Local, ConnectionKind::RemoteDesktop),
        (9004, Origin::Relay, ConnectionKind::Phone),
        (9005, Origin::Ssh, ConnectionKind::Phone),
    ] {
        h.core.connection_opened(ConnectionId(id), origin, "Pixel", kind);
        assert_eq!(credential_of(ConnectionId(id)), None, "{origin:?} {kind:?}");
    }

    // Its screen report is the desktop's own set, never a phone viewing a panel.
    h.core.screen.notify(Method("ui/screenSessions/changed"), json!({ "sessionIds": ["t1"], "visualizeSessionIds": ["t1"], "foreground": true }), named);
    assert!(h.core.screen.shows("t1"));
    assert!(h.registry.visualize_viewed_sessions().is_empty(), "no paired device views anything");
    h.runtime.close().await;
}
/// The leg is dropped, the next two dials fail and the third opens a leg: the delay doubles while redials fail.
fn ladder() -> Value {
    json!([{ "op": "drop", "code": null, "delayMs": 1000 }, { "op": "fail", "delayMs": 2000 }, { "op": "fail", "delayMs": 4000 }, { "op": "recover" }])
}

/// The relay closes the leg with the stalled-handshake code (4010) three times: the first two are redialed at once, the third waits the backoff.
fn stalled() -> Value {
    json!([
        { "op": "drop", "code": 4010, "delayMs": 0 }, { "op": "recover" },
        { "op": "drop", "code": 4010, "delayMs": 0 }, { "op": "recover" },
        { "op": "drop", "code": 4010, "delayMs": 1000 }, { "op": "recover" }
    ])
}

/// Plays the `script` against the relay, which ends the leg the core holds and refuses the dials the script says fail. Each
/// step that schedules a redial must not be followed by a dial sooner than the delay the script gives. (A longer wait is not asserted
/// here; the schedule itself is asserted by `mixdog-remote`'s `relay_redial`.)
async fn follow(h: &mut Harness, script: Value) {
    let steps = script.as_array().unwrap().clone();
    let longest = steps.iter().filter_map(|step| step["delayMs"].as_u64()).max().unwrap();
    // When the dial that the next delay follows was made (the failed attempt, or the moment the leg was ended).
    let mut since = Instant::now();
    for (at, step) in steps.iter().enumerate() {
        // The dial that follows this step fails exactly when the next step is a failure.
        let refuses_next = steps.get(at + 1).is_some_and(|next| next["op"] == "fail");
        h.relay.refuse_dials.store(refuses_next, Ordering::SeqCst);
        match step["op"].as_str().unwrap() {
            "drop" => {
                since = Instant::now();
                let end = match step["code"].as_u64() {
                    None => LegEnd::Drop,
                    Some(code) => LegEnd::Close(u16::try_from(code).unwrap()),
                };
                h.relay.end_leg.send(end).unwrap();
            }
            "fail" => {}
            // The dial that opened the leg was awaited with the step before.
            "recover" => continue,
            other => panic!("the relay cannot play {other}"),
        }
        let delay = Duration::from_millis(step["delayMs"].as_u64().unwrap());
        let dialed = h.relay.legs.recv().await.expect("the relay ended");
        let waited = dialed.duration_since(since);
        assert!(waited >= delay, "step {at} ({step}): the core dialed again after {waited:?}, the script waits {delay:?}");
        if delay.is_zero() {
            // A stalled-handshake close is redialed at once: well before the backoff an ordinary drop waits.
            assert!(waited < Duration::from_millis(longest), "step {at} ({step}): {waited:?}");
        }
        since = dialed;
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn the_leg_redials_on_the_doubling_backoff_and_a_phone_pairs_again_on_the_new_leg() {
    let mut h = Harness::start(true).await;
    let (_phone, connection) = h.connect("p1", CRED).await;
    let (mut watcher, watcher_connection) = h.connect("p2", OTHER_CRED).await;
    watcher.send(
        &json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": ["t1"], "visualizeSessionIds": ["t1"], "foreground": true } }).to_string(),
    );
    h.viewing(&["t1"]).await;

    // Doubling while redials fail (1 s, 2 s, 4 s), then the leg opens: no phone survives the lost leg.
    follow(&mut h, ladder()).await;
    h.closed(connection).await;
    h.closed(watcher_connection).await;
    h.viewing(&[]).await;
    h.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    // The relay re-announces the phones on the new leg; a phone pairs again and drives the core as before.
    let (mut again, _) = h.connect("p3", CRED).await;
    assert_eq!(list(&mut again, 1).await["result"], listed());
    h.runtime.close().await;
}
/// The frame a phone gets for a download that is gone, as Node's phone got it (without its id).
fn download_gone() -> Value {
    json!({ "ok": false, "error": "This download is no longer available.", "errorCode": "file-download:expired" })
}
/// Remote access switched off closes the relay handle, and with it every download the paired phones held: a phone that pairs again once
/// remote access is back finds its unbegun grant and its transfer gone (the begin of the unbegun grant, then the range of the transfer).
#[tokio::test(flavor = "multi_thread")]
#[allow(
    clippy::disallowed_methods,
    reason = "Test-only fixture setup, source inspection or owned-file/process assertions; preserve the recorded filesystem case."
)]
async fn switching_remote_access_off_ends_every_download_of_the_phones() {
    let mut h = Harness::start(true).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    let file = h.dir.path().join("a.bin");
    std::fs::write(&file, "0123456789abcdef").unwrap();
    let authorize = json!({ "sessionId": "s1", "source": { "kind": "sessionFile", "path": file.to_string_lossy() }, "purpose": "save" });
    let unbegun = download_frame(&mut phone, 1, "transfer/authorizeRead", authorize.clone()).await["value"]["grantId"].clone();
    let grant = download_frame(&mut phone, 2, "transfer/authorizeRead", authorize).await["value"]["grantId"].clone();
    let lease = download_frame(&mut phone, 3, "transfer/redeemGrant", json!({ "grantId": grant })).await["value"].clone();
    assert!(unbegun.is_string() && lease["transferId"].is_string(), "{unbegun} {lease}");

    h.runtime.stop().await.unwrap();
    h.closed(connection).await;
    h.runtime.start(false).await.unwrap();
    mixdog_rt::time::timeout(FRAME_WAIT, h.relay.legs.recv()).await.expect("the core never dialed the relay again").expect("the relay ended");
    let mut up = h.runtime.watch_connected();
    mixdog_rt::time::timeout(FRAME_WAIT, up.wait_for(|up| *up)).await.expect("the new leg never came up").expect("the runtime ended");
    let (mut again, _) = h.connect("p2", CRED).await;
    let begin = download_frame(&mut again, 4, "transfer/redeemGrant", json!({ "grantId": unbegun })).await;
    assert_eq!(begin, download_gone(), "the unbegun grant after the relay closed");
    let range = json!({ "transferId": lease["transferId"], "offset": 0, "length": 4, "version": lease["version"] });
    let read = download_frame(&mut again, 5, "transfer/readRange", range).await;
    assert_eq!(read, download_gone(), "the transfer after the relay closed");
    h.runtime.close().await;
}
#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_handshake_close_redials_at_once_twice_and_then_waits_the_backoff() {
    let mut h = Harness::start(true).await;
    follow(&mut h, stalled()).await;
    h.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
    h.runtime.close().await;
}
/// Over its own loopback connection the method table refuses a local client the relay-only screen methods before any access rule is asked
/// (`browser/screenDisplays` is a relay method), and the desktop is never asked for its displays.
#[tokio::test(flavor = "multi_thread")]
async fn a_local_client_is_refused_the_relay_only_screen_methods_and_the_desktop_is_not_asked() {
    let h = Harness::start(true).await;
    let (_phone, _) = h.connect("p1", CRED).await;
    let mut named = h.client(ConnectionOrigin::Loopback, "cli").await;
    let call = json!({ "id": 7, "method": "browser/screenDisplays", "params": {} });
    assert_eq!(
        named.call(&call).await,
        json!({ "id": 7, "error": { "code": -32600, "message": "permissionDenied", "data": { "reason": "permissionDenied", "method": "browser/screenDisplays", "origin": "local" } } })
    );
    assert!(h.desktop.asked.lock().unwrap().is_empty(), "a refused ask never reaches the window");
    h.runtime.close().await;
}
#[test]
fn a_local_client_is_recorded_by_what_it_states_and_a_relay_or_claimed_phone_is_not() {
    let registry = DeviceRegistry::default();
    register_local(&registry, ConnectionId(1), Origin::Local, "Mixdog Desktop", ConnectionKind::Desktop);
    register_local(&registry, ConnectionId(2), Origin::Ssh, "mixdog-cli", ConnectionKind::Cli);
    register_local(&registry, ConnectionId(3), Origin::Local, "liar", ConnectionKind::Phone);
    register_local(&registry, ConnectionId(4), Origin::Relay, "Mixdog Phone", ConnectionKind::Phone);
    let kind = |connection| registry.describe(connection).map(|described| (described.device, described.kind));
    assert_eq!(kind(1), Some(("Mixdog Desktop".to_owned(), LinkKind::Local(LocalKind::Desktop))));
    assert_eq!(kind(2), Some(("mixdog-cli".to_owned(), LinkKind::Local(LocalKind::Cli))));
    assert_eq!(kind(3), None, "a local client that says it is a phone is no paired phone");
    assert_eq!(kind(4), None, "a relay connection is recorded by the dialer that opened it");
}
