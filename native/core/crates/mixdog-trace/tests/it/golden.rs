//! The trace writer's files: ship mode, explicit paths and the disable switch, when a flush is due, and what a failed write
//! does, and the row sinks.
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
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

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
#[test]
fn a_writer_without_a_sink_of_its_own_feeds_the_process_sink() {
    use std::sync::Arc;
    use std::sync::Mutex;

    struct Collect(Mutex<Vec<String>>);
    impl mixdog_trace::RowSink for Collect {
        fn row(&self, row: &Map<String, Value>, _now_ms: i64) {
            if row.get("kind").and_then(Value::as_str) == Some("process_sink_probe") {
                self.0.lock().unwrap().push("row".into());
            }
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let trace = AgentTrace::new(&config(dir.path(), &[("MIXDOG_MODE", "ship")]));
    let record = json!({"kind": "process_sink_probe", "sessionId": "s", "ts": 5});
    trace.append(object(&record), 1);
    let sink = Arc::new(Collect(Mutex::new(Vec::new())));
    mixdog_trace::install_process_sink(Some(sink.clone()));
    trace.append(object(&record), 2);
    mixdog_trace::install_process_sink(None);
    trace.append(object(&record), 3);
    assert_eq!(sink.0.lock().unwrap().len(), 1, "only the row appended while the sink was installed");
}
