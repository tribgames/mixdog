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

/// `CRASH_CAPTURE_KEEP_BOOTS`, `CRASH_CAPTURE_KEEP_BYTES`, `CRASH_CAPTURE_TAIL_BYTES`.
const CAPTURE_KEEP_BOOTS: usize = 8;
const CAPTURE_KEEP_BYTES: u64 = 2 * 1024 * 1024;
const CAPTURE_TAIL_BYTES: u64 = 256 * 1024;

/// `CAPTURE_STEM_RE`: `daemon-<yyyymmdd>-<hhmmss>-<pid>-<4 hex>`, the stem of a capture's `.err.log` or `.json`; whether the
/// name is the record's.
fn capture_stem(name: &str) -> Option<(&str, bool)> {
    let (stem, record) = match (name.strip_suffix(".err.log"), name.strip_suffix(".json")) {
        (Some(stem), _) => (stem, false),
        (_, Some(stem)) => (stem, true),
        _ => return None,
    };
    let mut parts = stem.strip_prefix("daemon-")?.split('-');
    let (day, time, pid, nonce) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    (parts.next().is_none() && digits(day, Some(8)) && digits(time, Some(6)) && digits(pid, None) && lower_hex(nonce, 4..=4)).then_some((stem, record))
}

/// One boot's capture: its files, their bytes, the newest write among them.
#[derive(Default)]
struct Boot {
    stem: String,
    files: Vec<std::path::PathBuf>,
    bytes: u64,
    modified: Option<SystemTime>,
    record: Option<std::path::PathBuf>,
    raw: Option<(std::path::PathBuf, u64)>,
}

/// `daemonCaptureBootState`: only a proven dead owner makes a boot prunable. An exit the record carries, or a recorded
/// child pid that is gone, is completed (`Some(true)`); a live daemon or a launch still in progress is active (`Some(false)`);
/// a record that is missing or damaged, or a dead launcher that published no child, proves nothing (`None`).
fn boot_completed(boot: &Boot, alive: &dyn Fn(u32) -> bool) -> Option<bool> {
    let record: serde_json::Value = serde_json::from_slice(&std::fs::read(boot.record.as_ref()?).ok()?).ok()?;
    let record = record.as_object()?;
    // `record.exitedAt` as JS reads it: the stamp is a non-empty string.
    if record.get("exitedAt").and_then(serde_json::Value::as_str).is_some_and(|at| !at.is_empty()) {
        return Some(true);
    }
    let pid_of = |key: &str| record.get(key).and_then(serde_json::Value::as_u64).and_then(|pid| u32::try_from(pid).ok());
    match record.get("pid") {
        None | Some(serde_json::Value::Null) => pid_of("launcherPid").is_some_and(alive).then_some(false),
        Some(_) => Some(!pid_of("pid").is_some_and(alive)),
    }
}

/// `trimCaptureTail`: an oversized completed capture keeps its last `max` bytes under a line that says what was dropped
/// (a fatal report is the last thing written). Answers the new size; `None` when the file could not be rewritten.
fn trim_capture_tail(path: &Path, max: u64) -> Option<u64> {
    use std::io::Read;
    use std::io::Seek;
    let size = std::fs::metadata(path).ok()?.len();
    if size <= max {
        return Some(size);
    }
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(std::io::SeekFrom::Start(size - max)).ok()?;
    let mut tail = Vec::with_capacity(max as usize);
    file.take(max).read_to_end(&mut tail).ok()?;
    let mut out = format!("[capture trimmed: dropped {} earlier byte(s)]\n", size - tail.len() as u64).into_bytes();
    out.extend_from_slice(&tail);
    std::fs::write(path, &out).ok()?;
    Some(out.len() as u64)
}

/// The line a trimmed capture opens with.
const TRIMMED_HEAD: &[u8] = b"[capture trimmed: dropped ";

/// Whether the capture is already a trimmed tail: the line and at most the tail's bytes after it. Node trims such a file
/// again at every pass (it is longer than the tail by its own first line), each time dropping a few bytes of evidence
/// under one more line; here it is left as it is.
fn is_trimmed_tail(path: &Path, size: u64) -> bool {
    use std::io::Read;
    let mut head = [0u8; 96];
    let Ok(read) = std::fs::File::open(path).and_then(|mut file| file.read(&mut head)) else { return false };
    let head = &head[..read];
    head.starts_with(TRIMMED_HEAD) && head.iter().position(|b| *b == b'\n').is_some_and(|line| size <= CAPTURE_TAIL_BYTES + line as u64 + 1)
}

/// What one retention pass did (`pruneDaemonCrashCaptures`' answer).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pruned {
    pub removed: usize,
    pub trimmed: usize,
    pub kept_boots: usize,
    pub kept_bytes: u64,
    pub active_boots: usize,
    pub unknown_boots: usize,
}

