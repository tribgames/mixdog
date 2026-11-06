//! Verified downloads and installs of the llama.cpp runtime and models. A download is HTTPS
//! only, size-bounded, resumable from `<file>.part`, and renamed into place only after its
//! SHA-256 matches. Paused or failed installs leave the partial file as durable evidence; it
//! never proves validity, the digest does.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::{DurabilityIo, LaneToken};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::catalog::{Catalog, ensure_disk_space, exact_file, file_has_data, partial_asset_bytes};
use super::installations::Progress;
use crate::tidy::process::{Processes, RunOptions};

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("[local-provider] invalid asset URL")]
    InvalidUrl,
    #[error("[local-provider] asset URL must use HTTPS")]
    NotHttps,
    #[error("[local-provider] asset is missing a valid SHA-256")]
    NoDigest,
    #[error("[local-provider] asset is missing a valid byte size")]
    NoSize,
    #[error("[local-provider] download failed: HTTP {0} ({1})")]
    Http(u16, String),
    #[error("[local-provider] asset redirect must use HTTPS")]
    RedirectNotHttps,
    #[error("[local-provider] download exceeded declared size for {0}")]
    Oversize(String),
    #[error("[local-provider] incomplete download for {0}: {1}/{2}")]
    Incomplete(String, i64, i64),
    #[error("[local-provider] SHA-256 mismatch for {0}")]
    DigestMismatch(String),
    #[error("aborted")]
    Aborted,
    #[error("{0}")]
    Other(String),
}

impl From<std::io::Error> for AssetError {
    fn from(e: std::io::Error) -> Self {
        Self::Other(e.to_string())
    }
}

/// The bytes of one HTTP response.
#[async_trait]
pub trait Body: Send {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, String>;
}

pub struct Fetched {
    pub status: u16,
    /// Size of the body being sent, when the server declared it.
    pub content_length: Option<i64>,
    pub https: bool,
    pub body: Box<dyn Body>,
}

#[async_trait]
pub trait Fetcher: Send + Sync {
    /// GET following redirects, with `Range: bytes=<from>-` when `from > 0`.
    async fn get(&self, url: &str, from: i64) -> Result<Fetched, String>;
}

pub struct ReqwestFetcher(reqwest::Client);

impl Default for ReqwestFetcher {
    fn default() -> Self {
        Self(reqwest::Client::new())
    }
}

struct ReqwestBody(reqwest::Response);

#[async_trait]
impl Body for ReqwestBody {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
        self.0.chunk().await.map(|c| c.map(|b| b.to_vec())).map_err(|e| e.to_string())
    }
}

#[async_trait]
impl Fetcher for ReqwestFetcher {
    async fn get(&self, url: &str, from: i64) -> Result<Fetched, String> {
        let mut request = self.0.get(url);
        if from > 0 {
            request = request.header("Range", format!("bytes={from}-"));
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        Ok(Fetched { status: response.status().as_u16(), content_length: response.content_length().map(|n| n as i64), https: response.url().scheme() == "https", body: Box::new(ReqwestBody(response)) })
    }
}

fn check_asset(asset: &Value) -> Result<(i64, String, String), AssetError> {
    let url = asset["url"].as_str().ok_or(AssetError::InvalidUrl)?;
    let scheme_end = url.find("://").ok_or(AssetError::InvalidUrl)?;
    if url[..scheme_end].to_lowercase() != "https" {
        return Err(AssetError::NotHttps);
    }
    let sha = asset["sha256"].as_str().filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())).ok_or(AssetError::NoDigest)?;
    let size = asset["size"].as_i64().filter(|s| *s > 0).ok_or(AssetError::NoSize)?;
    Ok((size, url.to_owned(), sha.to_lowercase()))
}

/// Hashes `path` as one job on the durability lane (the lane its partial files are written on);
/// a cancel ends the wait at once and stops the read at its next 1 MiB block.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the file is read inside a durability-lane job")]
pub async fn sha256_file(lane: DurabilityIo, path: &Path, cancel: &CancellationToken) -> Result<String, AssetError> {
    let path = path.to_owned();
    let job_cancel = cancel.clone();
    let hashed = on_durability_lane(lane, cancel, move || {
        use std::io::Read;
        let mut file = fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if job_cancel.is_cancelled() {
                return Ok(None);
            }
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()))
    })
    .await?;
    hashed.ok_or(AssetError::Aborted)
}

fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn report(on_progress: &Option<Progress>, stage: Option<&str>, received: i64, total: i64, percent: i64) {
    if let Some(cb) = on_progress {
        let mut m = Map::new();
        if let Some(stage) = stage {
            m.insert("stage".into(), json!(stage));
        }
        m.insert("receivedBytes".into(), json!(received));
        m.insert("totalBytes".into(), json!(total));
        m.insert("percent".into(), json!(percent));
        cb(m);
    }
}

