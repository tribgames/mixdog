//! The whole-PC screen session of one viewer (a paired phone × one display) (Node: `screen-source.ts`,
//! `createRemoteScreenSource`, with the geometry of `screen-geometry.ts` and the input mapping of
//! `screen-input-dispatch.ts`). It locks the geometry and the capture plan, dispatches the viewer's input into
//! the desktop, switches to the secure-desktop helper (frames and input) when a UAC prompt or the lock screen
//! takes the input desktop, and on stop releases every held key and button and closes its backends.
//!
//! - The decision (`refresh_decision`) is re-read whenever the local input desktop, the helper's connection or
//!   desktop, its hold, or the service's state changes. The gate and the status change at once; the backend
//!   change is one turn of the input queue: the previous backend's presses are released through it, the helper
//!   is activated before it takes over and deactivated after its own presses were released.
//! - The status's helper block: the install offer (the check at start, then each install or password request of
//!   this session, a later one superseding an earlier one's answer), the outcome and detail of the last request,
//!   and the helper's reportable issue while it is active here.
//! - After a reboot the installed service is stopped: it is started at session start when the install is
//!   current, and each time the helper is activated while not connected; a failed start shows as helper
//!   `failed` until a connection or a later start.
//! - The stop is bounded by a deadline: when it passes, the input host is killed and every pending send is
//!   abandoned, so a backend that stopped answering cannot hold the stop open.
//!
//! Every dependency call takes effect when it is made, as Node's do; what Node leaves running behind a
//! promise (`void …then(…)`) runs as a task of [`Timers::spawn`].

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;

use super::installer::Credential;
use super::installer::HelperStatus;
use super::installer::InstallOffer;
use super::installer::InstallResult;
use super::installer::InstallState;
use super::installer::TimerHandle;
use super::installer::Timers;
use super::installer::install_offer_for;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::HelperError;
use super::lease::HelperFrame;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::SecureDesktopLease;
use super::lease::Unsub;
use super::router::BackendId;
use super::router::BoxFuture;
use super::router::RouteOutcome;
use super::router::ScreenBackend;
use super::router::ScreenInputRouter;
use super::router::SendError;
use super::router::SwitchHooks;
use super::router::next_turn;
use super::switch::HelperIssue;
use super::switch::HelperOffer;
use super::switch::HelperView;
use super::switch::LocalDesktop;
use super::switch::ScreenHelperFacts;
use super::switch::SourceDecision;
use super::switch::SourceMode;
use super::switch::SwitchInputs;
use super::switch::decide_screen_source;
use super::switch::decision_uses_helper;
use super::switch::helper_issue_after_change;
use super::switch::screen_helper_issue;
use super::switch::screen_status_for;
use super::switch::secure_desktop_identity;
use super::video::VideoPath;

/// Computer Use's per-command ceiling for the same PowerShell host round trip (`COMMAND_TIMEOUT_MS`): the
/// default stop deadline, since a backend that answers completes the whole release well within one command.
const COMMAND_TIMEOUT_MS: u64 = 45_000;
/// The contract's bound on a helper detail (`MAX_REMOTE_SCREEN_HELPER_DETAIL`), in UTF-16 code units.
const MAX_HELPER_DETAIL: usize = 256;
/// The contract's pixel bound (`MAX_PIXEL_DIMENSION`).
const MAX_SCREEN_PIXELS: f64 = 4_096.0;
const MIN_SCREEN_PIXELS: i64 = 64;
const MIN_CSS: f64 = 200.0;
const MAX_CSS: f64 = 3_840.0;
const CREDENTIAL_FAILED: &str = "the request could not be completed";
const DETAIL_HIDDEN: &str = "the request failed";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A JSON number as JavaScript writes it: whole numbers without a fraction.
pub(super) fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// JavaScript's `Number(text)` for the decimal numbers the input host writes; anything else is `NaN`.
fn js_number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        return 0.0;
    }
    let numeric = text.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'+' | b'e' | b'E'));
    if numeric { text.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// The first `units` UTF-16 code units of `text` (JavaScript's `slice`); a surrogate pair cut in half loses
/// its first half too, since a lone surrogate is no Rust text.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut taken = 0;
    let mut end = 0;
    for character in text.chars() {
        taken += character.len_utf16();
        if taken > units {
            break;
        }
        end += character.len_utf8();
    }
    text[..end].to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry (screen-geometry.ts)

/// A rectangle in physical desktop pixels of the virtual screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub(super) struct PixelRect {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// A rectangle in DIPs (Electron's `Display.bounds`).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub(super) struct DipRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One display as the platform reports it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScreenDisplay {
    pub screen_id: String,
    pub label: String,
    pub primary: bool,
    pub scale_factor: f64,
    pub bounds: DipRect,
    pub physical: PixelRect,
    /// The capture source whose display is this one.
    pub capture_source_id: String,
}

fn summarize_display(display: &ScreenDisplay) -> Value {
    json!({
        "screenId": display.screen_id,
        "label": display.label,
        "primary": display.primary,
        "pixelWidth": display.physical.width,
        "pixelHeight": display.physical.height,
        "scaleFactor": number(display.scale_factor),
    })
}

/// Video pixels → desktop pixels for one geometry generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PointerMapping {
    pub generation: u64,
    pub pixel_width: i64,
    pub pixel_height: i64,
    pub physical: PixelRect,
}

/// The display's native pixel size, scaled down uniformly only when a side exceeds the contract bound, then
/// made even for 4:2:0 chroma.
fn screen_video_size(physical: PixelRect) -> Result<(i64, i64), String> {
    if physical.width < MIN_SCREEN_PIXELS || physical.height < MIN_SCREEN_PIXELS {
        return Err("remote screen display is too small to stream".to_string());
    }
    let (width, height) = (physical.width as f64, physical.height as f64);
    let scale = 1f64.min(MAX_SCREEN_PIXELS / width).min(MAX_SCREEN_PIXELS / height);
    let even = |value: f64| MIN_SCREEN_PIXELS.max(((value / 2.0).floor() * 2.0) as i64);
    Ok((even(width * scale), even(height * scale)))
}

fn geometry_changed(mapping: &PointerMapping, display: &ScreenDisplay) -> bool {
    mapping.physical != display.physical
}

/// A video-pixel point → the desktop pixel under it, or `None` outside the frame. The far edge lands on the
/// last pixel.
fn map_screen_pointer(mapping: &PointerMapping, x: f64, y: f64) -> Option<(i64, i64)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    if x < 0.0 || y < 0.0 || x > mapping.pixel_width as f64 || y > mapping.pixel_height as f64 {
        return None;
    }
    let physical = mapping.physical;
    let column = (physical.width - 1).min((x * physical.width as f64 / mapping.pixel_width as f64).floor() as i64);
    let row = (physical.height - 1).min((y * physical.height as f64 / mapping.pixel_height as f64).floor() as i64);
    Some((physical.x + column, physical.y + row))
}

/// A desktop pixel → the video pixel showing it, or `None` when it is not on this display.
fn screen_point_to_video(mapping: &PointerMapping, x: f64, y: f64) -> Option<(i64, i64)> {
    let physical = mapping.physical;
    let column = x - physical.x as f64;
    let row = y - physical.y as f64;
    if !column.is_finite() || !row.is_finite() {
        return None;
    }
    if column < 0.0 || row < 0.0 || column >= physical.width as f64 || row >= physical.height as f64 {
        return None;
    }
    let video = |at: f64, pixels: i64, extent: i64| (pixels - 1).min(((at + 0.5) * pixels as f64 / extent as f64).floor() as i64);
    Some((video(column, mapping.pixel_width, physical.width), video(row, mapping.pixel_height, physical.height)))
}

/// A rectangle in (possibly fractional) video pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct VideoRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The part of a helper frame that shows the display, for the sender to crop and scale: no pixel is touched.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HelperPicture {
    /// The frame's pixels; the picture's rows are `rows` of it.
    pub pixels: Arc<Vec<u8>>,
    /// The byte range of the rows that cover the display: `height` rows `stride` bytes apart.
    pub rows: std::ops::Range<usize>,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    /// The display's part of those rows, in their pixels.
    pub source: PixelRect,
    /// Where that part lands in the locked picture; the rest stays black.
    pub target: VideoRect,
}

