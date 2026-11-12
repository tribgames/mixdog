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
use crate::memory::pg::cluster::{DEFAULT_PORT, PgCluster, PgRuntime, Start};
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
use crate::memory::transcript::watcher::{TranscriptSink, TranscriptWatcher, start_transcript_watcher};
use crate::memory::transcript::{TranscriptIngest, TranscriptIo};
use crate::bots::delivery::env::RetryTimer;
use crate::model_install::{ProgressSink, fsio};
use crate::tidy::process::Processes;
use tokio_util::sync::CancellationToken;

/// `pg_ctl stop -m fast -t` after a failed opening: `stopPg`'s default (`process.mjs:524`).
const STOP_SECONDS: u64 = 15;

/// `PG_STOP_TIMEOUT_MS` (`daemon.mjs:256`): the shutdown's `pg_ctl stop -m fast -t` (`stopOwnedPgForShutdown({ timeoutMs })`, `daemon-pg-stop.mjs:28`).
const PG_STOP_TIMEOUT: Duration = Duration::from_millis(6_000);

/// `PG_FORCED_STOP_AT_MS` (`daemon-stop-budget.mjs:18`): the launcher's wait for the daemon's exit, `IN_TREE_DAEMON_STOP_GRACE_MS` 5 000 (`:9`), less
/// `PG_STOP_SIGNAL_MARGIN_MS` 800 (`:13`) for `pg_ctl stop`'s spawn and signal. The teardown before the PostgreSQL stop runs at most this long.
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

/// How long a stop waits for an opening in flight (`stopOwnedPgForShutdown`'s `timeoutMs`, 6 s).
const OPENING_JOIN: Duration = Duration::from_secs(6);

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
    cluster: PgCluster,
    memory_db: Db,
    search_db: Db,
}

/// The outcome of the opening task, which every use that arrives while it runs awaits.
type Flight = futures::future::Shared<BoxFuture<'static, std::result::Result<(), String>>>;

/// Whether the stack stopped, and the opening in flight. One lock, so a stop and the opening's publication are ordered: an opening that ends after the
/// stop began does not publish, and releases what it opened itself.
#[derive(Default)]
struct Opening {
    stopped: bool,
    /// From the stop's start until it returns: a refusal in this span is Node's lifecycle's, after it the supervisor's.
    stop_running: bool,
    /// The opening task's outcome, shared by every use that arrived while it runs, under the number of its opening; forgotten when that task ends by
    /// any way, a panic included, so the next use starts a new one (Node's `createSharedAbortable` hands one promise to all callers and forgets it
    /// whenever it settles, `supervisor.mjs:659-665`).
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

/// Clears the stop's running mark when the stop ends, however it ends.
struct StopRunning<'a>(&'a std::sync::Mutex<Opening>);

impl Drop for StopRunning<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).stop_running = false;
    }
}

/// Forgets its opening when the opening task ends, however it ends.
struct Settled {
    stack: Arc<MemoryStack>,
    number: u64,
}

