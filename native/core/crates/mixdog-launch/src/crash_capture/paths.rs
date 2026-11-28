//! Where the core's crash captures live (`daemon-crash-capture/paths.mjs`).

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

/// `CAPTURE_DIR_NAME` (`daemon-crash-capture/paths.mjs`).
const CAPTURE_DIR_NAME: &str = "daemon-crash";

/// `daemonCrashCaptureDir({ dataDir })`: the captures of the core's boots, kept by the launcher that starts one and by the core.
pub fn capture_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(CAPTURE_DIR_NAME)
}

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
