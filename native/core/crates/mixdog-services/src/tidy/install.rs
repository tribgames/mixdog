//! Managed engine installs: manifest → download → sha256 → extract → atomic rename into
//! `<data>/tools/<engine>/<version>/`.
//!
//! Policy gating happens before any network call: `never` refuses, `ask` returns `needsApproval`
//! unless the call carried `approveDownloads`, `auto` proceeds. Toolchain engines (rustfmt, gofmt,
//! zig fmt, ...) are never downloadable.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::catalog::engine_entry;
use super::extract::extract_archive;
#[cfg(windows)]
use super::process::RunOptions;
use super::process::Processes;
use crate::lane::{io_on_lane, on_lane};
use crate::local_provider::assets::{Fetcher, sha256_file};
use crate::local_provider::catalog::file_has_data;

const MANIFEST: &str = include_str!("../../data/tidy-engines-manifest.json");
const LABEL: &str = "[tidy-install]";
pub const ENGINE_DIGEST_FILE: &str = ".engine.sha256";
const MAX_NATIVE_BINARY_DOWNLOAD_BYTES: i64 = 256 * 1024 * 1024;
const DEFAULT_STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// A `.tmp-<pid>-<ms>-…` staging dir whose owner crashed is never cleaned by that owner.
const STALE_TMP_AGE_MS: i64 = 60 * 60 * 1000;

pub type OnProgress = Arc<dyn Fn(&str, i64, i64) + Send + Sync>;

/// `{os}-{arch}` in the manifest's naming, best first. Windows on ARM runs x64 programs under
/// its emulation, so a win32-arm64 host also takes the win32-x64 asset.
pub fn platform_key_candidates() -> Vec<String> {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let native = format!("{os}-{arch}");
    if os == "win32" && arch == "arm64" { vec![native, "win32-x64".into()] } else { vec![native] }
}

pub fn read_engines_manifest() -> Value {
    serde_json::from_str(MANIFEST).unwrap_or_else(|_| json!({"version": 1, "engines": {}}))
}

pub fn managed_tools_dir(plugin_data: &Path) -> PathBuf {
    plugin_data.join("tools")
}

pub fn managed_engine_dir(plugin_data: &Path, id: &str, version: &str) -> PathBuf {
    managed_tools_dir(plugin_data).join(id).join(version)
}

pub struct Found<'a> {
    pub entry: &'a Value,
    pub asset: &'a Value,
    pub version: String,
}

pub fn manifest_asset<'a>(manifest: &'a Value, id: &str) -> Option<Found<'a>> {
    let entry = manifest["engines"].get(id)?;
    let assets = entry.get("assets")?;
    let key = platform_key_candidates().into_iter().find(|k| assets.get(k).is_some_and(|a| !a.is_null()));
    let asset = key.as_deref().and_then(|k| assets.get(k)).or_else(|| assets.get("any"))?;
    asset["url"].as_str().filter(|u| !u.is_empty())?;
    Some(Found { entry, asset, version: entry["version"].as_str().unwrap_or("0").to_owned() })
}

fn verified() -> &'static Mutex<HashMap<PathBuf, String>> {
    static VERIFIED: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    VERIFIED.get_or_init(Mutex::default)
}

