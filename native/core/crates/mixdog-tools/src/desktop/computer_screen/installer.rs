//! On-demand install of the secure-desktop helper (Node: `secure-desktop/install-request.ts`).
//!
//! Nothing installs the helper by itself: not on app install, not on update, not on start. The only trigger
//! is the paired phone's request from the secure-desktop blocked state, and each request is at most one
//! elevation prompt on the PC, answered by the PC's user. Nothing retries: a declined or failed request
//! leaves the helper not installed (or outdated) until the phone asks again. A request made while one is
//! running joins it instead of opening a second prompt, and a launched elevation is latched until the
//! process it launched has settled: when it has not finished by the report deadline the request answers
//! `in-progress`, and every later request launches nothing until that elevation exits. The elevation prompt
//! is the PC-side approval, as in Node: there is no other approval step on the request path.
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
use tokio::sync::oneshot;

use super::router::BoxFuture;
use super::turn::Turn;

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
/// The batch-logon path's refusals (Node `client.ts:500-505`).
const SECURE_DESKTOP_BAD_CREDENTIALS_EXIT: i32 = 10;
const SECURE_DESKTOP_NOT_ADMIN_EXIT: i32 = 11;
const SECURE_DESKTOP_LOGON_TYPE_DENIED_EXIT: i32 = 12;
const SECURE_DESKTOP_ACCOUNT_LOCKED_EXIT: i32 = 13;
const SECURE_DESKTOP_ACCOUNT_DISABLED_EXIT: i32 = 14;
const SECURE_DESKTOP_POLICY_BLOCKED_EXIT: i32 = 15;
/// The app-delegated path: delegation off, the service refused this caller, the service unreachable
/// (Node `client.ts:508-510`).
const SECURE_DESKTOP_DELEGATION_DISABLED_EXIT: i32 = 20;
const SECURE_DESKTOP_DELEGATION_DENIED_EXIT: i32 = 21;
const SECURE_DESKTOP_DELEGATION_UNAVAILABLE_EXIT: i32 = 22;

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
const KEY_OP_IN_FLIGHT: &str = "another secure-desktop admin action is already running on the PC";
const INVALID_KEY_OP_DETAIL: &str = "a controller key is invalid";

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum KeyVerb {
    Install,
    Enroll,
    Revoke,
}

/// The PC account's Windows password a phone typed, for the no-prompt batch-logon path.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Credential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub password: String,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Credential(..)")
    }
}

/// One admin-gated key-set operation and its authorization path: a UAC prompt when `credential` is absent,
/// the batch logon with it, or the unelevated app-delegation path when `delegated` (enroll and revoke only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct KeyOp {
    pub verb: KeyVerb,
    /// Keys to enroll (install, enroll); for a revoke, the keys to remove.
    pub keys: Vec<String>,
    /// Keys to also remove in the same op (pending revokes on install or enroll).
    pub revoke: Vec<String>,
    pub credential: Option<Credential>,
    pub delegated: Option<bool>,
}

/// Options of an explicit key-set operation (PC access).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub(super) struct KeyChangeOptions {
    /// Keys to also revoke in the same elevation (pending revokes).
    #[serde(default)]
    pub revoke: Vec<String>,
    #[serde(default)]
    pub credential: Option<Credential>,
    #[serde(default)]
    pub delegated: Option<bool>,
}

