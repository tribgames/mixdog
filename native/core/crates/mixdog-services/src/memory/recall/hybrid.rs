//! Hybrid recall: one candidate query over four lanes (dense vector, sparse
//! full-text, substring, exact terms), reciprocal-rank fusion, resolution of
//! matched member turns to their root episodes, optional latest-by-concept
//! widening, duplicate collapse and member attachment.

use mixdog_js::{js_trim, js_words, JsRegex, slice_utf16, utf16_len};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;


use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::query_terms::{build_fts_prefix_query, build_fts_query, tokenize_recall_query};
use crate::memory::recall::filters::{
    ScopeOptions, project_scope_predicate, scope_filter, valid_categories,
};
use crate::memory::recall::ranking::{
    collapse_history_duplicates, evidence_kind, is_semantic_only, lane_ranks, rank_candidates, rrf_score,
};
use crate::memory::recall::row::{P, Row};
use crate::memory::recall::store::read_query;

/// The entries scanned by the substring and exact lanes: the newest N by id.
const LEX_SCAN_ROWS: i64 = 200_000;
const MIN_EXACT_HITS: u32 = 1;

pub const ENTRY_ROW_COLUMNS: &str = "id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
              concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at";
const FINAL_ROW_COLUMNS: &str = "id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
              concept_id, supersedes_id, element, category, summary, project_id, status, score, last_seen_at, duplicate_of";

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub limit: Option<usize>,
    pub query_vector: Option<Vec<f32>>,
    pub include_members: bool,
    pub root_only: bool,
    pub latest_by_concept: bool,
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub exclude_statuses: Vec<String>,
    pub project_scope: Option<String>,
    pub category: Vec<String>,
}

#[derive(Debug, Clone)]
struct Plan {
    clean: String,
    limit: usize,
    candidate_window: i64,
    include_members: bool,
    root_only: bool,
    latest_by_concept: bool,
    query_vector: Option<Vec<f32>>,
    ts_from: Option<i64>,
    ts_to: Option<i64>,
    exclude_statuses: Vec<String>,
    project_scope: Option<String>,
    categories: Vec<String>,
}

impl Plan {
    fn new(clean: &str, options: &SearchOptions) -> Self {
        let limit = options.limit.unwrap_or(8).max(1);
        Self {
            clean: clean.to_owned(),
            limit,
            candidate_window: (limit * 8).max(240) as i64,
            include_members: options.include_members,
            root_only: options.root_only,
            latest_by_concept: options.latest_by_concept,
            query_vector: options.query_vector.clone().filter(|v| !v.is_empty()),
            ts_from: options.ts_from,
            ts_to: options.ts_to,
            exclude_statuses: options
                .exclude_statuses
                .iter()
                .filter(|s| !js_trim(s).is_empty())
                .map(|s| js_trim(s).to_lowercase())
                .collect(),
            project_scope: options.project_scope.clone(),
            categories: valid_categories(&options.category),
        }
    }

    fn scope_options(&self, skip_ts: bool) -> ScopeOptions<'_> {
        ScopeOptions {
            ts_from: if skip_ts { None } else { self.ts_from },
            ts_to: if skip_ts { None } else { self.ts_to },
            exclude_statuses: &self.exclude_statuses,
            categories: &self.categories,
            project_scope: self.project_scope.as_deref(),
        }
    }

    fn filter(&self, offset: usize, skip_ts: bool, alias: &str) -> (String, Vec<P>) {
        scope_filter(offset, &self.scope_options(skip_ts), alias)
    }
}

pub fn embedding_to_sql(vector: &[f32]) -> String {
    format!("[{}]", vector.iter().map(|n| format!("{:.6}", f64::from(*n))).collect::<Vec<_>>().join(","))
}

static EDGE_JUNK: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^[^\p{L}\p{N}_./:-]+|[^\p{L}\p{N}_./:-]+$", "u"));
static IDENTIFIER_SHAPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_./:-]", ""));

