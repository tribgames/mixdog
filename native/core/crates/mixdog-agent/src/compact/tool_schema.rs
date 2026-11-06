//! The request-side half of the context estimate: the tool schemas travel beside the messages,
//! so they have their own fingerprint and token cost (`context-tool-schema.mjs`).
//!
//! A `ToolDefinition` is always a plain schema; Node's provider-native tool prefix (raw
//! objects passed through as they are) has no counterpart in the Rust request, so the
//! prefix count is zero.

use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `serializeToolSchemas`: the wire list, deferred schemas flagged (or left out).
fn serialize(tools: &[ToolDefinition], exclude_deferred: bool) -> String {
    let wire: Vec<Value> = tools
        .iter()
        .filter(|tool| !(exclude_deferred && tool.defer_loading))
        .map(|tool| {
            let mut wire = json!({ "name": tool.name, "description": tool.description, "input_schema": tool.input_schema });
            if tool.defer_loading {
                wire["defer_loading"] = Value::Bool(true);
            }
            wire
        })
        .collect();
    mixdog_js::json_stringify(&Value::Array(wire))
}

/// `toolSchemaSignature`: sha256 of the full serialization, deferred tools included, so a
/// deferred tool joining or leaving re-fingerprints the surface.
pub fn tool_schema_signature(tools: &[ToolDefinition]) -> String {
    sha256_hex(serialize(tools, false).as_bytes())
}

/// `estimateRequestReserveTokens`: the schemas' token cost. The API leaves deferred schemas
/// out of its context count, so they are not metered.
pub fn estimate_request_reserve_tokens(tools: &[ToolDefinition]) -> u64 {
    if tools.is_empty() {
        return 0;
    }
    estimate_tokens(&serialize(tools, tools.iter().any(|tool| tool.defer_loading)))
}
