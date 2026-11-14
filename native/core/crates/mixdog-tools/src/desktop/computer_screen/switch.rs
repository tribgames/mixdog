//! What a phone's screen session streams and injects through right now, and the status it reports, as a
//! pure function of three inputs: what the local input watcher sees, whether the secure-desktop helper is
//! installed and connected, and which desktop that helper reports (Node: `secure-desktop-switch.ts`).
//!
//! The ordinary desktop is captured and injected in-process. When the input desktop becomes the secure
//! desktop (a UAC prompt that elevated onto it, Ctrl+Alt+Del, the lock or sign-in screen) neither reaches
//! it. If the helper is installed and connected, its frames and input take over for as long as the secure
//! desktop is up, and control there waits until the helper's video reaches the viewer; if it is not, the
//! phone is told an elevation prompt is on the PC instead of being shown a frozen frame.

use mixdog_core_api::domain::computer::DesktopIdentity;
use serde::Deserialize;
use serde::Serialize;

use super::super::computer_screen_input::InputDesktop;

/// The helper's capture cadence: `CAPTURE_INTERVAL` in `native/mixdog-secure-desktop/src/helper.rs` (a frame
/// every 66 ms at most, and only once its previous one was written out).
pub(super) const HELPER_FRAME_INTERVAL_MS: u64 = 66;
/// Deliveries the stall average spans: the last 30 frames, as in webrtc-stats.
pub(super) const STALL_WINDOW: usize = 30;

/// How long without a delivered helper frame before the video run ends: the shape of the webrtc-stats
/// freeze rule (`max(3 × average, average + 150 ms)` over the last frame intervals), applied to local
/// delivery intervals. Before two deliveries the helper's nominal cadence stands in.
pub(super) fn helper_video_stall_ms(intervals: &[f64]) -> f64 {
    let average = if intervals.is_empty() {
        HELPER_FRAME_INTERVAL_MS as f64
    } else {
        intervals.iter().sum::<f64>() / intervals.len() as f64
    };
    (3.0 * average).max(average + 150.0)
}

/// Desktop names compare case-insensitively (Windows object names do).
fn normalize_desktop_name(name: &str) -> String {
    name.to_lowercase()
}

/// The helper client as the switch reads it. Not installed, it reports nothing and is never driven.
pub(super) trait HelperView {
    fn installed(&self) -> bool;
    fn connected(&self) -> bool;
    /// The desktop the helper currently captures and injects on (its real object name).
    fn desktop(&self) -> Option<String>;
    /// The Windows session the helper is attached to; `None` while not connected.
    fn session(&self) -> Option<u32>;
}

