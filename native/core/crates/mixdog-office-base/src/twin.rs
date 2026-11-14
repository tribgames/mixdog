//! The helpers every office twin test shares: locate the Node source, run a recorder with node, load a golden, and
//! compare an output with it after the parts that differ from run to run are normalised (session and transaction ids,
//! `metrics.durationMs`, timestamps, temp paths, review tokens). Other crates' tests reach it as a dev-dependency with
//! the feature `test-support`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys};
use serde_json::{Map, Value};

/// The name the normalisers write for each kind of run-dependent text.
pub const SESSION_ID: &str = "office_<id>";
pub const TRANSACTION_ID: &str = "office_tx_<id>";
pub const TIMESTAMP: &str = "<timestamp>";
pub const TEMP_DIR: &str = "<tmp>";
pub const REVIEW_TOKEN: &str = "<review-token>";

/// The environment variable that names a tree holding the Node source, for a checkout that no longer carries it.
pub const NODE_TREE_VARIABLE: &str = "MIXDOG_NODE_TREE";

static TRANSACTION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"office_tx_[0-9a-f]{16}", "g"));
static SESSION: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"office_[0-9a-f]{16}", "g"));
static ISO_TIME: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)", "g"));

/// The checkout this crate lives in: the directory holding `native/core`.
pub fn repo_root() -> PathBuf {
    let manifest = std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(|| PathBuf::from("."), PathBuf::from);
    manifest.join("../../../..")
}

/// The tree holding the Node source (`src/runtime/office/shared/values.mjs` and its siblings) a recorder runs against:
/// the tree named by [`NODE_TREE_VARIABLE`], else this checkout. Panics naming the variable when neither has it.
pub fn node_source_root() -> PathBuf {
    let marker = "src/runtime/office/shared/values.mjs";
    let named = std::env::var_os(NODE_TREE_VARIABLE).map(PathBuf::from);
    named
        .into_iter()
        .chain(std::iter::once(repo_root()))
        .find(|tree| mixdog_testkit::exists(tree.join(marker)))
        .unwrap_or_else(|| panic!("no tree with {marker}: set {NODE_TREE_VARIABLE} to a checkout of the Node product"))
}

/// Runs `node <recorder> --tree <tree>` (the recorder is a path under this checkout) and returns what it printed.
pub fn run_recorder(recorder: &str, tree: &Path) -> String {
    let script = repo_root().join(recorder);
    let args: [&OsStr; 3] = [script.as_os_str(), OsStr::new("--tree"), tree.as_os_str()];
    mixdog_testkit::output("node", &args)
}

/// `native/core/fixtures/<set>/golden.json`, parsed.
pub fn load_golden(set: &str) -> Value {
    let path = repo_root().join("native/core/fixtures").join(set).join("golden.json");
    serde_json::from_str(&mixdog_testkit::read_string(&path)).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn normalise_text(text: &str) -> String {
    let mut text = text.to_owned();
    let temp = std::env::temp_dir().display().to_string();
    for form in [temp.clone(), temp.replace('\\', "/")] {
        let trimmed = form.trim_end_matches(['\\', '/']);
        if !trimmed.is_empty() {
            text = text.replace(trimmed, TEMP_DIR);
        }
    }
    let text = TRANSACTION.replace_all_with(&text, |_| TRANSACTION_ID.to_owned());
    let text = SESSION.replace_all_with(&text, |_| SESSION_ID.to_owned());
    ISO_TIME.replace_all_with(&text, |_| TIMESTAMP.to_owned())
}

/// The value with every run-dependent part replaced by a fixed name: `office_*` and `office_tx_*` ids, ISO
/// timestamps, the system temp directory, `durationMs` (0) and `reviewToken` ([`REVIEW_TOKEN`]). Object key order is
/// kept.
pub fn normalise(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(normalise_text(text)),
        Value::Array(items) => Value::Array(items.iter().map(normalise).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for key in js_object_keys(map) {
                let item = &map[key];
                let fixed = match (key.as_str(), item) {
                    ("durationMs", Value::Number(_)) => Value::from(0),
                    ("reviewToken", Value::String(_)) => Value::String(REVIEW_TOKEN.to_owned()),
                    _ => normalise(item),
                };
                out.insert(key.clone(), fixed);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// The paths at which two values differ (object key order is not compared); empty when they are equal.
pub fn differences(expected: &Value, actual: &Value) -> Vec<String> {
    let mut out = Vec::new();
    compare("", expected, actual, &mut out);
    out
}

fn compare(path: &str, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                match got.get(key) {
                    Some(other) => compare(&format!("{path}/{key}"), value, other, out),
                    None => out.push(format!("{path}/{key}: missing from the output")),
                }
            }
            for key in got.keys().filter(|key| !want.contains_key(*key)) {
                out.push(format!("{path}/{key}: not in the recording"));
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                out.push(format!("{path}: {} items recorded, {} produced", want.len(), got.len()));
            }
            for (index, (a, b)) in want.iter().zip(got).enumerate() {
                compare(&format!("{path}/{index}"), a, b, out);
            }
        }
        _ if expected == actual => {}
        _ => out.push(format!("{path}: recorded {expected}, produced {actual}")),
    }
}

/// Fails the test listing the first differences between a recorded value and an output, both normalised.
pub fn assert_matches(what: &str, expected: &Value, actual: &Value) {
    let found = differences(&normalise(expected), &normalise(actual));
    assert!(found.is_empty(), "{what} differs from the recording:\n{}", found.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn run_dependent_parts_are_normalised() {
        let value = json!({
            "id": "office_0123456789abcdef", "tx": "office_tx_fedcba9876543210",
            "metrics": { "durationMs": 12.5 }, "reviewToken": "abc",
            "at": "saved 2026-01-02T03:04:05.678Z ok", "n": 1
        });
        assert_eq!(
            normalise(&value),
            json!({
                "id": SESSION_ID, "tx": TRANSACTION_ID,
                "metrics": { "durationMs": 0 }, "reviewToken": REVIEW_TOKEN,
                "at": "saved <timestamp> ok", "n": 1
            })
        );
    }

    #[test]
    fn the_temp_directory_is_named() {
        let temp = std::env::temp_dir().display().to_string().replace('\\', "/");
        let path = format!("{}/x/y.docx", temp.trim_end_matches('/'));
        assert_eq!(normalise(&Value::String(path)), json!("<tmp>/x/y.docx"));
    }

    #[test]
    fn differences_name_the_path() {
        let found = differences(&json!({ "a": [1, 2], "b": { "c": "x" } }), &json!({ "a": [1, 3], "b": { "c": "x", "d": 1 } }));
        assert_eq!(found, ["/a/1: recorded 2, produced 3", "/b/d: not in the recording"]);
        assert!(differences(&json!({ "a": 1, "b": 2 }), &json!({ "b": 2, "a": 1 })).is_empty());
    }
}
