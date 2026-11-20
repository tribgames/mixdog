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
use mixdog_core_session::session::thread_edges::LiveRows;
use mixdog_core_session::session::thread_edges::ThreadEdgePublisher;
use mixdog_core_session::session::thread_edges::ThreadEdges;
use mixdog_core_session::session::thread_list::RoomSummaries;
use mixdog_core_session::session::thread_list::ThreadListService;

pub struct RoomPublication {
    pub summaries: Arc<RoomSummaries>,
    pub host: Arc<SessionRoomHost>,
    /// The index writes' publisher: a call that answers after its row is on the app feed waits for it ([`ThreadEdges::settled`]).
    pub edges: Arc<ThreadEdges>,
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
    let edges = ThreadEdges::start(ThreadEdgePublisher::new(thread_list.clone(), sections.clone(), deletions, agents.clone()));
    index.observe_rows(edges.clone())?;
    // A turn's start and end and an approval's wait reach the roster although no stored field moved (`LiveRows`).
    directory.set_live_rows(LiveRows::new(thread_list.clone(), sections.clone(), edges.clone()))?;
    let summaries = RoomSummaries::new(thread_list, sections, directory);
    summaries.follow(edges.clone());
    let republish: Republish = {
        let summaries = summaries.clone();
        Arc::new(move |publish| {
            let summaries = summaries.clone();
            Box::pin(async move { summaries.republish_catalog(publish).await.map_err(|error| RoomError::Port(format!("{error:?}"))) })
        })
    };
    let sessions = Arc::new(RenameLists { sessions, summaries: summaries.clone() });
    let host = Arc::new(SessionRoomHost::new(agents, sessions, republish));
    Ok(RoomPublication { summaries, host, edges })
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
    async fn set_room_members(&self, session_id: &str, members: &[String]) -> Result<(), RoomError> {
        self.sessions.set_room_members(session_id, members).await
    }
    async fn seed_room_members(&self, session_id: &str, members: &[String]) -> Result<(), RoomError> {
        self.sessions.seed_room_members(session_id, members).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::AfterAnswer;
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::mock::MockConnection;
    use mixdog_core_api::mock::MockFeed;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_base::support::testing::with_op;
    use mixdog_core_rooms::rooms::catalog_rows::MemberNames;
    use mixdog_core_rooms::rooms::ready::RoomsReady;
    use mixdog_core_rooms::rooms::records::RoomDoc;
    use mixdog_core_rooms::rooms::records::RoomStore;
    use mixdog_core_rooms::rooms::records::Rooms;
    use mixdog_core_rooms::rooms::service::RoomService;
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
        /// The ids of each presence check, in order (only the rooms' first load checks presence here).
        checked: std::sync::Mutex<Vec<Vec<String>>>,
        /// A stop in front of the index writes' next lookup (the edges look the workspace up here, the listings through `Gate`).
        edge_stop: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
        /// A stop in front of the next presence check (the rooms' first load's member check).
        presence_stop: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
        /// The next post into a room log finds the log released on close (`SessionClose::detach`) after it was admitted.
        detach_next_post: std::sync::atomic::AtomicBool,
    }
    impl Agents {
        fn new(roster: Vec<(String, String)>) -> Self {
            Self {
                detach_next_post: false.into(),
                lookup_fails: false.into(),
                roster,
                deleted: std::sync::Mutex::default(),
                checked: std::sync::Mutex::default(),
                edge_stop: std::sync::Mutex::default(),
                presence_stop: std::sync::Mutex::default(),
            }
        }
        /// The opener and the arrival signal of the edges' next lookup.
        fn arm_edges(&self) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.edge_stop.lock().unwrap() = Some((reached, held));
            (open, arrived)
        }
        fn lookup(&self) -> Result<String, String> {
            if self.lookup_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("the task workspace could not be resolved".into());
            }
            Ok("/tasks".into())
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
            let stop = self.edge_stop.lock().unwrap().take();
            if let Some((reached, held)) = stop {
                let _ = reached.send(());
                let _ = held.await;
            }
            self.lookup()
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
            self.checked.lock().unwrap().push(ids.to_vec());
            let stop = self.presence_stop.lock().unwrap().take();
            if let Some((reached, held)) = stop {
                let _ = reached.send(());
                let _ = held.await;
            }
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

