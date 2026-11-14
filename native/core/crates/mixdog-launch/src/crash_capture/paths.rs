//! Where the core's crash captures live (`daemon-crash-capture/paths.mjs`).

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

pub use mixdog_app_server_daemon::crash_record::capture_dir;

/// `daemonDataDir(env)`: `MIXDOG_DATA_DIR`, else `<MIXDOG_HOME or home/.mixdog>/data` (an empty variable counts as unset).
/// `None` when there is neither a variable nor a home folder, in which case no capture is kept.
pub fn data_dir_of(env: &dyn Fn(&str) -> Option<OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    mixdog_store::paths::Paths::resolve(Path::new(""), env, home).map(|paths| paths.data_dir)
}

/// [`data_dir_of`] over the process environment.
pub fn data_dir() -> Option<PathBuf> {
    data_dir_of(&|name| std::env::var_os(name), std::env::home_dir())
}

/// `daemonCrashCaptureDir()` over the process environment.
pub fn process_capture_dir() -> Option<PathBuf> {
    data_dir().map(|dir| capture_dir(&dir))
}
