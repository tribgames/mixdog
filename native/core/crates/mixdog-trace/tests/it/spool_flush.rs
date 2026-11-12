//! The trace spool's file when rows arrive while a flush is writing: every row once, in the order it was queued, as Node's
//! (`_flushLocalTrace` keeps one write in flight and queues the rest), replayed from `fixtures/trace-spool/golden.json`
//! (benchmarks/rust-core/recorders/record-trace-spool.mjs). Rust flushes from any thread, so two flushers must not write their
//! chunks out of order.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "fixture loading reads files synchronously; the test runs its flushers on plain threads"
)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::mpsc;

use mixdog_trace::AgentTrace;
use mixdog_trace::TraceConfig;
use serde_json::Value;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/trace-spool/golden.json");
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn rows_queued_while_another_flush_writes_reach_the_file_once_and_in_order() {
    let golden = golden();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("trace").join("agent-trace.jsonl");
    let env: BTreeMap<String, String> = [("MIXDOG_DIAGNOSTICS", "1"), ("MIXDOG_AGENT_TRACE_PATH", path.to_str().unwrap())]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &|name| env.get(name).cloned(), false));
    let now = 1_700_000_000_000;
    let (tick, ticks) = mpsc::channel::<()>();
    std::thread::scope(|scope| {
        // A second flusher (the exit hook, a `drainAgentTrace`) flushes at every row the writer queues.
        scope.spawn(|| {
            for () in ticks {
                assert!(trace.flush(now).is_empty());
            }
        });
        for row in golden["rows"].as_array().unwrap() {
            trace.append(row.as_object().unwrap(), now);
            tick.send(()).unwrap();
            assert!(trace.flush(now).is_empty());
        }
        drop(tick);
    });
    assert!(trace.flush(now).is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), golden["jsonl"].as_str().unwrap());
}
