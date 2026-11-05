//! The non-hybrid legs of recall: filtered entry reads, raw (unchunked) turns,
//! query-less browses, the session-grouped `last` browse, current-session
//! recall, `#id` lookups, the core-memory leg and event-context expansion.

use mixdog_js::{js_trim, utf16_len};
use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;
use crate::memory::recall::filters::{
    ScopeOptions, append_project_scope, is_valid_category, project_scope_predicate, scope_filter, VALID_CATEGORIES,
};
use crate::memory::recall::format::{
    GroupedOptions, RenderOptions, SessionMeta, compact_digest_rows, render_entry_lines, render_session_grouped_lines,
    search_haystack,
};
use crate::memory::recall::period::Clock;
use crate::memory::recall::plan::{RECALL_WINDOW_CAP, SearchArgs, SearchPlan, resolve_query_project_scope};
use crate::memory::recall::ranking::session_recall_terms;
use crate::memory::recall::row::{P, Row, compare_newest_first};
use crate::memory::recall::store::{query, query_pg, read_query};

const PER_SESSION_ROW_CAP: usize = 10;
const PER_SESSION_SEARCH_CAP: usize = 50;
const IN_FLIGHT_TURN_FRESHNESS_MS: i64 = 5 * 60 * 1000;

const VALID_STATUSES: [&str; 3] = ["pending", "active", "archived"];

#[derive(Debug, Clone, Default)]
pub struct EntryFilters {
    pub is_root: Option<bool>,
    pub session_id: Option<String>,
    pub project_scope: Option<String>,
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub category: Option<Vec<String>>,
    pub status: Option<String>,
    pub exclude_statuses: Vec<String>,
    pub chunk_root_null: bool,
    pub limit: Option<usize>,
    pub offset: usize,
    pub sort: Option<String>,
    pub include_members: bool,
}

/// Roots (or leaves) matching the filters, duplicate roots whose representative
/// is in the same set removed before paging.
pub async fn retrieve_entries(db: &Db, filters: &EntryFilters) -> Result<Vec<Row>> {
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<P> = Vec::new();
    where_clauses.push(format!("is_root = ${}", params.len() + 1));
    params.push(P::I2(i16::from(filters.is_root.unwrap_or(true))));
    if let Some(sid) = filters.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        where_clauses.push(format!("session_id = ${}", params.len() + 1));
        params.push(P::T(sid.to_owned()));
    }
    if filters.project_scope.is_some() {
        append_project_scope(&mut where_clauses, &mut params, filters.project_scope.as_deref(), "project_id");
    }
    if let Some(from) = filters.ts_from {
        where_clauses.push(format!("ts >= ${}", params.len() + 1));
        params.push(P::I(from));
    }
    if let Some(to) = filters.ts_to {
        where_clauses.push(format!("ts <= ${}", params.len() + 1));
        params.push(P::I(to));
    }
    if let Some(categories) = &filters.category {
        let cats: Vec<String> =
            categories.iter().map(|c| js_trim(c).to_lowercase()).filter(|c| is_valid_category(c)).collect();
        if !cats.is_empty() {
            let ph = (0..cats.len()).map(|i| format!("${}", params.len() + 1 + i)).collect::<Vec<_>>().join(",");
            where_clauses.push(format!("category IN ({ph})"));
            params.extend(cats.into_iter().map(P::T));
        }
    }
    if let Some(status) = filters.status.as_deref().map(|s| js_trim(s).to_lowercase()).filter(|s| VALID_STATUSES.contains(&s.as_str())) {
        where_clauses.push(format!("status = ${}", params.len() + 1));
        params.push(P::T(status));
    }
    let excluded: Vec<String> = filters
        .exclude_statuses
        .iter()
        .map(|s| js_trim(s).to_lowercase())
        .filter(|s| VALID_STATUSES.contains(&s.as_str()))
        .collect();
    if !excluded.is_empty() {
        let ph = (0..excluded.len()).map(|i| format!("${}", params.len() + 1 + i)).collect::<Vec<_>>().join(",");
        where_clauses.push(format!("(status IS NULL OR status NOT IN ({ph}))"));
        params.extend(excluded.into_iter().map(P::T));
    }
    if filters.chunk_root_null {
        where_clauses.push("chunk_root IS NULL".to_owned());
    }
    let limit = filters.limit.unwrap_or(50).clamp(1, RECALL_WINDOW_CAP);
    let sort = js_trim(filters.sort.as_deref().unwrap_or("importance")).to_lowercase();
    let order_by = if sort == "date" {
        "ts DESC, source_turn DESC NULLS LAST, id DESC"
    } else {
        "score DESC NULLS LAST, ts DESC, id DESC"
    };
    params.push(P::I(limit as i64));
    params.push(P::I(filters.offset as i64));
    let sql = format!(
        "WITH eligible AS NOT MATERIALIZED (
                 SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source,
                        chunk_root, is_root, element, category, summary, project_id,
                        status, score, last_seen_at, duplicate_of
                 FROM entries
                 WHERE {}
               )
               SELECT candidate.* FROM eligible candidate
               WHERE candidate.is_root <> 1 OR candidate.duplicate_of IS NULL
                  OR NOT EXISTS (
                    SELECT 1 FROM eligible representative
                    WHERE representative.id = candidate.duplicate_of
                      AND representative.is_root = 1
                      AND representative.project_id IS NOT DISTINCT FROM candidate.project_id
                  )
               ORDER BY {order_by}
               LIMIT ${} OFFSET ${}",
        where_clauses.join(" AND "),
        params.len() - 1,
        params.len()
    );
    let mut rows = read_query(db, &sql, &params).await?;
    if sort == "date" {
        rows.sort_by(compare_newest_first);
    }
    if filters.include_members && !rows.is_empty() {
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let members = read_query(
            db,
            "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
       FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
       ORDER BY chunk_root, ts ASC, id ASC",
            &[P::IA(ids)],
        )
        .await?;
        let mut by_root: HashMap<i64, Vec<Row>> = HashMap::new();
        for mut member in members {
            let root = member.chunk_root.take().unwrap_or(0);
            by_root.entry(root).or_default().push(member);
        }
        for row in &mut rows {
            row.members = Some(by_root.remove(&row.id).unwrap_or_default());
        }
    }
    Ok(rows)
}

