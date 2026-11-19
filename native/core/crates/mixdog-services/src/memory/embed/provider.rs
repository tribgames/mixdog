//! Explicit installation owns the model files. Only uncached vector work owns a running host.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use mixdog_js::{js_trim};
use serde_json::{Value, json};
use mixdog_rt::Gate;
use mixdog_rt::time::Instant;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::memory::embed::config::{self, InputType};
use crate::memory::embed::engine::{EmbedConfig, VectorCache};
use crate::memory::embed::host::{Embedder, Lifecycle};
use crate::model_host::WaitError;
use crate::memory::embed::{compress, install};
use crate::model_install::{InstallError, ProgressSink};
use crate::tool_state::{StateTick, onnx_runtime_supported};

type Loaded = Arc<OnceCell<Result<Embedder, String>>>;
type Load = Arc<dyn Fn(EmbedConfig) -> Pin<Box<dyn Future<Output = Result<Embedder, String>> + Send>> + Send + Sync>;

pub(in crate::memory) struct Demand(Arc<EmbeddingProvider>);

impl Drop for Demand {
    fn drop(&mut self) {
        let provider = &self.0;
        let mut count = locked(&provider.demand);
        *count -= 1;
        if *count != 0 {
            return;
        }
        // Keep the generation until reaped. The next demand must not reuse a stopping
        // host, and a failed host must still go through restart accounting.
        let loaded = locked(&provider.loaded);
        if let Some(Ok(model)) = loaded.get()
            && model.alive()
        {
            // We recovered and drained real demand on a live host. Its intentional
            // exit must not make the next cold start pay for the old failure.
            locked(&provider.restarts).count = 0;
            model.retire();
            provider.tick.bump();
        }
    }
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `MAX_RESTART_BACKOFF_MS`.
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(30);

/// Node's `_restartCount` / `_lastRestartMs` (`ensureWorker`): a host that died or timed out makes the next launch wait `1 s * 2^(n-1)`, at most 30 s, since the last launch.
#[derive(Default)]
struct Restarts {
    count: u32,
    last_launch: Option<Instant>,
    /// A launch this provider admitted is still loading: a caller joining it is not a launch.
    loading: bool,
    /// The last host generation whose end was accounted.
    accounted: Option<u64>,
    /// Ends and failed loads accounted so far (a test's count).
    #[cfg(test)]
    accountings: u32,
}

impl Restarts {
    /// Node's `exit` handler (`embedding-provider.mjs:143-151`; the timeout's kill, `:190`, ends in a non-zero exit too): a host nobody retired that
    /// exited with status 0 resets the count; a non-zero exit, a signal or a failed wait adds one; a retired host's end changes nothing. Each
    /// generation is consumed once. A successful request changes nothing.
    fn ended(&mut self, generation: u64, exit: &Result<std::process::ExitStatus, WaitError>, retired: bool) {
        if self.accounted == Some(generation) {
            return;
        }
        self.accounted = Some(generation);
        #[cfg(test)]
        {
            self.accountings += 1;
        }
        if retired {
            return;
        }
        match exit {
            Ok(status) if status.success() => self.count = 0,
            _ => self.count += 1,
        }
    }

    fn failed_load(&mut self) {
        #[cfg(test)]
        {
            self.accountings += 1;
        }
        self.count += 1;
    }

