//! The window restore, the connections feed and the caller policy.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{ServerPortsView, ServerRestorePhase, ServerRestoreProgress};
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::FeedSource;
use mixdog_core_api::FeedView;
use mixdog_core_api::ScopedFeed;
use mixdog_core_api::ScopedFeeds;
use mixdog_core_api::call::{WindowRole, WindowScope};
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::mock::{FeedTap, MockLimits, MockScopedFeeds};
use mixdog_protocol::FeedId;
use mixdog_protocol::Origin;
use mixdog_rt::DurabilityIo;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::AttemptContext;
use mixdog_ssh::install_wire::RemoteBootstrapError;
use mixdog_ssh::session::{Progress, SessionPhase};
use serde_json::Value;
use tokio::sync::{Notify, broadcast, watch};
use tokio_util::sync::CancellationToken;

use crate::host_store::{SshHostRecord, SshHostSettings, SshHostStore};
use crate::link::LinkSpec;
use crate::link_machine::{LinkState, LinkViewState, ModelLogin};
use crate::paths::ConnectionsPaths;
use crate::policy::{self, Callers};
use crate::restore::{Restore, RestoreLinks, RestoreWindows};
use crate::view::{ConnectionsFeed, FeedLink, FeedLinks};
use crate::window_restore_store::WindowRestoreStore;

fn io() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

// ---- policy

