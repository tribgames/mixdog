//! Shared TS/Rust parity cases: `parity/<name>.json` = `{name, cases: [{id, input, expect}]}`, read here and by
//! `scripts/parity/cases.mjs`, so both implementations are pinned to one table. A mismatch names the case id.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

/// This crate's manifest from the checkout's root: what marks a directory as the checkout.
const SELF_MANIFEST: &str = "native/core/crates/mixdog-testkit/Cargo.toml";

/// One row of a case file.
#[derive(Clone, Debug, PartialEq)]
pub struct Case {
    pub id: String,
    pub input: Value,
    pub expect: Value,
}

/// The directory of the case files, found from the manifest directory cargo names in the test's environment (any
/// crate of the checkout) or else the working directory. Panics when no checkout is found.
fn parity_dir() -> PathBuf {
    let start = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from).or_else(|| std::env::current_dir().ok());
    let root = start
        .as_deref()
        .and_then(|dir| dir.ancestors().find(|ancestor| crate::exists(ancestor.join(SELF_MANIFEST))))
        .unwrap_or_else(|| panic!("parity: no checkout found from {start:?}"));
    root.join("native/core/crates/mixdog-testkit/parity")
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The cases of `parity/<name>.json`, in file order. Panics when the file is missing or malformed (a case
/// without `id`, `input` or `expect`, a duplicate id, a `name` that differs from the file's).
pub fn cases(name: &str) -> Vec<Case> {
    assert!(valid_name(name), "parity: invalid case file name {name:?}");
    let path = parity_dir().join(format!("{name}.json"));
    parse(name, &path, &crate::read_string(&path))
}

fn parse(name: &str, path: &Path, text: &str) -> Vec<Case> {
    let file: Value = serde_json::from_str(text).unwrap_or_else(|error| panic!("parity: {}: {error}", path.display()));
    assert_eq!(file.get("name").and_then(Value::as_str), Some(name), "parity: {}: \"name\" must be {name:?}", path.display());
    let rows = file.get("cases").and_then(Value::as_array).unwrap_or_else(|| panic!("parity: {}: \"cases\" is not an array", path.display()));
    let mut out: Vec<Case> = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).unwrap_or_else(|| panic!("parity: {}: case {index} has no string \"id\"", path.display()));
        assert!(out.iter().all(|c| c.id != id), "parity: {}: duplicate case id {id}", path.display());
        let (Some(input), Some(expect)) = (row.get("input"), row.get("expect")) else { panic!("parity: {}: case {id} needs \"input\" and \"expect\"", path.display()) };
        out.push(Case { id: id.to_owned(), input: input.clone(), expect: expect.clone() });
    }
    out
}

/// Panics naming the case id unless `actual` equals the case's `expect`.
pub fn assert_case(case: &Case, actual: &Value) {
    assert!(actual == &case.expect, "parity case {}: expected {}, got {}", case.id, case.expect, actual);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(input: &Value) -> Value {
        let args = &input["args"];
        match input["op"].as_str().expect("op") {
            "add" => json!(args[0].as_i64().expect("a") + args[1].as_i64().expect("b")),
            "upper" => json!(args[0].as_str().expect("s").to_uppercase()),
            "join" => {
                let parts: Vec<&str> = args[0].as_array().expect("list").iter().map(|v| v.as_str().expect("s")).collect();
                json!(parts.join(args[1].as_str().expect("sep")))
            }
            "pair" => json!({ args[0].as_str().expect("k"): args[1] }),
            op => panic!("unknown op {op}"),
        }
    }

    #[test]
    fn parity_sample_cases_load_and_pass() {
        let cases = cases("sample");
        let ids: Vec<&str> = cases.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["add-small", "upper-ascii", "join-list", "empty-join", "object-result"]);
        for case in &cases {
            assert_case(case, &run(&case.input));
        }
    }

    #[test]
    #[should_panic(expected = "parity case add-small")]
    fn parity_mismatch_names_the_case_id() {
        let first = cases("sample").remove(0);
        assert_case(&first, &json!(4));
    }

    #[test]
    #[should_panic(expected = "duplicate case id a")]
    fn parity_duplicate_ids_are_rejected() {
        parse("x", Path::new("x.json"), r#"{"name":"x","cases":[{"id":"a","input":1,"expect":1},{"id":"a","input":1,"expect":1}]}"#);
    }

    #[test]
    #[should_panic(expected = "invalid case file name")]
    fn parity_path_names_are_rejected() {
        cases("../sample");
    }
}
