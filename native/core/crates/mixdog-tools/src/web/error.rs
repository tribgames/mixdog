//! One typed error for the whole fetch path. The kind carries every decision
//! the pipeline makes (fatal, retryable, challenge); nothing is read back out
//! of message text.

use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FetchKind {
    /// Address, scheme, userinfo, size, content-type or redirect-count policy.
    /// Never retried and never handed to the render stage.
    Policy,
    /// Non-2xx response.
    Http,
    /// `cf-mitigated: challenge` response.
    Challenge,
    /// Connect/transfer failure that may succeed on a second try.
    NetworkTransient,
    Network,
    /// The whole budget ran out.
    Timeout,
    /// One stage's share of the budget ran out.
    StageTimeout,
    Cancelled,
    EmptyContent,
}

#[derive(Clone, Debug)]
pub struct FetchError {
    pub kind: FetchKind,
    pub message: String,
    pub status: Option<u16>,
    pub retry_after: Duration,
}

impl FetchError {
    pub fn new(kind: FetchKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            retry_after: Duration::ZERO,
        }
    }

    pub fn policy(message: impl Into<String>) -> Self {
        Self::new(FetchKind::Policy, message)
    }

    pub fn network(error: &reqwest::Error) -> Self {
        // A policy decision made inside the connector surfaces as this error's
        // source; it keeps its own kind.
        let mut cause = std::error::Error::source(error);
        while let Some(inner) = cause {
            if let Some(typed) = inner.downcast_ref::<FetchError>() {
                return typed.clone();
            }
            cause = inner.source();
        }
        let transient = error.is_connect() || error.is_timeout() || error.is_body() || error.is_decode();
        let kind = if transient {
            FetchKind::NetworkTransient
        } else {
            FetchKind::Network
        };
        let mut detail = String::new();
        let mut source = std::error::Error::source(error);
        while let Some(cause) = source {
            detail = cause.to_string();
            source = cause.source();
        }
        let message = if detail.is_empty() {
            "fetch failed".to_string()
        } else {
            format!("fetch failed: {detail}")
        };
        Self::new(kind, message)
    }

    /// The stable failure code shown in diagnostics.
    pub fn code(&self) -> &'static str {
        match self.kind {
            FetchKind::Policy => "POLICY_BLOCKED",
            FetchKind::Challenge => "BLOCKED_CONTENT",
            FetchKind::EmptyContent => "EMPTY_CONTENT",
            FetchKind::Timeout => "FETCH_TIMEOUT",
            FetchKind::StageTimeout => "STAGE_TIMEOUT",
            FetchKind::Cancelled => "FETCH_CANCELLED",
            FetchKind::Http | FetchKind::NetworkTransient | FetchKind::Network => match self.status {
                Some(429) => "RATE_LIMITED",
                Some(401) => "LOGIN_REQUIRED",
                Some(403) => "HTTP_BLOCKED",
                Some(_) => "HTTP_ERROR",
                None => "NETWORK_ERROR",
            },
        }
    }
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FetchError {}