#[derive(Clone, Copy, Debug)]
enum Kind {
    /// A connection that is no window and not the host.
    Plain,
    Main,
    Server(&'static str),
    Host,
}

fn context(kind: Kind) -> CallContext {
    let base = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
    let scope = |role| Some(WindowScope { id: "w".into(), role });
    match kind {
        Kind::Plain => base,
        Kind::Main => base.with_window(scope(WindowRole::Main)),
        Kind::Server(id) => base.with_window(scope(WindowRole::Server { connection_id: id.to_owned() })),
        Kind::Host => {
            let mut host = base;
            host.host_claimant = true;
            host
        }
    }
}

/// What the table says: M is the main window or the host, S the server window of the id, H the host only.
fn admitted(callers: Callers, kind: Kind, id: &str) -> bool {
    let main = matches!(kind, Kind::Main | Kind::Host);
    let server = matches!(kind, Kind::Server(own) if own == id);
    match callers {
        Callers::Main => main,
        Callers::MainOrServer => main || server,
        Callers::Server => server,
        Callers::Host => matches!(kind, Kind::Host),
    }
}

#[test]
fn restore_view_policy_table_covers_every_connections_method() {
    let protocol: BTreeSet<&str> = mixdog_app_protocol::methods::CLIENT_METHODS
        .iter()
        .map(|spec| spec.method)
        .filter(|method| method.starts_with("connections/") || method.starts_with("remoteHosts/"))
        .collect();
    let table: BTreeSet<&str> = policy::methods().collect();
    assert_eq!(table, protocol, "the policy names exactly the connections and remoteHosts methods");
}

#[test]
fn restore_view_policy_every_method_admits_exactly_its_callers() {
    let kinds = [Kind::Plain, Kind::Main, Kind::Server("a"), Kind::Server("b"), Kind::Host];
    for method in policy::methods() {
        let callers = policy::callers(method).expect("a method of the table");
        for kind in kinds {
            for id in ["a", "b"] {
                let result = policy::authorize(&context(kind), method, Some(id));
                assert_eq!(result.is_ok(), admitted(callers, kind, id), "{method} for {kind:?} naming {id}");
            }
        }
    }
}

#[test]
fn restore_view_policy_unknown_method_is_refused() {
    assert!(policy::authorize(&context(Kind::Host), "thread/list", None).is_err());
}

#[test]
fn restore_view_policy_server_window_cannot_manage_hosts() {
    let server = context(Kind::Server("a"));
    for method in ["connections/ssh/list", "connections/ssh/connect", "connections/ssh/forget", "connections/restore/set", "remoteHosts/list"] {
        assert!(matches!(policy::authorize(&server, method, None), Err(CoreError::PermissionDenied { .. })), "{method}");
        assert!(policy::authorize(&server, method, Some("a")).is_err(), "{method} naming its own id");
    }
    assert!(policy::require_main(&server, "connections/ssh/list").is_err());
}

#[test]
fn restore_view_policy_server_window_own_id_only() {
    let server = context(Kind::Server("a"));
    assert!(policy::require_server(&server, "connections/ports/forward", "a").is_ok());
    assert!(policy::require_server(&server, "connections/ports/forward", "b").is_err());
    assert!(policy::require_main_or_server(&server, "connections/link/get", "a").is_ok());
    assert!(policy::require_main_or_server(&server, "connections/link/get", "b").is_err());
    // A call that names no id is the window's own.
    assert!(policy::authorize(&server, "connections/link/get", None).is_ok());
    assert_eq!(policy::subscription_scope(&server, "connections/subscribe", None).unwrap(), Some("a".to_owned()));
    assert_eq!(policy::subscription_scope(&server, "connections/subscribe", Some("a")).unwrap(), Some("a".to_owned()));
    assert!(policy::subscription_scope(&server, "connections/subscribe", Some("b")).is_err());
    assert!(policy::subscription_scope(&context(Kind::Plain), "connections/subscribe", None).is_err());
}

#[test]
fn restore_view_policy_main_allowed() {
    for kind in [Kind::Main, Kind::Host] {
        let ctx = context(kind);
        assert!(policy::require_main(&ctx, "connections/ssh/list").is_ok());
        assert!(policy::require_main_or_server(&ctx, "connections/link/get", "any").is_ok());
        assert_eq!(policy::subscription_scope(&ctx, "connections/subscribe", None).unwrap(), None);
        assert_eq!(policy::subscription_scope(&ctx, "connections/subscribe", Some("a")).unwrap(), Some("a".to_owned()));
    }
    assert!(policy::require_main(&context(Kind::Plain), "connections/ssh/list").is_err());
}

#[test]
fn restore_view_policy_host_only_endpoint() {
    assert!(policy::authorize(&context(Kind::Host), "connections/endpoint", Some("a")).is_ok());
    for kind in [Kind::Main, Kind::Server("a"), Kind::Plain] {
        assert!(policy::authorize(&context(kind), "connections/endpoint", Some("a")).is_err(), "{kind:?}");
        assert!(policy::require_host(&context(kind), "connections/endpoint").is_err(), "{kind:?}");
    }
    assert!(policy::require_host(&context(Kind::Host), "connections/endpoint").is_ok());
}

// ---- restore

fn record(id: &str, target: &str) -> SshHostRecord {
    SshHostRecord { id: id.to_owned(), name: format!("name-{id}"), target: target.to_owned(), last_connected_at: None, settings: None }
}

async fn stores(dir: &Path, saved: Vec<SshHostRecord>, remembered: &[&str]) -> (Arc<SshHostStore>, Arc<WindowRestoreStore>) {
    let paths = ConnectionsPaths::new(dir);
    let hosts = Arc::new(SshHostStore::load(&paths, io()).await);
    for record in saved {
        hosts.save(record).await.unwrap();
    }
    let store = Arc::new(WindowRestoreStore::new(&paths, io()));
    for id in remembered {
        store.remember(id).await.unwrap();
    }
    (hosts, store)
}

#[derive(Default)]
struct Links {
    /// The failure message of the servers whose connect fails.
    fail: HashMap<String, String>,
    /// Reported by every connect before it settles.
    phases: Vec<SessionPhase>,
    /// A server whose connect waits for this after reporting its phases.
    held: Option<(String, Arc<Notify>)>,
    opened: Mutex<Vec<(String, bool, Option<String>)>>,
}

#[async_trait]
impl RestoreLinks for Links {
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        let cwd = context.settings.as_ref().and_then(|settings| settings.remote_cwd.clone());
        self.opened.lock().unwrap().push((spec.id.clone(), context.askpass.is_none(), cwd));
        if let Some(progress) = &progress {
            for phase in &self.phases {
                progress(phase.clone());
            }
        }
        if let Some((id, gate)) = &self.held {
            if *id == spec.id {
                gate.notified().await;
            }
        }
        match self.fail.get(&spec.id) {
            Some(message) => Err(ConnectError::Bootstrap(RemoteBootstrapError { code: "failed".into(), message: message.clone(), detail: None })),
            None => Ok(()),
        }
    }
}

