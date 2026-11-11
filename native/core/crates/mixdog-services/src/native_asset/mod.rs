//! The prebuilt `mixdog-graph` binary a release ships (Node `tools/graph-binary-fetcher.mjs` over
//! `shared/native-asset.mjs`): a cached copy is looked up without the network, else downloaded,
//! sha256-verified and installed under `<data>/graph-bin/`.
//!
//! A manifest asset is trusted only when its version is strict semver, its sha256 is 64 hex digits
//! and its url is exactly the release url Mixdog CI publishes for that version and platform. The
//! manifest is the one bundled with the product: Node's `graph-manifest.json`, embedded at build
//! from its one place in the repo; Node's fallbacks to a cached `manifest.json` and to a
//! remote fetch apply only where no bundled manifest exists, which never happens here.
//!
//! Not as in Node: concurrent `ensure` calls queue instead of sharing one in-flight promise, so a
//! failure is retried by the next caller rather than handed to every waiter at once.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::{CpuBulk, DurabilityIo};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::memory::ingest::NowMs;
use crate::memory::pg::runtime_install::retry::with_retry;
use crate::model_install::{DownloadError, Spec, download_once, fsio, sha256_file};
use crate::tidy::install::platform_key_candidates;

#[cfg(test)]
mod tests;

const LABEL: &str = "[graph-fetcher]";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/tribgames/mixdog/releases/download";
/// `MAX_NATIVE_BINARY_DOWNLOAD_BYTES`.
const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;
/// Node's own file, read where it lives: a release job that rewrites it rewrites this too.
const BUNDLED: &str = include_str!("../../../../../../src/runtime/agent/orchestrator/tools/graph-manifest.json");

/// The manifest shipped with the product.
pub fn bundled_manifest() -> Value {
    serde_json::from_str(BUNDLED).expect("graph-manifest.json is valid JSON")
}

/// Downloads `url` to `dest`; a failed download leaves no file.
#[async_trait]
pub trait AssetDownloader: Send + Sync {
    async fn download(&self, url: &str, dest: &Path) -> Result<(), String>;
}

/// `createBinaryDownloader({ name: 'graph' })`: `downloadToFileWithRetry` with the native binary
/// size limit, on Node's timed retry schedule.
pub struct ReleaseDownloader {
    pub bulk: CpuBulk,
    pub durability: DurabilityIo,
}

#[async_trait]
impl AssetDownloader for ReleaseDownloader {
    async fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        let cancel = CancellationToken::new();
        let spec = Spec { url, dest, max_bytes: MAX_BINARY_BYTES, expected_bytes: 0, label: "graph binary download", lane: self.bulk };
        with_retry(
            || download_once(&spec, None, &cancel),
            || async {
                let _ = fsio::remove_file(self.durability, dest).await;
            },
            &cancel,
            |attempt, wait, error| {
                mixdog_rt::node_stderr!("{LABEL} download attempt {attempt} failed ({}), retrying in {}ms…", failure_text(error), wait.as_millis());
            },
        )
        .await
        .map(|_| ())
        .map_err(|error| failure_text(&error))
    }
}

/// The message of the error the downloader throws: what the retry line and the caller both carry.
fn failure_text(error: &DownloadError) -> String {
    match error {
        DownloadError::Http { status, url, note, .. } => format!("{LABEL} asset HTTP {status}{note} — {url}"),
        other => other.to_string(),
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_semver(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && (*p == "0" || !p.starts_with('0')))
}

fn bin_suffix() -> &'static str {
    if cfg!(windows) { ".exe" } else { "" }
}

/// `validReleaseAsset`: the asset's `(url, sha256)` when the manifest may be trusted for `pkey`.
fn valid_asset<'a>(manifest: &'a Value, pkey: &str) -> Option<(&'a str, &'a str)> {
    let version = manifest.get("version")?.as_str().filter(|v| valid_semver(v))?;
    let asset = manifest.get("assets")?.get(pkey)?;
    let sha = asset.get("sha256")?.as_str().filter(|s| valid_sha256(s))?;
    let url = asset.get("url")?.as_str()?;
    (url == format!("{RELEASE_DOWNLOAD_BASE}/graph-v{version}/mixdog-graph-{pkey}{}", bin_suffix())).then_some((url, sha))
}

