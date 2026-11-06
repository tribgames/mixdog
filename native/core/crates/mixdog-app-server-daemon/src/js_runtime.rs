//! Where the install layout keeps the JavaScript runtime (WP-INSTALL): the interpreter and the
//! package root holding `src/skill-script-entry.mjs` and `src/ext-host/worker.mjs`.
//!
//! An install describes it in `js-runtime.json` beside the `mixdogd` binary it ships with:
//!
//! ```json
//! { "program": "../../Mixdog.exe", "packageRoot": "../runtime.asar/node_modules/mixdog", "electron": true }
//! ```
//!
//! Relative paths are taken from the manifest's directory. A `program` without a path separator
//! (`"node"`) is searched on `PATH`. The desktop writes the manifest when it stages the core
//! (`apps/desktop/scripts/stage-core.mjs`); every product install ships it, desktop and remote
//! alike, so a missing manifest is as much a startup error as a broken one.

use std::ffi::OsStr;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::LaneToken;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::compose::JsRuntime;

pub const MANIFEST_FILE: &str = "js-runtime.json";
const SKILL_ENTRY: &str = "src/skill-script-entry.mjs";

#[derive(Debug, thiserror::Error)]
pub enum JsRuntimeError {
    #[error("the install has no JS runtime manifest {}", .manifest.display())]
    NotInstalled { manifest: PathBuf },
    #[error("reading {}: {source}", .path.display())]
    Read { path: PathBuf, source: std::io::Error },
    #[error("{} is not a JS runtime manifest: {source}", .path.display())]
    Parse { path: PathBuf, source: serde_json::Error },
    #[error("the JS interpreter {} named by {} does not exist", .program.display(), .manifest.display())]
    MissingProgram { program: PathBuf, manifest: PathBuf },
    #[error("the JS package root {} named by {} does not hold src/skill-script-entry.mjs", .root.display(), .manifest.display())]
    MissingPackage { root: PathBuf, manifest: PathBuf },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    program: String,
    package_root: String,
    #[serde(default)]
    electron: bool,
}

/// The runtime of the install `exe` belongs to; `path` is the `PATH` a bare program name is
/// searched on. A missing manifest, or one that names something missing, is an error.
///
/// Probes the file system: it runs in the lane job of [`resolve_current_on`], or before any
/// runtime exists ([`resolve_current`]).
#[allow(
    clippy::disallowed_methods,
    reason = "runs in the lane job of `resolve_current_on`, or before any runtime exists in `resolve_current`"
)]
pub fn resolve(exe: &Path, path: Option<&OsStr>) -> Result<JsRuntime, JsRuntimeError> {
    let Some(dir) = exe.parent() else {
        return Err(JsRuntimeError::NotInstalled { manifest: PathBuf::from(MANIFEST_FILE) });
    };
    let manifest_path = dir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(JsRuntimeError::NotInstalled { manifest: manifest_path });
        }
        Err(source) => return Err(JsRuntimeError::Read { path: manifest_path, source }),
    };
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|source| JsRuntimeError::Parse { path: manifest_path.clone(), source })?;
    let program = if manifest.program.contains(['/', '\\']) {
        dir.join(&manifest.program)
    } else {
        which(&manifest.program, path).unwrap_or_else(|| PathBuf::from(&manifest.program))
    };
    if !program.is_file() {
        return Err(JsRuntimeError::MissingProgram { program, manifest: manifest_path });
    }
    let package_root = dir.join(&manifest.package_root);
    if !package_present(&package_root) {
        return Err(JsRuntimeError::MissingPackage { root: package_root, manifest: manifest_path });
    }
    Ok(JsRuntime { program, package_root, electron: manifest.electron })
}

/// The runtime of the running binary's install, for a caller that has no runtime yet.
pub fn resolve_current() -> Result<JsRuntime, JsRuntimeError> {
    let exe = std::env::current_exe().map_err(|source| JsRuntimeError::Read { path: PathBuf::from("<current exe>"), source })?;
    resolve(&exe, std::env::var_os("PATH").as_deref())
}

/// [`resolve_current`] as a job of `lane`, for a caller on the async runtime.
pub async fn resolve_current_on(lane: impl LaneToken) -> Result<JsRuntime, JsRuntimeError> {
    let lane_failed = |source| JsRuntimeError::Read { path: PathBuf::from("<lane job>"), source };
    let job = lane
        .submit(&CancellationToken::new(), |_lane| resolve_current())
        .map_err(|_| lane_failed(std::io::Error::other("the lane is full")))?;
    job.await.map_err(|dropped| lane_failed(std::io::Error::other(dropped)))?
}

