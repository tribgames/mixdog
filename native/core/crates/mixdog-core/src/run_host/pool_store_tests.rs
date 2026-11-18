//! The Agents pool listed over the store: a worker session whose header holds a `worker` row is listed by what the row says
//! and what this daemon runs (`RegistryPoolStore` under `AgentPool::list`), a session with no row is not listed, and a row
//! rewritten through the thread's header is listed as rewritten at the next listing.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_core_agents::agents::AgentPool;
use mixdog_core_agents::agents::PoolLive;
use mixdog_core_agents::agents::RuntimeEntry;
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::agent_registry::KeptRows;
use mixdog_core_session::session::agent_registry::ReapWindow;
use mixdog_core_session::session::agent_registry::StoreWorkers;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_core_session::session::Clock;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::StoreThreads;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::pool_inputs::RegistryPoolStore;

const NOW: i64 = 1_700_000_000_000;

struct Held;

impl Clock for Held {
    fn now_ms(&self) -> i64 {
        NOW
    }
}

struct NoReap;

impl ReapWindow for NoReap {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        unreachable!("a listing reads no reap window")
    }
}

struct Live(HashSet<String>);

impl PoolLive for Live {
    fn now(&self) -> f64 {
        NOW as f64
    }
    fn running(&self) -> HashSet<String> {
        self.0.clone()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn live_session(&self, _: &str) -> Option<Arc<Map<String, Value>>> {
        None
    }
    fn runtime_entry(&self, _: &str) -> Option<RuntimeEntry> {
        None
    }
    fn ledger_tokens(&self, _: &[(String, Vec<String>)]) -> HashMap<String, String> {
        HashMap::new()
    }
    fn stall_warn_ms(&self, _: Option<&str>) -> f64 {
        unreachable!("no turn is in flight")
    }
}

struct World {
    pool: AgentPool,
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    _rig: Rig,
    _data: tempfile::TempDir,
}

async fn world(running: &[&str]) -> World {
    let data = tempfile::tempdir().expect("a data dir");
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), {
        let root = root.clone();
        move |lane| mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let store = Arc::new(StoreThreads::over_data_dir(&root, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(store.clone()))));
    let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &root.join("core.sqlite")).expect("core state");
    let workers = Arc::new(StoreWorkers::new(index, threads.clone(), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let registry = Arc::new(AgentRegistry::new(workers, directory.clone(), Arc::new(NoReap), Arc::new(Held)));
    let live = Live(running.iter().map(|id| (*id).to_owned()).collect());
    let pool = AgentPool::new(Arc::new(RegistryPoolStore::new(registry, directory.clone())), Arc::new(live));
    World { pool, directory, threads, _rig: rig, _data: data }
}

fn worker_header(id: &str, tag: &str, status: &str) -> Map<String, Value> {
    json!({
        "owner": "agent",
        "agent": "worker",
        "title": format!("title of {tag}"),
        "worker": { "tag": tag, "sessionId": id, "agent": "worker", "status": status, "startedAt": NOW - 5000 },
    })
    .as_object()
    .unwrap()
    .clone()
}

async fn listed(world: &World) -> Vec<Value> {
    world.pool.list().await.expect("agent/pool/list")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_session_is_listed_by_its_row_and_by_whether_this_daemon_runs_it() {
    let world = world(&["sess_alpha"]).await;
    world.directory.create_with_id(ThreadId::from("sess_alpha"), worker_header("sess_alpha", "alpha", "running"), json!({})).await.expect("alpha");
    world.directory.create_with_id(ThreadId::from("sess_beta"), worker_header("sess_beta", "beta", "running"), json!({})).await.expect("beta");
    world.directory.create_with_id(ThreadId::from("sess_plain"), json!({ "owner": "agent" }).as_object().unwrap().clone(), json!({})).await.expect("plain");
    let rows = listed(&world).await;
    let shown: Vec<(&str, &str, &str)> = rows.iter().map(|row| (row["tag"].as_str().unwrap(), row["sessionId"].as_str().unwrap(), row["status"].as_str().unwrap())).collect();
    assert_eq!(shown, [("alpha", "sess_alpha", "running"), ("beta", "sess_beta", "unknown")], "a row nobody runs is unknown; a session with no row is not listed");
    assert_eq!(rows[0]["title"], "title of alpha", "the session's own title fills what the row lacks");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_rewritten_through_the_threads_header_is_listed_as_rewritten_right_after() {
    let world = world(&["sess_alpha"]).await;
    world.directory.create_with_id(ThreadId::from("sess_alpha"), worker_header("sess_alpha", "alpha", "running"), json!({})).await.expect("alpha");
    assert_eq!(listed(&world).await[0]["tag"], "alpha");
    let renamed = worker_header("sess_alpha", "renamed", "running");
    world.threads.patch_header(&ThreadId::from("sess_alpha"), renamed.into_iter().filter(|(key, _)| key == "worker").collect(), Vec::new()).await.expect("thread/header/patch");
    assert_eq!(listed(&world).await[0]["tag"], "renamed");
}
