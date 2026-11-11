//! Durability primitives (SM §7): `sync_file`, `sync_dir`, `durable_rename`,
//! `publish_file`, `publish_dir`, the tmp sweep and the boot probe. Every error is a
//! failure; nothing is tolerated.
//!
//! The functions take a lane proof: store file I/O runs only inside io-interactive,
//! io-durability or io-maintenance jobs (RL §7, §13).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "store file I/O runs only in lane jobs (lane proof arguments)")]

use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
// One definition of the file-lane traits and of `Access` (with its Windows owner-only ACL code)
// for the store and the state files.
pub use mixdog_statefile::Access;
pub use mixdog_statefile::IoLane;
pub use mixdog_statefile::WriteLane;
#[cfg(windows)]
use mixdog_statefile::verbatim_wide;

/// A failed primitive: which step, on which path.
#[derive(Debug, thiserror::Error)]
#[error("{op} {path}: {source}")]
pub struct IoError {
    pub op: IoOp,
    pub path: PathBuf,
    #[source]
    pub source: io::Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoOp {
    Open,
    Read,
    Write,
    SyncFile,
    SyncDir,
    Rename,
    Truncate,
    CreateDir,
    List,
    Remove,
}

impl std::fmt::Display for IoOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            IoOp::Open => "open",
            IoOp::Read => "read",
            IoOp::Write => "write",
            IoOp::SyncFile => "sync_file",
            IoOp::SyncDir => "sync_dir",
            IoOp::Rename => "durable_rename",
            IoOp::Truncate => "truncate",
            IoOp::CreateDir => "create_dir",
            IoOp::List => "list",
            IoOp::Remove => "remove",
        };
        f.write_str(name)
    }
}

pub(crate) fn err(op: IoOp, path: &Path) -> impl FnOnce(io::Error) -> IoError + '_ {
    move |source| IoError {
        op,
        path: path.to_path_buf(),
        source,
    }
}

/// `fsync` / `FlushFileBuffers`.
pub fn sync_file(file: &File, path: &Path) -> Result<(), IoError> {
    file.sync_all().map_err(err(IoOp::SyncFile, path))
}

/// Makes the directory's entries durable. Windows needs a write handle opened with
/// `FILE_FLAG_BACKUP_SEMANTICS`; a read-only directory handle is refused by
/// `FlushFileBuffers`.
pub fn sync_dir(dir: &Path) -> Result<(), IoError> {
    mixdog_statefile::unlaned::sync_dir(dir).map_err(err(IoOp::SyncDir, dir))
}

fn parent(path: &Path) -> &Path {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    }
}

/// The rename alone, replacing `to` and written through; the new entry is durable only once the caller has synced the
/// parents ([durable_rename] does both).
pub fn rename_replace(from: &Path, to: &Path) -> Result<(), IoError> {
    rename_through(from, to).map_err(err(IoOp::Rename, to))
}

/// Syncs the parents of a renamed entry: where it is now, and where it was.
pub fn sync_rename_parents(from: &Path, to: &Path) -> Result<(), IoError> {
    sync_dir(parent(to))?;
    if parent(from) != parent(to) {
        sync_dir(parent(from))?;
    }
    Ok(())
}

/// Rename `from` to `to` (replacing it) so that the new entry is durable when this returns.
pub fn durable_rename(from: &Path, to: &Path) -> Result<(), IoError> {
    rename_replace(from, to)?;
    sync_rename_parents(from, to)
}

#[cfg(windows)]
fn rename_through(from: &Path, to: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING;
    use windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let (a, b) = (verbatim_wide(from)?, verbatim_wide(to)?);
    // SAFETY: both arguments are NUL-terminated UTF-16 strings that outlive the call.
    let ok = unsafe {
        MoveFileExW(a.as_ptr(), b.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
    };
    if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn rename_through(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)
}

/// Creates `dir` and every missing ancestor, syncing each new entry's parent.
pub fn create_dir_durable(dir: &Path) -> Result<(), IoError> {
    if dir.is_dir() {
        return Ok(());
    }
    create_dir_durable(parent(dir))?;
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && dir.is_dir() => return Ok(()),
        Err(e) => return Err(err(IoOp::CreateDir, dir)(e)),
    }
    sync_dir(parent(dir))
}

