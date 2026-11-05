//! `VACUUM INTO` backup. The copy is taken on a separate read-only connection so it is a
//! coherent snapshot while WAL readers and the writer's own open transaction continue
//! (the writer's uncommitted changes are not in it).

use std::path::Path;
use std::path::PathBuf;

use rusqlite::OpenFlags;

use crate::db::Connection;
use crate::error::LedgerError;
use crate::error::Result;

/// The file `conn` was opened on; `None` for an in-memory database.
pub fn database_path(conn: &Connection) -> Result<Option<PathBuf>> {
    let path = conn.path().filter(|p| !p.is_empty()).map(PathBuf::from);
    Ok(path)
}

/// Writes a compacted, coherent copy of `conn`'s database to `dest` (which must not exist).
pub fn vacuum_into(conn: &Connection, dest: &Path) -> Result<()> {
    let source = database_path(conn)?.ok_or(LedgerError::Invalid("a file-backed ledger"))?;
    let reader = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    reader.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])?;
    Ok(())
}

/// A fresh `pricing-backup-*` directory beside the ledger holding `ledger.sqlite`, the layout
/// repairs have always used. Returns the backup file's path.
#[allow(
    clippy::disallowed_methods,
    reason = "maintenance job body: runs on the ledger writer's lane, not an async task"
)]
pub fn backup_beside(conn: &Connection) -> Result<PathBuf> {
    let source = database_path(conn)?.ok_or(LedgerError::Invalid("a file-backed ledger"))?;
    let parent = source.parent().unwrap_or(Path::new("."));
    let mut attempt = 0u32;
    let directory = loop {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let candidate = parent.join(format!("pricing-backup-{nanos:x}-{attempt}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => attempt += 1,
            Err(e) => return Err(LedgerError::Io(e)),
        }
    };
    let backup = directory.join("ledger.sqlite");
    vacuum_into(conn, &backup)?;
    Ok(backup)
}
