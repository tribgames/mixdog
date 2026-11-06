//! The cycle code against `fixtures/memory-jobs/golden.json`, recorded from the Node product by
//! `record-memory-jobs.mjs`: signatures, intervals, the due rule, coalesce limits, the cycle1 plan,
//! SQL fragments, window packing, result merging, the classifier reply parse and validation,
//! prompts, quality records and the chunk generator driven by the recorded replies.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::quality::*;
use super::requests::{resolve_coalesce_max_drains_in, resolve_coalesce_max_retries_in};
use super::rows::{PlanOptions, cycle1_row_due_sql, cycle1_unchunked_sql, resolve_cycle1_plan, select_root_id};
use super::run::{Cycle1Result, EmbeddingDirty, merge_cycle1_results, pack_cycle1_windows};
use super::signature::{make_cycle_request_signature, parse_interval, periodic_cycle_due, scheduled_cycle1_signature};
use super::{Cycle1Llm, Cycle1Request};

const GOLDEN: &str = include_str!("../../../../../fixtures/memory-jobs/golden.json");
const FROZEN: i64 = 1_800_000_000_000;

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden parses")
}

fn num(value: &Value) -> f64 {
    match value {
        Value::Null => f64::NAN,
        Value::String(s) if s == "NaN" => f64::NAN,
        other => mixdog_js::to_number(other),
    }
}

fn same(actual: f64, expected: &Value) -> bool {
    if actual.is_nan() { expected.is_null() } else { expected.as_f64() == Some(actual) }
}

fn opt_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn row(value: &Value) -> Row {
    let text = |key: &str| value[key].as_str().and_then(|s| s.parse::<i64>().ok());
    Row {
        id: text("id").expect("numeric id"),
        ts: text("ts").expect("numeric ts"),
        role: opt_string(&value["role"]),
        content: value["content"].as_str().unwrap_or_default().to_owned(),
        session_id: opt_string(&value["session_id"]),
        project_id: opt_string(&value["project_id"]),
        element: opt_string(&value["element"]),
    }
}

fn rows(value: &Value) -> Vec<Row> {
    value.as_array().expect("rows").iter().map(row).collect()
}

fn parsed_json(chunks: &Option<Vec<Parsed>>) -> Value {
    match chunks {
        None => Value::Null,
        Some(chunks) => Value::Array(
            chunks
                .iter()
                .map(|c| {
                    let mut out = serde_json::Map::new();
                    out.insert("_idxList".into(), json!(c.idx_list));
                    if let Some(error) = c.parse_error {
                        out.insert("_parseError".into(), json!(error));
                    } else {
                        out.insert("element".into(), json!(c.element));
                        out.insert("category".into(), json!(c.category));
                        out.insert("summary".into(), json!(c.summary));
                    }
                    Value::Object(out)
                })
                .collect(),
        ),
    }
}

fn parsed_of(value: &Value) -> Parsed {
    Parsed {
        idx_list: value["_idxList"].as_array().map(|a| a.iter().map(|n| n.as_i64().expect("index")).collect()).unwrap_or_default(),
        parse_error: value["_parseError"].as_str().map(|_| "invalid_line_format"),
        element: value["element"].as_str().unwrap_or_default().to_owned(),
        category: value["category"].as_str().unwrap_or_default().to_owned(),
        summary: value["summary"].as_str().unwrap_or_default().to_owned(),
    }
}

#[test]
fn signatures_equal_node() {
    for case in golden()["signature"].as_array().unwrap() {
        let config = &case["config"];
        assert_eq!(scheduled_cycle1_signature(config), case["scheduled"].as_str().unwrap(), "{config}");
        let options = json!({"preset": {"provider": "p", "model": "m"}, "concurrency": 2});
        assert_eq!(make_cycle_request_signature(&["cycle1".into(), config.clone(), options]), case["withOptions"].as_str().unwrap(), "{config}");
    }
}

#[test]
fn intervals_and_the_due_rule_equal_node() {
    let g = golden();
    for case in g["intervals"].as_array().unwrap() {
        match (parse_interval(&case["value"]), case.get("ok"), case.get("error")) {
            (Ok(ms), Some(ok), _) => assert_eq!(Some(ms), ok.as_f64(), "{}", case["value"]),
            (Err(error), _, Some(expected)) => assert_eq!(error.message().trim_start_matches("postgres runtime: "), expected.as_str().unwrap(), "{}", case["value"]),
            (got, ok, error) => panic!("{} -> {got:?} vs {ok:?} {error:?}", case["value"]),
        }
    }
    for case in g["due"].as_array().unwrap() {
        let started = num(&case["started"]);
        let got = periodic_cycle_due(num(&case["last"]), started, num(&case["interval"]), num(&case["now"]));
        assert_eq!(got, case["due"].as_bool().unwrap(), "{case}");
    }
}

