//! What the queries answer over a ledger as 1.4.5 left it (`v145::write_v145`: three requests of two days, 10 input,
//! 5 output, 1 cache read, 2 cache write and $0.50 each; sessions `a` on both days, `b` on the 4th).

#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O"
)]

use std::collections::BTreeMap;
use std::sync::Arc;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::quota::QuotaHistoryOptions;
use mixdog_ledger::quota::QuotaReading;
use mixdog_ledger::quota::QuotaSample;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::requests::RequestQuery;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::stats::UsageRequestsOptions;
use mixdog_ledger::stats::UsageStatsOptions;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;
use serde_json::json;

/// The 1.4.5 ledger opened as production does (the writer upgrades it and builds its sums), with a reader on it.
async fn upgraded() -> (tempfile::TempDir, Arc<UsageWriter>, Arc<UsageReader>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    crate::v145::write_v145(&path);
    let tokens = mixdog_rt::testing::tokens();
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    (dir, writer, reader)
}

const NOW: i64 = 1_793_900_000_000;

#[tokio::test]
async fn the_rollup_of_a_145_ledger_totals_each_day() {
    let (_dir, _writer, reader) = upgraded().await;
    let rollup = reader.rollup(RollupQuery::default()).await.unwrap();
    let days = rollup["days"].as_object().unwrap();
    assert_eq!(days.keys().collect::<Vec<_>>(), ["2026-11-04", "2026-11-05"]);
    let (fourth, fifth) = (&days["2026-11-04"], &days["2026-11-05"]);
    assert_eq!(
        [&fourth["turns"], &fourth["input"], &fourth["output"], &fourth["cacheRead"], &fourth["cacheWrite"], &fourth["costUsd"], &fourth["durationMs"]],
        [&json!(2), &json!(20), &json!(10), &json!(2), &json!(4), &json!(1), &json!(200)]
    );
    assert_eq!(
        [&fifth["turns"], &fifth["input"], &fifth["output"], &fifth["cacheRead"], &fifth["cacheWrite"], &fifth["costUsd"], &fifth["durationMs"]],
        [&json!(1), &json!(10), &json!(5), &json!(1), &json!(2), &json!(0.5), &json!(100)]
    );
    let models = fourth["models"].as_object().unwrap();
    assert_eq!(models.len(), 1, "one route");
    let route = models.values().next().unwrap();
    assert_eq!((&route["provider"], &route["model"]), (&json!("p"), &json!("m")));
    assert_eq!(fourth["sessions"].as_object().unwrap().keys().collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(fifth["sessions"].as_object().unwrap().keys().collect::<Vec<_>>(), ["a"]);
}

#[tokio::test]
async fn the_request_list_of_a_145_ledger_is_newest_first_and_pages_by_cursor() {
    let (_dir, _writer, reader) = upgraded().await;
    let query = |limit, cursor: Option<&str>| RequestQuery {
        from_ms: 0,
        to_ms: 2_000_000_000_000,
        status: String::new(),
        model: None,
        cursor: cursor.map(str::to_owned),
        limit,
    };
    let page = reader.requests_page(query(10, None)).await.unwrap();
    let rows = page["requests"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["03".repeat(16), "02".repeat(16), "01".repeat(16)]);
    assert_eq!(page["nextCursor"], Value::Null);
    let sessions: Vec<&str> = rows.iter().map(|r| r["sessionId"].as_str().unwrap()).collect();
    assert_eq!(sessions, ["a", "b", "a"]);
    let first = &rows[0];
    assert_eq!(first["ts"], json!(1_793_880_000_000_i64));
    assert_eq!((&first["provider"], &first["model"], &first["status"], &first["attempts"]), (&json!("p"), &json!("m"), &json!("completed"), &json!(1)));
    assert_eq!(
        [&first["input"], &first["output"], &first["cacheRead"], &first["cacheWrite"], &first["tokens"], &first["costUsd"], &first["durationMs"]],
        [&json!(10), &json!(5), &json!(1), &json!(2), &json!(18), &json!(0.5), &json!(100)]
    );

    let head = reader.requests_page(query(2, None)).await.unwrap();
    assert_eq!(head["requests"].as_array().unwrap().len(), 2);
    assert_eq!(head["nextCursor"], json!(format!("1793800000000:{}", "02".repeat(16))));
    let tail = reader.requests_page(query(2, head["nextCursor"].as_str())).await.unwrap();
    let rest: Vec<&str> = tail["requests"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(rest, ["01".repeat(16)]);
    assert_eq!(tail["nextCursor"], Value::Null);
}

#[tokio::test]
async fn the_request_list_separates_unknown_prompt_and_missing_usage_from_measured_zero() {
    let (_dir, writer, reader) = upgraded().await;
    for (index, provider, rates, status, cost_source, input, output) in [
        (1, "cursor-oauth", r#"{"inputTokensKnown":false}"#, "completed", "unpriced", 800, 27),
        (2, "cursor-api", "{}", "completed", "unpriced", 0, 0),
        (3, "cursor-api", "{}", "failed", "none", 0, 0),
        (4, "openai", "{}", "completed", "catalog", 80, 0),
        (5, "cursor-api", r#"{"inputTokensKnown":false,"outputTokensKnown":false}"#, "completed", "unpriced", 0, 0),
    ] {
        let record: UsageRecord = serde_json::from_value(json!({
            "id": format!("evidence-{index}"), "ts": NOW + index, "day": "2026-11-05",
            "provider": provider, "model": "m", "kind": "api", "sessionId": "s", "sourceType": "lead",
            "input": input, "output": output, "cacheRead": 0, "cacheWrite": 0,
            "costUsd": null, "costSource": cost_source, "rates": rates, "origin": "live",
            "durationMs": 0, "status": status
        })).unwrap();
        writer.record_queued(record).await.unwrap();
    }
    let page = reader.requests_page(RequestQuery {
        from_ms: NOW,
        to_ms: NOW + 10,
        ..RequestQuery::default()
    }).await.unwrap();
    let rows = page["requests"].as_array().unwrap();
    let counts = |row: &Value| ["input", "cacheRead", "cacheWrite", "output", "tokens"].map(|key| row[key].clone());
    assert_eq!(rows.len(), 5);
    assert_eq!(counts(&rows[0]), [const { Value::Null }; 5]);
    assert_eq!(counts(&rows[1]), [json!(80), json!(0), json!(0), json!(0), json!(80)]);
    assert_eq!(counts(&rows[2]), [const { Value::Null }; 5]);
    assert_eq!(counts(&rows[3]), [Value::Null, Value::Null, Value::Null, json!(0), Value::Null]);
    assert_eq!(counts(&rows[4]), [Value::Null, Value::Null, Value::Null, json!(27), Value::Null]);
}

#[tokio::test]
async fn session_usage_of_a_145_ledger_sums_the_sessions_asked_for() {
    let (_dir, _writer, reader) = upgraded().await;
    let a = reader.session_usage(vec!["a".into()], vec![]).await.unwrap();
    assert_eq!(
        [&a["turns"], &a["input"], &a["output"], &a["cacheRead"], &a["cacheWrite"], &a["costUsd"]],
        [&json!(2), &json!(20), &json!(10), &json!(2), &json!(4), &json!(1)]
    );
    let both = reader.session_usage(vec!["a".into(), "b".into()], vec![]).await.unwrap();
    assert_eq!((&both["turns"], &both["input"], &both["costUsd"]), (&json!(3), &json!(30), &json!(1.5)));
    let none = reader.session_usage(vec!["nobody".into()], vec![]).await.unwrap();
    assert_eq!(none["turns"], json!(0));
}

#[tokio::test]
async fn the_statistics_of_a_145_ledger_total_its_period() {
    let (_dir, _writer, reader) = upgraded().await;
    let options: UsageStatsOptions = serde_json::from_value(json!({"days": 30})).unwrap();
    let stats = reader.usage_stats(options, NOW).await.unwrap();
    let totals = &stats["totals"];
    assert_eq!((&totals["turns"], &totals["tokens"], &totals["costUsd"]), (&json!(3), &json!(54), &json!(1.5)));
    let model = &stats["providers"][0]["models"][0];
    assert_eq!(model["speedTier"], "standard");
    assert!(model.get("fast").is_none());
    assert_eq!(stats["range"]["activeDays"], json!(2));
    assert_eq!(stats["generatedAt"], json!(NOW));

    let options: UsageRequestsOptions = serde_json::from_value(json!({"view": "custom", "startDay": "2026-11-04", "endDay": "2026-11-05"})).unwrap();
    let page = reader.usage_requests(options, NOW).await.unwrap();
    assert_eq!(page["requests"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn quota_history_of_a_145_ledger_keeps_the_readings_recorded_after_the_upgrade() {
    let (_dir, writer, reader) = upgraded().await;
    let reading = |ts, used_pct| QuotaReading {
        provider: "openai".into(),
        account: "acct".into(),
        label: "5h".into(),
        sample: QuotaSample { ts, used_pct, reset_at: Some(NOW + 4 * 3_600_000) },
    };
    writer.record_quota_queued(vec![reading(NOW - 3_600_000, 10.0), reading(NOW - 1_800_000, 40.0)]).await.unwrap();
    let options: QuotaHistoryOptions =
        serde_json::from_value(json!({"provider": "openai", "account": "acct", "window": "5h"})).unwrap();
    let history = reader.quota_history(options, BTreeMap::new(), NOW).await.unwrap();
    let text = serde_json::to_string(&history).unwrap();
    assert!(text.contains(r#""peak":40"#), "the window's peak: {text}");
    assert!(text.contains(r#""account":"acct""#), "{text}");
}