#[derive(Debug, Clone, Default)]
pub struct RawOptions {
    pub project_scope: Option<String>,
    pub session_id: Option<String>,
    pub terms: Vec<String>,
    pub min_hits: Option<usize>,
}

const RAW_TEXT_EXPR: &str = "lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))";

/// Newest unchunked turns inside a window, ranked by term evidence first when
/// terms are given. A failing read yields no rows.
pub async fn read_raw_rows_in_window(
    db: &Db,
    clock: &Clock,
    ts_from: Option<i64>,
    ts_to: Option<i64>,
    hard_limit: usize,
    options: &RawOptions,
) -> Vec<Row> {
    let mut where_clauses = vec!["chunk_root IS NULL".to_owned(), "is_root = 0".into(), "ts >= $1".into(), "ts <= $2".into()];
    let mut params = vec![P::I(ts_from.unwrap_or(0)), P::I(ts_to.unwrap_or(clock.now_ms))];
    let mut term_order = String::new();
    append_project_scope(&mut where_clauses, &mut params, options.project_scope.as_deref(), "project_id");
    if let Some(sid) = options.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        params.push(P::T(sid.to_owned()));
        where_clauses.push(format!("session_id = ${}", params.len()));
    }
    if !options.terms.is_empty() {
        let clauses: Vec<String> = options
            .terms
            .iter()
            .map(|term| {
                params.push(P::T(format!("%{term}%")));
                format!("(CASE WHEN {RAW_TEXT_EXPR} LIKE ${} THEN 1 ELSE 0 END)", params.len())
            })
            .collect();
        let default_min = if options.terms.len() >= 3 { 2 } else { 1 };
        let min_hits = options.min_hits.map_or(default_min, |m| m.max(1));
        let sum = clauses.join(" + ");
        where_clauses.push(format!("({sum}) >= {min_hits}"));
        term_order = format!("{sum} DESC, {}, ", clauses.iter().map(|c| format!("{c} DESC")).collect::<Vec<_>>().join(", "));
    }
    params.push(P::I(hard_limit as i64));
    let sql = format!(
        "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                element, category, summary, status, score, last_seen_at, project_id
         FROM entries
         WHERE {}
         ORDER BY {term_order}ts DESC, source_turn DESC NULLS LAST, id DESC
         LIMIT ${}",
        where_clauses.join(" AND "),
        params.len()
    );
    match query(db, &sql, &params).await {
        Ok(rows) => rows
            .into_iter()
            .map(|mut r| {
                r.retrieval_score = Some(0.0);
                r.rrf = Some(0.0);
                r
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Raw rows not already in `rows` (as a row or a member), merged newest-first.
pub fn merge_unseen_raw_rows(rows: Vec<Row>, raw: Vec<Row>, extra: Option<&dyn Fn(&Row) -> bool>) -> Vec<Row> {
    let mut seen: HashSet<i64> = HashSet::new();
    for row in &rows {
        seen.insert(row.id);
        seen.extend(row.member_list().iter().map(|m| m.id));
    }
    let new_raw: Vec<Row> = raw.into_iter().filter(|r| !seen.contains(&r.id)).filter(|r| extra.is_none_or(|f| f(r))).collect();
    if new_raw.is_empty() {
        return rows;
    }
    let mut merged = rows;
    merged.extend(new_raw);
    merged.sort_by(compare_newest_first);
    merged
}

pub fn row_matches_query_terms(row: &Row, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    if terms.iter().any(|t| search_haystack(row).contains(t.as_str())) {
        return true;
    }
    row.member_list().iter().any(|m| terms.iter().any(|t| search_haystack(m).contains(t.as_str())))
}

/// Query-less recall inside a window, newest first, grouped per session.
pub async fn browse_entries(db: &Db, clock: &Clock, args: &SearchArgs, plan: &SearchPlan) -> Result<String> {
    let window = plan.window();
    let filters = EntryFilters {
        limit: Some(plan.limit + plan.offset),
        ts_from: window.and_then(|w| w.start_ms),
        ts_to: window.and_then(|w| w.end_ms),
        project_scope: Some(plan.project_scope.clone()),
        category: plan.category.clone(),
        sort: Some(plan.sort.clone()),
        exclude_statuses: plan.exclude_statuses.clone(),
        include_members: plan.include_members,
        ..EntryFilters::default()
    };
    let rows = retrieve_entries(db, &filters).await?;
    let mut merged = rows;
    if plan.sort == "date" && plan.include_raw {
        let raw = read_raw_rows_in_window(
            db,
            clock,
            filters.ts_from.or(window.and_then(|w| w.start_ms)),
            filters.ts_to.or(window.and_then(|w| w.end_ms)),
            RECALL_WINDOW_CAP.min((plan.limit + plan.offset).max(20)),
            &RawOptions { project_scope: Some(plan.project_scope.clone()), ..RawOptions::default() },
        )
        .await;
        merged = merge_unseen_raw_rows(merged, raw, None);
    }
    let sliced: Vec<Row> = merged.into_iter().skip(plan.offset).take(plan.limit).collect();
    let body = render_session_grouped_lines(
        clock,
        &sliced,
        &[],
        &GroupedOptions {
            current_session_id: args.text("currentSessionId"),
            recency_order: plan.sort == "date",
            span_headers: false,
            preserve_source: plan.include_members || plan.include_raw,
            include_root_source: plan.include_members,
        },
    );
    Ok(format!("{}{body}", plan.cap_prefix))
}

// ---- period='last' -----------------------------------------------------------

fn requested_category_list(category: Option<&Vec<String>>) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    for c in category.into_iter().flatten() {
        let c = js_trim(c).to_lowercase();
        if is_valid_category(&c) && !list.contains(&c) {
            list.push(c);
        }
    }
    // Every public category is no filter at all.
    if list.len() == VALID_CATEGORIES.len() { Vec::new() } else { list }
}

pub struct LastCursorContext<'a> {
    pub query: &'a str,
    pub project_scope: &'a str,
    pub categories: &'a [String],
    pub include_archived: bool,
    pub include_members: bool,
    pub include_raw: bool,
}

impl LastCursorContext<'_> {
    fn json(&self) -> serde_json::Value {
        json!({
            "query": self.query,
            "projectScope": self.project_scope,
            "categories": self.categories,
            "includeArchived": self.include_archived,
            "includeMembers": self.include_members,
            "includeRaw": self.include_raw,
        })
    }
}

