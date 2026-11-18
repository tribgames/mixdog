//! The loop rows' switches in the trace environment.

use mixdog_trace as t;

#[test]
fn loop_rows_follow_the_trace_env() {
    let get = |on: &'static str| move |name: &str| (name == on).then(|| "1".to_string());
    let dir = std::path::Path::new("d");
    assert!(!t::TraceConfig::from_env(dir, &|_| None, false).loop_rows);
    assert!(t::TraceConfig::from_env(dir, &get("MIXDOG_AGENT_TRACE_VERBOSE"), false).loop_rows);
    assert!(t::TraceConfig::from_env(dir, &get("MIXDOG_AGENT_TRACE_TIMING"), false).loop_rows);
}
