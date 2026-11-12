//! memory-query-handlers: the `memory/recall` request's paging, enrichment and duplicate collapse.
//!
//! Each recorded request goes to `Recall::recall` over a private cluster holding the case's rows (module `pg`); the
//! returned text and the searches are compared whole. Case 0's 600 rows are the recorder's `fixture()`
//! (`record-memory-query-handlers.mjs`: the recording holds their count only), rebuilt by the same formula; cases 1
//! and 2 record their two rows. As the recording replaces `searchRelevantHybrid` with the fixture's scripted search,
//! the replay puts the same script in the hybrid search's place (`recall::SEARCH_SEAM`, test builds only): it returns
//! the stored rows (read back through the core's row decoder) with the recorded annotations (`retrievalScore`, `rrf`,
//! `_retrievalEvidence`), and logs each call's query and options in Node's shape (`options_seen`). Every other
//! statement runs on the database, which answers the browse as the scripted `db.query` does and holds no core
//! entries (Node's scripted answer to that statement is empty). The statements the recall sends, observed at its send
//! point (`recall::store`, test builds), are compared with the recorded `db.query` calls: text and params, in order.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, same, string};

const SET: &str = "memory-query-handlers";

#[test]
fn the_recording_has_three_cases() {
    assert_case_count(&golden(SET), 3);
}

/// The recorder's `fixture(count)` rows at the recorded clock.
fn fixture(count: i64, now_ms: i64) -> Vec<Exact> {
    (0..count)
        .map(|i| {
            let marker = format!("MARKER_{:04} needle", i + 1);
            object(vec![
                ("id", int(i + 1)),
                ("ts", int(now_ms - i * 1000)),
                ("is_root", int(1)),
                ("chunk_root", int(i + 1)),
                ("role", string("user")),
                ("project_id", Exact::Null),
                ("session_id", string("test-session")),
                ("category", string("fact")),
                ("status", string("pending")),
                ("element", string(format!("item-{}", i + 1))),
                ("summary", string(marker.as_str())),
                ("content", string(marker)),
                ("duplicate_of", Exact::Null),
                ("retrievalScore", int(1)),
                ("rrf", int(1)),
                ("_retrievalEvidence", string("lexical")),
            ])
        })
        .collect()
}

/// Which rows the recorder's scripted search returns.
#[derive(Clone, Copy)]
enum Script {
    /// `rows.slice(0, options.limit)` (`fixture().db.search`).
    FirstByLimit,
    /// `[rows[options.rootOnly ? 1 : 0]]` (the alias and time cases).
    RootOnlyPicksSecond,
}

mod pg {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;
    use crate::memory::recall::hybrid::SearchOptions;
    use crate::memory::recall::row::Row;
    use crate::memory::recall::SEARCH_SEAM;
    use crate::memory::replays::pg::{insert_entries, memory_db, param, read_path, recall};

    const ANNOTATIONS: [&str; 3] = ["retrievalScore", "rrf", "_retrievalEvidence"];

