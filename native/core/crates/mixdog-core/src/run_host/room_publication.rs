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
    /// The index writes' publisher (a test waits for it to have published every write so far).
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    edges: Arc<ThreadEdges>,
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
    #[cfg(not(any(test, feature = "test-support")))]
    drop(edges);
    Ok(RoomPublication {
        summaries,
        host,
        #[cfg(any(test, feature = "test-support"))]
        edges,
    })
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
        /// The ids of each presence check, in order (only the rooms' first load checks presence here).
        checked: std::sync::Mutex<Vec<Vec<String>>>,
        /// A stop in front of the index writes' next lookup (the edges look the workspace up here, the listings through `Gate`).
        edge_stop: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
        /// A stop in front of the next presence check (the rooms' first load's member check).
        presence_stop: std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
    }
    impl Agents {
        fn new(roster: Vec<(String, String)>) -> Self {
            Self {
                lookup_fails: false.into(),
                roster,
                deleted: std::sync::Mutex::default(),
                checked: std::sync::Mutex::default(),
                edge_stop: std::sync::Mutex::default(),
                presence_stop: std::sync::Mutex::default(),
            }
        }
        /// The opener and the arrival signal of the next presence check.
        fn arm_presence(&self) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.presence_stop.lock().unwrap() = Some((reached, held));
            (open, arrived)
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
        /// The arrival signal of the next exchange.
        fn arm(&self) -> tokio::sync::oneshot::Receiver<()> {
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.armed.lock().unwrap() = Some(reached);
            arrived
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
        fn publish_view(&self, _: &str, _: Option<mixdog_core_rooms::rooms::live::ExchangeView>, _: Vec<Value>) {}
    }
    #[async_trait]
    impl mixdog_core_rooms::rooms::live::RoomFiles for Unreached {
        async fn take_in(&self, _: &str, row: Value) -> Result<Value, String> {
            Ok(row)
        }
    }
    #[async_trait]
    impl mixdog_core_rooms::rooms::maintainer::Maintainer for Unreached {
        async fn ask(&self, _: &str, _: &str) -> mixdog_core_rooms::rooms::maintainer::Maintained {
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
        /// The opener and the arrival signal of the next save, which fails with `fails` when given.
        fn arm(&self, fails: Option<String>) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.0.lock().unwrap() = Some(SaveStop { reached, fails, held });
            (open, arrived)
        }
        /// The opener and the arrival signal of the next load (a core's first read of the room records).
        fn arm_load(&self) -> (tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>) {
            let (open, held) = tokio::sync::oneshot::channel();
            let (reached, arrived) = tokio::sync::oneshot::channel();
            *self.1.lock().unwrap() = Some((reached, held));
            (open, arrived)
        }
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
        homes: Arc<SessionHomePorts<Saves>>,
        ready: Arc<RoomsReady>,
        agents: Arc<Agents>,
        app: MockConnection,
        gate: Arc<Gate>,
        deletes: Arc<Deletes>,
        saves: SaveGate,
        summaries: Arc<RoomSummaries>,
        rooms: Arc<Rooms<Saves>>,
        host: Arc<SessionRoomHost>,
        sessions: Arc<dyn SessionOps>,
        ops: mixdog_store::state::CoreState,
        /// The rooms' log (`[mixdog-rooms] <line>`, `compose_flip.rs` `room_log`), line by line.
        logged: Arc<std::sync::Mutex<Vec<String>>>,
        edges: Arc<ThreadEdges>,
        /// The index writes acknowledged and not yet projected (the list's fence).
        projections: Arc<StoreThreads>,
        rig: Rig,
        /// The folder of the core's files, which a restart opens again.
        data: mixdog_core_session::session::testing::DataDir,
        /// The live rooms (their exchanges, and the start-up's recovery of the rooms cut off).
        live: Arc<mixdog_core_rooms::rooms::live::LiveRooms>,
        /// Where an exchange stops after its start.
        exchanges: Arc<HeldLabels>,
        /// How many preparations of the rooms' first load have started.
        prepares: tokio::sync::watch::Receiver<u32>,
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
        let service = Arc::new(RoomService::new(rooms.clone(), host.clone(), runner.clone(), scopes, agents.clone(), ready.clone()));
        (service, homes, ready, prepares)
    }

    /// The start-up's recovery as `compose_flip.rs` passes it to `ready::recover`: the rooms cut off marked interrupted, then the
    /// catalog republished, bounded.
    fn recovery(world: &Composed) -> impl FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), RoomError>> + Send>> + Send + 'static {
        let (live, rooms, summaries) = (world.live.clone(), world.rooms.clone(), world.summaries.clone());
        move || {
            Box::pin(async move {
                live.recover(&rooms).await?;
                tokio::time::timeout(DEADLINE, summaries.republish_now())
                    .await
                    .map_err(|_| RoomError::Port("the catalog's republish after the rooms' first load did not end within the deadline".into()))
            })
        }
    }

    /// `room_log` of `compose_flip.rs`: each line prefixed `[mixdog-rooms] `.
    fn room_log(logged: &Arc<std::sync::Mutex<Vec<String>>>) -> Arc<dyn Fn(&str) + Send + Sync> {
        let logged = logged.clone();
        Arc::new(move |line| logged.lock().unwrap().push(format!("[mixdog-rooms] {line}")))
    }

    impl Composed {
        /// The core restarted from its files: every part of this one ended and its databases closed, a new core composed over the
        /// same folder (the index, the session store and the room records read back from what this one wrote; the agents are the
        /// daemon's, which outlives it), and its start-up `recover` as `compose_flip.rs` starts it ([`recovery`]), ahead of the
        /// mutations that awaited the first load. An exchange the old core held stays held. The new core's app feed is a new
        /// connection.
        async fn restart(self) -> (Self, tokio::task::JoinHandle<()>) {
            let Composed { service, list, homes, ready, agents, app, gate, deletes, saves, summaries, rooms, host, sessions, ops, logged, edges, projections, rig, data, live, exchanges, prepares } = self;
            drop((service, list, homes, ready, app, gate, deletes, summaries, rooms, host, sessions, ops, edges, projections, rig, live, exchanges, prepares));
            data.close_databases();
            let world = composed_over(agents, data, saves, logged).await;
            let started = mixdog_core_rooms::rooms::ready::recover(world.rooms.clone(), world.ready.clone(), recovery(&world), room_log(&world.logged));
            (world, started)
        }

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

        /// A whole `thread/list` answer.
        async fn listed(&self) -> Value {
            value(self.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list")
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
        mixdog_rt::time::timeout(DEADLINE, arrived).await.expect("the room create never published the catalog").expect("gate");
        assert!(!creating.is_finished(), "the room create answered while its publish was held");
        drop(world.sent("thread/summary/updated"));
        open.send(()).expect("the publish waits at the gate");
        let created = mixdog_rt::time::timeout(DEADLINE, creating).await.expect("room/create answered within the deadline").expect("task").expect("room/create");
        let room = log_of(&created);
        assert!(world.sent("thread/summary/updated").contains(&room), "the publish sent the room's row before the reply");
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
        assert_as_recorded(&tokio::spawn(replay("not-loaded-large", Some("update-rounds"))).await.expect("the test task"));
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
        assert!(world.sent("thread/summary/updated").contains(&log_of(&created)), "the listing had not sent the room's row when the deletion began");
        assert!(!updating.is_finished(), "the update answered before its deletion went on");

        open.send(()).expect("the deletion waits at the stop");
        let answer = mixdog_rt::time::timeout(DEADLINE, updating).await.expect("the update never answered").expect("task").expect("room/update");
        assert_eq!(answer["members"], json!(["gh", "rel"]), "{answer}");
        replied.release();
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
    #[derive(Clone, Default)]
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
            // A room log by its room (a deletion names the log alone).
            let room = row["agentRoom"]["id"].as_str().map(str::to_owned).or_else(|| row["id"].as_str().and_then(|id| id.strip_prefix("sess_room_")).map(str::to_owned));
            let id = room.clone().unwrap_or_else(|| row["id"].as_str().expect("session id").to_owned());
            let at = self.ids.iter().position(|seen| *seen == id).unwrap_or_else(|| (self.ids.push(id.clone()), self.ids.len() - 1).1);
            if room.is_some() {
                row["id"] = json!(format!("<room log {at}>"));
                if row["agentRoom"].is_object() {
                    row["agentRoom"]["id"] = json!(format!("<room {at}>"));
                }
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
    /// `fixtures/room-catalog-states`), replayed whole and in order through the production wiring: per step, whether the catalog was
    /// loaded before and after it, how it ended, the rooms' log and first-load checks, and every catalog Node published in it, of
    /// every origin, in order and count, before and after its answer, against the core's app feed frame by frame, folded as a
    /// listener folds it (see [`compare_part`]). Node's listing fault (the daemon's `session.list` failing, per step as recorded) is
    /// the core's listing failing at its first step, the task workspace lookup.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn room_calls_replay_nodes_catalog_states() {
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-catalog-states/MANIFEST.json")).expect("manifest"),
        )
        .expect("manifest json");
        assert_eq!(manifest["product"]["exact"], json!(true), "the recording is of the exact product");
        let mut failures = Vec::new();
        for scenario in manifest["scenarios"].as_array().expect("scenarios") {
            failures.extend(replay(scenario.as_str().expect("scenario"), None).await);
        }
        assert_as_recorded(&failures);
    }

    /// One recorded scenario replayed; the parts of it that differ from Node's publications ([`compare_part`]), every other
    /// difference failing at once. At step `forced` (a call that starts a background listing), the listing is let have its rows in
    /// hand before the replay reads what the call sent by its reply: the order a busy runtime can produce.
    async fn replay(scenario: &str, forced: Option<&str>) -> Vec<String> {
        let node = recorded(scenario);
        let mut differences = Differences::of(scenario);
        let bots: Vec<String> = node["bots"].as_array().expect("bots").iter().map(|b| b.as_str().expect("bot").to_owned()).collect();
        // The bots' names, as their saved definitions answered them.
        let names = node["botNames"].as_object().expect("the bots' names");
        let roster = bots.iter().map(|id| (id.clone(), names[id].as_str().expect("name").to_owned())).collect();
        let mut world = composed_with(Agents::new(roster)).await;
        // A first load held at its save by one step, opened by the next: the save's opener and the start-up running.
        let mut held_save: Option<(tokio::sync::oneshot::Sender<()>, tokio::task::JoinHandle<()>)> = None;
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
                    let listed = world.listed().await;
                    assert!(world.list.catalog_loaded(), "{what}: the listing loaded the catalog");
                    world.settled(&what).await;
                    let sent = frames(&world.app);
                    assert_eq!(listed_rows(&listed, &mut core_names, &step["sessions"]), named_rows(&step["sessions"], &mut node_names), "{what}: the listing");
                    compare_part(&what, "the step", &events, &sent, &mut fold, &mut node_names, &mut core_names, &mut differences);
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedAfter"], "{what}: loaded after the step");
                }
                // The core's flag is the list service's, which a lost transport or a reloaded window does not replace.
                "transport-loss-and-renderer-reload" => {
                    world.settled(&what).await;
                    let sent = frames(&world.app);
                    compare_part(&what, "the step", &events, &sent, &mut fold, &mut node_names, &mut core_names, &mut differences);
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedAfter"], "{what}: loaded after the step");
                }
                call => {
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedBefore"], "{what}: loaded before the call");
                    // What the client was sent since the step before ended: Node's events since then are this step's.
                    let pre = frames(&world.app);
                    created += 1;
                    let room_id = room.as_ref().map(|r| r["roomId"].clone()).unwrap_or(Value::Null);
                    // A listing held at its lookup until the call's reply is queued.
                    let mut after_reply: Option<tokio::sync::oneshot::Sender<()>> = None;
                    let (answer, replied) = match call {
                        "create" => world.call_held("room/create", json!({ "name": "Room One", "members": bots }), created).await,
                        "update" => world.call_held("room/update", json!({ "roomId": room_id, "name": "Room Renamed" }), created).await,
                        "update-rounds" => world.call_held("room/update", json!({ "roomId": room_id, "maxRounds": 4 }), created).await,
                        "reset" => world.call_held("room/reset", json!({ "roomId": room_id }), created).await,
                        "remove" => world.call_held("room/remove", json!({ "roomId": room_id }), created).await,
                        // No client call: nothing waits for a reply (`agent-rooms.ts:339-350`).
                        "forget-member" => {
                            let forget = world.homes.forget_room_member(&bots[2]);
                            let answer = mixdog_rt::time::timeout(DEADLINE, forget).await.expect("forget_room_member answered");
                            (answer.map(|()| Value::Null).map_err(|error| format!("{error:?}")), AfterAnswer::default())
                        }
                        // No client call: the core restarted from its files (`Composed::restart`), as Node's host is made again; then a
                        // listing, which Node's step answers with.
                        "restart-and-list" => {
                            let (next, started) = world.restart().await;
                            (world, fold) = (next, Fold::default());
                            mixdog_rt::time::timeout(DEADLINE, started).await.unwrap_or_else(|_| panic!("{what}: the start-up never ended")).expect("the start-up");
                            (Ok(world.listed().await), AfterAnswer::default())
                        }
                        // No client call: the third bot's definition deleted past the host, then the core restarted (`Composed::restart`):
                        // its start-up `recover` runs the rooms' first load, which prunes the member. Node's step ends at the first load's
                        // end, or, with its save held, once the save is reached, or, with its save failing, at the start-up's logged end.
                        "restart-after-agent-deletion" | "restart-held-at-save" | "restart-save-fails" => {
                            world.agents.deleted.lock().unwrap().push(bots[2].clone());
                            let mut stop = match call {
                                "restart-held-at-save" => Some(world.saves.arm(None)),
                                "restart-save-fails" => {
                                    let failure = events.iter().find(|e| e["kind"] == "logged").and_then(|e| e["parts"][1]["error"].as_str());
                                    Some(world.saves.arm(Some(failure.expect("Node's logged save failure").to_owned())))
                                }
                                _ => None,
                            };
                            let (next, started) = world.restart().await;
                            (world, fold) = (next, Fold::default());
                            if let Some((_, arrived)) = &mut stop {
                                mixdog_rt::time::timeout(DEADLINE, arrived)
                                    .await
                                    .unwrap_or_else(|_| panic!("{what}: the first load never reached its save"))
                                    .expect("the save's stop");
                            }
                            match stop {
                                Some((open, _)) if call == "restart-held-at-save" => held_save = Some((open, started)),
                                _ => mixdog_rt::time::timeout(DEADLINE, started).await.unwrap_or_else(|_| panic!("{what}: the start-up never ended")).expect("the start-up"),
                            }
                            (Ok(Value::Null), AfterAnswer::default())
                        }
                        // While the first load is held at its save: a room update (it awaits the first load) is started, a listing (it
                        // does not) is answered, and whether the update had ended by then is Node's; then the save goes on.
                        "update-rounds-and-list-while-held" => {
                            let (open, started) = held_save.take().expect("the save held by the step before");
                            let (updating, replied) = world.spawn_held("room/update", json!({ "roomId": room_id, "maxRounds": 4 }), created);
                            let listed = mixdog_rt::time::timeout(DEADLINE, value(world.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)))
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the listing never answered while the save was held"))
                                .expect("thread/list");
                            let node_listed = events.iter().find(|e| e["kind"] == "listed").expect("Node's listing")["sessions"].clone();
                            assert_eq!(
                                listed_rows(&listed, &mut core_names, &node_listed),
                                named_rows(&node_listed, &mut node_names),
                                "{what}: the listing while the save is held"
                            );
                            let ended = &events.iter().find(|e| e["kind"] == "update-ended-before-the-save").expect("Node's update state")["ended"];
                            assert_eq!(&json!(updating.is_finished()), ended, "{what}: whether the update had ended while the save was held");
                            // The prune goes on past its save to its member's conversation deletion, stopped there: the first load is
                            // still pending, and whether the update had ended by then is Node's.
                            let (deleting, deletion) = world.deletes.arm();
                            open.send(()).expect("the save waits at its stop");
                            mixdog_rt::time::timeout(DEADLINE, deletion)
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the prune never reached its member's deletion"))
                                .expect("the deletion's stop");
                            let ended = &events.iter().find(|e| e["kind"] == "update-ended-before-the-deletion").expect("Node's update state")["ended"];
                            assert_eq!(&json!(updating.is_finished()), ended, "{what}: whether the update had ended when the prune reached its deletion");
                            deleting.send(()).expect("the deletion waits at its stop");
                            let answer = mixdog_rt::time::timeout(DEADLINE, updating)
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the update never answered once the save went on"))
                                .expect("the update's task");
                            mixdog_rt::time::timeout(DEADLINE, started).await.unwrap_or_else(|_| panic!("{what}: the start-up never ended")).expect("the start-up");
                            (answer.map_err(|error| format!("{error:?}")), replied)
                        }
                        "list-sessions" => {
                            let listed = value(world.list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.map_err(|error| format!("{error:?}"));
                            (listed, AfterAnswer::default())
                        }
                        // The room's exchange started and stopped at its first step after its start saved the room running (`HeldLabels`),
                        // as Node's is held after its start's save; the core is restarted under it by the next step.
                        // Its catalog republish (a whole listing: the catalog is not loaded) is held at its lookup until the reply is
                        // queued: Node's waits for the start's save and a daemon listing (`agent-room-exchange.ts:137-138`) while the
                        // continue answers at once (`agent-rooms.ts:414`); the core's exchange runs beside the reply, unordered.
                        "continue-held" => {
                            after_reply = Some(world.gate.arm().0);
                            let arrived = world.exchanges.arm();
                            let held = world.call_held("room/continue", json!({ "roomId": room_id }), created).await;
                            tokio::time::timeout(DEADLINE, arrived)
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the exchange never went past its start"))
                                .expect("the exchange's stop");
                            held
                        }
                        // No client call first: the core restarted (`Composed::restart`, no definition deleted), its start-up's recovery
                        // and a room update that awaits the same first load met as Node's recording names them (`startup`): the update
                        // starting the first load while the start-up's read of the room records is held; a member forgotten starting it
                        // there and the update called while the first load is held at its member check; or, with a room cut off, the
                        // update called there. The core's order of the two is one ([`RoomsReady::ready`]); Node's other is a named
                        // difference. The step's answer is the update's.
                        "restart-and-update" => {
                            let waiters = node["startup"].as_str().expect("the start-up's waiters");
                            let load = (waiters != "interrupted").then(|| world.saves.arm_load());
                            let (presence_open, presence) = world.agents.arm_presence();
                            let (next, started) = world.restart().await;
                            (world, fold) = (next, Fold::default());
                            let update = |world: &Composed| world.spawn_held("room/update", json!({ "roomId": room_id, "maxRounds": 4 }), created);
                            let mut updating = None;
                            let mut forgetting = None;
                            if let Some((load_open, load_arrived)) = load {
                                tokio::time::timeout(DEADLINE, load_arrived)
                                    .await
                                    .unwrap_or_else(|_| panic!("{what}: the start-up never read the room records"))
                                    .expect("the load's stop");
                                let mut prepares = world.prepares.clone();
                                let before = *prepares.borrow_and_update();
                                if waiters == "update-before-recovery" {
                                    updating = Some(update(&world));
                                } else {
                                    let (homes, spare) = (world.homes.clone(), node["spareBot"].as_str().expect("the bot in no room").to_owned());
                                    forgetting = Some(tokio::spawn(async move { homes.forget_room_member(&spare).await }));
                                }
                                tokio::time::timeout(DEADLINE, prepares.wait_for(|count| *count > before))
                                    .await
                                    .unwrap_or_else(|_| panic!("{what}: the call never started the rooms' first load"))
                                    .expect("the preparations' count");
                                load_open.send(()).expect("the load waits at its stop");
                            }
                            tokio::time::timeout(DEADLINE, presence)
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the first load never checked its members"))
                                .expect("the check's stop");
                            let (updating, replied) = updating.unwrap_or_else(|| update(&world));
                            presence_open.send(()).expect("the check waits at its stop");
                            let answer = tokio::time::timeout(DEADLINE, updating)
                                .await
                                .unwrap_or_else(|_| panic!("{what}: the update never answered"))
                                .expect("the update's task");
                            if let Some(forgetting) = forgetting {
                                tokio::time::timeout(DEADLINE, forgetting)
                                    .await
                                    .unwrap_or_else(|_| panic!("{what}: the member was never forgotten"))
                                    .expect("the forgetting's task")
                                    .expect("the member forgotten");
                            }
                            tokio::time::timeout(DEADLINE, started).await.unwrap_or_else(|_| panic!("{what}: the start-up never ended")).expect("the start-up");
                            (answer.map_err(|error| format!("{error:?}")), replied)
                        }
                        other => panic!("{what}: a call this replay does not know: {other}"),
                    };
                    if forced == Some(name) {
                        assert!(
                            step["loadedBefore"] == json!(false) && step["listingFails"] != json!(true),
                            "{what}: the forced step starts no background listing that lists"
                        );
                        mixdog_rt::time::timeout(DEADLINE, world.summaries.listing_in_hand())
                            .await
                            .unwrap_or_else(|_| panic!("{what}: the call's background listing never had its rows in hand"));
                    }
                    // What the client was sent before the reply (the server queues the reply and then sets its mark), the index writes
                    // the call made published.
                    world.settled(&what).await;
                    let mut sent = pre;
                    sent.extend(frames(&world.app));
                    replied.release();
                    if let Some(open) = after_reply.take() {
                        let _ = open.send(());
                    }
                    // Node's recorder awaits the call's background listing to its end before the next step sets its listing fault; so
                    // does the replay, for the core's, and for what the index writes made by then publish.
                    mixdog_rt::time::timeout(DEADLINE, world.summaries.background_ended())
                        .await
                        .unwrap_or_else(|_| panic!("{what}: the core's background listing did not end"));
                    world.settled(&what).await;
                    let later = frames(&world.app);
                    let node_answer = events.iter().find(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    // The rooms' log while the step ran: Node's lines (`console.warn` of its text and the error's message), the core's.
                    let node_logged: Vec<String> = events
                        .iter()
                        .filter(|e| e["kind"] == "logged")
                        .map(|e| {
                            let parts = e["parts"].as_array().expect("parts");
                            parts.iter().map(|part| part["error"].as_str().or(part.as_str()).expect("a text part").to_owned()).collect::<Vec<_>>().join(" ")
                        })
                        .collect();
                    assert_eq!(std::mem::take(&mut *world.logged.lock().unwrap()), node_logged, "{what}: the rooms' log");
                    // Whether a first load ran in the step (a failed one is run again by the next call that awaits it), by its checks.
                    let node_checked: Vec<Value> = events.iter().filter(|e| e["kind"] == "prune-checked").map(|e| e["ids"].clone()).collect();
                    let checked: Vec<Value> = std::mem::take(&mut *world.agents.checked.lock().unwrap()).into_iter().map(|ids| json!(ids)).collect();
                    assert_eq!(checked, node_checked, "{what}: the rooms' first load's member checks");
                    match (&answer, node_answer["kind"].as_str()) {
                        (Ok(listed), Some("answered")) if matches!(call, "list-sessions" | "restart-and-list") => {
                            assert_eq!(
                                listed_rows(listed, &mut core_names, &node_answer["value"]),
                                named_rows(&node_answer["value"], &mut node_names),
                                "{what}: the listing"
                            );
                        }
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
                            let node_value = if node_answer["value"].is_null()
                                && !matches!(call, "forget-member" | "restart-after-agent-deletion" | "restart-held-at-save" | "restart-save-fails")
                            {
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
                    // Every catalog Node published in the step, before its answer and after it, against the core's frames.
                    let answered_at = events.iter().position(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    compare_part(&what, "before the answer", &events[..answered_at], &sent, &mut fold, &mut node_names, &mut core_names, &mut differences);
                    compare_part(&what, "after the answer", &events[answered_at..], &later, &mut fold, &mut node_names, &mut core_names, &mut differences);
                    assert_eq!(json!(world.list.catalog_loaded()), step["loadedAfter"], "{what}: loaded after the call");
                }
            }
        }
        differences.finish()
    }

    /// Fails with every part of the replayed scenarios that differs from Node's recording.
    fn assert_as_recorded(failures: &[String]) {
        assert!(failures.is_empty(), "{} part(s) differ from Node's recording:\n{}", failures.len(), failures.join("\n"));
    }

    /// The core's known differences from Node in what the client is sent, each with its owner (`coreDifferences` of the set's
    /// manifest, from `benchmarks/rust-core/recorders/room-catalog-core-differences.json`): one part of one step and Node's
    /// publications in it exactly, then either the core's frames in it exactly with, for each frame, the Node publication whose row
    /// it carries (or, for a row no publication of Node's has, that row exactly), or (an order Node can produce and the core cannot)
    /// `compareWith`: the recorded scenario whose same step and part
    /// is the order the core produces, which the core's part then equals whole. A part that differs from Node and is not named so, a
    /// named part that differs from its entry, and an entry no part used all fail the replay, together, at its end.
    struct Differences {
        entries: Vec<(Value, bool)>,
        /// Per `compareWith` scenario: Node's publications of each step and part, named as that scenario's own replay names them.
        compared: HashMap<String, HashMap<(String, String), Vec<(String, Vec<Value>)>>>,
        failures: Vec<String>,
    }
    impl Differences {
        fn of(scenario: &str) -> Self {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/room-catalog-states/MANIFEST.json");
            let manifest: Value = serde_json::from_slice(&std::fs::read(&path).expect("manifest")).expect("manifest json");
            let entries: Vec<(Value, bool)> = manifest["coreDifferences"]["differences"]
                .as_array()
                .expect("the manifest's coreDifferences")
                .iter()
                .filter(|entry| entry["scenario"] == scenario)
                .map(|entry| (entry.clone(), false))
                .collect();
            let mut compared = HashMap::new();
            for (entry, _) in &entries {
                if let Some(with) = entry["compareWith"].as_str() {
                    compared.entry(with.to_owned()).or_insert_with(|| node_parts(with));
                }
            }
            Self { entries, compared, failures: Vec::new() }
        }
        fn entry(&mut self, step: &str, part: &str) -> Option<Value> {
            let (entry, used) = self.entries.iter_mut().find(|(entry, _)| entry["step"] == step && entry["part"] == part)?;
            assert!(!*used, "two parts named {step} / {part}");
            *used = true;
            Some(entry.clone())
        }
        /// The parts that differ from Node unnamed or not as named, and the named differences no part used.
        fn finish(self) -> Vec<String> {
            let mut failures = self.failures;
            for (entry, used) in self.entries {
                if !used {
                    failures.push(format!("a named difference no part of the replay has: {entry}"));
                }
            }
            failures
        }
    }

    /// A frame of the app feed by what it is: its method and the row it names.
    fn frame_shape(frame: &Value, names: &mut Names) -> String {
        let params = &frame["params"];
        let id = match params["thread"].as_object() {
            Some(_) => names.named(&params["thread"])["id"].clone(),
            None => names.named(&json!({ "id": params["threadId"] }))["id"].clone(),
        };
        format!("{} {}", frame["method"].as_str().expect("method"), id.as_str().expect("named id"))
    }

    /// One part of a step (before its answer, after it, or the whole of a step without an answer), compared whole, in order and
    /// count: Node's `published` events (every origin, each the whole catalog a listener is handed) against the core's frames, each
    /// folded into what the client holds. With no named difference, the core sends one frame per Node publication and holds, after
    /// each, exactly that publication's catalog. A named difference ([`Differences`]) states both sequences exactly; each frame
    /// then carries its row exactly as the Node publication it is paired with holds it (a deleted row: absent from it), the pairs
    /// keep Node's order, and after the last frame paired with a publication the client holds exactly that catalog. A named order
    /// the core cannot produce is compared as an unnamed part is, against its `compareWith` scenario's publications.
    /// Node's `published` events of one part, each the catalog named and its rows named.
    fn published(events: &[Value], names: &mut Names) -> Vec<(String, Vec<Value>)> {
        events
            .iter()
            .filter(|e| e["kind"] == "published")
            .map(|e| {
                let rows: Vec<Value> = e["sessions"].as_array().expect("sessions").iter().map(|row| names.named(row)).collect();
                let ids: Vec<&str> = rows.iter().map(|row| row["id"].as_str().expect("named id")).collect();
                // The catalog as the client is handed it; the recorder's `origin` (which of Node's paths published it) is not part of
                // it, and two of Node's paths race to it (a rename joins the store refresh's listing in flight, `session-host.ts:790`).
                (format!("catalog [{}]", ids.join(", ")), rows)
            })
            .collect()
    }

    /// A recorded scenario's publications per step and part, named in the order its own replay names them: a listing step's rows,
    /// then each part's publications. A step whose replay names other rows (a listing answered within a call) is not walked.
    fn node_parts(scenario: &str) -> HashMap<(String, String), Vec<(String, Vec<Value>)>> {
        let node = recorded(scenario);
        let mut names = Names::new(node["taskWorkspace"].as_str().expect("task workspace"));
        let mut parts = HashMap::new();
        for step in node["steps"].as_array().expect("steps") {
            let name = step["step"].as_str().expect("step");
            let events = step["events"].as_array().cloned().unwrap_or_default();
            let walked: Vec<(&str, &[Value])> = match name {
                "list" => {
                    named_rows(&step["sessions"], &mut names);
                    vec![("the step", &events[..])]
                }
                "transport-loss-and-renderer-reload" => vec![("the step", &events[..])],
                "create" | "update" | "update-rounds" | "reset" | "remove" | "forget-member" | "continue-held" | "restart-and-update" => {
                    let answered_at = events.iter().position(|e| e["kind"] == "answered" || e["kind"] == "threw").expect("the call's end");
                    vec![("before the answer", &events[..answered_at]), ("after the answer", &events[answered_at..])]
                }
                other => panic!("{scenario} / {other}: a step a compareWith scenario cannot have (its replay names a listing within it)"),
            };
            for (label, events) in walked {
                parts.insert((name.to_owned(), label.to_owned()), published(events, &mut names));
            }
        }
        parts
    }

    #[allow(clippy::too_many_arguments)]
    fn compare_part(what: &str, part: &str, events: &[Value], sent: &[Value], fold: &mut Fold, node_names: &mut Names, core_names: &mut Names, differences: &mut Differences) {
        let node = published(events, node_names);
        // Each frame: its shape, its row (named), and the client's fold after it.
        let mut core = Vec::new();
        for (at, frame) in sent.iter().enumerate() {
            fold.apply(frame);
            let row = frame["params"]["thread"].as_object().map(|_| core_names.named(&frame["params"]["thread"]));
            core.push((frame_shape(frame, core_names), row, fold.clone(), at));
        }
        let node_shapes: Vec<&str> = node.iter().map(|(shape, _)| shape.as_str()).collect();
        let core_shapes: Vec<&str> = core.iter().map(|(shape, ..)| shape.as_str()).collect();
        // The client's catalog after frame `at`, against Node's publication `rows`.
        let holds = |at: usize, rows: &[Value], names: &mut Names| -> bool {
            let (_, _, fold, _) = &core[at];
            held(fold, &sent[..=at], names, rows) == rows
        };
        // The frame's row as Node's publication `rows` holds it (a deleted row: absent).
        let carries = |at: usize, rows: &[Value]| -> bool {
            let (shape, row, ..) = &core[at];
            let id = shape.split_once(' ').expect("shape").1;
            let node_row = rows.iter().find(|row| row["id"] == id);
            match (row, node_row) {
                (Some(row), Some(node_row)) => live_form(row.clone(), node_row) == *node_row,
                (None, None) => true,
                _ => false,
            }
        };
        let label = format!("{what} / {part}");
        let step = what.split_once(" / ").expect("scenario / step").1;
        let Some(entry) = differences.entry(step, part) else {
            let same = node.len() == core.len() && (0..core.len()).all(|at| holds(at, &node[at].1, core_names));
            if !same {
                // The entry that would name this part, each frame paired with the first publication from the last pair on that
                // carries its row: what a reviewer reads, not what the replay accepts.
                let mut from = 0;
                let frames: Vec<Value> = (0..core.len())
                    .map(|at| {
                        let pair = (from..node.len()).find(|&k| carries(at, &node[k].1));
                        match pair {
                            Some(k) => {
                                from = k;
                                json!({ "frame": core_shapes[at], "publication": k })
                            }
                            // A frame no publication's row matches: its row, against Node's.
                            None => json!({ "frame": core_shapes[at], "publication": null, "row": core[at].1, "node": node.iter().map(|(_, rows)| rows).collect::<Vec<_>>() }),
                        }
                    })
                    .collect();
                differences.failures.push(format!(
                    "{label}: differs from Node and no named difference covers it; Node and the core: {}",
                    json!({ "scenario": what.split_once(" / ").expect("scenario").0, "step": step, "part": part, "node": node_shapes, "core": frames })
                ));
            }
            return;
        };
        let named_node: Vec<&str> = entry["node"].as_array().expect("node").iter().map(|s| s.as_str().expect("shape")).collect();
        if named_node != node_shapes {
            differences.failures.push(format!("{label}: not the named difference; Node published {node_shapes:?}; named: {entry}"));
            return;
        }
        // An order Node can produce and the core cannot: the core's part is the one Node recorded in the named scenario, whole, or,
        // with the core's frames named too, paired with that scenario's publications as below.
        let other;
        let node = match entry["compareWith"].as_str() {
            Some(with) => {
                other = differences.compared[with].get(&(step.to_owned(), part.to_owned())).cloned().unwrap_or_else(|| panic!("{label}: {with} has no such part"));
                if entry.get("core").is_none() {
                    let same = other.len() == core.len() && (0..core.len()).all(|at| holds(at, &other[at].1, core_names));
                    if !same {
                        let other_shapes: Vec<&str> = other.iter().map(|(shape, _)| shape.as_str()).collect();
                        differences.failures.push(format!("{label}: the core's part is not Node's {with} / {step} / {part} (Node published {other_shapes:?}, the core sent {core_shapes:?})"));
                    }
                    return;
                }
                &other
            }
            None => &node,
        };
        let named_core: Vec<&str> = entry["core"].as_array().expect("core").iter().map(|f| f["frame"].as_str().expect("frame")).collect();
        if named_core != core_shapes {
            differences.failures.push(format!("{label}: not the named difference; Node published {node_shapes:?}, the core sent {core_shapes:?}; named: {entry}"));
            return;
        }
        // Each frame's publication; a frame that carries a row no publication of Node's has (a state between two of Node's) names
        // that row exactly instead (`publication` null, `row`).
        let named_frames = entry["core"].as_array().expect("core");
        let pairs: Vec<Option<usize>> = named_frames.iter().map(|f| f["publication"].as_u64().map(|k| k as usize)).collect();
        let mut last = 0;
        for (at, pair) in pairs.iter().enumerate() {
            let Some(k) = *pair else {
                if named_frames[at].get("row").is_none_or(|row| core[at].1.as_ref() != Some(row)) {
                    differences.failures.push(format!("{label}: frame {at} ({}) does not carry the named row; it carries {}", core_shapes[at], json!(core[at].1)));
                }
                continue;
            };
            if k < last || k >= node.len() {
                differences.failures.push(format!("{label}: frame {at} is paired out of Node's order (publication {k})"));
                return;
            }
            last = k;
            if !carries(at, &node[k].1) {
                differences.failures.push(format!("{label}: frame {at} ({}) does not carry the row of Node's publication {k}", core_shapes[at]));
            }
        }
        for (k, (shape, rows)) in node.iter().enumerate() {
            if let Some(at) = pairs.iter().rposition(|pair| *pair == Some(k))
                && !holds(at, rows, core_names)
            {
                differences.failures.push(format!("{label}: after frame {at} the client does not hold Node's publication {k} ({shape})"));
            }
        }
        // At the part's end the client holds Node's last catalog of it, whether or not a frame of the part is paired with it.
        if let Some((shape, rows)) = node.last()
            && held(fold, sent, core_names, rows) != *rows
        {
            differences.failures.push(format!("{label}: at the part's end the client does not hold Node's last publication ({shape})"));
        }
    }

    /// Node's listed rows, named.
    fn named_rows(rows: &Value, names: &mut Names) -> Vec<Value> {
        rows.as_array().expect("Node's rows").iter().map(|row| names.named(row)).collect()
    }

    /// The core's `thread/list` answer's rows, named, each in Node's live form where Node's row has it (`live_form`).
    fn listed_rows(listed: &Value, names: &mut Names, node_rows: &Value) -> Vec<Value> {
        let node_rows = node_rows.as_array().expect("Node's rows");
        listed["data"]
            .as_array()
            .expect("thread/list data")
            .iter()
            .enumerate()
            .map(|(at, row)| {
                let row = names.named(row);
                match node_rows.get(at) {
                    Some(node) => live_form(row, node),
                    None => row,
                }
            })
            .collect()
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
        composed_over(Arc::new(agents), mixdog_core_session::session::testing::DataDir::default(), SaveGate::default(), Arc::default()).await
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
        let live = mixdog_core_rooms::rooms::live::LiveRooms::new(
            rooms.clone(),
            mixdog_core_rooms::rooms::live::RoomPorts {
                daemon: Arc::new(crate::run_host::room_daemon::DirectoryRoomDaemon::new(directory.clone(), {
                    let late = late_summaries.clone();
                    Arc::new(move || {
                        if let Some(summaries) = late.get() {
                            summaries.republish();
                        }
                    })
                })),
                approvals: Arc::new(Unreached),
                labels: exchanges.clone(),
                files: Arc::new(Unreached),
                sessions: sessions.clone(),
                catalog: agents.clone(),
                maintainer: Arc::new(Unreached),
                preview: Arc::new(|text: &str| mixdog_core_rooms::rooms::preview::plain_preview_text(text)),
                log: room_log(&logged),
            },
        );
        let calls = mixdog_core_rooms::rooms::calls::RoomCalls::new(Arc::new(mixdog_core_rooms::rooms::exchange_run::ExchangeRunner::new(live.clone())), room_log(&logged));
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
        Composed {
            service,
            list,
            homes,
            ready,
            agents,
            app,
            gate,
            deletes,
            saves,
            summaries: publication.summaries,
            rooms,
            host,
            sessions,
            ops,
            logged,
            edges: publication.edges,
            projections: store,
            rig,
            data,
            live,
            exchanges,
            prepares,
        }
    }
}
