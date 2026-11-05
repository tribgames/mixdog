//! The day sums on the production path (a `UsageWriter` that builds them itself): they are the
//! exact numbers Node's whole-session `SUM` stores, and a build interrupted at any point resumes.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::path::Path;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::append::append_batch;
use mixdog_ledger::db::Connection;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::stats::session_usage_snapshot;
use mixdog_ledger::sums::build_sums_step;
use mixdog_ledger::sums::sums_complete;
use mixdog_ledger::writer::UsageWriter;
use serde_json::Value;

/// A ledger holding `records` whose sums are not built yet.
fn unbuilt(path: &Path, records: &[UsageRecord]) {
    let mut conn = Connection::open(path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    prepare(&mut conn).unwrap();
    for chunk in records.chunks(500) {
        append_batch(&mut conn, chunk).unwrap();
    }
    conn.execute_batch(
        "DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0",
    )
    .unwrap();
}

/// Node's rounding case (`record-ledger-sums.mjs`): a session of 1,000 records at 0.000001 and
/// one at 0.0000005. Summed whole it is 0.0010004999999999999, which Node's six-decimal display
/// writes as 0.001; sums added slice by slice show 0.001001.
#[tokio::test]
async fn a_large_session_sums_and_formats_as_node_does() {
    let golden: Value = serde_json::from_slice(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/ledger-queries/sums-rounding.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let records: Vec<UsageRecord> = golden["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| serde_json::from_value(r.clone()).unwrap())
        .collect();
    assert_eq!(records.len(), 1_001);

    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    unbuilt(&path, &records);
    // The default budget: the session is larger than a batch and is still summed whole.
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    writer.sums_built().await.unwrap();

    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let usage = reader
        .session_usage(vec!["rounding".into()], vec![])
        .await
        .unwrap();
    let bytes = |v: &Value| mixdog_js::json_stringify(v);
    assert_eq!(bytes(&usage), bytes(&golden["usage"]));
    assert_eq!(
        bytes(&session_usage_snapshot(&usage)),
        bytes(&golden["snapshot"])
    );
    assert_eq!(usage["costUsd"].as_f64().unwrap(), 0.0010004999999999999);
    assert_eq!(golden["snapshot"]["costUsd"], 0.001);
}

fn record(n: u64, session: &str) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": format!("{n:064x}"), "ts": 1_000 + n, "day": "2026-01-01", "provider": "p", "model": "m",
        "kind": "api", "sessionId": session, "sourceType": "user", "input": 10, "output": 5,
        "cacheRead": 1, "cacheWrite": 2, "costUsd": 0.5, "costSource": "catalog", "origin": "live",
        "durationMs": 100
    }))
    .unwrap()
}

/// The cursor is the only build state, so a build stopped anywhere (the process died) resumes
/// from the writer's next open and ends with every record counted once.
#[tokio::test]
async fn a_build_interrupted_midway_resumes_after_a_reopen() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let records: Vec<UsageRecord> = (0..40_u64)
        .flat_map(|session| (0..25).map(move |i| record(session * 100 + i, &format!("s{session}"))))
        .collect();
    unbuilt(&path, &records);

    // A build that got three steps far, then stopped.
    {
        let mut conn = Connection::open(&path).unwrap();
        for _ in 0..3 {
            assert!(!build_sums_step(&mut conn, 100).unwrap());
        }
        let next: i64 = conn
            .query_row("SELECT next FROM usage_session_days_state", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(next > 0 && !sums_complete(&conn).unwrap());
        // A record lands on a session it has built and on one it has not.
        append_batch(&mut conn, &[record(7_000, "s0"), record(5_000, "s39")]).unwrap();
    }

    let writer = UsageWriter::open_with_build_budget(
        tokens.sqlite_writer_thread,
        tokens.maintenance_io,
        &path,
        100,
    )
    .unwrap();
    writer.sums_built().await.unwrap();

    let conn = Connection::open(&path).unwrap();
    let (counted, events): (i64, i64) = conn
        .query_row(
            "SELECT (SELECT SUM(turns) FROM usage_session_days),(SELECT COUNT(*) FROM usage_events)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((counted, events), (1_002, 1_002));
    let mismatched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (
               SELECT session,day,route,COUNT(*) t,SUM(input) i,SUM(cost_usd) c FROM usage_events GROUP BY session,day,route
               EXCEPT SELECT session,day,route,turns,input,cost_usd FROM usage_session_days)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mismatched, 0);
}
