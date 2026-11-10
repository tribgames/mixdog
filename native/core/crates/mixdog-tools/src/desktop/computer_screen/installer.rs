//! On-demand install of the secure-desktop helper (Node: `secure-desktop/install-request.ts`).
//!
//! Nothing installs the helper by itself: not on app install, not on update, not on start. The only trigger
//! is the paired phone's request from the secure-desktop blocked state, and each request is at most one
//! elevation prompt on the PC, answered by the PC's user. Nothing retries: a declined or failed request
//! leaves the helper not installed (or outdated) until the phone asks again. A request made while one is
//! running joins it instead of opening a second prompt, and a launched elevation is latched until the
//! process it launched has settled: when it has not finished by the report deadline the request answers
//! `in-progress`, and every later request launches nothing until that elevation exits.
//!
//! The PC-side approval hook ([`PcApproval`], applied by [`ApprovedPort`]) is asked right before an
//! elevation would be launched; a refusal there is the same as a declined prompt and launches nothing.
//!
//! After an `installed` outcome the caller must build a fresh helper client: an existing one read the
//! install state (its secret) when it was built, so it cannot see the new install.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use base64::Engine;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use futures::FutureExt;
use futures::future::Shared;
use serde::Deserialize;
use serde::Serialize;

use super::router::BoxFuture;

/// Exit code of an elevated run whose prompt was declined (`ERROR_CANCELLED`).
pub(super) const ELEVATION_DECLINED_EXIT: i32 = 1223;
/// The bridge's own exit codes: another elevated install is already running…
pub(super) const SECURE_DESKTOP_BUSY_EXIT: i32 = 75;
/// …the service is installed for a different Windows account (nothing changed)…
pub(super) const SECURE_DESKTOP_OTHER_USER_EXIT: i32 = 4;
/// …the image was refused: not a pinned, signed, unrevoked release build…
pub(super) const SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT: i32 = 5;
/// …and its certificate revocation status could not be determined in time.
pub(super) const SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT: i32 = 6;

/// How long a request waits for the elevated install before answering `in-progress`; covers the user reading
/// and approving the prompt: the bound for waiting on a modal OS dialog the user must answer (5 minutes).
pub(super) const DEFAULT_REPORT_AFTER_MS: u64 = 5 * 60_000;

const IMAGE_REFUSED_DETAIL: &str = "the helper image was refused: not a signed, unrevoked Mixdog release build";
const REVOCATION_UNKNOWN_DETAIL: &str = "could not check certificate revocation (offline?)";
const ANOTHER_INSTALL_DETAIL: &str = "another install is already running";
const AWAITING_PROMPT: &str =
    "an administrator (UAC) prompt is already open on the PC: answer it there; no new prompt is shown until it is answered";
const OTHER_PHONE_DETAIL: &str = "another phone\u{2019}s helper request is running on the PC";
const INVALID_KEY_DETAIL: &str = "the phone's control key is invalid";

/// Whether the installed service matches the bundled bridge, from its unelevated `check`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum InstallState {
    Installed,
    Outdated,
    NotInstalled,
    /// Installed and current, but the asking phone's key is not enrolled: add that one key, never reinstall.
    NotEnrolled,
    /// A service another Windows account installed.
    OtherUser,
    Unavailable,
}

impl InstallState {
    fn label(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Outdated => "outdated",
            Self::NotInstalled => "not-installed",
            Self::NotEnrolled => "not-enrolled",
            Self::OtherUser => "other-user",
            Self::Unavailable => "unavailable",
        }
    }
}

/// How one phone request ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum InstallOutcome {
    Installed,
    /// An outdated helper was replaced by the bundled one.
    Updated,
    Declined,
    Failed,
    InProgress,
    OtherUser,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct InstallResult {
    pub outcome: InstallOutcome,
    /// The install state after the request.
    pub state: InstallState,
    /// Short diagnostic for `failed` and `in-progress` (no secrets).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn result(outcome: InstallOutcome, state: InstallState) -> InstallResult {
    InstallResult { outcome, state, detail: None }
}

fn result_with(outcome: InstallOutcome, state: InstallState, detail: &str) -> InstallResult {
    InstallResult { outcome, state, detail: Some(detail.to_string()) }
}