fn context_key(context: &serde_json::Value) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(context.to_string().as_bytes());
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    encoded.chars().take(16).collect()
}

fn encode_cursor(last_ts: i64, session_id: &str, context: &serde_json::Value) -> String {
    use base64::Engine;
    let payload = json!({ "v": 1, "t": last_ts, "s": session_id, "k": context_key(context) }).to_string();
    format!("r1.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload))
}

fn decode_cursor(value: &str, context: &serde_json::Value) -> Result<(i64, String)> {
    use base64::Engine;
    let invalid = || MemoryError::rejected("invalid recall cursor");
    let token = js_trim(value);
    let body = token.strip_prefix("r1.").ok_or_else(invalid)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).map_err(|_| invalid())?;
    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let ts = payload["t"].as_f64().filter(|t| t.is_finite());
    let sid = js_trim(payload["s"].as_str().unwrap_or_default()).to_owned();
    match ts {
        Some(ts) if payload["v"] == 1 && !sid.is_empty() && payload["k"] == context_key(context) => Ok((ts as i64, sid)),
        _ => Err(MemoryError::rejected("recall cursor does not match this query/scope")),
    }
}

async fn select_session_page(
    db: &Db,
    plan: &SearchPlan,
    args: &SearchArgs,
    session_count: usize,
    cat_list: &[String],
    context: &serde_json::Value,
) -> Result<(Vec<tokio_postgres::Row>, Option<String>)> {
    let mut sel_where = vec![
        "e.session_id IS NOT NULL".to_owned(),
        "btrim(e.session_id) <> ''".into(),
        if plan.include_raw { "(e.is_root = 1 OR e.chunk_root IS NULL OR e.chunk_root = e.id)".into() } else { "e.is_root = 1".into() },
    ];
    let mut sel_params: Vec<P> = Vec::new();
    let (scope_clause, scope_params) = project_scope_predicate(Some(&plan.project_scope), 1, "e.project_id");
    if !scope_clause.is_empty() {
        sel_where.push(scope_clause);
        sel_params.extend(scope_params);
    }
    if !cat_list.is_empty() {
        let ph = cat_list
            .iter()
            .map(|c| {
                sel_params.push(P::T(c.clone()));
                format!("${}", sel_params.len())
            })
            .collect::<Vec<_>>()
            .join(",");
        sel_where.push(format!("lower(coalesce(e.category, '')) IN ({ph})"));
    }
    if !plan.exclude_statuses.is_empty() {
        let ph = plan
            .exclude_statuses
            .iter()
            .map(|s| {
                sel_params.push(P::T(s.clone()));
                format!("${}", sel_params.len())
            })
            .collect::<Vec<_>>()
            .join(",");
        sel_where.push(format!("(e.status IS NULL OR e.status NOT IN ({ph}))"));
    }
    let cursor = match args.get("cursor").map(mixdog_js::value_to_string).filter(|c| !c.is_empty()) {
        Some(value) => Some(decode_cursor(&value, context)?),
        None => None,
    };
    let (first_ts, last_ts) = if plan.include_members {
        (
            "CASE WHEN e.is_root = 1
                              THEN coalesce(member_span.first_ts, e.ts)
                              ELSE e.ts END",
            "CASE WHEN e.is_root = 1
                             THEN coalesce(member_span.last_ts, e.ts)
                             ELSE e.ts END",
        )
    } else {
        ("e.ts", "e.ts")
    };
    let mut cursor_having = String::new();
    if let Some((ts, sid)) = &cursor {
        sel_params.push(P::I(*ts));
        sel_params.push(P::T(sid.clone()));
        let (ts_param, sid_param) = (format!("${}", sel_params.len() - 1), format!("${}", sel_params.len()));
        cursor_having = format!(
            "HAVING (MAX({last_ts}) < {ts_param}
                          OR (MAX({last_ts}) = {ts_param} AND e.session_id < {sid_param}))"
        );
    }
    sel_params.push(P::I(session_count as i64 + 1));
    sel_params.push(P::I(if cursor.is_some() { 0 } else { plan.offset as i64 }));
    let sql = format!(
        "SELECT e.session_id,
                              MIN({first_ts}) AS first_ts,
                              MAX({last_ts}) AS last_ts
                       FROM entries e
                       LEFT JOIN LATERAL (
                         SELECT MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
                         FROM entries m
                         WHERE e.is_root = 1 AND m.is_root = 0 AND m.chunk_root = e.id
                       ) member_span ON true
                       WHERE {}
                       GROUP BY e.session_id
                       {cursor_having}
                       ORDER BY last_ts DESC, e.session_id DESC
                       LIMIT ${} OFFSET ${}",
        sel_where.join(" AND "),
        sel_params.len() - 1,
        sel_params.len()
    );
    let selected = query_pg(db, &sql, &sel_params).await?;
    let has_more = selected.len() > session_count;
    let page: Vec<tokio_postgres::Row> = selected.into_iter().take(session_count).collect();
    let next = match (has_more, page.last()) {
        (true, Some(last)) => Some(encode_cursor(last.get::<_, i64>("last_ts"), &last.get::<_, String>("session_id"), context)),
        _ => None,
    };
    Ok((page, next))
}

