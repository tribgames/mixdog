//! The agent home over real stored state: sessions in the SQLite-indexed thread store under a
//! temp data dir, the real session directory and actors. A reset keeps the old conversation
//! durably as an archived thread that restores whole, and refuses a thread running a turn.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::AgentHomeSessions;
use mixdog_core_agents::agents::HomeDeps;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::state::SectionFeedState;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_rooms::rooms::service::KnownAgent;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::StoreThreads;
use mixdog_core_session::session::TaskWorkspace;
use mixdog_core_session::session::archive_trees::ArchiveTrees;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_edges::{LiveRows, ThreadDeletions, ThreadEdgePublisher, ThreadEdges};
use mixdog_core_session::session::thread_list::{ListOverlay, ListRooms, RowOverlay, ThreadListService};
use mixdog_core_session::session::thread_settings::ArchivedWorktrees;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_services::memory::session_search::ingest::IngestSession;
use mixdog_services::memory::session_search::ingest::StoredSessions;
use mixdog_store::sqlite::SqliteStore;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::RoomMembers;
use super::SessionHomeDeps;
use crate::run_host::directory_sessions::DirectorySessions;

struct Catalog;

#[async_trait]
impl AgentCatalog for Catalog {
    async fn agents(&self) -> Result<Vec<KnownAgent>, RoomError> {
        Ok(vec![KnownAgent { id: "ada".into(), route: json!({ "provider": "openai", "model": "gpt-x", "effort": "low" }) }])
    }

    async fn mixy_route(&self) -> Value {
        Value::Null
    }

    async fn mixy_created(&self) -> bool {
        false
    }

    /// Ada's definition is gone from the files; nobody else is known.
    async fn presence(&self, ids: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
        Ok(ids.iter().filter(|id| id.as_str() == "ada").map(|id| (id.clone(), Presence::Deleted)).collect())
    }

    async fn archived_name(&self, _: &str) -> String {
        "Ada Gone".into()
    }

    async fn task_workspace(&self) -> String {
        "/ws".into()
    }
}

/// The stored sessions: just the ones a test names.
struct Stored(Vec<String>);

#[async_trait]
impl StoredSessions for Stored {
    async fn session_ids(&self) -> mixdog_services::memory::error::Result<Vec<String>> {
        Ok(self.0.clone())
    }

    async fn record_stamp(&self, _: &str) -> mixdog_services::memory::error::Result<Option<String>> {
        Ok(None)
    }

    async fn read(&self, _: &str) -> Option<IngestSession> {
        None
    }
}

/// The rooms: the members that left, in order.
#[derive(Default)]
struct Rooms(std::sync::Mutex<Vec<String>>);

#[async_trait]
impl RoomMembers for Rooms {
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), RoomError> {
        self.0.lock().unwrap().push(agent_id.to_owned());
        Ok(())
    }
}

async fn real_store(data: &std::path::Path) -> (Arc<StoreThreads>, Arc<SqliteStore>) {
    use mixdog_core_api::domain::mock::MockOwnership;

    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let store = StoreThreads::over_data_dir(data, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store");
    (Arc::new(store), Arc::new(index))
}

struct World {
    _data: tempfile::TempDir,
    rig: Rig,
    store: Arc<StoreThreads>,
    index: Arc<SqliteStore>,
    directory: Arc<SessionDirectory>,
    state: Arc<dyn ThreadState>,
    deps: Arc<SessionHomeDeps>,
    rooms: Arc<Rooms>,
}

async fn world() -> World {
    let data = tempfile::tempdir().expect("data dir");
    let (store, index) = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let state: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
    let sessions = Arc::new(DirectorySessions::new(directory.clone(), state.clone()));
    let rooms = Arc::new(Rooms::default());
    let stored = Arc::new(Stored(vec!["sess_home_ada".into(), "sess_other".into()]));
    let deps = Arc::new(SessionHomeDeps::new(Arc::new(Catalog), sessions, directory.clone(), stored, rooms.clone()));
    World { _data: data, rig, store, index, directory, state, deps, rooms }
}

struct QuietCatalog;

impl ListOverlay for QuietCatalog {
    fn of(&self, _: &ThreadId) -> RowOverlay {
        RowOverlay::default()
    }
}

#[async_trait]
impl ListRooms for QuietCatalog {
    async fn with_rooms(&self, rows: Vec<mixdog_protocol::ThreadSummary>) -> Result<Vec<mixdog_protocol::ThreadSummary>, String> {
        Ok(rows)
    }

    async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
        Ok(Vec::new())
    }
}

