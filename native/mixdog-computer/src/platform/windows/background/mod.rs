//! Input delivered to one window as messages, without taking the foreground
//! or moving the person's pointer. A target that cannot take messages is
//! refused before anything is sent.
//!
//! This file holds the message transport the routes share; the routes are
//! pointer.rs (pointer, wheel, drag), keyboard.rs (keys, text), holds.rs
//! (keeping the target inactive) and dialog.rs (standard dialogs).

mod dialog;
mod drops;
mod holds;
mod keyboard;
mod pointer;

pub use holds::{hold_inactive, release_inactive};

use super::native::{self, hwnd};
use super::{edit, native_state};
use crate::keys::Mod;
use crate::observer::Shared;
use crate::platform::{Background, Wid};
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Foundation::{GetLastError, SetLastError, ERROR_ACCESS_DENIED, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK};

/// A failed message delivery, and whether the system proved nothing arrived.
#[derive(Debug)]
struct MsgError {
    text: String,
    not_delivered: bool,
    hung: bool,
    gone: bool,
}

impl MsgError {
    fn plain(text: impl Into<String>) -> MsgError {
        MsgError {
            text: text.into(),
            not_delivered: false,
            hung: false,
            gone: false,
        }
    }
}

type Msg<T = ()> = Result<T, MsgError>;

fn send(target: Wid, message: u32, wparam: usize, lparam: isize) -> Msg<usize> {
    let mut result = 0usize;
    // SAFETY: the call can fail without setting an error, so it is cleared first.
    let sent = unsafe {
        SetLastError(Default::default());
        SendMessageTimeoutW(
            hwnd(target),
            message,
            WPARAM(wparam),
            LPARAM(lparam),
            SMTO_BLOCK | SMTO_ABORTIFHUNG,
            1000,
            Some(&mut result),
        )
    };
    if sent.0 != 0 {
        return Ok(result);
    }
    let error = unsafe { GetLastError() };
    Err(match error.0 {
        0 | 1460 => MsgError {
            hung: true,
            ..MsgError::plain("background_target_hung|native window message timed out")
        },
        code if code == ERROR_ACCESS_DENIED.0 => MsgError {
            not_delivered: true,
            ..MsgError::plain(
                "background_blocked_uipi|Windows integrity isolation blocked the native message",
            )
        },
        code => MsgError::plain(format!(
            "background_message_rejected|native window message failed with Win32 error {code}"
        )),
    })
}

/// One message to a window, for callers outside the background routes.
pub fn send_value(target: Wid, message: u32, wparam: usize, lparam: isize) -> Result<usize, String> {
    send(target, message, wparam, lparam).map_err(|error| error.text)
}

/// Binds a release to the window's process and thread: a destroyed window's
/// handle may be reused, and cleanup must never reach its successor.
fn bound(target: Wid, release: impl Fn() -> Msg + 'static) -> impl Fn() -> Msg {
    let (pid, thread) = native::pid_thread(target);
    move || {
        let (now_pid, now_thread) = native::pid_thread(target);
        if pid == 0 || thread == 0 || !native::is_window(target) || (now_pid, now_thread) != (pid, thread) {
            return Err(MsgError {
                gone: true,
                ..MsgError::plain("background_target_gone|the target window closed before it acknowledged a background input release")
            });
        }
        release()
    }
}

const RELEASE_ATTEMPTS: u32 = 3;
const RELEASE_ATTEMPT_MS: u64 = 1000;

/// A busy target times a release out without saying whether it landed; a
/// release is harmless to send again, so a timeout gets up to three attempts
/// about a second apart. A target gone before any release reached it holds
/// nothing; gone after an unanswered one, the release stays unconfirmed.
fn confirm_release(release: &dyn Fn() -> Msg) -> Result<(), String> {
    for attempt in 1..=RELEASE_ATTEMPTS {
        let started = std::time::Instant::now();
        match release() {
            Ok(()) => return Ok(()),
            Err(error) if error.gone => {
                return if attempt > 1 {
                    Err(format!("input_cleanup_unconfirmed: {}", error.text))
                } else {
                    Ok(())
                };
            }
            Err(error) if error.hung && attempt < RELEASE_ATTEMPTS => {
                let rest = Duration::from_millis(RELEASE_ATTEMPT_MS).saturating_sub(started.elapsed());
                std::thread::sleep(rest);
            }
            Err(_) => {
                return Err(
                    "input_cleanup_unconfirmed: background input release was not acknowledged"
                        .into(),
                )
            }
        }
    }
    unreachable!("the loop returns on its last attempt")
}

/// A press and its release as one guarded unit: whatever happens in between,
/// the release is sent and acknowledged unless the press provably never landed.
fn with_release(
    press: impl FnOnce() -> Msg,
    held: impl FnOnce() -> Msg,
    release: &dyn Fn() -> Msg,
) -> Result<(), String> {
    let mut release_required = true;
    let outcome = (|| {
        match press() {
            Ok(()) => {}
            Err(error) => {
                if error.not_delivered {
                    release_required = false;
                }
                return Err(error.text);
            }
        }
        held().map_err(|error| error.text)
    })();
    if release_required {
        confirm_release(release)?;
    }
    outcome
}

/// The refusal for a posted `kind` to `window` or the child `target` under
/// it, when the toolkit of either drops it (drops.rs).
fn refuse_dropped(window: Wid, target: Wid, kind: drops::Kind) -> Result<(), String> {
    let foreground = native::foreground() == window;
    for candidate in [window, target] {
        if let Some(refusal) = drops::refusal(&native::class_name(candidate), kind, foreground) {
            return Err(refusal);
        }
    }
    Ok(())
}

