//! The on-PC pill shown while a paired phone views or controls this PC's screen, driven by the core's screen sessions.
//! The pill is the desktop's window (`apps/desktop/src/main/remote-screen/screen-indicator*.ts`): the core tells it what to show
//! (`host/screen/indicator`, core to desktop) and the desktop reports its Stop button (`host/screen/indicator/stop`, desktop to core).
//! One pill serves every active phone and its Stop ends every session, so the desktop sends one stop per session it shows.

use serde::Deserialize;
use serde::Serialize;

/// What the pill does for one session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ScreenIndicatorState {
    /// The session started: the phone joins the pill (the pill appears when it is the first).
    Show,
    /// The phone's label changed, or it now views rather than controls (the pill tells neither apart).
    Update,
    /// The session ended: the phone leaves the pill (the pill goes when it is the last).
    Hide,
}

/// Params of `host/screen/indicator` (core to desktop): one session's place on the pill. `screen_id` names the session (one per
/// display) and is the key of its later `update` and `hide`; `client_label` and `controlling` are absent on `hide`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct ScreenIndicatorParams {
    pub state: ScreenIndicatorState,
    pub screen_id: String,
    /// The phone's name, shown as the pill's tooltip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controlling: Option<bool>,
}

/// The answer of `host/screen/indicator`: nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ScreenIndicatorResult {}

/// Params of `host/screen/indicator/stop` (desktop to core): the pill's Stop was pressed for the session of `screen_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenIndicatorStopParams {
    pub screen_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_show_carries_the_label_and_a_hide_carries_neither_label_nor_control() {
        let show = ScreenIndicatorParams { state: ScreenIndicatorState::Show, screen_id: "1".into(), client_label: Some("Phone".into()), controlling: Some(false) };
        assert_eq!(serde_json::to_value(&show).unwrap(), serde_json::json!({"state": "show", "screenId": "1", "clientLabel": "Phone", "controlling": false}));
        let hide = ScreenIndicatorParams { state: ScreenIndicatorState::Hide, screen_id: "1".into(), client_label: None, controlling: None };
        assert_eq!(serde_json::to_value(&hide).unwrap(), serde_json::json!({"state": "hide", "screenId": "1"}));
    }

    #[test]
    fn a_stop_names_the_session_and_nothing_else() {
        let stop: ScreenIndicatorStopParams = serde_json::from_value(serde_json::json!({"screenId": "2"})).unwrap();
        assert_eq!(stop.screen_id, "2");
        assert!(serde_json::from_value::<ScreenIndicatorStopParams>(serde_json::json!({"screenId": "2", "x": 1})).is_err());
    }
}