/// A package root inside an `.asar` archive is readable only by Electron, so only the archive
/// file is checked; any other root must hold the skill entry.
#[allow(clippy::disallowed_methods, reason = "runs only inside `resolve`")]
fn package_present(root: &Path) -> bool {
    match root.ancestors().find(|p| p.extension().is_some_and(|e| e == "asar")) {
        Some(archive) => archive.is_file(),
        None => root.join(SKILL_ENTRY).is_file(),
    }
}

#[allow(clippy::disallowed_methods, reason = "runs only inside `resolve`")]
fn which(name: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let suffixes: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd"] } else { &[""] };
    std::env::split_paths(path?)
        .flat_map(|dir| suffixes.iter().map(move |suffix| dir.join(format!("{name}{suffix}"))))
        .find(|candidate| candidate.is_file())
}

/// A test install under `root`: a manifest, an interpreter file and a package root holding the
/// skill entry, resolved through [`resolve`] as a product install is.
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup writes the install on the test thread")]
pub(crate) fn fixture(root: &Path) -> JsRuntime {
    let core = root.join("core");
    let package = root.join("js");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::create_dir_all(package.join("src")).unwrap();
    std::fs::write(core.join("node"), "").unwrap();
    std::fs::write(package.join(SKILL_ENTRY), "").unwrap();
    std::fs::write(core.join(MANIFEST_FILE), r#"{"program":"./node","packageRoot":"../js"}"#).unwrap();
    resolve(&core.join("mixdogd"), None).unwrap()
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "tests write their install on the test thread")]
mod tests {
    use super::*;

    fn install(manifest: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("core");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(core.join("mixdogd"), "").unwrap();
        std::fs::write(core.join(MANIFEST_FILE), manifest).unwrap();
        let exe = core.join("mixdogd");
        (root, exe)
    }

    #[test]
    fn no_manifest_is_an_error() {
        let (root, exe) = install("{}");
        std::fs::remove_file(root.path().join("core").join(MANIFEST_FILE)).unwrap();
        assert!(matches!(resolve(&exe, None), Err(JsRuntimeError::NotInstalled { .. })));
    }

    #[test]
    fn the_fixture_install_resolves() {
        let root = tempfile::tempdir().unwrap();
        assert!(!fixture(root.path()).electron);
    }

    #[test]
    fn desktop_layout_reaches_the_app_binary_and_the_archive() {
        let (root, exe) = install(
            r#"{"program":"../app/Mixdog","packageRoot":"../runtime.asar/node_modules/mixdog","electron":true}"#,
        );
        std::fs::create_dir_all(root.path().join("app")).unwrap();
        std::fs::write(root.path().join("app/Mixdog"), "").unwrap();
        // Inside an archive only the archive file can be checked.
        assert!(matches!(resolve(&exe, None), Err(JsRuntimeError::MissingPackage { .. })));
        std::fs::write(root.path().join("runtime.asar"), "").unwrap();
        let js = resolve(&exe, None).unwrap();
        assert!(js.electron);
        assert!(js.program.ends_with("app/Mixdog") || js.program.ends_with("app\\Mixdog"));
        assert!(js.package_root.ends_with("node_modules/mixdog") || js.package_root.ends_with("node_modules\\mixdog"));
    }

    #[test]
    fn a_bare_program_is_found_on_path_and_a_plain_root_needs_the_entry() {
        let (root, exe) = install(r#"{"program":"nodex","packageRoot":"../js"}"#);
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let name = if cfg!(windows) { "nodex.exe" } else { "nodex" };
        std::fs::write(bin.join(name), "").unwrap();
        let path = std::env::join_paths([&bin]).unwrap();
        assert!(matches!(resolve(&exe, Some(&path)), Err(JsRuntimeError::MissingPackage { .. })));
        std::fs::create_dir_all(root.path().join("js/src")).unwrap();
        std::fs::write(root.path().join("js").join(SKILL_ENTRY), "").unwrap();
        let js = resolve(&exe, Some(&path)).unwrap();
        assert!(!js.electron);
        assert_eq!(js.program, bin.join(name));
        assert!(matches!(resolve(&exe, None), Err(JsRuntimeError::MissingProgram { .. })));
    }

    #[test]
    fn a_malformed_manifest_is_an_error() {
        let (_root, exe) = install(r#"{"program":"x"}"#);
        assert!(matches!(resolve(&exe, None), Err(JsRuntimeError::Parse { .. })));
    }
}
