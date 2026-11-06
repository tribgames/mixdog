//! The memory maintenance cycles (`runtime/memory/lib/cycle-scheduler*`, `memory-cycle*`,
//! `cycle1/`, `memory-chunk-quality.mjs`): the 60-second tick that re-reads the memory config,
//! claims the scheduled cycle1 slot, runs the raw-row classifier and probes the backlog.
//!
//! The seams the composition fills are [`CycleConfig`] (the memory section, the recap switch,
//! the maintenance route), [`Cycle1Llm`] (the `cycle1-agent` dispatch) and [`CycleEmbeddings`]
//! (root and raw-row embedding, which the memory embedding owner provides).

pub mod ledger;
pub mod quality;
pub mod requests;
pub mod rows;
pub mod run;
pub mod scheduler;
pub mod signature;
pub mod window;

#[cfg(test)]
mod golden_tests;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

pub use scheduler::CycleScheduler;

/// What the cycles read of the product configuration, re-read on every use.
pub trait CycleConfig: Send + Sync + 'static {
    /// `readSection('memory')`.
    fn memory_section(&self) -> Value;
    /// `memoryCyclesEnabled()`: not secondary, not env-disabled, recap on.
    fn cycles_enabled(&self) -> bool;
    /// `resolveMaintenancePreset('memory')`.
    fn maintenance_preset(&self) -> Option<Value>;
}

/// One classifier call: `callAgentDispatch(request, prompt)` for the `cycle1-agent`.
#[derive(Clone, Debug)]
pub struct Cycle1Request {
    pub preset: Option<Value>,
    pub timeout_ms: f64,
}

#[async_trait]
pub trait Cycle1Llm: Send + Sync + 'static {
    /// The agent's reply text; an error is the dispatch failure's message.
    async fn call(&self, request: &Cycle1Request, cancel: &CancellationToken, prompt: &str) -> Result<String, String>;
}

/// The embedding work around a cycle (`memory-embed.mjs`).
#[async_trait]
pub trait CycleEmbeddings: Send + Sync + 'static {
    /// `flushEmbeddingDirty(db)`: embeds the roots whose embedding is missing.
    async fn flush_dirty(&self, cancel: &CancellationToken) -> Result<DirtyFlush, String>;
    /// `syncRootEmbedding(db, rootId)`.
    async fn sync_root(&self, root_id: i64, cancel: &CancellationToken) -> Result<(), String>;
    /// `flushRawEmbeddings(db, { limit })`: `(attempted, embedded)`.
    async fn flush_raw(&self, limit: usize) -> Result<(usize, usize), String>;
}

/// `flushEmbeddingDirty`'s report.
#[derive(Clone, Debug, Default)]
pub struct DirtyFlush {
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
}

pub(crate) fn log(message: &str) {
    tracing::info!("{}", message.trim_end_matches('\n'));
}
