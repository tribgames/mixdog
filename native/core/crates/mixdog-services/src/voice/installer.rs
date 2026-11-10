//! The managed voice runtime download (`voice-runtime-fetcher.mjs` `ensureWhisperRuntime`,
//! `ensureWhisperModel`, `ensureFfmpegRuntime`, driven by `voice-setup.mjs`
//! `ensureVoiceRuntimeReady`): fetch what [`Missing`] names from the bundled manifest, verify
//! its sha256, stage it beside the final directory and publish it with an `active-version`
//! pointer, under a cross-process install lock.
//!
//! Layout: `<data>/voice-runtime/whisper-<ver>-<variant>/` + `active-version`;
//! `<data>/voice/models/<filename>`; `<data>/ffmpeg-runtime/ffmpeg-<ver>/` + `active-version`.
//!
//! Every file operation is a job on the durability lane (or, for hashing, downloading and
//! unpacking, the CPU bulk lane): the functions below `fs`/`with_proof!` are those jobs' bodies.
//! Node's behavior is kept: no retries (a download is one attempt of 180 s, the model's of
//! 1200 s), the lock is polled every 250 ms and reclaimed when its holder is dead, or older
//! than 30 minutes, and a failed install removes its staging directory.

use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::{js_trim, string_to_number};
use mixdog_rt::{DurabilityIo, InLane, LaneToken};
use mixdog_statefile::{Access, Opts, create_new, process_exists, rename_with_retry, write_file};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::runtime::has_data;
use super::setup::{Missing, VoiceInstaller};
use crate::lane::on_lane;
use crate::model_install::{DownloadError, Progress, ProgressSink, Spec, download_once, run_on_lane, sha256_file};
use crate::tidy::extract::extract_zip;

const LOCK_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const LOCK_POLL: Duration = Duration::from_millis(250);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const MODEL_TIMEOUT: Duration = Duration::from_secs(1200);

/// The CUDA toolkit and driver facts a variant's `requires` is matched against.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VariantEnv {
    pub cuda_majors: BTreeSet<u64>,
    pub nvidia_driver: bool,
}

fn env_var<'a>(vars: &'a [(String, String)], name: &str) -> Option<&'a str> {
    // Windows environment names are case-insensitive, as `process.env` is there.
    let same = |key: &str| if cfg!(windows) { key.eq_ignore_ascii_case(name) } else { key == name };
    vars.iter().find(|(key, _)| same(key)).map(|(_, value)| value.as_str()).filter(|value| !value.is_empty())
}

/// The `N` of every `<prefix>N<suffix>` file name in `dir` (a missing or unreadable directory has none).
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn cublas_majors(dir: &Path, pattern: &regex::Regex, found: &mut BTreeSet<u64>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(major) = pattern.captures(&name).and_then(|c| c[1].parse::<u64>().ok()) {
            found.insert(major);
        }
    }
}

/// `detectCudaMajors` + `hasNvidiaDriver`: the CUDA majors with a cuBLAS library in a standard
/// toolkit location or `CUDA_PATH*` (nothing is guessed from `PATH`), and a driver that ships
/// `nvidia-smi.exe` or `nvml.dll` into `System32` (Windows only). macOS uses Metal: neither.
/// Blocking: the body of a durability-lane job.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
pub fn detect_variant_env(vars: &[(String, String)]) -> VariantEnv {
    static WINDOWS_DLL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^cublas64_([0-9]+)\.dll$").expect("static pattern"));
    static LINUX_SO: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^libcublas\.so\.([0-9]+)$").expect("static pattern"));
    static TOOLKIT: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^v[0-9]+\.[0-9]+").expect("static pattern"));
    static CUDA_PATH_VERSIONED: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^CUDA_PATH_V[0-9]+_[0-9]+$").expect("static pattern"));
    let mut found = BTreeSet::new();
    if cfg!(windows) {
        let mut dirs: Vec<PathBuf> = vars
            .iter()
            .filter(|(key, value)| (key == "CUDA_PATH" || CUDA_PATH_VERSIONED.is_match(key)) && !value.is_empty())
            .map(|(_, value)| Path::new(value).join("bin"))
            .collect();
        // `windowsProgramRoots`: only roots the environment defines, de-duplicated, in priority order.
        let mut roots: Vec<&str> = Vec::new();
        for name in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = env_var(vars, name).filter(|root| !roots.contains(root)) {
                roots.push(root);
            }
        }
        for root in roots {
            let standard = Path::new(root).join("NVIDIA GPU Computing Toolkit").join("CUDA");
            let Ok(read) = std::fs::read_dir(&standard) else { continue };
            for entry in read.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if TOOLKIT.is_match(&name) {
                    dirs.push(standard.join(name).join("bin"));
                }
            }
        }
        for dir in dirs {
            cublas_majors(&dir, &WINDOWS_DLL, &mut found);
        }
        let driver = env_var(vars, "SystemRoot")
            .is_some_and(|sys| ["nvidia-smi.exe", "nvml.dll"].iter().any(|file| Path::new(sys).join("System32").join(file).exists()));
        return VariantEnv { cuda_majors: found, nvidia_driver: driver };
    }
    if cfg!(target_os = "macos") {
        return VariantEnv::default();
    }
    let mut dirs: Vec<PathBuf> = env_var(vars, "LD_LIBRARY_PATH").unwrap_or_default().split(':').filter(|p| !p.is_empty()).map(PathBuf::from).collect();
    dirs.extend(["/usr/local/cuda/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"].map(PathBuf::from));
    if let Some(cuda) = env_var(vars, "CUDA_PATH") {
        dirs.push(Path::new(cuda).join("lib64"));
    }
    for dir in dirs {
        cublas_majors(&dir, &LINUX_SO, &mut found);
    }
    VariantEnv { cuda_majors: found, nvidia_driver: false }
}

