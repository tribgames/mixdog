//! Node's trace sink cases (`fixtures/trace-rows-cases`, `record-trace-rows-cases.mjs`): the redaction case's calls through
//! `AgentTrace::tool` and a flush, the whole `trace.jsonl` and `failures.jsonl` texts against Node's. The cases the
//! manifest names are left out.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use mixdog_trace::AgentTrace;
use mixdog_trace::TraceConfig;
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/trace-rows-cases").join(name);
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn every_recorded_trace_case_writes_nodes_files() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut replayed = 0;
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        assert_eq!(case["kind"], "redaction", "{}: no replay and no exclusion", case["case"]);
        let dir = tempfile::tempdir().unwrap();
        let (trace_path, failures_path) = (dir.path().join("trace.jsonl"), dir.path().join("failures.jsonl"));
        let env: BTreeMap<&str, String> = [
            ("MIXDOG_AGENT_TRACE_PATH", trace_path.to_string_lossy().into_owned()),
            ("MIXDOG_TOOL_FAILURE_LOG_PATH", failures_path.to_string_lossy().into_owned()),
        ]
        .into_iter()
        .collect();
        let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &|name| env.get(name).cloned(), false));
        let now = case["now"].as_i64().unwrap();
        for call in case["calls"].as_array().unwrap() {
            trace.tool(call.as_object().unwrap(), now);
        }
        assert!(trace.flush(now).is_empty());
        let read = |path: &Path| fs::read_to_string(path).unwrap();
        assert_eq!(read(&trace_path), case["recorded"]["trace"].as_str().unwrap(), "{}: trace.jsonl", case["case"]);
        assert_eq!(read(&failures_path), case["recorded"]["failures"].as_str().unwrap(), "{}: failures.jsonl", case["case"]);
        replayed += 1;
    }
    assert_eq!(replayed + excluded.len(), cases.len());
}