async fn stamp(lane: DurabilityIo, path: &Path) -> Option<String> {
    let path = path.to_owned();
    on_lane(lane, move || stamp_blocking(&path)).await.ok().flatten()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn stamp_blocking(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?;
    let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{mtime}", m.len()))
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_text(path: &Path) -> std::io::Result<String> {
    fs::read_to_string(path)
}

/// Writes `contents` beside `to` and renames it into place; the temp file does not survive a failure.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_replacing(tmp: &Path, to: &Path, contents: &str) {
    if fs::write(tmp, contents).and_then(|()| fs::rename(tmp, to)).is_err() {
        let _ = fs::remove_file(tmp);
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_tree(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn create_dirs(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The recorded digest decides whether a binary is intact. Only an install from before the
/// record existed has none; there alone the content probe keeps a crash-torn binary from
/// becoming the digest it is trusted by. A binary that cannot be read or hashed is not reused.
pub async fn engine_binary_intact(processes: &Processes, dir: &Path, full: &Path) -> bool {
    let lane = processes.durability();
    let Some(key) = stamp(lane, full).await else { return false };
    if verified().lock().unwrap().get(full) == Some(&key) {
        return true;
    }
    let digest_file = dir.join(ENGINE_DIGEST_FILE);
    let read = {
        let digest_file = digest_file.clone();
        io_on_lane(lane, move || read_text(&digest_file)).await
    };
    let mut recorded = match read {
        Ok(s) => Some(mixdog_js::js_trim(&s).to_lowercase()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return false,
    };
    if recorded.is_none() {
        let probed = full.to_owned();
        if !on_lane(lane, move || file_has_data(&probed)).await.unwrap_or(false) {
            return false;
        }
    }
    let Ok(actual) = sha256_file(lane, full, &CancellationToken::new()).await else { return false };
    if recorded.is_none() {
        // Trust on first use: record the digest beside the binary.
        let tmp = digest_file.with_extension(format!("tmp-{}", std::process::id()));
        let digest = actual.clone();
        let _ = on_lane(lane, move || write_replacing(&tmp, &digest_file, &digest)).await;
        recorded = Some(actual.clone());
    }
    let recorded = recorded.expect("set above");
    if !valid_sha256(&recorded) || actual != recorded {
        return false;
    }
    verified().lock().unwrap().insert(full.to_owned(), key);
    true
}

/// An already-installed managed binary for `id`: `(path, version)`. No network.
pub async fn managed_engine_binary(processes: &Processes, id: &str, manifest: &Value, plugin_data: &Path) -> Option<(PathBuf, String)> {
    let found = manifest_asset(manifest, id)?;
    if plugin_data.as_os_str().is_empty() {
        return None;
    }
    let bin = found.asset["binPath"].as_str().filter(|b| !b.is_empty())?;
    let dir = managed_engine_dir(plugin_data, id, &found.version);
    let full = dir.join(bin);
    engine_binary_intact(processes, &dir, &full).await.then_some((full, found.version))
}

pub async fn verify_download_digest(processes: &Processes, path: &Path, expected: &str) -> Result<String, String> {
    let wanted = expected.to_lowercase();
    if !valid_sha256(&wanted) {
        return Err(format!("{LABEL} manifest sha256 is not a 64-hex digest"));
    }
    let actual = sha256_file(processes.durability(), path, &CancellationToken::new()).await.map_err(|e| e.to_string())?.to_lowercase();
    if actual != wanted {
        return Err(format!("{LABEL} sha256 mismatch: expected {wanted}, got {actual}"));
    }
    Ok(actual)
}

#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub archive: String,
    pub bin_path: String,
    pub bytes: i64,
    pub license: String,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub targets: Vec<Target>,
    pub present: Vec<Value>,
    pub errors: Vec<Value>,
    pub needs_approval: Option<Value>,
}

/// Decides what an install call may do, without touching the network.
pub async fn plan_install(processes: &Processes, ids: &[String], manifest: &Value, plugin_data: &Path, policy: &str, approve_downloads: bool) -> Plan {
    let mut plan = Plan::default();
    let mut pending = Vec::new();
    for id in ids {
        let Some(catalog) = engine_entry(id) else {
            plan.errors.push(json!({"id": id, "error": format!("unknown engine \"{id}\"")}));
            continue;
        };
        if catalog.toolchain {
            plan.errors.push(json!({"id": id, "error": "toolchain engine; install it yourself", "installHint": catalog.install_hint}));
            continue;
        }
        if !catalog.managed {
            plan.errors.push(json!({"id": id, "error": "project-local engine; tidy never downloads it", "installHint": catalog.install_hint}));
            continue;
        }
        let Some(found) = manifest_asset(manifest, id) else {
            plan.errors.push(json!({"id": id, "error": format!("no {} asset in the engines manifest", platform_key_candidates()[0]), "installHint": catalog.install_hint}));
            continue;
        };
        if let Some((path, version)) = managed_engine_binary(processes, id, manifest, plugin_data).await {
            plan.present.push(json!({"id": id, "version": version, "path": path.to_string_lossy()}));
            continue;
        }
        pending.push(Target {
            id: id.clone(),
            version: found.version.clone(),
            url: found.asset["url"].as_str().unwrap_or("").to_owned(),
            sha256: found.asset["sha256"].as_str().unwrap_or("").to_owned(),
            archive: found.asset["archive"].as_str().unwrap_or("none").to_owned(),
            bin_path: found.asset["binPath"].as_str().unwrap_or("").to_owned(),
            bytes: found.asset["bytes"].as_i64().or_else(|| found.asset["size"].as_i64()).unwrap_or(0),
            license: found.entry["license"].as_str().unwrap_or("").to_owned(),
        });
    }
    if pending.is_empty() {
        return plan;
    }
    if policy == "never" {
        for item in &pending {
            plan.errors.push(json!({"id": item.id, "error": "downloads are disabled by policy (tidy.downloads=\"never\")", "installHint": engine_entry(&item.id).map(|e| e.install_hint.clone())}));
        }
        return plan;
    }
    if policy != "auto" && !approve_downloads {
        plan.needs_approval = Some(json!({
            "engines": pending.iter().map(|t| { let mut v = json!({"id": t.id, "version": t.version, "bytes": t.bytes}); if !t.license.is_empty() { v["license"] = json!(t.license); } v }).collect::<Vec<_>>(),
            "bytes": pending.iter().map(|t| t.bytes).sum::<i64>(),
            "reason": "tidy.downloads=\"ask\": re-run with approveDownloads:true to download these engines",
        }));
        return plan;
    }
    plan.targets = pending;
    plan
}

async fn pid_alive(processes: &Processes, pid: u32) -> bool {
    #[cfg(unix)]
    {
        let _ = processes;
        // SAFETY: signal 0 only probes for existence.
        let r = unsafe { libc::kill(pid as i32, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        let cwd = std::env::temp_dir();
        let mut options = RunOptions::new(&cwd);
        options.timeout = Duration::from_secs(10);
        processes.run("tasklist", &["/FI".to_owned(), format!("PID eq {pid}"), "/NH".to_owned()], options).await.stdout.contains(&pid.to_string())
    }
}

/// The `.tmp-<pid>-<ms>-…` staging dirs under an engine root, as `(path, owner pid, started ms)`.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn staging_dirs(engine_root: &Path) -> Vec<(PathBuf, u32, i64)> {
    let Ok(rd) = fs::read_dir(engine_root) else { return Vec::new() };
    rd.flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(".tmp-")?;
            let mut parts = rest.splitn(3, '-');
            let (pid, ms) = (parts.next().and_then(|p| p.parse::<u32>().ok())?, parts.next().and_then(|m| m.parse::<i64>().ok())?);
            Some((entry.path(), pid, ms))
        })
        .collect()
}

/// Removes staging dirs a killed install left behind (dead owner, or ancient).
async fn reclaim_stale_staging(processes: &Processes, engine_root: &Path) {
    let lane = processes.durability();
    let root = engine_root.to_owned();
    let Ok(staged) = on_lane(lane, move || staging_dirs(&root)).await else { return };
    let now = crate::media::store::now_ms();
    let mut stale = Vec::new();
    for (path, pid, ms) in staged {
        let owner_gone = pid != std::process::id() && !pid_alive(processes, pid).await;
        if owner_gone || now - ms >= STALE_TMP_AGE_MS {
            stale.push(path);
        }
    }
    let _ = on_lane(lane, move || stale.iter().for_each(|p| remove_tree(p))).await;
}

/// The archive being written; every call is a lane job, the file passes through by value.
#[allow(clippy::disallowed_types, reason = "touched only by durability-lane jobs")]
struct Partial(fs::File);

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
impl Partial {
    fn create(path: &Path) -> std::io::Result<Self> {
        fs::File::create(path).map(Self)
    }

    fn append(mut self, chunk: &[u8]) -> std::io::Result<Self> {
        std::io::Write::write_all(&mut self.0, chunk)?;
        Ok(self)
    }

    fn finish(self) -> std::io::Result<()> {
        self.0.sync_all()
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
    fs::write(path, contents)
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn path_exists(path: &Path) -> bool {
    path.exists()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn rename_path(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

/// Sizes the archive, unpacks it into `stage` and makes the binary executable; the archive's
/// byte count.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn stage_archive(target: &Target, archive_file: &Path, stage: &Path) -> Result<u64, String> {
    let bytes = fs::metadata(archive_file).map_err(|e| e.to_string())?.len();
    extract_archive(&target.archive, archive_file, stage, &target.bin_path).map_err(|e| e.to_string())?;
    let staged_bin = stage.join(&target.bin_path);
    if !staged_bin.exists() {
        return Err(format!("{LABEL} {}: archive has no {}", target.id, target.bin_path));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&staged_bin, fs::Permissions::from_mode(0o755));
    }
    Ok(bytes)
}

async fn download_asset(lane: DurabilityIo, target: &Target, archive_file: &Path, fetcher: &dyn Fetcher, cancel: &CancellationToken, on_progress: &Option<OnProgress>, stall: Duration) -> Result<(), String> {
    let mut response = fetcher.get(&target.url, 0).await.map_err(|e| format!("{LABEL} {}: {e}", target.id))?;
    if !(200..300).contains(&response.status) {
        return Err(format!("{LABEL} {}: HTTP {} for {}", target.id, response.status, target.url));
    }
    let total = response.content_length.unwrap_or(0);
    if total > MAX_NATIVE_BINARY_DOWNLOAD_BYTES {
        return Err(format!("{LABEL} {}: download exceeds the size limit", target.id));
    }
    let created = archive_file.to_owned();
    let mut file = io_on_lane(lane, move || Partial::create(&created)).await.map_err(|e| e.to_string())?;
    let mut downloaded = 0i64;
    loop {
        // Any bytes prove the connection is alive; silence for `stall` ends the install.
        let chunk = tokio::select! {
            c = mixdog_rt::time::timeout(stall, response.body.next()) => match c {
                Ok(r) => r.map_err(|e| format!("{LABEL} {}: {e}", target.id))?,
                Err(_) => return Err(format!("{LABEL} {}: download stalled (no data for {}s)", target.id, stall.as_secs())),
            },
            _ = cancel.cancelled() => return Err("aborted".into()),
        };
        let Some(chunk) = chunk else { break };
        downloaded += chunk.len() as i64;
        if downloaded > MAX_NATIVE_BINARY_DOWNLOAD_BYTES {
            return Err(format!("{LABEL} {}: download exceeds the size limit", target.id));
        }
        file = io_on_lane(lane, move || file.append(&chunk)).await.map_err(|e| e.to_string())?;
        if let Some(cb) = on_progress {
            cb(&target.id, downloaded, total);
        }
    }
    io_on_lane(lane, move || file.finish()).await.map_err(|e| e.to_string())
}

/// Downloads, verifies and extracts one engine into its versioned managed dir.
pub async fn install_engine(processes: &Processes, target: &Target, plugin_data: &Path, fetcher: &dyn Fetcher, cancel: &CancellationToken, on_progress: Option<OnProgress>, stall: Option<Duration>) -> Result<Value, String> {
    let engine_root = managed_tools_dir(plugin_data).join(&target.id);
    let final_dir = managed_engine_dir(plugin_data, &target.id, &target.version);
    let bin_full = final_dir.join(&target.bin_path);
    // A binary a crash left NUL-filled, or that no longer matches its recorded digest, is
    // not present: it is installed again.
    if engine_binary_intact(processes, &final_dir, &bin_full).await {
        return Ok(json!({"id": target.id, "version": target.version, "path": bin_full.to_string_lossy(), "bytes": 0, "status": "present"}));
    }
    let lane = processes.durability();
    let root = engine_root.clone();
    io_on_lane(lane, move || create_dirs(&root)).await.map_err(|e| e.to_string())?;
    reclaim_stale_staging(processes, &engine_root).await;
    let tmp = engine_root.join(format!(".tmp-{}-{}-{}", std::process::id(), crate::media::store::now_ms(), &uuid::Uuid::new_v4().simple().to_string()[..6]));
    let made = tmp.clone();
    io_on_lane(lane, move || create_dirs(&made)).await.map_err(|e| e.to_string())?;
    let result = async {
        let archive_file = tmp.join(format!("asset-{}", target.id));
        download_asset(lane, target, &archive_file, fetcher, cancel, &on_progress, stall.unwrap_or(DEFAULT_STALL_TIMEOUT)).await?;
        verify_download_digest(processes, &archive_file, &target.sha256).await?;
        let stage = tmp.join("stage");
        let (job_target, job_archive, job_stage) = (target.clone(), archive_file.clone(), stage.clone());
        let bytes = on_lane(lane, move || stage_archive(&job_target, &job_archive, &job_stage)).await.map_err(|e| e.to_string())??;
        let staged_bin = stage.join(&target.bin_path);
        let digest = sha256_file(lane, &staged_bin, cancel).await.map_err(|e| e.to_string())?;
        let digest_path = stage.join(ENGINE_DIGEST_FILE);
        io_on_lane(lane, move || write_file(&digest_path, &digest)).await.map_err(|e| e.to_string())?;
        let existing = final_dir.clone();
        if on_lane(lane, move || path_exists(&existing)).await.unwrap_or(false) && !engine_binary_intact(processes, &final_dir, &bin_full).await {
            verified().lock().unwrap().remove(&bin_full);
            let stale = final_dir.clone();
            let _ = on_lane(lane, move || remove_tree(&stale)).await;
        }
        let (from, to) = (stage.clone(), final_dir.clone());
        if let Err(error) = io_on_lane(lane, move || rename_path(&from, &to)).await {
            // A concurrent install won the race only if the surviving copy verifies.
            if !engine_binary_intact(processes, &final_dir, &bin_full).await {
                return Err(error.to_string());
            }
        }
        Ok(json!({"id": target.id, "version": target.version, "path": bin_full.to_string_lossy(), "bytes": bytes, "status": "installed"}))
    }
    .await;
    let _ = on_lane(lane, move || remove_tree(&tmp)).await;
    result
}

/// Plans and executes installs for `ids`. Never fails for a single engine: each failure lands
/// in `errors` so the report can show the rest.
pub async fn install_engines(processes: &Processes, ids: &[String], manifest: Option<&Value>, plugin_data: &Path, policy: &str, approve_downloads: bool, fetcher: &dyn Fetcher, cancel: &CancellationToken, on_progress: Option<OnProgress>, stall: Option<Duration>) -> Value {
    let loaded = manifest.cloned().unwrap_or_else(read_engines_manifest);
    let plan = plan_install(processes, ids, &loaded, plugin_data, policy, approve_downloads).await;
    let mut installed = plan.present.clone();
    let mut errors = plan.errors.clone();
    if plugin_data.as_os_str().is_empty() && !plan.targets.is_empty() {
        errors.push(json!({"id": "*", "error": "no plugin data directory for managed installs"}));
        return json!({"installed": installed, "errors": errors, "needsApproval": null});
    }
    for target in &plan.targets {
        match install_engine(processes, target, plugin_data, fetcher, cancel, on_progress.clone(), stall).await {
            Ok(done) => installed.push(done),
            Err(error) => errors.push(json!({"id": target.id, "error": error})),
        }
    }
    json!({"installed": installed, "errors": errors, "needsApproval": plan.needs_approval})
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::local_provider::assets::{Body, Fetched};

    struct Chunks(Vec<Vec<u8>>);
    #[async_trait]
    impl Body for Chunks {
        async fn next(&mut self) -> Result<Option<Vec<u8>>, String> {
            Ok(if self.0.is_empty() { None } else { Some(self.0.remove(0)) })
        }
    }

    struct Fake(Vec<u8>, std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl Fetcher for Fake {
        async fn get(&self, _: &str, _: i64) -> Result<Fetched, String> {
            self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Fetched { status: 200, content_length: Some(self.0.len() as i64), https: true, body: Box::new(Chunks(self.0.chunks(3).map(<[u8]>::to_vec).collect())) })
        }
    }

    fn hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A one-engine manifest whose asset is a bare binary for every platform.
    fn manifest(content: &[u8]) -> Value {
        json!({"version": 1, "engines": {"shfmt": {"version": "3.0.0", "license": "BSD", "assets": {"any": {"url": "https://example.test/shfmt", "sha256": hex(content), "archive": "none", "binPath": "shfmt-bin"}}}}})
    }

    #[test]
    fn the_bundled_manifest_covers_the_managed_engines() {
        let m = read_engines_manifest();
        assert!(manifest_asset(&m, "biome").is_some());
        assert!(manifest_asset(&m, "rustfmt").is_none());
        assert!(!platform_key_candidates().is_empty());
    }

    #[tokio::test]
    async fn policy_gates_run_before_any_network_call() {
        let dir = tempfile::tempdir().unwrap();
        let m = manifest(b"binary");
        let ids = vec!["shfmt".to_owned(), "rustfmt".to_owned(), "prettier".to_owned(), "nope".to_owned()];
        let p = Processes::for_tests();
        let ask = plan_install(&p, &ids, &m, dir.path(), "ask", false).await;
        assert!(ask.targets.is_empty());
        assert_eq!(ask.needs_approval.as_ref().unwrap()["engines"][0]["id"], "shfmt");
        assert_eq!(ask.errors.len(), 3, "toolchain, project-local and unknown engines are refused");
        let never = plan_install(&p, &ids, &m, dir.path(), "never", false).await;
        assert!(never.needs_approval.is_none() && never.targets.is_empty());
        assert!(never.errors.iter().any(|e| e["error"].as_str().unwrap().contains("disabled by policy")));
        assert_eq!(plan_install(&p, &ids, &m, dir.path(), "ask", true).await.targets.len(), 1);
        assert_eq!(plan_install(&p, &ids, &m, dir.path(), "auto", false).await.targets.len(), 1);
    }

    #[tokio::test]
    async fn an_install_verifies_extracts_records_a_digest_and_is_then_present() {
        let dir = tempfile::tempdir().unwrap();
        let content = b"binary-bytes";
        let m = manifest(content);
        let fake = Fake(content.to_vec(), Default::default());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let cb: OnProgress = { let seen = seen.clone(); Arc::new(move |id, got, total| seen.lock().unwrap().push((id.to_owned(), got, total))) };
        let p = Processes::for_tests();
        let out = install_engines(&p, &["shfmt".into()], Some(&m), dir.path(), "auto", false, &fake, &CancellationToken::new(), Some(cb), None).await;
        assert_eq!(out["installed"][0]["status"], "installed");
        let bin = managed_engine_dir(dir.path(), "shfmt", "3.0.0").join("shfmt-bin");
        assert_eq!(fs::read(&bin).unwrap(), content);
        assert_eq!(fs::read_to_string(bin.parent().unwrap().join(ENGINE_DIGEST_FILE)).unwrap(), hex(content));
        assert_eq!(seen.lock().unwrap().last().unwrap().1, content.len() as i64);
        assert!(managed_engine_binary(&p, "shfmt", &m, dir.path()).await.is_some());
        let again = install_engines(&p, &["shfmt".into()], Some(&m), dir.path(), "auto", false, &fake, &CancellationToken::new(), None, None).await;
        assert_eq!(again["installed"][0]["version"], "3.0.0");
        assert_eq!(fake.1.load(std::sync::atomic::Ordering::SeqCst), 1, "a present engine is not fetched again");
        // A tampered binary no longer verifies.
        fs::write(&bin, b"tampered!!!!").unwrap();
        verified().lock().unwrap().remove(&bin);
        assert!(managed_engine_binary(&p, "shfmt", &m, dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn a_digest_mismatch_installs_nothing_and_leaves_no_staging() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = manifest(b"expected");
        m["engines"]["shfmt"]["assets"]["any"]["sha256"] = json!(hex(b"expected"));
        let fake = Fake(b"different".to_vec(), Default::default());
        let p = Processes::for_tests();
        let out = install_engines(&p, &["shfmt".into()], Some(&m), dir.path(), "auto", false, &fake, &CancellationToken::new(), None, None).await;
        assert!(out["errors"][0]["error"].as_str().unwrap().contains("sha256 mismatch"));
        assert!(out["installed"].as_array().unwrap().is_empty());
        let root = managed_tools_dir(dir.path()).join("shfmt");
        assert!(fs::read_dir(&root).unwrap().next().is_none(), "staging was removed");
        let none = install_engines(&p, &["shfmt".into()], Some(&m), Path::new(""), "auto", false, &fake, &CancellationToken::new(), None, None).await;
        assert_eq!(none["errors"][0]["id"], "*");
    }
}