/// What an installer reads from the host.
pub struct InstallerParts {
    pub data_dir: PathBuf,
    /// The bundled `voice-runtime-manifest.json`.
    pub manifest: Value,
    /// `platformKeyCandidates()`, best first (`tidy::install::platform_key_candidates`).
    pub platform_keys: Vec<String>,
    /// The process environment (`std::env::vars()`), read for the CUDA toolkit and the program
    /// roots at each whisper install, as Node reads `process.env`.
    pub env_vars: Vec<(String, String)>,
    /// `process.pid`: names the staging directory and the install lock.
    pub pid: u32,
    pub durability: DurabilityIo,
    pub bulk: mixdog_rt::CpuBulk,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

pub struct ManagedVoiceInstaller {
    parts: Arc<InstallerParts>,
}

impl ManagedVoiceInstaller {
    pub fn new(parts: InstallerParts) -> Self {
        Self { parts: Arc::new(parts) }
    }
}

#[async_trait]
impl VoiceInstaller for ManagedVoiceInstaller {
    /// `ensureVoiceRuntimeReady`: only the missing pieces, whisper first, then the model, then ffmpeg.
    async fn install(&self, missing: Missing, progress: Option<ProgressSink>) -> Result<(), String> {
        if missing.whisper {
            self.ensure_whisper(progress.clone()).await?;
        }
        if missing.model {
            self.ensure_model(progress.clone()).await?;
        }
        if missing.ffmpeg {
            self.ensure_ffmpeg(progress.clone()).await?;
        }
        Ok(())
    }
}

// ── pure decisions ────────────────────────────────────────────────────────

/// `pickVariant`: the highest CUDA major present, else the NVIDIA-driver variant, else the
/// `requires: null` catch-all. The manifest's array order never decides.
fn pick_variant<'a>(variants: &'a [Value], env: &VariantEnv) -> Option<&'a Value> {
    let mut best: Option<(&Value, u64)> = None;
    for variant in variants {
        let Some(major) = variant.pointer("/requires/cudaMajor").filter(|v| !v.is_null()) else { continue };
        let major = mixdog_js::to_number(major);
        if major.fract() == 0.0 && major >= 0.0 && env.cuda_majors.contains(&(major as u64)) && best.is_none_or(|(_, held)| major as u64 > held) {
            best = Some((variant, major as u64));
        }
    }
    if let Some((variant, _)) = best {
        return Some(variant);
    }
    let driver = variants.iter().find(|v| v.pointer("/requires/nvidiaDriver") == Some(&Value::Bool(true)));
    if env.nvidia_driver && driver.is_some() {
        return driver;
    }
    variants.iter().find(|v| v.get("requires").is_none_or(Value::is_null))
}

/// The refusal when no variant fits the host.
fn no_variant(key: &str, env: &VariantEnv) -> String {
    let cuda = if env.cuda_majors.is_empty() { "none".to_owned() } else { env.cuda_majors.iter().map(|major| major.to_string()).collect::<Vec<_>>().join(",") };
    format!("[voice-runtime] no variant matched on {key} (cuda={cuda} nvidiaDriver={}) and no requires:null fallback in manifest", env.nvidia_driver)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `(bytes / 1024 / 1024).toFixed(0)`: halves round up, as JavaScript rounds them.
fn megabytes(bytes: u64) -> String {
    format!("{}", (bytes as f64 / 1024.0 / 1024.0 + 0.5).floor())
}

fn size(value: &Value) -> u64 {
    value.get("size").and_then(Value::as_u64).unwrap_or(0)
}

fn unsupported(key: &str) -> String {
    format!("voice runtime not supported on {key} — voice transcription is unavailable on this platform")
}

/// `manifestModelEntry`: `models[modelId]`, else the single `model`.
fn model_entry(manifest: &Value) -> Option<&Value> {
    manifest.pointer("/models/standard").or_else(|| manifest.get("model")).filter(|v| !v.is_null())
}

/// What the user sees of a failed download, in Node's words: the fetcher's own text for an HTTP
/// refusal (with the status line's reason), `fetch failed` when the request never got an answer,
/// and the shared download text for everything else (size limits, short bodies, disk).
fn download_text(error: DownloadError, url: &str) -> String {
    match error {
        DownloadError::Http { status, .. } => {
            let reason = reqwest::StatusCode::from_u16(status).ok().and_then(|code| code.canonical_reason()).unwrap_or_default();
            format!("[voice-runtime] download failed {status} {reason} ({url})")
        }
        DownloadError::Network(_) => "fetch failed".to_owned(),
        other => other.to_string(),
    }
}

// ── lane job bodies ───────────────────────────────────────────────────────

/// `rmSync(path, { recursive: true, force: true })`.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn remove_any(path: &Path) {
    let _ = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
}