/// How a key-set operation ended: the request outcomes, the key-change successes, the batch-logon path's
/// refusals and the app-delegated path's PC-side refusals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum KeyChangeOutcome {
    Installed,
    Updated,
    Declined,
    Failed,
    InProgress,
    OtherUser,
    Unavailable,
    Enrolled,
    Revoked,
    BadCredentials,
    NotAdmin,
    LogonTypeDenied,
    AccountLocked,
    AccountDisabled,
    PolicyBlocked,
    DelegationDisabled,
    DelegationDenied,
    ServiceUnreachable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct KeyChangeResult {
    pub outcome: KeyChangeOutcome,
    pub state: InstallState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The bridge's exit code when a `failed` came from it exiting without installing; absent when it never
    /// ran or never exited (a launch error).
    #[serde(default, rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

fn key_change(outcome: KeyChangeOutcome, state: InstallState) -> KeyChangeResult {
    KeyChangeResult { outcome, state, detail: None, exit_code: None }
}

/// The batch-logon refusal for an exit code, from the code alone, so nothing secret is echoed.
fn credential_outcome(exit_code: i32) -> Option<KeyChangeOutcome> {
    match exit_code {
        SECURE_DESKTOP_BAD_CREDENTIALS_EXIT => Some(KeyChangeOutcome::BadCredentials),
        SECURE_DESKTOP_NOT_ADMIN_EXIT => Some(KeyChangeOutcome::NotAdmin),
        SECURE_DESKTOP_LOGON_TYPE_DENIED_EXIT => Some(KeyChangeOutcome::LogonTypeDenied),
        SECURE_DESKTOP_ACCOUNT_LOCKED_EXIT => Some(KeyChangeOutcome::AccountLocked),
        SECURE_DESKTOP_ACCOUNT_DISABLED_EXIT => Some(KeyChangeOutcome::AccountDisabled),
        SECURE_DESKTOP_POLICY_BLOCKED_EXIT => Some(KeyChangeOutcome::PolicyBlocked),
        _ => None,
    }
}

/// A key op's outcome for the bridge's exit code; `before` and `after` are the install state around it (an
/// install of an outdated helper reads as `updated`).
fn key_change_from_exit(verb: KeyVerb, exit_code: i32, before: InstallState, after: InstallState) -> KeyChangeResult {
    let failed = |detail: String| KeyChangeResult { outcome: KeyChangeOutcome::Failed, state: after, detail: Some(detail), exit_code: Some(exit_code) };
    match exit_code {
        0 => key_change(
            match verb {
                KeyVerb::Install if before == InstallState::Outdated => KeyChangeOutcome::Updated,
                KeyVerb::Install => KeyChangeOutcome::Installed,
                KeyVerb::Enroll => KeyChangeOutcome::Enrolled,
                KeyVerb::Revoke => KeyChangeOutcome::Revoked,
            },
            after,
        ),
        ELEVATION_DECLINED_EXIT => key_change(KeyChangeOutcome::Declined, after),
        SECURE_DESKTOP_BUSY_EXIT => KeyChangeResult {
            outcome: KeyChangeOutcome::InProgress,
            state: after,
            detail: Some(ANOTHER_INSTALL_DETAIL.to_string()),
            exit_code: None,
        },
        SECURE_DESKTOP_OTHER_USER_EXIT => key_change(KeyChangeOutcome::OtherUser, after),
        SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT => failed(IMAGE_REFUSED_DETAIL.to_string()),
        SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT => failed(REVOCATION_UNKNOWN_DETAIL.to_string()),
        SECURE_DESKTOP_DELEGATION_DISABLED_EXIT => key_change(KeyChangeOutcome::DelegationDisabled, after),
        SECURE_DESKTOP_DELEGATION_DENIED_EXIT => key_change(KeyChangeOutcome::DelegationDenied, after),
        SECURE_DESKTOP_DELEGATION_UNAVAILABLE_EXIT => key_change(KeyChangeOutcome::ServiceUnreachable, after),
        other => match credential_outcome(other) {
            Some(outcome) => key_change(outcome, after),
            None => failed(format!("the helper exited with {other}")),
        },
    }
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

/// Time for screen control, and its one thread of control: a clock, timers, a place to run work that goes on
/// whether or not its caller still waits (a launched elevation, a request, a queued input step), as Node's promises
/// do, and the [`Turn`] every task and timer callback runs in. Every part of one screen control (its helper, its
/// sessions, their video sources) shares one `Timers`, so one turn serialises them all, as Node's one thread does.
pub(super) trait Timers: Send + Sync {
    /// Milliseconds on a monotonic clock (Node reads `Date.now()` only for differences).
    fn now_ms(&self) -> f64;
    /// Completes after `after`; dropping the future cancels the timer.
    fn sleep(&self, after: std::time::Duration) -> BoxFuture<()>;
    /// Runs `task` on the runtime as it is (see [`Timers::spawn`]).
    fn run(&self, task: BoxFuture<()>);
    /// Calls `callback` once after `after` unless the handle is cleared first (see [`Timers::set_timeout`]).
    fn arm(&self, after: std::time::Duration, callback: Box<dyn FnOnce() + Send>) -> TimerHandle;
    fn turn(&self) -> &Arc<Turn>;

    /// Runs `task`, polled in the turn.
    fn spawn(&self, task: BoxFuture<()>) {
        self.run(self.turn().guard(task));
    }

    /// Runs `callback` in the turn after `after` unless the handle is cleared first (Node's `setTimeout`). A
    /// callback the runtime already started while the turn was busy still checks for a clear made meanwhile, in
    /// the turn, so a cleared timer never runs.
    fn set_timeout(&self, after: std::time::Duration, callback: Box<dyn FnOnce() + Send>) -> TimerHandle {
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn = self.turn().clone();
        let armed = cleared.clone();
        let timer = self.arm(
            after,
            Box::new(move || {
                turn.enter(|| {
                    if !armed.load(std::sync::atomic::Ordering::SeqCst) {
                        callback();
                    }
                });
            }),
        );
        TimerHandle::new(move || {
            cleared.store(true, std::sync::atomic::Ordering::SeqCst);
            timer.clear();
        })
    }

    /// Node's `answer.then(reaction)` on an answer already asked for: `task` awaits the answer, then reacts. It is
    /// polled once here (the caller is in the turn), so an answer that is already settled is taken up by the
    /// task's first turn, as Node's reaction job is; otherwise the task waits like any other.
    fn react(&self, mut task: BoxFuture<()>) {
        let waker = futures::task::noop_waker();
        if task.as_mut().poll(&mut std::task::Context::from_waker(&waker)).is_pending() {
            self.spawn(task);
        }
    }
}

/// Timers on the tokio runtime the caller is in.
pub(super) struct TokioTimers {
    origin: tokio::time::Instant,
    turn: Arc<Turn>,
}

impl TokioTimers {
    pub(super) fn new() -> Self {
        Self { origin: tokio::time::Instant::now(), turn: Turn::new() }
    }
}

impl Timers for TokioTimers {
    fn now_ms(&self) -> f64 {
        self.origin.elapsed().as_secs_f64() * 1e3
    }

    fn sleep(&self, after: std::time::Duration) -> BoxFuture<()> {
        Box::pin(tokio::time::sleep(after))
    }

    fn run(&self, task: BoxFuture<()>) {
        drop(tokio::spawn(task));
    }

    fn turn(&self) -> &Arc<Turn> {
        &self.turn
    }

    fn arm(&self, after: std::time::Duration, callback: Box<dyn FnOnce() + Send>) -> TimerHandle {
        let cleared = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let armed = cleared.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(after).await;
            if !armed.load(std::sync::atomic::Ordering::SeqCst) {
                callback();
            }
        });
        TimerHandle::new(move || {
            cleared.store(true, std::sync::atomic::Ordering::SeqCst);
            task.abort();
        })
    }
}

