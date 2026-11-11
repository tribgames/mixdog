//! memory-hybrid-sql-exact: the exact-term leg of the hybrid candidate statement on a private cluster.
//!
//! The rows are inserted in the recorded order with the recorded ids and the recording's `database` columns
//! (`last_seen_at` = `ts`, as the recorder writes them); each probe runs after the rows the recorder had inserted
//! before it (`record-memory-hybrid-sql-exact.mjs`: 4, 7, 9, 11, 13 and 15 rows). A probe is the public
//! `search_relevant_hybrid` with no options (Node's `recallPlan(query)` defaults); the candidate rows it read are
//! observed through `hybrid::OBSERVED_CANDIDATES` (test builds only), since the search's result does not carry the
//! lanes. As the manifest states: the exact terms are compared whole (`build_exact_terms`), the candidates with an
//! `exact_rank` as a set keyed by id with their `exact_rank` (Node's final SELECT has no ORDER BY; node-postgres gives
//! BIGINT as text, read here as the integer it writes), and the cluster's ctype probe; Node's SQL text is not compared.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, same, string};

const SET: &str = "memory-hybrid-sql-exact";
const ROWS_BEFORE_PROBE: [usize; 6] = [4, 7, 9, 11, 13, 15];

#[test]
fn the_recording_has_one_case() {
    assert_case_count(&golden(SET), 1);
}

/// A recorded integer column, given as text by node-postgres.
fn pg_int(value: &Exact) -> Exact {
    match value {
        Exact::String(text) => int(text.parse().unwrap_or_else(|_| panic!("not an integer: {text}"))),
        Exact::Number(_) => value.clone(),
        other => panic!("not an integer column: {other:?}"),
    }
}

/// `{id: exact_rank}` pairs, ordered by id.
fn exact_ranked(rows: impl IntoIterator<Item = (Exact, Exact)>) -> Exact {
    let mut pairs: Vec<(Exact, Exact)> = rows.into_iter().collect();
    pairs.sort_by(|a, b| a.0.as_f64().total_cmp(&b.0.as_f64()));
    Exact::Array(pairs.into_iter().map(|(id, rank)| object(vec![("id", id), ("exact_rank", rank)])).collect())
}

mod pg {
    use super::*;
    use crate::memory::recall::hybrid::{OBSERVED_CANDIDATES, SearchOptions, build_exact_terms, search_relevant_hybrid};
    use crate::memory::replays::pg::{insert_entries, memory_db};

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
                    row.entries().iter().filter(|(k, _)| k != "label").cloned().collect();
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
            inserted = before;
            let text = query.get("query").as_str();
            let what = format!("{name}: {text}");
            same(&format!("{what}: exact terms"), query.get("exactTerms"), &Exact::Array(build_exact_terms(text).into_iter().map(string).collect()));
            OBSERVED_CANDIDATES.with(|o| *o.borrow_mut() = Some(Vec::new()));
            let searched = tokio::time::timeout(std::time::Duration::from_secs(60), search_relevant_hybrid(&pg.db, text, &SearchOptions::default()))
                .await
                .unwrap_or_else(|_| panic!("{what}: the search did not settle within 60 s"));
            let observed = OBSERVED_CANDIDATES.with(|o| o.borrow_mut().take()).expect("observed");
            searched.unwrap_or_else(|e| panic!("{what}: {}", e.message()));
            assert_eq!(observed.len(), 1, "{what}: one candidate statement");
            let recorded = exact_ranked(
                query
                    .get("returned")
                    .as_array()
                    .iter()
                    .filter(|r| !matches!(r.get("exact_rank"), Exact::Null))
                    .map(|r| (pg_int(r.get("id")), pg_int(r.get("exact_rank")))),
            );
            let actual = exact_ranked(
                observed[0].iter().filter_map(|r| r.exact_rank.map(|rank| (int(r.id), int(rank)))),
            );
            same(&format!("{what}: exact-ranked candidates"), &recorded, &actual);
        }
    }
}