/// Received bytes are written and flushed in batches of this size, one lane job per batch.
const WRITE_BATCH: usize = 1024 * 1024;

pub struct DownloadOptions {
    pub on_progress: Option<Progress>,
    pub cancel: CancellationToken,
    pub force: bool,
    pub timeout: Duration,
    pub check_disk: bool,
    /// The lane the partial file is created, written and fsynced on.
    pub durability: DurabilityIo,
    /// Received bytes collected before each write job.
    pub write_batch: usize,
    /// Runs at the start of every write job, on the lane thread.
    #[cfg(test)]
    pub write_gate: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
}

impl DownloadOptions {
    pub fn new(durability: DurabilityIo) -> Self {
        Self {
            on_progress: None,
            cancel: CancellationToken::new(),
            force: false,
            timeout: DOWNLOAD_TIMEOUT,
            check_disk: true,
            durability,
            write_batch: WRITE_BATCH,
            #[cfg(test)]
            write_gate: None,
        }
    }
}

/// Runs blocking file work on the durability lane and waits for it to settle. Cancelling `cancel`
/// stops a job still waiting for lane room or queued; a job already running is always awaited, so
/// `Aborted` is only returned once nothing of this call is still touching the file.
async fn on_durability_lane<T: Send + 'static>(lane: DurabilityIo, cancel: &CancellationToken, work: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> Result<T, AssetError> {
    let aborted = |e: &dyn std::fmt::Display| if cancel.is_cancelled() { AssetError::Aborted } else { AssetError::Other(e.to_string()) };
    let job = lane.submit_wait(cancel, move |_| work()).await.map_err(|e| aborted(&e))?;
    let done = job.await.map_err(|e| aborted(&e))?;
    Ok(done?)
}

/// Quick file work that must finish even when the download was cancelled (cleanup, the final
/// rename): it never observes a cancel.
async fn settled<T: Send + 'static>(lane: DurabilityIo, work: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> Result<T, AssetError> {
    on_durability_lane(lane, &CancellationToken::new(), work).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a durability-lane job")]
async fn create_dir_all(lane: DurabilityIo, path: &Path) -> Result<(), AssetError> {
    let path = path.to_owned();
    settled(lane, move || fs::create_dir_all(path)).await
}

/// Length of `path`, 0 when it does not exist.
#[allow(clippy::disallowed_methods, reason = "the call is a durability-lane job")]
async fn file_len(lane: DurabilityIo, path: &Path) -> Result<i64, AssetError> {
    let path = path.to_owned();
    settled(lane, move || Ok(fs::metadata(path).map_or(0, |m| m.len() as i64))).await
}

#[allow(clippy::disallowed_methods, reason = "the call is a durability-lane job")]
async fn remove_file(lane: DurabilityIo, path: &Path) {
    let path = path.to_owned();
    let _ = settled(lane, move || Ok(drop(fs::remove_file(path)))).await;
}

#[allow(clippy::disallowed_methods, reason = "the call is a durability-lane job")]
async fn remove_dir_all(lane: DurabilityIo, path: &Path) {
    let path = path.to_owned();
    let _ = settled(lane, move || Ok(drop(fs::remove_dir_all(path)))).await;
}

#[allow(clippy::disallowed_methods, reason = "the call is a durability-lane job")]
async fn rename(lane: DurabilityIo, from: &Path, to: &Path) -> Result<(), AssetError> {
    let (from, to) = (from.to_owned(), to.to_owned());
    settled(lane, move || fs::rename(from, to)).await
}

/// Runs any blocking job (a probe, a read, a short write) of the provider on the lane; it never
/// observes a cancel. Every file-system call of the provider's async paths goes through here.
pub(super) async fn probe<T: Send + 'static>(lane: DurabilityIo, work: impl FnOnce() -> T + Send + 'static) -> Result<T, AssetError> {
    settled(lane, move || Ok(work())).await
}

async fn check_disk(lane: DurabilityIo, enabled: bool, dir: &Path, need: i64) -> Result<(), AssetError> {
    if !enabled {
        return Ok(());
    }
    let dir = dir.to_owned();
    probe(lane, move || ensure_disk_space(&dir, need).map_err(AssetError::Other)).await?
}

/// One owner per partial file: a download holds its destination's lock from its first file
/// operation until its last write has settled, so a resume waits for the download it follows.
/// An entry lives while it has a holder or a waiter, so the map holds only active destinations.
struct Owner {
    lock: Arc<tokio::sync::Semaphore>,
    users: usize,
}

