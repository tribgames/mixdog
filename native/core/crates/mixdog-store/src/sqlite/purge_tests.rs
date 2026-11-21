//! The purge writer's step bound, counted on the real writer.
#![allow(clippy::disallowed_types, reason = "test-only check of the purge writer")]

use super::*;

/// The session's rows in every table a purge deletes from, its fork edge and catalog row
/// included.
fn rows_of(conn: &Connection, session: &str) -> usize {
    let mut total = 0;
    for (table, _) in PURGE_TABLES {
        let sql = format!("SELECT count(*) FROM {table} WHERE session = ?1");
        total += conn.query_row(&sql, [session], |r| r.get::<_, i64>(0)).unwrap();
    }
    total += conn.query_row("SELECT count(*) FROM fork_edges WHERE child = ?1", [session], |r| r.get::<_, i64>(0)).unwrap();
    total += conn.query_row("SELECT count(*) FROM sessions WHERE id = ?1", [session], |r| r.get::<_, i64>(0)).unwrap();
    total as usize
}

/// A deleted fork with 499 to 501 index rows (and its edge and catalog row besides): no
/// purge step deletes more than `STEP_ROWS` rows, and the purge ends with none left.
/// The index sizes around `STEP_ROWS`; each is its own test.
const SIZES: [usize; 4] = [STEP_ROWS - 2, STEP_ROWS - 1, STEP_ROWS, STEP_ROWS + 1];

mixdog_rt::replay_chunks!(SIZE_TESTS, #[test] purge_size; [
    a_purge_step_deletes_at_most_step_rows_counting_the_edge_and_catalog_row_00 = 0,
    a_purge_step_deletes_at_most_step_rows_counting_the_edge_and_catalog_row_01 = 1,
    a_purge_step_deletes_at_most_step_rows_counting_the_edge_and_catalog_row_02 = 2,
    a_purge_step_deletes_at_most_step_rows_counting_the_edge_and_catalog_row_03 = 3,
]);

#[test]
fn every_size_has_its_purge_test() {
    mixdog_rt::testing::assert_chunks_registered(SIZE_TESTS, SIZES.len(), 1);
}

/// The purge that starts a rebuild of a fork's rows from its log keeps the fork's edge: its deleted base is at no step a
/// session nothing forks from, so no purge (a running one, or the next start's) takes the base's log while the fork is
/// rebuilt. The purge of a fork that is gone for good takes the edge, and frees the base.
#[test]
fn the_purge_before_a_rebuild_keeps_the_forks_edge_to_its_deleted_base() {
    let dir = tempfile::tempdir().unwrap();
    drop(open_writer(&dir.path().join("store.sqlite"), Some(&runtime_ddl())).unwrap());
    let mut w = Writer::start(&dir.path().join("store.sqlite")).unwrap();
    w.step_rows = 1;
    let row = |id: &str, deleted: u8| {
        format!(
            "INSERT INTO sessions (id, dirty, status, deleted, log_id, newest_file_no, projected_file_no,
                 projected_offset, projected_ordinal, history_rev, row_count, visible_count, activity,
                 closed, archived, id_key, title_fold, id_fold, summary)
             VALUES ('{id}', 0, 'ok', {deleted}, 'l', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, CAST('{id}' AS BLOB), '', '{id}', '{{}}');"
        )
    };
    w.conn.execute_batch(&format!("{}{} INSERT INTO fork_edges (base, child) VALUES ('b', 'c');", row("b", 1), row("c", 0))).unwrap();
    w.conn.execute("INSERT INTO prompt_history (session, ordinal, key, text) VALUES ('c', 1, 'k', 't')", []).unwrap();
    let purgeable = |w: &Writer| w.conn.query_row(PURGEABLE_SQL, [], |r| r.get::<_, String>(0)).optional().unwrap();
    assert_eq!(purgeable(&w), None);
    for step in 0..10 {
        let done = w.purge_rows("c", true).unwrap();
        assert_eq!(purgeable(&w), None, "step {step}: the base of a fork under rebuild was free to purge");
        if done {
            break;
        }
    }
    assert_eq!(rows_of(&w.conn, "c"), 1, "all of the fork's rows are gone but its edge");
    w.conn.execute_batch(&row("c", 1)).unwrap();
    while !w.purge_rows("c", false).unwrap() {}
    assert_eq!((rows_of(&w.conn, "c"), purgeable(&w).as_deref()), (0, Some("b")));
}

fn purge_size(chunk: usize) {
    for indexed in SIZES[mixdog_rt::testing::chunk_range(SIZES.len(), chunk, 1)].iter().copied() {
        let dir = tempfile::tempdir().unwrap();
        // The writer opens only a built index (an empty file is rebuilt from the logs): build the empty one first.
        drop(open_writer(&dir.path().join("store.sqlite"), Some(&runtime_ddl())).unwrap());
        let mut w = Writer::start(&dir.path().join("store.sqlite")).unwrap();
        w.conn
            .execute_batch(
                "INSERT INTO sessions (id, dirty, status, deleted, log_id, newest_file_no, projected_file_no,
                     projected_offset, projected_ordinal, history_rev, row_count, visible_count, activity,
                     closed, archived, id_key, title_fold, id_fold, summary)
                 VALUES ('c', 0, 'ok', 1, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, x'63', '', 'c', '{}');
                 INSERT INTO fork_edges (base, child) VALUES ('b', 'c');",
            )
            .unwrap();
        // Split over two tables, so steps cross a table boundary.
        for n in 0..indexed {
            let table = if n % 2 == 0 { "prompt_occurrences" } else { "prompt_history" };
            let sql = format!("INSERT INTO {table} (session, ordinal, key, text) VALUES ('c', ?1, ?2, 't')");
            w.conn.execute(&sql, params![n as i64, format!("k{n}")]).unwrap();
        }
        assert_eq!(rows_of(&w.conn, "c"), indexed + 2);
        let (ack, mut done) = oneshot::channel();
        w.purges.push_back(("c".into(), ack));
        let mut steps = 0;
        loop {
            let before = rows_of(&w.conn, "c");
            w.purge_step();
            let deleted = before - rows_of(&w.conn, "c");
            assert!(deleted <= STEP_ROWS, "{indexed} rows: a step deleted {deleted}");
            steps += 1;
            if let Ok(result) = done.try_recv() {
                result.unwrap();
                break;
            }
            assert!(steps < 10, "{indexed} rows: the purge does not end");
        }
        assert_eq!(rows_of(&w.conn, "c"), 0, "{indexed} rows");
        assert!(w.purges.is_empty());
    }
}
