//! Memory start (`runtime/memory/index.mjs` `_initStore` and `openDatabase`): the one
//! Postgres cluster, the `memory` and `session_search` schemas, and the pieces the session
//! layer holds (`LocalMemory` for the close-time ingest, `SessionSearchIngest` for the
//! per-turn search copy, the process's `SensitiveStore`), built once over them.
//!
//! The embedding model stays off the boot path, as in Node: the schema opens from the
//! model's profile dimensions and the model loads on demand (`MemoryRuntime`).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

use mixdog_rt::{DurabilityIo, MaintenanceIo, TaskClass};
use mixdog_workspace::watcher::FolderWatcher;

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
use crate::memory::session_search::db::SessionSearchDb;
use crate::memory::session_search::ingest::SessionSearchIngest;
use crate::memory::transcript::watcher::{TranscriptSink, TranscriptWatcher, start_transcript_watcher};
use crate::memory::transcript::{TranscriptIngest, TranscriptIo};
use crate::bots::delivery::env::RetryTimer;
use crate::model_install::ProgressSink;
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
    /// The one process manager `initdb` and `pg_ctl` run under.
    pub processes: Processes,
    /// Ends an `initdb` in progress (Node's init `signal`).
    pub cancel: CancellationToken,
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
}

impl MemoryStack {
    pub async fn start(boot: MemoryBoot) -> Result<Self> {
        let MemoryBoot { data_dir, pg_runtime, embedder, embedding_provider, flags, progress, sensitive, lane, maintenance, transcripts: watch, processes, cancel } = boot;
        let (model_id, dtype) = match &embedder {
            Some(provider) => (provider.model_id().to_owned(), provider.dtype().map(str::to_owned)),
            None => (DEFAULT_MODEL_ID.to_owned(), None),
        };
        // Node measures an unprofiled model's dimensions by loading it; the engine here only
        // loads profiled models, so their dimensions are the profile's.
        let dims = config::known_dims(&model_id)
            .ok_or_else(|| MemoryError::Embedding(format!("no dimensions known for model {model_id}")))?;
        let identity = config::identity(embedding_provider.as_deref(), &model_id, dtype.as_deref());

        let cluster = PgCluster::ensure(PgRuntime::new(pg_runtime), data_dir.join("pgdata"), DEFAULT_PORT, lane, processes, &cancel).await?;
        let memory_db = Db::open(&cluster, Schema::Memory).await?;
        ensure_memory_schema(&memory_db, dims, &identity).await?;
        // Root vectors made under the older root text are replaced by the paced sweep below;
        // an existing sweep keeps its progress.
        start_root_embed_sweep(&memory_db).await?;
        let search_db = Db::open(&cluster, Schema::SessionSearch).await?;
        let search = SessionSearchIngest::new(SessionSearchDb::open(search_db.clone()).await?, sensitive.clone());

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
        let memory = Arc::new(LocalMemory::new(memory_db.clone(), data_dir, recall, ingest, lane));

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
        let reindex = Reindex::new();
        if embedder.is_some() {
            reindex.start(embed_flush.clone(), flags.secondary);
        }

        let runtime = embedder.map(|provider| MemoryRuntime::new(provider, flags, progress));
        Ok(Self { cluster, flags, memory_db, search_db, memory, search, sensitive, runtime, embed_flush, reindex, transcripts, watcher })
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
        self.memory_db.close();
        self.search_db.close();
        if self.flags.secondary {
            return Ok(());
        }
        self.cluster.stop(Duration::from_secs(STOP_SECONDS)).await
    }
}
