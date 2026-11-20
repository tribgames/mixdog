//! Hand-authored unit examples: each request row
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

fn query<T: rusqlite::types::FromSql>(path: &Path, sql: &str) -> T {
    Connection::open(path).unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
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

fn database_rows() -> Vec<Value> {
    vec![json!({"ts":"1788000200000","kind":"usage_raw","model":"gpt-x","session_id":"s2",
                "input_tokens":50.0,"output_tokens":5.0,"cached_tokens":0.0,"cache_write_tokens":0.0,"duration_ms":null,
                "payload":{"provider":"openai","uncached_input_tokens":30}})]
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



fn rig(trace: Vec<Value>) -> Rig {
    rig_reading(Arc::new(Canned(trace)))
}
fn rig_reading(trace: Arc<dyn OriginalTrace>) -> Rig {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer = UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let refresher = UsageRefresher::new(Arc::new(Prices), tokens.cpu_bulk);
    refresher.enable_history_from(data.clone(), tokens.maintenance_io, trace);
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
async fn totals(rig: &Rig) -> Value {
    let stats = rig.ledger.get_usage_stats(UsageStatsOptions::default(), || NOW).await.unwrap();
    stats["totals"].clone()
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

#[tokio::test]
async fn concurrent_import_waiters_share_failure_without_retry_and_later_call_retries() {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    struct HeldTrace {
        calls: AtomicUsize,
        release: tokio::sync::Notify,
    }
    impl OriginalTrace for HeldTrace {
        fn rows<'a>(&'a self, _: &'a str, _: i64) -> TraceFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.release.notified().await;
                Err(crate::error::LedgerError::History("trace unavailable".into()))
            })
        }
    }
    let rig = rig(Vec::new());
    put(&rig, "pgdata/postmaster.pid", "injected trace only");
    let tokens = mixdog_rt::testing::tokens();
    let trace = Arc::new(HeldTrace { calls: AtomicUsize::new(0), release: tokio::sync::Notify::new() });
    let importer = super::HistoryImporter::new(rig.data.clone(), tokens.maintenance_io, tokens.cpu_bulk, Arc::new(Prices), trace.clone());
    let release = async {
        loop {
            if trace.calls.load(Ordering::SeqCst) == 1 && importer.lock().waiters.len() == 1 {
                break;
            }
            tokio::task::yield_now().await;
        }
        trace.release.notify_one();
    };
    let (a, b, ()) = mixdog_rt::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(importer.ensure(&rig.ledger.writer, NOW), importer.ensure(&rig.ledger.writer, NOW), release)
    })
    .await
    .expect("both readers must settle");
    match (a.unwrap_err(), b.unwrap_err()) {
        (crate::error::LedgerError::SharedHistory(a), crate::error::LedgerError::SharedHistory(b)) => {
            assert!(Arc::ptr_eq(&a, &b));
            assert_eq!(a.to_string(), "trace unavailable");
        }
        errors => panic!("unshared errors: {errors:?}"),
    }
    assert_eq!(trace.calls.load(Ordering::SeqCst), 1);
    trace.release.notify_one();
    assert!(importer.ensure(&rig.ledger.writer, NOW).await.is_err());
    assert_eq!(trace.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_rejected_history_write_settles_its_accepted_mark() {
    let rig = rig(Vec::new());
    let mut row = row_record(&json!({"kind":"usage_raw","ts":5,"provider":"p","model":"m","input_tokens":1,"output_tokens":1})).unwrap();
    row.day = "not-a-day".to_owned();
    let pending = rig.ledger.writer.import_history(super::HistoryWrite {
        records: vec![row],
        legacy_days: Vec::new(),
        through: None,
        receipt: None,
        previously_inserted: 0,
    });
    let mark = rig.ledger.writer.marks().accepted();
    assert!(mark > 0, "enqueue must synchronously number the import");
    assert!(pending.await.is_err());
    assert!(rig.ledger.writer.marks().check(mark).unwrap().is_err());
    assert_eq!(rig.ledger.writer.marks().committed(), mark);
}

#[tokio::test]
async fn a_queued_live_write_precedes_the_statistics_cutover() {
    let rig = rig(Vec::new());
    let ts = NOW - 5_000;
    let live: crate::append::UsageRecord = serde_json::from_value(json!({
        "id": "live1", "ts": ts, "day": "2026-09-20", "provider": "p", "model": "m", "kind": "api", "sessionId": "s1",
        "sourceType": "user", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2, "costUsd": 0.5, "costSource": "catalog",
        "origin": "live", "durationMs": 100
    }))
    .unwrap();
    let queued = rig.ledger.writer.record_queued(live);
    let stats = rig.ledger.get_usage_stats(UsageStatsOptions::default(), || NOW).await.unwrap();
    queued.await.unwrap();
    assert_eq!(stats["totals"]["turns"], 1, "the write queued before the read is in the statistics");
    let cutover = |key: &str| query::<String>(&rig.path, &format!("SELECT value FROM metadata WHERE key='{key}'"));
    assert_eq!(cutover("liveSince"), ts.to_string());
    assert_eq!(cutover("importedThrough"), ts.to_string(), "the import stops where the live writer starts");
}

const GOOD_ROW: &str = r#"{"kind":"usage_raw","ts":1788000000000,"provider":"openai","model":"gpt-x","session_id":"s1","input_tokens":10,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0}"#;
const BAD_TS_ROW: &str = r#"{"kind":"usage_raw","ts":"never","provider":"openai","model":"gpt-x","session_id":"s1","input_tokens":10,"output_tokens":1,"cached_tokens":0,"cache_write_tokens":0}"#;

/// The failure of the first statistics read, which runs the import.
async fn import_failure(rig: &Rig) -> String {
    rig.ledger.get_usage_stats(UsageStatsOptions::default(), || NOW).await.unwrap_err().to_string()
}
fn events(rig: &Rig) -> i64 {
    query::<i64>(&rig.path, "SELECT COUNT(*) FROM usage_events")
}
fn imported_through(rig: &Rig) -> i64 {
    query::<i64>(&rig.path, "SELECT COUNT(*) FROM metadata WHERE key='importedThrough'")
}

#[tokio::test]
async fn a_trace_row_without_a_valid_timestamp_fails_the_import_and_leaves_it_unmarked() {
    let rig = rig(Vec::new());
    put(&rig, "history/agent-trace.jsonl", &format!("{BAD_TS_ROW}\n"));
    assert!(import_failure(&rig).await.contains("Usage requires a valid timestamp"));
    assert_eq!((events(&rig), imported_through(&rig)), (0, 0));
}

#[tokio::test]
async fn one_bad_row_rolls_back_its_whole_file() {
    let rig = rig(Vec::new());
    put(&rig, "history/agent-trace.jsonl", &format!("{GOOD_ROW}\n{BAD_TS_ROW}\n"));
    assert!(import_failure(&rig).await.contains("Usage requires a valid timestamp"));
    assert_eq!((events(&rig), imported_through(&rig)), (0, 0), "nothing of the file's batch stays");
}

#[tokio::test]
async fn a_later_file_failing_keeps_what_the_earlier_file_committed() {
    let rig = rig(Vec::new());
    put(&rig, "history/agent-trace.jsonl", &format!("{GOOD_ROW}\n"));
    put(&rig, "history/agent-trace.jsonl.1", &format!("{BAD_TS_ROW}\n"));
    assert!(import_failure(&rig).await.contains("Usage requires a valid timestamp"));
    assert_eq!((events(&rig), imported_through(&rig)), (1, 0), "the first file stays, the import is not marked done");
}

#[tokio::test]
async fn an_unreadable_original_database_fails_the_import_and_keeps_the_files_read() {
    struct Unavailable;
    impl OriginalTrace for Unavailable {
        fn rows<'a>(&'a self, _: &'a str, _: i64) -> TraceFuture<'a> {
            Box::pin(async { Err(crate::LedgerError::History("Original trace unavailable".into())) })
        }
    }
    let rig = rig_reading(Arc::new(Unavailable));
    put(&rig, "history/agent-trace.jsonl", &format!("{GOOD_ROW}\n"));
    put(&rig, "pgdata/postmaster.pid", "123\n/data\n0\n5432\n");
    assert!(import_failure(&rig).await.contains("Original trace unavailable"));
    assert_eq!((events(&rig), imported_through(&rig)), (1, 0));
}

#[tokio::test]
async fn a_null_gateway_event_fails_the_import() {
    let rig = rig(Vec::new());
    put(&rig, "gateway-usage.local.jsonl", "null\n");
    assert!(import_failure(&rig).await.contains("Cannot read properties of null (reading 'sessionId')"));
    assert_eq!((events(&rig), imported_through(&rig)), (0, 0));
}

#[tokio::test]
async fn an_empty_gateway_jsonl_supersedes_the_legacy_json_file() {
    let rig = rig(Vec::new());
    put(&rig, "gateway-usage.local.jsonl", "");
    put(
        &rig,
        "gateway-usage.local.json",
        r#"{"events":[{"ts":1788259200000,"provider":"openai","model":"gpt-x","sessionId":"s3","inputTokens":20,"outputTokens":4,"cacheReadTokens":5,"cacheWriteTokens":0,"costUsd":0.25}]}"#,
    );
    assert_eq!(totals(&rig).await["turns"], 0);
    assert_eq!((events(&rig), imported_through(&rig)), (0, 1));
}

#[tokio::test]
async fn an_import_up_to_the_cutover_is_marked_with_it_and_a_repeat_adds_nothing() {
    let rig = rig(Vec::new());
    let conn = Connection::open(&rig.path).unwrap();
    conn.execute("INSERT INTO metadata VALUES ('liveSince','1788000000001')", []).unwrap();
    drop(conn);
    put(&rig, "history/agent-trace.jsonl", &format!("{GOOD_ROW}\n"));
    assert_eq!(totals(&rig).await["turns"], 1);
    assert_eq!(
        query::<String>(&rig.path, "SELECT value FROM metadata WHERE key='importedThrough'"),
        "1788000000001"
    );
    assert_eq!(totals(&rig).await["turns"], 1);
    assert_eq!(events(&rig), 1);
}
