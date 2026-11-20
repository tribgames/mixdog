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

/// The least free-space margin kept over the checkout (`disk.mjs:12` `MARGIN_MIN_BYTES`).
pub const MARGIN_MIN_BYTES: u64 = 64 * 1024 * 1024;
/// The margin is one tenth of the content (`disk.mjs:13` `MARGIN_RATIO = 0.1`).
pub const MARGIN_RATIO_DIVISOR: u64 = 10;
pub const FOLDER_SIZE_TTL: Duration = Duration::from_secs(5 * 60);
const FOLDER_WALK_ENTRIES: usize = 250_000;

/// A measured folder size and when it was taken (epoch ms).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measured {
    pub bytes: u64,
    pub complete: bool,
    pub at: i64,
}

/// The walk of one path, as the callers sharing it see it: its result once it ended, whoever started it.
type Flight = Arc<tokio::sync::watch::Sender<Option<Result<Measured, ScmFailure>>>>;

struct Slot {
    measured: Option<Measured>,
    /// The walk that will fill or refresh this slot (its token); a forgotten slot is never resurrected by it.
    refresh: Option<u64>,
    /// That walk's result channel: a caller of a path never measured shares it.
    flight: Option<Flight>,
}

pub type Measure = Arc<dyn Fn(&Path) -> (u64, bool) + Send + Sync>;

