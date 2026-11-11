//! `memory-history-duplicates` (Node `history-duplicates.test.mjs`).
//!
//! The recorded calls are Node's `retrieveEntries`, `searchRelevantHybrid`, `collapseHistoryDuplicates`,
//! `buildRecallScopeFilter`, `makeChunkQuality` / `assessChunkQuality` and `preferLatestConceptRows`; the replay calls
//! their public core counterparts (`recall::browse::retrieve_entries`, `recall::hybrid::search_relevant_hybrid`,
//! `recall::ranking::collapse_history_duplicates`, `recall::filters::scope_filter`, `cycles::quality::*`,
//! `recall::hybrid::prefer_latest_concept_rows`), which the `memory/recall` request reaches.
//!
//! Database: a private cluster (module `pg`) with the memory schema, holding the test file's fixture rows (case 0's
//! recorded `before`). The test file's table has no `NOT NULL` on `role`, `content`, `source_ref` and its rows carry
//! NULL there, so those constraints are dropped on the private table; every other column, key and `ON DELETE` rule is
//! the core's. Node's stand-in answered the hybrid candidate statement with every root row by id (`sparse_rank` =
//! position, `sparse_lex` = 1) instead of running it; the replay answers the core's candidate statement the same way
//! (`hybrid::CANDIDATE_ANSWER`, test builds) with those rows read from the private table, and every other statement
//! runs on PostgreSQL. Compared per step: the result rows whole and in order, and the statements sent in order with
//! their params (`recall::store::STATEMENTS`, test builds).

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, row, same, same_rows};
use crate::memory::recall::hybrid::prefer_latest_concept_rows;

const SET: &str = "memory-history-duplicates";

#[test]
fn the_recording_has_ten_cases() {
    assert_case_count(&golden(SET), 10);
}

#[test]
fn previously_stored_lineage_still_selects_the_newer_conclusion_without_a_reviewer() {
    let g = golden(SET);
    let name = "previously stored lineage still selects the newer conclusion without a reviewer (test line 256)";
    let c = case(&g, 9, name);
    let probes = c.get("probes").as_array();
    let old_value = probes[0].get("old");
    let old = row(old_value).expect("old row");
    let latest = row(probes[0].get("latest")).expect("latest row");
    let with_correction = prefer_latest_concept_rows(std::slice::from_ref(&old), std::slice::from_ref(&latest));
    same_rows(&format!("{name}: {}", probes[0].get("label").as_str()), probes[0].get("result"), &with_correction);
    let without = prefer_latest_concept_rows(std::slice::from_ref(&old), &[]);
    same_rows(&format!("{name}: {}", probes[1].get("label").as_str()), probes[1].get("result"), &without);
    let unchanged = format!("{:?}", row(old_value).expect("old row")) == format!("{old:?}");
    same(&format!("{name}: oldUnchanged"), c.get("oldUnchanged"), &Exact::Bool(unchanged));
}

mod pg {
    use std::future::Future;
    use std::time::Duration;

    use tokio_postgres::types::ToSql;

    use super::*;
    use crate::memory::replays::{int, object, string};
    use crate::memory::cycles::quality::{Row as QRow, assess_chunk_quality, make_chunk_quality};
    use crate::memory::pg::db::Db;
    use crate::memory::recall::browse::{EntryFilters, retrieve_entries};
    use crate::memory::recall::filters::{ScopeOptions, scope_filter};
    use crate::memory::recall::hybrid::{CANDIDATE_ANSWER, SearchOptions, search_relevant_hybrid};
    use crate::memory::recall::ranking::collapse_history_duplicates;
    use crate::memory::recall::row::{P, Row, refs};
    use crate::memory::recall::store::STATEMENTS;
    use crate::memory::replays::chunk_quality_handoff::assessment_value;
    use crate::memory::replays::pg::{ReplayPg, memory_db};

    const CASE_DEADLINE: Duration = Duration::from_secs(300);
    /// The test file's table, in its column order (`SELECT *`).
    const COLUMNS: &str = "id, ts, project_id, summary, content, element, is_root, chunk_root, status, concept_id, supersedes_id,
        role, source_ref, session_id, source_turn, time_source, category, score, last_seen_at, duplicate_of, chunk_quality";

    async fn within<T>(name: &str, work: impl Future<Output = T>) -> T {
        tokio::time::timeout(CASE_DEADLINE, work)
            .await
            .unwrap_or_else(|_| panic!("{name}: the case did not finish within {CASE_DEADLINE:?}"))
    }

