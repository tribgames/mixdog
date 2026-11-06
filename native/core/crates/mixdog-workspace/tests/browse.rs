//! `projectFs/browseDirs` against Node's `host-directories.ts` (`listHostDirectories` and
//! `listServerDirectories`), recorded on the same fixture folder with Node 22.20.

#![allow(clippy::disallowed_methods, reason = "builds a fixture folder")]

use mixdog_workspace::browse::browse_dirs;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    for sub in ["b", "a/.git", ".hid", "Z"] {
        std::fs::create_dir_all(dir.path().join(sub)).expect("mkdir");
    }
    std::fs::write(dir.path().join("f.txt"), "x").expect("write");
    let canonical = mixdog_workspace::pathguard::canonical(dir.path()).expect("canonical").to_string_lossy().into_owned();
    (dir, canonical)
}

#[test]
fn host_listing_matches_node() {
    let (dir, path) = fixture();
    let got = browse_dirs(&dir.path().to_string_lossy(), None).expect("listing");
    assert_eq!(got, json!({ "path": path, "folders": [".hid", "a", "b", "Z"], "truncated": false }));
}

#[test]
fn server_listing_matches_node() {
    let (dir, path) = fixture();
    let text = dir.path().to_string_lossy().into_owned();
    assert_eq!(
        browse_dirs(&text, Some(false)).expect("listing"),
        json!({ "path": path, "entries": [{ "name": "a", "git": true }, { "name": "b", "git": false }, { "name": "Z", "git": false }], "truncated": false })
    );
    assert_eq!(
        browse_dirs(&text, Some(true)).expect("listing"),
        json!({ "path": path, "entries": [{ "name": ".hid", "git": false }, { "name": "a", "git": true }, { "name": "b", "git": false }, { "name": "Z", "git": false }], "truncated": false })
    );
}

#[test]
fn refusals_carry_nodes_text() {
    let (dir, _) = fixture();
    let file = dir.path().join("f.txt").to_string_lossy().into_owned();
    for (path, message) in [("rel/x", "path must be absolute."), (file.as_str(), "path is not a directory."), ("//?/C:/x", "path is invalid."), ("a\0b", "path is invalid.")] {
        let error = browse_dirs(path, Some(false)).expect_err(path);
        assert_eq!(error.message, message, "{path}");
    }
}
