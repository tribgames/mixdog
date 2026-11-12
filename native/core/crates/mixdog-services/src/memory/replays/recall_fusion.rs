//! memory-recall-fusion: the ranking step of `Recall::recall` (memory/recall/ranking.rs): `lane_ranks`,
//! `rrf_score` / `rrf_score_with_k`, `evidence_kind`, `is_semantic_only`, `rank_candidates` /
//! `rank_candidates_with_k`. Rows whose values no PostgreSQL row can carry (string ids and ranks, fractional or
//! missing ids, null rows: the manifest's JS coercion shapes) are reported per case, not replayed.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, object, opt, row, rows, same, string};
use crate::memory::recall::ranking::{
    evidence_kind, is_semantic_only, lane_ranks, rank_candidates, rank_candidates_with_k, rrf_score, rrf_score_with_k,
};

const SET: &str = "memory-recall-fusion";

/// A `rows` probe: lane ranks, RRF at the default and at k = 10, evidence. Returns the probe name when its row
/// is a JS-only shape.
fn row_probe(case_name: &str, probe: &Exact) -> Option<String> {
    let name = probe.get("name").as_str();
    let Ok(row) = row(probe.get("row")) else { return Some(name.to_owned()) };
    let what = |part: &str| format!("{case_name}: {name}: {part}");
    let (dense, lexical) = lane_ranks(&row);
    let ranks = object(vec![("denseRank", opt(dense, int)), ("lexicalRank", opt(lexical, int))]);
    same(&what("laneRanks"), probe.get("laneRanks").get("result"), &ranks);
    same(&what("rrf"), probe.get("rrf").get("result"), &Exact::from(rrf_score(&row)));
    same(&what("rrfK10"), probe.get("rrfK10").get("result"), &Exact::from(rrf_score_with_k(&row, 10.0)));
    same(&what("evidence"), probe.get("evidence").get("result"), &string(evidence_kind(&row)));
    None
}

/// A `ranked` probe: the whole ranked candidates (id, the input row, rrf, retrieval score, evidence) in order.
fn ranked_probe(case_name: &str, probe: &Exact) -> Option<String> {
    let name = probe.get("name").as_str();
    let recorded_rows: &[Exact] = match probe.get("rows") {
        Exact::Null => &[],
        rows => rows.as_array(),
    };
    let typed = rows(&Exact::Array(recorded_rows.to_vec()));
    let Ok(typed) = typed else { return Some(name.to_owned()) };
    if recorded_rows.iter().any(|r| r.try_get("id").is_none()) {
        return Some(name.to_owned());
    }
    let ranked = match probe.get("k") {
        Exact::String(default) if default == "default" => rank_candidates(&typed),
        k => rank_candidates_with_k(&typed, k.as_f64()),
    };
    let actual = Exact::Array(
        ranked
            .iter()
            .map(|r| {
                object(vec![
                    ("id", int(r.id)),
                    ("row", recorded_rows[r.index].clone()),
                    ("rrf", Exact::from(r.rrf)),
                    ("retrievalScore", Exact::from(r.rrf)),
                    ("evidence", string(r.evidence)),
                ])
            })
            .collect(),
    );
    same(&format!("{case_name}: ranked {name}"), probe.get("result"), &actual);
    None
}

#[test]
fn the_recording_has_five_cases() {
    assert_case_count(&golden(SET), 5);
}

#[test]
fn recall_fusion_gives_dense_and_lexical_retrieval_one_equal_rrf_lane_each() {
    let name = "recall fusion gives dense and lexical retrieval one equal RRF lane each";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    assert_eq!(ranked_probe(name, case.get("ranked")), None);
    for probe in case.get("rows").as_array() {
        assert_eq!(row_probe(name, probe), None);
    }
}

#[test]
fn multiple_lexical_candidate_generators_do_not_multiply_lexical_weight() {
    let name = "multiple lexical candidate generators do not multiply lexical weight";
    let golden = golden(SET);
    let case = case(&golden, 1, name);
    for probe in case.get("rows").as_array() {
        assert_eq!(row_probe(name, probe), None);
    }
}

#[test]
fn fixed_rrf_abstains_only_from_invalid_or_non_positive_semantic_evidence() {
    let name = "fixed RRF abstains only from invalid or non-positive semantic evidence";
    let golden = golden(SET);
    let case = case(&golden, 2, name);
    assert_eq!(ranked_probe(name, case.get("ranked")), None);
    for probe in case.get("rows").as_array() {
        assert_eq!(row_probe(name, probe), None);
    }
}

#[test]
fn semantic_only_retrieval_is_explicit_without_changing_rrf_ordering() {
    let name = "semantic-only retrieval is explicit without changing RRF ordering";
    let golden = golden(SET);
    let first = case(&golden, 0, "recall fusion gives dense and lexical retrieval one equal RRF lane each");
    let case = case(&golden, 3, name);
    // The evidence probes name rows the first case's `rows` probes record, as the test file defines them once.
    let named = |probe: &str| -> Exact {
        let probes = first.get("rows").as_array();
        let found = probes.iter().find(|p| p.get("name").as_str() == probe);
        found.unwrap_or_else(|| panic!("no row named {probe}")).get("row").clone()
    };
    for probe in case.get("evidence").as_array() {
        let probe_name = probe.get("name").as_str();
        let row = row(&named(probe_name)).expect("typed row");
        same(&format!("{name}: evidence {probe_name}"), probe.get("evidence").get("result"), &string(evidence_kind(&row)));
    }
    let mut js_only = Vec::new();
    for (i, probe) in case.get("semanticOnly").as_array().iter().enumerate() {
        let typed = match probe.get("rows") {
            Exact::Array(_) => rows(probe.get("rows")),
            other => Err(format!("rows are {other:?}")),
        };
        let Ok(typed) = typed else {
            js_only.push(i);
            continue;
        };
        same(&format!("{name}: semanticOnly {i}"), probe.get("result"), &Exact::Bool(is_semantic_only(&typed)));
    }
    assert_eq!(js_only, [3, 4, 5], "semanticOnly probes whose rows are null, a string or a null row");
}

#[test]
fn further_shapes_beyond_the_test_file() {
    let name = "further shapes (beyond the test file)";
    let golden = golden(SET);
    let case = case(&golden, 4, name);
    let js_rows: Vec<String> = case.get("rows").as_array().iter().filter_map(|p| row_probe(name, p)).collect();
    assert_eq!(js_rows, ["stringRanks", "badRanks", "nanId", "row null", "row undefined"], "JS-only row probes");
    let js_ranked: Vec<String> = case.get("ranked").as_array().iter().filter_map(|p| ranked_probe(name, p)).collect();
    assert_eq!(js_ranked, ["string ids and ranks"], "JS-only ranked probes");
}