    /// Admits a launch at `now`, or says how long the backoff has left.
    fn admit(&mut self, now: Instant) -> Result<(), Duration> {
        if self.loading {
            return Ok(());
        }
        if self.count > 0 {
            let backoff = Duration::from_secs(1u64 << (self.count - 1).min(5)).min(MAX_RESTART_BACKOFF);
            let elapsed = self.last_launch.map_or(backoff, |at| now.saturating_duration_since(at));
            if elapsed < backoff {
                return Err(backoff - elapsed);
            }
        }
        self.last_launch = Some(now);
        self.loading = true;
        Ok(())
    }
}

/// Empties the cell, retiring the host it held: the host's end is the owner's choice (Node excludes retiring workers from the restart count), and
/// its later `Ended` is never read by a warmup, which only reads the cell's current host.
#[cfg(test)]
fn retire_cell(cell: &mut Loaded) {
    if let Some(Ok(model)) = cell.get() {
        model.retire();
    }
    *cell = Loaded::default();
}

pub struct EmbeddingProvider {
    config: EmbedConfig,
    hub: String,
    /// The load, shared by every caller; a failure is retried on the next request. Shared with the task that runs
    /// it, so a recall that stops waiting does not end it; a dispose puts a fresh cell in its place.
    loaded: std::sync::Mutex<Loaded>,
    demand: std::sync::Mutex<usize>,
    query_cache: std::sync::Mutex<VectorCache>,
    measured_dims: std::sync::atomic::AtomicUsize,
    restarts: std::sync::Mutex<Restarts>,
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

fn info_of(model: &str, dtype: Option<&str>, dimensions: Option<usize>, device: &str) -> Value {
    json!({
        "model": model,
        "dtype": config::normalize_dtype(model, dtype),
        "dimensions": dimensions,
        "device": device,
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
mod install_tests {
    use super::*;

    /// A watcher woken by the last tick of an install reads it as over: that tick comes after the gate is free
    /// (the two ticks around the download are bumped while it is held).
    #[tokio::test]
    async fn an_install_ends_with_a_tick_after_the_gate_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let provider = EmbeddingProvider::installed_with_load(dir.path(), || Box::pin(async { Err("no model".to_owned()) }));
        let mut ticks = provider.tick().subscribe();
        let before = *ticks.borrow_and_update();
        assert!(!provider.is_installing());
        provider.install(None, &CancellationToken::new()).await.unwrap();
        assert!(!provider.is_installing());
        assert_eq!(*ticks.borrow_and_update(), before + 3, "a tick before and after the download, and one once the gate is free");
    }
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
            loaded: std::sync::Mutex::default(),
            demand: std::sync::Mutex::new(0),
            query_cache: std::sync::Mutex::default(),
            measured_dims: std::sync::atomic::AtomicUsize::new(0),
            restarts: std::sync::Mutex::default(),
            compress_started: Arc::default(),
            load: Arc::new(|config| Box::pin(async move { Embedder::load(config).await.map_err(|e| e.message()) })),
            installing: Gate::new(),
            tick,
            compact: None,
        }
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
        let device = current.get().and_then(|m| m.as_ref().ok()).filter(|m| m.alive()).map_or("", Embedder::device);
        let measured = self.measured_dims.load(std::sync::atomic::Ordering::Acquire);
        let dims = (measured != 0).then_some(measured).or_else(|| config::known_dims(model));
        info_of(model, self.config.dtype.as_deref(), dims, device)
    }

    /// An install is running or waiting for its turn.
    pub fn is_installing(&self) -> bool {
        self.installing.is_busy()
    }

    /// `getEmbeddingInfo()` on a host with no ONNX runtime to build a provider over: Node answers the same metadata there
    /// (nothing loaded, `supported` true wherever onnxruntime ships a binding), where the provider does not exist.
    pub fn info_unbuilt(model_id: &str, dtype: Option<&str>) -> Value {
        let model = js_trim(model_id);
        info_of(model, dtype, config::known_dims(model), "")
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
        matches!(self.current().get(), Some(Ok(model)) if model.alive())
    }

    /// The current load's cell.
    fn current(&self) -> Loaded {
        self.loaded.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// The worker's `dispose`: the loaded model (or the remembered failure) is released, so the next
    /// warmup loads again.
    #[cfg(test)]
    pub(crate) fn dispose(&self) {
        retire_cell(&mut locked(&self.loaded));
        self.tick.bump();
    }

    /// Loads the model, once however many callers ask. `Ok(None)` when it is
    /// not installed; `Err` is this host's load failure.
    ///
    /// The host's end is read from its lifecycle (Rule B): a `Stopping` host (its output closed, a write failed, a kill was asked) is not classified;
    /// the call waits for the reaper's `Ended` outside the provider's lock and reads the cell again. The end of the host the cell holds is
    /// accounted once, under the cell's lock, with the cell's replacement: a later end of an older host never touches the cell's replacement.
    pub(crate) async fn warmup(&self) -> Result<Option<Embedder>, String> {
        loop {
            let stopping = {
                let mut cell = locked(&self.loaded);
                match cell.get() {
                    None => break,
                    // A failed load counts once (Node's failed spawn, `embedding-provider.mjs:141`); the next request retries it, never in-process.
                    Some(Err(_)) => {
                        *cell = Loaded::default();
                        locked(&self.restarts).failed_load();
                        break;
                    }
                    Some(Ok(model)) => match model.lifecycle() {
                        Lifecycle::Running => return Ok(Some(model.clone())),
                        Lifecycle::Stopping => model.clone(),
                        Lifecycle::Ended { generation, exit, retired } => {
                            locked(&self.restarts).ended(generation, &exit, retired);
                            *cell = Loaded::default();
                            break;
                        }
                    },
                }
            };
            drop(stopping.ended().await);
        }
        if !self.is_installed().await.map_err(|e| e.to_string())? {
            return Ok(None);
        }
        let admitted = locked(&self.restarts).admit(Instant::now());
        if let Err(remaining) = admitted {
            return Err(format!("embed worker in restart backoff ({}s remaining)", remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0)));
        }
        struct Launched<'a>(&'a std::sync::Mutex<Restarts>);
        impl Drop for Launched<'_> {
            fn drop(&mut self) {
                locked(self.0).loading = false;
            }
        }
        let _launched = Launched(&self.restarts);
        self.load_future().await.map(Some)
    }

