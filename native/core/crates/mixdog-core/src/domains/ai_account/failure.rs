//! How a Node throw reaches the wire: `call-route.mjs` answers `{ error: message }` and adds
//! `code` only when the error has one, so a `TypeError` and a plain `Error` are the same answer.

use mixdog_core_api::CoreError;
use mixdog_ledger::LedgerError;

use crate::domains::support::coded;
use crate::domains::support::failed;

/// A refusal in Node's vocabulary. `Type` keeps the thrown class for the golden tests only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Type(String),
    Error(String),
    /// An `Error` with a `code` property (`MODEL_CREDENTIALS_DISABLED`).
    Coded { code: &'static str, message: String },
}

impl Failure {
    pub fn error(message: impl Into<String>) -> Self {
        Self::Error(message.into())
    }

    pub fn type_error(message: impl Into<String>) -> Self {
        Self::Type(message.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Type(m) | Self::Error(m) => m,
            Self::Coded { message, .. } => message,
        }
    }

    pub fn into_core(self, domain: &'static str) -> CoreError {
        match self {
            Self::Type(m) | Self::Error(m) => failed(domain, m),
            Self::Coded { code, message } => coded(domain, code, message),
        }
    }
}

/// The ledger reader's refusals: a period the caller got wrong is Node's `TypeError`/`RangeError`
/// text; a full read lane is `queueFull`.
pub fn ledger_failure(error: LedgerError, domain: &'static str) -> CoreError {
    match error {
        LedgerError::Period { message, .. } => failed(domain, message),
        LedgerError::Busy { queue } => CoreError::QueueFull { queue: queue.into() },
        LedgerError::Stopped => CoreError::Cancelled { by: "caller".into() },
        other => failed(domain, other.to_string()),
    }
}
