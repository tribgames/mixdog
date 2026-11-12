//! Where the install layout keeps the JavaScript runtime (WP-INSTALL): the interpreter and the
//! package root holding `src/skill-script-entry.mjs` and `src/ext-host/worker.mjs`.
//!
//! An install describes it in `js-runtime.json` beside the `mixdogd` binary it ships with:
//!
//! ```json
//! { "program": "../../Mixdog.exe", "packageRoot": "../runtime.asar/node_modules/mixdog", "electron": true,
//!   "ortLibrary": "../runtime.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll" }
//! ```
//!
//! Relative paths are taken from the manifest's directory. A `program` without a path separator
//! (`"node"`) is searched on `PATH`. The desktop writes the manifest when it stages the core
//! (`apps/desktop/scripts/stage-core.mjs`); every product install ships it, desktop and remote
//! alike, so a missing manifest is as much a startup error as a broken one.
//!
//! `ortLibrary` is the one place the daemon looks for the ONNX Runtime shared library the
//! embedding and effort-judge models load ([`resolve_ort_library`]): the same file Node's
//! `onnxruntime-node` binding loads. A manifest without it describes an install that has no ONNX
//! Runtime (macOS x64); one that names a file that is not there is a startup error.

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
    #[error("the ONNX Runtime library {} named by {} does not exist", .library.display(), .manifest.display())]
    MissingOrtLibrary { library: PathBuf, manifest: PathBuf },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    program: String,
    package_root: String,
    #[serde(default)]
    electron: bool,
    #[serde(default)]
    ort_library: Option<String>,
}

/// The manifest beside `exe`, with its path and directory.
#[allow(clippy::disallowed_methods, reason = "runs in the callers' lane job, or before any runtime exists")]
fn read_manifest(exe: &Path) -> Result<(PathBuf, PathBuf, Manifest), JsRuntimeError> {
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
    Ok((dir.to_path_buf(), manifest_path, manifest))
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
    let (dir, manifest_path, manifest) = read_manifest(exe)?;
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

/// The ONNX Runtime library of the install `exe` belongs to: the manifest's `ortLibrary`, which
/// must exist. `None` when the manifest names none (an install without ONNX Runtime).
///
/// Probes the file system, like [`resolve`].
#[allow(clippy::disallowed_methods, reason = "runs in the lane job of `resolve_ort_library_current_on`")]
pub fn resolve_ort_library(exe: &Path) -> Result<Option<PathBuf>, JsRuntimeError> {
    let (dir, manifest_path, manifest) = read_manifest(exe)?;
    let Some(library) = manifest.ort_library else {
        return Ok(None);
    };
    let library = dir.join(library);
    if !library.is_file() {
        return Err(JsRuntimeError::MissingOrtLibrary { library, manifest: manifest_path });
    }
    Ok(Some(library))
}

fn current_exe() -> Result<PathBuf, JsRuntimeError> {
    std::env::current_exe().map_err(|source| JsRuntimeError::Read { path: PathBuf::from("<current exe>"), source })
}

/// The runtime of the running binary's install, for a caller that has no runtime yet.
pub fn resolve_current() -> Result<JsRuntime, JsRuntimeError> {
    resolve(&current_exe()?, std::env::var_os("PATH").as_deref())
}

/// [`resolve_ort_library`] of the running binary's install.
pub fn resolve_ort_library_current() -> Result<Option<PathBuf>, JsRuntimeError> {
    resolve_ort_library(&current_exe()?)
}

/// One of the resolvers above as a job of `lane`, for a caller on the async runtime.
async fn on_lane<T: Send + 'static>(
    lane: impl LaneToken,
    resolver: fn() -> Result<T, JsRuntimeError>,
) -> Result<T, JsRuntimeError> {
    let lane_failed = |source| JsRuntimeError::Read { path: PathBuf::from("<lane job>"), source };
    let job = lane
        .submit(&CancellationToken::new(), move |_lane| resolver())
        .map_err(|_| lane_failed(std::io::Error::other("the lane is full")))?;
    job.await.map_err(|dropped| lane_failed(std::io::Error::other(dropped)))?
}

/// [`resolve_current`] as a job of `lane`, for a caller on the async runtime.
pub async fn resolve_current_on(lane: impl LaneToken) -> Result<JsRuntime, JsRuntimeError> {
    on_lane(lane, resolve_current).await
}

