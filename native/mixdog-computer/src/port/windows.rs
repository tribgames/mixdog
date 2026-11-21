//! The Windows effect port. Every Windows API that hands input or a change to another application (`SendInput`, a window's
//! message queue, the foreground and focus, window placement, the no-activate bit and the shield, UI Automation and MSAA
//! actions, the clipboard and the shell) is called only by the driver ([`real`]), and the driver is reachable only through a
//! [`WinPort`]: platform code builds typed operations, the port arbitrates each against the scope and records what it holds.
//!
//! Submission boundaries, route by route (`crate::port`: a local submission is admitted across its call, a call that can block
//! on another process is handed over at its entry and counted in flight):
//! - Local: `SendInput` (it enqueues hardware input and has no target queue; the cross-process receipt lock is taken before
//!   admission), the no-name key (one `SendInput`), `PostMessageW`, `TerminateProcess`.
//! - Handed over: every call whose not blocking depends on input queues this port cannot see (another thread's attachment,
//!   made here or elsewhere, transitively): `SendMessageCallbackW` (a window's queue; its reply is waited for outside admission,
//!   as data), `ShowWindowAsync`, `SetWindowPos` with `SWP_ASYNCWINDOWPOS`. And the foreground (`SetForegroundWindow`), an
//!   activation try (`AttachThreadInput`, `BringWindowToTop`, `SetActiveWindow`, `SetFocus`), the no-activate bit
//!   (`SetWindowLongW` sends the window its style messages), the shield (`EnableWindow` sends `WM_ENABLE`), UI Automation, MSAA,
//!   the clipboard and the shell.

mod real;
pub(crate) mod shared;

use super::{Admitted, Boundary, Cleanup, Holder, Ledger, Outcome, Owned, Receipt, Scope, Settled};
use crate::platform::windows_input::{DELIVERY_FAILED, Event, KEY_UP, RELEASE_REJECTED};
use crate::platform::{Wid, WinState};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::Win32::UI::Accessibility::{
    IAccessible, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern,
    IUIAutomationTogglePattern, IUIAutomationValuePattern, ScrollAmount,
};
use windows::core::BSTR;

#[cfg(test)]
pub(crate) use real::send_unmarked;
pub(crate) use real::{ReadMessage, read_message, release_recorded, restore_recorded};

/// A button of a window's pointer messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MouseButton {
    Left,
    Right,
    Middle,
}

impl MouseButton {
    /// The button's down message and its `MK_*` flag.
    fn down(self) -> (u32, usize) {
        match self {
            MouseButton::Left => (0x0201, 0x1),
            MouseButton::Right => (0x0204, 0x2),
            MouseButton::Middle => (0x0207, 0x10),
        }
    }

    fn up(self) -> u32 {
        match self {
            MouseButton::Left => 0x0202,
            MouseButton::Right => 0x0205,
            MouseButton::Middle => 0x0208,
        }
    }
}

/// The only messages that reach another application's window through the port. `flags` never carry the pressed button's
/// own `MK_*` bit: the port adds it to a press and a motion while the button is held.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Message {
    MouseMove {
        flags: usize,
        point: isize,
    },
    ButtonDown {
        button: MouseButton,
        flags: usize,
        point: isize,
    },
    /// The second press of a double click (`WM_LBUTTONDBLCLK`).
    DoubleClick {
        flags: usize,
        point: isize,
    },
    ButtonUp {
        button: MouseButton,
        flags: usize,
        point: isize,
    },
    Wheel {
        horizontal: bool,
        packed: usize,
        point: isize,
    },
    KeyDown {
        vk: u16,
        lparam: isize,
    },
    KeyUp {
        vk: u16,
        lparam: isize,
    },
    Char {
        unit: usize,
        lparam: isize,
    },
    /// `EM_SETSEL`: moves an edit's caret or selection.
    EditSelect {
        start: usize,
        end: isize,
    },
    /// `WM_INITMENUPOPUP`: an opening menu refreshes its items.
    MenuAnnounce {
        menu: usize,
        position: isize,
    },
}

impl Message {
    pub(crate) fn raw(&self) -> (u32, usize, isize) {
        match *self {
            Message::MouseMove { flags, point } => (0x0200, flags, point),
            Message::ButtonDown { button, flags, point } => (button.down().0, flags | button.down().1, point),
            Message::DoubleClick { flags, point } => (0x0203, flags | 0x1, point),
            Message::ButtonUp { button, flags, point } => (button.up(), flags, point),
            Message::Wheel { horizontal, packed, point } => (if horizontal { 0x020E } else { 0x020A }, packed, point),
            Message::KeyDown { vk, lparam } => (0x0100, vk as usize, lparam),
            Message::KeyUp { vk, lparam } => (0x0101, vk as usize, lparam),
            Message::Char { unit, lparam } => (0x0102, unit, lparam),
            Message::EditSelect { start, end } => (0x00B1, start, end),
            Message::MenuAnnounce { menu, position } => (0x0117, menu, position),
        }
    }

