//! `describeRequestSessions`' `internalKindOf` and `openable` against Node's answers
//! (`fixtures/session-metadata/golden.json`, `record-session-metadata.mjs`).

use serde_json::Value;

use super::internal_kind;
use super::is_openable;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../../fixtures/session-metadata/golden.json")).expect("golden json")
}

#[test]
fn internal_kind_equals_nodes() {
    let golden = golden();
    for entry in golden["internalKinds"].as_array().expect("internalKinds") {
        let source = entry["source"].as_str().expect("source");
        assert_eq!(internal_kind(source), entry["kind"].as_str().expect("kind"), "{source:?}");
    }
}

#[test]
fn openable_equals_nodes() {
    let golden = golden();
    for case in golden["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let mut own = case["expected"].clone();
        // The list row's `owner` is `session.owner || 'user'`; `isLeadVisibleRow` applies the same default.
        if own["owner"].is_null() {
            own["owner"] = Value::from("user");
        }
        assert_eq!(is_openable(&own, ""), case["openable"]["unowned"], "{id} without an owner link");
        assert_eq!(is_openable(&own, "r_owner"), case["openable"]["owned"], "{id} with an owner link");
    }
}
