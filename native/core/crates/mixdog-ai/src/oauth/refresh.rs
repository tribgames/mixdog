//! Definitive versus transient refresh failure (PW §6.3). Reads the status and
//! the RFC 6749 §5.2 error code only, never the description text.

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

const DEAD_GRANT_CODES: [&str; 7] = [
    "invalid_grant",
    "invalid_token",
    "unauthorized_client",
    "invalid_client",
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
];

fn error_code(body: &Value) -> Option<&str> {
    let error = body.get("error")?;
    // RFC 6749 uses a string; some providers nest `{code}` or add `error_code`.
    error
        .as_str()
        .or_else(|| error.get("code").and_then(Value::as_str))
        .or_else(|| body.get("error_code").and_then(Value::as_str))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        use RefreshFailure::*;
        let dead = br#"{"error":"invalid_grant","error_description":"temporarily unavailable"}"#;
        assert_eq!(classify_refresh_failure(Some(400), dead), Definitive);
        assert_eq!(
            classify_refresh_failure(Some(401), br#"{"error":{"code":"refresh_token_reused"}}"#),
            Definitive
        );
        assert_eq!(classify_refresh_failure(Some(503), dead), Transient);
        assert_eq!(classify_refresh_failure(Some(429), b""), Transient);
        assert_eq!(classify_refresh_failure(None, b""), Transient);
        assert_eq!(classify_refresh_failure(Some(401), b"not json"), Unknown);
        assert_eq!(
            classify_refresh_failure(Some(400), br#"{"error":"invalid_request"}"#),
            Unknown
        );
    }
}