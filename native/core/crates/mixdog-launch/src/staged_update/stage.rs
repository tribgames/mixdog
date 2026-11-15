//! STAGE (`runStagedInstall`): the platform archive of the release feed into `<data>/staging/<version>/`, verified, unpacked, its
//! binary asked for its version, the completion marker written last.

use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use mixdog_ai::netproxy::EnvLookup;
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::netproxy::ProcessEnv;
use mixdog_ai::netproxy::RoutedClients;
use mixdog_ai::netproxy::SystemProxy;
use mixdog_ai::netproxy::system::HANDOFF_VAR;
use mixdog_ai::netproxy::system::WindowsRegistry;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use super::Context;
use super::layout;
use super::lock;

/// The manifest is small; the archive is a binary.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// An archive larger than this is not the CLI.
const MAX_ARCHIVE_BYTES: u64 = 1 << 30;
/// How long a staged binary has to say its version.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What `runStagedInstall` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageOutcome {
    /// The version was staged now: its binary is in place and the marker written.
    Staged { version: String, binary: PathBuf },
    /// The version had been staged before.
    AlreadyStaged { version: String, binary: PathBuf },
    /// Another live worker holds a fresh staging lock for the version.
    InProgress,
    /// Nothing was staged; the text says why. The next launch tries again.
    Failed(String),
}

/// `runStagedInstall(version)`: stages `version` to completion (blocking on the download). Never panics; every failure is
/// [`StageOutcome::Failed`] and leaves no marker.
pub fn run_staged_install(context: &Context, version: &str) -> StageOutcome {
    let version = version.trim();
    if version.is_empty() {
        return StageOutcome::Failed("no version".into());
    }
    let ver_dir = layout::staging_root(context).join(version);
    if layout::is_staged_complete(context, version) {
        return StageOutcome::AlreadyStaged { version: version.to_owned(), binary: ver_dir.join(layout::BIN_SUBDIR).join(layout::binary_name()) };
    }
    if std::fs::create_dir_all(&ver_dir).is_err() {
        return StageOutcome::Failed("staging folder cannot be made".into());
    }
    let lock_file = ver_dir.join(".staging.lock");
    if !lock::claim(context, &lock_file) {
        return StageOutcome::InProgress;
    }
    let outcome = match stage_locked(context, version, &ver_dir) {
        Ok(binary) => StageOutcome::Staged { version: version.to_owned(), binary },
        Err(error) => StageOutcome::Failed(error),
    };
    // Released whatever happened; a worker that died keeps it until its owner is seen gone.
    drop(std::fs::remove_file(&lock_file));
    outcome
}

/// The install proper, with the lock held.
fn stage_locked(context: &Context, version: &str, ver_dir: &Path) -> Result<PathBuf, String> {
    // Fresh staging: clear any partial prior attempt (the lock file stays).
    let download = ver_dir.join("download");
    let bin_dir = ver_dir.join(layout::BIN_SUBDIR);
    layout::remove_dir(&download);
    layout::remove_dir(&bin_dir);
    std::fs::create_dir_all(&download).map_err(|error| format!("download folder: {error}"))?;
    std::fs::create_dir_all(&bin_dir).map_err(|error| format!("binary folder: {error}"))?;
    let staged = fetch_and_unpack(context, version, &download, &bin_dir);
    layout::remove_dir(&download);
    let binary = staged?;
    let said = (context.probe_version)(&binary);
    if said.as_deref() != Some(version) {
        return Err(format!("staged version {} != {version}", said.unwrap_or_else(|| "?".into())));
    }
    write_marker(ver_dir, version, &binary).map_err(|error| format!("marker: {error}"))?;
    Ok(binary)
}

fn fetch_and_unpack(context: &Context, version: &str, download: &Path, bin_dir: &Path) -> Result<PathBuf, String> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| format!("runtime: {error}"))?;
    let archive = download.join("archive.zip");
    runtime.block_on(fetch(context, version, &archive))?;
    unpack(&archive, bin_dir)
}

/// The proxy decision the CLI adopts for its own process (`adoptSystemProxyAsync`, then the environment): the environment's proxy
/// variables with local and LAN hosts direct, the Windows static system proxy when no variable is set. The one resolver is the
/// core's own (`netproxy`).
async fn client_for(url: &str) -> Result<reqwest::Client, String> {
    let system = SystemProxy::default();
    let policy = NetworkProxy::new(Arc::new(ProcessEnv), system.clone());
    system.adopt(&ProcessEnv, ProcessEnv.get(HANDOFF_VAR).as_deref(), cfg!(windows), &WindowsRegistry).await;
    policy.adopt(&Value::Null);
    let clients = RoutedClients::new(policy, |_| reqwest::Client::builder().build());
    clients.download_client_for(url).await.map_err(|error| format!("network: {error}"))
}

/// One asset of the feed.
struct Asset {
    url: String,
    sha256: String,
    size: Option<u64>,
}

