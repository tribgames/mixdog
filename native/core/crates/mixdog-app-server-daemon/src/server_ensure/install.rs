//! The immutable install (LR §8.1):
//!
//! ```text
//! ~/.mixdog-remote/versions/<version>-<build>/mixdogd     the core binary
//!                                            /js-runtime.json, js/node, js/pkg/   its JS runtime
//!                                            /.install-complete   written last
//! ~/.mixdog-remote/state.json                               {current, previous}
//! ```
//!
//! An upload lands in a staging directory, is verified against its checksum there, and one
//! rename publishes it. A directory without a matching marker is never trusted: it is replaced.
//! Everything here runs with the install lock held.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

use super::error::EnsureError;
use super::host::ProcessImage;
use super::layout::BINARY_NAME;
use super::layout::COMPLETE_MARKER;
use super::layout::RemotePaths;

#[derive(Debug, Clone, Copy)]
pub struct InstallSpec<'a> {
    pub install_id: &'a str,
    pub version: &'a str,
    pub build: &'a str,
    /// Lowercase hex SHA-256 of the binary the desktop sends; a probe may not know it.
    pub sha256: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub exe: PathBuf,
    /// Written by this run (as opposed to found complete).
    pub fresh: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    version: String,
    build: String,
    sha256: String,
    installed_at: u64,
}

fn io_failed(what: &str, error: &std::io::Error) -> EnsureError {
    EnsureError::InstallFailed(format!("{what}: {error}"))
}

/// Writes `bytes` to `target` through a sibling file and a rename.
fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let staged = target.with_extension(format!("tmp-{}-{:08x}", std::process::id(), rand::random::<u32>()));
    let mut file = fs::File::create(&staged)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&staged, target).inspect_err(|_| {
        let _ = fs::remove_file(&staged);
    })
}

pub fn find_installed(paths: &RemotePaths, spec: &InstallSpec) -> Result<Option<PathBuf>, EnsureError> {
    let dir = paths.version_dir(spec.install_id)?;
    let marker: Option<Marker> = fs::read(dir.join(COMPLETE_MARKER))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let exe = dir.join(BINARY_NAME);
    Ok(marker
        .filter(|m| m.build == spec.build && m.version == spec.version && spec.sha256.is_none_or(|sha| m.sha256 == sha))
        .filter(|_| exe.is_file())
        .map(|_| exe))
}

/// Beside the staged binary, the entries of this directory (the JS runtime: `js-runtime.json`,
/// `js/`) become part of the install.
pub const PAYLOAD_DIR: &str = "payload";

/// Finds the install complete, or publishes the file `source` (the running binary, unpacked and
/// checked by the bootstrap shell) as it, with the `payload/` directory next to it, if any.
pub fn ensure_installed(
    paths: &RemotePaths,
    spec: &InstallSpec,
    now_ms: u64,
    source: Option<&Path>,
) -> Result<Installed, EnsureError> {
    if let Some(exe) = find_installed(paths, spec)? {
        return Ok(Installed { exe, fresh: false });
    }
    let Some(source) = source else {
        return Err(EnsureError::InstallMissing(spec.install_id.to_owned()));
    };
    let Some(sha256) = spec.sha256 else {
        return Err(EnsureError::InstallFailed("An install needs the sha256 of the runtime.".to_owned()));
    };
    let mut upload = fs::File::open(source).map_err(|e| io_failed("Cannot read the runtime to install", &e))?;
    let dir = paths.version_dir(spec.install_id)?;
    fs::create_dir_all(&paths.versions).map_err(|e| io_failed("Cannot create the versions directory", &e))?;
    let staging = paths
        .versions
        .join(format!(".staging-{}-{}-{:08x}", spec.install_id, std::process::id(), rand::random::<u32>()));
    let payload = source.parent().map(|parent| parent.join(PAYLOAD_DIR)).filter(|path| path.is_dir());
    let result = stage_and_publish(&staging, &dir, spec, sha256, now_ms, &mut upload, payload.as_deref());
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| Installed { exe: dir.join(BINARY_NAME), fresh: true })
}