/// Lower-cased literal terms for the exact lane: the whole query when short,
/// each concept token and each adjacent pair.
pub fn build_exact_terms(query: &str) -> Vec<String> {
    let clean = js_words(query).collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return Vec::new();
    }
    let mut terms: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        let term = EDGE_JUNK.replace_all_with(js_trim(value), |_| String::new());
        if term.is_empty() {
            return;
        }
        if !IDENTIFIER_SHAPE.is_match(&term) && utf16_len(&term) < 2 {
            return;
        }
        terms.push(slice_utf16(&term, 80));
    };
    let tokens = tokenize_recall_query(&clean, 12);
    if tokens.len() <= 2 && utf16_len(&clean) <= 80 {
        add(&clean);
    }
    for token in &tokens {
        add(token);
    }
    for pair in tokens.windows(2) {
        add(&format!("{} {}", pair[0], pair[1]));
    }
    let mut seen = HashSet::new();
    terms.into_iter().map(|t| t.to_lowercase()).filter(|t| seen.insert(t.clone())).take(12).collect()
}

fn substring_predicate(column: &str, term: &str) -> String {
    let pattern = format!("'%' || {term} || '%'");
    format!("({column} ILIKE {pattern} OR ({column} IS NULL AND '' ILIKE {pattern}))")
}

fn lex_scan_bound(alias: &str) -> String {
    let col = if alias.is_empty() { "id".to_owned() } else { format!("{alias}.id") };
    format!("AND {col} >= (SELECT GREATEST(COALESCE(MAX(id), 0) - {LEX_SCAN_ROWS}, 0) FROM entries)")
}

struct Filters {
    clause: String,
    root: &'static str,
    exact_clause: String,
    exact_root: &'static str,
}

fn dense_cte(has_vector: bool, f: &Filters) -> String {
    if !has_vector {
        return "\ndense AS (SELECT NULL::bigint AS id, NULL::float8 AS sim, NULL::bigint AS dense_rank WHERE $1::text IS NOT NULL AND false),".into();
    }
    format!(
        "
dense AS (
  SELECT id,
         1 - (embedding <=> $1::text::halfvec) AS sim,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::text::halfvec) AS dense_rank
  FROM entries
  WHERE embedding IS NOT NULL
    {}
    {}
  ORDER BY embedding <=> $1::text::halfvec
  LIMIT $4
),",
        f.clause, f.root
    )
}

fn sparse_cte(fts: Option<&str>, prefix_mode: bool, f: &Filters) -> String {
    if fts.is_none() {
        return "\nsparse AS (SELECT NULL::bigint AS id, NULL::float8 AS lex, NULL::bigint AS sparse_rank WHERE $2::text IS NOT NULL AND false),".into();
    }
    let tsq = if prefix_mode { "to_tsquery('simple', $2)" } else { "websearch_to_tsquery('simple', $2)" };
    format!(
        "
sparse AS (
  SELECT id,
         ts_rank_cd(search_tsv, {tsq}) AS lex,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_tsv, {tsq}) DESC) AS sparse_rank
  FROM entries
  WHERE search_tsv @@ {tsq}
    {}
    {}
  ORDER BY lex DESC
  LIMIT $4
),",
        f.clause, f.root
    )
}

fn trgm_cte(f: &Filters) -> String {
    format!(
        "
trgm AS (
  SELECT id,
         1.0::float8 AS trg_sim,
         ROW_NUMBER() OVER (ORDER BY ts DESC) AS trgm_rank
  FROM entries
  WHERE (
      content ILIKE '%' || $3 || '%'
      OR {}
      OR {}
    )
    {}
    {}
    {}
  ORDER BY ts DESC
  LIMIT $4
),",
        substring_predicate("element", "$3"),
        substring_predicate("summary", "$3"),
        f.clause,
        f.root,
        lex_scan_bound("")
    )
}

