//! The embedding model as recall sees it. Three defined states give a vector or none:
//!
//! - ready: the query is embedded; a recall that finds the model cold warms it
//!   within its bounded wait (`recall/readiness.rs` `RecallEmbedder`, the one
//!   cold wait), then runs on its text lanes while the load goes on;
//! - not installed: no vector, so the recall runs on its text lanes. Installing
//!   is a separate, progress-driven step ([`EmbeddingProvider::install`]) the
//!   host starts; a recall never waits for a download;
//! - failed: the load failed; the failure is remembered for this instance (a
//!   new instance, after an install or repair, is the retry) and recall runs on
//!   its text lanes.
//!
//! A loaded model is released after an idle window (`IDLE_TIMEOUT`, the worker's idle dispose): a
//! disposed model costs a reload, so the window is long, and a backlog being worked holds it warm
//! ([`EmbeddingProvider::hold_warm`]).

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use mixdog_js::{js_trim};
use serde_json::{Value, json};
use mixdog_rt::Gate;
use mixdog_rt::time::Instant;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::memory::embed::config;
use crate::memory::embed::engine::{EmbedConfig, Embedder};
use crate::memory::embed::{compress, install};
use crate::model_install::{InstallError, ProgressSink};
use crate::tool_state::{StateTick, onnx_runtime_supported};

/// The worker's `IDLE_TIMEOUT_MS`: 5 minutes.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// `EMBED_KEEP_WARM_MS`: how long a backlog being worked keeps the model resident.
pub const KEEP_WARM: Duration = Duration::from_secs(6 * 60);

type Loaded = Arc<OnceCell<Result<Embedder, String>>>;
type Load = Arc<dyn Fn(EmbedConfig) -> Pin<Box<dyn Future<Output = Result<Embedder, String>> + Send>> + Send + Sync>;

/// When the model was last asked for, and until when a backlog keeps it warm (`createIdleLease`).
struct Usage {
    last_use: std::sync::Mutex<Instant>,
    warm_until: std::sync::Mutex<Option<Instant>>,
    /// A release timer is running.
    armed: AtomicBool,
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Releases the model once it has not been asked for during `idle` and no backlog holds it warm. A
/// lease that is still held re-arms a full window; the timer ends with the provider.
async fn release_when_idle(loaded: Weak<std::sync::Mutex<Loaded>>, usage: Arc<Usage>, idle: Duration, tick: StateTick) {
    loop {
        let seen = *locked(&usage.last_use);
        mixdog_rt::time::sleep_until_unrefed(seen + idle).await;
        let Some(loaded) = loaded.upgrade() else { return };
        let now = Instant::now();
        let last = *locked(&usage.last_use);
        if locked(&usage.warm_until).is_some_and(|until| now < until) {
            *locked(&usage.last_use) = now;
            continue;
        }
        if now < last + idle {
            continue;
        }
        usage.armed.store(false, Ordering::Release);
        *locked(&loaded) = Loaded::default();
        tick.bump();
        // Asked for while it was released: the new load needs its own timer.
        if *locked(&usage.last_use) > last && !usage.armed.swap(true, Ordering::AcqRel) {
            continue;
        }
        return;
    }
}

pub struct EmbeddingProvider {
    config: EmbedConfig,
    hub: String,
    /// The load, shared by every caller; a failure stays until a dispose. Shared with the task that runs
    /// it, so a recall that stops waiting does not end it; a dispose puts a fresh cell in its place.
    loaded: Arc<std::sync::Mutex<Loaded>>,
    usage: Arc<Usage>,
    /// The idle window; zero never releases (`MIXDOG_EMBED_IDLE_TIMEOUT_MS=0`).
    idle: Duration,
    /// The worker's `modelCacheCompressionStarted`: one compression per provider, a reload after a
    /// dispose included.
    compress_started: Arc<std::sync::atomic::AtomicBool>,
    load: Load,
    /// Installs run one at a time; `cancel` ends both the wait and a stuck install.
    installing: Gate,
    tick: StateTick,
    /// Runs `compact.exe` after the first successful load (Windows only).
    compact: Option<compress::Compact>,
}

impl EmbeddingProvider {
    pub fn new(config: EmbedConfig) -> Self {
        Self::with_tick(config, StateTick::default())
    }

    /// `tick` is bumped whenever `info()` may have changed.
    pub fn with_tick(config: EmbedConfig, tick: StateTick) -> Self {
        Self {
            config,
            hub: install::HUB.to_owned(),
            loaded: Arc::default(),
            usage: Arc::new(Usage { last_use: std::sync::Mutex::new(Instant::now()), warm_until: std::sync::Mutex::new(None), armed: AtomicBool::new(false) }),
            idle: IDLE_TIMEOUT,
            compress_started: Arc::default(),
            load: Arc::new(|config| Box::pin(async move { Embedder::load(config).await.map_err(|e| e.message()) })),
            installing: Gate::new(),
            tick,
            compact: None,
        }
    }

