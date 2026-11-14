//! The transparent system-cursor theme kept by the watchdog child while the
//! overlay draws the agent's arrow (CursorTheme.cs). The helper never touches
//! the cursors itself: it starts `--cursor-watchdog`, which saves, replaces
//! and restores them, and restores them on its own when the helper is gone.

mod client;
mod lease;
pub(super) mod watchdog;

use client::{complete, Guard, Wire};
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::Duration;
use windows::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW};

/// One line of a protocol channel, or why there is none.
#[derive(Debug, PartialEq)]
pub enum Line {
    Text(String),
    /// Nothing arrived (in time, or yet).
    Empty,
    /// The other side is gone.
    Closed,
}

const UNAVAILABLE: &str = "computer_cursor_unavailable: theme activation was not confirmed; no input sent";
const UNCONFIRMED_CLEANUP: &str = "input_cleanup_unconfirmed: cursor watchdog did not confirm restoration";

/// The pipes to one watchdog child. A reader thread turns its output into
/// lines, so a late acknowledgement is never lost to a timed-out read.
struct ChildWire {
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    _child: Child,
}

impl Wire for ChildWire {
    fn send(&mut self, line: &str) -> bool {
        self.stdin
            .as_mut()
            .is_some_and(|stdin| writeln!(stdin, "{line}").and_then(|()| stdin.flush()).is_ok())
    }

    fn recv(&mut self, within: Duration) -> Line {
        match self.lines.recv_timeout(within) {
            Ok(text) => Line::Text(text),
            Err(mpsc::RecvTimeoutError::Timeout) => Line::Empty,
            Err(mpsc::RecvTimeoutError::Disconnected) => Line::Closed,
        }
    }

    fn poll(&mut self) -> Line {
        match self.lines.try_recv() {
            Ok(text) => Line::Text(text),
            Err(mpsc::TryRecvError::Empty) => Line::Empty,
            Err(mpsc::TryRecvError::Disconnected) => Line::Closed,
        }
    }
}

impl Drop for ChildWire {
    /// Closing the watchdog's input makes it end an unused reservation, or
    /// restore a lease whose END was lost.
    fn drop(&mut self) {
        self.stdin = None;
    }
}

/// Starts a watchdog outside this process's job, so a kill of the helper (the
/// core's timeout retires it) does not take the watchdog with it
/// (LaunchDetachedWatchdog, which used WMI for the same independence). A job
/// that forbids breakaway refuses the start, and the action with it: a theme
/// that nothing would restore is never applied.
fn launch() -> Result<ChildWire, String> {
    let program = std::env::current_exe().map_err(|_| UNAVAILABLE.to_string())?;
    let mut child = Command::new(program)
        .arg("--cursor-watchdog")
        .arg(std::process::id().to_string())
        .env("MIXDOG_COMPUTER_INPUT_MARKER", crate::config::input_marker().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0 | CREATE_BREAKAWAY_FROM_JOB.0)
        .spawn()
        .map_err(|_| UNAVAILABLE.to_string())?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err(UNAVAILABLE.into());
    };
    let (send, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if send.send(line).is_err() {
                break;
            }
        }
    });
    Ok(ChildWire { stdin: Some(stdin), lines, _child: child })
}

/// A lease and whether it blanks the cursors.
struct Held {
    guard: Guard<ChildWire>,
    decorated: bool,
}

struct State {
    /// A watchdog started and not yet asked to lease.
    reserved: Option<ChildWire>,
    held: Option<Held>,
}

static STATE: Mutex<State> = Mutex::new(State { reserved: None, held: None });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the watchdog while the caller still has focus work to do, unless a
/// lease is held; a held one the watchdog ended on its own is dropped first
/// (Clear-ExpiredCursorTheme, Reserve). Whether a lease is held now.
pub fn reserve() -> Result<bool, String> {
    let mut state = state();
    if let Some(held) = state.held.as_mut() {
        if held.guard.expired() {
            // The watchdog already restored; its confirmation is moot.
            let _ = held.guard.dispose();
            state.held = None;
        }
    }
    if state.held.is_some() {
        return Ok(true);
    }
    state.reserved = Some(launch()?);
    Ok(false)
}

/// Leases the theme right before input is dispatched: the held one, or the
/// reserved watchdog's (Acquire-CursorTheme). A held lease keeps the
/// decoration it was acquired with. Whether the cursors are blanked.
pub fn begin(decorate: bool) -> Result<bool, String> {
    let mut state = state();
    if let Some(held) = &state.held {
        return Ok(held.decorated);
    }
    let wire = match state.reserved.take() {
        Some(wire) => wire,
        None => launch()?,
    };
    state.held = Some(Held { guard: complete(wire, decorate)?, decorated: decorate });
    Ok(decorate)
}

/// Ends the held lease and drops an unused reservation (Release-CursorTheme).
/// Whether a lease was held.
pub fn end() -> Result<bool, String> {
    let mut state = state();
    state.reserved = None;
    match state.held.take() {
        Some(mut held) => held.guard.dispose().map(|()| true),
        None => Ok(false),
    }
}
