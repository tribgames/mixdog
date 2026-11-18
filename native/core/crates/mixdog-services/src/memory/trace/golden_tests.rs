//! The trace store's SQL and bound rows equal what Node's `trace-store.mjs` sends, replayed from
//! `fixtures/agent-trace/trace-store-golden.json` (benchmarks/rust-core/recorders/
//! record-trace-store.mjs). No database runs.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test fixture I/O")]

#[cfg(node_twin)]
use std::path::Path;

use serde_json::Value;

#[cfg(node_twin)]
use super::Event;
use super::RecordReply;
use super::TraceStore;
use super::rows::TraceEventRow;
#[cfg(node_twin)]
use super::rows::collect_agent_rows;
use super::rows::insert_trace_events_sql;
#[cfg(node_twin)]
use super::rows::llm_columns;
#[cfg(node_twin)]
use super::rows::session_columns;
#[cfg(node_twin)]
use super::rows::tool_columns;
use super::sql;
use super::store::first_boot_statements;
use super::store::retention_statements;

#[cfg(node_twin)]
fn events(g: &Value) -> Vec<Event> {
    g["events"].as_array().unwrap().clone()
}

#[cfg(node_twin)]
fn text(value: &Value) -> String {
    mixdog_js::json_stringify(value)
}

#[cfg(node_twin)]
fn recorded<'a>(g: &'a Value, phase: &str, group: &str) -> Vec<&'a Value> {
    g[phase].as_array().unwrap().iter().filter(|r| r["group"] == group).collect()
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

/// The close queues the rows still waiting on the 5 s feed timer, so none is lost at shutdown (the write itself fails here: the database is not reachable).
#[tokio::test]
async fn closing_the_store_takes_the_rows_waiting_on_the_feed_timer() {
    use crate::memory::pg::db::{Db, Schema};
    mixdog_rt::testing::tokens();
    let store = TraceStore::for_test(std::sync::Arc::new(Db::unconnected(1, Schema::Memory, crate::memory::lifecycle::Scope::new())));
    mixdog_trace::RowSink::row(&store, &serde_json::Map::new(), 1);
    assert_eq!(store.feed_rows(), 1, "the row waits on the feed timer");
    store.close(2).await;
    assert_eq!(store.feed_rows(), 0, "the close took it");
}

#[test]
fn an_event_row_defaults_what_the_event_leaves_out_and_reads_either_spelling_of_a_result() {
    let row = TraceEventRow::from_event(&serde_json::json!({ "resultKind": "error", "result_error_category": "timeout", "tool_name": { "a": 1 } }), 1_700_000_000_000).unwrap();
    assert_eq!((row.ts, row.kind.as_str(), row.payload.as_str()), (1_700_000_000_000.0, "unknown", "{}"));
    assert_eq!((row.result_kind.as_deref(), row.result_error_category.as_deref()), (Some("error"), Some("timeout")));
    assert_eq!(row.tool_name.as_deref(), Some("{\"a\":1}"), "an object bound to a text column is its JSON text");
    assert_eq!(row.session_id, None);
}

#[test]
fn an_event_keeps_its_time_whether_a_number_or_an_iso_string_and_a_string_payload_is_bound_as_given() {
    let at = |ts: Value| TraceEventRow::from_event(&serde_json::json!({ "ts": ts, "payload": "raw text" }), 5).unwrap();
    assert_eq!(at(serde_json::json!(1234)).ts, 1234.0);
    assert_eq!(at(serde_json::json!("1970-01-01T00:00:01.000Z")).ts, 1000.0);
    assert_eq!(at(serde_json::json!("not a time")).ts, 5.0, "an unreadable time is now");
    assert_eq!(at(serde_json::json!(null)).payload, "raw text");
    assert_eq!(TraceEventRow::from_event(&serde_json::json!({ "payload": { "k": [1] } }), 1).unwrap().payload, "{\"k\":[1]}");
}

#[test]
fn a_number_the_column_cannot_hold_fails_the_row_as_the_database_would() {
    let row = |event: Value| TraceEventRow::from_event(&event, 1).unwrap().cells();
    assert_eq!(row(serde_json::json!({ "iteration": 1.5 })).err().unwrap().0, "invalid input syntax for type integer: \"1.5\"");
    assert_eq!(row(serde_json::json!({ "tool_ms": 3_000_000_000_i64 })).err().unwrap().0, "invalid input syntax for type integer: \"3000000000\"");
    assert!(row(serde_json::json!({ "iteration": 2, "entry_id": 3_000_000_000_i64 })).is_ok(), "an entry id is a bigint");
}

#[test]
fn a_null_event_cannot_be_a_row() {
    assert_eq!(TraceEventRow::from_event(&Value::Null, 1).unwrap_err().0, "Cannot read properties of null (reading 'payload')");
}

#[test]
fn the_insert_numbers_its_placeholders_across_rows() {
    let two = insert_trace_events_sql(2);
    assert!(two.starts_with("INSERT INTO trace_events (ts, session_id, iteration, kind, "), "{two}");
    assert!(two.contains("VALUES ($1, $2, $3, $4, "));
    assert!(two.contains("$20), ($21, $22, "));
    assert!(two.ends_with("$39, $40)"));
}

#[test]
fn retention_prunes_what_is_older_than_the_days_in_batches() {
    let now = 10 * 86_400_000;
    let statements = retention_statements(7, now);
    assert_eq!(statements[0].0, sql::SET_SEARCH_PATH);
    let cutoff = now - 7 * 86_400_000;
    let pruning: Vec<_> = statements.iter().filter(|(_, params)| !params.is_empty()).collect();
    assert!(pruning.len() > 1, "the events table and the others are pruned");
    assert!(pruning.iter().all(|(_, params)| params[0] == cutoff && params.len() == 2));
}

#[test]
fn the_first_boot_runs_inside_one_lock_taken_first_and_released_last() {
    let statements = first_boot_statements();
    assert_eq!(statements[0], sql::SET_SEARCH_PATH);
    assert_eq!(statements[1], sql::TRY_LOCK);
    assert_eq!(statements.last().unwrap(), sql::UNLOCK);
    assert_eq!(statements.iter().filter(|s| s.as_str() == sql::UNLOCK).count(), 1);
}


#[cfg(node_twin)]
fn golden() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/agent-trace/trace-store-golden.json");
    mixdog_js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}
#[cfg(node_twin)]
#[test]
fn first_boot_sends_nodes_statements_in_nodes_order() {
    let g = golden();
    let want: Vec<&str> = recorded(&g, "open", "client0").iter().map(|r| r["sql"].as_str().unwrap()).collect();
    assert_eq!(first_boot_statements(), want);
}
#[cfg(node_twin)]
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
#[cfg(node_twin)]
#[test]
fn disabled_path_sends_nodes_statements() {
    let g = golden();
    let want = g["disabled"].as_array().unwrap();
    assert_eq!(sql::TRACE_NAMESPACE_PRESENT, want[0]["sql"].as_str().unwrap());
    assert_eq!(sql::DROP_TRACE_SCHEMA, want[1]["sql"].as_str().unwrap());
}
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
