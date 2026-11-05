//! Outcomes of one item's stage, publish or verify step: the item is quarantined, or the
//! run is blocked (`crate::error::Blocked`, SM §11.5).

use std::fmt;
use std::path::Path;

use mixdog_store::schema::migration::QuarantineCode;

use crate::error::Blocked;

/// The item cannot be converted or verified: the framework quarantines it with `code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemFailure {
    pub code: QuarantineCode,
    /// Never carries file content (secrets are class C).
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyError {
    Quarantine(ItemFailure),
    Blocked(Blocked),
}

impl ApplyError {
    pub fn quarantine(code: QuarantineCode, detail: impl Into<String>) -> Self {
        Self::Quarantine(ItemFailure {
            code,
            detail: detail.into(),
        })
    }

    /// A step that stops the run for a reason outside the item.
    pub fn blocked(op: &'static str, path: &Path, os_error: impl fmt::Display) -> Self {
        Self::Blocked(Blocked::Io {
            op,
            path: path.to_path_buf(),
            os_error: os_error.to_string(),
        })
    }

    pub fn io(op: &'static str, path: &Path, error: std::io::Error) -> Self {
        Self::Blocked(Blocked::io(op, path, error))
    }
}

impl From<Blocked> for ApplyError {
    fn from(blocked: Blocked) -> Self {
        Self::Blocked(blocked)
    }
}

impl fmt::Display for ApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Quarantine(failure) => write!(f, "{:?}: {}", failure.code, failure.detail),
            Self::Blocked(blocked) => blocked.fmt(f),
        }
    }
}

impl std::error::Error for ApplyError {}

pub(super) type Step<T> = Result<T, ApplyError>;
