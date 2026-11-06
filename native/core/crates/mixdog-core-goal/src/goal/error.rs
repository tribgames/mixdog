//! The error of the Goal runtime: what Node throws as a plain `Error`, whose message is the
//! whole answer.

/// `Error(message)`. `code` is the `error.code` Node attaches in two places; `rollback_failed`
/// is `error.quotaResumeRollbackFailed`.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{message}")]
pub struct GoalError {
    pub message: String,
    pub code: Option<&'static str>,
    pub rollback_failed: bool,
}

impl GoalError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, rollback_failed: false }
    }

    pub fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self { message: message.into(), code: Some(code), rollback_failed: false }
    }
}

pub type GoalResult<T> = Result<T, GoalError>;

impl From<std::io::Error> for GoalError {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

impl From<mixdog_statefile::LockError> for GoalError {
    fn from(error: mixdog_statefile::LockError) -> Self {
        let code = error.code();
        match code {
            Some(code) => Self::coded(code, error.to_string()),
            None => Self::new(error.to_string()),
        }
    }
}
