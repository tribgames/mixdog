//! A paired phone reaches the core over the relay through the production wiring and drives it: the real `build_remote` runtime, the
//! dialer bound as `serving::attach` binds it (the server's `spawn_drive`), `start_remote` at boot, the registered connections,
//! `ScreenSessions` for the phone's notification, `register_local` and `phone_credential` as `ComposedCore` and `compose_flip` use
//! them, and the close path of `ConnectionOwners`, over a mock thread directory (the composed core needs a bundled Postgres runtime).
//! The relay is a local scripted peer; the phone is a real E2EE client.

#[path = "../../../../mixdog-remote/tests/it/common/mod.rs"]
mod common;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mixdog_app_protocol::limits::Limits;
use bytes::Bytes;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_server::AppServer;
use mixdog_app_server::Outgoing;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::Incoming;
use mixdog_app_server_transport::SocketClosed;
use mixdog_app_server_transport::SocketRead;
use mixdog_app_server_transport::SocketWrite;
use mixdog_app_server::HostMedia;
use mixdog_core_api::CoreError;
use mixdog_core_api::ConnectionNotifier;
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
use common::Event;
use common::LegEnd;
use common::Phone;
use common::Relay;
use common::driven_relay_with;
use common::on_lane;

const CRED: &str = "aaaaaaa1";
const OTHER_CRED: &str = "bbbbbbb2";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const REDIAL: &str = include_str!("../../../../../fixtures/remote-relay-redial/golden.json");

/// The core the server sees: the mock directory for threads, the production `ScreenSessions` for the phone's screen report, and the
/// registry hooks `ComposedCore` runs when a connection starts (`register_local`) and ends (`ConnectionOwners`).
/// The desktop as the live view meets it: it records what it was asked and, when a window supplies displays, answers the display list.
struct Desktop {
    asked: Mutex<Vec<String>>,
    /// How many asks reached the desktop so far, for a test to wait on.
    reached: watch::Sender<usize>,
    /// Whether a window supplies the display list. Without one an ask stays pending, as it does in Node's desktop when no window answers.
    displays: bool,
}

impl Desktop {
    fn new(displays: bool) -> Self {
        Self { asked: Mutex::default(), reached: watch::channel(0).0, displays }
    }
}

#[async_trait::async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, _params: Value) -> Result<Value, HostError> {
        let count = {
            let mut asked = self.asked.lock().unwrap();
            asked.push(method.as_str().to_owned());
            asked.len()
        };
        self.reached.send_replace(count);
        if !self.displays {
            std::future::pending::<()>().await;
        }
        Ok(serde_json::from_str::<Value>(SCREEN_ACCESS).unwrap()["displays"].clone())
    }

    fn notify(&self, _capability: HostCapability, _method: Method, _params: Value) -> Result<(), CoreError> {
        Ok(())
    }
}

struct NoPushes;

impl ConnectionNotifier for NoPushes {
    fn notify(&self, _to: ConnectionId, _method: Method, _params: Value) -> Result<(), CoreError> {
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

    fn connection_opened(&self, connection: ConnectionId, origin: Origin, device: &str, kind: ConnectionKind) {
        register_local(&self.registry, connection, origin, device, kind);
        self.mock.connection_opened(connection, origin, device, kind);
    }

    fn request_started(&self, method: &str, params: &serde_json::Value) -> RequestGuard {
        self.mock.request_started(method, params)
    }
}

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

/// The core booted as `compose` and `serving::attach` boot it, with one paired device ("Pixel", `CRED`) in the relay's roster.
struct Harness {
    /// The file the downloads' clock is read from (`<MIXDOG_DOWNLOAD_REPLAY_DIR>/clock`), which only the test writes: Node's recorder
    /// moved its own clock by explicit steps too.
    wall: std::path::PathBuf,
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
    /// The device state an unpair cleans, the real services: notification preferences (`Config`), one-file grants and transfers.
    config: mixdog_core_config::config::Config,
    /// The server's own hub and server: a client in this process attaches to them as the daemon's listeners do.
    hub: ConnectionHub,
    server: AppServer,
}

fn listed() -> Value {
    json!({ "threads": [{ "id": "t1", "title": "Fix the build" }] })
}

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
        // An install that used remote access before: activated, with its E2EE identity on disk.
        std::fs::write(path.join("remote-activated.json"), br#"{"activatedAt":1}"#).unwrap();
        let identity = identity_in(path.clone());
        let mut relay = driven_relay_with(json!([{ "id": CRED, "name": "Pixel", "browser": "Chrome" }]), revoke_ok).await;

        // The wiring `compose` and `serving::attach` do, in their order.
        let (remote_viewing, _) = watch::channel(Vec::new());
        let published = Arc::new(Published { remote_viewing });
        let late_publisher = Arc::new(LatePublisher::default());
        let late_dialer = Arc::new(LateDialer::default());
        let remote = build_remote(RemoteInputs {
            dir: path,
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
        })
        .unwrap();
        let grants = Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(AllSessions(dir.path().to_string_lossy().into_owned()))));
        workspace.set_phone_grants(grants.clone(), phone_credential(remote.registry.clone()));
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
            Arc::new(NoPushes),
            HostMedia::new(1 << 20),
            remote.runtime.clone(),
            tokens.media_thread,
            Arc::new(PairedScreenAccess::new(phone_credential(remote.registry.clone()), super::screen_revoked(remote.registry.clone()))),
        ));
        let core = Arc::new(Core { live, workspace, access, mock, screen, registry: remote.registry.clone(), owners, closed: closed_tx });
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let origins = hub.clone();
        let own_hub = hub.clone();
        let server = AppServer::new(core.clone(), Outgoing::new(), Arc::new(move |id| origins.origin_of(id)), crate::server::server_config(Limits::default(), Default::default())).unwrap();
        let own_server = server.clone();
        late_dialer
            .bind(hub, Arc::new(move |accepted| crate::server::spawn_drive(server.clone(), accepted)), remote.registry.clone())
            .unwrap();
        start_remote(&remote, published.clone()).await;

        // The relay answers the boot's leg, the roster names the paired device.
        relay.legs.recv().await.expect("the relay ended");
        remote.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
        remote.runtime.list_clients().await.unwrap();
        Self { wall, dir, core, registry: remote.registry, runtime: remote.runtime, published, relay, identity, desktop, reads, turns, closed, config, hub: own_hub, server: own_server }
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
        let got = tokio::time::timeout(FRAME_WAIT, seen.wait_for(|closed| closed.contains(&connection))).await;
        got.unwrap_or_else(|_| panic!("connection {connection:?} was never closed")).expect("the core ended");
    }

    async fn viewing(&self, wanted: &[&str]) {
        let wanted: Vec<String> = wanted.iter().map(|id| (*id).to_owned()).collect();
        let mut seen = self.published.remote_viewing.subscribe();
        let got = tokio::time::timeout(FRAME_WAIT, seen.wait_for(|ids| *ids == wanted)).await;
        got.unwrap_or_else(|_| panic!("the viewed sessions never became {wanted:?}")).expect("the publisher ended");
    }
}

