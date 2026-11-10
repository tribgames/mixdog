//! The helper client as the lease uses it (Node: `secure-desktop-adapter.ts`, `createSecureDesktopAdapter`).
//!
//! - Not installed: it reports nothing and does nothing, so a secure desktop stays blocked.
//! - Connected on demand: the first activation dials the helper (never awaited, so the input queue that calls it
//!   cannot wait on it). Once connected, the declared video run and a wanted activation are sent. While activation
//!   is wanted, a lost or failed connection is dialled again after a backoff of [`RECONNECT_FIRST_MS`] doubling to
//!   [`RECONNECT_MAX_MS`].
//! - Input becomes the protocol's event in the same desktop pixels; a button without a position goes to the last
//!   position sent (the helper releases in place anyway).
//! - Ctrl+Alt+Delete: the Delete press while this adapter has Ctrl and Alt down through the helper becomes the
//!   helper's `sas` (a Delete injected with `SendInput` never reaches Winlogon as the secure attention sequence).
//!   The record of held keys is cleared wherever the helper releases everything it holds: deactivation, a new
//!   video run, a desktop change, `grant_expired`, `desktop_unavailable`, a `sas`, and a disconnect.
//! - `dispose`: the redial is cancelled, the client's listeners detached and its connection closed, also one
//!   still in its handshake; a connect that succeeds anyway is closed when it does.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::time::Duration;

use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_secure_desktop::protocol::FrameHeader;
use mixdog_secure_desktop::protocol::InputEvent;
use mixdog_secure_desktop::protocol::PointerButton as WireButton;

use super::installer::TimerHandle;
use super::installer::Timers;
use super::lease::Challenge;
use super::lease::Grant;
use super::lease::HelperAdapter;
use super::lease::HelperError;
use super::lease::HelperFrame;
use super::lease::Listener;
use super::lease::ListenerSet;
use super::lease::Unsub;
use super::router::BoxFuture;

/// Redial backoff while activation is wanted: the first retry after a second, doubling to a 30 s ceiling, so a
/// stopped service is not dialled hot yet a started one is found within half a minute.
pub(super) const RECONNECT_FIRST_MS: u64 = 1_000;
pub(super) const RECONNECT_MAX_MS: u64 = 30_000;

const VK_CONTROL: [u32; 3] = [0x11, 0xa2, 0xa3];
const VK_MENU: [u32; 3] = [0x12, 0xa4, 0xa5];
const VK_DELETE: u32 = 0x2e;

/// Helper `error` codes sent after it released everything it held.
const HELPER_RELEASED_CODES: [&str; 2] = ["grant_expired", "desktop_unavailable"];

const NOT_INSTALLED: &str = "secure desktop helper is not installed";

/// The authenticated helper connection as the client reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HelperSession {
    pub session: u32,
    /// The input desktop's object name.
    pub desktop: String,
    pub locked: Option<bool>,
}

/// The part of the helper client the adapter uses (Node's `SecureDesktopClient`).
pub(super) trait HelperService: Send + Sync {
    /// False when the helper is not installed.
    fn available(&self) -> bool;
    /// The authenticated session; `None` when not connected.
    fn session(&self) -> Option<HelperSession>;
    /// Connects and completes the mutual challenge-response.
    fn connect(&self) -> BoxFuture<Result<(), String>>;
    /// The input desktop changed: the new desktop, session and lock state.
    fn on_desktop_changed(&self, listener: Listener<HelperSession>) -> Unsub;
    fn on_close(&self, listener: Listener<()>) -> Unsub;
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub;
    /// The helper's `error` reports: code and message.
    fn on_error(&self, listener: Listener<(String, String)>) -> Unsub;
    fn on_frame(&self, listener: Listener<(FrameHeader, Arc<Vec<u8>>)>) -> Unsub;
    fn set_active(&self, active: bool);
    /// Settles in bounded time.
    fn send_input(&self, event: InputEvent) -> BoxFuture<Result<(), String>>;
    fn close(&self);
    fn set_video_run(&self, epoch: u64);
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), String>>;
    /// Ctrl+Alt+Del, pressed by the service.
    fn sas(&self) -> BoxFuture<Result<(), String>>;
}

