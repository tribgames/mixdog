//! The one failure type of the SCM engine and its single conversion to the seam's
//! `CoreError` (P §10). Codes are stable data; the English text of a failure that has no
//! structured fields travels as the error's `message` and is never parsed.

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
pub const CODE_NOT_A_REPOSITORY: &str = "NOT_A_REPOSITORY";

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
    /// `command` is the program and its arguments as Node's runner worded them (`git status -z`).
    /// The operating system refused to start the program for a reason other than its absence; Node threw `spawn <CODE>` with that
    /// libuv code (`UNKNOWN` for a file the loader cannot run).
    #[error("spawn {code}")]
    Spawn { code: &'static str, timing: crate::exec::SpawnTiming },
    #[error("{command} timed out after {millis}ms")]
    TimedOut { command: String, millis: u64 },
    #[error("{command} exceeded {limit} output bytes")]
    OutputTooLarge { command: String, limit: u64 },
    /// Node's `AbortError` message, which an aborted git call carries.
    #[error("This operation was aborted")]
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

/// What git prints outside a repository (Node surfaced git's own stderr).
pub const NOT_A_REPOSITORY_TEXT: &str = "fatal: not a git repository (or any of the parent directories): .git";

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

impl From<ScmFailure> for CoreError {
    fn from(failure: ScmFailure) -> Self {
        match failure {
            // Node let git say it: the stderr of the command that ran outside a repository. The code is the core's own
            // (Node's error had none); the phone's adapter leaves it out (renderer/remote-protocol-scm.ts).
            ScmFailure::NotARepository => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_NOT_A_REPOSITORY.into()),
                message: Some(NOT_A_REPOSITORY_TEXT.into()),
                detail: None,
            },
            ScmFailure::Invalid { path, expected } => CoreError::InvalidParams {
                path: path.into(),
                expected: expected.into(),
            },
            ScmFailure::Command { domain, text } => CoreError::DomainError {
                domain: domain.into(),
                code: Some(CODE_COMMAND_FAILED.into()),
                message: Some(text.into()),
                detail: None,
            },
            ScmFailure::Unavailable { capability } => CoreError::CapabilityUnavailable {
                capability: capability.into(),
                detail: Arc::from(""),
            },
            ScmFailure::Spawn { code, .. } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(code.into()),
                message: Some(format!("spawn {code}").into()),
                detail: None,
            },
            ScmFailure::TimedOut { command, millis } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_TIMED_OUT.into()),
                message: Some(format!("{command} timed out after {millis}ms").into()),
                detail: None,
            },
            ScmFailure::OutputTooLarge { command, limit } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_OUTPUT_TOO_LARGE.into()),
                message: Some(format!("{command} exceeded {limit} output bytes").into()),
                detail: None,
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
                message: Some(message.into()),
                detail: None,
            },
            ScmFailure::Coded {
                domain,
                code,
                detail,
                message,
            } => CoreError::DomainError {
                domain: domain.into(),
                code: Some(code.into()),
                message: match message {
                    Some(text) => Some(text.into()),
                    None => crate::worktree::texts::contract_message(code, detail.as_deref()).map(Into::into),
                },
                detail,
            },
            ScmFailure::Io { message, .. } => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some(CODE_IO.into()),
                message: Some(message.into()),
                detail: None,
            },
            ScmFailure::ObjectMissing(id) => CoreError::DomainError {
                domain: GIT_DOMAIN.into(),
                code: Some("OBJECT_MISSING".into()),
                message: Some(id.0.into()),
                detail: None,
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
            ScmFailure::Unavailable { capability } => ScmError::Unavailable { capability },
            ScmFailure::TimedOut { command, millis } => ScmError::TimedOut { command, millis },
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
    fn a_coded_failure_reaches_the_seam_with_its_message_and_its_typed_detail() {
        let error: CoreError = crate::worktree::errors::busy(crate::worktree::errors::RefusalReason::FolderInUse).into();
        let CoreError::DomainError { code, message, detail, .. } = error else { panic!("{error:?}") };
        assert_eq!(code.as_deref(), Some("WORKTREE_BUSY_JOBS"));
        assert_eq!(message.as_deref(), Some("Sessions or workers still use an affected folder. Finish or move them before continuing."));
        assert!(matches!(detail.as_deref(), Some(DomainErrorDetail::WorktreeBusyJobs { reason, .. }) if reason == "folder-in-use"));
    }

    #[test]
    fn failure_codes_reach_the_seam_error() {
        let error: CoreError = ScmFailure::git("fatal: x").into();
        match error {
            CoreError::DomainError {
                domain,
                code,
                message,
                detail,
            } => {
                assert_eq!(&*domain, "git");
                assert_eq!(code.as_deref(), Some(CODE_COMMAND_FAILED));
                assert_eq!(message.as_deref(), Some("fatal: x"));
                assert_eq!(detail, None);
            }
            other => panic!("{other:?}"),
        }
    }

    fn domain(failure: ScmFailure) -> (Option<String>, Option<String>) {
        let CoreError::DomainError { code, message, .. } = CoreError::from(failure) else { panic!("not a domain error") };
        (code.map(|code| code.to_string()), message.map(|message| message.to_string()))
    }

    #[test]
    fn a_deadline_and_an_overflow_read_as_node_worded_them() {
        let timed_out = ScmFailure::TimedOut { command: "git status -z".into(), millis: 60_000 };
        assert_eq!(domain(timed_out), (Some("GIT_TIMEOUT".into()), Some("git status -z timed out after 60000ms".into())));
        let overflow = ScmFailure::OutputTooLarge { command: "git log -z".into(), limit: 32_000_000 };
        assert_eq!(domain(overflow), (Some("OUTPUT_TOO_LARGE".into()), Some("git log -z exceeded 32000000 output bytes".into())));
    }

    /// The core's own codes stay what every caller of the engine has always read; only the text is Node's.
    #[test]
    fn outside_a_repository_git_says_so_under_the_codes_every_caller_reads() {
        assert_eq!(
            domain(ScmFailure::NotARepository),
            (Some("NOT_A_REPOSITORY".into()), Some("fatal: not a git repository (or any of the parent directories): .git".into()))
        );
        assert_eq!(
            domain(ScmFailure::refused("UNKNOWN_FLOW", "Unknown GitHub login flow.")),
            (Some("UNKNOWN_FLOW".into()), Some("Unknown GitHub login flow.".into()))
        );
        assert_eq!(domain(ScmFailure::Io { os_code: None, message: "x".into() }).0.as_deref(), Some("IO_ERROR"));
        assert_eq!(domain(ScmFailure::refused("git-reset-dirty-worktree", "x")).0.as_deref(), Some("git-reset-dirty-worktree"));
    }
}