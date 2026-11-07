//! The PostgreSQL runtime the memory service runs (`runtime/memory/lib/runtime-fetcher.mjs`
//! `ensureRuntime`). It is not part of the install: the first memory start downloads the
//! release asset named by the bundled manifest into `<data>/runtime`, verifies its sha256,
//! extracts it with the system `tar` and publishes it as `runtime-<version>-<sha256[0..12]>`
//! behind an `active-version` pointer. [`ensure_runtime`] answers the tree to hand to
//! `PgRuntime::new`.
//!
//! Node's timings are kept: a download attempt has 180 s ([`retry`]), a failed one waits 1 s,
//! 3 s, 9 s and tries again, and a refused rename is retried on `atomic-file.mjs`'s backoff
//! (`mixdog-statefile`). Node's manifest fallbacks (a cached `<data>/runtime/manifest.json`, a
//! GitHub fetch) serve a checkout without the bundled file, which cannot happen when the
//! manifest is compiled in (`decisions.md`, "PG runtime installer").

mod manifest;
pub mod retry;
mod stage;
mod tar;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use mixdog_rt::{CpuBulk, DurabilityIo, InLane, LaneToken};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

pub use self::manifest::{Asset, Manifest, Platform, repositories_env, url_candidates};
use crate::memory::ingest::NowMs;
use crate::model_install::{DownloadError, ProgressSink, Spec, download_once, fsio, sha256_file};

const DOWNLOAD_LABEL: &str = "memory runtime download";

#[derive(Debug, Clone, Error)]
pub enum RuntimeInstallError {
    /// The manifest has no runtime for this platform: memory is off here and the rest of
    /// Mixdog works without it.
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Text(String),
    #[error("cancelled")]
    Cancelled,
}

fn io_error(error: std::io::Error) -> RuntimeInstallError {
    RuntimeInstallError::Text(error.to_string())
}

/// A job on the durability lane; its body gets the proof `mixdog-statefile` asks for.
async fn job<R: Send + 'static>(
    lane: DurabilityIo,
    work: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static,
) -> Result<R, RuntimeInstallError> {
    let handle = lane
        .submit_wait(&mixdog_rt::CancellationToken::new(), work)
        .await
        .map_err(|e| RuntimeInstallError::Text(format!("lane job was not queued: {e:?}")))?;
    handle.await.map_err(|_| RuntimeInstallError::Text("lane job was dropped".to_owned()))
}

/// What one install reads from the host.
pub struct InstallOptions {
    pub data_dir: PathBuf,
    /// [`Manifest::bundled`] in the product.
    pub manifest: Manifest,
    /// [`Platform::current`] in the product.
    pub platform: Platform,
    /// `MIXDOG_RUNTIME_RELEASE_REPOSITORY || RUNTIME_RELEASE_REPOSITORY || ''`, see
    /// [`repositories_env`]: repositories tried after the manifest's own, in order.
    pub release_repositories: String,
    /// The lane the runtime directory's files are read and written on.
    pub durability: DurabilityIo,
    /// The lane the archive is hashed on and the download is written on.
    pub bulk: CpuBulk,
    pub now: NowMs,
    pub progress: Option<ProgressSink>,
}

/// An installed runtime tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeInstall {
    /// `runtime-<key>`: the directory `PgRuntime::new` takes.
    pub runtime_dir: PathBuf,
    pub pg_bin_dir: PathBuf,
    pub lib_dir: PathBuf,
    pub share_path: PathBuf,
    pub version: String,
}

impl RuntimeInstall {
    fn of(dir: PathBuf, version: String) -> Self {
        Self { pg_bin_dir: dir.join("bin"), lib_dir: dir.join("lib"), share_path: dir.join("share"), runtime_dir: dir, version }
    }
}

fn check(cancel: &CancellationToken) -> Result<(), RuntimeInstallError> {
    if cancel.is_cancelled() { Err(RuntimeInstallError::Cancelled) } else { Ok(()) }
}