fn helper_error(result: BoxFuture<Result<(), String>>) -> BoxFuture<Result<(), HelperError>> {
    Box::pin(async move { result.await.map_err(HelperError) })
}

/// The adapter of a PC without the helper: reports not installed and does nothing.
struct NotInstalled;

impl HelperAdapter<HelperFrame> for NotInstalled {
    fn installed(&self) -> bool {
        false
    }
    fn connected(&self) -> bool {
        false
    }
    fn desktop(&self) -> Option<String> {
        None
    }
    fn session(&self) -> Option<u32> {
        None
    }
    fn locked(&self) -> Option<bool> {
        None
    }
    fn set_active(&self, _active: bool) -> BoxFuture<()> {
        Box::pin(async {})
    }
    fn send_input(&self, _command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        Box::pin(async { Ok(()) })
    }
    fn send_grant(&self, _grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        Box::pin(async { Err(HelperError(NOT_INSTALLED.to_string())) })
    }
    fn set_video_run(&self, _epoch: u64) {}
    fn latest_frame(&self) -> Option<HelperFrame> {
        None
    }
    fn on_frame(&self, _listener: Listener<HelperFrame>) -> Unsub {
        Box::new(|| {})
    }
    fn on_desktop_changed(&self, _listener: Listener<()>) -> Unsub {
        Box::new(|| {})
    }
    fn on_grant_challenge(&self, _listener: Listener<Challenge>) -> Unsub {
        Box::new(|| {})
    }
    fn on_helper_issue(&self, _listener: Listener<String>) -> Unsub {
        Box::new(|| {})
    }
    fn dispose(&self) {}
}

struct State {
    disposed: bool,
    want_active: bool,
    dialing: bool,
    retry_ms: u64,
    retry: Option<TimerHandle>,
    latest: Option<HelperFrame>,
    /// The last position the helper was given.
    pointer: (i32, i32),
    video_run: Option<u64>,
    /// Keys this adapter pressed through the helper and the helper still holds, by virtual key.
    held_keys: Vec<u32>,
    detach: Vec<Unsub>,
}

struct Inner {
    service: Arc<dyn HelperService>,
    timers: Arc<dyn Timers>,
    state: Mutex<State>,
    changes: Arc<ListenerSet<()>>,
    frames: Arc<ListenerSet<HelperFrame>>,
    challenges: Arc<ListenerSet<Challenge>>,
    issues: Arc<ListenerSet<String>>,
    me: Weak<Inner>,
}

