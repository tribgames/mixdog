//! Verified downloads and installs of the llama.cpp runtime and models. A download is HTTPS
//! only, size-bounded, resumable from `<file>.part`, and renamed into place only after its
//! SHA-256 matches. Paused or failed installs leave the partial file as durable evidence; it
//! never proves validity, the digest does.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::catalog::{Catalog, ensure_disk_space, exact_file, file_has_data, partial_asset_bytes};
use super::installations::Progress;

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

pub async fn sha256_file(path: &Path, cancel: &CancellationToken) -> Result<String, AssetError> {
    let path = path.to_owned();
    let cancel = cancel.clone();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = fs::File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            if cancel.is_cancelled() {
                return Err(AssetError::Aborted);
            }
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
    })
    .await
    .map_err(|e| AssetError::Other(e.to_string()))?
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

pub struct DownloadOptions {
    pub on_progress: Option<Progress>,
    pub cancel: CancellationToken,
    pub force: bool,
    pub timeout: Duration,
    pub check_disk: bool,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self { on_progress: None, cancel: CancellationToken::new(), force: false, timeout: DOWNLOAD_TIMEOUT, check_disk: true }
    }
}

/// Downloads `asset` (`url`, `size`, `sha256`, optional `name`) to `destination`.
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
    fs::create_dir_all(destination.parent().expect("destination has a parent"))?;
    if !options.force && exact_file(destination, size) && sha256_file(destination, &deadline).await? == sha256 {
        report(&options.on_progress, None, size, size, 100);
        return Ok(destination.to_owned());
    }
    let partial = part_path(destination);
    let mut received = fs::metadata(&partial).map_or(0, |m| m.len() as i64);
    if received > size {
        let _ = fs::remove_file(&partial);
        received = 0;
    }
    if received == size {
        if sha256_file(&partial, &deadline).await? == sha256 {
            fs::rename(&partial, destination)?;
            report(&options.on_progress, None, size, size, 100);
            return Ok(destination.to_owned());
        }
        let _ = fs::remove_file(&partial);
        received = 0;
    }
    let dir = destination.parent().expect("destination has a parent");
    let disk = |need: i64| if options.check_disk { ensure_disk_space(dir, need).map_err(AssetError::Other) } else { Ok(()) };
    disk(size - received)?;
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
        let _ = fs::remove_file(&partial);
        received = 0;
        disk(size)?;
    }
    let mut file = fs::OpenOptions::new().create(true).write(true).append(resumed).truncate(!resumed).open(&partial)?;
    let mut total = received;
    loop {
        let chunk = tokio::select! {
            c = response.body.next() => c.map_err(AssetError::Other)?,
            _ = deadline.cancelled() => return Err(AssetError::Aborted),
        };
        let Some(chunk) = chunk else { break };
        total += chunk.len() as i64;
        if total > size {
            return Err(AssetError::Oversize(name));
        }
        file.write_all(&chunk)?;
        report(&options.on_progress, Some("downloading"), total, size, ((total as f64 / size as f64) * 100.0).round().min(99.0) as i64);
    }
    file.sync_all()?;
    drop(file);
    if total != size {
        return Err(AssetError::Incomplete(name, total, size));
    }
    report(&options.on_progress, Some("verifying"), total, size, 99);
    if sha256_file(&partial, &deadline).await? != sha256 {
        let _ = fs::remove_file(&partial);
        return Err(AssetError::DigestMismatch(name));
    }
    if deadline.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    fs::rename(&partial, destination)?;
    report(&options.on_progress, Some("complete"), total, size, 100);
    Ok(destination.to_owned())
}

/// Windows builds ship as zips (PowerShell's `Expand-Archive`); the macOS build is a gzipped
/// tarball the system `tar` unpacks.
async fn extract_archive(archive: &Path, destination: &Path, cancel: &CancellationToken) -> Result<(), AssetError> {
    let mut cmd = if archive.extension().is_some_and(|e| e == "zip") {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:MIXDOG_LOCAL_ARCHIVE -DestinationPath $env:MIXDOG_LOCAL_DESTINATION -Force"])
            .env("MIXDOG_LOCAL_ARCHIVE", archive)
            .env("MIXDOG_LOCAL_DESTINATION", destination);
        c
    } else {
        let mut c = tokio::process::Command::new("tar");
        c.arg("-xzf").arg(archive).arg("-C").arg(destination);
        c
    };
    cmd.stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let output = tokio::select! {
        o = cmd.output() => o?,
        _ = cancel.cancelled() => return Err(AssetError::Aborted),
    };
    if output.status.success() {
        return Ok(());
    }
    let mut log = String::from_utf8_lossy(&output.stdout).into_owned();
    log.push_str(&String::from_utf8_lossy(&output.stderr));
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
    Err(AssetError::Other(format!("[local-provider] runtime extraction failed: {}", if tail.is_empty() { format!("status {}", output.status) } else { tail.to_owned() })))
}

