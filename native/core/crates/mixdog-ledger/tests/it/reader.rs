//! The query API on its lanes: every query is served through [`UsageReader`], the lane
//! each query shape runs on is the documented one, and the interactive statements never scan a
//! table (RL §7.2: query-plan test).
#![allow(
    clippy::disallowed_types,
    clippy::disallowed_methods,
    reason = "test fixture I/O; mixdog-store::sqlite has not landed"
)]

use std::collections::BTreeMap;
use std::path::Path;

use mixdog_ledger::db::Connection;
use mixdog_ledger::quota::NEXT_SERIES_SQL;
use mixdog_ledger::quota::QuotaHistoryOptions;
use mixdog_ledger::quota::SERIES_CHANGED_SQL;
use mixdog_ledger::quota::WINDOW_ROWS_SQL;
use mixdog_ledger::reader::ReadLane;
use mixdog_ledger::reader::UsageReader;
use mixdog_ledger::requests::MODEL_ROUTES_SQL;
use mixdog_ledger::requests::MODELS_ROUTES_SQL;
use mixdog_ledger::requests::OWNER_SQL;
use mixdog_ledger::requests::ROUTE_INFO_SQL;
use mixdog_ledger::requests::RequestQuery;
use mixdog_ledger::requests::SESSION_SQL;
use mixdog_ledger::requests::Source;
use mixdog_ledger::requests::models_probe_sql;
use mixdog_ledger::requests::page_sql;
use mixdog_ledger::rollup::RollupQuery;
use mixdog_ledger::schema::prepare;
use mixdog_ledger::stats::UsageStatsOptions;
use mixdog_ledger::sums::build_sums_step;
use rusqlite::types::Null;

const CORPUS: &str =
    r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus\v145\usage\ledger.sqlite";

fn upgraded(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("ledger.sqlite");
    std::fs::copy(CORPUS, &path).unwrap();
    let mut conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    prepare(&mut conn).unwrap();
    while !build_sums_step(&mut conn, 500).unwrap() {}
    path
}

#[tokio::test]
async fn every_lane_serves_its_queries() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let path = upgraded(dir.path());
    let reader = UsageReader::new(&path, tokens.interactive_io, tokens.maintenance_io);
    let now = 1_793_890_000_000_i64;

    // The answers' content is pinned by the Node goldens (`stats_parity`); this checks that every
    // lane serves its queries, and that a repeated read on the pooled connection agrees.
    for options in [r#"{"view":"day"}"#, r#"{"view":"hour"}"#, r#"{"days":7}"#] {
        let options: UsageStatsOptions = serde_json::from_str(options).unwrap();
        let first = reader.usage_stats(options.clone(), now).await.unwrap();
        let again = reader.usage_stats(options, now).await.unwrap();
        assert_eq!(
            mixdog_js::json_stringify(&first),
            mixdog_js::json_stringify(&again)
        );
    }
    let history = reader
        .quota_history(QuotaHistoryOptions::default(), BTreeMap::new(), now)
        .await
        .unwrap();
    assert!(history.is_object());
    let day = reader.rollup(RollupQuery::default()).await.unwrap();
    assert!(day["days"].as_object().is_some_and(|d| !d.is_empty()));
}

#[test]
fn event_reading_queries_take_the_maintenance_lane() {
    let timed = RollupQuery {
        from_ms: Some(1),
        to_ms: Some(2),
        ..RollupQuery::default()
    };
    let hourly = RollupQuery {
        hourly_day: Some("2026-11-05".into()),
        ..RollupQuery::default()
    };
    assert_eq!(UsageReader::rollup_lane(&timed), ReadLane::Maintenance);
    assert_eq!(UsageReader::rollup_lane(&hourly), ReadLane::Maintenance);
    assert_eq!(
        UsageReader::rollup_lane(&RollupQuery::default()),
        ReadLane::Interactive
    );
    let stats = |json: &str| UsageReader::stats_lane(&serde_json::from_str(json).unwrap());
    assert_eq!(stats(r#"{"view":"hour"}"#), ReadLane::Maintenance);
    assert_eq!(
        stats(
            r#"{"view":"custom","startDay":"2026-11-01","endDay":"2026-11-02","startTime":"09:00"}"#
        ),
        ReadLane::Maintenance
    );
    assert_eq!(stats(r#"{"view":"day"}"#), ReadLane::Interactive);
    assert_eq!(stats(r#"{"days":30}"#), ReadLane::Interactive);
}

/// Every plan row of `sql` (bound to NULLs) that is unbounded: SQLite writes a bounded read as
/// `SEARCH`, so any `SCAN` visits a whole table or index, and a temporary b-tree sorts a range.
fn scans(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let count = conn.prepare(sql).unwrap().parameter_count();
    let params: Vec<&dyn rusqlite::ToSql> =
        (0..count).map(|_| &Null as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(params.as_slice(), |r| r.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.into_iter()
        .filter(|row| row.starts_with("SCAN ") || row.contains("TEMP B-TREE"))
        .collect()
}

#[test]
fn interactive_statements_do_not_scan_a_table() {
    let dir = tempfile::tempdir().unwrap();
    let path = upgraded(dir.path());
    let conn = Connection::open(&path).unwrap();
    let mut statements: Vec<(String, String)> = vec![
        ("quota next series".into(), NEXT_SERIES_SQL.into()),
        ("quota series changed".into(), SERIES_CHANGED_SQL.into()),
        ("quota window rows".into(), WINDOW_ROWS_SQL.into()),
        ("request model routes".into(), MODEL_ROUTES_SQL.into()),
        ("request route info".into(), ROUTE_INFO_SQL.into()),
        ("request session".into(), SESSION_SQL.into()),
        ("request owner".into(), OWNER_SQL.into()),
    ];
    for source in [Source::Time, Source::Status, Source::Route] {
        for cursor in [false, true] {
            for completed in [false, true] {
                for routes in [0, 1, 3] {
                    statements.push((
                        format!(
                            "request page {}/{cursor}/{completed}/{routes}",
                            source as u8
                        ),
                        page_sql(source, cursor, completed, routes),
                    ));
                }
            }
        }
    }
    // The check sees a scan when there is one.
    assert!(!scans(&conn, "SELECT * FROM usage_events WHERE input>?1").is_empty());
    let mut failed = Vec::new();
    for (name, sql) in &statements {
        let found = scans(&conn, sql);
        if !found.is_empty() {
            failed.push(format!("{name}: {found:?}"));
        }
    }
    assert!(
        failed.is_empty(),
        "full table scans:\n{}",
        failed.join("\n")
    );
}

/// A later page is an interactive, index-bounded read. The first page also lists the models,
/// which visits every route, so the whole first page is one maintenance job (one snapshot).
#[test]
fn first_page_is_one_maintenance_job() {
    let first = RequestQuery::default();
    let later = RequestQuery {
        cursor: Some("1:ab".into()),
        ..RequestQuery::default()
    };
    assert_eq!(UsageReader::requests_lane(&first), ReadLane::Maintenance);
    assert_eq!(UsageReader::requests_lane(&later), ReadLane::Interactive);

    // The reason: the list enumerates every route, which no index bounds.
    let dir = tempfile::tempdir().unwrap();
    let conn = Connection::open(upgraded(dir.path())).unwrap();
    assert!(!scans(&conn, MODELS_ROUTES_SQL).is_empty());
    assert!(scans(&conn, &models_probe_sql()).is_empty());
}