fn exact_cte(exact_param: usize, f: &Filters) -> String {
    if exact_param == 0 {
        return "
exact_matches AS (
  SELECT NULL::bigint AS id, NULL::bigint AS ts, NULL::text AS term, NULL::float8 AS term_df
  WHERE false
),
exact AS (
  SELECT NULL::bigint AS id, NULL::float8 AS exact_hits,
         NULL::float8 AS exact_phrase_hits, NULL::float8 AS exact_rarity,
         NULL::bigint AS exact_rank
  WHERE false
),"
        .into();
    }
    format!(
        "
exact_matches AS (
  SELECT ee.id,
         ee.ts,
         q.term,
         COUNT(*) OVER (PARTITION BY q.term)::float8 AS term_df
  FROM entries ee
  CROSS JOIN LATERAL (
    SELECT lower(ee.content) AS content, lower(ee.element) AS element, lower(ee.summary) AS summary
    OFFSET 0
  ) lc
  JOIN LATERAL unnest(${exact_param}::text[]) AS q(term) ON (
       strpos(lc.content, q.term) > 0
       OR strpos(lc.element, q.term) > 0
       OR strpos(lc.summary, q.term) > 0
  )
  WHERE true
    {}
    {}
    {}
),
exact AS (
  SELECT id,
         COUNT(*)::float8 AS exact_hits,
         COUNT(*) FILTER (WHERE POSITION(' ' IN term) > 0)::float8 AS exact_phrase_hits,
         SUM(
           (CASE WHEN term ~ '[A-Za-z0-9_./:-]' THEN 3.0 ELSE 1.0 END)
           / SQRT(GREATEST(term_df, 1))
         )::float8 AS exact_rarity,
         ROW_NUMBER() OVER (
           ORDER BY SUM(
                      (CASE WHEN term ~ '[A-Za-z0-9_./:-]' THEN 3.0 ELSE 1.0 END)
                      / SQRT(GREATEST(term_df, 1))
                    ) DESC,
                    COUNT(*) DESC,
                    MAX(ts) DESC
         ) AS exact_rank
  FROM exact_matches
  GROUP BY id
  HAVING COUNT(*) >= {MIN_EXACT_HITS}
  ORDER BY exact_rarity DESC, exact_hits DESC, MAX(ts) DESC
  LIMIT $4
),",
        f.exact_clause,
        f.exact_root,
        lex_scan_bound("ee")
    )
}

/// Param layout: $1 vector literal, $2 tsquery text, $3 clean text, $4 window,
/// $5.. filter params, then the exact-term array.
fn build_hybrid_query(plan: &Plan) -> (String, Vec<P>) {
    let vector_sql = plan.query_vector.as_deref().map(embedding_to_sql);
    let prefix = if utf16_len(&plan.clean) >= 3 { build_fts_prefix_query(&plan.clean) } else { None };
    let fts: Option<String> = match (&prefix, utf16_len(&plan.clean) >= 3) {
        (Some(query), _) => Some(query.clone()),
        (None, true) => Some(build_fts_query(&plan.clean)).filter(|q| !q.is_empty()),
        _ => None,
    };
    let exact_terms = build_exact_terms(&plan.clean);
    let (clause, filter_params) = plan.filter(5, false, "");
    let (exact_clause, _) = plan.filter(5, false, "ee");
    let filters = Filters {
        clause,
        root: if plan.root_only { "AND is_root = 1" } else { "" },
        exact_clause,
        exact_root: if plan.root_only { "AND ee.is_root = 1" } else { "" },
    };
    let exact_param = if exact_terms.is_empty() { 0 } else { 5 + filter_params.len() };
    let sql = format!(
        "
WITH
{}
{}
{}
{}
combined AS (
  SELECT id FROM dense  WHERE id IS NOT NULL UNION
  SELECT id FROM sparse WHERE id IS NOT NULL UNION
  SELECT id FROM trgm   WHERE id IS NOT NULL UNION
  SELECT id FROM exact  WHERE id IS NOT NULL
)
SELECT
  e.id, e.element, e.summary, e.category, e.status, e.score,
  e.last_seen_at, e.ts, e.project_id, e.session_id, e.source_ref,
  e.source_turn, e.content, e.chunk_root, e.concept_id, e.supersedes_id, e.is_root,
  e.role,
  d.sim        AS dense_sim,
  d.dense_rank,
  s.lex        AS sparse_lex,
  s.sparse_rank,
  t.trg_sim,
  t.trgm_rank,
  x.exact_hits,
  x.exact_phrase_hits,
  x.exact_rarity,
  x.exact_rank
FROM combined c
JOIN   entries e ON e.id = c.id
LEFT JOIN dense  d ON d.id = c.id
LEFT JOIN sparse s ON s.id = c.id
LEFT JOIN trgm   t ON t.id = c.id
LEFT JOIN exact  x ON x.id = c.id",
        dense_cte(vector_sql.is_some(), &filters),
        sparse_cte(fts.as_deref(), prefix.is_some(), &filters),
        trgm_cte(&filters),
        exact_cte(exact_param, &filters),
    );
    let mut params = vec![
        vector_sql.map_or(P::T(String::new()), P::T),
        fts.map_or(P::T(String::new()), P::T),
        P::T(plan.clean.clone()),
        P::I(plan.candidate_window),
    ];
    params.extend(filter_params);
    if exact_param != 0 {
        params.push(P::TA(exact_terms));
    }
    (sql, params)
}