/// `gcStaleVersions`: everything under `root` that is not the active version, `active-version`
/// or `manifest.json`, and starts with `prefix` or `staging-`.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn gc_stale_versions(root: &Path, active: &str, prefix: &str) {
    let Ok(read) = std::fs::read_dir(root) else { return };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == active || name == "active-version" || name == "manifest.json" {
            continue;
        }
        if name.starts_with(prefix) || name.starts_with("staging-") {
            remove_any(&root.join(name));
        }
    }
}

/// `gcStagingPartials`: `.staging-*` files left by a killed install (a plain file removal, so a
/// directory of that name stays).
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn gc_staging_partials(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        if entry.file_name().to_string_lossy().starts_with(".staging-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `gcUnknownModelFiles`: the models directory holds only the filenames the manifest declares.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn gc_unknown_model_files(manifest: &Value, dir: &Path) {
    let mut keep: BTreeSet<&str> = BTreeSet::new();
    let declared = std::iter::once(manifest.get("model")).chain(manifest.get("models").and_then(Value::as_object).map(|m| m.values()).into_iter().flatten().map(Some));
    for entry in declared.flatten() {
        if let Some(filename) = entry.get("filename").and_then(Value::as_str).filter(|f| !f.is_empty()) {
            keep.insert(filename);
        }
    }
    if keep.is_empty() {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".bin") && !keep.contains(name.as_str()) && std::fs::remove_file(entry.path()).is_ok() {
            mixdog_rt::node_stderr!("[voice-runtime] removed stale model file {name}");
        }
    }
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn exists(path: &Path) -> bool {
    path.exists()
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn make_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

/// `chmodSync(path, 0o755)`; no-op on Windows.
#[cfg(unix)]
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

/// `chmodExtractedBinariesPosix`: a zip does not reliably carry the executable bit.
fn chmod_extracted(root: &Path, executable: &str) {
    let dir = root.join(Path::new(executable).parent().unwrap_or(Path::new("")));
    for path in [root.join(executable), dir.join("whisper-cli"), dir.join("whisper-server"), dir.join("ffmpeg")] {
        if exists(&path) {
            make_executable(&path);
        }
    }
}

/// `extractGz`: the single compressed file to `dest`, flushed to disk.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a bulk-lane job")]
fn extract_gz(archive: &Path, dest: &Path) -> io::Result<()> {
    let mut decoder = flate2::read::GzDecoder::new(std::fs::File::open(archive)?);
    let mut out = std::fs::File::create(dest)?;
    io::copy(&mut decoder, &mut out)?;
    out.flush()?;
    out.sync_all()
}

// ── the install lock ──────────────────────────────────────────────────────

struct Holder {
    pid: f64,
    ts: f64,
    token: String,
}

/// `_readInstallLockToken`: `<pid>\n<ms>`; none when empty or the pid is not a positive number.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn read_holder(lock: &Path) -> Option<Holder> {
    let raw = std::fs::read_to_string(lock).ok()?;
    let raw = js_trim(&raw);
    if raw.is_empty() {
        return None;
    }
    let mut lines = raw.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line));
    let pid_line = lines.next().unwrap_or_default();
    let ts_line = lines.next().unwrap_or_default();
    let (pid, ts) = (string_to_number(pid_line), string_to_number(ts_line));
    (pid.is_finite() && pid > 0.0).then(|| Holder { pid, ts, token: format!("{pid_line}\n{ts_line}") })
}

/// `_installLockTokenMatches`.
fn holder_unchanged(lock: &Path, held: &Holder) -> bool {
    read_holder(lock).is_some_and(|now| now.pid == held.pid && now.ts.to_bits() == held.ts.to_bits() && now.token == held.token)
}

/// `lockAgeMs`: the on-disk timestamp when present, else this waiter's first sighting.
fn lock_age_ms(holder_ts: f64, wait_since: i64, now: i64) -> i64 {
    if holder_ts.is_finite() && holder_ts > 0.0 {
        return now - holder_ts as i64;
    }
    if wait_since != 0 { now - wait_since } else { 0 }
}

#[derive(Clone, Copy, Default)]
struct Waits {
    foreign_since: i64,
    same_pid_since: i64,
}

enum Attempt {
    Held(mixdog_fsio::File),
    /// The lock was reclaimed: try again at once.
    Retry(Waits),
    Wait(Waits),
    Failed(String),
}