#[async_trait]
impl TaskWorkspace for QuietCatalog {
    async fn path(&self) -> Result<String, String> {
        Ok("/ws".into())
    }
}

#[async_trait]
impl ArchivedWorktrees for QuietCatalog {
    async fn set_archived(&self, _: &[String], _: bool) -> Result<(), String> {
        Ok(())
    }
}

/// The real index and app feed, without a room or a model.
async fn catalog_feed(world: &World) -> (Arc<ThreadListService>, Arc<ThreadEdges>, mixdog_core_api::mock::MockConnection, Arc<SectionFeedState>) {
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::mock::{EchoView, MockConnection, MockFeed, MockLimits, epoch};

    world.rig.archive.bind_index(&world.index).await.expect("bind archive index");
    let limits = MockLimits::default();
    let feed = Arc::new(MockFeed::new("app".into(), epoch(1), Arc::new(EchoView), limits));
    let app = MockConnection::new(ConnectionId(1), limits);
    let source: Arc<dyn FeedSource> = feed.clone();
    let attached =
        mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).expect("subscribe to the app feed");
    mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).expect("release the feed");
    drop(app.drain_text());

    let section = Arc::new(SectionFeedState::new(feed));
    let quiet = Arc::new(QuietCatalog);
    let list = Arc::new(ThreadListService::new(world.index.clone(), quiet.clone(), quiet.clone(), quiet.clone()));
    list.fence(world.store.clone());
    let edges = ThreadEdges::start(ThreadEdgePublisher::new(list.clone(), section.clone(), ThreadDeletions::new(section.clone()), quiet));
    world.index.observe_rows(edges.clone()).expect("observe the index");
    world.directory.set_live_rows(LiveRows::new(list.clone(), section.clone(), edges.clone())).expect("bind the live rows");
    (list, edges, app, section)
}

fn app_frames(app: &mixdog_core_api::mock::MockConnection) -> Vec<Value> {
    app.drain_text().into_iter().map(|text| serde_json::from_str(&text[text.find('{').expect("JSON body")..]).unwrap()).collect()
}

fn connection() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

async fn read(directory: &SessionDirectory, id: &str) -> Value {
    let thread = ThreadId::from(id);
    let handle = directory.open_handle(&thread, &connection()).await.expect("opens");
    let request = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": thread }), op: None, ctx: connection() };
    match handle.request(request).await.expect("thread/read") {
        Reply::Value(value) => value,
        other => panic!("not a value: {other:?}"),
    }
}

