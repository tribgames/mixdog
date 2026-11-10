//! When the memory runtime loads (and, if needed, installs) the embedding
//! model. Three triggers, as Node has them, gated by the same flags:
//!
//! - cold warmup when the memory runtime starts (`runtime/memory/index.mjs`);
//! - a prewarm when a session starts, so its first recall is not cold
//!   (`http-router/session-routes.mjs`), fire-and-forget;
//! - the built-in Install's awaited warmup: it loads the model, downloading it
//!   first when absent, and answers once ready, so an offline or failed fetch
//!   fails the Install instead of silently degrading the first recall.
//!
//! Node throttles the session-start prewarm with a 30 s cooldown. Here loading
//! happens once per provider and an install is serialised, so repeating the
//! prewarm costs nothing and needs no clock.

use std::sync::Arc;

use mixdog_rt::TaskClass;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory::embed::provider::EmbeddingProvider;
use crate::model_install::ProgressSink;
use crate::tool_state::onnx_runtime_supported;

/// `MIXDOG_MEMORY_SECONDARY` and `MIXDOG_EMBED_WARMUP`, read by the host.
#[derive(Debug, Clone, Copy)]
pub struct RuntimeFlags {
    /// Another process owns the model.
    pub secondary: bool,
    /// `MIXDOG_EMBED_WARMUP` (default true): gates the eager paths only.
    pub eager_warmup: bool,
}

impl Default for RuntimeFlags {
    fn default() -> Self {
        Self { secondary: false, eager_warmup: true }
    }
}

impl RuntimeFlags {
    /// The flags of a standalone start: `ensureStandaloneEnvironment` (`seeds.mjs:26`) does `MIXDOG_EMBED_WARMUP ??= '0'`, so an unset
    /// variable keeps the eager paths off (the model still loads on demand), while a set one is read by `envFlag(name, true)`
    /// (`memory-config-flags.mjs:36`): an empty or unrecognised value keeps the default `true`.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Self {
        let eager_warmup = env("MIXDOG_EMBED_WARMUP").is_some_and(|raw| match mixdog_js::js_trim(&raw).to_lowercase().as_str() {
            "0" | "false" | "off" | "no" => false,
            _ => true,
        });
        Self { eager_warmup, ..Self::default() }
    }

    /// `embeddingWarmupCanStart`: the eager paths.
    pub fn warmup_can_start(self) -> bool {
        onnx_runtime_supported() && self.eager_warmup && !self.secondary
    }

    /// `embeddingOnDemandCanStart`: a recall may load the model.
    pub fn on_demand_can_start(self) -> bool {
        onnx_runtime_supported() && !self.secondary
    }
}

/// The reply of the Install's warmup route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WarmupReply {
    Skipped(&'static str),
    Ready(bool),
}

impl WarmupReply {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Skipped(reason) => json!({ "ok": true, "skipped": reason }),
            Self::Ready(ready) => json!({ "ok": true, "ready": ready }),
        }
    }
}

pub struct MemoryRuntime {
    embedder: Arc<EmbeddingProvider>,
    flags: RuntimeFlags,
    progress: Option<ProgressSink>,
    /// Ends installs the runtime started in the background.
    cancel: CancellationToken,
}

impl MemoryRuntime {
    pub fn new(embedder: Arc<EmbeddingProvider>, flags: RuntimeFlags, progress: Option<ProgressSink>) -> Arc<Self> {
        Arc::new(Self { embedder, flags, progress, cancel: CancellationToken::new() })
    }

    pub fn flags(&self) -> RuntimeFlags {
        self.flags
    }

    pub fn embedder(&self) -> &Arc<EmbeddingProvider> {
        &self.embedder
    }

    /// Installs the model when it is absent, then loads it.
    async fn install_and_load(&self, cancel: &CancellationToken) -> Result<bool, String> {
        if !self.embedder.is_installed().await.map_err(|e| e.to_string())? {
            self.embedder.install(self.progress.as_ref(), cancel).await.map_err(|e| e.to_string())?;
        }
        Ok(self.embedder.warmup().await?.is_some())
    }

    /// Memory start: loads the model before the first recall. Errors are the
    /// caller's to report; recall still works on its text lanes.
    pub async fn cold_warmup(&self) -> Result<(), String> {
        if !self.flags.warmup_can_start() || self.embedder.is_ready() {
            return Ok(());
        }
        self.install_and_load(&self.cancel).await.map(|_| ())
    }

    /// A session started: warm the model for its first recall, in the
    /// background. Never throws and never waits.
    pub fn prewarm_recall(self: &Arc<Self>) {
        if self.flags.secondary || !self.flags.warmup_can_start() || self.embedder.is_ready() {
            return;
        }
        let this = self.clone();
        mixdog_rt::spawn("services.memory.prewarm", TaskClass::Work, async move {
            if let Err(error) = this.install_and_load(&this.cancel).await {
                tracing::warn!(%error, "memory: session-start embedding prewarm failed");
            }
        });
    }

    /// The built-in Install: awaited, and an explicit request, so the eager
    /// warmup flag does not gate it.
    pub async fn embedding_warmup(&self, cancel: &CancellationToken) -> Result<WarmupReply, String> {
        if !self.flags.on_demand_can_start() {
            return Ok(WarmupReply::Skipped(if onnx_runtime_supported() { "secondary mode" } else { "unsupported" }));
        }
        self.install_and_load(cancel).await?;
        Ok(WarmupReply::Ready(self.embedder.is_ready()))
    }

    /// Stops installs started in the background.
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}
