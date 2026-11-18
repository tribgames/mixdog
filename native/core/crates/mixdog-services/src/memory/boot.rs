//! Memory start (`runtime/memory/index.mjs` `_initStore` and `openDatabase`): the one
//! Postgres cluster, the `memory` and `session_search` schemas, and the pieces the session
//! layer holds (`LocalMemory` for the close-time ingest, `SessionSearchIngest` for the
//! per-turn search copy, the process's `SensitiveStore`), built once over them.
//!
//! The embedding model stays off the boot path, as in Node: the schema opens from the
//! model's dimensions (saved measurement, else its profile; an unprofiled model is measured by a
//! cold warm-up at the first start) and the model otherwise loads on demand (`MemoryRuntime`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use futures::future::BoxFuture;

use mixdog_core_api::domain::tool::Tool;
use mixdog_js::to_number;
use mixdog_rt::{DurabilityIo, LaneToken, MaintenanceIo, TaskClass};
use mixdog_statefile::{Opts, write_json};
use serde_json::Value;
use mixdog_workspace::watcher::FolderWatcher;

use crate::memory::cycles::embeddings::FlushEmbeddings;
use crate::memory::cycles::requests::wait;
use crate::memory::cycles::scheduler::SchedulerDeps;
use crate::memory::cycles::{Cycle1Llm, CycleConfig, CycleScheduler};
use crate::memory::embed::config::{self, DEFAULT_MODEL_ID};
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::embed_flush::{RawEmbedFlush, start_root_embed_sweep};
use crate::memory::ingest::{SessionIngest, system_now};
use crate::memory::pg::cluster::{DEFAULT_PORT, PgCluster, PgRuntime, Start, StopRecord};
pub use crate::memory::pg::cluster::StopDispatch;
use crate::memory::pg::db::{Db, Schema};
use crate::memory::recall::period::Clock;
use crate::memory::recall::{QueryEmbedder, Recall, RecallDeps};
use crate::memory::reindex::Reindex;
use crate::memory::runtime::{MemoryRuntime, RuntimeFlags};
use crate::memory::schema::ensure_memory_schema;
use crate::memory::sensitive::SensitiveStore;
use crate::memory::service::{LocalMemory, MemoryModule, MemoryService, SessionSource};
use crate::memory::tool::MemoryCallers;
use crate::memory::session_search::db::SessionSearchDb;
use crate::memory::session_search::ingest::{SessionSearchIngest, StoredSessions};
use crate::memory::lifecycle::{Owned, Scope};
use crate::memory::transcript::watcher::{TranscriptSink, TranscriptWatcher};
use crate::memory::transcript::{TranscriptIngest, TranscriptIo};
use crate::bots::delivery::env::RetryTimer;
use crate::model_install::{ProgressSink, fsio};
use crate::tidy::process::Processes;
use tokio_util::sync::CancellationToken;

/// `pg_ctl stop -m fast -t` after a failed opening: `stopPg`'s default (`process.mjs:524`).
const STOP_SECONDS: u64 = 15;

/// `PG_FORCED_STOP_AT_MS` (`daemon-stop-budget.mjs:18`): the launcher's wait for the daemon's exit, `IN_TREE_DAEMON_STOP_GRACE_MS` 5 000 (`:9`), less
/// `PG_STOP_SIGNAL_MARGIN_MS` 800 (`:13`) for the stop's signal. The cutoff: the stop-initiation point, counted from the shutdown's start
/// (`daemon-pg-stop.mjs:36-41`). Graceful progress ends there; nothing after it waits for the postmaster.
const PG_FORCED_STOP_AT: Duration = Duration::from_millis(5_000 - 800);

/// What memory start reads from the host.
pub struct MemoryBoot {
    pub data_dir: PathBuf,
    /// The bundled PostgreSQL runtime (`bin/`, `lib/`, `share/`), or what installs it at the first use.
    pub pg_runtime: PgRuntimeSource,
    /// `None` where onnxruntime ships no binding: recall runs on its text lanes.
    pub embedder: Option<Arc<EmbeddingProvider>>,
    /// The main config's `embedding.provider`; part of the stored model identity.
    pub embedding_provider: Option<String>,
    pub flags: RuntimeFlags,
    pub progress: Option<ProgressSink>,
    /// The process's one sensitive-value store: the search copy and the session turns share it.
    pub sensitive: Arc<SensitiveStore>,
    pub lane: DurabilityIo,
    /// The lane transcripts are read and the active-file scan runs on.
    pub maintenance: MaintenanceIo,
    /// The transcript watcher's change source and clock; `None` runs without a watcher.
    pub transcripts: Option<TranscriptWatch>,
    /// The cycles' host seams; `None` runs without cycles.
    pub cycles: Option<CycleBoot>,
    /// The stored sessions the one-time session-search backfill reads; `None` skips it.
    pub backfill: Option<BackfillBoot>,
    /// The one process manager `initdb` and `pg_ctl` run under.
    pub processes: Processes,
    /// Ends an `initdb` in progress (Node's init `signal`).
    pub cancel: CancellationToken,
}

/// The session-search backfill (`daemon.mjs`): once per run, a minute after start, low priority.
/// `stored` reads the session store (WP-SESSION); `timer` is the daemon's.
pub struct BackfillBoot {
    pub stored: Arc<dyn StoredSessions>,
    pub timer: Arc<dyn RetryTimer>,
}

/// `setTimeout(.., 60_000)` of the daemon's backfill.
const BACKFILL_DELAY: Duration = Duration::from_secs(60);

/// What the cycle scheduler needs from the composition root: the memory configuration section
/// and recap switch, the `cycle1-agent` dispatch, and the timer for the tick and retries. The
/// embedding work comes from the stack's own flusher.
pub struct CycleBoot {
    pub config: Arc<dyn CycleConfig>,
    pub llm: Arc<dyn Cycle1Llm>,
    pub timer: Arc<dyn RetryTimer>,
}

/// What the transcript watcher needs from the composition root (`initTranscriptWatcher`): the
/// projects root (`<home>/projects`), the core's one `FolderWatcher` and the sink it routes this
/// watcher's batches to (built first, see `TranscriptSink`), and the timer for the debounce and
/// the 5 minute safety sweep.
pub struct TranscriptWatch {
    pub projects_root: PathBuf,
    pub folders: Arc<FolderWatcher>,
    pub sink: TranscriptSink,
    pub timer: Arc<dyn RetryTimer>,
}

/// `<data>/embedding-meta.json`: the dimensions measured for one model identity, so a later start
/// opens the vector schema without loading the model.
const EMBEDDING_META: &str = "embedding-meta.json";

/// Awaits `open`; when it fails, runs `release` (what gives back the resource `open` worked over) before the error is returned.
pub(crate) async fn release_on_failure<T, E>(open: impl std::future::Future<Output = std::result::Result<T, E>>, release: impl std::future::Future<Output = ()>) -> std::result::Result<T, E> {
    match open.await {
        Ok(opened) => Ok(opened),
        Err(error) => {
            release.await;
            Err(error)
        }
    }
}

/// `_initStore`'s dimensions: the saved measurement of this identity, else the profile's, else a
/// cold warm-up that measures them (and saves the result). A model the profiles do not list
/// therefore needs the embedding model installed and loadable at the first start.
pub(crate) async fn resolve_dims(data_dir: &Path, lane: DurabilityIo, identity: &Value, model_id: &str, runtime: Option<&MemoryRuntime>) -> Result<usize> {
    let path = data_dir.join(EMBEDDING_META);
    let saved = fsio::read(lane, &path).await.ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if let Some(saved) = saved.filter(|saved| ["provider", "model", "dtype"].iter().all(|key| saved[key] == identity[key])) {
        let dims = to_number(&saved["dims"]);
        if dims.is_finite() && dims > 0.0 {
            return Ok(dims as usize);
        }
    }
    if let Some(known) = config::known_dims(model_id) {
        return Ok(known);
    }
    let unavailable = |why: &str| MemoryError::Embedding(format!("memory-service: embedding dims unavailable {why}"));
    let runtime = runtime.ok_or_else(|| unavailable("without an embedding model"))?;
    if !runtime.flags().warmup_can_start() {
        return Err(unavailable("while warmup is disabled"));
    }
    runtime.cold_warmup().await.map_err(MemoryError::Embedding)?;
    let loaded = runtime.embedder().warmup().await.map_err(MemoryError::Embedding)?;
    let dims = loaded.ok_or_else(|| unavailable("because the model is not installed"))?.dims();
    let mut meta = identity.clone();
    meta["dims"] = Value::from(dims);
    let written = lane
        .submit_wait(&mixdog_rt::CancellationToken::new(), move |proof| write_json(proof, &path, &meta, &Opts { lock: true, ..Opts::default() }))
        .await;
    match written {
        Ok(job) => {
            if let Ok(Err(error)) = job.await {
                mixdog_rt::memory_stderr!("[memory-service] could not persist embedding-meta: {error}");
            }
        }
        Err(error) => mixdog_rt::memory_stderr!("[memory-service] could not persist embedding-meta: {error:?}"),
    }
    Ok(dims)
}

