//! The raw console: Windows VT input and Unix termios. Filled in by the console task.

use std::io;

/// Raw mode on the controlling terminal; dropping it restores the mode the console had.
#[derive(Debug)]
pub struct RawConsole;

impl RawConsole {
    pub fn enable() -> io::Result<RawConsole> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "the raw console is not provided yet"))
    }
}
