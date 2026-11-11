//! `session-usage-totals.test.mjs:32` (second half): the turn-end fallback adds the turn's tool calls once, and
//! not again when the totals were kept per response, against Node's `applyAskTerminalUsageTotals`
//! (`fixtures/session-usage-totals/golden.json`, `benchmarks/rust-core/recorders/record-session-usage-totals.mjs`):
//! the session header after each call, whole.

use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::TerminalUsage;
use mixdog_agent::compact::pressure::terminal_usage;
use serde_json::Value;

#[test]
fn the_turn_end_totals_equal_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-usage-totals/golden.json")).unwrap();
    for case in golden["terminal"].as_array().unwrap() {
        let mut header: Header = case["header"].as_object().unwrap().clone();
        let result = &case["result"];
        let usage = result.get("usage").filter(|u| !u.is_null());
        let ask = TerminalUsage {
            usage,
            last_turn: result.get("lastTurnUsage").filter(|u| !u.is_null()).or(usage).unwrap(),
            tool_calls_total: result["toolCallsTotal"].as_f64().unwrap(),
            incremental: case["incremental"].as_bool().unwrap(),
            input_excludes_cache: case["excludesCache"].as_bool().unwrap(),
            now: case["now"].as_f64().unwrap(),
        };
        terminal_usage(&header, &ask).apply(&mut header);
        assert_eq!(Value::Object(header), case["after"], "incremental {}", case["incremental"]);
    }
}