    fn param(p: &P) -> Exact {
        match p {
            P::I(n) => int(*n),
            P::I2(n) => int(i64::from(*n)),
            P::I4(n) => int(i64::from(*n)),
            P::T(text) => string(text.clone()),
            P::TA(list) => Exact::Array(list.iter().cloned().map(Exact::String).collect()),
            P::IA(list) => Exact::Array(list.iter().map(|n| int(*n)).collect()),
            P::J(value) => Exact::plain(value),
            P::Null => Exact::Null,
            P::Lit(text) => string(text.clone()),
        }
    }

    fn statement_values(log: &[(String, Vec<P>)]) -> Exact {
        Exact::Array(
            log.iter()
                .map(|(sql, params)| object(vec![("sql", string(sql.clone())), ("params", Exact::Array(params.iter().map(param).collect()))]))
                .collect(),
        )
    }

    async fn exec(db: &Db, sql: &str, params: &[&(dyn ToSql + Sync)]) {
        db.execute(sql, params).await.unwrap_or_else(|e| panic!("{sql}: {}", e.message()));
    }

    fn text(row: &Exact, key: &str) -> Option<String> {
        match row.get(key) {
            Exact::String(s) => Some(s.clone()),
            Exact::Null | Exact::Undefined => None,
            other => panic!("{key}: {other:?}"),
        }
    }

    fn number(row: &Exact, key: &str) -> Option<i64> {
        match row.get(key) {
            Exact::Number(n) => Some(*n as i64),
            Exact::Null | Exact::Undefined => None,
            other => panic!("{key}: {other:?}"),
        }
    }

    /// The private cluster holding the test file's fixture rows (case 0's recorded `before`), links set after every
    /// row exists as the fixture's `UPDATE` does.
    async fn fixture(g: &Exact) -> ReplayPg {
        let pg = memory_db().await;
        exec(
            &pg.db,
            "ALTER TABLE entries ALTER COLUMN role DROP NOT NULL, ALTER COLUMN content DROP NOT NULL,
               ALTER COLUMN source_ref DROP NOT NULL",
            &[],
        )
        .await;
        let seed = case(g, 0, "records of every status are searchable and stored aliases stay read-only (test line 76)").get("before");
        for r in seed.as_array() {
            let (id, ts, is_root) = (number(r, "id"), number(r, "ts"), number(r, "is_root").map(|v| v as i16));
            let (project, summary, content, element, status) =
                (text(r, "project_id"), text(r, "summary"), text(r, "content"), text(r, "element"), text(r, "status"));
            exec(
                &pg.db,
                "INSERT INTO entries (id, ts, project_id, summary, content, element, is_root, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::entry_status)",
                &[&id, &ts, &project, &summary, &content, &element, &is_root, &status],
            )
            .await;
        }
        for r in seed.as_array() {
            let (id, chunk_root, duplicate_of) = (number(r, "id"), number(r, "chunk_root"), number(r, "duplicate_of"));
            exec(&pg.db, "UPDATE entries SET chunk_root = $2, duplicate_of = $3 WHERE id = $1", &[&id, &chunk_root, &duplicate_of]).await;
        }
        pg
    }

    async fn table(db: &Db) -> Vec<Row> {
        let sql = format!("SELECT {COLUMNS} FROM entries ORDER BY id");
        db.query(&sql, &[]).await.unwrap_or_else(|e| panic!("table: {}", e.message())).iter().map(Row::from_pg).collect()
    }

    fn ids(rows: &[Row]) -> Exact {
        Exact::Array(rows.iter().map(|r| int(r.id)).collect())
    }

    /// Runs `work` with the statement log on; the statements it sent.
    async fn logged<T>(work: impl Future<Output = T>) -> (T, Vec<(String, Vec<P>)>) {
        STATEMENTS.with(|log| *log.borrow_mut() = Some(Vec::new()));
        let out = work.await;
        let log = STATEMENTS.with(|log| log.borrow_mut().take()).expect("statement log");
        (out, log)
    }

    fn compare_call(what: &str, step: &Exact, rows: &[Row], statements: &[(String, Vec<P>)]) {
        let result = step.get("result");
        same_rows(&format!("{what}: rows"), result.get("rows"), rows);
        same(&format!("{what}: ids"), result.get("ids"), &ids(rows));
        let (recorded, sent) = (step.get("statements").as_array(), statement_values(statements));
        for (i, (node, rust)) in recorded.iter().zip(sent.as_array()).enumerate() {
            same(&format!("{what}: statement {i} of {}", step.get("label").as_str()), node, rust);
        }
        same(&format!("{what}: statements of {}", step.get("label").as_str()), step.get("statements"), &sent);
    }