/// Where a command through the helper lands now; `None` unless connected and both its session and desktop
/// are known. Lower-cased like the in-process desktop's name, so both backends' identities of one desktop
/// compare equal.
pub(super) fn secure_desktop_identity(client: &dyn HelperView) -> Option<DesktopIdentity> {
    if !client.connected() {
        return None;
    }
    let session = client.session()?;
    let desktop = client.desktop()?;
    Some(DesktopIdentity { session, desktop: normalize_desktop_name(&desktop) })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SourceMode {
    /// The ordinary desktop's capture and in-process input.
    Default,
    /// Ordinary capture still, but an elevation prompt owns input (no helper).
    ElevationPrompt,
    /// The helper's frames and input on the secure desktop.
    Helper,
    /// The secure desktop is up and no helper can serve it.
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum HelperState {
    NotNeeded,
    Active,
    Starting,
    Missing,
    Failed,
    InUse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum StatusState {
    Live,
    ElevationPrompt,
    SecureDesktop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Reason {
    Uac,
    Lock,
    Secure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceDecision {
    pub mode: SourceMode,
    pub helper: HelperState,
    /// The helper should be capturing and injecting (mode `Helper`, or warming for a prompt so a switch to
    /// the secure desktop is seamless).
    pub helper_active: bool,
    pub status: StatusState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SwitchInputs {
    /// The local watcher's last report (`None` before the first).
    pub local: Option<InputDesktop>,
    pub helper_installed: bool,
    pub helper_connected: bool,
    pub helper_desktop: Option<String>,
    /// The helper's WTS session lock state; `None` when it reports none or is not connected.
    pub helper_locked: Option<bool>,
    /// The installed service was found stopped and could not be started; a connection supersedes it.
    pub helper_service_down: bool,
    /// Another session holds the helper: this one cannot use it until the hold passes.
    pub helper_owned_elsewhere: bool,
}

fn helper_state(inputs: &SwitchInputs) -> HelperState {
    if !inputs.helper_installed {
        HelperState::Missing
    } else if inputs.helper_owned_elsewhere {
        HelperState::InUse
    } else if inputs.helper_connected {
        HelperState::Active
    } else if inputs.helper_service_down {
        HelperState::Failed
    } else {
        HelperState::Starting
    }
}

/// The secure desktop is up when the local watcher cannot open the input desktop or names `winlogon`. A
/// `consent.exe` in the session with the input desktop still readable is an elevation prompt that elevated
/// in place on the ordinary desktop: the view is live, but the prompt does not take remote input without
/// the helper.
///
/// Lock screen vs UAC (both on the one `Winlogon` desktop): the helper's WTS lock state decides whenever it
/// reports one, before the local LogonUI check (LogonUI also draws the Ctrl+Alt+Del screen of an unlocked
/// session). Not locked is UAC when a consent prompt runs, else an unnamed secure screen.
pub(super) fn decide_screen_source(inputs: &SwitchInputs) -> SourceDecision {
    let helper = helper_state(inputs);
    // Connected and this session's to use (not held by another session).
    let usable = inputs.helper_connected && !inputs.helper_owned_elsewhere;
    let local = inputs.local.as_ref();
    let on_secure = local.is_some_and(|local| {
        local.name.as_deref().is_none_or(|name| normalize_desktop_name(name) == "winlogon")
    });
    let lock_screen = local.is_some_and(|local| inputs.helper_locked.unwrap_or(local.logon_ui));
    let locked = lock_screen && !on_secure;

    if on_secure {
        let reason = if lock_screen {
            Reason::Lock
        } else if local.is_some_and(|local| local.consent) {
            Reason::Uac
        } else {
            Reason::Secure
        };
        let served = inputs.helper_installed
            && usable
            && inputs.helper_desktop.as_deref().is_some_and(|name| normalize_desktop_name(name) != "default");
        return if served {
            SourceDecision {
                mode: SourceMode::Helper,
                helper,
                helper_active: true,
                status: StatusState::SecureDesktop,
                reason: Some(reason),
            }
        } else {
            SourceDecision {
                mode: SourceMode::Blocked,
                helper,
                helper_active: inputs.helper_installed,
                status: StatusState::SecureDesktop,
                reason: Some(reason),
            }
        };
    }

    // Ordinary desktop. An in-place elevation prompt (or the lock UI while the input desktop is still
    // readable) is live but un-actionable without a helper.
    if local.is_some_and(|local| local.consent) || locked {
        let reason = if locked { Reason::Lock } else { Reason::Uac };
        return if inputs.helper_installed && usable {
            // The helper can act even for an in-place prompt; keep it warm so a jump to the secure desktop
            // has frames already flowing.
            SourceDecision {
                mode: SourceMode::Default,
                helper,
                helper_active: true,
                status: StatusState::ElevationPrompt,
                reason: Some(reason),
            }
        } else {
            SourceDecision {
                mode: SourceMode::ElevationPrompt,
                helper,
                helper_active: inputs.helper_installed,
                status: StatusState::ElevationPrompt,
                reason: Some(reason),
            }
        };
    }

    SourceDecision { mode: SourceMode::Default, helper, helper_active: false, status: StatusState::Live, reason: None }
}

/// Whether a decision takes frames and input from the helper rather than the ordinary desktop.
pub(super) fn decision_uses_helper(decision: &SourceDecision) -> bool {
    decision.mode == SourceMode::Helper
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum HelperOffer {
    Install,
    Update,
    #[serde(rename = "none")]
    Nothing,
}

/// The helper's advisory codes the phone is told about (`native/mixdog-secure-desktop/docs/ipc-spec.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum HelperIssue {
    GrantKeyMissing,
    GrantExpired,
    InputFailed,
    DesktopUnavailable,
    SasDisabledByPolicy,
}

/// A helper advisory code the phone is told about; `None` for the others (handshake failures close the
/// connection; a refused grant is followed by the next challenge).
pub(super) fn screen_helper_issue(code: &str) -> Option<HelperIssue> {
    Some(match code {
        "grant_key_missing" => HelperIssue::GrantKeyMissing,
        "grant_expired" => HelperIssue::GrantExpired,
        "input_failed" => HelperIssue::InputFailed,
        "desktop_unavailable" => HelperIssue::DesktopUnavailable,
        "sas_disabled_by_policy" => HelperIssue::SasDisabledByPolicy,
        _ => return None,
    })
}

/// The issue still standing after the helper's connection or desktop changed (connected, the input desktop
/// switched, disconnected, or the adapter rebuilt by an install): every report of the desktop it was about
/// ends, while `grant_key_missing` describes the install and stands as long as the connection to it does.
pub(super) fn helper_issue_after_change(issue: Option<HelperIssue>, connected: bool) -> Option<HelperIssue> {
    issue.filter(|issue| *issue == HelperIssue::GrantKeyMissing && connected)
}

/// The status's helper block besides what the decision says (`secure`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScreenHelperFacts {
    pub offer: HelperOffer,
    /// How this session's last install request ended; `None` before one.
    pub outcome: Option<String>,
    pub detail: Option<String>,
    pub issue: Option<HelperIssue>,
    /// Whether the account signed in on the PC is an administrator; absent when the PC did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_is_admin: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HelperInfo {
    #[serde(flatten)]
    pub facts: ScreenHelperFacts,
    /// Which secure screen is up: the lock screen or an elevation prompt; `None` on the ordinary desktop or
    /// when it cannot be told.
    pub secure: Option<Reason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScreenStatus {
    pub state: StatusState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Reason>,
    pub helper: HelperState,
    /// Input is currently accepted from this viewer.
    pub control: bool,
    pub helper_info: HelperInfo,
}

/// The status pushed to the phone for a decision, with whether this viewer may currently control. Control is
/// refused on `Blocked` (nothing can act), on `ElevationPrompt` without an active helper, and on `Helper`
/// until the helper's video reaches this viewer: without the picture the phone would act on a desktop it
/// cannot see.
pub(super) fn screen_status_for(
    decision: &SourceDecision,
    control_granted: bool,
    helper_video: bool,
    helper: &ScreenHelperFacts,
) -> ScreenStatus {
    let control = control_granted
        && decision.mode != SourceMode::Blocked
        && !(decision.mode == SourceMode::ElevationPrompt && decision.helper != HelperState::Active)
        && (decision.mode != SourceMode::Helper || helper_video);
    let secure = decision.reason.filter(|reason| matches!(reason, Reason::Lock | Reason::Uac));
    ScreenStatus {
        state: decision.status,
        reason: decision.reason,
        helper: decision.helper,
        control,
        helper_info: HelperInfo { facts: helper.clone(), secure },
    }
}
