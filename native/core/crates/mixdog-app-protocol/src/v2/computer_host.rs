//! Params and results of the Computer Use host methods the core asks the desktop for (pixels, app-owned windows,
//! input into the desktop's own windows, cursor preparation, OS grants, the dual-path command), the pointer release
//! the desktop reports, the dev-only harness entry, and the checks of the extended `computer/userControl` params.
//!
//! All ride the existing `host.computer` capability. A core that gets JSON-RPC -32601 from an older desktop treats the
//! feature as unavailable. Shapes follow the wincu-int desktop: `host/input-dispatch-electron-*.ts` (`appInput`),
//! `overlay/cursor-readiness.ts` (`cursorPrepare`), `host/permission-reads.ts` (`permissions`).

use mixdog_protocol::BlobDigest;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

use crate::v2::host::ComputerUserControlAction;
use crate::v2::host::ComputerUserControlParams;

/// The longest `configureIdleResume` interval, in seconds.
pub const IDLE_RESUME_SECONDS_MAX: u32 = 60;
/// The longest a `dev/computer/run` command may run, in ms.
pub const DEV_COMPUTER_RUN_TIMEOUT_MS_MAX: u32 = 120_000;

/// Bytes the host put in the core's blob store with `blob/put` before it answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerBlob {
    pub digest: BlobDigest,
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub byte_length: u64,
    pub mime_type: String,
}

/// How the pixels of `host/computer/pixels` are taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerPixelsBackend {
    Screen,
    AppOwned,
    Composited,
}

/// The encoding of `host/computer/pixels`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerPixelsFormat {
    Jpeg,
    Png,
}

/// A display to capture: by id, by index, or (both absent) the primary one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerDisplayTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
}

/// A window to capture, named as the helper names windows (`hwnd:0x..`, `cg:<n>`, `x11:0x..`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerWindowTarget {
    pub window_id: String,
}

/// What `host/computer/pixels` captures, by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "kind")]
pub enum HostComputerPixelsTarget {
    #[serde(rename = "display")]
    #[cfg_attr(feature = "codegen", ts(rename = "display"))]
    Display(HostComputerDisplayTarget),
    #[serde(rename = "window")]
    #[cfg_attr(feature = "codegen", ts(rename = "window"))]
    Window(HostComputerWindowTarget),
}

/// Params of `host/computer/pixels` (core -> host): one capture, encoded by the desktop, which uploads the bytes with
/// `blob/put` before it answers. Replaces `host/computer/capture` for display and app-owned pixels. Errors are -32000
/// with `data.code` `computer_capture_unavailable`, `computer_capture_permission` or `computer_window_gone`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerPixelsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_thread_id: Option<ThreadId>,
    pub target: HostComputerPixelsTarget,
    pub backend: HostComputerPixelsBackend,
    pub max_width: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u32>,
    pub format: HostComputerPixelsFormat,
    /// 1..=100.
    pub quality: u8,
    /// The part of the display to capture, in physical pixels of the screen (the display's origin included): the core's display
    /// zoom asks for the region at full resolution and answers `source` with the rectangle delivered, which must equal the region.
    /// Absent = the whole display (g25-fu-cu-b, s3-10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<HostComputerPixelsRegion>,
}

/// A rectangle of a display in physical pixels of the screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerPixelsRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// What was captured, in physical pixels of the screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerPixelsSource {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub display_id: Option<String>,
    pub window_id: Option<String>,
}

/// One backend the host tried for a capture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerPixelsAttempt {
    pub backend: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Result of `host/computer/pixels`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerPixelsResult {
    pub blob: HostComputerBlob,
    pub capture_width: u32,
    pub capture_height: u32,
    pub source: HostComputerPixelsSource,
    /// The backend that produced the pixels.
    pub backend: String,
    /// Epoch ms.
    pub captured_at: f64,
    pub attempts: Vec<HostComputerPixelsAttempt>,
}

/// Params of `host/computer/appWindows` (core -> host): none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct HostComputerAppWindowsParams {}

/// What an app-owned window is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerAppWindowKind {
    Main,
    BrowserGuest,
    Aux,
}

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostComputerBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// One window of the desktop itself. The overlay, pill and indicator windows are not listed: they stay in
/// `host/computer/internalWindows`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerAppWindow {
    /// Spelled as the helper spells it: `hwnd:0x..`, `cg:<n>` or `x11:0x..`.
    pub window_id: String,
    pub kind: HostComputerAppWindowKind,
    pub title: String,
    pub bounds: HostComputerBounds,
    pub scale_factor: f64,
    pub display_id: String,
    pub focused: bool,
}

/// Result of `host/computer/appWindows`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerAppWindowsResult {
    pub windows: Vec<HostComputerAppWindow>,
}

/// What `host/computer/appInput` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerAppInputOp {
    Key,
    Type,
    Click,
    Move,
    Wheel,
}

/// A pointer button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerButton {
    Left,
    Right,
    Middle,
}