fn wire_button(button: PointerButton) -> WireButton {
    match button {
        PointerButton::Left => WireButton::Left,
        PointerButton::Right => WireButton::Right,
        PointerButton::Middle => WireButton::Middle,
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn changed(&self) {
        self.changes.call(&());
    }

    fn schedule_retry(&self) {
        let retry_ms = {
            let state = self.state();
            if !state.want_active || state.retry.is_some() || state.dialing {
                return;
            }
            state.retry_ms
        };
        if self.service.session().is_some() {
            return;
        }
        let me = self.me.clone();
        let handle = self.timers.set_timeout(
            Duration::from_millis(retry_ms),
            Box::new(move || {
                if let Some(inner) = me.upgrade() {
                    inner.state().retry = None;
                    inner.dial();
                }
            }),
        );
        let mut state = self.state();
        state.retry = Some(handle);
        state.retry_ms = RECONNECT_MAX_MS.min(retry_ms * 2);
    }

    fn dial(&self) {
        if self.state().dialing || self.service.session().is_some() {
            return;
        }
        self.state().dialing = true;
        let connected = self.service.connect();
        let me = self.me.clone();
        self.timers.react(Box::pin(async move {
            let outcome = connected.await;
            let Some(inner) = me.upgrade() else {
                return;
            };
            inner.state().dialing = false;
            if outcome.is_err() {
                inner.schedule_retry();
                return;
            }
            let (disposed, video_run, want_active) = {
                let mut state = inner.state();
                state.retry_ms = RECONNECT_FIRST_MS;
                (state.disposed, state.video_run, state.want_active)
            };
            // Disposed while it was being made: the late connection is closed.
            if disposed {
                inner.service.close();
                return;
            }
            if let Some(epoch) = video_run {
                inner.service.set_video_run(epoch);
            }
            if want_active {
                inner.service.set_active(true);
            }
            inner.changed();
        }));
    }

    fn attach(&self) {
        let me = self.me.clone();
        let desktop_changed = self.service.on_desktop_changed(Arc::new(move |_: &HelperSession| {
            if let Some(inner) = me.upgrade() {
                // A desktop switch releases everything the helper held.
                inner.state().held_keys.clear();
                inner.changed();
            }
        }));
        let me = self.me.clone();
        let closed = self.service.on_close(Arc::new(move |_: &()| {
            if let Some(inner) = me.upgrade() {
                {
                    let mut state = inner.state();
                    state.latest = None;
                    state.held_keys.clear();
                }
                inner.changed();
                inner.schedule_retry();
            }
        }));
        let me = self.me.clone();
        let challenged = self.service.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
            if let Some(inner) = me.upgrade() {
                inner.challenges.call(challenge);
            }
        }));
        let me = self.me.clone();
        let errors = self.service.on_error(Arc::new(move |(code, _): &(String, String)| {
            if let Some(inner) = me.upgrade() {
                if HELPER_RELEASED_CODES.contains(&code.as_str()) {
                    inner.state().held_keys.clear();
                }
                inner.issues.call(code);
            }
        }));
        let me = self.me.clone();
        let frames = self.service.on_frame(Arc::new(move |(header, pixels): &(FrameHeader, Arc<Vec<u8>>)| {
            if let Some(inner) = me.upgrade() {
                let frame = HelperFrame {
                    width: header.width,
                    height: header.height,
                    stride: header.stride,
                    origin_x: header.origin_x,
                    origin_y: header.origin_y,
                    pixels: pixels.clone(),
                };
                inner.state().latest = Some(frame.clone());
                inner.frames.call(&frame);
            }
        }));
        self.state().detach = vec![desktop_changed, closed, challenged, errors, frames];
    }

    /// The protocol event of a command, following the pointer and the keys the helper holds; Ctrl+Alt+Delete's
    /// Delete is the helper's `sas`.
    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        let event = {
            let mut state = self.state();
            let event = match command {
                ScreenInput::Move { x, y } => InputEvent::PointerMove { x, y },
                ScreenInput::Button { button, down, at } => {
                    let (x, y) = at.unwrap_or(state.pointer);
                    InputEvent::PointerButton { button: wire_button(button), down, x, y }
                }
                ScreenInput::Wheel { x, y, dx, dy } => InputEvent::PointerWheel { x, y, dx, dy },
                ScreenInput::Key { vk, scan, extended, down } => InputEvent::Key { down, vk: vk as u16, scan: scan as u16, extended },
                ScreenInput::Text(text) => InputEvent::Text { text },
            };
            match &event {
                InputEvent::PointerMove { x, y } | InputEvent::PointerButton { x, y, .. } | InputEvent::PointerWheel { x, y, .. } => {
                    state.pointer = (*x, *y);
                }
                InputEvent::Key { down, vk, .. } => {
                    let vk = u32::from(*vk);
                    let held = |keys: &[u32]| keys.iter().any(|key| state.held_keys.contains(key));
                    if *down && vk == VK_DELETE && held(&VK_CONTROL) && held(&VK_MENU) {
                        // The helper releases everything it holds before raising SAS.
                        state.held_keys.clear();
                        drop(state);
                        return helper_error(self.service.sas());
                    }
                    if *down {
                        if !state.held_keys.contains(&vk) {
                            state.held_keys.push(vk);
                        }
                    } else {
                        state.held_keys.retain(|key| *key != vk);
                    }
                }
                InputEvent::Text { .. } => {}
            }
            event
        };
        helper_error(self.service.send_input(event))
    }
}

