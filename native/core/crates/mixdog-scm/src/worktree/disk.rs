//! Disk estimate for a new worktree: tracked checkout bytes (blob sizes of the base commit's
//! tree) + include copies + a safety margin, compared with free space on the destination volume.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::locks::path_key;
use crate::repo::on_lane;
use crate::worktree::manager::Worktrees;

const MARGIN_MIN_BYTES: u64 = 64 * 1024 * 1024;
pub const FOLDER_SIZE_TTL: Duration = Duration::from_secs(5 * 60);
const FOLDER_WALK_ENTRIES: usize = 250_000;

/// A measured folder size and when it was taken (epoch ms).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measured {
    pub bytes: u64,
    pub complete: bool,
    pub at: i64,
}

struct Slot {
    measured: Option<Measured>,
    /// The walk that will fill or refresh this slot; a forgotten slot is never resurrected by it.
    refresh: Option<u64>,
}

pub type Measure = Arc<dyn Fn(&Path) -> (u64, bool) + Send + Sync>;

/// Per-path folder sizes for the worktree list (Node `cachedFolderBytes`): a fresh entry is
/// returned as is, a stale one at once while one background walk refreshes it, and only a path
/// never measured waits for its walk. `forget` drops an entry (the worktree was removed or created).
#[derive(Default)]
pub struct SizeCache {
    slots: Mutex<HashMap<String, Slot>>,
    walks: AtomicU64,
}

fn epoch_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl SizeCache {
    pub fn forget(&self, path: &Path) {
        if !path.as_os_str().is_empty() {
            self.slots.lock().expect("size cache").remove(&path_key(path));
        }
    }

    fn finish(&self, key: &str, token: u64, measured: Option<Measured>) {
        let mut slots = self.slots.lock().expect("size cache");
        if slots.get(key).and_then(|slot| slot.refresh) != Some(token) {
            return;
        }
        match measured {
            Some(measured) => slots.insert(key.to_owned(), Slot { measured: Some(measured), refresh: None }),
            None => slots.remove(key),
        };
    }

    async fn walk(self: &Arc<Self>, lane: MaintenanceIo, path: &Path, key: &str, token: u64, measure: &Measure, cancel: &CancellationToken) -> Result<Measured, ScmFailure> {
        let (folder, measure) = (path.to_path_buf(), measure.clone());
        let walked = on_lane(lane, cancel, move || measure(&folder)).await;
        match walked {
            Ok((bytes, complete)) => {
                let measured = Measured { bytes, complete, at: epoch_ms() };
                self.finish(key, token, Some(measured));
                Ok(measured)
            }
            Err(failure) => {
                self.finish(key, token, None);
                Err(failure)
            }
        }
    }

    pub async fn get(self: &Arc<Self>, lane: MaintenanceIo, path: &Path, ttl: Duration, measure: Measure, cancel: &CancellationToken) -> Result<Measured, ScmFailure> {
        let key = path_key(path);
        let token = self.walks.fetch_add(1, Ordering::Relaxed) + 1;
        let (cached, start) = {
            let mut slots = self.slots.lock().expect("size cache");
            match slots.get_mut(&key) {
                Some(Slot { measured: Some(measured), refresh }) => {
                    let stale = refresh.is_none() && epoch_ms() - measured.at >= ttl.as_millis() as i64;
                    if stale {
                        *refresh = Some(token);
                    }
                    (Some(*measured), stale)
                }
                _ => {
                    slots.insert(key.clone(), Slot { measured: None, refresh: Some(token) });
                    (None, true)
                }
            }
        };
        match cached {
            Some(measured) => {
                if start {
                    let (cache, folder, key) = (self.clone(), path.to_path_buf(), key.clone());
                    tokio::spawn(async move {
                        let _ = cache.walk(lane, &folder, &key, token, &measure, &CancellationToken::new()).await;
                    });
                }
                Ok(measured)
            }
            None => self.walk(lane, path, &key, token, &measure, cancel).await,
        }
    }
}

impl Worktrees {
    /// The size of a worktree folder through the shared cache.
    pub async fn cached_folder_bytes(&self, path: &Path, cancel: &CancellationToken) -> Result<Measured, ScmFailure> {
        let measure: Measure = Arc::new(|folder| folder_bytes(folder, FOLDER_WALK_ENTRIES));
        self.sizes().get(self.scm().lane, path, FOLDER_SIZE_TTL, measure, cancel).await
    }

