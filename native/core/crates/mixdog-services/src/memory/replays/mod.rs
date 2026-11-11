//! Replays of the Node memory recordings under `native/core/fixtures/memory-*` (values decoded through the shared
//! `mixdog_testkit::Exact`). One test per recorded case; each loads its set's golden and drives the public Rust entry
//! its MANIFEST.json names.

mod light_ko_morph;
mod project_id;
mod query_ranking;
mod recall_fusion;
mod scope_filter;
mod tokenizer;

use mixdog_testkit::Exact;
use std::path::PathBuf;

use crate::memory::recall::row::Row;

pub(crate) fn fixture(set: &str, file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(set).join(file)
}

pub(crate) fn golden(set: &str) -> Exact {
    Exact::load(fixture(set, "golden.json"))
}

/// Recorded case `index`; the name is checked so a reordered recording fails here, not in a comparison.
pub(crate) fn case<'a>(golden: &'a Exact, index: usize, name: &str) -> &'a Exact {
    let cases = golden.get("cases").as_array();
    let case = cases.get(index).unwrap_or_else(|| panic!("the recording has no case {index}"));
    assert_eq!(case.get("name").as_str(), name, "case {index} of the recording");
    case
}

/// The recorded case count, so a case added to the recording without a replay fails.
pub(crate) fn assert_case_count(golden: &Exact, count: usize) {
    assert_eq!(golden.get("cases").as_array().len(), count, "recorded cases");
}

#[track_caller]
pub(crate) fn same(what: &str, expected: &Exact, actual: &Exact) {
    assert!(expected == actual, "{what}\n  Node: {expected:?}\n  Rust: {actual:?}");
}

pub(crate) fn string(value: impl Into<String>) -> Exact {
    Exact::String(value.into())
}

