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

use super::native;
use super::{edit, native_state};
use crate::keys::Mod;
use crate::observer::Shared;
use crate::platform::{Background, Wid};
use crate::port::windows::{read_message, Message, Pressed, ReadMessage, Refusal, WinPort};
use std::sync::Arc;
use std::time::Duration;

/// A failed message delivery. Whether anything was queued is the port's to know: its receipts decide what is released.
#[derive(Debug)]
struct MsgError {
    text: String,
}

impl MsgError {
    fn plain(text: impl Into<String>) -> MsgError {
        MsgError { text: text.into() }
    }
}

type Msg<T = ()> = Result<T, MsgError>;

/// How long a queued message's handling is awaited (the wait holds nothing).
const REPLY_WAIT: Duration = Duration::from_millis(1000);

fn refused(refusal: Refusal) -> MsgError {
    match refusal {
        Refusal::Revoked => MsgError::plain(crate::port::REVOKED),
        Refusal::Hung => MsgError::plain("background_target_hung|the target window does not answer; no message was queued"),
        Refusal::Isolated => {
            MsgError::plain("background_blocked_uipi|Windows integrity isolation blocked the native message")
        }
        Refusal::Gone => MsgError::plain(
            "background_target_gone|the target window closed before it acknowledged a background input release",
        ),
        Refusal::Failed(code) => {
            MsgError::plain(format!("background_message_rejected|native window message failed with Win32 error {code}"))
        }
    }
}

/// One message through the port to `target`, a window of `top`, then its handling awaited: the reply is data, and the next
/// message is arbitrated again.
fn send(port: &WinPort, top: Wid, target: Wid, message: Message) -> Msg<usize> {
    let reply = port.message(top, target, message).map_err(refused)?;
    port.wait(&reply, REPLY_WAIT)
        .ok_or_else(|| MsgError::plain("background_target_hung|native window message timed out"))
}

/// One read of a window's state: holds no permission and changes nothing.
pub fn read_value(target: Wid, read: ReadMessage<'_>) -> Result<usize, String> {
    read_message(target, read).map_err(|refusal| refused(refusal).text)
}

const RELEASE_ATTEMPTS: u32 = 3;

/// Lets go of what `top`'s queue holds through its receipt, and waits for the target to acknowledge it. A busy target gets up
/// to three waits; the release itself is queued once and never sent again. A target gone since the press holds nothing.
fn confirm_release(port: &WinPort, top: Wid, target: Wid, pressed: Pressed) -> Result<(), String> {
    let release = match port.release_pressed(top, target, pressed) {
        None => return Ok(()),
        Some(Err(Refusal::Gone)) => return Ok(()),
        Some(Err(_)) => {
            return Err("input_cleanup_unconfirmed: background input release was not acknowledged".into());
        }
        Some(Ok(reply)) => reply,
    };
    for _ in 0..RELEASE_ATTEMPTS {
        if port.wait(&release, REPLY_WAIT).is_some() {
            return Ok(());
        }
    }
    Err("input_cleanup_unconfirmed: background input release was not acknowledged".into())
}

/// A press and its release as one unit: once the port queued the press, its receipt holds the release, which goes out and is
/// acknowledged whatever happens in between (a revocation, an error, a lost reply). A press refused before it was queued holds
/// nothing.
fn with_release(
    port: &WinPort,
    top: Wid,
    target: Wid,
    press: Message,
    held: impl FnOnce() -> Msg,
) -> Result<(), String> {
    let pressed = match press {
        Message::KeyDown { vk, .. } => Pressed::Key(vk),
        Message::ButtonDown { button, .. } => Pressed::Button(button),
        _ => Pressed::Button(crate::port::windows::MouseButton::Left),
    };
    let outcome = send(port, top, target, press).and_then(|_| held()).map_err(|error| error.text);
    confirm_release(port, top, target, pressed)?;
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
    /// Every message, hold and focus recovery of the background routes goes through the executor's port.
    port: Arc<WinPort>,
}

impl WinBackground {
    pub fn new(shared: Arc<Shared>, port: Arc<WinPort>) -> WinBackground {
        WinBackground { shared, port }
    }

    pub(in crate::platform::windows) fn port(&self) -> &WinPort {
        &self.port
    }

    /// `EM_SETSEL` on `control`, a window of `top`, through the port; its reply once handled.
    pub(in crate::platform::windows) fn edit_select(&self, top: Wid, control: Wid, start: usize, end: isize) -> Result<usize, String> {
        send(&self.port, top, control, Message::EditSelect { start, end }).map_err(|error| error.text)
    }

    /// `WM_INITMENUPOPUP` on `window`, through the port: an opening menu refreshes its items.
    pub(in crate::platform::windows) fn announce_menu(&self, window: Wid, menu: usize, position: isize) -> Result<usize, String> {
        send(&self.port, window, window, Message::MenuAnnounce { menu, position }).map_err(|error| error.text)
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
