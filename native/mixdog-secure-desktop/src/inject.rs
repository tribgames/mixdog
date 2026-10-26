//! Pointer and keyboard injection via `SendInput`.
//!
//! `SendInput` posts to the input queue of the desktop the calling thread is
//! attached to, so — with the thread attached to the input desktop by
//! [`crate::desktop`] — the same calls drive the `Default` and `Winlogon`
//! (secure) desktops. Pointer coordinates arrive in desktop pixels and are
//! normalized to the 0..65535 absolute range across the whole virtual desktop.
//! Keys are injected by scan code when one is supplied (so keyboard layout and
//! the secure desktop behave), falling back to the virtual key otherwise.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEINPUT,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::protocol::PointerButton;

/// One wheel notch in the units `SendInput` expects.
const WHEEL_DELTA: i32 = 120;

/// Where the injector's synthesized input goes. Production uses
/// [`SystemInput`] (`SendInput`); tests record the exact `INPUT`s instead, so
/// the release semantics are verified without injecting on the build machine.
pub trait InputSink {
    fn send(&mut self, inputs: &[INPUT]);
}

/// `SendInput` on the calling thread's attached desktop.
#[derive(Default)]
pub struct SystemInput;

impl InputSink for SystemInput {
    fn send(&mut self, inputs: &[INPUT]) {
        if inputs.is_empty() {
            return;
        }
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

/// Normalize a virtual-screen pixel coordinate to the 0..65535 absolute range
/// that `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` uses.
fn normalize(x: i32, y: i32) -> (i32, i32) {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
    let nx = ((x - origin_x) as i64 * 65535 / (width.max(2) - 1) as i64) as i32;
    let ny = ((y - origin_y) as i64 * 65535 / (height.max(2) - 1) as i64) as i32;
    (nx.clamp(0, 65535), ny.clamp(0, 65535))
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, nx: i32, ny: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: nx,
                dy: ny,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn pointer_move(x: i32, y: i32) -> Vec<INPUT> {
    let (nx, ny) = normalize(x, y);
    vec![mouse_input(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        nx,
        ny,
        0,
    )]
}

fn button_flag(button: PointerButton, down: bool) -> MOUSE_EVENT_FLAGS {
    match (button, down) {
        (PointerButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (PointerButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (PointerButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (PointerButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (PointerButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (PointerButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    }
}

fn pointer_button(button: PointerButton, down: bool, x: i32, y: i32) -> Vec<INPUT> {
    let (nx, ny) = normalize(x, y);
    // Position and press travel in one event so the click lands where asked.
    vec![mouse_input(
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | button_flag(button, down),
        nx,
        ny,
        0,
    )]
}

/// Release `button` wherever the pointer is: only the `*UP` flag — no
/// `MOUSEEVENTF_MOVE`, no `ABSOLUTE`, zero deltas — so a release can never move
/// the pointer or carry a client's coordinates.
fn button_up_in_place(button: PointerButton) -> Vec<INPUT> {
    vec![mouse_input(button_flag(button, false), 0, 0, 0)]
}

fn pointer_wheel(x: i32, y: i32, dx: i32, dy: i32) -> Vec<INPUT> {
    let (nx, ny) = normalize(x, y);
    let mut inputs = Vec::new();
    if dy != 0 {
        inputs.push(mouse_input(
            MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_WHEEL,
            nx,
            ny,
            dy * WHEEL_DELTA,
        ));
    }
    if dx != 0 {
        inputs.push(mouse_input(
            MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_HWHEEL,
            nx,
            ny,
            dx * WHEEL_DELTA,
        ));
    }
    inputs
}

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key(down: bool, vk: u16, scan: u16, extended: bool) -> Vec<INPUT> {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    // Scan code is preferred; the virtual key is only the fallback.
    let input = if scan != 0 {
        key_input(0, scan, flags | KEYEVENTF_SCANCODE)
    } else {
        key_input(vk, 0, flags)
    };
    vec![input]
}

fn text(value: &str) -> Vec<INPUT> {
    let mut inputs = Vec::new();
    for unit in value.encode_utf16() {
        inputs.push(key_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    inputs
}

/// A key held down, stored exactly as it was pressed so its release is the
/// matching up of that same injection.
#[derive(Clone, Copy, PartialEq, Eq)]
struct HeldKey {
    vk: u16,
    scan: u16,
    extended: bool,
}

/// Which physical key an event names — exactly what [`key`] injects: with a
/// scan code, the key is `{scan, extended}` and `vk` is ignored; without one,
/// it is `{vk, extended}`. `extended` is part of both because [`key`] always
/// sends `KEYEVENTF_EXTENDEDKEY` when it is set, and the extended-key flag
/// selects a different physical key (e.g. numpad Enter vs. main Enter, both
/// `VK_RETURN`). Tracking by this identity means two representations that
/// inject the same key (e.g. `{vk:65, scan:30}` and `{vk:0, scan:30}`) press
/// and release the same held entry, while an extended and a non-extended key
/// stay independent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum KeyId {
    Scan { scan: u16, extended: bool },
    Vk { vk: u16, extended: bool },
}

impl HeldKey {
    fn id(&self) -> KeyId {
        if self.scan != 0 {
            KeyId::Scan { scan: self.scan, extended: self.extended }
        } else {
            KeyId::Vk { vk: self.vk, extended: self.extended }
        }
    }
}

/// Per-connection injector. It remembers exactly which pointer buttons and keys
/// **this connection** pressed and has not yet released, and:
///
/// - releases only those: an "up" for a button or key it does not hold is
///   ignored, active or not, so a client can never release input it did not
///   press (e.g. a key held on the physical keyboard);
/// - releases in place: a button release outside an active move is a bare
///   `*UP` with no movement or coordinates ([`button_up_in_place`]);
/// - releases everything it still holds on deactivate, desktop switch, session
///   change, disconnect, stop, and drop, so no exit path strands a press on the
///   (possibly secure) desktop.
///
/// One injector is created per client connection, so its tracking is the
/// connection's own.
pub struct Injector<S: InputSink = SystemInput> {
    sink: S,
    buttons: Vec<PointerButton>,
    keys: Vec<HeldKey>,
}

impl Injector<SystemInput> {
    pub fn new() -> Self {
        Injector::with_sink(SystemInput)
    }
}

impl<S: InputSink> Injector<S> {
    pub fn with_sink(sink: S) -> Self {
        Injector { sink, buttons: Vec::new(), keys: Vec::new() }
    }

    fn holds_button(&self, button: PointerButton) -> bool {
        self.buttons.contains(&button)
    }

    /// The held entry with the same identity as `key`, if any.
    fn held_key(&self, key: HeldKey) -> Option<HeldKey> {
        self.keys.iter().copied().find(|held| held.id() == key.id())
    }

    fn track_button(&mut self, button: PointerButton, down: bool) {
        self.buttons.retain(|&b| b != button);
        if down {
            self.buttons.push(button);
        }
    }

    fn track_key(&mut self, key: HeldKey, down: bool) {
        self.keys.retain(|k| k.id() != key.id());
        if down {
            self.keys.push(key);
        }
    }

    pub fn pointer_move(&mut self, x: i32, y: i32) {
        self.sink.send(&pointer_move(x, y));
    }

    /// Active-session button. A press is tracked and sent at `(x, y)`; a
    /// release is sent (at `(x, y)`, ending a drag where the client released
    /// it) only if this connection holds that button — otherwise ignored.
    pub fn pointer_button(&mut self, button: PointerButton, down: bool, x: i32, y: i32) {
        if !down && !self.holds_button(button) {
            return;
        }
        self.track_button(button, down);
        self.sink.send(&pointer_button(button, down, x, y));
    }

    pub fn pointer_wheel(&mut self, x: i32, y: i32, dx: i32, dy: i32) {
        self.sink.send(&pointer_wheel(x, y, dx, dy));
    }

    /// Active-session key. A press is tracked and sent; a release is sent only
    /// if this connection holds that key (by [`KeyId`]) — otherwise ignored.
    pub fn key(&mut self, down: bool, vk: u16, scan: u16, extended: bool) {
        let event = HeldKey { vk, scan, extended };
        if down {
            self.track_key(event, true);
            self.sink.send(&key(true, vk, scan, extended));
        } else {
            self.release_key(vk, scan, extended);
        }
    }

    /// Text is injected as complete down+up pairs, so nothing stays held.
    pub fn text(&mut self, value: &str) {
        self.sink.send(&text(value));
    }

    /// Release-only path (used while control is inactive): if this connection
    /// holds `button`, release it in place — no movement, no coordinates.
    /// Returns whether anything was released.
    pub fn release_button(&mut self, button: PointerButton) -> bool {
        if !self.holds_button(button) {
            return false;
        }
        self.track_button(button, false);
        self.sink.send(&button_up_in_place(button));
        true
    }

    /// Release-only path (used while control is inactive): if this connection
    /// holds the key, release it. Returns whether anything was released.
    pub fn release_key(&mut self, vk: u16, scan: u16, extended: bool) -> bool {
        let Some(held) = self.held_key(HeldKey { vk, scan, extended }) else {
            return false;
        };
        self.track_key(held, false);
        // Release the key as it was pressed, not as this event spells it.
        self.sink.send(&key(false, held.vk, held.scan, held.extended));
        true
    }

    /// Release every button (in place) and key this connection still holds.
    /// Safe to call repeatedly; a no-op when nothing is held.
    pub fn release_all(&mut self) {
        for button in std::mem::take(&mut self.buttons) {
            self.sink.send(&button_up_in_place(button));
        }
        for held in std::mem::take(&mut self.keys) {
            self.sink.send(&key(false, held.vk, held.scan, held.extended));
        }
    }
}

/// Every exit path that drops the injector — the end of a client connection,
/// an early return, a stop request — releases what it still holds, so no path
/// the helper controls can strand a key or button down.
impl<S: InputSink> Drop for Injector<S> {
    fn drop(&mut self) {
        self.release_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::RefCell;
    use std::rc::Rc;

    /// Records every `INPUT` instead of calling `SendInput`, so `cargo test`
    /// never injects on the build machine. Shared so it can be read after the
    /// injector (and its release-on-drop) is gone.
    #[derive(Clone, Default)]
    struct Recorder(Rc<RefCell<Vec<INPUT>>>);

    impl InputSink for Recorder {
        fn send(&mut self, inputs: &[INPUT]) {
            self.0.borrow_mut().extend_from_slice(inputs);
        }
    }

    impl Recorder {
        fn take(&self) -> Vec<INPUT> {
            std::mem::take(&mut *self.0.borrow_mut())
        }
    }

    fn mouse(input: &INPUT) -> MOUSEINPUT {
        assert_eq!(input.r#type, INPUT_MOUSE);
        unsafe { input.Anonymous.mi }
    }

    fn keyboard(input: &INPUT) -> KEYBDINPUT {
        assert_eq!(input.r#type, INPUT_KEYBOARD);
        unsafe { input.Anonymous.ki }
    }

    /// A release that cannot move the pointer: only the up flag, zero deltas.
    fn assert_in_place_up(input: &INPUT, up: MOUSE_EVENT_FLAGS) {
        let mi = mouse(input);
        assert_eq!(mi.dwFlags, up, "only the up flag: no MOVE, ABSOLUTE or VIRTUALDESK");
        assert_eq!((mi.dx, mi.dy), (0, 0), "no coordinates");
    }

    #[test]
    fn release_only_path_moves_nothing_and_uses_no_coordinates() {
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());
        injector.pointer_button(PointerButton::Left, true, 100, 200);
        injector.key(true, 0x11, 0x1d, false);
        sink.take();

        assert!(injector.release_button(PointerButton::Left));
        assert!(injector.release_key(0x11, 0x1d, false));
        let sent = sink.take();
        assert_eq!(sent.len(), 2);
        assert_in_place_up(&sent[0], MOUSEEVENTF_LEFTUP);
        let ki = keyboard(&sent[1]);
        assert_eq!(ki.wScan, 0x1d);
        assert_ne!(ki.dwFlags.0 & KEYEVENTF_KEYUP.0, 0);
        assert!(injector.buttons.is_empty() && injector.keys.is_empty());
    }

    #[test]
    fn untracked_releases_are_no_ops_active_or_not() {
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());
        // Nothing pressed by this connection: every release is ignored.
        assert!(!injector.release_button(PointerButton::Right));
        assert!(!injector.release_key(0x5B, 0x5b, true)); // Win
        injector.pointer_button(PointerButton::Right, false, 5, 5);
        injector.key(false, 0x5B, 0x5b, true);
        assert!(sink.take().is_empty(), "no input for releases of unheld input");

        // A different key/button than the one held is still untracked.
        injector.key(true, 0x41, 0x1e, false);
        injector.pointer_button(PointerButton::Left, true, 1, 1);
        sink.take();
        injector.key(false, 0x41, 0x1e, true); // same scan, different `extended`
        injector.pointer_button(PointerButton::Middle, false, 9, 9);
        assert!(!injector.release_button(PointerButton::Right));
        assert!(sink.take().is_empty());
        assert_eq!((injector.buttons.len(), injector.keys.len()), (1, 1));
        drop(injector);
        // Drop released exactly what was held: the left button in place, then A.
        let sent = sink.take();
        assert_eq!(sent.len(), 2);
        assert_in_place_up(&sent[0], MOUSEEVENTF_LEFTUP);
        assert_eq!(keyboard(&sent[1]).wScan, 0x1e);
    }

    #[test]
    fn equivalent_down_and_up_representations_release_exactly_once() {
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());

        // Scan-coded: `vk` is ignored by injection, so it is ignored by tracking.
        injector.key(true, 65, 30, false);
        sink.take();
        injector.key(false, 0, 30, false);
        let sent = sink.take();
        assert_eq!(sent.len(), 1, "the equivalent up released the key");
        let ki = keyboard(&sent[0]);
        assert_eq!(ki.wScan, 30);
        assert_ne!(ki.dwFlags.0 & KEYEVENTF_KEYUP.0, 0);
        assert_ne!(ki.dwFlags.0 & KEYEVENTF_SCANCODE.0, 0, "released as it was pressed");
        assert!(injector.keys.is_empty());
        injector.key(false, 65, 30, false);
        assert!(!injector.release_key(99, 30, false));
        assert!(sink.take().is_empty(), "released exactly once");

        // Equivalent spellings of one press track a single entry.
        injector.key(true, 0, 30, false);
        injector.key(true, 65, 30, false);
        assert_eq!(injector.keys.len(), 1);
        sink.take();
        assert!(injector.release_key(7, 30, false), "inactive path uses the same identity");
        assert_eq!(sink.take().len(), 1);

        drop(injector);
        assert!(sink.take().is_empty(), "nothing left held, nothing released twice");
    }

    fn is_extended(ki: &KEYBDINPUT) -> bool {
        ki.dwFlags.0 & KEYEVENTF_EXTENDEDKEY.0 != 0
    }

    #[test]
    fn extended_and_plain_vk_keys_are_tracked_and_released_independently() {
        // VK_RETURN: main Enter (plain) and numpad Enter (extended).
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());
        injector.key(true, 0x0D, 0, false);
        injector.key(true, 0x0D, 0, true);
        assert_eq!(injector.keys.len(), 2, "two distinct held keys");
        sink.take();

        // Releasing main Enter releases exactly main Enter.
        injector.key(false, 0x0D, 0, false);
        let sent = sink.take();
        assert_eq!(sent.len(), 1);
        assert_eq!(keyboard(&sent[0]).wVk, VIRTUAL_KEY(0x0D));
        assert!(!is_extended(&keyboard(&sent[0])), "the plain key went up, not numpad Enter");
        assert_eq!(injector.keys.len(), 1, "numpad Enter is still tracked");

        // A second plain release is untracked now; numpad Enter stays held.
        injector.key(false, 0x0D, 0, false);
        assert!(!injector.release_key(0x0D, 0, false));
        assert!(sink.take().is_empty());

        // Numpad Enter releases on its own (here via the inactive path).
        assert!(injector.release_key(0x0D, 0, true));
        let sent = sink.take();
        assert_eq!(sent.len(), 1);
        assert!(is_extended(&keyboard(&sent[0])));
        assert!(injector.keys.is_empty());
    }

    #[test]
    fn extended_and_plain_scan_keys_are_independent_and_unmatched_releases_are_ignored() {
        // Scan 0x1c: main Enter (plain) vs numpad Enter (extended).
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());

        // Only the plain key is held: an extended release of it is ignored.
        injector.key(true, 0, 0x1c, false);
        sink.take();
        injector.key(false, 0, 0x1c, true);
        assert!(!injector.release_key(0x0D, 0x1c, true));
        assert!(sink.take().is_empty(), "extended release does not match the plain press");
        assert_eq!(injector.keys.len(), 1);

        // A vk-only release (no scan code) is ignored too: a vk identity never
        // matches a scan-code identity.
        injector.key(false, 0x0D, 0, false);
        assert!(sink.take().is_empty());

        // The matching release (any vk, same scan + extended) releases it once.
        injector.key(false, 0x0D, 0x1c, false);
        let sent = sink.take();
        assert_eq!(sent.len(), 1);
        assert!(!is_extended(&keyboard(&sent[0])));
        drop(injector);
        assert!(sink.take().is_empty(), "nothing left held");
    }

    #[test]
    fn release_all_is_in_place_and_idempotent_and_repeated_down_tracks_once() {
        let sink = Recorder::default();
        let mut injector = Injector::with_sink(sink.clone());
        injector.pointer_button(PointerButton::Right, true, 12, 34);
        injector.pointer_button(PointerButton::Right, true, 12, 34);
        injector.key(true, 0, 0x2a, false);
        injector.key(true, 0, 0x2a, false);
        assert_eq!((injector.buttons.len(), injector.keys.len()), (1, 1));
        sink.take();

        injector.release_all();
        let sent = sink.take();
        assert_eq!(sent.len(), 2);
        assert_in_place_up(&sent[0], MOUSEEVENTF_RIGHTUP);
        assert_ne!(keyboard(&sent[1]).dwFlags.0 & KEYEVENTF_KEYUP.0, 0);
        injector.release_all();
        drop(injector);
        assert!(sink.take().is_empty(), "nothing left to release");
    }
}