#[derive(Default)]
struct Windows {
    refuse: HashMap<String, String>,
    opened: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl RestoreWindows for Windows {
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String> {
        match self.refuse.get(connection_id) {
            Some(message) => Err(message.clone()),
            None => {
                self.opened.lock().unwrap().push((connection_id.to_owned(), name.to_owned()));
                Ok(())
            }
        }
    }
}

fn sorted<T: Ord>(mut list: Vec<T>) -> Vec<T> {
    list.sort();
    list
}

#[tokio::test]
async fn restore_view_policy_reopens_remembered_saved_servers_in_batch_mode() {
    let dir = tempfile::tempdir().unwrap();
    let mut with_folder = record("a", "one.example.com");
    with_folder.settings = Some(SshHostSettings { remote_cwd: Some("~/work".into()), ..SshHostSettings::default() });
    let (hosts, store) = stores(dir.path(), vec![with_folder, record("b", "two.example.com"), record("c", "three.example.com")], &["a", "b", "gone"]).await;
    let (links, windows) = (Arc::new(Links::default()), Arc::new(Windows::default()));
    let restore = Restore::new(store.clone(), hosts);

    restore.run(links.clone(), windows.clone()).await.unwrap();

    let opened = sorted(links.opened.lock().unwrap().clone());
    assert_eq!(opened, [("a".to_owned(), true, Some("~/work".to_owned())), ("b".to_owned(), true, None)], "every remembered saved server, batch mode, its settings");
    assert_eq!(sorted(windows.opened.lock().unwrap().clone()), [("a".to_owned(), "name-a".to_owned()), ("b".to_owned(), "name-b".to_owned())]);
    assert!(restore.progress().borrow().is_empty(), "a ready reopening leaves the list");
    assert_eq!(store.list().await.unwrap(), ["a", "b"], "a server no longer saved is forgotten");
}

#[test]
fn restore_view_policy_attempt_context_writes_the_target_diagnostics_ring() {
    let context = crate::restore::attempt_context(&record("a", "user@one.example.com:2222"));
    let target = mixdog_ssh::command::parse_ssh_target("user@one.example.com:2222").unwrap();
    assert_eq!(context.diagnostics_key, Some(mixdog_ssh::diagnostics::diagnostics_key_for(&target)), "the ring connections/ssh/diagnosticsLog reads");
    assert!(context.askpass.is_none(), "batch mode");
}

#[tokio::test]
async fn restore_view_policy_setting_off_reopens_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (hosts, store) = stores(dir.path(), vec![record("a", "one.example.com")], &["a"]).await;
    store.set_enabled(false).await.unwrap();
    let (links, windows) = (Arc::new(Links::default()), Arc::new(Windows::default()));

    Restore::new(store.clone(), hosts).run(links.clone(), windows.clone()).await.unwrap();

    assert!(links.opened.lock().unwrap().is_empty());
    assert!(windows.opened.lock().unwrap().is_empty());
    assert_eq!(store.list().await.unwrap(), ["a"], "the remembered windows are kept for the next time the setting is on");
}

