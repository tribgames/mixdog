//! Wire pieces shared by the Connect+protobuf providers (`cursor`, `devin`).
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod frame;
pub mod pb;
pub mod rewrite;
pub mod stream;

use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;

use crate::retry::classify::Facts;
use crate::retry::classify::kind_of;

/// The Connect error code vocabulary (`connectrpc.com/connect`) with the
/// HTTP-equivalent status each code stands for. A code outside the
/// vocabulary is `unknown`.
pub fn connect_code_status(code: &str) -> Option<u16> {
    Some(match code {
        "canceled" => 499,
        "unknown" => 500,
        "invalid_argument" => 400,
        "deadline_exceeded" => 504,
        "not_found" => 404,
        "already_exists" => 409,
        "permission_denied" => 403,
        "resource_exhausted" => 429,
        "failed_precondition" => 400,
        "aborted" => 409,
        "out_of_range" => 400,
        "unimplemented" => 501,
        "internal" => 500,
        "unavailable" => 503,
        "data_loss" => 500,
        "unauthenticated" => 401,
        _ => return None,
    })
}

/// The Connect code a bare HTTP status stands for when the response carried
/// no Connect error body.
pub fn status_connect_code(status: u16) -> Option<&'static str> {
    Some(match status {
        400 => "invalid_argument",
        401 => "unauthenticated",
        403 => "permission_denied",
        404 => "not_found",
        408 | 504 => "deadline_exceeded",
        429 => "resource_exhausted",
        500 => "internal",
        502 | 503 => "unavailable",
        _ => return None,
    })
}

/// The tool-call arguments slot of a call whose JSON could not be parsed
/// although the stream ended cleanly: the dispatch loop returns the parse
/// error to the model as an error result so it can re-issue the call.
pub fn invalid_tool_args_marker(raw: &str, error: &str) -> serde_json::Value {
    serde_json::json!({
        "__invalidToolArgs": true,
        "__rawArguments": raw,
        "__parseError": error,
    })
}

/// What a Connect failure (end-stream error object or error response body)
/// carried.
#[derive(Debug, Clone, Default)]
pub struct ConnectFailure {
    /// The Connect code, lowercase; empty when the failure had none.
    pub code: String,
    pub message: String,
    /// The HTTP status of the response, when the failure came with one.
    pub http_status: Option<u16>,
    pub retry_after: Option<Duration>,
}

/// The one classification of a Connect failure: kind from the typed code
/// (and status) through the shared rules; the message text is read only by the shared wording fallbacks. A code
/// outside the Connect vocabulary is `unknown`, and a failure with neither
/// code nor status keeps the vocabulary's `unknown` verdict.
pub fn provider_error(failure: ConnectFailure, delivery: DeliveryState) -> ProviderError {
    let mut code = failure.code.to_ascii_lowercase();
    if code.is_empty()
        && let Some(status) = failure.http_status
    {
        code = status_connect_code(status).unwrap_or_default().to_owned();
    }
    if !code.is_empty() && connect_code_status(&code).is_none() {
        code = "unknown".to_owned();
    }
    let status = failure
        .http_status
        .or_else(|| connect_code_status(&code));
    let kind = kind_of(&Facts {
        status,
        code: (!code.is_empty()).then_some(code.as_str()),
        retry_after: failure.retry_after,
        text: Some(failure.message.as_str()),
        ..Facts::default()
    });
    let mut error = ProviderError::new(kind, delivery);
    error.code = (!code.is_empty()).then_some(code);
    error.status = status;
    error.retry_after = failure.retry_after;
    error.message = failure.message;
    error
}

/// A random version-4 UUID.
pub fn random_uuid() -> String {
    let bytes: [u8; 16] = crate::random::bytes();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let variant = (u8::from_str_radix(&hex[16..17], 16).expect("hex") & 3) | 8;
    format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    /// Node's `crypto.randomUUID()` (RFC 9562 version 4): 36 characters, lower-case hex in groups 8-4-4-4-12, version
    /// nibble `4`, variant nibble one of `8 9 a b`, all four of which occur.
    #[test]
    fn random_uuid_has_the_form_of_nodes_random_uuid() {
        let mut variants = std::collections::BTreeSet::new();
        for _ in 0..256 {
            let id = super::random_uuid();
            assert_eq!(id.len(), 36, "{id}");
            let groups: Vec<&str> = id.split('-').collect();
            assert_eq!(groups.iter().map(|g| g.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12], "{id}");
            assert!(groups.concat().chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')), "{id}");
            assert_eq!(&id[14..15], "4", "{id}");
            let variant = id.as_bytes()[19] as char;
            assert!(matches!(variant, '8' | '9' | 'a' | 'b'), "{id}");
            variants.insert(variant);
        }
        assert_eq!(variants.len(), 4, "every variant nibble Node draws occurs");
    }
}
