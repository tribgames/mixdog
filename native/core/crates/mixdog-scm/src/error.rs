//! The one failure type of the SCM engine and its single conversion to the seam's
//! `CoreError` (P §10). Codes are stable data; the English text of a failure that has no
//! structured fields travels in `DomainErrorDetail::Display` and is never parsed.

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::ScmError;
use mixdog_protocol::DomainErrorDetail;

pub const GIT_DOMAIN: &str = "git";
pub const GITHUB_DOMAIN: &str = "github";
pub const WORKTREE_DOMAIN: &str = "worktree";

pub const CODE_COMMAND_FAILED: &str = "COMMAND_FAILED";
pub const CODE_REFUSED: &str = "REFUSED";
pub const CODE_TIMED_OUT: &str = "GIT_TIMEOUT";
pub const CODE_OUTPUT_TOO_LARGE: &str = "OUTPUT_TOO_LARGE";
pub const CODE_IO: &str = "IO_ERROR";

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ScmFailure {
    #[error("not a git repository")]
    NotARepository,
    #[error("invalid parameter `{path}`: {expected}")]
    Invalid { path: String, expected: String },
    /// A program ran and failed; `text` is its scrubbed diagnostic.
    #[error("{text}")]
    Command { domain: &'static str, text: String },
    /// The program does not exist (`capabilityUnavailable{capability}`), from the spawn error
    /// kind and never from text.
    #[error("{capability} is not available")]
    Unavailable { capability: String },
    /// A read-only git child was cut off at its run limit: its answer is unknown.
    #[error("git timed out")]
    TimedOut,
    #[error("output exceeded {limit} bytes")]
    OutputTooLarge { limit: u64 },
    #[error("cancelled")]
    Cancelled,
    /// A lane queue is full: the caller answers overloaded at once.
    #[error("lane {queue} is full")]
    QueueFull { queue: String },
    /// A coded refusal of an operation with the English text a surface shows.
    #[error("{message}")]
    Refused {
        domain: &'static str,
        code: &'static str,
        message: String,
    },
    /// A coded refusal that carries structured detail (worktree and merge refusals).
    #[error("{code}")]
    Coded {
        domain: &'static str,
        code: &'static str,
        detail: Option<Box<DomainErrorDetail>>,
        /// Node's own text when one code has several messages; the display stays the code.
        message: Option<Box<str>>,
    },
    #[error("io error {os_code:?}: {message}")]
    Io {
        os_code: Option<i32>,
        message: String,
    },
    #[error("object {0:?} is missing")]
    ObjectMissing(ObjectId),
}

impl ScmFailure {
    pub fn invalid(path: impl Into<String>, expected: impl Into<String>) -> Self {
        Self::Invalid {
            path: path.into(),
            expected: expected.into(),
        }
    }

    pub fn git(text: impl Into<String>) -> Self {
        Self::Command {
            domain: GIT_DOMAIN,
            text: text.into(),
        }
    }

    pub fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self::Refused {
            domain: GIT_DOMAIN,
            code,
            message: message.into(),
        }
    }

    pub fn coded(code: &'static str, detail: DomainErrorDetail) -> Self {
        Self::Coded {
            domain: WORKTREE_DOMAIN,
            code,
            detail: Some(Box::new(detail)),
            message: None,
        }
    }

    pub fn coded_plain(code: &'static str) -> Self {
        Self::Coded {
            domain: WORKTREE_DOMAIN,
            code,
            detail: None,
            message: None,
        }
    }

    pub fn coded_with_message(code: &'static str, detail: DomainErrorDetail, message: impl Into<String>) -> Self {
        Self::Coded {
            domain: WORKTREE_DOMAIN,
            code,
            detail: Some(Box::new(detail)),
            message: Some(message.into().into_boxed_str()),
        }
    }

    /// The explicit text of a coded failure, when its producer set one.
    pub fn message(&self) -> Option<&str> {
        match self {
            Self::Coded { message, .. } => message.as_deref(),
            _ => None,
        }
    }

    /// The stable code of a coded failure, for callers that branch on it.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Coded { code, .. } | Self::Refused { code, .. } => Some(code),
            _ => None,
        }
    }

    pub fn detail(&self) -> Option<&DomainErrorDetail> {
        match self {
            Self::Coded { detail, .. } => detail.as_deref(),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ScmFailure {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            os_code: error.raw_os_error(),
            message: error.to_string(),
        }
    }
}

fn display(text: String) -> Option<Box<DomainErrorDetail>> {
    Some(Box::new(DomainErrorDetail::Display { name: text }))
}