fn owners() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Owner>> {
    static OWNERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, Owner>>> = std::sync::OnceLock::new();
    OWNERS.get_or_init(Default::default)
}

/// A waiter's or holder's claim on the registry entry; the last one out removes it.
struct Registration(PathBuf);

impl Drop for Registration {
    fn drop(&mut self) {
        let mut map = owners().lock().unwrap();
        if let Some(owner) = map.get_mut(&self.0) {
            owner.users -= 1;
            if owner.users == 0 {
                map.remove(&self.0);
            }
        }
    }
}

/// Ownership of a destination. The guard is released before the registration, so a waiter that
/// takes over finds the entry still there.
struct Ownership {
    _guard: tokio::sync::OwnedSemaphorePermit,
    _registration: Registration,
}

/// Waits until this caller owns `partial`; a cancel while waiting gives up with `None`.
async fn own(partial: &Path, cancel: &CancellationToken) -> Option<Ownership> {
    let lock = {
        let mut map = owners().lock().unwrap();
        let owner = map.entry(partial.to_owned()).or_insert_with(|| Owner { lock: Arc::new(tokio::sync::Semaphore::new(1)), users: 0 });
        owner.users += 1;
        owner.lock.clone()
    };
    let registration = Registration(partial.to_owned());
    tokio::select! {
        // The semaphore is never closed, so the permit is always granted.
        guard = lock.acquire_owned() => guard.ok().map(|guard| Ownership { _guard: guard, _registration: registration }),
        () = cancel.cancelled() => None,
    }
}

/// How many callers hold or wait for `partial`.
#[cfg(test)]
fn users_of(partial: &Path) -> usize {
    owners().lock().unwrap().get(partial).map_or(0, |o| o.users)
}

/// Downloads `asset` (`url`, `size`, `sha256`, optional `name`) to `destination`.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the file calls are durability-lane jobs")]
pub async fn download_verified_asset(fetcher: &dyn Fetcher, asset: &Value, destination: &Path, options: DownloadOptions) -> Result<PathBuf, AssetError> {
    let (size, url, sha256) = check_asset(asset)?;
    let name = asset["name"].as_str().map_or_else(|| destination.display().to_string(), str::to_owned);
    let cancel = options.cancel.clone();
    let deadline = cancel.child_token();
    {
        let deadline = deadline.clone();
        let timeout = options.timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            deadline.cancel();
        });
    }
    if deadline.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    let lane = options.durability;
    let partial = part_path(destination);
    let Some(_owner) = own(&partial, &deadline).await else { return Err(AssetError::Aborted) };
    let dir = destination.parent().expect("destination has a parent");
    create_dir_all(lane, dir).await?;
    if !options.force {
        let (path, expected) = (destination.to_owned(), size);
        if probe(lane, move || exact_file(&path, expected)).await? && sha256_file(lane, destination, &deadline).await? == sha256 {
            report(&options.on_progress, None, size, size, 100);
            return Ok(destination.to_owned());
        }
    }
    let mut received = file_len(lane, &partial).await?;
    if received > size {
        remove_file(lane, &partial).await;
        received = 0;
    }
    if received == size {
        if sha256_file(lane, &partial, &deadline).await? == sha256 {
            rename(lane, &partial, destination).await?;
            report(&options.on_progress, None, size, size, 100);
            return Ok(destination.to_owned());
        }
        remove_file(lane, &partial).await;
        received = 0;
    }
    check_disk(lane, options.check_disk, dir, size - received).await?;
    let mut response = tokio::select! {
        r = fetcher.get(&url, received) => r.map_err(AssetError::Other)?,
        _ = deadline.cancelled() => return Err(AssetError::Aborted),
    };
    if !(200..300).contains(&response.status) {
        return Err(AssetError::Http(response.status, url));
    }
    if !response.https {
        return Err(AssetError::RedirectNotHttps);
    }
    let resumed = received > 0 && response.status == 206;
    if received > 0 && !resumed {
        remove_file(lane, &partial).await;
        received = 0;
        check_disk(lane, options.check_disk, dir, size).await?;
    }
    let opened = {
        let partial = partial.clone();
        on_durability_lane(lane, &deadline, move || fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&partial)).await?
    };
    let mut file = Some(opened);
    let mut total = received;
    let mut pending: Vec<u8> = Vec::new();
    // Every exit from the stream settles its last write job before the file is released.
    let streamed: Result<(), AssetError> = async {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = deadline.cancelled() => return Err(AssetError::Aborted),
                c = response.body.next() => c.map_err(AssetError::Other)?,
            };
            let Some(chunk) = chunk else { break };
            total += chunk.len() as i64;
            if total > size {
                return Err(AssetError::Oversize(name.clone()));
            }
            pending.extend_from_slice(&chunk);
            report(&options.on_progress, Some("downloading"), total, size, ((total as f64 / size as f64) * 100.0).round().min(99.0) as i64);
            if pending.len() >= options.write_batch {
                let batch = std::mem::take(&mut pending);
                let mut open = file.take().expect("file is open while streaming");
                #[cfg(test)]
                let gate = options.write_gate.clone();
                file = Some(
                    on_durability_lane(lane, &deadline, move || {
                        #[cfg(test)]
                        if let Some(gate) = gate {
                            gate();
                        }
                        open.write_all(&batch).map(|()| open)
                    })
                    .await?,
                );
            }
        }
        let mut open = file.take().expect("file is open while streaming");
        let last = std::mem::take(&mut pending);
        #[cfg(test)]
        let gate = options.write_gate.clone();
        on_durability_lane(lane, &deadline, move || {
            #[cfg(test)]
            if let Some(gate) = gate {
                gate();
            }
            open.write_all(&last)?;
            open.sync_all()
        })
        .await
    }
    .await;
    if let Some(open) = file.take() {
        let _ = settled(lane, move || Ok(drop(open))).await;
    }
    streamed?;
    if total != size {
        return Err(AssetError::Incomplete(name, total, size));
    }
    report(&options.on_progress, Some("verifying"), total, size, 99);
    if sha256_file(lane, &partial, &deadline).await? != sha256 {
        remove_file(lane, &partial).await;
        return Err(AssetError::DigestMismatch(name));
    }
    if deadline.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    rename(lane, &partial, destination).await?;
    report(&options.on_progress, Some("complete"), total, size, 100);
    Ok(destination.to_owned())
}

