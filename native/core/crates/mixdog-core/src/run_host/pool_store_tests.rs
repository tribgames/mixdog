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
use mixdog_core_session::session::Clock;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::StoreThreads;
use mixdog_core_session::session::ThreadStore;
use mixdog_core_session::session::agent_registry::AgentRegistry;
use mixdog_core_session::session::agent_registry::KeptRows;
use mixdog_core_session::session::agent_registry::ReapWindow;
use mixdog_core_session::session::agent_registry::StoreWorkers;
use mixdog_core_session::session::testing::CallCounted;
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
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
    pool: Arc<AgentPool>,
    registry: Arc<AgentRegistry>,
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    index: mixdog_store::sqlite::SqliteStore,
    _rig: Rig,
    data: tempfile::TempDir,
}

async fn world(running: &[&str]) -> World {
    world_over(tempfile::tempdir().expect("a data dir"), running, |store| store).await
}

/// A daemon started over the data dir `data`, its sessions read through what `reads` makes of the thread store.
async fn world_over(data: tempfile::TempDir, running: &[&str], reads: impl FnOnce(Arc<StoreThreads>) -> Arc<dyn ThreadStore>) -> World {
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
    let store =
        Arc::new(StoreThreads::over_data_dir(&root, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(reads(store)))));
    let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
    let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &root.join("core.sqlite")).expect("core state");
    let workers = Arc::new(StoreWorkers::new(index.clone(), threads.clone(), tokens.interactive_io, Arc::new(KeptRows::new(state))));
    let registry = Arc::new(AgentRegistry::new(workers, directory.clone(), Arc::new(NoReap), Arc::new(Held)));
    let live = Live(running.iter().map(|id| (*id).to_owned()).collect());
    let pool = Arc::new(AgentPool::new(Arc::new(RegistryPoolStore::new(registry.clone(), directory.clone())), Arc::new(live)));
    World { pool, registry, directory, threads, index, _rig: rig, data }
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
    let shown: Vec<(&str, &str, &str)> =
        rows.iter().map(|row| (row["tag"].as_str().unwrap(), row["sessionId"].as_str().unwrap(), row["status"].as_str().unwrap())).collect();
    assert_eq!(
        shown,
        [("alpha", "sess_alpha", "running"), ("beta", "sess_beta", "unknown")],
        "a row nobody runs is unknown; a session with no row is not listed"
    );
    assert_eq!(rows[0]["title"], "title of alpha", "the session's own title fills what the row lacks");
}

/// A daemon that has loaded none of the worker sessions lists them from the index: no session's record is read, however
/// many there are, and the row holds every member the pool shows of a session (its model parameters among them).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workers_no_daemon_has_loaded_are_listed_from_the_index_and_no_record_is_read() {
    const WORKERS: usize = 40;
    let world = world(&[]).await;
    for n in 0..WORKERS {
        let id = format!("sess_w{n:02}");
        let mut header = worker_header(&id, &format!("w{n}"), "idle");
        header.extend(
            json!({ "provider": "openai-oauth", "model": "gpt-6.2-sol", "modelParameters": { "serviceTier": "ultrafast" } }).as_object().unwrap().clone(),
        );
        // Its outcome already holds its settle identity: the listing has nothing to write.
        header["worker"].as_object_mut().unwrap().extend(json!({ "settledAt": NOW - 1000, "settledTurn": 0 }).as_object().unwrap().clone());
        world.directory.create_with_id(ThreadId::from(id.as_str()), header, json!({})).await.expect("a worker");
    }
    // The daemon that made them stops, and the next one brings each catalog row level with its log as it starts.
    world.directory.shutdown().await;
    world.index.close();
    let mut counted = None;
    let next = world_over(world.data, &[], |store| counted.insert(CallCounted::new(store)).clone()).await;
    next.index.reconciled().await.expect("the index is level with the logs");
    let counted = counted.expect("the daemon reads through the counting store");
    let rows = listed(&next).await;

    assert_eq!(rows.len(), WORKERS);
    assert!(rows.iter().all(|row| row.to_string().contains("ultrafast")), "each row shows its session's model parameters: {}", rows[0]);
    let calls = counted.calls();
    assert_eq!(calls.iter().filter(|call| **call == "listed_rows").count(), 1, "one read of the index answers for them all: {calls:?}");
    assert!(!calls.iter().any(|call| matches!(*call, "read_header" | "read_header_fields" | "read_head")), "a record was read: {calls:?}");
}

/// A session whose header cannot be read (the index holds no row of it, and its record does not open) is not a session
/// without a header. The pool listing, which reads it as a worker's owner, fails with the read's failure instead of
/// listing the worker under an owner it knows nothing of; and a spawn that asks whether that session can be resumed under
/// a tag is answered the failure, not "no such session", so no fresh session takes the tag. A session that is not there at
/// all is still answered as absent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::disallowed_methods, reason = "test setup writes a session folder")]
async fn a_header_that_cannot_be_read_fails_the_pool_listing_and_the_resume_of_its_tag() {
    use mixdog_agent::agent_tool::host::Registry;
    use mixdog_agent::agent_tool::scope::Scope;

    let world = world(&[]).await;
    let owned = |owner: &str| {
        let mut header = worker_header("sess_alpha", "alpha", "idle");
        header.insert("ownerSessionId".into(), owner.into());
        header["worker"].as_object_mut().unwrap().insert("ownerSessionId".into(), owner.into());
        header
    };
    world.directory.create_with_id(ThreadId::from("sess_alpha"), owned("sess_owner"), json!({})).await.expect("alpha");
    // No such owner anywhere: an absent session, and the worker is listed.
    assert_eq!(listed(&world).await.len(), 1, "a worker whose owner is not stored is listed");
    let scope = Scope { caller_session_id: None, host_pid: None };
    let absent = Registry::resumable_tag_session(&*world.registry, "lead", "sess_owner", &scope).await;
    assert!(matches!(absent, Ok(None)), "a session that is not stored cannot be resumed, and that is an answer");

    // The owner's folder is there and does not open as a log: it holds an entry no log has.
    let folder = world.data.path().join("sessions").join("sess_owner");
    std::fs::create_dir_all(&folder).expect("the owner's folder");
    std::fs::write(folder.join("stray.entry"), b"x").expect("the stray entry");

    let why = world.pool.list().await.expect_err("the pool listed a worker whose owner's header could not be read").0;
    assert!(why.contains("header could not be read"), "{why}");
    let resumable = Registry::resumable_tag_session(&*world.registry, "lead", "sess_owner", &scope).await;
    let why = match resumable {
        Err(why) => why,
        Ok(found) => panic!("a session whose header could not be read was answered as resumable or not: found {}", found.is_some()),
    };
    assert!(why.contains("sess_owner") && why.contains("could not be read"), "{why}");
}

