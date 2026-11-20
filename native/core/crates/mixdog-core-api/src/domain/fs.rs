//! The one file service (DS §4.2). Every path-touching feature uses it.
//! Lane-typed: reads need [`InteractiveIo`], writes need [`DurabilityIo`],
//! walks and searches need [`MaintenanceIo`]; the implementation runs each
//! on that lane, never on an async runtime thread.
//!
//! Dropping a returned future or stream cancels a job that has not started;
//! a started write completes atomically. Origin rules and project-boundary
//! checks are applied by the callers' method rows, not by variants here.

use std::time::SystemTime;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::MaintenanceIo;

use super::common::AbsPath;
use super::common::EventSource;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    /// Device, pipe, socket.
    Special,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FileStat {
    pub kind: EntryKind,
    pub len: u64,
    pub modified: Option<SystemTime>,
    /// Node's `ctimeMs`: the inode change time on Unix, the NTFS change time on Windows.
    pub ctime: Option<SystemTime>,
    /// Node's `ino`: the inode on Unix, the file index on Windows.
    pub inode: u128,
    /// Node's `dev`: the device on Unix, the volume serial number on Windows.
    pub device: u64,
    pub readonly: bool,
}

/// Metadata used to rank and display locator results, without a file version.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LocatorStat {
    pub kind: EntryKind,
    pub len: u64,
    pub modified: Option<SystemTime>,
    pub readonly: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DirEntry {
    pub path: AbsPath,
    pub kind: EntryKind,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct ReadRange {
    pub offset: u64,
    /// `None` reads to the end.
    pub max_len: Option<u64>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FileBytes {
    pub offset: u64,
    pub bytes: Vec<u8>,
    /// File length when read.
    pub total_len: u64,
}

/// Compare-and-set condition of a write (DS §4.2 `expectedContent`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum WritePrecondition {
    Unconditional,
    /// The path must not exist.
    Absent,
    /// The current content must equal these bytes.
    ContentEquals(Vec<u8>),
    /// The target must still be the observed file, with the same metadata and bytes.
    FileEquals {
        stat: FileStat,
        bytes: Vec<u8>,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WriteRequest {
    pub path: AbsPath,
    pub content: Vec<u8>,
    pub precondition: WritePrecondition,
}

/// A walk's reach below its root. An entry at depth `max_depth` is listed, never entered; a folder named in `bare`, or a
/// dotted folder when `bare_dotted`, is listed but not entered.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Descent {
    pub max_depth: Option<usize>,
    pub bare: Vec<String>,
    pub bare_dotted: bool,
    /// A name rule the caller keeps entries by: a folder below which the rule keeps nothing is listed but not entered.
    pub guard: Option<NameGuard>,
}

/// The ancestor rule of `list`'s find with a name (`findNameMatcher` over rg's `--iglob`): an entry is kept only when each
/// folder above it, from the root down, matches the name or is neither inside a `noise` folder nor (when `dotted`) dotted
/// itself. So a folder that fails it holds nothing kept, and the walk need not enter it.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct NameGuard {
    /// The name as a regex (a glob's whole pattern) and the same without a leading `**/`; the source of each, as compiled.
    pub whole: Option<String>,
    pub rest: Option<String>,
    /// With neither this nor `whole`, no folder is named: only the noise and dotted rules apply.
    /// Without a glob: the name lowercased, matched as a substring of the lowercased subject.
    pub fragment: Option<String>,
    /// The subject is the folder's path below the root joined by `/` (the name holds a separator), else its own name.
    pub path: bool,
    /// The noise folder names (none when the caller includes noise).
    pub noise: Vec<String>,
    /// A dotted folder fails unless it matches (the caller does not show hidden entries).
    pub dotted: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WalkRequest {
    pub root: AbsPath,
    pub recursive: bool,
    pub include_hidden: bool,
    /// Honour `.gitignore` and friends.
    pub respect_ignore: bool,
    /// With `respect_ignore`, a `.gitignore` counts only inside a git repository (ripgrep's default); `false` honours
    /// it anywhere (Node's fuzzy inventory, serve_search/fuzzy.rs `no_require_git`).
    pub require_git: bool,
    pub include_dirs: bool,
    /// Directories the walk neither lists nor enters.
    pub prune: Vec<AbsPath>,
    /// How far down the walk goes (`rg --max-depth`) and which folders it lists without entering.
    pub descent: Descent,
    /// The search-server request the walk stands for (a glob's `--files` listing, a find's inventory), queued as Node's
    /// server queues it; `None`: a walk Node does not send to its search server, never refused as
    /// [`FsErrorKind::Saturated`].
    pub server: Option<SearchClass>,
}

/// The class of Node's search-server request (serve_search/scheduler.rs:42-49 `search_class`): its queue takes a `Bulk`
/// request while fewer than its capacity less a priority reserve wait, the others while fewer than its capacity wait
/// (serve_search/config.rs:183-192); past that the request is refused ([`FsErrorKind::Saturated`]).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SearchClass {
    /// A content search (no `bulkHint`).
    Interactive,
    /// A `--files` listing, or a content search sent with `bulkHint`.
    Bulk,
    /// A find's fuzzy query.
    Fuzzy,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SearchRequest {
    pub root: AbsPath,
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub include_globs: Vec<String>,
    pub exclude_globs: Vec<String>,
    pub include_hidden: bool,
    pub respect_ignore: bool,
    /// A match may span lines (Node's `-U --multiline-dotall`): `.` matches a line break too, and each line of a match
    /// is a [`SearchMatch`] of its own.
    pub multiline: bool,
    /// The pattern is compiled by PCRE2 (Node's `-P`), which takes the lookarounds and backreferences the default
    /// engine refuses.
    pub pcre2: bool,
    /// A file holding a NUL byte is searched as text (Node's `--text`); otherwise its search stops at its first NUL.
    pub binary_as_text: bool,
    /// The scan stops after this many [`SearchMatch`] items, one per printed line, so a [`SearchRequest::multiline`]
    /// match spends one per line it spans (Node's search server, `collect_until`, counts output lines); `None` reads every match.
    pub limit: Option<usize>,
    /// Each file's search stops at its first match, as the search server's file list stops a file
    /// (`--files-with-matches`: grep-printer's summary printer, `PathWithMatch`, quits a file at its first match), so
    /// the rest of the file is not read.
    pub first_per_file: bool,
    /// The search server's soft deadline (Node's request `deadlineMs`): once it passes the stream ends with a
    /// [`FsErrorKind::TimedOut`] item after what was found; `None` has no deadline.
    pub deadline: Option<std::time::Instant>,
    /// The search-server request class the search stands for, for its queue's admission ([`SearchClass`]).
    pub class: SearchClass,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SearchMatch {
    pub path: AbsPath,
    /// 1-based.
    pub line: u64,
    /// 1-based byte column.
    pub column: u64,
    /// The line as Node's search server prints it: without its terminator, a long line clipped and marked.
    pub text: String,
    /// What the line adds to its file's count (Node's `--count`, grep-printer's summary printer): 1 in a line-by-line
    /// search; in a [`SearchRequest::multiline`] one, the first line of a match counts every match its lines hold and
    /// the lines after it 0.
    pub count: u64,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum FsErrorKind {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotADirectory,
    IsADirectory,
    /// Not a regular file (device, pipe, socket).
    Special,
    /// Compare-and-set mismatch; `actual` is the current content, `None`
    /// when the path is absent.
    PreconditionFailed {
        actual: Option<Vec<u8>>,
    },
    /// A multi-step operation failed after it may have changed the disk.
    OutcomeUnknown,
    /// The caller's cancellation arrived before a write was published: the target was not replaced. `left` names what
    /// the cancelled write could not clean up (its temp file, or the empty placeholder a create claimed at the target)
    /// and is still on disk; empty when nothing was left behind.
    Cancelled {
        left: Vec<AbsPath>,
    },
    Io {
        os_code: Option<i32>,
    },
    /// `search_text` with `regex: true` got a pattern that does not parse;
    /// `message` is the parser's text as Node shows it
    /// (`regex parse error: …`), passed through verbatim.
    InvalidPattern {
        message: String,
    },
    /// The last item of a `search_text` stream whose [`SearchRequest::deadline`] passed: the matches before it are what
    /// the search found (Node's server answers them as `partial`, `timeout`). The error's path, when set, is the file
    /// whose search the deadline cut: matches of it already given are not whole and are dropped, as Node's server
    /// drops a file its deadline interrupted (`serve_search/search.rs`, the swallowed mid-file expiry).
    TimedOut,
    /// The only item of a `walk` or `search_text` stream refused because as many searches already wait as Node's search
    /// server queues for its [`SearchClass`] ("native search queue saturated", serve_search/server.rs:370-383).
    Saturated,
    /// The only item of a `walk` or `search_text` stream refused because the volume it would read on holds as many reads
    /// that ignored their cancel as the service keeps: Node's answer to a request whose server its client ended for a
    /// search that did not stop within `grace_ms` of its cancel (NATIVE_SEARCH_CANCEL_STALLED,
    /// native-search-client.mjs:501-520). `search` is Node's name for that search's request (`requestKind`: `content`,
    /// `file inventory`, `fuzzy`).
    CancelStalled {
        search: String,
        grace_ms: u64,
    },
}

/// The step of an atomic write that failed (Node's `atomicWrite` names it in its error text).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum FsStep {
    /// Creating the temp file.
    Open {
        path: AbsPath,
    },
    /// Writing the content to the temp file.
    Write,
    /// Syncing the temp file (a code the filesystem is allowed to refuse is not a failure).
    Fsync,
    /// Replacing the target with the temp file, after the retries.
    Rename {
        from: AbsPath,
        to: AbsPath,
    },
    Unlink,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FsError {
    pub kind: FsErrorKind,
    pub path: Option<AbsPath>,
    /// The failing step of a write; `None` for every other failure.
    pub step: Option<FsStep>,
}

impl FsError {
    pub fn new(kind: FsErrorKind, path: Option<AbsPath>) -> Self {
        Self { kind, path, step: None }
    }

    pub fn at(mut self, step: FsStep) -> Self {
        self.step = Some(step);
        self
    }
}

/// The lane token is the routing proof: the implementation submits the job
/// to that lane (`LaneToken::submit`) and awaits its handle.
#[async_trait]
pub trait FileService: Send + Sync {
    async fn stat(&self, lane: InteractiveIo, path: AbsPath) -> Result<FileStat, FsError>;

    /// Like `stat`, follows links; no change time or file identity is needed.
    async fn stat_for_locator(&self, lane: InteractiveIo, path: AbsPath) -> Result<LocatorStat, FsError> {
        let FileStat { kind, len, modified, readonly, .. } = self.stat(lane, path).await?;
        Ok(LocatorStat { kind, len, modified, readonly })
    }
    /// Like `stat_for_locator`, but a symlink answers its own metadata (kind [`EntryKind::Symlink`], the link's size and
    /// time), as Node's `lstat` does for a `list` row.
    async fn lstat_for_locator(&self, lane: InteractiveIo, path: AbsPath) -> Result<LocatorStat, FsError> {
        self.stat_for_locator(lane, path).await
    }
    async fn read(&self, lane: InteractiveIo, path: AbsPath, range: ReadRange) -> Result<FileBytes, FsError>;

    /// Returns a bounded read and the file version it came from so a caller can assemble windows across reads.
    /// Reject a change during the read. Implementations with access to a file handle should stat that handle.
    async fn read_versioned(&self, lane: InteractiveIo, path: AbsPath, offset: u64, max_len: u64) -> Result<(FileStat, FileBytes), FsError> {
        let before = self.stat(lane, path.clone()).await?;
        let bytes = self.read(lane, path.clone(), ReadRange { offset, max_len: Some(max_len) }).await?;
        let after = self.stat(lane, path.clone()).await?;
        if before != after {
            return Err(FsError::new(FsErrorKind::OutcomeUnknown, Some(path)));
        }
        Ok((before, bytes))
    }

    async fn list_dir(&self, lane: InteractiveIo, path: AbsPath) -> Result<Vec<DirEntry>, FsError>;

    /// For a caller that ranks all entries itself. May skip the raw path sort only below `cap`;
    /// the bool says it did, so ties and a partial result can use raw path order.
    async fn list_dir_for_ranking(&self, lane: InteractiveIo, path: AbsPath, cap: usize) -> Result<(Vec<DirEntry>, bool), FsError> {
        let _ = cap;
        self.list_dir(lane, path).await.map(|entries| (entries, false))
    }

    /// Atomic replace (write, rename, fsync of file and directory). Writes
    /// through a leaf symlink to its target.
    async fn write(&self, lane: DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError>;

    /// [`write`](Self::write) that gives up with [`FsErrorKind::Cancelled`] when `cancel` fires before the temp file is
    /// published: the temp file is removed and the target is untouched. A cancel after the rename is too late; the write
    /// answers as done. A service that cannot check a cancel there runs the write whole.
    async fn write_cancellable(&self, lane: DurabilityIo, request: WriteRequest, cancel: tokio_util::sync::CancellationToken) -> Result<FileStat, FsError> {
        let _ = cancel;
        self.write(lane, request).await
    }
    /// Multi-file write: all files or none; preconditions are checked for
    /// every file before the first is replaced. A failure after that restores
    /// the files already replaced from their prior contents held in memory,
    /// as Node does; nothing is journaled, so a crash mid-batch can leave it
    /// partly applied.
    async fn write_batch(&self, lane: DurabilityIo, requests: Vec<WriteRequest>) -> Result<Vec<FileStat>, FsError>;

    /// [`write_batch`](Self::write_batch) that checks `cancel` before each file and immediately before each one is
    /// published: once it has fired no further file is replaced, the files already replaced are restored as for any
    /// other failure, and the batch answers [`FsErrorKind::Cancelled`] (or [`FsErrorKind::OutcomeUnknown`] when a
    /// restore failed). A service that cannot check a cancel there runs the batch whole.
    async fn write_batch_cancellable(
        &self,
        lane: DurabilityIo,
        requests: Vec<WriteRequest>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Vec<FileStat>, FsError> {
        let _ = cancel;
        self.write_batch(lane, requests).await
    }
    async fn create_dir(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError>;
    async fn rename(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError>;
    async fn copy(&self, lane: DurabilityIo, from: AbsPath, to: AbsPath, overwrite: bool) -> Result<(), FsError>;
    async fn remove(&self, lane: DurabilityIo, path: AbsPath, recursive: bool) -> Result<(), FsError>;

    fn walk(&self, lane: MaintenanceIo, request: WalkRequest) -> Box<dyn EventSource<Result<DirEntry, FsError>>>;
    /// The matches of `request`, in the search's file order. An error that names a file (its search failed, or the
    /// deadline cut it) withdraws the matches of that file already streamed: the file is not answered in part.
    fn search_text(&self, lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>>;

    /// Search for file totals (or the first match per file when requested), without needing line text or columns.
    /// The caller supplies no line limit and sums `count` by path, withdrawing a file on the same errors as
    /// `search_text`. Implementations may send one total per file instead of individual matches.
    fn search_summary(&self, lane: MaintenanceIo, request: SearchRequest) -> Box<dyn EventSource<Result<SearchMatch, FsError>>> {
        self.search_text(lane, request)
    }
}