/// `.<name>.tmp-<16 hex>` beside `path`.
pub fn tmp_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    parent(path).join(format!(".{name}.tmp-{:016x}", rand::random::<u64>()))
}

/// Whether `name` is a tmp name of `publish_file`.
pub fn is_tmp_name(name: &str) -> bool {
    name.starts_with('.')
        && name.len() > 22
        && name.as_bytes()[name.len() - 21..name.len() - 16] == *b".tmp-"
        && name.as_bytes()[name.len() - 16..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Every whole-file write (SM §7.2): the file is visible and durable exactly when this
/// returns. On a failed rename the tmp is unlinked (left for the sweep if that fails too).
pub fn publish_file<L: WriteLane>(_lane: &InLane<L>, path: &Path, bytes: &[u8]) -> Result<(), IoError> {
    publish_file_unlaned(path, bytes)
}

pub(crate) fn publish_file_unlaned(path: &Path, bytes: &[u8]) -> Result<(), IoError> {
    publish_file_with(path, bytes, Access::Inherit)
}

/// Creates `path`, which must not exist, with `access`; parents are created durably.
/// Blocking: callers outside the store (migration driver) run it on their own thread.
pub fn create_new_file(path: &Path, access: Access) -> Result<File, IoError> {
    create_dir_durable(parent(path))?;
    create_new_platform(path, access).map_err(err(IoOp::Open, path))
}

fn create_new_platform(path: &Path, access: Access) -> io::Result<File> {
    // 0o666: the umask decides, as a plain `open` does.
    mixdog_statefile::unlaned::create_new(path, access, 0o666).map(mixdog_fsio::File::into_std)
}

/// Whether only the current user can open `path`: Unix no group/other mode bits;
/// Windows exactly the protected owner-only DACL `create_new_file` sets.
pub fn is_owner_only(path: &Path) -> Result<bool, IoError> {
    mixdog_statefile::unlaned::is_owner_only(path).map_err(err(IoOp::Read, path))
}

/// The boundaries of [publish_file_with], each reported before it is taken. Compiled only with the `crash-hook` feature,
/// which only the dev-dependencies of crates whose tests kill a publication enable: a production build has no hook.
#[cfg(feature = "crash-hook")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishStep {
    /// The tmp about to be created: none of it exists yet.
    Create,
    /// The first half of the bytes written, the second not: a partial tmp.
    Write,
    /// All bytes written, the tmp not yet synced.
    Sync,
    /// The tmp synced, the rename that publishes it not yet done (the path is the target).
    Rename,
    /// Renamed, the parent directories not yet synced (the path is the target).
    SyncDir,
}

/// Test seam: called at every [PublishStep] with the path it concerns and the bytes being published (empty at the last
/// two). A test installs it in a child process that exits at the boundary it chooses.
#[cfg(feature = "crash-hook")]
pub type PublishHook = fn(PublishStep, &Path, &[u8]);

#[cfg(feature = "crash-hook")]
static PUBLISH_HOOK: std::sync::OnceLock<PublishHook> = std::sync::OnceLock::new();

/// Installs the hook for the life of the process; a second installation is a bug of the caller.
#[cfg(feature = "crash-hook")]
pub fn set_publish_hook(hook: PublishHook) {
    assert!(PUBLISH_HOOK.set(hook).is_ok(), "the publish hook is installed once");
}

/// The boundaries of a session log's barrier (`LogWriter::append_barrier`), each reported with the batch's records (none at
/// `Truncate`). A test installs it in a child process that exits at the boundary it chooses, or fails the step by returning
/// an error: the writer then fails it as the disk would.
#[cfg(feature = "crash-hook")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendStep {
    /// Before the frames are written. An error: the write stops half way (half the batch's bytes are in the file).
    Write,
    /// Before the written frames are synced. An error: the sync fails.
    Sync,
    /// Before a rollback truncates the file back to its acked end. An error: the rollback fails (the outcome is unknown).
    Truncate,
    /// The frames are durable.
    Synced,
}

#[cfg(feature = "crash-hook")]
pub type AppendHook = fn(AppendStep, &[crate::schema::record::Record]) -> std::io::Result<()>;

#[cfg(feature = "crash-hook")]
static APPEND_HOOK: std::sync::OnceLock<AppendHook> = std::sync::OnceLock::new();