/// `pruneDaemonCrashCaptures` (`daemon-crash-capture/retention.mjs`): the completed boots share a budget of eight boots and
/// 2 MiB, newest first; an oversized completed capture is trimmed to its last 256 KiB; the newest completed boot is never
/// deleted. Active and unknown boots are never read-modified, trimmed or removed and sit outside the budget: age is not
/// evidence. Nothing outside the captures' own naming is touched.
pub fn prune_crash_captures(dir: &Path, alive: &dyn Fn(u32) -> bool) -> Pruned {
    let Ok(entries) = std::fs::read_dir(dir) else { return Pruned::default() };
    let mut boots: std::collections::HashMap<String, Boot> = std::collections::HashMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some((stem, record)) = name.to_str().and_then(capture_stem) else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let boot = boots.entry(stem.to_owned()).or_insert_with(|| Boot { stem: stem.to_owned(), ..Boot::default() });
        boot.files.push(entry.path());
        boot.bytes += meta.len();
        boot.modified = boot.modified.max(meta.modified().ok());
        if record {
            boot.record = Some(entry.path());
        } else {
            boot.raw = Some((entry.path(), meta.len()));
        }
    }
    let mut ordered: Vec<Boot> = boots.into_values().collect();
    ordered.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.stem.cmp(&a.stem)));
    let mut pruned = Pruned::default();
    let mut newest_completed_seen = false;
    for boot in &ordered {
        match boot_completed(boot, alive) {
            Some(true) => {}
            Some(false) => {
                pruned.active_boots += 1;
                continue;
            }
            None => {
                pruned.unknown_boots += 1;
                continue;
            }
        }
        let newest_completed = !std::mem::replace(&mut newest_completed_seen, true);
        let mut bytes = boot.bytes;
        if let Some((raw, raw_bytes)) = boot.raw.as_ref().filter(|(raw, size)| *size > CAPTURE_TAIL_BYTES && !is_trimmed_tail(raw, *size))
            && let Some(size) = trim_capture_tail(raw, CAPTURE_TAIL_BYTES)
        {
            bytes = bytes - raw_bytes + size;
            pruned.trimmed += 1;
        }
        // The newest completed boot survives even when it alone spends the byte budget: it is the crash to look at.
        if newest_completed || (pruned.kept_boots < CAPTURE_KEEP_BOOTS && pruned.kept_bytes + bytes <= CAPTURE_KEEP_BYTES) {
            pruned.kept_boots += 1;
            pruned.kept_bytes += bytes;
            continue;
        }
        // A locked capture simply stays.
        pruned.removed += boot.files.iter().filter(|file| std::fs::remove_file(file).is_ok()).count();
    }
    pruned
}

#[cfg(test)]
mod capture_retention_tests {
    use super::*;

    fn boot(dir: &Path, stem: &str, record: Option<&str>, raw: usize, age_secs: u64) {
        let at = SystemTime::now() - Duration::from_secs(age_secs);
        let stamp = |path: std::path::PathBuf| std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
        std::fs::write(dir.join(format!("{stem}.err.log")), vec![b'x'; raw]).unwrap();
        stamp(dir.join(format!("{stem}.err.log")));
        if let Some(record) = record {
            std::fs::write(dir.join(format!("{stem}.json")), record).unwrap();
            stamp(dir.join(format!("{stem}.json")));
        }
    }

    /// The states of `daemonCaptureBootState` and the budget of `pruneDaemonCrashCaptures`: completed boots beyond eight
    /// go, oldest first; a live daemon's, a launch in progress and a boot with no readable record stay whatever their age;
    /// the newest completed boot is trimmed to its tail and kept; a file of another name is never touched.
    #[test]
    fn completed_boots_keep_a_budget_and_no_other_boot_is_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let alive = |pid: u32| pid == 7 || pid == 8;
        let exited = r#"{"pid": 1, "exitedAt": "2026-11-13T00:00:00.000Z"}"#;
        for n in 0..10 {
            boot(dir, &format!("daemon-20261113-0000{n:02}-1-00aa"), Some(exited), 100, 1000 + n);
        }
        // Newest of all and completed by a dead child pid: oversized, so trimmed, and never removed.
        boot(dir, "daemon-20261113-010000-2-00bb", Some(r#"{"pid": 2, "exitedAt": null}"#), 300 * 1024, 10);
        boot(dir, "daemon-20261113-020000-7-00cc", Some(r#"{"pid": 7, "exitedAt": null}"#), 100, 5000);
        boot(dir, "daemon-20261113-030000-8-00dd", Some(r#"{"pid": null, "launcherPid": 8}"#), 100, 5000);
        boot(dir, "daemon-20261113-040000-9-00ee", Some(r#"{"pid": null, "launcherPid": 9}"#), 100, 5000);
        boot(dir, "daemon-20261113-050000-9-00ff", Some("not json"), 100, 5000);
        boot(dir, "daemon-20261113-060000-9-0a0a", None, 100, 5000);
        std::fs::write(dir.join("notes.txt"), b"mine").unwrap();

        let pruned = prune_crash_captures(dir, &alive);
        assert_eq!((pruned.active_boots, pruned.unknown_boots, pruned.trimmed), (2, 3, 1));
        // Eleven completed boots, eight kept: the three oldest go, two files each.
        assert_eq!((pruned.kept_boots, pruned.removed), (8, 6));
        for n in 7..10 {
            assert!(!dir.join(format!("daemon-20261113-0000{n:02}-1-00aa.json")).exists(), "boot {n} is beyond the budget");
        }
        let header = "[capture trimmed: dropped 45056 earlier byte(s)]\n";
        let trimmed = std::fs::read(dir.join("daemon-20261113-010000-2-00bb.err.log")).unwrap();
        assert!(trimmed.starts_with(header.as_bytes()));
        assert_eq!(trimmed.len(), header.len() + 256 * 1024);
        for kept in ["daemon-20261113-020000-7-00cc.json", "daemon-20261113-040000-9-00ee.err.log", "daemon-20261113-050000-9-00ff.json", "daemon-20261113-060000-9-0a0a.err.log", "notes.txt"] {
            assert!(dir.join(kept).exists(), "{kept}");
        }
        // A second pass finds nothing more to do.
        let again = prune_crash_captures(dir, &alive);
        assert_eq!((again.removed, again.trimmed, again.kept_boots), (0, 0, 8));
    }
}
