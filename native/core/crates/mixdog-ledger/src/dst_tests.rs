//! Hourly and daily rollups across daylight-saving changes, in a fixed zone through
//! `mixdog_js::time`'s test override (the one local-time implementation the ledger uses).
//! Expected values come from the calendar: a spring-forward day has 23 hours, a fall-back day
//! 25, and wall-clock times map to instants by `Date`'s rules.
#![allow(
    clippy::disallowed_methods,
    reason = "test fixture: a temporary ledger file"
)]

use chrono::DateTime;
use chrono::NaiveDate;
use mixdog_js::time::Tz;
use mixdog_js::time::with_local_zone;
use serde_json::Value;

use crate::append::UsageRecord;
use crate::append::append_batch;
use crate::db::Connection;
use crate::hours::hourly_series;
use crate::rollup::RollupQuery;
use crate::rollup::rollup_usage;
use crate::schema::prepare;
use crate::sums::build_sums_step;
use crate::time::day_key;
use crate::time::local_midnight_ms;
use crate::time::local_ms;
use crate::time::next_midnight_ms;
use crate::time::parse_day;

const HOUR: i64 = 3_600_000;

fn utc(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp_millis()
}

fn record(id: &str, ts: i64) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": id, "ts": ts, "day": day_key(ts), "provider": "p", "model": "m", "kind": "api",
        "sessionId": "s1", "sourceType": "user", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2,
        "costUsd": 0.1, "costSource": "catalog", "origin": "live", "durationMs": 100
    }))
    .unwrap()
}

/// The rollup of one local `day` with its hourly view, over a ledger holding `events`, and the
/// day's hourly series.
fn day_view(day: &str, events: &[i64]) -> (Value, Vec<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = Connection::open(dir.path().join("ledger.sqlite")).unwrap();
    prepare(&mut conn).unwrap();
    let rows: Vec<UsageRecord> = events
        .iter()
        .enumerate()
        .map(|(i, ts)| record(&format!("r{i}"), *ts))
        .collect();
    append_batch(&mut conn, &rows).unwrap();
    while !build_sums_step(&mut conn, 100).unwrap() {}

    let mut query = RollupQuery::days(day, day);
    query.hourly_day = Some(day.to_string());
    let rollup = rollup_usage(&conn, &query).unwrap();
    let date = parse_day(day).unwrap();
    let series = hourly_series(
        rollup.hourly.as_ref(),
        local_midnight_ms(date),
        next_midnight_ms(date) - 1,
        next_midnight_ms(date),
        false,
    );
    (rollup.to_value(), series.as_array().unwrap().clone())
}

fn labels(series: &[Value]) -> Vec<&str> {
    series
        .iter()
        .map(|b| b["label"].as_str().unwrap())
        .collect()
}

fn turns(bucket: &Value) -> i64 {
    bucket["turns"].as_i64().unwrap()
}

#[test]
fn spring_forward_day_has_23_hours() {
    with_local_zone(Tz::America__New_York, || {
        let date = parse_day("2026-03-08").unwrap();
        let (start, end) = (local_midnight_ms(date), next_midnight_ms(date));
        assert_eq!(start, utc("2026-03-08T05:00:00Z"));
        assert_eq!(end, utc("2026-03-09T04:00:00Z"));
        assert_eq!(end - start, 23 * HOUR);
        assert_eq!(day_key(start - 1), "2026-03-07");
        assert_eq!(day_key(start), "2026-03-08");
        assert_eq!(day_key(end - 1), "2026-03-08");
        assert_eq!(day_key(end), "2026-03-09");
        // 02:30 does not exist: it reads with the offset before the change.
        let gap = NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(2, 30, 0)
            .unwrap();
        assert_eq!(local_ms(gap), utc("2026-03-08T07:30:00Z"));

        let events = [
            start - 1,
            utc("2026-03-08T06:59:59Z"),
            utc("2026-03-08T07:00:00Z"),
            end - 1,
            end,
        ];
        let (rollup, series) = day_view("2026-03-08", &events);
        assert_eq!(turns(&rollup["days"]["2026-03-08"]), 3);
        assert_eq!(rollup["hourly"]["rows"].as_array().unwrap().len(), 3);

        assert_eq!(series.len(), 23);
        let names = labels(&series);
        assert_eq!(&names[..4], ["00:00", "01:00", "03:00", "04:00"]);
        assert!(!names.contains(&"02:00"));
        let filled: Vec<(usize, i64)> = series
            .iter()
            .enumerate()
            .map(|(i, b)| (i, turns(b)))
            .filter(|(_, t)| *t > 0)
            .collect();
        assert_eq!(filled, [(1, 1), (2, 1), (22, 1)]);
    });
}

#[test]
fn fall_back_day_has_25_hours() {
    with_local_zone(Tz::America__New_York, || {
        let date = parse_day("2026-11-01").unwrap();
        let (start, end) = (local_midnight_ms(date), next_midnight_ms(date));
        assert_eq!(start, utc("2026-11-01T04:00:00Z"));
        assert_eq!(end, utc("2026-11-02T05:00:00Z"));
        assert_eq!(end - start, 25 * HOUR);
        assert_eq!(day_key(start - 1), "2026-10-31");
        assert_eq!(day_key(end - 1), "2026-11-01");
        assert_eq!(day_key(end), "2026-11-02");
        // 01:30 happens twice: the first occurrence.
        let repeated = date.and_hms_opt(1, 30, 0).unwrap();
        assert_eq!(local_ms(repeated), utc("2026-11-01T05:30:00Z"));

        let events = [
            start - 1,
            utc("2026-11-01T05:30:00Z"),
            utc("2026-11-01T06:30:00Z"),
            end - 1,
            end,
        ];
        let (rollup, series) = day_view("2026-11-01", &events);
        assert_eq!(turns(&rollup["days"]["2026-11-01"]), 3);

        assert_eq!(series.len(), 25);
        let names = labels(&series);
        assert_eq!(names[0], "00:00");
        assert_eq!(names.iter().filter(|n| **n == "01:00").count(), 2);
        let filled: Vec<(usize, i64)> = series
            .iter()
            .enumerate()
            .map(|(i, b)| (i, turns(b)))
            .filter(|(_, t)| *t > 0)
            .collect();
        assert_eq!(filled, [(1, 1), (2, 1), (24, 1)]);
    });
}