/// Locates the display in a helper frame; `Ok(None)` when the frame does not cover it, `Err` when the frame is
/// malformed.
fn screen_frame_region(frame: &HelperFrame, mapping: &PointerMapping) -> Result<Option<HelperPicture>, ()> {
    let (width, height, stride) = (i64::from(frame.width), i64::from(frame.height), i64::from(frame.stride));
    if width < 1 || height < 1 || stride < width * 4 || (frame.pixels.len() as i64) < stride * height {
        return Err(());
    }
    let physical = mapping.physical;
    let (origin_x, origin_y) = (i64::from(frame.origin_x), i64::from(frame.origin_y));
    let left = physical.x.max(origin_x);
    let top = physical.y.max(origin_y);
    let right = (physical.x + physical.width).min(origin_x + width);
    let bottom = (physical.y + physical.height).min(origin_y + height);
    if right <= left || bottom <= top {
        return Ok(None);
    }
    let first_row = top - origin_y;
    let rows = bottom - top;
    let scale_x = mapping.pixel_width as f64 / physical.width as f64;
    let scale_y = mapping.pixel_height as f64 / physical.height as f64;
    Ok(Some(HelperPicture {
        pixels: frame.pixels.clone(),
        rows: (first_row * stride) as usize..((first_row + rows) * stride) as usize,
        width: frame.width,
        height: rows as u32,
        stride: frame.stride,
        source: PixelRect { x: left - origin_x, y: 0, width: right - left, height: rows },
        target: VideoRect {
            x: (left - physical.x) as f64 * scale_x,
            y: (top - physical.y) as f64 * scale_y,
            width: (right - left) as f64 * scale_x,
            height: rows as f64 * scale_y,
        },
    }))
}

// ---------------------------------------------------------------------------------------------------------------
// Input mapping (screen-input-dispatch.ts)

fn button_of(name: &str) -> Option<PointerButton> {
    match name {
        "left" => Some(PointerButton::Left),
        "right" => Some(PointerButton::Right),
        "middle" => Some(PointerButton::Middle),
        _ => None,
    }
}

fn key_of(key: &Value, down: bool) -> Option<ScreenInput> {
    Some(ScreenInput::Key {
        vk: u32::try_from(key["vk"].as_u64()?).ok()?,
        scan: u32::try_from(key["scan"].as_u64()?).ok()?,
        extended: key["extended"].as_bool()?,
        down,
    })
}

/// The commands one validated viewer input produces, or `None` when it cannot be applied now: a pointer or
/// wheel of another geometry generation, a point out of bounds, or a zero wheel. A button up is always
/// deliverable: unmapped, it releases in place.
fn screen_input_commands(input: &Value, mapping: Option<&PointerMapping>, generation: u64) -> Option<Vec<ScreenInput>> {
    let point = || {
        let mapping = mapping.filter(|mapping| mapping.generation == generation)?;
        let (x, y) = map_screen_pointer(mapping, input["x"].as_f64()?, input["y"].as_f64()?)?;
        Some((i32::try_from(x).ok()?, i32::try_from(y).ok()?))
    };
    let action = input["action"].as_str();
    match input["type"].as_str()? {
        "screen-pointer" => {
            let button = input["button"].as_str().and_then(button_of);
            match (point(), action) {
                (None, Some("up")) => Some(vec![ScreenInput::Button { button: button?, down: false, at: None }]),
                (None, _) => None,
                (Some((x, y)), Some("move")) => Some(vec![ScreenInput::Move { x, y }]),
                (Some(at), _) => Some(vec![ScreenInput::Button { button: button?, down: action == Some("down"), at: Some(at) }]),
            }
        }
        "screen-wheel" => {
            let (x, y) = point()?;
            let (dx, dy) = (input["deltaX"].as_f64()?, input["deltaY"].as_f64()?);
            if dx == 0.0 && dy == 0.0 {
                return None;
            }
            Some(vec![ScreenInput::Wheel { x, y, dx: dx as i32, dy: dy as i32 }])
        }
        "screen-key" => Some(vec![key_of(input, action == Some("down"))?]),
        "screen-keys" => input["keys"].as_array()?.iter().map(|key| key_of(key, true)).collect(),
        "screen-text" => Some(vec![ScreenInput::Text(input["text"].as_str()?.to_string())]),
        "screen-release" => Some(Vec::new()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Dependencies

/// A command for the input host: an input, or the cursor read-back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum HostCommand {
    Input(ScreenInput),
    Cursor,
}

/// The Windows input host of the ordinary desktop: the injector, and the local UAC / lock detector.
pub(super) trait ScreenHost: Send + Sync {
    /// Completes once the process serves.
    fn start(&self) -> BoxFuture<Result<(), String>>;
    /// The `ok` fields of the answer; the error code otherwise.
    fn command(&self, command: HostCommand) -> BoxFuture<Result<Vec<String>, String>>;
    fn desktop(&self) -> Option<LocalDesktop>;
    /// The Windows session the process runs in.
    fn session(&self) -> Option<u32>;
    fn on_desktop(&self, listener: Listener<LocalDesktop>) -> Unsub;
    /// An exit this side did not ask for.
    fn on_exit(&self, listener: Listener<()>) -> Unsub;
    /// Releases what the process holds, then ends it.
    fn stop(&self) -> BoxFuture<()>;
    /// Ends the process at once, without its release-on-quit.
    fn kill(&self);
}

/// Where a command through the host lands now: its session and the input desktop's name, lower-cased.
fn screen_host_identity(host: &dyn ScreenHost) -> Option<DesktopIdentity> {
    let session = host.session()?;
    let name = host.desktop()?.input_desktop.filter(|name| !name.is_empty())?;
    Some(DesktopIdentity { session, desktop: name.to_lowercase() })
}

/// The displays the PC has now.
pub(super) trait ScreenDisplays: Send + Sync {
    fn list(&self) -> Vec<ScreenDisplay>;
    /// Fires when displays are added, removed or rescaled.
    fn on_change(&self, listener: Listener<()>) -> Unsub;
}

/// The viewer's trust, read live. Pairing is the approval: a paired phone may view and control.
pub(super) trait ViewerAuthorization: Send + Sync {
    /// The viewer's connection is a paired, E2EE-established client and still connected.
    fn paired(&self) -> bool;
    /// Why `paired()` is false: `viewer-left` or `revoked`.
    fn lost(&self) -> String;
    fn on_change(&self, listener: Listener<()>) -> Unsub;
}

/// What the on-PC indicator shows, with its one-click stop.
pub(super) struct IndicatorView {
    pub client_label: String,
    pub controlling: bool,
    pub screen_id: String,
    pub on_stop: Arc<dyn Fn() + Send + Sync>,
}

pub(super) trait ScreenIndicator: Send + Sync {
    fn show(&self, view: IndicatorView);
    fn update(&self, controlling: bool);
    fn hide(&self);
}

/// A credential the session empties once its request ended, wherever it is reachable from.
pub(super) type SharedCredential = Arc<Mutex<Credential>>;

fn wipe_credential(credential: &SharedCredential) {
    let mut credential = lock(credential);
    credential.password.clear();
    credential.user = None;
}

/// Aborts a password request when its session ends.
#[derive(Clone, Default)]
pub(super) struct AbortSignal {
    state: Arc<Mutex<(bool, Vec<Box<dyn FnOnce() + Send>>)>>,
}

impl AbortSignal {
    pub(super) fn aborted(&self) -> bool {
        lock(&self.state).0
    }

    /// Runs `listener` at the abort (never if it has already happened).
    pub(super) fn on_abort(&self, listener: Box<dyn FnOnce() + Send>) {
        let mut state = lock(&self.state);
        if !state.0 {
            state.1.push(listener);
        }
    }

    fn abort(&self) {
        let listeners = {
            let mut state = lock(&self.state);
            if state.0 {
                return;
            }
            state.0 = true;
            std::mem::take(&mut state.1)
        };
        for listener in listeners {
            listener();
        }
    }
}

/// How a password request ended: the installer's key-change outcome, or `busy`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(super) struct CredentialResult {
    pub outcome: String,
    pub state: InstallState,
    #[serde(default)]
    pub detail: Option<String>,
}

/// PC access as a session uses it for the phone's Windows-password request.
pub(super) trait ScreenPcAccess: Send + Sync {
    /// Whether the account signed in on the PC is an administrator; `None` when that could not be told.
    fn account_is_admin(&self) -> BoxFuture<Result<Option<bool>, String>>;
    /// The install-or-enroll authorized by the phone's password; `signal` aborts it when the session ends.
    fn approve_with_credential(
        &self,
        client_id: &str,
        public_key: &str,
        credential: SharedCredential,
        signal: AbortSignal,
    ) -> BoxFuture<Result<CredentialResult, String>>;
}

/// The session's lease on the shared secure-desktop helper, with its install state and requests.
pub(super) trait SessionHelper: HelperView + Send + Sync {
    fn locked(&self) -> Option<bool>;
    fn owned_elsewhere(&self) -> bool;
    fn mint_video_run(&self) -> u64;
    fn on_hold(&self, listener: Listener<()>) -> Unsub;
    fn set_active(&self, active: bool) -> BoxFuture<()>;
    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>>;
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>>;
    fn set_video_run(&self, epoch: u64);
    fn on_frame(&self, listener: Listener<HelperFrame>) -> Unsub;
    fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub;
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub;
    fn on_helper_issue(&self, listener: Listener<String>) -> Unsub;
    fn install_state(&self) -> BoxFuture<InstallState>;
    fn request_install(&self, controller_key: &str) -> BoxFuture<Result<InstallResult, String>>;
    fn ensure_running(&self) -> BoxFuture<Result<HelperStatus, String>>;
}

impl HelperView for SecureDesktopLease<HelperFrame> {
    fn installed(&self) -> bool {
        SecureDesktopLease::installed(self)
    }
    fn connected(&self) -> bool {
        SecureDesktopLease::connected(self)
    }
    fn desktop(&self) -> Option<String> {
        SecureDesktopLease::desktop(self)
    }
    fn session(&self) -> Option<u32> {
        SecureDesktopLease::session(self)
    }
}

impl SessionHelper for SecureDesktopLease<HelperFrame> {
    fn locked(&self) -> Option<bool> {
        SecureDesktopLease::locked(self)
    }
    fn owned_elsewhere(&self) -> bool {
        SecureDesktopLease::owned_elsewhere(self)
    }
    fn mint_video_run(&self) -> u64 {
        SecureDesktopLease::mint_video_run(self)
    }
    fn on_hold(&self, listener: Listener<()>) -> Unsub {
        SecureDesktopLease::on_hold(self, listener)
    }
    fn set_active(&self, active: bool) -> BoxFuture<()> {
        SecureDesktopLease::set_active(self, active)
    }
    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        SecureDesktopLease::send_input(self, command)
    }
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        SecureDesktopLease::send_grant(self, grant)
    }
    fn set_video_run(&self, epoch: u64) {
        SecureDesktopLease::set_video_run(self, epoch);
    }
    fn on_frame(&self, listener: Listener<HelperFrame>) -> Unsub {
        SecureDesktopLease::on_frame(self, listener)
    }
    fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub {
        SecureDesktopLease::on_desktop_changed(self, listener)
    }
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        SecureDesktopLease::on_grant_challenge(self, listener)
    }
    fn on_helper_issue(&self, listener: Listener<String>) -> Unsub {
        SecureDesktopLease::on_helper_issue(self, listener)
    }
    fn install_state(&self) -> BoxFuture<InstallState> {
        SecureDesktopLease::install_state(self, None)
    }
    fn request_install(&self, controller_key: &str) -> BoxFuture<Result<InstallResult, String>> {
        SecureDesktopLease::request_install(self, controller_key).map(Ok).boxed()
    }
    fn ensure_running(&self) -> BoxFuture<Result<HelperStatus, String>> {
        SecureDesktopLease::ensure_running(self).map(Ok).boxed()
    }
}

