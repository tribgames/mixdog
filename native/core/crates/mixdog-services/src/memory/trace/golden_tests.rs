//! The trace store's SQL and bound rows equal what Node's `trace-store.mjs` sends, replayed from
//! `fixtures/agent-trace/trace-store-golden.json` (benchmarks/rust-core/recorders/
//! record-trace-store.mjs). No database runs.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

use std::path::Path;

use serde_json::Value;

use super::Event;
use super::RecordReply;
use super::TraceStore;
use super::rows::TraceEventRow;
use super::rows::collect_agent_rows;
use super::rows::insert_trace_events_sql;
use super::rows::llm_columns;
use super::rows::session_columns;
use super::rows::tool_columns;
use super::sql;
use super::store::first_boot_statements;
use super::store::retention_statements;

fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace/trace-store-golden.json");
    mixdog_js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn events(g: &Value) -> Vec<Event> {
    g["events"].as_array().unwrap().clone()
}

fn text(value: &Value) -> String {
    mixdog_js::json_stringify(value)
}

fn recorded<'a>(g: &'a Value, phase: &str, group: &str) -> Vec<&'a Value> {
    g[phase].as_array().unwrap().iter().filter(|r| r["group"] == group).collect()
}

#[test]
fn first_boot_sends_nodes_statements_in_nodes_order() {
    let g = golden();
    let want: Vec<&str> = recorded(&g, "open", "client0").iter().map(|r| r["sql"].as_str().unwrap()).collect();
    assert_eq!(first_boot_statements(), want);
}

#[test]
fn retention_sends_nodes_statements_and_cutoff() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let got = retention_statements(7, now);
    let want = recorded(&g, "open", "client1");
    assert_eq!(got.len(), want.len());
    for ((sql, params), want) in got.iter().zip(want) {
        assert_eq!(sql, want["sql"].as_str().unwrap());
        let want_params: Vec<i64> = want["params"]
            .as_array()
            .map(|p| p.iter().map(|n| n.as_i64().unwrap()).collect())
            .unwrap_or_default();
        assert_eq!(params, &want_params);
    }
}

#[test]
fn disabled_path_sends_nodes_statements() {
    let g = golden();
    let want = g["disabled"].as_array().unwrap();
    assert_eq!(sql::TRACE_NAMESPACE_PRESENT, want[0]["sql"].as_str().unwrap());
    assert_eq!(sql::DROP_TRACE_SCHEMA, want[1]["sql"].as_str().unwrap());
}

#[test]
fn trace_events_insert_binds_nodes_values() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let evs = events(&g);
    let want = &g["insertTraceEvents"][0];
    assert_eq!(insert_trace_events_sql(evs.len()), want["sql"].as_str().unwrap());
    let got: Vec<Value> = evs.iter().flat_map(|ev| TraceEventRow::from_event(ev, now).unwrap().params_json()).collect();
    assert_eq!(text(&Value::Array(got)), text(&want["params"]));
}

#[test]
fn agent_calls_insert_binds_nodes_values() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let rows = collect_agent_rows(&events(&g), now).unwrap();
    let recorded = recorded(&g, "insertAgentCalls", "client2");
    let json = |cols: Vec<super::rows::Column>| Value::Array(cols.iter().map(|c| c.to_json()).collect());
    assert_eq!(sql::INSERT_TOOL_ROWS, recorded[2]["sql"].as_str().unwrap());
    assert_eq!(text(&json(tool_columns(&rows.tool_rows).unwrap())), text(&recorded[2]["params"]));
    assert_eq!(sql::INSERT_LLM_ROWS, recorded[3]["sql"].as_str().unwrap());
    assert_eq!(text(&json(llm_columns(&rows.llm_rows).unwrap())), text(&recorded[3]["params"]));
    assert_eq!(sql::UPSERT_SESSIONS, recorded[4]["sql"].as_str().unwrap());
    assert_eq!(text(&json(session_columns(&rows.sessions).unwrap())), text(&recorded[4]["params"]));
}

#[test]
fn record_checks_the_body_like_the_route() {
    let now = 1;
    let bad = serde_json::json!({"events": "x"});
    assert_eq!(
        TraceStore::record(None, &bad, now),
        RecordReply::Rejected { status: 400, error: "body.events must be an array".into() }
    );
    let many = serde_json::json!({"events": vec![serde_json::json!({}); 501]});
    assert_eq!(
        TraceStore::record(None, &many, now),
        RecordReply::Rejected { status: 413, error: "too many events (max 500)".into() }
    );
    let ok = serde_json::json!({"events": [{"kind": "x"}]});
    assert_eq!(TraceStore::record(None, &ok, now), RecordReply::Disabled);
}

#[test]
fn trace_mode_and_retention_env_follow_node() {
    use super::retention_days;
    use super::trace_enabled;
    for on in ["1", "true", "ON", " yes "] {
        assert!(trace_enabled(Some(on), false), "{on}");
    }
    for off in ["0", "false", "off", "no", "other"] {
        assert!(!trace_enabled(Some(off), true), "{off}");
    }
    assert!(trace_enabled(None, true));
    assert!(trace_enabled(Some(""), true));
    assert!(!trace_enabled(None, false));
    assert_eq!(retention_days(None), 7);
    assert_eq!(retention_days(Some("")), 7);
    assert_eq!(retention_days(Some("0")), 0);
    assert_eq!(retention_days(Some("30.9")), 30);
    assert_eq!(retention_days(Some("-1")), 7);
    assert_eq!(retention_days(Some("abc")), 7);
}

#[test]
fn non_object_elements_fail_or_default_like_node() {
    let g = golden();
    let now = g["now"].as_i64().unwrap();
    let want = &g["nonObject"];
    let with_null = vec![serde_json::json!({"kind": "a"}), Value::Null];
    let first_error = with_null.iter().map(|ev| TraceEventRow::from_event(ev, now)).find_map(Result::err).unwrap();
    assert_eq!(first_error.0, want["traceEvents"].as_str().unwrap());
    let calls = vec![serde_json::json!({"kind": "a", "session_id": "s"}), Value::Null];
    assert_eq!(collect_agent_rows(&calls, now).unwrap_err().0, want["agentCalls"].as_str().unwrap());
    let primitives: Vec<Event> = want["primitives"].as_array().unwrap().clone();
    let got: Vec<Value> = primitives.iter().flat_map(|ev| TraceEventRow::from_event(ev, now).unwrap().params_json()).collect();
    assert_eq!(text(&Value::Array(got)), text(&want["primitivesSql"][0]["params"]));
}