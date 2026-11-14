//! The browser opener and the native folder picker. Filled in by the OS task.

use std::io;
use std::path::PathBuf;

pub fn open_in_browser(_url: &str) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "the browser opener is not provided yet"))
}

pub fn pick_folder() -> io::Result<Option<PathBuf>> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "the folder picker is not provided yet"))
}