/// Node's text for a use after the stop ended (`ensurePgInstance`, `supervisor.mjs:648`).
const REFUSED_AFTER_STOP: &str = "[supervisor-pg] process is shutting down; PG start refused";

/// Node's text for a use while the stop runs, and for an opening the stop ended (the lifecycle's refusal and its abort reason,
/// `memory-service-lifecycle.mjs:23,69`).
const STOPPING: &str = "memory service stopping";

/// Where the PostgreSQL runtime comes from: an unpacked directory, or an install that runs when the database is first needed
/// (Node's `ensureRuntime`, `supervisor.mjs:484`, runs inside the memory start, never at daemon boot).
/// What runs to bring the PostgreSQL runtime when the database is first opened.
pub type PgInstall = Arc<dyn Fn(CancellationToken) -> BoxFuture<'static, Result<PathBuf>> + Send + Sync>;

pub enum PgRuntimeSource {
    Dir(PathBuf),
    Install(PgInstall),
}

/// What an opening produced: the running cluster and the two schemas' open handles.
pub(crate) struct Opened {
    /// Held for the opening's life; the stop reaches the cluster through the stop-target record, never through this.
    #[expect(dead_code, reason = "held for the opening's life; the stop reaches the cluster through its stop-target record")]
    cluster: PgCluster,
    memory_db: Db,
    search_db: Db,
}

/// The outcome of the opening task, which every use that arrives while it runs awaits.
type Flight = futures::future::Shared<BoxFuture<'static, std::result::Result<(), String>>>;

/// What the stop did with PostgreSQL: the dispatch's recorded outcome ([`StopDispatch`]), whether the cutoff ended graceful progress, and whether the
/// postmaster's exit was observed (only ever waited for inside the cutoff; `None` when nothing was waited for). Reported only after local revocation
/// was acknowledged: every owned future and connection driver of the stack was destroyed, so this process submits nothing more.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopReport {
    pub forced: bool,
    pub dispatch: StopDispatch,
    pub postmaster_exited: Option<bool>,
    /// The shutdown's last finalizer flushed the WAL (a commit with `synchronous_commit = on`) before the dispatch. Only a graceful stop flushes:
    /// on the forced path the last commits acknowledged under `synchronous_commit = off` and not yet written by the WAL writer (its delay, at most
    /// a few hundred ms of commits) can be lost if the postmaster is ended before its shutdown checkpoint, a stated limit.
    pub flushed: bool,
    /// The controller's dispatch of a cluster the opening reached after the first dispatch decided (made once the local revocation was
    /// acknowledged, when no further transition can come); `None` when nothing came late.
    pub late_dispatch: Option<StopDispatch>,
}

/// The opening's report to the stop record ([`crate::memory::pg::cluster::Launch`]).
struct StackLaunch<'a> {
    stack: &'a MemoryStack,
    runtime: &'a PgRuntime,
}

impl crate::memory::pg::cluster::Launch for StackLaunch<'_> {
    fn admit(&self) -> bool {
        self.stack.admit_start(self.runtime)
    }

    fn established(&self, cluster: PgCluster) -> PgCluster {
        self.stack.record.reached(self.runtime, None);
        // A test's hold of the opening's poll right after its record: an owned poll still running, so the local acknowledgement cannot complete.
        #[cfg(test)]
        crate::memory::lifecycle::fences::hold("established-recorded");
        cluster
    }
}

/// The one stop of a stack, shared by the ordered stop and the forced point.
type StopFlight = futures::future::Shared<BoxFuture<'static, StopReport>>;

/// Whether the stack stopped, and the opening in flight. One lock, so a stop and the opening's publication are ordered: an opening that ends after the
/// stop began does not publish, and releases what it opened itself.
#[derive(Default)]
struct Opening {
    stopped: bool,
    /// From the stop's start until it returns: a refusal in this span is Node's lifecycle's, after it the supervisor's.
    stop_running: bool,
    /// The opening task's outcome, shared by every use that arrived while it runs, under the number of its opening. A flight that settled (by any
    /// way: completed, revoked, refused) is not joined: the next use starts a new one (Node's `createSharedAbortable` hands one promise to all
    /// callers and forgets it whenever it settles, `supervisor.mjs:659-665`).
    flight: Option<(u64, Flight)>,
    /// Openings launched so far: the number of the next one.
    launched: u64,
    /// Uses of the opening in flight that are still waiting for it, and whether one joined that cannot withdraw (`createSharedAbortable`'s `waiting` and
    /// `pinned`, `abort-race.mjs:79-80`). Reset when an opening launches.
    waiters: usize,
    pinned: bool,
    /// Ends the opening in flight: cancelled when its last waiter withdraws and none is pinned (`abort-race.mjs:115-123`), or with the stack.
    token: Option<CancellationToken>,
    /// When the latest opening was launched: a request's wait for the runtime is bounded from it (Node's from its spawn of the memory child).
    since: Option<tokio::time::Instant>,
}

fn refusal(opening: &Opening) -> &'static str {
    if opening.stop_running { STOPPING } else { REFUSED_AFTER_STOP }
}


/// One use waiting for the opening in flight. Dropped before the opening ends, the use has withdrawn: the opening is cancelled when no use is left
/// waiting and none cannot withdraw (`createSharedAbortable`'s `onAbort`, `abort-race.mjs:111-123`). Dropped after the opening ended, it does nothing.
struct Waiting<'a> {
    stack: &'a MemoryStack,
    number: u64,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut opening = self.stack.opening.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if !opening.flight.as_ref().is_some_and(|(number, flight)| *number == self.number && flight.peek().is_none()) {
            return;
        }
        opening.waiters = opening.waiters.saturating_sub(1);
        if opening.waiters == 0 && !opening.pinned
            && let Some(token) = &opening.token
        {
            token.cancel();
        }
    }
}

/// The rows of the agent trace held for the `trace` store until it opens, then fed to it.
pub(crate) struct PendingTrace {
    state: std::sync::Mutex<PendingState>,
    stack: std::sync::Weak<MemoryStack>,
}

enum PendingState {
    Held(Vec<(serde_json::Map<String, Value>, i64)>),
    Open(crate::memory::trace::TraceStore),
    Closed,
}

/// Rows held before the store opens, as many as its own queue keeps (`QUEUE_MAX_PENDING_EVENTS`).
const TRACE_HELD_MAX: usize = 10_000;

impl PendingTrace {
    /// The store is open: every held row goes in, in order, and later rows go straight to it. A sink already closed hands the store back, to be closed.
    fn open(&self, store: crate::memory::trace::TraceStore) -> Option<crate::memory::trace::TraceStore> {
        let mut state = self.state.lock().expect("trace sink");
        let PendingState::Held(held) = &mut *state else { return Some(store) };
        for (row, now_ms) in std::mem::take(held) {
            mixdog_trace::RowSink::row(&store, &row, now_ms);
        }
        *state = PendingState::Open(store);
        None
    }

    /// Rows go nowhere from here; the store, if it was open, is handed back to be closed.
    fn close(&self) -> Option<crate::memory::trace::TraceStore> {
        match std::mem::replace(&mut *self.state.lock().expect("trace sink"), PendingState::Closed) {
            PendingState::Open(store) => Some(store),
            _ => None,
        }
    }

