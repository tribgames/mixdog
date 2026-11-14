//! A failed `host/browser/*` call, mapped from the JSON-RPC error's `data.code` (`BROWSER_ENGINE_ERR_*`).

use std::fmt;

use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_DIALOG_BLOCKING;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_FAILED;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_PAGE_GONE;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_PRECONDITION_FAILED;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_REFUSED;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_STALE_SNAPSHOT;
use mixdog_app_protocol::v2::browser_engine::BROWSER_ENGINE_ERR_USER_INPUT;
use mixdog_app_protocol::v2::browser_engine::BrowserDialogBlockingData;
use mixdog_app_protocol::v2::browser_engine::BrowserPendingDialog;
use mixdog_app_protocol::v2::browser_engine::BrowserPreconditionFailedData;
use mixdog_app_protocol::v2::browser_engine::BrowserPreconditionReason;
use mixdog_app_protocol::v2::browser_engine::BrowserRefusedErrorData;
use mixdog_app_protocol::v2::browser_engine::BrowserUserInputErrorData;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::host::HostError;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Why a host call produced no result. The variants named after a JSON-RPC code carry what that code's `data` carries.
#[derive(Debug, Clone, PartialEq)]
pub enum HostCallError {
    /// -32010: the page no longer matches what the call was decided against; `facts` are the page's current ones.
    PreconditionFailed { reason: BrowserPreconditionReason, facts: Box<PageFacts> },
    /// -32011: the page is closed, or its session ended.
    PageGone,
    /// -32012: the person holds the page, until `until` (epoch milliseconds) when the host knows.
    UserInput { until: Option<i64> },
    /// -32013: the snapshot the call named is not the page's current one.
    StaleSnapshot,
    /// -32014: a JavaScript dialog blocks the page.
    DialogBlocking { dialog: Box<BrowserPendingDialog> },
    /// -32015: the URL policy or the CDP allowlist refused it.
    Refused { reason: String },
    /// -32000 or any code of no meaning to the engine: the host's already redacted message.
    Failed { message: String },
    /// The caller's cancel ended the request first.
    Cancelled,
    /// No host serves the lane (none claimed, or it closed before answering).
    Unavailable { detail: String },
}

fn data_as<T: DeserializeOwned>(data: Option<&Value>) -> Option<T> {
    serde_json::from_value(data?.clone()).ok()
}

impl HostCallError {
    /// Map a JSON-RPC error answer. A `data` that does not parse as its code's shape degrades to `Failed` with the message:
    /// the code alone is never trusted to carry facts it does not.
    pub fn from_rpc(code: i64, message: &str, data: Option<&Value>) -> Self {
        let failed = || Self::Failed { message: message.to_string() };
        match i32::try_from(code) {
            Ok(BROWSER_ENGINE_ERR_PRECONDITION_FAILED) => match data_as::<BrowserPreconditionFailedData>(data) {
                Some(data) => Self::PreconditionFailed { reason: data.reason, facts: Box::new(data.facts) },
                None => failed(),
            },
            Ok(BROWSER_ENGINE_ERR_PAGE_GONE) => Self::PageGone,
            Ok(BROWSER_ENGINE_ERR_USER_INPUT) => Self::UserInput { until: data_as::<BrowserUserInputErrorData>(data).and_then(|data| data.until) },
            Ok(BROWSER_ENGINE_ERR_STALE_SNAPSHOT) => Self::StaleSnapshot,
            Ok(BROWSER_ENGINE_ERR_DIALOG_BLOCKING) => match data_as::<BrowserDialogBlockingData>(data) {
                Some(data) => Self::DialogBlocking { dialog: Box::new(data.dialog) },
                None => failed(),
            },
            Ok(BROWSER_ENGINE_ERR_REFUSED) => Self::Refused {
                reason: data_as::<BrowserRefusedErrorData>(data).map_or_else(|| message.to_string(), |data| data.reason),
            },
            _ => failed(),
        }
    }

    /// The JSON-RPC code, message and `data` a host answers this error with (the inverse of [`Self::from_rpc`]); `None` for the two
    /// variants that never come from a host. The fake host replays recorded errors with it.
    pub fn to_rpc(&self) -> Option<(i32, String, Option<Value>)> {
        let value = |data: Result<Value, serde_json::Error>| data.ok();
        match self {
            Self::PreconditionFailed { reason, facts } => Some((
                BROWSER_ENGINE_ERR_PRECONDITION_FAILED,
                String::new(),
                value(serde_json::to_value(BrowserPreconditionFailedData { reason: *reason, facts: (**facts).clone() })),
            )),
            Self::PageGone => Some((BROWSER_ENGINE_ERR_PAGE_GONE, String::new(), None)),
            Self::UserInput { until } => Some((BROWSER_ENGINE_ERR_USER_INPUT, String::new(), value(serde_json::to_value(BrowserUserInputErrorData { until: *until })))),
            Self::StaleSnapshot => Some((BROWSER_ENGINE_ERR_STALE_SNAPSHOT, String::new(), None)),
            Self::DialogBlocking { dialog } => Some((
                BROWSER_ENGINE_ERR_DIALOG_BLOCKING,
                String::new(),
                value(serde_json::to_value(BrowserDialogBlockingData { dialog: (**dialog).clone() })),
            )),
            Self::Refused { reason } => Some((
                BROWSER_ENGINE_ERR_REFUSED,
                reason.clone(),
                value(serde_json::to_value(BrowserRefusedErrorData { reason: reason.clone() })),
            )),
            Self::Failed { message } => Some((BROWSER_ENGINE_ERR_FAILED, message.clone(), None)),
            Self::Cancelled | Self::Unavailable { .. } => None,
        }
    }
}