fn root_id_of(row: &Row) -> i64 {
    if row.is_root == 1 { row.id } else { row.chunk_root.unwrap_or(0) }
}

fn member_ts_in_window(row: &Row, from: Option<i64>, to: Option<i64>) -> bool {
    from.is_none_or(|f| row.ts >= f) && to.is_none_or(|t| row.ts <= t)
}

struct Resolved {
    root: Row,
    rrf: f64,
    retrieval_evidence: &'static str,
    retrieval_rank: usize,
    concept_expanded: bool,
}

struct RootResolution {
    resolved: Vec<Resolved>,
    member_hit_roots: HashSet<i64>,
    matched_members: HashMap<i64, HashSet<i64>>,
}

async fn resolve_roots(
    db: &Db,
    ranked: &[crate::memory::recall::ranking::Ranked],
    by_id: &HashMap<i64, usize>,
    raw: &[Row],
    plan: &Plan,
    concept_expanded_roots: &HashSet<i64>,
) -> Result<RootResolution> {
    let mut member_root_ids: Vec<i64> = Vec::new();
    let mut matched_members: HashMap<i64, HashSet<i64>> = HashMap::new();
    for candidate in ranked {
        let Some(row) = by_id.get(&candidate.id).map(|i| &raw[*i]) else { continue };
        if row.is_root == 1 {
            continue;
        }
        let Some(root) = row.chunk_root.filter(|root| *root != row.id) else { continue };
        matched_members.entry(root).or_insert_with(|| {
            member_root_ids.push(root);
            HashSet::new()
        });
        matched_members.entry(root).or_default().insert(row.id);
    }
    let mut root_by_id: HashMap<i64, Row> = HashMap::new();
    if !member_root_ids.is_empty() {
        let (scope, scope_params) = project_scope_predicate(plan.project_scope.as_deref(), 2, "project_id");
        let scope_clause = if scope.is_empty() { String::new() } else { format!("AND {scope}") };
        let mut params = vec![P::IA(member_root_ids)];
        params.extend(scope_params);
        let rows = read_query(
            db,
            &format!("SELECT {ENTRY_ROW_COLUMNS} FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1 {scope_clause}"),
            &params,
        )
        .await?;
        for row in rows {
            root_by_id.insert(row.id, row);
        }
    }
    let mut member_hit_roots = HashSet::new();
    let mut resolved: Vec<Resolved> = Vec::new();
    let mut seen = HashSet::new();
    for candidate in ranked {
        let Some(row) = by_id.get(&candidate.id).map(|i| &raw[*i]) else { continue };
        let mut target = row.clone();
        if row.is_root != 1
            && let Some(chunk_root) = row.chunk_root.filter(|root| *root != row.id) {
                let Some(root) = root_by_id.get(&chunk_root) else { continue };
                if !member_ts_in_window(row, plan.ts_from, plan.ts_to) {
                    continue;
                }
                member_hit_roots.insert(root.id);
                target = root.clone();
            }
        if !seen.insert(target.id) {
            continue;
        }
        let (dense, lexical) = lane_ranks(row);
        let evidence = if lexical.is_some() {
            "lexical"
        } else if dense.is_some() {
            "semantic"
        } else {
            "none"
        };
        let expanded = concept_expanded_roots.contains(&target.id) || (plan.latest_by_concept && target.supersedes_id.is_some());
        resolved.push(Resolved {
            root: target,
            rrf: candidate.rrf,
            retrieval_evidence: evidence,
            retrieval_rank: resolved.len() + 1,
            concept_expanded: expanded,
        });
    }
    Ok(RootResolution { resolved, member_hit_roots, matched_members })
}

