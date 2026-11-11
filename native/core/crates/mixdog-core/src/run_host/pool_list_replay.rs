//! Node's recording `fixtures/store-agent-worker-pool-cases/golden.json` (`record-store-agent-worker-pool-cases.mjs`), read when
//! the test runs and decoded with [`Exact`]. Each case recorded the store its listings read (`store`, `storeAtEachList`,
//! `storeChanged`, `storeOfEachDirectory`: the worker indexes and session records by path). That store is written as Node's data
//! dir, migrated as the core does at its first start, and opened through the real store; the Agents pool is listed through
//! the entry `agent/pool/list` answers with ([`AgentPool::list`] over [`RegistryPoolStore`], composed as `compose_flip.rs`
//! does), at the recording's held clock with the recorded running sessions and no other live state. Every listing Node made
//! is compared whole. A rewrite Node made while its pool stayed up (cases 1 and 4) is made through the core's store write
//! (`thread/header/patch`: the record's title, the session's `worker` row) and the same pool lists again; a restart is a new
//! registry and pool over the same data dir. Node's header cache, its stamps, read counts, fs-call counts and link list have
//! no counterpart in the core (MANIFEST `replay.missingOnO1`). The two listings in which Node lists an index row that has no
//! session record are not replayed (MANIFEST `replay.notReplayed`).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentPool, PoolLive, RuntimeEntry};
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake};
use mixdog_core_api::domain::mock::MockOwnership;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_session::session::agent_registry::{AgentRegistry, ReapWindow, StoreWorkers};
use mixdog_core_session::session::testing::Rig;
use mixdog_core_session::session::thread_state::SessionThreads;
use mixdog_core_session::session::{Clock, SessionDirectory, StoreThreads};
use mixdog_migrate::durable;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_migrate::index::IndexProjector;
use mixdog_migrate::run::{MigrateOptions, Migrator, product_drivers};
use mixdog_migrate::session::context_blobs::OfficeExtractor;
use mixdog_testkit::Exact;
use serde_json::{Map, Value, json};

use super::pool_inputs::RegistryPoolStore;

fn golden() -> Exact {
    Exact::load(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/store-agent-worker-pool-cases/golden.json"))
}

/// The recorded case `index`, checked by name: its observed value.
fn observed<'a>(golden: &'a Exact, index: usize, name: &str) -> &'a Exact {
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index}");
    case.get("observed")
}

fn plain(value: &Exact) -> Value {
    value.to_plain().unwrap()
}

fn files(value: &Exact) -> Map<String, Value> {
    plain(value).as_object().cloned().unwrap()
}

/// `store` with `changes` applied (a `null` removes the file).
fn changed(store: &Map<String, Value>, changes: &Map<String, Value>) -> Map<String, Value> {
    let mut out = store.clone();
    for (path, text) in changes {
        match text {
            Value::Null => out.shift_remove(path),
            text => out.insert(path.clone(), text.clone()),
        };
    }
    out
}

fn running(value: &Exact) -> HashSet<String> {
    plain(value).as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
}

struct NoDocuments;

#[async_trait]
impl DocumentText for NoDocuments {
    async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
        unreachable!("the recorded store has no office part, yet {filename} was extracted")
    }
    async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
        unreachable!("the migration extracts no PDF text")
    }
    async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
        unreachable!("the migration counts no PDF")
    }
}

struct StoreProjector;

impl IndexProjector for StoreProjector {
    fn project(&self, data: &Path, db: &Path, sessions: &[String]) -> Result<(), String> {
        mixdog_store::sqlite::project_index(data, db, sessions)
    }
}

/// A data dir holding `store` as Node's, migrated as the core does at its first start.
struct DataDir {
    _dir: tempfile::TempDir,
    roots: MigrationRoots,
}

fn migrated(store: &Map<String, Value>) -> DataDir {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join(".mixdog");
    let data = home.join("data");
    durable::create_dir_all(&data.join("sessions")).unwrap();
    for (path, text) in store {
        durable::write_synced(&data.join(path), text.as_str().unwrap().as_bytes()).unwrap();
    }
    let roots = MigrationRoots { data, home, profile: None };
    let office = OfficeExtractor { docs: Arc::new(NoDocuments), runtime: tokio::runtime::Handle::current() };
    Migrator::new(roots.clone(), product_drivers(Arc::new(StoreProjector), office), MigrateOptions::default())
        .run()
        .expect("the migration of the recorded store completes");
    DataDir { _dir: dir, roots }
}

/// The clock Node's listing ran under (`golden.json` `clock.dateNow`).
struct Held(i64);

