//! The clipboard (OSC 52 and native helpers). Filled in by the OS task.

use std::io;

pub fn copy_to_clipboard(_text: &str) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "the clipboard is not provided yet"))
}
