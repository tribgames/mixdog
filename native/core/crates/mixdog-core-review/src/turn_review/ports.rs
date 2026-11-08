//! What the turn review needs from the world around it. Each port has one real implementation
//! (composed in `mixdog-app-server-daemon`) and a scripted one in the tests.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::turn_review::ReviewContent;
use serde_json::Value;

/// The Git baseline of one turn (Node's turn worktree snapshot): the tree of the work tree at the
/// start of the turn, kept so a review has a durable source.
#[async_trait]
pub trait WorktreeBase: Send + Sync {
    /// The canonical top level of the repository the turn ran in.
    fn root(&self) -> String;
    fn baseline_tree(&self) -> String;
    /// The recorded first states of the paths tools wrote (`baselineFiles` values), for the
    /// durable record.
    fn baseline_files(&self) -> Vec<Value>;
    /// A tool is about to replace `path`: its first-before bytes fill holes in the baseline
    /// (`recordTurnWorktreeFileChange`).
    fn record_file_change(&self, path: &str, before: &ReviewContent);
    /// The last refresh's review of the baseline against the worktree (the snapshot's `files`,
    /// `patch` and `patchTruncated`).
    fn review(&self) -> SnapshotReview;
    /// Brings the baseline's current capture up to date; `force` always captures afresh
    /// (`refreshTurnWorktreeSnapshot`).
    async fn refresh(&self, force: bool);
}

/// What a refreshed snapshot holds of its diff.
#[derive(Clone, Default, Debug)]
pub struct SnapshotReview {
    pub files: Vec<crate::turn_review::review_diff::Obj>,
    pub patch: String,
    pub patch_truncated: bool,
}

/// The scope a recorded baseline is re-opened with.
#[derive(Clone, Default, Debug)]
pub struct ResumeScope {
    /// The paths the recording session owns; empty is unscoped.
    pub paths: Vec<String>,
    pub baseline_files: Vec<Value>,
}

#[async_trait]
pub trait ReviewWorktrees: Send + Sync {
    /// `resumeTurnWorktreeSnapshot`: a recorded baseline tree re-opened; `None` when it is gone.
    async fn resume(&self, worktree: &str, baseline_tree: &str, scope: &ResumeScope) -> Option<Arc<dyn WorktreeBase>>;
    /// `resumeTurnWorktreeFilePatch`: one file of a recorded baseline against the worktree now.
    async fn resume_file_patch(&self, worktree: &str, baseline_tree: &str, scope: &ResumeScope, path: &str, old_path: &str, max_bytes: usize) -> Option<crate::turn_review::review_diff::Obj>;
    /// `forgetTurnWorktreeRoot(root)`: the removed and the kept shadow paths.
    async fn forget_root(&self, root: &str) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>);
    /// `createTurnWorktreeSnapshot(worktree)`: `None` outside a repository.
    async fn create(&self, worktree: &str) -> Option<Arc<dyn WorktreeBase>>;
    /// `noteTurnWorktreeChange(paths)`: a boundary signal; `None` means anything may have changed.
    fn note_change(&self, paths: Option<&[String]>);
    /// `canonicalPath(path)`: the path with the symlinks of its nearest existing ancestor
    /// resolved, spelled the way Git reports the root.
    fn canonical_path(&self, path: &str) -> String;
}

pub struct GitRun {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// `runGitOffThread`: one Git child to completion. An `Err` is a spawn failure, a timeout or an
/// output overflow (Node rejects).
#[async_trait]
pub trait ReviewGit: Send + Sync {
    async fn run_with(&self, cwd: &str, args: &[String], input: Vec<u8>, options: &GitOptions) -> Result<GitRun, String>;

    async fn run(&self, cwd: &str, args: &[String], input: Vec<u8>) -> Result<GitRun, String> {
        self.run_with(cwd, args, input, &GitOptions::default()).await
    }
}

/// What runGitOffThread takes besides the arguments.
#[derive(Clone, Debug)]
pub struct GitOptions {
    /// nv: { GIT_INDEX_FILE }: the scratch index a command reads and writes.
    pub index_file: Option<std::path::PathBuf>,
    /// maxBytes: output past it fails the run with [OUTPUT_OVERFLOW].
    pub max_bytes: Option<u64>,
    /// timeoutMs: the child is killed and the run fails once it has run this long.
    pub timeout: Duration,
}

impl Default for GitOptions {
    fn default() -> Self {
        Self { index_file: None, max_bytes: None, timeout: COMMAND_TIMEOUT }
    }
}

/// `COMMAND_TIMEOUT_MS` of `turn-worktree-snapshot.mjs`: every shadow-repository command.
pub const COMMAND_TIMEOUT: Duration = Duration::from_millis(30_000);
/// The `timeoutMs: 300_000` of `scheduleShadowGc`.
pub const GC_TIMEOUT: Duration = Duration::from_millis(300_000);
/// `APPLY_TIMEOUT_MS` of `turn-changes.mjs`: the Git reads and the apply of an Undo/Reapply.
pub const APPLY_TIMEOUT: Duration = Duration::from_millis(60_000);
/// The `timeoutMs: 10_000` of `ignoredChangePaths` (`turn-snapshot.mjs`).
pub const IGNORED_PATHS_TIMEOUT: Duration = Duration::from_millis(10_000);

impl GitOptions {
    pub fn timeout(timeout: Duration) -> Self {
        Self { timeout, ..Self::default() }
    }
}

/// The Err of a run whose output passed maxBytes (Node's EMAXBUFFER).
pub const OUTPUT_OVERFLOW: &str = "EMAXBUFFER";

/// What [`ReviewDisk::current_text`] found.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CurrentText {
    Absent,
    /// Unreadable, binary, large, or reached through a link.
    Unreadable,
    Text(String),
}

