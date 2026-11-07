//! Every record builder yields the row Node wrote for the same call, replayed from
//! `fixtures/agent-trace/builders-golden.json` (benchmarks/rust-core/recorders/
//! record-agent-trace-builders.mjs). Cases marked `transcribed` pin the writer's output for a literal
//! copied from a call site that cannot be run alone.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O"
)]

use std::fs;
use std::path::Path;

use mixdog_trace as t;
use serde_json::Map;
use serde_json::Value;

fn golden(file: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace").join(file);
    mixdog_js::json_parse(&fs::read_to_string(path).unwrap()).unwrap()
}

fn build(builder: &str, input: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut input = input.clone();
    let identity = input.remove("__identity");
    let identity = identity.as_ref().and_then(Value::as_object);
    Some(match builder {
        "preset_assign" => t::preset_assign_record(&input),
        "fetch" => t::fetch_record(&input),
        "sse" => t::sse_record(&input),
        "turn_timing" => t::turn_timing_record(&input),
        "usage_raw" => t::usage_raw_record(&input, identity),
        "loop" => t::loop_record(&input),
        "compress" => t::compress_record(&input),
        "shell_output" => t::shell_output_record(&input)?,
        "tool_output" => t::tool_output_record(&input)?,
        "batch" => t::batch_record(&input),
        "transport_fallback" => t::transport_fallback_record(&input),
        "transport_error" => t::transport_error_record(&input),
        "spawn_ws_prewarm" => t::spawn_ws_prewarm_record(&input),
        "output_truncated" => t::output_truncated_record(&input),
        "gemini_cache" => t::gemini_cache_record(&input),
        "cache_break" => t::cache_break_record(&input),
        "browser_timing" => t::browser_timing_record(&input),
        "stall_abort" => t::stall_abort_record(&input),
        "context" => t::context_record(&input),
        "steer" => t::steer_record(&input),
        "ws_timeout" => t::ws_timeout_record(&input),
        "cache_context" => t::spread_payload_record("cache_context", &input),
        "trace_loop" => t::trace_loop_record(&input),
        "no_tool" => t::no_tool_record(&input),
        "cursor_unknown_field" => t::cursor_unknown_field_record(&input),
        other => panic!("no builder {other}"),
    })
}

fn replay(file: &str) {
    let g = golden(file);
    let now = g["now"].as_i64().unwrap();
    let mut got = String::new();
    for case in g["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let record = build(case["builder"].as_str().unwrap(), case["rust"].as_object().unwrap());
        assert_eq!(record.is_some(), case["emits"].as_bool().unwrap(), "{name}: emits");
        if let Some(record) = record {
            let row = t::build_row(&record, now);
            got.push_str(&t::stringify(&Value::Object(row)));
            got.push('\n');
        }
    }
    let want = g["jsonl"].as_str().unwrap();
    for (n, (got, want)) in got.lines().zip(want.lines()).enumerate() {
        assert_eq!(got, want, "row {n}");
    }
    assert_eq!(got.lines().count(), want.lines().count());
}

#[test]
fn helpers_write_nodes_rows() {
    replay("builders-golden.json");
}

#[test]
fn driven_call_sites_write_nodes_rows() {
    replay("sites-golden.json");
}

#[test]
fn grok_cache_chain_fields_match_node() {
    let g = golden("builders-golden.json");
    for case in g["pure"]["grokChain"].as_array().unwrap() {
        let state = Some(&case["state"]).filter(|s| !s.is_null());
        let prev = Some(&case["prev"]).filter(|p| !p.is_null());
        let reason = case["reason"].as_str();
        let got = t::grok_cache_chain_fields(state, prev, reason);
        assert_eq!(t::stringify(&Value::Object(got)), t::stringify(&case["out"]));
    }
}

#[test]
fn loop_rows_follow_the_trace_env() {
    let get = |on: &'static str| move |name: &str| (name == on).then(|| "1".to_string());
    let dir = std::path::Path::new("d");
    assert!(!t::TraceConfig::from_env(dir, &|_| None, false).loop_rows);
    assert!(t::TraceConfig::from_env(dir, &get("MIXDOG_AGENT_TRACE_VERBOSE"), false).loop_rows);
    assert!(t::TraceConfig::from_env(dir, &get("MIXDOG_AGENT_TRACE_TIMING"), false).loop_rows);
}
