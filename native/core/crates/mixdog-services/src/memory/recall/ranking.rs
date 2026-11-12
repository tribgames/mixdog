//! Ordering and selection of recall rows: reciprocal-rank fusion of the
//! retrieval lanes, query-intent detection (latest, timeline), latest-first
//! ranking, historical-root reserve, timeline sampling and temporal bounds.

use mixdog_js::{JsRegex, js_trim};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use unicode_normalization::UnicodeNormalization;

use crate::memory::query_terms::{is_structural_time_token, tokenize_recall_query};
use crate::memory::recall::period::Window;
use crate::memory::recall::row::{Row, by_diff, compare_newest_first};

const RRF_K: f64 = 60.0;

fn normalize_rank(value: Option<i64>) -> Option<i64> {
    value.filter(|rank| *rank > 0)
}

/// Dense rank and the best lexical rank of a candidate.
pub fn lane_ranks(row: &Row) -> (Option<i64>, Option<i64>) {
    let lexical = [row.sparse_rank, row.trgm_rank, row.exact_rank].into_iter().filter_map(normalize_rank).min();
    (normalize_rank(row.dense_rank), lexical)
}

pub fn rrf_score(row: &Row) -> f64 {
    rrf_score_with_k(row, RRF_K)
}

/// `rrf_score` with an explicit RRF constant (Node's `recallRrfScore(row, k)`).
pub fn rrf_score_with_k(row: &Row, k: f64) -> f64 {
    let (dense, lexical) = lane_ranks(row);
    dense.map_or(0.0, |rank| 1.0 / (k + rank as f64)) + lexical.map_or(0.0, |rank| 1.0 / (k + rank as f64))
}

/// `lexical` when a lexical lane matched, `semantic` for positive dense
/// similarity alone, otherwise `none`.
pub fn evidence_kind(row: &Row) -> &'static str {
    let (dense, lexical) = lane_ranks(row);
    if lexical.is_some() {
        return "lexical";
    }
    if dense.is_none() {
        return "none";
    }
    match row.dense_sim {
        Some(sim) if sim.is_finite() && sim > 0.0 => "semantic",
        _ => "none",
    }
}

pub fn is_semantic_only(rows: &[Row]) -> bool {
    !rows.is_empty() && rows.iter().all(|row| row.retrieval_evidence == Some("semantic"))
}

#[derive(Debug, Clone)]
pub struct Ranked {
    pub id: i64,
    pub rrf: f64,
    /// Position of the candidate's row in the ranked input.
    pub index: usize,
    pub evidence: &'static str,
}

/// Candidates with positive fused score and some evidence, best first.
pub fn rank_candidates(rows: &[Row]) -> Vec<Ranked> {
    rank_candidates_with_k(rows, RRF_K)
}

/// `rank_candidates` with an explicit RRF constant (Node's `rankRecallCandidates(rows, k)`).
pub fn rank_candidates_with_k(rows: &[Row], k: f64) -> Vec<Ranked> {
    let mut ranked: Vec<Ranked> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| Ranked { id: row.id, rrf: rrf_score_with_k(row, k), index, evidence: evidence_kind(row) })
        .filter(|ranked| ranked.rrf > 0.0 && ranked.evidence != "none")
        .collect();
    ranked.sort_by(|a, b| by_diff(b.rrf - a.rrf).then_with(|| a.id.cmp(&b.id)));
    ranked
}

const LATEST_CONTEXT_TERMS: [&str; 24] = [
    "latest", "current", "recent", "most", "now", "final", "result", "status", "statu", "decision", "complete",
    "completed", "최신", "현재", "최근", "지금", "방금", "최종", "결과", "상태", "값", "확정값", "결정", "완료",
];