/// Params of `host/computer/appInput` (core -> host): input into one of the desktop's own windows, delivered through its
/// renderer without OS focus or the pointer. The desktop answers -32602 when `windowId` is not app-owned. A member an
/// `op` does not use is absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerAppInputParams {
    pub session_thread_id: ThreadId,
    pub window_id: String,
    pub op: HostComputerAppInputOp,
    /// `key`: the normalized chord, e.g. `ctrl+a`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<String>,
    /// `type`: the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `click`, `move`, `wheel`: physical pixels relative to the window's bounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<HostComputerButton>,
    /// `click`: 1..=3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clicks: Option<u8>,
    /// `wheel`: signed notches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<f64>,
}

/// What became of an `appInput`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerAppInputEffect {
    Delivered,
    NotEditable,
    WindowGone,
    Refused,
}

/// What the desktop saw of the typing target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerAppInputEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_role: Option<String>,
}

/// A point in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostComputerPoint {
    pub x: f64,
    pub y: f64,
}

/// Result of `host/computer/appInput`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerAppInputResult {
    pub delivered: bool,
    pub effect: HostComputerAppInputEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<HostComputerAppInputEvidence>,
    /// Where the arrow now stands.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<HostComputerPoint>,
}

/// Params of `host/computer/cursorPrepare` (core -> host): ready the agent's arrow before the first pointer input of a
/// session. The desktop answers within 750 ms (`overlay/cursor-readiness.ts`); the core waits at most 900 ms and goes
/// on without it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerCursorPrepareParams {
    pub session_thread_id: ThreadId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    pub x: f64,
    pub y: f64,
}

/// How ready the arrow is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum HostComputerCursorState {
    Ready,
    Unavailable,
    Timeout,
}

/// Result of `host/computer/cursorPrepare`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct HostComputerCursorPrepareResult {
    pub state: HostComputerCursorState,
}

/// Params of `host/computer/permissions` (core -> host): `request` asks macOS to show its own prompts
/// (`requestComputerPermissions`) before the grants are read; absent or false only reads.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerPermissionsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<bool>,
}

/// Result of `host/computer/permissions`: the grants as the desktop reads them (`host/permission-reads.ts`). Each is the
/// host's own word: `granted`, `denied`, `not-determined`, `restricted`, `not_required_on_windows`,
/// `target_integrity_dependent`, `accessibility_dependent` or a Linux capability state; the core matches the ones it knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerPermissionsResult {
    pub screen_capture: String,
    pub accessibility: String,
    pub input: String,
    /// Linux only: each capability's probed readiness, structurally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux: Option<JsonValue>,
}

/// Params of `host/computer/command` (core -> host, dual path only): a whole bridge command, as
/// `computer-bridge/client.mjs` posts it. Answered only while the desktop runs the legacy Windows PowerShell host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostComputerCommandParams {
    pub session_thread_id: ThreadId,
    pub command: JsonValue,
}

/// Result of `host/computer/command`: the host's value as the bridge's `{ ok, value }` carried it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct HostComputerCommandResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_blob: Option<HostComputerBlob>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Params of `computer/pointerReleased` (desktop -> core notification): the user moved the real pointer over an agent
/// arrow, so the core ends that session's pointer hold.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerPointerReleasedParams {
    pub session_thread_id: ThreadId,
}

/// Params of `dev/computer/run` (client -> core): one command through the harness, refused with -32601 unless the core
/// was started with `MIXDOG_DEV_COMPUTER_RUN=1`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct DevComputerRunParams {
    pub session_thread_id: ThreadId,
    pub command: JsonValue,
    /// At most 120000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

/// The failure of a `dev/computer/run` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct DevComputerRunError {
    pub code: String,
    pub message: String,
}

/// Result of `dev/computer/run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct DevComputerRunResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_blob: Option<HostComputerBlob>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<DevComputerRunError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_pid: Option<u32>,
}

impl DevComputerRunParams {
    /// `timeoutMs` is at most [`DEV_COMPUTER_RUN_TIMEOUT_MS_MAX`].
    pub fn validate(&self) -> Result<(), String> {
        match self.timeout_ms {
            Some(ms) if ms > DEV_COMPUTER_RUN_TIMEOUT_MS_MAX => {
                Err(format!("timeoutMs is at most {DEV_COMPUTER_RUN_TIMEOUT_MS_MAX}"))
            }
            _ => Ok(()),
        }
    }
}

/// Why a `takeover` of the user's hold is raised (`computer/userControl`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ComputerTakeoverReason {
    DesktopUnavailable,
    DisplayChanged,
}

