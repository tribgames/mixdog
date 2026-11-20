//! The Linux executor's port. Every XTest event, X window, keymap, selection and XInput request, uinput frame, compositor
//! command, AT-SPI action, clipboard write and launch of this desktop is a typed operation here, and the code that reaches the
//! external API is here too: each operation admits one primitive (`generic::Port::admit`), invokes exactly that one call, and
//! records its completion; a compound operation is a sequence of them. The port owns its own X connection, so a press and the
//! release that follows it travel in order on one connection. Platform code holds no grant and no closure.
//!
//! Boundaries: a uinput frame is one local `write` (local). An X request is written to the server and awaited, a compositor
//! command, an AT-SPI action, a clipboard step and a launch call into other processes: hand-overs. A press is pending from
//! before its call until it completes; one whose acknowledgement failed is still owned (uncertain).
//!
//! Not offered through the port: creating this process's own private input master (no input; listed as a limit), and its
//! removal at exit (a release of what it owns).

use super::generic::{Hold, Port, Slot};
use super::{Boundary, Outcome, Scope};
use crate::platform::linux::uinput::{EV_KEY, EV_SYN, SYN_REPORT, event_bytes};
use std::fs::File;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use x11rb::CURRENT_TIME;
use x11rb::connection::Connection;
use x11rb::protocol::xinput::ConnectionExt as _;
use x11rb::protocol::xproto::{
    self, AtomEnum, ClientMessageEvent, ConfigureWindowAux, ConnectionExt as _, EventMask, InputFocus, PropMode, SelectionNotifyEvent, StackMode, Window,
};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// Whether a hold is a key or a button: the port derives every event kind from it, never from a caller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Pressable {
    Key,
    Button,
}

impl Pressable {
    /// The core XTest press and release kinds.
    fn core(self) -> (u8, u8) {
        match self {
            Pressable::Key => (xproto::KEY_PRESS_EVENT, xproto::KEY_RELEASE_EVENT),
            Pressable::Button => (xproto::BUTTON_PRESS_EVENT, xproto::BUTTON_RELEASE_EVENT),
        }
    }

    /// The XInput 1 device event offsets of the press and the release.
    fn device(self) -> (u8, u8) {
        match self {
            Pressable::Key => (1, 2),
            Pressable::Button => (3, 4),
        }
    }
}

/// A key or button one device holds; its release is derived from it alone.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum LinuxHold {
    /// XTest on the core devices.
    Core { what: Pressable, detail: u8 },
    /// XTest on a private master's device.
    Master { what: Pressable, detail: u8, device: u16 },
    /// The uinput device: the key or button code.
    Uinput { code: u16 },
}

static PORT: Slot<LinuxHold> = Slot::new();
/// The port's own X connection: every X request of this executor's, and every release, goes through it.
static X: OnceLock<Option<(RustConnection, Window)>> = OnceLock::new();
/// The uinput device this executor created.
static UINPUT: Mutex<Option<Arc<File>>> = Mutex::new(None);

fn e<T: std::fmt::Display>(error: T) -> String {
    error.to_string()
}

fn x() -> Result<&'static (RustConnection, Window), String> {
    X.get_or_init(|| crate::platform::linux::x11::connect().ok()).as_ref().ok_or_else(|| "x11_unavailable: no display".into())
}

fn port() -> Result<&'static Arc<Port<LinuxHold>>, String> {
    PORT.get()
}

/// The XInput extension's first event (a read).
fn xinput_first_event(conn: &RustConnection) -> Result<u8, String> {
    let reply = conn.query_extension(b"XInputExtension").map_err(e)?.reply().map_err(e)?;
    if !reply.present {
        return Err("background_unsupported|the X server has no XInput extension; no input sent".into());
    }
    Ok(reply.first_event)
}

/// Raw: one XTest event on the port's connection, then its acknowledgement.
fn fake(kind: u8, detail: u8, x_at: i32, y_at: i32, device: u8) -> Outcome {
    let Ok((conn, root)) = x() else { return Outcome::NotApplied };
    if conn.xtest_fake_input(kind, detail, CURRENT_TIME, *root, x_at as i16, y_at as i16, device).is_err() {
        return Outcome::NotApplied;
    }
    if conn.sync().is_ok() { Outcome::Applied } else { Outcome::Uncertain }
}

/// Raw: one uinput frame (the events, then the report that closes it) in one write: the kernel takes it whole or not at all.
fn frame(events: &[(u16, u16, i32)]) -> Outcome {
    let Some(file) = UINPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() else { return Outcome::NotApplied };
    let mut bytes = Vec::new();
    for &(kind, code, value) in events.iter().chain(std::iter::once(&(EV_SYN, SYN_REPORT, 0))) {
        bytes.extend_from_slice(&event_bytes(kind, code, value));
    }
    let mut writer = &*file;
    if writer.write_all(&bytes).is_ok() { Outcome::Applied } else { Outcome::NotApplied }
}

