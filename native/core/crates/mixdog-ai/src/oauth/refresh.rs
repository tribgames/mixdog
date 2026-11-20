//! Definitive versus transient refresh failure (PW §6.3). Reads the status and
//! the RFC 6749 §5.2 error code only, never the description text.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RefreshFailure {
    /// The grant is dead: the account must sign in again.
    Definitive,
    /// Retry later: a transport fault, 403, 429 or a server error.
    Transient,
    /// A rejection that states no reason. Surface it; do not mark the
    /// account as needing re-authentication.
    Unknown,
}

const DEAD_GRANT_CODES: [&str; 7] =
    ["invalid_grant", "invalid_token", "unauthorized_client", "invalid_client", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"];

fn error_code(body: &Value) -> Option<&str> {
    let error = body.get("error")?;
    // RFC 6749 uses a string; some providers nest `{code}` or add `error_code`.
    error.as_str().or_else(|| error.get("code").and_then(Value::as_str)).or_else(|| body.get("error_code").and_then(Value::as_str))
}

/// `status` is `None` when no response arrived (a transport fault).
pub fn classify_refresh_failure(status: Option<u16>, body: &[u8]) -> RefreshFailure {
    match status {
        None | Some(403 | 429 | 500..) => return RefreshFailure::Transient,
        Some(_) => {}
    }
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    match parsed.as_ref().and_then(error_code) {
        Some(code) if DEAD_GRANT_CODES.contains(&code) => RefreshFailure::Definitive,
        _ => RefreshFailure::Unknown,
    }
}

// Node's own expressions on the JavaScript engine: `\b` is ASCII there, and `i` folds as the engine does.
static TRANSIENT_TEXT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"\b(?:403|429|50[0-4])\b|rate[ _-]?limit|too many requests|bad gateway|service unavailable|gateway time-?out|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network",
        "i",
    )
});
static DEAD_GRANT_TEXT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"invalid_grant|invalid_token|unauthorized_client|refresh[ _-]?token[^.\n]{0,40}\b(?:expired|revoked)\b", "i"));

/// `isDefinitiveOAuthFailure` (`lib/oauth-token-utils.mjs`): Anthropic's reading of a refresh answer. A
/// 403, 429 or server error never is; the body text decides next (a transient word says no, a dead-grant word
/// says yes); a bare 401 is a dead grant.
pub fn is_definitive_oauth_failure(body: &str, status: u16) -> bool {
    if matches!(status, 403 | 429 | 500..) || TRANSIENT_TEXT.is_match(body) {
        return false;
    }
    DEAD_GRANT_TEXT.is_match(body) || status == 401
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropics_reading_of_a_refresh_answer() {
        assert!(is_definitive_oauth_failure("not json", 401));
        assert!(is_definitive_oauth_failure("Refresh token has expired.", 400));
        assert!(is_definitive_oauth_failure(r#"{"error":"invalid_grant"}"#, 400));
        assert!(!is_definitive_oauth_failure("upstream timeout", 401));
        assert!(!is_definitive_oauth_failure("", 403));
        assert!(!is_definitive_oauth_failure("invalid_grant", 503));
        assert!(!is_definitive_oauth_failure("bad request", 400));
        // Edge bodies as Node's `isDefinitiveOAuthFailure` answered them when run on node: `\b` is ASCII there, so a
        // `403` glued to CJK text is still a word of its own and keeps the account.
        for (body, status, node) in [
            ("错误403错误 invalid_grant", 400, false),
            ("x403 invalid_grant", 400, true),
            ("invalid_grant 403", 400, false),
            ("ａ refresh token expired.", 400, true),
            ("Refresh_Token has been Revoked", 400, true),
            ("İNVALID_GRANT", 400, false),
            ("ﬁ network", 401, false),
            ("ſervice unavailable invalid_grant", 400, true),
            ("abc", 401, true),
            ("5０3 invalid_grant", 400, true),
            ("refresh token expiredé", 400, true),
        ] {
            assert_eq!(is_definitive_oauth_failure(body, status), node, "{body:?} at {status}");
        }
    }

    #[test]
    fn classification() {
        use RefreshFailure::*;
        let dead = br#"{"error":"invalid_grant","error_description":"temporarily unavailable"}"#;
        assert_eq!(classify_refresh_failure(Some(400), dead), Definitive);
        assert_eq!(classify_refresh_failure(Some(401), br#"{"error":{"code":"refresh_token_reused"}}"#), Definitive);
        assert_eq!(classify_refresh_failure(Some(503), dead), Transient);
        assert_eq!(classify_refresh_failure(Some(429), b""), Transient);
        assert_eq!(classify_refresh_failure(None, b""), Transient);
        assert_eq!(classify_refresh_failure(Some(401), b"not json"), Unknown);
        assert_eq!(classify_refresh_failure(Some(400), br#"{"error":"invalid_request"}"#), Unknown);
    }
}
