//! New files with their access control set at creation (no readable window), for the
//! staged copies of secrets and the config that may hold credentials. Owner-only creation
//! and its check are WP-STORE's `fsio`; publication and syncing are `crate::durable`'s.

use std::fs::File;
use std::io::Read;
use std::io::Write;
use std::path::Path;

use mixdog_store::fsio;
use mixdog_store::fsio::Access;
use sha2::Digest as _;
use sha2::Sha256;

use crate::json::hex;

fn access(secret: bool) -> Access {
    if secret { Access::OwnerOnly } else { Access::Inherit }
}

fn plain(error: fsio::IoError) -> std::io::Error {
    error.source
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Writes `bytes` to a new synced file, replacing a stage file an interrupted run left.
pub(super) fn write_new(path: &Path, bytes: &[u8], secret: bool) -> std::io::Result<()> {
    remove_if_present(path)?;
    fsio::publish_file_with(path, bytes, access(secret)).map_err(plain)
}

/// Copies `from` to a new synced file at `to`; returns the size and SHA-256 copied.
pub(super) fn copy_new(from: &Path, to: &Path, secret: bool) -> std::io::Result<(u64, String)> {
    remove_if_present(to)?;
    let mut source = File::open(from)?;
    let mut target = fsio::create_new_file(to, access(secret)).map_err(plain)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        target.write_all(&buffer[..read])?;
        size += read as u64;
    }
    fsio::flush(&target)?;
    Ok((size, hex(&hasher.finalize())))
}

/// Whether only the owner can read `path`.
pub(super) fn is_owner_only(path: &Path) -> std::io::Result<bool> {
    fsio::is_owner_only(path).map_err(plain)
}