/// The service's state as the helper reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct HelperStatus {
    pub installed: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Whether the bundled bridge would pass the elevated install's image check.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(super) enum ImageCheck {
    Ok,
    Refused { detail: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum KeyVerb {
    Install,
    Enroll,
}

/// One admin-gated key-set operation: the elevation a request launches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct KeyOp {
    pub verb: KeyVerb,
    pub keys: Vec<String>,
    pub revoke: Vec<String>,
}

/// What the installer needs of the bridge. Every method but `run_key_op` is an unelevated read.
pub(super) trait InstallerPort: Send + Sync {
    /// Unelevated state check, relative to the phone key when one is given.
    fn check(&self, controller_key: Option<String>) -> BoxFuture<InstallState>;
    /// Unelevated check that the elevated install would accept the bundled image.
    fn verify_image(&self) -> BoxFuture<ImageCheck>;
    /// Unelevated start of the installed service; the running status after.
    fn start_service(&self) -> BoxFuture<HelperStatus>;
    /// Launches one admin-gated key op and resolves the bridge's exit code (`ELEVATION_DECLINED_EXIT` when
    /// its prompt was declined); an error only when it could not launch. Settles only once the launched
    /// elevation has finished; never gives up on a running child.
    fn run_key_op(&self, op: KeyOp) -> BoxFuture<Result<i32, String>>;
}

/// Time for the installer: the report deadline's timer, and a place to drive a launched elevation to its end
/// when no request is waiting on it any more.
pub(super) trait Timers: Send + Sync {
    /// Completes after `ms`; dropping the future cancels the timer.
    fn sleep(&self, ms: u64) -> BoxFuture<()>;
    fn spawn(&self, task: BoxFuture<()>);
}

/// Timers on the tokio runtime the caller is in.
pub(super) struct TokioTimers;

impl Timers for TokioTimers {
    fn sleep(&self, ms: u64) -> BoxFuture<()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }

    fn spawn(&self, task: BoxFuture<()>) {
        drop(tokio::spawn(task));
    }
}

/// What the PC's user is asked to approve right before an elevation launches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct InstallApproval {
    pub verb: KeyVerb,
    /// The paired phones' controller keys the elevation would enroll.
    pub keys: Vec<String>,
}

/// The PC-side approval hook: the desktop's PC-access UI answers it. `false` refuses.
pub(super) trait PcApproval: Send + Sync {
    fn approve(&self, request: InstallApproval) -> BoxFuture<bool>;
}

/// A port whose elevation waits for the PC-side approval hook: a refusal answers as a declined prompt
/// (`ELEVATION_DECLINED_EXIT`) and the inner port is never asked to launch anything.
pub(super) struct ApprovedPort {
    inner: Arc<dyn InstallerPort>,
    approval: Arc<dyn PcApproval>,
}

impl ApprovedPort {
    pub(super) fn new(inner: Arc<dyn InstallerPort>, approval: Arc<dyn PcApproval>) -> Self {
        Self { inner, approval }
    }
}

impl InstallerPort for ApprovedPort {
    fn check(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        self.inner.check(controller_key)
    }

    fn verify_image(&self) -> BoxFuture<ImageCheck> {
        self.inner.verify_image()
    }

    fn start_service(&self) -> BoxFuture<HelperStatus> {
        self.inner.start_service()
    }

    fn run_key_op(&self, op: KeyOp) -> BoxFuture<Result<i32, String>> {
        let inner = self.inner.clone();
        let approved = self.approval.approve(InstallApproval { verb: op.verb, keys: op.keys.clone() });
        Box::pin(async move {
            if approved.await {
                inner.run_key_op(op).await
            } else {
                Ok(ELEVATION_DECLINED_EXIT)
            }
        })
    }
}

/// What the phone's blocked state offers for an install state. An outdated helper (the installed copy differs
/// from the bundled one, e.g. after an app update bumped the helper protocol) is offered as an update to
/// approve instead of surfacing only as a protocol mismatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum InstallOffer {
    Install,
    Update,
    None,
}

pub(super) fn install_offer_for(state: InstallState) -> InstallOffer {
    match state {
        InstallState::NotInstalled => InstallOffer::Install,
        // Outdated, or current but this phone unenrolled: both are "approve", but `NotEnrolled` only adds
        // this key (an enroll), never a reinstall that would replace the whole key set.
        InstallState::Outdated | InstallState::NotEnrolled => InstallOffer::Update,
        _ => InstallOffer::None,
    }
}