    /// The rooms' runner as `compose_flip.rs` composes it: the calls' scheduler over the live rooms' exchanges.
    type Runner = mixdog_core_rooms::rooms::runner::CallsRunner<mixdog_core_rooms::rooms::exchange_run::ExchangeRunner>;

    /// The members' labels, the first thing an exchange reads after its start saved the room running (`exchange_run.rs` `turns_body`):
    /// where a test arms it, the next exchange stops there for good (the core is restarted under it, as Node's exchange is cut off by
    /// its host made again) and says it arrived. No exchange of these tests goes further.
    #[derive(Default)]
    struct HeldLabels {
        armed: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    }
    impl HeldLabels {
    }

    /// No user message is sent in these tests.
    struct NoSends;
    #[async_trait]
    impl mixdog_core_rooms::rooms::user_send::RoomSend for NoSends {
        async fn send(&self, _: &mixdog_core_rooms::rooms::user_send::UserMessage) -> Result<bool, RoomError> {
            unreachable!("no user message is sent here")
        }
    }

    #[async_trait]
    impl mixdog_core_rooms::rooms::live::RoomLabels for HeldLabels {
        async fn labels(&self, _: &[String]) -> Result<HashMap<String, mixdog_core_rooms::rooms::turn_host::MemberLabel>, String> {
            let reached = self.armed.lock().unwrap().take().expect("an exchange went past its start where the test held none");
            let _ = reached.send(());
            std::future::pending().await
        }
    }

    /// The live rooms' ports no step of these tests reaches past an exchange's start: the room view's publish (no catalog), and a row
    /// taken in as it is (an interrupted row has no files, `room_files.rs`).
    struct Unreached;
    #[async_trait]
    impl mixdog_core_rooms::rooms::live::RoomApprovals for Unreached {
        async fn approve(&self, _: &str, _: mixdog_core_rooms::rooms::live::ApprovalAnswer) -> Result<bool, String> {
            unreachable!("no member asks for approval in these tests")
        }
        async fn answer_question(&self, _: &str, _: mixdog_core_rooms::rooms::live::ApprovalAnswer) -> Result<bool, String> {
            unreachable!("no member asks a question in these tests")
        }
        fn member_questions(&self, _: &str, _: &[String]) -> Vec<Value> {
            Vec::new()
        }
        async fn publish_view(&self, _: &str, _: Option<mixdog_core_rooms::rooms::live::ExchangeView>, _: Vec<Value>) {}
    }
    #[async_trait]
    impl mixdog_core_rooms::rooms::live::RoomFiles for Unreached {
        async fn take_in(&self, _: &str, row: Value) -> Result<Value, String> {
            Ok(row)
        }
    }
    #[async_trait]
    impl mixdog_core_rooms::rooms::maintainer::Maintainer for Unreached {
        async fn decide(
            &self,
            _: &mixdog_core_rooms::rooms::exchange_run::SupervisorStep,
        ) -> Result<Option<mixdog_core_rooms::rooms::exchange::Decision>, String> {
            unreachable!("no exchange of these tests reaches its supervisor")
        }
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
            self.agents.lookup()
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

    /// The room records' store, with a stop in front of a save where a test arms one: the next save says it arrived, then fails
    /// with the given text or waits until the test opens it; and a stop in front of the next load, which waits until opened.
    struct Saves {
        inner: StateRoomStore,
        armed: Arc<std::sync::Mutex<Option<SaveStop>>>,
        load: Arc<std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>>,
    }
    struct SaveStop {
        reached: tokio::sync::oneshot::Sender<()>,
        fails: Option<String>,
        held: tokio::sync::oneshot::Receiver<()>,
    }
    /// The arming end of [`Saves`].
    #[derive(Clone, Default)]
    struct SaveGate(Arc<std::sync::Mutex<Option<SaveStop>>>, Arc<std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>>);
    impl SaveGate {
    }
    #[async_trait]
    impl RoomStore for Saves {
        async fn load(&self) -> Result<RoomDoc, RoomError> {
            let armed = self.load.lock().unwrap().take();
            if let Some((reached, held)) = armed {
                let _ = reached.send(());
                let _ = held.await;
            }
            self.inner.load().await
        }
        async fn save(&self, doc: &RoomDoc) -> Result<(), RoomError> {
            let armed = self.armed.lock().unwrap().take();
            if let Some(stop) = armed {
                let _ = stop.reached.send(());
                if let Some(text) = stop.fails {
                    return Err(RoomError::Port(text));
                }
                let _ = stop.held.await;
            }
            self.inner.save(doc).await
        }
    }