    #[cfg(test)]
    pub(crate) fn set_restart_count(&self, count: u32) {
        locked(&self.restarts).count = count;
    }

    #[cfg(test)]
    pub(crate) fn restart_count(&self) -> u32 {
        locked(&self.restarts).count
    }

    /// The generation of the host the cell holds, if it holds one.
    #[cfg(test)]
    pub(crate) fn held_generation(&self) -> Option<u64> {
        match self.current().get() {
            Some(Ok(model)) => Some(model.generation()),
            _ => None,
        }
    }

    /// Host ends and failed loads accounted so far.
    #[cfg(test)]
    pub(crate) fn accountings(&self) -> u32 {
        locked(&self.restarts).accountings
    }

    /// The last launch is now, so a test does not depend on how long its host took to die.
    #[cfg(test)]
    pub(crate) fn stamp_launch_now(&self) {
        locked(&self.restarts).last_launch = Some(Instant::now());
    }

    /// Moves the last launch `by` into the past: the backoff has run that much longer (a test's clock).
    #[cfg(test)]
    pub(crate) fn backdate_launch(&self, by: Duration) {
        let mut restarts = locked(&self.restarts);
        restarts.last_launch = restarts.last_launch.and_then(|at| at.checked_sub(by));
    }

    /// The shared load, as an owned future a task can run to its end.
    fn load_future(&self) -> impl Future<Output = Result<Embedder, String>> + Send + 'static {
        let loaded = self.current();
        let (load, config, tick, compact) = (self.load.clone(), self.config.clone(), self.tick.clone(), self.compact.clone());
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

    /// Query cache entries outlive the child, but never own it.
    pub async fn embed_query(self: &Arc<Self>, text: &str) -> Result<Option<Vec<f32>>, String> {
        self.admit_query(text).1.await
    }

    pub(crate) fn admit_query(
        self: &Arc<Self>,
        text: &str,
    ) -> (bool, futures::future::BoxFuture<'static, Result<Option<Vec<f32>>, String>>) {
        let key = config::prepare_input(text, InputType::Query, self.model_id());
        if key.is_empty() {
            return (false, Box::pin(async { Ok(None) }));
        }
        if let Some(vector) = locked(&self.query_cache).get(&key) {
            return (false, Box::pin(async move { Ok(Some(vector.to_vec())) }));
        }
        let (demand, ready) = {
            // Retirement uses these same locks in the same order. A warm
            // admission uses this exact host; it cannot silently cold-start.
            let mut count = locked(&self.demand);
            let loaded = locked(&self.loaded);
            let ready = loaded.get().and_then(|outcome| outcome.as_ref().ok()).filter(|model| model.alive()).cloned();
            *count += 1;
            (Demand(self.clone()), ready)
        };
        let cold = ready.is_none();
        let text = text.to_owned();
        (cold, Box::pin(async move {
            let vectors = Self::compute(demand, ready, vec![text], InputType::Query, Some(key)).await?;
            Ok(vectors.into_iter().next().map(|v| v.to_vec()))
        }))
    }

