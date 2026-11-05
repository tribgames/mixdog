//! The same DST day through the lanes: a lane job runs on its own thread, so the zone is pinned
//! for the whole process (`set_process_zone`) before any lane starts, not with a thread-scoped
//! override. This test binary holds this one test, so nothing else sees the pinned zone.
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use mixdog_js::time::Tz;
use mixdog_js::time::set_process_zone;
use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::writer::UsageWriter;

/// 2026-03-08 in New York is 23 hours long: local midnight is 05:00Z, the next is 04:00Z.
const START: i64 = 1_772_946_000_000;
const HOUR: i64 = 3_600_000;

fn record(id: &str, ts: i64, day: &str) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": id, "ts": ts, "day": day, "provider": "p", "model": "m", "kind": "api",
        "sessionId": "s1", "sourceType": "user", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2,
        "costUsd": 0.1, "costSource": "catalog", "origin": "live", "durationMs": 100
    }))
    .unwrap()
}

#[tokio::test]
async fn lane_jobs_read_the_pinned_zone() {
    set_process_zone(Tz::America__New_York).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    let writer =
        UsageWriter::open(tokens.sqlite_writer_thread, tokens.maintenance_io, &path).unwrap();
    let end = START + 23 * HOUR;
    for (id, ts, day) in [
        ("before", START - 1, "2026-03-07"),
        ("a", START + HOUR + HOUR - 1, "2026-03-08"),
        // 03:00 EDT, the hour after the gap.
        ("b", START + 2 * HOUR, "2026-03-08"),
        ("c", end - 1, "2026-03-08"),
        ("after", end, "2026-03-09"),
    ] {
        writer.record_queued(record(id, ts, day)).await.unwrap();
    }
    writer.settle_writes().await.unwrap();

    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let mut query = RollupQuery::days("2026-03-08", "2026-03-08");
    query.hourly_day = Some("2026-03-08".into());
    let rollup = reader.rollup(query).await.unwrap();
    assert_eq!(rollup["days"]["2026-03-08"]["turns"], 3);
    // The hourly view is cut by the zone's local midnights (a lane job): exactly the day's
    // three records, none of the neighbouring days'.
    assert_eq!(rollup["hourly"]["rows"].as_array().unwrap().len(), 3);
}
