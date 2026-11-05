#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! In-place rewrite of an open file. The file is opened once, compared,
//! rewritten and flushed through that one handle, so it keeps its identity
//! (file id, hard links, ACLs, attributes) and a symlink is written through to
//! its target. Never creates a file. Not atomic: a crash mid-write is covered
//! by the recovery journal, an in-process failure by [`rewrite_or_restore`].

use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;
use crate::ident::FileId;
use crate::ident::file_id;
use crate::ident::path_id;
use crate::pathguard::canonical;
use crate::pathguard::is_within;

/// A file opened read-write for an in-place save.
pub struct Opened {
    pub file: File,
    pub id: FileId,
    pub path: PathBuf,
}

/// Opens `path` read-write (never creating or truncating) and proves from the
/// open file that it is a regular file whose real location is inside `root`.
/// A path swapped for a link between resolving and opening reaches nothing.
pub fn open_authorized_rw(path: &Path, root: &Path) -> WsResult<Opened> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    let id = verify_opened(&file, path, root)?;
    Ok(Opened { file, id, path: path.to_path_buf() })
}

/// The read-only form of [`open_authorized_rw`].
pub fn open_authorized_ro(path: &Path, root: &Path) -> WsResult<Opened> {
    let file = File::open(path)?;
    let id = verify_opened(&file, path, root)?;
    Ok(Opened { file, id, path: path.to_path_buf() })
}

fn verify_opened(file: &File, path: &Path, root: &Path) -> WsResult<FileId> {
    if !file.metadata()?.is_file() {
        return Err(WsError::new(Reason::NotAFile, "Not a file."));
    }
    let id = file_id(file)?;
    let real = canonical(path).map_err(|_| WsError::new(Reason::Changed, "The file changed while it was opened."))?;
    let root = canonical(root)?;
    if !is_within(&root, &real) {
        return Err(WsError::denied("The file resolves outside the project."));
    }
    if path_id(&real).ok() != Some(id) {
        return Err(WsError::new(Reason::Changed, "The file changed while it was opened."));
    }
    Ok(id)
}

pub fn read_all(file: &mut File) -> io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Filesystems that refuse to flush (network and cloud-sync drives) keep a
/// best-effort save; any other flush error fails it.
fn flush_tolerated(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported || matches!(error.raw_os_error(), Some(1 | 22 | 95 | 45))
}

pub fn rewrite(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    match file.sync_data() {
        Err(error) if !flush_tolerated(&error) => Err(error),
        _ => Ok(()),
    }
}

/// [`rewrite`], undone on failure: the original bytes are written back
/// through the same handle when it fails part-way.
pub fn rewrite_or_restore(file: &mut File, bytes: &[u8], original: &[u8]) -> WsResult<()> {
    match rewrite(file, bytes) {
        Ok(()) => Ok(()),
        Err(error) => match rewrite(file, original) {
            Ok(()) => Err(error.into()),
            Err(_) => Err(WsError::new(
                Reason::Io,
                format!("Save failed: {error}. The original could not be restored."),
            )),
        },
    }
}