/// A worker whose session still owes its sensitive rewrite is held, not failed: a pool listing asked meanwhile waits for
/// the rewrite, as a read waits at the index for a held session, and then answers with the worker's header as the rewrite
/// left it. The record's refusal (`coreMigrating`) is no failure of the listing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_held_for_its_sensitive_rewrite_is_listed_with_its_header_once_the_rewrite_ends() {
    use mixdog_core_session::session::store::SensitiveMarksOf;
    use mixdog_services::memory::sensitive::SensitiveStore;
    const CODE: &str = "482913";
    const BOUND: std::time::Duration = std::time::Duration::from_secs(30);
    let tokens = mixdog_rt::testing::tokens();
    let redacting = |marks: &Arc<SensitiveStore>, store: &Arc<StoreThreads>| assert!(store.redact_with(Arc::new(SensitiveMarksOf::new(marks.clone()))).is_ok());

    let world = world(&[]).await;
    let mut header = worker_header("sess_alpha", "alpha", "idle");
    header.insert("title".into(), format!("the code is {CODE}").into());
    world.directory.create_with_id(ThreadId::from("sess_alpha"), header, json!({})).await.expect("alpha");
    world.directory.shutdown().await;
    world.index.close();
    // The next daemon brings the row level with its log; its session then gains a sensitive value, and the daemon ends
    // before the session's next barrier: the rewrite is owed by the start after it.
    let marks = Arc::new(SensitiveStore::default());
    let level = world_over(world.data, &[], |store| {
        redacting(&marks, &store);
        store
    })
    .await;
    level.index.reconciled().await.expect("the index is level with the logs");
    assert!(listed(&level).await[0]["title"].as_str().is_some_and(|title| title.contains(CODE)), "the worker's title holds the code");
    level.directory.shutdown().await;
    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
    assert!(marks.remember("sess_alpha", &[fill]));
    level.index.close();

    let marks = Arc::new(SensitiveStore::default());
    let (mut threads, mut counted) = (None, None);
    let next = world_over(level.data, &[], |store| {
        redacting(&marks, &store);
        threads = Some(store.clone());
        counted.insert(CallCounted::new(store)).clone()
    })
    .await;
    let (threads, counted) = (threads.expect("the thread store"), counted.expect("the counting store"));
    let owed = threads.owe_marks(tokens.durability_io, None).await.expect("the marks are owed");
    assert_eq!(owed.owed(), 1, "the worker's session owes its rewrite");

    let listing = tokio::spawn({
        let pool = next.pool.clone();
        async move { pool.list().await }
    });
    // The index answers a withheld worker's row without its content, which the pool's documents hold no row of: the
    // listing waits at the index for the worker's rewrite, and has read no record yet.
    assert_eq!(next.index.withheld_workers().await.expect("the withheld set"), ["sess_alpha"], "the worker is withheld");
    let asked = std::time::Instant::now();
    while next.index.rewrite_waits() == 0 {
        assert!(!listing.is_finished(), "the listing answered while the worker's session was held for its rewrite");
        assert!(asked.elapsed() < BOUND, "the listing never waited for the worker's rewrite: store calls {:?}", counted.calls());
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(!listing.is_finished(), "the listing answered while the worker's session was held for its rewrite");

    owed.run(&mixdog_rt::CancellationToken::new()).await.expect("the rewrite runs behind serving");
    let rows = mixdog_rt::time::timeout(BOUND, listing).await.expect("the listing answers once the rewrite ended").expect("the task").expect("agent/pool/list");
    assert_eq!(rows.len(), 1);
    let title = rows[0]["title"].as_str().expect("the worker's header is listed");
    assert!(title.contains("[redacted]") && !title.contains(CODE), "the header as the rewrite left it: {title}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_row_rewritten_through_the_threads_header_is_listed_as_rewritten_right_after() {
    let world = world(&["sess_alpha"]).await;
    world.directory.create_with_id(ThreadId::from("sess_alpha"), worker_header("sess_alpha", "alpha", "running"), json!({})).await.expect("alpha");
    assert_eq!(listed(&world).await[0]["tag"], "alpha");
    let renamed = worker_header("sess_alpha", "renamed", "running");
    world
        .threads
        .patch_header(&ThreadId::from("sess_alpha"), renamed.into_iter().filter(|(key, _)| key == "worker").collect(), Vec::new())
        .await
        .expect("thread/header/patch");
    assert_eq!(listed(&world).await[0]["tag"], "renamed");
}
