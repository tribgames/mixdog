//! The staging area on disk: `<data>/staging/<version>/` with the unpacked binary in `bin/` and the completion marker
//! `.staged-complete.json`, the rules that read it (`isStagedComplete`, `bestStagedVersion`, `cleanupStaging`) and the build that
//! is never replaced (`isDevInstall`).

use std::cmp::Ordering;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_domains::domains::update::compare_semver;
use serde_json::Value;

use super::Context;

/// `MARKER_NAME`.
pub(super) const MARKER_NAME: &str = ".staged-complete.json";
/// Where the unpacked binary is inside a version's folder (`PKG_SUBDIR`).
pub(super) const BIN_SUBDIR: &str = "bin";
/// A folder with no marker older than this is a dead attempt and is removed.
const INCOMPLETE_MAX_AGE: Duration = Duration::from_secs(60 * 60);

pub(super) fn staging_root(context: &Context) -> PathBuf {
    context.data_dir.join("staging")
}

pub(super) fn marker_path(ver_dir: &Path) -> PathBuf {
    ver_dir.join(MARKER_NAME)
}

/// The file name of the `mixdog` binary on this platform.
pub(super) fn binary_name() -> String {
    format!("mixdog{}", std::env::consts::EXE_SUFFIX)
}

pub(super) fn read_marker(ver_dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(marker_path(ver_dir)).ok()?).ok()
}

/// The binary a marker names (`pkgDir`): its `binary`, else the default place.
fn marker_binary(marker: &Value, ver_dir: &Path) -> PathBuf {
    marker.get("binary").and_then(Value::as_str).map_or_else(|| ver_dir.join(BIN_SUBDIR).join(binary_name()), PathBuf::from)
}

/// `isStagedComplete(version)`: the marker names this version and its binary is there.
pub fn is_staged_complete(context: &Context, version: &str) -> bool {
    let version = version.trim();
    if version.is_empty() {
        return false;
    }
    let ver_dir = staging_root(context).join(version);
    let Some(marker) = read_marker(&ver_dir) else { return false };
    marker.get("version").and_then(Value::as_str) == Some(version) && marker_binary(&marker, &ver_dir).is_file()
}

/// A completed staged version and where its binary is.
pub(super) struct Staged {
    pub version: String,
    pub binary: PathBuf,
}

/// `isNewerVersion`.
pub(super) fn is_newer(latest: &str, current: &str) -> bool {
    !latest.is_empty() && !current.is_empty() && compare_semver(latest, current) == Ordering::Greater
}

/// `bestStagedVersion(current)`: the highest completed staged version strictly newer than `current`, with its binary in place.
pub(super) fn best_staged(context: &Context, current: &str) -> Option<Staged> {
    let mut best: Option<Staged> = None;
    for entry in std::fs::read_dir(staging_root(context)).ok()?.flatten() {
        let ver_dir = entry.path();
        let Some(marker) = read_marker(&ver_dir) else { continue };
        let Some(version) = marker.get("version").and_then(Value::as_str).filter(|version| !version.is_empty()) else { continue };
        let binary = marker_binary(&marker, &ver_dir);
        if !binary.is_file() || !is_newer(version, current) {
            continue;
        }
        if best.as_ref().is_none_or(|best| compare_semver(version, &best.version) == Ordering::Greater) {
            best = Some(Staged { version: version.to_owned(), binary });
        }
    }
    best
}

pub(super) fn remove_dir(dir: &Path) {
    // Best effort.
    drop(std::fs::remove_dir_all(dir));
}

/// `cleanupStaging(current)`: removes the staged versions that are not newer than `current`, the attempts that never completed and
/// are over an hour old, and the executables a swap left aside, once a real executable is at its place.
pub(super) fn cleanup_staging(context: &Context, current: &str) {
    if let Ok(entries) = std::fs::read_dir(staging_root(context)) {
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(meta) = std::fs::metadata(&dir) else { continue };
            if !meta.is_dir() {
                continue;
            }
            let version = read_marker(&dir).and_then(|marker| marker.get("version").and_then(Value::as_str).map(str::to_owned)).filter(|v| !v.is_empty());
            match version {
                Some(version) => {
                    if compare_semver(&version, current) != Ordering::Greater {
                        remove_dir(&dir);
                    }
                }
                None => {
                    let age = meta.modified().ok().and_then(|modified| SystemTime::now().duration_since(modified).ok());
                    if age.is_some_and(|age| age > INCOMPLETE_MAX_AGE) {
                        remove_dir(&dir);
                    }
                }
            }
        }
    }
    // Only once a real executable sits at its place is a leftover from a swap stale: never while a swap left it bare.
    if !context.exe.is_file() {
        return;
    }
    let (Some(parent), Some(name)) = (context.exe.parent(), context.exe.file_name().map(|name| name.to_string_lossy().into_owned())) else { return };
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        let found = entry.file_name().to_string_lossy().into_owned();
        if found.starts_with(&format!("{name}.old-")) || found.starts_with(&format!("{name}.update-")) {
            // A backup of an executable that still runs cannot be removed on Windows: the next start sweeps it.
            drop(std::fs::remove_file(entry.path()));
        }
    }
}

/// `parseInt(text, 10)`: the leading decimal digits, 0 when there are none or they do not fit.
pub(super) fn parse_int_prefix(text: &str) -> u32 {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().unwrap_or(0)
}

/// `isDevInstall()`: the executable sits in a cargo `target` folder (`target/debug`, `target/release`, `target/<triple>/release`):
/// a source checkout's build, which is never replaced.
pub(super) fn is_dev_build(exe: &Path) -> bool {
    let parts: Vec<String> = exe.components().map(|part| part.as_os_str().to_string_lossy().to_lowercase()).collect();
    let profile = |part: &String| part == "debug" || part == "release";
    parts.windows(2).any(|pair| pair[0] == "target" && profile(&pair[1])) || parts.windows(3).any(|trio| trio[0] == "target" && profile(&trio[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pid_is_read_the_way_parse_int_reads_it() {
        assert_eq!(parse_int_prefix("123"), 123);
        assert_eq!(parse_int_prefix("12abc"), 12);
        assert_eq!(parse_int_prefix("abc"), 0);
        assert_eq!(parse_int_prefix("-5"), 0);
        assert_eq!(parse_int_prefix(""), 0);
        assert_eq!(parse_int_prefix("99999999999999"), 0);
    }

    #[test]
    fn only_a_cargo_build_folder_is_a_checkout_build() {
        assert!(is_dev_build(Path::new("/src/mixdog/target/debug/mixdog")));
        assert!(is_dev_build(Path::new("C:/src/mixdog/native/core/target/release/mixdog.exe")));
        assert!(is_dev_build(Path::new("/src/mixdog/target/x86_64-pc-windows-msvc/release/mixdog.exe")));
        assert!(!is_dev_build(Path::new("/usr/local/bin/mixdog")));
        assert!(!is_dev_build(Path::new("/home/me/target/mixdog")));
    }
}
