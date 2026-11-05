#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::path::Path;
use std::path::PathBuf;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::append::append_batch;
use mixdog_ledger::db::Connection;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::rollup::rollup_usage;
use mixdog_ledger::schema::LedgerShape;
use mixdog_ledger::schema::LedgerState;
use mixdog_ledger::schema::Prepared;
use mixdog_ledger::schema::classify;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::sums::build_sums_step;
use mixdog_ledger::sums::read_session_usage;
use mixdog_ledger::sums::read_usage_token;
use mixdog_ledger::sums::sums_complete;
use mixdog_store::schema::sql::LEDGER_V2_BASE;
use mixdog_store::schema::sql::LEDGER_V2_DEV;

fn copy_to_temp(src: &Path) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let dst = dir.path().join("ledger.sqlite");
    std::fs::copy(src, &dst).unwrap();
    (dir, dst)
}

fn counts(conn: &Connection) -> (i64, i64, i64, i64) {
    let n = |t: &str| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type=?1 AND sql IS NOT NULL",
            [t],
            |r| r.get(0),
        )
        .unwrap()
    };
    (n("table"), n("index"), n("view"), n("trigger"))
}

/// Sums equal the events they summarize, regardless of how many steps the build took.
fn assert_sums_match_events(conn: &Connection) {
    let diff: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (
               SELECT session,day,route,COUNT(*) t,SUM(input) i,SUM(output) o,SUM(cache_read) cr,SUM(cache_write) cw,
                      SUM(COALESCE(cost_usd,0)) c,SUM(duration_ms) d FROM usage_events GROUP BY session,day,route
               EXCEPT
               SELECT session,day,route,turns,input,output,cache_read,cache_write,cost_usd,duration_ms FROM usage_session_days)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let extra: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM usage_session_days WHERE turns<=0 OR route NOT IN (SELECT id FROM usage_routes)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((diff, extra), (0, 0));
}

fn upgrade_and_build(path: &Path, expect: Prepared) -> Connection {
    let mut conn = Connection::open(path).unwrap();
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(prepare(&mut conn).unwrap(), expect);
    assert_eq!(counts(&conn), (19, 7, 1, 31));
    assert_eq!(classify(&conn).unwrap(), LedgerState::Current);
    assert_eq!(sums_complete(&conn).unwrap(), events == 0);
    // Small budget forces many resumable steps.
    let mut steps = 0;
    while !build_sums_step(&mut conn, 200).unwrap() {
        steps += 1;
        assert!(steps < 100_000);
    }
    assert!(sums_complete(&conn).unwrap());
    assert_sums_match_events(&conn);
    assert_eq!(prepare(&mut conn).unwrap(), Prepared::Current);
    conn
}

#[test]
fn genuine_145_fixture_upgrades() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/migration/ledger-v145/ledger.sqlite");
    let (_dir, path) = copy_to_temp(&src);
    let conn = upgrade_and_build(&path, Prepared::Upgraded(LedgerShape::Tag145));
    let rollup = rollup_usage(&conn, &RollupQuery::default()).unwrap();
    assert!(!rollup.days.is_empty());
    let sessions: Vec<String> = conn
        .prepare("SELECT value FROM usage_sessions LIMIT 3")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let before = read_usage_token(&conn, &sessions, &[]).unwrap();
    read_session_usage(&conn, &sessions, &[]).unwrap();
    assert_eq!(read_usage_token(&conn, &sessions, &[]).unwrap(), before);
}

#[test]
fn corpus_ledger_upgrades() {
    let src = PathBuf::from(
        r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus\v145\usage\ledger.sqlite",
    );
    if !src.exists() {
        return;
    }
    let (_dir, path) = copy_to_temp(&src);
    let conn = Connection::open(&path).unwrap();
    let shape = match classify(&conn).unwrap() {
        LedgerState::Upgradable(shape) => shape,
        other => panic!("{other:?}"),
    };
    drop(conn);
    upgrade_and_build(&path, Prepared::Upgraded(shape));
}

#[test]
fn dev_shape_upgrades_and_append_after_is_counted_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(LEDGER_V2_BASE).unwrap();
        conn.execute_batch(LEDGER_V2_DEV).unwrap();
        conn.execute_batch("PRAGMA user_version = 2").unwrap();
        conn.execute("INSERT INTO usage_routes(signature) VALUES ('[\"p\",\"m\",\"k\",\"s\",\"provider\",null,\"live\",0]')", []).unwrap();
        conn.execute("INSERT INTO usage_sessions(value) VALUES ('a'),('b')", [])
            .unwrap();
        for i in 0..5 {
            conn.execute(
                "INSERT INTO usage_events VALUES (?1, 1000, 20260101, 1, ?2, 1,2,3,4,0.5,10)",
                rusqlite::params![vec![1u8, i as u8], 1 + i % 2],
            )
            .unwrap();
        }
    }
    let mut conn = upgrade_and_build(&path, Prepared::Upgraded(LedgerShape::Dev146));
    let record: UsageRecord = serde_json::from_value(serde_json::json!({
        "id": "r-1", "ts": 2000, "day": "2026-01-01", "provider": "p", "model": "m", "kind": "k",
        "sessionId": "a", "sourceType": "s", "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0,
        "costUsd": 0.1, "costSource": "provider", "origin": "live", "durationMs": 5
    }))
    .unwrap();
    assert_eq!(
        append_batch(&mut conn, std::slice::from_ref(&record)).unwrap(),
        1
    );
    assert_eq!(
        append_batch(&mut conn, std::slice::from_ref(&record)).unwrap(),
        0
    );
    assert_sums_match_events(&conn);
}
