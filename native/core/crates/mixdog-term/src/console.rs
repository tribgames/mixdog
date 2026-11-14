//! The raw console. Raw mode is what Node's `tty.ReadStream.setRawMode(true)` gave the Ink fork (libuv's
//! `UV_TTY_MODE_RAW`, and on Windows `UV_TTY_MODE_RAW_VT` as Node 22 and later use it): no line editing, echo, signal keys
//! or flow control, so the bytes read are the terminal's own, and a Ctrl+C arrives as the byte 3. Dropping a
//! [`RawConsole`] puts back the modes the console had.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod win;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use win as platform;

#[cfg(windows)]
pub(crate) use win::open_console;

static RAW_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Raw mode on the controlling terminal; dropping it restores the mode the console had.
pub struct RawConsole {
    state: platform::State,
}

impl std::fmt::Debug for RawConsole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RawConsole").finish_non_exhaustive()
    }
}

impl RawConsole {
    /// Turns raw mode on. Fails when there is no console to read from (stdin is not a terminal and no controlling
    /// terminal can be opened).
    pub fn enable() -> io::Result<RawConsole> {
        let state = platform::enable()?;
        RAW_ACTIVE.store(true, Ordering::SeqCst);
        Ok(RawConsole { state })
    }

    /// Puts the console's own modes back now (also what dropping does); a second call does nothing.
    pub fn restore(&mut self) {
        if platform::restore(&mut self.state) {
            RAW_ACTIVE.store(false, Ordering::SeqCst);
        }
    }
}

impl Drop for RawConsole {
    fn drop(&mut self) {
        self.restore();
    }
}

/// Whether a [`RawConsole`] is on right now.
pub fn is_raw() -> bool {
    RAW_ACTIVE.load(Ordering::SeqCst)
}

/// The terminal's size as `(columns, rows)`: the visible window, not the scroll-back buffer.
pub fn terminal_size() -> io::Result<(u16, u16)> {
    platform::terminal_size()
}
