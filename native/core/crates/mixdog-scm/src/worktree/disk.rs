//! Disk estimate for a new worktree: tracked checkout bytes (blob sizes of the base commit's
//! tree) + include copies + a safety margin, compared with free space on the destination volume.

use std::path::Path;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::repo::on_lane;
use crate::worktree::manager::Worktrees;

const MARGIN_MIN_BYTES: u64 = 64 * 1024 * 1024;

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
}