    #[cfg(test)]
    fn held(&self) -> usize {
        match &*self.state.lock().expect("trace sink") {
            PendingState::Held(held) => held.len(),
            _ => 0,
        }
    }
}

impl mixdog_trace::RowSink for PendingTrace {
    fn row(&self, row: &serde_json::Map<String, Value>, now_ms: i64) {
        let first = {
            let mut state = self.state.lock().expect("trace sink");
            match &mut *state {
                PendingState::Open(store) => {
                    mixdog_trace::RowSink::row(&*store, row, now_ms);
                    return;
                }
                PendingState::Closed => return,
                PendingState::Held(held) => {
                    if held.len() >= TRACE_HELD_MAX {
                        held.remove(0);
                    }
                    held.push((row.clone(), now_ms));
                    held.len() == 1
                }
            }
        };
        // The record that finds the runtime not started starts it (Node's `await init()`); the opening feeds the held rows to the store.
        if first && let Some(stack) = self.stack.upgrade() {
            mixdog_rt::spawn("services.memory.trace-start", TaskClass::Work, async move {
                let _ = stack.opened().await;
            });
        }
    }
}

/// A memory runtime. Like Node's (`registerMemoryRuntimeLazy`, `daemon.mjs:202`) it costs nothing at construction:
/// the runtime download, `initdb`, the postmaster, the schemas and the background work (transcript watcher, cycles,
/// reindex, backfill) start at the first use of the database, or when [`MemoryStack::open_in_background`] finds a cluster already on disk.
pub struct MemoryStack {
    me: std::sync::Weak<MemoryStack>,
    data_dir: PathBuf,
    source: PgRuntimeSource,
    identity: Value,
    model_id: String,
    embedder: Option<Arc<EmbeddingProvider>>,
    lane: DurabilityIo,
    processes: Processes,
    /// Ends the opening in progress; cancelled by `stop`, and a child of the host's token.
    cancel: CancellationToken,
    /// What a cluster start asks and waits on (Node's in a release build).
    start: Start,
    /// Set once by the opening task, unless a stop came first.
    opened: std::sync::OnceLock<Opened>,
    /// What an opening that ended after the stop began opened: never served, only handed to the stop, which closes its pools and stops its cluster.
    late: std::sync::OnceLock<Opened>,
    opening: std::sync::Mutex<Opening>,
    /// The lifecycle owner of every piece of work and every connection driver that touches the stack's databases (Rule A): all the stack's handles
    /// carry it ([`Db::scope`]), the trace store and the watcher are groups of it, the drivers its transport group, and the opening and the
    /// shutdown's own finalizers are its work. Accepted work is service-owned: a caller that stops waiting leaves it running to completion (no cap),
    /// as a Node promise outlives its caller; only the owner's revocation at the cutoff ends it early.
    scope: Scope,
    /// What follows the opening (`run_background`), as work of [`Self::scope`].
    background: std::sync::Mutex<Option<Owned<()>>>,
    /// The opt-in `trace` store's sink (`openTraceDatabase`), present from the start only when tracing is on: rows wait in it until the store opens.
    trace: std::sync::OnceLock<Arc<PendingTrace>>,
    /// Told when an opening ends, however it ends: the first-start notice of the database goes then, once `initdb` and the postmaster are behind it.
    opening_ended: std::sync::OnceLock<Arc<dyn Fn() + Send + Sync>>,
    flags: RuntimeFlags,
    memory_db: Db,
    memory: Arc<LocalMemory>,
    search: Arc<SessionSearchIngest>,
    sensitive: Arc<SensitiveStore>,
    runtime: Option<Arc<MemoryRuntime>>,
    embed_flush: Arc<RawEmbedFlush>,
    reindex: Arc<Reindex>,
    transcripts: Arc<TranscriptIngest>,
    watch: std::sync::Mutex<Option<TranscriptWatch>>,
    /// The running watcher, published before any of its tasks starts ([`MemoryStack::run_background`]).
    watcher: std::sync::Mutex<Option<Arc<TranscriptWatcher>>>,
    cycles: Option<CycleScheduler>,
    backfill_boot: std::sync::Mutex<Option<BackfillBoot>>,
    backfill: std::sync::Mutex<Option<Owned<()>>>,
    backfill_cancel: CancellationToken,
    /// When the core's shutdown began ([`MemoryStack::arm_forced_stop`]); [`PG_FORCED_STOP_AT`] counts from it, as Node's does.
    shutdown_began: std::sync::OnceLock<tokio::time::Instant>,
    /// The one stop-target record ([`StopRecord`]).
    record: Arc<StopRecord>,
    /// The shutdown's WAL flush completed ([`StopReport::flushed`]).
    flushed: std::sync::atomic::AtomicBool,
    /// The one stop controller: the stop's flight, started by the ordered stop or by the forced point, whichever comes first, with one recorded
    /// outcome.
    stop: std::sync::Mutex<Option<StopFlight>>,
    /// Raised by the forced point: the stop in flight ends graceful progress now.
    forced: tokio::sync::watch::Sender<bool>,
    #[cfg(any(test, feature = "test-support"))]
    stop_seam: StopSeam,
}

/// A development-only seam on the stop's two failing steps, inert until a test acts: it makes the background-work stop or the storage release fail with a
/// given text, and records each step as it ends, in order.
#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
pub struct StopSeam {
    state: std::sync::Mutex<StopSeamState>,
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Default)]
struct StopSeamState {
    fail_background: Option<String>,
    fail_storage: Option<String>,
    steps: Vec<&'static str>,
    trail: Vec<&'static str>,
}

#[cfg(any(test, feature = "test-support"))]
impl StopSeam {
    pub fn fail_background(&self, text: &str) {
        self.state.lock().expect("seam").fail_background = Some(text.to_owned());
    }

    pub fn fail_storage(&self, text: &str) {
        self.state.lock().expect("seam").fail_storage = Some(text.to_owned());
    }

    /// The stop steps that ended so far (`background-stopped`, `storage-released`), in order.
    pub fn steps(&self) -> Vec<&'static str> {
        self.state.lock().expect("seam").steps.clone()
    }

    /// Records a point of the stop that cannot fail (`revoked`, `release-begun`), or a test's own marker, in [`Self::trail`].
    pub fn note(&self, point: &'static str) {
        self.state.lock().expect("seam").trail.push(point);
    }

    /// The points [`Self::note`] recorded so far, in order.
    pub fn trail(&self) -> Vec<&'static str> {
        self.state.lock().expect("seam").trail.clone()
    }

    fn step(&self, step: &'static str, outcome: Result<()>) -> Result<()> {
        let mut state = self.state.lock().expect("seam");
        state.steps.push(step);
        let injected = match step {
            "background-stopped" => state.fail_background.clone(),
            _ => state.fail_storage.clone(),
        };
        match injected {
            Some(text) => Err(MemoryError::Rejected(text)),
            None => outcome,
        }
    }
}

#[cfg(test)]
mod trace_sink_tests {
    use super::*;

    /// A row that arrives before the store opens is held, not dropped; once the sink is closed nothing is held any more.
    #[tokio::test]
    async fn rows_before_the_store_opens_are_held_until_it_does() {
        let sink = PendingTrace { state: std::sync::Mutex::new(PendingState::Held(Vec::new())), stack: std::sync::Weak::new() };
        let row = serde_json::Map::new();
        mixdog_trace::RowSink::row(&sink, &row, 1);
        mixdog_trace::RowSink::row(&sink, &row, 2);
        assert_eq!(sink.held(), 2);
        assert!(sink.close().is_none());
        mixdog_trace::RowSink::row(&sink, &row, 3);
        assert_eq!(sink.held(), 0);
    }
}

impl MemoryStack {
    /// Builds the stack over deferred database handles; nothing here touches PostgreSQL or the network.
    pub async fn start(boot: MemoryBoot) -> Result<Arc<Self>> {
        Self::start_with(boot, Start::node()).await
    }