pub struct GraphBinary {
    data_dir: PathBuf,
    manifest: Value,
    durability: DurabilityIo,
    bulk: CpuBulk,
    downloader: Arc<dyn AssetDownloader>,
    now: NowMs,
    flight: tokio::sync::Semaphore,
    /// This host's manifest keys, best first ([`platform_key_candidates`]).
    platforms: Vec<String>,
}

impl GraphBinary {
    /// `manifest` is [`bundled_manifest`] in the product.
    pub fn new(data_dir: PathBuf, manifest: Value, durability: DurabilityIo, bulk: CpuBulk, downloader: Arc<dyn AssetDownloader>, now: NowMs) -> Self {
        Self { data_dir, manifest, durability, bulk, downloader, now, flight: tokio::sync::Semaphore::new(1), platforms: platform_key_candidates() }
    }

    /// The fetcher as it runs on a host whose `std::env::consts` are `os` and `arch`.
    #[cfg(test)]
    fn on_host(self, os: &str, arch: &str) -> Self {
        Self { platforms: crate::tidy::install::platform_key_candidates_for(os, arch), ..self }
    }

    fn dir(&self) -> PathBuf {
        self.data_dir.join("graph-bin")
    }

    fn version(&self) -> &str {
        self.manifest.get("version").and_then(Value::as_str).unwrap_or("0")
    }

    fn file_name(&self) -> String {
        format!("mixdog-graph-{}{}", self.version(), bin_suffix())
    }

    /// `resolvePlatformKey`: the first host key the manifest has a trusted asset for, else the native key.
    fn platform_key(&self) -> String {
        let candidates = &self.platforms;
        candidates.iter().find(|key| valid_asset(&self.manifest, key).is_some()).unwrap_or(&candidates[0]).clone()
    }

    /// `findCachedGraphBinary`: the installed binary whose digest is the manifest's, no network.
    pub async fn find_cached(&self) -> Option<PathBuf> {
        let key = self.platform_key();
        let (_, sha256) = valid_asset(&self.manifest, &key)?;
        let path = self.dir().join(self.file_name());
        if !fsio::exists(self.durability, &path).await.ok()? {
            return None;
        }
        (sha256_file(self.bulk, &path).await.ok()? == sha256.to_lowercase()).then_some(path)
    }

    /// `ensureGraphBinary`: the verified binary's path, downloaded first when it is not installed.
    pub async fn ensure(&self) -> Result<PathBuf, String> {
        let _turn = self.flight.acquire().await.map_err(|_| format!("{LABEL} the install gate is closed"))?;
        let key = self.platform_key();
        let Some((url, sha256)) = valid_asset(&self.manifest, &key) else {
            let assets = self.manifest.get("assets").and_then(Value::as_object);
            let supported = assets.map(|a| a.keys().cloned().collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty()).unwrap_or_else(|| "(none)".to_owned());
            return Err(format!(
                "{LABEL} no prebuilt mixdog-graph binary for platform {key} (unsupported platform/arch — there is no JS parsing fallback). Supported platforms: {supported}. Build it locally: cargo build --release in native/mixdog-graph."
            ));
        };
        let dir = self.dir();
        fsio::create_dir_all(self.durability, &dir).await.map_err(|e| e.to_string())?;
        let file_name = self.file_name();
        let dest = dir.join(&file_name);
        let expected = sha256.to_lowercase();
        if fsio::exists(self.durability, &dest).await.map_err(|e| e.to_string())? && sha256_file(self.bulk, &dest).await.is_ok_and(|actual| actual == expected) {
            return Ok(dest);
        }
        let tmp = dir.join(format!("{file_name}.tmp-{}-{}", std::process::id(), (self.now)()));
        self.downloader.download(url, &tmp).await?;
        let actual = sha256_file(self.bulk, &tmp).await.map_err(|e| e.to_string())?;
        if actual != expected {
            let _ = fsio::remove_file(self.durability, &tmp).await;
            return Err(format!("{LABEL} sha256 mismatch for {key}: expected {sha256}, got {actual}"));
        }
        fsio::rename(self.durability, &tmp, &dest).await.map_err(|e| e.to_string())?;
        fsio::make_executable(self.durability, &dest).await;
        // `gcBinaryDir`: stale binaries and temp files, keeping the active one and the manifest.
        for name in fsio::list_names(self.durability, &dir).await {
            if name != "manifest.json" && name != file_name && name.starts_with("mixdog-graph") {
                let _ = fsio::remove_file(self.durability, &dir.join(name)).await;
            }
        }
        Ok(dest)
    }
}