fn stage_and_publish(
    staging: &Path,
    dir: &Path,
    spec: &InstallSpec,
    sha256: &str,
    now_ms: u64,
    upload: &mut dyn Read,
    payload: Option<&Path>,
) -> Result<(), EnsureError> {
    fs::create_dir(staging).map_err(|e| io_failed("Cannot create the staging directory", &e))?;
    let staged_exe = staging.join(BINARY_NAME);
    let mut file = fs::File::create(&staged_exe).map_err(|e| io_failed("Cannot create the binary", &e))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = upload.read(&mut buffer).map_err(|e| io_failed("Reading the uploaded binary failed", &e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(|e| io_failed("Writing the binary failed", &e))?;
    }
    file.sync_all().map_err(|e| io_failed("Writing the binary failed", &e))?;
    drop(file);
    let actual = crate::lifecycle::hex(&hasher.finalize());
    if actual != sha256 {
        return Err(EnsureError::ChecksumMismatch { expected: sha256.to_owned(), actual });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged_exe, fs::Permissions::from_mode(0o755))
            .map_err(|e| io_failed("Cannot make the binary executable", &e))?;
    }
    // The JS runtime travels in the same bundle: `js-runtime.json`, the bundled node and the package
    // root move beside the binary (the bootstrap extracts both under one filesystem), so one rename
    // publishes them together and `js_runtime::resolve` finds them next to `mixdogd`.
    if let Some(payload) = payload {
        for entry in fs::read_dir(payload).map_err(|e| io_failed("Cannot read the uploaded runtime payload", &e))? {
            let entry = entry.map_err(|e| io_failed("Cannot read the uploaded runtime payload", &e))?;
            fs::rename(entry.path(), staging.join(entry.file_name()))
                .map_err(|e| io_failed("Cannot place the uploaded runtime payload", &e))?;
        }
    }
    // Whatever sits at the final path has no matching marker: never trusted.
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| io_failed("Cannot replace the incomplete install", &e))?;
    }
    fs::rename(staging, dir).map_err(|e| io_failed("Cannot publish the install", &e))?;
    let marker = Marker {
        version: spec.version.to_owned(),
        build: spec.build.to_owned(),
        sha256: sha256.to_owned(),
        installed_at: now_ms,
    };
    let bytes = serde_json::to_vec(&marker).map_err(|e| io_failed("Cannot write the marker", &e.into()))?;
    write_atomic(&dir.join(COMPLETE_MARKER), &bytes).map_err(|e| io_failed("Cannot write the marker", &e))
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallState {
    pub current: Option<String>,
    pub previous: Option<String>,
}

