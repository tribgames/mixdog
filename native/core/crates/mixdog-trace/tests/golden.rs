//! The Rust writer leaves the same bytes as Node's `appendAgentTrace` + `logLlmCall` +
//! `traceAgentCompact` + `_appendToolFailureRow`, replayed from
//! `fixtures/agent-trace/golden.json` (recorded by `benchmarks/rust-core/recorders/
//! record-agent-trace.mjs` on a temp `MIXDOG_DATA_DIR`).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use mixdog_trace::AgentTrace;
use mixdog_trace::TraceConfig;
use mixdog_trace::compact_meta_record;
use mixdog_trace::usage_record;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace/golden.json");
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

fn config(data_dir: &Path, extra: &[(&str, &str)]) -> TraceConfig {
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    TraceConfig::from_env(data_dir, &|name| env.get(name).cloned(), false)
}

fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap()
}

fn node_env(keep: i64) -> Vec<(&'static str, String)> {
    vec![
        ("MIXDOG_DIAGNOSTICS", "1".into()),
        ("MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS", "1".into()),
        ("MIXDOG_AGENT_TRACE_ROTATE_KEEP", keep.to_string()),
    ]
}

fn trace_in(dir: &Path, keep: i64) -> AgentTrace {
    let env = node_env(keep);
    let pairs: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    AgentTrace::new(&config(dir, &pairs))
}

#[test]
fn rows_and_failures_match_node() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let trace = trace_in(dir.path(), g["keep"].as_i64().unwrap());
    for case in g["cases"].as_array().unwrap() {
        let record = match case["op"].as_str().unwrap() {
            "append" => object(&case["record"]).clone(),
            "compact" => compact_meta_record(object(&case["input"])),
            "usage" => usage_record(
                object(&case["entry"]),
                case["maintenance"].as_bool().unwrap(),
                now,
            ),
            other => panic!("unknown op {other}"),
        };
        trace.append(&record, now);
    }
    for row in g["failureRows"].as_array().unwrap() {
        trace.append_tool_failure(row, now);
    }
    assert!(trace.flush(now).is_empty());
    let history = dir.path().join("history");
    assert_eq!(
        fs::read_to_string(history.join("agent-trace.jsonl")).unwrap(),
        g["jsonl"].as_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(history.join("tool-failures.jsonl")).unwrap(),
        g["failuresJsonl"].as_str().unwrap()
    );
}

#[test]
fn rotation_matches_node() {
    let g = golden();
    let now0 = g["now"].as_i64().unwrap();
    let blob = "x".repeat(g["bigBlobLen"].as_u64().unwrap() as usize);
    let dir = tempfile::tempdir().unwrap();
    let trace = trace_in(dir.path(), g["keep"].as_i64().unwrap());
    let mut now = now0;
    for i in 1..=3_i64 {
        let big = json!({"kind": "big", "ts": now0 + i, "sessionId": "rot", "payload": {"n": i, "blob": blob}});
        trace.append(object(&big), now);
        assert!(trace.flush(now).is_empty());
        now += 10;
        let small = json!({"kind": "small", "ts": now0 + i, "sessionId": "rot", "payload": {"n": i}});
        trace.append(object(&small), now);
        assert!(trace.flush(now).is_empty());
        now += 10;
    }
    let history = dir.path().join("history");
    let mut seen = Vec::new();
    for entry in fs::read_dir(&history).unwrap() {
        let entry = entry.unwrap();
        let bytes = fs::read(entry.path()).unwrap();
        let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        seen.push((entry.file_name().to_string_lossy().into_owned(), bytes.len() as u64, digest));
    }
    seen.sort();
    let want: Vec<(String, u64, String)> = g["rotation"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap().to_string(),
                f["bytes"].as_u64().unwrap(),
                f["sha256"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(seen, want);
}

#[test]
fn ship_mode_writes_no_local_trace_but_keeps_failures() {
    let dir = tempfile::tempdir().unwrap();
    let trace = AgentTrace::new(&config(dir.path(), &[("MIXDOG_MODE", "ship")]));
    let record = json!({"kind": "loop"});
    assert!(!trace.append(object(&record), 1));
    trace.append_tool_failure(&json!({"tool": "edit"}), 1);
    trace.flush(1);
    let history = dir.path().join("history");
    assert!(!history.join("agent-trace.jsonl").exists());
    assert_eq!(
        fs::read_to_string(history.join("tool-failures.jsonl")).unwrap(),
        "{\"tool\":\"edit\"}\n"
    );
}

#[test]
fn explicit_path_and_disable_switches() {
    let dir = tempfile::tempdir().unwrap();
    let explicit = dir.path().join("sub").join("t.jsonl");
    let path = explicit.to_string_lossy().into_owned();
    let trace = AgentTrace::new(&config(
        dir.path(),
        &[("MIXDOG_MODE", "ship"), ("MIXDOG_AGENT_TRACE_PATH", path.as_str())],
    ));
    trace.append(object(&json!({"kind": "a", "ts": 1})), 1);
    trace.flush(1);
    assert_eq!(
        fs::read_to_string(&explicit).unwrap(),
        "{\"kind\":\"a\",\"ts\":1,\"session_id\":\"no-session\",\"payload\":{}}\n"
    );
    let off = AgentTrace::new(&config(
        dir.path(),
        &[("MIXDOG_AGENT_TRACE_PATH", path.as_str()), ("MIXDOG_AGENT_TRACE_DISABLE", "1")],
    ));
    assert!(!off.append(object(&json!({"kind": "b"})), 1));
    off.flush(1);
    assert_eq!(fs::read_to_string(&explicit).unwrap().lines().count(), 1);
}

#[test]
fn due_after_one_second_or_hundred_lines_and_failed_write_warns() {
    let dir = tempfile::tempdir().unwrap();
    // A file where the history directory should be: the flush must warn and drop the chunk.
    fs::write(dir.path().join("history"), "x").unwrap();
    let trace = AgentTrace::new(&config(dir.path(), &[("MIXDOG_DIAGNOSTICS", "1")]));
    assert!(!trace.append(object(&json!({"kind": "a"})), 1000));
    assert!(!trace.due(1999));
    assert!(trace.due(2000));
    let warnings = trace.flush(2000);
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].key, "agent-trace:local-spool");
    assert!(warnings[0].message.starts_with("[agent-trace] local spool failed ("));
    assert!(trace.flush(2001).is_empty(), "the failed chunk was dropped");
}

#[test]
fn row_sink_gets_every_row_even_when_no_file_is_written() {
    use std::sync::Arc;
    use std::sync::Mutex;

    struct Collect(Mutex<Vec<String>>);
    impl mixdog_trace::RowSink for Collect {
        fn row(&self, row: &Map<String, Value>, _now_ms: i64) {
            self.0.lock().unwrap().push(mixdog_trace::stringify(&Value::Object(row.clone())));
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    let trace = AgentTrace::with_sink(&config(dir.path(), &[("MIXDOG_MODE", "ship")]), Some(sink.clone()));
    assert!(!trace.append(object(&json!({"kind": "a", "sessionId": "s", "ts": 5})), 1));
    assert_eq!(
        *sink.0.lock().unwrap(),
        ["{\"kind\":\"a\",\"ts\":5,\"session_id\":\"s\",\"payload\":{}}"]
    );
    assert!(!dir.path().join("history").join("agent-trace.jsonl").exists());
}