#[tokio::test]
async fn restore_view_policy_failed_reopening_stays_with_its_message() {
    let dir = tempfile::tempdir().unwrap();
    let (hosts, store) = stores(dir.path(), vec![record("a", "one.example.com"), record("b", "two.example.com"), record("c", "three.example.com")], &["a", "b", "c"]).await;
    let links = Arc::new(Links { fail: HashMap::from([("a".to_owned(), "Permission denied".to_owned())]), ..Links::default() });
    let windows = Arc::new(Windows { refuse: HashMap::from([("c".to_owned(), "The window did not open.".to_owned())]), ..Windows::default() });
    let restore = Restore::new(store, hosts);

    restore.run(links, windows.clone()).await.unwrap();

    let mut rows = restore.progress().borrow().clone();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    let failed = |id: &str, message: &str| ServerRestoreProgress {
        id: id.to_owned(),
        name: format!("name-{id}"),
        phase: ServerRestorePhase::Failed,
        message: Some(message.to_owned()),
    };
    assert_eq!(rows, [failed("a", "Permission denied"), failed("c", "The window did not open.")]);
    assert_eq!(windows.opened.lock().unwrap().clone(), [("b".to_owned(), "name-b".to_owned())], "only the ready link gets its window");
}

#[tokio::test]
async fn restore_view_policy_progress_follows_the_connect_phases() {
    let dir = tempfile::tempdir().unwrap();
    let (hosts, store) = stores(dir.path(), vec![record("a", "one.example.com")], &["a"]).await;
    let gate = Arc::new(Notify::new());
    let links = Arc::new(Links {
        phases: vec![SessionPhase::Check { detail: "linux-x64".into() }, SessionPhase::Install, SessionPhase::Start, SessionPhase::Ready],
        held: Some(("a".to_owned(), gate.clone())),
        ..Links::default()
    });
    let restore = Arc::new(Restore::new(store, hosts));
    let mut progress = restore.progress();
    let running = {
        let (restore, windows) = (restore.clone(), Arc::new(Windows::default()));
        tokio::spawn(async move { restore.run(links, windows).await })
    };

    // The link's own `Ready` is not the reopening's: the row stays at `start` until the window is open too.
    let row = progress.wait_for(|rows| rows.iter().any(|row| row.phase == ServerRestorePhase::Start)).await.unwrap().clone();
    assert_eq!((row[0].id.as_str(), row[0].name.as_str(), row[0].message.as_deref()), ("a", "name-a", None));
    gate.notify_one();
    running.await.unwrap().unwrap();
    assert!(progress.borrow().is_empty());
}

// ---- the feed

/// Creates mock feeds and keeps each one in the order it was made (every feed of the connections feed has the same id).
struct Recording {
    inner: MockScopedFeeds,
    made: Mutex<Vec<Arc<dyn ScopedFeed>>>,
}

impl Recording {
    fn new() -> Arc<Self> {
        Arc::new(Self { inner: MockScopedFeeds::new(MockLimits::default()), made: Mutex::new(Vec::new()) })
    }

    fn made(&self, at: usize) -> Arc<dyn ScopedFeed> {
        self.made.lock().unwrap()[at].clone()
    }
}

impl ScopedFeeds for Recording {
    fn create(&self, id: FeedId, view: Arc<dyn FeedView>) -> Arc<dyn ScopedFeed> {
        let feed = self.inner.create(id, view);
        self.made.lock().unwrap().push(feed.clone());
        feed
    }
}

struct FakeLink {
    view: watch::Sender<LinkViewState>,
    ports: watch::Sender<ServerPortsView>,
}

impl FakeLink {
    fn new(id: &str) -> Arc<Self> {
        let state = LinkViewState {
            connection_id: id.to_owned(),
            state: LinkState::Connected,
            rtt_ms: Some(12),
            terminals_available: true,
            model_login: ModelLogin::Pc,
        };
        let ports = ServerPortsView { detected: None, scan_error: None, forwards: Vec::new(), suggested: Vec::new() };
        Arc::new(Self { view: watch::channel(state).0, ports: watch::channel(ports).0 })
    }
}

