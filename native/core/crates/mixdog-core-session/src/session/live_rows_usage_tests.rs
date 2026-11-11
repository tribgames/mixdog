//! `session-usage-totals.test.mjs:32` (first half): the usage event of one provider response carries the tool
//! calls that response dispatched, and none when it dispatched none, against Node's `usageDeltaEvent`
//! (`fixtures/session-usage-totals/golden.json`, `benchmarks/rust-core/recorders/record-session-usage-totals.mjs`).

use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;

use super::usage_delta;
use crate::session::run::UsageReport;

#[test]
fn the_usage_event_equals_nodes_usage_delta_event() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/session-usage-totals/golden.json")).unwrap();
    for case in golden["deltas"].as_array().unwrap() {
        let event = &case["event"];
        let report = UsageReport {
            iteration: event["iterationIndex"].as_u64().unwrap() as u32,
            usage: Usage { input_tokens: 10, output_tokens: 2, ..Usage::default() },
            model: "m".into(),
            requested_model: "m".into(),
            // What the loop counted of the response's calls: none when it dispatched none.
            delta_tool_calls: case["toolCalls"].as_u64().unwrap_or(0),
            request_ms: 0,
            delta_prompt: 0,
            send_tools: Vec::new(),
            reasoning_tokens: None,
            reasoning_tokens_complete: false,
            outgoing: Vec::new(),
            sent_at_ms: 0,
        };
        assert_eq!(usage_delta("s", &report, event["ts"].as_i64().unwrap()), *event, "{}", case["toolCalls"]);
    }
}
