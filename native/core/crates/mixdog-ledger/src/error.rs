use thiserror::Error;

pub type Result<T, E = LedgerError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// The file's objects are not exactly one of the recognized shapes
    /// (`migration_blocked{ledger_schema}`).
    #[error("the usage ledger schema is not a recognized shape")]
    UnrecognizedSchema,
    #[error("unsupported usage ledger version {0}")]
    UnsupportedVersion(i64),
    #[error("usage requires {0}")]
    Invalid(&'static str),
    /// The per-session sums answer only once they hold every stored record.
    #[error("the usage ledger is still building its session sums")]
    SumsBuilding,
    #[error("repair changed immutable request records")]
    RepairIntegrity,
    #[error("invalid repair price")]
    RepairPrice,
    /// Stored rows contradict each other (a route read without the day it belongs to).
    #[error("the usage ledger is inconsistent: {0}")]
    Inconsistent(&'static str),
}