impl FeedLink for FakeLink {
    fn link_view(&self) -> watch::Receiver<LinkViewState> {
        self.view.subscribe()
    }

    fn ports_view(&self) -> watch::Receiver<ServerPortsView> {
        self.ports.subscribe()
    }
}

struct FakeLinks {
    links: Mutex<HashMap<String, Arc<FakeLink>>>,
    attached: broadcast::Sender<String>,
}

impl FakeLinks {
    fn new(ids: &[&str]) -> Arc<Self> {
        let links = ids.iter().map(|id| ((*id).to_owned(), FakeLink::new(id))).collect();
        Arc::new(Self { links: Mutex::new(links), attached: broadcast::channel(8).0 })
    }

    fn link(&self, id: &str) -> Arc<FakeLink> {
        self.links.lock().unwrap()[id].clone()
    }
}

impl FeedLinks for FakeLinks {
    fn get(&self, id: &str) -> Option<Arc<dyn FeedLink>> {
        self.links.lock().unwrap().get(id).map(|link| link.clone() as Arc<dyn FeedLink>)
    }

    fn ids(&self) -> Vec<String> {
        self.links.lock().unwrap().keys().cloned().collect()
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.attached.subscribe()
    }
}

/// The keys a tap has heard of: the sections of a snapshot and the keys of the updates (a removed key is taken back).
fn keys(notes: &[Value]) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for note in notes {
        let params = &note["params"];
        match note["method"].as_str() {
            Some("feed/snapshot") => {
                for section in params["state"]["sections"].as_array().into_iter().flatten() {
                    keys.insert(section["key"].as_str().unwrap().to_owned());
                }
            }
            Some("connections/updated") => {
                let key = params["key"].as_str().unwrap().to_owned();
                if params["removed"] == Value::Bool(true) {
                    keys.remove(&key);
                } else {
                    keys.insert(key);
                }
            }
            _ => {}
        }
    }
    keys
}

fn set(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

struct Rig {
    _dir: tempfile::TempDir,
    feeds: Arc<Recording>,
    links: Arc<FakeLinks>,
    feed: ConnectionsFeed,
}

async fn rig(link_ids: &[&str]) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let (hosts, store) = stores(dir.path(), vec![record("a", "one.example.com")], &[]).await;
    let (feeds, links) = (Recording::new(), FakeLinks::new(link_ids));
    let restore = Restore::new(store.clone(), hosts.clone());
    let feed = ConnectionsFeed::start(feeds.clone(), links.clone(), hosts, store, &restore);
    Rig { _dir: dir, feeds, links, feed }
}

/// The latest value a tap heard for a key: from a snapshot's sections or an update.
fn value_of(notes: &[Value], key: &str) -> Option<Value> {
    let mut latest = None;
    for note in notes {
        let params = &note["params"];
        let sections = params["state"]["sections"].as_array().into_iter().flatten().chain(std::iter::once(params));
        for section in sections.filter(|section| section["key"] == key) {
            latest = section.get("value").cloned();
        }
    }
    latest
}

#[tokio::test]
async fn restore_view_policy_feed_carries_hosts_restore_link_and_ports() {
    let rig = rig(&["a"]).await;
    let tap = FeedTap::attach(&rig.feeds.made(0));
    let notes = tap.notifications_until(|notes| keys(notes) == set(&["hosts", "restore", "link/a", "ports/a"])).await;

    let hosts = value_of(&notes, "hosts").unwrap();
    assert_eq!(hosts.as_array().unwrap().len(), 1);
    assert_eq!((hosts[0]["id"].as_str(), hosts[0]["open"].as_bool()), (Some("a"), Some(true)), "the server has a link");
    assert_eq!(value_of(&notes, "restore").unwrap(), serde_json::json!({ "enabled": true, "progress": [] }));
    assert_eq!(value_of(&notes, "link/a").unwrap()["state"]["status"], "connected");
    assert_eq!(value_of(&notes, "ports/a").unwrap()["forwards"], serde_json::json!([]));
}

