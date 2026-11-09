//! The start of the desktop's one-time `desktop` section separation (`DesktopSettingsStore.separateDefaults`), which
//! Node's app ran at app-ready as `void settingsStore.separateDefaults(dataDir).catch(...)` (`index.ts`): a failure
//! (the backup folder cannot be made, the config cannot be saved) never stopped the app. The catch wrote
//! `defaults-separation-failed {message}` to the desktop's diagnostics log (`<userData>/logs/desktop-diagnostics.jsonl`,
//! `createDesktopDiagnostics`) and the start went on. Nothing was saved, so the marker stayed unset and the next start
//! tried again. Here the daemon runs the pass before it serves `config/*`, and a failure ends the same way.
//!
//! The desktop's profile folder is the one the launcher names (`MIXDOG_DESKTOP_USER_DATA`, D-profile-1). A daemon that
//! was not started by the desktop has no diagnostics log to write, so the failure goes to the daemon log instead. The
//! line carries what the daemon knows of its process; `packaged` and `bootId` are the desktop process's own and are
//! not written.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

use mixdog_core::run_host::run_seams::EnvReader;
use mixdog_core_config::config::Config;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneTokens;
use serde_json::json;

use crate::daemon_log::DaemonLog;

/// The launcher's name for the desktop profile folder.
const PROFILE_ENV: &str = "MIXDOG_DESKTOP_USER_DATA";
/// The event `index.ts` writes for a failed separation.
const EVENT: &str = "defaults-separation-failed";
/// `DEFAULT_MAX_BYTES` of `createDesktopDiagnostics`.
const MAX_BYTES: u64 = 512 * 1024;

/// Runs the separation; a failure is reported and swallowed. Returns after the attempt, so the caller serves `config/*`
/// only once the `desktop` section is separated or the failure is on record.
pub async fn separate(config: &Config, tokens: &LaneTokens, env: &EnvReader, log: &DaemonLog, now_ms: i64) {
    let Err(error) = config.separate_desktop_defaults(now_ms).await else { return };
    let message = error.node_message();
    let Some(profile) = env(PROFILE_ENV).filter(|profile| !profile.is_empty()) else {
        log.log(&format!("the desktop defaults separation failed: {message}"));
        return;
    };
    let file = PathBuf::from(profile).join("logs").join("desktop-diagnostics.jsonl");
    if let Err(error) = append(tokens, file, diagnostic_line(now_ms, &message)).await {
        // `console.warn` in `createDesktopDiagnostics`: the diagnostics log never becomes a new failure path.
        log.log(&format!("Failed to write Mixdog desktop diagnostics: {error}"));
    }
}

/// `createDesktopDiagnostics(...).write('defaults-separation-failed', { message })`, as one line.
pub(crate) fn diagnostic_line(now_ms: i64, message: &str) -> String {
    let at = chrono::DateTime::from_timestamp_millis(now_ms).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default();
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let line = json!({
        "schemaVersion": 1,
        "at": at,
        "event": EVENT,
        "pid": std::process::id(),
        "platform": crate::compose::node_platform(),
        "arch": arch,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "message": message,
    });
    format!("{line}\n")
}

async fn append(tokens: &LaneTokens, file: PathBuf, line: String) -> std::io::Result<()> {
    use mixdog_rt::LaneToken;
    let job = tokens
        .durability_io
        .submit(&tokio_util::sync::CancellationToken::new(), move |lane| write_line(lane, &file, line.as_bytes()))
        .map_err(|_| std::io::Error::other("the durability lane is full"))?;
    job.await.map_err(std::io::Error::other)?
}

/// The write of `createDesktopDiagnostics`: the folder, then a log that would pass `MAX_BYTES` moves to `<file>.1`
/// (the old `.1` removed), then the append.
#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_line(lane: &InLane<DurabilityIo>, file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        mixdog_statefile::create_dir_all(lane, dir)?;
    }
    let existing = match mixdog_statefile::metadata(lane, file) {
        Ok(meta) => meta.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    if existing > 0 && existing + bytes.len() as u64 > MAX_BYTES {
        let mut rotated: OsString = file.as_os_str().to_owned();
        rotated.push(".1");
        match std::fs::remove_file(&rotated) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        std::fs::rename(file, &rotated)?;
    }
    mixdog_statefile::append_file(lane, file, bytes)
}

#[cfg(test)]
mod tests;