impl Hold for LinuxHold {
    fn release(&self) -> bool {
        match *self {
            LinuxHold::Core { what, detail } => fake(what.core().1, detail, 0, 0, 0) == Outcome::Applied,
            LinuxHold::Master { what, detail, device } => x()
                .and_then(|(conn, _)| xinput_first_event(conn))
                .is_ok_and(|first| fake(first + what.device().1, detail, 0, 0, device as u8) == Outcome::Applied),
            LinuxHold::Uinput { code } => frame(&[(EV_KEY, code, 0)]) == Outcome::Applied,
        }
    }

    fn boundary(&self) -> Boundary {
        match self {
            LinuxHold::Uinput { .. } => Boundary::Local,
            _ => Boundary::HandOver,
        }
    }
}

pub(crate) fn install(scope: &Scope) {
    PORT.install(Port::new(scope));
}

/// Whether the executor's scope is closed: a wait reads it to end early; never a fence.
pub(crate) fn revoked() -> bool {
    port().map_or(true, |port| port.revoked())
}

fn delivered(outcome: Outcome) -> Result<(), String> {
    match outcome {
        Outcome::Applied => Ok(()),
        Outcome::NotApplied => Err("input_delivery_failed: the request was not sent".into()),
        Outcome::Uncertain => Err("input_cleanup_unconfirmed: the request's acknowledgement failed".into()),
    }
}

/// A press: pending from before its one call until it completes.
fn press(hold: LinuxHold, boundary: Boundary, raw: impl FnOnce() -> Outcome) -> Result<(), String> {
    let port = port()?;
    let ticket = port.begin(hold);
    let outcome = match port.admit(boundary) {
        Ok(_admitted) => raw(),
        Err(refused) => {
            port.finish(ticket, Outcome::NotApplied);
            return Err(refused);
        }
    };
    port.finish(ticket, outcome);
    delivered(outcome)
}

// --- XTest on the core devices ------------------------------------------------------------------------------------------

/// A press, release or motion on the core pointer or keyboard.
pub(crate) fn core_event(kind: u8, detail: u8, x_at: i32, y_at: i32) -> Result<(), String> {
    let what = |key| if key { Pressable::Key } else { Pressable::Button };
    match kind {
        xproto::KEY_PRESS_EVENT | xproto::BUTTON_PRESS_EVENT => {
            let hold = LinuxHold::Core { what: what(kind == xproto::KEY_PRESS_EVENT), detail };
            let pressed = what(kind == xproto::KEY_PRESS_EVENT).core().0;
            press(hold, Boundary::HandOver, || fake(pressed, detail, x_at, y_at, 0))
        }
        xproto::KEY_RELEASE_EVENT | xproto::BUTTON_RELEASE_EVENT => port()?.release(&LinuxHold::Core { what: what(kind == xproto::KEY_RELEASE_EVENT), detail }),
        _ => {
            let _admitted = port()?.admit(Boundary::HandOver)?;
            delivered(fake(xproto::MOTION_NOTIFY_EVENT, 0, x_at, y_at, 0))
        }
    }
}

// --- a private master's devices -----------------------------------------------------------------------------------------

/// A press or release on a private master's XTest device (`offset`: the XInput 1 device event offset).
pub(crate) fn device_event(offset: u8, detail: u8, device: u16) -> Result<(), String> {
    let (what, down) = match offset {
        1 => (Pressable::Key, true),
        2 => (Pressable::Key, false),
        3 => (Pressable::Button, true),
        4 => (Pressable::Button, false),
        other => return Err(format!("input_delivery_failed: device event {other} is not offered")),
    };
    let hold = LinuxHold::Master { what, detail, device };
    if !down {
        return port()?.release(&hold);
    }
    let first = xinput_first_event(&x()?.0)?;
    press(hold, Boundary::HandOver, || fake(first + what.device().0, detail, 0, 0, device as u8))
}

// --- X requests ---------------------------------------------------------------------------------------------------------