/// Windows builds ship as zips (PowerShell's `Expand-Archive`); the macOS build is a gzipped
/// tarball the system `tar` unpacks.
async fn extract_archive(processes: &Processes, archive: &Path, destination: &Path, cancel: &CancellationToken) -> Result<(), AssetError> {
    // The manager starts a child with exactly the environment it is given.
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let (program, args) = if archive.extension().is_some_and(|e| e == "zip") {
        env.insert("MIXDOG_LOCAL_ARCHIVE".into(), archive.to_string_lossy().into_owned());
        env.insert("MIXDOG_LOCAL_DESTINATION".into(), destination.to_string_lossy().into_owned());
        ("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:MIXDOG_LOCAL_ARCHIVE -DestinationPath $env:MIXDOG_LOCAL_DESTINATION -Force"].map(str::to_owned).to_vec())
    } else {
        ("tar", vec!["-xzf".to_owned(), archive.to_string_lossy().into_owned(), "-C".to_owned(), destination.to_string_lossy().into_owned()])
    };
    let mut options = RunOptions::new(destination);
    options.env = Some(&env);
    options.cancel = Some(cancel);
    options.timeout = Duration::ZERO;
    let output = processes.run(program, &args, options).await;
    if cancel.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    if output.code == 0 {
        return Ok(());
    }
    if output.code == -1 && !output.error.is_empty() {
        return Err(AssetError::Other(format!("[local-provider] runtime extraction failed: {}", output.error)));
    }
    let mut log = output.stdout.clone();
    log.push_str(&output.stderr);
    // `log.slice(-16384)`: the last 16384 UTF-16 units; a pair cut in half is dropped whole.
    let (mut units, mut from) = (0, log.len());
    for (at, c) in log.char_indices().rev() {
        units += c.len_utf16();
        if units > 16_384 {
            break;
        }
        from = at;
    }
    let tail = &log[from..];
    Err(AssetError::Other(format!("[local-provider] runtime extraction failed: {}", if tail.is_empty() { format!("status {}", output.code) } else { tail.to_owned() })))
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn exists_blocking(path: &Path) -> bool {
    path.exists()
}