/// Makes `install_id` current; the version it replaces becomes previous.
pub fn record_current(paths: &RemotePaths, install_id: &str) -> Result<InstallState, EnsureError> {
    let mut state: InstallState = fs::read(&paths.state)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if state.current.as_deref() != Some(install_id) {
        state.previous = state.current.take();
        state.current = Some(install_id.to_owned());
    }
    let mut bytes = serde_json::to_vec(&state).map_err(|e| io_failed("Cannot write state.json", &e.into()))?;
    bytes.push(b'\n');
    write_atomic(&paths.state, &bytes).map_err(|e| io_failed("Cannot write state.json", &e))?;
    Ok(state)
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct GcReport {
    pub removed: Vec<String>,
    pub skipped: Option<&'static str>,
}

/// Removes version and dependency directories that are not in `keep` and that no running
/// process's executable lives in, plus staging leftovers of dead installers (the caller holds
/// the install lock). Without a process list nothing is removed.
pub fn collect(paths: &RemotePaths, keep: &HashSet<String>, images: Option<&[ProcessImage]>) -> GcReport {
    let mut report = GcReport::default();
    let Some(images) = images else {
        report.skipped = Some("process list unavailable");
        return report;
    };
    for (area, label) in [(&paths.versions, "versions"), (&paths.deps, "deps")] {
        let Ok(entries) = fs::read_dir(area) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let Ok(name) = entry.file_name().into_string() else { continue };
            let dir = entry.path();
            if name.starts_with('.') {
                if (name.starts_with(".staging-") || name.starts_with(".gc-")) && fs::remove_dir_all(&dir).is_ok() {
                    report.removed.push(format!("{label}/{name}"));
                }
                continue;
            }
            let keeps = label == "versions" && keep.contains(&name);
            let in_use = images.iter().any(|p| p.within(&dir));
            if keeps || in_use || !dir.is_dir() {
                continue;
            }
            if drop_tree(&dir) {
                report.removed.push(format!("{label}/{name}"));
            }
        }
    }
    // The pre-versioned layout of the first desktop installs: `~/.mixdog-remote/<x.y.z>`.
    if let Ok(entries) = fs::read_dir(&paths.root) {
        for entry in entries.filter_map(Result::ok) {
            let Ok(name) = entry.file_name().into_string() else { continue };
            let dir = entry.path();
            if is_pre_versioned(&name) && dir.is_dir() && !images.iter().any(|p| p.within(&dir)) && drop_tree(&dir) {
                report.removed.push(name);
            }
        }
    }
    report
}

/// `\d+\.\d+\.\d+` followed by anything.
fn is_pre_versioned(name: &str) -> bool {
    let mut rest = name;
    for part in 0..3 {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &rest[digits..];
        if part < 2 {
            let Some(after) = rest.strip_prefix('.') else { return false };
            rest = after;
        }
    }
    true
}

