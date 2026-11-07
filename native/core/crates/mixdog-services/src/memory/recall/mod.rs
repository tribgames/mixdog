//! `recall` / `search_memories`: hybrid (lexical + semantic) search over the
//! generated history, `#id` lookups, query-less browses, the session-grouped
//! `last` browse and current-session recall. The text a model reads is
//! assembled here exactly as callers have always seen it.

pub mod browse;
pub mod compact;
pub mod filters;
pub mod format;
pub mod hybrid;
pub mod period;
pub mod plan;
pub mod ranking;
pub mod row;
pub mod store;

use mixdog_js::{js_trim, value_to_string};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::task::JoinSet;

use crate::memory::core::access::MemoryCaller;
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;
use crate::memory::project::resolve_project_scope;
use crate::memory::recall::browse::{
    CoreOptions, EntryFilters, EventContext, RawOptions, SessionOptions, browse_entries, browse_last_sessions,
    expand_event_context, read_raw_rows_in_window, recall_core_rows, recall_session_rows, retrieve_entries,
    search_by_ids,
};
use crate::memory::recall::format::{RenderOptions, collapse_near_duplicate_rows, interleave_raw_rows, render_entry_lines, search_haystack};
use crate::memory::recall::hybrid::{SearchOptions, search_relevant_hybrid};
use crate::memory::recall::period::Clock;
use crate::memory::recall::plan::{RECALL_LIMIT_CAP, SearchArgs, SearchPlan, js_number, resolve_search_plan};
use crate::memory::recall::ranking::{
    annotate_root_context, bound_rows_to_temporal, collapse_history_duplicates, has_vague_latest_work_intent,
    is_semantic_only, latest_recall_topic_terms, merge_historical_rows, preserve_latest_concept_rows,
    prioritize_historical_root_evidence, rank_latest_rows, sample_timeline, session_recall_terms, topic_term_coverage,
};
use crate::memory::recall::row::{Row, by_diff, compare_by_score, compare_newest_first, unique_rows_by_id};

/// Largest recall text handed to a model.
pub const RECALL_OUTPUT_MAX_BYTES: usize = 20 * 1024;
const FAN_OUT_QUERIES_CAP: usize = 5;
const FAN_OUT_DEADLINE: Duration = Duration::from_secs(180);

/// The vector of a recall query, when the embedding model can answer in time.
#[async_trait]
pub trait QueryEmbedder: Send + Sync {
    async fn query_vector(&self, text: &str) -> Option<Vec<f32>>;
}

/// A recall that hit a stored entry, for the trace store.
#[derive(Debug, Clone)]
pub struct RecallTrace {
    pub query: String,
    pub top_entry_id: i64,
    pub hit_count: usize,
}

pub type TraceSink = Arc<dyn Fn(RecallTrace) + Send + Sync>;

pub struct RecallDeps {
    pub db: Db,
    pub clock: Arc<dyn Fn() -> Clock + Send + Sync>,
    pub embedder: Option<Arc<dyn QueryEmbedder>>,
    /// Working directory of the calling session, for project classification.
    pub session_cwd: Option<PathBuf>,
    /// The lane project marker files are read on.
    pub lane: mixdog_rt::DurabilityIo,
    /// Token estimate used to judge whether a summary is shorter than its source.
    pub estimate_tokens: Arc<dyn Fn(&str) -> u64 + Send + Sync>,
    pub trace: Option<TraceSink>,
}

/// The result of one recall call.
#[derive(Debug, Clone)]
pub struct RecallOutcome {
    pub text: String,
    /// Present (possibly null) only for the `last` browse.
    pub next_cursor: Option<Option<String>>,
    pub is_error: bool,
}

impl RecallOutcome {
    fn ok(text: String) -> Self {
        Self { text, next_cursor: None, is_error: false }
    }

    /// The JSON text of the tool result.
    pub fn envelope(&self) -> String {
        let text = serde_json::to_string(&self.text).unwrap_or_default();
        let content = format!("[{{\"type\":\"text\",\"text\":{text}}}]");
        if self.is_error {
            return format!("{{\"content\":{content},\"isError\":true}}");
        }
        let cursor = match &self.next_cursor {
            Some(cursor) => format!(",\"nextCursor\":{}", serde_json::to_string(cursor).unwrap_or_default()),
            None => String::new(),
        };
        format!("{{\"text\":{text}{cursor},\"content\":{content},\"isError\":false}}")
    }
}