async fn fetch_final_rows(db: &Db, resolution: &RootResolution, plan: &Plan) -> Result<Vec<Row>> {
    let top_ids: Vec<i64> = resolution.resolved.iter().map(|r| r.root.id).collect();
    async fn fetch(db: &Db, ids: Vec<i64>, clause: String, params: Vec<P>) -> Result<Vec<Row>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut all = vec![P::IA(ids)];
        all.extend(params);
        read_query(db, &format!("SELECT {FINAL_ROW_COLUMNS} FROM entries WHERE id = ANY($1::bigint[]) {clause}"), &all).await
    }
    let (window_clause, window_params) = plan.filter(2, false, "");
    if resolution.member_hit_roots.is_empty() {
        return fetch(db, top_ids, window_clause, window_params).await;
    }
    let non_exempt: Vec<i64> = top_ids.iter().copied().filter(|id| !resolution.member_hit_roots.contains(id)).collect();
    let exempt: Vec<i64> = resolution.member_hit_roots.iter().copied().collect();
    let (exempt_clause, exempt_params) = plan.filter(2, true, "");
    let (windowed, exempt) = tokio::try_join!(
        fetch(db, non_exempt, window_clause, window_params),
        fetch(db, exempt, exempt_clause, exempt_params)
    )?;
    Ok(windowed.into_iter().chain(exempt).collect())
}

const RANK_KEYS: usize = 4;

fn rank_values(row: &Row) -> [Option<i64>; RANK_KEYS] {
    [row.dense_rank, row.sparse_rank, row.trgm_rank, row.exact_rank]
}

fn max_values(row: &Row) -> [Option<f64>; 6] {
    [row.dense_sim, row.sparse_lex, row.trg_sim, row.exact_hits, row.exact_phrase_hits, row.exact_rarity]
}

fn set_ranks(row: &mut Row, v: [Option<i64>; RANK_KEYS]) {
    [row.dense_rank, row.sparse_rank, row.trgm_rank, row.exact_rank] = v;
}

fn set_max(row: &mut Row, v: [Option<f64>; 6]) {
    [row.dense_sim, row.sparse_lex, row.trg_sim, row.exact_hits, row.exact_phrase_hits, row.exact_rarity] = v;
}

fn inherit_anchor_evidence(latest: &Row, anchor: &Row, existing: Option<&Row>) -> Row {
    let mut inherited = latest.clone();
    set_ranks(&mut inherited, rank_values(anchor));
    set_max(&mut inherited, max_values(anchor));
    let Some(existing) = existing else { return inherited };
    let (old_ranks, new_ranks) = (rank_values(existing), rank_values(&inherited));
    let merged = std::array::from_fn(|i| match (old_ranks[i], new_ranks[i]) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    });
    set_ranks(&mut inherited, merged);
    let (old_max, new_max) = (max_values(existing), max_values(&inherited));
    let merged = std::array::from_fn(|i| match (old_max[i], new_max[i]) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    });
    set_max(&mut inherited, merged);
    inherited
}