/// The X requests this executor makes on its own connection, other than input: each one request.
pub(crate) enum XRequest {
    /// A window-manager request (EWMH client message to the root).
    ClientMessage {
        window: Window,
        kind: xproto::Atom,
        data: [u32; 5],
    },
    /// A direct raise, for a window manager that ignores the request.
    Raise {
        window: Window,
    },
    /// A direct input focus, after the raise.
    Focus {
        window: Window,
    },
    Configure {
        window: Window,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    /// Gives up the clipboard selection.
    ClearSelection {
        selection: xproto::Atom,
    },
    /// Puts a private master's pointer at a point.
    Warp {
        x: i32,
        y: i32,
        pointer: u16,
    },
    /// A private master's keyboard focus.
    DeviceFocus {
        window: Window,
        keyboard: u16,
    },
}

/// One X request, admitted and awaited; its answer is data.
pub(crate) fn x_request(request: XRequest) -> Result<(), String> {
    let (conn, root) = x()?;
    let _admitted = port()?.admit(Boundary::HandOver)?;
    match request {
        XRequest::ClientMessage { window, kind, data } => {
            let event = ClientMessageEvent::new(32, window, kind, data);
            conn.send_event(false, *root, EventMask::SUBSTRUCTURE_NOTIFY | EventMask::SUBSTRUCTURE_REDIRECT, event).map_err(e)?;
        }
        XRequest::Raise { window } => {
            conn.configure_window(window, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE)).map_err(e)?;
        }
        XRequest::Focus { window } => {
            conn.set_input_focus(InputFocus::PARENT, window, CURRENT_TIME).map_err(e)?;
        }
        XRequest::Configure { window, x, y, width, height } => {
            let aux = ConfigureWindowAux::new().x(x).y(y).width(width as u32).height(height as u32);
            conn.configure_window(window, &aux).map_err(e)?;
        }
        XRequest::ClearSelection { selection } => {
            conn.set_selection_owner(x11rb::NONE, selection, CURRENT_TIME).map_err(e)?;
        }
        XRequest::Warp { x, y, pointer } => {
            conn.xinput_xi_warp_pointer(x11rb::NONE, *root, 0, 0, 0, 0, x << 16, y << 16, pointer)
                .map_err(|error| format!("background_message_rejected|{error}"))?;
        }
        XRequest::DeviceFocus { window, keyboard } => {
            conn.xinput_xi_set_focus(window, CURRENT_TIME, keyboard).map_err(e)?;
        }
    }
    conn.sync().map_err(e)
}

/// A keycode this port borrowed for a symbol the layout lacks: issued only once the port actually changed the mapping, and
/// consumed by [`return_keycode`]. Not cloneable, and not constructible outside the port.
pub(crate) struct Borrowed {
    code: u8,
}

impl Borrowed {
    pub(crate) fn code(&self) -> u8 {
        self.code
    }
}

/// Borrows a spare keycode for `syms` (the keymap is shared with every client: a submission of its own).
pub(crate) fn borrow_keycode(code: u8, syms: [u32; 2]) -> Result<Borrowed, String> {
    let (conn, _) = x()?;
    let _admitted = port()?.admit(Boundary::HandOver)?;
    conn.change_keyboard_mapping(1, code, 2, &syms).map_err(e)?;
    conn.sync().map_err(e)?;
    Ok(Borrowed { code })
}

/// Returns a borrowed keycode to having no symbols: the release of what this port borrowed, whatever the scope says.
pub(crate) fn return_keycode(borrowed: Borrowed) {
    if let Ok((conn, _)) = x() {
        let _ = conn.change_keyboard_mapping(1, borrowed.code, 2, &[0, 0]);
        let _ = conn.sync();
    }
}

// --- the clipboard owner's connection -----------------------------------------------------------------------------------

/// One request of the clipboard owner (a thread of this executor's, on its own connection): admitted when it acts.
pub(crate) enum Selection<'a> {
    /// Takes the selection for the owner's window.
    Own {
        window: Window,
        selection: xproto::Atom,
    },
    /// Writes a requestor's property: 32-bit atoms, or 8-bit text.
    Atoms {
        requestor: Window,
        property: xproto::Atom,
        atoms: &'a [u32],
    },
    Text {
        requestor: Window,
        property: xproto::Atom,
        target: xproto::Atom,
        bytes: &'a [u8],
    },
    /// Tells the requestor the conversion is done.
    Notify(SelectionNotifyEvent),
}

pub(crate) fn selection(conn: &RustConnection, request: Selection<'_>) -> Result<(), String> {
    let _admitted = port()?.admit(Boundary::HandOver)?;
    match request {
        Selection::Own { window, selection } => {
            conn.set_selection_owner(window, selection, CURRENT_TIME).map_err(e)?;
        }
        Selection::Atoms { requestor, property, atoms } => {
            conn.change_property32(PropMode::REPLACE, requestor, property, AtomEnum::ATOM, atoms).map_err(e)?;
        }
        Selection::Text { requestor, property, target, bytes } => {
            conn.change_property8(PropMode::REPLACE, requestor, property, target, bytes).map_err(e)?;
        }
        Selection::Notify(notify) => {
            conn.send_event(false, notify.requestor, EventMask::NO_EVENT, notify).map_err(e)?;
        }
    }
    conn.flush().map_err(e)
}

// --- uinput -------------------------------------------------------------------------------------------------------------

/// The uinput device this executor created.
pub(crate) fn register_uinput(file: Arc<File>) {
    *UINPUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(file);
}

