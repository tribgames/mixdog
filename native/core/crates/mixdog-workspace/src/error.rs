//! The one error of the workspace domain. `reason` is the stable machine value
//! (wire `data.reason`); `message` keeps today's user-visible text.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reason {
    InvalidParams,
    /// Path outside the project or the connection's reach.
    PermissionDenied,
    NotFound,
    AlreadyExists,
    NotAFile,
    /// Node's `canonicalDirectory` on a path that does not exist (`realpath` failed with `ENOENT`). The error's message is the
    /// path as the caller gave it, which is all the OS error names; the client rebuilds Node's text from it.
    PathMissing,
    /// Node's `canonicalDirectory` on a path that is not a folder; the message is Node's text.
    NotADirectory,
    /// An attachment the session's conversation does not name (Node's `not-linked`).
    NotLinked,
    /// Compare-and-set mismatch; `actual` is the current content.
    PreconditionFailed { expected: Vec<u8>, actual: Vec<u8> },
    TooLarge,
    /// The file or folder changed under a transfer or a save.
    Changed,
    Expired,
    Busy,
    /// An upload chunk that does not start where the received bytes end.
    OutOfOrder,
    /// A one-file grant that is not held, has expired or lost its conversation (Node's `SELECTED_FILE_GRANT_UNAVAILABLE`).
    GrantUnavailable,
    /// A one-file grant presented for a path other than the file it names.
    GrantMismatch,
    FolderTooLarge,
    /// A `RECOVERY_*` code of the recovery journal.
    Recovery(&'static str),
    InvalidEncoding,
    Unsupported,
    Overloaded,
    Cancelled,
    Io,
    /// Node's `Error` that carried a `code` of its own - a system error's `ENOENT`, `PROJECT_UNAVAILABLE` - with Node's text as the
    /// message. Answered as a code-bearing `domainError`, so a client rebuilds the error Node threw.
    Coded(&'static str),
    /// Node's plain `Error`: a text and no code. Answered as a code-less `domainError`.
    Plain,
}

impl Reason {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidParams => "invalidParams",
            Self::PermissionDenied => "permissionDenied",
            Self::NotFound => "notFound",
            Self::AlreadyExists => "alreadyExists",
            Self::NotAFile => "notAFile",
            Self::PathMissing => "pathMissing",
            Self::NotADirectory => "notADirectory",
            Self::NotLinked => "notLinked",
            Self::PreconditionFailed { .. } => "preconditionFailed",
            Self::TooLarge => "tooLarge",
            Self::Changed => "changed",
            Self::Expired => "expired",
            Self::Busy => "busy",
            Self::OutOfOrder => "outOfOrder",
            Self::GrantUnavailable => "SELECTED_FILE_GRANT_UNAVAILABLE",
            Self::GrantMismatch => "grantMismatch",
            Self::FolderTooLarge => "folderTooLarge",
            Self::Recovery(code) => code,
            Self::InvalidEncoding => "invalidEncoding",
            Self::Unsupported => "unsupported",
            Self::Overloaded => "overloaded",
            Self::Cancelled => "cancelled",
            Self::Io => "io",
            Self::Coded(code) => code,
            Self::Plain => "plain",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WsError {
    pub reason: Reason,
    pub message: String,
}

pub type WsResult<T> = Result<T, WsError>;

impl WsError {
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        Self { reason, message: message.into() }
    }
    /// Node's error with a `code` of its own (see [`Reason::Coded`]).
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(Reason::Coded(code), message)
    }
    /// Node's plain `Error` with only a message (see [`Reason::Plain`]).
    pub fn plain(message: impl Into<String>) -> Self {
        Self::new(Reason::Plain, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Reason::InvalidParams, message)
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(Reason::PermissionDenied, message)
    }
    pub fn changed() -> Self {
        Self::new(Reason::Changed, "The file changed on the host.")
    }
    pub fn expired() -> Self {
        Self::new(Reason::Expired, "This download is no longer available.")
    }
    pub fn precondition(expected: &str, actual: &str) -> Self {
        Self::new(
            Reason::PreconditionFailed { expected: expected.into(), actual: actual.into() },
            "File changed on disk. Reload or keep your edits before saving.",
        )
    }
}

impl fmt::Display for WsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.reason.code(), self.message)
    }
}

impl std::error::Error for WsError {}

impl From<std::io::Error> for WsError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind as K;
        let reason = match error.kind() {
            K::NotFound => Reason::NotFound,
            K::PermissionDenied => Reason::PermissionDenied,
            K::AlreadyExists => Reason::AlreadyExists,
            _ => Reason::Io,
        };
        Self::new(reason, error.to_string())
    }
}

impl From<mixdog_rt::LaneFull> for WsError {
    fn from(full: mixdog_rt::LaneFull) -> Self {
        Self::new(Reason::Overloaded, full.to_string())
    }
}
