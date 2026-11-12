//! `traceCacheBreak`: the payload, the trace row and the stderr line of every recorded record equal Node's, and the
//! writer leaves Node's line in the trace file, replayed from `fixtures/cache-break/golden.json`
//! (benchmarks/rust-core/recorders/record-cache-break.mjs).
#![allow(clippy::disallowed_methods, reason = "fixture loading reads files synchronously; tests are not lane code")]

use std::fs;
use std::path::Path;

use serde_json::Value;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/cache-break/golden.json");
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn every_payload_row_and_line_is_nodes() {
    let golden = golden();
    let cases = golden["payloads"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let record = case["record"].as_object().unwrap();
        let label = record["sessionId"].to_string();
        assert_eq!(Value::Object(mixdog_trace::cache_break_payload(record)), case["payload"], "{label}: payload");
        let row = mixdog_trace::cache_break_trace_record(record);
        assert_eq!(mixdog_trace::stringify(&Value::Object(row)), mixdog_trace::stringify(&case["row"]), "{label}: row");
        assert_eq!(format!("{}\n", mixdog_trace::cache_break_line(record)), case["stderr"].as_str().unwrap(), "{label}: stderr");
    }
}

/// The writer's file holds the row as Node's `appendAgentTrace` wrote it.
#[test]
fn the_trace_file_holds_nodes_line() {
    let golden = golden();
    let now = golden["now"].as_i64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    let env = |name: &str| (name == "MIXDOG_DIAGNOSTICS").then(|| "1".to_owned());
    let trace = mixdog_trace::AgentTrace::new(&mixdog_trace::TraceConfig::from_env(&data, &env, false));
    let record = serde_json::json!({
        "sessionId": golden["loop"]["session"], "iteration": 1, "classification": "intentional",
        "reason": "image_strip_nonpersistent_rebaseline", "source": "image_strip_retry", "provider": golden["loop"]["provider"],
        "model": golden["loop"]["model"], "previousCount": 2, "nextCount": 2,
    });
    trace.cache_break(record.as_object().unwrap(), now);
    assert!(trace.flush(now).is_empty());
    let written = fs::read_to_string(data.join("history").join("agent-trace.jsonl")).unwrap();
    let lines: Vec<&str> = written.lines().collect();
    assert_eq!(serde_json::json!(lines), golden["loop"]["rows"]);
}
