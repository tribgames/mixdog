#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::collections::BTreeMap;
use std::path::Path;

use mixdog_core_api::StatePublisher;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_ledger::LedgerError;
use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::append::append_batch;
use mixdog_ledger::db::Connection;
use mixdog_ledger::maintenance::maintain_usage;
use mixdog_ledger::maintenance::recompute_rollup_days;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::repair::Priced;
use mixdog_ledger::repair::RepairOptions;
use mixdog_ledger::repair::integrity;
use mixdog_ledger::repair::repair_usage_ledger;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::sums::build_sums_step;
use mixdog_protocol::SectionName;

/// 2026-01-01T12:00:00Z: the same calendar day in every time zone from UTC-12 to UTC+11.
const NOON_JAN_1: i64 = 1_767_225_600_000 + 43_200_000;

fn record(
    id: &str,
    ts: i64,
    day: &str,
    provider: &str,
    cost: Option<f64>,
    source: &str,
) -> UsageRecord {
    serde_json::from_value(serde_json::json!({
        "id": id, "ts": ts, "day": day, "provider": provider, "model": "m", "kind": "api",
        "sessionId": "s1", "sourceType": "user", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2,
        "costUsd": cost, "costSource": source, "origin": "live", "durationMs": 100
    }))
    .unwrap()
}

fn ledger(dir: &Path) -> Connection {
    let mut conn = Connection::open(dir.join("ledger.sqlite")).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    prepare(&mut conn).unwrap();
    while !build_sums_step(&mut conn, 100).unwrap() {}
    conn
}

fn options(backup: bool) -> RepairOptions {
    RepairOptions {
        through_ts: 10_000_000_000_000,
        only_unpriced: true,
        backup,
        ..RepairOptions::default()
    }
}

#[test]
fn repair_reprices_keeps_records_and_backs_up_the_prior_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ledger(dir.path());
    let rows = [
        record("a", 1_000, "2026-01-01", "p", None, "unpriced"),
        record("b", 2_000, "2026-01-01", "p", Some(0.5), "catalog"),
    ];
    append_batch(&mut conn, &rows).unwrap();
    let before = integrity(&conn).unwrap();

    let mut price = |_: &_| {
        Ok(Priced {
            cost_usd: Some(0.25),
            rates: None,
        })
    };
    let report = repair_usage_ledger(&mut conn, &options(true), 5_000, &mut price).unwrap();
    assert_eq!(
        (report.repriced, report.still_unpriced, report.reattributed),
        (1, 0, 0)
    );
    assert_eq!(report.integrity.as_ref(), Some(&before));
    assert_eq!(integrity(&conn).unwrap(), before);

    let costs: Vec<Option<f64>> = conn
        .prepare("SELECT cost_usd FROM usage_events ORDER BY ts")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(costs, [Some(0.25), Some(0.5)]);
    let daily: f64 = conn
        .query_row("SELECT SUM(cost_usd) FROM daily", [], |r| r.get(0))
        .unwrap();
    assert_eq!(daily, 0.75);

    let backup = Connection::open(report.backup_path.unwrap()).unwrap();
    let old: Option<f64> = backup
        .query_row("SELECT cost_usd FROM usage_events WHERE ts=1000", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(old, None);

    // A second repair has nothing to do and writes nothing.
    let again = repair_usage_ledger(&mut conn, &options(false), 6_000, &mut price).unwrap();
    assert!(again.integrity.is_none() && again.repriced == 0);
}

#[test]
fn repair_rejects_an_invalid_price_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ledger(dir.path());
    append_batch(
        &mut conn,
        &[record("a", 1_000, "2026-01-01", "p", None, "unpriced")],
    )
    .unwrap();
    let mut price = |_: &_| {
        Ok(Priced {
            cost_usd: Some(-1.0),
            rates: None,
        })
    };
    let error = repair_usage_ledger(&mut conn, &options(false), 5_000, &mut price).unwrap_err();
    assert!(matches!(error, LedgerError::RepairPrice));
    let cost: Option<f64> = conn
        .query_row("SELECT cost_usd FROM usage_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cost, None);

    let bad = RepairOptions {
        through_ts: 0,
        ..RepairOptions::default()
    };
    assert!(repair_usage_ledger(&mut conn, &bad, 1, &mut price).is_err());
}

#[test]
fn repair_moves_a_provider_and_updates_the_route() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ledger(dir.path());
    append_batch(
        &mut conn,
        &[record(
            "a",
            1_000,
            "2026-01-01",
            "old",
            Some(0.5),
            "catalog",
        )],
    )
    .unwrap();
    let before = integrity(&conn).unwrap();
    let opts = RepairOptions {
        through_ts: 10_000_000_000_000,
        provider_overrides: BTreeMap::from([("old".to_string(), "new-oauth".to_string())]),
        ..RepairOptions::default()
    };
    let mut price = |request: &mixdog_ledger::repair::PriceRequest| {
        assert_eq!(
            (request.provider.as_str(), request.kind.as_str()),
            ("new-oauth", "oauth")
        );
        Ok(Priced {
            cost_usd: Some(0.0),
            rates: None,
        })
    };
    let report = repair_usage_ledger(&mut conn, &opts, 5_000, &mut price).unwrap();
    assert_eq!(report.reattributed, 1);
    assert_eq!(integrity(&conn).unwrap(), before);
    let (provider, source): (String, String) = conn
        .query_row("SELECT provider,cost_source FROM events", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(
        (provider.as_str(), source.as_str()),
        ("new-oauth", "subscription")
    );
}

#[tokio::test]
async fn recompute_and_publish_the_usage_section() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ledger(dir.path());
    let rows: Vec<_> = (0..20)
        .map(|i| {
            record(
                &format!("r{i}"),
                NOON_JAN_1 + i * 86_400_000,
                &format!("2026-01-{:02}", i + 1),
                "p",
                Some(0.1),
                "catalog",
            )
        })
        .collect();
    append_batch(&mut conn, &rows).unwrap();
    // Well after every stored day (they are named 2026-01-xx), so all of them are completed.
    let now = 1_800_000_000_000_i64;

    let publisher = MockStatePublisher::default();
    let mut steps = 0;
    while !maintain_usage(&mut conn, &publisher, "all", now).unwrap() {
        steps += 1;
        assert!(steps < 10);
    }
    assert!(steps >= 1, "20 stale days take more than one bounded step");
    assert_eq!(recompute_rollup_days(&mut conn, now).unwrap().recomputed, 0);

    let published = publisher.published();
    assert_eq!(published.len(), 1);
    let (section, key, change) = &published[0];
    assert_eq!(
        (*section, key.as_deref()),
        (SectionName::Usage, Some("all"))
    );
    let SectionChange::Set(bytes) = change else {
        panic!("expected an inline value")
    };
    let sent: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let reader = UsageReader::new(
        &dir.path().join("ledger.sqlite"),
        tokens.interactive_io,
        tokens.maintenance_io,
    );
    let direct = reader.rollup(RollupQuery::default()).await.unwrap();
    for (day, value) in direct["days"].as_object().unwrap() {
        assert_eq!(&sent["days"][day], value, "day {day}");
    }
    assert_eq!(sent, direct);

    // A new record moves its day's fingerprint: the next step recomputes exactly that day.
    append_batch(
        &mut conn,
        &[record(
            "late",
            NOON_JAN_1 + 500,
            "2026-01-01",
            "p",
            Some(0.2),
            "catalog",
        )],
    )
    .unwrap();
    assert_eq!(recompute_rollup_days(&mut conn, now).unwrap().recomputed, 1);
    let _: &dyn StatePublisher = &publisher;
}
