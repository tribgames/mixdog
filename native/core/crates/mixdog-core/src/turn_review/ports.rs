//! What the turn review needs from the world around it. Each port has one real implementation
//! (composed in `mixdog-app-server-daemon`) and a scripted one in the tests.

use std::path::Path;
use std::sync::Arc;

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
    /// Brings the baseline's current capture up to date; `force` always captures afresh
    /// (`refreshTurnWorktreeSnapshot`).
    async fn refresh(&self, force: bool);
}

#[async_trait]
pub trait ReviewWorktrees: Send + Sync {
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
    async fn run(&self, cwd: &str, args: &[String], input: Vec<u8>) -> Result<GitRun, String>;
}

/// What [`ReviewDisk::current_text`] found.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CurrentText {
    Absent,
    /// Unreadable, binary, large, or reached through a link.
    Unreadable,
    Text(String),
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
    /// Whether `path` is a directory now (`stat(path).isDirectory()`).
    async fn is_dir(&self, path: &Path) -> bool;
    /// `currentText(root, path)`: the recorded file's text now, read only through its recorded
    /// location (never through a link) and only when it is small UTF-8 text.
    async fn current_text(&self, root: &str, path: &str) -> CurrentText;
    /// `Date.now()`.
    fn now_ms(&self) -> f64;
}