pub(in crate::platform::windows) fn is_chromium(class: &str) -> bool {
    class.eq_ignore_ascii_case("Chrome_RenderWidgetHostHWND")
        || class
            .get(.."Chrome_WidgetWin".len())
            .is_some_and(|head| head.eq_ignore_ascii_case("Chrome_WidgetWin"))
}

pub(in crate::platform::windows) fn belongs_to_top(top: Wid, candidate: Wid) -> bool {
    if !native::is_window(top) || !native::is_window(candidate) {
        return false;
    }
    if candidate != top && native::root_of(candidate) != top {
        return false;
    }
    let (top_pid, candidate_pid) = (native::pid_of(top), native::pid_of(candidate));
    top_pid != 0 && top_pid == candidate_pid
}

pub struct WinBackground {
    shared: Arc<Shared>,
}

impl WinBackground {
    pub fn new(shared: Arc<Shared>) -> WinBackground {
        WinBackground { shared }
    }
}

impl Background for WinBackground {
    fn validate(&self, window: Wid, action: &str) -> Result<(), String> {
        if !native::is_window(window) {
            return Err("stale_target|background input window is stale".into());
        }
        if (action == "key" || action == "type") && !keyboard::supports_keyboard_class(&native::class_name(window)) {
            return Err("background_unsupported|target renderer does not accept posted keyboard input; use semantic value input or explicit foreground delivery; no input sent".into());
        }
        Ok(())
    }

    /// ValidateBackgroundInput (MixWin32Keyboard.cs:305-317): a key stream's
    /// grammar first, then, for a named child, the control that would take
    /// the keys; else the top window's class.
    fn validate_target(
        &self,
        window: Wid,
        preferred: Wid,
        action: &str,
        keys: Option<&str>,
    ) -> Result<(), String> {
        if action == "key" {
            keyboard::parse_keys(keys.unwrap_or("")).map_err(|error| error.text)?;
        }
        if matches!(action, "key" | "type") {
            refuse_dropped(window, preferred, if action == "key" { drops::Kind::Key } else { drops::Kind::Text })?;
        }
        if preferred != 0 && matches!(action, "key" | "type") {
            if !native::is_window(window) {
                return Err("stale_target|background input window is stale".into());
            }
            return keyboard::keyboard_target(window, preferred).map(|_| ()).map_err(|error| error.text);
        }
        self.validate(window, action)
    }

    fn pointer(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        kind: &str,
        modifiers: &[Mod],
    ) -> Result<String, String> {
        self.send_pointer(window, x, y, kind, modifiers)
    }

    fn wheel(
        &self,
        window: Wid,
        x: i32,
        y: i32,
        clicks: i32,
        horizontal: bool,
        modifiers: &[Mod],
    ) -> Result<String, String> {
        self.send_wheel(window, x, y, clicks, horizontal, modifiers)
    }

    fn drag(&self, window: Wid, points: &[(i32, i32)], modifiers: &[Mod]) -> Result<String, String> {
        self.send_drag(window, points, modifiers)
    }

    fn keys(&self, window: Wid, keys: &str) -> Result<String, String> {
        self.send_keys_to(window, 0, keys)
    }

    fn text(&self, window: Wid, text: &str) -> Result<String, String> {
        self.send_text_to(window, 0, text)
    }

    fn keys_to(&self, window: Wid, preferred: Wid, keys: &str) -> Result<String, String> {
        self.send_keys_to(window, preferred, keys)
    }

    fn text_to(&self, window: Wid, preferred: Wid, text: &str) -> Result<String, String> {
        self.send_text_to(window, preferred, text)
    }

    fn is_web_content_host(&self, window: Wid) -> bool {
        keyboard::is_web_content_host(window)
    }

    fn begin_scope(&self, root: Wid) -> Result<(), String> {
        self.begin_inactive_scope(root)
    }

    fn end_scope(&self, root: Wid) -> Result<(), String> {
        self.end_inactive_scope(root)
    }

    fn hold(&self, window: Wid) -> Result<Wid, String> {
        self.hold_past_call(window)
    }

    fn release_hold(&self, root: Wid) -> Result<(), String> {
        self.release_past_call(root)
    }

    fn take_activation_unprotected(&self) -> bool {
        holds::take_activation_unprotected()
    }

    fn select_all(&self, top: Wid, preferred: Wid, has_text: bool) -> Result<i32, String> {
        edit::select_all(self, top, preferred, has_text)
    }

    fn text_end(&self, top: Wid, preferred: Wid) -> Result<i32, String> {
        edit::text_end(self, top, preferred)
    }

    fn native_state(&self, child: Wid, action: &str) -> Option<String> {
        native_state::read(child, action)
    }

    fn dialog_refusal(
        &self,
        top: Wid,
        preferred: Wid,
        action: &str,
        keys: Option<&str>,
    ) -> Option<String> {
        dialog::refusal(top, preferred, action, keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chromium_classes_are_recognised() {
        assert!(is_chromium("Chrome_WidgetWin_1"));
        assert!(is_chromium("Chrome_RenderWidgetHostHWND"));
        assert!(!is_chromium("Notepad"));
    }
}

/// The control background keys reach (KeyboardTarget), for the native edit
/// operations: its class and Tk checks and the focused-descendant fallback.
pub(super) fn keyboard_target_of(top: Wid, preferred: Wid) -> Result<Wid, String> {
    keyboard::keyboard_target(top, preferred).map_err(|error| error.text)
}