impl From<HostError> for HostCallError {
    fn from(error: HostError) -> Self {
        match error {
            HostError::Rpc { code, message, data } => Self::from_rpc(code, &message, data.as_ref()),
            HostError::Core(CoreError::CapabilityUnavailable { detail, .. }) if &*detail == "cancelled" => Self::Cancelled,
            HostError::Core(CoreError::CapabilityUnavailable { detail, .. }) => Self::Unavailable { detail: detail.to_string() },
            HostError::Core(other) => Self::Unavailable { detail: format!("{other:?}") },
        }
    }
}

impl fmt::Display for HostCallError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PreconditionFailed { reason, .. } => write!(out, "the page changed ({reason:?})"),
            Self::PageGone => out.write_str("the page is gone"),
            Self::UserInput { .. } => out.write_str("the person holds the page"),
            Self::StaleSnapshot => out.write_str("the snapshot is stale"),
            Self::DialogBlocking { .. } => out.write_str("a dialog blocks the page"),
            Self::Refused { reason } => write!(out, "refused: {reason}"),
            Self::Failed { message } => out.write_str(message),
            Self::Cancelled => out.write_str("cancelled"),
            Self::Unavailable { detail } => write!(out, "the browser host is unavailable: {detail}"),
        }
    }
}

impl std::error::Error for HostCallError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::page_facts;
    use serde_json::json;

    #[test]
    fn each_code_maps_to_its_variant() {
        assert_eq!(HostCallError::from_rpc(-32011, "", None), HostCallError::PageGone);
        assert_eq!(HostCallError::from_rpc(-32013, "", None), HostCallError::StaleSnapshot);
        assert_eq!(HostCallError::from_rpc(-32012, "", Some(&json!({"until": 99}))), HostCallError::UserInput { until: Some(99) });
        assert_eq!(HostCallError::from_rpc(-32012, "", None), HostCallError::UserInput { until: None });
        assert_eq!(HostCallError::from_rpc(-32015, "m", Some(&json!({"reason": "blocked scheme"}))), HostCallError::Refused { reason: "blocked scheme".into() });
        assert_eq!(HostCallError::from_rpc(-32015, "m", None), HostCallError::Refused { reason: "m".into() });
        assert_eq!(HostCallError::from_rpc(-32000, "boom", None), HostCallError::Failed { message: "boom".into() });
        assert_eq!(HostCallError::from_rpc(-1, "odd", None), HostCallError::Failed { message: "odd".into() });
        assert_eq!(HostCallError::from_rpc(i64::MAX, "odd", None), HostCallError::Failed { message: "odd".into() });
    }

    #[test]
    fn a_precondition_failure_carries_the_facts() {
        let data = json!({"reason": "document", "facts": page_facts("p1", 3)});
        match HostCallError::from_rpc(-32010, "", Some(&data)) {
            HostCallError::PreconditionFailed { reason, facts } => {
                assert_eq!(reason, BrowserPreconditionReason::Document);
                assert_eq!(facts.page_id, "p1");
                assert_eq!(facts.seq, 3);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(HostCallError::from_rpc(-32010, "no data", None), HostCallError::Failed { message: "no data".into() });
    }

    #[test]
    fn a_rpc_error_round_trips() {
        let dialog = BrowserPendingDialog { kind: "alert".into(), message: "hi".into(), default_prompt: None, opened_at: 7, session_id: None, bridge: false };
        for error in [
            HostCallError::PageGone,
            HostCallError::StaleSnapshot,
            HostCallError::UserInput { until: Some(5) },
            HostCallError::Refused { reason: "r".into() },
            HostCallError::Failed { message: "f".into() },
            HostCallError::DialogBlocking { dialog: Box::new(dialog) },
            HostCallError::PreconditionFailed { reason: BrowserPreconditionReason::Url, facts: Box::new(serde_json::from_value(page_facts("p2", 1)).expect("facts")) },
        ] {
            let (code, message, data) = error.to_rpc().expect("answered by a host");
            assert_eq!(HostCallError::from_rpc(i64::from(code), &message, data.as_ref()), error);
        }
        assert_eq!(HostCallError::Cancelled.to_rpc(), None);
    }

    #[test]
    fn the_channel_errors_map() {
        let cancelled = HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "cancelled".into() });
        assert_eq!(HostCallError::from(cancelled), HostCallError::Cancelled);
        let none = HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "notClaimed".into() });
        assert_eq!(HostCallError::from(none), HostCallError::Unavailable { detail: "notClaimed".into() });
        let rpc = HostError::Rpc { code: -32011, message: String::new(), data: None };
        assert_eq!(HostCallError::from(rpc), HostCallError::PageGone);
    }
}
