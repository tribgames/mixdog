//! Shared plumbing for installing local ONNX models (the effort judge and the
//! embedding models): a streamed, size-checked download with byte progress,
//! sha256 of installed files on the CPU bulk lane, and atomic stamps. Downloads
//! have no wall-clock deadlines: bytes arriving drive the work, and the caller's
//! cancellation token ends it.

pub mod download;

use std::path::Path;
use std::sync::Arc;

use mixdog_rt::{CpuBulk, LaneToken};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub use download::{DownloadError, Spec, download_to_file, sha256_file};

/// Bytes received so far of one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub label: String,
    pub downloaded: u64,
    /// 0 when the size is unknown.
    pub total: u64,
}

pub type ProgressSink = Arc<dyn Fn(Progress) + Send + Sync>;

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("{0}")]
    Download(#[from] DownloadError),
    #[error("model manifest is invalid: {0}")]
    Manifest(String),
    #[error("{label}: sha256 mismatch (expected {expected}, got {actual})")]
    Hash { label: String, expected: String, actual: String },
    #[error("{0}")]
    Io(String),
    #[error("the model is not installed (expected in {0})")]
    NotInstalled(String),
    #[error("an install is already running")]
    Busy,
    #[error("cancelled")]
    Cancelled,
}

impl InstallError {
    pub fn io(error: impl std::fmt::Display) -> Self {
        Self::Io(error.to_string())
    }
}

/// Runs `job` on the CPU bulk lane. The job is cancelled when the returned
/// future is dropped.
pub async fn run_on_lane<R, F>(lane: CpuBulk, job: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    struct CancelOnDrop(CancellationToken);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }
    let token = CancellationToken::new();
    let _cancel = CancelOnDrop(token.clone());
    let handle = lane.submit(&token, move |_| job()).map_err(|e| e.to_string())?;
    handle.await.map_err(|_| "the lane job ended without an answer".to_owned())
}

/// Writes `bytes` to `path` through a sibling temp file, flushed to disk before the rename.
pub async fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    use tokio::io::AsyncWriteExt;
    let partial = path.with_extension(format!("{}.part", std::process::id()));
    let result = async {
        let mut file = tokio::fs::File::create(&partial).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&partial, path).await
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(InstallError::io(error));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod trigger_tests;