/// Per-path folder sizes for the worktree list (Node `cachedFolderBytes`): a fresh entry is
/// returned as is, a stale one at once while one background walk refreshes it, and only a path
/// never measured waits for its walk, which every caller of that path shares. A walk belongs to
/// the cache, not to the caller that started it: it runs, publishes and settles its slot whether
/// or not anyone still awaits it. `forget` drops an entry (the worktree was removed or created).
#[derive(Default)]
pub struct SizeCache {
    slots: Mutex<HashMap<String, Slot>>,
    walks: AtomicU64,
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
    content + MARGIN_MIN_BYTES.max(content.div_ceil(MARGIN_RATIO_DIVISOR))
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
            mixdog_rt::job_progress();
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
        let options = RunOptions { max_output: Some(1024 * 1024 * 1024), ..RunOptions::default() };
        let listing = self.scm().git.text(cancel, cwd, &["ls-tree", "-r", "-l", "-z", "--full-tree", commit], &options).await?;
        Ok(parse_tree_sizes(&listing))
    }

    /// Refuses a worktree the volume cannot hold (`WORKTREE_DISK_INSUFFICIENT`) and one over the
    /// size threshold until the user confirmed (`WORKTREE_LARGE_REPO_CONFIRM`). Returns the
    /// tracked sizes and the bytes needed.
    #[allow(clippy::too_many_arguments, reason = "preserve the established public checkout admission API and its independent size/confirmation inputs")]
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
        // After the disk check, and strictly above the threshold (`manager.mjs:1466`).
        if size_warn_bytes > 0 && estimate > size_warn_bytes && !confirm_large {
            return Err(ScmFailure::coded(
                crate::worktree::errors::WORKTREE_LARGE_REPO_CONFIRM,
                mixdog_protocol::DomainErrorDetail::WorktreeLargeRepoConfirm { estimate_bytes: estimate, threshold_bytes: size_warn_bytes },
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

    /// A measure whose n-th walk ends only once `release(n)` is called, so a test orders the walks itself.
    #[derive(Default)]
    struct Gates {
        started: std::sync::Mutex<usize>,
        released: std::sync::Mutex<usize>,
        moved: std::sync::Condvar,
    }

    impl Gates {
        fn measure(self: &Arc<Self>) -> Measure {
            let gates = self.clone();
            Arc::new(move |_| {
                let mine = {
                    let mut started = gates.started.lock().unwrap();
                    *started += 1;
                    *started
                };
                let mut released = gates.released.lock().unwrap();
                while *released < mine {
                    released = gates.moved.wait(released).unwrap();
                }
                (mine as u64, true)
            })
        }

        fn release(&self, walks: usize) {
            *self.released.lock().unwrap() = walks;
            self.moved.notify_all();
        }

        async fn started(&self, walks: usize) {
            while *self.started.lock().unwrap() < walks {
                tokio::task::yield_now().await;
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn callers_of_a_path_being_measured_share_its_one_walk() {
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (cache, gates, cancel) = (Arc::new(SizeCache::default()), Arc::new(Gates::default()), CancellationToken::new());
        let path = Path::new("/virtual/worktree-size-shared-walk");
        let measure = gates.measure();
        let first = cache.get(lane, path, FOLDER_SIZE_TTL, measure.clone(), &cancel);
        let second = cache.get(lane, path, FOLDER_SIZE_TTL, measure.clone(), &cancel);
        let release = async {
            gates.started(1).await;
            gates.release(1);
        };
        let (first, second, ()) = tokio::join!(first, second, release);
        assert_eq!((first.unwrap().bytes, second.unwrap().bytes), (1, 1));
        assert_eq!(*gates.started.lock().unwrap(), 1, "the second caller shared the walk under way");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_walk_settles_its_slot_when_the_caller_that_started_it_is_gone() {
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (cache, gates, cancel) = (Arc::new(SizeCache::default()), Arc::new(Gates::default()), CancellationToken::new());
        let path = Path::new("/virtual/worktree-size-starter-dropped");
        let measure = gates.measure();
        let mut starter = Box::pin(cache.get(lane, path, FOLDER_SIZE_TTL, measure.clone(), &cancel));
        assert!(futures::poll!(starter.as_mut()).is_pending());
        drop(starter);
        gates.started(1).await;
        let late = cache.get(lane, path, FOLDER_SIZE_TTL, measure.clone(), &cancel);
        let release = async {
            // The late caller is waiting on the walk before it ends.
            tokio::task::yield_now().await;
            gates.release(1);
        };
        let (late, ()) = tokio::join!(late, release);
        assert_eq!(late.unwrap().bytes, 1);
        assert_eq!(*gates.started.lock().unwrap(), 1, "no second walk: the first one published");
        assert_eq!(cache.get(lane, path, FOLDER_SIZE_TTL, measure, &cancel).await.unwrap().bytes, 1, "the slot holds the result");
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_waiter_is_tied_to_the_walk_it_joined_when_the_path_is_forgotten_and_measured_again() {
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let (cache, gates, cancel) = (Arc::new(SizeCache::default()), Arc::new(Gates::default()), CancellationToken::new());
        let path = Path::new("/virtual/worktree-size-forgotten");
        let measure = gates.measure();
        let waiter = tokio::spawn({
            let (cache, measure, cancel) = (cache.clone(), measure.clone(), cancel.clone());
            async move { cache.get(lane, path, FOLDER_SIZE_TTL, measure, &cancel).await }
        });
        gates.started(1).await;
        // The path is forgotten and measured again while the first walk is still running.
        cache.forget(path);
        let again = tokio::spawn({
            let (cache, measure, cancel) = (cache.clone(), measure.clone(), cancel.clone());
            async move { cache.get(lane, path, FOLDER_SIZE_TTL, measure, &cancel).await }
        });
        gates.started(2).await;
        gates.release(2);
        assert_eq!(waiter.await.unwrap().unwrap().bytes, 1, "the first walk's own result");
        assert_eq!(again.await.unwrap().unwrap().bytes, 2);
    }
    #[tokio::test(start_paused = true)]
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
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
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
        let Some(slot) = slots.get_mut(key).filter(|slot| slot.refresh == Some(token)) else {
            return;
        };
        match measured {
            Some(measured) => {
                slot.measured = Some(measured);
                slot.refresh = None;
                slot.flight = None;
            }
            None => {
                slots.remove(key);
            }
        }
    }

    /// Runs the walk on its own task: it settles the slot and publishes to `flight` on every outcome.
    fn start(self: &Arc<Self>, lane: MaintenanceIo, path: &Path, key: String, token: u64, measure: Measure, flight: Flight) {
        let (cache, folder) = (self.clone(), path.to_path_buf());
        tokio::spawn(async move {
            let walked = on_lane(lane, &CancellationToken::new(), move || measure(&folder)).await;
            let result = walked.map(|(bytes, complete)| Measured { bytes, complete, at: epoch_ms() });
            cache.finish(&key, token, result.as_ref().ok().copied());
            flight.send_replace(Some(result));
        });
    }

    pub async fn get(
        self: &Arc<Self>,
        lane: MaintenanceIo,
        path: &Path,
        ttl: Duration,
        measure: Measure,
        cancel: &CancellationToken,
    ) -> Result<Measured, ScmFailure> {
        let key = path_key(path);
        let token = self.walks.fetch_add(1, Ordering::Relaxed) + 1;
        let new_flight = || -> Flight { Arc::new(tokio::sync::watch::channel(None).0) };
        let (cached, flight, started) = {
            let mut slots = self.slots.lock().expect("size cache");
            match slots.get_mut(&key) {
                Some(Slot { measured: Some(measured), refresh, flight }) => {
                    let stale = refresh.is_none() && epoch_ms() - measured.at >= ttl.as_millis() as i64;
                    if stale {
                        *refresh = Some(token);
                        *flight = Some(new_flight());
                    }
                    (Some(*measured), flight.clone().filter(|_| stale), stale)
                }
                Some(slot) => (None, slot.flight.clone(), false),
                None => {
                    let flight = new_flight();
                    slots.insert(key.clone(), Slot { measured: None, refresh: Some(token), flight: Some(flight.clone()) });
                    (None, Some(flight), true)
                }
            }
        };
        if started && let Some(flight) = &flight {
            self.start(lane, path, key, token, measure, flight.clone());
        }
        if let Some(measured) = cached {
            return Ok(measured);
        }
        let mut result = flight.expect("a path never measured has a walk under way").subscribe();
        let cancelled = std::pin::pin!(cancel.cancelled());
        let ended = std::pin::pin!(result.wait_for(Option::is_some));
        match futures::future::select(cancelled, ended).await {
            futures::future::Either::Left(_) => Err(ScmFailure::Cancelled),
            futures::future::Either::Right((Ok(ended), _)) => ended.clone().expect("waited for a result"),
            futures::future::Either::Right((Err(_), _)) => Err(ScmFailure::Cancelled),
        }
    }
}
