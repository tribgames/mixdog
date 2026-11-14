//! The import against recorded legacy originals. The expected figures are those the earlier
//! daemon's `importUsageHistory` and statistics produced for the same files: each request row
//! is one turn with its uncached input, the legacy day is one disjoint historical route, and a
//! cost the provider reported stands where the catalog's price would have been used otherwise.
#![allow(
    clippy::disallowed_methods,
    reason = "test fixture: originals written into a temporary data directory"
)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use serde_json::json;

use super::OriginalTrace;
use super::TraceFuture;
use super::record;
use crate::db::Connection;
use crate::ledger::UsageLedger;
use crate::reader::UsageReader;
use crate::refresh::Pricer;
use crate::refresh::UsageRefresher;
use crate::repair::PriceRequest;
use crate::repair::Priced;
use crate::stats::UsageStatsOptions;
use crate::writer::UsageWriter;

const NOW: i64 = 1_790_000_000_000;

/// Every request costs 0.5 and every restored sum 0.25.
struct Prices;

impl Pricer for Prices {
    fn revision(&self) -> String {
        "r1".into()
    }

    fn price(&self, _: &PriceRequest) -> crate::Result<Priced> {
        Ok(Priced {
            cost_usd: Some(0.5),
            rates: Some(r#"{"requestedModel":null,"pricingModel":"m"}"#.into()),
        })
    }

    fn price_aggregate(&self, _: &PriceRequest) -> crate::Result<Priced> {
        Ok(Priced {
            cost_usd: Some(0.25),
            rates: None,
        })
    }
}

/// The database rows a cluster would give.
struct Canned(Vec<Value>);

impl OriginalTrace for Canned {
    fn rows<'a>(&'a self, _pid_file: &'a str, _until: i64) -> TraceFuture<'a> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    data: PathBuf,
    ledger: UsageLedger,
    path: PathBuf,
}

fn rig(trace: Vec<Value>) -> Rig {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let refresher = UsageRefresher::new(Arc::new(Prices), tokens.cpu_bulk);
    refresher.enable_history_from(data.clone(), tokens.maintenance_io, Arc::new(Canned(trace)));
    Rig {
        _dir: dir,
        data,
        ledger: UsageLedger { writer, reader, refresher },
        path,
    }
}

fn put(rig: &Rig, rel: &str, text: &str) {
    let path = rig.data.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn query<T: rusqlite::types::FromSql>(path: &Path, sql: &str) -> T {
    Connection::open(path).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

async fn totals(rig: &Rig) -> Value {
    let stats = rig.ledger.get_usage_stats(UsageStatsOptions::default(), || NOW).await.unwrap();
    stats["totals"].clone()
}

fn lines(rows: &[Value]) -> String {
    rows.iter().map(|row| format!("{row}\n")).collect()
}

fn trace_rows() -> Vec<Value> {
    vec![
        json!({"kind":"usage_raw","ts":1_788_000_000_000_i64,"provider":"openai","model":"gpt-x","session_id":"s1",
               "input_tokens":100,"output_tokens":10,"cached_tokens":40,"cache_write_tokens":0,"duration_ms":500}),
        json!({"kind":"usage_raw","ts":"1788000100000","provider":"anthropic","model":"claude-x","session_id":"s1",
               "input_tokens":7,"output_tokens":3,"cached_tokens":5,"cache_write_tokens":2,"duration_ms":0}),
        json!({"kind":"other","ts":1}),
        // After the cutover: the live writer owns it.
        json!({"kind":"usage_raw","ts":1_800_000_000_000_i64,"provider":"openai","model":"gpt-x","session_id":"s1",
               "input_tokens":1,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0}),
    ]
}

fn legacy_originals(rig: &Rig) {
    let mut trace = lines(&trace_rows());
    trace.insert_str(trace.find('\n').unwrap() + 1, "{\"kind\":\"usage_raw\",\"ts\":\n");
    put(rig, "history/agent-trace.jsonl", &trace);
    put(rig, "pgdata/postmaster.pid", "123\n/data\n0\n5432\n");
    let gateway = [
        json!({"ts":1_788_259_200_000_i64,"provider":"openai","model":"gpt-x","sessionId":"s3",
               "inputTokens":20,"outputTokens":4,"cacheReadTokens":5,"cacheWriteTokens":0,"costUsd":0.25}),
        json!({"ts":1_788_259_300_000_i64,"provider":"openai","model":"gpt-x","sessionId":"s3",
               "inputTokens":null,"outputTokens":4}),
    ];
    put(rig, "gateway-usage.local.jsonl", &format!("{}{{\"ts\"\n", lines(&gateway)));
    put(
        rig,
        "usage-rollup.local.json",
        r#"{"days":{"2025-01-02":{"models":{"other/legacy":{"provider":"other","model":"legacy","turns":2,"input":20,"output":2,"cacheRead":0,"cacheWrite":0,"costUsd":3}}}}}"#,
    );
}

fn database_rows() -> Vec<Value> {
    vec![json!({"ts":"1788000200000","kind":"usage_raw","model":"gpt-x","session_id":"s2",
                "input_tokens":50.0,"output_tokens":5.0,"cached_tokens":0.0,"cache_write_tokens":0.0,"duration_ms":null,
                "payload":{"provider":"openai","uncached_input_tokens":30}})]
}

#[tokio::test]
async fn legacy_originals_enter_the_statistics_once_with_the_old_totals() {
    let rig = rig(database_rows());
    legacy_originals(&rig);

    let got = totals(&rig).await;
    // Four requests (60 + 7 + 30 + 15 uncached input, 10 + 3 + 5 + 4 output) and the legacy
    // day's two turns (20 input, 2 output); 0.5 for each catalog-priced request, the provider's
    // 0.25 for the gateway one, 3 for the legacy day.
    assert_eq!(got["turns"], 6, "{got}");
    assert_eq!(got["input"], 132, "{got}");
    assert_eq!(got["output"], 24, "{got}");
    assert_eq!(got["costUsd"], 4.75, "{got}");

    assert_eq!(query::<i64>(&rig.path, "SELECT COUNT(*) FROM usage_events"), 4);
    assert_eq!(query::<i64>(&rig.path, "SELECT COUNT(*) FROM legacy_days"), 1);
    assert_eq!(
        query::<String>(&rig.path, "SELECT value FROM metadata WHERE key='importedThrough'"),
        NOW.to_string()
    );
    let receipt: Value =
        serde_json::from_str(&query::<String>(&rig.path, "SELECT value FROM metadata WHERE key='importReceipt'")).unwrap();
    assert_eq!(receipt["inserted"], 4, "{receipt}");
    assert_eq!(receipt["sourceRows"], 6, "{receipt}");
    assert_eq!(receipt["unrecordableRows"], 1, "{receipt}");
    assert_eq!(receipt["tornTraceLines"], 1, "{receipt}");
    assert_eq!(receipt["traceRows"], 1, "{receipt}");
    assert_eq!(receipt["files"][0]["rows"], 3, "{receipt}");
    assert_eq!(receipt["until"], NOW, "{receipt}");

    // A second read adds nothing, and the originals are untouched.
    assert_eq!(totals(&rig).await, got);
    assert_eq!(query::<i64>(&rig.path, "SELECT COUNT(*) FROM usage_events"), 4);
    assert!(rig.data.join("usage-rollup.local.json").is_file());
    assert!(rig.data.join("gateway-usage.local.jsonl").is_file());
}

#[tokio::test]
async fn a_damaged_legacy_rollup_is_skipped_with_a_warning_and_retried_after_repair() {
    let rig = rig(Vec::new());
    let (written, _guard) = mixdog_rt::node_log::capture();
    for damaged in ["{broken", "", "[]", "{\"days\":null}", "{}"] {
        put(&rig, "usage-rollup.local.json", damaged);
        assert_eq!(totals(&rig).await["turns"], 0);
        assert_eq!(
            query::<i64>(&rig.path, "SELECT COUNT(*) FROM metadata WHERE key='importedThrough'"),
            0,
            "left unset so a repair is retried: {damaged:?}"
        );
    }
    assert!(written.lock().unwrap().iter().any(|(_, _, line)| line.contains("usage-rollup.local.json")));
    put(&rig, "usage-rollup.local.json", "{\"days\":{}}");
    totals(&rig).await;
    assert_eq!(
        query::<String>(&rig.path, "SELECT value FROM metadata WHERE key='importedThrough'"),
        NOW.to_string()
    );
}

#[tokio::test]
async fn nothing_from_the_live_period_is_imported() {
    let rig = rig(Vec::new());
    let live: crate::append::UsageRecord = serde_json::from_value(json!({
        "id": "live-1", "ts": 1_788_000_150_000_i64, "day": crate::time::day_key(1_788_000_150_000), "provider": "openai",
        "model": "gpt-x", "kind": "api", "sessionId": "s9", "sourceType": "user", "input": 1, "output": 1, "cacheRead": 0,
        "cacheWrite": 0, "costUsd": 0.1, "costSource": "catalog", "origin": "live", "durationMs": 1
    }))
    .unwrap();
    rig.ledger.writer.record_queued(live).await.unwrap();
    let before = json!({"kind":"usage_raw","ts":1_788_000_000_000_i64,"provider":"openai","model":"gpt-x","session_id":"s1",
                        "input_tokens":10,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0});
    let after = json!({"kind":"usage_raw","ts":1_788_000_300_000_i64,"provider":"openai","model":"gpt-x","session_id":"s1",
                       "input_tokens":10,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0});
    put(&rig, "history/agent-trace.jsonl", &lines(&[before, after]));

    assert_eq!(totals(&rig).await["turns"], 2);
    assert_eq!(
        query::<String>(&rig.path, "SELECT value FROM metadata WHERE key='importedThrough'"),
        "1788000150000"
    );
    // The history is complete up to the cutover: a later original is not looked at.
    let older = json!({"kind":"usage_raw","ts":1_787_000_000_000_i64,"provider":"openai","model":"gpt-x","session_id":"s1",
                       "input_tokens":10,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0});
    put(&rig, "history/agent-trace.jsonl.1", &lines(&[older]));
    assert_eq!(totals(&rig).await["turns"], 2);
}

fn row_record(row: &Value) -> Option<crate::append::UsageRecord> {
    record::import_row(row, &Prices).unwrap()
}

#[test]
fn a_row_becomes_the_record_the_earlier_importer_made() {
    // A provider named only in the payload, an inclusive provider's cache taken out of its input.
    let row = json!({"kind":"usage_raw","ts":"1788000000000","model":"gpt-x","session_id":"no-session",
                     "input_tokens":100,"output_tokens":10,"cached_tokens":40,"cache_write_tokens":10,"duration_ms":7,
                     "payload":{"provider":"openai","requested_model":"gpt-y","response_id":"resp-1","sourceType":"user"}});
    let made = row_record(&row).unwrap();
    assert_eq!(
        (made.provider.as_str(), made.input, made.output, made.cache_read, made.cache_write),
        ("openai", 50.0, 10.0, 40.0, 10.0)
    );
    assert_eq!((made.session_id.as_str(), made.source_type.as_str(), made.origin.as_str()), ("", "user", "trace"));
    assert_eq!((made.requested_model.as_str(), made.kind.as_str(), made.cost_source.as_str()), ("gpt-y", "api", "catalog"));
    assert_eq!(made.cost_usd, Some(0.5));
    // A response id identifies the record by itself, whatever else differs.
    let again = row_record(&json!({"kind":"usage_raw","ts":1788000999000_i64,"provider":"openai","model":"gpt-x",
                                   "input_tokens":1,"output_tokens":1,"payload":{"response_id":"resp-1"}}))
    .unwrap();
    assert_eq!(made.id, again.id);

    // Anthropic reports its input apart from the cache; a given uncached figure wins.
    let anthropic = json!({"kind":"usage_raw","ts":5,"provider":"anthropic","model":"c","input_tokens":7,"output_tokens":1,
                           "cached_tokens":5,"cache_write_tokens":2});
    assert_eq!(row_record(&anthropic).unwrap().input, 7.0);
    let uncached = json!({"kind":"usage_raw","ts":5,"provider":"openai","model":"m","input_tokens":70,"output_tokens":1,
                          "cached_tokens":5,"uncached_input_tokens":0});
    assert_eq!(row_record(&uncached).unwrap().input, 0.0);

    // A local model is free and a reported cost beats the catalog (summaries only).
    let local = json!({"kind":"usage","ts":5,"provider":"mixdog-local","model":"m","inputTokens":3,"outputTokens":1,"costUsd":9});
    let local = row_record(&local).unwrap();
    assert_eq!((local.cost_usd, local.cost_source.as_str(), local.origin.as_str()), (Some(0.0), "local", "gateway"));
    assert!(local.rates.unwrap().contains("\"pricingSource\":\"local\""));
    let oauth = json!({"kind":"usage","ts":5,"provider":"openai-oauth","model":"m","inputTokens":3,"outputTokens":1,"costUsd":9});
    assert_eq!(row_record(&oauth).unwrap().cost_source, "subscription");
    let reported = json!({"kind":"usage","ts":5,"provider":"openai","model":"m","inputTokens":3,"outputTokens":1,"costUsd":"0.75"});
    let reported = row_record(&reported).unwrap();
    assert_eq!((reported.cost_usd, reported.cost_source.as_str()), (Some(0.75), "provider"));
    assert_eq!(
        reported.rates.as_deref(),
        Some(r#"{"requestedModel":null,"pricingModel":"m","pricingProvider":"openai","pricingSource":"provider"}"#)
    );
    let raw_cost = json!({"kind":"usage_raw","ts":5,"provider":"openai","model":"m","input_tokens":3,"output_tokens":1,"costUsd":9});
    assert_eq!(row_record(&raw_cost).unwrap().cost_source, "catalog");
}

#[test]
fn a_row_with_a_missing_figure_is_not_recorded_as_zero() {
    let base = json!({"kind":"usage_raw","ts":5,"provider":"openai","model":"m","input_tokens":3,"output_tokens":1});
    assert!(row_record(&base).is_some());
    for (key, value) in [
        ("input_tokens", Value::Null),
        ("output_tokens", Value::Null),
        ("model", json!("")),
        ("provider", json!(7)),
        ("ts", json!("not a time")),
        ("ts", json!(0)),
        ("ts", json!(1.5)),
    ] {
        let mut row = base.clone();
        row[key] = value.clone();
        assert!(row_record(&row).is_none(), "{key} {value}");
    }
    // The summary shape reads camelCase figures only.
    let summary = json!({"kind":"usage","ts":5,"provider":"openai","model":"m","input_tokens":3,"output_tokens":1});
    assert!(row_record(&summary).is_none());
}

#[test]
fn a_restored_day_is_priced_again_from_its_sums() {
    let days = json!({
        "2025-01-02": {
            "restored": true, "costUsd": 99, "costBilled": 99, "costEstimated": 99, "costKnownTurns": 99,
            "conversation": {"costUsd": 9, "turns": 1},
            "models": {
                "p/m": {"provider": "p", "model": "m", "turns": 4, "input": 10, "output": 2, "costUsd": 50,
                        "conversation": {"turns": 1, "input": 3, "output": 1, "costUsd": 20}},
                "mixdog-local/l": {"provider": "mixdog-local", "model": "l", "turns": 2, "input": 1, "output": 1}
            }
        },
        "2025-01-03": {"costUsd": 7, "models": {"p/m": {"provider": "p", "model": "m", "turns": 1, "costUsd": 7}}}
    });
    let got = record::reprice_restored_days(&days, &Prices).unwrap();
    let day = &got["2025-01-02"];
    // The sum price (0.25) is used, not the request price (0.5); the local route is free.
    assert_eq!(day["models"]["p/m"]["costUsd"], 0.25);
    assert_eq!(day["models"]["p/m"]["kind"], "api");
    assert_eq!(day["models"]["p/m"]["costBilled"], 0);
    assert_eq!(day["models"]["p/m"]["costKnownTurns"], 4);
    assert_eq!(day["models"]["p/m"]["conversation"]["costUsd"], 0.25);
    assert_eq!(day["models"]["mixdog-local/l"]["costUsd"], 0);
    assert_eq!(day["models"]["mixdog-local/l"]["costKnownTurns"], 2);
    assert_eq!(day["costUsd"], 0.25);
    assert_eq!(day["costEstimated"], 0.25);
    assert_eq!(day["costBilled"], 0);
    assert_eq!(day["costKnownTurns"], 6);
    assert_eq!(day["conversation"]["costUsd"], 0.25);
    assert_eq!(day["conversation"]["costKnownTurns"], 1);
    // A day that was not restored is kept as it was.
    assert_eq!(got["2025-01-03"], days["2025-01-03"]);
}
