//! The agent home over real stored state: sessions in the SQLite-indexed thread store under a
//! temp data dir, the real session directory and actors. A reset keeps the old conversation
//! durably as an archived thread that restores whole, and refuses a thread running a turn.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

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
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_rooms::rooms::service::KnownAgent;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

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

    async fn presence(&self, _: &[String]) -> Result<HashMap<String, Presence>, RoomError> {
        Ok(HashMap::new())
    }

    async fn archived_name(&self, _: &str) -> String {
        String::new()
    }

    async fn task_workspace(&self) -> String {
        "/ws".into()
    }
}

async fn real_store(data: &std::path::Path) -> Arc<dyn mixdog_core_session::session::ThreadStore> {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;

    let tokens = mixdog_rt::testing::tokens();
    let root = data.to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    Arc::new(
        mixdog_core_session::session::StoreThreads::over_data_dir(data, index, Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    )
}

struct World {
    _data: tempfile::TempDir,
    rig: Rig,
    store: Arc<dyn mixdog_core_session::session::ThreadStore>,
    directory: Arc<SessionDirectory>,
    state: Arc<dyn ThreadState>,
    deps: Arc<SessionHomeDeps>,
}

async fn world() -> World {
    let data = tempfile::tempdir().expect("data dir");
    let store = real_store(data.path()).await;
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
    let state: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
    let sessions = Arc::new(DirectorySessions::new(directory.clone(), state.clone()));
    let deps = Arc::new(SessionHomeDeps::new(Arc::new(Catalog), sessions, directory.clone()));
    World { _data: data, rig, store, directory, state, deps }
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

async fn eventually(what: &str, mut probe: impl AsyncFnMut() -> bool) {
    for _ in 0..1000 {
        if probe().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("{what}: not reached in 5 s");
}

/// One user turn in the home thread.
async fn talk(world: &World, id: &str, prompt: &str) {
    let thread = ThreadId::from(id);
    let handle = world.directory.open_handle(&thread, &connection()).await.expect("opens");
    let op = OpId::from(uuid::Uuid::now_v7().to_string());
    let params = json!({ "threadId": thread, "opId": op.as_str(), "input": { "prompt": prompt } });
    handle.request(CoreRequest { method: Method("turn/start"), params, op: Some(op), ctx: connection() }).await.expect("turn/start");
    eventually("the user row", async || user_texts(&read(&world.directory, id).await).len() == 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_keeps_the_old_conversation_archived_durable_and_restorable() {
    let world = world().await;
    let homes = AgentHomeSessions::new(world.deps.clone());
    let opened = homes.open("ada").await.expect("opens");
    let home = opened["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(home, "sess_home_ada");
    talk(&world, &home, "write a haiku").await;
    eventually("the turn ends", async || read(&world.directory, &home).await["state"]["runtime"]["busy"] != json!(true)).await;

    let reset = homes.reset("ada").await.expect("resets");
    assert_eq!(reset["sessionId"], json!(home));
    let archive = reset["archivedSessionId"].as_str().expect("the conversation had a user turn").to_owned();
    assert!(archive.starts_with("sess_") && archive != home);

    // The home thread starts over; its old conversation sits in the archive copy.
    assert!(user_texts(&read(&world.directory, &home).await).is_empty());
    assert_eq!(world.state.header(&ThreadId::from(archive.as_str())).await.unwrap().get("archived"), Some(&json!(true)));

    // Durable: a fresh directory over the same stored state reads the archive whole and the home emptied.
    let reopened = SessionDirectory::new(world.rig.deps_on(world.store.clone()));
    assert_eq!(user_texts(&read(&reopened, &archive).await), ["write a haiku"]);
    assert!(user_texts(&read(&reopened, &home).await).is_empty());

    // Restorable: unarchiving brings the whole conversation back as a live thread.
    world.deps.set_archived(&archive, false).await.expect("restores");
    assert_eq!(world.state.header(&ThreadId::from(archive.as_str())).await.unwrap().get("archived"), Some(&json!(false)));
    let restored = SessionDirectory::new(world.rig.deps_on(world.store.clone()));
    assert_eq!(user_texts(&read(&restored, &archive).await), ["write a haiku"]);

    // An empty conversation keeps no copy.
    let again = homes.reset("ada").await.expect("resets again");
    assert_eq!(again, json!({ "sessionId": home, "archivedSessionId": null }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_is_refused_while_the_home_thread_runs_a_turn_and_keeps_the_conversation() {
    let world = world().await;
    world.rig.set_script(Arc::new(|_run| Box::pin(std::future::pending())));
    let homes = AgentHomeSessions::new(world.deps.clone());
    let home = homes.open("ada").await.expect("opens")["sessionId"].as_str().unwrap().to_owned();
    talk(&world, &home, "still working").await;
    eventually("the turn runs", async || world.deps.turn_in_progress(&ThreadId::from(home.as_str())).await.unwrap()).await;

    let refused = homes.reset("ada").await.expect_err("a running turn refuses the reset");
    assert!(format!("{refused:?}").contains("wait for it to finish before resetting the conversation"), "{refused:?}");
    assert_eq!(user_texts(&read(&world.directory, &home).await), ["still working"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_deps_read_the_catalog_and_report_a_missing_session_as_node_does() {
    let world = world().await;
    let agents = world.deps.list_agents().await.unwrap();
    assert_eq!(agents, json!([{ "id": "ada", "custom": true, "kind": "bot", "disabled": false, "route": { "provider": "openai", "model": "gpt-x", "effort": "low" } }]));
    let missing = world.deps.read_session("sess_nowhere").await.unwrap_err();
    assert_eq!(missing.message, "Session sess_nowhere is not available");
    assert_eq!(missing.code.as_deref(), Some("SESSION_NOT_AVAILABLE"));
    let id = world.deps.mint_archive_id();
    assert!(id.starts_with("sess_") && id.len() > 40 && id != world.deps.mint_archive_id());
}