fn user_texts(view: &Value) -> Vec<String> {
    view["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "userMessage")
        .map(|item| item["content"][0]["text"].as_str().unwrap().to_owned())
        .collect()
}

/// Waits for `probe` to hold, woken by every step of the thread's actor (the state the probes read
/// is set inside one); nothing on the clock judges the wait. The signal is registered before each
/// probe, so a step during the probe is not missed.
async fn eventually(thread: &mixdog_core_session::session::SessionHandle, mut probe: impl AsyncFnMut() -> bool) {
    loop {
        let stepped = thread.stepped().notified();
        tokio::pin!(stepped);
        stepped.as_mut().enable();
        if probe().await {
            return;
        }
        stepped.await;
    }
}

/// One user turn in the home thread.
async fn talk(world: &World, id: &str, prompt: &str) {
    let thread = ThreadId::from(id);
    let handle = world.directory.open_handle(&thread, &connection()).await.expect("opens");
    let op = OpId::from(uuid::Uuid::now_v7().to_string());
    let params = json!({ "threadId": thread, "opId": op.as_str(), "input": { "prompt": prompt } });
    handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: connection() }).await.expect("turn/start");
    eventually(&handle, async || user_texts(&read(&world.directory, id).await).len() == 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_is_refused_while_the_home_thread_runs_a_turn_and_keeps_the_conversation() {
    let world = world().await;
    world.rig.set_script(Arc::new(|_run| Box::pin(std::future::pending())));
    let homes = AgentHomeSessions::new(world.deps.clone());
    let home = homes.open("ada").await.expect("opens")["sessionId"].as_str().unwrap().to_owned();
    talk(&world, &home, "still working").await;
    let thread = world.directory.handle(&ThreadId::from(home.as_str())).expect("the home thread is loaded");
    eventually(&thread, async || world.deps.turn_in_progress(&ThreadId::from(home.as_str())).await.unwrap()).await;

    let refused = homes.reset("ada").await.expect_err("a running turn refuses the reset");
    assert!(format!("{refused:?}").contains("wait for it to finish before resetting the conversation"), "{refused:?}");
    assert_eq!(user_texts(&read(&world.directory, &home).await), ["still working"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_deps_read_the_catalog_and_report_a_missing_session_as_unavailable() {
    let world = world().await;
    let agents = world.deps.list_agents().await.unwrap();
    assert_eq!(
        agents,
        json!([{ "id": "ada", "custom": true, "kind": "bot", "disabled": false, "route": { "provider": "openai", "model": "gpt-x", "effort": "low" } }])
    );
    let missing = world.deps.read_session("sess_nowhere").await.unwrap_err();
    assert_eq!(missing.message, "Session sess_nowhere is not available");
    assert_eq!(missing.code.as_deref(), Some("SESSION_NOT_AVAILABLE"));
    let id = world.deps.mint_archive_id();
    assert!(id.starts_with("sess_") && id.len() > 40 && id != world.deps.mint_archive_id());
}

/// The retirement mark is a positive stamp in the header (`retiredAt`), which the thread rows read.
fn stamped(header: &mixdog_store::schema::record::Header, key: &str) -> bool {
    header.get(key).and_then(Value::as_f64).is_some_and(|at| at > 0.0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_keeps_the_old_conversation_archived_durable_and_restorable() {
    let world = world().await;
    let homes = AgentHomeSessions::new(world.deps.clone());
    let opened = homes.open("ada").await.expect("opens");
    let home = opened["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(home, "sess_home_ada");
    talk(&world, &home, "write a haiku").await;
    let thread = world.directory.handle(&ThreadId::from(home.as_str())).expect("the home thread is loaded");
    eventually(&thread, async || read(&world.directory, &home).await["state"]["runtime"]["busy"] != json!(true)).await;

    let reset = homes.reset("ada").await.expect("resets");
    assert_eq!(reset["sessionId"], json!(home));
    let archive = reset["archivedSessionId"].as_str().expect("the conversation had a user turn").to_owned();
    assert!(archive.starts_with("sess_") && archive != home);

    // The home thread starts over; its old conversation sits in the archive copy.
    assert!(user_texts(&read(&world.directory, &home).await).is_empty());
    assert!(archived(&world.rig, &archive, &world.state.header(&ThreadId::from(archive.as_str())).await.unwrap()));

    // Durable: a fresh directory over the same stored state reads the archive whole and the home emptied.
    let reopened = SessionDirectory::new(world.rig.deps_on(world.store.clone()));
    assert_eq!(user_texts(&read(&reopened, &archive).await), ["write a haiku"]);
    assert!(user_texts(&read(&reopened, &home).await).is_empty());

    // Restorable: unarchiving brings the whole conversation back as a live thread.
    world.deps.set_archived(&archive, false).await.expect("restores");
    assert!(!archived(&world.rig, &archive, &world.state.header(&ThreadId::from(archive.as_str())).await.unwrap()));
    let restored = SessionDirectory::new(world.rig.deps_on(world.store.clone()));
    assert_eq!(user_texts(&read(&restored, &archive).await), ["write a haiku"]);

    // An empty conversation keeps no copy.
    let again = homes.reset("ada").await.expect("resets again");
    assert_eq!(again, json!({ "sessionId": home, "archivedSessionId": null }));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_agents_home_is_archived_and_named_then_brought_back_by_a_restore() {
    let world = world().await;
    let homes = AgentHomeSessions::new(world.deps.clone());
    let home = homes.open("ada").await.expect("opens")["sessionId"].as_str().unwrap().to_owned();
    let header = || async { world.state.header(&ThreadId::from(home.as_str())).await.unwrap() };
    // The stored ids, then a session the process holds that is not stored yet.
    world.deps.create_session("sess_live_only", &json!({ "provider": "openai", "model": "gpt-x" })).await.unwrap();
    assert_eq!(world.deps.known_session_ids().await.unwrap(), ["sess_home_ada", "sess_other", "sess_live_only"]);
    assert!(homes.has_home("ada").await.unwrap() && !homes.has_home("bob").await.unwrap());

    homes.retire(&["ada".into(), "lead".into()]).await.expect("retires");
    let retired = header().await;
    assert!(archived(&world.rig, &home, &retired) && stamped(&retired, "retiredAt"), "the thread rows read these two stamps: {retired:?}");
    assert_eq!(world.rooms.0.lock().unwrap().as_slice(), ["ada"], "the deletion is proven once, and Mixy is never retired");

    // A reconcile after the transition archives nothing again.
    world.deps.set_archived(&home, false).await.unwrap();
    homes.reconcile().await.expect("reconciles");
    assert!(!archived(&world.rig, &home, &header().await), "a hand-restored home stays restored");

    homes.restore("ada").await.expect("restores");
    let restored = header().await;
    assert!(!archived(&world.rig, &home, &restored) && !stamped(&restored, "retiredAt"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restoring_a_deleted_bot_replaces_its_archived_catalog_row_on_the_open_app_feed() {
    let world = world().await;
    let (list, edges, app, _) = catalog_feed(&world).await;
    let homes = AgentHomeSessions::new(world.deps.clone());
    let opened = homes.open("ada").await.expect("opens");
    let home = opened["sessionId"].as_str().unwrap();
    let id = ThreadId::from(home);
    homes.retire(&["ada".into()]).await.expect("archives the deleted bot");
    let archived = serde_json::to_value(list.summary(&id).await.unwrap().expect("archived catalog row")).unwrap();
    assert_eq!(archived["archived"], true);
    assert_eq!(archived["agentDeleted"], true);
    edges.settled().await;
    drop(app.drain_text());

    homes.restore("ada").await.expect("restores");
    // Like the open sidebar, take only feed updates after restore; do not list again.
    let restored = app_frames(&app)
        .into_iter()
        .filter(|frame| frame["method"] == "thread/summary/updated" && frame["params"]["thread"]["id"] == home)
        .map(|frame| frame["params"]["thread"].clone())
        .last()
        .expect("the restored home is on the app feed before the operation answers");
    assert_ne!(restored["archived"], true);
    assert_ne!(restored["agentDeleted"], true);
    assert_eq!(restored["title"], archived["title"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reopening_an_unchanged_bot_after_public_archive_restores_its_row_on_the_open_feed() {
    let world = world().await;
    let (list, edges, app, section) = catalog_feed(&world).await;
    let homes = AgentHomeSessions::new(world.deps.clone());
    let opened = homes.open("ada").await.expect("opens");
    let home = opened["sessionId"].as_str().unwrap();
    let id = ThreadId::from(home);
    world.state.patch_header(&id, json!({"title": "Ada's conversation"}).as_object().unwrap().clone(), Vec::new()).await.expect("give the home a catalog row");
    assert!(list.summary(&id).await.unwrap().is_some());
    edges.settled().await;
    let active = app_frames(&app).into_iter()
        .filter(|frame| frame["params"]["thread"]["id"] == home)
        .last().expect("the listener has a full active row")["params"]["thread"].clone();
    assert_ne!(active["archived"], true);

    // The public thread/archive handler uses set_manual; it announces a flag, not a full row.
    let trees = ArchiveTrees::new(world.directory.clone(), world.index.clone(), section, Arc::new(QuietCatalog), Arc::default());
    assert!(trees.set_manual(&id, true).await.expect("public archive committed"));
    edges.settled().await;
    let archived = app_frames(&app);
    assert!(archived.iter().any(|frame| frame["method"] == "thread/archived" && frame["params"]["threadId"] == home));
    assert!(!archived.iter().any(|frame| frame["params"]["thread"]["id"] == home));

    assert_eq!(homes.open("ada").await.expect("reopens"), opened);
    let restored: Vec<_> = app_frames(&app)
        .into_iter()
        .filter(|frame| frame["method"] == "thread/summary/updated" && frame["params"]["thread"]["id"] == home)
        .map(|frame| frame["params"]["thread"].clone())
        .collect();
    assert_eq!(restored, [active], "the identical active row must replace the archived one without another listing");
}

/// The archive mark as the archive authority resolves it over the header.
fn archived(rig: &mixdog_core_session::session::testing::Rig, id: &str, header: &mixdog_store::schema::record::Header) -> bool {
    rig.archive.resolve(id, header.get("archivedAt")).archived()
}