async fn session_raw_rows(
    db: &Db,
    clock: &Clock,
    sid: &str,
    project_scope: &str,
    query_terms: &[String],
    fetch_cap: usize,
) -> Vec<Row> {
    let base = RawOptions { project_scope: Some(project_scope.to_owned()), session_id: Some(sid.to_owned()), ..RawOptions::default() };
    if query_terms.is_empty() {
        return read_raw_rows_in_window(db, clock, None, None, fetch_cap, &base).await;
    }
    let matched = RawOptions { terms: query_terms.to_vec(), min_hits: Some(1), ..base.clone() };
    let (recent, matched) = tokio::join!(
        read_raw_rows_in_window(db, clock, None, None, fetch_cap, &base),
        read_raw_rows_in_window(db, clock, None, None, fetch_cap, &matched)
    );
    let mut seen = HashSet::new();
    recent.into_iter().chain(matched).filter(|r| seen.insert(r.id)).collect()
}

async fn fill_session(
    db: &Db,
    clock: &Clock,
    plan: &SearchPlan,
    sid: &str,
    query_terms: &[String],
    cat_list: &[String],
) -> Result<(Vec<Row>, usize, bool)> {
    let fetch_cap = if query_terms.is_empty() { PER_SESSION_ROW_CAP } else { PER_SESSION_SEARCH_CAP };
    let filters = EntryFilters {
        limit: Some(fetch_cap),
        session_id: Some(sid.to_owned()),
        project_scope: Some(plan.project_scope.clone()),
        sort: Some("date".into()),
        include_members: plan.include_members,
        exclude_statuses: plan.exclude_statuses.clone(),
        category: (!cat_list.is_empty()).then(|| cat_list.to_vec()),
        ..EntryFilters::default()
    };
    let rows = retrieve_entries(db, &filters).await?;
    let mut merged = rows;
    if plan.include_raw {
        let raw = session_raw_rows(db, clock, sid, &plan.project_scope, query_terms, fetch_cap).await;
        let passes = |r: &Row| {
            if !cat_list.is_empty() && !cat_list.contains(&js_trim(r.category.as_deref().unwrap_or_default()).to_lowercase()) {
                return false;
            }
            let status = js_trim(r.status.as_deref().unwrap_or_default()).to_lowercase();
            plan.exclude_statuses.is_empty() || status.is_empty() || !plan.exclude_statuses.contains(&status)
        };
        merged = merge_unseen_raw_rows(merged, raw, Some(&passes));
    }
    let fetched = merged.len();
    let mut query_filtered = false;
    if !query_terms.is_empty() {
        let newest: Vec<Row> = merged.iter().take(3).cloned().collect();
        let newest_ids: HashSet<i64> = newest.iter().map(|r| r.id).collect();
        let matched: Vec<Row> = merged.iter().filter(|r| row_matches_query_terms(r, query_terms)).cloned().collect();
        merged = newest.into_iter().chain(matched.into_iter().filter(|r| !newest_ids.contains(&r.id))).collect();
        query_filtered = merged.len() < fetched;
    }
    merged.truncate(PER_SESSION_ROW_CAP);
    Ok((merged, fetched, query_filtered))
}

/// `period='last'`: the most recently active sessions, each with its newest rows.
pub async fn browse_last_sessions(db: &Db, clock: &Clock, args: &SearchArgs, plan: &SearchPlan) -> Result<(String, Option<String>)> {
    let session_count = if plan.requested_limit.is_some() { plan.limit } else { 5 };
    let query_terms = session_recall_terms(&plan.query);
    let cat_list = requested_category_list(plan.category.as_ref());
    let context = LastCursorContext {
        query: &plan.query,
        project_scope: &plan.project_scope,
        categories: &cat_list,
        include_archived: plan.include_archived,
        include_members: plan.include_members,
        include_raw: plan.include_raw,
    }
    .json();
    let (sessions, next_cursor) = select_session_page(db, plan, args, session_count, &cat_list, &context).await?;
    let mut all_rows = Vec::new();
    let mut meta: Vec<(String, SessionMeta)> = Vec::new();
    for session in &sessions {
        let sid = js_trim(&session.get::<_, String>("session_id")).to_owned();
        if sid.is_empty() {
            continue;
        }
        let (rows, fetched, query_filtered) = fill_session(db, clock, plan, &sid, &query_terms, &cat_list).await?;
        meta.push((
            sid,
            SessionMeta {
                min_ts: session.get::<_, i64>("first_ts"),
                max_ts: session.get::<_, i64>("last_ts"),
                fetched_count: fetched,
                shown_count: rows.len(),
                query_filtered,
            },
        ));
        all_rows.extend(rows);
    }
    let cursor_prefix = next_cursor.as_ref().map(|c| format!("[nextCursor: {c}]\n")).unwrap_or_default();
    let body = render_session_grouped_lines(
        clock,
        &all_rows,
        &meta,
        &GroupedOptions {
            current_session_id: args.text("currentSessionId"),
            recency_order: true,
            span_headers: true,
            preserve_source: plan.include_members || plan.include_raw,
            include_root_source: plan.include_members,
        },
    );
    Ok((format!("{}{cursor_prefix}{body}", plan.cap_prefix), next_cursor))
}

