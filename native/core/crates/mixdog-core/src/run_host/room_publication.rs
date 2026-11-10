//! The wiring between the index writer, the app feed and the room service: a room call publishes the catalog as Node's
//! `deps.republishCatalog` does (`session-host.ts:353-356`, called by `agent-rooms.ts:289,312,333,345,388`): inside the call once a
//! listing has been answered, started and not awaited before that. The daemon's composition calls this; so do the tests that
//! prove the order.

use std::sync::Arc;

use mixdog_core_base::state::SectionFeedState;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;
use mixdog_core_rooms::rooms::sessions::Republish;
use mixdog_core_rooms::rooms::sessions::SessionOps;
use mixdog_core_rooms::rooms::sessions::SessionRoomHost;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::TaskWorkspace;
use mixdog_core_session::session::thread_edges::ThreadEdgePublisher;
use mixdog_core_session::session::thread_edges::ThreadEdges;
use mixdog_core_session::session::thread_list::RoomSummaries;
use mixdog_core_session::session::thread_list::ThreadListService;

pub struct RoomPublication {
    pub summaries: Arc<RoomSummaries>,
    pub host: Arc<SessionRoomHost>,
}

/// The index writer's row writes reach the app feed (`thread/started`, `thread/summary/updated`, `thread/deleted`), and the room
/// host publishes through the summaries ([`RoomSummaries::republish_catalog`]). Fails when the index already has a row sink.
pub fn wire<A>(
    thread_list: Arc<ThreadListService>,
    sections: Arc<SectionFeedState>,
    agents: Arc<A>,
    index: &mixdog_store::sqlite::SqliteStore,
    directory: Arc<SessionDirectory>,
    sessions: Arc<dyn SessionOps>,
) -> Result<RoomPublication, &'static str>
where
    A: TaskWorkspace + AgentCatalog + 'static,
{
    index.observe_rows(ThreadEdges::start(ThreadEdgePublisher::new(thread_list.clone(), sections.clone(), agents.clone())))?;
    let summaries = RoomSummaries::new(thread_list, sections, directory);
    let republish: Republish = {
        let summaries = summaries.clone();
        Arc::new(move || {
            let summaries = summaries.clone();
            Box::pin(async move { summaries.republish_catalog().await.map_err(|error| RoomError::Port(format!("{error:?}"))) })
        })
    };
    let sessions = Arc::new(RenameLists { sessions, summaries: summaries.clone() });
    let host = Arc::new(SessionRoomHost::new(agents, sessions, republish));
    Ok(RoomPublication { summaries, host })
}

/// The room sessions as Node's host serves them to the rooms: a room log's rename is the host's `renameSession`
/// (`session-host.ts:316`), which after the title awaits a whole catalog listing (`session-host-lifecycle.ts:225-233`); that listing
/// is what loads the catalog before a room create or rename publishes it (recorded: `fixtures/room-catalog-states`).
struct RenameLists {
    sessions: Arc<dyn SessionOps>,
    summaries: Arc<RoomSummaries>,
}