/// Installs the append hook for the life of the process; a second installation is a bug of the caller.
#[cfg(feature = "crash-hook")]
pub fn set_append_hook(hook: AppendHook) {
    assert!(APPEND_HOOK.set(hook).is_ok(), "the append hook is installed once");
}

#[cfg(feature = "crash-hook")]
pub(crate) fn append_step(step: AppendStep, records: &[crate::schema::record::Record]) -> std::io::Result<()> {
    APPEND_HOOK.get().map_or(Ok(()), |hook| hook(step, records))
}

#[cfg(feature = "crash-hook")]
fn publish_step(step: PublishStep, path: &Path, bytes: &[u8]) {
    if let Some(hook) = PUBLISH_HOOK.get() {
        hook(step, path, bytes);
    }
}

/// `publish_file` with `access` on the new file (the tmp is created with it and keeps it
/// across the rename). Usable outside a write lane: it takes no lane proof.
pub fn publish_file_with(path: &Path, bytes: &[u8], access: Access) -> Result<(), IoError> {
    create_dir_durable(parent(path))?;
    let tmp = tmp_path(path);
    let result = (|| {
        #[cfg(feature = "crash-hook")]
        publish_step(PublishStep::Create, &tmp, bytes);
        let mut file = create_new_platform(&tmp, access).map_err(err(IoOp::Open, &tmp))?;
        write_body(&mut file, &tmp, bytes)?;
        #[cfg(feature = "crash-hook")]
        publish_step(PublishStep::Sync, &tmp, bytes);
        sync_file(&file, &tmp)?;
        drop(file);
        #[cfg(feature = "crash-hook")]
        publish_step(PublishStep::Rename, path, &[]);
        rename_replace(&tmp, path)?;
        #[cfg(feature = "crash-hook")]
        publish_step(PublishStep::SyncDir, path, &[]);
        sync_rename_parents(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The bytes in two halves, so that the boundary between them is a real partial tmp.
#[cfg(feature = "crash-hook")]
fn write_body(file: &mut File, tmp: &Path, bytes: &[u8]) -> Result<(), IoError> {
    let (first, second) = bytes.split_at(bytes.len() / 2);
    file.write_all(first).map_err(err(IoOp::Write, tmp))?;
    publish_step(PublishStep::Write, tmp, bytes);
    file.write_all(second).map_err(err(IoOp::Write, tmp))
}

#[cfg(not(feature = "crash-hook"))]
fn write_body(file: &mut File, tmp: &Path, bytes: &[u8]) -> Result<(), IoError> {
    file.write_all(bytes).map_err(err(IoOp::Write, tmp))
}

/// Publishes a staged directory as `target` (SM §7.3; migration targets only).
pub fn publish_dir<L: WriteLane>(_lane: &InLane<L>, stage: &Path, target: &Path) -> Result<(), IoError> {
    sync_tree(stage)?;
    durable_rename(stage, target)
}

fn sync_tree(dir: &Path) -> Result<(), IoError> {
    for entry in std::fs::read_dir(dir).map_err(err(IoOp::List, dir))? {
        let entry = entry.map_err(err(IoOp::List, dir))?;
        let path = entry.path();
        let kind = entry.file_type().map_err(err(IoOp::List, &path))?;
        if kind.is_dir() {
            sync_tree(&path)?;
        } else {
            // FlushFileBuffers needs a handle with write access on Windows.
            let file = OpenOptions::new()
                .write(true)
                .open(&path)
                .map_err(err(IoOp::Open, &path))?;
            sync_file(&file, &path)?;
        }
    }
    sync_dir(dir)
}

/// Deletes every `publish_file` tmp in `dir` (SM §7.4 open sweep). Returns how many.
pub fn sweep_tmp<L: WriteLane>(_lane: &InLane<L>, dir: &Path) -> Result<usize, IoError> {
    sweep_tmp_unlaned(dir)
}

pub(crate) fn sweep_tmp_unlaned(dir: &Path) -> Result<usize, IoError> {
    let mut removed = 0;
    for entry in std::fs::read_dir(dir).map_err(err(IoOp::List, dir))? {
        let entry = entry.map_err(err(IoOp::List, dir))?;
        if is_tmp_name(&entry.file_name().to_string_lossy()) {
            let path = entry.path();
            std::fs::remove_file(&path).map_err(err(IoOp::Remove, &path))?;
            removed += 1;
        }
    }
    if removed > 0 {
        sync_dir(dir)?;
    }
    Ok(removed)
}

/// The data dir cannot give the durability the store needs (SM §7.1 boot probe).
#[derive(Debug, thiserror::Error)]
#[error("storage unsupported: {0}")]
pub struct StorageUnsupported(#[from] pub IoError);

/// Boot probe: `sync_dir(<D>)` and one `durable_rename` of a probe file. A failure refuses
/// the data dir; there is no degraded mode.
pub fn boot_probe<L: WriteLane>(lane: &InLane<L>, data_dir: &Path) -> Result<(), StorageUnsupported> {
    sync_dir(data_dir)?;
    let probe = data_dir.join(format!(".store-probe-{:016x}", rand::random::<u64>()));
    publish_file(lane, &probe, b"probe")?;
    std::fs::remove_file(&probe).map_err(err(IoOp::Remove, &probe))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_names_round_trip() {
        let tmp = tmp_path(Path::new("x/log.000001"));
        let name = tmp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(is_tmp_name(&name), "{name}");
        assert!(!is_tmp_name("log.000001"));
        assert!(!is_tmp_name(".log.000001.tmp-xyz"));
    }

    #[test]
    fn publish_creates_parents_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/c.json");
        publish_file_unlaned(&path, b"one").unwrap();
        publish_file_unlaned(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        std::fs::write(dir.path().join("a/b/.c.json.tmp-0123456789abcdef"), b"").unwrap();
        assert_eq!(sweep_tmp_unlaned(&dir.path().join("a/b")).unwrap(), 1);
        sync_dir(dir.path()).unwrap();
    }

    /// Paths over `MAX_PATH` (quarantine keys reach 263+): every helper, both access modes.
    #[test]
    fn helpers_work_on_paths_over_300_characters() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("q".repeat(120)).join("%2F".repeat(40)).join("k".repeat(100));
        let file = deep.join("log.000000");
        assert!(file.as_os_str().len() > 300, "{}", file.as_os_str().len());
        create_dir_durable(&deep).unwrap();
        sync_dir(&deep).unwrap();
        publish_file_unlaned(&file, b"one").unwrap();
        publish_file_with(&file, b"two", Access::OwnerOnly).unwrap();
        assert!(is_owner_only(&file).unwrap());
        let moved = deep.join("moved.000000");
        durable_rename(&file, &moved).unwrap();
        let created = deep.join("created.bin");
        drop(create_new_file(&created, Access::OwnerOnly).unwrap());
        assert!(is_owner_only(&created).unwrap());
        drop(create_new_file(&deep.join("plain.bin"), Access::Inherit).unwrap());
        std::fs::write(deep.join(".x.tmp-0123456789abcdef"), b"").unwrap();
        assert_eq!(sweep_tmp_unlaned(&deep).unwrap(), 1);
        let stage = dir.path().join("s".repeat(150)).join("t".repeat(150));
        create_dir_durable(&stage).unwrap();
        publish_file_unlaned(&stage.join("inner.json"), b"{}").unwrap();
        let target = dir.path().join("u".repeat(150)).join("v".repeat(160));
        create_dir_durable(target.parent().unwrap()).unwrap();
        sync_tree(&stage).unwrap();
        durable_rename(&stage, &target).unwrap();
        assert_eq!(std::fs::read(target.join("inner.json")).unwrap(), b"{}");
        assert_eq!(std::fs::read(&moved).unwrap(), b"two");
    }

    #[test]
    fn owner_only_files_are_created_and_published_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let created = dir.path().join("s/secret.bin");
        let mut file = create_new_file(&created, Access::OwnerOnly).unwrap();
        file.write_all(b"k").unwrap();
        drop(file);
        assert!(is_owner_only(&created).unwrap());
        assert!(create_new_file(&created, Access::OwnerOnly).is_err(), "must not exist");
        let published = dir.path().join("p/config.json");
        publish_file_with(&published, b"{}", Access::OwnerOnly).unwrap();
        assert!(is_owner_only(&published).unwrap());
        assert_eq!(std::fs::read(&published).unwrap(), b"{}");
        let plain = dir.path().join("plain.txt");
        publish_file_with(&plain, b"x", Access::Inherit).unwrap();
        assert!(!is_owner_only(&plain).unwrap());
    }
}