#[derive(Clone)]
pub struct Recall {
    deps: Arc<RecallDeps>,
}

fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = max_bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn format_cap_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} bytes");
    }
    let kb = bytes as f64 / 1024.0;
    if kb.fract() == 0.0 { format!("{} KB", kb as usize) } else { format!("{kb:.1} KB") }
}

fn cap_marker(limit: usize, shown: &str) -> String {
    format!(
        "[output capped at {}; {shown}; narrow: narrow query[]/category/period, lower limit, or page with the cursor/offset shown in the results]",
        format_cap_size(limit)
    )
}

/// Complete leading lines that fit `max_bytes` together with a continuation footer.
pub fn cap_recall_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let footer = |kept: usize| cap_marker(max_bytes, &format!("{kept} of {} lines shown", lines.len()));
    let (mut lo, mut hi) = (0usize, lines.len());
    let mut best = String::new();
    loop {
        if lo > hi {
            break;
        }
        let mid = (lo + hi) / 2;
        let kept = &lines[..mid];
        let candidate = format!("{}{}{}", kept.join("\n"), if kept.is_empty() { "" } else { "\n" }, footer(mid));
        if candidate.len() <= max_bytes {
            best = candidate;
            lo = mid + 1;
        } else {
            if mid == 0 {
                break;
            }
            hi = mid - 1;
        }
    }
    if !best.is_empty() { best } else { utf8_prefix(&footer(0), max_bytes).to_owned() }
}

fn id_values(value: &Value) -> Vec<i64> {
    let items: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    items
        .into_iter()
        .map(|v| js_number(Some(v)))
        .filter(|n| n.fract() == 0.0 && n.is_finite() && *n > 0.0)
        .map(|n| n as i64)
        .collect()
}