impl ComputerUserControlParams {
    /// `seconds` goes with `configureIdleResume` alone and is 0..=60 there; `reason` goes with `takeover` alone.
    pub fn validate(&self) -> Result<(), String> {
        let configure = self.action == ComputerUserControlAction::ConfigureIdleResume;
        match (configure, self.seconds) {
            (true, None) => return Err("configureIdleResume needs seconds".to_owned()),
            (true, Some(seconds)) if seconds > IDLE_RESUME_SECONDS_MAX => {
                return Err(format!("seconds is at most {IDLE_RESUME_SECONDS_MAX}"));
            }
            (false, Some(_)) => return Err("seconds goes with configureIdleResume only".to_owned()),
            _ => {}
        }
        if self.reason.is_some() && self.action != ComputerUserControlAction::Takeover {
            return Err("reason goes with takeover only".to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn control(value: serde_json::Value) -> ComputerUserControlParams {
        serde_json::from_value(value).expect("params")
    }

    #[test]
    fn old_user_control_params_still_decode() {
        let params = control(json!({ "action": "resume", "sessionThreadId": "t1" }));
        assert_eq!(params.reason, None);
        assert_eq!(params.seconds, None);
        assert_eq!(params.validate(), Ok(()));
    }

    #[test]
    fn user_control_actions_decode_by_name() {
        assert_eq!(
            control(json!({ "action": "takeover", "reason": "display_changed" })).reason,
            Some(ComputerTakeoverReason::DisplayChanged)
        );
        assert_eq!(control(json!({ "action": "configureIdleResume", "seconds": 5 })).seconds, Some(5));
    }

    #[test]
    fn idle_resume_seconds_are_zero_to_sixty() {
        assert_eq!(control(json!({ "action": "configureIdleResume", "seconds": 0 })).validate(), Ok(()));
        assert_eq!(control(json!({ "action": "configureIdleResume", "seconds": 60 })).validate(), Ok(()));
        assert!(control(json!({ "action": "configureIdleResume", "seconds": 61 })).validate().is_err());
        assert!(control(json!({ "action": "configureIdleResume" })).validate().is_err());
        assert!(control(json!({ "action": "stop", "seconds": 5 })).validate().is_err());
    }

    #[test]
    fn reason_goes_with_takeover_only() {
        assert_eq!(control(json!({ "action": "takeover", "reason": "desktop_unavailable" })).validate(), Ok(()));
        assert_eq!(control(json!({ "action": "takeover" })).validate(), Ok(()));
        assert!(control(json!({ "action": "pause", "reason": "display_changed" })).validate().is_err());
    }

    #[test]
    fn unknown_takeover_reason_is_refused() {
        let value = json!({ "action": "takeover", "reason": "other" });
        assert!(serde_json::from_value::<ComputerUserControlParams>(value).is_err());
    }

    #[test]
    fn old_computer_section_still_decodes() {
        let section: mixdog_protocol::ComputerSection = serde_json::from_value(json!({
            "active": true,
            "observeOnly": false,
            "controller": null,
            "sessions": [{ "sessionThreadId": "t1", "observeOnly": false }],
            "sessionThreadId": "t1"
        }))
        .expect("section");
        assert_eq!(section.backend, mixdog_protocol::ComputerBackendSection::Helper);
        assert_eq!(section.cleanup_state, mixdog_protocol::ComputerCleanupState::Ready);
        assert_eq!(section.idle_resume_seconds, 5);
        assert!(section.sessions[0].window_ids.is_empty());
        assert_eq!(section.sessions[0].mode, None);
        assert_eq!(section.sessions[0].phase, None);
    }

    #[test]
    fn dev_run_timeout_is_bounded() {
        let run = |ms: u32| -> DevComputerRunParams {
            serde_json::from_value(json!({ "sessionThreadId": "t1", "command": {}, "timeoutMs": ms })).expect("params")
        };
        assert_eq!(run(120_000).validate(), Ok(()));
        assert!(run(120_001).validate().is_err());
    }

    #[test]
    fn pixels_params_round_trip() {
        let value = json!({
            "target": { "kind": "window", "windowId": "hwnd:0x10" },
            "backend": "app_owned",
            "maxWidth": 1280,
            "format": "jpeg",
            "quality": 80
        });
        let params: HostComputerPixelsParams = serde_json::from_value(value.clone()).expect("params");
        assert_eq!(serde_json::to_value(&params).expect("value"), value);
        let display: HostComputerPixelsTarget =
            serde_json::from_value(json!({ "kind": "display", "index": 1 })).expect("target");
        assert_eq!(
            display,
            HostComputerPixelsTarget::Display(HostComputerDisplayTarget { display_id: None, index: Some(1) })
        );
    }

    #[test]
    fn app_input_result_round_trips() {
        let value = json!({
            "delivered": false,
            "effect": "not_editable",
            "evidence": { "editable": false, "focusedRole": "button" },
            "cursor": { "x": 1.5, "y": 2.0 }
        });
        let result: HostComputerAppInputResult = serde_json::from_value(value.clone()).expect("result");
        assert_eq!(result.effect, HostComputerAppInputEffect::NotEditable);
        assert_eq!(serde_json::to_value(&result).expect("value"), value);
    }

    #[test]
    fn permissions_keep_the_hosts_words() {
        let value = json!({
            "screenCapture": "not_required_on_windows",
            "accessibility": "not_required_on_windows",
            "input": "target_integrity_dependent"
        });
        let result: HostComputerPermissionsResult = serde_json::from_value(value.clone()).expect("result");
        assert_eq!(serde_json::to_value(&result).expect("value"), value);
    }
}