const LATEST_COLUMNS: &str = "e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
                 e.source_turn, e.time_source, e.chunk_root, e.is_root,
                 e.concept_id, e.supersedes_id, e.element, e.category,
                 e.summary, e.project_id, e.status, e.score, e.last_seen_at";

/// Widens the candidates with the newest root of every matched concept.
async fn expand_latest_by_concept(db: &Db, raw: Vec<Row>, plan: &Plan) -> Result<(Vec<Row>, HashSet<i64>)> {
    let mut expanded = HashSet::new();
    let mut candidate_roots: Vec<i64> = Vec::new();
    for row in &raw {
        let id = root_id_of(row);
        if !candidate_roots.contains(&id) {
            candidate_roots.push(id);
        }
    }
    if candidate_roots.is_empty() {
        return Ok((raw, expanded));
    }
    let relations = read_query_raw(
        db,
        "WITH roots AS (
          SELECT id, concept_id FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1
        )
        SELECT r.id AS root_id, ec.concept_id
        FROM roots r
        JOIN entry_concepts ec ON ec.entry_id = r.id
        UNION
        SELECT r.id AS root_id, r.id AS concept_id FROM roots r
        UNION
        SELECT r.id AS root_id, r.concept_id FROM roots r WHERE r.concept_id IS NOT NULL",
        &[P::IA(candidate_roots)],
    )
    .await?;
    let mut by_root: HashMap<i64, Vec<i64>> = HashMap::new();
    for relation in &relations {
        by_root.entry(relation.get::<_, i64>("root_id")).or_default().push(relation.get::<_, i64>("concept_id"));
    }
    let mut anchors: HashMap<i64, &Row> = HashMap::new();
    for row in &raw {
        for concept in by_root.get(&root_id_of(row)).into_iter().flatten() {
            if anchors.get(concept).is_none_or(|prior| rrf_score(row) > rrf_score(prior)) {
                anchors.insert(*concept, row);
            }
        }
    }
    if anchors.is_empty() {
        return Ok((raw, expanded));
    }
    let concept_ids: Vec<i64> = anchors.keys().copied().collect();
    let (latest_filter, latest_params) = plan.filter(2, true, "e");
    let mut params = vec![P::IA(concept_ids)];
    params.extend(latest_params);
    let latest = read_query(
        db,
        &format!(
            "SELECT DISTINCT ON (ec.concept_id)
                 ec.concept_id AS matched_concept_id,
                 {LATEST_COLUMNS}
          FROM entry_concepts ec
          JOIN entries e ON e.id = ec.entry_id
          WHERE ec.concept_id = ANY($1::bigint[])
            AND e.is_root = 1
            {latest_filter}
          ORDER BY ec.concept_id, e.ts DESC, e.id DESC"
        ),
        &params,
    )
    .await?;
    let mut merged: Vec<Row> = raw.clone();
    let mut index: HashMap<i64, usize> = merged.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    for latest_row in latest {
        let Some(anchor) = latest_row.matched_concept_id.and_then(|c| anchors.get(&c)) else { continue };
        let carries = latest_row.supersedes_id.is_some() || latest_row.id != root_id_of(anchor);
        if carries {
            expanded.insert(latest_row.id);
        }
        let existing = index.get(&latest_row.id).map(|i| &merged[*i]);
        let mut inherited = inherit_anchor_evidence(&latest_row, anchor, existing);
        inherited.concept_expanded = carries;
        match index.get(&latest_row.id) {
            Some(i) => merged[*i] = inherited,
            None => {
                index.insert(latest_row.id, merged.len());
                merged.push(inherited);
            }
        }
    }
    Ok((merged, expanded))
}

