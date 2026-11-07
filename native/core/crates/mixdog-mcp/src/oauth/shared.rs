//! The failures of an MCP sign-in. The messages are fixed texts: they name scopes and causes,
//! never a token, a code or a server response body.

use std::collections::HashSet;

use crate::transport::TransportError;

pub const REAUTHENTICATION_REQUIRED_MESSAGE: &str = "MCP OAuth reauthenticationRequired: sign in to connect";
pub const SCOPE_NOT_GRANTED_MARKER: &str = "MCP OAuth scopeNotGranted";
pub const LOGIN_FAILED_MESSAGE: &str = "MCP OAuth login failed, cancelled, or timed out";

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("{REAUTHENTICATION_REQUIRED_MESSAGE}")]
    ReauthenticationRequired,
    #[error("{LOGIN_FAILED_MESSAGE}")]
    LoginFailed,
    #[error("{SCOPE_NOT_GRANTED_MARKER}: access not granted for {}", .0.join(" "))]
    ScopeNotGranted(Vec<String>),
    /// The secret store could not be read or written.
    #[error("MCP OAuth credential store: {0}")]
    Store(String),
    /// The store call never ran (its lane refused or dropped the job). It says nothing about the
    /// sign-in: not "reauthentication required", and never a reason to erase it.
    #[error("MCP OAuth credential store: its lane did not run the call")]
    Unavailable,
}

impl From<OAuthError> for TransportError {
    fn from(error: OAuthError) -> Self {
        match error {
            OAuthError::ReauthenticationRequired => Self::AuthRequired,
            other => Self::Other(other.to_string()),
        }
    }
}

/// Whether a connect failed only because the server needs an explicit sign-in.
pub fn is_reauthentication_required(message: &str) -> bool {
    message.contains(REAUTHENTICATION_REQUIRED_MESSAGE)
}

/// Whether a sign-in failed because the provider did not grant a requested scope.
pub fn is_scope_not_granted(message: &str) -> bool {
    message.contains(SCOPE_NOT_GRANTED_MARKER)
}

/// The identity scopes are never checked: Google answers a requested `email` with its
/// userinfo.email URL (likewise `profile`).
const BASIC_SCOPES: [&str; 3] = ["openid", "email", "profile"];

/// The requested non-basic scopes a token response's `scope` leaves out. A response without a
/// `scope` field grants what was requested (RFC 6749).
pub fn missing_scopes(requested: &[String], granted: Option<&str>) -> Vec<String> {
    let Some(granted) = granted else { return Vec::new() };
    let have: HashSet<&str> = mixdog_js::js_words(granted).collect();
    requested.iter().filter(|s| !BASIC_SCOPES.contains(&s.as_str()) && !have.contains(s.as_str())).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_scopes_and_a_missing_scope_field_are_never_missing() {
        let wanted = vec!["openid".to_owned(), "email".to_owned(), "https://x/drive".to_owned()];
        assert_eq!(missing_scopes(&wanted, Some("https://x/drive")), Vec::<String>::new());
        assert_eq!(missing_scopes(&wanted, Some("openid")), vec!["https://x/drive".to_owned()]);
        assert!(missing_scopes(&wanted, None).is_empty());
    }
}