/// `EEXIST`, `EPERM`, `EACCES`, `EBUSY`.
fn lock_busy(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::AlreadyExists | io::ErrorKind::PermissionDenied) || error.raw_os_error() == Some(if cfg!(windows) { 32 } else { 16 })
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn try_lock(proof: &InLane<DurabilityIo>, lock: &Path, pid: u32, now: i64, mut waits: Waits) -> Attempt {
    let reclaim = |waits: &mut Waits| {
        let _ = std::fs::remove_file(lock);
        *waits = Waits::default();
    };
    match create_new(proof, lock, Access::Inherit, 0o666) {
        Ok(mut file) => {
            let _ = file.write_all(format!("{pid}\n{now}").as_bytes());
            return Attempt::Held(file);
        }
        Err(error) if !lock_busy(&error) => return Attempt::Failed(error.to_string()),
        Err(_) => {}
    }
    let Some(holder) = read_holder(lock) else {
        reclaim(&mut waits);
        return Attempt::Retry(waits);
    };
    if holder.pid == f64::from(pid) {
        // Another install in this process holds it: wait for its release, unless it outlived the ceiling.
        let age = lock_age_ms(holder.ts, waits.same_pid_since, now);
        if !(holder.ts.is_finite() && holder.ts > 0.0) && waits.same_pid_since == 0 {
            waits.same_pid_since = now;
        }
        if age > LOCK_MAX_AGE_MS && holder_unchanged(lock, &holder) {
            reclaim(&mut waits);
            return Attempt::Retry(waits);
        }
        return Attempt::Wait(waits);
    }
    waits.same_pid_since = 0;
    if !process_exists(holder.pid as u32) {
        reclaim(&mut waits);
        return Attempt::Retry(waits);
    }
    // A live foreign pid: a recycled pid must not block installs forever.
    let age = lock_age_ms(holder.ts, waits.foreign_since, now);
    if waits.foreign_since == 0 {
        waits.foreign_since = now;
    }
    if age > LOCK_MAX_AGE_MS && holder_unchanged(lock, &holder) {
        reclaim(&mut waits);
        return Attempt::Retry(waits);
    }
    Attempt::Wait(waits)
}

/// Every lock file held right now: what `process.on('exit', release)` unlinks when the process
/// ends with an install in flight.
static HELD: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn held() -> std::sync::MutexGuard<'static, Vec<PathBuf>> {
    HELD.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Node's exit handler: unlinks the install locks still held. The daemon calls this on its way
/// out, where a dropped future or `std::process::exit` would leave them behind.
#[allow(clippy::disallowed_methods, reason = "process-exit cleanup: no lane is left to run it")]
pub fn release_held_locks() {
    for path in held().drain(..) {
        let _ = std::fs::remove_file(path);
    }
}

/// The held lock: closed and unlinked by [`ManagedVoiceInstaller::release`]; dropped any other way
/// (a cancelled install), it unlinks itself.
struct Lock {
    file: Option<mixdog_fsio::File>,
    path: PathBuf,
}

impl Lock {
    fn held(file: mixdog_fsio::File, path: PathBuf) -> Self {
        held().push(path.clone());
        Self { file: Some(file), path }
    }

    /// Closes the file and forgets the path; the caller unlinks it.
    fn disarm(mut self) -> PathBuf {
        self.file = None;
        held().retain(|held| *held != self.path);
        std::mem::take(&mut self.path)
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if self.file.take().is_some() {
            release_held_locks_of(&self.path);
        }
    }
}

#[allow(clippy::disallowed_methods, reason = "a cancelled install cleans up after itself without a lane")]
fn release_held_locks_of(path: &Path) {
    held().retain(|held| held != path);
    let _ = std::fs::remove_file(path);
}

/// A body on the durability lane that publishes (it gets the proof `mixdog-statefile` asks for):
/// `with_proof!(self, move |proof| ...)` is a `Result<R, String>`. A macro, so the closure is
/// written at the `submit_wait` call (a closure handed on through a generic `async fn` makes the
/// future's `Send` unprovable for the proof's reference parameter).
macro_rules! with_proof {
    ($installer:expr, $work:expr) => {{
        match $installer.parts.durability.submit_wait(&mixdog_rt::CancellationToken::new(), $work).await {
            Ok(job) => job.await.map_err(|_| "lane job was dropped".to_owned()),
            Err(e) => Err(format!("lane job was not queued: {e:?}")),
        }
    }};
}

// ── the installer ─────────────────────────────────────────────────────────

/// A blocking body on the durability lane. Takes the lane token, not the installer: a step's
/// future then holds no borrow of the installer for it.
async fn fs<R: Send + 'static>(lane: DurabilityIo, work: impl FnOnce() -> R + Send + 'static) -> Result<R, String> {
    on_lane(lane, work).await.map_err(|e| e.to_string())
}

/// The published file is there: drop what it superseded. A free fn over owned values, so its future
/// holds no reference at all.
async fn ready(lane: DurabilityIo, path: PathBuf, root: PathBuf, active: String, prefix: String) -> Result<bool, String> {
    fs(lane, move || {
        let present = has_data(&path);
        if present {
            gc_stale_versions(&root, &active, &prefix);
        }
        present
    })
    .await
}

impl ManagedVoiceInstaller {
    fn now(&self) -> i64 {
        (self.parts.now)()
    }

    fn entry_key(&self, entries: Option<&Value>) -> String {
        let usable = |key: &&String| entries.and_then(|e| e.get(key.as_str())).is_some_and(|v| !v.is_null());
        self.parts.platform_keys.iter().find(usable).or(self.parts.platform_keys.first()).cloned().unwrap_or_default()
    }
}