    /// [`MemoryStack::start`] whose cluster start asks and waits on `start` (a test holds the probe and the waits).
    pub(crate) async fn start_with(boot: MemoryBoot, start: Start) -> Result<Arc<Self>> {
        let MemoryBoot { data_dir, pg_runtime, embedder, embedding_provider, flags, progress, sensitive, lane, maintenance, transcripts: watch, cycles, backfill, processes, cancel } = boot;
        let (model_id, dtype) = match &embedder {
            Some(provider) => (provider.model_id().to_owned(), provider.dtype().map(str::to_owned)),
            None => (DEFAULT_MODEL_ID.to_owned(), None),
        };
        let identity = config::identity(embedding_provider.as_deref(), &model_id, dtype.as_deref());
        let runtime = embedder.clone().map(|provider| MemoryRuntime::new(provider, flags, progress));
        let scope = Scope::new();
        let built = Arc::new_cyclic(|me: &std::sync::Weak<MemoryStack>| {
            let deferred = |schema: Schema| {
                let me = me.clone();
                let launched = me.clone();
                let since: crate::memory::pg::db::OpeningSince =
                    Arc::new(move || launched.upgrade().and_then(|stack| stack.opening.lock().expect("opening").since));
                Db::deferred(
                    schema,
                    Arc::new(move || {
                        let me = me.clone();
                        Box::pin(async move {
                            let stack = me.upgrade().ok_or_else(|| MemoryError::Runtime("the memory runtime is gone".to_owned()))?;
                            let opened = stack.opened().await?;
                            Ok(match schema {
                                Schema::Memory => opened.memory_db.opened_pool(),
                                Schema::SessionSearch => opened.search_db.opened_pool(),
                            })
                        })
                    }),
                    since,
                )
                .with_scope(scope.clone())
            };
            let (memory_db, search_db) = (deferred(Schema::Memory), deferred(Schema::SessionSearch));
            let search = SessionSearchIngest::new(SessionSearchDb::over(search_db.clone()), sensitive.clone());
            // `embedQuery` (`query-hybrid-search.mjs:39`): a cold model is warmed within the recall's bounded wait.
            let query: Option<Arc<dyn QueryEmbedder>> = embedder.clone().map(|provider| {
                Arc::new(crate::memory::recall::readiness::RecallEmbedder::new(provider, flags.secondary)) as Arc<dyn QueryEmbedder>
            });
            let recall = Recall::new(RecallDeps {
                db: memory_db.clone(),
                clock: Arc::new(|| Clock { now_ms: chrono::Utc::now().timestamp_millis(), zone: mixdog_js::time::local_zone() }),
                embedder: query,
                session_cwd: None,
                lane,
                estimate_tokens: Arc::new(mixdog_js::token_estimate::estimate_tokens),
                trace: None,
            });
            // One flusher per database, as Node keeps one cache state, prune clock and in-flight flush
            // per db handle: session ingest, the reindex and the memory cycles share it.
            let embed_flush = Arc::new(RawEmbedFlush::new(memory_db.clone(), embedder.clone()));
            let ingest = SessionIngest::new(memory_db.clone(), embed_flush.clone(), None, system_now(), lane);
            let memory = Arc::new(LocalMemory::new(memory_db.clone(), data_dir.clone(), recall, ingest, lane));
            let transcripts = TranscriptIngest::new(memory_db.clone(), TranscriptIo { maintenance, durability: lane }, system_now());
            // The 60 s cycle tick starts unless this is a secondary process or the host left the
            // cycles out (`MIXDOG_MEMORY_DISABLE_CYCLES`); the tick itself re-reads `cycles_enabled`
            // (the recap switch), so recap can be turned on later.
            let cycle_config = cycles.as_ref().map(|cycles| cycles.config.clone());
            let projects_root = watch.as_ref().map(|watch| watch.projects_root.clone());
            let cycles = match cycles {
                Some(cycles) if !flags.secondary => Some(CycleScheduler::new(SchedulerDeps {
                    db: memory_db.clone(),
                    llm: cycles.llm,
                    embeddings: Arc::new(FlushEmbeddings(embed_flush.clone())),
                    config: cycles.config,
                    state_file: data_dir.join("memory-cycle-state.json"),
                    lane: maintenance,
                    now: system_now(),
                    timer: cycles.timer,
                })),
                _ => None,
            };
            memory.attach_maintenance(crate::memory::service::maintenance::Maintenance::new(
                cycles.clone().zip(cycle_config),
                embed_flush.clone(),
                transcripts.clone(),
                projects_root,
                maintenance,
                lane,
            ));
            let record = StopRecord::new(data_dir.join("pgdata"), lane, processes.clone(), !flags.secondary);
            Self {
                me: me.clone(),
                data_dir,
                source: pg_runtime,
                identity,
                model_id,
                embedder,
                lane,
                processes,
                cancel: cancel.child_token(),
                start,
                opened: std::sync::OnceLock::new(),
                late: std::sync::OnceLock::new(),
                opening: std::sync::Mutex::new(Opening::default()),
                scope: scope.clone(),
                background: std::sync::Mutex::new(None),
                trace: std::sync::OnceLock::new(),
                opening_ended: std::sync::OnceLock::new(),
                flags,
                memory_db,
                memory,
                search,
                sensitive,
                runtime,
                embed_flush,
                reindex: Reindex::new(),
                transcripts,
                watch: std::sync::Mutex::new(watch),
                watcher: std::sync::Mutex::new(None),
                cycles,
                backfill_boot: std::sync::Mutex::new(backfill),
                backfill: std::sync::Mutex::new(None),
                backfill_cancel: CancellationToken::new(),
                shutdown_began: std::sync::OnceLock::new(),
                stop: std::sync::Mutex::new(None),
                record,
                flushed: std::sync::atomic::AtomicBool::new(false),
                forced: tokio::sync::watch::channel(false).0,
                #[cfg(any(test, feature = "test-support"))]
                stop_seam: StopSeam::default(),
            }
        });
        // Node's `recordTraceEvents` awaited the memory runtime's start, so no record was lost to it: with tracing on, the sink is in place from the start and
        // holds rows until the store opens (the first one starts the opening).
        if built.trace_enabled().await {
            let sink = Arc::new(PendingTrace { state: std::sync::Mutex::new(PendingState::Held(Vec::new())), stack: Arc::downgrade(&built) });
            let _ = built.trace.set(sink.clone());
            mixdog_trace::install_process_sink(Some(sink));
        }
        Ok(built)
    }

    /// The opened database, opening it first when nobody has: the first use pays for the runtime install, `initdb`
    /// and the postmaster. A failed opening is retried by the next use (Node's lazy singleton).
    async fn opened(&self) -> Result<&Opened> {
        self.opened_as(false).await
    }

    /// [`Self::opened`] for a caller that cannot withdraw: while it waits, the opening goes on whoever else leaves (`join` without a signal).
    pub(crate) async fn opened_as(&self, pinned: bool) -> Result<&Opened> {
        use futures::FutureExt as _;
        let (flight, _waiting, launch) = {
            let mut opening = self.opening.lock().expect("opening");
            // Node refuses before its fast path and before joining the shared ensure (`ensurePgInstance`, `supervisor.mjs:647-665`).
            if opening.stopped {
                return Err(MemoryError::Rejected(refusal(&opening).to_owned()));
            }
            if let Some(opened) = self.opened.get() {
                return Ok(opened);
            }
            let live = opening.flight.as_ref().filter(|(_, flight)| flight.peek().is_none()).map(|(number, flight)| (*number, flight.clone()));
            let (number, flight, launch) = match live {
                Some((number, flight)) => (number, flight, None),
                None => {
                    // The opening is the owner's work from here: an inert slot reserved under this lock (which a stop takes to set `stopped` before it
                    // drains), installed after the lock is released, so a refusal destroys nothing under it.
                    let reservation = self.scope.reserve().ok_or_else(|| MemoryError::Rejected(refusal(&opening).to_owned()))?;
                    opening.launched += 1;
                    let number = opening.launched;
                    let token = self.cancel.child_token();
                    let (done, outcome) = tokio::sync::oneshot::channel();
                    let flight: Flight = async move { outcome.await.unwrap_or_else(|_| Err(STOPPING.to_owned())) }.boxed().shared();
                    opening.since = Some(tokio::time::Instant::now());
                    opening.flight = Some((number, flight.clone()));
                    opening.waiters = 0;
                    opening.pinned = false;
                    opening.token = Some(token.clone());
                    (number, flight, Some((reservation, token, done)))
                }
            };
            opening.pinned |= pinned;
            opening.waiters += 1;
            (flight, Waiting { stack: self, number }, launch)
        };
        if let Some((reservation, token, done)) = launch {
            self.launch(reservation, token, done);
        }
        // A failed opening's text is every waiting use's error.
        flight.await.map_err(MemoryError::Rejected)?;
        self.opened.get().ok_or_else(|| MemoryError::Rejected(self.refusal().to_owned()))
    }