#[tokio::test]
async fn restore_view_policy_feed_publishes_a_link_state_change() {
    let rig = rig(&["a"]).await;
    let tap = FeedTap::attach(&rig.feeds.made(0));
    tap.notifications_until(|notes| keys(notes).contains("link/a")).await;

    rig.links.link("a").view.send_modify(|view| {
        view.state = LinkState::Lost { terminal: true, code: "host-key".into(), message: "changed".into(), settings_required: true };
    });
    let notes = tap
        .notifications_until(|notes| notes.iter().any(|note| note["params"]["key"] == "link/a" && note["params"]["value"]["state"]["status"] == "lost"))
        .await;
    let update = notes.iter().rev().find(|note| note["params"]["key"] == "link/a").unwrap();
    assert_eq!(update["params"]["value"]["state"]["settingsRequired"], true);
    assert_eq!(update["params"]["section"], "connections");
}

#[tokio::test]
async fn restore_view_policy_feed_for_one_connection_carries_its_keys_and_the_shared_ones() {
    let rig = rig(&["a", "b"]).await;
    let scoped = rig.feed.source(Some("a"));
    assert_eq!(scoped.feed_id(), FeedId("connections".to_owned()));
    let tap = FeedTap::attach(&rig.feeds.made(1));
    let notes = tap.notifications_until(|notes| keys(notes).len() >= 4).await;
    assert_eq!(keys(&notes), set(&["hosts", "restore", "link/a", "ports/a"]), "the shared keys, and no other server");

    // What happens to another server does not reach it: the next thing it hears is its own change.
    rig.links.link("b").view.send_modify(|view| view.rtt_ms = Some(99));
    rig.links.link("a").view.send_modify(|view| view.rtt_ms = Some(7));
    let notes = tap.notifications_until(|notes| notes.iter().any(|note| note["params"]["value"]["rttMs"] == 7)).await;
    assert_eq!(keys(&notes), set(&["hosts", "restore", "link/a", "ports/a"]));
}

#[tokio::test]
async fn restore_view_policy_feed_for_one_connection_hears_the_host_list_change() {
    let rig = rig(&["a"]).await;
    rig.feed.source(Some("a"));
    let tap = FeedTap::attach(&rig.feeds.made(1));
    tap.notifications_until(|notes| keys(notes).contains("hosts")).await;

    rig.links.links.lock().unwrap().remove("a");
    rig.feed.reconcile();
    let notes = tap
        .notifications_until(|notes| notes.iter().any(|note| note["params"]["key"] == "hosts" && note["params"]["value"][0]["open"] == false))
        .await;
    assert!(notes.iter().any(|note| note["params"]["key"] == "hosts"));
}

#[tokio::test]
async fn restore_view_policy_feed_publishes_an_ended_link_as_removed() {
    let rig = rig(&["a"]).await;
    let tap = FeedTap::attach(&rig.feeds.made(0));
    tap.notifications_until(|notes| keys(notes).contains("link/a") && keys(notes).contains("ports/a")).await;

    rig.links.links.lock().unwrap().remove("a");
    rig.feed.reconcile();
    let notes = tap.notifications_until(|notes| !keys(notes).contains("link/a") && !keys(notes).contains("ports/a")).await;
    assert!(notes.iter().any(|note| note["params"]["key"] == "link/a" && note["params"]["removed"] == Value::Bool(true)));
}

#[tokio::test]
async fn restore_view_policy_feed_follows_a_link_that_attaches_later() {
    let rig = rig(&[]).await;
    let tap = FeedTap::attach(&rig.feeds.made(0));
    tap.notifications_until(|notes| keys(notes).contains("hosts")).await;

    let link = FakeLink::new("a");
    rig.links.links.lock().unwrap().insert("a".to_owned(), link);
    rig.feed.reconcile();
    tap.notifications_until(|notes| keys(notes).contains("link/a")).await;
}