#[test]
fn coalesce_limits_equal_node() {
    for case in golden()["coalesce"].as_array().unwrap() {
        // The recorded environment of the case, not the process's.
        let env = |name: &str| case["env"][name].as_str().map(str::to_owned);
        assert_eq!(resolve_coalesce_max_retries_in(&env, &case["config"], 3.0), case["maxRetries"].as_f64().unwrap(), "{case}");
        assert_eq!(resolve_coalesce_max_drains_in(&env, &case["config"], 1.0), case["maxDrains"].as_f64().unwrap(), "{case}");
    }
}

#[test]
fn the_plan_and_sql_equal_node() {
    let g = golden();
    for case in g["plan"].as_array().unwrap() {
        let options = &case["options"];
        let plan_options = PlanOptions {
            caller_deadline_ms: options["callerDeadlineMs"].as_f64(),
            preset: options.get("preset").cloned(),
            concurrency: options["concurrency"].as_f64(),
            max_concurrent: None,
        };
        let plan = resolve_cycle1_plan(&case["config"], &plan_options, None);
        let expected = &case["plan"];
        for (name, actual) in [
            ("windowSize", plan.window_size),
            ("maxPackets", plan.max_packets),
            ("rowsPerSession", plan.rows_per_session),
            ("minBatch", plan.min_batch),
            ("sessionCap", plan.session_cap),
            ("backfillCap", plan.backfill_cap),
            ("sessionQuietMs", plan.session_quiet_ms),
            ("sessionForceAgeMs", plan.session_force_age_ms),
            ("timeout", plan.timeout),
            ("inputTokenBudget", plan.input_token_budget),
            ("concurrency", plan.concurrency),
        ] {
            assert!(same(actual, &expected[name]), "{name}: {actual} vs {} for {}", expected[name], case["config"]);
        }
        assert_eq!(plan.only_session_id, expected["onlySessionId"].as_str().unwrap());
        assert_eq!(plan.preset, Some(expected["preset"].clone()));
    }
    let sql = &g["sql"];
    assert_eq!(cycle1_row_due_sql("$1", ""), sql["due"].as_str().unwrap());
    assert_eq!(cycle1_row_due_sql("$2", "e"), sql["dueAlias"].as_str().unwrap());
    assert_eq!(cycle1_unchunked_sql(""), sql["unchunked"].as_str().unwrap());
    assert_eq!(cycle1_unchunked_sql("e"), sql["unchunkedAlias"].as_str().unwrap());
    for case in g["roots"].as_array().unwrap() {
        // A member whose id is not a number never reaches a `Row`: the database's bigint column is
        // the conversion boundary, exercised with these very members by `tests::jobs`.
        if case["members"].as_array().unwrap().iter().any(|m| m["id"].as_str().is_none_or(|s| s.parse::<i64>().is_err())) {
            continue;
        }
        let members: Vec<Row> = case["members"].as_array().unwrap().iter().map(row).collect();
        assert_eq!(select_root_id(&members).map(|id| id.to_string()), case["root"].as_i64().map(|id| id.to_string()), "{case}");
    }
}

#[test]
fn window_packing_equals_node() {
    for case in golden()["pack"].as_array().unwrap() {
        let sessions: Vec<(String, Vec<Row>)> = case["sessions"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_owned(), rows(&pair[1]))).collect();
        let packed = pack_cycle1_windows(&sessions, num(&case["packetSize"]), num(&case["maxPackets"]), num(&case["budget"]));
        match (packed, case.get("ok"), case.get("error")) {
            (Ok(windows), Some(expected), _) => {
                let ids: Vec<Vec<String>> = windows.iter().map(|w| w.iter().map(|r| r.id.to_string()).collect()).collect();
                assert_eq!(json!(ids), *expected, "{case}");
            }
            (Err(error), _, Some(expected)) => assert_eq!(error.message().trim_start_matches("postgres runtime: "), expected.as_str().unwrap()),
            (got, ok, error) => panic!("{got:?} vs {ok:?} {error:?}"),
        }
    }
}

