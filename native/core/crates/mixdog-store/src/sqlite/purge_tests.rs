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
#[test]
fn a_purge_step_deletes_at_most_step_rows_counting_the_edge_and_catalog_row() {
    for indexed in [STEP_ROWS - 2, STEP_ROWS - 1, STEP_ROWS, STEP_ROWS + 1] {
        let dir = tempfile::tempdir().unwrap();
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
