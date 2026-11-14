//! `takeover/state`: what the core holds for a takeover or a secret request, read by the desktop's mirrors (the window process's
//! takeover gate and its secret request slots): the sessions whose takeover card is open, the step of a screen takeover, and which
//! of the request ids a client names hold a value. A value itself is never part of the answer.

use serde::Deserialize;
use serde::Serialize;

/// Params of `takeover/state`: the secret request ids the client asks about (none: no slot is read).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TakeoverStateParams {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_request_ids: Vec<String>,
}

/// The surface a held takeover names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum TakeoverSurface {
    Browser,
    Computer,
}

/// One session whose own Browser Use is paused by an open takeover card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HeldTakeover {
    pub session_id: String,
    /// The request id of the takeover the hold is named by (the oldest of the session).
    pub takeover_id: String,
    /// What it waits on (`takeoverStep`).
    pub step: String,
    /// The surface of that takeover.
    pub surface: TakeoverSurface,
}

/// Result of `takeover/state`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TakeoverStateResult {
    /// Every session with an open takeover, by session id.
    pub held: Vec<HeldTakeover>,
    /// The step of a screen takeover some session holds: Computer Use refuses new operations for every session meanwhile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    /// The ids among `secretRequestIds` whose one-shot value slot holds a value.
    pub secret_slots: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_is_camel_case_and_params_are_optional() {
        let params: TakeoverStateParams = serde_json::from_str("{}").unwrap();
        assert_eq!(params, TakeoverStateParams::default());
        let params: TakeoverStateParams = serde_json::from_str(r#"{"secretRequestIds":["secret_abcdefgh"]}"#).unwrap();
        assert_eq!(params.secret_request_ids, ["secret_abcdefgh"]);
        let result = TakeoverStateResult {
            held: vec![HeldTakeover { session_id: "s1".into(), takeover_id: "4".into(), step: "sign-in on a.com".into(), surface: TakeoverSurface::Computer }],
            screen: Some("sign-in on a.com".into()),
            secret_slots: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::json!({ "held": [{ "sessionId": "s1", "takeoverId": "4", "step": "sign-in on a.com", "surface": "computer" }], "screen": "sign-in on a.com", "secretSlots": [] })
        );
    }
}