// ---- current session ---------------------------------------------------------

const SESSION_ENTRY_COLUMNS: &str = "id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
             element, category, summary, chunk_quality, status, score, last_seen_at, project_id";
const SESSION_TEXT_EXPR: &str = "lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))";
const BROWSABLE_ROW: &str = "(is_root = 1 OR chunk_root IS NULL OR chunk_root = id)";

async fn find_in_flight_turn(db: &Db, clock: &Clock, session_id: &str) -> Option<i32> {
    let rows = query_pg(
        db,
        "SELECT source_turn t, MAX(ts) last_ts FROM entries
           WHERE session_id = $1 AND chunk_root IS NULL
           GROUP BY source_turn ORDER BY source_turn DESC LIMIT 1",
        &[P::T(session_id.to_owned())],
    )
    .await
    .ok()?;
    let row = rows.first()?;
    let turn: Option<i32> = row.get("t");
    let last_ts: Option<i64> = row.get("last_ts");
    match (turn, last_ts) {
        (Some(t), Some(ts)) if clock.now_ms - ts <= IN_FLIGHT_TURN_FRESHNESS_MS => Some(t),
        _ => None,
    }
}

fn exclude_turn(where_clauses: &mut Vec<String>, params: &mut Vec<P>, turn: Option<i32>) {
    let Some(turn) = turn else { return };
    params.push(P::I4(turn));
    where_clauses.push(format!("NOT (chunk_root IS NULL AND source_turn = ${})", params.len()));
}

async fn select_session_entries(db: &Db, where_clauses: &[String], mut params: Vec<P>, limit: Option<usize>) -> Result<Vec<Row>> {
    let limit_clause = match limit {
        Some(limit) => {
            params.push(P::I(limit as i64));
            format!("LIMIT ${}", params.len())
        }
        None => String::new(),
    };
    query(
        db,
        &format!(
            "SELECT {SESSION_ENTRY_COLUMNS}
        FROM entries
        WHERE {}
        ORDER BY ts DESC, source_turn DESC NULLS LAST, id DESC
        {limit_clause}",
            where_clauses.join(" AND ")
        ),
        &params,
    )
    .await
}

async fn select_session_page_rows(
    db: &Db,
    session_id: &str,
    terms: &[String],
    exclude_turn_value: Option<i32>,
    fetch_limit: Option<usize>,
) -> Result<Vec<Row>> {
    let mut params = vec![P::T(session_id.to_owned())];
    let mut where_clauses = vec!["session_id = $1".to_owned(), BROWSABLE_ROW.to_owned()];
    exclude_turn(&mut where_clauses, &mut params, exclude_turn_value);
    if !terms.is_empty() {
        let clauses: Vec<String> = terms
            .iter()
            .map(|term| {
                params.push(P::T(format!("%{term}%")));
                format!("{SESSION_TEXT_EXPR} LIKE ${}", params.len())
            })
            .collect();
        where_clauses.push(format!("({})", clauses.join(" OR ")));
    }
    let mut rows = select_session_entries(db, &where_clauses, params, fetch_limit).await?;
    if let Some(limit) = fetch_limit.filter(|limit| rows.len() < *limit) {
        let seen: Vec<i64> = rows.iter().map(|r| r.id).collect();
        let fill_limit = limit - rows.len();
        let mut fill_where = vec!["session_id = $1".to_owned(), "id <> ALL($2::bigint[])".into(), BROWSABLE_ROW.to_owned()];
        let mut fill_params = vec![P::T(session_id.to_owned()), P::IA(seen)];
        exclude_turn(&mut fill_where, &mut fill_params, exclude_turn_value);
        if fill_limit > 0 {
            rows.extend(select_session_entries(db, &fill_where, fill_params, Some(fill_limit)).await?);
        }
    }
    Ok(rows)
}

async fn attach_root_members_by_turn(db: &Db, rows: &mut [Row]) -> Result<()> {
    let root_ids: Vec<i64> = rows.iter().filter(|r| r.is_root == 1).map(|r| r.id).collect();
    if root_ids.is_empty() {
        return Ok(());
    }
    let members = query(
        db,
        "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
          FROM entries
          WHERE chunk_root = ANY($1::bigint[])
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC",
        &[P::IA(root_ids.clone())],
    )
    .await?;
    let mut by_root: HashMap<i64, Vec<Row>> = root_ids.iter().map(|id| (*id, Vec::new())).collect();
    for member in members {
        if let Some(list) = by_root.get_mut(&member.chunk_root.unwrap_or(0)) {
            list.push(member);
        }
    }
    for row in rows {
        if let Some(list) = by_root.remove(&row.id) {
            row.members = Some(list);
        }
    }
    Ok(())
}

pub struct SessionOptions<'a> {
    pub estimate_tokens: &'a (dyn Fn(&str) -> u64 + Sync),
}