/// An enrollable controller key: unpadded base64url of an uncompressed P-256 point (65 bytes, first 4).
pub(super) fn is_controller_key(value: &str) -> bool {
    if value.len() != 87 || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_') {
        return false;
    }
    // A decoder that, like the platform's, ignores the unused bits of the last symbol.
    let engine = GeneralPurpose::new(&alphabet::URL_SAFE, GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::RequireNone));
    engine.decode(value).is_ok_and(|bytes| bytes.len() == 65 && bytes[0] == 4)
}

fn failure_detail(exit_code: i32, after: InstallState) -> String {
    match exit_code {
        SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT => IMAGE_REFUSED_DETAIL.to_string(),
        SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT => REVOCATION_UNKNOWN_DETAIL.to_string(),
        0 => format!("helper not installed after install ({})", after.label()),
        other => format!("install exited with {other}"),
    }
}

type Launched = Shared<BoxFuture<Result<i32, String>>>;
type Running = Shared<BoxFuture<InstallResult>>;

#[derive(Default)]
struct State {
    /// The request running now, joined by the same phone.
    in_flight: Option<Running>,
    /// The phone key the running request enrolls.
    in_flight_key: Option<String>,
    /// The launched elevation until it is known to have finished, with the number of its launch.
    outstanding: Option<(u64, Launched)>,
    launches: u64,
}

struct Core {
    port: Arc<dyn InstallerPort>,
    timers: Arc<dyn Timers>,
    report_after_ms: u64,
    state: Mutex<State>,
}

impl Core {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The request's result for the elevated install's exit code.
    async fn from_exit_code(&self, exit_code: i32, before: InstallState, key: String) -> InstallResult {
        let after = self.port.check(Some(key)).await;
        match exit_code {
            ELEVATION_DECLINED_EXIT => result(InstallOutcome::Declined, after),
            // Another elevated install held the machine-wide lock: it is doing the work.
            SECURE_DESKTOP_BUSY_EXIT => result_with(InstallOutcome::InProgress, after, ANOTHER_INSTALL_DETAIL),
            // Ownership is re-checked under the elevated lock; nothing was changed.
            SECURE_DESKTOP_OTHER_USER_EXIT => result(InstallOutcome::OtherUser, after),
            0 if after == InstallState::Installed => {
                result(if before == InstallState::Outdated { InstallOutcome::Updated } else { InstallOutcome::Installed }, after)
            }
            _ => InstallResult { outcome: InstallOutcome::Failed, state: after, detail: Some(failure_detail(exit_code, after)) },
        }
    }

    async fn run(self: Arc<Self>, key: String) -> InstallResult {
        // A launched elevation has not settled: never launch another. A determinate installed state answers
        // this request, and only this one; the latch is released solely when the launched process settles.
        let latched = self.state().outstanding.is_some();
        if latched {
            let state = self.port.check(Some(key)).await;
            if state == InstallState::Installed {
                return result(InstallOutcome::Installed, state);
            }
            return result_with(InstallOutcome::InProgress, state, AWAITING_PROMPT);
        }

        let before = self.port.check(Some(key.clone())).await;
        // Nothing the elevated step could fix, nothing to do, or not ours: no prompt.
        match before {
            InstallState::Unavailable => return result(InstallOutcome::Unavailable, before),
            InstallState::Installed => return result(InstallOutcome::Installed, before),
            InstallState::OtherUser => return result(InstallOutcome::OtherUser, before),
            _ => {}
        }
        // Installed and current, but this phone's key is not enrolled: add that one key (an enroll), never a
        // reinstall — a reinstall rebuilds the state and would drop every other paired phone's key. The
        // image is already the bundled one, so there is nothing to verify.
        let enroll_only = before == InstallState::NotEnrolled;
        if !enroll_only
            && let ImageCheck::Refused { detail } = self.port.verify_image().await
        {
            return InstallResult { outcome: InstallOutcome::Failed, state: before, detail: Some(detail) };
        }

        let op = KeyOp {
            verb: if enroll_only { KeyVerb::Enroll } else { KeyVerb::Install },
            keys: vec![key.clone()],
            revoke: Vec::new(),
        };
        let launched = self.launch(op);
        let timer = self.timers.sleep(self.report_after_ms);
        let settled = tokio::select! {
            biased;
            exit = launched.clone() => Some(exit),
            () = timer => None,
        };
        match settled {
            Some(Err(message)) => {
                InstallResult { outcome: InstallOutcome::Failed, state: self.port.check(Some(key)).await, detail: Some(message) }
            }
            None => result_with(InstallOutcome::InProgress, self.port.check(Some(key)).await, AWAITING_PROMPT),
            Some(Ok(exit_code)) => self.from_exit_code(exit_code, before, key).await,
        }
    }