/// The install steps. Each is a boxed future of its own (`#[async_trait]`): as plain `async fn`s
/// nested six deep, rustc rejected `install` ("implementation of `Send` is not general enough"
/// for `&ManagedVoiceInstaller`). Boxed, each step's future is proven `Send` where it is written,
/// and a caller holds only a `Pin<Box<dyn Future + Send>>` instead of every callee's borrow.
#[async_trait]
trait Steps {
    async fn mkdir(&self, dir: &Path) -> Result<(), String>;
    async fn acquire(&self, root: &Path, name: &str) -> Result<Lock, String>;
    async fn release(&self, lock: Lock);
    async fn download(&self, progress: Option<ProgressSink>, url: &str, dest: &Path, expected: u64, timeout: Duration, phase: &'static str) -> Result<(), String>;
    async fn verify(&self, path: &Path, expected: &str) -> Result<(), String>;
    async fn unzip(&self, archive: &Path, dest: &Path) -> Result<(), String>;
    async fn publish(&self, staging: PathBuf, active_dir: PathBuf, root: PathBuf, active_name: String) -> Result<(), String>;
    async fn ensure_whisper(&self, progress: Option<ProgressSink>) -> Result<(), String>;
    async fn stage_whisper(&self, progress: Option<ProgressSink>, variant: &Value, env: &VariantEnv, key: &str, root: &Path, active_name: &str, command: &Path) -> Result<(), String>;
    async fn begin_staging(&self, root: &Path) -> Result<PathBuf, String>;
    async fn fill_whisper(&self, progress: Option<ProgressSink>, variant: &Value, key: &str, root: &Path, active_name: &str, staging: &Path) -> Result<(), String>;
    async fn extras(&self, progress: Option<ProgressSink>, extras: Option<&Value>, staging: &Path) -> Result<(), String>;
    async fn ensure_model(&self, progress: Option<ProgressSink>) -> Result<(), String>;
    async fn matches_or_removed(&self, path: &Path, expected: &str) -> Result<bool, String>;
    async fn stage_model(&self, progress: Option<ProgressSink>, model: &Value, dir: &Path, path: &Path) -> Result<(), String>;
    async fn fill_model(&self, progress: Option<ProgressSink>, model: &Value, dir: &Path, path: &Path, staging: &Path) -> Result<(), String>;
    async fn ensure_ffmpeg(&self, progress: Option<ProgressSink>) -> Result<(), String>;
    async fn stage_ffmpeg(&self, progress: Option<ProgressSink>, entry: &Value, key: &str, root: &Path, active_name: &str, command: &Path) -> Result<(), String>;
    async fn fill_ffmpeg(&self, progress: Option<ProgressSink>, entry: &Value, key: &str, root: &Path, active_name: &str, staging: &Path) -> Result<(), String>;
}

#[async_trait]
impl Steps for ManagedVoiceInstaller {
    async fn mkdir(&self, dir: &Path) -> Result<(), String> {
        let dir = dir.to_owned();
        fs(self.parts.durability, move || make_dir(&dir)).await?.map_err(|e| e.to_string())
    }

    async fn acquire(&self, root: &Path, name: &str) -> Result<Lock, String> {
        self.mkdir(root).await?;
        let path = root.join(format!(".{name}.lock"));
        let mut waits = Waits::default();
        loop {
            let (lock, now) = (path.clone(), self.now());
            let pid = self.parts.pid;
            // Bound first: the scrutinee's temporaries would otherwise live across the poll sleep.
            let attempt = with_proof!(self, move |proof| try_lock(proof, &lock, pid, now, waits))?;
            match attempt {
                Attempt::Held(file) => return Ok(Lock::held(file, path)),
                Attempt::Failed(error) => return Err(error),
                Attempt::Retry(next) => waits = next,
                Attempt::Wait(next) => {
                    waits = next;
                    tokio::time::sleep(LOCK_POLL).await;
                }
            }
        }
    }

    async fn release(&self, lock: Lock) {
        let path = lock.disarm();
        let _ = fs(self.parts.durability, move || remove_any(&path)).await;
    }

    /// `downloadFile`: one attempt; the destination is removed on any failure.
    async fn download(&self, progress: Option<ProgressSink>, url: &str, dest: &Path, expected: u64, timeout: Duration, phase: &'static str) -> Result<(), String> {
        let sink: Option<ProgressSink> = progress.map(|inner| {
            Arc::new(move |progress: Progress| inner(Progress { label: phase.to_owned(), ..progress })) as ProgressSink
        });
        let limit = if expected == 0 { u64::MAX } else { expected };
        let spec = Spec { url, dest, max_bytes: limit, expected_bytes: expected, label: "voice runtime download", lane: self.parts.bulk };
        let outcome = tokio::time::timeout(timeout, download_once(&spec, sink.as_ref(), &CancellationToken::new())).await;
        match outcome {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(download_text(error, url)),
            Err(_) => {
                let dest = dest.to_owned();
                let _ = fs(self.parts.durability, move || remove_any(&dest)).await;
                Err("The operation was aborted due to timeout".to_owned())
            }
        }
    }