    /// Like `list`, with `sizeBytes` and `sizeComplete` on every row (`null` / `true` for a
    /// folder that is gone).
    pub async fn list_with_sizes(
        &self,
        repo_common_dir: Option<&Path>,
        retention: &dyn crate::worktree::manager::Retention,
        cancel: &CancellationToken,
    ) -> Result<Vec<serde_json::Value>, ScmFailure> {
        let mut rows = self.list(repo_common_dir, retention, cancel).await?;
        for row in &mut rows {
            let path = PathBuf::from(row["path"].as_str().unwrap_or_default());
            let present = {
                let path = path.clone();
                on_lane(self.scm().lane, cancel, move || path.exists()).await?
            };
            let measured = if present { Some(self.cached_folder_bytes(&path, cancel).await?) } else { None };
            row["sizeBytes"] = serde_json::json!(measured.map(|m| m.bytes));
            row["sizeComplete"] = serde_json::json!(measured.is_none_or(|m| m.complete));
        }
        Ok(rows)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tracked {
    pub bytes: u64,
    pub files: u64,
    pub submodules: bool,
}

/// Bytes needed for `content` of checkout and copies: the content plus a margin of 10%, at least
/// 64 MiB.
pub fn required_bytes(content: u64) -> u64 {
    content + MARGIN_MIN_BYTES.max(content.div_ceil(10))
}

/// Sum of blob sizes in a `git ls-tree -r -l -z` listing; gitlinks flag submodules.
pub fn parse_tree_sizes(listing: &str) -> Tracked {
    let mut tracked = Tracked::default();
    for record in nul_records(listing) {
        let Some((meta, _path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (_mode, kind, _id, size) = (fields.next(), fields.next(), fields.next(), fields.next());
        match kind {
            Some("commit") => tracked.submodules = true,
            Some("blob") => {
                tracked.files += 1;
                tracked.bytes += size.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            }
            _ => {}
        }
    }
    tracked
}

/// Bytes of the files under `path`; links are not followed and unreadable entries are skipped.
/// The walk stops after `max_entries`, reporting `complete: false` (a lower bound).
pub fn folder_bytes(path: &Path, max_entries: usize) -> (u64, bool) {
    let (mut bytes, mut seen) = (0u64, 0usize);
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > max_entries {
                return (bytes, false);
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                bytes += entry.metadata().map_or(0, |m| m.len());
            }
        }
    }
    (bytes, true)
}

/// Free bytes available to this user on the volume holding the nearest existing ancestor of
/// `path`.
pub fn free_bytes_at(path: &Path) -> Option<u64> {
    let mut dir: PathBuf = path.to_path_buf();
    while !dir.exists() {
        dir = dir.parent()?.to_path_buf();
    }
    fs_free(&dir)
}

#[cfg(unix)]
fn fs_free(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid C string and `stat` a valid out-pointer.
    (unsafe { libc::statvfs(c.as_ptr(), &mut stat) } == 0).then(|| stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(windows)]
fn fs_free(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and `free` a valid out-pointer.
    (unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) } != 0).then_some(free)
}

impl Worktrees {
    pub async fn tracked_checkout_bytes(&self, cwd: &Path, commit: &str, cancel: &CancellationToken) -> Result<Tracked, ScmFailure> {
        let options = RunOptions {
            max_output: Some(1024 * 1024 * 1024),
            ..RunOptions::default()
        };
        let listing = self
            .scm()
            .git
            .text(cancel, cwd, &["ls-tree", "-r", "-l", "-z", "--full-tree", commit], &options)
            .await?;
        Ok(parse_tree_sizes(&listing))
    }

