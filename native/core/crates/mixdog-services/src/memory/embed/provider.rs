//! The embedding model as recall sees it. A recall waits for the model's
//! real readiness: the load it needs completes or fails, and nothing here
//! counts time. Three defined states give a vector or none:
//!
//! - ready: the query is embedded;
//! - not installed: no vector, so the recall runs on its text lanes. Installing
//!   is a separate, progress-driven step ([`EmbeddingProvider::install`]) the
//!   host starts; a recall never waits for a download;
//! - failed: the load failed; the failure is remembered for this instance (a
//!   new instance, after an install or repair, is the retry) and recall runs on
//!   its text lanes.

use mixdog_js::{js_trim};
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

use crate::memory::embed::config::{self, InputType};
use crate::memory::embed::engine::{EmbedConfig, Embedder};
use crate::memory::embed::install;
use crate::memory::recall::QueryEmbedder;
use crate::model_install::{InstallError, ProgressSink};
use crate::tool_state::{StateTick, onnx_runtime_supported};

pub struct EmbeddingProvider {
    config: EmbedConfig,
    hub: String,
    /// The load, shared by every caller; a failure stays.
    loaded: OnceCell<Result<Embedder, String>>,
    installing: Mutex<()>,
    tick: StateTick,
}

impl EmbeddingProvider {
    pub fn new(config: EmbedConfig) -> Self {
        Self::with_tick(config, StateTick::default())
    }

    /// `tick` is bumped whenever `info()` may have changed.
    pub fn with_tick(config: EmbedConfig, tick: StateTick) -> Self {
        Self { config, hub: install::HUB.to_owned(), loaded: OnceCell::new(), installing: Mutex::new(()), tick }
    }

    /// `getEmbeddingInfo()`: metadata only, never loads the model.
    pub fn info(&self) -> Value {
        let model = js_trim(&self.config.model_id);
        let ready = self.is_ready();
        json!({
            "model": model,
            "dtype": config::normalize_dtype(model, self.config.dtype.as_deref()),
            "dimensions": config::known_dims(model),
            "device": if ready { "cpu" } else { "" },
            "engine": "Transformers.js · ONNX Runtime",
            "supported": onnx_runtime_supported(),
        })
    }

    /// Fetch models from another host (tests).
    pub fn with_hub(mut self, hub: impl Into<String>) -> Self {
        self.hub = hub.into();
        self
    }

    pub fn is_installed(&self) -> bool {
        install::installed(&self.config)
    }

    pub fn is_ready(&self) -> bool {
        matches!(self.loaded.get(), Some(Ok(_)))
    }

    /// Loads the model, once however many callers ask. `Ok(None)` when it is
    /// not installed; `Err` is the remembered load failure.
    pub async fn warmup(&self) -> Result<Option<Embedder>, String> {
        if let Some(loaded) = self.loaded.get() {
            return loaded.clone().map(Some);
        }
        if !self.is_installed() {
            return Ok(None);
        }
        let config = self.config.clone();
        let tick = self.tick.clone();
        self.loaded
            .get_or_init(|| async move {
                let outcome = Embedder::load(config).await.map_err(|e| e.message());
                tick.bump();
                outcome
            })
            .await
            .clone()
            .map(Some)
    }

    /// Downloads whatever is missing or damaged, reporting bytes as they
    /// arrive. A model that is already loaded keeps its files. Needs no timer:
    /// bytes arriving drive it, and `cancel` ends it.
    pub async fn install(&self, progress: Option<&ProgressSink>, cancel: &CancellationToken) -> Result<(), InstallError> {
        let _one_at_a_time = self.installing.lock().await;
        if self.is_ready() {
            return Ok(());
        }
        self.tick.bump();
        let outcome = install::install(&self.config, &self.hub, progress, cancel).await;
        self.tick.bump();
        outcome
    }

    /// The change tick this provider bumps.
    pub fn tick(&self) -> &StateTick {
        &self.tick
    }
}

#[async_trait]
impl QueryEmbedder for EmbeddingProvider {
    async fn query_vector(&self, text: &str) -> Option<Vec<f32>> {
        let embedder = self.warmup().await.ok().flatten()?;
        let vector = embedder.embed(text, InputType::Query).await.ok()?;
        (!vector.is_empty()).then(|| vector.to_vec())
    }
}