pub(crate) fn object(entries: Vec<(&str, Exact)>) -> Exact {
    Exact::Object(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

pub(crate) fn opt<T>(value: Option<T>, map: impl FnOnce(T) -> Exact) -> Exact {
    value.map_or(Exact::Null, map)
}

pub(crate) fn int(value: i64) -> Exact {
    Exact::from(value as f64)
}

/// A recorded string, `None` for null or undefined, `Err` for any other JS value (a typing shape no Rust caller has).
pub(crate) fn opt_str(value: &Exact) -> Result<Option<&str>, String> {
    match value {
        Exact::String(s) => Ok(Some(s)),
        Exact::Null | Exact::Undefined => Ok(None),
        other => Err(format!("not a string: {other:?}")),
    }
}

fn integer(value: &Exact) -> Result<i64, String> {
    match value {
        Exact::Number(n) if n.fract() == 0.0 => Ok(*n as i64),
        other => Err(format!("not an integer: {other:?}")),
    }
}

fn opt_integer(value: &Exact) -> Result<Option<i64>, String> {
    match value {
        Exact::Null | Exact::Undefined => Ok(None),
        other => integer(other).map(Some),
    }
}

fn opt_float(value: &Exact) -> Result<Option<f64>, String> {
    match value {
        Exact::Null | Exact::Undefined => Ok(None),
        Exact::Number(_) | Exact::NaN | Exact::Infinity | Exact::NegInfinity | Exact::NegZero => Ok(Some(value.as_f64())),
        other => Err(format!("not a number: {other:?}")),
    }
}

fn opt_string(value: &Exact) -> Result<Option<String>, String> {
    opt_str(value).map(|s| s.map(str::to_owned))
}

/// A recorded row object as the recall pipeline's typed row. `Err` names the first key whose value no
/// PostgreSQL row can carry (a string id, a fractional rank: JS coercion shapes) or that `Row` does not hold.
pub(crate) fn row(value: &Exact) -> Result<Row, String> {
    let mut row = Row::default();
    let Exact::Object(entries) = value else { return Err(format!("not a row object: {value:?}")) };
    for (key, v) in entries {
        let at = |e: String| format!("{key}: {e}");
        match key.as_str() {
            "id" => match v {
                Exact::String(text) if text.starts_with("core:") => {
                    row.core = true;
                    row.id = -text["core:".len()..].parse::<i64>().map_err(|e| at(e.to_string()))?;
                }
                other => row.id = integer(other).map_err(at)?,
            },
            "ts" => row.ts = integer(v).map_err(at)?,
            "is_root" => row.is_root = integer(v).map_err(at)? as i16,
            "role" => row.role = opt_string(v).map_err(at)?,
            "content" => row.content = opt_string(v).map_err(at)?,
            "source_ref" => row.source_ref = opt_string(v).map_err(at)?,
            "session_id" => row.session_id = opt_string(v).map_err(at)?,
            "time_source" => row.time_source = opt_string(v).map_err(at)?,
            "element" => row.element = opt_string(v).map_err(at)?,
            "category" => row.category = opt_string(v).map_err(at)?,
            "summary" => row.summary = opt_string(v).map_err(at)?,
            "project_id" => row.project_id = opt_string(v).map_err(at)?,
            "status" => row.status = opt_string(v).map_err(at)?,
            "_event_key" => row.event_key = opt_string(v).map_err(at)?,
            "source_turn" => row.source_turn = opt_integer(v).map_err(at)?.map(|t| t as i32),
            "_anchor_order" => row.anchor_order = opt_integer(v).map_err(at)?.map(|t| t as i32),
            "chunk_root" => row.chunk_root = opt_integer(v).map_err(at)?,
            "concept_id" => row.concept_id = opt_integer(v).map_err(at)?,
            "supersedes_id" => row.supersedes_id = opt_integer(v).map_err(at)?,
            "last_seen_at" => row.last_seen_at = opt_integer(v).map_err(at)?,
            "duplicate_of" => row.duplicate_of = opt_integer(v).map_err(at)?,
            "matched_concept_id" => row.matched_concept_id = opt_integer(v).map_err(at)?,
            "dense_rank" => row.dense_rank = opt_integer(v).map_err(at)?,
            "sparse_rank" => row.sparse_rank = opt_integer(v).map_err(at)?,
            "trgm_rank" => row.trgm_rank = opt_integer(v).map_err(at)?,
            "exact_rank" => row.exact_rank = opt_integer(v).map_err(at)?,
            "score" => row.score = opt_float(v).map_err(at)?,
            "dense_sim" => row.dense_sim = opt_float(v).map_err(at)?,
            "sparse_lex" => row.sparse_lex = opt_float(v).map_err(at)?,
            "trg_sim" => row.trg_sim = opt_float(v).map_err(at)?,
            "exact_hits" => row.exact_hits = opt_float(v).map_err(at)?,
            "exact_phrase_hits" => row.exact_phrase_hits = opt_float(v).map_err(at)?,
            "exact_rarity" => row.exact_rarity = opt_float(v).map_err(at)?,
            "rrf" => row.rrf = opt_float(v).map_err(at)?,
            "retrievalScore" => row.retrieval_score = opt_float(v).map_err(at)?,
            "_retrievalEvidence" => {
                row.retrieval_evidence = match opt_str(v).map_err(at)? {
                    None => None,
                    Some("semantic") => Some("semantic"),
                    Some("lexical") => Some("lexical"),
                    Some("none") => Some("none"),
                    Some(other) => return Err(at(format!("evidence {other:?}"))),
                }
            }
            "_historicalRootElement" => row.historical_root_element = opt_string(v).map_err(at)?,
            "_historicalRootSummary" => row.historical_root_summary = opt_string(v).map_err(at)?,
            "chunk_quality" => row.chunk_quality = Some(v.to_plain().map_err(at)?),
            "members" => row.members = Some(rows(v).map_err(at)?),
            other => return Err(format!("no Row field for {other:?}")),
        }
    }
    Ok(row)
}

pub(crate) fn rows(value: &Exact) -> Result<Vec<Row>, String> {
    value.as_array().iter().map(row).collect()
}

/// The fields a Rust row holds, under Node's keys: `id`, `ts`, `is_root`, and the `Option` fields that are set.
fn row_fields(row: &Row) -> Vec<(&'static str, Exact)> {
    let mut out: Vec<(&'static str, Exact)> = Vec::new();
    let s = |v: &Option<String>| v.clone().map(Exact::String);
    let i = |v: Option<i64>| v.map(int);
    let f = |v: Option<f64>| v.map(Exact::from);
    out.push(("id", if row.core { string(row.display_id()) } else { int(row.id) }));
    out.push(("ts", int(row.ts)));
    out.push(("is_root", int(i64::from(row.is_root))));
    let optional: Vec<(&'static str, Option<Exact>)> = vec![
        ("role", s(&row.role)),
        ("content", s(&row.content)),
        ("source_ref", s(&row.source_ref)),
        ("session_id", s(&row.session_id)),
        ("source_turn", i(row.source_turn.map(i64::from))),
        ("time_source", s(&row.time_source)),
        ("chunk_root", i(row.chunk_root)),
        ("concept_id", i(row.concept_id)),
        ("supersedes_id", i(row.supersedes_id)),
        ("element", s(&row.element)),
        ("category", s(&row.category)),
        ("summary", s(&row.summary)),
        ("project_id", s(&row.project_id)),
        ("status", s(&row.status)),
        ("score", f(row.score)),
        ("last_seen_at", i(row.last_seen_at)),
        ("duplicate_of", i(row.duplicate_of)),
        ("chunk_quality", row.chunk_quality.as_ref().map(Exact::plain)),
        ("matched_concept_id", i(row.matched_concept_id)),
        ("_anchor_order", i(row.anchor_order.map(i64::from))),
        ("_event_key", s(&row.event_key)),
        ("dense_sim", f(row.dense_sim)),
        ("dense_rank", i(row.dense_rank)),
        ("sparse_lex", f(row.sparse_lex)),
        ("sparse_rank", i(row.sparse_rank)),
        ("trg_sim", f(row.trg_sim)),
        ("trgm_rank", i(row.trgm_rank)),
        ("exact_hits", f(row.exact_hits)),
        ("exact_phrase_hits", f(row.exact_phrase_hits)),
        ("exact_rarity", f(row.exact_rarity)),
        ("exact_rank", i(row.exact_rank)),
        ("rrf", f(row.rrf)),
        ("retrievalScore", f(row.retrieval_score)),
        ("_retrievalEvidence", row.retrieval_evidence.map(string)),
        ("members", row.members.as_ref().map(|m| Exact::Array(m.iter().map(row_value).collect()))),
        ("_historicalRootElement", s(&row.historical_root_element)),
        ("_historicalRootSummary", s(&row.historical_root_summary)),
    ];
    out.extend(optional.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    out
}

fn row_value(row: &Row) -> Exact {
    object(row_fields(row))
}

/// A Rust row in the key order of the recorded row it is compared with (a struct has no key order; JS objects
/// do), then any key the recorded row lacks: a missing, extra or different field still fails the comparison.
fn row_like(row: &Row, recorded: Option<&Exact>) -> Exact {
    let mut fields = row_fields(row);
    let mut out = Vec::new();
    // `id`, `ts` and `is_root` are plain struct fields: zero is also what a row without the key holds.
    if let Some(Exact::Object(entries)) = recorded {
        fields.retain(|(k, v)| {
            !(matches!(*k, "id" | "ts" | "is_root") && *v == int(0) && !entries.iter().any(|(key, _)| key == k))
        });
    }
    if let Some(Exact::Object(entries)) = recorded {
        for (key, value) in entries {
            if let Some(at) = fields.iter().position(|(k, _)| k == key) {
                let (k, v) = fields.remove(at);
                let v = match (k, &v, value) {
                    ("members", Exact::Array(_), Exact::Array(recorded)) => {
                        let members = row.member_list();
                        Exact::Array(members.iter().enumerate().map(|(i, m)| row_like(m, recorded.get(i))).collect())
                    }
                    _ => v,
                };
                out.push((k.to_owned(), v));
            }
        }
    }
    out.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
    Exact::Object(out)
}

/// Rust rows against the recorded rows, whole and in order.
#[track_caller]
pub(crate) fn same_rows(what: &str, expected: &Exact, actual: &[Row]) {
    let recorded = expected.as_array();
    let actual = Exact::Array(actual.iter().enumerate().map(|(i, r)| row_like(r, recorded.get(i))).collect());
    same(what, expected, &actual);
}
