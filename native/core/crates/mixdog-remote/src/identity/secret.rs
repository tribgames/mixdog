//! Owner-only secret files. A secret is created with its access control already set (mode 0600,
//! or a protected DACL for the current user on Windows) and published through the store's
//! durable helpers, so there is no moment it is readable by anyone else.
#![allow(clippy::disallowed_methods, reason = "secret file I/O runs only in lane jobs (lane proof arguments)")]

use std::io;
use std::path::Path;

use mixdog_rt::InLane;
use mixdog_store::fsio::{self, Access, IoError, WriteLane};

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("secret file io: {0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Store(#[from] IoError),
}

/// Atomically replaces `path` with `bytes`, readable by the owner only.
pub fn write_secret<L: WriteLane>(_lane: &InLane<L>, path: &Path, bytes: &[u8]) -> Result<(), SecretError> {
    Ok(fsio::publish_file_with(path, bytes, Access::OwnerOnly)?)
}

/// Whether only the owner can read `path`.
pub fn is_owner_only(path: &Path) -> Result<bool, SecretError> {
    Ok(fsio::is_owner_only(path)?)
}

/// `None` only when the file is absent; an unreadable file is an error, never `None`.
pub fn read_raw<L: WriteLane>(_lane: &InLane<L>, path: &Path) -> Result<Option<Vec<u8>>, SecretError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Like [`read_raw`], and a file another account could read is republished owner-only before its
/// contents are returned.
pub fn read_secret<L: WriteLane>(lane: &InLane<L>, path: &Path) -> Result<Option<Vec<u8>>, SecretError> {
    let Some(bytes) = read_raw(lane, path)? else { return Ok(None) };
    if !is_owner_only(path)? {
        write_secret(lane, path, &bytes)?;
    }
    Ok(Some(bytes))
}