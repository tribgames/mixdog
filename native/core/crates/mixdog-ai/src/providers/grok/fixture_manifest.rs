//! The manifest of a recorded fixture set (`native/core/fixtures/<set>/MANIFEST.json`) read as the pre-review gate reads it:
//! an exact recording of Node b6f10295a, and every file listed there is the file the test reads, byte for byte.

use std::path::Path;

use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

pub const NODE_COMMIT: &str = "b6f10295a2f698afc85332467192de28500bd146";

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The paths of every file under `dir` but its MANIFEST.json, `/`-separated, sorted as the recorders' `walkFiles` sorts.
fn files_under(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.push(path.strip_prefix(root).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.retain(|path| path != "MANIFEST.json");
    out.sort();
    out
}

/// Panics unless `dir`'s MANIFEST.json records an exact recording of the Node commit by `recorder` (a path from the
/// repository root, whose content hash the manifest names), and lists exactly the files the directory holds, each with
/// its size and sha256: an extra, missing or changed file, or a changed recorder, fails.
pub fn verify_dir(repo: &Path, dir: &Path, recorder: &str) -> Value {
    let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("MANIFEST.json")).unwrap()).unwrap();
    assert_eq!(manifest["product"]["exact"], true, "the recording is not exact");
    assert_eq!(manifest["product"]["commit"], NODE_COMMIT, "the recording is of another Node commit");
    assert_eq!(manifest["recorder"], recorder, "the manifest names another recorder");
    let recorder_bytes = std::fs::read(repo.join(recorder)).unwrap();
    assert_eq!(manifest["recorderSha256"], sha256(&recorder_bytes), "{recorder} changed since the recording (re-record)");
    let listed = manifest["files"].as_array().unwrap();
    assert_eq!(
        listed.iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect::<Vec<_>>(),
        files_under(dir),
        "the directory holds other files than the manifest lists"
    );
    for entry in listed {
        let name = entry["path"].as_str().unwrap();
        let content = std::fs::read(dir.join(name)).unwrap();
        assert_eq!(entry["bytes"].as_u64(), Some(content.len() as u64), "{name}: size differs from the manifest (re-record, never hand-edit)");
        assert_eq!(entry["sha256"], sha256(&content), "{name}: sha256 differs from the manifest (re-record, never hand-edit)");
    }
    manifest
}