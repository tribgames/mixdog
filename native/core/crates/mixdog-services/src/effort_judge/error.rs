use thiserror::Error;

/// Why a judgment could not be made. Every variant answers the step "no
/// judgment": the step stays at the effort in force.
#[derive(Debug, Clone, Error)]
pub enum JudgeError {
    /// The model is not installed (files missing, empty or unstamped).
    #[error("effort judge model is not installed in {0}")]
    NotInstalled(String),
    #[error("effort judge load failed: {0}")]
    Load(String),
    /// The model was not trained on tool-result steps.
    #[error("effort judge does not support steps")]
    StepsUnsupported,
    #[error("effort judge run failed: {0}")]
    Run(String),
    /// The inference lane refused the job, or the job died before answering.
    #[error("effort judge worker unavailable: {0}")]
    Worker(String),
    /// The platform has no ONNX Runtime binding (macOS Intel).
    #[error("effort judge is unsupported on this platform")]
    Unsupported,
    /// A download or repair of the model is running; the step stays at the effort in force.
    #[error("effort judge model is being installed")]
    Installing,
    #[error("cancelled")]
    Cancelled,
}
