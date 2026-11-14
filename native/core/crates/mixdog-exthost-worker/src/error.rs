//! The error a handler answers with, and the environment-failure test (`runtime/shared/environment-error.mjs`).

use std::error::Error;

/// An error with the code the pool reports to the caller (`{err:{code, message}}`).
#[derive(Debug)]
pub struct CodedError {
    pub code: String,
    pub message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl CodedError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            source: None,
        }
    }

    /// The code a call answers when a handler fails without one.
    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("failed", message)
    }

    /// The answer to a call that was cancelled.
    pub fn cancelled() -> Self {
        Self::new("cancelled", "call cancelled")
    }

    /// The failure this one wraps, which [`is_environment_error`] follows.
    pub fn with_source(mut self, source: impl Error + Send + Sync + 'static) -> Self {
        self.source = Some(Box::new(source));
        self
    }
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for CodedError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.as_deref().map(|e| e as &(dyn Error + 'static))
    }
}

/// How many wrapped causes are followed, the failure itself included.
const CAUSE_DEPTH: usize = 4;

fn is_environment_code(code: &str) -> bool {
    code.starts_with("ERR_") || code == "ENOMEM" || code == "MODULE_NOT_FOUND"
}

fn is_environment_message(message: &str) -> bool {
    let message = message.to_lowercase();
    [
        "out of memory",
        "allocation failed",
        "cannot allocate memory",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Environment failures (the machine, not the bytes): an error code such as `ERR_*`, `ENOMEM` or `MODULE_NOT_FOUND`, or an
/// out-of-memory or allocation-failed message. Anything else, such as a decoder's bad-bytes error, is a property of the input.
/// Wrapped causes are followed.
pub fn is_environment_error(error: &(dyn Error + 'static)) -> bool {
    let mut current = Some(error);
    for _ in 0..CAUSE_DEPTH {
        let Some(error) = current else { return false };
        if let Some(coded) = error.downcast_ref::<CodedError>()
            && is_environment_code(&coded.code)
        {
            return true;
        }
        if is_environment_message(&error.to_string()) {
            return true;
        }
        current = error.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_listed_codes_are_environment_failures() {
        for code in [
            "ERR_WORKER_OUT_OF_MEMORY",
            "ERR_X",
            "ENOMEM",
            "MODULE_NOT_FOUND",
        ] {
            assert!(is_environment_error(&CodedError::new(code, "x")), "{code}");
        }
        for code in ["ENOENT", "failed", "XERR_X", "ENOMEMX", "err_x"] {
            assert!(!is_environment_error(&CodedError::new(code, "x")), "{code}");
        }
    }

    #[test]
    fn the_listed_messages_are_environment_failures_in_any_case() {
        for message in [
            "JavaScript heap Out Of Memory",
            "Allocation failed",
            "cannot allocate memory",
        ] {
            assert!(
                is_environment_error(&CodedError::failed(message)),
                "{message}"
            );
        }
        assert!(!is_environment_error(&CodedError::failed("bad bytes")));
    }

    #[test]
    fn a_wrapped_cause_is_followed_to_its_depth() {
        let env = CodedError::new("ENOMEM", "x");
        assert!(is_environment_error(
            &CodedError::failed("wrapper").with_source(env)
        ));
        // Four levels are looked at: the failure and three causes.
        let deep = |levels: usize| {
            let mut error = CodedError::new("ENOMEM", "x");
            for _ in 1..levels {
                error = CodedError::failed("wrapper").with_source(error);
            }
            error
        };
        assert!(is_environment_error(&deep(4)));
        assert!(!is_environment_error(&deep(5)));
    }
}
