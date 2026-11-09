//! Durable filesystem steps of the migration (SM §7.1–§7.4): synced files, renames with
//! parent-directory sync, whole-file and whole-directory publication. A failure is
//! returned as `migration_blocked{op, path, os_error}`; there is no tolerated-error list.
//!
//! Publication, renames, directory creation and syncing are `mixdog_store::fsio`'s
//! primitives (the lane-free forms the migration may call); the rest are the plain reads,
//! removals and walks the migration needs.

// The migration is a sanctioned blocking-I/O home (RL §13): it runs once, before the
// runtime, on its own thread.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "one-time migration: blocking std::fs on the migration thread"
)]

use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Path;
#[cfg(feature = "crash-hook")]
use std::sync::OnceLock;

use mixdog_store::fsio;
use sha2::Digest as _;
use sha2::Sha256;

use crate::error::Blocked;
use crate::error::Result;
use crate::json::hex;

/// The boundaries at which a mutating step of the migration can be cut, in the order the code takes them. A hook is called
/// before the boundary's operation is done, with the disk exactly as a process killed there leaves it: nothing is simulated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// A directory about to be created.
    CreateDir,
    /// A file about to be created (the tmp of a publication, a staged output): none of it exists yet.
    Create,
    /// The first half of a file's bytes written, the second not: a partial file.
    Write,
    /// All bytes written, the file not yet synced.
    Sync,
    /// The tmp or staged file synced, the rename that publishes it not yet done.
    Rename,
    /// Renamed, the parent directories not yet synced.
    SyncDir,
    /// One file about to be removed.
    Remove,
    /// The emptied directory tree about to be removed.
    RemoveDir,
    /// The first half of a journal frame appended, the second not: a torn tail.
    Append,
    /// The torn journal tail about to be cut off.
    Truncate,
    /// The derived index database about to be built in its stage directory.
    Project,
    /// The index database built, not yet synced.
    Projected,
    /// An SQLite transaction about to commit; a kill leaves its rollback journal.
    SqliteCommit,
}
/// Test seam (`crash-hook` feature only): called at every [Step] boundary, with the path it concerns and the bytes the file will hold (empty when
/// there are none). A test installs it in a child process that exits at the boundary it chooses.
#[cfg(feature = "crash-hook")]
pub type StepHook = fn(Step, &Path, &[u8]);

#[cfg(feature = "crash-hook")]
static STEP_HOOK: OnceLock<StepHook> = OnceLock::new();

/// Installs the hook for the life of the process; a second installation is a bug of the caller.
#[cfg(feature = "crash-hook")]
pub fn set_step_hook(hook: StepHook) {
    assert!(STEP_HOOK.set(hook).is_ok(), "the step hook is installed once");
    // Every whole-file publication goes through the store's `publish_file_with`; its boundaries are steps too.
    fsio::set_publish_hook(|at, path, bytes| {
        let at = match at {
            fsio::PublishStep::Create => Step::Create,
            fsio::PublishStep::Write => Step::Write,
            fsio::PublishStep::Sync => Step::Sync,
            fsio::PublishStep::Rename => Step::Rename,
            fsio::PublishStep::SyncDir => Step::SyncDir,
        };
        step(at, path, bytes);
    });
}

/// Reports a step to the hook before it is taken.
#[cfg(feature = "crash-hook")]
pub fn step(step: Step, path: &Path, bytes: &[u8]) {
    if let Some(hook) = STEP_HOOK.get() {
        hook(step, path, bytes);
    }
}

/// A production build has no hook: a step is not reported.
#[cfg(not(feature = "crash-hook"))]
pub fn step(_: Step, _: &Path, _: &[u8]) {}

/// Syncs a file's data and metadata.
pub fn sync_file(path: &Path) -> Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| Blocked::io("open", path, e))?;
    fsio::sync_file(&file, path).map_err(Blocked::fsio)
}

/// Makes a directory's entries durable.
pub fn sync_dir(path: &Path) -> Result<()> {
    fsio::sync_dir(path).map_err(Blocked::fsio)
}

/// Creates `path` and its missing ancestors durably.
pub fn create_dir_all(path: &Path) -> Result<()> {
    step(Step::CreateDir, path, &[]);
    fsio::create_dir_durable(path).map_err(Blocked::fsio)
}

/// Renames `from` to `to` (replacing a file `to`), then syncs both parents.
pub fn durable_rename(from: &Path, to: &Path) -> Result<()> {
    step(Step::Rename, to, &[]);
    fsio::rename_replace(from, to).map_err(Blocked::fsio)?;
    step(Step::SyncDir, to, &[]);
    fsio::sync_rename_parents(from, to).map_err(Blocked::fsio)
}

/// Writes `bytes` in two halves, so that the boundary between them is a real partial file.
fn write_halves(file: &mut File, path: &Path, bytes: &[u8], midway: Step) -> Result<()> {
    let (first, second) = bytes.split_at(bytes.len() / 2);
    file.write_all(first).map_err(|e| Blocked::io("write", path, e))?;
    step(midway, path, bytes);
    file.write_all(second).map_err(|e| Blocked::io("write", path, e))
}