impl Clock for Held {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// The reap window is not read by a listing.
struct NoReap;

impl ReapWindow for NoReap {
    fn terminal_reap_ms(&self, _: &str) -> f64 {
        unreachable!("a listing reads no reap window")
    }
}

/// The daemon's live side as the recording's: Node's `runningSessionIds`, nothing else live.
struct Live {
    now: i64,
    running: HashSet<String>,
}

impl PoolLive for Live {
    fn now(&self) -> f64 {
        self.now as f64
    }
    fn running(&self) -> HashSet<String> {
        self.running.clone()
    }
    fn awaiting_shell(&self) -> HashSet<String> {
        HashSet::new()
    }
    fn live_session(&self, _: &str) -> Option<Value> {
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

/// One daemon over a data dir: the store opened as the core opens it, the registry and the pool composed as `compose_flip.rs`.
struct Daemon {
    pool: AgentPool,
    threads: Arc<dyn ThreadState>,
    _rig: Rig,
}

impl Daemon {
    async fn up(data: &DataDir, now: i64, running: &HashSet<String>) -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.roots.data.clone();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(StoreThreads::over_data_dir(&data.roots.data, index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("thread store"));
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(Arc::new(rig.deps_parts(store.clone()))));
        let threads: Arc<dyn ThreadState> = Arc::new(SessionThreads::new(directory.clone()));
        let workers = Arc::new(StoreWorkers::new(index, threads.clone(), tokens.interactive_io));
        workers.fence(store);
        let registry = Arc::new(AgentRegistry::new(workers, directory, Arc::new(NoReap), Arc::new(Held(now))));
        let pool = AgentPool::new(Arc::new(RegistryPoolStore::new(registry, threads.clone())), Arc::new(Live { now, running: running.clone() }));
        Self { pool, threads, _rig: rig }
    }

    async fn list(&self) -> Value {
        Value::Array(self.pool.list().await.expect("agent/pool/list"))
    }

    /// `thread/header/patch` of one session.
    async fn patch(&self, session: &str, set: Value) {
        self.threads.patch_header(&ThreadId::from(session), set.as_object().cloned().unwrap(), Vec::new()).await.expect("thread/header/patch");
    }

    async fn header(&self, session: &str) -> Map<String, Value> {
        self.threads.header(&ThreadId::from(session)).await.expect("stored header")
    }
}

/// A listing compared whole with the recorded one.
fn same(got: &Value, want: &Exact, what: &str) {
    assert!(Exact::plain(got) == *want, "{what}: the core listed {got}");
}

fn now(golden: &Exact) -> i64 {
    plain(golden.get("clock").get("dateNow")).as_i64().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_agents_pool_lists_nodes_recorded_stores() {
    let golden = golden();
    let now = now(&golden);
    let none = HashSet::new();

    // Case 0: every state of the churned store, listed cold.
    let want = observed(&golden, 0, "an incrementally updated pool lists exactly what a cold read of the same store lists");
    let live = running(want.get("running"));
    let mut store = files(want.get("store"));
    let data = migrated(&store);
    let daemon = Daemon::up(&data, now, &live).await;
    same(&daemon.list().await, want.get("initial").get("listed"), "case 0 initial");
    same(&daemon.list().await, want.get("initial").get("listedAgain"), "case 0 initial again");
    // Round 5 removes `sessions/churn-22.json` and keeps its index row (MANIFEST `replay.notReplayed`).
    let rounds = want.get("rounds").as_array();
    assert_eq!(plain(rounds[5].get("round")), json!(5), "case 0 round 5 is the declared one");
    for round in &rounds[..5] {
        store = changed(&store, &files(round.get("storeChanged")));
        let data = migrated(&store);
        let daemon = Daemon::up(&data, now, &live).await;
        let label = format!("case 0 round {}", plain(round.get("round")));
        for key in ["reference", "incremental", "incrementalAsync", "coldAsync"] {
            same(&daemon.list().await, round.get(key), &format!("{label} {key}"));
        }
    }

    // Case 1: the record's title rewritten while the pool stays up, and each store state listed cold.
    let want = observed(&golden, 1, "a session rewrite that keeps its size and mtime is still read, settled or not");
    let stores = want.get("storeAtEachList").as_array();
    let lists = want.get("listsSeen").as_array();
    for (index, (store, list)) in stores.iter().zip(lists).enumerate() {
        let data = migrated(&files(store));
        same(&Daemon::up(&data, now, &none).await.list().await, list, &format!("case 1 cold list {index}"));
    }
    let data = migrated(&files(&stores[0]));
    let daemon = Daemon::up(&data, now, &none).await;
    same(&daemon.list().await, &lists[0], "case 1 first read");
    for (index, store) in stores.iter().enumerate().skip(1) {
        let record: Value = serde_json::from_str(files(store)["sessions/stamp-child.json"].as_str().unwrap()).unwrap();
        daemon.patch("stamp-child", json!({ "title": record["title"] })).await;
        same(&daemon.list().await, &lists[index], &format!("case 1 list {index} after the rewrite"));
    }

    // Cases 2 and 3: one store listed twice by the same pool.
    for (index, name, keys) in [
        (2, "a settled, unchanged header is served from the cache, however many there are", ["first", "second"]),
        (3, "the awaited listing touches the store only through async I/O, and its caches serve the next one", ["listed", "sync"]),
    ] {
        let want = observed(&golden, index, name);
        let data = migrated(&files(want.get("store")));
        let daemon = Daemon::up(&data, now, &none).await;
        for key in keys {
            same(&daemon.list().await, want.get(key), &format!("case {index} {key}"));
        }
    }

    // Case 4: the worker index row's title rewritten while the pool stays up, and each store state listed cold.
    let want = observed(&golden, 4, "a worker index rewrite that keeps its size and mtime is still read");
    let stores = want.get("storeAtEachList").as_array();
    for (store, key) in stores.iter().zip(["first", "afterRewrite"]) {
        let data = migrated(&files(store));
        same(&Daemon::up(&data, now, &none).await.list().await, want.get(key), &format!("case 4 cold {key}"));
    }
    let data = migrated(&files(&stores[0]));
    let daemon = Daemon::up(&data, now, &none).await;
    same(&daemon.list().await, want.get("first"), "case 4 first");
    let index: Value = serde_json::from_str(files(&stores[1])["agent-workers.json"].as_str().unwrap()).unwrap();
    let mut worker = daemon.header("same-size").await["worker"].as_object().cloned().expect("the migrated worker row");
    worker.insert("title".into(), index["workers"][0]["title"].clone());
    daemon.patch("same-size", json!({ "worker": worker })).await;
    same(&daemon.list().await, want.get("afterRewrite"), "case 4 after the rewrite");

    // Case 5: restarts over one data dir, and the store changed while the daemon was down.
    let want = observed(&golden, 5, "the persisted header cache across daemon restarts");
    let live = running(want.get("running"));
    let store = files(want.get("store"));
    let data = migrated(&store);
    let restart = want.get("phases").get("restart");
    let first = Daemon::up(&data, now, &live).await;
    same(&first.list().await, restart.get("firstRows"), "case 5 first daemon");
    same(&first.list().await, restart.get("reference"), "case 5 reference");
    drop(first);
    let restarted = Daemon::up(&data, now, &live).await;
    same(&restarted.list().await, restart.get("restartedRows"), "case 5 restarted");
    same(&restarted.list().await, restart.get("restartedAsyncRows"), "case 5 restarted again");
    drop(restarted);
    for result in want.get("phases").get("corrupt").get("results").as_array() {
        let label = plain(result.get("label"));
        for key in ["rows", "recoveredRows"] {
            let daemon = Daemon::up(&data, now, &live).await;
            same(&daemon.list().await, result.get(key), &format!("case 5 after the {label} cache, {key}"));
        }
    }
    // `changedWhileDown` removes `sessions/persist-08.json` and keeps its index row (MANIFEST `replay.notReplayed`).

    // Case 6: two data dirs, each listed by its own daemon.
    let want = observed(&golden, 6, "switching data directories before a scheduled persist still persists the new directory");
    let live = running(want.get("running"));
    let dirs: Vec<DataDir> = want.get("storeOfEachDirectory").as_array().iter().map(|store| migrated(&files(store))).collect();
    let listings = want.get("listings").as_array();
    same(&Daemon::up(&dirs[0], now, &live).await.list().await, &listings[0], "case 6 first dir");
    let second = Daemon::up(&dirs[1], now, &live).await;
    same(&second.list().await, &listings[1], "case 6 second dir");
    same(&second.list().await, &listings[2], "case 6 second dir again");

    // Case 7: a large index (1800 rows, 351 sessions), listed by a fresh pool and twice by another. Its rows without a session
    // record are settled long ago and Node lists none of them, nor does the core.
    let want = observed(&golden, 7, "listing a large index costs a bounded number of fs calls, whatever its row count");
    let live = running(want.get("running"));
    let data = migrated(&files(want.get("store")));
    same(&Daemon::up(&data, now, &live).await.list().await, want.get("reference"), "case 7 reference");
    let daemon = Daemon::up(&data, now, &live).await;
    same(&daemon.list().await, want.get("cold"), "case 7 cold");
    same(&daemon.list().await, want.get("warm"), "case 7 warm");
}
