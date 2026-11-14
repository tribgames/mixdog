//! Params of `takeover/ready`: the renderer reports that a login takeover it shows is ready for the person (the desktop's old
//! `takeoverReady` IPC, `apps/desktop/src/main/takeover-gate.ts` `ready`), read and kept by the core's takeover owner.

use serde::Deserialize;
use serde::Serialize;

/// Params of `takeover/ready`: takeover `takeover_id` of session `session_id` is `ready` for the person to act on, or will never
/// be (`ready: false`: its card went away). The answer is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TakeoverReadyParams {
    pub session_id: String,
    pub takeover_id: String,
    pub ready: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_params_are_camel_case() {
        let params: TakeoverReadyParams = serde_json::from_str(r#"{"sessionId":"s","takeoverId":"t","ready":true}"#).unwrap();
        assert_eq!(params, TakeoverReadyParams { session_id: "s".into(), takeover_id: "t".into(), ready: true });
        assert!(serde_json::from_str::<TakeoverReadyParams>(r#"{"sessionId":"s","takeoverId":"t"}"#).is_err());
    }
}
