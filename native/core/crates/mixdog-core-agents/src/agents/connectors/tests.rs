use serde_json::Value;
use serde_json::json;

use super::*;

mod policy;

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
