//! Original Node recordings, with recorded real priceUsage outputs at the pricing boundary.
//! CatalogPricer must separately replay the pricing witnesses: this test does not certify it.
use super::*;
use crate::error::{LedgerError, Result};

struct RecordedPrices(Vec<Value>);
impl RecordedPrices {
    fn lookup(&self, request: &PriceRequest, aggregate: bool) -> Result<Priced> {
        assert!(request.historical);
        let amount = |value: &Value| value.as_f64().unwrap_or(0.0);
        let call = self.0.iter().find(|call| {
            let args = &call["args"];
            args["provider"] == request.provider && args["model"] == request.model
                && args["historicalAggregate"].as_bool().unwrap_or(false) == aggregate
                && amount(&call["result"]["input"]) == request.uncached_input_tokens
                && amount(&args["outputTokens"]) == request.output_tokens
                && amount(&args["cacheReadTokens"]) == request.cache_read_tokens
                && amount(&args["cacheWriteTokens"]) == request.cache_write_tokens
                && amount(&args["cacheWrite1hTokens"]) == request.cache_write_1h_tokens.unwrap_or(0.0)
                && (aggregate || amount(&args["ts"]) == request.ts as f64)
                && args["requestedModel"].as_str() == request.requested_model.as_deref()
                && args["pricingModel"].as_str() == request.pricing_model.as_deref()
                && args["serviceTier"].as_str() == request.service_tier.as_deref()
        }).unwrap_or_else(|| panic!("unrecorded pricing request: {request:?}, aggregate={aggregate}"));
        Ok(Priced {
            cost_usd: call["result"]["costUsd"].as_f64(),
            rates: call["result"].get("rates").map(mixdog_js::json_stringify),
        })
    }
}
impl Pricer for RecordedPrices {
    fn revision(&self) -> String { "original-node-recording".into() }
    fn price(&self, request: &PriceRequest) -> Result<Priced> { self.lookup(request, false) }
    fn price_aggregate(&self, request: &PriceRequest) -> Result<Priced> { self.lookup(request, true) }
}
struct RecordedTrace { rows: Vec<Value>, error: Option<String> }
impl OriginalTrace for RecordedTrace {
    fn rows<'a>(&'a self, _: &'a str, _: i64) -> TraceFuture<'a> {
        Box::pin(async move {
            match &self.error { Some(error) => Err(LedgerError::History(error.clone())), None => Ok(self.rows.clone()) }
        })
    }
}
fn equal(actual: &Value, expected: &Value, label: &str) {
    // JS JSON number formatting makes 1 and 1.0 the same, without rounding floats.
    assert_eq!(mixdog_js::json_stringify(actual), mixdog_js::json_stringify(expected), "{label}");
}
fn saved(conn: &Connection, key: &str) -> Option<String> {
    use crate::db::OptionalExtension;
    conn.query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| r.get(0)).optional().unwrap()
}
#[tokio::test]
async fn original_node_history_errors_partial_commits_pricing_and_receipts() {
    let corpus: Value = serde_json::from_str(include_str!("oracle/original.json")).unwrap();
    assert_eq!(corpus["fetches"], 0);
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 17);
    for case in corpus["cases"].as_array().unwrap() {
        let label = case["id"].as_str().unwrap();
        let rig = rig(Vec::new());
        for (name, text) in case["input"]["files"].as_object().unwrap() { put(&rig, name, text.as_str().unwrap()); }
        let conn = Connection::open(&rig.path).unwrap();
        if let Some(live) = case["input"]["liveSince"].as_i64() {
            conn.execute("INSERT INTO metadata VALUES ('liveSince',?1)", [live.to_string()]).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let trace = Arc::new(RecordedTrace {
            rows: case["input"]["trace"].as_array().cloned().unwrap_or_default(),
            error: case["input"]["traceError"].as_str().map(str::to_owned),
        });
        // Only a marker for the injected reader; no database is opened.
        put(&rig, "pgdata/postmaster.pid", "isolated original reader injection");
        let importer = super::super::HistoryImporter::new(rig.data.clone(), tokens.maintenance_io, tokens.cpu_bulk,
            Arc::new(RecordedPrices(case["pricingCalls"].as_array().unwrap().clone())), trace);
        let result = importer.ensure(&rig.ledger.writer, NOW).await;
        let actual_error = result.err().map(|error| error.to_string());
        assert_eq!(actual_error.as_deref(), case["error"]["message"].as_str(), "{label}");
        let mut stmt = conn.prepare("SELECT hex(id),ts,day,input,output,cache_read,cache_write,cost_usd,duration_ms FROM usage_events ORDER BY ts,id").unwrap();
        let events: Vec<Value> = stmt.query_map([], |r| Ok(json!({
            "id":r.get::<_,String>(0)?, "ts":r.get::<_,i64>(1)?, "day":r.get::<_,i64>(2)?,
            "input":r.get::<_,f64>(3)?, "output":r.get::<_,f64>(4)?, "cache_read":r.get::<_,f64>(5)?,
            "cache_write":r.get::<_,f64>(6)?, "cost_usd":r.get::<_,Option<f64>>(7)?, "duration_ms":r.get::<_,f64>(8)?
        }))).unwrap().collect::<std::result::Result<_,_>>().unwrap();
        // Object key order is not semantic; compare parsed objects recursively below.
        semantic_equal(&json!(events), &case["events"], label);
        let routes: Vec<String> = conn.prepare("SELECT signature FROM usage_routes ORDER BY signature").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<std::result::Result<_,_>>().unwrap();
        equal(&json!(routes), &case["routes"], label);
        let days: Vec<Value> = conn.prepare("SELECT day,document FROM legacy_days ORDER BY day").unwrap()
            .query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
            .map(|row| {let (day,doc)=row.unwrap();json!({"day":day,"document":serde_json::from_str::<Value>(&doc).unwrap()})}).collect();
        semantic_equal(&json!(days), &case["legacy"], label);
        equal(&json!(saved(&conn,"importedThrough")), &case["through"], label);
        let receipt = saved(&conn,"importReceipt").map(|text| {
            let mut value: Value = serde_json::from_str(&text).unwrap();
            for file in value["files"].as_array_mut().unwrap() {
                file["path"] = json!(file["path"].as_str().unwrap().replace(&rig.data.display().to_string(), "$DATA"));
            }
            value
        }).unwrap_or(Value::Null);
        semantic_equal(&receipt, &case["receipt"], label);
        let mark = rig.ledger.writer.marks().accepted();
        assert!(mark > 0 || !case["error"].is_null(), "history writes must be numbered: {label}");
        assert!(rig.ledger.writer.marks().check(mark).unwrap().is_ok(), "{label}");
        if case["input"]["repeat"] == true {
            importer.ensure(&rig.ledger.writer, NOW).await.unwrap();
            assert_eq!(mark, rig.ledger.writer.marks().accepted(), "completed import queues no writes");
        }
    }
}
fn semantic_equal(actual: &Value, expected: &Value, label: &str) {
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{label}: {actual} != {expected}");
            for (key, value) in b { semantic_equal(a.get(key).unwrap_or_else(|| panic!("missing {key}: {label}")), value, label); }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{label}: {actual} != {expected}");
            for (a,b) in a.iter().zip(b) { semantic_equal(a,b,label); }
        }
        _ => equal(actual,expected,label),
    }
}