    /// `verifySha256File`.
    async fn verify(&self, path: &Path, expected: &str) -> Result<(), String> {
        let actual = sha256_file(self.parts.bulk, path).await.map_err(|e| e.to_string())?;
        if actual == expected {
            return Ok(());
        }
        Err(format!("[voice-runtime] sha256 mismatch for {}: expected {expected}, got {actual}", path.display()))
    }

    async fn unzip(&self, archive: &Path, dest: &Path) -> Result<(), String> {
        let (archive, dest) = (archive.to_owned(), dest.to_owned());
        // Node names the tool it spawned; the tool's own stderr is not reproducible here.
        let tool = if cfg!(windows) { "Expand-Archive" } else if cfg!(target_os = "linux") { "unzip" } else { "tar" };
        run_on_lane(self.parts.bulk, move || extract_zip(&archive, &dest, |_| false).map(drop).map_err(|e| format!("[voice-runtime] zip extract failed via {tool}: {e}")))
            .await?
    }

    /// `renameWithRetrySync` + the `active-version` pointer, published last.
    async fn publish(&self, staging: PathBuf, active_dir: PathBuf, root: PathBuf, active_name: String) -> Result<(), String> {
        with_proof!(self, move |proof| -> io::Result<()> {
            rename_with_retry(proof, &staging, &active_dir)?;
            write_file(proof, &root.join("active-version"), active_name.as_bytes(), &Opts { fsync_dir: true, ..Opts::default() }).map(drop).map_err(|e| io::Error::other(e.to_string()))
        })?
        .map_err(|e| e.to_string())
    }

    /// `ensureWhisperRuntime`.
    async fn ensure_whisper(&self, progress: Option<ProgressSink>) -> Result<(), String> {
        let manifest = &self.parts.manifest;
        let key = self.entry_key(manifest.get("platforms"));
        let Some(platform) = manifest.pointer(&format!("/platforms/{key}")).filter(|v| !v.is_null()) else { return Err(unsupported(&key)) };
        let variants = platform.get("variants").and_then(Value::as_array).filter(|v| !v.is_empty());
        let Some(variants) = variants else { return Err(format!("[voice-runtime] manifest for {key} has no variants array")) };
        let vars = self.parts.env_vars.clone();
        let detected = fs(self.parts.durability, move || detect_variant_env(&vars)).await?;
        let env = &detected;
        let Some(variant) = pick_variant(variants, env) else {
            return Err(no_variant(&key, env));
        };
        let version = text(manifest, "version");
        let root = self.parts.data_dir.join("voice-runtime");
        let active_name = format!("whisper-{version}-{}", text(variant, "id"));
        let active_dir = root.join(&active_name);
        let command = active_dir.join(text(variant, "executable"));
        if ready(self.parts.durability, command.clone(), root.clone(), active_name.clone(), "whisper-".to_owned()).await? {
            return Ok(());
        }
        let lock = self.acquire(&root, "install").await?;
        let outcome = self.stage_whisper(progress.clone(), variant, env, &key, &root, &active_name, &command).await;
        self.release(lock).await;
        outcome
    }

    async fn stage_whisper(&self, progress: Option<ProgressSink>, variant: &Value, env: &VariantEnv, key: &str, root: &Path, active_name: &str, command: &Path) -> Result<(), String> {
        if ready(self.parts.durability, command.to_owned(), root.to_owned(), active_name.to_owned(), "whisper-".to_owned()).await? {
            return Ok(());
        }
        let staging = self.begin_staging(root).await?;
        mixdog_rt::node_stderr!(
            "[voice-runtime] fetching whisper-{} variant={} for {key} ({} MB; cuda={} nvidiaDriver={}) ...",
            text(&self.parts.manifest, "version"),
            text(variant, "id"),
            megabytes(size(variant)),
            if env.cuda_majors.is_empty() { "none".to_owned() } else { env.cuda_majors.iter().map(u64::to_string).collect::<Vec<_>>().join(",") },
            env.nvidia_driver
        );
        let outcome = self.fill_whisper(progress.clone(), variant, key, root, active_name, &staging).await;
        if outcome.is_err() {
            let staging = staging.clone();
            let _ = fs(self.parts.durability, move || remove_any(&staging)).await;
        }
        outcome
    }

    /// `gcStagingPartials` + `staging-<pid>-<ms>`.
    async fn begin_staging(&self, root: &Path) -> Result<PathBuf, String> {
        let (root, now) = (root.to_owned(), self.now());
        let staging = root.join(format!("staging-{}-{now}", self.parts.pid));
        let made = staging.clone();
        fs(self.parts.durability, move || {
            gc_staging_partials(&root);
            make_dir(&made)
        })
        .await?
        .map_err(|e| e.to_string())?;
        Ok(staging)
    }

