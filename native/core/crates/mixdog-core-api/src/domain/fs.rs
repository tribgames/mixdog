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
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WriteRequest {
    pub path: AbsPath,
    pub content: Vec<u8>,
    pub precondition: WritePrecondition,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WalkRequest {
    pub root: AbsPath,
    pub recursive: bool,
    pub include_hidden: bool,
    /// Honour `.gitignore` and friends.
    pub respect_ignore: bool,
    pub include_dirs: bool,
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
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SearchMatch {
    pub path: AbsPath,
    /// 1-based.
    pub line: u64,
    /// 1-based byte column.
    pub column: u64,
    pub text: String,
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
    Io {
        os_code: Option<i32>,
    },
    /// `search_text` with `regex: true` got a pattern that does not parse;
    /// `message` is the parser's text as Node shows it
    /// (`regex parse error: …`), passed through verbatim.
    InvalidPattern {
        message: String,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FsError {
    pub kind: FsErrorKind,
    pub path: Option<AbsPath>,
}

impl FsError {
    pub fn new(kind: FsErrorKind, path: Option<AbsPath>) -> Self {
        Self { kind, path }
    }
}

/// The lane token is the routing proof: the implementation submits the job
/// to that lane (`LaneToken::submit`) and awaits its handle.
#[async_trait]
pub trait FileService: Send + Sync {
    async fn stat(&self, lane: InteractiveIo, path: AbsPath) -> Result<FileStat, FsError>;
    async fn read(
        &self,
        lane: InteractiveIo,
        path: AbsPath,
        range: ReadRange,
    ) -> Result<FileBytes, FsError>;
    async fn list_dir(&self, lane: InteractiveIo, path: AbsPath) -> Result<Vec<DirEntry>, FsError>;

    /// Atomic replace (write, rename, fsync of file and directory). Writes
    /// through a leaf symlink to its target.
    async fn write(&self, lane: DurabilityIo, request: WriteRequest) -> Result<FileStat, FsError>;
    /// Multi-file write: all files or none; preconditions are checked for
    /// every file before the first is replaced. A failure after that restores
    /// the files already replaced from their prior contents held in memory,
    /// as Node does; nothing is journaled, so a crash mid-batch can leave it
    /// partly applied.
    async fn write_batch(
        &self,
        lane: DurabilityIo,
        requests: Vec<WriteRequest>,
    ) -> Result<Vec<FileStat>, FsError>;
    async fn create_dir(
        &self,
        lane: DurabilityIo,
        path: AbsPath,
        recursive: bool,
    ) -> Result<(), FsError>;
    async fn rename(
        &self,
        lane: DurabilityIo,
        from: AbsPath,
        to: AbsPath,
        overwrite: bool,
    ) -> Result<(), FsError>;
    async fn copy(
        &self,
        lane: DurabilityIo,
        from: AbsPath,
        to: AbsPath,
        overwrite: bool,
    ) -> Result<(), FsError>;
    async fn remove(
        &self,
        lane: DurabilityIo,
        path: AbsPath,
        recursive: bool,
    ) -> Result<(), FsError>;

    fn walk(
        &self,
        lane: MaintenanceIo,
        request: WalkRequest,
    ) -> Box<dyn EventSource<Result<DirEntry, FsError>>>;
    fn search_text(
        &self,
        lane: MaintenanceIo,
        request: SearchRequest,
    ) -> Box<dyn EventSource<Result<SearchMatch, FsError>>>;
}
