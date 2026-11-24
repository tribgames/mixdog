#![allow(clippy::disallowed_types, clippy::disallowed_methods, reason = "test fixture I/O; mixdog-store::sqlite has not landed")]

use std::path::Path;
use std::path::PathBuf;

use mixdog_ledger::append::UsageRecord;
use mixdog_ledger::append::append_batch;
use mixdog_ledger::db::Connection;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::schema::LedgerShape;
use mixdog_ledger::schema::LedgerState;
use mixdog_ledger::schema::Prepared;
use mixdog_ledger::schema::classify;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::sums::build_sums_step;
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
    let n = |t: &str| -> i64 { conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type=?1 AND sql IS NOT NULL", [t], |r| r.get(0)).unwrap() };
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
    let extra: i64 =
        conn.query_row("SELECT COUNT(*) FROM usage_session_days WHERE turns<=0 OR route NOT IN (SELECT id FROM usage_routes)", [], |r| r.get(0)).unwrap();
    assert_eq!((diff, extra), (0, 0));
}

fn upgrade_and_build(path: &Path, expect: Prepared) -> Connection {
    let mut conn = Connection::open(path).unwrap();
    let events: i64 = conn.query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get(0)).unwrap();
    assert_eq!(prepare(&mut conn).unwrap(), expect);
    assert_eq!(counts(&conn), (20, 8, 1, 32));
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

fn v3_route(tokens: Option<u32>) -> String {
    let rates = match tokens {
        Some(t) => format!(r#"{{"pricingModel":"m","cacheWrite1hTokens":{t},"inputCostPerM":8}}"#),
        None => r#"{"pricingModel":"m","inputCostPerM":8}"#.to_owned(),
    };
    mixdog_js::json_stringify(&serde_json::json!(["p", "m", "oauth", "lead", "subscription", rates, "live", 0]))
}

fn v3_ledger_with_split_routes() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    {
        let mut conn = Connection::open(&path).unwrap();
        for script in mixdog_store::schema::sql::LEDGER_NEW_SCRIPTS {
            conn.execute_batch(script).unwrap();
        }
        assert_eq!(classify(&conn).unwrap(), LedgerState::V3);
        conn.execute("INSERT INTO usage_sessions(value) VALUES ('a'),('b')", []).unwrap();
        // Routes 1..=3 carry counts 100, 200, 300; route 4 has none (the merged one already exists).
        for tokens in [Some(100), Some(200), Some(300), None] {
            conn.execute("INSERT INTO usage_routes(signature) VALUES (?1)", [v3_route(tokens)]).unwrap();
        }
        for i in 0..8u8 {
            conn.execute(
                "INSERT INTO usage_events VALUES (?1, 1000, 20260101, ?2, ?3, 1,2,3,4,0.5,10)",
                rusqlite::params![vec![0u8, i], 1 + i64::from(i % 4), 1 + i64::from(i % 2)],
            )
            .unwrap();
        }
        while !build_sums_step(&mut conn, 200).unwrap() {}
        assert_sums_match_events(&conn);
    }
    (dir, path)
}