    /// How long a step may take before the test calls it hung (a failure bound, not a wait the test relies on).
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    type Service = RoomService<Saves, SessionRoomHost, Runner>;

    /// The room service over the production wiring (`wire`, as `compose_flip.rs` composes it), the real index, store and room
    /// records; the list's fence is the test's gate.
    struct Composed {
        service: Arc<Service>,
        list: Arc<ThreadListService>,
        agents: Arc<Agents>,
        app: MockConnection,
        summaries: Arc<RoomSummaries>,
        gate: Arc<Gate>,
        deletes: Arc<Deletes>,
        edges: Arc<ThreadEdges>,
        /// The index writes acknowledged and not yet projected (the list's fence).
        projections: Arc<StoreThreads>,
        /// Kept for the lifetime of the core: the rig's runtime and the folder of the core's files, which a restart opens again.
        _rig: Rig,
        _data: mixdog_core_session::session::testing::DataDir,
    }
    /// The room service, the agent deletion's room ports and the rooms' first load over the records, as `compose_flip.rs` composes
    /// them: every room call and a member forgotten await the first load, which hosts the rooms and prunes the members proven
    /// deleted. Each preparation that starts is counted in `prepares`.
    #[allow(clippy::too_many_arguments)]
    async fn rooms_over(
        rooms: &Arc<Rooms<Saves>>,
        host: &Arc<SessionRoomHost>,
        sessions: &Arc<dyn SessionOps>,
        agents: &Arc<Agents>,
        ops: &mixdog_store::state::CoreState,
        logged: &Arc<std::sync::Mutex<Vec<String>>>,
        live: &Arc<mixdog_core_rooms::rooms::live::LiveRooms>,
        runner: &Arc<Runner>,
    ) -> (Arc<Service>, Arc<SessionHomePorts<Saves>>, Arc<RoomsReady>, tokio::sync::watch::Receiver<u32>) {
        let ready = RoomsReady::new();
        let homes = Arc::new(SessionHomePorts::new(agents.clone(), sessions.clone(), rooms.clone(), host.clone(), runner.clone(), ready.clone()));
        let (started, prepares) = tokio::sync::watch::channel(0u32);
        ready
            .bind({
                let (live, rooms, homes, log, started) = (live.clone(), rooms.clone(), Arc::downgrade(&homes), room_log(logged), Arc::new(started));
                move || {
                    let (live, rooms, homes, log) = (live.clone(), rooms.clone(), homes.clone(), log.clone());
                    started.send_modify(|count| *count += 1);
                    async move {
                        live.host_loaded(&rooms).await?;
                        let Some(homes) = homes.upgrade() else { return Ok(()) };
                        homes.prune_deleted(&*log).await
                    }
                }
            })
            .expect("bound once");
        let scopes = mixdog_core_base::support::testing::scopes_over(ops.clone(), "room").await;
        let service = Arc::new(RoomService::new(rooms.clone(), host.clone(), runner.clone(), scopes, agents.clone(), ready.clone(), Arc::new(NoSends)));
        (service, homes, ready, prepares)
    }
    /// `room_log` of `compose_flip.rs`: each line prefixed `[mixdog-rooms] `.
    fn room_log(logged: &Arc<std::sync::Mutex<Vec<String>>>) -> Arc<dyn Fn(&str) + Send + Sync> {
        let logged = logged.clone();
        Arc::new(move |line| logged.lock().unwrap().push(format!("[mixdog-rooms] {line}")))
    }

    impl Composed {

        /// Waits until the index writes acknowledged so far are in the index (the list's fence) and their row edges published
        /// (`ThreadEdges::settled`): a write the store acknowledged reaches the index behind it, and its edge only then.
        async fn settled(&self, what: &str) {
            let projected = mixdog_core_session::session::thread_list::ListFence::pending(&*self.projections);
            let settled = async {
                if let Some(projected) = projected {
                    projected.await;
                }
                self.edges.settled().await;
            };
            mixdog_rt::time::timeout(DEADLINE, settled).await.unwrap_or_else(|_| panic!("{what}: the index writes acknowledged so far were not all in the index and published"));
        }
        async fn create(&self) -> tokio::task::JoinHandle<Result<Value, mixdog_core_api::CoreError>> {
            let service = self.service.clone();
            tokio::spawn(async move { value(&*service, request("room/create", with_op(json!({ "input": { "name": "Release", "members": ["gh", "rel"] } }), 1), Some(1))).await })
        }

