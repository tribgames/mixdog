//! The rows the trace builds: the common row, usage and compaction records, tool rows with their summarised arguments,
//! the record builders of the call sites, and the rotation of the trace file.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O"
)]

use std::collections::BTreeMap;
use std::fs;

use mixdog_trace as t;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn object(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn keys(map: &Map<String, Value>) -> Vec<&str> {
    map.keys().map(String::as_str).collect()
}

#[test]
fn a_row_takes_its_time_from_the_record_and_its_session_from_either_key() {
    let row = t::build_row(&object(json!({"kind": "k", "ts": "2026-01-02T03:04:05Z", "sessionId": "s"})), 5);
    assert_eq!(keys(&row), ["kind", "ts", "session_id", "payload"]);
    assert_eq!(row["ts"], 1_767_323_045_000_i64);
    assert_eq!(row["session_id"], "s");
    assert_eq!(row["payload"], json!({}));
    let numeric = t::build_row(&object(json!({"ts": 77, "session_id": "own", "sessionId": "other", "payload": {"a": 1}})), 5);
    assert_eq!((numeric["ts"].clone(), numeric["session_id"].clone(), numeric["payload"].clone()), (json!(77), json!("own"), json!({"a": 1})));
    // No time, an unreadable one or no session: the clock and `no-session`.
    for record in [json!({}), json!({"ts": "garbage"}), json!({"ts": 0})] {
        let row = t::build_row(&object(record), 5);
        assert_eq!((row["ts"].clone(), row["session_id"].clone()), (json!(5), json!("no-session")));
    }
}

#[test]
fn a_usage_record_is_stamped_and_marked_as_maintenance_when_it_is() {
    let entry = object(json!({"provider": "p", "payload": null}));
    let record = t::usage_record(&entry, true, 5);
    assert_eq!(keys(&record), ["ts", "kind", "provider", "payload", "maintenanceLog"]);
    assert_eq!((record["ts"].clone(), record["kind"].clone(), record["payload"].clone()), (json!(5), json!("usage"), json!({})));
    assert_eq!(record["maintenanceLog"], true);
    let own = t::usage_record(&object(json!({"ts": 9})), false, 5);
    assert_eq!(own["ts"], 9);
    assert!(!own.contains_key("maintenanceLog"));
}

#[test]
fn a_compaction_record_keeps_zero_counts_nulls_the_blank_and_cuts_a_long_recovered_error() {
    let long = "m".repeat(400);
    let record = t::compact_meta_record(&object(json!({
        "sessionId": "s", "stage": "x", "compact_changed": 1, "before_count": 0, "error": "",
        "recovered_error": {"code": "E", "message": long}, "details": 5,
    })));
    assert_eq!(record["kind"], "compact_meta");
    assert_eq!((record["stage"].clone(), record["trigger"].clone()), (json!("x"), Value::Null));
    assert_eq!(record["compact_changed"], true);
    assert_eq!((record["before_count"].clone(), record["after_count"].clone()), (json!(0), Value::Null));
    assert_eq!(record["error"], Value::Null);
    assert_eq!(record["details"], Value::Null, "only an object or a list is kept");
    let message = record["recovered_error"]["message"].as_str().unwrap();
    assert_eq!(message, format!("{}\u{2026}", "m".repeat(299)));
    assert_eq!(record["recovered_error"]["code"], "E");
}

#[test]
fn tool_arguments_are_summarised_by_the_tools_own_keys_and_secrets_never_survive() {
    let read = t::summarize_tool_args("read", Some(&json!({"file_path": "a.rs", "offset": 5, "bogus": 1}))).unwrap();
    assert_eq!(read, json!({"file_path": "a.rs", "offset": 5}));
    let custom = t::summarize_tool_args("custom", Some(&json!({"password": "p", "a": 1, "content": "x".repeat(100), "note": "y".repeat(200)}))).unwrap();
    assert_eq!(custom["password"], "[redacted]");
    assert_eq!(custom["content"], format!("{}...", "x".repeat(60)), "a body is cut at 60 units");
    assert_eq!(custom["note"], format!("{}...", "y".repeat(180)), "other text at 180");
    let shell = t::summarize_tool_args("shell", Some(&json!({"command": "curl --password hunter2 http://x"}))).unwrap();
    assert_eq!(shell["command"], "curl --password [redacted] http://x");
    let many = t::summarize_tool_args("edit_many", Some(&json!({"edits": [{"a": 1}, {"a": 2}]}))).unwrap();
    assert_eq!(many["edits_count"], 2);
    assert_eq!(t::summarize_tool_args("read", Some(&json!({}))), None);
    assert_eq!(t::summarize_tool_args("read", Some(&json!("text"))), None);
    assert_eq!(t::summarize_tool_args("read", None), None);
    let hash = t::hash_trace_value(&json!({"a": 1, "b": 2}));
    assert_eq!(hash.len(), 16);
    assert_eq!(hash, t::hash_trace_value(&json!({"b": 2, "a": 1})), "key order does not matter");
}

#[test]
fn next_calls_count_only_those_whose_arguments_are_complete_json() {
    assert_eq!(t::count_json_next_calls("next_call: read({\"a\":1}) then next_call: grep({\"b\":{\"c\":\"}\"}})"), 2);
    assert_eq!(t::count_json_next_calls("next_call: read({broken)"), 0);
    assert_eq!(t::count_json_next_calls("next_call: read({\"a\":1}"), 0);
    assert_eq!(t::count_json_next_calls("no marker"), 0);
}

fn tool_call(extra: Value) -> Map<String, Value> {
    let mut call = object(json!({"sessionId": "s", "iteration": 2, "toolName": "grep", "toolKind": "builtin", "resultKind": "ok"}));
    call.extend(object(extra));
    call
}

#[test]
fn a_tool_call_becomes_a_tool_row_and_a_slow_row_past_the_threshold_for_the_listed_tools() {
    let slow = t::SlowTool::from_env(&|_| None);
    let call = tool_call(json!({"toolMs": 3500, "resultText": "a\nb", "toolArgs": {"pattern": "x"}}));
    let records = t::tool_records(&call, &slow, 10);
    let tool = &records.tool;
    assert_eq!((tool["kind"].clone(), tool["tool_name"].clone(), tool["tool_ms"].clone()), (json!("tool"), json!("grep"), json!(3500)));
    assert_eq!((tool["result_bytes_est"].clone(), tool["result_lines_est"].clone()), (json!(3), json!(2)));
    assert_eq!(tool["tool_args"], json!({"pattern": "x"}));
    assert_eq!(tool["result_error_first_line"], Value::Null);
    assert_eq!(tool["result_has_next_call"], false);
    let slow_row = records.slow.expect("grep past 3000 ms is slow");
    assert_eq!(slow_row["kind"], "tool_slow");
    assert_eq!(slow_row["payload"]["threshold_ms"], 3000);
    assert!(records.failure.is_none());
    // A tool not on the list, or a quick call, has no slow row.
    assert!(t::tool_records(&tool_call(json!({"toolName": "read", "toolMs": 9000})), &slow, 10).slow.is_none());
    assert!(t::tool_records(&tool_call(json!({"toolMs": 100})), &slow, 10).slow.is_none());
}

#[test]
fn a_failed_tool_call_names_its_category_and_first_line_and_writes_a_failure_row() {
    let slow = t::SlowTool::from_env(&|_| None);
    let call = tool_call(json!({"toolName": "read", "resultKind": "error", "resultText": "\n\nENOENT: no such file\nmore"}));
    let records = t::tool_records(&call, &slow, 10);
    assert_eq!(records.tool["result_error_first_line"], "ENOENT: no such file");
    assert_eq!(records.tool["result_error_category"], "navigation/miss");
    let failure = records.failure.expect("an error writes a failure row");
    assert_eq!((failure["category"].clone(), failure["tool_name"].clone(), failure["ts"].clone()), (json!("navigation/miss"), json!("read"), json!(10)));
    let next = t::tool_records(&tool_call(json!({"resultText": "next_call: read({\"a\":1})"})), &slow, 10);
    assert_eq!((next.tool["result_has_next_call"].clone(), next.tool["result_next_call_count"].clone()), (json!(true), json!(1)));
}

#[test]
fn tool_timing_is_summarised_in_whole_milliseconds() {
    let slow = t::SlowTool::from_env(&|_| None);
    let call = tool_call(json!({"toolTiming": {
        "dispatchStartedAt": 100, "executionStartedAt": 110, "executionCompletedAt": 160, "postprocessStartedAt": 165, "resultCompletedAt": 170
    }}));
    let records = t::tool_records(&call, &slow, 10);
    assert_eq!(
        records.tool["payload"]["timing"],
        json!({"dispatch_wait_ms": 10, "execution_ms": 50, "result_collection_wait_ms": 5, "postprocess_ms": 5, "total_ms": 70})
    );
}

#[test]
fn usage_rows_take_the_cache_out_of_the_input_only_for_providers_that_count_it_in() {
    let usage = |provider: &str| {
        let a = object(json!({"inputTokens": 100, "cachedTokens": 40, "cacheWriteTokens": 10, "outputTokens": 5, "provider": provider}));
        t::usage_raw_record(&a, None)
    };
    let inclusive = usage("openai");
    assert_eq!((inclusive["uncached_input_tokens"].clone(), inclusive["prompt_tokens"].clone()), (json!(50), json!(100)));
    let exclusive = usage("anthropic");
    assert_eq!((exclusive["uncached_input_tokens"].clone(), exclusive["prompt_tokens"].clone()), (json!(100), json!(150)));
    assert_eq!(exclusive["kind"], "usage_raw");
    assert_eq!(exclusive["payload"]["provider"], "anthropic");
    let none = t::usage_raw_record(&object(json!({"inputTokens": 1})), None);
    assert_eq!(none["cache_write_tokens"], 0);
    let identity = object(json!({"provider": "anthropic", "sessionId": "from-identity"}));
    let by_identity = t::usage_raw_record(&object(json!({"inputTokens": 100, "cachedTokens": 40, "provider": "openai"})), Some(&identity));
    assert_eq!(by_identity["sessionId"], "from-identity");
    assert_eq!(by_identity["prompt_tokens"], 140, "the send's own provider decides how the input counts");
}

#[test]
fn reasoning_tokens_are_read_from_the_usage_shapes_providers_send() {
    assert_eq!(t::reasoning_tokens(Some(&json!({"reasoningTokens": 3}))), 3);
    assert_eq!(t::reasoning_tokens(Some(&json!({"output_tokens_details": {"reasoning_tokens": 7}}))), 7);
    assert_eq!(t::reasoning_tokens(Some(&json!({"raw": {"thoughtsTokenCount": 9}}))), 9);
    assert_eq!(t::reasoning_tokens(Some(&json!({"reasoningTokens": -1}))), Value::Null);
    assert_eq!(t::reasoning_tokens(Some(&json!({"reasoningTokens": 1.5}))), Value::Null);
    assert_eq!(t::reasoning_tokens(None), Value::Null);
}

#[test]
fn small_call_site_records_round_default_and_null_their_fields() {
    let timing = t::turn_timing_record(&object(json!({"sessionId": "s", "ttftMs": 12.5, "queueMs": "x"})));
    assert_eq!((timing["payload"]["status"].clone(), timing["payload"]["ttft_ms"].clone(), timing["payload"]["queue_ms"].clone()), (json!("unknown"), json!(13), Value::Null));
    assert_eq!(timing["ttft_ms"], 13, "the payload's fields are also on the row");
    assert_eq!(t::compress_record(&object(json!({"before": 200, "after": 50})))["payload"]["savings_pct"], 75);
    assert_eq!(t::compress_record(&object(json!({"before": 0, "after": 50})))["payload"]["savings_pct"], 0);
    let looped = t::loop_record(&object(json!({"sessionId": "s", "iteration": 1, "agent": "", "sendMs": 3, "messageCount": 4})));
    assert_eq!((looped["agent"].clone(), looped["pre_send_ms"].clone(), looped["body_bytes_est"].clone(), looped["send_ms"].clone()), (Value::Null, Value::Null, Value::Null, json!(3)));
    let preset = t::preset_assign_record(&object(json!({"sessionId": "s", "parentSessionId": "p", "presetName": "fast"})));
    assert_eq!((preset["preset_name"].clone(), preset["parent_session_id"].clone(), preset["parentSessionId"].clone()), (json!("fast"), json!("p"), json!("p")));
}

#[test]
fn a_cache_chain_is_continuous_only_when_the_sent_response_id_is_the_last_one() {
    let state = json!({"xaiResponses": {"previousResponseId": "r1"}});
    let chain = |sent: Option<&str>, reason: Option<&str>| {
        let sent = sent.map(|s| json!(s));
        t::grok_cache_chain_fields(Some(&state), sent.as_ref(), reason)
    };
    assert_eq!(chain(Some("r1"), None)["chainContinuous"], true);
    assert_eq!(chain(Some("r2"), Some("reset"))["chainContinuous"], false);
    assert_eq!(chain(Some("r2"), Some("reset"))["continuationResetReason"], "reset");
    let none = chain(None, Some(""));
    assert_eq!((none["requestPrevResponseId"].clone(), none["chainContinuous"].clone(), none["continuationResetReason"].clone()), (Value::Null, json!(false), Value::Null));
}

#[test]
fn the_trace_file_moves_aside_once_it_is_over_ten_mebibytes() {
    let dir = tempfile::tempdir().unwrap();
    let env: BTreeMap<&str, &str> = [("MIXDOG_DIAGNOSTICS", "1"), ("MIXDOG_AGENT_TRACE_ROTATE_CHECK_MS", "1")].into_iter().collect();
    let trace = t::AgentTrace::new(&t::TraceConfig::from_env(dir.path(), &|name| env.get(name).map(|v| (*v).to_owned()), false));
    let live = dir.path().join("history").join("agent-trace.jsonl");
    fs::create_dir_all(live.parent().unwrap()).unwrap();
    fs::write(&live, vec![b'x'; 10 * 1024 * 1024]).unwrap();
    trace.append(&object(json!({"kind": "a"})), 10);
    assert!(trace.flush(10).is_empty());
    assert!(!dir.path().join("history").join("agent-trace.jsonl.1").exists(), "exactly 10 MiB stays");
    trace.append(&object(json!({"kind": "b"})), 100);
    assert!(trace.flush(100).is_empty());
    assert!(dir.path().join("history").join("agent-trace.jsonl.1").exists());
    assert_eq!(fs::read_to_string(&live).unwrap().lines().count(), 1, "the live file starts again");
}