/// The arguments `recall` forwards to the search: every advertised argument,
/// and ids only when no query is given.
fn recall_search_args(a: &Value) -> Value {
    let query_present = match a.get("query") {
        Some(Value::Array(items)) => items.iter().any(|v| !js_trim(&value_to_string(v)).is_empty()),
        Some(Value::Null) | None => false,
        Some(other) => !js_trim(&value_to_string(other)).is_empty(),
    };
    let ids = if query_present { Vec::new() } else { a.get("id").map(id_values).unwrap_or_default() };
    let truthy = |key: &str| a.get(key).is_some_and(|v| !matches!(v, Value::Null | Value::Bool(false)) && v != "" && v != 0);
    let mut out = serde_json::Map::new();
    if let Some(query) = a.get("query") {
        out.insert("query".into(), query.clone());
    }
    if !ids.is_empty() {
        out.insert("ids".into(), json!(ids));
    }
    for key in ["period"] {
        if truthy(key) {
            out.insert(key.into(), a[key].clone());
        }
    }
    for key in ["limit", "offset"] {
        if let Some(v) = a.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if truthy("cursor") {
        out.insert("cursor".into(), a["cursor"].clone());
    }
    for key in ["sort", "category", "includeArchived", "includeMembers", "includeRaw"] {
        if let Some(v) = a.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["cwd", "projectScope", "sessionId", "session_id"] {
        if truthy(key) {
            out.insert(key.into(), a[key].clone());
        }
    }
    if let Some(v) = a.get("currentSession") {
        out.insert("currentSession".into(), v.clone());
    }
    for key in ["currentSessionId", "memory_caller"] {
        if truthy(key) {
            out.insert(key.into(), a[key].clone());
        }
    }
    Value::Object(out)
}

impl Recall {
    pub fn new(deps: RecallDeps) -> Self {
        Self { deps: Arc::new(deps) }
    }

    fn clock(&self) -> Clock {
        (self.deps.clock)()
    }

    /// The `recall` tool.
    pub async fn recall(&self, args: &Value) -> RecallOutcome {
        match self.handle_search(&recall_search_args(args)).await {
            Ok(mut outcome) => {
                outcome.text = cap_recall_text(&outcome.text, RECALL_OUTPUT_MAX_BYTES);
                outcome
            }
            Err(error) => RecallOutcome { text: format!("recall failed: {}", error.message()), next_cursor: None, is_error: true },
        }
    }

    /// The internal `search_memories` tool.
    pub async fn search_memories(&self, args: &Value) -> RecallOutcome {
        match self.handle_search(args).await {
            Ok(outcome) => outcome,
            Err(error) => {
                RecallOutcome { text: format!("search_memories failed: {}", error.message()), next_cursor: None, is_error: true }
            }
        }
    }

    pub async fn handle_search(&self, args: &Value) -> Result<RecallOutcome> {
        let mut args = args.clone();
        if let Some(object) = args.as_object_mut()
            && !object.get("ids").is_some_and(Value::is_array)
                && let Some(id) = object.get("id").filter(|v| !v.is_null()).cloned() {
                    object.insert("ids".into(), if id.is_array() { id } else { json!([id]) });
                }
        let search = SearchArgs::new(args);
        if let Some(queries) = search.query_list() {
            return self.fan_out(&search, queries).await;
        }
        self.dispatch(&search).await
    }

    async fn fan_out(&self, args: &SearchArgs, queries: Vec<String>) -> Result<RecallOutcome> {
        let mut dedup: Vec<String> = Vec::new();
        for q in queries.iter().map(|q| js_trim(q).to_owned()).filter(|q| !q.is_empty()) {
            if !dedup.contains(&q) {
                dedup.push(q);
            }
        }
        if dedup.is_empty() {
            return Ok(RecallOutcome::ok(String::new()));
        }
        let selected: Vec<String> = dedup.iter().take(FAN_OUT_QUERIES_CAP).cloned().collect();
        let dropped = dedup.len() - selected.len();
        let mut set = JoinSet::new();
        for (index, query) in selected.iter().enumerate() {
            let mut sub = args.raw.clone();
            sub["query"] = json!(query);
            let this = self.clone();
            set.spawn(async move { (index, this.dispatch(&SearchArgs::new(sub)).await) });
        }
        let gather = async {
            let mut parts: Vec<Option<String>> = vec![None; selected.len()];
            while let Some(joined) = set.join_next().await {
                let (index, outcome) = joined.map_err(|e| MemoryError::Runtime(e.to_string()))?;
                let text = outcome?.text;
                parts[index] = Some(format!("[{}]\n{}", selected[index], if text.is_empty() { "(no results)" } else { &text }));
            }
            Ok::<_, MemoryError>(parts.into_iter().flatten().collect::<Vec<_>>())
        };
        let parts = tokio::time::timeout(FAN_OUT_DEADLINE, gather)
            .await
            .map_err(|_| MemoryError::rejected("memory fan-out deadline exceeded (180s)"))??;
        let header = if dropped > 0 {
            format!("note: {} queries received, {} processed, {dropped} dropped (cap {FAN_OUT_QUERIES_CAP})\n\n", dedup.len(), selected.len())
        } else {
            String::new()
        };
        Ok(RecallOutcome::ok(format!("{header}{}", parts.join("\n\n"))))
    }

    async fn dispatch(&self, args: &SearchArgs) -> Result<RecallOutcome> {
        let db = &self.deps.db;
        let clock = self.clock();
        if args.raw.get("currentSession") == Some(&Value::Bool(true))
            || !args.text("sessionId").is_empty()
            || !args.text("session_id").is_empty()
        {
            let estimate = |text: &str| (self.deps.estimate_tokens)(text);
            let text = recall_session_rows(db, &clock, args, &SessionOptions { estimate_tokens: &estimate }).await?;
            return Ok(RecallOutcome::ok(text));
        }
        let cwd = args.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty());
        let resolved = resolve_project_scope(self.deps.lane, cwd, self.deps.session_cwd.as_deref()).await?;
        if let Some(ids) = args.raw.get("ids").filter(|v| v.as_array().is_some_and(|a| !a.is_empty())) {
            let ids = id_values(ids);
            let text = search_by_ids(db, &clock, args, &ids, resolved.as_deref()).await?;
            return Ok(RecallOutcome::ok(text));
        }
        let plan = resolve_search_plan(&clock, args, resolved.as_deref());
        if !plan.query.is_empty() && !plan.is_last() {
            return Ok(RecallOutcome::ok(self.search_by_query(&clock, args, &plan).await?));
        }
        if plan.is_last() {
            let (text, cursor) = browse_last_sessions(db, &clock, args, &plan).await?;
            return Ok(RecallOutcome { text, next_cursor: Some(cursor), is_error: false });
        }
        Ok(RecallOutcome::ok(browse_entries(db, &clock, args, &plan).await?))
    }

    // ---- query search ------------------------------------------------------------

    fn search_options(&self, plan: &SearchPlan, args: &SearchArgs, vector: Option<Vec<f32>>, retrieval_limit: usize) -> SearchOptions {
        let window = plan.window();
        SearchOptions {
            limit: Some(retrieval_limit),
            query_vector: vector,
            include_members: if plan.structured_time_mode { false } else { plan.include_members },
            root_only: false,
            latest_by_concept: plan.latest_intent && args.get("period").is_none(),
            ts_from: window.and_then(|w| w.start_ms),
            ts_to: window.and_then(|w| w.end_ms),
            exclude_statuses: plan.exclude_statuses.clone(),
            project_scope: Some(plan.project_scope.clone()),
            category: plan.category.clone().unwrap_or_default(),
        }
    }

    async fn search_by_query(&self, clock: &Clock, args: &SearchArgs, plan: &SearchPlan) -> Result<String> {
        let db = &self.deps.db;
        let vector = match &self.deps.embedder {
            Some(embedder) => embedder.query_vector(&plan.retrieval_query).await,
            None => None,
        };
        let candidates = self.retrieve_candidates(args, plan, vector).await?;
        let retrieval_limit = candidates.retrieval_limit;
        let mut filtered = order_candidates(candidates.results.clone(), plan, candidates.vague_latest_root_mode);
        if plan.include_raw {
            filtered = self.merge_raw_window(clock, filtered, plan, retrieval_limit).await;
        }
        let window = plan.window();
        let core_rows = if plan.structured_time_mode {
            Vec::new()
        } else {
            recall_core_rows(
                db,
                clock,
                &plan.retrieval_query,
                &CoreOptions {
                    project_scope: Some(plan.project_scope.clone()),
                    category: plan.category.clone(),
                    limit: retrieval_limit,
                    ts_from: window.and_then(|w| w.start_ms),
                    ts_to: window.and_then(|w| w.end_ms),
                    agent_id: MemoryCaller::from_value(args.get("memory_caller")).agent_id,
                },
            )
            .await?
        };
        if !core_rows.is_empty() {
            filtered = interleave_raw_rows(filtered, core_rows);
        }
        let mut promote_latest_raw = false;
        if plan.sort != "date" && plan.latest_intent {
            (promote_latest_raw, filtered) = promote_latest_raw_rows(filtered, plan);
        }
        if plan.sort == "date" {
            filtered.sort_by(compare_newest_first);
        }
        let filtered = self.expand_and_bound(filtered, plan, &candidates, promote_latest_raw).await?;
        let sliced = page_rows(filtered.clone(), plan);
        if let (Some(sink), Some(top)) = (&self.deps.trace, filtered.first())
            && top.id > 0 {
                sink(RecallTrace { query: plan.query.chars().take(200).collect(), top_entry_id: top.id, hit_count: filtered.len() });
            }
        let latest_note =
            if plan.latest_intent && args.get("period").is_none() { "note: latest stored evidence; no newer stored completion is implied\n" } else { "" };
        let semantic_note = if candidates.semantic_only {
            "note: semantic-only candidates; no lexical corroboration was found, so treat them as possible rather than confirmed evidence\n"
        } else {
            ""
        };
        let body = render_entry_lines(
            clock,
            &sliced,
            &RenderOptions {
                recency_order: plan.sort == "date",
                preserve_source: plan.include_members || plan.include_raw,
                include_root_source: plan.include_members,
                source_window: window,
                ..RenderOptions::default()
            },
        );
        Ok(format!("{}{latest_note}{semantic_note}{body}", plan.cap_prefix))
    }

    async fn retrieve_candidates(&self, args: &SearchArgs, plan: &SearchPlan, vector: Option<Vec<f32>>) -> Result<Candidates> {
        let db = &self.deps.db;
        let window = plan.window();
        let retrieval_limit = (plan.limit + plan.offset).max(RECALL_LIMIT_CAP.min((plan.limit + plan.offset) * 3));
        let options = self.search_options(plan, args, vector, retrieval_limit);
        let window_filters = EntryFilters {
            is_root: Some(true),
            ts_from: window.and_then(|w| w.start_ms),
            ts_to: window.and_then(|w| w.end_ms),
            project_scope: Some(plan.project_scope.clone()),
            category: plan.category.clone(),
            exclude_statuses: plan.exclude_statuses.clone(),
            sort: Some("date".into()),
            ..EntryFilters::default()
        };
        let vague_latest_root_mode = plan.latest_root_mode && has_vague_latest_work_intent(&plan.query);
        let primary = async {
            if vague_latest_root_mode {
                retrieve_entries(db, &EntryFilters { limit: Some(retrieval_limit), ..window_filters.clone() }).await
            } else {
                search_relevant_hybrid(db, &plan.retrieval_query, &options).await
            }
        };
        let historical = async {
            if plan.bounded_historical {
                search_relevant_hybrid(
                    db,
                    &plan.retrieval_query,
                    &SearchOptions { include_members: false, root_only: true, ..options.clone() },
                )
                .await
            } else {
                Ok(Vec::new())
            }
        };
        let (results, historical_rows) = tokio::try_join!(primary, historical)?;
        let primary_roots: Vec<Row> = if plan.deep_historical {
            results.iter().filter(|r| r.is_root == 1).cloned().map(|mut r| {
                r.members = Some(Vec::new());
                r
            }).collect()
        } else {
            Vec::new()
        };
        let mut historical_candidates = unique_rows_by_id(primary_roots.iter().cloned().chain(historical_rows.iter().cloned()));
        let low = if plan.deep_historical { results.len() <= 2 } else { results.len() <= 5 && historical_rows.len() <= 2 };
        if plan.bounded_historical && low {
            let window_roots = retrieve_entries(db, &EntryFilters { limit: Some(50), ..window_filters }).await?;
            let terms = session_recall_terms(&plan.retrieval_query);
            historical_candidates = unique_rows_by_id(
                primary_roots.into_iter().chain(window_roots).chain(historical_rows),
            );
            historical_candidates.sort_by(|a, b| {
                by_diff(topic_term_coverage(b, &terms) as f64 - topic_term_coverage(a, &terms) as f64)
                    .then_with(|| by_diff(b.retrieval_value() - a.retrieval_value()))
                    .then_with(|| compare_newest_first(a, b))
            });
        }
        let semantic_only = is_semantic_only(&results);
        Ok(Candidates { results, retrieval_limit, vague_latest_root_mode, historical_candidates, low_historical: low, semantic_only })
    }

    /// Raw turns not yet in the ranked set, appended (or merged by date).
    async fn merge_raw_window(&self, clock: &Clock, filtered: Vec<Row>, plan: &SearchPlan, retrieval_limit: usize) -> Vec<Row> {
        let window = plan.window();
        let raw_fetch = 500.min(retrieval_limit.max(20));
        let terms = session_recall_terms(&plan.retrieval_query);
        let raw = read_raw_rows_in_window(
            &self.deps.db,
            clock,
            window.and_then(|w| w.start_ms),
            window.and_then(|w| w.end_ms),
            raw_fetch,
            &RawOptions { project_scope: Some(plan.project_scope.clone()), terms: terms.clone(), ..RawOptions::default() },
        )
        .await;
        let seen: std::collections::HashSet<i64> = filtered.iter().map(|r| r.id).collect();
        let mut new_raw: Vec<Row> = raw.into_iter().filter(|r| !seen.contains(&r.id)).collect();
        if !terms.is_empty() {
            new_raw.retain(|r| terms.iter().any(|t| search_haystack(r).contains(t.as_str())));
        }
        let mut filtered = filtered;
        if plan.sort == "date" {
            filtered.extend(new_raw);
            filtered.sort_by(compare_newest_first);
            return filtered;
        }
        filtered.extend(new_raw);
        filtered
    }

    async fn expand_and_bound(&self, filtered: Vec<Row>, plan: &SearchPlan, candidates: &Candidates, promote_latest_raw: bool) -> Result<Vec<Row>> {
        let window = plan.window();
        let mut filtered = filtered;
        if plan.sort != "date" && plan.include_raw && (!plan.structured_time_mode || promote_latest_raw) {
            let latest_concept_rows: Vec<Row> =
                if plan.latest_intent { filtered.iter().filter(|r| r.concept_expanded).cloned().collect() } else { Vec::new() };
            filtered = expand_event_context(
                &self.deps.db,
                filtered,
                &EventContext {
                    query: &plan.retrieval_query,
                    limit: candidates.retrieval_limit,
                    ts_from: window.and_then(|w| w.start_ms),
                    ts_to: window.and_then(|w| w.end_ms),
                    exclude_statuses: &plan.exclude_statuses,
                    project_scope: Some(&plan.project_scope),
                    dedupe_events: plan.latest_intent,
                },
            )
            .await?;
            if !latest_concept_rows.is_empty() {
                filtered = preserve_latest_concept_rows(filtered, &latest_concept_rows, candidates.retrieval_limit);
            }
        }
        if plan.bounded_historical {
            let reserve = if plan.deep_historical { 6 } else if candidates.low_historical { 5 } else { 1 };
            filtered = merge_historical_rows(filtered, &candidates.historical_candidates, candidates.retrieval_limit, true, reserve);
            if plan.deep_historical {
                filtered = prioritize_historical_root_evidence(filtered);
            }
        }
        let filtered = annotate_root_context(filtered);
        Ok(bound_rows_to_temporal(filtered, window.as_ref()))
    }
}

struct Candidates {
    results: Vec<Row>,
    retrieval_limit: usize,
    vague_latest_root_mode: bool,
    historical_candidates: Vec<Row>,
    low_historical: bool,
    semantic_only: bool,
}

fn order_candidates(mut filtered: Vec<Row>, plan: &SearchPlan, vague_latest_root_mode: bool) -> Vec<Row> {
    if plan.sort == "date" {
        filtered.sort_by(compare_newest_first);
    } else {
        filtered.sort_by(compare_by_score);
    }
    if plan.structured_time_mode {
        let (root_rows, other): (Vec<Row>, Vec<Row>) = filtered.into_iter().partition(|r| r.is_root == 1);
        let roots = if plan.latest_intent && !vague_latest_root_mode {
            rank_latest_rows(root_rows, &plan.retrieval_query)
        } else {
            let mut roots = root_rows;
            roots.sort_by(compare_newest_first);
            roots
        };
        return roots.into_iter().chain(other).collect();
    }
    if plan.latest_entity_mode {
        return rank_latest_rows(filtered, &plan.retrieval_query);
    }
    filtered
}

/// Fresh unclassified turns lead only when they cover more of the topic than
/// every classified root.
fn promote_latest_raw_rows(filtered: Vec<Row>, plan: &SearchPlan) -> (bool, Vec<Row>) {
    let terms = latest_recall_topic_terms(&plan.retrieval_query);
    let coverage = |select: &dyn Fn(&Row) -> bool| {
        filtered.iter().filter(|r| select(r)).map(|r| topic_term_coverage(r, &terms) as i64).fold(-1, i64::max)
    };
    let raw = coverage(&|r| r.is_root == 0 && r.chunk_root.is_none());
    let root = coverage(&|r| r.is_root == 1);
    if raw > root { (true, rank_latest_rows(filtered, &plan.retrieval_query)) } else { (false, filtered) }
}

fn page_rows(filtered: Vec<Row>, plan: &SearchPlan) -> Vec<Row> {
    let deduped = collapse_near_duplicate_rows(collapse_history_duplicates(filtered));
    let mut rows: Vec<Row> = if plan.latest_intent { deduped.into_iter().filter(|r| !r.dup_stub).collect() } else { deduped };
    if plan.timeline_mode {
        let roots: Vec<Row> = rows.iter().filter(|r| r.is_root == 1).cloned().collect();
        rows = sample_timeline(if roots.len() > 1 { roots } else { rows }, plan.limit + plan.offset);
    }
    rows.into_iter().skip(plan.offset).take(plan.limit).collect()
}
