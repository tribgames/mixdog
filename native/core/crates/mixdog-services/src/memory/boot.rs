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
use crate::memory::pg::cluster::{DEFAULT_PORT, PgCluster, PgRuntime};
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

/// `pg_ctl stop -m fast -t`: how long a shutdown waits for the postmaster.
const STOP_SECONDS: u64 = 15;

/// What memory start reads from the host.
pub struct MemoryBoot {
    pub data_dir: PathBuf,
    /// The bundled PostgreSQL runtime (`bin/`, `lib/`, `share/`).
    pub pg_runtime: PathBuf,
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
                tracing::warn!(%error, "[memory-service] could not persist embedding-meta");
            }
        }
        Err(error) => tracing::warn!(?error, "[memory-service] could not persist embedding-meta"),
    }
    Ok(dims)
}

/// A started memory runtime.
pub struct MemoryStack {
    cluster: PgCluster,
    flags: RuntimeFlags,
    memory_db: Db,
    search_db: Db,
    memory: Arc<LocalMemory>,
    search: Arc<SessionSearchIngest>,
    sensitive: Arc<SensitiveStore>,
    runtime: Option<Arc<MemoryRuntime>>,
    embed_flush: Arc<RawEmbedFlush>,
    reindex: Arc<Reindex>,
    transcripts: Arc<TranscriptIngest>,
    watcher: Option<TranscriptWatcher>,
    cycles: Option<CycleScheduler>,
    backfill: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    backfill_cancel: CancellationToken,
}

impl MemoryStack {
    pub async fn start(boot: MemoryBoot) -> Result<Self> {
        let MemoryBoot { data_dir, pg_runtime, embedder, embedding_provider, flags, progress, sensitive, lane, maintenance, transcripts: watch, cycles, backfill, processes, cancel } = boot;
        let (model_id, dtype) = match &embedder {
            Some(provider) => (provider.model_id().to_owned(), provider.dtype().map(str::to_owned)),
            None => (DEFAULT_MODEL_ID.to_owned(), None),
        };
        let identity = config::identity(embedding_provider.as_deref(), &model_id, dtype.as_deref());
        let runtime = embedder.clone().map(|provider| MemoryRuntime::new(provider, flags, progress));
        let dims = resolve_dims(&data_dir, lane, &identity, &model_id, runtime.as_deref()).await?;

        let cluster = PgCluster::ensure(PgRuntime::new(pg_runtime), data_dir.join("pgdata"), DEFAULT_PORT, lane, processes, &cancel).await?;
        // The postmaster is up: a failure from here to the end of the stack's construction stops it (Node's boot error goes through `shutdown`, whose memory stop ends
        // PostgreSQL, `daemon.mjs:1347,377,383`), as `stop` does: a secondary process leaves the shared one running.
        let (memory_db, search_db, search) = release_on_failure(
            async {
                let memory_db = Db::open(&cluster, Schema::Memory).await?;
                ensure_memory_schema(&memory_db, dims, &identity).await?;
                // Root vectors made under the older root text are replaced by the paced sweep below;
                // an existing sweep keeps its progress.
                start_root_embed_sweep(&memory_db).await?;
                let search_db = Db::open(&cluster, Schema::SessionSearch).await?;
                let search = SessionSearchIngest::new(SessionSearchDb::open(search_db.clone()).await?, sensitive.clone());
                Ok::<_, MemoryError>((memory_db, search_db, search))
            },
            async {
                if !flags.secondary {
                    if let Err(error) = cluster.stop(Duration::from_secs(STOP_SECONDS)).await {
                        tracing::warn!(error = %error.message(), "[pg-process] stopping PostgreSQL after a failed memory start");
                    }
                }
            },
        )
        .await?;

        let query: Option<Arc<dyn QueryEmbedder>> = embedder.clone().map(|provider| provider as Arc<dyn QueryEmbedder>);
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

        // First boot migrates existing core data; later boots reconcile a crash between a
        // committed mutation and its file refresh. Not part of readiness.
        let refresh = memory.clone();
        mixdog_rt::spawn("services.memory.snapshot-boot", TaskClass::Work, async move {
            refresh.refresh_snapshot("boot-migration").await;
        });

        // `_initStore`: the persisted transcript positions load once the store is open; then
        // `_initRuntime` starts the transcript watcher (not in secondary mode: the primary
        // ingests) before the reindex.
        let transcripts = TranscriptIngest::new(memory_db.clone(), TranscriptIo { maintenance, durability: lane }, system_now());
        transcripts.load_transcript_offsets().await;
        let watcher = match watch {
            Some(watch) if !flags.secondary => {
                Some(start_transcript_watcher(watch.projects_root, transcripts.clone(), watch.folders, &watch.sink, watch.timer).await)
            }
            _ => None,
        };
        // The 60 s cycle tick starts unless this is a secondary process or the host left the
        // cycles out (`MIXDOG_MEMORY_DISABLE_CYCLES`); the tick itself re-reads `cycles_enabled`
        // (the recap switch), so recap can be turned on later.
        let cycles = match cycles {
            Some(cycles) if !flags.secondary => {
                let scheduler = CycleScheduler::new(SchedulerDeps {
                    db: memory_db.clone(),
                    llm: cycles.llm,
                    embeddings: Arc::new(FlushEmbeddings(embed_flush.clone())),
                    config: cycles.config,
                    state_file: data_dir.join("memory-cycle-state.json"),
                    lane: maintenance,
                    now: system_now(),
                    timer: cycles.timer,
                });
                scheduler.start_cycles().await;
                Some(scheduler)
            }
            _ => None,
        };
        let backfill_cancel = CancellationToken::new();
        let backfill = backfill.map(|backfill| {
            let (search, stop) = (search.clone(), backfill_cancel.clone());
            mixdog_rt::spawn("services.memory.session-search-backfill", TaskClass::Work, async move {
                tokio::select! {
                    () = stop.cancelled() => return,
                    () = wait(backfill.timer.as_ref(), BACKFILL_DELAY) => {}
                }
                if let Err(error) = search.backfill(backfill.stored.as_ref()).await {
                    tracing::warn!("session-search backfill failed: {}", error.message());
                }
            })
        });
        let reindex = Reindex::new();
        if embedder.is_some() {
            reindex.start(embed_flush.clone(), flags.secondary);
        }

        Ok(Self { cluster, flags, memory_db, search_db, memory, search, sensitive, runtime, embed_flush, reindex, transcripts, watcher, cycles, backfill: std::sync::Mutex::new(backfill), backfill_cancel })
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

    /// `_stopRuntime`: background installs end, the pools drain, then the postmaster stops
    /// (a secondary process leaves the shared one running).
    pub async fn stop(&self) -> Result<()> {
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
        if let Some(watcher) = &self.watcher {
            watcher.stop();
        }
        self.reindex.stop().await;
        if let Some(watcher) = &self.watcher {
            if let Err(error) = watcher.finished().await {
                tracing::warn!(%error, "[transcript-watch] shutdown");
            }
            self.transcripts.persist_transcript_offsets().await;
        }
        if let Some(runtime) = &self.runtime {
            runtime.shutdown();
        }
        if let Some(cycles) = &self.cycles {
            cycles.reset_in_flight();
        }
        self.memory_db.close();
        self.search_db.close();
        if self.flags.secondary {
            return Ok(());
        }
        self.cluster.stop(Duration::from_secs(STOP_SECONDS)).await
    }
}
