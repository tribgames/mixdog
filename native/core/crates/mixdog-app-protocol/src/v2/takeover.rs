//! `takeover/ready`: a client asks whether the person may act on a takeover it shows (the desktop's old `takeoverReady` IPC,
//! `apps/desktop/src/main/takeover-gate.ts` `ready`), answered by the core's takeover owner once the session's commands
//! stopped and drained, or with `false` when the takeover ends first or is never seen.

use serde::Deserialize;
use serde::Serialize;

/// Params of `takeover/ready`: takeover `takeover_id` of session `session_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TakeoverReadyParams {
    pub session_id: String,
    pub takeover_id: String,
}

/// Result of `takeover/ready`: true once the person may act on the takeover, false when it ended first or was never seen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TakeoverReadyResult {
    pub ready: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_params_and_result_are_camel_case() {
        let params: TakeoverReadyParams = serde_json::from_str(r#"{"sessionId":"s","takeoverId":"t"}"#).unwrap();
        assert_eq!(params, TakeoverReadyParams { session_id: "s".into(), takeover_id: "t".into() });
        assert!(serde_json::from_str::<TakeoverReadyParams>(r#"{"sessionId":"s"}"#).is_err());
        assert_eq!(serde_json::to_string(&TakeoverReadyResult { ready: true }).unwrap(), r#"{"ready":true}"#);
    }
}
