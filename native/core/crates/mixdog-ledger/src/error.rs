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
    /// A statistics period or request the caller got wrong: the `TypeError` (`range: false`) or
    /// `RangeError` (`range: true`) today's service throws, with its text.
    #[error("{message}")]
    Period { range: bool, message: &'static str },
    /// The read lane's queue is full. The service layer answers `-32001` `overloaded` with
    /// `data.reason = queueFull{queue}` (SPEC R7) at once, naming the lane.
    #[error("the usage read lane {queue} is full")]
    Busy { queue: &'static str },
    /// The read job was dropped before it produced an answer: the call was cancelled or the
    /// lane stopped (the core is draining). Today's Node ledger never fails this way, so there
    /// is no overload to report: the service layer answers the request as cancelled.
    #[error("the usage read was dropped")]
    Stopped,
    #[error("repair changed immutable request records")]
    RepairIntegrity,
    #[error("invalid repair price")]
    RepairPrice,
    /// Stored rows contradict each other (a route read without the day it belongs to).
    #[error("the usage ledger is inconsistent: {0}")]
    Inconsistent(&'static str),
}
