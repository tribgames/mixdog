//! The tool rows (`tool`, `tool_slow`, the failure row) and the helpers they are built from equal what
//! Node's `traceAgentTool` / `classifyToolFailure` / `summarizeToolArgs` / `countJsonNextCalls` wrote,
//! replayed from `fixtures/agent-trace/tools-golden.json` (record-agent-trace-tools.mjs).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O"
)]

use std::fs;
use std::path::Path;

use mixdog_trace as t;
use serde_json::Value;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace/tools-golden.json");
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn tool_rows_and_failure_rows_match_node() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let slow = t::SlowTool::from_env(&|_| None);
    let (mut trace, mut failures) = (String::new(), String::new());
    for case in g["cases"].as_array().unwrap() {
        let records = t::tool_records(case.as_object().unwrap(), &slow, now);
        for record in std::iter::once(&records.tool).chain(records.slow.as_ref()) {
            trace.push_str(&t::stringify(&Value::Object(t::build_row(record, now))));
            trace.push('\n');
        }
        if let Some(row) = &records.failure {
            failures.push_str(&t::stringify(row));
            failures.push('\n');
        }
    }
    let lines = |text: &str| text.lines().map(str::to_string).collect::<Vec<_>>();
    assert_eq!(lines(&trace), lines(g["jsonl"].as_str().unwrap()));
    assert_eq!(lines(&failures), lines(g["failures"].as_str().unwrap()));
}

#[test]
fn classify_tool_failure_matches_node() {
    let g = golden();
    for case in g["classify"].as_array().unwrap() {
        let got = t::classify_tool_failure(&case["text"], case["tool"].as_str().unwrap());
        assert_eq!(got, case["out"].as_str().unwrap(), "{}", case["text"]);
    }
}

#[test]
fn summarize_tool_args_matches_node() {
    let g = golden();
    for case in g["summarize"].as_array().unwrap() {
        let args = Some(&case["args"]).filter(|a| !a.is_null());
        let got = t::summarize_tool_args(case["tool"].as_str().unwrap(), args).unwrap_or(Value::Null);
        assert_eq!(t::stringify(&got), t::stringify(&case["out"]), "{}", case["args"]);
    }
}

#[test]
fn count_json_next_calls_matches_node() {
    let g = golden();
    for case in g["nextCalls"].as_array().unwrap() {
        let got = t::count_json_next_calls(case["text"].as_str().unwrap());
        assert_eq!(got as u64, case["n"].as_u64().unwrap(), "{}", case["text"]);
    }
}

#[test]
fn slow_tool_env_follows_node() {
    let get = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_string())
    };
    let default = t::SlowTool::from_env(&get(&[]));
    assert_eq!(default.threshold_ms, 3000);
    assert_eq!(default.names, Some(vec!["recall".into(), "grep".into(), "code_graph".into()]));
    let all = t::SlowTool::from_env(&get(&[("MIXDOG_SLOW_TOOL_TRACE_MS", "10x"), ("MIXDOG_SLOW_TOOL_TRACE_NAMES", " * ")]));
    assert_eq!((all.threshold_ms, all.names), (10, None));
    let bad = t::SlowTool::from_env(&get(&[("MIXDOG_SLOW_TOOL_TRACE_MS", "-5")]));
    assert_eq!(bad.threshold_ms, 3000);
}