    pub(in crate::memory) fn document_demand(self: &Arc<Self>) -> Demand {
        *locked(&self.demand) += 1;
        Demand(self.clone())
    }

    pub(crate) async fn embed_documents(self: &Arc<Self>, texts: Vec<String>) -> Result<Vec<Arc<Vec<f32>>>, String> {
        if texts.iter().all(|text| js_trim(text).is_empty()) {
            return Ok(texts.iter().map(|_| Arc::new(Vec::new())).collect());
        }
        Self::compute(self.document_demand(), None, texts, InputType::Document, None).await
    }

    async fn compute(demand: Demand, ready: Option<Embedder>, texts: Vec<String>, kind: InputType, query_key: Option<String>) -> Result<Vec<Arc<Vec<f32>>>, String> {
        // Admit before spawning so overlapping requests count even while queued. A caller
        // dropping its wait cannot retire a child with a pipe exchange still in flight.
        let result = mixdog_rt::spawn("embedding-demand", mixdog_rt::TaskClass::Work, async move {
            let provider = &demand.0;
            let model = match match ready {
                Some(model) => Some(model),
                None => provider.warmup().await?,
            } {
                Some(model) => model,
                None if query_key.is_some() => return Ok(Vec::new()),
                None => return Err("embedding model is not installed".to_owned()),
            };
            let vectors = model.embed_batch(&texts, kind).await.map_err(|e| e.message())?;
            if let Some(vector) = vectors.iter().find(|v| !v.is_empty()) {
                provider.measured_dims.store(vector.len(), std::sync::atomic::Ordering::Release);
                if let Some(key) = query_key {
                    locked(&provider.query_cache).insert(key, vector.clone());
                }
            }
            // Explicit drop keeps the admission alive through the last exchange.
            drop(demand);
            Ok(vectors)
        }).await;
        match result {
            Ok(outcome) => outcome,
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Downloads whatever is missing or damaged, reporting bytes as they
    /// arrive. A model that is already loaded keeps its files. Needs no timer:
    /// bytes arriving drive it, and `cancel` ends it.
    pub async fn install(&self, progress: Option<&ProgressSink>, cancel: &CancellationToken) -> Result<(), InstallError> {
        let outcome = self
            .installing
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
            .map_err(|_| InstallError::Cancelled);
        // The gate is free now: a watcher woken by this tick reads `is_installing` as false (the tick inside the run is bumped while it is held).
        self.tick.bump();
        outcome?
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
        Self::installed_model_with_load(cache, config::DEFAULT_MODEL_ID, load)
    }

    pub(crate) fn installed_model_with_load(
        cache: &std::path::Path,
        model_id: &str,
        load: impl Fn() -> Pin<Box<dyn Future<Output = Result<Embedder, String>> + Send>> + Send + Sync + 'static,
    ) -> Self {
        let config = EmbedConfig {
            model_id: model_id.to_owned(),
            cache_dir: cache.to_path_buf(),
            ort_library: std::path::PathBuf::new(),
            dtype: None,
            sessions: 1,
            lane: mixdog_rt::testing::tokens().cpu_bulk,
        };
        let graph = install::required_files(&config).graph;
        for (file, body) in [("tokenizer.json", "{}"), ("tokenizer_config.json", "{}"), (graph.as_str(), "graph")] {
            let path = install::model_path(&config.cache_dir, model_id, file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
        let mut provider = Self::new(config);
        provider.load = Arc::new(move |_| load());
        provider
    }
}