impl From<ScmFailure> for CoreError {
    fn from(failure: ScmFailure) -> Self {
        match failure {
            ScmFailure::NotARepository => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some("NOT_A_REPOSITORY".into()),
                detail: None,
            },
            ScmFailure::Invalid { path, expected } => CoreError::InvalidParams {
                path: path.into(),
                expected: expected.into(),
            },
            ScmFailure::Command { domain, text } => CoreError::DomainError {
                domain: domain.into(),
                code: Some(CODE_COMMAND_FAILED.into()),
                detail: display(text),
            },
            ScmFailure::Unavailable { capability } => CoreError::CapabilityUnavailable {
                capability: capability.into(),
                detail: Arc::from(""),
            },
            ScmFailure::TimedOut => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_TIMED_OUT.into()),
                detail: None,
            },
            ScmFailure::OutputTooLarge { limit } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_OUTPUT_TOO_LARGE.into()),
                detail: display(limit.to_string()),
            },
            ScmFailure::Cancelled => CoreError::Cancelled { by: "caller".into() },
            ScmFailure::QueueFull { queue } => CoreError::QueueFull {
                queue: queue.into(),
            },
            ScmFailure::Refused {
                domain,
                code,
                message,
            } => CoreError::DomainError {
                domain: domain.into(),
                code: Some(code.into()),
                detail: display(message),
            },
            // Node sends `error.message` with the code to every client, and a code with
            // several messages (`WORKTREE_BUSY_JOBS` transition) needs it: an explicit message
            // travels as `ExternalFailure`, like the other services' failure text.
            ScmFailure::Coded {
                domain,
                code,
                detail,
                message,
            } => CoreError::DomainError {
                domain: domain.into(),
                code: Some(code.into()),
                detail: match message {
                    Some(message) => Some(Box::new(DomainErrorDetail::ExternalFailure { message: message.into_string() })),
                    None => detail,
                },
            },
            ScmFailure::Io { message, .. } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_IO.into()),
                detail: display(message),
            },
            ScmFailure::ObjectMissing(id) => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some("OBJECT_MISSING".into()),
                detail: display(id.0),
            },
        }
    }
}

impl From<ScmFailure> for ScmError {
    fn from(failure: ScmFailure) -> Self {
        match failure {
            ScmFailure::NotARepository => ScmError::NotARepository,
            ScmFailure::ObjectMissing(id) => ScmError::ObjectMissing { id },
            ScmFailure::Io { os_code, .. } => ScmError::Io { os_code },
            other => ScmError::Corrupt {
                detail: other.to_string(),
            },
        }
    }
}

/// Credentials in URLs and query strings never reach a diagnostic.
pub fn scrub_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = find_scheme(rest) {
        let (head, tail) = rest.split_at(at);
        out.push_str(head);
        let scheme_end = tail.find("://").expect("find_scheme found it") + 3;
        out.push_str(&tail[..scheme_end]);
        let after = &tail[scheme_end..];
        let authority_end = after
            .find(|c: char| c == '/' || c.is_whitespace())
            .unwrap_or(after.len());
        match after[..authority_end].rfind('@') {
            Some(user_end) => {
                out.push_str("[redacted]@");
                rest = &after[user_end + 1..];
            }
            None => rest = after,
        }
    }
    out.push_str(rest);
    scrub_query_secrets(&out)
}

fn find_scheme(text: &str) -> Option<usize> {
    ["https://", "http://", "ssh://"]
        .iter()
        .filter_map(|scheme| text.find(scheme))
        .min()
}

const SECRET_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "api-key",
    "apikey",
    "auth",
    "password",
    "secret",
    "signature",
    "token",
];

fn scrub_query_secrets(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let lower = text.to_ascii_lowercase();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if (c == b'?' || c == b'&') && i + 1 < bytes.len() {
            let tail = &lower[i + 1..];
            if let Some(key) = SECRET_KEYS
                .iter()
                .find(|key| tail.starts_with(*key) && tail[key.len()..].starts_with('='))
            {
                let value_start = i + 1 + key.len() + 1;
                let value_end = text[value_start..]
                    .find(|ch: char| ch == '&' || ch.is_whitespace() || ch == '\'' || ch == '"')
                    .map_or(text.len(), |n| value_start + n);
                out.push(c as char);
                out.push_str(&text[i + 1..value_start]);
                out.push_str("[redacted]");
                i = value_end;
                continue;
            }
        }
        let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_userinfo_and_query_secrets_are_redacted() {
        assert_eq!(
            scrub_credentials("fatal: https://user:pw@example.com/a.git?token=abc&x=1 failed"),
            "fatal: https://[redacted]@example.com/a.git?token=[redacted]&x=1 failed"
        );
        assert_eq!(scrub_credentials("no secrets here"), "no secrets here");
    }

    #[test]
    fn failure_codes_reach_the_seam_error() {
        let error: CoreError = ScmFailure::git("fatal: x").into();
        match error {
            CoreError::DomainError {
                domain,
                code,
                detail,
            } => {
                assert_eq!(&*domain, "git");
                assert_eq!(code.as_deref(), Some(CODE_COMMAND_FAILED));
                assert_eq!(
                    detail.as_deref(),
                    Some(&DomainErrorDetail::Display {
                        name: "fatal: x".into()
                    })
                );
            }
            other => panic!("{other:?}"),
        }
    }
}