/// `ensureRuntime(dataDir, { signal })`: the installed runtime, downloaded first when the active
/// one is missing, damaged or of another asset. `cancel` ends a download in progress: its
/// partial files and staging lock are removed and nothing is published.
pub async fn ensure_runtime(options: &InstallOptions, cancel: &CancellationToken) -> Result<RuntimeInstall, RuntimeInstallError> {
    let lane = options.durability;
    let base = options.data_dir.join("runtime");
    fsio::create_dir_all(lane, &base).await.map_err(io_error)?;
    // Entry GC: partial extracts of earlier crashes go; the active runtime stays.
    let (gc_base, now) = (base.clone(), (options.now)());
    job(lane, move |_| stage::gc(&gc_base, stage::read_active_version(&gc_base).as_deref(), now)).await?;

    let (asset, selected) = options.manifest.select(&options.platform)?;
    let pkey = options.platform.key();
    if selected != pkey {
        tracing::info!("[runtime-fetcher] {pkey} has no native runtime; using {selected} under emulation");
    }
    let version = options.manifest.version();
    let (cache_base, cache_version, cache_sha) = (base.clone(), version.clone(), asset.sha256.clone());
    let cached = job(lane, move |_| stage::cached_runtime_dir(&cache_base, &cache_version, &cache_sha)).await?;
    let dir = match cached {
        Some(dir) => dir,
        None => install(options, &base, &asset, &version, &pkey, cancel).await?,
    };
    Ok(RuntimeInstall::of(dir, version))
}