#[async_trait::async_trait]
impl SessionOps for RenameLists {
    async fn route(&self, session_id: &str) -> Result<Option<serde_json::Value>, RoomError> {
        self.sessions.route(session_id).await
    }
    async fn create(&self, session_id: &str, params: &serde_json::Value) -> Result<(), RoomError> {
        self.sessions.create(session_id, params).await
    }
    async fn set_route(&self, session_id: &str, route: &serde_json::Value) -> Result<(), RoomError> {
        self.sessions.set_route(session_id, route).await
    }
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError> {
        self.sessions.set_archived(session_id, archived).await
    }
    async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError> {
        self.sessions.is_retired(session_id).await
    }
    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError> {
        self.sessions.set_retired(session_id, retired).await
    }
    async fn rename(&self, session_id: &str, title: &str) -> Result<(), RoomError> {
        self.sessions.rename(session_id, title).await?;
        self.summaries.publish_catalogs().await;
        Ok(())
    }
    async fn set_retired_title(&self, session_id: &str, name: &str) -> Result<(), RoomError> {
        self.sessions.set_retired_title(session_id, name).await
    }
    async fn clear(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError> {
        self.sessions.clear(session_id, archive_as).await
    }
    async fn delete(&self, session_id: &str) -> Result<(), RoomError> {
        self.sessions.delete(session_id).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockFeed;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_base::support::testing::with_op;
    use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
    use mixdog_core_rooms::rooms::records::Rooms;
    use mixdog_core_rooms::rooms::service::RoomRunner;
    use mixdog_core_rooms::rooms::service::RoomService;
    use mixdog_core_rooms::rooms::home::HomePorts;
    use mixdog_core_rooms::rooms::home::Presence;
    use mixdog_core_rooms::rooms::sessions::SessionHomePorts;
    use mixdog_core_rooms::rooms::store::StateRoomStore;
    use mixdog_core_session::session::StoreThreads;
    use mixdog_core_session::session::thread_list::LIST;
    use mixdog_core_session::session::thread_list::ListOverlay;
    use mixdog_core_session::session::thread_list::RowOverlay;
    use mixdog_core_session::session::thread_state::SessionThreads;
    use mixdog_core_session::session::testing::Rig;
    use mixdog_protocol::ThreadId;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::run_host::directory_sessions::DirectorySessions;
    use crate::run_host::room_list::RoomListRows;

    /// The agents the rooms name, and the folder tasks run in; the listing's task workspace lookup fails once `lookup_fails` is set.
    struct Agents {
        lookup_fails: std::sync::atomic::AtomicBool,
        /// Each agent's id and name.
        roster: Vec<(String, String)>,
    }
    impl Default for Agents {
        fn default() -> Self {
            Self { lookup_fails: false.into(), roster: vec![("gh".into(), "GH".into()), ("rel".into(), "Rel".into())] }
        }
    }
    #[async_trait]
    impl TaskWorkspace for Agents {
        async fn path(&self) -> Result<String, String> {
            if self.lookup_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("the task workspace could not be resolved".into());
            }
            Ok("/tasks".into())
        }
    }
    #[async_trait]
    impl AgentCatalog for Agents {
        async fn agents(&self) -> Result<Vec<mixdog_core_rooms::rooms::service::KnownAgent>, RoomError> {
            let route = json!({ "provider": "custom-harness", "model": "harness-model" });
            Ok(self.roster.iter().map(|(id, _)| mixdog_core_rooms::rooms::service::KnownAgent { id: id.clone(), route: route.clone() }).collect())
        }
        async fn mixy_route(&self) -> Value {
            Value::Null
        }
        async fn mixy_created(&self) -> bool {
            false
        }
        async fn presence(&self, _: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
            Ok(HashMap::new())
        }
        async fn archived_name(&self, _: &str) -> String {
            String::new()
        }
        async fn task_workspace(&self) -> String {
            "/tasks".into()
        }
    }
    #[async_trait]
    impl MemberNames for Agents {
        async fn names(&self) -> HashMap<String, String> {
            self.roster.iter().cloned().collect()
        }
    }

    struct Quiet;
    impl ListOverlay for Quiet {
        fn of(&self, _: &ThreadId) -> RowOverlay {
            RowOverlay::default()
        }
    }

    struct Idle;
    #[async_trait]
    impl RoomRunner for Idle {
        fn is_running(&self, _: &str) -> bool {
            false
        }
        fn stop(&self, _: &str) {}
        async fn start(&self, _: &str, _: Vec<String>) -> Result<(), RoomError> {
            unreachable!("no room speaks in this test")
        }
        fn cancel_owed_to(&self, _: &str, _: &[String]) {}
    }

    /// The listing's task workspace lookup (the first step of every catalog publication and listing; the index-driven edges look
    /// it up through `Agents` itself), with a gate in front of it where a test arms one: the next lookup stops there, says it
    /// arrived, and answers when the test opens it.
    struct Gate {
        armed: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
        agents: Arc<Agents>,
    }
    impl Gate {
        /// The opener and the arrival signal of the next lookup.
        fn arm(&self) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.armed.lock().unwrap() = Some((reached, held));
            (open, arrived)
        }
    }
    #[async_trait]
    impl TaskWorkspace for Gate {
        async fn path(&self) -> Result<String, String> {
            let armed = self.armed.lock().unwrap().take();
            if let Some((reached, held)) = armed {
                let _ = reached.send(());
                let _ = held.await;
            }
            self.agents.path().await
        }
    }

    /// How long a step may take before the test calls it hung (a failure bound, not a wait the test relies on).
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    type Service = RoomService<StateRoomStore, SessionRoomHost, Idle>;

    /// The room service over the production wiring (`wire`, as `compose_flip.rs` composes it), the real index, store and room
    /// records; the list's fence is the test's gate.
    struct Composed {
        service: Arc<Service>,
        list: Arc<ThreadListService>,
        homes: SessionHomePorts<StateRoomStore>,
        agents: Arc<Agents>,
        app: MockConnection,
        gate: Arc<Gate>,
        _held: (Rig, tempfile::TempDir, tempfile::TempDir),
    }