    /// Releases the model after `idle` without use instead of [`IDLE_TIMEOUT`]; zero never releases.
    pub fn with_idle_timeout(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    /// Compress the model cache with `compact` once the model first loads.
    pub fn with_compaction(mut self, compact: compress::Compact) -> Self {
        self.compact = Some(compact);
        self
    }

    /// `getEmbeddingInfo()`: metadata only, never loads the model.
    pub fn info(&self) -> Value {
        let model = js_trim(&self.config.model_id);
        // `cachedDims || getKnownDimsForCurrentModel()`: the measured value once loaded.
        let current = self.current();
        let dims = match current.get() {
            Some(Ok(embedder)) => Some(embedder.dims()),
            _ => config::known_dims(model),
        };
        info_of(model, self.config.dtype.as_deref(), dims, self.is_ready())
    }

    /// `getEmbeddingInfo()` on a host with no ONNX runtime to build a provider over: Node answers the same metadata there
    /// (nothing loaded, `supported` true wherever onnxruntime ships a binding), where the provider does not exist.
    pub fn info_unbuilt(model_id: &str, dtype: Option<&str>) -> Value {
        let model = js_trim(model_id);
        info_of(model, dtype, config::known_dims(model), false)
    }
    /// `getEmbeddingModelId()`.
    pub fn model_id(&self) -> &str {
        &self.config.model_id
    }

    /// The configured dtype (`None` = the model's default), as `config::identity` takes it.
    pub fn dtype(&self) -> Option<&str> {
        self.config.dtype.as_deref()
    }

    /// Fetch models from another host (tests).
    pub fn with_hub(mut self, hub: impl Into<String>) -> Self {
        self.hub = hub.into();
        self
    }

    /// Whether the model files are present and undamaged, read on the config's lane.
    pub async fn is_installed(&self) -> Result<bool, InstallError> {
        Ok(install::missing_on(&self.config).await?.is_none())
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.current().get(), Some(Ok(_)))
    }

    /// The current load's cell.
    fn current(&self) -> Loaded {
        self.loaded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// A backlog is being worked: the model stays resident for [`KEEP_WARM`] more (it expires on its own,
    /// so a stopped backlog never pins the model).
    pub fn hold_warm(&self) {
        let until = Instant::now() + KEEP_WARM;
        let mut warm = locked(&self.usage.warm_until);
        *warm = Some(warm.map_or(until, |held| held.max(until)));
    }

    /// The model was just asked for: the idle window restarts, and the release timer runs.
    fn touched(&self) {
        if self.idle.is_zero() {
            return;
        }
        *locked(&self.usage.last_use) = Instant::now();
        if !self.usage.armed.swap(true, Ordering::AcqRel) {
            let (loaded, usage, idle, tick) = (Arc::downgrade(&self.loaded), self.usage.clone(), self.idle, self.tick.clone());
            tokio::spawn(release_when_idle(loaded, usage, idle, tick));
        }
    }

    /// The worker's `dispose`: the loaded model (or the remembered failure) is released, so the next
    /// warmup loads again.
    pub fn dispose(&self) {
        *self.loaded.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Loaded::default();
        self.tick.bump();
    }

    /// Loads the model, once however many callers ask. `Ok(None)` when it is
    /// not installed; `Err` is the remembered load failure.
    pub async fn warmup(&self) -> Result<Option<Embedder>, String> {
        self.touched();
        if let Some(loaded) = self.current().get() {
            return loaded.clone().map(Some);
        }
        if !self.is_installed().await.map_err(|e| e.to_string())? {
            return Ok(None);
        }
        self.load_future().await.map(Some)
    }

    /// The shared load, as an owned future a task can run to its end.
    fn load_future(&self) -> impl Future<Output = Result<Embedder, String>> + Send + 'static {
        let (loaded, load, config, tick, compact) = (self.current(), self.load.clone(), self.config.clone(), self.tick.clone(), self.compact.clone());
        let started = self.compress_started.clone();
        async move {
            loaded
                .get_or_init(|| async move {
                    let outcome = load(config.clone()).await;
                    tick.bump();
                    if let (Ok(_), Some(compact)) = (&outcome, compact)
                        && !started.swap(true, std::sync::atomic::Ordering::AcqRel)
                    {
                        mixdog_rt::spawn("embedding-model-compress", mixdog_rt::TaskClass::Work, async move {
                            match compress::compress_model_cache(cfg!(windows), config.lane, &config.cache_dir, js_trim(&config.model_id), &compact).await {
                                Ok(Some(dir)) => tracing::info!("[embed-worker] model cache LZX compressed: {}", dir.display()),
                                Ok(None) => {}
                                Err(error) => tracing::info!("[embed-worker] model cache LZX compression skipped: {error}"),
                            }
                        });
                    }
                    outcome
                })
                .await
                .clone()
        }
    }

