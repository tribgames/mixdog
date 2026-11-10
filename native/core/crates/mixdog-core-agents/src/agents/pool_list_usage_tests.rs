//! `usage_totals` replayed against Node's `sessionUsageTotals` (`fixtures/session-usage-totals/golden.json`,
//! `benchmarks/rust-core/recorders/record-session-usage-totals.mjs`).

use serde_json::Value;
use serde_json::json;

use super::usage_totals;

#[test]
fn session_usage_totals_equal_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-usage-totals/golden.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let (usage, tool_calls) = usage_totals(case["session"].as_object());
        let totals = json!({"usage": usage.unwrap_or(Value::Null), "toolCalls": tool_calls.unwrap_or(Value::Null)});
        assert_eq!(totals, case["totals"], "{}", case["session"]);
    }
}