    /// Launches the elevation and latches it: it stays outstanding until it settles, whether or not a request
    /// is still waiting on it (a task drives it to its end).
    fn launch(self: &Arc<Self>, op: KeyOp) -> Launched {
        let id = {
            let mut state = self.state();
            state.launches += 1;
            state.launches
        };
        let core = self.clone();
        let launched: Launched = (Box::pin(async move {
            let exit = core.port.run_key_op(op).await;
            let mut state = core.state();
            if state.outstanding.as_ref().is_some_and(|(held, _)| *held == id) {
                state.outstanding = None;
            }
            exit
        }) as BoxFuture<Result<i32, String>>)
            .shared();
        self.state().outstanding = Some((id, launched.clone()));
        let driven = launched.clone();
        self.timers.spawn(Box::pin(async move {
            let _ = driven.await;
        }));
        launched
    }
}

pub(super) struct SecureDesktopInstaller {
    core: Arc<Core>,
}

impl SecureDesktopInstaller {
    pub(super) fn new(port: Arc<dyn InstallerPort>, timers: Arc<dyn Timers>, report_after_ms: Option<u64>) -> Self {
        Self {
            core: Arc::new(Core {
                port,
                timers,
                report_after_ms: report_after_ms.unwrap_or(DEFAULT_REPORT_AFTER_MS),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Current install state, for that phone when its key is given; never prompts.
    pub(super) fn state(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        self.core.port.check(controller_key)
    }

    /// Whether a request (and so possibly a prompt) is in progress.
    pub(super) fn pending(&self) -> bool {
        let state = self.core.state();
        state.in_flight.is_some() || state.outstanding.is_some()
    }

    /// Handles one phone request carrying its public control key: at most one prompt, never retried. An
    /// invalid key fails without a prompt. The request takes its place now: the same phone's request made
    /// while it runs joins it, another phone's is told `in-progress`.
    pub(super) fn request(&self, controller_key: &str) -> BoxFuture<InstallResult> {
        let core = self.core.clone();
        if !is_controller_key(controller_key) {
            return Box::pin(async move {
                InstallResult {
                    outcome: InstallOutcome::Failed,
                    state: core.port.check(None).await,
                    detail: Some(INVALID_KEY_DETAIL.to_string()),
                }
            });
        }
        let key = controller_key.to_string();
        let mut state = self.core.state();
        // The same phone joins the running request; another phone does not get that phone's result as its own.
        if state.in_flight.is_some() && state.in_flight_key.as_deref() != Some(controller_key) {
            drop(state);
            return Box::pin(async move {
                InstallResult {
                    outcome: InstallOutcome::InProgress,
                    state: core.port.check(Some(key)).await,
                    detail: Some(OTHER_PHONE_DETAIL.to_string()),
                }
            });
        }
        state.in_flight_key = Some(key.clone());
        let running = match &state.in_flight {
            Some(running) => running.clone(),
            None => {
                let running: Running = (Box::pin(async move {
                    let outcome = core.clone().run(key).await;
                    let mut state = core.state();
                    state.in_flight = None;
                    state.in_flight_key = None;
                    outcome
                }) as BoxFuture<InstallResult>)
                    .shared();
                state.in_flight = Some(running.clone());
                running
            }
        };
        drop(state);
        Box::pin(running)
    }

    /// Starts the installed service if it is registered but stopped (after a reboot). Never installs, never
    /// prompts; the running status after.
    pub(super) fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        let port = self.core.port.clone();
        Box::pin(async move {
            if port.check(None).await != InstallState::Installed {
                return HelperStatus { installed: false, running: false, version: None };
            }
            port.start_service().await
        })
    }
}
