//! The request-side half of the context estimate: the tool schemas travel beside the messages,
//! so they have their own fingerprint and token cost (`context-tool-schema.mjs`).
//!
//! A request's tools are a prefix of provider-native tools (raw wire objects, passed through as
//! they are) followed by schemas the wire builds from `ToolDefinition`s. The run host owns the
//! exposure mode, so it hands over the native objects and the prefix count is their number.

use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The tools a request carries.
#[derive(Clone, Copy, Debug, Default)]
pub struct RequestTools<'a> {
    /// The provider-native prefix (`providerNativeToolPrefixCount` of them), sent as they are.
    pub native: &'a [Value],
    pub defined: &'a [ToolDefinition],
}

impl RequestTools<'_> {
    fn is_empty(&self) -> bool {
        self.native.is_empty() && self.defined.is_empty()
    }

    fn any_deferred(&self) -> bool {
        self.native.iter().any(native_deferred) || self.defined.iter().any(|t| t.defer_loading)
    }
}

/// `isDeferredToolSchema` of a native object.
fn native_deferred(tool: &Value) -> bool {
    tool.get("deferLoading") == Some(&Value::Bool(true)) || tool.get("defer_loading") == Some(&Value::Bool(true))
}

/// `serializeToolSchemas`: the wire list, deferred schemas flagged (or left out).
fn serialize(tools: &RequestTools<'_>, exclude_deferred: bool) -> String {
    let native = tools.native.iter().filter(|tool| !(exclude_deferred && native_deferred(tool))).cloned();
    let defined = tools.defined.iter().filter(|tool| !(exclude_deferred && tool.defer_loading)).map(|tool| {
        let mut wire = json!({ "name": tool.name, "description": tool.description, "input_schema": tool.input_schema });
        if tool.defer_loading {
            wire["defer_loading"] = Value::Bool(true);
        }
        wire
    });
    mixdog_js::json_stringify(&Value::Array(native.chain(defined).collect()))
}

/// `toolSchemaSignature`: sha256 of the full serialization, deferred tools included, so a
/// deferred tool joining or leaving re-fingerprints the surface.
pub fn tool_schema_signature(tools: &RequestTools<'_>) -> String {
    sha256_hex(serialize(tools, false).as_bytes())
}

/// `estimateRequestReserveTokens`: the schemas' token cost. The API leaves deferred schemas
/// out of its context count, so they are not metered.
pub fn estimate_request_reserve_tokens(tools: &RequestTools<'_>) -> u64 {
    if tools.is_empty() {
        return 0;
    }
    estimate_tokens(&serialize(tools, tools.any_deferred()))
}