    /// Downloads whatever is missing or damaged, reporting bytes as they
    /// arrive. A model that is already loaded keeps its files. Needs no timer:
    /// bytes arriving drive it, and `cancel` ends it.
    pub async fn install(&self, progress: Option<&ProgressSink>, cancel: &CancellationToken) -> Result<(), InstallError> {
        self.installing
            .run(cancel, async {
                if self.is_ready() {
                    return Ok(());
                }
                self.tick.bump();
                let outcome = install::install(&self.config, &self.hub, progress, cancel).await;
                self.tick.bump();
                outcome
            })
            .await
            .map_err(|_| InstallError::Cancelled)?
    }

    /// The change tick this provider bumps.
    pub fn tick(&self) -> &StateTick {
        &self.tick
    }
}

#[cfg(test)]
impl EmbeddingProvider {
    /// A provider over `cache` whose model files are present and whose load is `load`: the embedding worker the
    /// recordings script (`record-memory-cold-recall.mjs`).
    pub(crate) fn installed_with_load(
        cache: &std::path::Path,
        load: impl Fn() -> Pin<Box<dyn Future<Output = Result<Embedder, String>> + Send>> + Send + Sync + 'static,
    ) -> Self {
        let config = EmbedConfig {
            model_id: config::DEFAULT_MODEL_ID.to_owned(),
            cache_dir: cache.to_path_buf(),
            ort_library: std::path::PathBuf::new(),
            dtype: None,
            sessions: 1,
            lane: mixdog_rt::testing::tokens().cpu_bulk,
        };
        let graph = install::required_files(&config).graph;
        for (file, body) in [("tokenizer.json", "{}"), ("tokenizer_config.json", "{}"), (graph.as_str(), "graph")] {
            let path = install::model_path(&config.cache_dir, config::DEFAULT_MODEL_ID, file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let mut provider = Self::new(config);
        provider.load = Arc::new(move |_| load());
        provider
    }
}

fn info_of(model: &str, dtype: Option<&str>, dimensions: Option<usize>, ready: bool) -> Value {
    json!({
        "model": model,
        "dtype": config::normalize_dtype(model, dtype),
        "dimensions": dimensions,
        "device": if ready { "cpu" } else { "" },
        "engine": "Transformers.js · ONNX Runtime",
        "supported": onnx_runtime_supported(),
    })
}

#[cfg(test)]
mod unbuilt_tests {
    use super::*;

    /// What Node's `getEmbeddingInfo()` answered for the default model before anything loaded (recorded by the capability
    /// harness: `getToolModuleSettings` `memory.info`).
    #[test]
    fn a_host_without_the_runtime_reports_the_metadata_node_does() {
        let info = EmbeddingProvider::info_unbuilt(config::DEFAULT_MODEL_ID, None);
        assert_eq!(info["model"], config::DEFAULT_MODEL_ID);
        assert_eq!((info["dtype"].as_str(), info["dimensions"].as_u64(), info["device"].as_str()), (Some("q8"), Some(384), Some("")));
        assert_eq!(info["engine"], "Transformers.js · ONNX Runtime");
        // Node recorded supported: true on win32/x64 (onnxRuntimeSupported(): only macOS Intel has no binding).
        assert_eq!(info["supported"], !(cfg!(target_os = "macos") && cfg!(target_arch = "x86_64")));
    }
}
#[cfg(test)]
mod idle_tests {
    use super::*;

    fn failing(dir: &std::path::Path, idle: Duration) -> EmbeddingProvider {
        EmbeddingProvider::installed_with_load(dir, || Box::pin(async { Err("no model in this test".to_owned()) })).with_idle_timeout(idle)
    }

    async fn settled(provider: &EmbeddingProvider) -> bool {
        for _ in 0..100 {
            if provider.current().get().is_none() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    #[tokio::test]
    async fn an_idle_model_is_released_and_the_next_use_loads_again() {
        let dir = tempfile::tempdir().unwrap();
        let provider = failing(dir.path(), Duration::from_millis(40));
        assert!(provider.warmup().await.is_err());
        assert!(provider.current().get().is_some());
        assert!(settled(&provider).await, "the idle model was not released");
        assert!(provider.warmup().await.is_err());
        assert!(provider.current().get().is_some(), "the next use loads again");
    }

    #[tokio::test]
    async fn a_backlog_holds_the_model_and_a_zero_window_never_releases() {
        let dir = tempfile::tempdir().unwrap();
        let held = failing(dir.path(), Duration::from_millis(30));
        assert!(held.warmup().await.is_err());
        held.hold_warm();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(held.current().get().is_some(), "a held model is released");
        let never = failing(dir.path(), Duration::ZERO);
        assert!(never.warmup().await.is_err());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(never.current().get().is_some());
    }
}
