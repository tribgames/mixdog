//! Explicit installation is separate from inference: it prepares the model
//! files without creating an inference host.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::memory::embed::provider::EmbeddingProvider;
use crate::model_install::ProgressSink;
use crate::tool_state::onnx_runtime_supported;

#[derive(Debug, Clone, Copy, Default)]
pub struct RuntimeFlags {
    /// Another process owns the model.
    pub secondary: bool,
}

pub struct MemoryRuntime {
    embedder: Arc<EmbeddingProvider>,
    flags: RuntimeFlags,
    progress: Option<ProgressSink>,
}

impl MemoryRuntime {
    pub fn new(embedder: Arc<EmbeddingProvider>, flags: RuntimeFlags, progress: Option<ProgressSink>) -> Arc<Self> {
        Arc::new(Self { embedder, flags, progress })
    }

    /// Returns whether this process installed or already had the model files.
    pub async fn install_model(&self, cancel: &CancellationToken) -> Result<bool, String> {
        if self.flags.secondary || !onnx_runtime_supported() {
            return Ok(false);
        }
        self.embedder.install(self.progress.as_ref(), cancel).await.map_err(|e| e.to_string())?;
        Ok(true)
    }
}