/// Renamed away first, so a half-deleted directory is never mistaken for an install.
fn drop_tree(dir: &Path) -> bool {
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let grave = dir.with_file_name(format!(".gc-{name}-{}", std::process::id()));
    fs::rename(dir, &grave).is_ok() && {
        let _ = fs::remove_dir_all(&grave);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(bytes: &[u8]) -> String {
        crate::lifecycle::hex(&Sha256::digest(bytes))
    }

    fn source(home: &tempfile::TempDir, bytes: &[u8]) -> PathBuf {
        let path = home.path().join("staged");
        fs::write(&path, bytes).unwrap();
        path
    }

    fn setup() -> (tempfile::TempDir, RemotePaths) {
        let home = tempfile::tempdir().unwrap();
        let paths = RemotePaths::new(home.path());
        (home, paths)
    }

    #[test]
    fn upload_is_verified_published_and_found_again() {
        let (home, paths) = setup();
        let body = b"binary".to_vec();
        let sha = hash(&body);
        let spec = InstallSpec { install_id: "1.4.6-abc", version: "1.4.6", build: "abc", sha256: Some(&sha) };
        let first = ensure_installed(&paths, &spec, 7, Some(&source(&home, &body))).unwrap();
        assert!(first.fresh);
        assert_eq!(fs::read(&first.exe).unwrap(), body);
        let second = ensure_installed(&paths, &spec, 8, None).unwrap();
        assert_eq!(second, Installed { exe: first.exe.clone(), fresh: false });
        let leftovers: Vec<_> = fs::read_dir(&paths.versions).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no staging directory remains");
    }

    #[test]
    fn the_payload_beside_the_binary_is_published_with_it() {
        let (home, paths) = setup();
        let body = b"binary".to_vec();
        let sha = hash(&body);
        let source = source(&home, &body);
        let payload = home.path().join(PAYLOAD_DIR);
        fs::create_dir_all(payload.join("js")).unwrap();
        fs::write(payload.join("js").join("node"), b"node").unwrap();
        fs::write(payload.join("js-runtime.json"), b"{}").unwrap();
        let spec = InstallSpec { install_id: "1.4.6-abc", version: "1.4.6", build: "abc", sha256: Some(&sha) };
        let installed = ensure_installed(&paths, &spec, 1, Some(&source)).unwrap();
        let dir = installed.exe.parent().unwrap();
        assert_eq!(fs::read(dir.join("js").join("node")).unwrap(), b"node");
        assert_eq!(fs::read(dir.join("js-runtime.json")).unwrap(), b"{}");
        assert!(!dir.join(PAYLOAD_DIR).exists(), "the entries are placed, not nested");
        assert!(find_installed(&paths, &spec).unwrap().is_some());
    }

    #[test]
    fn missing_install_without_upload_is_a_fact_not_a_guess() {
        let (_home, paths) = setup();
        let spec = InstallSpec { install_id: "1.4.6-abc", version: "1.4.6", build: "abc", sha256: Some("00") };
        assert_eq!(
            ensure_installed(&paths, &spec, 0, None),
            Err(EnsureError::InstallMissing("1.4.6-abc".into()))
        );
    }

    #[test]
    fn a_wrong_checksum_publishes_nothing() {
        let (home, paths) = setup();
        let spec = InstallSpec { install_id: "1.4.6-abc", version: "1.4.6", build: "abc", sha256: Some("00") };
        let error = ensure_installed(&paths, &spec, 0, Some(&source(&home, b"x"))).unwrap_err();
        assert!(matches!(error, EnsureError::ChecksumMismatch { .. }));
        assert_eq!(fs::read_dir(&paths.versions).unwrap().count(), 0);
    }

    #[test]
    fn a_directory_without_its_marker_is_replaced() {
        let (home, paths) = setup();
        let dir = paths.versions.join("1.4.6-abc");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(BINARY_NAME), b"half").unwrap();
        let body = b"whole".to_vec();
        let sha = hash(&body);
        let spec = InstallSpec { install_id: "1.4.6-abc", version: "1.4.6", build: "abc", sha256: Some(&sha) };
        let installed = ensure_installed(&paths, &spec, 0, Some(&source(&home, &body))).unwrap();
        assert_eq!(fs::read(installed.exe).unwrap(), body);
    }

    #[test]
    fn state_keeps_current_and_previous() {
        let (_home, paths) = setup();
        fs::create_dir_all(&paths.root).unwrap();
        record_current(&paths, "a").unwrap();
        record_current(&paths, "b").unwrap();
        let state = record_current(&paths, "b").unwrap();
        assert_eq!(state, InstallState { current: Some("b".into()), previous: Some("a".into()) });
    }

    #[test]
    fn collect_keeps_current_previous_and_running_installs() {
        let (_home, paths) = setup();
        for name in ["cur", "prev", "running", "old", ".staging-x-1-2"] {
            fs::create_dir_all(paths.versions.join(name)).unwrap();
        }
        fs::create_dir_all(paths.deps.join("dep")).unwrap();
        let keep: HashSet<String> = ["cur", "prev"].map(String::from).into();
        let images = [ProcessImage { pid: 9, image: paths.versions.join("running").join(BINARY_NAME) }];
        let report = collect(&paths, &keep, Some(&images));
        let mut removed = report.removed.clone();
        removed.sort();
        assert_eq!(removed, ["deps/dep", "versions/.staging-x-1-2", "versions/old"]);
        for kept in ["cur", "prev", "running"] {
            assert!(paths.versions.join(kept).exists(), "{kept}");
        }
    }

    #[test]
    fn collect_removes_nothing_without_a_process_list() {
        let (_home, paths) = setup();
        fs::create_dir_all(paths.versions.join("old")).unwrap();
        let report = collect(&paths, &HashSet::new(), None);
        assert_eq!(report.skipped, Some("process list unavailable"));
        assert!(paths.versions.join("old").exists());
    }
}
