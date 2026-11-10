//! `history/tool-failures.jsonl` as Node's `_appendToolFailureRow` keeps it: cut at 300 / 1200 UTF-16 units (a cut inside a
//! surrogate pair leaves the lone `\ud83d` Node's `JSON.stringify` writes), flushed at 50 lines or 1000 ms, rotated above
//! 10 MB, a failed write warned and its chunk dropped. The clock is the `now_ms` each call is given, advanced explicitly.
//! The surrogate expectation was taken from Node v22.20.0: `('Error: '+'a'.repeat(292)+'\u{1F600}tail').slice(0,300)`
//! stringifies as `…aaaa\ud83d"`.
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
use mixdog_trace::tool_failure_row;
use serde_json::Value;
use serde_json::json;

fn trace_in(dir: &Path, extra: &[(&str, &str)]) -> AgentTrace {
    let env: BTreeMap<String, String> = extra.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
    AgentTrace::new(&TraceConfig::from_env(dir, &|name| env.get(name).cloned(), false))
}

fn failure(n: usize) -> serde_json::Map<String, Value> {
    json!({"sessionId": "s", "toolName": "edit", "resultText": format!("Error: failure {n}")}).as_object().unwrap().clone()
}

fn file(dir: &Path) -> std::path::PathBuf {
    dir.join("history").join("tool-failures.jsonl")
}

#[test]
fn a_cut_inside_a_surrogate_pair_leaves_the_lone_escape_node_writes() {
    let text = format!("Error: {}\u{1F600}tail", "a".repeat(292));
    let args = json!({"sessionId": "s", "toolName": "edit", "resultText": text}).as_object().unwrap().clone();
    let line = mixdog_trace::stringify(&tool_failure_row(&args, 1).unwrap());
    assert!(line.contains("aaaa\\ud83d\",\"error_preview\""), "first line cut at 300 units: {line}");
    assert!(line.contains("\u{1F600}tail\""), "the preview (under 1200 units) keeps the whole pair: {line}");
    let long = format!("{}\u{1F600}", "b".repeat(1199));
    let args = json!({"sessionId": "s", "toolName": "edit", "resultText": long}).as_object().unwrap().clone();
    let line = mixdog_trace::stringify(&tool_failure_row(&args, 1).unwrap());
    assert!(line.contains("bbbb\\ud83d\",\"result_bytes_est\""), "preview cut at 1200 units: {line}");
}

#[test]
fn the_first_line_is_cut_at_300_and_the_preview_at_1200_units() {
    let args = json!({"sessionId": "s", "toolName": "edit", "resultText": "x".repeat(2000)}).as_object().unwrap().clone();
    let row = tool_failure_row(&args, 1).unwrap();
    assert_eq!(row["error_first_line"].as_str().unwrap().len(), 300);
    assert_eq!(row["error_preview"].as_str().unwrap().len(), 1200);
}

#[test]
fn rows_wait_for_the_fiftieth_line_or_a_second_and_are_lost_unflushed() {
    let dir = tempfile::tempdir().unwrap();
    let trace = trace_in(dir.path(), &[]);
    for n in 0..49 {
        assert!(!trace.tool_failure(&failure(n), 1000), "line {n} is not due");
    }
    assert!(!file(dir.path()).exists(), "nothing is written before the flush");
    assert!(trace.tool_failure(&failure(49), 1000), "the 50th line is due");
    assert!(trace.flush(1000).is_empty());
    assert_eq!(fs::read_to_string(file(dir.path())).unwrap().lines().count(), 50);

    assert!(!trace.tool_failure(&failure(50), 5000));
    assert!(!trace.due(5999));
    assert!(trace.due(6000), "1000 ms after the first queued line");
    // A killed process never flushes: the queued row is in memory only.
    drop(trace);
    assert_eq!(fs::read_to_string(file(dir.path())).unwrap().lines().count(), 50);
}

#[test]
fn the_log_rotates_above_ten_megabytes_and_keeps_the_generations() {
    let dir = tempfile::tempdir().unwrap();
    let trace = trace_in(dir.path(), &[("MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS", "1")]);
    let live = file(dir.path());
    fs::create_dir_all(live.parent().unwrap()).unwrap();
    fs::write(&live, vec![b'x'; 10 * 1024 * 1024]).unwrap();
    trace.tool_failure(&failure(0), 10);
    assert!(trace.flush(10).is_empty());
    assert!(fs::metadata(&live).unwrap().len() > 10 * 1024 * 1024, "the row was appended to the 10 MB file");
    assert!(!dir.path().join("history").join("tool-failures.jsonl.1").exists(), "exactly 10 MB is not above the bound");

    trace.tool_failure(&failure(1), 100);
    assert!(trace.flush(100).is_empty());
    let rotated = dir.path().join("history").join("tool-failures.jsonl.1");
    assert!(rotated.exists(), "above 10 MB the live file moves to .1");
    assert_eq!(fs::read_to_string(&live).unwrap().lines().count(), 1, "the live file starts again");
}

#[test]
fn a_failed_write_warns_with_its_key_and_drops_the_chunk() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("history"), "a file where the directory belongs").unwrap();
    let trace = trace_in(dir.path(), &[]);
    trace.tool_failure(&failure(0), 1);
    let warnings = trace.flush(2);
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].key, "tool-failure-log:append");
    assert!(warnings[0].message.starts_with("[tool-failure-log] append failed ("));
    assert!(trace.flush(3).is_empty(), "the chunk was dropped, not retried");
    fs::remove_file(dir.path().join("history")).unwrap();
    trace.tool_failure(&failure(1), 4);
    assert!(trace.flush(5).is_empty());
    assert_eq!(fs::read_to_string(file(dir.path())).unwrap().lines().count(), 1, "only the later row exists");
}