#[tokio::test]
async fn concurrent_import_waiters_share_failure_without_retry_and_later_call_retries() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct HeldTrace { calls: AtomicUsize, release: tokio::sync::Notify }
    impl OriginalTrace for HeldTrace {
        fn rows<'a>(&'a self, _: &'a str, _: i64) -> TraceFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.release.notified().await;
                Err(LedgerError::History("Original trace unavailable".into()))
            })
        }
    }
    let rig = rig(Vec::new());
    put(&rig, "pgdata/postmaster.pid", "injected trace only");
    let tokens = mixdog_rt::testing::tokens();
    let trace = Arc::new(HeldTrace { calls: AtomicUsize::new(0), release: tokio::sync::Notify::new() });
    let importer = super::super::HistoryImporter::new(rig.data.clone(), tokens.maintenance_io, tokens.cpu_bulk, Arc::new(Prices), trace.clone());
    let release = async {
        loop {
            if trace.calls.load(Ordering::SeqCst) == 1 && importer.lock().waiters.len() == 1 { break; }
            tokio::task::yield_now().await;
        }
        trace.release.notify_one();
    };
    let (a,b,()) = mixdog_rt::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(importer.ensure(&rig.ledger.writer,NOW),importer.ensure(&rig.ledger.writer,NOW),release)
    }).await.expect("both readers must settle");
    match (a.unwrap_err(),b.unwrap_err()) {
        (LedgerError::SharedHistory(a), LedgerError::SharedHistory(b)) => {
            assert!(Arc::ptr_eq(&a,&b));
            assert_eq!(a.to_string(),"Original trace unavailable");
        }
        errors => panic!("unshared errors: {errors:?}"),
    }
    assert_eq!(trace.calls.load(Ordering::SeqCst),1);
    trace.release.notify_one();
    assert!(importer.ensure(&rig.ledger.writer,NOW).await.is_err());
    assert_eq!(trace.calls.load(Ordering::SeqCst),2);
}

#[tokio::test]
async fn rejected_history_write_settles_its_accepted_mark() {
    let rig=rig(Vec::new());
    let mut row=row_record(&json!({"kind":"usage_raw","ts":5,"provider":"p","model":"m","input_tokens":1,"output_tokens":1})).unwrap();
    row.day="not-a-day".to_owned();
    let pending=rig.ledger.writer.import_history(super::super::HistoryWrite {
        records:vec![row],legacy_days:Vec::new(),through:None,receipt:None,previously_inserted:0,
    });
    let mark=rig.ledger.writer.marks().accepted();
    assert!(mark>0,"enqueue must synchronously number the import");
    assert!(pending.await.is_err());
    assert!(rig.ledger.writer.marks().check(mark).unwrap().is_err());
    assert_eq!(rig.ledger.writer.marks().committed(),mark);
}

#[tokio::test]
async fn original_queued_live_write_precedes_statistics_cutover() {
    let corpus: Value=serde_json::from_str(include_str!("oracle/original.json")).unwrap();
    let expected=&corpus["apiCases"][1];
    let rig=rig(Vec::new());
    let mut live=expected["live"].clone();
    live["rates"]=json!(mixdog_js::json_stringify(&live["rates"]));
    let row: crate::append::UsageRecord=serde_json::from_value(live).unwrap();
    let queued=rig.ledger.writer.record_queued(row);
    let stats=rig.ledger.get_usage_stats(UsageStatsOptions::default(),||NOW).await.unwrap();
    queued.await.unwrap();
    semantic_equal(&stats["totals"],&expected["totals"],"queued live totals");
    let conn=Connection::open(&rig.path).unwrap();
    equal(&json!(saved(&conn,"liveSince")),&expected["observedCutover"],"queued cutover");
    equal(&json!(saved(&conn,"importedThrough")),&expected["observedCutover"],"import through queued cutover");
}
