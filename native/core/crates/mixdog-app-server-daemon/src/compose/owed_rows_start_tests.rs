//! A start whose index owes a session its rows (an unclean exit left the session behind its log; the index is not rebuilt)
//! composes without waiting for that projection: the restart's settlement of the stored worker rows runs behind the composed
//! core, and a read of the worker rows waits for that settlement.
use std::time::Duration;

use mixdog_store::sqlite::DirtyMark;
use mixdog_store::summary::CatalogHead;

use super::*;

const SESSION: &str = "sess_1_1795000000000_1795000000000_0123456789abcdef0123456789abcdef";

/// An index at `data` holding one session's row marked dirty, as a process that ended without retiring its writer leaves it.
async fn index_owing_a_session(data: &Path, tokens: &LaneTokens) {
    let root = data.to_path_buf();
    let (thread, read) = (tokens.sqlite_writer_thread, tokens.interactive_io);
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
        mixdog_store::sqlite::SqliteStore::open(lane, thread, read, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let header = serde_json::Map::from_iter([("id".to_owned(), serde_json::Value::from(SESSION))]);
    index
        .upsert(CatalogHead { session: SESSION.to_owned(), log_id: "owed-rows-start".to_owned(), base_session: None, header: header.into() }, DirtyMark::Set)
        .await
        .expect("the session's row");
    index.close();
}

#[test]
fn a_start_owing_a_session_its_rows_is_composed_before_that_projection_ends_and_a_worker_rows_read_waits_for_the_settlement() {
    crate::compose_test_support::on_marked_runtime(owed_rows_do_not_hold_the_start());
}

#[allow(clippy::disallowed_methods, reason = "Test-only fixture setup: the test's own data directory.")]
async fn owed_rows_do_not_hold_the_start() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    index_owing_a_session(&data, &tokens).await;
    // The session's repair does not start before the test lets it: its rows stay owed for as long.
    let (release, _arrived) = mixdog_store::sqlite::repair_hold::hold(&data, SESSION);
    let stop = mixdog_rt::CancellationToken::new();
    let log = crate::daemon_log::DaemonLog::new(data.join("daemon.log"), tokens.maintenance_io, stop.clone());
    let mut config = tests::config_without_postgres(&data, dir.path(), log, stop, "the owed-rows test must not install PostgreSQL");
    config.js_runtime.program = "node".into();
    let core = mixdog_rt::time::timeout(Duration::from_secs(60), compose(&tokens, config))
        .await
        .expect("the start waited for the projection its index owes")
        .unwrap_or_else(|e| panic!("the daemon must compose: {e}"));
    let index = core.catalog_index();
    assert!(!index.rebuilding(), "the index is repaired, not rebuilt");
    assert!(index.owes_projection(), "the session's rows are still owed when the start is composed");

    let registry = core.real.agent_registry.clone();
    let mut read = std::pin::pin!(registry.pending_restart_failures());
    assert!(
        mixdog_rt::time::timeout(Duration::from_millis(500), &mut read).await.is_err(),
        "a read of the worker rows was answered before the restart settled them"
    );
    drop(release);
    let rows = mixdog_rt::time::timeout(Duration::from_secs(60), &mut read)
        .await
        .expect("the read was not answered once the projection ended")
        .expect("the settlement's result");
    assert!(rows.is_empty(), "{rows:?}");
    assert!(!index.owes_projection(), "the read was answered with rows still owed");
    mixdog_rt::time::timeout(Duration::from_secs(30), core.stop("owed rows start test")).await.expect("core shutdown did not complete within 30 seconds");
}