/// A v3 ledger whose routes differ only by the 1-hour cache-write count in their rates becomes one route per real
/// route: the counts move to `usage_event_cache_1h` and the day sums follow the records.
#[test]
fn v3_routes_split_by_the_1h_count_merge_into_one() {
    let (_dir, path) = v3_ledger_with_split_routes();
    let mut conn = Connection::open(&path).unwrap();
    assert_eq!(prepare(&mut conn).unwrap(), Prepared::UpgradedV3);
    assert_eq!(classify(&conn).unwrap(), LedgerState::Current);
    assert_eq!(counts(&conn), (20, 8, 1, 32));
    let routes: Vec<String> =
        conn.prepare("SELECT signature FROM usage_routes").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(routes, vec![v3_route(None)]);
    let events: i64 = conn.query_row("SELECT COUNT(*) FROM usage_events WHERE route=4", [], |r| r.get(0)).unwrap();
    assert_eq!(events, 8);
    let counts_1h: Vec<f64> =
        conn.prepare("SELECT tokens FROM usage_event_cache_1h ORDER BY id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    // Events 0..8 used routes 1,2,3,4,1,2,3,4: the six on routes 1-3 keep their counts.
    assert_eq!(counts_1h, vec![100.0, 200.0, 300.0, 100.0, 200.0, 300.0]);
    assert_sums_match_events(&conn);
}

#[test]
fn a_record_appended_after_the_1h_merge_lands_on_the_merged_route() {
    let (_dir, path) = v3_ledger_with_split_routes();
    let mut conn = Connection::open(&path).unwrap();
    assert_eq!(prepare(&mut conn).unwrap(), Prepared::UpgradedV3);
    let record: UsageRecord = serde_json::from_value(serde_json::json!({
        "id": "r-1", "ts": 2000, "day": "2026-01-01", "provider": "p", "model": "m", "kind": "oauth",
        "sessionId": "a", "sourceType": "lead", "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 5,
        "costUsd": 0.1, "costSource": "subscription", "origin": "live", "durationMs": 5,
        "rates": r#"{"pricingModel":"m","cacheWrite1hTokens":5,"inputCostPerM":8}"#
    }))
    .unwrap();
    assert_eq!(append_batch(&mut conn, std::slice::from_ref(&record)).unwrap(), 1);
    let (routes, last): (i64, f64) = conn
        .query_row("SELECT (SELECT COUNT(*) FROM usage_routes), (SELECT tokens FROM usage_event_cache_1h WHERE id=x'01722d31')", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((routes, last), (1, 5.0));
    assert_sums_match_events(&conn);
    assert_eq!(prepare(&mut conn).unwrap(), Prepared::Current);
}

/// A v4 ledger's quota readings survive the upgrade to v5 as readings of fixed windows: none declared itself rolling.
#[test]
fn a_v4_ledger_keeps_its_quota_readings_as_fixed_windows_in_v5() {
    let mut conn = Connection::open_in_memory().unwrap();
    for script in mixdog_store::schema::sql::LEDGER_NEW_SCRIPTS {
        conn.execute_batch(script).unwrap();
    }
    conn.execute_batch(mixdog_store::schema::sql::LEDGER_V4_DELTA).unwrap();
    assert_eq!(classify(&conn).unwrap(), LedgerState::V4);
    conn.execute("INSERT INTO quota_samples VALUES ('p','a','5H',1,1,10,NULL)", []).unwrap();

    assert_eq!(prepare(&mut conn).unwrap(), Prepared::UpgradedV4);

    assert_eq!(classify(&conn).unwrap(), LedgerState::Current);
    assert_eq!(counts(&conn), (20, 8, 1, 32));
    let rolling: i64 = conn.query_row("SELECT rolling FROM quota_samples", [], |r| r.get(0)).unwrap();
    assert_eq!(rolling, 0);
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
        conn.execute("INSERT INTO usage_sessions(value) VALUES ('a'),('b')", []).unwrap();
        for i in 0..5 {
            conn.execute("INSERT INTO usage_events VALUES (?1, 1000, 20260101, 1, ?2, 1,2,3,4,0.5,10)", rusqlite::params![vec![1u8, i as u8], 1 + i % 2])
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
    assert_eq!(append_batch(&mut conn, std::slice::from_ref(&record)).unwrap(), 1);
    assert_eq!(append_batch(&mut conn, std::slice::from_ref(&record)).unwrap(), 0);
    assert_sums_match_events(&conn);
}

#[test]
#[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
fn corpus_ledger_upgrades() {
    let src = PathBuf::from(std::env::var_os("MIXDOG_MIGRATION_CORPUS").expect("MIXDOG_MIGRATION_CORPUS names the migration corpus"))
        .join("v145/usage/ledger.sqlite");
    let (_dir, path) = copy_to_temp(&src);
    let conn = Connection::open(&path).unwrap();
    let shape = match classify(&conn).unwrap() {
        LedgerState::Upgradable(shape) => shape,
        other => panic!("{other:?}"),
    };
    drop(conn);
    upgrade_and_build(&path, Prepared::Upgraded(shape));
}

#[tokio::test]
async fn a_145_ledger_upgrades_keeps_its_requests_and_answers_its_queries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.sqlite");
    crate::v145::write_v145(&path);
    let conn = upgrade_and_build(&path, Prepared::Upgraded(LedgerShape::Tag145));
    let tokens = mixdog_rt::testing::tokens();
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let rollup = reader.rollup(RollupQuery::default()).await.unwrap();
    assert_eq!(rollup["days"].as_object().unwrap().len(), 2, "both days of the ledger");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
    let sessions: Vec<String> =
        conn.prepare("SELECT value FROM usage_sessions LIMIT 3").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    let before = reader.usage_token(sessions.clone(), vec![]).await.unwrap();
    reader.session_usage(sessions.clone(), vec![]).await.unwrap();
    assert_eq!(reader.usage_token(sessions, vec![]).await.unwrap(), before);
}
