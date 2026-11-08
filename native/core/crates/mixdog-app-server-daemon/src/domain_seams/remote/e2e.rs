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
use mixdog_app_server::AppServer;
use mixdog_app_server::Outgoing;
use mixdog_app_server_transport::ConnectionHub;
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
struct Core {
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
        if self.screen.methods().contains(&method) {
            return Some(self.screen.as_ref());
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
    reads: Arc<AtomicUsize>,
    /// `turn/start` params that reached the thread.
    turns: Arc<Mutex<Vec<Value>>>,
    closed: watch::Receiver<Vec<ConnectionId>>,
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
        let screen = Arc::new(ScreenSessions::new(remote.registry.clone()));
        let owners = ConnectionOwners::of(vec![screen.clone() as Arc<dyn ConnectionOwner>, remote.registry.clone()]);
        let (closed_tx, closed) = watch::channel(Vec::new());
        let core = Arc::new(Core { mock, screen, registry: remote.registry.clone(), owners, closed: closed_tx });
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let origins = hub.clone();
        let server = AppServer::new(core.clone(), Outgoing::new(), Arc::new(move |id| origins.origin_of(id)), crate::server::server_config(Limits::default())).unwrap();
        late_dialer
            .bind(hub, Arc::new(move |accepted| crate::server::spawn_drive(server.clone(), accepted)), remote.registry.clone())
            .unwrap();
        start_remote(&remote, published.clone()).await;

        // The relay answers the boot's leg, the roster names the paired device.
        relay.legs.recv().await.expect("the relay ended");
        remote.runtime.watch_connected().wait_for(|up| *up).await.expect("the runtime ended");
        remote.runtime.list_clients().await.unwrap();
        Self { dir, core, registry: remote.registry, runtime: remote.runtime, published, relay, identity, reads, turns, closed }
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

    async fn closed(&self, connection: ConnectionId) {
        self.closed.clone().wait_for(|closed| closed.contains(&connection)).await.expect("the core ended");
    }

    async fn viewing(&self, wanted: &[&str]) {
        let wanted: Vec<String> = wanted.iter().map(|id| (*id).to_owned()).collect();
        self.published.remote_viewing.subscribe().wait_for(|ids| *ids == wanted).await.expect("the publisher ended");
    }
}

async fn answer(phone: &mut Phone, id: u64) -> Value {
    loop {
        let frame: Value = serde_json::from_str(&phone.recv().await).unwrap();
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
async fn an_unpaired_device_loses_its_connection_and_its_access_at_once() {
    let h = Harness::start(true).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;
    let credential_of = phone_credential(h.registry.clone());
    assert_eq!(credential_of(connection).as_deref(), Some(CRED), "a paired relay connection acts as its device (phone file grants)");
    assert_eq!(list(&mut phone, 1).await["result"], listed());

    h.runtime.revoke_client(CRED).await.unwrap();
    let revoke = h.relay.frame(|frame| frame["type"] == "revoke-client").await;
    assert_eq!(revoke["clientId"], CRED);
    assert_eq!(phone.closed().await, "device unpaired");
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
async fn an_unpair_the_relay_has_not_confirmed_still_refuses_the_device_on_every_connection() {
    let h = Harness::start(false).await;
    let (mut phone, connection) = h.connect("p1", CRED).await;

    assert!(h.runtime.revoke_client(CRED).await.is_err(), "the relay refused the unpair");
    assert_eq!(phone.closed().await, "device unpaired");
    h.closed(connection).await;

    // The unpair is recorded and in force: the device is refused before it is even challenged.
    let again = h.relay.open_peer("p2", CRED);
    let Event::Closed(reason) = again.next().await else { panic!("a device whose unpair is recorded was challenged") };
    assert_eq!(reason, "device unpaired");
    assert_eq!(h.core.mock.opened_connections().len(), 1);
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
