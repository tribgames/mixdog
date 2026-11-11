//! memory-hybrid-sql-exact: the exact-term leg of the hybrid candidate statement on a private cluster.
//!
//! The rows are inserted in the recorded order with the recorded ids and the recording's `database` columns
//! (`last_seen_at` = `ts`, as the recorder writes them), each scored as the schema's trigger scored it, at the clock
//! it read then (`scoredAtMs`); each probe runs after the rows the recorder had inserted
//! before it (`record-memory-hybrid-sql-exact.mjs`: 4, 7, 9, 11, 13 and 15 rows). A probe is the public
//! `search_relevant_hybrid` with no options (Node's `recallPlan(query)` defaults). Compared per probe: the exact terms
//! (`build_exact_terms`), the candidate statement the search sends at its send point (`recall::store::read_query_pg`,
//! observed in test builds): its text byte for byte and its parameters, and the rows PostgreSQL answered it with
//! (`recall::store::ANSWERS`, as node-pg gives them) whole and in the returned order; and the cluster's ctype probe.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, same, string};

const SET: &str = "memory-hybrid-sql-exact";
const ROWS_BEFORE_PROBE: [usize; 6] = [4, 7, 9, 11, 13, 15];

#[test]
fn the_recording_has_one_case() {
    assert_case_count(&golden(SET), 1);
}

mod pg {
    use super::*;
    use crate::memory::recall::hybrid::{SearchOptions, build_exact_terms, search_relevant_hybrid};
    use crate::memory::replays::pg::{insert_entries, memory_db, param, read_path};

    #[tokio::test(flavor = "current_thread")]
    async fn the_exact_term_recall_leg_matches_literal_substrings_case_insensitively() {
        let g = golden(SET);
        let name = "the exact-term recall leg matches literal substrings case-insensitively (test line 9)";
        let c = case(&g, 0, name);
        let database = g.get("database");
        let rows: Vec<Exact> = c
            .get("rows")
            .as_array()
            .iter()
            .map(|row| {
                let mut entries: Vec<(String, Exact)> =
                    row.entries().iter().filter(|(k, _)| k != "label" && k != "scoredAtMs").cloned().collect();
                for key in ["role", "session_id", "project_id", "is_root", "category", "status"] {
                    entries.push((key.into(), database.get(key).clone()));
                }
                entries.push(("last_seen_at".into(), row.get("ts").clone()));
                Exact::Object(entries)
            })
            .collect();
        let queries = c.get("queries").as_array();
        assert_eq!(queries.len(), ROWS_BEFORE_PROBE.len(), "{name}: probes");
        assert_eq!(rows.len(), ROWS_BEFORE_PROBE[5], "{name}: rows");

        let pg = memory_db().await;
        let folds = pg.db.query("SELECT 'DER ÄRGER' ILIKE '%ärger%' AS folds", &[]).await.expect("ctype probe");
        same(
            &format!("{name}: ctype"),
            g.get("ctype").get("ilikeFoldsNonAscii"),
            &Exact::Bool(folds[0].get::<_, bool>("folds")),
        );
        let mut inserted = 0;
        for (query, before) in queries.iter().zip(ROWS_BEFORE_PROBE) {
            let batch: Vec<&Exact> = rows[inserted..before].iter().collect();
            insert_entries(&pg.db, &batch).await;
            // The score trigger's expression (`compute_entry_score(category, COALESCE(last_seen_at, ts), now)`) at the
            // clock it read when the recorder inserted the row.
            for recorded in &c.get("rows").as_array()[inserted..before] {
                let (id, at) = (recorded.get("id").as_f64() as i64, recorded.get("scoredAtMs").as_f64() as i64);
                pg.db
                    .execute(
                        "UPDATE entries SET score = compute_entry_score(category, COALESCE(last_seen_at, ts), $2) WHERE id = $1",
                        &[&id, &at],
                    )
                    .await
                    .unwrap_or_else(|e| panic!("{name}: scoring row {id}: {}", e.message()));
            }
            inserted = before;
            let text = query.get("query").as_str();
            let what = format!("{name}: {text}");
            same(&format!("{what}: exact terms"), query.get("exactTerms"), &Exact::Array(build_exact_terms(text).into_iter().map(string).collect()));
            let options = SearchOptions::default();
            let search = tokio::time::timeout(std::time::Duration::from_secs(60), search_relevant_hybrid(&pg.db, text, &options));
            let (searched, statements, answers) = read_path(search).await;
            searched
                .unwrap_or_else(|_| panic!("{what}: the search did not settle within 60 s"))
                .unwrap_or_else(|e| panic!("{what}: {}", e.message()));
            // The search's first read is the candidate statement, after the read path's `SET LOCAL` in the same
            // transaction (Node's `recallReadQuery`, memory-recall-read-query.mjs:4, sends it too; the recorder ran the
            // statement alone, so only the candidate statement has a recorded counterpart).
            assert!(statements.len() >= 2, "{what}: the search sent no candidate statement: {statements:?}");
            let (sql, params) = &statements[1];
            same(&format!("{what}: sql"), query.get("sql"), &string(sql.clone()));
            same(&format!("{what}: params"), query.get("params"), &Exact::Array(params.iter().map(param).collect()));
            let order_by = regex::Regex::new(r"FROM combined c[\s\S]*ORDER BY").expect("pattern").is_match(sql);
            same(&format!("{what}: finalStatementHasOrderBy"), query.get("finalStatementHasOrderBy"), &Exact::Bool(order_by));
            same(&format!("{what}: returned"), query.get("returned"), &Exact::Array(answers[0].clone()));
        }
    }
}