impl Drop for Settled {
    fn drop(&mut self) {
        let mut opening = self.stack.opening.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if opening.flight.as_ref().is_some_and(|(number, _)| *number == self.number) {
            opening.flight = None;
        }
    }
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
        if !opening.flight.as_ref().is_some_and(|(number, _)| *number == self.number) {
            return;
        }
        opening.waiters = opening.waiters.saturating_sub(1);
        if opening.waiters == 0 && !opening.pinned {
            if let Some(token) = &opening.token {
                token.cancel();
            }
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
    opening: std::sync::Mutex<Opening>,
    background: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
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
    watcher: std::sync::Mutex<Option<TranscriptWatcher>>,
    cycles: Option<CycleScheduler>,
    backfill_boot: std::sync::Mutex<Option<BackfillBoot>>,
    backfill: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    backfill_cancel: CancellationToken,
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
                opening: std::sync::Mutex::new(Opening::default()),
                background: std::sync::Mutex::new(None),
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
                #[cfg(any(test, feature = "test-support"))]
                stop_seam: StopSeam::default(),
            }
        });
        Ok(built)
    }

    /// The opened database, opening it first when nobody has: the first use pays for the runtime install, `initdb`
    /// and the postmaster. A failed opening is retried by the next use (Node's lazy singleton).
    async fn opened(&self) -> Result<&Opened> {
        self.opened_as(false).await
    }

    /// [`Self::opened`] for a caller that cannot withdraw: while it waits, the opening goes on whoever else leaves (`join` without a signal).
    pub(crate) async fn opened_as(&self, pinned: bool) -> Result<&Opened> {
        let (flight, _waiting) = {
            let mut opening = self.opening.lock().expect("opening");
            // Node refuses before its fast path and before joining the shared ensure (`ensurePgInstance`, `supervisor.mjs:647-665`).
            if opening.stopped {
                return Err(MemoryError::Rejected(refusal(&opening).to_owned()));
            }
            if let Some(opened) = self.opened.get() {
                return Ok(opened);
            }
            let (number, flight) = match &opening.flight {
                Some((number, flight)) => (*number, flight.clone()),
                None => {
                    opening.launched += 1;
                    let number = opening.launched;
                    let token = self.cancel.child_token();
                    let flight = self.launch(number, token.clone())?;
                    opening.since = Some(tokio::time::Instant::now());
                    opening.flight = Some((number, flight.clone()));
                    opening.waiters = 0;
                    opening.pinned = false;
                    opening.token = Some(token);
                    (number, flight)
                }
            };
            opening.pinned |= pinned;
            opening.waiters += 1;
            (flight, Waiting { stack: self, number })
        };
        // A failed opening's text is every waiting use's error.
        flight.await.map_err(MemoryError::Rejected)?;
        self.opened.get().ok_or_else(|| MemoryError::Rejected(self.refusal().to_owned()))
    }

    /// The text a use refused by a stop gets: the lifecycle's while the stop runs, the supervisor's after it.
    fn refusal(&self) -> &'static str {
        refusal(&self.opening.lock().expect("opening"))
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

    /// The opening in flight, as a wait for its end (a test waits for the opening to settle before the next use).
    #[cfg(test)]
    pub(crate) fn settled(&self) -> Option<BoxFuture<'static, ()>> {
        use futures::FutureExt as _;
        let flight = self.opening.lock().expect("opening").flight.as_ref().map(|(_, flight)| flight.clone())?;
        Some(async move { let _ = flight.await; }.boxed())
    }

    /// Starts the opening as a task of its own: it runs to its end whatever its callers do (Node's shared promise does), and `stop` cancels and joins it.
    fn launch(&self, number: u64, cancel: CancellationToken) -> Result<Flight> {
        use futures::FutureExt as _;
        let me = self.me.upgrade().ok_or_else(|| MemoryError::Rejected(REFUSED_AFTER_STOP.to_owned()))?;
        let task = mixdog_rt::spawn("services.memory.open", TaskClass::Work, async move {
            let _settled = Settled { stack: me.clone(), number };
            me.run_opening(&cancel).await
        });
        Ok(async move { task.await.unwrap_or_else(|error| Err(format!("the memory opening ended: {error}"))) }.boxed().shared())
    }

    /// The last check before a postmaster starts, made under the lock a stop takes: no start begins once a stop has begun.
    fn admit_start(&self) -> bool {
        !self.opening.lock().expect("opening").stopped
    }

    /// The opening task: opens, then publishes the result and starts the background work, unless a stop began meanwhile; then it releases what it opened
    /// itself, so a cluster an abandoned opening started is never left without an owner.
    async fn run_opening(self: Arc<Self>, cancel: &CancellationToken) -> std::result::Result<(), String> {
        let outcome = self.open(cancel).await;
        let late = {
            let opening = self.opening.lock().expect("opening");
            match outcome {
                Err(error) => return Err(error.message()),
                // Node's acquisition resolved after the abort: `signal.throwIfAborted()` throws the abort reason (`memory-service-lifecycle.mjs:33`).
                Ok(opened) if opening.stopped => (opened, refusal(&opening)),
                Ok(opened) => {
                    let _ = self.opened.set(opened);
                    let me = self.clone();
                    *self.background.lock().expect("background") = Some(mixdog_rt::spawn("services.memory.runtime-start", TaskClass::Work, async move { me.run_background().await }));
                    return Ok(());
                }
            }
        };
        let (late, refused) = late;
        if let Err(error) = self.release(&late).await {
            tracing::warn!(error = %error.message(), "[pg-process] stopping PostgreSQL an opening started after the stop began");
        }
        Err(refused.to_owned())
    }

    /// The pools close and, unless this is a secondary process, the postmaster stops, within the shutdown's bound.
    async fn release(&self, opened: &Opened) -> Result<()> {
        opened.memory_db.close();
        opened.search_db.close();
        if self.flags.secondary {
            return Ok(());
        }
        opened.cluster.stop(PG_STOP_TIMEOUT).await
    }

    /// The stack as an opening that published `cluster` with handles that never connect leaves it: what the stop's teardown and release act on, without
    /// a postmaster.
    #[cfg(test)]
    pub(crate) fn opened_over(&self, cluster: PgCluster) {
        let (memory_db, search_db) = (Db::unconnected(cluster.port(), Schema::Memory), Db::unconnected(cluster.port(), Schema::SessionSearch));
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
        let cluster = PgCluster::ensure(PgRuntime::new(runtime_dir), &self.data_dir, DEFAULT_PORT, self.lane, self.processes.clone(), cancel, &self.start, &|| self.admit_start()).await?;
        // The postmaster is up: a failure from here to the end of the opening stops it (Node's boot error goes through `shutdown`, whose memory stop ends
        // PostgreSQL, `daemon.mjs:1347,377,383`), as `stop` does: a secondary process leaves the shared one running.
        let (memory_db, search_db) = release_on_failure(
            self.until_cancelled(cancel, async {
                let memory_db = Db::open(&cluster, Schema::Memory).await?;
                ensure_memory_schema(&memory_db, dims, &self.identity).await?;
                // Root vectors made under the older root text are replaced by the paced sweep;
                // an existing sweep keeps its progress.
                start_root_embed_sweep(&memory_db).await?;
                let search_db = Db::open(&cluster, Schema::SessionSearch).await?;
                SessionSearchDb::open(search_db.clone()).await?;
                Ok::<_, MemoryError>((memory_db, search_db))
            }),
            async {
                if !self.flags.secondary {
                    if let Err(error) = cluster.stop(Duration::from_secs(STOP_SECONDS)).await {
                        tracing::warn!(error = %error.message(), "[pg-process] stopping PostgreSQL after a failed memory start");
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
        // First boot migrates existing core data; later boots reconcile a crash between a committed mutation and its file refresh.
        let refresh = self.memory.clone();
        mixdog_rt::spawn("services.memory.snapshot-boot", TaskClass::Work, async move {
            refresh.refresh_snapshot("boot-migration").await;
        });
        self.transcripts.load_transcript_offsets().await;
        let watch = self.watch.lock().expect("watch").take();
        if let Some(watch) = watch.filter(|_| !self.flags.secondary) {
            let started = start_transcript_watcher(watch.projects_root, self.transcripts.clone(), watch.folders, &watch.sink, watch.timer).await;
            *self.watcher.lock().expect("watcher") = Some(started);
        }
        if let Some(cycles) = &self.cycles {
            cycles.start_cycles().await;
        }
        let backfill = self.backfill_boot.lock().expect("backfill").take();
        if let Some(backfill) = backfill {
            let (search, stop) = (self.search.clone(), self.backfill_cancel.clone());
            *self.backfill.lock().expect("backfill") = Some(mixdog_rt::spawn("services.memory.session-search-backfill", TaskClass::Work, async move {
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = wait(backfill.timer.as_ref(), BACKFILL_DELAY) => {}
                }
                if let Err(error) = search.backfill(backfill.stored.as_ref()).await {
                    tracing::warn!("session-search backfill failed: {}", error.message());
                }
            }));
        }
        if self.embedder.is_some() {
            self.reindex.start(self.embed_flush.clone(), self.flags.secondary);
        }
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

    /// The `memory` schema's pool, for the rooms' memory control.
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

    /// `_stopRuntime`: background installs end, the pools drain, then the postmaster stops
    /// (a secondary process leaves the shared one running). A stack nobody used has nothing to stop.
    pub async fn stop(&self) -> Result<()> {
        let flight = {
            let mut opening = self.opening.lock().expect("opening");
            opening.stopped = true;
            opening.stop_running = true;
            opening.flight.as_ref().map(|(_, flight)| flight.clone())
        };
        let _running = StopRunning(&self.opening);
        self.cancel.cancel();
        // Node's order (`shutdownOwnedPg`, `adapter.mjs:603-627`): the work that writes through the database ends first, within the point at which Node asks
        // PostgreSQL to stop whatever teardown still runs (`PG_FORCED_STOP_AT`, `daemon-pg-stop.mjs:36-41`); then the opening in flight is waited for;
        // then the pools close and PostgreSQL stops. An opening still in flight publishes nothing after the stop began, so it starts no background work.
        let background = self.background.lock().expect("background").take();
        let watcher = self.watcher.lock().expect("watcher").take();
        let teardown = async {
            if let Some(background) = background {
                background.abort();
                let _ = background.await;
            }
            // `_stopBackgroundWork`: the watcher stops arming, the reindex ends, then the ingests
            // still running finish and the offsets are written before the pools drain.
            // The backfill is a low-priority one-shot: it ends with the stack.
            self.backfill_cancel.cancel();
            let backfill = self.backfill.lock().expect("backfill").take();
            if let Some(backfill) = backfill {
                // Derived rows: the next run's backfill restores whatever this one did not reach.
                backfill.abort();
                let _ = backfill.await;
            }
            if let Some(cycles) = &self.cycles {
                cycles.shutdown().await;
            }
            if let Some(watcher) = &watcher {
                watcher.stop();
            }
            self.reindex.stop().await;
            if let Some(watcher) = &watcher {
                if let Err(error) = watcher.finished().await {
                    tracing::warn!(%error, "[transcript-watch] shutdown");
                }
                self.transcripts.persist_transcript_offsets().await;
            }
        };
        if mixdog_rt::time::timeout(PG_FORCED_STOP_AT, teardown).await.is_err() {
            // Node's fallback log line (`daemon-pg-stop.mjs:38`); what the teardown had not finished is ended, and PostgreSQL is asked to stop anyway.
            tracing::warn!("teardown still running {}ms into shutdown; stopping postgres before the launcher's kill", PG_FORCED_STOP_AT.as_millis());
            if let Some(cycles) = &self.cycles {
                cycles.abandon();
            }
            self.reindex.abandon();
            if let Some(watcher) = &watcher {
                watcher.abandon();
            }
        }
        // The opening task is joined for at most `OPENING_JOIN` (`stopOwnedPgForShutdown`'s race, `supervisor.mjs:790-800`): it was cancelled, so it normally
        // ends at once, and one that does not goes on alone as Node's does: it publishes nothing after this point and stops what it opened itself if the
        // process lives that long. A postmaster started by an opening admitted before the stop and still coming up at 6 s is left as Node leaves it (its
        // exit hook, `supervisor.mjs:832-845`, covers only a published `_live`): it runs outside the core's job, and the next core attaches to it and stops it.
        if let Some(flight) = flight {
            let _ = mixdog_rt::time::timeout(OPENING_JOIN, flight).await;
        }
        let opened = self.opened.get();
        if let Some(runtime) = &self.runtime {
            runtime.shutdown();
        }
        // Node attempts every step and reports what failed, one failure as itself, several together (`memory-service-lifecycle.mjs:73-96`):
        // the background work's stop ends here (its last step is the embedding shutdown above), then storage is released whatever it reported.
        let background: Result<()> = Ok(());
        #[cfg(any(test, feature = "test-support"))]
        let background = self.stop_seam.step("background-stopped", background);
        if let Some(cycles) = &self.cycles {
            cycles.reset_in_flight();
        }
        let storage = match opened {
            Some(opened) => self.release(opened).await,
            None => Ok(()),
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
}
