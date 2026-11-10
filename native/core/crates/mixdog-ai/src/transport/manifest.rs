//! The manifest of a recorded fixture set (`native/core/fixtures/<set>/MANIFEST.json`) read as the pre-review gate reads it:
//! an exact recording of Node b6f10295a, and every file listed there is the file the test reads, byte for byte.

use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

pub const NODE_COMMIT: &str = "b6f10295a2f698afc85332467192de28500bd146";

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Panics unless `manifest` records exactly `files` (name, content) from the exact Node commit.
pub fn verify(manifest: &str, files: &[(&str, &str)]) -> Value {
    let manifest: Value = serde_json::from_str(manifest).unwrap();
    assert_eq!(manifest["product"]["exact"], true, "the recording is not exact");
    assert_eq!(manifest["product"]["commit"], NODE_COMMIT, "the recording is of another Node commit");
    let listed = manifest["files"].as_array().unwrap();
    assert_eq!(
        listed.iter().map(|f| f["path"].as_str().unwrap()).collect::<Vec<_>>(),
        files.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
        "the manifest lists other files than the test reads"
    );
    for (entry, (name, content)) in listed.iter().zip(files) {
        assert_eq!(entry["bytes"].as_u64(), Some(content.len() as u64), "{name}: size differs from the manifest (re-record, never hand-edit)");
        assert_eq!(entry["sha256"], sha256(content.as_bytes()), "{name}: sha256 differs from the manifest (re-record, never hand-edit)");
    }
    manifest
}