pub(super) struct SessionDeps {
    pub client_id: String,
    pub client_label: String,
    pub screen_id: String,
    pub displays: Arc<dyn ScreenDisplays>,
    pub authorization: Arc<dyn ViewerAuthorization>,
    /// The input host for the ordinary desktop, started with the session.
    pub create_input_host: Box<dyn Fn() -> Arc<dyn ScreenHost> + Send + Sync>,
    pub secure_desktop: Arc<dyn SessionHelper>,
    /// Absent: the phone's password request is answered `unavailable`.
    pub pc_access: Option<Arc<dyn ScreenPcAccess>>,
    pub indicator: Arc<dyn ScreenIndicator>,
    /// Start, stop and transitions; never input content.
    pub log: Box<dyn Fn(Value) + Send + Sync>,
    pub timers: Arc<dyn Timers>,
    /// Default 30.
    pub max_frame_rate: Option<f64>,
    /// Sample the cursor for the phone (`on_cursor`), once per frame interval.
    pub sample_cursor: bool,
    /// The stop's deadline; default [`COMMAND_TIMEOUT_MS`].
    pub shutdown_deadline_ms: Option<u64>,
}

// ---------------------------------------------------------------------------------------------------------------
// The session

#[derive(Clone, Copy, PartialEq, Eq)]
struct Cursor {
    x: i64,
    y: i64,
    generation: u64,
}

impl Cursor {
    fn value(self) -> Value {
        json!({"x": self.x, "y": self.y, "generation": self.generation})
    }
}

struct CredentialRequest {
    id: u64,
    credential: SharedCredential,
    signal: AbortSignal,
}

struct StopDeadline {
    at: f64,
    timer: Option<TimerHandle>,
    passed: bool,
    waiters: Vec<oneshot::Sender<()>>,
}

struct State {
    started: bool,
    running: bool,
    /// The running or finished stop: whether it ended, and who waits for it, in the order they asked.
    stopping: Option<(bool, Vec<oneshot::Sender<()>>)>,
    stop_reason: Option<String>,
    generation: u64,
    geometry: Option<Value>,
    plan: Option<Value>,
    capture_source_id: Option<String>,
    mapping: Option<PointerMapping>,
    host: Option<Arc<dyn ScreenHost>>,
    local: Option<LocalDesktop>,
    decision: Option<SourceDecision>,
    helper_active: bool,
    /// The helper's video reaches this viewer (`set_helper_video`).
    helper_video: bool,
    video_path: VideoPath,
    facts: ScreenHelperFacts,
    /// An install-state answer counts only when no later check or request started.
    install_turn: u64,
    credential_request: Option<CredentialRequest>,
    credential_requests: u64,
    /// The installed service was stopped and could not be started.
    service_down: bool,
    service_turn: u64,
    status: Value,
    cursor: Option<Cursor>,
    /// Bumped by a new geometry and a switch to the helper: a cursor read taken before it is dropped.
    cursor_sample: u64,
    cursor_reading: bool,
    subscriptions: Vec<Unsub>,
    stop_deadline: Option<StopDeadline>,
}

struct Inner {
    deps: SessionDeps,
    router: ScreenInputRouter,
    state: Mutex<State>,
    max_frame_rate: f64,
    frames: Arc<ListenerSet<HelperPicture>>,
    statuses: Arc<ListenerSet<Value>>,
    geometries: Arc<ListenerSet<Value>>,
    stops: Arc<ListenerSet<String>>,
    paths: Arc<ListenerSet<VideoPath>>,
    cursors: Arc<ListenerSet<Value>>,
    challenges: Arc<ListenerSet<Challenge>>,
    holds: Arc<ListenerSet<()>>,
    me: Weak<Inner>,
}

struct DesktopBackend(Weak<Inner>);

