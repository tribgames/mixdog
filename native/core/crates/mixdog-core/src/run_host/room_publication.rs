//! The wiring between the index writer, the app feed and the room service: what makes a room call's reply follow the
//! publication of the catalog (Node `deps.republishCatalog`, `session-host.ts:357-360`, which `agent-rooms.ts:289,312,333`
//! await before answering). The daemon's composition calls this; so does the test that proves the order.

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
/// host publishes through the summaries: a room call's publish returns once the rows it wrote are announced, or answers why not.
/// Fails when the index already has a row sink.
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
    let edges = ThreadEdges::start(ThreadEdgePublisher::new(thread_list.clone(), sections.clone(), agents.clone()));
    index.observe_rows(edges.clone())?;
    let summaries = RoomSummaries::new(thread_list, sections, directory, edges);
    let republish: Republish = {
        let summaries = summaries.clone();
        Arc::new(move || {
            let summaries = summaries.clone();
            Box::pin(async move { summaries.republish_settled().await.map_err(|error| RoomError::Port(format!("{error:?}"))) })
        })
    };
    let host = Arc::new(SessionRoomHost::new(agents, sessions, republish));
    Ok(RoomPublication { summaries, host })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use async_trait::async_trait;
    use mixdog_core_api::FeedSource;
    use mixdog_core_api::DomainService;
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
    use mixdog_core_rooms::rooms::home::Presence;
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

    /// The agents the rooms name, and the folder tasks run in.
    struct Agents;
    #[async_trait]
    impl TaskWorkspace for Agents {
        async fn path(&self) -> Result<String, String> {
            Ok("/tasks".into())
        }
    }
    #[async_trait]
    impl AgentCatalog for Agents {
        async fn agents(&self) -> Result<Vec<mixdog_core_rooms::rooms::service::KnownAgent>, RoomError> {
            let route = json!({ "provider": "custom-harness", "model": "harness-model" });
            Ok(["gh", "rel"].map(|id| mixdog_core_rooms::rooms::service::KnownAgent { id: id.into(), route: route.clone() }).to_vec())
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
            HashMap::from([("gh".to_owned(), "GH".to_owned()), ("rel".to_owned(), "Rel".to_owned())])
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

    /// How long the create may take before the test calls it hung (a failure bound, not a wait the test relies on).
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    /// Through the wiring the daemon composes (`wire`): when `room/create` answers, a `thread/list` already lists the room and
    /// the feed has been sent the room's `thread/started` (Node publishes the catalog before `createAgentRoom` answers,
    /// `agent-rooms.ts:289`, `session-host.ts:1199`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_create_answers_when_the_room_is_listed_and_announced() {
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
        let store = StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store");
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(Arc::new(store)))));
        std::fs::create_dir_all(data.path().join("state")).expect("state dir");
        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &data.path().join("state").join("core.sqlite")).expect("core state");
        let rooms = Arc::new(Rooms::new(StateRoomStore::new(state)));
        let agents = Arc::new(Agents);
        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).expect("subscribe");
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).expect("release");
        drop(app.drain_text());
        let sections = Arc::new(SectionFeedState::new(feed));
        let room_rows = Arc::new(RoomListRows::new(rooms.clone(), Arc::new(Idle), agents.clone()));
        let list = Arc::new(ThreadListService::new(Arc::new(index.clone()), Arc::new(Quiet), room_rows, agents.clone()));
        let sessions = Arc::new(DirectorySessions::new(directory.clone(), Arc::new(SessionThreads::new(directory.clone()))));
        let publication = wire(list.clone(), sections, agents.clone(), &index, directory, sessions).expect("wired");
        let op_dir = tempfile::tempdir().expect("op dir");
        let scopes = mixdog_core_base::support::testing::scopes(op_dir.path(), "room").await;
        let service = RoomService::new(rooms, publication.host, Arc::new(Idle), scopes);

        let created = tokio::time::timeout(DEADLINE, value(&service, request("room/create", with_op(json!({ "input": { "name": "Release", "members": ["gh", "rel"] } }), 1), Some(1))))
            .await
            .expect("room/create answered within the deadline")
            .expect("room/create");
        let room = format!("sess_room_{}", created["roomId"].as_str().expect("room id").trim_start_matches("room_"));
        let listed = value(list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("thread/list");
        let ids: Vec<&str> = listed["data"].as_array().expect("data").iter().filter_map(|row| row["id"].as_str()).collect();
        assert!(ids.contains(&room.as_str()), "thread/list at the reply lists the room {room}: {ids:?}");
        let started: Vec<String> = app
            .drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).unwrap_or_else(|error| panic!("{error}: {text}")))
            .filter(|frame| frame["method"] == "thread/started")
            .filter_map(|frame| frame["params"]["thread"]["id"].as_str().map(str::to_owned))
            .collect();
        assert!(started.contains(&room), "the feed has been sent the room's thread/started by the reply: {started:?}");
    }
}