/// Roots and unchunked leaves of one session, newest first, as a page, a
/// compaction digest or a compact handoff timeline.
pub async fn recall_session_rows(db: &Db, clock: &Clock, args: &SearchArgs, options: &SessionOptions<'_>) -> Result<String> {
    let session_id = {
        let sid = args.text("sessionId");
        if sid.is_empty() { args.text("session_id") } else { sid }
    };
    if session_id.is_empty() {
        return Ok("(no current session)".to_owned());
    }
    let limit = {
        let n = crate::memory::recall::plan::js_number(args.raw.get("limit"));
        (if n.is_finite() && n != 0.0 { n } else { 20.0 }).clamp(1.0, 100.0).floor() as usize
    };
    let compact_digest = args.flag("compactDigest");
    let compact_handoff = args.flag("compactHandoff");
    let fetch_limit = if compact_handoff {
        None
    } else if compact_digest {
        Some(100.min(limit.max(limit * 4)))
    } else {
        Some(limit)
    };
    let terms = session_recall_terms(&args.text("query"));
    let exclude = if !compact_digest && !compact_handoff && terms.is_empty() {
        find_in_flight_turn(db, clock, &session_id).await
    } else {
        None
    };
    let mut rows = select_session_page_rows(db, &session_id, &terms, exclude, fetch_limit).await?;
    if args.flag("includeMembers") || compact_handoff {
        attach_root_members_by_turn(db, &mut rows).await?;
    }
    if compact_handoff {
        let keep = crate::memory::recall::plan::js_number(args.raw.get("preserveLatestUserTurns"));
        rows = crate::memory::recall::compact::compact_handoff_rows(rows, if keep.is_finite() { keep.max(0.0).floor() as usize } else { 0 }, options.estimate_tokens);
    } else if compact_digest {
        rows = compact_digest_rows(rows, limit);
    }
    Ok(render_entry_lines(
        clock,
        &rows,
        &RenderOptions {
            pending_marks: !compact_digest && !compact_handoff,
            chronological_order: compact_handoff,
            compact_timestamps: compact_handoff,
            max_body_chars: if compact_handoff { None } else { Some(8000) },
            preserve_source: args.flag("includeMembers") || args.flag("includeRaw"),
            include_root_source: !compact_handoff && args.flag("includeMembers"),
            ..RenderOptions::default()
        },
    ))
}

// ---- #id lookup ----------------------------------------------------------------

/// Rows named by `#id`, with the members of any root, in the caller's order.
pub async fn search_by_ids(
    db: &Db,
    clock: &Clock,
    args: &SearchArgs,
    ids: &[i64],
    resolved_scope: Option<&str>,
) -> Result<String> {
    let ids: Vec<i64> = ids.iter().copied().filter(|id| *id > 0).collect();
    if ids.is_empty() {
        return Ok("(no valid ids)".to_owned());
    }
    let include_archived = args.raw.get("includeArchived") != Some(&serde_json::Value::Bool(false));
    let period = args.text("period");
    let temporal = crate::memory::recall::period::parse_period(clock, &period, false);
    let window = match temporal {
        Some(crate::memory::recall::period::Temporal::Window(w)) => Some(w),
        _ => None,
    };
    let project_scope = resolve_query_project_scope(args, resolved_scope);
    let exclude: Vec<String> = if include_archived { Vec::new() } else { vec!["archived".to_owned()] };
    let categories = args.categories().unwrap_or_default();
    let (clause, params) = scope_filter(
        2,
        &ScopeOptions {
            ts_from: window.and_then(|w| w.start_ms),
            ts_to: window.and_then(|w| w.end_ms),
            exclude_statuses: &exclude,
            categories: &categories,
            project_scope: Some(&project_scope),
        },
        "",
    );
    let mut all = vec![P::IA(ids.clone())];
    all.extend(params);
    let mut rows = read_query(
        db,
        &format!(
            "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
            element, category, summary, project_id, status, score, last_seen_at
     FROM entries WHERE id = ANY($1::bigint[]) {clause}"
        ),
        &all,
    )
    .await?;
    if rows.is_empty() {
        return Ok("(no results)".to_owned());
    }
    let root_ids: Vec<i64> = rows.iter().filter(|r| r.is_root == 1).map(|r| r.id).collect();
    let mut member_leaf_ids: HashSet<i64> = HashSet::new();
    if !root_ids.is_empty() {
        let members = query(
            db,
            "SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root
     FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
     ORDER BY ts ASC, id ASC",
            &[P::IA(root_ids)],
        )
        .await?;
        let mut by_root: HashMap<i64, Vec<Row>> = HashMap::new();
        for member in members {
            member_leaf_ids.insert(member.id);
            by_root.entry(member.chunk_root.unwrap_or(0)).or_default().push(member);
        }
        for row in rows.iter_mut().filter(|r| r.is_root == 1) {
            row.members = Some(by_root.remove(&row.id).unwrap_or_default());
        }
    }
    let by_id: HashMap<i64, &Row> = rows.iter().map(|r| (r.id, r)).collect();
    let ordered: Vec<Row> = ids
        .iter()
        .filter_map(|id| by_id.get(id).map(|r| (*r).clone()))
        .filter(|r| !(r.is_root == 0 && member_leaf_ids.contains(&r.id)))
        .collect();
    Ok(render_entry_lines(
        clock,
        &ordered,
        &RenderOptions { preserve_source: true, include_root_source: true, ..RenderOptions::default() },
    ))
}

// ---- core memory leg -----------------------------------------------------------

const CORE_STOPWORDS: [&str; 14] = [
    "about", "after", "again", "before", "check", "color", "decision", "decided", "earlier", "memory", "previous",
    "routing", "stored", "tell",
];

fn core_recall_terms(query: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    crate::memory::query_terms::tokenize_recall_query(query, 12)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .filter(|t| utf16_len(t) >= 3 || t.chars().any(|c| ('\u{AC00}'..='\u{D7AF}').contains(&c)) || t.contains(['_', '.', '/', ':', '-']))
        .filter(|t| !CORE_STOPWORDS.contains(&t.as_str()))
        .take(8)
        .collect()
}