/// Installs the runtime build for this host; no-op when its executable is already there.
pub async fn install_runtime(catalog: &Arc<Catalog>, fetcher: &dyn Fetcher, processes: &Processes, platform_key: &str, progress: Progress, cancel: CancellationToken) -> Result<Value, AssetError> {
    let durability = processes.durability();
    let hardware = catalog.hardware.detect(true).await;
    if cancel.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    let entry = catalog.runtime_platform_entry(platform_key);
    let status = catalog.status(Some(platform_key)).await?;
    let Some(entry) = entry.filter(|_| status["available"] == true) else {
        return Err(AssetError::Other("[local-provider] Windows x64 with a compatible NVIDIA RTX GPU, or an Apple Silicon Mac with enough memory, is required".into()));
    };
    let _ = hardware;
    let target = catalog.runtime_directory();
    let executable = entry["executable"].as_str().unwrap_or("");
    let installed = target.join(executable);
    if probe(durability, move || file_has_data(&installed)).await? {
        return catalog.status(Some(platform_key)).await;
    }
    let total_bytes = entry["downloadBytes"].as_i64().unwrap_or(0);
    check_disk(durability, true, &catalog.runtime_root(), total_bytes).await?;
    let staging = catalog.runtime_root().join(format!(".staging-{}", std::process::id()));
    let downloads = catalog.runtime_root().join(".downloads");
    remove_dir_all(durability, &staging).await;
    create_dir_all(durability, &staging).await?;
    let result = async {
        let mut completed = 0i64;
        for asset in entry["assets"].as_array().cloned().unwrap_or_default() {
            let archive = downloads.join(asset["name"].as_str().unwrap_or("asset"));
            let (done, progress_cb) = (completed, progress.clone());
            let on_progress: Progress = std::sync::Arc::new(move |p: Map<String, Value>| {
                let got = done + p.get("receivedBytes").and_then(Value::as_i64).unwrap_or(0);
                let mut m = Map::new();
                m.insert("phase".into(), json!("runtime"));
                m.insert("stage".into(), p.get("stage").cloned().unwrap_or(json!("downloading")));
                m.insert("receivedBytes".into(), json!(got));
                m.insert("totalBytes".into(), json!(total_bytes));
                m.insert("percent".into(), json!((got as f64 / total_bytes as f64 * 100.0).round()));
                progress_cb(m);
            });
            download_verified_asset(fetcher, &asset, &archive, DownloadOptions { on_progress: Some(on_progress), cancel: cancel.clone(), ..DownloadOptions::new(durability) }).await?;
            let after = completed + asset["size"].as_i64().unwrap_or(0);
            progress(Map::from_iter([
                ("phase".to_owned(), json!("runtime")), ("stage".into(), json!("extracting")),
                ("receivedBytes".into(), json!(after)), ("totalBytes".into(), json!(total_bytes)),
                ("percent".into(), json!((after as f64 / total_bytes as f64 * 100.0).round().min(99.0))),
            ]));
            extract_archive(processes, &archive, &staging, &cancel).await?;
            completed = after;
        }
        let extracted = staging.join(executable);
        if !probe(durability, move || exists_blocking(&extracted)).await? {
            return Err(AssetError::Other(format!("[local-provider] runtime archive did not contain {executable}")));
        }
        if cancel.is_cancelled() {
            return Err(AssetError::Aborted);
        }
        remove_dir_all(durability, &target).await;
        rename(durability, &staging, &target).await?;
        remove_dir_all(durability, &downloads).await;
        catalog.status(Some(platform_key)).await
    }
    .await;
    if result.is_err() {
        remove_dir_all(durability, &staging).await;
    }
    result
}

/// Downloads one model after checking the runtime and GPU memory.
pub async fn install_model(catalog: &Arc<Catalog>, fetcher: &dyn Fetcher, durability: DurabilityIo, entry: &Value, progress: Progress, cancel: CancellationToken) -> Result<Value, AssetError> {
    let hardware = catalog.hardware.detect(true).await;
    if cancel.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    if catalog.status(None).await?["runtime"]["installed"] != true {
        return Err(AssetError::Other("[local-provider] install the Local Provider runtime first".into()));
    }
    let minimum = entry["minimumVramBytes"].as_i64().unwrap_or(0);
    if !hardware.supported || hardware.gpus.first().map_or(0, |g| g.memory_bytes) < minimum {
        return Err(AssetError::Other(format!("[local-provider] {} requires at least {minimum} bytes of GPU memory", entry["name"].as_str().unwrap_or(""))));
    }
    let id = entry["id"].clone();
    let on_progress: Progress = std::sync::Arc::new(move |mut p| {
        p.insert("phase".into(), json!("model"));
        p.insert("modelId".into(), id.clone());
        progress(p);
    });
    download_verified_asset(fetcher, entry, &catalog.model_path(entry), DownloadOptions { on_progress: Some(on_progress), cancel, ..DownloadOptions::new(durability) }).await?;
    catalog.status(None).await
}

fn paused_entry(phase: &str, model_id: Option<&str>, received: i64, total: i64) -> Value {
    json!({"phase": phase, "modelId": model_id, "state": "paused", "stage": "paused", "receivedBytes": received, "totalBytes": total,
           "percent": ((received as f64 / total as f64) * 100.0).round().min(99.0)})
}