    async fn fill_whisper(&self, progress: Option<ProgressSink>, variant: &Value, key: &str, root: &Path, active_name: &str, staging: &Path) -> Result<(), String> {
        let (url, executable) = (text(variant, "url"), text(variant, "executable"));
        let archive = staging.join(format!("whisper.{}", text(variant, "format")));
        let id = text(variant, "id");
        self.download(progress.clone(), url, &archive, size(variant), DOWNLOAD_TIMEOUT, "runtime").await?;
        let sha = text(variant, "sha256");
        if sha.is_empty() {
            return Err(format!("[voice-runtime] manifest variant {id} for {key} missing required sha256"));
        }
        self.verify(&archive, sha).await?;
        self.unzip(&archive, staging).await?;
        let (staged, archived, exec) = (staging.to_owned(), archive.clone(), executable.to_owned());
        let present = fs(self.parts.durability, move || {
            remove_any(&archived);
            chmod_extracted(&staged, &exec);
            exists(&staged.join(&exec))
        })
        .await?;
        if !present {
            return Err(format!("[voice-runtime] expected executable {executable} not present after extract"));
        }
        self.extras(progress.clone(), variant.get("extras"), staging).await?;
        let (active_dir, root_owned) = (root.join(active_name), root.to_owned());
        self.publish(staging.to_owned(), active_dir, root_owned, active_name.to_owned()).await?;
        mixdog_rt::node_stderr!("[voice-runtime] whisper-{} variant={id} ready at {}", text(&self.parts.manifest, "version"), root.join(active_name).display());
        let (root, active) = (root.to_owned(), active_name.to_owned());
        fs(self.parts.durability, move || gc_stale_versions(&root, &active, "whisper-")).await
    }

    /// `processExtras`: supplementary archives whose selected files are lifted into the runtime.
    async fn extras(&self, progress: Option<ProgressSink>, extras: Option<&Value>, staging: &Path) -> Result<(), String> {
        let listed: &[Value] = extras.and_then(Value::as_array).map_or(&[], Vec::as_slice);
        for extra in listed {
            let url = text(extra, "url");
            let tag: String = Sha256::digest(url.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>().chars().take(8).collect();
            let archive = staging.join(format!("extra-{tag}.{}", text(extra, "format")));
            self.download(progress.clone(), url, &archive, size(extra), DOWNLOAD_TIMEOUT, "extra").await?;
            let sha = text(extra, "sha256");
            if sha.is_empty() {
                return Err(format!("[voice-runtime] manifest extra entry missing required sha256: {url}"));
            }
            self.verify(&archive, sha).await?;
            let extract_dir = staging.join(format!(".extra-{tag}"));
            self.mkdir(&extract_dir).await?;
            self.unzip(&archive, &extract_dir).await?;
            let files: Vec<(String, String)> = extra
                .get("files")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|f| (text(f, "from").to_owned(), text(f, "to").to_owned()))
                .collect();
            let (staging, tag_owned) = (staging.to_owned(), tag.clone());
            with_proof!(self, move |proof| -> Result<(), String> {
                for (from, to) in &files {
                    let (src, dst) = (extract_dir.join(from), staging.join(to));
                    if !exists(&src) {
                        return Err(format!("[voice-runtime] extra {tag_owned}: expected file {from} not present after extract"));
                    }
                    if let Some(parent) = dst.parent() {
                        make_dir(parent).map_err(|e| e.to_string())?;
                    }
                    rename_with_retry(proof, &src, &dst).map_err(|e| e.to_string())?;
                }
                // Only the lifted files are kept.
                remove_any(&extract_dir);
                remove_any(&archive);
                Ok(())
            })??;
        }
        Ok(())
    }

    /// `ensureWhisperModel`.
    async fn ensure_model(&self, progress: Option<ProgressSink>) -> Result<(), String> {
        let manifest = &self.parts.manifest;
        let Some(model) = model_entry(manifest) else {
            return Err("[voice-runtime] manifest is missing the `model` section — cannot resolve whisper model".to_owned());
        };
        let dir = self.parts.data_dir.join("voice").join("models");
        let path = dir.join(text(model, "filename"));
        let expected = text(model, "sha256");
        if self.matches_or_removed(&path, expected).await? {
            return Ok(());
        }
        let lock = self.acquire(&dir, "install").await?;
        let outcome = self.stage_model(progress.clone(), model, &dir, &path).await;
        self.release(lock).await;
        outcome
    }

    /// An existing model that has the manifest's digest; one that differs is removed.
    async fn matches_or_removed(&self, path: &Path, expected: &str) -> Result<bool, String> {
        let exists = {
            let path = path.to_owned();
            fs(self.parts.durability, move || exists(&path)).await?
        };
        if !exists {
            return Ok(false);
        }
        let actual = sha256_file(self.parts.bulk, path).await.map_err(|e| e.to_string())?;
        if actual == expected {
            return Ok(true);
        }
        mixdog_rt::node_stderr!("[voice-runtime] model {} sha256 mismatch (expected {expected}, got {actual}) — re-fetching", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default());
        let path = path.to_owned();
        fs(self.parts.durability, move || remove_any(&path)).await?;
        Ok(false)
    }

    async fn stage_model(&self, progress: Option<ProgressSink>, model: &Value, dir: &Path, path: &Path) -> Result<(), String> {
        if self.matches_or_removed(path, text(model, "sha256")).await? {
            let (manifest, dir) = (self.parts.manifest.clone(), dir.to_owned());
            return fs(self.parts.durability, move || gc_unknown_model_files(&manifest, &dir)).await;
        }
        let (partials, now) = (dir.to_owned(), self.now());
        fs(self.parts.durability, move || gc_staging_partials(&partials)).await?;
        let staging = dir.join(format!(".staging-{}-{now}-{}", self.parts.pid, text(model, "filename")));
        let outcome = self.fill_model(progress.clone(), model, dir, path, &staging).await;
        if outcome.is_err() {
            let staging = staging.clone();
            let _ = fs(self.parts.durability, move || remove_any(&staging)).await;
        }
        outcome
    }