    fn step<'a>(c: &'a Exact, index: usize, label: &str) -> &'a Exact {
        let step = &c.get("steps").as_array()[index];
        assert_eq!(step.get("label").as_str(), label, "step {index}");
        step
    }

    async fn retrieve(db: &Db, what: &str, step: &Exact, filters: EntryFilters) {
        let (rows, statements) = logged(retrieve_entries(db, &filters)).await;
        let rows = rows.unwrap_or_else(|e| panic!("{what}: {e}"));
        compare_call(what, step, &rows, &statements);
    }

    async fn hybrid(db: &Db, what: &str, step: &Exact, query: &str, options: SearchOptions) -> (Vec<Row>, Vec<(String, Vec<P>)>) {
        // Node's stand-in: every root row by id, `sparse_rank` its position, `sparse_lex` 1.
        let sql = format!("SELECT {COLUMNS} FROM entries WHERE is_root = 1 ORDER BY id");
        let answer: Vec<Row> = db
            .query(&sql, &[])
            .await
            .unwrap_or_else(|e| panic!("{what}: candidate answer: {}", e.message()))
            .iter()
            .enumerate()
            .map(|(i, r)| Row { sparse_rank: Some(i as i64 + 1), sparse_lex: Some(1.0), ..Row::from_pg(r) })
            .collect();
        CANDIDATE_ANSWER.with(|a| *a.borrow_mut() = Some(answer));
        let (rows, statements) = logged(search_relevant_hybrid(db, query, &options)).await;
        assert!(CANDIDATE_ANSWER.with(|a| a.borrow().is_none()), "{what}: the search sent no candidate statement");
        let rows = rows.unwrap_or_else(|e| panic!("{what}: {e}"));
        compare_call(what, step, &rows, &statements);
        (rows, statements)
    }

    fn project_date() -> EntryFilters {
        EntryFilters { project_scope: Some("project".into()), sort: Some("date".into()), ..EntryFilters::default() }
    }

    fn all(limit: Option<usize>) -> EntryFilters {
        EntryFilters { project_scope: Some("all".into()), limit, ..EntryFilters::default() }
    }

    fn search(scope: &str, limit: Option<usize>, ts_to: Option<i64>) -> SearchOptions {
        SearchOptions { project_scope: Some(scope.into()), limit, ts_to, ..SearchOptions::default() }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn records_of_every_status_are_searchable_and_stored_aliases_stay_read_only() {
        let g = golden(SET);
        let name = "records of every status are searchable and stored aliases stay read-only (test line 76)";
        let c = case(&g, 0, name);
        within(name, async {
            let pg = fixture(&g).await;
            same_rows(&format!("{name}: before"), c.get("before"), &table(&pg.db).await);
            let s = step(c, 0, "scope filter selects every status of the project");
            let (clause, params) =
                scope_filter(1, &ScopeOptions { project_scope: Some("project"), ..ScopeOptions::default() }, "");
            same(
                &format!("{name}: filter"),
                s.get("filter"),
                &object(vec![("clause", string(clause.clone())), ("params", Exact::Array(params.iter().map(param).collect()))]),
            );
            let matched: Vec<Row> = pg
                .db
                .query(&format!("SELECT id FROM entries WHERE 1=1 {clause} ORDER BY id"), &refs(&params))
                .await
                .unwrap_or_else(|e| panic!("{name}: filter query: {}", e.message()))
                .iter()
                .map(Row::from_pg)
                .collect();
            same_rows(&format!("{name}: filter rows"), s.get("rows"), &matched);
            same(&format!("{name}: filter ids"), s.get("ids"), &ids(&matched));
            retrieve(&pg.db, name, step(c, 1, "retrieveEntries project, sort date"), project_date()).await;
            same_rows(&format!("{name}: after"), c.get("after"), &table(&pg.db).await);
        })
        .await;
    }

    async fn reusable_summaries(index: usize, second_session: &str) {
        let g = golden(SET);
        let name = format!("stored aliases keep Cycle 1 summaries reusable ({second_session}) (test line 115)");
        let c = case(&g, index, &name);
        same(&format!("{name}: secondSession"), c.get("secondSession"), &string(second_session));
        let now_ms = g.get("clock").get("dateNowMs").as_f64() as i64;
        within(&name, async {
            let pg = fixture(&g).await;
            let first = "The original request and its exact conditions. ".repeat(20);
            let second = "The same request remains pending, with its conditions. ".repeat(20);
            exec(
                &pg.db,
                "UPDATE entries SET session_id = $1, role = $2, content = $3 WHERE id IN (1, 3)",
                &[&"session-a", &"user", &first],
            )
            .await;
            exec(&pg.db, "UPDATE entries SET session_id = $1, role = $2, content = $3 WHERE id = 2", &[
                &second_session,
                &"assistant",
                &second,
            ])
            .await;
            let rows = table(&pg.db).await;
            let mut assessments = Vec::new();
            for id in [1, 2] {
                let root = rows.iter().find(|r| r.id == id).expect("root");
                let members: Vec<QRow> = rows
                    .iter()
                    .filter(|r| r.chunk_root == Some(id))
                    .map(|r| QRow {
                        id: r.id,
                        ts: r.ts,
                        role: r.role.clone(),
                        content: r.content().to_owned(),
                        session_id: r.session_id.clone(),
                        project_id: r.project_id.clone(),
                        element: r.element.clone(),
                    })
                    .collect();
                let quality = make_chunk_quality(root.summary(), &members, now_ms);
                let assessed = assess_chunk_quality(root.summary(), Some(&quality), &members);
                assessments.push(object(vec![
                    ("root", int(id)),
                    ("memberIds", Exact::Array(members.iter().map(|m| int(m.id)).collect())),
                    ("result", assessment_value(&assessed)),
                ]));
            }
            same(&format!("{name}: assessments"), c.get("assessments"), &Exact::Array(assessments));
            let roots = Exact::Array(table(&pg.db).await.iter().map(|r| r.chunk_root.map_or(Exact::Null, int)).collect());
            same(&format!("{name}: chunkRoots"), c.get("chunkRoots"), &roots);
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stored_aliases_keep_cycle_1_summaries_reusable_session_a() {
        reusable_summaries(1, "session-a").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stored_aliases_keep_cycle_1_summaries_reusable_session_b() {
        reusable_summaries(2, "session-b").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn duplicate_representatives_collapse_only_inside_the_requested_history_window_and_project() {
        let g = golden(SET);
        let name = "duplicate representatives collapse only inside the requested history window and project (test line 150)";
        let c = case(&g, 3, name);
        within(name, async {
            let pg = fixture(&g).await;
            retrieve(&pg.db, name, step(c, 0, "retrieveEntries common"), project_date()).await;
            retrieve(&pg.db, name, step(c, 1, "retrieveEntries ts_to 150"), EntryFilters { ts_to: Some(150), ..project_date() }).await;
            let rows = table(&pg.db).await;
            same(&format!("{name}: content"), step(c, 2, "old row content unchanged").get("content"), &string(rows[0].content()));
            let (old, current) = (rows[0].clone(), rows[1].clone());
            let other = Row { project_id: Some("other".into()), ..current.clone() };
            for (index, label, input) in [
                (3, "collapse [old, current]", vec![old.clone(), current.clone()]),
                (4, "collapse [old]", vec![old.clone()]),
                (5, "collapse [old, current in another project]", vec![old.clone(), other]),
            ] {
                let s = step(c, index, label);
                let out = collapse_history_duplicates(input);
                same_rows(&format!("{name}: {label}"), s.get("rows"), &out);
                same(&format!("{name}: {label} ids"), s.get("ids"), &ids(&out));
            }
            hybrid(&pg.db, name, step(c, 6, "searchRelevantHybrid \"request\""), "request", search("project", None, None)).await;
            hybrid(&pg.db, name, step(c, 7, "searchRelevantHybrid \"request\" ts_to 150"), "request", search("project", None, Some(150)))
                .await;
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deleting_an_old_alias_representative_preserves_the_original_chunks() {
        let g = golden(SET);
        let name = "deleting an old alias representative preserves the original chunks (test line 164)";
        let c = case(&g, 4, name);
        within(name, async {
            let pg = fixture(&g).await;
            exec(&pg.db, "DELETE FROM entries WHERE id = 2", &[]).await;
            let rows = table(&pg.db).await;
            let s = step(c, 0, "after deleting the representative");
            same(&format!("{name}: duplicate_of of row 1"), s.get("duplicateOfOfRow1"), &rows[0].duplicate_of.map_or(Exact::Null, int));
            same(
                &format!("{name}: chunkRoots"),
                s.get("chunkRoots"),
                &Exact::Array(rows.iter().map(|r| r.chunk_root.map_or(Exact::Null, int)).collect()),
            );
            retrieve(&pg.db, name, step(c, 1, "retrieveEntries project, sort date"), project_date()).await;
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn duplicates_do_not_consume_hybrid_output_slots_or_browse_page_offsets() {
        let g = golden(SET);
        let name = "duplicates do not consume hybrid output slots or browse-page offsets (test line 189)";
        let c = case(&g, 5, name);
        within(name, async {
            let pg = fixture(&g).await;
            exec(&pg.db, "UPDATE entries SET score = 5 - id", &[]).await;
            let before = table(&pg.db).await;
            hybrid(&pg.db, name, step(c, 0, "hybrid limit 2"), "request", search("all", Some(2), None)).await;
            hybrid(&pg.db, name, step(c, 1, "hybrid limit 1"), "request", search("all", Some(1), None)).await;
            retrieve(&pg.db, name, step(c, 2, "retrieveEntries limit 2"), all(Some(2))).await;
            for offset in 0..3 {
                let label = format!("retrieveEntries limit 1 offset {offset}");
                retrieve(&pg.db, name, step(c, 3 + offset, &label), EntryFilters { offset, ..all(Some(1)) }).await;
            }
            let after = table(&pg.db).await;
            let unchanged = format!("{before:?}") == format!("{after:?}");
            same(&format!("{name}: rowsUnchanged"), c.get("rowsUnchanged"), &Exact::Bool(unchanged));
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_long_duplicate_prefix_cannot_starve_distinct_results_or_repeat_later_pages() {
        let g = golden(SET);
        let name = "a long duplicate prefix cannot starve distinct results or repeat later pages (test line 208)";
        let c = case(&g, 6, name);
        same(&format!("{name}: inserted"), c.get("insertedAliasIds"), &string("5..30 (duplicate_of 2, ts 50, score 100)"));
        within(name, async {
            let pg = fixture(&g).await;
            exec(&pg.db, "UPDATE entries SET score = 5 - id", &[]).await;
            for id in 5_i64..=30 {
                exec(
                    &pg.db,
                    "INSERT INTO entries (id, ts, project_id, summary, content, is_root, chunk_root, duplicate_of, score)
                     VALUES ($1, 50, 'project', 'Same account', 'Original duplicate source', 1, $1, 2, 100)",
                    &[&id],
                )
                .await;
            }
            retrieve(&pg.db, name, step(c, 0, "retrieveEntries limit 2"), all(Some(2))).await;
            retrieve(&pg.db, name, step(c, 1, "retrieveEntries limit 2 offset 2"), EntryFilters { offset: 2, ..all(Some(2)) }).await;
            hybrid(&pg.db, name, step(c, 2, "hybrid limit 2"), "request", search("all", Some(2), None)).await;
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn paging_keeps_an_alias_whose_representative_is_outside_the_requested_session() {
        let g = golden(SET);
        let name = "paging keeps an alias whose representative is outside the requested session (test line 220)";
        let c = case(&g, 7, name);
        within(name, async {
            let pg = fixture(&g).await;
            exec(&pg.db, "UPDATE entries SET session_id = 'older' WHERE id IN (1, 3)", &[]).await;
            exec(&pg.db, "UPDATE entries SET session_id = 'newer' WHERE id = 2", &[]).await;
            let scope = EntryFilters {
                project_scope: Some("project".into()),
                limit: Some(1),
                session_id: Some("older".into()),
                ..EntryFilters::default()
            };
            retrieve(&pg.db, name, step(c, 0, "retrieveEntries session older limit 1"), scope.clone()).await;
            retrieve(&pg.db, name, step(c, 1, "retrieveEntries session older limit 1 offset 1"), EntryFilters { offset: 1, ..scope }).await;
        })
        .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hybrid_member_expansion_reads_only_selected_distinct_roots() {
        let g = golden(SET);
        let name = "hybrid member expansion reads only selected distinct roots (test line 242)";
        let c = case(&g, 8, name);
        within(name, async {
            let pg = fixture(&g).await;
            exec(
                &pg.db,
                "INSERT INTO entries (id, ts, project_id, content, is_root, chunk_root)
                 VALUES (5, 210, 'project', 'Full selected-member source', 0, 2)",
                &[],
            )
            .await;
            let s = step(c, 0, "hybrid limit 1 includeMembers");
            let options = SearchOptions { include_members: true, ..search("all", Some(1), None) };
            let (rows, statements) = hybrid(&pg.db, name, s, "request", options).await;
            let expanded: Vec<Exact> = statements
                .iter()
                .filter(|(sql, _)| sql.contains("WHERE chunk_root = ANY"))
                .map(|(_, params)| param(&params[0]))
                .collect();
            same(&format!("{name}: expandedRootLists"), c.get("expandedRootLists"), &Exact::Array(expanded));
            let contents: Vec<Exact> =
                rows[0].member_list().iter().map(|m| m.content.clone().map_or(Exact::Null, Exact::String)).collect();
            same(&format!("{name}: memberContents"), s.get("result").get("memberContents"), &Exact::Array(contents));
        })
        .await;
    }
}