    impl Composed {
        async fn create(&self) -> tokio::task::JoinHandle<Result<Value, mixdog_core_api::CoreError>> {
            let service = self.service.clone();
            tokio::spawn(async move { value(&*service, request("room/create", with_op(json!({ "input": { "name": "Release", "members": ["gh", "rel"] } }), 1), Some(1))).await })
        }

        /// One room call through the service, its `input` as given; its answer or its error's text.
        async fn call(&self, method: &'static str, input: Value, op: u64) -> Result<Value, String> {
            let service = self.service.clone();
            let answer = tokio::time::timeout(DEADLINE, async move { value(&*service, request(method, with_op(json!({ "input": input }), op), Some(op))).await })
                .await
                .unwrap_or_else(|_| panic!("{method} answered within the deadline"));
            answer.map_err(|error| format!("{error:?}"))
        }

        /// A listing, as a window's first list loads Node's catalog.
        async fn load_catalog(&self) {
            value(self.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
            assert!(self.list.catalog_loaded());
        }

        /// The ids of the rows the feed was sent under `method`, in order.
        fn sent(&self, method: &str) -> Vec<String> {
            self.app
                .drain_text()
                .into_iter()
                .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
                .filter(|frame| frame["method"] == method)
                .filter_map(|frame| frame["params"]["thread"]["id"].as_str().map(str::to_owned))
                .collect()
        }
    }

    fn log_of(created: &Value) -> String {
        format!("sess_room_{}", created["roomId"].as_str().expect("room id").trim_start_matches("room_"))
    }

    /// Node with its catalog loaded publishes it inside `createAgentRoom` before answering (`session-host.ts:353-354`,
    /// `agent-rooms.ts:289`). Held at its first step, the production publish keeps the creation unanswered; opened, the creation
    /// answers, and by then the feed has been sent the room's row and a `thread/list` lists it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_the_catalog_loaded_a_room_create_answers_after_its_publish() {
        let world = composed().await;
        world.load_catalog().await;
        let (open, arrived) = world.gate.arm();
        let creating = world.create().await;
        tokio::time::timeout(DEADLINE, arrived).await.expect("the room create never published the catalog").expect("gate");
        assert!(!creating.is_finished(), "the room create answered while its publish was held");
        drop(world.sent("thread/summary/updated"));
        open.send(()).expect("the publish waits at the gate");
        let created = tokio::time::timeout(DEADLINE, creating).await.expect("room/create answered within the deadline").expect("task").expect("room/create");
        let room = log_of(&created);
        assert!(world.sent("thread/summary/updated").contains(&room), "the publish sent the room's row before the reply");
        let listed = value(world.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
        let ids: Vec<&str> = listed["data"].as_array().expect("data").iter().filter_map(|row| row["id"].as_str()).collect();
        assert!(ids.contains(&room.as_str()), "thread/list at the reply lists the room {room}: {ids:?}");
    }

    fn recorded(scenario: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/room-catalog-states/{scenario}.json"));
        serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).expect("recording")
    }

    /// The room log rows of the frames the app feed has been sent since the last drain, in order.
    fn room_rows(app: &MockConnection) -> Vec<Value> {
        app.drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
            .filter(|frame| frame["method"] == "thread/summary/updated" && frame["params"]["thread"]["agentRoom"].is_object())
            .map(|frame| frame["params"]["thread"].clone())
            .collect()
    }

    /// Where the two runs differ by what they are, not by what they do: the room's id (made at random) and each time field (each
    /// run's clock; per field, as two clock reads of one run can land in one millisecond) are named by their order of first
    /// appearance in the scenario; the task workspace a room log is made in (`agent-rooms.ts:284`, the log row's `cwd`) is named
    /// as such.
    struct Names {
        ids: Vec<String>,
        times: HashMap<&'static str, Vec<i64>>,
        workspace: String,
    }
    impl Names {
        fn new(workspace: &str) -> Self {
            Self { ids: Vec::new(), times: HashMap::new(), workspace: workspace.to_owned() }
        }
        fn named(&mut self, row: &Value) -> Value {
            let mut row = row.clone();
            let id = row["agentRoom"]["id"].as_str().expect("room id").to_owned();
            let at = self.ids.iter().position(|seen| *seen == id).unwrap_or_else(|| (self.ids.push(id.clone()), self.ids.len() - 1).1);
            row["id"] = json!(format!("<room log {at}>"));
            row["agentRoom"]["id"] = json!(format!("<room {at}>"));
            for key in ["createdAt", "updatedAt", "activityAt"] {
                if let Some(time) = row.get(key).and_then(Value::as_i64) {
                    let seen = self.times.entry(key).or_default();
                    let at = seen.iter().position(|t| *t == time).unwrap_or_else(|| (seen.push(time), seen.len() - 1).1);
                    row[key] = json!(format!("<{key} {at}>"));
                }
            }
            if !self.workspace.is_empty() && row["cwd"] == self.workspace.as_str() {
                row["cwd"] = json!("<task workspace>");
            }
            row
        }
    }

