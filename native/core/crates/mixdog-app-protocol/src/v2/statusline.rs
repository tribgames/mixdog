//! `statusline/read`: what a client's footer shows of the route a thread runs on: the route with its cached quota windows and
//! context share (`loadGatewayStatus`), and the limits of that route: quota windows, balance and the route's spend so far
//! (`buildGatewayLimits`). The client lays them out; the rows are the same for every front end.

use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

/// Params of `statusline/read`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct StatuslineReadParams {
    /// The thread whose footer is read.
    pub session_id: String,
    /// The process id of the front end showing it: routes are kept per host, so two front ends on one machine do not read
    /// each other's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub client_host_pid: Option<u64>,
    /// Tokens the active context holds now, for the context share of the status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub active_context_tokens: Option<f64>,
    /// The route the front end shows right now, when it knows one the stored routes do not (`options.currentRoute`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_route: Option<JsonValue>,
    /// What the last provider answer reported of usage (`providerOut`), for the limits' quota windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_out: Option<JsonValue>,
    /// The cached quota snapshot the front end holds (`usageSnapshot`: `quotaWindows`, `balance`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_snapshot: Option<JsonValue>,
}

/// Result of `statusline/read`. `status` is null when no route resolves; `limits` is null with it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct StatuslineReadResult {
    #[serde(default)]
    pub status: Option<JsonValue>,
    #[serde(default)]
    pub limits: Option<JsonValue>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_thread_is_required_and_the_names_are_camel_case() {
        let params: StatuslineReadParams = serde_json::from_str(r#"{"sessionId":"s1"}"#).unwrap();
        assert_eq!(params, StatuslineReadParams { session_id: "s1".into(), ..Default::default() });
        let params: StatuslineReadParams = serde_json::from_str(r#"{"sessionId":"s1","clientHostPid":42,"activeContextTokens":1500.5,"providerOut":{"usage":{}}}"#).unwrap();
        assert_eq!((params.client_host_pid, params.active_context_tokens), (Some(42), Some(1500.5)));
        let result = StatuslineReadResult { status: Some(serde_json::json!({ "model": "m" })), limits: None };
        assert_eq!(serde_json::to_value(&result).unwrap(), serde_json::json!({ "status": { "model": "m" }, "limits": null }));
    }
}