    /// What a press holds and the exact message that lets go of it.
    fn press(&self) -> Option<(Pressed, Message)> {
        match *self {
            Message::ButtonDown { button, flags, point } => Some((Pressed::Button(button), Message::ButtonUp { button, flags, point })),
            Message::DoubleClick { flags, point } => {
                let button = MouseButton::Left;
                Some((Pressed::Button(button), Message::ButtonUp { button, flags, point }))
            }
            Message::KeyDown { vk, lparam } => Some((Pressed::Key(vk), Message::KeyUp { vk, lparam: lparam | 0xC000_0000u32 as i32 as isize })),
            _ => None,
        }
    }

    fn release(&self) -> Option<Pressed> {
        match *self {
            Message::ButtonUp { button, .. } => Some(Pressed::Button(button)),
            Message::KeyUp { vk, .. } => Some(Pressed::Key(vk)),
            _ => None,
        }
    }
}

/// What a window's queue holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pressed {
    Button(MouseButton),
    Key(u16),
}

/// A message posted without a reply.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Posted {
    Close,
    MenuCommand(u32),
}

/// What the port holds.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Hold {
    /// A key the system keyboard holds, by the receipt's identity: virtual key, scan code, flags without KEYUP.
    Key { vk: u16, scan: u16, flags: u32 },
    /// A system mouse button, by its down flag.
    Button(u32),
    /// A button or key a window's queue holds: the top window it was sent for, the window it went to and that window's
    /// `(pid, thread)` then, and the message that lets go of it.
    Queue { top: Wid, target: Wid, owner: (u32, u32), pressed: Pressed, release: Message },
    /// The no-activate bit this executor put on a root window.
    NoActivate(Wid),
    /// A window this executor disabled (the activation shield).
    Disabled(Wid),
    /// This thread's input attached to another thread's (`AttachThreadInput`): detached by its receipt.
    Attached { from: u32, to: u32 },
}

/// Why a message did not go out.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Refusal {
    Revoked,
    /// The target does not answer; nothing was queued.
    Hung,
    /// Integrity isolation refused it; nothing was queued.
    Isolated,
    /// The window was gone or reused by another owner; nothing was queued.
    Gone,
    Failed(u32),
}

/// The reply a queued message gets once the target handled it: data, never a renewed permission.
#[derive(Clone, Default)]
pub(crate) struct Reply(pub(crate) Arc<Mutex<Option<usize>>>);

impl Reply {
    pub(crate) fn answered(value: usize) -> Reply {
        Reply(Arc::new(Mutex::new(Some(value))))
    }