        /// One room call through the service, its `input` as given, as the server dispatches it: once it has answered, its reply is
        /// queued and then the reply's mark set (`AppServer` `on_message`). Its answer or its error's text.
        async fn call(&self, method: &'static str, input: Value, op: u64) -> Result<Value, String> {
            let (answer, replied) = self.call_held(method, input, op).await;
            replied.release();
            answer
        }

        /// [`Self::call`] up to its answer, the reply's mark not yet set: the moment between the call's answer and its reply queued.
        async fn call_held(&self, method: &'static str, input: Value, op: u64) -> (Result<Value, String>, AfterAnswer) {
            let (answering, replied) = self.spawn_held(method, input, op);
            let answer = mixdog_rt::time::timeout(DEADLINE, answering)
                .await
                .unwrap_or_else(|_| panic!("{method} answered within the deadline"))
                .expect("the call's task");
            (answer.map_err(|error| format!("{error:?}")), replied)
        }

        /// The room call running, and the mark of its reply, not yet set.
        fn spawn_held(&self, method: &'static str, input: Value, op: u64) -> (tokio::task::JoinHandle<Result<Value, mixdog_core_api::CoreError>>, AfterAnswer) {
            let service = self.service.clone();
            let req = request(method, with_op(json!({ "input": input }), op), Some(op));
            // The server's copy: the reply's mark is the test's to set, not the dropped request's.
            let replied = req.ctx.after_answer.clone();
            (tokio::spawn(async move { value(&*service, req).await }), replied)
        }

        /// A room of every agent, made while every listing fails, its creation's background listing ended: the catalog is not loaded.
        async fn unloaded_room(&self) -> Value {
            self.agents.lookup_fails.store(true, std::sync::atomic::Ordering::SeqCst);
            let members: Vec<&str> = self.agents.roster.iter().map(|(id, _)| id.as_str()).collect();
            let created = self.call("room/create", json!({ "name": "Release", "members": members }), 1).await.expect("room/create");
            mixdog_rt::time::timeout(DEADLINE, self.summaries.background_ended()).await.expect("the creation's background listing never ended");
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
        mixdog_rt::time::timeout(DEADLINE, arrived).await.expect("the room create never published the catalog").expect("gate");
        assert!(!creating.is_finished(), "the room create answered while its publish was held");
        open.send(()).expect("the publish waits at the gate");
        let created = mixdog_rt::time::timeout(DEADLINE, creating).await.expect("room/create answered within the deadline").expect("task").expect("room/create");
        let room = log_of(&created);
        // The row reached the feed once, by the log's write or by the publish: a catalog the feed already holds is not handed again.
        let sent: Vec<String> = world
            .app
            .drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).expect("frame"))
            .filter(|frame| frame["method"] == "thread/started" || frame["method"] == "thread/summary/updated")
            .filter_map(|frame| frame["params"]["thread"]["id"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(sent.iter().filter(|id| **id == room).count(), 1, "the room's row was sent once before the reply: {sent:?}");
        let listed = value(world.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
        let ids: Vec<&str> = listed["data"].as_array().expect("data").iter().filter_map(|row| row["id"].as_str()).collect();
        assert!(ids.contains(&room.as_str()), "thread/list at the reply lists the room {room}: {ids:?}");
    }

    /// The room log's write and the create's room pass both send the log's row: the pass waits until the write's own notification
    /// is out, so the client is told `thread/started` of the log before any `thread/summary/updated` of it (Node sends one catalog,
    /// `session-host-catalog.ts:217-238`). The index writes' notifications held at their lookup, a pass waits for them; let go, the
    /// log's first frame is `thread/started`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_pass_sends_the_log_row_only_after_its_write_is_announced() {
        let world = composed().await;
        world.load_catalog().await;
        world.settled("the first listing").await;
        drop(world.app.drain_text());
        let mut waits = world.edges.waits();
        let before = *waits.borrow_and_update();
        let (open, arrived) = world.agents.arm_edges();
        let creating = world.create().await;
        mixdog_rt::time::timeout(DEADLINE, arrived).await.expect("the room create's writes were never announced").expect("stop");
        mixdog_rt::time::timeout(DEADLINE, waits.wait_for(|waits| *waits > before))
            .await
            .expect("no room pass waited for the room create's writes to be announced")
            .expect("the waits are held by the edges");
        open.send(()).expect("the announcement waits at the stop");
        let created = mixdog_rt::time::timeout(DEADLINE, creating).await.expect("room/create answered within the deadline").expect("task").expect("room/create");
        world.settled("the room create").await;
        let room = log_of(&created);
        let frames: Vec<String> = world
            .app
            .drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).expect("frame"))
            .filter(|frame| frame["params"]["thread"]["id"] == room.as_str())
            .map(|frame| frame["method"].as_str().expect("method").to_owned())
            .collect();
        assert_eq!(frames.first().map(String::as_str), Some("thread/started"), "the room log's frames: {frames:?}");
    }