/// The manifest's asset of this platform, for `version`.
fn asset_of(manifest: &Value, version: &str, platform: &str) -> Result<Asset, String> {
    let feed_version = manifest.get("version").and_then(Value::as_str).unwrap_or_default();
    if feed_version != version {
        return Err(format!("feed version {} != {version}", if feed_version.is_empty() { "?" } else { feed_version }));
    }
    let asset = manifest.get("assets").and_then(|assets| assets.get(platform)).ok_or_else(|| format!("no {platform} asset in the feed"))?;
    let text = |key: &str| asset.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned();
    let (url, sha256) = (text("url"), text("sha256").to_lowercase());
    if url.is_empty() || sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("the {platform} asset of the feed is incomplete"));
    }
    Ok(Asset { url, sha256, size: asset.get("size").and_then(Value::as_u64) })
}

/// The manifest, then the archive into `archive`, its size and SHA-256 checked against the feed's.
async fn fetch(context: &Context, version: &str, archive: &Path) -> Result<(), String> {
    let client = client_for(&context.feed_url).await?;
    let response = client.get(&context.feed_url).timeout(MANIFEST_TIMEOUT).send().await.map_err(|error| format!("feed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("feed answered {}", response.status()));
    }
    let manifest: Value = serde_json::from_slice(&response.bytes().await.map_err(|error| format!("feed: {error}"))?).map_err(|error| format!("feed: {error}"))?;
    let asset = asset_of(&manifest, version, &context.platform)?;

    let client = client_for(&asset.url).await?;
    let mut response = client.get(&asset.url).timeout(DOWNLOAD_TIMEOUT).send().await.map_err(|error| format!("download: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("download answered {}", response.status()));
    }
    let mut file = std::fs::File::create(archive).map_err(|error| format!("archive: {error}"))?;
    let (mut hasher, mut total) = (Sha256::new(), 0_u64);
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("download: {error}"))? {
        total += chunk.len() as u64;
        if total > MAX_ARCHIVE_BYTES {
            return Err("the archive is larger than a mixdog release".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|error| format!("archive: {error}"))?;
    }
    file.sync_all().map_err(|error| format!("archive: {error}"))?;
    if asset.size.is_some_and(|size| size != total) {
        return Err(format!("archive is {total} bytes, the feed says {}", asset.size.unwrap_or_default()));
    }
    let digest: String = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
    if digest != asset.sha256 {
        return Err("archive does not match the feed's SHA-256".into());
    }
    Ok(())
}

/// The binary of the zip (its file `mixdog` or `mixdog.exe` at any depth, by its file name only: no path of the archive is used)
/// unpacked into `bin_dir` and made executable.
fn unpack(archive: &Path, bin_dir: &Path) -> Result<PathBuf, String> {
    let name = layout::binary_name();
    let file = std::fs::File::open(archive).map_err(|error| format!("archive: {error}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| format!("archive: {error}"))?;
    let target = bin_dir.join(&name);
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| format!("archive: {error}"))?;
        let is_binary = !entry.is_dir() && entry.name().rsplit(['/', '\\']).next() == Some(name.as_str());
        if !is_binary {
            continue;
        }
        let mut out = std::fs::File::create(&target).map_err(|error| format!("binary: {error}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|error| format!("binary: {error}"))?;
        out.sync_all().map_err(|error| format!("binary: {error}"))?;
        #[cfg(unix)]
        std::fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(0o755)).map_err(|error| format!("binary: {error}"))?;
        return Ok(target);
    }
    Err(format!("{name} is not in the archive"))
}

/// The marker, written last and whole: published by a rename so a reader never sees half of it (a marker that reads as not staged
/// would force a full download again).
fn write_marker(ver_dir: &Path, version: &str, binary: &Path) -> std::io::Result<()> {
    let marker = serde_json::json!({ "version": version, "binary": binary.to_string_lossy(), "stagedAt": super::now_ms() as u64 });
    let temp = ver_dir.join(format!("{}.{}.tmp", layout::MARKER_NAME, std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(marker.to_string().as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, layout::marker_path(ver_dir)).inspect_err(|_| drop(std::fs::remove_file(&temp)))
}

/// `<binary> --version` asked for its version: the first word of its output that starts with a digit (a leading `v` dropped).
/// `None` when it cannot be started, says nothing, or does not end within ten seconds.
pub fn probe_binary_version(binary: &Path) -> Option<String> {
    let mut command = std::process::Command::new(binary);
    command.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        drop(stdout.read_to_end(&mut bytes));
        drop(sender.send(bytes));
    });
    let Ok(bytes) = receiver.recv_timeout(PROBE_TIMEOUT) else {
        drop(child.kill());
        drop(child.wait());
        return None;
    };
    let status = child.wait().ok()?;
    if !status.success() {
        return None;
    }
    String::from_utf8_lossy(&bytes)
        .split_whitespace()
        .map(|word| word.strip_prefix('v').unwrap_or(word))
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))
        .map(str::to_owned)
}
