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
/// The desktop as the live view meets it: it answers the host's display list and records what it was asked.
struct Desktop {
    asked: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, _params: Value) -> Result<Value, HostError> {
        self.asked.lock().unwrap().push(method.as_str().to_owned());
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

    fn request_started(&self) -> RequestGuard {
        self.mock.request_started()
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
    /// `revoke_ok`: whether the relay confirms an unpair.
    async fn start(revoke_ok: bool) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
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
        let grants = Arc::new(mixdog_workspace::grants::GrantStore::new(Arc::new(mixdog_workspace::transfer::SystemClock), Arc::new(AllSessions)));
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
        let desktop = Arc::new(Desktop { asked: Mutex::default() });
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
        Self { dir, core, registry: remote.registry, runtime: remote.runtime, published, relay, identity, desktop, reads, turns, closed, config, hub: own_hub, server: own_server }
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

/// Every conversation exists (the catalog the grants are checked against has none to remove).
struct AllSessions;

#[async_trait::async_trait]
impl mixdog_workspace::grants::SessionCatalog for AllSessions {
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

async fn answer(phone: &mut Phone, id: u64) -> Value {
    loop {
        let text = tokio::time::timeout(FRAME_WAIT, phone.recv()).await.unwrap_or_else(|_| panic!("no frame with id {id} reached the phone"));
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["id"] == id {
            return frame;
        }
    }
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

/// `record-unpair-access.mjs` replaced the values that differ between two Node recordings (its `VARYING`, in the fixture's `remapped`) by
/// tokens numbered by first appearance per key; a frame the core writes goes through the same rules before it is compared.
struct Canon {
    rules: Value,
    dir: String,
    seen: std::collections::HashMap<String, Vec<String>>,
}

impl Canon {
    fn new(rules: &Value, dir: &std::path::Path) -> Self {
        Self { rules: rules.clone(), dir: dir.to_string_lossy().into_owned(), seen: Default::default() }
    }

    fn token(&mut self, key: &str, value: &Value) -> Value {
        let held = self.seen.entry(key.to_owned()).or_default();
        let text = value.to_string();
        let at = held.iter().position(|known| *known == text).unwrap_or_else(|| {
            held.push(text);
            held.len() - 1
        });
        json!(format!("<{key}#{at}>"))
    }

    fn replaced(&mut self, path: &str, key: &str, value: &Value) -> Option<Value> {
        let listed = |group: &str| self.rules[group].as_array().unwrap().iter().any(|listed| listed == key);
        if listed("time") && value.is_number() || listed("generated") && value.is_string() {
            return Some(self.token(key, value));
        }
        if listed("directory") && *value == json!(self.dir) {
            return Some(json!("<dir>"));
        }
        if listed("directoryPrefix") {
            if let Some(rest) = value.as_str().and_then(|text| text.strip_prefix(self.dir.as_str())) {
                return Some(json!(format!("<dir>{rest}")));
            }
        }
        (path.ends_with(".webPush") && key == "value").then(|| self.token("webPushKey", value))
    }

    fn frame(&mut self, path: &str, node: &Value) -> Value {
        match node {
            Value::Array(items) => Value::Array(items.iter().map(|item| self.frame(path, item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), self.replaced(path, key, value).unwrap_or_else(|| self.frame(path, value)))).collect()),
            other => other.clone(),
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

/// The recorded frames this test does not replay whole, each with the branch it waits on and why. The test fails when an entry has no
/// recorded frame, and when a recorded path is neither replayed nor listed here. Node's frames stay in the fixture for the owner to replay.
const NOT_REPLAYED: &[(&str, &str, &str)] = &[
    ("before.chat", "phone-chat-live / rs-thread-list-rows", "Node's session rows (`listSessions`); the core's `thread/list` has no such rows. Replayed only as the same answer before and after the unpair."),
    ("after.chat", "phone-chat-live / rs-thread-list-rows", "as before.chat"),
    ("before.terminal", "phone-ph2-terminal", "Node's shell profile list (`termProfiles`) from the desktop host"),
    ("after.terminal", "phone-ph2-terminal", "as before.terminal"),
    ("before.settings", "phone-ph2-settings-notify", "Node's settings blob (`readSettings`) from the desktop host"),
    ("after.settings", "phone-ph2-settings-notify", "as before.settings"),
    ("setup.setNotificationPreferences", "phone-ph2-settings-notify", "Node's roster reply to setNotificationPreferences; its preferences seed `Config`, the input of this test"),
    ("before.notifications", "phone-ph2-settings-notify", "Node's roster (`getNotificationPreferences`); only the device's preferences in it are compared, as what `Config` stores"),
    ("after.notifications", "phone-ph2-settings-notify", "as before.notifications"),
    ("after.notificationsAfterForget", "phone-ph2-settings-notify", "as before.notifications"),
    ("before.files.grant", "none: the Rust wire has no download-grant step", "Node's `fileDownloadAuthorize`; the core has one `transfer/beginRead`"),
    ("before.files.unbegun", "none: the Rust wire has no download-grant step", "as before.files.grant"),
    ("after.files.begin", "none: the Rust wire has no download-grant step", "Node's `fileDownloadBegin` of the revoked grant (refused); the core has one `transfer/beginRead`"),
    ("before.files.transfer", "none: the Rust wire has no download-grant step", "Node's transfer-begin reply (media shape); here only its size is compared, as an open transfer"),
    // `feedEvents` is not a frame path: Node sends a compact session-state frame `{e:"T",s,w:{r,ip:{p,a:[row]}}}` to a phone still attached.
    // The core has no encoder of it (its feed is the thread feed's own protocol); an owner would need that compact encoder on the phone link.
];

/// What Node's desktop did across an unpair of a paired phone, recorded through its real unpair handler (`unpair-access.json`), replayed
/// over the composed wiring and the real services that hold a device's state (the remote access service, the workspace and its one-file
/// grants and transfers, the notification preferences in `Config`): the same phone connection throughout. A frame is the whole frame the
/// phone received (`node_of` of what the core writes) against the recorded one, after the same replacement of the values that differ
/// between two Node runs. A revoked phone keeps its credential, so its native and Web Push registrations answer as before; only its
/// screen is refused. The registrations and notification preferences go when, and only when, the relay confirmed the unpair; a grant the
/// attached connection holds stays with it and a new connection of the device holds none.
///
/// What is not replayed is named, with its owner, in `NOT_REPLAYED`; the test fails when a recorded frame is neither replayed nor named.
#[tokio::test(flavor = "multi_thread")]
async fn an_unpair_leaves_a_revoked_phone_everything_but_the_screen_as_nodes_desktop_did() {
    let all: Value = serde_json::from_str(UNPAIR_ACCESS).unwrap();
    let token = all["token"].as_str().unwrap();
    assert_eq!(all["credential"], CRED);
    let scenarios = all["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 2, "every recorded scenario is replayed below");
    let native = json!({ "platform": "fcm", "token": token, "publicKey": PUSH_KEY });
    let web = json!({ "endpoint": PUSH_ENDPOINT, "p256dh": PUSH_KEY, "auth": "AAAAAAAAAAAAAAAAAAAAAA", "clientId": CRED });

    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let confirms = scenario["relayConfirms"].as_bool().unwrap();
        let after = &scenario["after"];
        let h = Harness::start(confirms).await;
        let mut canon = Canon::new(&all["remapped"], h.dir.path());
        let mut replayed: Vec<&str> = Vec::new();
        let (mut phone, connection) = h.connect("p1", CRED).await;
        let credential = phone_credential(h.registry.clone());
        let download = h.dir.path().join("unpair-download.txt");
        std::fs::write(&download, "unpair download").unwrap();

        // One call over `phone`: the frame the core wrote for it, in Node's shape, replaced as Node's was, against the recorded one.
        macro_rules! replay {
            ($phone:expr, $path:expr, $method:expr, $params:expr) => {{
                let recorded = at(scenario, $path);
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
        let source = json!({ "kind": "granted", "accessToken": link[2], "projectPath": link[0], "relPath": link[1] });
        phone.send(&json!({ "id": 5000, "method": "transfer/beginRead", "params": { "source": source } }).to_string());
        let began = answer(&mut phone, 5000).await;
        assert_eq!(&began["result"]["size"], at(scenario, "before.files.transfer.value.size"), "{name}: an open transfer of the file");
        let transfer = began["result"]["transferId"].clone();

        let chat_before = {
            phone.send(&json!({ "id": 5100, "method": "thread/list", "params": {} }).to_string());
            answer(&mut phone, 5100).await
        };
        assert_eq!((&scenario["before"]["chat"]["ok"], &after["chat"]["ok"]), (&json!(true), &json!(true)), "{name}: Node answers the chat call before and after");
        // The unpair: the phone is sent nothing and nothing closes.
        let sent = phone.arrived().await;
        let outcome = h.runtime.revoke_client(CRED).await;
        assert_eq!(scenario["revokeOutcome"].as_str().unwrap().starts_with("rejected"), outcome.is_err(), "{name}");
        assert_eq!(scenario["desktopClosedPhone"], Value::Null);
        assert_eq!(phone.arrived().await, sent, "{name}: the unpair sent the phone nothing and closed nothing");

        // The connection the phone's next calls go over: the same one, unless the relay ended its leg.
        let attached = scenario["phoneStillAttached"].as_bool().unwrap();
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
        replay!(*asks, "after.link.read", "projectFs/readText", read_link);
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
        } else {
            assert_eq!((&after["screen"], &after["secondConnection"]["screen"]), (&Value::Null, &Value::Null));
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
        assert_eq!(scenario["feedEvents"].is_null(), confirms, "{name}: Node's feed reached only a phone still attached");
        // Every recorded group is replayed above or named in NOT_REPLAYED, and a named one still has its recorded frames.
        for path in all["order"].as_array().unwrap().iter().map(|path| path.as_str().unwrap()) {
            let recorded = at(scenario, path);
            let listed = NOT_REPLAYED.iter().any(|(named, _, _)| *named == path);
            if recorded.is_null() {
                // A phone that the unpair detached is sent no screen call, so those two paths hold no frame in that scenario.
                assert!(path.ends_with("screen") && !attached, "{name}: {path} has no recorded frame");
                assert!(!listed, "{name}: NOT_REPLAYED names {path}, which has no recorded frame");
                continue;
            }
            assert!(recorded["id"].is_u64() && recorded["ok"].is_boolean(), "{name}: {path} is not a recorded frame");
            assert_ne!(listed, replayed.contains(&path), "{name}: {path} must be replayed or named in NOT_REPLAYED, and not both");
        }
        for (named, _, _) in NOT_REPLAYED {
            assert!(all["order"].as_array().unwrap().iter().any(|path| path == named), "NOT_REPLAYED names {named}, which the recording does not hold");
        }
        let feed = &scenario["feedEvents"];
        assert!(feed.is_null() == confirms && feed.as_array().is_none_or(|frames| !frames.is_empty()), "{name}: the recorded feed frames NOT_REPLAYED names as `feedEvents`");
        h.runtime.close().await;
    }
}
