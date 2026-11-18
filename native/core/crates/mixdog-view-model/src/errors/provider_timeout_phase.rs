//! The phase a provider timeout names on its `timeoutPhase` field (`provider-timeout-phase.mjs`). A provider stamps it
//! where the timer that fired is known; retry policy and error presentation read it instead of the timeout's message text.

use serde_json::Value;

use super::js_value::Js;
use super::js_value::get;

/// The response headers did not arrive in the first-byte window.
pub const HEADERS: &str = "headers";
/// The headers arrived, the first chunk did not.
pub const FIRST_CHUNK: &str = "first-chunk";
/// A stream that already produced output went silent.
pub const IDLE: &str = "idle";
/// A sign-in token refresh did not answer: an auth problem, not a slow model.
pub const AUTH: &str = "auth";

/// The `timeoutPhase` stamp of a failure, when it is a string.
pub fn timeout_phase(error: Js<'_>) -> Option<&str> {
    get(error, "timeoutPhase").and_then(Value::as_str)
}

/// A timeout before the model produced anything: headers or first chunk.
pub fn is_first_byte_timeout(error: Js) -> bool {
    matches!(timeout_phase(error), Some(HEADERS | FIRST_CHUNK))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_headers_and_first_chunk_are_first_byte() {
        for (phase, first_byte) in [("headers", true), ("first-chunk", true), ("idle", false), ("auth", false), ("", false)] {
            assert_eq!(is_first_byte_timeout(Some(&json!({ "timeoutPhase": phase }))), first_byte, "{phase}");
        }
        assert!(!is_first_byte_timeout(None));
        assert!(!is_first_byte_timeout(Some(&json!("headers"))));
        assert!(!is_first_byte_timeout(Some(&json!({ "timeoutPhase": 1 }))));
    }
}