static ENTITY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[A-Za-z0-9_./:-]", ""));
static LATEST_INTENT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"최신|현재|최근|방금|latest|current|most\s+recent", ""));
static VAGUE_LATEST: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"방금.*(?:작업|결과)|(?:latest|recent|most\s+recent).*(?:work|result)", ""));
static TIMELINE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"처음(?:부터)?|나중|변천|히스토리|과정|history|timeline|from\s+the\s+start", "")
});
static DATED_UNIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d{1,4}(?:년|월|일|시|분)$", ""));
static ATTACHED_ASCII: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"([A-Za-z0-9_./:-]{2,})\p{Script=Hangul}", "u"));
static IDENTIFIER_SHAPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_./:-]|\d", ""));
static LOWER_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[a-z][a-z0-9_-]*$", ""));
static EXPLICIT_IDENTIFIER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[A-Za-z][A-Za-z0-9_]*", ""));
static ALL_CAPS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z]{2,}$", ""));
static UNDERSCORE_OR_DIGIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_\d]", ""));

pub fn has_recall_entity(text: &str) -> bool {
    ENTITY.is_match(text)
}

fn intent_text(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

pub fn has_latest_recall_intent(text: &str) -> bool {
    LATEST_INTENT.is_match(&intent_text(text))
}

pub fn has_vague_latest_work_intent(text: &str) -> bool {
    VAGUE_LATEST.is_match(&intent_text(text))
}

pub fn has_timeline_intent(text: &str) -> bool {
    TIMELINE.is_match(&intent_text(text))
}

/// Unique tokens of a query (at most 12 before de-duplication).
pub fn session_recall_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tokenize_recall_query(query, 12).into_iter().filter(|t| seen.insert(t.clone())).collect()
}

pub fn latest_recall_topic_terms(text: &str) -> Vec<String> {
    session_recall_terms(text)
        .into_iter()
        .filter(|term| !LATEST_CONTEXT_TERMS.contains(&term.as_str()))
        .filter(|term| !is_structural_time_token(term))
        .filter(|term| !DATED_UNIT.is_match(term))
        .collect()
}

pub fn latest_recall_search_terms(text: &str) -> Vec<String> {
    let topic = latest_recall_topic_terms(text);
    let attached: HashSet<String> =
        ATTACHED_ASCII.captures_iter(text).flat_map(|m| session_recall_terms(m.get(1).unwrap_or_default())).collect();
    let identifiers: Vec<String> = topic
        .iter()
        .filter(|term| {
            IDENTIFIER_SHAPE.is_match(term)
                || attached.contains(term.as_str())
                || (!attached.is_empty() && LOWER_WORD.is_match(term))
        })
        .cloned()
        .collect();
    if identifiers.is_empty() { topic } else { identifiers }
}

fn row_score(row: &Row) -> f64 {
    let value = row.retrieval_score.or(row.rrf).or(row.score).unwrap_or(0.0);
    if value.is_finite() { value } else { 0.0 }
}

fn topic_text(row: &Row) -> String {
    let mut parts: Vec<&str> = vec![row.content(), row.element(), row.summary()];
    for member in row.member_list() {
        parts.extend([member.content(), member.element(), member.summary()]);
    }
    parts.into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ").nfkc().collect::<String>().to_lowercase()
}

/// How many of `terms` the row (or any member) contains.
pub fn topic_term_coverage(row: &Row, terms: &[String]) -> usize {
    let text = topic_text(row);
    terms.iter().filter(|term| text.contains(term.as_str())).count()
}