/// [`resolve_ort_library_current`] as a job of `lane`, for a caller on the async runtime.
pub async fn resolve_ort_library_current_on(lane: impl LaneToken) -> Result<Option<PathBuf>, JsRuntimeError> {
    on_lane(lane, resolve_ort_library_current).await
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
/// skill entry and `package.json`, resolved through [`resolve`] as a product install is.
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup writes the install on the test thread")]
pub(crate) fn fixture(root: &Path) -> JsRuntime {
    let core = root.join("core");
    let package = root.join("js");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::create_dir_all(package.join("src")).unwrap();
    std::fs::write(core.join("node"), "").unwrap();
    std::fs::write(package.join(SKILL_ENTRY), "").unwrap();
    // The tree's own manifest: the composition reads its ersion (package_version).
    std::fs::write(package.join("package.json"), include_str!("../../../../../package.json")).unwrap();
    // The shipped files the composition reads from <packageRoot>/src: prompt rules, output styles, agents, defaults, workflow packs, orchestration texts and the voice manifest.
    let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src");
    for dir in ["rules", "output-styles", "agents", "defaults", "workflows", "orchestration", "runtime/channels/data"] {
        copy_dir(&shipped.join(dir), &package.join("src").join(dir));
    }
    std::fs::write(core.join(MANIFEST_FILE), r#"{"program":"./node","packageRoot":"../js"}"#).unwrap();
    resolve(&core.join("mixdogd"), None).unwrap()
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup copies the shipped files on the test thread")]
fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
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

    /// Node reads `<STANDALONE_ROOT>/defaults/shipped-history.json` with `STANDALONE_ROOT` = `<package>/src`; the boot retirement
    /// (`compose_flip::real_core`) roots its pass at `package_root.join("src")`, so on a plain (dev / server) install the history is read
    /// from this very file.
    #[test]
    fn the_retirement_reads_the_history_node_reads_in_a_plain_install() {
        let root = tempfile::tempdir().unwrap();
        let js = fixture(root.path());
        let history = js.package_root.join("src").join("defaults").join("shipped-history.json");
        assert_eq!(std::fs::read(history).unwrap(), std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/defaults/shipped-history.json")).unwrap());
    }

    /// A packaged desktop starts `mixdogd` with `MIXDOG_ROOT` at the unpacked tree while `packageRoot` is inside the archive; the
    /// retirement then reads `<MIXDOG_ROOT>/defaults/shipped-history.json` and never the archive.
    #[test]
    fn the_retirement_reads_the_history_under_mixdog_root_in_a_packaged_install() {
        let root = tempfile::tempdir().unwrap();
        let unpacked = root.path().join("resources").join("runtime.asar.unpacked").join("node_modules").join("mixdog").join("src");
        copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src/defaults"), &unpacked.join("defaults"));
        let archive_package = root.path().join("resources").join("runtime.asar").join("node_modules").join("mixdog");
        let data = root.path().join("data");
        let env_root = unpacked.clone().into_os_string();
        let paths = crate::compose_flip::retirement_paths(&archive_package, &data, &|name| (name == "MIXDOG_ROOT").then(|| env_root.clone()));
        assert_eq!(paths.root, unpacked);
        assert!(paths.root.join("defaults").join("shipped-history.json").is_file());
        assert_eq!(paths.data, data);
        let unset = crate::compose_flip::retirement_paths(&archive_package, &data, &|_| None);
        assert_eq!(unset.root, archive_package.join("src"));
        let empty = crate::compose_flip::retirement_paths(&archive_package, &data, &|_| Some(std::ffi::OsString::new()));
        assert_eq!(empty.root, archive_package.join("src"), "an empty MIXDOG_ROOT counts as unset");
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
    fn the_ort_library_is_the_manifests_file_or_an_error() {
        let (root, exe) = install(r#"{"program":"x","packageRoot":"../js"}"#);
        assert_eq!(resolve_ort_library(&exe).unwrap(), None);

        let manifest = r#"{"program":"x","packageRoot":"../js","ortLibrary":"../ort/onnxruntime.dll"}"#;
        std::fs::write(root.path().join("core").join(MANIFEST_FILE), manifest).unwrap();
        assert!(matches!(resolve_ort_library(&exe), Err(JsRuntimeError::MissingOrtLibrary { .. })));
        std::fs::create_dir_all(root.path().join("ort")).unwrap();
        std::fs::write(root.path().join("ort/onnxruntime.dll"), "").unwrap();
        assert_eq!(resolve_ort_library(&exe).unwrap(), Some(root.path().join("core").join("../ort/onnxruntime.dll")));
    }

    #[test]
    fn a_malformed_manifest_is_an_error() {
        let (_root, exe) = install(r#"{"program":"x"}"#);
        assert!(matches!(resolve(&exe, None), Err(JsRuntimeError::Parse { .. })));
    }
}