    async fn fill_model(&self, progress: Option<ProgressSink>, model: &Value, dir: &Path, path: &Path, staging: &Path) -> Result<(), String> {
        mixdog_rt::node_stderr!("[voice-runtime] fetching model {} ({} MB) from {} ...", text(model, "id"), megabytes(size(model)), text(model, "url"));
        self.download(progress.clone(), text(model, "url"), staging, size(model), MODEL_TIMEOUT, "model").await?;
        self.verify(staging, text(model, "sha256")).await?;
        let (from, to) = (staging.to_owned(), path.to_owned());
        with_proof!(self, move |proof| rename_with_retry(proof, &from, &to))?.map_err(|e| e.to_string())?;
        let (manifest, dir) = (self.parts.manifest.clone(), dir.to_owned());
        fs(self.parts.durability, move || gc_unknown_model_files(&manifest, &dir)).await
    }

    /// `ensureFfmpegRuntime`.
    async fn ensure_ffmpeg(&self, progress: Option<ProgressSink>) -> Result<(), String> {
        let Some(ffmpeg) = self.parts.manifest.get("ffmpeg").filter(|v| !v.is_null()) else {
            return Err("[voice-runtime] manifest is missing the `ffmpeg` section — cannot resolve ffmpeg runtime".to_owned());
        };
        let key = self.entry_key(ffmpeg.get("platforms"));
        let Some(entry) = ffmpeg.pointer(&format!("/platforms/{key}")).filter(|v| !v.is_null()) else { return Err(unsupported(&key)) };
        let root = self.parts.data_dir.join("ffmpeg-runtime");
        let active_name = format!("ffmpeg-{}", text(ffmpeg, "version"));
        let command = root.join(&active_name).join(text(entry, "executable"));
        if ready(self.parts.durability, command.clone(), root.clone(), active_name.clone(), "ffmpeg-".to_owned()).await? {
            return Ok(());
        }
        let lock = self.acquire(&root, "install").await?;
        let outcome = self.stage_ffmpeg(progress.clone(), entry, &key, &root, &active_name, &command).await;
        self.release(lock).await;
        outcome
    }

    async fn stage_ffmpeg(&self, progress: Option<ProgressSink>, entry: &Value, key: &str, root: &Path, active_name: &str, command: &Path) -> Result<(), String> {
        if ready(self.parts.durability, command.to_owned(), root.to_owned(), active_name.to_owned(), "ffmpeg-".to_owned()).await? {
            return Ok(());
        }
        let staging = self.begin_staging(root).await?;
        let outcome = self.fill_ffmpeg(progress.clone(), entry, key, root, active_name, &staging).await;
        if outcome.is_err() {
            let staging = staging.clone();
            let _ = fs(self.parts.durability, move || remove_any(&staging)).await;
        }
        outcome
    }

    async fn fill_ffmpeg(&self, progress: Option<ProgressSink>, entry: &Value, key: &str, root: &Path, active_name: &str, staging: &Path) -> Result<(), String> {
        let (format, executable) = (text(entry, "format"), text(entry, "executable"));
        let archive = staging.join(format!("ffmpeg.{format}"));
        mixdog_rt::node_stderr!("[voice-runtime] fetching {active_name} for {key} ({} MB) ...", megabytes(size(entry)));
        self.download(progress.clone(), text(entry, "url"), &archive, size(entry), DOWNLOAD_TIMEOUT, "ffmpeg").await?;
        let sha = text(entry, "sha256");
        if sha.is_empty() {
            return Err(format!("[voice-runtime] manifest ffmpeg entry for {key} missing required sha256"));
        }
        self.verify(&archive, sha).await?;
        let staged = staging.join(executable);
        match format {
            "gz" => {
                let (from, to) = (archive.clone(), staged.clone());
                run_on_lane(self.parts.bulk, move || extract_gz(&from, &to).map_err(|e| e.to_string())).await??;
            }
            "zip" => self.unzip(&archive, staging).await?,
            other => return Err(format!("[voice-runtime] ffmpeg manifest format must be \"gz\" or \"zip\", got \"{other}\"")),
        }
        let (archived, check) = (archive, staged.clone());
        let present = fs(self.parts.durability, move || {
            remove_any(&archived);
            let present = exists(&check);
            if present {
                make_executable(&check);
            }
            present
        })
        .await?;
        if !present {
            return Err(format!("[voice-runtime] expected ffmpeg executable {executable} not present after extract"));
        }
        self.publish(staging.to_owned(), root.join(active_name), root.to_owned(), active_name.to_owned()).await?;
        mixdog_rt::node_stderr!("[voice-runtime] {active_name} ready at {}", root.join(active_name).display());
        let (root, active) = (root.to_owned(), active_name.to_owned());
        fs(self.parts.durability, move || gc_stale_versions(&root, &active, "ffmpeg-")).await
    }
}

#[cfg(test)]
mod tests;