#[async_trait]
impl ScreenBackend for DesktopBackend {
    async fn send(&self, command: ScreenInput) -> Result<(), SendError> {
        let host = self.0.upgrade().and_then(|inner| inner.state().host.clone()).ok_or(SendError)?;
        host.command(HostCommand::Input(command)).await.map(|_| ()).map_err(|_| SendError)
    }

    fn identity(&self) -> Option<DesktopIdentity> {
        let host = self.0.upgrade()?.state().host.clone()?;
        screen_host_identity(&*host)
    }
}

struct SecureBackend(Arc<dyn SessionHelper>);

#[async_trait]
impl ScreenBackend for SecureBackend {
    async fn send(&self, command: ScreenInput) -> Result<(), SendError> {
        self.0.send_input(command).await.map_err(|_| SendError)
    }

    fn identity(&self) -> Option<DesktopIdentity> {
        secure_desktop_identity(&*self.0)
    }
}

fn stop_denied(reason: &str) -> String {
    format!("remote screen denied: {reason}")
}

fn helper_offer(offer: InstallOffer) -> HelperOffer {
    match offer {
        InstallOffer::Install => HelperOffer::Install,
        InstallOffer::Update => HelperOffer::Update,
        InstallOffer::None => HelperOffer::Nothing,
    }
}

/// The outcomes the phone is told: the delegated path's refusals are PC-side only, so they read as `failed`.
fn phone_outcome(outcome: &str) -> String {
    match outcome {
        "delegation-disabled" | "delegation-denied" | "service-unreachable" => "failed".to_string(),
        other => other.to_string(),
    }
}

/// A diagnostic that does not quote what the phone typed (an installer message may echo its input).
fn safe_detail(detail: Option<String>, credential: &SharedCredential) -> Option<String> {
    let detail = detail?;
    let credential = lock(credential);
    let quoted = [Some(credential.password.as_str()), credential.user.as_deref()]
        .into_iter()
        .flatten()
        .any(|secret| !secret.is_empty() && detail.contains(secret));
    Some(if quoted { DETAIL_HIDDEN.to_string() } else { detail })
}

fn status_value(status: &super::switch::ScreenStatus) -> Value {
    serde_json::to_value(status).expect("a screen status serializes")
}

