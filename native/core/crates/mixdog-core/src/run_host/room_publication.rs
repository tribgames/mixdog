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
    deletions: Arc<mixdog_core_session::session::thread_edges::ThreadDeletions>,
    agents: Arc<A>,
    index: &mixdog_store::sqlite::SqliteStore,
    directory: Arc<SessionDirectory>,
    sessions: Arc<dyn SessionOps>,
) -> Result<RoomPublication, &'static str>
where
    A: TaskWorkspace + AgentCatalog + 'static,
{
    index.observe_rows(ThreadEdges::start(ThreadEdgePublisher::new(thread_list.clone(), sections.clone(), deletions, agents.clone())))?;
    let summaries = RoomSummaries::new(thread_list, sections, directory);
    let republish: Republish = {
        let summaries = summaries.clone();
        Arc::new(move |publish| {
            let summaries = summaries.clone();
            Box::pin(async move { summaries.republish_catalog(publish).await.map_err(|error| RoomError::Port(format!("{error:?}"))) })
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
    use mixdog_core_api::ReplyQueued;
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
        /// The agents whose definitions were deleted (proven gone); every other is present.
        deleted: std::sync::Mutex<Vec<String>>,
    }
    impl Agents {
        fn new(roster: Vec<(String, String)>) -> Self {
            Self { lookup_fails: false.into(), roster, deleted: std::sync::Mutex::default() }
        }
    }
    impl Default for Agents {
        fn default() -> Self {
            Self::new(vec![("gh".into(), "GH".into()), ("rel".into(), "Rel".into())])
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
        async fn presence(&self, ids: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
            let deleted = self.deleted.lock().unwrap();
            Ok(ids.iter().map(|id| (id.clone(), if deleted.contains(id) { Presence::Deleted } else { Presence::Present })).collect())
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

    /// The room sessions, with a stop in front of a deletion where a test arms one: the next deletion stops there, says it
    /// arrived, and goes on when the test opens it.
    struct Deletes {
        inner: Arc<dyn SessionOps>,
        armed: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
    }
    impl Deletes {
        /// The opener and the arrival signal of the next deletion.
        fn arm(&self) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.armed.lock().unwrap() = Some((reached, held));
            (open, arrived)
        }
    }
    #[async_trait]
    impl SessionOps for Deletes {
        async fn route(&self, session_id: &str) -> Result<Option<Value>, RoomError> {
            self.inner.route(session_id).await
        }
        async fn create(&self, session_id: &str, params: &Value) -> Result<(), RoomError> {
            self.inner.create(session_id, params).await
        }
        async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), RoomError> {
            self.inner.set_route(session_id, route).await
        }
        async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), RoomError> {
            self.inner.set_archived(session_id, archived).await
        }
        async fn is_retired(&self, session_id: &str) -> Result<bool, RoomError> {
            self.inner.is_retired(session_id).await
        }
        async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), RoomError> {
            self.inner.set_retired(session_id, retired).await
        }
        async fn rename(&self, session_id: &str, title: &str) -> Result<(), RoomError> {
            self.inner.rename(session_id, title).await
        }
        async fn set_retired_title(&self, session_id: &str, name: &str) -> Result<(), RoomError> {
            self.inner.set_retired_title(session_id, name).await
        }
        async fn clear(&self, session_id: &str, archive_as: &str) -> Result<(), RoomError> {
            self.inner.clear(session_id, archive_as).await
        }
        async fn delete(&self, session_id: &str) -> Result<(), RoomError> {
            let armed = self.armed.lock().unwrap().take();
            if let Some((reached, held)) = armed {
                let _ = reached.send(());
                let _ = held.await;
            }
            self.inner.delete(session_id).await
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
        deletes: Arc<Deletes>,
        summaries: Arc<RoomSummaries>,
        _held: (Rig, mixdog_core_session::session::testing::DataDir),
    }

    impl Composed {
        async fn create(&self) -> tokio::task::JoinHandle<Result<Value, mixdog_core_api::CoreError>> {
            let service = self.service.clone();
            tokio::spawn(async move { value(&*service, request("room/create", with_op(json!({ "input": { "name": "Release", "members": ["gh", "rel"] } }), 1), Some(1))).await })
        }

        /// One room call through the service, its `input` as given, as the server dispatches it: once it has answered, its reply is
        /// queued and then the reply's mark set (`AppServer` `on_message`). Its answer or its error's text.
        async fn call(&self, method: &'static str, input: Value, op: u64) -> Result<Value, String> {
            let (answer, replied) = self.call_held(method, input, op).await;
            replied.mark();
            answer
        }

        /// [`Self::call`] up to its answer, the reply's mark not yet set: the moment between the call's answer and its reply queued.
        async fn call_held(&self, method: &'static str, input: Value, op: u64) -> (Result<Value, String>, ReplyQueued) {
            let (answering, replied) = self.spawn_held(method, input, op);
            let answer = tokio::time::timeout(DEADLINE, answering)
                .await
                .unwrap_or_else(|_| panic!("{method} answered within the deadline"))
                .expect("the call's task");
            (answer.map_err(|error| format!("{error:?}")), replied)
        }

        /// The room call running, and the mark of its reply, not yet set.
        fn spawn_held(&self, method: &'static str, input: Value, op: u64) -> (tokio::task::JoinHandle<Result<Value, mixdog_core_api::CoreError>>, ReplyQueued) {
            let service = self.service.clone();
            let req = request(method, with_op(json!({ "input": input }), op), Some(op));
            // The server's copy: the reply's mark is the test's to set, not the dropped request's.
            let replied = req.ctx.reply_queued.clone();
            (tokio::spawn(async move { value(&*service, req).await }), replied)
        }

        /// A room of every agent, made while every listing fails, its creation's background listing ended: the catalog is not loaded.
        async fn unloaded_room(&self) -> Value {
            self.agents.lookup_fails.store(true, std::sync::atomic::Ordering::SeqCst);
            let members: Vec<&str> = self.agents.roster.iter().map(|(id, _)| id.as_str()).collect();
            let created = self.call("room/create", json!({ "name": "Release", "members": members }), 1).await.expect("room/create");
            tokio::time::timeout(DEADLINE, self.summaries.background_ended()).await.expect("the creation's background listing never ended");
            self.agents.lookup_fails.store(false, std::sync::atomic::Ordering::SeqCst);
            assert!(!self.list.catalog_loaded(), "the failed listings left the catalog unloaded");
            drop(self.app.drain_text());
            created
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

    /// Node's room update before any listing answers before its background listing publishes: `deps.republishCatalog()` starts
    /// `publishCatalogs` (`session-host.ts:355`), whose rows wait for the daemon's `session.list` reply (`session-host.ts:797`), and
    /// `update` awaits no I/O before its answer (`agent-rooms.ts:312-319`, `deleteSessions([])` loops over nothing). The recorded
    /// scenario with that step (`not-loaded-large / update-rounds`) is replayed whole, as [`room_calls_replay_nodes_catalog_states`]
    /// replays it, with the losing order forced at that step: the core's listing has its rows in hand after the update has answered
    /// and before the server has queued the reply; what the client was sent by then and after the listing are compared with Node's
    /// recording. The test runs as a task of the runtime's one worker: the listing, told it has its rows in hand, runs on until it
    /// awaits something before the test sees anything (the session store's blocking reads need a multi-threaded runtime).
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn before_any_listing_a_room_update_answers_before_its_background_listing_publishes() {
        tokio::spawn(replay("not-loaded-large", Some("update-rounds"))).await.expect("the test task");
    }

    /// Node's room update that removes a member, before any listing, starts the background listing and then deletes the member's
    /// session (`agent-rooms.ts:312-315`); the deletion first awaits `listSessions()` (`session-host-lifecycle.ts:527`), which joins
    /// the listing in flight (`session-host.ts:789-790`), so the listing reads before the deletion and publishes before it, before
    /// the answer. The core's update lets go of the listing there and waits for its end: stopped as the deletion begins, the room's
    /// row has been sent, the update has not answered and its reply is not queued.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn before_any_listing_a_room_update_removing_a_member_publishes_its_listing_before_the_deletion() {
        let roster = [("gh", "GH"), ("rel", "Rel"), ("qa", "QA")].map(|(id, name)| (id.to_owned(), name.to_owned())).to_vec();
        let world = composed_with(Agents::new(roster)).await;
        let created = world.unloaded_room().await;
        let (open, arrived) = world.deletes.arm();
        let (mut updating, replied) = world.spawn_held("room/update", json!({ "roomId": created["roomId"], "members": ["gh", "rel"] }), 2);
        tokio::time::timeout(DEADLINE, async {
            tokio::select! {
                reached = arrived => reached.expect("stop"),
                answered = &mut updating => panic!("the update answered without deleting the removed member's session: {answered:?}"),
            }
        })
        .await
        .expect("the update never deleted the removed member's session");
        assert!(world.sent("thread/summary/updated").contains(&log_of(&created)), "the listing had not sent the room's row when the deletion began");
        assert!(!updating.is_finished(), "the update answered before its deletion went on");

        open.send(()).expect("the deletion waits at the stop");
        let answer = tokio::time::timeout(DEADLINE, updating).await.expect("the update never answered").expect("task").expect("room/update");
        assert_eq!(answer["members"], json!(["gh", "rel"]), "{answer}");
        replied.mark();
        assert!(world.list.catalog_loaded(), "the joined listing loaded the catalog");
    }

    fn recorded(scenario: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/room-catalog-states/{scenario}.json"));
        serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))).expect("recording")
    }

    /// The frames the app feed has been sent since the last drain, in order.
    fn frames(app: &MockConnection) -> Vec<Value> {
        app.drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
            .collect()
    }

    /// What a listener of the app feed holds, folded as the roster folds it (`replay-roster-rows-live.mjs` `folded`): a thread edge
    /// puts its row, a deletion takes it out, an archive or unarchive marks it. In the order rows first came.
    #[derive(Default)]
    struct Fold(Vec<(String, Value)>);
    impl Fold {
        fn apply(&mut self, frame: &Value) {
            let params = &frame["params"];
            match frame["method"].as_str().unwrap_or_default() {
                "thread/started" | "thread/summary/updated" => {
                    let id = params["thread"]["id"].as_str().expect("thread id").to_owned();
                    match self.0.iter_mut().find(|(seen, _)| *seen == id) {
                        Some((_, row)) => *row = params["thread"].clone(),
                        None => self.0.push((id, params["thread"].clone())),
                    }
                }
                "thread/deleted" => self.0.retain(|(id, _)| params["threadId"] != id.as_str()),
                method @ ("thread/archived" | "thread/unarchived") => {
                    if let Some((_, row)) = self.0.iter_mut().find(|(id, _)| params["threadId"] == id.as_str()) {
                        let row = row.as_object_mut().expect("row");
                        if method == "thread/archived" {
                            row.insert("archived".into(), json!(true));
                        } else {
                            row.shift_remove("archived");
                        }
                    }
                }
                _ => {}
            }
        }
        fn row(&self, id: &str) -> Option<&Value> {
            self.0.iter().find(|(seen, _)| seen == id).map(|(_, row)| row)
        }
    }

    /// The rows of the last publication pass in `frames` (the last run of `thread/summary/updated` frames), in the order sent.
    fn last_pass(frames: &[Value]) -> Vec<&Value> {
        let mut pass: Vec<&Value> = frames.iter().rev().take_while(|frame| frame["method"] == "thread/summary/updated").map(|frame| &frame["params"]["thread"]).collect();
        pass.reverse();
        pass
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
            let room = row["agentRoom"]["id"].as_str().map(str::to_owned);
            let id = room.clone().unwrap_or_else(|| row["id"].as_str().expect("session id").to_owned());
            let at = self.ids.iter().position(|seen| *seen == id).unwrap_or_else(|| (self.ids.push(id.clone()), self.ids.len() - 1).1);
            if room.is_some() {
                row["id"] = json!(format!("<room log {at}>"));
                row["agentRoom"]["id"] = json!(format!("<room {at}>"));
            } else {
                row["id"] = json!(format!("<session {at}>"));
            }
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
    /// `store-summary-real-turns.test.mjs:115-118`), a row with neither `compactCount` nor `incomingTail`; a stored row always
    /// carries `compactCount` (`store-summary-index.mjs:350`), and the core's row is always the stored summary's. Where Node's row
    /// is that live form, exactly those two fields are taken off the core's row; any other difference stays.
    fn live_form(mut core: Value, node: &Value) -> Value {
        if node.get("compactCount").is_none() && node.get("incomingTail").is_none() {
            let row = core.as_object_mut().expect("row");
            row.shift_remove("compactCount");
            row.shift_remove("incomingTail");
        }
        core
    }

    /// Every room call of Node's recordings (`benchmarks/rust-core/recorders/record-room-catalog-states.mjs` →
    /// `fixtures/room-catalog-states`), replayed whole and in order through the production wiring: per call, whether the catalog was
    /// loaded before and after it, how it ended, and the whole catalog the client holds when it answers (Node's last catalog the call
    /// published before answering, every row, against the core's app feed folded as a listener folds it) and, where Node's background
    /// listing published after the answer, the whole catalog after it. Only the store watcher's timer publications (a 400 ms / 2 s
    /// refresh, no part of the call) are not the call's. Node's listing fault (the daemon's `session.list` failing, per step as
    /// recorded) is the core's listing failing at its first step, the task workspace lookup.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn room_calls_replay_nodes_catalog_states() {
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-catalog-states/MANIFEST.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(manifest["product"]["exact"], json!(true), "the recording is of the exact product");
        for scenario in manifest["scenarios"].as_array().expect("scenarios") {
            replay(scenario.as_str().expect("scenario"), None).await;
        }
    }

    /// One recorded scenario replayed. At step `forced` (a call that starts a background listing), the listing is let have its
    /// rows in hand before the replay reads what the call sent by its reply: the order a busy runtime can produce.
    async fn replay(scenario: &str, forced: Option<&str>) {
        let node = recorded(scenario);
        let bots: Vec<String> = node["bots"].as_array().expect("bots").iter().map(|b| b.as_str().expect("bot").to_owned()).collect();
        // The bots' names, as their saved definitions answered them.
        let names = node["botNames"].as_object().expect("the bots' names");
        let roster = bots.iter().map(|id| (id.clone(), names[id].as_str().expect("name").to_owned())).collect();
        let world = composed_with(Agents::new(roster)).await;
        let workspace = world.agents.path().await.unwrap_or_default();
        let (mut node_names, mut core_names) = (Names::new(node["taskWorkspace"].as_str().expect("task workspace")), Names::new(&workspace));
        let mut fold = Fold::default();
        let mut room: Option<Value> = None;
        // The room Node's calls act on: the one its last create answered.
        let mut node_room = String::new();
        let mut created = 0;
        for step in node["steps"].as_array().expect("steps") {
            let name = step["step"].as_str().expect("step");
            let events = step["events"].as_array().cloned().unwrap_or_default();
            let what = format!("{scenario} / {name}");
            // Node's daemon fails the host's listing while the step runs; the core's listing fails at its first step.
            world.agents.lookup_fails.store(step["listingFails"] == json!(true), std::sync::atomic::Ordering::SeqCst);
            match name {
                "list" => {
                    world.load_catalog().await;
                    for frame in frames(&world.app) {
                        fold.apply(&frame);
                    }
                }
                // The core's flag is the list service's, which a lost transport or a reloaded window does not replace.
                "transport-loss-and-renderer-reload" => {}
                call => {
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedBefore"], "{what}: loaded before the call");
                    for frame in frames(&world.app) {
                        fold.apply(&frame);
                    }
                    created += 1;
                    let room_id = room.as_ref().map(|r| r["roomId"].clone()).unwrap_or(Value::Null);
                    let (answer, replied) = match call {
                        "create" => world.call_held("room/create", json!({ "name": "Room One", "members": bots }), created).await,
                        "update" => world.call_held("room/update", json!({ "roomId": room_id, "name": "Room Renamed" }), created).await,
                        "update-rounds" => world.call_held("room/update", json!({ "roomId": room_id, "maxRounds": 4 }), created).await,
                        "reset" => world.call_held("room/reset", json!({ "roomId": room_id }), created).await,
                        "remove" => world.call_held("room/remove", json!({ "roomId": room_id }), created).await,
                        // No client call: nothing waits for a reply (`agent-rooms.ts:339-350`).
                        "forget-member" => {
                            let forget = world.homes.forget_room_member(&bots[2]);
                            let answer = tokio::time::timeout(DEADLINE, forget).await.expect("forget_room_member answered");
                            (answer.map(|()| Value::Null).map_err(|error| format!("{error:?}")), ReplyQueued::new())
                        }
                        // No client call: the third bot's definition deleted past the host, then the core's start-up as
                        // `compose_flip.rs` runs it: the rooms' first load prunes (`prune_deleted`), and `LiveRooms::start`, with no
                        // exchange cut off, ends with the rooms' republish (`DirectoryRoomDaemon::republish_catalog` →
                        // `RoomSummaries::republish`, whose pass is awaited here).
                        "restart-after-agent-deletion" => {
                            world.agents.deleted.lock().unwrap().push(bots[2].clone());
                            let start = async {
                                let unpruned = world.homes.prune_deleted().await?;
                                world.summaries.publish().await;
                                Ok::<_, RoomError>(unpruned)
                            };
                            let answer = tokio::time::timeout(DEADLINE, start).await.expect("the start-up's prune ended");
                            (answer.map(|_| Value::Null).map_err(|error| format!("{error:?}")), ReplyQueued::new())
                        }
                        other => panic!("{what}: a call this replay does not know: {other}"),
                    };
                    if forced == Some(name) {
                        assert!(
                            step["loadedBefore"] == json!(false) && step["listingFails"] != json!(true),
                            "{what}: the forced step starts no background listing that lists"
                        );
                        tokio::time::timeout(DEADLINE, world.summaries.listing_in_hand())
                            .await
                            .unwrap_or_else(|_| panic!("{what}: the call's background listing never had its rows in hand"));
                    }
                    // What the client was sent before the reply: the server queues the reply and then sets its mark.
                    let sent = frames(&world.app);
                    replied.mark();
                    // Node's recorder awaits the call's background listing to its end before the next step sets its listing fault; so
                    // does the replay, for the core's.
                    tokio::time::timeout(DEADLINE, world.summaries.background_ended())
                        .await
                        .unwrap_or_else(|_| panic!("{what}: the core's background listing did not end"));
                    let node_answer = events.iter().find(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    match (&answer, node_answer["kind"].as_str()) {
                        (Ok(value), Some("answered")) => {
                            if call == "create" {
                                room = Some(value.clone());
                            }
                            let core_room = room.as_ref().map(|r| r["roomId"].as_str().expect("room id").to_owned()).unwrap_or_default();
                            if call == "create" {
                                node_room = node_answer["value"]["roomId"].as_str().expect("Node's room id").to_owned();
                            }
                            let node_room = node_room.as_str();
                            let core_text = value.to_string().replace(&core_room, "<room>");
                            // A call Node answers with nothing (`Promise<void>`, recorded as null) answers the protocol's empty object.
                            // (The member removal is no protocol call: its `()` is the null here.)
                            let node_value = if node_answer["value"].is_null() && !matches!(call, "forget-member" | "restart-after-agent-deletion") {
                                json!({})
                            } else {
                                node_answer["value"].clone()
                            };
                            let node_text = node_value.to_string().replace(node_room, "<room>");
                            assert_eq!(core_text, node_text, "{what}: the answer");
                        }
                        (Err(error), Some("threw")) => assert!(error.contains(node_answer["message"].as_str().expect("message")), "{what}: {error}"),
                        (got, _) => panic!("{what}: the core ended {got:?}, Node {node_answer}"),
                    }
                    for frame in &sent {
                        fold.apply(frame);
                    }
                    // What the client held when the call answered: Node's last catalog published by the call before it answered (any
                    // origin but the store watcher's timer, which is no part of the call), whole; the core's fold of its feed.
                    let answered_at = events.iter().position(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    let published = |range: &[Value]| -> Option<Vec<Value>> {
                        range.iter().filter(|e| e["kind"] == "published" && e["origin"] != "store-refresh").filter_map(|e| e["sessions"].as_array()).last().cloned()
                    };
                    match published(&events[..answered_at]) {
                        Some(catalog) => {
                            let node_rows: Vec<Value> = catalog.iter().map(|row| node_names.named(row)).collect();
                            let core_rows = held(&fold, &sent, &mut core_names, &node_rows);
                            assert_eq!(core_rows, node_rows, "{what}: the catalog the client holds when the call answers");
                        }
                        None => assert!(
                            !sent.iter().any(|frame| frame["method"] == "thread/summary/updated"),
                            "{what}: Node published no catalog before answering; the core sent rows: {sent:?}"
                        ),
                    }
                    // Node's background listing, awaited by the recorder after the answer: the core's pass runs after the answer too.
                    if let Some(catalog) = published(&events[answered_at..]) {
                        let rows = catalog.len();
                        let later = tokio::time::timeout(
                            DEADLINE,
                            world.app.drain_text_until(|texts| texts.iter().filter(|text| text.contains("\"thread/summary/updated\"")).count() >= rows),
                        )
                        .await
                        .unwrap_or_else(|_| panic!("{what}: the core's background publication of {rows} rows did not come"));
                        let later: Vec<Value> = later.iter().map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).expect("frame")).collect();
                        for frame in &later {
                            fold.apply(frame);
                        }
                        let node_rows: Vec<Value> = catalog.iter().map(|row| node_names.named(row)).collect();
                        let core_rows = held(&fold, &later, &mut core_names, &node_rows);
                        assert_eq!(core_rows, node_rows, "{what}: the catalog the client holds after the call's background listing");
                    }
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedAfter"], "{what}: loaded after the call");
                }
            }
        }
    }

    /// The core client's catalog, named: every row of the fold, in the order of the last publication pass in `sent` when that pass
    /// carried every row (a whole publication is in catalog order), else in the order the rows first came. A row Node holds in its live
    /// form is compared in that form (`live_form`).
    fn held(fold: &Fold, sent: &[Value], names: &mut Names, node_rows: &[Value]) -> Vec<Value> {
        let pass = last_pass(sent);
        let ids: Vec<&str> = if pass.len() == fold.0.len() && fold.0.iter().all(|(id, _)| pass.iter().any(|row| row["id"] == id.as_str())) {
            pass.iter().map(|row| row["id"].as_str().expect("id")).collect()
        } else {
            fold.0.iter().map(|(id, _)| id.as_str()).collect()
        };
        ids.into_iter()
            .enumerate()
            .map(|(at, id)| {
                let row = names.named(fold.row(id).expect("a folded row"));
                match node_rows.get(at) {
                    Some(node) => live_form(row, node),
                    None => row,
                }
            })
            .collect()
    }

    /// The rig's delete seams, with `thread/deleted` sent on the app feed.
    struct AppDeletion {
        inner: Arc<dyn mixdog_core_session::session::delete::DeleteSeams>,
        app: Arc<SectionFeedState>,
    }
    #[async_trait]
    impl mixdog_core_session::session::delete::DeleteSeams for AppDeletion {
        async fn release_session_work(&self, session_id: &str, reason: &str) {
            self.inner.release_session_work(session_id, reason).await;
        }
        fn session_closed(&self, session_id: &str, reason: &str, header: &mixdog_store::schema::record::Header, closed_at_ms: i64) {
            self.inner.session_closed(session_id, reason, header, closed_at_ms);
        }
        fn tombstoned(&self, thread: &ThreadId) {
            self.inner.tombstoned(thread);
        }
        fn release_mcp_scope(&self, session_id: &str) {
            self.inner.release_mcp_scope(session_id);
        }
        fn forget_session_search(&self, session_id: &str) {
            self.inner.forget_session_search(session_id);
        }
        async fn release_deleted_worktree(&self, session_id: &str) {
            self.inner.release_deleted_worktree(session_id).await;
        }
        fn thread_deleted(&self, thread: &ThreadId) {
            self.app.notify("thread/deleted", &mixdog_app_protocol::v2::thread::ThreadIdParams { thread_id: thread.clone() });
        }
        fn current_session(&self) -> Option<String> {
            self.inner.current_session()
        }
        fn hosted_busy(&self, session_id: &str) -> Option<bool> {
            self.inner.hosted_busy(session_id)
        }
    }

    async fn composed() -> Composed {
        composed_with(Agents::default()).await
    }

    async fn composed_with(agents: Agents) -> Composed {
        let data = mixdog_core_session::session::testing::DataDir::default();
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let index = data.index(index);
        let store = Arc::new(StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
        let rig = Rig::new();
        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).expect("subscribe");
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
        drop(app.drain_text());
        let sections = Arc::new(SectionFeedState::new(feed));
        // A delete says `thread/deleted` on the app feed, as the production seams do (`purge.rs` `thread_deleted`).
        let mut parts = rig.deps_parts(store.clone());
        parts.deletion = Arc::new(AppDeletion { inner: parts.deletion.clone(), app: sections.clone() });
        let directory = Arc::new(SessionDirectory::new(Arc::new(parts)));
        std::fs::create_dir_all(data.path().join("state")).expect("state dir");
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &data.path().join("state").join("core.sqlite")).expect("core state");
        let rooms = Arc::new(Rooms::new(StateRoomStore::new(data.state(state))));
        let agents = Arc::new(agents);
        let room_rows =Arc::new(RoomListRows::new(rooms.clone(), Arc::new(Idle), agents.clone()));
        let gate = Arc::new(Gate { armed: std::sync::Mutex::new(None), agents: agents.clone() });
        let list = Arc::new(ThreadListService::new(Arc::new(index.clone()), Arc::new(Quiet), room_rows, gate.clone()));
        list.fence(store);
        let deletes = Arc::new(Deletes {
            inner: Arc::new(DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory.clone())))),
            armed: std::sync::Mutex::new(None),
        });
        let sessions: Arc<dyn SessionOps> = deletes.clone();
        let deletions = mixdog_core_session::session::thread_edges::ThreadDeletions::new(sections.clone());
        let publication = wire(list.clone(), sections, deletions, agents.clone(), &index, directory, sessions.clone()).expect("wired");
        let ops = data.state(mixdog_core_base::support::testing::op_state(data.path()));
        let scopes = mixdog_core_base::support::testing::scopes_over(ops, "room").await;
        // The agent deletion's room ports, as `compose_flip.rs` composes them.
        let homes = SessionHomePorts::new(agents.clone(), sessions, rooms.clone(), publication.host.clone(), Arc::new(Idle));
        let service = Arc::new(RoomService::new(rooms.clone(), publication.host, Arc::new(Idle), scopes, agents.clone()));
        Composed { service, list, homes, agents, app, gate, deletes, summaries: publication.summaries, _held: (rig, data) }
    }
}