    /// Node's room rename (`fixtures/frame-order` on `writer-order`, scenario `room-rename`) reaches the phone as one roster frame
    /// carrying the room's row: its relay skips a publication that changes nothing (`remote-relay-catalog.ts:79-91`). The core's
    /// rename writes the log's title (an index edge), lists the whole catalog and republishes the rooms: the app feed carries the
    /// room's row once, with the new title and room name, and no other row, the background edge included.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_rename_announces_the_room_row_once() {
        let world = composed().await;
        world.load_catalog().await;
        let created = tokio::time::timeout(DEADLINE, world.create().await).await.expect("room/create answered").expect("task").expect("room/create");
        let room = log_of(&created);
        world.settled("the create").await;
        drop(frames(&world.app));
        world.call("room/update", json!({ "roomId": created["roomId"], "name": "Renamed" }), 2).await.expect("room/update");
        world.settled("the rename").await;
        let rows: Vec<Value> = frames(&world.app)
            .into_iter()
            .filter(|frame| frame["method"] == "thread/summary/updated" || frame["method"] == "thread/started")
            .map(|frame| frame["params"]["thread"].clone())
            .collect();
        assert_eq!(rows.len(), 1, "one announcement of one row: {rows:?}");
        assert_eq!(rows[0]["id"], room.as_str());
        assert_eq!((rows[0]["title"].as_str(), rows[0]["agentRoom"]["name"].as_str()), (Some("Renamed"), Some("Renamed")));
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
        mixdog_rt::time::timeout(DEADLINE, async {
            tokio::select! {
                reached = arrived => reached.expect("stop"),
                answered = &mut updating => panic!("the update answered without deleting the removed member's session: {answered:?}"),
            }
        })
        .await
        .expect("the update never deleted the removed member's session");
        // The room's row went to the feed when the room was made, and the listing's copy of it is the one Node's catalog channel
        // does not hand again (`session-host-publication.ts:141`): what shows the listing published is that it has ended.
        mixdog_rt::time::timeout(DEADLINE, world.summaries.background_ended())
            .await
            .expect("the listing had not ended when the deletion began");
        assert!(world.list.catalog_loaded(), "the listing had not been answered when the deletion began");
        assert!(!updating.is_finished(), "the update answered before its deletion went on");