/// A frame that holds nothing: an absolute move or one wheel step.
pub(crate) enum Frame {
    Move { x: i32, y: i32 },
    Wheel { code: u16, value: i32 },
}

pub(crate) fn uinput_frame(motion: Frame) -> Result<(), String> {
    const EV_REL: u16 = 2;
    const EV_ABS: u16 = 3;
    let events: Vec<(u16, u16, i32)> = match motion {
        Frame::Move { x, y } => vec![(EV_ABS, 0, x), (EV_ABS, 1, y)],
        Frame::Wheel { code, value } => vec![(EV_REL, code, value)],
    };
    let _admitted = port()?.admit(Boundary::Local)?;
    delivered(frame(&events))
}

/// A key or button on the uinput device: a press owned from its write, a release the hold's own frame.
pub(crate) fn uinput_key(code: u16, down: bool) -> Result<(), String> {
    let hold = LinuxHold::Uinput { code };
    if down { press(hold, Boundary::Local, || frame(&[(EV_KEY, code, 1)])) } else { port()?.release(&hold) }
}

// --- providers ----------------------------------------------------------------------------------------------------------

/// One AT-SPI request that changes the application (an action, a text or value write, a selection), handed over to it.
pub(crate) fn atspi_act<B, R>(
    bus: &zbus::blocking::Connection,
    node: &(String, zbus::zvariant::OwnedObjectPath),
    interface: &str,
    method: &str,
    body: &B,
) -> Result<R, String>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
    R: for<'d> serde::Deserialize<'d> + zbus::zvariant::Type,
{
    let reply = {
        let _admitted = port()?.admit(Boundary::HandOver)?;
        bus.call_method(Some(node.0.as_str()), node.1.as_str(), Some(interface), method, body).map_err(e)?
    };
    reply.body().deserialize::<R>().map_err(e)
}

/// The compositor programs a command may run.
#[derive(Clone, Copy)]
pub(crate) enum Program {
    Swaymsg,
    Hyprctl,
}

/// One compositor command, handed over.
pub(crate) fn compositor_command(program: Program, args: &[&str]) -> Result<(), String> {
    let name = match program {
        Program::Swaymsg => "swaymsg",
        Program::Hyprctl => "hyprctl",
    };
    let output = {
        let _admitted = port()?.admit(Boundary::HandOver)?;
        Command::new(name).args(args).output().map_err(|error| format!("{name}: {error}"))?
    };
    if output.status.success() { Ok(()) } else { Err(format!("{name}: {}", String::from_utf8_lossy(&output.stderr).trim())) }
}

/// One window request to GNOME Shell's Mixdog extension, handed over.
pub(crate) fn gnome_window<B>(method: &str, body: &B) -> Result<(), String>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let bus = zbus::blocking::Connection::session().map_err(e)?;
    let _admitted = port()?.admit(Boundary::HandOver)?;
    bus.call_method(Some("org.gnome.Shell"), "/io/mixdog/Windows", Some("io.mixdog.Windows"), method, body).map(|_| ()).map_err(e)
}

/// Starts `program` detached from this host's session, handed over; its pid.
pub(crate) fn spawn_detached(program: &str, arguments: &[String]) -> std::io::Result<u32> {
    let mut command = Command::new(program);
    command.args(arguments).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid in the child only detaches it from this host's session.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let _admitted = port().and_then(|port| port.admit(Boundary::HandOver)).map_err(std::io::Error::other)?;
    command.spawn().map(|child| child.id())
}

/// Ends a process (one local signal; the wait for its exit holds nothing).
pub(crate) fn terminate(pid: i64) -> Result<(), String> {
    port()?.terminate(pid)
}

/// The Wayland clipboard through `wl-copy`: cleared (one spawn), or given `text` (the spawn, then the text written to it:
/// two hand-overs, each admitted). Whether `wl-copy` took it.
pub(crate) fn wl_copy(text: &str, hint: &str) -> Result<bool, String> {
    if text.is_empty() {
        let _admitted = port()?.admit(Boundary::HandOver)?;
        return Command::new("wl-copy").arg("--clear").status().map(|status| status.success()).map_err(|_| hint.to_string());
    }
    let mut child = {
        let _admitted = port()?.admit(Boundary::HandOver)?;
        Command::new("wl-copy").stdin(Stdio::piped()).spawn().map_err(|_| hint.to_string())?
    };
    let mut input = child.stdin.take().ok_or("clipboard_unavailable: no input pipe")?;
    let written = match port()?.admit(Boundary::HandOver) {
        Ok(_admitted) => input.write_all(text.as_bytes()).map_err(|error| error.to_string()),
        Err(refused) => Err(refused),
    };
    drop(input);
    // The wait is data: it holds no admission.
    child.wait().map_err(|error| error.to_string())?;
    written.map(|()| true)
}