/// Every conversation exists, a project conversation of the harness folder (the catalog the grants are checked against has none to remove).
struct AllSessions(String);

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for AllSessions {
    async fn row(&self, _: &str) -> mixdog_workspace::error::WsResult<Option<mixdog_workspace::grants::SessionRow>> {
        Ok(Some(mixdog_workspace::grants::SessionRow { project: true, project_path: Some(self.0.clone()), cwd: self.0.clone() }))
    }

    async fn has(&self, _: &str) -> mixdog_workspace::error::WsResult<bool> {
        Ok(true)
    }
}

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

impl Client {
    /// Sends the request and returns the frame the server wrote for its id, as written.
    async fn call(&mut self, request: &Value) -> Value {
        self.to_server.send(Incoming::Text(request.to_string())).unwrap();
        loop {
            let next = tokio::time::timeout(FRAME_WAIT, self.from_server.recv()).await.expect("the server wrote no frame for the request");
            let frame: Value = serde_json::from_str(&next.expect("the server ended")).unwrap();
            if frame["id"] == request["id"] {
                return frame;
            }
        }
    }
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

/// The frame carrying `id`, with the frames for other ids that came before it. One deadline covers the whole wait: frames for other ids
/// (Node's desktop also sends a phone frames nobody asked for) neither extend it nor are lost, so a reply that never comes fails here.
async fn reply_within(from: &mut impl Frames, id: u64, within: Duration) -> (Value, Vec<Value>) {
    let mut others = Vec::new();
    let waited = tokio::time::timeout(within, async {
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
async fn an_unpaired_peer_is_refused_before_any_session_read_or_turn() {
    let h = Harness::start(true).await;
    let strangers = identity_in(h.dir.path().join("stranger"));

    // Without the pairing key nothing it sends is an application frame: the first frame must be the hello, and anything else
    // is dropped, not answered and not forwarded.
    let plain = h.relay.open_peer("u1", OTHER_CRED);
    plain.challenge().await;
    plain.send_frame(&json!({ "id": 0, "method": "initialize", "params": { "clientInfo": { "name": "x", "version": "1", "kind": "phone" }, "capabilities": {} } }).to_string());
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

#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_the_relay_has_not_confirmed_leaves_every_connection_open_without_the_grants_of_the_device() {
    let h = Harness::start(false).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    let credential_of = phone_credential(h.registry.clone());

    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    // Nothing closes the phone (Node closes none; the relay ends a leg only when it removed the pairing); it keeps its identity.
    assert_eq!(credential_of(connection).as_deref(), Some(CRED));
    assert_eq!(list(&mut phone, 1).await["result"], listed());

    // The unpair is recorded and in force: the device's new connection is admitted (Node revokes it on admission) without a grant.
    let (mut again, again_connection) = h.connect("p2", CRED).await;
    assert_eq!(credential_of(again_connection).as_deref(), Some(CRED));
    assert_eq!(list(&mut again, 1).await["result"], listed());
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
    h.core.screen.notify(
        Method("ui/screenSessions/changed"),
        json!({ "sessionIds": ["t1"], "visualizeSessionIds": ["t1"], "foreground": true }),
        named,
    );
    assert!(h.core.screen.shows("t1"));
    assert!(h.registry.visualize_viewed_sessions().is_empty(), "no paired device views anything");
    h.runtime.close().await;
}

/// Plays the recorded `script` against the relay, which ends the leg the core holds and refuses the dials the script says fail. Each
/// step that schedules a redial must not be followed by a dial sooner than the delay Node scheduled. (A longer wait is not asserted
/// here; the schedule itself is replayed exactly by `mixdog-remote`'s `relay_redial`.)
async fn follow(h: &mut Harness, script: &str) {
    let golden: Value = serde_json::from_str(REDIAL).unwrap();
    let steps = golden[script].as_array().unwrap().clone();
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
        assert!(waited >= delay, "step {at} ({step}): the core dialed again after {waited:?}, Node waits {delay:?}");
        if delay.is_zero() {
            // A stalled-handshake close is redialed at once: well before the backoff an ordinary drop waits.
            assert!(waited < Duration::from_millis(longest), "step {at} ({step}): {waited:?}");
        }
        since = dialed;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_leg_redials_on_the_backoff_node_recorded_and_a_phone_pairs_again_on_the_new_leg() {
    let mut h = Harness::start(true).await;
    let (_phone, connection) = h.connect("p1", CRED).await;
    let (mut watcher, watcher_connection) = h.connect("p2", OTHER_CRED).await;
    watcher.send(
        &json!({ "method": "ui/screenSessions/changed", "params": { "sessionIds": ["t1"], "visualizeSessionIds": ["t1"], "foreground": true } }).to_string(),
    );
    h.viewing(&["t1"]).await;

    // Doubling while redials fail (1 s, 2 s, 4 s), then the leg opens: no phone survives the lost leg.
    follow(&mut h, "ladder").await;
    h.closed(connection).await;
    h.closed(watcher_connection).await;
    h.viewing(&[]).await;
    h.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");

    // The relay re-announces the phones on the new leg; a phone pairs again and drives the core as before.
    let (mut again, _) = h.connect("p3", CRED).await;
    assert_eq!(list(&mut again, 1).await["result"], listed());
    h.runtime.close().await;
}

const FILE_DOWNLOADS: &str = include_str!("../../../../../fixtures/file-downloads/file-downloads.json");

/// The frame Node's phone got for the `n`th call of the scenario `name`, which must be of the phone method `method`, without its id.
fn download_call(name: &str, n: usize, method: &str) -> Value {
    let recording: Value = serde_json::from_str(FILE_DOWNLOADS).unwrap();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no scenario {name}"));
    let step = scenario["steps"].as_array().unwrap().iter().filter(|step| step["op"] == "call").nth(n).unwrap_or_else(|| panic!("{name}: no call {n}"));
    assert_eq!(step["method"], method, "{name}: call {n}");
    let mut frame = step["frame"].clone();
    frame.as_object_mut().unwrap().remove("id");
    frame
}

/// One call of `phone`, as the frame Node's phone would have got, without its id.
async fn download_frame(phone: &mut Phone, id: u64, method: &str, params: Value) -> Value {
    phone.send(&json!({ "id": id, "method": method, "params": params }).to_string());
    let mut frame = node_of(&answer(phone, id).await);
    frame.as_object_mut().unwrap().remove("id");
    frame
}

/// Remote access switched off closes the relay handle, and with it every download the paired phones held (`remote-relay.ts` `close`,
/// `fileDownloads.revokeAll`): a phone that pairs again once remote access is back finds its unbegun grant and its transfer gone, as Node's
/// phone did after the same revoke (`revoke all`: the begin of the unbegun grant, then the range of the transfer).
#[tokio::test(flavor = "multi_thread")]
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
    tokio::time::timeout(FRAME_WAIT, h.relay.legs.recv()).await.expect("the core never dialed the relay again").expect("the relay ended");
    let mut up = h.runtime.watch_connected();
    tokio::time::timeout(FRAME_WAIT, up.wait_for(|up| *up)).await.expect("the new leg never came up").expect("the runtime ended");
    let (mut again, _) = h.connect("p2", CRED).await;
    let begin = download_frame(&mut again, 4, "transfer/redeemGrant", json!({ "grantId": unbegun })).await;
    assert_eq!(begin, download_call("revoke all", 3, "fileDownloadBegin"), "the unbegun grant after the relay closed");
    let range = json!({ "transferId": lease["transferId"], "offset": 0, "length": 4, "version": lease["version"] });
    let read = download_frame(&mut again, 5, "transfer/readRange", range).await;
    assert_eq!(read, download_call("revoke all", 4, "fileDownloadRange"), "the transfer after the relay closed");
    h.runtime.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_handshake_close_redials_at_once_twice_and_then_waits_the_backoff() {
    let mut h = Harness::start(true).await;
    follow(&mut h, "stalled").await;
    h.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
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

/// The clock Node's recorder started at (`record-unpair-access.mjs` `CLOCK_START`, 2031-01-01).
const DOWNLOAD_CLOCK_START: i64 = 1_924_992_000_000;

const SCREEN_ACCESS: &str = include_str!("../../../../../fixtures/screen-access/screen-access.json");

/// The frame the core's wire carries for what Node sent the phone: `{ id, ok: true, value }` becomes `{ id, result }`, and
/// `{ id, ok: false, error }` becomes `{ id, error }` with the JSON-RPC error body of a remote domain error carrying that text (the body is
/// the wire's own: code -32600, reason `domainError`). Any other recorded key is kept as it is, so a frame that is not exactly one of the
/// two shapes is not equal to what the server writes.
fn wire_of(node: &Value) -> Value {
    let mut frame = node.as_object().unwrap().clone();
    match frame.remove("ok").unwrap().as_bool().unwrap() {
        true => {
            let value = frame.remove("value").unwrap();
            frame.insert("result".to_owned(), value);
        }
        false => {
            let text = frame.remove("error").unwrap();
            let body = json!({ "code": -32600, "message": "domainError", "data": { "reason": "domainError", "domain": "remote", "message": text } });
            frame.insert("error".to_owned(), body);
        }
    }
    Value::Object(frame)
}

/// The recorded scenario `name` (by its leading words), checked to hold exactly the keys `wanted` (the ones this replay reads), and, when
/// it has a `before`, the keys of an answer in it.
fn recorded(name: &str, wanted: &[&str]) -> Value {
    fn keys(value: &Value, wanted: &[&str], at: &str) {
        let mut found: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
        found.sort_unstable();
        let mut wanted = wanted.to_vec();
        wanted.sort_unstable();
        assert_eq!(found, wanted, "{at}");
    }
    let all: Value = serde_json::from_str(SCREEN_ACCESS).unwrap();
    let scenario = all["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["name"].as_str().unwrap().starts_with(name)).unwrap_or_else(|| panic!("no recorded scenario {name}")).clone();
    keys(&scenario, wanted, name);
    if let Some(before) = scenario.get("before") {
        keys(before, &["reply", "hostAsked"], name);
    }
    scenario
}

/// The request the phone sends for the display list, with the id Node's recording used.
fn displays_call(reply: &Value) -> Value {
    json!({ "id": reply["id"], "method": "browser/screenDisplays", "params": {} })
}

/// Node's composed screen access (`screen-access.json`: the frame the real relay-client call dispatch sent the phone, over the real
/// relay asking the real publisher over the real client table), against the production wiring. Every recorded scenario is replayed over a
/// connection the server's dispatch serves, and the frame the server writes is compared as a whole to the frame Node's recorded reply
/// maps to (`wire_of`); a recorded `null` reply is no frame at all. The host is asked exactly as often as Node's was.
///
/// The unpair scenarios run over the one phone connection throughout. Node's desktop closes nothing at an unpair: the connection stays
/// attached and its next call is refused, unless the relay removed the pairing, in which case the relay ends the leg (`relay-legs.mjs`
/// `revokeClient`, only `if (removed)`) and the next call gets nothing. The scripted relay does not close a leg by itself, so the
/// confirmed case has the phone's leg end (`Phone::leave`) as the relay reports it.
///
/// The local-client scenario is replayed on a relay connection that holds no paired device: Node's dispatch is relay-only, so the frame
/// it recorded is the one such a connection gets.
#[tokio::test(flavor = "multi_thread")]
async fn the_composed_screen_access_answers_as_nodes_relay_and_publisher_did() {
    let all: Value = serde_json::from_str(SCREEN_ACCESS).unwrap();
    assert_eq!(all["scenarios"].as_array().unwrap().len(), 5, "every recorded scenario is replayed below");
    let asked = |h: &Harness| h.desktop.asked.lock().unwrap().len() as u64;
    let unpaired_relay_peer = ConnectionOrigin::Relay { peer_id: "gone".to_owned() };
    let plain = ["name", "reply", "hostAsked"];

    // A paired phone, over its relay channel.
    let allowed = recorded("a paired, E2EE-established phone", &plain);
    let h = Harness::start(true).await;
    let (mut phone, _) = h.connect("p1", CRED).await;
    phone.send(&displays_call(&allowed["reply"]).to_string());
    assert_eq!(answer(&mut phone, 7).await, wire_of(&allowed["reply"]), "a paired phone");
    assert_eq!(asked(&h), allowed["hostAsked"].as_u64().unwrap());
    h.runtime.close().await;

    // Unpaired, the relay not removing the pairing: the same connection stays, and its next call is refused. Desktop envelopes at the
    // unpair: none (no frame and no close reaches the phone's client).
    let kept = recorded("a paired phone is allowed, then unpaired with the relay not", &["name", "before", "envelopesAtUnpair", "reply", "hostAsked"]);
    assert_eq!(kept["envelopesAtUnpair"], json!([]));
    let h = Harness::start(false).await;
    let (mut phone, _) = h.connect("p1", CRED).await;
    phone.send(&displays_call(&kept["before"]["reply"]).to_string());
    assert_eq!(answer(&mut phone, 7).await, wire_of(&kept["before"]["reply"]), "before the unpair");
    assert_eq!(asked(&h), kept["before"]["hostAsked"].as_u64().unwrap());
    let sent = phone.arrived().await;
    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    assert_eq!(phone.arrived().await, sent, "the unpair sent the phone nothing and closed nothing");
    phone.send(&displays_call(&kept["reply"]).to_string());
    assert_eq!(answer(&mut phone, 7).await, wire_of(&kept["reply"]), "the same connection, after the unpair");
    assert_eq!(asked(&h), kept["before"]["hostAsked"].as_u64().unwrap() + kept["hostAsked"].as_u64().unwrap());
    h.runtime.close().await;

    // Unpaired, the relay removing the pairing: it ends the phone's leg; the same connection's next call gets nothing.
    let ended = recorded("a paired phone is allowed, then unpaired with the relay removing", &["name", "before", "envelopesAtUnpair", "reply", "hostAsked", "envelopesAfter"]);
    assert_eq!((ended["envelopesAtUnpair"].clone(), ended["envelopesAfter"].clone(), ended["reply"].clone()), (json!([]), json!([]), Value::Null));
    let h = Harness::start(true).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    phone.send(&displays_call(&ended["before"]["reply"]).to_string());
    assert_eq!(answer(&mut phone, 7).await, wire_of(&ended["before"]["reply"]), "before the unpair");
    assert_eq!(asked(&h), ended["before"]["hostAsked"].as_u64().unwrap());
    let sent = phone.arrived().await;
    h.runtime.revoke_client(CRED).await.unwrap();
    assert_eq!(phone.arrived().await, sent, "the unpair sent the phone nothing and closed nothing");
    phone.leave();
    h.closed(connection).await;
    phone.send(&displays_call(&kept["reply"]).to_string());
    // The runtime takes the relay's events in order: another paired phone's answer proves the dead phone's call was handled.
    let (mut other, _) = h.connect("p2", OTHER_CRED).await;
    assert_eq!(list(&mut other, 1).await["result"], listed());
    assert_eq!(phone.arrived().await, sent, "a phone the relay ended is sent nothing");
    assert_eq!(asked(&h), ended["before"]["hostAsked"].as_u64().unwrap() + ended["hostAsked"].as_u64().unwrap());
    h.runtime.close().await;

    // A device whose unpair is in force when its connection is admitted: the connection is admitted, and refused the screen.
    let unpaired = recorded("a device whose unpair is in force", &["name", "reply", "hostAsked", "envelopes"]);
    assert_eq!(unpaired["envelopes"], json!([]));
    let h = Harness::start(false).await;
    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    let (mut phone, _) = h.connect("p1", CRED).await;
    phone.send(&displays_call(&unpaired["reply"]).to_string());
    assert_eq!(answer(&mut phone, 7).await, wire_of(&unpaired["reply"]), "an unpair in force");
    assert_eq!(asked(&h), unpaired["hostAsked"].as_u64().unwrap());
    h.runtime.close().await;

    // A local client, even one naming itself after the paired device.
    let local = recorded("a local client", &plain);
    let h = Harness::start(true).await;
    let (_phone, _) = h.connect("p1", CRED).await;
    let mut nobody = h.client(unpaired_relay_peer, "phone").await;
    assert_eq!(nobody.call(&displays_call(&local["reply"])).await, wire_of(&local["reply"]), "a connection with no paired device");
    // Over its own loopback connection the method table refuses the local client before the access rule is asked
    // (`browser/screenDisplays` is a relay method): the server's own `permissionDenied` frame, which Node has no counterpart of.
    let mut named = h.client(ConnectionOrigin::Loopback, "cli").await;
    assert_eq!(
        named.call(&displays_call(&local["reply"])).await,
        json!({ "id": local["reply"]["id"], "error": { "code": -32600, "message": "permissionDenied", "data": { "reason": "permissionDenied", "method": "browser/screenDisplays", "origin": "local" } } }),
        "a local client"
    );
    assert_eq!(asked(&h), local["hostAsked"].as_u64().unwrap());
    h.runtime.close().await;
}

const UNPAIR_ACCESS: &str = include_str!("../../../../../fixtures/unpair-access/unpair-access.json");

/// The inputs `record-unpair-access.mjs` registered before its unpair.
const PUSH_KEY: &str = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const PUSH_ENDPOINT: &str = "https://push.example/x";

/// `record-unpair-access.mjs` replaced the values that differ between two Node runs, by exact path (the fixture's `remapped`: a kind and
/// a path in a scenario): a random id by `<kind#n>`, numbered per kind by first appearance of the value over the whole recording, so equal
/// values share a token and different ones never do; the run's temporary directory, alone or as the head of a path, by `<dir>`. A frame the
/// core wrote goes through the same replacement at the same paths, and the numbering goes on across the scenarios, as the recorder's did.
struct Canon {
    rules: std::collections::HashMap<String, String>,
    dir: String,
    tokens: std::collections::HashMap<String, String>,
    counts: std::collections::HashMap<String, usize>,
}

impl Canon {
    fn new(remapped: &Value) -> Self {
        let rules = remapped.as_array().unwrap().iter().map(|rule| (rule["path"].as_str().unwrap().to_owned(), rule["kind"].as_str().unwrap().to_owned())).collect();
        Self { rules, dir: String::new(), tokens: Default::default(), counts: Default::default() }
    }

    fn replace(&mut self, kind: &str, text: &str) -> String {
        if kind == "dir" {
            return text.strip_prefix(self.dir.as_str()).map_or_else(|| text.to_owned(), |rest| format!("<dir>{rest}"));
        }
        if !self.tokens.contains_key(text) {
            let count = self.counts.entry(kind.to_owned()).or_default();
            self.tokens.insert(text.to_owned(), format!("<{kind}#{count}>"));
            *count += 1;
        }
        self.tokens[text].clone()
    }

    /// `node` found at `path` (a frame's path, then the keys and indices inside it) with the values at the rules' paths replaced.
    fn frame(&mut self, path: &str, node: &Value) -> Value {
        if let (Some(kind), Some(text)) = (self.rules.get(path).cloned(), node.as_str()) {
            return json!(self.replace(&kind, text));
        }
        match node {
            Value::Array(items) => Value::Array(items.iter().enumerate().map(|(index, item)| self.frame(&format!("{path}.{index}"), item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), self.frame(&format!("{path}.{key}"), value))).collect()),
            // JavaScript has one number type: `1924905600000` and `1924905600000.0` are the same value on Node's wire.
            Value::Number(number) => match number.as_f64() {
                Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < 9e15 => json!(float as i64),
                _ => node.clone(),
            },
            other => other.clone(),
        }
    }

    /// The recording replaced exactly the rules' paths: each holds a placeholder, and no other string in `scenario` looks like one.
    fn only_at_rules(&self, scenario: &Value) {
        fn walk(rules: &std::collections::HashMap<String, String>, node: &Value, path: &str) {
            match node {
                Value::Object(map) => map.iter().for_each(|(key, value)| walk(rules, value, &if path.is_empty() { key.clone() } else { format!("{path}.{key}") })),
                Value::Array(items) => items.iter().enumerate().for_each(|(index, item)| walk(rules, item, &format!("{path}.{index}"))),
                Value::String(text) => {
                    let placeholder = text.starts_with("<dir>") || (text.starts_with('<') && text.contains('#') && text.ends_with('>'));
                    assert_eq!(placeholder, rules.contains_key(path), "{path} holds {text:?}: a placeholder belongs at the remap rules' paths and nowhere else");
                }
                _ => assert!(!rules.contains_key(path), "{path} is remapped but holds no string"),
            }
        }
        walk(&self.rules, scenario, "");
        for path in self.rules.keys() {
            assert!(scenario.pointer(&format!("/{}", path.replace('.', "/"))).is_some_and(Value::is_string), "the remap rule {path} names nothing in the recording");
        }
    }
}

/// The frame Node's phone received for the core's wire frame: the inverse of `wire_of`, with the error code Node's frame carries.
fn node_of(wire: &Value) -> Value {
    let mut frame = wire.as_object().unwrap().clone();
    if let Some(result) = frame.remove("result") {
        frame.insert("ok".to_owned(), json!(true));
        frame.insert("value".to_owned(), result);
    } else {
        let error = frame.remove("error").unwrap();
        frame.insert("ok".to_owned(), json!(false));
        frame.insert("error".to_owned(), error["data"]["message"].clone());
        if let Some(code) = error["data"].get("code") {
            frame.insert("errorCode".to_owned(), code.clone());
        }
    }
    Value::Object(frame)
}

fn op(n: u32) -> String {
    format!("018f0000-0000-7000-8000-{n:012x}")
}

fn at<'a>(root: &'a Value, path: &str) -> &'a Value {
    path.split('.').fold(root, |node, key| &node[key])
}

/// The branches that own recorded frames this test does not replay yet. A `NOT_REPLAYED` entry names only these.
const OWNERS: &[&str] = &["phone-ph2-terminal", "phone-ph2-settings-notify", "phone-chat-live", "rs-thread-list-rows"];

struct NotReplayed {
    /// A recorded frame's path in a scenario (or `feedEvents`, the frames Node pushed to an attached phone).
    path: &'static str,
    owners: &'static [&'static str],
    /// What Node answered there and why the core's wire cannot be compared to it yet.
    why: &'static str,
}

/// The recorded frames this test does not replay whole, each with the branches it waits on. Node's frames stay in the fixture for the
/// owner to replay. The test fails when an entry names an owner outside `OWNERS`, a path the recording holds no frame for, or a path it
/// replays, and when a recorded frame is neither replayed nor named here.
const NOT_REPLAYED: &[NotReplayed] = &[
    NotReplayed {
        path: "before.chat",
        owners: &["phone-chat-live", "rs-thread-list-rows"],
        why: "Node's session rows (`listSessions`, remote-methods.ts:865): served to a revoked phone as before, the same row with its times moved. The core's `thread/list` has no such rows; it is compared only against itself, before and after the unpair.",
    },
    NotReplayed { path: "after.chat", owners: &["phone-chat-live", "rs-thread-list-rows"], why: "as before.chat" },
    NotReplayed {
        path: "before.terminal",
        owners: &["phone-ph2-terminal"],
        why: "Node's shell list (`termProfiles`, remote-methods.ts:1159): served to a revoked phone unchanged. The core's counterpart is `terminal/profiles`, served by the mixdog-spawn host, which this harness does not compose; the core's list is compared with Node's recorded list exactly in the phone-terminal replay (apps/desktop/src/renderer/remote-protocol-terminal.slow.test.mjs, `termProfiles`).",
    },
    NotReplayed { path: "after.terminal", owners: &["phone-ph2-terminal"], why: "as before.terminal" },
    NotReplayed {
        path: "before.settings",
        owners: &["phone-ph2-settings-notify"],
        why: "Node's settings blob (`readSettings`, remote-methods.ts:1092): served to a revoked phone unchanged. The core has no counterpart of the frame.",
    },
    NotReplayed { path: "after.settings", owners: &["phone-ph2-settings-notify"], why: "as before.settings" },
    NotReplayed {
        path: "setup.setNotificationPreferences",
        owners: &["phone-ph2-settings-notify"],
        why: "Node's roster reply to the call that stores the device's preferences. The preferences it stored are this test's input (written to `Config`).",
    },
    NotReplayed {
        path: "before.notifications",
        owners: &["phone-ph2-settings-notify"],
        why: "Node's roster (`getNotificationPreferences`, remote-methods.ts:1115). The device's preferences in it are compared as what `Config` stores; the roster call itself has no core counterpart.",
    },
    NotReplayed {
        path: "after.notifications",
        owners: &["phone-ph2-settings-notify"],
        why: "the roster after the unpair: it hides the device while the relay has not confirmed (only the PC is listed) and lists it with default preferences once it has",
    },
    NotReplayed { path: "after.notificationsAfterForget", owners: &["phone-ph2-settings-notify"], why: "as after.notifications" },
    NotReplayed {
        path: "feedEvents",
        owners: &["phone-chat-live"],
        why: "Node's compact session-state frame `{e: 'T', s, w: {r, ip: {p, a: [row]}}}` (remote-relay-session-state.ts:143), pushed only to an attached phone and decoded into its transcript snapshot (remote-shim-dispatch.ts:228-257); without it an attached phone gets no live transcript updates. The core has no encoder of it on the phone link.",
    },
];

/// The frames a recorded scenario holds, by path: those of `setup`, `before` and `after` (an object with an `id`, at any depth), and `feedEvents`.
/// A key that is neither one of those nor one of the metadata asserted one by one in the test fails here, so no recorded group escapes.
fn recorded_paths(scenario: &Value) -> Vec<String> {
    const METADATA: [&str; 6] = ["name", "relayConfirms", "revokeOutcome", "envelopesAtUnpair", "desktopClosedPhone", "phoneStillAttached"];
    fn frames(path: &str, node: &Value, into: &mut Vec<String>) {
        let object = node.as_object().unwrap_or_else(|| panic!("{path} is neither a recorded frame nor a group of frames"));
        if object.contains_key("id") {
            let replied = object.get("ok").is_some_and(Value::is_boolean);
            let unanswered = object.get("unanswered") == Some(&json!(true));
            assert!(object["id"].is_u64() && replied != unanswered, "{path} is neither a recorded reply nor a recorded call that got none");
            into.push(path.to_owned());
        } else {
            object.iter().for_each(|(key, value)| frames(&format!("{path}.{key}"), value, into));
        }
    }
    let mut paths = Vec::new();
    for (key, value) in scenario.as_object().unwrap() {
        match key.as_str() {
            "feedEvents" => paths.push(key.clone()),
            "setup" | "before" | "after" => frames(key, value, &mut paths),
            other => assert!(METADATA.contains(&other), "the recording holds a group the test does not know: {other}"),
        }
    }
    paths
}

#[test]
fn the_remap_is_by_exact_path_and_keeps_what_the_values_mean() {
    let mut canon = Canon::new(&json!([{ "kind": "grantId", "path": "a.value.id" }, { "kind": "grantId", "path": "b.value.id" }, { "kind": "dir", "path": "a.value.root" }]));
    canon.dir = "/tmp/run".to_owned();
    let a = canon.frame("a", &json!({ "value": { "id": "x1", "root": "/tmp/run/files", "expiresAt": 20, "nested": { "id": "x1", "updatedAt": 7 } } }));
    let b = canon.frame("b", &json!({ "value": { "id": "x1" } }));
    let c = canon.frame("b", &json!({ "value": { "id": "x2" } }));
    // The same random id keeps one token over the whole recording, another id another token.
    assert_eq!((a["value"]["id"].clone(), b["value"]["id"].clone()), (json!("<grantId#0>"), json!("<grantId#0>")));
    assert_eq!(c["value"]["id"], json!("<grantId#1>"));
    assert_eq!(a["value"]["root"], json!("<dir>/files"));
    // A key of the same name at a path that is no rule is kept, and so are the times: two times that swap stay two times that swap.
    assert_eq!((&a["value"]["nested"]["id"], &a["value"]["nested"]["updatedAt"], &a["value"]["expiresAt"]), (&json!("x1"), &json!(7), &json!(20)));
    let swapped = canon.frame("a", &json!({ "value": { "expiresAt": 20 } }));
    assert_ne!(swapped, canon.frame("a", &json!({ "value": { "expiresAt": 21 } })), "a changed time must change the frame");
}
/// What Node's desktop did across an unpair of a paired phone, recorded through its real unpair handler (`unpair-access.json`), replayed
/// over the composed wiring and the real services that hold a device's state (the remote access service, the workspace and its one-file
/// grants and transfers, the notification preferences in `Config`): the same phone connection throughout. A frame is the whole frame the
/// phone received (`node_of` of what the core writes) against the recorded one, after the same replacement at the same exact paths of the
/// values that differ between two Node runs. A revoked phone keeps its credential, so its native and Web Push registrations answer as
/// before; only its screen is refused. The registrations and notification preferences go when, and only when, the relay confirmed the
/// unpair; a grant the attached connection holds stays with it and a new connection of the device holds none.
///
/// The screen: a connection revoked at the unpair is refused before the window is asked. A connection admitted after the relay confirmed
/// the unpair is a new one and is not revoked: its ask reaches the window, and where no window supplies displays (the recorder's world,
/// and `Harness::start_with(.., false)`) it is never answered; the same ask where a window does supply them is answered, shown last.
///
/// What is not replayed is in `NOT_REPLAYED`, with its owners; the test fails when a recorded frame is neither replayed nor named there.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_leaves_a_revoked_phone_everything_but_the_screen_as_nodes_desktop_did() {
    let all: Value = serde_json::from_str(UNPAIR_ACCESS).unwrap();
    let token = all["token"].as_str().unwrap();
    assert_eq!(all["credential"], CRED);
    let scenarios = all["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 2, "every recorded scenario is replayed below");
    let native = json!({ "platform": "fcm", "token": token, "publicKey": PUSH_KEY });
    let web = json!({ "endpoint": PUSH_ENDPOINT, "p256dh": PUSH_KEY, "auth": "AAAAAAAAAAAAAAAAAAAAAA", "clientId": CRED });

    // The table first: its entries are checked against the recording before anything is replayed.
    let mut canon = Canon::new(&all["remapped"]);
    let held: Vec<Vec<String>> = scenarios.iter().map(recorded_paths).collect();
    for (index, entry) in NOT_REPLAYED.iter().enumerate() {
        let path = entry.path;
        assert!(!entry.owners.is_empty() && entry.owners.iter().all(|owner| OWNERS.contains(owner)), "NOT_REPLAYED {path}: owners {:?} are not all from OWNERS", entry.owners);
        assert!(!entry.why.trim().is_empty(), "NOT_REPLAYED {path} says nothing of what Node answered");
        assert!(NOT_REPLAYED[..index].iter().all(|earlier| earlier.path != path), "NOT_REPLAYED names {path} twice");
        assert!(held.iter().any(|paths| paths.iter().any(|frame| frame == path)), "NOT_REPLAYED names {path}, which the recording holds no frame for");
    }
    for owner in OWNERS {
        assert!(NOT_REPLAYED.iter().any(|entry| entry.owners.contains(owner)), "{owner} is in OWNERS and owns nothing in NOT_REPLAYED");
    }

    for (scenario, paths) in scenarios.iter().zip(&held) {
        let name = scenario["name"].as_str().unwrap();
        let confirms = scenario["relayConfirms"].as_bool().unwrap();
        let after = &scenario["after"];
        // The world of the recording: no window supplies displays.
        let h = Harness::start_with(confirms, false).await;
        canon.dir = h.dir.path().to_string_lossy().into_owned();
        canon.only_at_rules(scenario);
        let mut replayed: Vec<&str> = Vec::new();
        let (mut phone, connection) = h.connect("p1", CRED).await;
        let credential = phone_credential(h.registry.clone());
        let download = h.dir.path().join("unpair-download.txt");
        std::fs::write(&download, "unpair download").unwrap();
        // The modification time of the file Node recorded (`mtimeMs` of the read through the grant).
        let mtime_ms = at(scenario, "before.link.read.value.mtimeMs").as_u64().unwrap();
        std::fs::File::options().write(true).open(&download).unwrap().set_modified(std::time::UNIX_EPOCH + Duration::from_millis(mtime_ms)).unwrap();

        // One call over `phone`: the frame the core wrote for it, in Node's shape, replaced as Node's was, against the recorded one.
        macro_rules! replay {
            ($phone:expr, $path:expr, $method:expr, $params:expr) => {{
                let recorded = at(scenario, $path);
                // Node's recorder moved its clock a second for every call the phone made (its ids count from 100).
                std::fs::write(&h.wall, (DOWNLOAD_CLOCK_START + (recorded["id"].as_i64().unwrap() - 99) * 1000).to_string()).unwrap();
                $phone.send(&json!({ "id": recorded["id"], "method": $method, "params": $params }).to_string());
                let wire = answer(&mut $phone, recorded["id"].as_u64().unwrap()).await;
                let frame = canon.frame($path, &node_of(&wire));
                assert_eq!(&frame, recorded, "{name}: {}", $path);
                replayed.push($path);
                wire
            }};
        }

        // Setup: the device's notification preferences as Node stored them (the recorded preferences of the device, whole), and its
        // native and Web Push registrations, through the service the phone calls.
        let stored = at(scenario, "setup.setNotificationPreferences.value.preferences")[CRED].clone();
        h.config.write("notifications.devices", json!({ CRED: stored }), mixdog_protocol::ConfigWriteMode::Replace).await.unwrap();
        assert_eq!(serde_json::to_value(h.config.notification_device(CRED)).unwrap(), at(scenario, "before.notifications.value.preferences")[CRED].clone(), "{name}: the preferences Config holds");
        replay!(phone, "setup.registerNativePush", "remoteAccess/registerNativePush", json!({ "opId": op(1), "input": native }));
        replay!(phone, "setup.registerPushSubscription", "remoteAccess/registerPushSubscription", json!({ "opId": op(2), "input": web }));

        // Before the unpair: the Web Push key, the device's one-file grant (`resolveLocalPaths`, a file outside every project) and a
        // read through it, and an open transfer of the file.
        replay!(phone, "before.webPush", "remoteAccess/pushPublicKey", json!({}));
        let minted = {
            let recorded = at(scenario, "before.link.resolve");
            phone.send(&json!({ "id": recorded["id"], "method": "transfer/grant/mint", "params": { "path": download.to_string_lossy() } }).to_string());
            let wire = answer(&mut phone, recorded["id"].as_u64().unwrap()).await;
            // Node describes a list of paths, the core one path: the row is the first of the recorded list.
            let listed = json!({ "id": wire["id"], "result": [wire["result"].clone()] });
            assert_eq!(&canon.frame("before.link.resolve", &node_of(&listed)), recorded, "{name}: before.link.resolve");
            replayed.push("before.link.resolve");
            wire["result"].clone()
        };
        let link = [minted["projectPath"].clone(), minted["relPath"].clone(), minted["accessToken"].clone()];
        let read_link = json!({ "root": link[0], "rel": link[1], "accessToken": link[2] });
        replay!(phone, "before.link.read", "projectFs/readText", read_link);
        // The download in its two stages, as Node's phone made them: the grant, the transfer it is consumed into, and a second grant
        // never begun.
        let source = json!({ "kind": "sessionFile", "path": download.to_string_lossy() });
        let authorize = json!({ "sessionId": "s1", "source": source, "purpose": "save" });
        let grant = replay!(phone, "before.files.grant", "transfer/authorizeRead", authorize)["result"]["grantId"].clone();
        let transfer = replay!(phone, "before.files.transfer", "transfer/redeemGrant", json!({ "grantId": grant }))["result"]["transferId"].clone();
        let unbegun = replay!(phone, "before.files.unbegun", "transfer/authorizeRead", authorize)["result"]["grantId"].clone();

        let chat_before = {
            phone.send(&json!({ "id": 5100, "method": "thread/list", "params": {} }).to_string());
            answer(&mut phone, 5100).await
        };
        assert_eq!((&scenario["before"]["chat"]["ok"], &after["chat"]["ok"]), (&json!(true), &json!(true)), "{name}: Node answers the chat call before and after");
        // The unpair: the phone is sent nothing and nothing closes. Node's desktop sent the relay the revoke and, once it confirmed, a re-read
        // of its roster (the Settings list, not a phone's call); it sent the phone no frame and closed none.
        let sent = phone.arrived().await;
        let outcome = h.runtime.revoke_client(CRED).await;
        assert_eq!(scenario["revokeOutcome"].as_str().unwrap().starts_with("rejected"), outcome.is_err(), "{name}");
        let envelopes: Vec<&str> = scenario["envelopesAtUnpair"].as_array().unwrap().iter().map(|kind| kind.as_str().unwrap()).collect();
        assert!(envelopes.first() == Some(&"revoke-client") && envelopes.iter().all(|kind| !matches!(*kind, "frame" | "close-client")), "{name}: Node's desktop sent the relay the revoke and the phone nothing: {envelopes:?}");
        tokio::time::timeout(FRAME_WAIT, h.relay.frame(|frame| frame["type"] == "revoke-client")).await.unwrap_or_else(|_| panic!("{name}: the revoke never reached the relay"));
        assert_eq!(scenario["desktopClosedPhone"], Value::Null);
        assert_eq!(phone.arrived().await, sent, "{name}: the unpair sent the phone nothing and closed nothing");

        // The connection the phone's next calls go over: the same one, unless the relay ended its leg.
        let attached = scenario["phoneStillAttached"].as_bool().unwrap();
        assert_eq!(attached, !confirms, "{name}: only a relay that removed the pairing ends the phone's leg");
        let mut second = None;
        if !attached {
            phone.leave();
            h.closed(connection).await;
            second = Some(h.connect("p2", CRED).await);
        }
        let asks = match second.as_mut() {
            Some((phone, _)) => phone,
            None => &mut phone,
        };
        // The chat group: answered after the unpair as before it, as Node's recording shows for the revoked, still-attached phone.
        asks.send(&json!({ "id": 5101, "method": "thread/list", "params": {} }).to_string());
        let mut chat_after = answer(asks, 5101).await;
        chat_after["id"] = json!(5100);
        assert_eq!(chat_after, chat_before, "{name}: the chat call after the unpair");
        replay!(*asks, "after.webPush", "remoteAccess/pushPublicKey", json!({}));
        // The transfer the device held ended with its unpair (the files of the device end at once, on any connection).
        replay!(*asks, "after.files.range", "transfer/readRange", json!({ "transferId": transfer, "offset": 0, "length": 4 }));
        // And the grant it never begun.
        replay!(*asks, "after.files.begin", "transfer/redeemGrant", json!({ "grantId": unbegun }));
        replay!(*asks, "after.link.read", "projectFs/readText", read_link);
        let asked = || h.desktop.asked.lock().unwrap().len();
        if attached {
            // The connection keeps its identity: the credential, and what the services read of it to act as the device.
            assert_eq!(credential(connection).as_deref(), Some(CRED), "{name}");
            let described = h.registry.describe(connection.0).unwrap();
            assert_eq!((described.credential.as_str(), described.kind), (CRED, LinkKind::Phone), "{name}");
            asks.send(&displays_call(&after["screen"]).to_string());
            assert_eq!(answer(asks, after["screen"]["id"].as_u64().unwrap()).await, wire_of(&after["screen"]), "{name}: the screen");
            replayed.push("after.screen");
            let (mut second, second_connection) = h.connect("p3", CRED).await;
            assert_eq!(credential(second_connection).as_deref(), Some(CRED), "{name}");
            let refusal = &after["secondConnection"]["screen"];
            second.send(&displays_call(refusal).to_string());
            assert_eq!(answer(&mut second, refusal["id"].as_u64().unwrap()).await, wire_of(refusal), "{name}: a second connection");
            replayed.push("after.secondConnection.screen");
            assert_eq!(asked(), 0, "{name}: a refused ask never reaches the window");
        } else {
            // Both asks went over the connection admitted after the confirmed unpair (the recorder's `second`). It is not revoked, so each
            // reaches the window; no window answers; the call that follows is answered and no frame for either came before it.
            let calls = ["after.screen", "after.secondConnection.screen"];
            for path in calls {
                assert_eq!(at(scenario, path)["unanswered"], json!(true), "{name}: {path}");
                asks.send(&displays_call(at(scenario, path)).to_string());
                replayed.push(path);
            }
            let mut reached = h.desktop.reached.subscribe();
            tokio::time::timeout(FRAME_WAIT, reached.wait_for(|count| *count >= calls.len())).await.unwrap_or_else(|_| panic!("{name}: the screen asks never reached the window")).unwrap();
            asks.send(&json!({ "id": 5200, "method": "thread/list", "params": {} }).to_string());
            let (_, before_it) = reply_within(asks, 5200, FRAME_WAIT).await;
            for path in calls {
                assert!(before_it.iter().all(|frame| frame["id"] != at(scenario, path)["id"]), "{name}: {path} was answered");
            }
            assert_eq!(asked(), calls.len(), "{name}: each ask reached the window once");
        }
        // The notification preferences: dropped once the relay confirmed the unpair (Node's roster then shows the device's defaults),
        // kept while it has not. Compared as the preferences Config holds, whole, against the recorded list.
        let shown = h.config.notification_device(CRED);
        // Node's roster lists the device only once the relay confirmed (after.notifications); while it has not, the roster hides it and the
        // preferences stay as the roster showed them before the unpair.
        let expected = at(scenario, if confirms { "after.notifications" } else { "before.notifications" })["value"]["preferences"][CRED].clone();
        assert_eq!(serde_json::to_value(shown).unwrap(), expected, "{name}: the preferences after the unpair");
        // The registrations: kept while the relay has not confirmed, gone when it has (`removeNativePush` / `removePushSubscription`).
        let asks = match second.as_mut() {
            Some((phone, _)) => phone,
            None => &mut phone,
        };
        replay!(*asks, "after.removeNativePush", "remoteAccess/removeNativePush", json!({ "opId": op(3), "token": token }));
        replay!(*asks, "after.removePushSubscription", "remoteAccess/removePushSubscription", json!({ "opId": op(4), "endpoint": PUSH_ENDPOINT }));

        // The frames Node pushed to a phone still attached exist exactly when there was one, and are named in NOT_REPLAYED.
        let feed = &scenario["feedEvents"];
        if attached {
            assert!(feed.as_array().is_some_and(|frames| !frames.is_empty() && frames.iter().all(|frame| frame["e"].is_string())), "{name}: the recorded feed frames");
        } else {
            assert!(feed.is_null(), "{name}: a phone the relay ended is pushed no feed");
        }
        // Every recorded frame is replayed above or named in NOT_REPLAYED, not both.
        for path in paths {
            let listed = NOT_REPLAYED.iter().any(|entry| entry.path == path);
            let replayed = replayed.contains(&path.as_str());
            assert!(!(listed && replayed), "{name}: {path} is replayed and also named in NOT_REPLAYED");
            assert!(listed || replayed, "{name}: {path} is neither replayed nor named in NOT_REPLAYED");
        }
        h.runtime.close().await;
    }

    // Why the confirmed case's screen asks got no frame: no window supplied displays. The same ask on a new connection after the same
    // confirmed unpair, where the desktop does supply them, is answered as any allowed phone's is (`screen-access.json`).
    let allowed = recorded("a paired, E2EE-established phone", &["name", "reply", "hostAsked"]);
    let h = Harness::start_with(true, true).await;
    let (first, first_connection) = h.connect("p1", CRED).await;
    h.runtime.revoke_client(CRED).await.unwrap();
    first.leave();
    h.closed(first_connection).await;
    let (mut again, _) = h.connect("p2", CRED).await;
    again.send(&displays_call(&allowed["reply"]).to_string());
    assert_eq!(answer(&mut again, allowed["reply"]["id"].as_u64().unwrap()).await, wire_of(&allowed["reply"]), "a connection admitted after the confirmed unpair, where a window supplies displays");
    h.runtime.close().await;
}
