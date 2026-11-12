//! The core's half of a replay a client library finishes: the core's values for a recording, written beside the client
//! test that turns them into what the recording observed.

use std::path::Path;

use serde_json::Value;
use serde_json::json;

/// Writes `{ inputs, core }` to `path`: `inputs` is the sha256 the set's `MANIFEST.json` gives its `golden.json` (the client
/// test refuses a file made from another recording), `core` the values the core gave now. A file that differed is
/// rewritten and the test fails, so the client never reads values the core no longer gives without the change showing.
pub fn chain_output(path: &Path, set_dir: &Path, core: Value, what: &str) {
    let manifest: Value = serde_json::from_slice(&crate::read(set_dir.join("MANIFEST.json"))).unwrap_or_else(|e| panic!("{}: {e}", set_dir.display()));
    let inputs = manifest["files"]
        .as_array()
        .and_then(|files| files.iter().find(|file| file["path"] == "golden.json"))
        .and_then(|file| file["sha256"].as_str())
        .unwrap_or_else(|| panic!("{}: MANIFEST.json names no golden.json sha256", set_dir.display()))
        .to_owned();
    let produced = format!("{}\n", serde_json::to_string_pretty(&json!({ "inputs": inputs, "core": core })).unwrap());
    let committed = crate::exists(path).then(|| crate::read_string(path));
    if committed.as_deref() != Some(produced.as_str()) {
        crate::write(path, &produced);
        panic!("{what}: {} did not hold what the core gives now; it is rewritten, review and commit it", path.display());
    }
}