    /// The text a use refused by a stop gets: the lifecycle's while the stop runs, the supervisor's after it.
    fn refusal(&self) -> &'static str {
        refusal(&self.opening.lock().expect("opening"))
    }

    /// Binds who is told when an opening (runtime install, `initdb`, postmaster start, schemas) ends; the first binding stands.
    pub fn on_opening_end(&self, ended: Arc<dyn Fn() + Send + Sync>) {
        let _ = self.opening_ended.set(ended);
    }

    /// The stop's failure seam (development builds only).
    #[cfg(any(test, feature = "test-support"))]
    pub fn stop_seam(&self) -> &StopSeam {
        &self.stop_seam
    }

    /// Whether a stop is running (Node's `isStopping`).
    pub fn is_stopping(&self) -> bool {
        self.opening.lock().expect("opening").stop_running
    }

    #[cfg(node_twin)]
    /// The opening in flight, as a wait for its end (a test waits for the opening to settle before the next use).
    #[cfg(test)]
    pub(crate) fn settled(&self) -> Option<BoxFuture<'static, ()>> {
        use futures::FutureExt as _;
        let flight = self.opening.lock().expect("opening").flight.as_ref().map(|(_, flight)| flight.clone())?;
        Some(async move { let _ = flight.await; }.boxed())
    }

    /// Installs the opening in its reserved slot: it runs to its end whatever its callers do (Node's shared promise does), as the owner's work, which
    /// the stop's drain waits for and the cutoff revokes. A refused activation (the cut won) runs nothing; its flight answers [`STOPPING`].
    fn launch(&self, reservation: crate::memory::lifecycle::Reservation, cancel: CancellationToken, done: tokio::sync::oneshot::Sender<std::result::Result<(), String>>) {
        let Some(me) = self.me.upgrade() else { return };
        let _opening = reservation.activate("services.memory.open", async move {
            use futures::FutureExt as _;
            // A panic ends the opening like a failure (Node forgets its shared ensure whenever it settles): its text is every waiting use's error.
            let outcome = std::panic::AssertUnwindSafe(me.clone().run_opening(&cancel)).catch_unwind().await.unwrap_or_else(|panic| {
                let text = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default();
                Err(format!("the memory opening ended: the opening panicked: {text}"))
            });
            if let Some(ended) = me.opening_ended.get() {
                ended();
            }
            let _ = done.send(outcome);
        });
    }

    /// The last check before a postmaster starts, made under the lock a stop takes, in the same poll as the spawn: no start begins once a stop has
    /// begun, and an admitted one is recorded as handed to the OS before it is spawned.
    fn admit_start(&self, runtime: &PgRuntime) -> bool {
        let opening = self.opening.lock().expect("opening");
        if opening.stopped {
            return false;
        }
        // Recorded under the record's lock (taken inside the opening lock a stop takes) before the spawn.
        self.record.handed(runtime);
        true
    }

    /// The opening task: opens, then publishes the result and starts the background work, unless a stop began meanwhile; then it releases what it opened
    /// itself, so a cluster an abandoned opening started is never left without an owner.
    async fn run_opening(self: Arc<Self>, cancel: &CancellationToken) -> std::result::Result<(), String> {
        let outcome = self.open(cancel).await;
        let opening = self.opening.lock().expect("opening");
        // Publication does not move the stop target: the record already names the cluster from its attach or start (`open`).
        match outcome {
            Err(error) => Err(error.message()),
            // Node's acquisition resolved after the abort: `signal.throwIfAborted()` throws the abort reason (`memory-service-lifecycle.mjs:33`). The
            // stop releases what it opened (its pools close and its cluster is signalled with the stop's own dispatch).
            Ok(opened) if opening.stopped => {
                let refused = refusal(&opening).to_owned();
                let _ = self.late.set(opened);
                Err(refused)
            }
            Ok(opened) => {
                let _ = self.opened.set(opened);
                // A child of the opening (admitted while the opening is polled), reserved under the lock a stop takes and installed after it.
                let reservation = self.scope.reserve();
                drop(opening);
                let me = self.clone();
                let background = reservation.and_then(|reservation| {
                    reservation.activate("services.memory.runtime-start", async move {
                        let cancel = me.cancel.clone();
                        tokio::select! {
                            biased;
                            () = cancel.cancelled() => {}
                            () = me.run_background() => {}
                        }
                    })
                });
                *self.background.lock().expect("background") = background;
                Ok(())
            }
        }
    }

    /// The stack as an opening that published `cluster` with handles that never connect leaves it: what the stop's teardown and release act on, without
    /// a postmaster.
    #[cfg(test)]
    pub(crate) fn opened_over(&self, cluster: PgCluster) {
        let (memory_db, search_db) = (
            Db::unconnected(cluster.port(), Schema::Memory, self.scope.clone()),
            Db::unconnected(cluster.port(), Schema::SessionSearch, self.scope.clone()),
        );
        self.record.reached(cluster.runtime(), None);
        assert!(self.opened.set(Opened { cluster, memory_db, search_db }).is_ok(), "one opening");
    }

    async fn open(&self, cancel: &CancellationToken) -> Result<Opened> {
        // A stop in the same turn as the use cancels the acquisition before it starts (Node's queued `initialize` sees the aborted signal first,
        // `memory-service-lifecycle.mjs:30`).
        if cancel.is_cancelled() {
            return Err(MemoryError::Rejected(self.refusal().to_owned()));
        }
        let runtime_dir = match &self.source {
            PgRuntimeSource::Dir(dir) => dir.clone(),
            PgRuntimeSource::Install(install) => install(cancel.clone()).await?,
        };
        let dims = self.until_cancelled(cancel, resolve_dims(&self.data_dir, self.lane, &self.identity, &self.model_id, self.runtime.as_deref())).await?;
        let runtime = PgRuntime::new(runtime_dir);
        // The start reports to the stop record synchronously where each fact becomes true: its admission before the spawn, the attach or the
        // readiness before `ensure` returns (`StackLaunch`). No await separates an established cluster from its record.
        let ensured = PgCluster::ensure(runtime.clone(), &self.data_dir, DEFAULT_PORT, self.lane, self.processes.clone(), cancel, &self.start, &StackLaunch { stack: self, runtime: &runtime }).await;
        let cluster = match ensured {
            Ok(cluster) => {
                // A test's fence between the recorded attach (or start) and the pid read, which the stop's cancel does not end: only the cutoff's
                // revocation does, and the stop must still reach the cluster without its pid.
                #[cfg(test)]
                crate::memory::lifecycle::fences::pass("cluster-recorded").await;
                // The pid the stop signals, added to the record so the stop does not depend on a file read; until then a dispatch reads it itself.
                if let Ok(Some(pid)) = crate::memory::pg::cluster::recorded_pid(self.lane, cluster.data_dir()).await {
                    self.record.known_pid(pid);
                }
                cluster
            }
            Err(error) => {
                // Cleared only on evidence that no postmaster is left (a start whose cleanup stop failed keeps its target).
                self.record.failed_start().await;
                return Err(error);
            }
        };
        // The postmaster is up: a failure from here to the end of the opening stops it (Node's boot error goes through `shutdown`, whose memory stop ends
        // PostgreSQL, `daemon.mjs:1347,377,383`), as `stop` does: a secondary process leaves the shared one running.
        let (memory_db, search_db) = release_on_failure(
            self.until_cancelled(cancel, async {
                // The bootstrap connections and the pools' drivers are the stack's transport from before they connect.
                let memory_db = Db::open(&cluster, Schema::Memory, self.scope.clone()).await?;
                ensure_memory_schema(&memory_db, dims, &self.identity).await?;
                // Root vectors made under the older root text are replaced by the paced sweep;
                // an existing sweep keeps its progress.
                start_root_embed_sweep(&memory_db).await?;
                let search_db = Db::open(&cluster, Schema::SessionSearch, self.scope.clone()).await?;
                SessionSearchDb::open(search_db.clone()).await?;
                Ok::<_, MemoryError>((memory_db, search_db))
            }),
            async {
                if !self.flags.secondary {
                    match cluster.stop(Duration::from_secs(STOP_SECONDS)).await {
                        // Stopped: nothing is left for the stop to reach.
                        Ok(()) => self.record.cleared(),
                        Err(error) => tracing::warn!(error = %error.message(), "[pg-process] stopping PostgreSQL after a failed memory start"),
                    }
                }
            },
        )
        .await?;
        Ok(Opened { cluster, memory_db, search_db })
    }

    /// `work` unless its opening is cancelled first (a stop, or the last waiter's withdrawal): the schema steps and the dimension lookup have no time
    /// limit of their own, so a cancellation must be able to end them.
    async fn until_cancelled<T>(&self, cancel: &CancellationToken, work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(MemoryError::Rejected(self.refusal().to_owned())),
            done = work => done,
        }
    }

    /// What follows an opening (`_initStore`, `_initRuntime`): the snapshot refresh, the persisted transcript
    /// positions, the transcript watcher (not in secondary mode: the primary ingests), the cycles, the backfill, the reindex.
    async fn run_background(self: Arc<Self>) {
        // First boot migrates existing core data; later boots reconcile a crash between a committed mutation and its file refresh. A child of this
        // work in the stack's scope: the stop waits for it or revokes it.
        let refresh = self.memory.clone();
        let _refreshing = self.scope.spawn("services.memory.snapshot-boot", async move {
            refresh.refresh_snapshot("boot-migration").await;
        });
        self.start_trace().await;
        self.transcripts.load_transcript_offsets().await;
        let watch = self.watch.lock().expect("watch").take();
        if let Some(watch) = watch.filter(|_| !self.flags.secondary) {
            // The handle is published before any task of it starts, and only while no stop has begun: the stop, which ends this work before it takes
            // the slot, always finds a watcher whose tasks run.
            let watcher = {
                let mut slot = self.watcher.lock().expect("watcher");
                if self.opening.lock().expect("opening").stopped {
                    return;
                }
                let watcher = Arc::new(TranscriptWatcher::new(watch.projects_root, self.transcripts.clone(), watch.folders, watch.timer));
                *slot = Some(watcher.clone());
                watcher
            };
            watcher.start(&watch.sink).await;
        }
        if let Some(cycles) = &self.cycles {
            cycles.start_cycles().await;
        }
        let backfill = self.backfill_boot.lock().expect("backfill").take();
        if let Some(backfill) = backfill {
            let (search, stop) = (self.search.clone(), self.backfill_cancel.clone());
            *self.backfill.lock().expect("backfill") = self.scope.spawn("services.memory.session-search-backfill", async move {
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = wait(backfill.timer.as_ref(), BACKFILL_DELAY) => {}
                }
                // Derived rows: the stop cancels the backfill, and the next run's restores whatever this one did not reach.
                tokio::select! {
                    () = stop.cancelled() => {}
                    outcome = search.backfill(backfill.stored.as_ref()) => {
                        if let Err(error) = outcome {
                            tracing::warn!("session-search backfill failed: {}", error.message());
                        }
                    }
                }
            });
        }
        if self.embedder.is_some() {
            self.reindex.start(self.embed_flush.clone(), self.flags.secondary);
        }
    }

    /// `openTraceDatabase`: with tracing on, the `trace` store opens and the rows held for it (and every later one) reach it; with it off, a leftover `trace`
    /// schema is dropped.
    async fn start_trace(&self) {
        let Some(opened) = self.opened.get() else { return };
        let enabled = self.trace_enabled().await;
        let days = crate::memory::trace::retention_days(std::env::var("MIXDOG_TRACE_RETENTION_DAYS").ok().as_deref());
        match crate::memory::trace::TraceStore::open(Arc::new(opened.memory_db.clone()), enabled, days, chrono::Utc::now().timestamp_millis()).await {
            Ok(Some(store)) => {
                let unused = match self.trace.get() {
                    Some(sink) => sink.open(store),
                    None => Some(store),
                };
                if let Some(store) = unused {
                    store.close(chrono::Utc::now().timestamp_millis()).await;
                }
            }
            Ok(None) => {
                if let Some(sink) = self.trace.get() {
                    drop(sink.close());
                }
            }
            Err(error) => tracing::warn!(error = %error.message(), "[trace-store] open failed"),
        }
    }

    async fn trace_enabled(&self) -> bool {
        let marker = matches!(fsio::exists(self.lane, &crate::memory::trace::trace_marker_path(&self.data_dir)).await, Ok(true));
        crate::memory::trace::trace_enabled(std::env::var("MIXDOG_TRACE").ok().as_deref(), marker)
    }
    /// After the daemon is ready (`startPostgresInBackground`, `daemon.mjs:881`): a data directory that already holds a
    /// cluster opens it off the request path; one with none starts nothing, so a fresh profile downloads and initialises nothing at boot.
    /// The returned handle ends when that decision and the opening it led to are over.
    pub fn open_in_background(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let stack = self.clone();
        mixdog_rt::spawn("services.memory.open-existing", TaskClass::Work, async move {
            if matches!(fsio::exists(stack.lane, &stack.data_dir.join("pgdata").join("PG_VERSION")).await, Ok(true))
                && let Err(error) = stack.opened_as(true).await
            {
                tracing::warn!(error = %error.message(), "postgres background start failed");
            }
        })
    }

    /// The cycle scheduler (`awaitCycle1Run`, `startCycle1Run`, the health ledger); `None` in a
    /// secondary process or when the host runs without cycles.
    pub fn cycles(&self) -> Option<CycleScheduler> {
        self.cycles.clone()
    }

    /// Transcript ingest and its persisted offsets (`forgetTranscripts` for a deleted session).
    pub fn transcripts(&self) -> Arc<TranscriptIngest> {
        self.transcripts.clone()
    }

    /// The database's one embedding flusher: roots, raw rows and the root-text sweep.
    pub fn embed_flush(&self) -> Arc<RawEmbedFlush> {
        self.embed_flush.clone()
    }

    /// `SessionDeps.memory`: the module the close-time ingest and the tool route call.
    pub fn module(&self) -> Arc<dyn MemoryModule> {
        self.memory.clone()
    }

    #[cfg(test)]
    pub(crate) fn local_memory(&self) -> Arc<LocalMemory> {
        self.memory.clone()
    }

    /// The `memory` and `recall` tools, in that order (`TOOL_DEFS` of the memory runtime).
    pub fn tools(&self, callers: Arc<dyn MemoryCallers>) -> Vec<Arc<dyn Tool>> {
        crate::memory::tool::tools(self.memory.clone(), callers)
    }

    /// The memory domain's `memory/*` routes over the session layer.
    pub fn service(&self, sessions: Arc<dyn SessionSource>) -> MemoryService {
        MemoryService::new(self.memory.clone(), sessions)
    }

    /// `SessionDeps.search`: the per-turn search copy's writer (also `forgetSessionSearch`'s).
    pub fn search(&self) -> Arc<SessionSearchIngest> {
        self.search.clone()
    }

    pub fn sensitive(&self) -> Arc<SensitiveStore> {
        self.sensitive.clone()
    }

    /// Embedding warm-up and install triggers; `None` without an embedder.
    pub fn runtime(&self) -> Option<Arc<MemoryRuntime>> {
        self.runtime.clone()
    }

    /// The host's memory-control operation: every list/delete runs as work of the stack's owner.
    pub fn memory_control(&self) -> crate::memory::core::action::ControlScope {
        crate::memory::core::action::ControlScope::new(self.memory_db.clone(), self.data_dir(), self.snapshot_revision(), self.lane)
    }

    /// Whether the stop has read its record for the first dispatch.
    #[cfg(test)]
    pub(crate) fn stop_decided(&self) -> bool {
        self.record.decided()
    }

    /// Whether the background after the opening published its watcher and opened the trace store.
    #[cfg(test)]
    pub(crate) fn background_ready(&self) -> bool {
        let traced = self.trace.get().is_some_and(|sink| matches!(*sink.state.lock().expect("trace sink"), PendingState::Open(_)));
        self.watcher.lock().expect("watcher").is_some() && traced
    }

    /// The trace sink (a test records rows through it).
    #[cfg(test)]
    pub(crate) fn trace_sink(&self) -> Option<Arc<PendingTrace>> {
        self.trace.get().cloned()
    }

    /// Scoped operations over the `memory` schema (the legacy migration, the readiness wait).
    pub fn memory_access(&self) -> crate::memory::access::MemoryAccess {
        crate::memory::access::MemoryAccess::over(self.memory_db.clone())
    }

    /// Scoped operations over the session-search schema (`thread/search`).
    pub fn search_access(&self) -> crate::memory::access::MemoryAccess {
        crate::memory::access::MemoryAccess::over(self.search.db().db().clone())
    }

    /// The `memory` schema's raw handle, for tests only: product code reaches the database through scoped operations ([`Self::memory_access`],
    /// [`Self::memory_control`]).
    #[cfg(any(test, feature = "test-support"))]
    pub fn db(&self) -> Arc<Db> {
        Arc::new(self.memory_db.clone())
    }

    /// The process's one snapshot revision counter, shared with the rooms' memory control.
    pub fn snapshot_revision(&self) -> Arc<AtomicU64> {
        self.memory.snapshot_revision()
    }

    pub fn data_dir(&self) -> PathBuf {
        self.memory.data_dir().to_owned()
    }

    /// Whether an opening has completed and no stop has ended since (Node's `initialized`, cleared when its stop settles,
    /// `memory-service-lifecycle.mjs:99`).
    pub fn is_open(&self) -> bool {
        let opening = self.opening.lock().expect("opening");
        self.opened.get().is_some() && (!opening.stopped || opening.stop_running)
    }

    /// The host's stop at quit (and at a failed composition): in Node the memory process stops when its last client is gone and writes a
    /// failed stop to its stderr (`memory-daemon-lifecycle.mjs:66-71`, `log` = `__mixdogMemoryLog`, `index.mjs:170`), which the daemon's spawner
    /// mirrors into `memory-runtime-proxy.log`. The core writes the same line to the memory worker's stderr. Node's preceding "client grace
    /// elapsed" line names a timer the core does not have, and the separate process's exit code has no counterpart.
    pub async fn stop_for_quit(&self) {
        if let Err(error) = self.stop().await {
            mixdog_rt::memory_stderr!("[memory-service] daemon client-grace shutdown failed: {}", error.message());
        }
    }

    /// The core's shutdown began now (the first call counts), as Node's `createDaemonPgStop` is armed at the start of `shutdown()`
    /// (`daemon.mjs:299`, `daemon-pg-stop.mjs:21`): the cutoff ([`PG_FORCED_STOP_AT`]) is counted from here, not from this stack's own stop, which
    /// comes after the sessions and the steps before it. At the cutoff a timer independent of those steps addresses the one stop controller: it
    /// starts the stop if none has begun, and ends graceful progress of the one in flight ([`Self::stop`]). Both callers get the one recorded outcome.
    pub fn arm_forced_stop(&self, runtime: &tokio::runtime::Handle) {
        let began = tokio::time::Instant::now();
        if self.shutdown_began.set(began).is_err() {
            return;
        }
        let Some(stack) = self.me.upgrade() else { return };
        // The task ends with the process; the daemon's exit does not wait for it.
        drop(runtime.spawn(async move {
            // Counted from the shutdown's start, not from the task's first poll: a task that first runs late must not push the point back.
            mixdog_rt::time::sleep_until(began + PG_FORCED_STOP_AT).await;
            let _ = stack.forced.send_replace(true);
            let report = stack.stop_flight().await;
            if let Err(error) = stack.reported(&report) {
                mixdog_rt::memory_stderr!("[memory-service] daemon client-grace shutdown failed: {}", error.message());
            }
        }));
    }

    /// Releases the trace sink: rows go nowhere from here, and an open store is handed back to be closed.
    fn uninstall_trace(&self) -> Option<crate::memory::trace::TraceStore> {
        let sink = self.trace.get()?;
        mixdog_trace::install_process_sink(None);
        sink.close()
    }

    /// `_stopRuntime`: background installs end, the work drains, the pools close and the connection drivers retire, then the postmaster is signalled
    /// (a secondary process leaves the shared one running). One stop runs for the ordered stop and the forced point together, as Node's
    /// `createDaemonPgStop` runs the one stop for whichever of its two callers comes first; every caller gets its one recorded outcome.
    pub async fn stop(&self) -> Result<()> {
        let report = self.stop_flight().await;
        self.reported(&report)
    }

    /// The stop's recorded outcome, once it has been reported (a caller that needs more than success or failure).
    pub async fn stop_report(&self) -> StopReport {
        self.stop_flight().await
    }

    /// The stop's outcome as the host's result: a dispatch that failed, or a start handed to the OS that the stop could not reach, is a failure.
    fn reported(&self, report: &StopReport) -> Result<()> {
        let background: Result<()> = Ok(());
        #[cfg(any(test, feature = "test-support"))]
        let background = self.stop_seam.step("background-stopped", background);
        // A cluster reached after the first dispatch was dispatched again by the controller: that later outcome is the one that counts.
        let storage = match report.late_dispatch.as_ref().unwrap_or(&report.dispatch) {
            StopDispatch::Failed(text) => Err(MemoryError::Runtime(format!("stopping PostgreSQL failed: {text}"))),
            StopDispatch::ExternalStartUnresolved => Err(MemoryError::Runtime(
                "stopping PostgreSQL: a start handed to the OS before the stop could not be reached (external-start-unresolved)".to_owned(),
            )),
            _ => Ok(()),
        };
        #[cfg(any(test, feature = "test-support"))]
        let storage = self.stop_seam.step("storage-released", storage);
        let mut failures: Vec<MemoryError> = [background, storage].into_iter().filter_map(Result::err).collect();
        match failures.len() {
            0 => Ok(()),
            1 => Err(failures.remove(0)),
            _ => Err(MemoryError::Shutdown(failures)),
        }
    }

    /// The one stop's flight, started on the first call. The controller runs no SQL; its outcome is shared by every caller.
    fn stop_flight(&self) -> StopFlight {
        use futures::FutureExt as _;
        let mut stop = self.stop.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(flight) = stop.as_ref() {
            return flight.clone();
        }
        let flight: StopFlight = match self.me.upgrade() {
            Some(me) => {
                // The stop begins in the caller's turn: from here no opening, start or watcher publication begins, and the owner is draining with the
                // shutdown work registered in the same step.
                let began = tokio::time::Instant::now();
                {
                    let mut opening = self.opening.lock().expect("opening");
                    opening.stopped = true;
                    opening.stop_running = true;
                }
                self.cancel.cancel();
                let worker = me.clone();
                let shutdown = self.scope.begin_drain("services.memory.shutdown", async move { worker.shutdown_work().await });
                // Driven by its callers (the ordered stop and the forced point's timer), never by a task of its own: a stop step that runs on an
                // executor the host is already winding down still drives it to its end.
                async move { me.run_stop(began, shutdown).await }.boxed().shared()
            }
            None => async { StopReport { forced: false, dispatch: StopDispatch::NothingOpened, postmaster_exited: None, flushed: false, late_dispatch: None } }.boxed().shared(),
        };
        *stop = Some(flight.clone());
        flight
    }

    /// The stop controller. It runs no SQL itself:
    /// 1. `stopped` is set under the opening lock (no opening, start or watcher publication begins after it), then the owner enters `Draining` with
    ///    the shutdown work registered in the same step ([`Self::shutdown_work`]: the background's end, the watcher's ingests, the offsets' write,
    ///    the trace store's drain, the remaining accepted work), so the finalizers are owned work like any other.
    /// 2. Until the cutoff: the shutdown work completes, then the pools close and the transport group (the drivers) retires.
    /// 3. At the cutoff, or once 2 completed: local revocation is requested (synchronous: it marks and wakes, it destroys nothing itself), the stop is
    ///    dispatched at once (it never waits for the local acknowledgement, so a stuck poll cannot delay the signal), then the acknowledgement is
    ///    awaited. Only when graceful progress completed before the cutoff is the postmaster's exit observed, with what is left of the cutoff; at the
    ///    cutoff the observation is abandoned, never the shutdown.
    async fn run_stop(self: Arc<Self>, began: tokio::time::Instant, shutdown: Option<Owned<()>>) -> StopReport {
        let cutoff = self.shutdown_began.get().copied().unwrap_or(began) + PG_FORCED_STOP_AT;
        let mut forced_rx = self.forced.subscribe();
        let graceful = async {
            if let Some(shutdown) = shutdown {
                shutdown.await;
            }
            self.close_pools();
            let transport = self.scope.transport();
            transport.seal();
            transport.idle().await;
        };
        let forced = tokio::select! {
            biased;
            _ = forced_rx.wait_for(|forced| *forced) => true,
            () = mixdog_rt::time::sleep_until(cutoff) => true,
            () = graceful => false,
        };
        if forced {
            // Node's fallback log line (`daemon-pg-stop.mjs:38`): what the teardown had not finished is cut, and PostgreSQL is asked to stop anyway.
            tracing::warn!("teardown still running {}ms into shutdown; stopping postgres before the launcher's kill", PG_FORCED_STOP_AT.as_millis());
        }
        // Revocation requested: admission ends for everything, every slot is marked and its pump woken.
        self.scope.request_revoke();
        drop(self.uninstall_trace());
        self.close_pools();
        #[cfg(any(test, feature = "test-support"))]
        self.stop_seam.note("revoked");
        #[cfg(any(test, feature = "test-support"))]
        self.stop_seam.note("release-begun");
        // A test's fence right before the delivery (it suspends the postmaster's main thread there, so the shutdown cannot proceed).
        #[cfg(test)]
        crate::memory::lifecycle::fences::pass("dispatching").await;
        let dispatch = self.dispatch().await;
        // Local revocation acknowledged: every owned future and driver was destroyed and published done.
        self.scope.revoked().await;
        // Every transition of the stop record is made by the opening, the owner's work: after the acknowledgement none can follow. A cluster reached
        // after the first dispatch decided already started its own delivery in that transition (`StopRecord::reached`); here its outcome is
        // collected, bounded, and recorded.
        let late_dispatch = self.record.late_dispatch().await;
        let postmaster_exited = match (&dispatch, forced) {
            (StopDispatch::Dispatched { pid }, false) => Some(crate::memory::pg::cluster::await_exit(*pid, cutoff).await),
            _ => None,
        };
        let flushed = !forced && self.flushed.load(std::sync::atomic::Ordering::SeqCst);
        if let Some(runtime) = &self.runtime {
            runtime.shutdown();
        }
        if let Some(cycles) = &self.cycles {
            cycles.reset_in_flight();
        }
        self.opening.lock().expect("opening").stop_running = false;
        StopReport { forced, dispatch, postmaster_exited, flushed, late_dispatch }
    }

    /// The pools of what was opened close: idle connections end and their drivers retire; a connection still checked out is discarded when its
    /// holder returns or is revoked.
    fn close_pools(&self) {
        for opened in [self.opened.get(), self.late.get()].into_iter().flatten() {
            opened.memory_db.close();
            opened.search_db.close();
        }
    }

    /// The stop's dispatch to PostgreSQL, recorded as its outcome, from the one stop-target record ([`StopTarget`]): a cluster attached or started is
    /// signalled for a fast shutdown (its recorded pid, else its pid file) and the call returns without waiting for the postmaster; a start handed
    /// to the OS that has no pid file yet is reported unresolved. The whole step is bounded and always ends in an outcome.
    async fn dispatch(&self) -> StopDispatch {
        self.record.dispatch().await
    }

    /// The trace store's close: its admission is sealed and its accepted work finished, then its queue drained (`closeTraceDatabase`).
    async fn close_trace(&self) {
        if let Some(store) = self.uninstall_trace() {
            store.close(chrono::Utc::now().timestamp_millis()).await;
        }
    }

    /// The shutdown's own work, registered as the owner's work at the transition to draining. It waits for the groups it depends on, never for an
    /// idle that includes itself. Node's order (`shutdownOwnedPg`, `adapter.mjs:603-627`): the work that writes through the database ends first.
    async fn shutdown_work(self: Arc<Self>) {
        // The work that publishes the watcher, the cycles and the backfill ends first (cancelled by the stop), so nothing is published after the
        // slots below are taken.
        let background = self.background.lock().expect("background").take();
        if let Some(background) = background {
            background.await;
        }
        // `_stopBackgroundWork`: the watcher stops arming, the reindex ends, then the ingests still running finish and the offsets are written before
        // the pools drain. The backfill is a low-priority one-shot: it is cancelled with the stack.
        self.backfill_cancel.cancel();
        let backfill = self.backfill.lock().expect("backfill").take();
        if let Some(backfill) = backfill {
            backfill.await;
        }
        if let Some(cycles) = &self.cycles {
            cycles.shutdown().await;
        }
        let watcher = self.watcher.lock().expect("watcher").take();
        if let Some(watcher) = &watcher {
            watcher.stop();
        }
        self.reindex.stop().await;
        if let Some(watcher) = &watcher {
            if let Err(error) = watcher.finished().await {
                tracing::warn!(%error, "[transcript-watch] shutdown");
            }
            // Node writes the offsets through the pool it opened with (`memory.mjs:414`) and refuses only new starts until PostgreSQL's own stop
            // begins (`supervisor.mjs:794`), so this write goes through the open pool itself, as the shutdown's own work.
            if let Some(opened) = self.opened.get() {
                self.transcripts.persist_transcript_offsets_over(&opened.memory_db).await;
            }
        }
        // The trace store finishes what it accepted (feed batches already taken included) and drains its queue before its pool is released.
        self.close_trace().await;
        // Every other piece of accepted work and its descendants (session ingests, their embedding and queued flushes, actions, recalls, the
        // snapshot refresh, search writes, an opening cancelled by the stop) ends.
        self.scope.idle().await;
        // The last finalizer: the cluster commits asynchronously (`synchronous_commit = off`). PostgreSQL 17's `RecordTransactionCommit` flushes
        // synchronously only when the transaction has an XID, wrote WAL, and `synchronous_commit > off` (then `XLogFlush(XactLastRecEnd)`), and a
        // flush to an LSN writes out every WAL record before it: one transaction that really writes WAL under `synchronous_commit = on` flushes
        // the WAL past every earlier asynchronous commit. `flushed` is set from evidence: the flush position after the commit against the insert
        // position read after the write.
        if let Some(opened) = self.opened.get() {
            let flushed = async {
                let lease = crate::memory::pg::db::Lease::take(&opened.memory_db).await?;
                lease.begin().await?;
                lease.batch_execute("SET LOCAL synchronous_commit = on").await?;
                lease
                    .execute(
                        "INSERT INTO meta(key, value) VALUES ('state.shutdown_wal_flush', to_jsonb(now()::text))
                         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                        &[],
                    )
                    .await?;
                #[cfg(test)]
                crate::memory::lifecycle::fences::pass("wal-flush").await;
                let written: String = lease.query_one("SELECT pg_current_wal_insert_lsn()::text", &[]).await?.get(0);
                lease.commit().await?;
                let covered: bool = lease.query_one("SELECT pg_current_wal_flush_lsn() >= $1::text::pg_lsn", &[&written]).await?.get(0);
                lease.release(None).await;
                Ok::<bool, MemoryError>(covered)
            }
            .await;
            match flushed {
                Ok(covered) => self.flushed.store(covered, std::sync::atomic::Ordering::SeqCst),
                Err(error) => tracing::warn!(error = %error.message(), "[memory] the shutdown's WAL flush failed"),
            }
        }
    }
}
