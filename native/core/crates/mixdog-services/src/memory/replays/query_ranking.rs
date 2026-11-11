//! memory-query-ranking: the row steps of `Recall::recall` in memory/recall/ranking.rs (`rank_latest_rows`,
//! `merge_historical_rows`, `bound_rows_to_temporal`, `topic_term_coverage`), memory/recall/row.rs
//! `unique_rows_by_id` and memory/recall/format.rs `interleave_raw_rows` (the core-row interleave Node's
//! `interleaveRawRows` is; recall/mod.rs:392). Rows are compared whole, in returned order.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, rows, row, same, same_rows};
use crate::memory::recall::format::interleave_raw_rows;
use crate::memory::recall::period::Window;
use crate::memory::recall::ranking::{bound_rows_to_temporal, merge_historical_rows, rank_latest_rows, topic_term_coverage};
use crate::memory::recall::row::{RowKey, unique_rows_by_id};

const SET: &str = "memory-query-ranking";

/// A recorded row as Node holds it: its id keyed by `String(row?.id ?? '')`.
struct Wire(Exact);

impl RowKey for Wire {
    fn unique_key(&self) -> Option<String> {
        let key = match self.0.try_get("id") {
            None | Some(Exact::Null | Exact::Undefined) => String::new(),
            Some(Exact::String(text)) => text.clone(),
            Some(Exact::Number(n)) => mixdog_js::number_to_string(*n),
            Some(other) => panic!("row id of a shape the recording does not hold: {other:?}"),
        };
        (!key.is_empty()).then_some(key)
    }
}

fn typed(value: &Exact) -> Vec<crate::memory::recall::row::Row> {
    rows(value).unwrap_or_else(|e| panic!("recorded rows: {e}"))
}

#[test]
fn the_recording_has_five_cases() {
    assert_case_count(&golden(SET), 5);
}

#[test]
fn latest_recall_ranks_the_newest_topic_covered_evidence_and_demotes_query_echo() {
    let name = "latest recall ranks the newest topic-covered evidence and demotes query echo";
    let golden = golden(SET);
    for probe in case(&golden, 0, name).get("probes").as_array() {
        let input = probe.get("input");
        let ranked = rank_latest_rows(typed(input.get("rows")), input.get("query").as_str());
        same_rows(&format!("{name}: {}", probe.get("label").as_str()), probe.get("result"), &ranked);
    }
}

#[test]
fn historical_merge_reserves_novel_root_evidence_without_replacing_the_best_hit() {
    let name = "historical merge reserves novel root evidence without replacing the best hit";
    let golden = golden(SET);
    for probe in case(&golden, 1, name).get("probes").as_array() {
        let input = probe.get("input");
        // Node's defaults: `{ includeMatchedRootSummary = false, rootReserve = 1 } = {}`.
        let (include, reserve) = match input.get("options") {
            Exact::Undefined => (false, 1),
            options => (
                options.try_get("includeMatchedRootSummary").is_some_and(Exact::as_bool),
                options.try_get("rootReserve").map_or(1, |r| r.as_f64() as usize),
            ),
        };
        let merged = merge_historical_rows(
            typed(input.get("primary")),
            &typed(input.get("roots")),
            input.get("limit").as_f64() as usize,
            include,
            reserve,
        );
        same_rows(&format!("{name}: {}", probe.get("label").as_str()), probe.get("result"), &merged);
    }
}

#[test]
fn temporal_bounding_keeps_an_out_of_window_root_when_an_in_window_member_matched() {
    let name = "temporal bounding keeps an out-of-window root when an in-window member matched";
    let golden = golden(SET);
    for probe in case(&golden, 2, name).get("probes").as_array() {
        let input = probe.get("input");
        let window = match input.get("window") {
            Exact::Null => None,
            w => Some(Window {
                start_ms: w.try_get("startMs").map(|v| v.as_f64() as i64),
                end_ms: w.try_get("endMs").map(|v| v.as_f64() as i64),
                exact: false,
            }),
        };
        let bounded = bound_rows_to_temporal(typed(input.get("rows")), window.as_ref());
        same_rows(&format!("{name}: {}", probe.get("label").as_str()), probe.get("result"), &bounded);
    }
}

#[test]
fn core_memory_interleave_preserves_the_leading_hybrid_result() {
    let name = "core memory interleave preserves the leading hybrid result";
    let golden = golden(SET);
    for (i, probe) in case(&golden, 3, name).get("probes").as_array().iter().enumerate() {
        let input = probe.get("input");
        let merged = interleave_raw_rows(typed(input.get("hybrid")), typed(input.get("core")));
        same_rows(&format!("{name}: probe {i}"), probe.get("result"), &merged);
    }
}

#[test]
fn unique_rows_by_id_keeps_first_seen_order_and_topic_term_coverage_counts_member_text() {
    let name = "uniqueRowsById keeps first-seen order and topicTermCoverage counts member text";
    let golden = golden(SET);
    let case = case(&golden, 4, name);
    for probe in case.get("unique").as_array() {
        let label = probe.get("label").as_str();
        match rows(probe.get("input")) {
            Ok(input) => same_rows(&format!("{name}: unique {label}"), probe.get("result"), &unique_rows_by_id(input)),
            // An empty, null or string id has no typed row (entries ids are bigint): the same function runs over the
            // rows with Node's values, keyed as Node keys them.
            Err(_) => {
                let input = probe.get("input").as_array().iter().cloned().map(Wire);
                let kept = Exact::Array(unique_rows_by_id(input).into_iter().map(|w| w.0).collect());
                same(&format!("{name}: unique {label}"), probe.get("result"), &kept);
            }
        }
    }
    for probe in case.get("coverage").as_array() {
        let input = probe.get("input");
        let terms: Vec<String> = input.get("terms").as_array().iter().map(|t| t.as_str().to_owned()).collect();
        let row = row(input.get("row")).expect("typed row");
        same(
            &format!("{name}: coverage {}", probe.get("label").as_str()),
            probe.get("result"),
            &int(topic_term_coverage(&row, &terms) as i64),
        );
    }
}
