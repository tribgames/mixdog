//! The file reads of a prompt composition. [`LiveFiles`] reads the disk; [`FileReads`] reads it inside an
//! io-interactive lane job and keeps every answer; the [`FileSnapshot`] it becomes answers from what was kept, so the
//! composition itself runs on a compute lane and reads nothing.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "LiveFiles is the composition's one disk reader; it runs in a lane job")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::hash::Hash;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;

use super::real_sources::INSTRUCTION_FILE_MAX_BYTES;

/// A readable entry of `fs::read_dir`: its name and its `DirEntry::file_type`, `None` when that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: OsString,
    pub kind: Option<EntryKind>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntryKind {
    pub dir: bool,
    pub file: bool,
}

/// `findRepositoryRoot(start)`: the root and the git directory holding `HEAD`.
pub type RepositoryRoot = Option<(PathBuf, Option<PathBuf>)>;

/// The leading bytes of an instruction file, or why it has none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum InstructionHead {
    Bytes(Vec<u8>),
    /// Not a regular file.
    #[default]
    NotAFile,
    /// It resolves outside its root.
    Outside,
    /// A step failed with this error.
    Failed {
        kind: std::io::ErrorKind,
        message: String,
    },
}

/// What a composition reads from the disk.
pub trait PromptFiles {
    /// `fs::read`; `None` when it fails.
    fn read(&self, path: &Path) -> Option<Vec<u8>>;
    /// `Path::exists`.
    fn exists(&self, path: &Path) -> bool;
    /// The readable entries of `fs::read_dir(dir)`; `None` when the directory cannot be read.
    fn entries(&self, dir: &Path) -> Option<Vec<Entry>>;
    /// `findRepositoryRoot(start)`.
    fn repository_root(&self, start: &str) -> RepositoryRoot;
    /// The head of the instruction file at `path`, which must resolve inside `root`.
    fn instruction_head(&self, path: &Path, root: Option<&Path>) -> InstructionHead;
}

/// The disk itself.
pub struct LiveFiles;

impl PromptFiles for LiveFiles {
    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        fs::read(path).ok()
    }

    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn entries(&self, dir: &Path) -> Option<Vec<Entry>> {
        let read = fs::read_dir(dir).ok()?;
        Some(
            read.flatten()
                .map(|entry| Entry { name: entry.file_name(), kind: entry.file_type().ok().map(|t| EntryKind { dir: t.is_dir(), file: t.is_file() }) })
                .collect(),
        )
    }

    fn repository_root(&self, start: &str) -> RepositoryRoot {
        let mut current = std::path::absolute(if start.is_empty() { "." } else { start }).ok()?;
        for _ in 0..64 {
            let marker = current.join(".git");
            if let Ok(stats) = fs::metadata(&marker) {
                let git_dir = if stats.is_dir() { Some(marker) } else { linked_git_dir(&marker, &current) };
                return Some((current, git_dir));
            }
            current = current.parent()?.to_path_buf();
        }
        None
    }

    fn instruction_head(&self, path: &Path, root: Option<&Path>) -> InstructionHead {
        instruction_head(path, root).unwrap_or_else(|error| InstructionHead::Failed { kind: error.kind(), message: error.to_string() })
    }
}

fn linked_git_dir(marker: &Path, root: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(marker).ok()?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?;
    let target = js_trim(target);
    (!target.is_empty()).then(|| std::path::absolute(root.join(target)).ok()).flatten()
}

/// `openSync(path, O_RDONLY | O_NONBLOCK)`.
fn open_nonblocking(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    options.open(path)
}

fn instruction_head(path: &Path, root: Option<&Path>) -> std::io::Result<InstructionHead> {
    let real = fs::canonicalize(path)?;
    if let Some(root) = root
        && !real.starts_with(fs::canonicalize(root)?)
    {
        return Ok(InstructionHead::Outside);
    }
    // Opening a FIFO for reading blocks until a writer appears, so the type is checked before the
    // open, which is non-blocking, and again on the opened file.
    if !fs::metadata(&real)?.is_file() {
        return Ok(InstructionHead::NotAFile);
    }
    let file = open_nonblocking(&real)?;
    if !file.metadata()?.is_file() {
        return Ok(InstructionHead::NotAFile);
    }
    let mut head = Vec::new();
    file.take((INSTRUCTION_FILE_MAX_BYTES + 3 + 1) as u64).read_to_end(&mut head)?;
    Ok(InstructionHead::Bytes(head))
}