/// Whether two statuses differ in what the phone is shown (Node's field-by-field comparison; the helper block's
/// fields are those of the new status).
fn same_status(next: &Value, current: &Value) -> bool {
    ["state", "reason", "helper", "control"].iter().all(|field| next.get(field) == current.get(field))
        && next["helperInfo"]
            .as_object()
            .is_some_and(|info| info.iter().all(|(field, value)| current["helperInfo"].get(field) == Some(value)))
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn arc(&self) -> Arc<Inner> {
        self.me.upgrade().expect("the session is alive while it is called")
    }

    fn spawn(&self, task: BoxFuture<()>) {
        self.deps.timers.spawn(task);
    }

    /// A reaction to a dependency's answer ([`Timers::react`]).
    fn then(&self, task: BoxFuture<()>) {
        self.deps.timers.react(task);
    }

    fn paired(&self) -> bool {
        self.deps.authorization.paired()
    }

    fn find_display(&self) -> Option<ScreenDisplay> {
        self.deps.displays.list().into_iter().find(|display| display.screen_id == self.deps.screen_id)
    }

    /// Input is accepted only while every gate holds at this instant.
    fn control_now(&self) -> bool {
        let (running, decision, helper_video, facts) = {
            let state = self.state();
            (state.running, state.decision, state.helper_video, state.facts.clone())
        };
        running
            && self.paired()
            && decision.is_some_and(|decision| screen_status_for(&decision, true, helper_video, &facts).control)
    }

    fn lock_geometry(&self, state: &mut State, display: &ScreenDisplay) -> Result<(), String> {
        state.generation += 1;
        state.cursor_sample += 1;
        let (width, height) = screen_video_size(display.physical)?;
        let generation = state.generation;
        state.geometry = Some(json!({
            "generation": generation,
            "cssWidth": number(js_round(display.bounds.width).clamp(MIN_CSS, MAX_CSS)),
            "cssHeight": number(js_round(display.bounds.height).clamp(MIN_CSS, MAX_CSS)),
            "deviceScaleFactor": number(display.scale_factor.clamp(0.5, 4.0)),
            "pixelWidth": width,
            "pixelHeight": height,
        }));
        state.mapping = Some(PointerMapping { generation, pixel_width: width, pixel_height: height, physical: display.physical });
        state.plan = Some(json!({
            "sourceId": display.capture_source_id,
            "width": width,
            "height": height,
            "maxFrameRate": number(self.max_frame_rate),
        }));
        state.capture_source_id = Some(display.capture_source_id.clone());
        Ok(())
    }

    fn switch_inputs(&self) -> SwitchInputs {
        let (local, service_down) = {
            let state = self.state();
            (state.local.clone(), state.service_down)
        };
        let helper = &self.deps.secure_desktop;
        SwitchInputs {
            local,
            helper_installed: helper.installed(),
            helper_connected: helper.connected(),
            helper_desktop: helper.desktop(),
            helper_locked: helper.locked(),
            helper_service_down: service_down,
            helper_owned_elsewhere: helper.owned_elsewhere(),
        }
    }

    fn emit_status(&self, next: Value, force: bool) {
        {
            let mut state = self.state();
            if !force && same_status(&next, &state.status) {
                return;
            }
            state.status = next.clone();
        }
        if next["state"] != "stopped" {
            self.deps.indicator.update(next["control"].as_bool().unwrap_or(false));
        }
        self.statuses.call(&next);
    }

    fn publish_status(&self, force: bool) {
        let (decision, helper_video, facts) = {
            let state = self.state();
            if !state.running {
                return;
            }
            let Some(decision) = state.decision else {
                return;
            };
            (decision, state.helper_video, state.facts.clone())
        };
        let paired = self.paired();
        self.emit_status(status_value(&screen_status_for(&decision, paired, helper_video, &facts)), force);
    }

    /// `force`: pushed even when nothing changed, for an answer the phone waits on.
    fn set_helper_facts(&self, change: impl FnOnce(&mut ScreenHelperFacts), force: bool) {
        change(&mut self.state().facts);
        self.publish_status(force);
    }

    fn set_issue(&self, issue: Option<HelperIssue>) {
        if self.state().facts.issue != issue {
            self.set_helper_facts(|facts| facts.issue = issue, false);
        }
    }

    /// An install-state answer, applied unless a later check or request started.
    fn install_answer(&self, turn: u64, change: impl FnOnce(&mut ScreenHelperFacts), force: bool) {
        let current = {
            let state = self.state();
            state.running && state.install_turn == turn
        };
        if current {
            self.set_helper_facts(change, force);
        }
    }

    fn set_helper_video(&self, delivering: bool) {
        let release = {
            let mut state = self.state();
            let next = delivering && state.running && state.decision.is_some_and(|decision| decision_uses_helper(&decision));
            if next == state.helper_video {
                return;
            }
            state.helper_video = next;
            !next
        };
        self.publish_status(false);
        // Control withdrawn: what the viewer holds is lifted through the backend that pressed it.
        if release && self.state().running {
            self.spawn(self.router.release_all());
        }
    }

    /// Starts a stopped service; the answer re-decides. A rejection means it could not be brought up either.
    fn ensure_service(&self) {
        let turn = {
            let mut state = self.state();
            state.service_turn += 1;
            state.service_turn
        };
        let started = self.deps.secure_desktop.ensure_running();
        let me = self.me.clone();
        self.then(Box::pin(async move {
            let down = match started.await {
                Ok(service) => service.installed && !service.running,
                Err(_) => true,
            };
            let Some(inner) = me.upgrade() else {
                return;
            };
            let refresh = {
                let mut state = inner.state();
                if !state.running || turn != state.service_turn || down == state.service_down {
                    return;
                }
                state.service_down = down;
                // Before the start's first decision, that decision reads it.
                state.decision.is_some()
            };
            if refresh {
                inner.refresh_decision();
            }
        }));
    }

    fn set_helper_active(&self, active: bool) -> BoxFuture<()> {
        {
            let mut state = self.state();
            if state.helper_active == active {
                return Box::pin(async {});
            }
            state.helper_active = active;
        }
        // A deactivated helper's reports are not the phone's concern.
        if !active {
            self.set_issue(None);
        }
        // The helper is needed now; after a reboot its service may be stopped.
        if active && !self.deps.secure_desktop.connected() {
            self.ensure_service();
        }
        self.deps.secure_desktop.set_active(active)
    }

    /// Re-reads the desktop state: the gate and the status change at once, the backend change runs as one turn
    /// of the input queue.
    fn refresh_decision(&self) {
        if !self.state().running {
            return;
        }
        let next = decide_screen_source(&self.switch_inputs());
        let was = {
            let mut state = self.state();
            let was = state.decision.map(|decision| decision.status);
            state.decision = Some(next);
            if decision_uses_helper(&next) {
                // The helper's capture: a desktop cursor (cached, or a read in flight) no longer matches.
                state.cursor = None;
                state.cursor_sample += 1;
            } else {
                // Helper video only exists while the helper serves.
                state.helper_video = false;
            }
            was
        };
        if next.status != super::switch::StatusState::Live && Some(next.status) != was {
            (self.deps.log)(json!({
                "type": "secure-desktop",
                "clientId": self.deps.client_id,
                "screenId": self.deps.screen_id,
                "state": next.status,
            }));
        }
        self.publish_status(false);
        let path = if decision_uses_helper(&next) { VideoPath::Helper } else { VideoPath::Capture };
        let changed = {
            let mut state = self.state();
            let changed = path != state.video_path;
            state.video_path = path;
            changed
        };
        if changed {
            self.paths.call(&path);
        }
        let backend = if decision_uses_helper(&next) {
            Some(BackendId::Secure)
        } else if next.mode == SourceMode::Blocked {
            None
        } else {
            Some(BackendId::Desktop)
        };
        let before = self.me.clone();
        let after = self.me.clone();
        let hooks = SwitchHooks {
            before: Some(Box::new(move || {
                let activate = before.upgrade().filter(|inner| inner.state().running && next.helper_active);
                let activated = activate.map(|inner| inner.set_helper_active(true));
                Box::pin(async move {
                    if let Some(activated) = activated {
                        activated.await;
                    }
                    Ok(())
                })
            })),
            after: Some(Box::new(move || {
                let deactivate = after.upgrade().filter(|inner| inner.state().running && !next.helper_active);
                let deactivated = deactivate.map(|inner| inner.set_helper_active(false));
                Box::pin(async move {
                    if let Some(deactivated) = deactivated {
                        deactivated.await;
                    }
                    Ok(())
                })
            })),
        };
        self.spawn(self.router.switch_to(backend, hooks));
    }

    /// The connection is no longer paired and connected: the session stops, for the reason access ended.
    fn reauthorize(&self) {
        if self.state().running && !self.paired() {
            drop(self.stop(self.deps.authorization.lost(), None));
        }
    }

    fn renew_geometry(&self) {
        if !self.state().running {
            return;
        }
        let Some(display) = self.find_display() else {
            drop(self.stop("display-removed".to_string(), None));
            return;
        };
        let renewal = {
            let mut state = self.state();
            let unchanged = state.mapping.as_ref().is_some_and(|mapping| !geometry_changed(mapping, &display))
                && state.plan.is_some()
                && state.capture_source_id.as_deref() == Some(display.capture_source_id.as_str());
            if unchanged {
                return;
            }
            // A display too small to stream keeps the old geometry, as Node's throwing `lock` does.
            if self.lock_geometry(&mut state, &display).is_err() {
                return;
            }
            json!({"plan": state.plan, "geometry": state.geometry})
        };
        self.geometries.call(&renewal);
    }

    fn on_helper_frame(&self, frame: &HelperFrame) {
        let mapping = {
            let state = self.state();
            if !state.running || !state.decision.is_some_and(|decision| decision_uses_helper(&decision)) {
                return;
            }
            state.mapping
        };
        // Frames are gated by the live pairing, not only the admitted one.
        if !self.paired() {
            return;
        }
        let Some(mapping) = mapping else {
            return;
        };
        if let Ok(Some(picture)) = screen_frame_region(frame, &mapping) {
            self.frames.call(&picture);
        }
    }

    fn subscribe(&self, unsub: Unsub) {
        self.state().subscriptions.push(unsub);
    }

    fn ensure_host(&self) -> (Arc<dyn ScreenHost>, BoxFuture<Result<(), String>>) {
        let existing = self.state().host.clone();
        let host = match existing {
            Some(host) => host,
            None => {
                let created = (self.deps.create_input_host)();
                self.state().host = Some(created.clone());
                let me = self.me.clone();
                self.subscribe(created.on_desktop(Arc::new(move |desktop: &LocalDesktop| {
                    if let Some(inner) = me.upgrade() {
                        inner.state().local = Some(desktop.clone());
                        inner.refresh_decision();
                    }
                })));
                let me = self.me.clone();
                self.subscribe(created.on_exit(Arc::new(move |_: &()| {
                    if let Some(inner) = me.upgrade()
                        && inner.state().running
                    {
                        drop(inner.stop("error".to_string(), None));
                    }
                })));
                created
            }
        };
        let started = host.start();
        (host, started)
    }

    fn start(&self) -> BoxFuture<Result<Value, String>> {
        if self.state().started {
            return Box::pin(async { Err(stop_denied("already-started")) });
        }
        if !self.paired() {
            (self.deps.log)(json!({
                "type": "denied",
                "clientId": self.deps.client_id,
                "screenId": self.deps.screen_id,
                "reason": "unauthorized",
            }));
            return Box::pin(async { Err(stop_denied("unauthorized")) });
        }
        let Some(display) = self.find_display() else {
            return Box::pin(async { Err(stop_denied("display-removed")) });
        };
        {
            let mut state = self.state();
            state.started = true;
            state.running = true;
            if let Err(error) = self.lock_geometry(&mut state, &display) {
                return Box::pin(async move { Err(error) });
            }
        }
        self.subscribe_all();
        let turn = {
            let mut state = self.state();
            state.install_turn += 1;
            state.install_turn
        };
        let checked = self.deps.secure_desktop.install_state();
        let me = self.me.clone();
        self.then(Box::pin(async move {
            let install = checked.await;
            let Some(inner) = me.upgrade() else {
                return;
            };
            inner.install_answer(turn, |facts| facts.offer = helper_offer(install_offer_for(install)), false);
            // A current install whose service is stopped (after a reboot).
            if inner.state().running && install == InstallState::Installed && !inner.deps.secure_desktop.connected() {
                inner.ensure_service();
            }
        }));
        // Whether the PC's account is an administrator (the password sheet asks for an account name if not).
        if let Some(pc_access) = &self.deps.pc_access {
            let asked = pc_access.account_is_admin();
            let me = self.me.clone();
            self.then(Box::pin(async move {
                if let Ok(Some(admin)) = asked.await
                    && let Some(inner) = me.upgrade()
                    && inner.state().running
                {
                    inner.set_helper_facts(|facts| facts.account_is_admin = Some(admin), false);
                }
            }));
        }
        // The input host is the injector and also the local UAC / lock detector: no session without it.
        let (host, started) = self.ensure_host();
        let inner = self.arc();
        Box::pin(async move {
            let started = started.await;
            // `ensureHost` is an async function: its end reaches the start one microtask later, behind an answer
            // that came in with it (the service start of the install-state check).
            next_turn().await;
            if let Err(error) = started {
                if inner.state().running {
                    inner.stop("error".to_string(), None).await;
                }
                return Err(error);
            }
            inner.state().local = host.desktop();
            // The host start awaited: the phone may have left, or the session stopped, meanwhile.
            inner.reauthorize();
            inner.started_or_denied()?;
            let decision = decide_screen_source(&inner.switch_inputs());
            let status = {
                let mut state = inner.state();
                state.decision = Some(decision);
                state.status = status_value(&screen_status_for(&decision, true, state.helper_video, &state.facts));
                state.status.clone()
            };
            let me = inner.me.clone();
            inner.deps.indicator.show(IndicatorView {
                client_label: inner.deps.client_label.clone(),
                controlling: status["control"].as_bool().unwrap_or(false),
                screen_id: inner.deps.screen_id.clone(),
                on_stop: Arc::new(move || {
                    if let Some(inner) = me.upgrade() {
                        drop(inner.stop("user".to_string(), None));
                    }
                }),
            });
            if inner.deps.sample_cursor {
                inner.start_cursor_sampling();
            }
            (inner.deps.log)(json!({"type": "start", "clientId": inner.deps.client_id, "screenId": inner.deps.screen_id}));
            inner.refresh_decision();
            inner.router.settled().await;
            inner.started_or_denied()?;
            let state = inner.state();
            Ok(json!({"plan": state.plan, "geometry": state.geometry, "status": state.status}))
        })
    }

    fn started_or_denied(&self) -> Result<(), String> {
        let state = self.state();
        if state.running { Ok(()) } else { Err(stop_denied(state.stop_reason.as_deref().unwrap_or("stopped"))) }
    }

    fn subscribe_all(&self) {
        let me = self.me.clone();
        self.subscribe(self.deps.authorization.on_change(Arc::new(move |_: &()| {
            if let Some(inner) = me.upgrade() {
                inner.reauthorize();
            }
        })));
        let me = self.me.clone();
        self.subscribe(self.deps.displays.on_change(Arc::new(move |_: &()| {
            if let Some(inner) = me.upgrade() {
                inner.renew_geometry();
            }
        })));
        let helper = &self.deps.secure_desktop;
        let me = self.me.clone();
        self.subscribe(helper.on_frame(Arc::new(move |frame: &HelperFrame| {
            if let Some(inner) = me.upgrade() {
                inner.on_helper_frame(frame);
            }
        })));
        let me = self.me.clone();
        self.subscribe(helper.on_desktop_changed(Arc::new(move |_: &()| {
            if let Some(inner) = me.upgrade() {
                let connected = inner.deps.secure_desktop.connected();
                {
                    let mut state = inner.state();
                    state.facts.issue = helper_issue_after_change(state.facts.issue, connected);
                }
                inner.refresh_decision();
            }
        })));
        let me = self.me.clone();
        self.subscribe(helper.on_helper_issue(Arc::new(move |code: &String| {
            if let Some(issue) = screen_helper_issue(code)
                && let Some(inner) = me.upgrade()
            {
                let applies = {
                    let state = inner.state();
                    state.running && state.helper_active
                };
                if applies {
                    inner.set_issue(Some(issue));
                }
            }
        })));
        let me = self.me.clone();
        self.subscribe(helper.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
            if let Some(inner) = me.upgrade()
                && inner.state().running
                && inner.paired()
            {
                inner.challenges.call(challenge);
            }
        })));
        let me = self.me.clone();
        self.subscribe(helper.on_hold(Arc::new(move |_: &()| {
            if let Some(inner) = me.upgrade()
                && inner.state().running
            {
                inner.holds.call(&());
            }
        })));
    }

    fn handle_input(&self, input: &Value, generation: u64) -> BoxFuture<RouteOutcome> {
        // Release always runs, even after a revoke or stop, so nothing stays stuck.
        if input["type"] == "screen-release" {
            let released = self.router.release_all();
            return Box::pin(async move {
                released.await;
                RouteOutcome::Applied
            });
        }
        if !self.control_now() {
            return Box::pin(async { RouteOutcome::Rejected });
        }
        let mapping = self.state().mapping;
        let Some(commands) = screen_input_commands(input, mapping.as_ref(), generation) else {
            return Box::pin(async { RouteOutcome::Rejected });
        };
        let pointed = input["type"] == "screen-wheel" || (input["type"] == "screen-pointer" && input["action"] != "up");
        // Re-checked when the input's turn comes and between its commands.
        let me = self.me.clone();
        let allowed = Arc::new(move || {
            me.upgrade().is_some_and(|inner| {
                inner.control_now() && (!pointed || inner.state().mapping.is_some_and(|mapping| mapping.generation == generation))
            })
        });
        if input["type"] == "screen-keys" { self.router.dispatch_keys(commands, allowed) } else { self.router.dispatch(commands, allowed) }
    }

    /// Cursor sampling: the host's read-back of the cursor, mapped to video pixels, published when it changed,
    /// once per capture frame interval (the cursor is baked into the video, which shows at most `max_frame_rate`
    /// pictures a second). One read at a time; none while the helper serves the secure desktop. A read that
    /// completes after a switch to the helper or a new geometry is dropped.
    fn start_cursor_sampling(&self) {
        let every = Duration::from_millis((1000.0 / self.max_frame_rate).ceil() as u64);
        let armed: Arc<Mutex<(bool, Option<TimerHandle>)>> = Arc::new(Mutex::new((false, None)));
        fn arm(me: Weak<Inner>, armed: Arc<Mutex<(bool, Option<TimerHandle>)>>, every: Duration) {
            let Some(inner) = me.upgrade() else {
                return;
            };
            let again = (me.clone(), armed.clone());
            let handle = inner.deps.timers.set_timeout(
                every,
                Box::new(move || {
                    let (me, armed) = again;
                    if let Some(inner) = me.upgrade() {
                        inner.sample_cursor();
                    }
                    // An interval runs again `every` after each run, unless it was cleared meanwhile.
                    if !lock(&armed).0 {
                        arm(me, armed, every);
                    }
                }),
            );
            let mut slot = lock(&armed);
            if slot.0 { handle.clear() } else { slot.1 = Some(handle) }
        }
        arm(self.me.clone(), armed.clone(), every);
        self.subscribe(Box::new(move || {
            let mut slot = lock(&armed);
            slot.0 = true;
            if let Some(handle) = slot.1.take() {
                handle.clear();
            }
        }));
    }

    fn sample_cursor(&self) {
        let (host, sample) = {
            let mut state = self.state();
            let serving = state.decision.is_none_or(|decision| decision_uses_helper(&decision));
            if state.cursor_reading || !state.running || state.mapping.is_none() || serving {
                return;
            }
            let Some(host) = state.host.clone() else {
                return;
            };
            state.cursor_reading = true;
            (host, state.cursor_sample)
        };
        let read = host.command(HostCommand::Cursor);
        let me = self.me.clone();
        self.then(Box::pin(async move {
            let fields = read.await;
            let Some(inner) = me.upgrade() else {
                return;
            };
            let changed = {
                let mut state = inner.state();
                state.cursor_reading = false;
                let serving = state.decision.is_none_or(|decision| decision_uses_helper(&decision));
                match (fields, state.mapping) {
                    (Ok(fields), Some(mapping)) if state.running && sample == state.cursor_sample && !serving => {
                        let at = (fields.len() == 2)
                            .then(|| screen_point_to_video(&mapping, js_number(&fields[0]), js_number(&fields[1])))
                            .flatten();
                        at.map(|(x, y)| Cursor { x, y, generation: mapping.generation })
                            .filter(|next| state.cursor != Some(*next))
                            .inspect(|next| state.cursor = Some(*next))
                    }
                    _ => None,
                }
            };
            if let Some(cursor) = changed {
                inner.cursors.call(&cursor.value());
            }
        }));
    }

    fn arm_stop_deadline(&self) {
        let now = self.deps.timers.now_ms();
        let mut state = self.state();
        let Some(deadline) = state.stop_deadline.as_mut() else {
            return;
        };
        if deadline.passed {
            return;
        }
        if let Some(timer) = deadline.timer.take() {
            timer.clear();
        }
        let after = Duration::from_nanos(((deadline.at - now).max(0.0) * 1e6).round() as u64);
        let me = self.me.clone();
        deadline.timer = Some(self.deps.timers.set_timeout(
            after,
            Box::new(move || {
                if let Some(inner) = me.upgrade() {
                    inner.stop_deadline_reached();
                }
            }),
        ));
    }

    fn stop_deadline_reached(&self) {
        let (host, waiters) = {
            let mut state = self.state();
            let host = state.host.clone();
            let Some(deadline) = state.stop_deadline.as_mut() else {
                return;
            };
            deadline.passed = true;
            (host, std::mem::take(&mut deadline.waiters))
        };
        // Release step still running (the host is still the session's): a hung host is killed, every pending
        // send abandoned.
        if let Some(host) = host {
            host.kill();
            self.router.abandon();
        }
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }

    /// Resolves when the stop deadline passes (at once if it has).
    fn stop_deadline_passed(&self) -> BoxFuture<()> {
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.state();
            match state.stop_deadline.as_mut() {
                Some(deadline) if !deadline.passed => deadline.waiters.push(sender),
                _ => {
                    return Box::pin(async {
                        next_turn().await;
                    });
                }
            }
        }
        Box::pin(async move {
            let _ = receiver.await;
            // Node's `stopDeadlinePassed().then(…)`: the reaction runs one turn after the deadline, so a host stop
            // that ended by then still counts as ended in time.
            next_turn().await;
        })
    }

    /// The stop's end, for one more waiter: the waiters are told in the order they asked, as a promise's
    /// reactions run. `None` when no stop began.
    fn stop_waiter(&self) -> Option<BoxFuture<()>> {
        let mut state = self.state();
        let (ended, waiters) = state.stopping.as_mut()?;
        if *ended {
            return Some(Box::pin(async {}));
        }
        let (sender, receiver) = oneshot::channel();
        waiters.push(sender);
        Some(Box::pin(async move {
            let _ = receiver.await;
        }))
    }

    fn stop(&self, reason: String, deadline_ms: Option<u64>) -> BoxFuture<()> {
        let now = self.deps.timers.now_ms();
        {
            let mut state = self.state();
            if state.stopping.is_some() {
                // Already stopping: a shorter deadline still applies, from now.
                let mut rearm = false;
                if let (Some(ms), Some(deadline)) = (deadline_ms, state.stop_deadline.as_mut())
                    && !deadline.passed
                {
                    let at = now + ms as f64;
                    if at < deadline.at {
                        deadline.at = at;
                        rearm = true;
                    }
                }
                drop(state);
                if rearm {
                    self.arm_stop_deadline();
                }
                return self.stop_waiter().expect("a stop began");
            }
            if !state.running {
                return Box::pin(async {});
            }
            let ms = deadline_ms.unwrap_or(self.deps.shutdown_deadline_ms.unwrap_or(COMMAND_TIMEOUT_MS));
            state.stop_deadline = Some(StopDeadline { at: now + ms as f64, timer: None, passed: false, waiters: Vec::new() });
            // Nothing new is admitted, queued input is cancelled, and capture ends now.
            state.running = false;
            state.stop_reason = Some(reason.clone());
            state.stopping = Some((false, Vec::new()));
        }
        // A password outstanding for this session ends with it: still queued, it is cancelled before the
        // installer is reached; already dispatched, its result is dropped. Either way no copy stays here.
        let request = self.state().credential_request.as_ref().map(|request| (request.signal.clone(), request.credential.clone()));
        if let Some((signal, credential)) = request {
            signal.abort();
            wipe_credential(&credential);
        }
        self.router.cancel();
        let subscriptions = std::mem::take(&mut self.state().subscriptions);
        for off in subscriptions {
            off();
        }
        let status = self.state().status.clone();
        self.emit_status(
            json!({"state": "stopped", "reason": reason, "helper": status["helper"], "control": false, "helperInfo": status["helperInfo"]}),
            false,
        );
        self.stops.call(&reason);
        self.deps.indicator.hide();
        (self.deps.log)(json!({"type": "stop", "clientId": self.deps.client_id, "screenId": self.deps.screen_id, "reason": reason}));
        // The watchdog runs from this moment, whatever the queue is waiting on.
        self.arm_stop_deadline();
        // The release is queued behind any in-flight command, so it undoes it.
        let released = self.router.release_all();
        let inner = self.arc();
        let waiter = self.stop_waiter().expect("a stop began");
        self.spawn(Box::pin(async move {
            released.await;
            inner.router.abandon();
            inner.close_backends().await;
            let waiters = {
                let mut state = inner.state();
                if let Some(timer) = state.stop_deadline.as_mut().and_then(|deadline| deadline.timer.take()) {
                    timer.clear();
                }
                let stopping = state.stopping.as_mut().expect("a stop began");
                stopping.0 = true;
                std::mem::take(&mut stopping.1)
            };
            for waiter in waiters {
                let _ = waiter.send(());
            }
        }));
        waiter
    }

    /// Closes the backends by the stop deadline: the host's graceful stop gets the time left and is killed when
    /// the deadline passes first.
    async fn close_backends(&self) {
        self.state().helper_active = false;
        // Not awaited: the helper client is not ours to bound.
        self.spawn(self.deps.secure_desktop.set_active(false));
        let Some(current) = self.state().host.take() else {
            return;
        };
        let stopped = current.stop().map(|()| false);
        let passed = self.stop_deadline_passed().map(|()| true);
        let timed_out = futures::future::select(stopped, passed).await.factor_first().0;
        if timed_out {
            current.kill();
        }
    }

    fn helper_grant(&self, grant: Grant) {
        if !self.state().running || !self.paired() {
            return;
        }
        let sent = self.deps.secure_desktop.send_grant(grant);
        let me = self.me.clone();
        self.then(Box::pin(async move {
            // The remedy for a lapsed grant was relayed; a refusal is reported anew.
            if sent.await.is_ok()
                && let Some(inner) = me.upgrade()
            {
                let lapsed = {
                    let state = inner.state();
                    state.running && state.facts.issue == Some(HelperIssue::GrantExpired)
                };
                if lapsed {
                    inner.set_issue(None);
                }
            }
        }));
    }

    fn next_install_turn(&self) -> u64 {
        let mut state = self.state();
        state.install_turn += 1;
        state.install_turn
    }

    fn answer(&self, turn: u64, outcome: String, detail: Option<String>, offer: Option<HelperOffer>, force: bool) {
        self.install_answer(
            turn,
            |facts| {
                facts.outcome = Some(outcome);
                facts.detail = detail.map(|detail| utf16_prefix(&detail, MAX_HELPER_DETAIL));
                if let Some(offer) = offer {
                    facts.offer = offer;
                }
            },
            force,
        );
    }

    fn request_helper_install(&self, controller_key: &str) {
        if !self.state().running || !self.paired() {
            return;
        }
        let turn = self.next_install_turn();
        let requested = self.deps.secure_desktop.request_install(controller_key);
        let me = self.me.clone();
        self.then(Box::pin(async move {
            let result = requested.await;
            let Some(inner) = me.upgrade() else {
                return;
            };
            match result {
                Ok(result) => {
                    let outcome = serde_json::to_value(result.outcome).expect("an outcome serializes");
                    let outcome = outcome.as_str().unwrap_or_default().to_string();
                    inner.answer(turn, outcome, result.detail, Some(helper_offer(install_offer_for(result.state))), false);
                }
                Err(error) => inner.answer(turn, "failed".to_string(), Some(error), None, false),
            }
        }));
    }

    fn request_helper_credential(&self, controller_key: &str, credential: SharedCredential) {
        let busy = {
            let state = self.state();
            !state.running || state.credential_request.is_some()
        };
        if busy || !self.paired() {
            wipe_credential(&credential);
            return;
        }
        let turn = self.next_install_turn();
        let Some(pc_access) = self.deps.pc_access.clone() else {
            wipe_credential(&credential);
            // Forced: the phone waits for each answer.
            self.answer(turn, "unavailable".to_string(), None, None, true);
            return;
        };
        let signal = AbortSignal::default();
        let id = {
            let mut state = self.state();
            state.credential_requests += 1;
            let id = state.credential_requests;
            state.credential_request = Some(CredentialRequest { id, credential: credential.clone(), signal: signal.clone() });
            id
        };
        // The error text never reaches the phone or a log: only a fixed line.
        let approved = pc_access.approve_with_credential(&self.deps.client_id, controller_key, credential.clone(), signal.clone());
        let me = self.me.clone();
        self.then(Box::pin(async move {
            let result = approved.await;
            let Some(inner) = me.upgrade() else {
                wipe_credential(&credential);
                return;
            };
            // A session that ended meanwhile has no one to tell.
            if !signal.aborted() {
                match result {
                    Ok(result) => {
                        let detail = safe_detail(result.detail, &credential);
                        let offer = helper_offer(install_offer_for(result.state));
                        inner.answer(turn, phone_outcome(&result.outcome), detail, Some(offer), true);
                    }
                    Err(_) => inner.answer(turn, "failed".to_string(), Some(CREDENTIAL_FAILED.to_string()), None, true),
                }
            }
            {
                let mut state = inner.state();
                if state.credential_request.as_ref().is_some_and(|request| request.id == id) {
                    state.credential_request = None;
                }
            }
            wipe_credential(&credential);
        }));
    }
}