fn prefer_latest_concept_rows(rows: &[Row], latest: &[Row]) -> Vec<Row> {
    let mut by_concept: HashMap<i64, &Row> = HashMap::new();
    for row in latest {
        by_concept.entry(row.matched_concept_id.or(row.concept_id).unwrap_or(row.id)).or_insert(row);
    }
    rows.iter()
        .map(|row| {
            let concept_ids: Vec<i64> =
                if row.concept_ids.is_empty() { vec![row.concept_id.unwrap_or(row.id)] } else { row.concept_ids.clone() };
            let mut best = row;
            for concept in concept_ids {
                let Some(candidate) = by_concept.get(&concept) else { continue };
                if candidate.ts > best.ts || (candidate.ts == best.ts && candidate.id > best.id) {
                    best = candidate;
                }
            }
            best.clone()
        })
        .collect()
}

/// Annotates final roots with their concepts and resolves each to the latest
/// root of its concept; the two lists stay index-aligned.
async fn resolve_latest_concept_rows(db: &Db, final_rows: Vec<Row>, plan: &Plan) -> Result<(Vec<Row>, Vec<Row>)> {
    let root_ids: Vec<i64> = final_rows.iter().filter(|r| r.is_root == 1).map(|r| r.id).collect();
    let mut relation_concepts: HashMap<i64, Vec<i64>> = HashMap::new();
    if !root_ids.is_empty() {
        let rows = read_query_raw(
            db,
            "SELECT entry_id, array_agg(concept_id ORDER BY concept_id) AS concept_ids
          FROM entry_concepts
          WHERE entry_id = ANY($1::bigint[])
          GROUP BY entry_id",
            &[P::IA(root_ids)],
        )
        .await?;
        for row in rows {
            relation_concepts.insert(row.get::<_, i64>("entry_id"), row.get::<_, Option<Vec<i64>>>("concept_ids").unwrap_or_default());
        }
    }
    let annotated: Vec<Row> = final_rows
        .into_iter()
        .map(|mut row| {
            if let Some(ids) = relation_concepts.get(&row.id).filter(|ids| !ids.is_empty()) {
                row.concept_ids = ids.clone();
            }
            row
        })
        .collect();
    let mut concept_ids: Vec<i64> = Vec::new();
    for row in annotated.iter().filter(|r| r.is_root == 1) {
        let ids = if row.concept_ids.is_empty() { vec![row.concept_id.unwrap_or(row.id)] } else { row.concept_ids.clone() };
        for id in ids {
            if !concept_ids.contains(&id) {
                concept_ids.push(id);
            }
        }
    }
    if concept_ids.is_empty() {
        return Ok((annotated.clone(), annotated));
    }
    let (latest_filter, latest_params) = plan.filter(2, true, "e");
    let mut params = vec![P::IA(concept_ids)];
    params.extend(latest_params);
    let latest = read_query(
        db,
        &format!(
            "WITH candidates AS (
          SELECT ec.concept_id AS matched_concept_id,
                 {LATEST_COLUMNS}
          FROM entry_concepts ec
          JOIN entries e ON e.id = ec.entry_id
          WHERE ec.concept_id = ANY($1::bigint[])
            AND e.is_root = 1
            {latest_filter}
          UNION ALL
          SELECT COALESCE(e.concept_id, e.id) AS matched_concept_id,
                 {LATEST_COLUMNS}
          FROM entries e
          WHERE e.is_root = 1
            AND COALESCE(e.concept_id, e.id) = ANY($1::bigint[])
            {latest_filter}
        )
        SELECT DISTINCT ON (matched_concept_id) *
        FROM candidates
        ORDER BY matched_concept_id, ts DESC, id DESC"
        ),
        &params,
    )
    .await?;
    let resolved = prefer_latest_concept_rows(&annotated, &latest);
    Ok((annotated, resolved))
}