    /// Refuses a worktree the volume cannot hold (`WORKTREE_DISK_INSUFFICIENT`) and one over the
    /// size threshold until the user confirmed (`WORKTREE_LARGE_REPO_CONFIRM`). Returns the
    /// tracked sizes and the bytes needed.
    pub async fn assert_checkout_fits(
        &self,
        cwd: &Path,
        commit: &str,
        extra_bytes: u64,
        root: &Path,
        size_warn_bytes: u64,
        confirm_large: bool,
        cancel: &CancellationToken,
    ) -> Result<(Tracked, u64), ScmFailure> {
        let tracked = self.tracked_checkout_bytes(cwd, commit, cancel).await?;
        let estimate = tracked.bytes + extra_bytes;
        if size_warn_bytes > 0 && estimate >= size_warn_bytes && !confirm_large {
            return Err(ScmFailure::coded(
                crate::worktree::errors::WORKTREE_LARGE_REPO_CONFIRM,
                mixdog_protocol::DomainErrorDetail::WorktreeLargeRepoConfirm {
                    estimate_bytes: estimate,
                    threshold_bytes: size_warn_bytes,
                },
            ));
        }
        let needed = required_bytes(estimate);
        let target = root.to_path_buf();
        let free = on_lane(self.scm().lane, cancel, move || free_bytes_at(&target)).await?;
        if let Some(free) = free.filter(|free| *free < needed) {
            return Err(ScmFailure::coded(
                crate::worktree::errors::WORKTREE_DISK_INSUFFICIENT,
                mixdog_protocol::DomainErrorDetail::WorktreeDiskInsufficient {
                    required_bytes: needed,
                    free_bytes: Some(free),
                    path: root.to_string_lossy().into_owned(),
                    reason: None,
                },
            ));
        }
        Ok((tracked, needed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_listings_sum_blobs_and_flag_submodules() {
        let listing = "100644 blob aaa      12\ta.txt\0100644 blob bbb       3\tdir/b.txt\0160000 commit ccc       -\tsub\0";
        let tracked = parse_tree_sizes(listing);
        assert_eq!((tracked.bytes, tracked.files, tracked.submodules), (15, 2, true));
    }

    #[test]
    fn the_margin_is_a_tenth_with_a_floor() {
        assert_eq!(required_bytes(0), MARGIN_MIN_BYTES);
        assert_eq!(required_bytes(10 * 1024 * 1024 * 1024), 10 * 1024 * 1024 * 1024 + 1024 * 1024 * 1024);
    }

    #[test]
    fn free_space_is_read_from_the_nearest_existing_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes_at(&dir.path().join("not/yet/there")).is_some());
        std::fs::write(dir.path().join("f"), vec![0u8; 100]).unwrap();
        assert_eq!(folder_bytes(dir.path(), 10), (100, true));
    }

    #[tokio::test]
    async fn sizes_are_measured_once_refreshed_in_the_background_when_stale_and_forgotten_on_removal() {
        use std::sync::atomic::AtomicUsize;
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let cache = Arc::new(SizeCache::default());
        let (walks, bytes) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicU64::new(100)));
        let measure: Measure = {
            let (walks, bytes) = (walks.clone(), bytes.clone());
            Arc::new(move |_| {
                walks.fetch_add(1, Ordering::SeqCst);
                (bytes.load(Ordering::SeqCst), true)
            })
        };
        let (path, cancel) = (Path::new("/virtual/worktree-size-cache"), CancellationToken::new());
        let get = |ttl: Duration| cache.get(lane, path, ttl, measure.clone(), &cancel);
        assert_eq!(get(FOLDER_SIZE_TTL).await.unwrap().bytes, 100);
        // Fresh: no walk at all.
        bytes.store(200, Ordering::SeqCst);
        assert_eq!(get(FOLDER_SIZE_TTL).await.unwrap().bytes, 100);
        assert_eq!(walks.load(Ordering::SeqCst), 1);
        // Stale: the cached value at once, one walk in the background.
        assert_eq!(get(Duration::ZERO).await.unwrap().bytes, 100);
        for _ in 0..200 {
            if walks.load(Ordering::SeqCst) == 2 && get(FOLDER_SIZE_TTL).await.unwrap().bytes == 200 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(get(FOLDER_SIZE_TTL).await.unwrap().bytes, 200, "the refreshed size");
        assert_eq!(walks.load(Ordering::SeqCst), 2);
        // A removed (or re-created) worktree is measured again.
        cache.forget(path);
        bytes.store(5, Ordering::SeqCst);
        assert_eq!(get(FOLDER_SIZE_TTL).await.unwrap().bytes, 5);
        assert_eq!(walks.load(Ordering::SeqCst), 3);
    }
}