/// The screen session of one viewer: see the module docs.
pub(super) struct ScreenSession {
    inner: Arc<Inner>,
}

impl ScreenSession {
    pub(super) fn new(deps: SessionDeps) -> Self {
        let max_frame_rate = deps.max_frame_rate.unwrap_or(30.0);
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| {
            let log_ids = (deps.client_id.clone(), deps.screen_id.clone());
            let dropped_log = me.clone();
            let router = ScreenInputRouter::new(
                Arc::new(DesktopBackend(me.clone())),
                Arc::new(SecureBackend(deps.secure_desktop.clone())),
                move |backend, count| {
                    if let Some(inner) = dropped_log.upgrade() {
                        let backend = match backend {
                            BackendId::Desktop => "desktop",
                            BackendId::Secure => "secure",
                        };
                        (inner.deps.log)(json!({
                            "type": "release-dropped",
                            "clientId": log_ids.0,
                            "screenId": log_ids.1,
                            "backend": backend,
                            "count": count,
                        }));
                    }
                },
            );
            Inner {
                deps,
                router,
                max_frame_rate,
                state: Mutex::new(State {
                    started: false,
                    running: false,
                    stopping: None,
                    stop_reason: None,
                    generation: 0,
                    geometry: None,
                    plan: None,
                    capture_source_id: None,
                    mapping: None,
                    host: None,
                    local: None,
                    decision: None,
                    helper_active: false,
                    helper_video: false,
                    video_path: VideoPath::Capture,
                    facts: ScreenHelperFacts { offer: HelperOffer::Nothing, outcome: None, detail: None, issue: None, account_is_admin: None },
                    install_turn: 0,
                    credential_request: None,
                    credential_requests: 0,
                    service_down: false,
                    service_turn: 0,
                    status: json!({
                        "state": "live",
                        "helper": "not-needed",
                        "control": false,
                        "helperInfo": {"offer": "none", "outcome": null, "detail": null, "issue": null, "secure": null},
                    }),
                    cursor: None,
                    cursor_sample: 0,
                    cursor_reading: false,
                    subscriptions: Vec::new(),
                    stop_deadline: None,
                }),
                frames: ListenerSet::new(),
                statuses: ListenerSet::new(),
                geometries: ListenerSet::new(),
                stops: ListenerSet::new(),
                paths: ListenerSet::new(),
                cursors: ListenerSet::new(),
                challenges: ListenerSet::new(),
                holds: ListenerSet::new(),
                me: me.clone(),
            }
        });
        Self { inner }
    }

    /// The displays a phone may choose, before `start`.
    pub(super) fn list_displays(&self) -> Vec<Value> {
        self.inner.deps.displays.list().iter().map(summarize_display).collect()
    }

    /// Admits the viewer and locks the geometry: `{plan, geometry, status}`. Refused when the viewer is not
    /// paired, the display is gone, the host cannot start, or the session stopped meanwhile. Single use.
    pub(super) fn start(&self) -> BoxFuture<Result<Value, String>> {
        self.inner.start()
    }

    pub(super) fn running(&self) -> bool {
        self.inner.state().running
    }

    pub(super) fn geometry(&self) -> Option<Value> {
        self.inner.state().geometry.clone()
    }

    /// The capture plan the sender opens its track from; `None` unless running.
    pub(super) fn capture_plan(&self) -> Option<Value> {
        let state = self.inner.state();
        if state.running { state.plan.clone() } else { None }
    }

    pub(super) fn status(&self) -> Value {
        self.inner.state().status.clone()
    }

    pub(super) fn video_path(&self) -> VideoPath {
        self.inner.state().video_path
    }

    /// The last sampled cursor for the current geometry; `None` before one, while the helper serves, or when
    /// not running.
    pub(super) fn cursor(&self) -> Option<Value> {
        let state = self.inner.state();
        let serving = state.decision.is_none_or(|decision| decision_uses_helper(&decision));
        state
            .cursor
            .filter(|cursor| state.running && !serving && state.mapping.is_some_and(|mapping| mapping.generation == cursor.generation))
            .map(Cursor::value)
    }

    pub(super) fn on_frame(&self, listener: Listener<HelperPicture>) -> Unsub {
        self.inner.frames.add(listener)
    }

    pub(super) fn on_status(&self, listener: Listener<Value>) -> Unsub {
        self.inner.statuses.add(listener)
    }

    pub(super) fn on_video_path(&self, listener: Listener<VideoPath>) -> Unsub {
        self.inner.paths.add(listener)
    }

    pub(super) fn on_cursor(&self, listener: Listener<Value>) -> Unsub {
        self.inner.cursors.add(listener)
    }

    /// A new locked geometry `{plan, geometry}`: the sender renews capture.
    pub(super) fn on_geometry(&self, listener: Listener<Value>) -> Unsub {
        self.inner.geometries.add(listener)
    }

    pub(super) fn on_stop(&self, listener: Listener<String>) -> Unsub {
        self.inner.stops.add(listener)
    }

    pub(super) fn on_helper_hold(&self, listener: Listener<()>) -> Unsub {
        self.inner.holds.add(listener)
    }

    pub(super) fn on_helper_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.inner.challenges.add(listener)
    }

    /// One validated viewer input (the channel's `screen-*` message); the outcome feeds the input-ack.
    pub(super) fn handle_input(&self, input: &Value, generation: u64) -> BoxFuture<RouteOutcome> {
        self.inner.handle_input(input, generation)
    }

    /// Lifts every key and button this viewer holds. Valid before, during and after stop.
    pub(super) fn release_input(&self) -> BoxFuture<()> {
        self.inner.router.release_all()
    }

    /// Whether the helper's frames reach this viewer's video now: control on the helper path waits for it.
    pub(super) fn set_helper_video(&self, delivering: bool) {
        self.inner.set_helper_video(delivering);
    }

    /// Declares the video run the viewer is shown to the helper.
    pub(super) fn set_video_run(&self, epoch: u64) {
        if self.inner.state().running {
            self.inner.deps.secure_desktop.set_video_run(epoch);
        }
    }

    pub(super) fn next_video_run(&self) -> u64 {
        self.inner.deps.secure_desktop.mint_video_run()
    }

    pub(super) fn helper_grant(&self, grant: Grant) {
        self.inner.helper_grant(grant);
    }

    pub(super) fn request_helper_install(&self, controller_key: &str) {
        self.inner.request_helper_install(controller_key);
    }

    /// The phone's install-or-enroll with its Windows password, through PC access; `credential` is emptied
    /// once the request ended (or at once when it is not taken).
    pub(super) fn request_helper_credential(&self, controller_key: &str, credential: SharedCredential) {
        self.inner.request_helper_credential(controller_key, credential);
    }

    /// Ends the session. Idempotent: a later call returns the first one's future, and a shorter `deadline_ms`
    /// moves the running stop's deadline earlier (never later).
    pub(super) fn stop(&self, reason: &str, deadline_ms: Option<u64>) -> BoxFuture<()> {
        self.inner.stop(reason.to_string(), deadline_ms)
    }

    /// Completes once shutdown is done: releases delivered or dropped, and the backends closed.
    pub(super) fn released(&self) -> BoxFuture<()> {
        self.inner.stop_waiter().unwrap_or_else(|| Box::pin(async {}))
    }
}