/// A timer armed with [`Timers::set_timeout`]; `clear` stops it from running (Node's `clearTimeout`), at once.
pub(super) struct TimerHandle {
    clear: Box<dyn FnOnce() + Send>,
}

impl TimerHandle {
    pub(super) fn new(clear: impl FnOnce() + Send + 'static) -> Self {
        Self { clear: Box::new(clear) }
    }

    pub(super) fn clear(self) {
        (self.clear)();
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
type KeyChanging = Shared<BoxFuture<KeyChangeResult>>;

#[derive(Default)]
struct State {
    /// The request running now, with the callers waiting for its answer in the order they asked (the same
    /// phone joins it).
    in_flight: Option<Vec<oneshot::Sender<InstallResult>>>,
    /// The phone key the running request enrolls.
    in_flight_key: Option<String>,
    /// The launched elevation until it is known to have finished, with the number of its launch.
    outstanding: Option<(u64, Launched)>,
    launches: u64,
    /// The one explicit key op (install, enroll, revoke) running, with its number: at most one admin action
    /// at a time across all phones and PC access, never queued and never retried.
    key_op: Option<(u64, KeyChanging)>,
    key_ops: u64,
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

    /// One phone request. It starts now, as Node's does when it is called: the latch is read and the first
    /// state check is made before this returns; the rest runs when the returned future is driven.
    fn run(self: Arc<Self>, key: String) -> BoxFuture<InstallResult> {
        // A launched elevation or an explicit key op has not settled: never launch another. A determinate
        // installed state answers this request, and only this one; the latch is released solely when the
        // launched process settles.
        let latched = {
            let state = self.state();
            state.outstanding.is_some() || state.key_op.is_some()
        };
        let checked = self.port.check(Some(key.clone()));
        if latched {
            return Box::pin(async move {
                let state = checked.await;
                if state == InstallState::Installed {
                    return result(InstallOutcome::Installed, state);
                }
                result_with(InstallOutcome::InProgress, state, AWAITING_PROMPT)
            });
        }
        Box::pin(self.launch_for(key, checked))
    }

    async fn launch_for(self: Arc<Self>, key: String, checked: BoxFuture<InstallState>) -> InstallResult {
        let before = checked.await;
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
            credential: None,
            delegated: None,
        };
        let launched = self.launch(op);
        let timer = self.timers.sleep(std::time::Duration::from_millis(self.report_after_ms));
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

    /// One explicit key op through the port: an install checks the image first; the state before and after
    /// it decide the outcome with the exit code. The first port call is made now, as Node's runs up to its
    /// first await when it is called.
    fn perform_key_change(core: Arc<Self>, verb: KeyVerb, keys: Vec<String>, options: KeyChangeOptions) -> BoxFuture<KeyChangeResult> {
        let first: Result<BoxFuture<ImageCheck>, BoxFuture<InstallState>> =
            if verb == KeyVerb::Install { Ok(core.port.verify_image()) } else { Err(core.port.check(keys.first().cloned())) };
        Box::pin(async move {
            let before = match first {
                Ok(image) => {
                    if let ImageCheck::Refused { detail } = image.await {
                        return KeyChangeResult {
                            outcome: KeyChangeOutcome::Failed,
                            state: core.port.check(None).await,
                            detail: Some(detail),
                            exit_code: None,
                        };
                    }
                    core.port.check(keys.first().cloned()).await
                }
                Err(before) => before.await,
            };
            let KeyChangeOptions { revoke, credential, delegated } = options;
            let op = KeyOp { verb, keys: keys.clone(), revoke, credential, delegated };
            match core.port.run_key_op(op).await {
                Err(message) => KeyChangeResult {
                    outcome: KeyChangeOutcome::Failed,
                    state: core.port.check(None).await,
                    detail: Some(message),
                    exit_code: None,
                },
                Ok(exit_code) => {
                    let after = core.port.check(keys.first().cloned()).await;
                    key_change_from_exit(verb, exit_code, before, after)
                }
            }
        })
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

    /// Whether a request or a key op (and so possibly a prompt) is in progress.
    pub(super) fn pending(&self) -> bool {
        let state = self.core.state();
        state.in_flight.is_some() || state.outstanding.is_some() || state.key_op.is_some()
    }

    /// PC access: installs (or updates) the helper enrolling `keys`, applying `options.revoke` in the same
    /// elevation.
    pub(super) fn install(&self, keys: Vec<String>, options: KeyChangeOptions) -> BoxFuture<KeyChangeResult> {
        self.key_change(KeyVerb::Install, keys, options)
    }

    /// PC access: enrolls one or several keys in a single authorization into the installed helper.
    pub(super) fn enroll(&self, keys: Vec<String>, options: KeyChangeOptions) -> BoxFuture<KeyChangeResult> {
        self.key_change(KeyVerb::Enroll, keys, options)
    }

    /// PC access: revokes one phone's key.
    pub(super) fn revoke(&self, key: String, options: KeyChangeOptions) -> BoxFuture<KeyChangeResult> {
        self.key_change(KeyVerb::Revoke, vec![key], options)
    }

    /// One explicit key op, the one admin action at a time (a phone request's elevation included): a second
    /// while one runs is answered `in-progress`, not queued. The latch is taken when the call is made.
    fn key_change(&self, verb: KeyVerb, keys: Vec<String>, options: KeyChangeOptions) -> BoxFuture<KeyChangeResult> {
        let core = self.core.clone();
        let mut state = self.core.state();
        if state.in_flight.is_some() || state.outstanding.is_some() || state.key_op.is_some() {
            drop(state);
            let checked = core.port.check(None);
            return Box::pin(async move {
                KeyChangeResult {
                    outcome: KeyChangeOutcome::InProgress,
                    state: checked.await,
                    detail: Some(KEY_OP_IN_FLIGHT.to_string()),
                    exit_code: None,
                }
            });
        }
        if !keys.iter().chain(&options.revoke).all(|key| is_controller_key(key)) {
            drop(state);
            let checked = core.port.check(None);
            return Box::pin(async move {
                KeyChangeResult {
                    outcome: KeyChangeOutcome::Failed,
                    state: checked.await,
                    detail: Some(INVALID_KEY_OP_DETAIL.to_string()),
                    exit_code: None,
                }
            });
        }
        state.key_ops += 1;
        let id = state.key_ops;
        let performed = Core::perform_key_change(core.clone(), verb, keys, options);
        let running: KeyChanging = (Box::pin(async move {
            let result = performed.await;
            let mut state = core.state();
            if state.key_op.as_ref().is_some_and(|(held, _)| *held == id) {
                state.key_op = None;
            }
            result
        }) as BoxFuture<KeyChangeResult>)
            .shared();
        state.key_op = Some((id, running.clone()));
        drop(state);
        // Driven to its end whether or not the caller still waits, like Node's promise.
        let driven = running.clone();
        self.core.timers.spawn(Box::pin(async move {
            let _ = driven.await;
        }));
        Box::pin(running)
    }

    /// Handles one phone request carrying its public control key: at most one prompt, never retried. An
    /// invalid key fails without a prompt. The request takes its place now: the same phone's request made
    /// while it runs joins it, another phone's is told `in-progress`.
    pub(super) fn request(&self, controller_key: &str) -> BoxFuture<InstallResult> {
        let core = self.core.clone();
        if !is_controller_key(controller_key) {
            let checked = core.port.check(None);
            return Box::pin(async move {
                InstallResult { outcome: InstallOutcome::Failed, state: checked.await, detail: Some(INVALID_KEY_DETAIL.to_string()) }
            });
        }
        let key = controller_key.to_string();
        let mut state = self.core.state();
        // The same phone joins the running request; another phone does not get that phone's result as its own.
        if state.in_flight.is_some() && state.in_flight_key.as_deref() != Some(controller_key) {
            drop(state);
            let checked = core.port.check(Some(key));
            return Box::pin(async move {
                InstallResult { outcome: InstallOutcome::InProgress, state: checked.await, detail: Some(OTHER_PHONE_DETAIL.to_string()) }
            });
        }
        state.in_flight_key = Some(key.clone());
        let (answer, answered) = oneshot::channel();
        if let Some(waiters) = state.in_flight.as_mut() {
            waiters.push(answer);
        } else {
            state.in_flight = Some(vec![answer]);
            drop(state);
            // The request runs to its end whether or not anyone still waits for it, as Node's promise does:
            // the latch it holds is released only when it ends. Its answer reaches every caller that joined,
            // in the order they asked.
            let running = core.clone().run(key);
            self.core.timers.spawn(Box::pin(async move {
                let outcome = running.await;
                let waiters = {
                    let mut state = core.state();
                    state.in_flight_key = None;
                    state.in_flight.take().unwrap_or_default()
                };
                for waiter in waiters {
                    let _ = waiter.send(outcome.clone());
                }
            }));
        }
        Box::pin(async move { answered.await.expect("a running request answers every caller that joined it") })
    }

    /// Starts the installed service if it is registered but stopped (after a reboot). Never installs, never
    /// prompts; the running status after.
    pub(super) fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        let port = self.core.port.clone();
        let checked = port.check(None);
        Box::pin(async move {
            if checked.await != InstallState::Installed {
                return HelperStatus { installed: false, running: false, version: None };
            }
            port.start_service().await
        })
    }
}