async fn attach_members(db: &Db, page: &mut [Row], matched: &HashMap<i64, HashSet<i64>>) -> Result<()> {
    let root_ids: Vec<i64> = page.iter().filter(|r| r.is_root == 1).map(|r| r.id).collect();
    if root_ids.is_empty() {
        return Ok(());
    }
    let members = read_query(
        db,
        "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
         FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
         ORDER BY ts ASC, id ASC",
        &[P::IA(root_ids)],
    )
    .await?;
    let mut by_root: HashMap<i64, Vec<Row>> = HashMap::new();
    for member in members {
        by_root.entry(member.chunk_root.unwrap_or(0)).or_default().push(member);
    }
    for row in page.iter_mut().filter(|r| r.is_root == 1) {
        let all = by_root.get(&row.id).cloned().unwrap_or_default();
        let kept: Vec<Row> = match matched.get(&row.id).filter(|set| !set.is_empty()) {
            Some(set) => all.iter().filter(|m| set.contains(&m.id)).cloned().collect(),
            None => Vec::new(),
        };
        row.members = Some(if kept.is_empty() { all } else { kept });
    }
    Ok(())
}

/// `read_query` rows kept as driver rows for queries with ad-hoc columns.
async fn read_query_raw(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    crate::memory::recall::store::read_query_pg(db, sql, params).await
}

/// Hybrid search over `entries`. Numeric-only and empty queries find nothing.
pub async fn search_relevant_hybrid(db: &Db, query: &str, options: &SearchOptions) -> Result<Vec<Row>> {
    let clean = js_trim(query);
    if clean.is_empty() || clean.chars().all(|c| c.is_ascii_digit()) {
        return Ok(Vec::new());
    }
    let plan = Plan::new(clean, options);
    let (sql, params) = build_hybrid_query(&plan);
    let mut raw = read_query(db, &sql, &params).await?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let mut concept_expanded_roots = HashSet::new();
    if plan.latest_by_concept {
        (raw, concept_expanded_roots) = expand_latest_by_concept(db, raw, &plan).await?;
    }
    let ranked = rank_candidates(&raw);
    if ranked.is_empty() {
        return Ok(Vec::new());
    }
    let by_id: HashMap<i64, usize> = raw.iter().enumerate().map(|(i, r)| (r.id, i)).collect();
    let resolution = resolve_roots(db, &ranked, &by_id, &raw, &plan, &concept_expanded_roots).await?;
    let mut final_rows = fetch_final_rows(db, &resolution, &plan).await?;
    let mut resolved_final = final_rows.clone();
    if plan.latest_by_concept && !final_rows.is_empty() {
        (final_rows, resolved_final) = resolve_latest_concept_rows(db, final_rows, &plan).await?;
    }
    let final_by_id: HashMap<i64, &Row> = final_rows.iter().zip(&resolved_final).map(|(row, resolved)| (row.id, resolved)).collect();
    let mut results = Vec::new();
    let mut emitted = HashSet::new();
    for item in &resolution.resolved {
        let Some(final_root) = final_by_id.get(&item.root.id) else { continue };
        if !emitted.insert(final_root.id) {
            continue;
        }
        let mut out = (*final_root).clone();
        out.rrf = Some(item.rrf);
        out.retrieval_score = Some(item.rrf);
        out.retrieval_rank = Some(item.retrieval_rank);
        out.retrieval_evidence = Some(item.retrieval_evidence);
        if item.concept_expanded || (plan.latest_by_concept && final_root.supersedes_id.is_some()) {
            out.concept_expanded = true;
        }
        results.push(out);
    }
    let mut page: Vec<Row> = collapse_history_duplicates(results).into_iter().take(plan.limit).collect();
    if plan.include_members {
        attach_members(db, &mut page, &resolution.matched_members).await?;
    }
    Ok(page)
}

/// Whether every returned candidate matched on meaning alone.
pub fn semantic_only(rows: &[Row]) -> bool {
    is_semantic_only(rows)
}

#[allow(dead_code)]
fn evidence_of(row: &Row) -> &'static str {
    evidence_kind(row)
}