/// `installRuntimeVersion`: download, verify, extract, publish, all under one staging lock.
async fn install(
    options: &InstallOptions,
    base: &Path,
    asset: &Asset,
    version: &str,
    pkey: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf, RuntimeInstallError> {
    let lane = options.durability;
    // `tar` is only needed here: a machine without it reuses a complete cached runtime.
    tar::probe().await.map_err(RuntimeInstallError::Text)?;
    check(cancel)?;
    tracing::info!("[runtime-fetcher] downloading runtime {version} for {pkey} (~{} bytes) …", asset.size);

    // A unique staging suffix keeps two siblings off one directory and its guarding lock file.
    let tag = format!("{}-{}-{}", (options.now)(), std::process::id(), stage::random_tag());
    let staging = base.join(format!("staging-{tag}"));
    let tar_path = PathBuf::from(format!("{}.tar.gz", staging.display()));
    let key = stage::install_key(version, &asset.sha256);

    let (lock_staging, now) = (staging.clone(), (options.now)());
    let lock = job(lane, move |proof| stage::acquire_lock(proof, &lock_staging, now)).await?.map_err(io_error)?;
    let published = fetch_and_publish(options, base, &staging, &tar_path, asset, version, &key, cancel).await;
    // The lock is held for the whole download, extract and publish.
    job(lane, move |_| stage::release_lock(lock)).await?;
    match published {
        Ok(()) => {
            let dir = stage::ver_dir(base, &key);
            tracing::info!("[runtime-fetcher] runtime ready at {}", dir.display());
            Ok(dir)
        }
        Err(RuntimeInstallError::Cancelled) => {
            tracing::info!("[runtime-fetcher] install of {version} cancelled; its staging was removed");
            Err(RuntimeInstallError::Cancelled)
        }
        Err(error) => Err(error),
    }
}

#[allow(clippy::too_many_arguments, reason = "the body of `install`: one install's paths and asset")]
async fn fetch_and_publish(
    options: &InstallOptions,
    base: &Path,
    staging: &Path,
    tar_path: &Path,
    asset: &Asset,
    version: &str,
    key: &str,
    cancel: &CancellationToken,
) -> Result<(), RuntimeInstallError> {
    let lane = options.durability;
    let fetched = async {
        download_verified(options, asset, tar_path, version, cancel).await?;
        check(cancel)?;
        tar::extract(lane, tar_path, staging).await.map_err(RuntimeInstallError::Text)
    }
    .await;
    let _ = fsio::remove_file(lane, tar_path).await;
    fetched?;
    // Cancelled after the extract: the unpublished tree is dropped, nothing is published.
    if cancel.is_cancelled() {
        let dropped = staging.to_owned();
        job(lane, move |_| stage::remove_any(&dropped)).await?;
        return Err(RuntimeInstallError::Cancelled);
    }
    let (staging, base, key, sha256, now) = (staging.to_owned(), base.to_owned(), key.to_owned(), asset.sha256.clone(), (options.now)());
    job(lane, move |proof| -> std::io::Result<()> {
        stage::write_atomic(proof, &staging.join(".version-sha256"), sha256.as_bytes(), false)?;
        stage::normalize_bin_exec_bit(&staging);
        stage::publish(proof, &base, &staging, &key, &sha256, now).inspect_err(|error| {
            tracing::warn!("[runtime-fetcher] atomic swap failed: {error}");
        })?;
        // Stale runtimes go, still under the lock.
        stage::gc(&base, Some(&key), now);
        Ok(())
    })
    .await?
    .map_err(io_error)
}

/// Node's `HTTP` error text keeps its own label.
fn download_failure(error: DownloadError) -> RuntimeInstallError {
    match error {
        DownloadError::Cancelled => RuntimeInstallError::Cancelled,
        DownloadError::Http { status, url, note, .. } => {
            RuntimeInstallError::Text(format!("[runtime-fetcher] asset download HTTP {status}{note} — {url}"))
        }
        other => RuntimeInstallError::Text(other.to_string()),
    }
}

/// One candidate: downloaded to `tar_path` within the manifest's size, then checked against its sha256.
async fn fetch_one(
    options: &InstallOptions,
    asset: &Asset,
    url: &str,
    tar_path: &Path,
    cancel: &CancellationToken,
) -> Result<(), RuntimeInstallError> {
    let spec = Spec { url, dest: tar_path, max_bytes: asset.size, expected_bytes: asset.size, label: DOWNLOAD_LABEL, lane: options.bulk };
    retry::with_retry(
        || download_once(&spec, options.progress.as_ref(), cancel),
        || async {
            let _ = fsio::remove_file(options.durability, tar_path).await;
        },
        cancel,
        |attempt, wait, error| {
            tracing::warn!("[runtime-fetcher] download attempt {attempt} failed ({error}), retrying in {}ms…", wait.as_millis());
        },
    )
    .await
    .map_err(download_failure)?;
    let actual = sha256_file(options.bulk, tar_path).await.map_err(download_failure)?;
    if actual != asset.sha256 {
        return Err(RuntimeInstallError::Text(format!(
            "[runtime-fetcher] sha256 mismatch for {}: expected {}, got {actual}",
            tar_path.display(),
            asset.sha256
        )));
    }
    Ok(())
}

/// The candidate urls in order, each downloaded and checked against the manifest's sha256; the
/// first that passes wins and the last failure is the answer when none does.
async fn download_verified(
    options: &InstallOptions,
    asset: &Asset,
    tar_path: &Path,
    version: &str,
    cancel: &CancellationToken,
) -> Result<(), RuntimeInstallError> {
    let lane = options.durability;
    let mut last = None;
    for url in url_candidates(&asset.url, &options.release_repositories) {
        if url != asset.url {
            tracing::warn!("[runtime-fetcher] retrying runtime download from fallback release repo — {url}");
        }
        match fetch_one(options, asset, &url, tar_path, cancel).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                let _ = fsio::remove_file(lane, tar_path).await;
                // A cancelled install tries no fallback repository.
                check(cancel)?;
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or_else(|| RuntimeInstallError::Text(format!("[runtime-fetcher] download or verify failed for {version}"))))
}
