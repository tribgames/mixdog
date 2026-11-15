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

/// What stands for an embedded workbook in a snapshot once its entries are compared.
pub const EMBEDDED: &str = "<an embedded workbook, compared by its entries>";

/// An embedded workbook is a zip whose bytes carry the wall-clock stamp of the run that wrote them and the compressor's
/// own deflate (JSZip's pako there, the `zip` crate here), so its bytes are not compared one by one: the recording kept
/// them as UTF-8-decoded text (every byte of 0x80 and above a replacement character, or merged with its neighbours), and
/// the entries are compared as far as that text shows them. For every entry of ours, in order, the recorded text has its
/// local header (signature, the flags and the method, the CRC-32 of the uncompressed bytes and their size wherever
/// the header's bytes are readable as they were written, the name), and the end record counts the same entries. A header
/// that differs is a different workbook: the CRC-32 stands for the uncompressed bytes.
pub fn embedded_matches(recorded: &str, ours: &[u8]) -> Result<(), String> {
    let text: Vec<char> = recorded.chars().collect();
    let read16 = |at: usize| usize::from(u16::from_le_bytes([ours[at], ours[at + 1]]));
    let read32 = |at: usize| u32::from_le_bytes([ours[at], ours[at + 1], ours[at + 2], ours[at + 3]]) as usize;
    let mut cursor = 0;
    let mut from = 0;
    let mut count = 0;
    while ours.len() >= cursor + 30 && ours[cursor..cursor + 4] == *b"PK\x03\x04" {
        let (name_length, extra_length, packed) = (read16(cursor + 26), read16(cursor + 28), read32(cursor + 18));
        let name = String::from_utf8_lossy(&ours[cursor + 30..cursor + 30 + name_length]).into_owned();
        let name_chars: Vec<char> = name.chars().collect();
        let Some(start) = (from..text.len().saturating_sub(3)).find(|at| text[*at..*at + 4] == ['P', 'K', '\u{3}', '\u{4}']) else {
            return Err(format!("the recording has no local header for `{name}` (entry {count})"));
        };
        // Bytes of 0x80 and above in the 26 fixed bytes may have merged: the name follows 30 characters on, or a few fewer.
        let Some(shift) = (0..=4usize).find(|shift| {
            let at = start + 30 - shift;
            at + name_chars.len() <= text.len() && text[at..at + name_chars.len()] == name_chars[..]
        }) else {
            return Err(format!("entry {count} of the recording is not `{name}`: its header reads {:?}", text[start..(start + 40).min(text.len())].iter().collect::<String>()));
        };
        // The version needed to extract is not compared: JSZip writes 10 for every entry, the `zip` crate 20 for a deflated one,
        // and no reader reads a difference. The flags and the method are.
        for (index, byte) in ours[cursor + 6..cursor + 10].iter().enumerate() {
            if text[start + 6 + index] != char::from(*byte) {
                return Err(format!("`{name}`: flags or method byte {index} is {byte}, recorded {:?}", text[start + 6 + index]));
            }
        }
        // The core properties carry the moment the workbook was written (created and modified), so their checksum and size are the run's.
        if shift == 0 && name != "docProps/core.xml" {
            for position in (14..18).chain(22..26) {
                let (byte, shown) = (ours[cursor + position], text[start + position]);
                let agrees = if byte < 0x80 { shown == char::from(byte) } else { shown == '\u{fffd}' };
                if !agrees {
                    return Err(format!("`{name}`: header byte {position} (CRC-32 or size) is {byte}, recorded {shown:?}"));
                }
            }
        }
        from = start + 30 - shift + name_chars.len();
        cursor += 30 + name_length + extra_length + packed;
        count += 1;
    }
    // The central directory: the same entries in the same order, each with its method, its external attributes and the
    // length of its comment wherever the recording's text shows them as they were written.
    let mut from = 0;
    let mut cursor = ours.len().saturating_sub(22);
    while cursor > 0 && ours[cursor..cursor + 4] != *b"PK\x05\x06" {
        cursor -= 1;
    }
    let mut at = read32(cursor + 16);
    for index in 0..count {
        if ours[at..at + 4] != *b"PK\x01\x02" {
            return Err(format!("our central directory ends before entry {index}"));
        }
        let (name_length, extra_length, comment_length) = (read16(at + 28), read16(at + 30), read16(at + 32));
        let name = String::from_utf8_lossy(&ours[at + 46..at + 46 + name_length]).into_owned();
        let name_chars: Vec<char> = name.chars().collect();
        let Some(start) = (from..text.len().saturating_sub(3)).find(|at| text[*at..*at + 4] == ['P', 'K', '\u{1}', '\u{2}']) else {
            return Err(format!("the recording has no central entry for `{name}` (entry {index})"));
        };
        let Some(shift) = (0..=16usize).find(|shift| {
            let place = (start + 46).wrapping_sub(*shift);
            place + name_chars.len() <= text.len() && text[place..place + name_chars.len()] == name_chars[..]
        }) else {
            return Err(format!("central entry {index} of the recording is not `{name}`"));
        };
        if shift == 0 {
            if text[start + 10] != char::from(ours[at + 10]) || text[start + 11] != char::from(ours[at + 11]) {
                return Err(format!("`{name}`: the compression method differs from the recording"));
            }
            for position in 38..42 {
                let (byte, shown) = (ours[at + position], text[start + position]);
                let agrees = if byte < 0x80 { shown == char::from(byte) } else { shown == '\u{fffd}' };
                if !agrees {
                    return Err(format!("`{name}`: external attribute byte {} is {byte}, recorded {shown:?}", position - 38));
                }
            }
            if text[start + 32] != char::from(ours[at + 32]) || text[start + 33] != char::from(ours[at + 33]) {
                return Err(format!("`{name}`: the comment length differs from the recording ({comment_length} here)"));
            }
        }
        from = (start + 46).wrapping_sub(shift) + name_chars.len();
        at += 46 + name_length + extra_length + comment_length;
    }
    let end = (0..text.len().saturating_sub(3)).rev().find(|at| text[*at..*at + 4] == ['P', 'K', '\u{5}', '\u{6}']);
    match end {
        Some(at) if text.get(at + 10) == Some(&char::from(u8::try_from(count).expect("a small workbook"))) => Ok(()),
        _ => Err(format!("the recording's end record does not count {count} entries")),
    }
}

/// The recorded snapshot and ours with every embedded workbook of ours compared by [`embedded_matches`] and put out of
/// both: what is left is compared byte for byte. `file` gives the bytes of a part of the package by its name.
pub fn settle_embedded(recorded: &Value, produced: &Value, file: impl Fn(&str) -> Option<Vec<u8>>) -> (Value, Value) {
    let (mut recorded, mut produced) = (recorded.clone(), produced.clone());
    let names: Vec<String> = produced["parts"].as_object().map(|parts| parts.keys().cloned().collect()).unwrap_or_default();
    for name in names {
        let (Some(ours), Some(theirs)) = (produced["parts"][&name].as_str(), recorded["parts"][&name].as_str()) else { continue };
        if name.ends_with(".xlsx") && ours.starts_with("PK\u{3}\u{4}") && theirs.starts_with("PK\u{3}\u{4}") {
            let bytes = file(&name).expect("the part");
            if let Err(reason) = embedded_matches(theirs, &bytes) {
                panic!("{name}: {reason}");
            }
            produced["parts"][&name] = Value::from(EMBEDDED);
            recorded["parts"][&name] = Value::from(EMBEDDED);
        }
    }
    (recorded, produced)
}