        open.send(()).expect("the deletion waits at the stop");
        let answer = mixdog_rt::time::timeout(DEADLINE, updating).await.expect("the update never answered").expect("task").expect("room/update");
        assert_eq!(answer["members"], json!(["gh", "rel"]), "{answer}");
        replied.release();
        assert!(world.list.catalog_loaded(), "the joined listing loaded the catalog");
    }
    /// The frames the app feed has been sent since the last drain, in order.
    fn frames(app: &MockConnection) -> Vec<Value> {
        app.drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
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
        fn release_unloaded_runtime(&self, session_id: &str) {
            self.inner.release_unloaded_runtime(session_id);
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
        composed_over(Arc::new(agents), mixdog_core_session::session::testing::DataDir::default(), SaveGate::default(), Arc::default()).await
    }

    struct NoShells;
    impl mixdog_core_session::session::shell_jobs::OwnedShells for NoShells {
        fn cancel_owned(&self, _: &ThreadId) {}
    }
    struct NoProviders;
    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
            Err(format!("no {name}"))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            false
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// The core composed over the files in `data` (a new folder, or the one a core before it wrote).
    async fn composed_over(
        agents: Arc<Agents>,
        data: mixdog_core_session::session::testing::DataDir,
        saves: SaveGate,
        logged: Arc<std::sync::Mutex<Vec<String>>>,
    ) -> Composed {
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
        let rooms = Arc::new(Rooms::new(Saves { inner: StateRoomStore::new(data.state(state)), armed: saves.0.clone(), load: saves.1.clone() }));
        let deletes = Arc::new(Deletes {
            inner: Arc::new(DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory.clone())))),
            armed: std::sync::Mutex::new(None),
        });
        let sessions: Arc<dyn SessionOps> = deletes.clone();
        // The live rooms and the runner as `compose_flip.rs` composes them: the room daemon is the production one over the session
        // directory, its catalog republish the summaries', bound once they exist (`late_room_summaries`).
        let late_summaries: Arc<std::sync::OnceLock<Arc<RoomSummaries>>> = Arc::default();
        let exchanges = Arc::new(HeldLabels::default());
        let close = Arc::new(mixdog_core_session::session::close::SessionClose::new(
            directory.clone(),
            Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders))),
            Arc::new(NoShells),
            Arc::new(mixdog_tools::fs::ReadState::new(None)),
        ));
        let released = agents.clone();
        let live = mixdog_core_rooms::rooms::live::LiveRooms::new(
            rooms.clone(),
            mixdog_core_rooms::rooms::live::RoomPorts {
                daemon: Arc::new(
                    crate::run_host::room_daemon::DirectoryRoomDaemon::new(directory.clone(), {
                        let late = late_summaries.clone();
                        Arc::new(move || {
                            if let Some(summaries) = late.get() {
                                summaries.republish();
                            }
                        })
                    })
                    .with_between_open_and_post(Arc::new(move |thread| {
                        let (close, released) = (close.clone(), released.clone());
                        Box::pin(async move {
                            if released.detach_next_post.swap(false, std::sync::atomic::Ordering::SeqCst) {
                                assert!(close.detach(thread.as_str(), "no live session clients", false).await, "the room log is released");
                            }
                        })
                    })),
                ),
                approvals: Arc::new(Unreached),
                labels: exchanges.clone(),
                files: Arc::new(Unreached),
                sessions: sessions.clone(),
                catalog: agents.clone(),
                maintainer: Arc::new(Unreached),
                preview: Arc::new(|text: &str| mixdog_core_rooms::rooms::preview::plain_preview_text(text)),
                log: room_log(&logged),
                // `Date.now()` of the room host: the compared time fields are named by order, not value.
                now: Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as i64)),
            },
        );
        let calls =mixdog_core_rooms::rooms::calls::RoomCalls::new(Arc::new(mixdog_core_rooms::rooms::exchange_run::ExchangeRunner::new(live.clone())), room_log(&logged));
        live.bind_relays(Arc::new({
            let calls = Arc::downgrade(&calls);
            move |room: &str, error: &str| {
                if let Some(calls) = calls.upgrade() {
                    calls.fail_relays(room, error)
                }
            }
        }));
        let runner: Arc<Runner> = Arc::new(mixdog_core_rooms::rooms::runner::CallsRunner::new(calls, live.clone()));
        let room_rows = Arc::new(RoomListRows::new(rooms.clone(), runner.clone(), agents.clone()));
        let gate = Arc::new(Gate { armed: std::sync::Mutex::new(None), agents: agents.clone() });
        let list = Arc::new(ThreadListService::new(Arc::new(index.clone()), Arc::new(Quiet), room_rows, gate.clone()));
        list.fence(store.clone());
        let deletions = mixdog_core_session::session::thread_edges::ThreadDeletions::new(sections.clone());
        let publication = wire(list.clone(), sections, deletions, agents.clone(), &index, directory, sessions.clone()).expect("wired");
        assert!(late_summaries.set(publication.summaries.clone()).is_ok(), "the summaries are bound once");
        let ops = data.state(mixdog_core_base::support::testing::op_state(data.path()));
        let host = publication.host;
        let (service, homes, ready, prepares) = rooms_over(&rooms, &host, &sessions, &agents, &ops, &logged, &live, &runner).await;
        drop((homes, ready, prepares));
        Composed {
            service,
            list,
            agents,
            app,
            gate,
            deletes,
            summaries: publication.summaries,
            edges: publication.edges,
            projections: store,
            _rig: rig,
            _data: data,
        }
    }
}