    pub(crate) fn get(&self) -> Option<usize> {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A UI Automation or MSAA action, on the pattern or object it acts through.
pub(crate) enum A11y<'a> {
    Invoke(&'a IUIAutomationInvokePattern),
    Toggle(&'a IUIAutomationTogglePattern),
    Expand(&'a IUIAutomationExpandCollapsePattern),
    Collapse(&'a IUIAutomationExpandCollapsePattern),
    SetValue(&'a IUIAutomationValuePattern, &'a BSTR),
    Select(&'a IUIAutomationSelectionItemPattern),
    Scroll(&'a IUIAutomationScrollPattern, bool, ScrollAmount),
    DefaultAction(&'a IAccessible, i32),
    PutValue(&'a IAccessible, i32, &'a BSTR),
}

impl A11y<'_> {
    fn name(&self) -> &'static str {
        match self {
            A11y::Invoke(_) => "invoke",
            A11y::Toggle(_) => "toggle",
            A11y::Expand(_) => "expand",
            A11y::Collapse(_) => "collapse",
            A11y::SetValue(..) => "set_value",
            A11y::Select(_) => "select",
            A11y::Scroll(..) => "scroll",
            A11y::DefaultAction(..) => "default_action",
            A11y::PutValue(..) => "put_value",
        }
    }
}

/// A launch through the shell or the activation broker.
pub(crate) enum Launch<'a> {
    Shell(&'a str),
    AppId(&'a str),
}

/// Clipboard text staged before its admission (the global memory the clipboard takes over once set).
pub(crate) struct Staged(pub(crate) Option<real::Global>);

/// The activation broker created by one admitted call, used by the next.
pub(crate) struct Broker(pub(crate) Option<windows::Win32::UI::Shell::IApplicationActivationManager>);

/// The raw Windows calls: each mutating method is exactly one invocation of one external API (one primitive). The real driver
/// is private to this module; a test hands the port a fake one. Reads (`hung`, `owner`, `foreground`, `iconic`,
/// `current_thread`, `wait`) and preparation (`stage_text`) change nothing.
pub(crate) trait WinDriver: Send + Sync {
    /// Called before each admission: a test holds a submission here.
    fn preflight(&self, _what: &str) {}
    /// `SendInput` through the cross-process receipt: how many events the system took. The driver takes the receipt's lock
    /// first (a wait on other processes, never under admission), then admits the batch with `admission` right before the system
    /// call (`None`: owned releases, sent whatever the scope says). An error means nothing reached the system.
    fn send_input(&self, events: &[Event], admission: Option<&Scope>) -> Result<u32, String>;
    fn hung(&self, window: Wid) -> bool;
    fn owner(&self, window: Wid) -> (u32, u32);
    fn foreground(&self) -> Wid;
    fn iconic(&self, window: Wid) -> bool;
    fn current_thread(&self) -> u32;
    /// `SendMessageCallbackW`.
    fn enqueue(&self, window: Wid, message: Message) -> Result<Reply, Refusal>;
    /// Waits for a queued message's reply (pumping this thread's queue); None at the timeout.
    fn wait(&self, reply: &Reply, timeout: Duration) -> Option<usize>;
    /// `PostMessageW`.
    fn post(&self, window: Wid, message: Posted) -> Result<(), Refusal>;
    /// `AttachThreadInput`; whether it succeeded.
    fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool;
    fn bring_to_top(&self, window: Wid);
    fn set_foreground(&self, window: Wid);
    fn set_active(&self, window: Wid);
    fn set_focus(&self, window: Wid);
    /// The reserved no-name key pressed and released in one `SendInput` batch.
    fn no_name_key(&self);
    /// `ShowWindowAsync`.
    fn show_async(&self, window: Wid, state: WinState);
    /// `SetWindowPos` with `SWP_ASYNCWINDOWPOS`; whether it was accepted.
    fn place_async(&self, window: Wid, x: i32, y: i32, width: i32, height: i32) -> bool;
    fn terminate(&self, pid: u32) -> Result<(), String>;
    /// `SetWindowLongW` of the no-activate bit; whether it is set afterwards (read back).
    fn set_no_activate(&self, root: Wid, on: bool) -> bool;
    /// `EnableWindow`.
    fn set_enabled(&self, window: Wid, enabled: bool);
    fn accessibility(&self, action: &A11y<'_>) -> Result<(), String>;
    /// Prepares clipboard text; no external effect.
    fn stage_text(&self, text: &str) -> Result<Staged, String>;
    /// `EmptyClipboard` on the opened clipboard.
    fn clipboard_empty(&self) -> Result<(), String>;
    /// `SetClipboardData` of staged text.
    fn clipboard_set(&self, staged: Staged) -> Result<(), String>;
    /// `ShellExecuteExW`: the launched process, 0 when the shell names none.
    fn shell_execute(&self, target: &str) -> windows::core::Result<u32>;
    /// `CoCreateInstance` of the activation broker.
    fn create_broker(&self) -> windows::core::Result<Broker>;
    /// `IApplicationActivationManager::ActivateApplication`.
    fn activate_application(&self, broker: &Broker, app_id: &str) -> windows::core::Result<u32>;
}

/// The events one attempt sends, each with the index of the part it comes from.
fn outgoing_events(parts: &[Part], admitted: bool) -> Vec<(usize, Event)> {
    parts
        .iter()
        .enumerate()
        .filter_map(|(at, part)| match part {
            Part::Ordinary(event) if admitted => Some((at, *event)),
            Part::Unowned(hold) if admitted => release_event(hold).map(|event| (at, event)),
            Part::Owned(receipt) => release_event(&receipt.hold).map(|event| (at, event)),
            _ => None,
        })
        .collect()
}

/// One executor's Windows port.
pub(crate) struct WinPort {
    scope: Scope,
    driver: Box<dyn WinDriver>,
    ledger: Ledger<Hold>,
    /// Releases queued to a window and not acknowledged yet: a later release of the same hold waits for this reply.
    queued: Mutex<Vec<(Wid, Wid, Pressed, Reply)>>,
}

/// Each button's up flag is its down flag shifted left once.
const BUTTON_DOWNS: [u32; 3] = [0x0002, 0x0008, 0x0020];

/// Flags that only qualify a pointer event's coordinates: alone they do nothing.
const COORDINATE_FLAGS: u32 = 0x8000 | 0x4000;

/// A caller's `SendInput` event taken apart: what is not a release (motion, a wheel, a press, a key down), and each release
/// it carries. The release parts are never sent as the caller wrote them.
fn split(event: &Event) -> (Option<Event>, Vec<Hold>) {
    match *event {
        Event::Key { vk, scan, flags } if flags & KEY_UP != 0 => (None, vec![Hold::Key { vk, scan, flags: flags & !KEY_UP }]),
        Event::Key { .. } => (Some(*event), Vec::new()),
        Event::Mouse { flags, dx, dy, data } => {
            let ups: Vec<u32> = BUTTON_DOWNS.iter().map(|down| down << 1).filter(|up| flags & up != 0).collect();
            let rest = flags & !ups.iter().fold(0, |all, up| all | up);
            let rest = (rest & !COORDINATE_FLAGS != 0).then_some(Event::Mouse { flags: rest, dx, dy, data });
            (rest, ups.into_iter().map(|up| Hold::Button(up >> 1)).collect())
        }
    }
}

/// What a sent event presses.
fn presses(event: &Event) -> Vec<Hold> {
    match *event {
        Event::Key { vk, scan, flags } if flags & KEY_UP == 0 => vec![Hold::Key { vk, scan, flags }],
        Event::Key { .. } => Vec::new(),
        Event::Mouse { flags, .. } => BUTTON_DOWNS.iter().filter(|down| flags & **down != 0).map(|down| Hold::Button(*down)).collect(),
    }
}

/// One part of a caller's batch as the port sends it.
enum Part {
    /// Not a release: an ordinary submission (a press is recorded once the system took it).
    Ordinary(Event),
    /// A release this port holds a receipt for (taken out, so consumed exactly once): sent as the receipt's own release.
    Owned(Receipt<Hold>),
    /// A release the revocation cleanup already sent: nothing to send.
    Drained,
    /// A release without a receipt: an ordinary submission of the bare release the hold names.
    Unowned(Hold),
}

/// The release that lets go of a system hold.
fn release_event(hold: &Hold) -> Option<Event> {
    match *hold {
        Hold::Key { vk, scan, flags } => Some(Event::key(vk, scan, flags | KEY_UP)),
        Hold::Button(down) => Some(Event::mouse(down << 1)),
        _ => None,
    }
}

impl WinPort {
    /// The port of the executor this process runs: real Windows behind it.
    pub(crate) fn new(scope: &Scope, marker: i64) -> Arc<WinPort> {
        WinPort::with_driver(scope, Box::new(real::Real::new(marker)))
    }

    pub(crate) fn with_driver(scope: &Scope, driver: Box<dyn WinDriver>) -> Arc<WinPort> {
        let port = Arc::new(WinPort { scope: scope.clone(), driver, ledger: Ledger::new(scope.epoch()), queued: Mutex::new(Vec::new()) });
        port.ledger.observe(scope);
        scope.hold(Arc::downgrade(&(port.clone() as Arc<dyn Holder>)));
        port
    }

    pub(crate) fn scope(&self) -> &Scope {
        &self.scope
    }

    /// Admits one external call (one primitive): refused once the scope is closed.
    fn admit(&self, what: &str, boundary: Boundary) -> Result<Admitted<'_>, String> {
        self.driver.preflight(what);
        self.scope.admit(boundary)
    }

    // --- SendInput ---------------------------------------------------------------------------------------------------------

    /// Hands one batch to `SendInput`. Each event is taken apart (`split`): a release part with a receipt is sent as the
    /// receipt's own release and consumes it, whatever the scope says; everything else is an ordinary submission, refused after
    /// Off (then the owned releases still go out and the call answers the refusal). The accepted prefix decides what the port
    /// holds; a partly accepted batch lets go at once of what it pressed and is never sent again.
    pub(crate) fn input(&self, events: &[Event]) -> Result<(), String> {
        let _releasing = self.ledger.releasing();
        let parts = self.plan_parts(events);
        let ordinary = parts.iter().any(|part| matches!(part, Part::Ordinary(_) | Part::Unowned(_)));
        let mut admitted = ordinary && !self.scope.is_revoked();
        if admitted {
            self.driver.preflight("input");
        }
        loop {
            let outgoing = outgoing_events(&parts, admitted);
            let batch: Vec<Event> = outgoing.iter().map(|(_, event)| *event).collect();
            let sent = if batch.is_empty() { Ok(0) } else { self.driver.send_input(&batch, admitted.then_some(&self.scope)) };
            let sent = match sent {
                // Revoked between the plan and the admission: nothing went out; the owned releases still go.
                Err(refused) if admitted && refused == super::REVOKED => {
                    admitted = false;
                    continue;
                }
                Err(error) => {
                    self.restore_unsent(parts, &[]);
                    return Err(error);
                }
                Ok(sent) => (sent as usize).min(batch.len()),
            };
            let accepted = &outgoing[..sent];
            let mut pressed = Vec::new();
            for (at, event) in accepted {
                match &parts[*at] {
                    Part::Ordinary(_) => {
                        for hold in presses(event) {
                            if self.ledger.find(|held| *held == hold).is_none() {
                                pressed.push(self.ledger.record(hold));
                            }
                        }
                    }
                    // A bare release sent while open lets go of a press this same batch made.
                    Part::Unowned(hold) => {
                        if let Owned::Held(receipt) = self.ledger.take(|held| held == hold) {
                            self.ledger.released(&receipt);
                        }
                    }
                    _ => {}
                }
            }
            let sent_parts: Vec<usize> = accepted.iter().map(|(at, _)| *at).collect();
            let refused = parts.iter().any(|part| matches!(part, Part::Ordinary(_) | Part::Unowned(_))) && !admitted;
            let complete = sent == batch.len();
            self.restore_unsent(parts, &sent_parts);
            if !complete {
                // A partly accepted batch: what it pressed is let go of now, from the receipts just taken.
                for receipt in pressed {
                    if let Owned::Held(receipt) = self.ledger.take(|held| *held == receipt.hold) {
                        self.send_owned(receipt);
                    }
                }
                let releases_only = !ordinary;
                return Err(if releases_only { RELEASE_REJECTED } else { DELIVERY_FAILED }.into());
            }
            return if refused { Err(super::REVOKED.into()) } else { Ok(()) };
        }
    }

    /// Takes each event apart into its ordinary part and the releases it carries, taking the receipt each release names.
    fn plan_parts(&self, events: &[Event]) -> Vec<Part> {
        let mut parts = Vec::new();
        for event in events {
            let (rest, releases) = split(event);
            parts.extend(rest.map(Part::Ordinary));
            for hold in releases {
                parts.push(match self.ledger.take(|held| *held == hold) {
                    Owned::Held(receipt) => Part::Owned(receipt),
                    Owned::Drained => Part::Drained,
                    Owned::None => Part::Unowned(hold),
                });
            }
        }
        parts
    }

    /// Ends the release of each owned part: consumed when it went out, held again when it did not.
    fn restore_unsent(&self, parts: Vec<Part>, sent: &[usize]) {
        for (at, part) in parts.into_iter().enumerate() {
            if let Part::Owned(receipt) = part {
                if sent.contains(&at) {
                    self.ledger.released(&receipt);
                } else {
                    self.ledger.restore(receipt);
                }
            }
        }
    }

    /// Sends the release a system receipt names, whatever the scope says; the receipt goes back when it was not taken.
    fn send_owned(&self, receipt: Receipt<Hold>) -> bool {
        let Some(event) = release_event(&receipt.hold) else { return false };
        let sent = self.driver.send_input(std::slice::from_ref(&event), None) == Ok(1);
        if sent {
            self.ledger.released(&receipt);
        } else {
            self.ledger.restore(receipt);
        }
        sent
    }

    // --- a window's queue --------------------------------------------------------------------------------------------------

    /// One message to `target` (a window of `top`), queued without waiting for its handling. A press records the receipt of
    /// what it holds once queued, whatever its reply then says; a release with a receipt sends the release the receipt names
    /// (never the caller's payload) whatever the scope says; a motion while a button is held moves the release point with it.
    pub(crate) fn message(&self, top: Wid, target: Wid, message: Message) -> Result<Reply, Refusal> {
        if let Some(pressed) = message.release() {
            return match self.release_pressed(top, target, pressed) {
                Some(released) => released,
                None => self.queue(top, target, message),
            };
        }
        self.queue(top, target, message)
    }

    fn queue(&self, top: Wid, target: Wid, message: Message) -> Result<Reply, Refusal> {
        self.driver.preflight("message");
        if self.driver.hung(target) {
            return Err(Refusal::Hung);
        }
        let owner = self.driver.owner(target);
        let held = self.ledger.holds().into_iter().filter_map(|hold| match hold {
            Hold::Queue { target: held, pressed: Pressed::Button(button), .. } if held == target => Some(button),
            _ => None,
        });
        let message = match message {
            // A motion while a button is held carries the button, as a person's drag does.
            Message::MouseMove { flags, point } => Message::MouseMove { flags: held.fold(flags, |flags, button| flags | button.down().1), point },
            other => other,
        };
        let _admitted = self.scope.admit(Boundary::HandOver).map_err(|_| Refusal::Revoked)?;
        let reply = self.driver.enqueue(target, message)?;
        if let Some((pressed, release)) = message.press() {
            self.ledger.record(Hold::Queue { top, target, owner, pressed, release });
        }
        if let Message::MouseMove { point, .. } = message {
            self.ledger.update(
                |hold| matches!(hold, Hold::Queue { target: held, pressed: Pressed::Button(_), .. } if *held == target),
                |hold| {
                    if let Hold::Queue { release: Message::ButtonUp { point: release, .. }, .. } = hold {
                        *release = point;
                    }
                },
            );
        }
        Ok(reply)
    }

    /// Lets go of what `top`'s queue holds for `pressed` (in `target`, or in any window of `top` when it is 0): the release its
    /// receipt names, queued whatever the scope says. A release queued earlier and not acknowledged yet answers its own reply
    /// again (it is never sent twice); None when the port holds nothing there. A window gone or reused by another owner since
    /// the press holds nothing: its receipt is consumed and nothing is sent.
    pub(crate) fn release_pressed(&self, top: Wid, target: Wid, pressed: Pressed) -> Option<Result<Reply, Refusal>> {
        let _releasing = self.ledger.releasing();
        let wanted = |hold: &Hold| {
            matches!(hold, Hold::Queue { top: held_top, target: held, pressed: held_pressed, .. }
                if *held_top == top && (*held == target || target == 0) && *held_pressed == pressed)
        };
        match self.ledger.take(wanted) {
            Owned::Held(receipt) => Some(self.send_release(receipt)),
            Owned::Drained => Some(Ok(Reply::answered(0))),
            Owned::None => {
                let queued = self.queued.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                queued
                    .iter()
                    .find(|(held_top, held, held_pressed, _)| *held_top == top && (*held == target || target == 0) && *held_pressed == pressed)
                    .map(|(.., reply)| Ok(reply.clone()))
            }
        }
    }

    fn send_release(&self, receipt: Receipt<Hold>) -> Result<Reply, Refusal> {
        let Hold::Queue { top, target, owner, pressed, release } = receipt.hold else {
            unreachable!("a queue receipt");
        };
        if self.driver.owner(target) != owner || owner == (0, 0) {
            // Gone or reused: nothing of ours is left there; the receipt is consumed.
            self.ledger.released(&receipt);
            return Err(Refusal::Gone);
        }
        match self.driver.enqueue(target, release) {
            Ok(reply) => {
                self.ledger.released(&receipt);
                self.queued.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((top, target, pressed, reply.clone()));
                Ok(reply)
            }
            Err(refusal) => {
                // Not queued: the receipt stays for a later release.
                self.ledger.restore(receipt);
                Err(refusal)
            }
        }
    }

    /// Lets go of a button `top`'s queue holds through its receipt alone: no motion and no hold of its own.
    pub(crate) fn release_button(&self, top: Wid, button: MouseButton) -> Option<Result<Reply, Refusal>> {
        self.release_pressed(top, 0, Pressed::Button(button))
    }

    /// Waits for a reply (data); a release acknowledged now is forgotten.
    pub(crate) fn wait(&self, reply: &Reply, timeout: Duration) -> Option<usize> {
        let answer = self.driver.wait(reply, timeout);
        if answer.is_some() {
            self.queued.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|(.., queued)| queued.get().is_none());
        }
        answer
    }

    /// `PostMessageW`: local.
    pub(crate) fn post(&self, window: Wid, message: Posted) -> Result<(), Refusal> {
        let _admitted = self.admit("post", Boundary::Local).map_err(|_| Refusal::Revoked)?;
        self.driver.post(window, message)
    }

    // --- foreground, focus and placement -----------------------------------------------------------------------------------

    /// One activation try: a sequence of individually admitted primitives (attach the input queues, restore, raise, foreground,
    /// activate, focus), each a hand-over, stopping at the first refused one. The attachments are holds: each is detached by its
    /// receipt whatever the scope says (receipt-derived teardown). Whether the window holds the foreground afterwards.
    pub(crate) fn focus_try(&self, window: Wid) -> bool {
        let current = self.driver.foreground();
        if current == window && !self.driver.iconic(window) {
            return true;
        }
        let this = self.driver.current_thread();
        let mut threads = vec![self.driver.owner(current).1];
        let target_thread = self.driver.owner(window).1;
        if !threads.contains(&target_thread) {
            threads.push(target_thread);
        }
        let attached: Vec<u32> = threads.into_iter().filter(|thread| *thread != 0 && *thread != this).filter(|thread| self.attach(this, *thread)).collect();
        let steps = || -> Result<(), String> {
            if self.driver.iconic(window) {
                let _admitted = self.admit("restore", Boundary::HandOver)?;
                self.driver.show_async(window, WinState::Restore);
            }
            {
                let _admitted = self.admit("bring_to_top", Boundary::HandOver)?;
                self.driver.bring_to_top(window);
            }
            {
                let _admitted = self.admit("foreground", Boundary::HandOver)?;
                self.driver.set_foreground(window);
            }
            {
                let _admitted = self.admit("active", Boundary::HandOver)?;
                self.driver.set_active(window);
            }
            let _admitted = self.admit("focus", Boundary::HandOver)?;
            self.driver.set_focus(window);
            Ok(())
        };
        let stepped = steps();
        let landed = stepped.is_ok() && self.driver.foreground() == window;
        for thread in attached {
            self.detach(this, thread);
        }
        landed
    }

    /// Attaches this thread's input to `to`'s: a pending hold until `AttachThreadInput` answered, then held (or compensated at
    /// once when the scope closed meanwhile). Whether it is attached.
    fn attach(&self, from: u32, to: u32) -> bool {
        let ticket = self.ledger.begin(Hold::Attached { from, to });
        let attached = match self.admit("attach", Boundary::HandOver) {
            Ok(_admitted) => self.driver.attach_input(from, to, true),
            Err(_) => {
                self.ledger.settle(ticket, Outcome::NotApplied);
                return false;
            }
        };
        let settled = self.ledger.settle(ticket, if attached { Outcome::Applied } else { Outcome::NotApplied });
        if let Settled::Compensate(receipt) = settled {
            self.compensate(receipt);
            return false;
        }
        attached
    }

    /// Detaches through the attachment's receipt, whatever the scope says.
    fn detach(&self, from: u32, to: u32) {
        if let Owned::Held(receipt) = self.ledger.take(|hold| *hold == Hold::Attached { from, to }) {
            if self.driver.attach_input(from, to, false) {
                self.ledger.released(&receipt);
            } else {
                self.ledger.restore(receipt);
            }
        }
    }

    /// `SetForegroundWindow`: a hand-over (the foreground change runs the windows' activation code).
    pub(crate) fn set_foreground(&self, window: Wid) -> Result<(), String> {
        let _admitted = self.admit("foreground", Boundary::HandOver)?;
        self.driver.set_foreground(window);
        Ok(())
    }

    /// Restores a minimized window (`ShowWindowAsync`); nothing to do for one that is not.
    pub(crate) fn restore(&self, window: Wid) -> Result<(), String> {
        if !self.driver.iconic(window) {
            return Ok(());
        }
        let _admitted = self.admit("restore", Boundary::HandOver)?;
        self.driver.show_async(window, WinState::Restore);
        Ok(())
    }

    /// The reserved no-name key pressed and released in one `SendInput` batch: the system counts it as this process's latest
    /// input. Local.
    pub(crate) fn grant_foreground(&self) -> Result<(), String> {
        let _admitted = self.admit("grant", Boundary::Local)?;
        self.driver.no_name_key();
        Ok(())
    }

    /// `ShowWindowAsync`.
    pub(crate) fn show(&self, window: Wid, state: WinState) -> Result<(), String> {
        let _admitted = self.admit("show", Boundary::HandOver)?;
        self.driver.show_async(window, state);
        Ok(())
    }

    /// Two primitives: restore (`ShowWindowAsync`), then place (`SetWindowPos` asynchronously), each admitted.
    pub(crate) fn move_window(&self, window: Wid, x: i32, y: i32, width: i32, height: i32) -> Result<bool, String> {
        {
            let _admitted = self.admit("restore", Boundary::HandOver)?;
            self.driver.show_async(window, WinState::Restore);
        }
        let _admitted = self.admit("move", Boundary::HandOver)?;
        Ok(self.driver.place_async(window, x, y, width, height))
    }

    /// `TerminateProcess`: local.
    pub(crate) fn terminate(&self, pid: u32) -> Result<(), String> {
        let _admitted = self.admit("terminate", Boundary::Local)?;
        self.driver.terminate(pid)
    }

    // --- holds on other applications' windows ------------------------------------------------------------------------------

    /// Runs the stored compensation of a hold applied after its release was asked for (receipt-derived: whatever the scope
    /// says), then tells the scope its report changed.
    fn compensate(&self, receipt: Receipt<Hold>) {
        let done = self.undo(&receipt.hold);
        // The ledger publishes the transition.
        self.ledger.compensated(receipt, done);
    }

    /// The teardown a hold's receipt names; whether it took.
    fn undo(&self, hold: &Hold) -> bool {
        match hold {
            Hold::Key { .. } | Hold::Button(_) => {
                let event = release_event(hold).expect("a system hold");
                self.driver.send_input(std::slice::from_ref(&event), None) == Ok(1)
            }
            // Gone or reused: nothing of ours is left there.
            Hold::Queue { target, owner, release, .. } => self.driver.owner(*target) != *owner || self.driver.enqueue(*target, *release).is_ok(),
            Hold::NoActivate(root) => !self.driver.set_no_activate(*root, false),
            Hold::Disabled(window) => {
                self.driver.set_enabled(*window, true);
                true
            }
            Hold::Attached { from, to } => self.driver.attach_input(*from, *to, false),
        }
    }

    /// Puts the no-activate bit on `root` (`SetWindowLongW`, a hand-over: the style change is sent to the window). The hold is
    /// pending while the call runs: a revocation or a release meanwhile marks it, and its completion then clears the bit again;
    /// no receipt lock is held across the call. Whether it is set.
    pub(crate) fn hold_no_activate(&self, root: Wid) -> Result<bool, String> {
        let ticket = self.ledger.begin(Hold::NoActivate(root));
        let set = match self.admit("no_activate", Boundary::HandOver) {
            Ok(_admitted) => self.driver.set_no_activate(root, true),
            Err(refused) => {
                self.ledger.settle(ticket, Outcome::NotApplied);
                return Err(refused);
            }
        };
        match self.ledger.settle(ticket, if set { Outcome::Applied } else { Outcome::NotApplied }) {
            Settled::Compensate(receipt) => {
                self.compensate(receipt);
                Err(super::REVOKED.into())
            }
            Settled::Done => Ok(set),
        }
    }

    /// Clears the bit this port put on `root`; false when it stays set. Without a receipt nothing is touched; a pending one is
    /// cleared by its completion.
    pub(crate) fn release_no_activate(&self, root: Wid) -> bool {
        match self.ledger.take(|hold| *hold == Hold::NoActivate(root)) {
            Owned::Held(receipt) => {
                let cleared = self.undo(&receipt.hold);
                if cleared {
                    self.ledger.released(&receipt);
                } else {
                    self.ledger.restore(receipt);
                }
                cleared
            }
            Owned::Drained | Owned::None => true,
        }
    }

    /// Disables `window` for one call (the shield; `EnableWindow`, a hand-over: `WM_ENABLE` is sent to it), pending as
    /// [`WinPort::hold_no_activate`].
    pub(crate) fn shield(&self, window: Wid) -> Result<(), String> {
        let ticket = self.ledger.begin(Hold::Disabled(window));
        match self.admit("shield", Boundary::HandOver) {
            Ok(_admitted) => self.driver.set_enabled(window, false),
            Err(refused) => {
                self.ledger.settle(ticket, Outcome::NotApplied);
                return Err(refused);
            }
        }
        match self.ledger.settle(ticket, Outcome::Applied) {
            Settled::Compensate(receipt) => {
                self.compensate(receipt);
                Err(super::REVOKED.into())
            }
            Settled::Done => Ok(()),
        }
    }

    pub(crate) fn unshield(&self, window: Wid) {
        if let Owned::Held(receipt) = self.ledger.take(|hold| *hold == Hold::Disabled(window)) {
            if self.undo(&receipt.hold) {
                self.ledger.released(&receipt);
            } else {
                self.ledger.restore(receipt);
            }
        }
    }

    // --- accessibility, clipboard, shell -----------------------------------------------------------------------------------

    /// One UI Automation or MSAA action on an element of `window`: a hand-over. A window already known not to answer is not
    /// asked (a courtesy: the fence is the admission).
    pub(crate) fn accessibility(&self, window: Wid, action: A11y<'_>) -> Result<(), String> {
        if window != 0 && self.driver.hung(window) {
            return Err(format!("background_target_hung|the window does not answer; no {} was sent", action.name()));
        }
        let _admitted = self.admit(action.name(), Boundary::HandOver)?;
        self.driver.accessibility(&action)
    }

    /// The opened clipboard emptied (`EmptyClipboard`, a hand-over: the owner is told), then the staged text set
    /// (`SetClipboardData`, a hand-over: viewers are told), each admitted; the storage is prepared before either. Off between
    /// the two leaves the clipboard cleared.
    pub(crate) fn clipboard_write(&self, text: &str) -> Result<(), String> {
        let staged = if text.is_empty() { None } else { Some(self.driver.stage_text(text)?) };
        {
            let _admitted = self.admit("clipboard_empty", Boundary::HandOver)?;
            self.driver.clipboard_empty()?;
        }
        let Some(staged) = staged else { return Ok(()) };
        let _admitted = self.admit("clipboard_set", Boundary::HandOver)?;
        self.driver.clipboard_set(staged)
    }

    /// A launch: through the shell (`ShellExecuteExW`, one hand-over), or through the activation broker (`CoCreateInstance`,
    /// then `ActivateApplication`: two hand-overs, each admitted).
    pub(crate) fn launch(&self, launch: Launch<'_>) -> Result<windows::core::Result<u32>, String> {
        match launch {
            Launch::Shell(target) => {
                let _admitted = self.admit("shell_execute", Boundary::HandOver)?;
                Ok(self.driver.shell_execute(target))
            }
            Launch::AppId(app_id) => {
                let broker = {
                    let _admitted = self.admit("create_broker", Boundary::HandOver)?;
                    self.driver.create_broker()
                };
                let broker = match broker {
                    Ok(broker) => broker,
                    Err(error) => return Ok(Err(error)),
                };
                let _admitted = self.admit("activate_application", Boundary::HandOver)?;
                Ok(self.driver.activate_application(&broker, app_id))
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn holds(&self) -> Vec<Hold> {
        self.ledger.holds()
    }
}

impl Holder for WinPort {
    fn release_held(&self) -> bool {
        let mut released = true;
        for receipt in self.ledger.drain() {
            // The ledger's take is atomic: an operation's own release and this cleanup never both get one receipt, so no lock
            // is held across a teardown that calls into a window.
            if self.undo(&receipt.hold) {
                self.ledger.drained(receipt);
            } else {
                self.ledger.fail(receipt);
                released = false;
            }
        }
        released
    }

    fn cleanup(&self) -> Cleanup {
        self.ledger.cleanup()
    }
}

#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod tests;