/// Live installations plus the paused ones the partial files on disk prove after a restart.
pub async fn resumable_installations(catalog: &Arc<Catalog>, status: &Value, live: Vec<Value>) -> Result<Vec<Value>, AssetError> {
    let (job_catalog, job_status) = (catalog.clone(), status.clone());
    probe(catalog.lane(), move || resumable_blocking(&job_catalog, &job_status, live)).await
}

fn resumable_blocking(catalog: &Catalog, status: &Value, live: Vec<Value>) -> Vec<Value> {
    let mut entries = live;
    for model in status["models"].as_array().into_iter().flatten() {
        let size = model["sizeBytes"].as_i64().unwrap_or(0);
        let received = size - model["remainingDownloadBytes"].as_i64().unwrap_or(0);
        if model["installed"] == true || received <= 0 || entries.iter().any(|e| e["phase"] == "model" && e["modelId"] == model["id"]) {
            continue;
        }
        entries.push(paused_entry("model", model["id"].as_str(), received, size));
    }
    if status["runtime"]["installed"] != true && !entries.iter().any(|e| e["phase"] == "runtime") {
        let assets = catalog.runtime_platform_entry(super::hardware::host_platform_key()).and_then(|e| e["assets"].as_array().cloned()).unwrap_or_default();
        let received: i64 = assets
            .iter()
            .map(|a| {
                let path = catalog.runtime_root().join(".downloads").join(a["name"].as_str().unwrap_or(""));
                let size = a["size"].as_i64().unwrap_or(0);
                if exact_file(&path, size) { size } else { partial_asset_bytes(&path, size) }
            })
            .sum();
        if received > 0 {
            entries.push(paused_entry("runtime", None, received, status["runtime"]["downloadBytes"].as_i64().unwrap_or(1)));
        }
    }
    entries
}

#[derive(Debug, thiserror::Error)]
pub enum DiscardError {
    #[error("[local-provider] stop the installation before discarding it")]
    Active,
    #[error("[local-provider] unknown model")]
    UnknownModel,
    #[error("phase must be runtime, model, verify or repair.")]
    BadPhase,
    #[error("[local-provider] {0}")]
    Lane(String),
}