/// The installed helper's adapter over its client.
pub(super) struct SecureDesktopAdapter {
    inner: Arc<Inner>,
}

impl SecureDesktopAdapter {
    /// The adapter for `service`; a no-op one when the helper is not installed.
    pub(super) fn create(service: Arc<dyn HelperService>, timers: Arc<dyn Timers>) -> Arc<dyn HelperAdapter<HelperFrame>> {
        if !service.available() {
            return Arc::new(NotInstalled);
        }
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| Inner {
            service,
            timers,
            state: Mutex::new(State {
                disposed: false,
                want_active: false,
                dialing: false,
                retry_ms: RECONNECT_FIRST_MS,
                retry: None,
                latest: None,
                pointer: (0, 0),
                video_run: None,
                held_keys: Vec::new(),
                detach: Vec::new(),
            }),
            changes: ListenerSet::new(),
            frames: ListenerSet::new(),
            challenges: ListenerSet::new(),
            issues: ListenerSet::new(),
            me: me.clone(),
        });
        inner.attach();
        Arc::new(Self { inner })
    }
}

impl HelperAdapter<HelperFrame> for SecureDesktopAdapter {
    fn installed(&self) -> bool {
        true
    }

    fn connected(&self) -> bool {
        self.inner.service.session().is_some()
    }

    fn desktop(&self) -> Option<String> {
        self.inner.service.session().map(|session| session.desktop)
    }

    fn session(&self) -> Option<u32> {
        self.inner.service.session().map(|session| session.session)
    }

    fn locked(&self) -> Option<bool> {
        self.inner.service.session().and_then(|session| session.locked)
    }

    fn set_active(&self, active: bool) -> BoxFuture<()> {
        let inner = &self.inner;
        let retry = {
            let mut state = inner.state();
            if state.disposed {
                return Box::pin(async {});
            }
            state.want_active = active;
            if active {
                None
            } else {
                // Deactivating releases everything the helper held.
                state.held_keys.clear();
                Some(state.retry.take())
            }
        };
        match retry {
            Some(retry) => {
                if let Some(retry) = retry {
                    retry.clear();
                }
                if inner.service.session().is_some() {
                    inner.service.set_active(false);
                }
            }
            None if inner.service.session().is_some() => inner.service.set_active(true),
            None => inner.dial(),
        }
        Box::pin(async {})
    }

    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        self.inner.send_input(command)
    }

    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        helper_error(self.inner.service.send_grant(grant))
    }

    fn set_video_run(&self, epoch: u64) {
        let send = {
            let mut state = self.inner.state();
            // A new run releases everything the helper held.
            if state.video_run != Some(epoch) {
                state.held_keys.clear();
            }
            state.video_run = Some(epoch);
            !state.disposed
        };
        if send && self.inner.service.session().is_some() {
            self.inner.service.set_video_run(epoch);
        }
    }

    fn latest_frame(&self) -> Option<HelperFrame> {
        self.inner.state().latest.clone()
    }

    fn on_frame(&self, listener: Listener<HelperFrame>) -> Unsub {
        self.inner.frames.add(listener)
    }

    fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub {
        self.inner.changes.add(listener)
    }

    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.inner.challenges.add(listener)
    }

    fn on_helper_issue(&self, listener: Listener<String>) -> Unsub {
        self.inner.issues.add(listener)
    }

    fn dispose(&self) {
        let (retry, detach) = {
            let mut state = self.inner.state();
            if state.disposed {
                return;
            }
            state.disposed = true;
            state.want_active = false;
            state.latest = None;
            (state.retry.take(), std::mem::take(&mut state.detach))
        };
        if let Some(retry) = retry {
            retry.clear();
        }
        for off in detach {
            off();
        }
        self.inner.changes.clear();
        self.inner.frames.clear();
        self.inner.challenges.clear();
        self.inner.issues.clear();
        // Deactivates and ends a connection that is up or still in its handshake.
        self.inner.service.close();
    }
}
