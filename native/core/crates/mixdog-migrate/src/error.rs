//! `migration_blocked{…}` (SM §11.5): the one way a migration step stops. Every variant
//! leaves the data dir in a state the next run resumes from; "Retry" re-enters the same
//! state machine.

use std::fmt;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocked {
    /// A filesystem or SQLite operation failed (`migration_blocked{op, path, os_error}`).
    Io {
        op: &'static str,
        path: PathBuf,
        os_error: String,
    },
    /// `mixdog-config.json` (or another singleton store) does not parse; never quarantined.
    StoreSchema { key: String, detail: String },
    /// A source no longer matches its manifest hash; nothing of the item was deleted.
    SourceChanged { path: PathBuf },
    /// A target exists that this migration did not publish.
    TargetConflict { key: String, path: PathBuf },
    /// The usage ledger is neither the 1.4.5 nor the 1.4.6-dev shape.
    LedgerSchema { detail: String },
    /// The journal or manifest is damaged or names an impossible transition.
    JournalDamage { detail: String },
    /// A fault point stopped the run (test seam for the crash matrix).
    Interrupted { point: String },
}

impl Blocked {
    pub fn io(op: &'static str, path: &Path, error: io::Error) -> Self {
        Blocked::Io {
            op,
            path: path.to_path_buf(),
            os_error: error.to_string(),
        }
    }

    pub fn sqlite(op: &'static str, path: &Path, error: rusqlite::Error) -> Self {
        Blocked::Io {
            op,
            path: path.to_path_buf(),
            os_error: error.to_string(),
        }
    }

    /// A failed `mixdog_store::fsio` primitive.
    pub fn fsio(error: mixdog_store::fsio::IoError) -> Self {
        use mixdog_store::fsio::IoOp;
        let op = match error.op {
            IoOp::Open => "open",
            IoOp::Read => "read",
            IoOp::Write => "write",
            IoOp::SyncFile => "sync",
            IoOp::SyncDir => "sync_dir",
            IoOp::Rename => "rename",
            IoOp::Truncate => "truncate",
            IoOp::CreateDir => "create_dir",
            IoOp::List => "list",
            IoOp::Remove => "remove",
        };
        Blocked::io(op, &error.path, error.source)
    }

    pub fn journal(detail: impl Into<String>) -> Self {
        Blocked::JournalDamage {
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Blocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Blocked::Io { op, path, os_error } => {
                write!(f, "migration_blocked{{{op}, {}, {os_error}}}", path.display())
            }
            Blocked::StoreSchema { key, detail } => {
                write!(f, "migration_blocked{{store_schema, {key}: {detail}}}")
            }
            Blocked::SourceChanged { path } => {
                write!(f, "migration_blocked{{source_changed, {}}}", path.display())
            }
            Blocked::TargetConflict { key, path } => write!(
                f,
                "migration_blocked{{target_conflict, {key}, {}}}",
                path.display()
            ),
            Blocked::LedgerSchema { detail } => {
                write!(f, "migration_blocked{{ledger_schema, {detail}}}")
            }
            Blocked::JournalDamage { detail } => {
                write!(f, "migration_blocked{{journal_damage, {detail}}}")
            }
            Blocked::Interrupted { point } => write!(f, "migration interrupted at {point}"),
        }
    }
}

impl std::error::Error for Blocked {}

pub type Result<T> = std::result::Result<T, Blocked>;
