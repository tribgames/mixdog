//! The local-model state the `toolModules` settings section shows, computed the
//! way the Node product does (`onnxRuntimeSupported`, `getEmbeddingInfo`,
//! `effortJudgeInfo` / `effortJudgeReady` / `effortJudgeLastError`), plus the
//! change tick that tells the settings service to read it again.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::watch;

/// `onnxRuntimeSupported()`: onnxruntime ships no macOS Intel binding.
pub fn onnx_runtime_supported() -> bool {
    !(cfg!(target_os = "macos") && cfg!(target_arch = "x86_64"))
}

/// Ticks whenever embedder or judge state changes (load finished or failed,
/// install started or ended). Cheap to clone; every clone shares the counter.
#[derive(Clone)]
pub struct StateTick(Arc<watch::Sender<u64>>);

impl Default for StateTick {
    fn default() -> Self {
        Self(Arc::new(watch::channel(0).0))
    }
}

impl StateTick {
    pub fn bump(&self) {
        self.0.send_modify(|tick| *tick += 1);
    }

    /// The receiver `ToolModulesHost::changes` hands out.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }
}

/// What the settings card shows about the effort judge.
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeStatus {
    /// `effortJudgeAvailable()`: installed (files present, stamped).
    pub available: bool,
    /// `effortJudgeInstalling()`.
    pub installing: bool,
    /// `effortJudgeReady()`: the model is loaded.
    pub ready: bool,
    /// `effortJudgeLastError()`: `""` when it loaded or never failed.
    pub last_error: String,
    /// `effortJudgeInfo()`.
    pub info: Value,
}