#[derive(Debug, Clone, Default)]
pub struct CoreOptions {
    pub project_scope: Option<String>,
    pub category: Option<Vec<String>>,
    pub limit: usize,
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub agent_id: String,
}

/// Active core entries containing the query terms, shaped like root rows.
pub async fn recall_core_rows(db: &Db, clock: &Clock, query_text: &str, options: &CoreOptions) -> Result<Vec<Row>> {
    let terms = core_recall_terms(query_text);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    const TS_EXPR: &str = "COALESCE(updated_at, created_at)";
    const TEXT_EXPR: &str = "lower(coalesce(element, '') || ' ' || coalesce(summary, ''))";
    let mut params: Vec<P> = Vec::new();
    let mut where_clauses: Vec<String> = Vec::new();
    if options.agent_id.is_empty() {
        where_clauses.push("agent_id IS NULL".to_owned());
    } else {
        params.push(P::T(options.agent_id.clone()));
        where_clauses.push(format!("(agent_id IS NULL OR agent_id = ${})", params.len()));
    }
    let scope = {
        let raw = js_trim(options.project_scope.as_deref().filter(|s| !s.is_empty()).unwrap_or("common")).to_owned();
        if raw.is_empty() || (raw.to_lowercase() == "common") {
            "common".to_owned()
        } else if (raw.to_lowercase() == "all") {
            "all".to_owned()
        } else {
            raw
        }
    };
    append_project_scope(&mut where_clauses, &mut params, Some(&scope), "project_id");
    if let Some(categories) = &options.category {
        let cats: Vec<String> = categories.iter().map(|c| js_trim(c).to_lowercase()).filter(|c| !c.is_empty()).collect();
        if !cats.is_empty() {
            let ph = cats
                .iter()
                .map(|c| {
                    params.push(P::T(c.clone()));
                    format!("${}", params.len())
                })
                .collect::<Vec<_>>()
                .join(", ");
            where_clauses.push(format!("category IN ({ph})"));
        }
    }
    if let Some(from) = options.ts_from {
        params.push(P::I(from));
        where_clauses.push(format!("{TS_EXPR} >= ${}", params.len()));
    }
    if let Some(to) = options.ts_to {
        params.push(P::I(to));
        where_clauses.push(format!("{TS_EXPR} <= ${}", params.len()));
    }
    let term_clauses: Vec<String> = terms
        .iter()
        .map(|term| {
            params.push(P::T(format!("%{term}%")));
            format!("{TEXT_EXPR} LIKE ${}", params.len())
        })
        .collect();
    where_clauses.push(format!("({})", term_clauses.join(" OR ")));
    let hit_expr = term_clauses.iter().map(|c| format!("CASE WHEN {c} THEN 1 ELSE 0 END")).collect::<Vec<_>>().join(" + ");
    let row_limit = if options.limit == 0 { 5 } else { options.limit.clamp(1, 10) };
    params.push(P::I(row_limit as i64));
    let rows = query_pg(
        db,
        &format!(
            "SELECT id, element, summary, category, project_id, created_at, updated_at,
             ({hit_expr}) AS hit_count
      FROM core_entries
      WHERE {}
        AND (status IS NULL OR status = 'active')
      ORDER BY hit_count DESC, updated_at DESC, id ASC
      LIMIT ${}",
            where_clauses.join(" AND "),
            params.len()
        ),
        &params,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let updated: i64 = row.get("updated_at");
            let created: i64 = row.get("created_at");
            Row {
                id: -row.get::<_, i64>("id"),
                core: true,
                ts: if updated != 0 { updated } else if created != 0 { created } else { clock.now_ms },
                element: row.get("element"),
                summary: row.get("summary"),
                category: row.get("category"),
                project_id: row.get("project_id"),
                is_root: 1,
                ..Row::default()
            }
        })
        .collect())
}

// ---- event context ---------------------------------------------------------------

const EVENT_TAIL_ROWS: i64 = 1;

struct Anchor {
    order: usize,
    id: i64,
    session_id: String,
    turn: Option<i64>,
    ts: i64,
}

fn anchor_point(row: &Row) -> (Option<i64>, i64) {
    let members = row.member_list();
    let candidates: Vec<&Row> = if members.is_empty() { vec![row] } else { members.iter().collect() };
    let mut best: Option<(Option<i64>, i64)> = None;
    for candidate in candidates {
        let turn = i64::from(candidate.source_turn.unwrap_or(0));
        let ts = candidate.ts;
        let better = match best {
            None => true,
            Some((best_turn, best_ts)) => turn > best_turn.unwrap_or(i64::MIN) || (Some(turn) == best_turn && ts > best_ts),
        };
        if better {
            best = Some((Some(turn), ts));
        }
    }
    best.unwrap_or((None, row.ts))
}