/// Writes `bytes` whole to `path`: a synced temporary file renamed over it, parent synced. The tmp is removed again when a
/// step fails; one a kill leaves is deleted by [sweep_tmp] under the migration directory, and beside `path` by the next
/// publication of that same name (a quarantine directory is outside the migration directory, and holds moved user files
/// no sweep may touch).
pub fn publish_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stale = format!(".{name}.tmp-");
    for (entry, is_dir) in list_dir(path.parent().expect("a published file has a parent"))? {
        if !is_dir && entry.starts_with(&stale) && fsio::is_tmp_name(&entry) {
            remove_file(&path.with_file_name(entry))?;
        }
    }
    fsio::publish_file_with(path, bytes, fsio::Access::Inherit).map_err(Blocked::fsio)
}

/// Makes the staged directory `stage` (every file already synced) the directory `target`.
pub fn publish_dir(stage: &Path, target: &Path) -> Result<()> {
    sync_dir(stage)?;
    if let Some(parent) = target.parent() {
        create_dir_all(parent)?;
    }
    durable_rename(stage, target)
}

/// Writes a new file and syncs it (staged output; published later by a rename).
pub fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }
    step(Step::Create, path, bytes);
    let mut file = File::create(path).map_err(|e| Blocked::io("create", path, e))?;
    write_halves(&mut file, path, bytes, Step::Write)?;
    step(Step::Sync, path, bytes);
    file.sync_all().map_err(|e| Blocked::io("sync", path, e))
}

/// Removes a file that may already be gone; syncs its parent when it removed one.
pub fn remove_file(path: &Path) -> Result<bool> {
    step(Step::Remove, path, &[]);
    match fs::remove_file(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                sync_dir(parent)?;
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(Blocked::io("remove", path, e)),
    }
}

/// Removes a directory tree that may already be gone: its files one by one (each a boundary a kill can fall on), then the
/// emptied tree.
pub fn remove_dir_all(path: &Path) -> Result<()> {
    for rel in walk_files(path)? {
        let file = path.join(rel);
        step(Step::Remove, &file, &[]);
        match fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Blocked::io("remove", &file, e)),
        }
    }
    step(Step::RemoveDir, path, &[]);
    match fs::remove_dir_all(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                sync_dir(parent)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Blocked::io("remove_dir", path, e)),
    }
}

/// Whether `path` is an existing regular file (a symlink is followed).
pub fn is_file(path: &Path) -> bool {
    path.is_file()
}

pub fn exists(path: &Path) -> Result<bool> {
    path.try_exists()
        .map_err(|e| Blocked::io("stat", path, e))
}

pub fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|e| Blocked::io("read", path, e))
}

/// A file opened to be read line by line without holding it whole; `path` names it in errors.
pub struct OpenFile {
    pub path: std::path::PathBuf,
    pub reader: std::io::BufReader<File>,
}

pub fn open_buffered(path: &Path) -> Result<OpenFile> {
    let file = File::open(path).map_err(|e| Blocked::io("open", path, e))?;
    Ok(OpenFile {
        path: path.to_path_buf(),
        reader: std::io::BufReader::with_capacity(1 << 16, file),
    })
}

/// The bytes of the regular, non-empty file `path` when it holds at most `max_bytes` (judged
/// by the opened file and by at most `max_bytes + 1` bytes read), else `None`. An empty or
/// non-regular file is an `InvalidData` error.
pub fn read_within(path: &Path, max_bytes: u64) -> std::io::Result<Option<Vec<u8>>> {
    let file = File::open(path)?;
    let info = file.metadata()?;
    if !info.is_file() || info.len() == 0 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    if info.len() > max_bytes {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    file.take(info.len() + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= max_bytes).then_some(bytes))
}

/// The bytes of `path`, or `None` when it does not exist.
pub fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Blocked::io("read", path, e)),
    }
}

/// `(size, sha256 hex)` of a file, streamed.
pub fn hash_file(path: &Path) -> Result<(u64, String)> {
    let mut file = File::open(path).map_err(|e| Blocked::io("open", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| Blocked::io("read", path, e))?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((size, hex(&hasher.finalize())))
}

/// Deletes the tmp files of an interrupted `publish_file` under `dir`, at any depth (SM §7.4: a tmp is never
/// published, only deleted). The migration creates every file there, so none is anyone's data.
pub fn sweep_tmp(dir: &Path) -> Result<()> {
    for rel in walk_files(dir)? {
        if fsio::is_tmp_name(rel.rsplit('/').next().unwrap_or(&rel)) {
            remove_file(&dir.join(&rel))?;
        }
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Entries of a directory (name, is_dir), sorted by name; empty when it does not exist.
pub fn list_dir(path: &Path) -> Result<Vec<(String, bool)>> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Blocked::io("list", path, e)),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| Blocked::io("list", path, e))?;
        let kind = entry
            .file_type()
            .map_err(|e| Blocked::io("stat", &entry.path(), e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        out.push((name, kind.is_dir()));
    }
    out.sort();
    Ok(out)
}

/// Every file under `dir`, as `/`-separated paths relative to `dir`, sorted.
pub fn walk_files(dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let abs = if rel.is_empty() {
            dir.to_path_buf()
        } else {
            dir.join(&rel)
        };
        for (name, is_dir) in list_dir(&abs)? {
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            if is_dir {
                stack.push(child);
            } else {
                out.push(child);
            }
        }
    }
    out.sort();
    Ok(out)
}
