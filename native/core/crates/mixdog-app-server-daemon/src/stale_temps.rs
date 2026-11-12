//! The temp files a 1.4.5 core left in the data folder when it died between creating a temp file and renaming it over its
//! target, reclaimed as Node reclaimed them: a crash capture's temp whose writer is gone
//! (`pruneDaemonCrashCaptures`, `daemon-crash-capture/retention.mjs`) and a session-summary index temp older than ten minutes
//! (`sweepStaleSummaryTempFiles`, `store-summary-index.mjs`), the latter under the index's lock. Other names are never touched.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "housekeeping of a folder's leftovers: the capture reclaim runs before any runtime exists, the summary sweep is a lane job"
)]

use std::path::Path;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_statefile::LockOpts;
use mixdog_statefile::WriteLane;
use tokio_util::sync::CancellationToken;

/// `SUMMARY_TMP_MIN_AGE_MS`.
const SUMMARY_TMP_MIN_AGE: Duration = Duration::from_secs(10 * 60);

fn lower_hex(text: &str, lengths: std::ops::RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn digits(text: &str, len: Option<usize>) -> bool {
    !text.is_empty() && len.is_none_or(|len| text.len() == len) && text.bytes().all(|b| b.is_ascii_digit())
}

/// `SUMMARY_TMP_PATTERN`: `session-summaries.json.mixdog-tmp-<16..24 hex>`, or the cloud-sync-era `.session-summaries.json.<24 hex>.tmp`.
pub fn is_summary_index_temp(name: &str) -> bool {
    if let Some(hex) = name.strip_prefix("session-summaries.json.mixdog-tmp-") {
        return lower_hex(hex, 16..=24);
    }
    name.strip_prefix(".session-summaries.json.").and_then(|rest| rest.strip_suffix(".tmp")).is_some_and(|hex| lower_hex(hex, 24..=24))
}

/// `CAPTURE_TEMP_RE`: `[.]daemon-<yyyymmdd>-<hhmmss>-<launcher pid>-<4 hex>.json.<hex>.tmp` or `….json.mixdog-tmp-<hex>`; the pid of its writer.
fn capture_temp_writer(name: &str) -> Option<u64> {
    let rest = name.strip_prefix('.').unwrap_or(name).strip_prefix("daemon-")?;
    let (day, rest) = rest.split_once('-')?;
    let (time, rest) = rest.split_once('-')?;
    let (pid, rest) = rest.split_once('-')?;
    let (nonce, temp) = rest.split_once(".json.")?;
    let temp_ok = temp.strip_suffix(".tmp").is_some_and(|hex| lower_hex(hex, 1..=usize::MAX))
        || temp.strip_prefix("mixdog-tmp-").is_some_and(|hex| lower_hex(hex, 1..=usize::MAX));
    (digits(day, Some(8)) && digits(time, Some(6)) && digits(pid, None) && lower_hex(nonce, 4..=4) && temp_ok).then(|| pid.parse().unwrap_or(0))
}

/// Removes the crash-capture temps in `dir` whose writer is gone. A live or unidentifiable writer keeps its temp: an unfinished atomic
/// write is not garbage by age. Answers how many.
pub fn reclaim_dead_capture_temps(dir: &Path, alive: &dyn Fn(u32) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Some(writer) = entry.file_name().to_str().and_then(capture_temp_writer) else { continue };
        if writer == 0 || u32::try_from(writer).map_or(true, |pid| alive(pid)) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// `sweepStaleSummaryTempFiles`: under `session-summaries.json.lock`, which every writer of these temps (full rewrite,
/// compaction) holds for its whole write, so no live writer owns a temp the sweep sees. The lock is tried once
/// (`SUMMARY_LOCK_TIMEOUT_MS` 0): a busy lock sweeps nothing. Removes the temps in `dir` last written at least ten minutes
/// before `now`. Answers how many.
pub fn sweep_stale_summary_temps<L: WriteLane>(lane: &InLane<L>, dir: &Path, now: SystemTime) -> usize {
    let opts = LockOpts { timeout: Some(Duration::ZERO), ..LockOpts::default() };
    mixdog_statefile::with_lock(lane, &dir.join("session-summaries.json"), &opts, || remove_aged_summary_temps(dir, now)).unwrap_or(0)
}

fn remove_aged_summary_temps(dir: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(is_summary_index_temp) {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else { continue };
        if now.duration_since(modified).unwrap_or_default() < SUMMARY_TMP_MIN_AGE {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The summary-temp sweep of a serving start, as a maintenance-lane job. Run once the data-directory lock is held. The core
/// writes no summary index of its own, so there is no flush of its to follow: the sweep is the first thing it does to that file.
pub async fn sweep_summary_temps_of_start(tokens: &LaneTokens, data_dir: &Path) -> usize {
    let dir = data_dir.to_path_buf();
    let Ok(job) = tokens.maintenance_io.submit(&CancellationToken::new(), move |lane| sweep_stale_summary_temps(lane, &dir, SystemTime::now())) else {
        return 0;
    };
    job.await.unwrap_or(0)
}