/// Ranked rows interleaved with the latest tail row of each anchor's event.
pub fn merge_event_rows(ranked: &[Row], tails: &[Row], dedupe_events: bool) -> Vec<Row> {
    if ranked.is_empty() {
        return Vec::new();
    }
    let mut tails_by_anchor: HashMap<i32, Vec<&Row>> = HashMap::new();
    for tail in tails {
        if let Some(order) = tail.anchor_order.filter(|o| *o >= 0) {
            tails_by_anchor.entry(order).or_default().push(tail);
        }
    }
    let mut emitted: HashSet<i64> = HashSet::new();
    let mut emitted_events: HashSet<String> = HashSet::new();
    let mut out: Vec<Row> = Vec::new();
    let mut emit = |row: Row, out: &mut Vec<Row>| {
        if emitted.contains(&row.id) {
            return;
        }
        emitted.insert(row.id);
        out.push(row);
    };
    for (index, anchor) in ranked.iter().enumerate() {
        let tails: Vec<&Row> = tails_by_anchor.get(&(index as i32)).map(|t| t.iter().copied().take(EVENT_TAIL_ROWS as usize).collect()).unwrap_or_default();
        let event_key = tails.first().and_then(|t| t.event_key.clone()).unwrap_or_default();
        if dedupe_events && !event_key.is_empty() && emitted_events.contains(&event_key) {
            continue;
        }
        if dedupe_events && !event_key.is_empty() {
            emitted_events.insert(event_key);
        }
        for (tail_index, tail) in tails.into_iter().enumerate() {
            let mut tail = tail.clone();
            if tail_index == 0 && anchor.is_root == 1 {
                tail.historical_root_element = anchor.element.clone();
                tail.historical_root_summary = anchor.summary.clone();
            }
            emit(tail, &mut out);
        }
        emit(anchor.clone(), &mut out);
    }
    out
}

pub struct EventContext<'a> {
    pub query: &'a str,
    pub limit: usize,
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub exclude_statuses: &'a [String],
    pub project_scope: Option<&'a str>,
    pub dedupe_events: bool,
}

/// Adds, after each ranked anchor, the newest non-root turn of its event.
pub async fn expand_event_context(db: &Db, ranked: Vec<Row>, context: &EventContext<'_>) -> Result<Vec<Row>> {
    let anchor_limit = context.limit.max(1);
    let mut anchors: Vec<Anchor> = Vec::new();
    for (index, row) in ranked.iter().enumerate() {
        let sid = js_trim(row.session());
        if sid.is_empty() {
            continue;
        }
        let (turn, ts) = anchor_point(row);
        anchors.push(Anchor { order: index, id: row.id, session_id: sid.to_owned(), turn, ts });
        if anchors.len() >= anchor_limit {
            break;
        }
    }
    if anchors.is_empty() {
        return Ok(ranked);
    }
    let normalized = js_trim(context.query).to_lowercase();
    let (clause, params) = scope_filter(
        3,
        &ScopeOptions {
            ts_from: context.ts_from,
            ts_to: context.ts_to,
            exclude_statuses: context.exclude_statuses,
            categories: &[],
            project_scope: context.project_scope,
        },
        "e",
    );
    let anchors_json: Vec<serde_json::Value> = anchors
        .iter()
        .map(|a| json!({ "anchor_order": a.order, "anchor_id": a.id, "session_id": a.session_id, "anchor_turn": a.turn, "anchor_ts": a.ts }))
        .collect();
    let mut all = vec![P::J(serde_json::Value::Array(anchors_json)), P::T(normalized)];
    all.extend(params);
    let rows = read_query(
        db,
        &format!(
            "
    WITH anchors AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS a(
        anchor_order integer,
        anchor_id bigint,
        session_id text,
        anchor_turn integer,
        anchor_ts bigint
      )
    ),
    bounded AS MATERIALIZED (
      SELECT a.*,
             (
               SELECT MIN(next_row.source_turn)
               FROM entries next_row
               WHERE next_row.session_id = a.session_id
                 AND next_row.role = 'user'
                 AND a.anchor_turn IS NOT NULL
                 AND next_row.source_turn > a.anchor_turn
             ) AS next_user_turn,
             (
               SELECT MIN(next_row.ts)
               FROM entries next_row
               WHERE next_row.session_id = a.session_id
                 AND next_row.role = 'user'
                 AND next_row.ts > a.anchor_ts
             ) AS next_user_ts
      FROM anchors a
    ),
    ranked_event_rows AS (
      SELECT b.anchor_order AS _anchor_order,
             CONCAT(
               b.session_id,
               ':',
               CASE
                 WHEN b.anchor_turn IS NOT NULL THEN COALESCE(b.next_user_turn::text, 'open')
                 ELSE COALESCE(b.next_user_ts::text, 'open')
               END
             ) AS _event_key,
             e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
             e.source_turn, e.time_source, e.chunk_root, e.is_root,
             e.element, e.category, e.summary, e.status, e.score,
             e.last_seen_at, e.project_id,
             ROW_NUMBER() OVER (
               PARTITION BY b.anchor_order
               ORDER BY e.ts DESC, e.source_turn DESC NULLS LAST, e.id DESC
             ) AS event_rank
      FROM bounded b
      JOIN entries e ON e.session_id = b.session_id
      WHERE (
          (
            b.anchor_turn IS NOT NULL
            AND e.source_turn >= b.anchor_turn
            AND (b.next_user_turn IS NULL OR e.source_turn < b.next_user_turn)
          )
          OR (
            b.anchor_turn IS NULL
            AND e.ts >= b.anchor_ts
            AND (b.next_user_ts IS NULL OR e.ts < b.next_user_ts)
          )
        )
        AND e.is_root = 0
        AND ($2::text = '' OR lower(btrim(e.content)) <> $2)
        {clause}
    )
    SELECT _anchor_order, _event_key, id, ts, role, content, source_ref, session_id, source_turn,
           time_source, chunk_root, is_root, element, category, summary,
           status, score, last_seen_at, project_id
    FROM ranked_event_rows
    WHERE event_rank <= {EVENT_TAIL_ROWS}
    ORDER BY _anchor_order ASC, event_rank ASC
  "
        ),
        &all,
    )
    .await?;
    Ok(merge_event_rows(&ranked, &rows, context.dedupe_events))
}
