//! The watchdog abort rows equal what Node's `abortAgentProgressWatchdog` wrote, replayed from
//! `fixtures/agent-trace/watchdog-golden.json` (record-agent-trace-watchdog.mjs).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O"
)]

use std::fs;
use std::path::Path;

use mixdog_trace as t;
use serde_json::Value;

#[test]
fn watchdog_abort_rows_match_node() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace/watchdog-golden.json");
    let g = mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap();
    let now = g["now"].as_i64().unwrap();
    let (mut trace, mut failures) = (String::new(), String::new());
    for case in g["cases"].as_array().unwrap() {
        let mut ctx = case["ctx"].as_object().unwrap().clone();
        ctx.insert("buildVersion".into(), g["buildVersion"].clone());
        let records = t::watchdog_abort_records(&ctx, now);
        assert_eq!(records.is_some(), case["emits"].as_bool().unwrap(), "{}", case["name"]);
        if let Some(abort) = records {
            trace.push_str(&t::stringify(&Value::Object(t::build_row(&abort.trace, now))));
            trace.push('\n');
            failures.push_str(&t::stringify(&abort.failure));
            failures.push('\n');
        }
    }
    assert_eq!(trace, g["jsonl"].as_str().unwrap());
    assert_eq!(failures, g["failures"].as_str().unwrap());
}