/// Drops a paused or failed installation's downloads. Installed weights and runtimes are
/// untouched; a failed verification only forgets its row (the caller forgets the row).
pub async fn discard_downloads(catalog: &Arc<Catalog>, phase: &str, model_id: Option<&str>) -> Result<(), DiscardError> {
    let (job_catalog, phase, model_id) = (catalog.clone(), phase.to_owned(), model_id.map(str::to_owned));
    probe(catalog.lane(), move || discard_blocking(&job_catalog, &phase, model_id.as_deref())).await.map_err(|e| DiscardError::Lane(e.to_string()))?
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn discard_blocking(catalog: &Catalog, phase: &str, model_id: Option<&str>) -> Result<(), DiscardError> {
    match phase {
        "runtime" => {
            for asset in catalog.runtime_platform_entry(super::hardware::host_platform_key()).and_then(|e| e["assets"].as_array().cloned()).unwrap_or_default() {
                let path = catalog.runtime_root().join(".downloads").join(asset["name"].as_str().unwrap_or(""));
                let _ = fs::remove_file(&path);
                let _ = fs::remove_file(part_path(&path));
            }
        }
        "model" | "repair" => {
            let entry = model_id.and_then(|id| catalog.model_entry(id)).ok_or(DiscardError::UnknownModel)?;
            let _ = fs::remove_file(part_path(&catalog.model_path(&entry)));
        }
        "verify" => {}
        _ => return Err(DiscardError::BadPhase),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    struct Chunks(Vec<Vec<u8>>);

    #[async_trait]
    impl Body for Chunks {
        async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
            Ok(if self.0.is_empty() { None } else { Some(self.0.remove(0)) })
        }
    }

    struct Fake {
        content: Vec<u8>,
        status: u16,
        https: bool,
        requested_from: Mutex<Vec<i64>>,
    }

    #[async_trait]
    impl Fetcher for Fake {
        async fn get(&self, _: &str, from: i64) -> Result<Fetched, String> {
            self.requested_from.lock().unwrap().push(from);
            let (status, body) = if from > 0 && self.status == 200 { (206, self.content[from as usize..].to_vec()) } else { (self.status, self.content.clone()) };
            Ok(Fetched { status, content_length: Some(body.len() as i64), https: self.https, body: Box::new(Chunks(body.chunks(4).map(<[u8]>::to_vec).collect())) })
        }
    }

    fn digest(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    fn asset(content: &[u8]) -> Value {
        json!({"name": "a.bin", "url": "https://example.test/a.bin", "size": content.len(), "sha256": digest(content)})
    }

    fn fake(content: &[u8]) -> Fake {
        Fake { content: content.to_vec(), status: 200, https: true, requested_from: Mutex::default() }
    }

    fn opts() -> DownloadOptions {
        DownloadOptions { check_disk: false, ..DownloadOptions::new(mixdog_rt::testing::tokens().durability_io) }
    }

    /// The test backend runs lane jobs inline, so which thread wrote cannot be observed here; what
    /// is checked is that the lane path honours cancellation and carries a multi-batch download.
    #[tokio::test(flavor = "current_thread")]
    async fn partial_file_io_goes_through_the_lane_with_cancellation_and_batches() {
        let dir = tempfile::tempdir().unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        assert_eq!(on_durability_lane(lane, &CancellationToken::new(), || Ok(7)).await.unwrap(), 7);
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(matches!(on_durability_lane(lane, &cancelled, || Ok(())).await, Err(AssetError::Aborted)));
        // A body spanning many write batches is written through the lane and verified.
        let content = vec![7u8; 100];
        let dest = dir.path().join("big.bin");
        download_verified_asset(&fake(&content), &asset(&content), &dest, DownloadOptions { write_batch: 8, ..opts() }).await.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), content);
    }

    /// A resume must not touch the partial file while the download it follows still has a write in
    /// flight, and must then continue from every byte that write put down. The first download is
    /// paused (cancelled) while its first write job is held on the gate.
    #[test]
    fn a_resume_waits_for_the_paused_download_to_settle_its_write() {
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let content = b"hello world!";
        let (first, second) = (fake(content), fake(content));
        let pause = CancellationToken::new();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        // The gate also opens when the sender is dropped, so a failing assertion cannot leave the
        // write job blocked.
        let gate: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            entered_tx.send(()).ok();
            release_rx.lock().unwrap().recv().ok();
        });
        let run = |fetcher: &Fake, options: DownloadOptions| {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(download_verified_asset(fetcher, &asset(content), &dest, options))
        };
        let partial = part_path(&dest);
        std::thread::scope(|scope| {
            let release = release_tx;
            let paused = scope.spawn(|| run(&first, DownloadOptions { write_batch: 4, cancel: pause.clone(), write_gate: Some(gate), ..opts() }));
            entered_rx.recv().unwrap();
            pause.cancel();
            let resumed = scope.spawn(|| run(&second, opts()));
            // The resume has reached the destination's lock when it is registered next to the holder.
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while users_of(&partial) < 2 {
                assert!(std::time::Instant::now() < deadline, "the resume never reached the destination lock");
                std::thread::yield_now();
            }
            assert!(second.requested_from.lock().unwrap().is_empty(), "the resume started while the paused download still owned the file");
            drop(release);
            assert!(matches!(paused.join().unwrap(), Err(AssetError::Aborted)));
            resumed.join().unwrap().unwrap();
        });
        assert_eq!(*second.requested_from.lock().unwrap(), vec![4], "the resume continues after the settled write");
        assert_eq!(fs::read(&dest).unwrap(), content);
        assert!(!part_path(&dest).exists());
        assert_eq!(users_of(&partial), 0, "the registry keeps no entry for a finished destination");
    }

    #[tokio::test]
    async fn the_owner_registry_holds_only_active_destinations() {
        let dir = tempfile::tempdir().unwrap();
        let content = b"hello world!";
        // A completed download, a failed one (wrong digest) and one cancelled while waiting.
        let done = dir.path().join("done.bin");
        download_verified_asset(&fake(content), &asset(content), &done, opts()).await.unwrap();
        assert_eq!(users_of(&part_path(&done)), 0);
        let bad = dir.path().join("bad.bin");
        let mut wrong = asset(content);
        wrong["sha256"] = json!(digest(b"other"));
        assert!(download_verified_asset(&fake(content), &wrong, &bad, opts()).await.is_err());
        assert_eq!(users_of(&part_path(&bad)), 0);
        let held = own(&part_path(&done), &CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(own(&part_path(&done), &cancel).await.is_none());
        assert_eq!(users_of(&part_path(&done)), 1, "the cancelled waiter left");
        drop(held);
        assert_eq!(users_of(&part_path(&done)), 0);
    }

    #[tokio::test]
    async fn a_download_is_verified_then_renamed_and_a_second_call_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("sub/a.bin");
        let content = b"hello world!";
        let seen = Arc::new(Mutex::new(Vec::new()));
        let cb: Progress = {
            let seen = seen.clone();
            Arc::new(move |p| seen.lock().unwrap().push(p["percent"].as_i64().unwrap()))
        };
        let f = fake(content);
        download_verified_asset(&f, &asset(content), &dest, DownloadOptions { on_progress: Some(cb), ..opts() }).await.unwrap();
        assert_eq!(fs::read(&dest).unwrap(), content);
        assert!(!part_path(&dest).exists());
        let percents = seen.lock().unwrap().clone();
        assert!(percents.windows(2).all(|w| w[0] <= w[1]) && percents.contains(&99) && *percents.last().unwrap() == 100);
        download_verified_asset(&f, &asset(content), &dest, opts()).await.unwrap();
        assert_eq!(f.requested_from.lock().unwrap().len(), 1, "no second fetch");
    }

    #[tokio::test]
    async fn a_partial_file_resumes_from_its_length_and_a_bad_digest_discards_it() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let content = b"hello world!";
        fs::write(part_path(&dest), &content[..5]).unwrap();
        let f = fake(content);
        download_verified_asset(&f, &asset(content), &dest, opts()).await.unwrap();
        assert_eq!(*f.requested_from.lock().unwrap(), vec![5]);
        assert_eq!(fs::read(&dest).unwrap(), content);
        let dest2 = dir.path().join("b.bin");
        let mut wrong = asset(content);
        wrong["sha256"] = json!(digest(b"other"));
        let err = download_verified_asset(&fake(content), &wrong, &dest2, opts()).await.unwrap_err();
        assert!(matches!(err, AssetError::DigestMismatch(_)));
        assert!(!dest2.exists() && !part_path(&dest2).exists());
    }

    #[tokio::test]
    async fn unsafe_or_inconsistent_assets_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a.bin");
        let content = b"abcd";
        let mut http = asset(content);
        http["url"] = json!("http://example.test/a");
        assert!(matches!(download_verified_asset(&fake(content), &http, &dest, opts()).await, Err(AssetError::NotHttps)));
        let mut no_size = asset(content);
        no_size["size"] = json!(0);
        assert!(matches!(download_verified_asset(&fake(content), &no_size, &dest, opts()).await, Err(AssetError::NoSize)));
        let mut redirected = fake(content);
        redirected.https = false;
        assert!(matches!(download_verified_asset(&redirected, &asset(content), &dest, opts()).await, Err(AssetError::RedirectNotHttps)));
        let mut server_error = fake(content);
        server_error.status = 503;
        assert!(matches!(download_verified_asset(&server_error, &asset(content), &dest, opts()).await, Err(AssetError::Http(503, _))));
        // The server sends more than declared.
        let mut oversized = asset(content);
        oversized["size"] = json!(2);
        oversized["sha256"] = json!(digest(&content[..2]));
        assert!(matches!(download_verified_asset(&fake(content), &oversized, &dest, opts()).await, Err(AssetError::Oversize(_))));
        // Less than declared stays resumable.
        let mut short = fake(&content[..2]);
        short.status = 200;
        assert!(matches!(download_verified_asset(&short, &asset(content), &dest, opts()).await, Err(AssetError::Incomplete(_, 2, 4))));
        assert!(part_path(&dest).exists());
        let cancelled = DownloadOptions { cancel: { let c = CancellationToken::new(); c.cancel(); c }, ..opts() };
        assert!(matches!(download_verified_asset(&fake(content), &asset(content), &dest, cancelled).await, Err(AssetError::Aborted)));
    }

    #[tokio::test]
    async fn partial_files_surface_as_paused_installations_and_can_be_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let c = super::super::catalog::tests::catalog(dir.path());
        let weights = c.model_path(&c.model_entry("qwen3.8-27b-q4-k-m").unwrap());
        fs::create_dir_all(weights.parent().unwrap()).unwrap();
        fs::write(part_path(&weights), vec![1u8; 100]).unwrap();
        let status = c.status(Some("win32-x64-nvidia")).await.unwrap();
        let rows = resumable_installations(&c, &status, vec![]).await.unwrap();
        let row = rows.iter().find(|r| r["phase"] == "model").unwrap();
        assert_eq!((row["state"].clone(), row["receivedBytes"].clone()), (json!("paused"), json!(100)));
        // A live row for the same model suppresses the synthetic one.
        let live = vec![json!({"phase": "model", "modelId": "qwen3.8-27b-q4-k-m", "state": "running"})];
        assert_eq!(resumable_installations(&c, &status, live).await.unwrap().iter().filter(|r| r["phase"] == "model").count(), 1);
        discard_downloads(&c, "model", Some("qwen3.8-27b-q4-k-m")).await.unwrap();
        assert!(!part_path(&weights).exists());
        assert!(matches!(discard_downloads(&c, "model", Some("nope")).await, Err(DiscardError::UnknownModel)));
        assert!(matches!(discard_downloads(&c, "bogus", None).await, Err(DiscardError::BadPhase)));
    }
}