    fn evidence(name: &str) -> &'static str {
        match name {
            "lexical" => "lexical",
            "semantic" => "semantic",
            "hybrid" => "hybrid",
            other => panic!("unrecorded retrieval evidence {other}"),
        }
    }

    /// The options the search received, in the shape Node's log holds them: `queryVector` null when absent,
    /// `category` undefined when empty, `rootOnly` only when set (the historical search's spread adds it).
    fn options_seen(options: &SearchOptions) -> Exact {
        let mut fields = vec![
            ("limit", int(options.limit.expect("a limit") as i64)),
            (
                "queryVector",
                options.query_vector.as_ref().map_or(Exact::Null, |v| Exact::Array(v.iter().map(|n| Exact::Number(f64::from(*n))).collect())),
            ),
            ("includeMembers", Exact::Bool(options.include_members)),
            ("ts_from", options.ts_from.map_or(Exact::Undefined, int)),
            ("ts_to", options.ts_to.map_or(Exact::Undefined, int)),
            ("projectScope", options.project_scope.clone().map_or(Exact::Undefined, string)),
            (
                "category",
                if options.category.is_empty() { Exact::Undefined } else { Exact::Array(options.category.iter().cloned().map(string).collect()) },
            ),
            ("excludeStatuses", Exact::Array(options.exclude_statuses.iter().cloned().map(string).collect())),
            ("latestByConcept", Exact::Bool(options.latest_by_concept)),
        ];
        if options.root_only {
            fields.push(("rootOnly", Exact::Bool(true)));
        }
        object(fields)
    }

    async fn steps(name: &str, rows: &[Exact], steps: &[Exact], now_ms: i64, script: Script) {
        let pg = memory_db().await;
        let columns: Vec<Exact> = rows
            .iter()
            .map(|row| Exact::Object(row.entries().iter().filter(|(k, _)| !ANNOTATIONS.contains(&k.as_str())).cloned().collect()))
            .collect();
        insert_entries(&pg.db, &columns.iter().collect::<Vec<_>>()).await;
        let stored = pg
            .db
            .query(&format!("SELECT {}, duplicate_of FROM entries ORDER BY id", crate::memory::recall::hybrid::ENTRY_ROW_COLUMNS), &[])
            .await
            .expect("stored rows");
        let scripted: Vec<Row> = stored
            .iter()
            .zip(rows)
            .map(|(pg_row, recorded)| {
                let mut row = Row::from_pg(pg_row);
                row.retrieval_score = Some(recorded.get("retrievalScore").as_f64());
                row.rrf = Some(recorded.get("rrf").as_f64());
                row.retrieval_evidence = Some(evidence(recorded.get("_retrievalEvidence").as_str()));
                row
            })
            .collect();
        assert_eq!(scripted.len(), rows.len(), "{name}: stored rows");
        let searches: Rc<RefCell<Vec<Exact>>> = Rc::default();
        let log = searches.clone();
        SEARCH_SEAM.with(|s| {
            *s.borrow_mut() = Some(Rc::new(move |query: &str, options: &SearchOptions| {
                log.borrow_mut().push(object(vec![("query", string(query)), ("options", options_seen(options))]));
                match script {
                    Script::FirstByLimit => scripted.iter().take(options.limit.expect("a limit")).cloned().collect(),
                    Script::RootOnlyPicksSecond => vec![scripted[usize::from(options.root_only)].clone()],
                }
            }))
        });
        let recall = recall(&pg.db, now_ms);
        for (at, step) in steps.iter().enumerate() {
            let args = step.get("args").to_plain().expect("JSON args");
            let what = format!("{name}: step {at} {args}");
            searches.borrow_mut().clear();
            let (outcome, statements, _) = read_path(tokio::time::timeout(std::time::Duration::from_secs(60), recall.recall_cancellable(&args, &tokio_util::sync::CancellationToken::new()))).await;
            let outcome = outcome.unwrap_or_else(|_| panic!("{what}: did not settle within 60 s"));
            same(&format!("{what}: searches"), step.get("searches"), &Exact::Array(searches.borrow().clone()));
            let sent = Exact::Array(
                statements
                    .iter()
                    .map(|(sql, params)| object(vec![("sql", string(sql.clone())), ("params", Exact::Array(params.iter().map(param).collect()))]))
                    .collect(),
            );
            same(&format!("{what}: statements"), step.get("statements"), &sent);
            same(&what, step.get("result"), &object(vec![("text", string(outcome.text))]));
        }
        SEARCH_SEAM.with(|s| *s.borrow_mut() = None);
    }

    fn now_ms(g: &Exact) -> i64 {
        g.get("clock").get("dateNowMs").as_f64() as i64
    }

    #[tokio::test(flavor = "current_thread")]
    async fn public_recall_preserves_every_supported_page_boundary_including_the_last_offset() {
        let g = golden(SET);
        let name = "public recall preserves every supported page boundary, including the last offset";
        let c = case(&g, 0, name);
        let rows = fixture(c.get("rows").as_f64() as i64, now_ms(&g));
        steps(name, &rows, c.get("steps").as_array(), now_ms(&g), Script::FirstByLimit).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn public_historical_enrichment_cannot_reintroduce_an_alias_beside_its_representative() {
        let g = golden(SET);
        let name = "public historical enrichment cannot reintroduce an alias beside its representative";
        let c = case(&g, 1, name);
        steps(name, c.get("rows").as_array(), std::slice::from_ref(c.get("step")), now_ms(&g), Script::RootOnlyPicksSecond).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn public_enrichment_filters_time_before_duplicate_grouping() {
        let g = golden(SET);
        let name = "public enrichment filters time before duplicate grouping";
        let c = case(&g, 2, name);
        steps(name, c.get("rows").as_array(), std::slice::from_ref(c.get("step")), now_ms(&g), Script::RootOnlyPicksSecond).await;
    }
}