pub fn rank_latest_rows(rows: Vec<Row>, query: &str) -> Vec<Row> {
    let terms = latest_recall_topic_terms(query);
    let strict_entity_coverage = EXPLICIT_IDENTIFIER
        .find_iter(query)
        .map(|range| &query[range])
        .filter(|term| {
            ALL_CAPS.is_match(term)
                || term.chars().skip(1).any(|c| c.is_ascii_uppercase())
                || UNDERSCORE_OR_DIGIT.is_match(term)
        })
        .count()
        > 1;
    let normalized_query = js_trim(&query.nfkc().collect::<String>()).to_lowercase();
    struct Annotated {
        row: Row,
        index: usize,
        coverage: usize,
        self_echo: bool,
    }
    let mut annotated: Vec<Annotated> = rows
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let coverage = topic_term_coverage(&row, &terms);
            let self_echo = js_trim(&row.content().nfkc().collect::<String>()).to_lowercase() == normalized_query;
            Annotated { row, index, coverage, self_echo }
        })
        .collect();
    let max_coverage = annotated.iter().map(|a| a.coverage).max().unwrap_or(0);
    let relaxed = if max_coverage > 1 { max_coverage - 1 } else { max_coverage };
    let floor = if strict_entity_coverage { max_coverage } else { relaxed };
    annotated.sort_by(|a, b| {
        if a.self_echo != b.self_echo {
            return if a.self_echo { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less };
        }
        let (a_latest, b_latest) = (a.coverage >= floor, b.coverage >= floor);
        if a_latest != b_latest {
            return if a_latest { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        if a_latest && b_latest {
            return compare_newest_first(&a.row, &b.row)
                .then_with(|| b.coverage.cmp(&a.coverage))
                .then_with(|| by_diff(row_score(&b.row) - row_score(&a.row)))
                .then_with(|| a.index.cmp(&b.index));
        }
        b.coverage
            .cmp(&a.coverage)
            .then_with(|| by_diff(row_score(&b.row) - row_score(&a.row)))
            .then_with(|| compare_newest_first(&a.row, &b.row))
            .then_with(|| a.index.cmp(&b.index))
    });
    annotated.into_iter().map(|a| a.row).collect()
}

/// Primary rows with the novel historical roots reserved among them.
pub fn merge_historical_rows(
    primary_rows: Vec<Row>,
    root_rows: &[Row],
    limit: usize,
    include_matched_root_summary: bool,
    root_reserve: usize,
) -> Vec<Row> {
    let cap = limit.max(1);
    let mut root_by_id: HashMap<i64, &Row> = HashMap::new();
    for row in root_rows {
        root_by_id.entry(row.id).or_insert(row);
    }
    let mut seen = HashSet::new();
    let mut primary = Vec::new();
    for row in primary_rows {
        if !seen.insert(row.id) {
            continue;
        }
        let source = root_by_id.get(&row.id).copied().or(if row.is_root == 1 { Some(&row) } else { None });
        let mut row = row.clone();
        if include_matched_root_summary
            && let Some(source) = source {
                row.historical_root_element = source.element.clone();
                row.historical_root_summary = source.summary.clone();
            }
        primary.push(row);
    }
    let reserve = root_reserve.min(cap);
    let novel: Vec<Row> = root_rows.iter().filter(|row| !seen.contains(&row.id)).take(reserve).cloned().collect();
    if novel.is_empty() {
        primary.truncate(cap);
        return primary;
    }
    let mut primary = primary.into_iter();
    let mut out = Vec::new();
    if let Some(first) = primary.next() {
        out.push(first);
    }
    if reserve > 1 {
        out.extend(novel);
        while out.len() < cap {
            let Some(row) = primary.next() else { break };
            out.push(row);
        }
        out.truncate(cap);
        return out;
    }
    for root in novel {
        out.push(root);
        if let Some(row) = primary.next() {
            out.push(row);
        }
    }
    while out.len() < cap {
        let Some(row) = primary.next() else { break };
        out.push(row);
    }
    out.truncate(cap);
    out
}

/// The first row, the single best latest-concept row, then the rest, capped.
pub fn preserve_latest_concept_rows(primary: Vec<Row>, concept_rows: &[Row], limit: usize) -> Vec<Row> {
    let cap = limit.max(1);
    let mut concepts: Vec<&Row> = concept_rows.iter().collect();
    concepts.sort_by(|a, b| {
        by_diff(b.retrieval_value() - a.retrieval_value()).then_with(|| {
            let rank = |r: &Row| r.retrieval_rank.map_or(9_007_199_254_740_991.0, |v| v as f64);
            by_diff(rank(a) - rank(b))
        })
    });
    concepts.truncate(1);
    let mut seen = HashSet::new();
    let mut out: Vec<Row> = Vec::new();
    let mut append = |row: &Row, out: &mut Vec<Row>| {
        if seen.contains(&row.id) || out.len() >= cap {
            return;
        }
        seen.insert(row.id);
        out.push(row.clone());
    };
    if let Some(first) = primary.first() {
        append(first, &mut out);
    }
    for row in concepts {
        append(row, &mut out);
    }
    for row in &primary {
        append(row, &mut out);
    }
    out
}

/// Rows (and members) inside the window; a root keeps only its in-window members.
pub fn bound_rows_to_temporal(rows: Vec<Row>, window: Option<&Window>) -> Vec<Row> {
    let (Some(start), Some(end)) = (window.and_then(|w| w.start_ms), window.and_then(|w| w.end_ms)) else {
        return rows;
    };
    let in_range = |row: &Row| row.ts >= start && row.ts <= end;
    rows.into_iter()
        .flat_map(|mut row| match row.members.as_ref().filter(|m| !m.is_empty()) {
            None => in_range(&row).then_some(row).into_iter().collect::<Vec<_>>(),
            Some(members) => {
                let kept: Vec<Row> = members.iter().filter(|m| in_range(m)).cloned().collect();
                if !kept.is_empty() {
                    row.members = Some(kept);
                    vec![row]
                } else if in_range(&row) {
                    row.members = Some(Vec::new());
                    vec![row]
                } else {
                    Vec::new()
                }
            }
        })
        .collect()
}

/// Each root first within the group of rows that belong to it.
pub fn prioritize_historical_root_evidence(rows: Vec<Row>) -> Vec<Row> {
    let root_ids: HashSet<i64> = rows.iter().filter(|r| r.is_root == 1).map(|r| r.id).collect();
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();
    for row in rows {
        let key = if row.is_root == 1 {
            format!("root:{}", row.id)
        } else if row.chunk_root.is_some_and(|parent| root_ids.contains(&parent)) {
            format!("root:{}", row.chunk_root.unwrap_or_default())
        } else {
            format!("row:{}", row.id)
        };
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(row);
    }
    order
        .into_iter()
        .flat_map(|key| {
            let mut group = groups.remove(&key).unwrap_or_default();
            group.sort_by(|a, b| u8::from(b.is_root == 1).cmp(&u8::from(a.is_root == 1)));
            group
        })
        .collect()
}

/// A root that carries members remembers its own element/summary as event context.
pub fn annotate_root_context(rows: Vec<Row>) -> Vec<Row> {
    rows.into_iter()
        .map(|mut row| {
            if row.is_root == 1 && !row.member_list().is_empty() {
                row.historical_root_element = row.element.clone();
                row.historical_root_summary = row.summary.clone();
            }
            row
        })
        .collect()
}

/// Half the page by relevance, half spread across the time span.
pub fn sample_timeline(rows: Vec<Row>, limit: usize) -> Vec<Row> {
    let cap = limit.max(1);
    let mut sorted = rows;
    sorted.sort_by(compare_newest_first);
    if sorted.len() <= cap {
        return sorted;
    }
    let mut selected = std::collections::BTreeSet::new();
    let mut by_relevance: Vec<(usize, f64)> = sorted.iter().enumerate().map(|(i, r)| (i, row_score(r))).collect();
    by_relevance.sort_by(|a, b| by_diff(b.1 - a.1).then_with(|| a.0.cmp(&b.0)));
    let relevance_count = cap.div_ceil(2).max(1);
    for (index, _) in &by_relevance {
        selected.insert(*index);
        if selected.len() >= relevance_count {
            break;
        }
    }
    let coverage_count = cap - relevance_count;
    for slot in 0..coverage_count {
        let ratio = if coverage_count == 1 { 0.0 } else { slot as f64 / (coverage_count - 1) as f64 };
        selected.insert((ratio * (sorted.len() - 1) as f64).round() as usize);
    }
    for (index, _) in &by_relevance {
        if selected.len() >= cap {
            break;
        }
        selected.insert(*index);
    }
    let mut index = 0;
    while selected.len() < cap && index < sorted.len() {
        selected.insert(index);
        index += 1;
    }
    selected.into_iter().take(cap).map(|i| sorted[i].clone()).collect()
}

/// Drops a root whose duplicate representative is also present in the same project.
pub fn collapse_history_duplicates(rows: Vec<Row>) -> Vec<Row> {
    let by_id: HashMap<i64, Option<String>> =
        rows.iter().filter(|r| r.is_root == 1).map(|r| (r.id, r.project_id.clone())).collect();
    rows.into_iter()
        .filter(|row| {
            let (1, Some(duplicate_of)) = (row.is_root, row.duplicate_of) else { return true };
            by_id.get(&duplicate_of).is_none_or(|project| *project != row.project_id)
        })
        .collect()
}