/// Installs the runtime build for this host; no-op when its executable is already there.
pub async fn install_runtime(catalog: &Catalog, fetcher: &dyn Fetcher, platform_key: &str, progress: Progress, cancel: CancellationToken) -> Result<Value, AssetError> {
    let hardware = catalog.hardware.detect(true).await;
    if cancel.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    let entry = catalog.runtime_platform_entry(platform_key);
    let status = catalog.status(Some(platform_key));
    let Some(entry) = entry.filter(|_| status["available"] == true) else {
        return Err(AssetError::Other("[local-provider] Windows x64 with a compatible NVIDIA RTX GPU, or an Apple Silicon Mac with enough memory, is required".into()));
    };
    let _ = hardware;
    let target = catalog.runtime_directory();
    let executable = entry["executable"].as_str().unwrap_or("");
    if file_has_data(&target.join(executable)) {
        return Ok(catalog.status(Some(platform_key)));
    }
    let total_bytes = entry["downloadBytes"].as_i64().unwrap_or(0);
    ensure_disk_space(&catalog.runtime_root(), total_bytes).map_err(AssetError::Other)?;
    let staging = catalog.runtime_root().join(format!(".staging-{}", std::process::id()));
    let downloads = catalog.runtime_root().join(".downloads");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;
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
            download_verified_asset(fetcher, &asset, &archive, DownloadOptions { on_progress: Some(on_progress), cancel: cancel.clone(), ..Default::default() }).await?;
            let after = completed + asset["size"].as_i64().unwrap_or(0);
            progress(Map::from_iter([
                ("phase".to_owned(), json!("runtime")), ("stage".into(), json!("extracting")),
                ("receivedBytes".into(), json!(after)), ("totalBytes".into(), json!(total_bytes)),
                ("percent".into(), json!((after as f64 / total_bytes as f64 * 100.0).round().min(99.0))),
            ]));
            extract_archive(&archive, &staging, &cancel).await?;
            completed = after;
        }
        if !staging.join(executable).exists() {
            return Err(AssetError::Other(format!("[local-provider] runtime archive did not contain {executable}")));
        }
        if cancel.is_cancelled() {
            return Err(AssetError::Aborted);
        }
        let _ = fs::remove_dir_all(&target);
        fs::rename(&staging, &target)?;
        let _ = fs::remove_dir_all(&downloads);
        Ok(catalog.status(Some(platform_key)))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

/// Downloads one model after checking the runtime and GPU memory.
pub async fn install_model(catalog: &Catalog, fetcher: &dyn Fetcher, entry: &Value, progress: Progress, cancel: CancellationToken) -> Result<Value, AssetError> {
    let hardware = catalog.hardware.detect(true).await;
    if cancel.is_cancelled() {
        return Err(AssetError::Aborted);
    }
    if catalog.status(None)["runtime"]["installed"] != true {
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
    download_verified_asset(fetcher, entry, &catalog.model_path(entry), DownloadOptions { on_progress: Some(on_progress), cancel, ..Default::default() }).await?;
    Ok(catalog.status(None))
}

fn paused_entry(phase: &str, model_id: Option<&str>, received: i64, total: i64) -> Value {
    json!({"phase": phase, "modelId": model_id, "state": "paused", "stage": "paused", "receivedBytes": received, "totalBytes": total,
           "percent": ((received as f64 / total as f64) * 100.0).round().min(99.0)})
}

/// Live installations plus the paused ones the partial files on disk prove after a restart.
pub fn resumable_installations(catalog: &Catalog, status: &Value, live: Vec<Value>) -> Vec<Value> {
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
}

/// Drops a paused or failed installation's downloads. Installed weights and runtimes are
/// untouched; a failed verification only forgets its row (the caller forgets the row).
pub fn discard_downloads(catalog: &Catalog, phase: &str, model_id: Option<&str>) -> Result<(), DiscardError> {
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
        DownloadOptions { check_disk: false, ..Default::default() }
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

    #[test]
    fn partial_files_surface_as_paused_installations_and_can_be_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let c = super::super::catalog::tests::catalog(dir.path());
        let weights = c.model_path(&c.model_entry("qwen3.8-27b-q4-k-m").unwrap());
        fs::create_dir_all(weights.parent().unwrap()).unwrap();
        fs::write(part_path(&weights), vec![1u8; 100]).unwrap();
        let status = c.status(Some("win32-x64-nvidia"));
        let rows = resumable_installations(&c, &status, vec![]);
        let row = rows.iter().find(|r| r["phase"] == "model").unwrap();
        assert_eq!((row["state"].clone(), row["receivedBytes"].clone()), (json!("paused"), json!(100)));
        // A live row for the same model suppresses the synthetic one.
        let live = vec![json!({"phase": "model", "modelId": "qwen3.8-27b-q4-k-m", "state": "running"})];
        assert_eq!(resumable_installations(&c, &status, live).iter().filter(|r| r["phase"] == "model").count(), 1);
        discard_downloads(&c, "model", Some("qwen3.8-27b-q4-k-m")).unwrap();
        assert!(!part_path(&weights).exists());
        assert!(matches!(discard_downloads(&c, "model", Some("nope")), Err(DiscardError::UnknownModel)));
        assert!(matches!(discard_downloads(&c, "bogus", None), Err(DiscardError::BadPhase)));
    }
}