#[derive(Debug, Default)]
struct Kept {
    read: HashMap<PathBuf, Option<Vec<u8>>>,
    exists: HashMap<PathBuf, bool>,
    entries: HashMap<PathBuf, Option<Vec<Entry>>>,
    roots: HashMap<String, RepositoryRoot>,
    heads: HashMap<(PathBuf, Option<PathBuf>), InstructionHead>,
}

/// The disk read inside an io-interactive lane job, each answer kept for the [`FileSnapshot`].
pub struct FileReads<'a> {
    _lane: &'a InLane<InteractiveIo>,
    kept: RefCell<Kept>,
}

impl<'a> FileReads<'a> {
    pub fn new(lane: &'a InLane<InteractiveIo>) -> Self {
        Self { _lane: lane, kept: RefCell::new(Kept::default()) }
    }

    /// What was read, owned.
    pub fn snapshot(self) -> FileSnapshot {
        FileSnapshot { kept: self.kept.into_inner(), gap: std::sync::OnceLock::new() }
    }
}

fn keep<K: Eq + Hash, V: Clone>(map: &mut HashMap<K, V>, key: K, read: impl FnOnce() -> V) -> V {
    map.entry(key).or_insert_with(read).clone()
}

impl PromptFiles for FileReads<'_> {
    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        keep(&mut self.kept.borrow_mut().read, path.to_path_buf(), || LiveFiles.read(path))
    }

    fn exists(&self, path: &Path) -> bool {
        keep(&mut self.kept.borrow_mut().exists, path.to_path_buf(), || LiveFiles.exists(path))
    }

    fn entries(&self, dir: &Path) -> Option<Vec<Entry>> {
        keep(&mut self.kept.borrow_mut().entries, dir.to_path_buf(), || LiveFiles.entries(dir))
    }

    fn repository_root(&self, start: &str) -> RepositoryRoot {
        keep(&mut self.kept.borrow_mut().roots, start.to_owned(), || LiveFiles.repository_root(start))
    }

    fn instruction_head(&self, path: &Path, root: Option<&Path>) -> InstructionHead {
        keep(&mut self.kept.borrow_mut().heads, (path.to_path_buf(), root.map(Path::to_path_buf)), || LiveFiles.instruction_head(path, root))
    }
}

/// The answers of a [`FileReads`]. A question it was never asked is a gap in the reads: the composition that asked it
/// is not the one the disk gives, and [`FileSnapshot::gap`] names the question so the caller fails it.
#[derive(Debug, Default)]
pub struct FileSnapshot {
    kept: Kept,
    gap: std::sync::OnceLock<String>,
}

impl FileSnapshot {
    /// The first question asked that the reads did not cover.
    pub fn gap(&self) -> Option<&str> {
        self.gap.get().map(String::as_str)
    }

    fn unread<T: Default>(&self, question: std::fmt::Arguments<'_>) -> T {
        self.gap.get_or_init(|| question.to_string());
        T::default()
    }
}

impl PromptFiles for FileSnapshot {
    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        self.kept.read.get(path).cloned().unwrap_or_else(|| self.unread(format_args!("read {}", path.display())))
    }

    fn exists(&self, path: &Path) -> bool {
        self.kept.exists.get(path).copied().unwrap_or_else(|| self.unread(format_args!("exists {}", path.display())))
    }

    fn entries(&self, dir: &Path) -> Option<Vec<Entry>> {
        self.kept.entries.get(dir).cloned().unwrap_or_else(|| self.unread(format_args!("entries {}", dir.display())))
    }

    fn repository_root(&self, start: &str) -> RepositoryRoot {
        self.kept.roots.get(start).cloned().unwrap_or_else(|| self.unread(format_args!("repository root {start}")))
    }

    fn instruction_head(&self, path: &Path, root: Option<&Path>) -> InstructionHead {
        self.kept
            .heads
            .get(&(path.to_path_buf(), root.map(Path::to_path_buf)))
            .cloned()
            .unwrap_or_else(|| self.unread(format_args!("instruction head {}", path.display())))
    }
}
