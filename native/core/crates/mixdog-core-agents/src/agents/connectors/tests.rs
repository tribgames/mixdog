use std::path::Path;

use serde_json::Value;
use serde_json::json;

use super::*;

fn twin() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/connector-policy-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[test]
fn a_policy_is_stored_as_the_recorded_node_stores_it() {
    let twin = twin();
    let cases = twin["stored"].as_array().unwrap();
    assert!(cases.len() > 300);
    let mut failures = Vec::new();
    for case in cases {
        let got = match policy_input(&case["input"]) {
            Ok(stored) => json!({ "ok": stored }),
            Err(message) => json!({ "error": message }),
        };
        let want = if case.get("ok").is_some() { json!({ "ok": case["ok"] }) } else { json!({ "error": case["error"] }) };
        // Compared as JavaScript writes them: integer-like keys first.
        if mixdog_js::json_stringify(&got) != mixdog_js::json_stringify(&want) {
            failures.push(format!("{}: stored {got}, Node {want}", case["input"]));
        }
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn the_no_widen_check_judges_as_the_recorded_node_does_plain_and_inside_an_approved_change() {
    let twin = twin();
    let cases = twin["checks"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let approved = case["approved"].as_object().map(|change| ApprovedToolChange {
            server: change["server"].as_str().unwrap().into(),
            tool: change["tool"].as_str().unwrap().into(),
            from: Permission::parse(change["from"].as_str().unwrap()).unwrap(),
            to: Permission::parse(change["to"].as_str().unwrap()).unwrap(),
        });
        let present = |key: &str| Some(&case[key]).filter(|value| !value.is_null());
        let got = match assert_not_widened(present("before"), present("after"), approved.as_ref()) {
            Ok(()) => json!({ "ok": null }),
            Err(message) => json!({ "error": message }),
        };
        let want = if case.get("ok").is_some() { json!({ "ok": null }) } else { json!({ "error": case["error"] }) };
        if got != want {
            failures.push(format!("{} -> {} approved {}: {got}, Node {want}", case["before"], case["after"], case["approved"]));
        }
    }
    assert!(cases.len() > 1000);
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn tool_names_that_trim_alike_resolve_in_javascript_key_order_whatever_order_they_arrive_in() {
    // `Object.entries` lists "7" before " 7", so the later (" 7") wins; file order says otherwise.
    let given: Value = serde_json::from_str(r#"{"tools":{"gmail":{" 7":"auto","7":"disabled"}}}"#).unwrap();
    let stored = policy_input(&given).unwrap().unwrap();
    assert_eq!(stored["tools"]["gmail"], json!({ "7": "auto" }));
}

#[test]
fn accounts_with_one_number_rank_in_the_order_the_stored_policy_lists_them() {
    // `gmail-2` is listed before `gmail-02` and the sort is stable, so the disabled one decides.
    let before = json!({ "off": [], "tools": { "gmail-2": { "send": "disabled" }, "gmail-02": { "send": "auto" } } });
    let after = json!({ "off": [], "tools": { "gmail": { "send": "auto" } } });
    assert!(assert_not_widened(Some(&before), Some(&after), None).is_err());
    let reversed = json!({ "off": [], "tools": { "gmail-02": { "send": "auto" }, "gmail-2": { "send": "disabled" } } });
    assert!(assert_not_widened(Some(&reversed), Some(&after), None).is_ok());
}