/// Synchronous reads for a job that runs on the interactive read lane.
pub trait ReadFs {
    fn read(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>>;
    fn stat(&self, path: &Path) -> std::io::Result<Option<FileStamp>>;
    /// `readdir(path, { withFileTypes })`: `(name, is_file, is_dir)`; a missing directory is empty.
    fn list(&self, path: &Path) -> std::io::Result<Vec<(String, bool, bool)>>;
}

pub type ReadJob = Box<dyn FnOnce(&dyn ReadFs) + Send>;

/// Synchronous file access for a job that runs on the durability lane.
pub trait BlockingFs: ReadFs {
    /// `writeFileAtomicAsync(path, bytes, { createOnly, fsync })`.
    fn write_atomic(&self, path: &Path, bytes: &[u8], create_only: bool, fsync: bool) -> std::io::Result<()>;
    /// `rm(path, { force: true })`.
    fn remove(&self, path: &Path) -> std::io::Result<()>;
    /// `rm(path, { recursive: true, force: true })`.
    fn remove_tree(&self, path: &Path) -> std::io::Result<()>;
    /// `mkdir(path, { recursive: true, mode: 0o700 })`.
    fn create_private_dir_all(&self, path: &Path) -> std::io::Result<()>;
}

pub type BlockingJob = Box<dyn FnOnce(&dyn BlockingFs) + Send>;

/// What `currentFile` finds.
#[derive(Clone, PartialEq, Debug)]
pub enum CurrentFile {
    Absent,
    Unsafe,
    Present { file: std::path::PathBuf, size: u64, sig: String },
}

/// lstat of a path (links are not followed).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LinkStat {
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// mtimeMs and ctimeMs.
    pub mtime_ms: f64,
    pub change_ms: f64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct FileStamp {
    pub mtime_ms: f64,
    pub size: u64,
}

/// The files of the review store (`<data>/turn-snapshots`), on the durability lane.
#[async_trait]
pub trait ReviewDisk: Send + Sync {
    async fn read(&self, path: &Path) -> std::io::Result<Option<Vec<u8>>>;
    async fn stat(&self, path: &Path) -> std::io::Result<Option<FileStamp>>;
    /// Writes by rename, flushed before it is published: a crash must not leave a record that
    /// reads as NUL.
    async fn write_atomic(&self, path: &Path, bytes: Vec<u8>) -> std::io::Result<()>;
    /// Removes a file; a missing one is not an error (`rm({ force: true })`).
    async fn remove(&self, path: &Path) -> std::io::Result<()>;
    async fn list(&self, dir: &Path) -> std::io::Result<Vec<(String, FileStamp)>>;
    async fn create_dir_all(&self, dir: &Path) -> std::io::Result<()>;
    /// lstat(path); a missing path is None.
    async fn lstat(&self, path: &Path) -> std::io::Result<Option<LinkStat>>;
    /// Runs `job` on the durability lane, under `lock`'s file lock (`<lock>.lock`, ten seconds' wait)
    /// when given. A refused lock is the `Err`; the job did not run.
    /// Runs `job` on the interactive read lane, so a read never queues behind writes.
    async fn blocking_read(&self, job: ReadJob) -> std::io::Result<()>;
    async fn blocking(&self, lock: Option<&Path>, job: BlockingJob) -> std::io::Result<()>;
    /// `currentFile({ root, path })` of the session review: the recorded file read under the link
    /// rules of `currentText`.
    async fn current_file(&self, root: &str, path: &str) -> CurrentFile;
    /// `readBounded(file, maxBytes)`: the whole file, `None` when it is larger or cannot be read.
    async fn read_bounded(&self, file: &Path, max_bytes: u64) -> Option<Vec<u8>>;
    /// `fileDigest`: the SHA-256 of a regular file up to `max_bytes`, `None` otherwise.
    async fn file_digest(&self, file: &Path, max_bytes: u64) -> Option<String>;
    /// rename(from, to).
    async fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    /// copyFile(from, to).
    async fn copy_file(&self, from: &Path, to: &Path) -> std::io::Result<()>;
    /// rm(dir, { recursive: true, force: true }).
    async fn remove_tree(&self, dir: &Path) -> std::io::Result<()>;
    /// Whether `path` is a directory now (`stat(path).isDirectory()`).
    async fn is_dir(&self, path: &Path) -> bool;
    /// `currentText(root, path)`: the recorded file's text now, read only through its recorded
    /// location (never through a link) and only when it is small UTF-8 text.
    async fn current_text(&self, root: &str, path: &str) -> CurrentText;
    /// `Date.now()`.
    fn now_ms(&self) -> f64;
}