fn result_of(value: &Value) -> Cycle1Result {
    let ids = |key: &str| value[key].as_array().map(|a| a.iter().map(|n| n.as_i64().unwrap()).collect()).unwrap_or_default();
    let map = |key: &str| value[key].as_object().cloned().unwrap_or_default();
    let dirty = &value["embedding_dirty"];
    Cycle1Result {
        processed: value["processed"].as_i64().unwrap(),
        chunks: value["chunks"].as_i64().unwrap(),
        skipped: value["skipped"].as_i64().unwrap(),
        sessions: value["sessions"].as_i64().unwrap(),
        pending_rows: value["pendingRows"].as_i64(),
        failed_row_ids: ids("failed_row_ids"),
        omitted_row_ids: ids("omitted_row_ids"),
        prefiltered_row_ids: ids("prefiltered_row_ids"),
        invalid_chunks: value["invalid_chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| InvalidChunk { reason: c["reason"].as_str().unwrap().into(), idx_list: None, member_ids: c["member_ids"].as_array().unwrap().iter().map(|n| n.as_i64().unwrap()).collect(), error: None })
            .collect(),
        quality: map("quality"),
        timing: map("timing"),
        embedding_dirty: EmbeddingDirty {
            deferred: dirty["deferred"].as_bool().unwrap(),
            attempted: dirty["attempted"].as_i64().unwrap(),
            succeeded: dirty["succeeded"].as_i64().unwrap(),
            failed: dirty["failed"].as_i64().unwrap(),
            failed_ids: dirty["failed_ids"].as_array().unwrap().iter().map(|n| n.as_i64().unwrap()).collect(),
        },
        ..Cycle1Result::default()
    }
}

#[test]
fn merged_results_equal_node() {
    let merged = &golden()["merged"];
    let got = merge_cycle1_results(result_of(&merged["a"]), result_of(&merged["b"])).to_json();
    let expected = &merged["result"];
    for key in ["processed", "chunks", "skipped", "sessions", "skippedInFlight", "pendingRows", "failed_row_ids", "omitted_row_ids", "prefiltered_row_ids", "quality", "timing", "embedding_dirty"] {
        assert_eq!(got[key], expected[key], "{key}");
    }
    assert_eq!(got["invalid_chunks"].as_array().unwrap().len(), expected["invalid_chunks"].as_array().unwrap().len());
}

#[test]
fn reply_parse_and_grouping_equal_node() {
    let g = golden();
    for case in g["parse"].as_array().unwrap() {
        let parsed = parse_cycle1_line_format(case["raw"].as_str().unwrap());
        assert_eq!(parsed_json(&parsed), case["parsed"], "{}", case["raw"]);
    }
    let rows = rows(&json!([
        {"id": "1", "ts": "1700000000001", "role": "user", "content": "one", "session_id": "sa"},
        {"id": "2", "ts": "1700000000002", "role": "assistant", "content": "two", "session_id": "sa"},
        {"id": "3", "ts": "1700000000003", "role": "user", "content": "three", "session_id": "sb"},
        {"id": "4", "ts": "1700000000004", "role": "assistant", "content": "four", "session_id": "sa"},
    ]));
    for case in g["grouping"].as_array().unwrap() {
        let chunks: Option<Vec<Parsed>> = case["chunks"].as_array().map(|a| a.iter().map(parsed_of).collect());
        let got = validate_cycle1_grouping(chunks.as_deref(), &rows);
        let expected = &case["result"];
        assert_eq!(got.valid, expected["valid"].as_bool().unwrap(), "{case}");
        assert_eq!(json!(got.errors), expected["errors"], "{case}");
        assert_eq!(json!(got.omitted), expected["omitted"], "{case}");
        assert_eq!(got.accepted.len(), expected["accepted"].as_array().unwrap().len(), "{case}");
        let invalid: Vec<Value> = got.invalid.iter().map(InvalidChunk::to_json).collect();
        assert_eq!(json!(invalid), expected["invalid"], "{case}");
    }
}

#[test]
fn prompts_budgets_and_quality_equal_node() {
    let g = golden();
    let source = rows(&json!([
        {"id": "1", "ts": "1700000000001", "role": "user", "content": "first \"quoted\" line\nsecond", "session_id": "sa"},
        {"id": "2", "ts": "1700000000002", "role": "assistant", "content": format!("{}", "word".repeat(3)), "session_id": "sa"},
    ]));
    assert_eq!(chunk_source_text(&[]), g["prompts"]["empty"].as_str().unwrap());
    assert!(chunk_source_text(&source).starts_with("# session sa\n@1 {\"ts\":\"1700000000001\",\"role\":\"user\",\"content\":\"first \\\"quoted\\\" line\\nsecond\"}"));
    for case in g["budgets"].as_array().unwrap() {
        match (cycle1_source_budget(num(&case["value"])), case.get("ok"), case.get("error")) {
            (Ok(budget), Some(ok), _) => assert_eq!(Some(budget), ok.as_f64()),
            (Err(error), _, Some(expected)) => assert_eq!(error.message().trim_start_matches("postgres runtime: "), expected.as_str().unwrap()),
            (got, ok, error) => panic!("{got:?} vs {ok:?} {error:?}"),
        }
    }
    let record = &g["qualityRecord"];
    let members = rows(&record["members"]);
    let summary = record["summary"].as_str().unwrap();
    assert_eq!(make_chunk_quality(summary, &members, FROZEN), record["record"]);
    for case in g["assess"].as_array().unwrap() {
        let root = &case["root"];
        let members = rows(&root["members"]);
        let quality = Some(&root["chunk_quality"]).filter(|q| !q.is_null());
        let (usable, reasons) = assess_chunk_quality(root["summary"].as_str().unwrap(), quality, &members);
        assert_eq!(usable, case["result"]["usable"].as_bool().unwrap(), "{case}");
        assert_eq!(json!(reasons), case["result"]["reasons"], "{case}");
    }
    for case in g["split"].as_array().unwrap() {
        match (split_cycle1_row(&row(&case["row"]), num(&case["budget"])), case.get("ok"), case.get("error")) {
            (Ok(parts), Some(ok), _) => assert_eq!(json!(parts.iter().map(|r| r.content.clone()).collect::<Vec<_>>()), *ok, "{}", case["budget"]),
            (Err(error), _, Some(expected)) => assert_eq!(error, expected.as_str().unwrap()),
            (got, ok, error) => panic!("{got:?} vs {ok:?} {error:?}"),
        }
    }
}

/// Replies the recorded run got, in order; the last repeats.
struct Scripted {
    replies: Vec<Value>,
    calls: Mutex<VecDeque<String>>,
    count: Mutex<usize>,
}

#[async_trait]
impl Cycle1Llm for Scripted {
    async fn call(&self, _request: &Cycle1Request, _cancel: &CancellationToken, prompt: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push_back(prompt.to_owned());
        let mut n = self.count.lock().unwrap();
        let reply = &self.replies[(*n).min(self.replies.len() - 1)];
        *n += 1;
        match reply {
            Value::String(text) => Ok(text.clone()),
            other => Err(other["error"].as_str().unwrap().to_owned()),
        }
    }
}

#[tokio::test]
async fn the_chunk_generator_equals_node() {
    for case in golden()["generate"].as_array().unwrap() {
        let llm = Scripted { replies: case["replies"].as_array().unwrap().clone(), calls: Mutex::default(), count: Mutex::default() };
        let request = Cycle1Request { preset: Some(json!({"provider": "p"})), timeout_ms: 1000.0 };
        let cancel = CancellationToken::new();
        let now = || FROZEN;
        let generation = Generation { llm: &llm, request: &request, cancel: &cancel, input_token_budget: num(&case["inputTokenBudget"]), now: &now };
        let source = rows(&case["rows"]);
        let got = generate_cycle1_chunks(&source, &generation).await.expect("generates");
        let label = case["label"].as_str().unwrap();
        let prompts: Vec<String> = llm.calls.lock().unwrap().iter().cloned().collect();
        let expected_prompts: Vec<String> = case["calls"].as_array().unwrap().iter().map(|c| c["prompt"].as_str().unwrap().to_owned()).collect();
        assert_eq!(prompts, expected_prompts, "{label}");
        let expected = &case["result"];
        let chunks: Vec<Value> = got
            .chunks
            .iter()
            .map(|c| json!({"element": c.element, "category": c.category, "summary": c.summary, "_idxList": c.idx_list, "members": c.members.iter().map(|m| m.id.to_string()).collect::<Vec<_>>(), "quality": c.quality}))
            .collect();
        let expected_chunks: Vec<Value> = expected["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| json!({"element": c["element"], "category": c["category"], "summary": c["summary"], "_idxList": c["_idxList"], "members": c["members"].as_array().unwrap().iter().map(|m| m["id"].clone()).collect::<Vec<_>>(), "quality": c["quality"]}))
            .collect();
        assert_eq!(chunks, expected_chunks, "{label}");
        assert_eq!(json!(got.raw_row_ids), expected["rawRowIds"], "{label}");
        let invalid: Vec<Value> = got.invalid_chunks.iter().map(InvalidChunk::to_json).collect();
        assert_eq!(json!(invalid), expected["invalidChunks"], "{label}");
        let stats = got.stats.to_json(0);
        for key in ["groupingCalls", "verificationCalls", "verificationMs", "retries", "fragments"] {
            assert_eq!(stats[key], expected["stats"][key], "{label} {key}");
        }
    }
}
