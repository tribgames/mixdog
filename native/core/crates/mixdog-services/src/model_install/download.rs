//! Streamed file download: the response is written to a partial file, counted
//! against a byte limit and an expected size, flushed to disk and reported as
//! progress. A 4xx answer is terminal; any other failure is retried a few
//! times at once by [`download_to_file`] (the model install). A caller that needs Node's
//! timed schedule (the Postgres runtime's 180 s attempts and 1 s / 3 s / 9 s waits) runs
//! [`download_once`] under its own loop.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use mixdog_ai::netproxy::clients::RoutedClients;
use mixdog_rt::CpuBulk;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::model_install::fsio::{self, LaneWriter};
use crate::model_install::{Progress, ProgressSink, run_on_lane};

const RETRIES: usize = 3;
const MIN_PROGRESS_STEP: u64 = 64 * 1024;

#[derive(Debug, Clone, Error)]
pub enum DownloadError {
    #[error("{label} HTTP {status}{note} — {url}")]
    Http { status: u16, label: String, url: String, note: &'static str },
    #[error("{0}")]
    Size(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Io(String),
    #[error("cancelled")]
    Cancelled,
}

impl DownloadError {
    /// A 4xx answer or a cancel: retrying cannot change it.
    pub fn is_terminal(&self) -> bool {
        match self {
            Self::Http { status, .. } => (400..500).contains(status),
            Self::Cancelled => true,
            _ => false,
        }
    }
}

/// The daemon's routed clients: every download follows the network proxy setting and the proxy
/// the OS reports (the system proxy), like every other outbound request.
static ROUTED: OnceLock<Arc<RoutedClients>> = OnceLock::new();

/// Routes every later download through `clients`. Set once, by the composition; a download made
/// before it (or in a process that never sets it) uses the environment's proxy variables only.
pub fn route_downloads(clients: Arc<RoutedClients>) {
    let _ = ROUTED.set(clients);
}

async fn send(url: &str, label: &str) -> Result<reqwest::Response, DownloadError> {
    let network = |e: &dyn std::fmt::Display| DownloadError::Network(format!("{label}: {e}"));
    match ROUTED.get() {
        // A route the policy cannot decide fails the download; it never goes direct.
        Some(clients) => clients.download_client_for(url).await.map_err(|e| network(&e))?.get(url).send().await.map_err(|e| network(&e)),
        None => reqwest::get(url).await.map_err(|e| network(&e)),
    }
}

#[derive(Debug, Clone)]
pub struct Spec<'a> {
    pub url: &'a str,
    pub dest: &'a Path,
    /// Largest accepted body.
    pub max_bytes: u64,
    /// The exact size, when known (0 otherwise).
    pub expected_bytes: u64,
    pub label: &'a str,
    /// The lane the partial file is created, written and synced on.
    pub lane: CpuBulk,
}

async fn attempt(spec: &Spec<'_>, progress: Option<&ProgressSink>, cancel: &CancellationToken) -> Result<u64, DownloadError> {
    let label = spec.label;
    let mut response = tokio::select! {
        () = cancel.cancelled() => return Err(DownloadError::Cancelled),
        sent = send(spec.url, label) => sent?,
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let note = if (400..500).contains(&status) { " (terminal)" } else { "" };
        return Err(DownloadError::Http { status, label: label.to_owned(), url: spec.url.to_owned(), note });
    }
    let advertised = response.content_length().unwrap_or(0);
    if advertised > spec.max_bytes {
        return Err(DownloadError::Size(format!("{label}: response exceeds the {} byte limit", spec.max_bytes)));
    }
    if spec.expected_bytes != 0 && advertised != 0 && advertised != spec.expected_bytes {
        return Err(DownloadError::Size(format!(
            "{label}: expected {} bytes, server advertised {advertised}",
            spec.expected_bytes
        )));
    }
    let total = if advertised != 0 { advertised } else { spec.expected_bytes };
    if let Some(parent) = spec.dest.parent() {
        fsio::create_dir_all(spec.lane, parent).await.map_err(|e| DownloadError::Io(e.to_string()))?;
    }
    let mut file = LaneWriter::create(spec.lane, spec.dest).await.map_err(|e| DownloadError::Io(e.to_string()))?;
    let step = (total / 100).max(MIN_PROGRESS_STEP);
    let (mut downloaded, mut reported) = (0u64, 0u64);
    let emit = |downloaded: u64| {
        if let Some(sink) = progress {
            sink(Progress { label: label.to_owned(), downloaded, total });
        }
    };
    loop {
        let chunk = tokio::select! {
            () = cancel.cancelled() => return Err(DownloadError::Cancelled),
            next = response.chunk() => next.map_err(|e| DownloadError::Network(format!("{label}: {e}")))?,
        };
        let Some(chunk) = chunk else { break };
        downloaded += chunk.len() as u64;
        if downloaded > spec.max_bytes {
            return Err(DownloadError::Size(format!("{label}: response exceeds the {} byte limit", spec.max_bytes)));
        }
        file.write(&chunk).await.map_err(|e| DownloadError::Io(e.to_string()))?;
        if downloaded - reported >= step {
            reported = downloaded;
            emit(downloaded);
        }
    }
    emit(downloaded);
    let expected = if spec.expected_bytes != 0 { spec.expected_bytes } else { advertised };
    if expected != 0 && downloaded != expected {
        return Err(DownloadError::Size(format!("{label}: expected {expected} bytes, received {downloaded}")));
    }
    // The bytes reach disk before the caller installs the file, so a crash
    // cannot leave an installed model that is all NUL.
    file.finish().await.map_err(|e| DownloadError::Io(e.to_string()))?;
    Ok(downloaded)
}

/// One attempt at `spec.url`; a failed attempt leaves no file.
pub async fn download_once(
    spec: &Spec<'_>,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<u64, DownloadError> {
    let outcome = attempt(spec, progress, cancel).await;
    if outcome.is_err() {
        let _ = fsio::remove_file(spec.lane, spec.dest).await;
    }
    outcome
}

/// Downloads `spec.url` to `spec.dest`; a failed download leaves no file.
pub async fn download_to_file(
    spec: &Spec<'_>,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<u64, DownloadError> {
    let mut last = DownloadError::Cancelled;
    for _ in 0..=RETRIES {
        match download_once(spec, progress, cancel).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                if error.is_terminal() {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}

/// Hex sha256 of a file, read on the CPU bulk lane.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the file is read inside a lane job")]
pub async fn sha256_file(lane: CpuBulk, path: &Path) -> Result<String, DownloadError> {
    use std::io::Read;
    let path = path.to_owned();
    run_on_lane(lane, move || -> std::io::Result<String> {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await
    .map_err(DownloadError::Io)?
    .map_err(|e| DownloadError::Io(e.to_string()))
}