    /// The one known difference, named and checked rather than passed over (reported for `decisions.md`, owner: Lead): Node's
    /// daemon lists a session it still holds live from the session object (`listLeadSessions` over a session, no summary:
    /// `store-summary-real-turns.test.mjs:115-118`), which carries neither `compactCount` nor `incomingTail`; the core's row is
    /// always the stored summary's (`store-summary-index.mjs:288,350`), `compactCount: 0` and, for a room log, `incomingTail: []`.
    /// Only that exact pair, absent from Node's row, is taken off the core's; any other difference stays.
    fn live_form(mut core: Value, node: &Value) -> Value {
        for (key, stored) in [("compactCount", json!(0)), ("incomingTail", json!([]))] {
            if node.get(key).is_none() && core.get(key) == Some(&stored) {
                core.as_object_mut().expect("row").shift_remove(key);
            }
        }
        core
    }

    /// Every room call of Node's recordings (`benchmarks/rust-core/recorders/record-room-catalog-states.mjs` →
    /// `fixtures/room-catalog-states`), replayed whole and in order through the production wiring: per call, whether the catalog was
    /// loaded before and after it, how it ended, and the room rows its own publications sent before it answered (the room's
    /// rename's whole listing and the room call's `republishCatalog`, Node's `room-rename`/`room-call` origins). Node's other
    /// publications (a member session's reset or deletion, the store watcher) are other paths, the core's index edges; they are
    /// recorded with their own origin and not part of a room call's answer. Node's listing fault (the daemon's `session.list`
    /// failing) is the core's listing failing at its first step, the task workspace lookup.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn room_calls_replay_nodes_catalog_states() {
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-catalog-states/MANIFEST.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(manifest["product"]["exact"], json!(true), "the recording is of the exact product");
        for scenario in manifest["scenarios"].as_array().expect("scenarios") {
            replay(scenario.as_str().expect("scenario")).await;
        }
    }

    async fn replay(scenario: &str) {
        let node = recorded(scenario);
        let bots: Vec<String> = node["bots"].as_array().expect("bots").iter().map(|b| b.as_str().expect("bot").to_owned()).collect();
        // The bots' names, as Node's room summary names them.
        let named = node["steps"].as_array().expect("steps").iter().find_map(|step| {
            step["events"].as_array()?.iter().find_map(|event| {
                event["value"]["memberNames"]
                    .as_object()
                    .or_else(|| event["rooms"].as_array()?.iter().find_map(|row| row["agentRoom"]["memberNames"].as_object()))
                    .cloned()
            })
        });
        let names = named.expect("a step answers the members' names");
        let roster = bots.iter().map(|id| (id.clone(), names[id].as_str().expect("name").to_owned())).collect();
        let world = composed_with(Agents { lookup_fails: false.into(), roster }).await;
        let fail_from = node["failListingAfter"].as_u64();
        if fail_from == Some(0) {
            world.agents.lookup_fails.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let workspace = world.agents.path().await.unwrap_or_default();
        let (mut node_names, mut core_names) = (Names::new(node["taskWorkspace"].as_str().expect("task workspace")), Names::new(&workspace));
        let mut room: Option<Value> = None;
        let mut created = 0;
        for step in node["steps"].as_array().expect("steps") {
            let name = step["step"].as_str().expect("step");
            let events = step["events"].as_array().cloned().unwrap_or_default();
            let what = format!("{scenario} / {name}");            match name {
                "list" => world.load_catalog().await,
                // The core's flag is the list service's, which a lost transport or a reloaded window does not replace.
                "transport-loss-and-renderer-reload" => {}
                call => {
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedBefore"], "{what}: loaded before the call");
                    drop(world.app.drain_text());
                    created += 1;
                    let room_id = room.as_ref().map(|r| r["roomId"].clone()).unwrap_or(Value::Null);
                    let answer = match call {
                        "create" => world.call("room/create", json!({ "name": "Room One", "members": bots }), created).await,
                        "update" => world.call("room/update", json!({ "roomId": room_id, "name": "Room Renamed" }), created).await,
                        "reset" => world.call("room/reset", json!({ "roomId": room_id }), created).await,
                        "remove" => world.call("room/remove", json!({ "roomId": room_id }), created).await,
                        "forget-member" => {
                            let forget = world.homes.forget_room_member(&bots[2]);
                            tokio::time::timeout(DEADLINE, forget).await.expect("forget_room_member answered").map(|()| Value::Null).map_err(|error| format!("{error:?}"))
                        }
                        other => panic!("{what}: a call this replay does not know: {other}"),
                    };
                    let sent = room_rows(&world.app);
                    let node_answer = events.iter().find(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    match (&answer, node_answer["kind"].as_str()) {
                        (Ok(value), Some("answered")) => {
                            if call == "create" {
                                room = Some(value.clone());
                            }
                            let core_room = room.as_ref().map(|r| r["roomId"].as_str().expect("room id").to_owned()).unwrap_or_default();
                            let node_room = node["room"]["roomId"].as_str().unwrap_or_default();
                            let core_text = value.to_string().replace(&core_room, "<room>");
                            // A call Node answers with nothing (`Promise<void>`, recorded as null) answers the protocol's empty object.
                            // (The member removal is no protocol call: its `()` is the null here.)
                            let node_value = if node_answer["value"].is_null() && call != "forget-member" { json!({}) } else { node_answer["value"].clone() };
                            let node_text = node_value.to_string().replace(node_room, "<room>");
                            assert_eq!(core_text, node_text, "{what}: the answer");
                        }
                        (Err(error), Some("threw")) => assert!(error.contains(node_answer["message"].as_str().expect("message")), "{what}: {error}"),
                        (got, _) => panic!("{what}: the core ended {got:?}, Node {node_answer}"),
                    }
                    // The room rows Node's own publications of the call carried before it answered, the last one per room.
                    let node_rows: Vec<&Value> = events
                        .iter()
                        .take_while(|e| e["kind"] != "answered" && e["kind"] != "threw")
                        .filter(|e| e["kind"] == "published" && (e["origin"] == "room-call" || e["origin"] == "room-rename" || e["origin"] == "room-call-background-listing"))
                        .filter_map(|e| e["rooms"].as_array())
                        .last()
                        .map(|rows| rows.iter().collect())
                        .unwrap_or_default();
                    let node_rows: Vec<Value> = node_rows.into_iter().map(|row| node_names.named(row)).collect();
                    let core_last = sent.last().map(|row| core_names.named(row));
                    match node_rows.as_slice() {
                        [] => assert_eq!(core_last, None, "{what}: Node published no room row before answering"),
                        [one] => assert_eq!(core_last.map(|row| live_form(row, one)).as_ref(), Some(one), "{what}: the room row published before the answer"),
                        more => panic!("{what}: Node published {} rooms; the scenario has one", more.len()),
                    }
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedAfter"], "{what}: loaded after the call");                }
            }
            if name == "list" && fail_from == Some(1) {
                world.agents.lookup_fails.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    async fn composed() -> Composed {
        composed_with(Agents::default()).await
    }

    async fn composed_with(agents: Agents) -> Composed {
        let data = tempfile::tempdir().expect("data dir");
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(store.clone()))));
        std::fs::create_dir_all(data.path().join("state")).expect("state dir");
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &data.path().join("state").join("core.sqlite")).expect("core state");
        let rooms = Arc::new(Rooms::new(StateRoomStore::new(state)));
        let agents = Arc::new(agents);
        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).expect("subscribe");
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
        drop(app.drain_text());
        let sections = Arc::new(SectionFeedState::new(feed));
        let room_rows = Arc::new(RoomListRows::new(rooms.clone(), Arc::new(Idle), agents.clone()));
        let gate = Arc::new(Gate { armed: std::sync::Mutex::new(None), agents: agents.clone() });
        let list = Arc::new(ThreadListService::new(Arc::new(index.clone()), Arc::new(Quiet), room_rows, gate.clone()));
        list.fence(store);
        let sessions = Arc::new(DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory.clone()))));
        let publication = wire(list.clone(), sections, agents.clone(), &index, directory, sessions.clone()).expect("wired");
        let op_dir = tempfile::tempdir().expect("op dir");
        let scopes = mixdog_core_base::support::testing::scopes(op_dir.path(), "room").await;
        // The agent deletion's room ports, as `compose_flip.rs` composes them.
        let homes = SessionHomePorts::new(agents.clone(), sessions, rooms.clone(), publication.host.clone(), Arc::new(Idle));
        let service = Arc::new(RoomService::new(rooms.clone(), publication.host, Arc::new(Idle), scopes, agents.clone()));
        Composed { service, list, homes, agents, app, gate, _held: (rig, data, op_dir) }
    }
}
