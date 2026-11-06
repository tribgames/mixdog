//! `ingest/transcript-discovery.mjs`: which files under the projects root are watchable session
//! transcripts, and which were active recently enough for the safety sweep.

use std::path::{Path, PathBuf};

use mixdog_rt::{CancellationToken, LaneToken, MaintenanceIo};
use mixdog_statefile::{list_dir, metadata};

const ACTIVE_WINDOW_MS: f64 = 30.0 * 60_000.0;

pub fn is_skipped_watch_path(rel_or_base: &str) -> bool {
    rel_or_base.split(['/', '\\']).any(|seg| matches!(seg, "tmp" | "cache" | "plugins"))
}

/// A `.jsonl` that is not a sub-agent's (`agent-` prefix).
pub fn is_transcript_jsonl_name(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.ends_with(".jsonl") && !base.starts_with("agent-")
}

pub fn is_watchable(rel_or_base: &str) -> bool {
    is_transcript_jsonl_name(rel_or_base) && !is_skipped_watch_path(rel_or_base)
}

/// `mtimeMs` of a metadata, as a JS number.
pub fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_secs_f64() * 1000.0)
}

/// An active transcript: its path and `mtimeMs`.
#[derive(Clone, Debug, PartialEq)]
pub struct Active {
    pub path: PathBuf,
    pub mtime: f64,
}

/// Transcripts under `root/<project>/` modified within the active window. An unreadable
/// directory or a vanished file is skipped.
pub async fn discover_active_transcripts(lane: MaintenanceIo, root: &Path, now_ms: f64) -> Vec<Active> {
    let root = root.to_owned();
    let job = lane
        .submit_wait(&CancellationToken::new(), move |lane| {
            let Ok(top) = list_dir(lane, &root) else { return Vec::new() };
            let mut files = Vec::new();
            for dir in top {
                if is_skipped_watch_path(&dir) {
                    continue;
                }
                let full = root.join(&dir);
                let Ok(inner) = list_dir(lane, &full) else { continue };
                for file in inner.into_iter().filter(|f| is_transcript_jsonl_name(f)) {
                    let path = full.join(&file);
                    if let Some(mtime) = metadata(lane, &path).ok().as_ref().and_then(mtime_ms) {
                        files.push(Active { path, mtime });
                    }
                }
            }
            files.into_iter().filter(|f| f.mtime > now_ms - ACTIVE_WINDOW_MS).collect()
        })
        .await;
    match job {
        Ok(job) => job.await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_watcher() {
        assert!(is_watchable("proj/abc.jsonl"));
        assert!(is_watchable("proj\\abc.jsonl"));
        assert!(!is_watchable("proj/agent-abc.jsonl"));
        assert!(!is_watchable("proj/abc.json"));
        assert!(!is_watchable("tmp/abc.jsonl"));
        assert!(!is_watchable("proj/plugins/abc.jsonl"));
        assert!(is_watchable("cached/abc.jsonl"));
    }
}
