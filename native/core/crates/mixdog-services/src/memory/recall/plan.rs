//! The recall request and the search plan derived from it: query intent,
//! period, sort, page bounds, expansion opt-ins and project scope. Pure.

use mixdog_js::{js_trim, value_to_string};
use serde_json::Value;

use crate::memory::recall::period::{Clock, Temporal, Window, infer_recall_period, parse_period};
use crate::memory::recall::ranking::{
    has_latest_recall_intent, has_recall_entity, has_timeline_intent, latest_recall_search_terms,
};

pub const RECALL_LIMIT_CAP: usize = 100;
pub const RECALL_OFFSET_CAP: usize = 500;
pub const RECALL_WINDOW_CAP: usize = RECALL_LIMIT_CAP + RECALL_OFFSET_CAP;

/// `Number(value)` of an argument that may be absent (NaN).
pub fn js_number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, mixdog_js::to_number)
}

/// The request as the search legs read it.
#[derive(Debug, Clone, Default)]
pub struct SearchArgs {
    pub raw: Value,
}

impl SearchArgs {
    pub fn new(raw: Value) -> Self {
        Self { raw }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.raw.get(key).filter(|v| !v.is_null())
    }

    pub fn text(&self, key: &str) -> String {
        js_trim(&self.get(key).map(value_to_string).unwrap_or_default()).to_owned()
    }

    pub fn flag(&self, key: &str) -> bool {
        self.raw.get(key) == Some(&Value::Bool(true))
    }

    /// The `category` argument as a list (one value or an array).
    pub fn categories(&self) -> Option<Vec<String>> {
        self.get("category").map(|c| match c {
            Value::Array(items) => items.iter().map(value_to_string).collect(),
            other => vec![value_to_string(other)],
        })
    }

    pub fn query_list(&self) -> Option<Vec<String>> {
        self.raw.get("query").and_then(Value::as_array).map(|items| items.iter().map(value_to_string).collect())
    }
}

#[derive(Debug, Clone)]
pub struct SearchPlan {
    pub query: String,
    pub retrieval_query: String,
    pub timeline_mode: bool,
    pub latest_intent: bool,
    pub latest_entity_mode: bool,
    pub latest_root_mode: bool,
    pub structured_time_mode: bool,
    pub requested_limit: Option<f64>,
    pub limit: usize,
    pub offset: usize,
    pub cap_prefix: String,
    pub sort: String,
    pub include_members: bool,
    pub include_raw: bool,
    pub include_archived: bool,
    pub category: Option<Vec<String>>,
    pub temporal: Option<Temporal>,
    pub exclude_statuses: Vec<String>,
    pub bounded_historical: bool,
    pub deep_historical: bool,
    pub project_scope: String,
}

impl SearchPlan {
    pub fn window(&self) -> Option<Window> {
        match self.temporal {
            Some(Temporal::Window(window)) => Some(window),
            _ => None,
        }
    }

    pub fn is_last(&self) -> bool {
        matches!(self.temporal, Some(Temporal::Last))
    }
}

/// An explicit `projectScope`, else the project resolved from the caller's
/// directory (`resolved`), else COMMON.
pub fn resolve_query_project_scope(args: &SearchArgs, resolved: Option<&str>) -> String {
    if let Some(Value::String(scope)) = args.get("projectScope")
        && !scope.is_empty() {
            return scope.clone();
        }
    resolved.unwrap_or("common").to_owned()
}

struct Page {
    requested: Option<f64>,
    limit: usize,
    offset: usize,
    prefix: String,
}

fn page_bounds(args: &SearchArgs) -> Page {
    let requested_limit = js_number(args.raw.get("limit"));
    let requested_offset = js_number(args.raw.get("offset"));
    let mut limit = if requested_limit.is_finite() { requested_limit } else { 10.0 }.max(1.0);
    let mut offset = if requested_offset.is_finite() { requested_offset } else { 0.0 }.max(0.0);
    let mut notes = Vec::new();
    if requested_limit.is_finite() && requested_limit > RECALL_LIMIT_CAP as f64 {
        limit = RECALL_LIMIT_CAP as f64;
        notes.push(format!("limit capped to {RECALL_LIMIT_CAP} (requested {})", mixdog_js::number_to_string(requested_limit)));
    } else {
        limit = limit.min(RECALL_LIMIT_CAP as f64);
    }
    if requested_offset.is_finite() && requested_offset > RECALL_OFFSET_CAP as f64 {
        offset = RECALL_OFFSET_CAP as f64;
        notes.push(format!("offset capped to {RECALL_OFFSET_CAP} (requested {})", mixdog_js::number_to_string(requested_offset)));
    } else {
        offset = offset.min(RECALL_OFFSET_CAP as f64);
    }
    Page {
        requested: requested_limit.is_finite().then_some(requested_limit),
        limit: limit.floor() as usize,
        offset: offset.floor() as usize,
        prefix: if notes.is_empty() { String::new() } else { format!("{}\n", notes.join("; ")) },
    }
}

pub fn resolve_search_plan(
    clock: &Clock,
    args: &SearchArgs,
    resolved_scope: Option<&str>,
) -> SearchPlan {
    let query = args.text("query");
    let query_period = infer_recall_period(&query);
    let explicit_period = args.text("period");
    let period = if explicit_period.is_empty() { query_period.clone().unwrap_or_default() } else { explicit_period };
    let no_sort = args.get("sort").is_none();
    let timeline_mode = no_sort && has_timeline_intent(&query);
    let latest_intent = has_latest_recall_intent(&query) || query_period.as_deref() == Some("3h");
    let latest_terms = if latest_intent { latest_recall_search_terms(&query) } else { Vec::new() };
    let retrieval_query = if latest_terms.is_empty() { query.clone() } else { latest_terms.join(" ") };
    let latest_entity_mode = no_sort && latest_intent && has_recall_entity(&query);
    let latest_root_mode = no_sort
        && !timeline_mode
        && !latest_entity_mode
        && ((query_period.is_some() && !has_recall_entity(&query)) || latest_intent);
    let structured_time_mode = timeline_mode || latest_root_mode;
    let page = page_bounds(args);
    let has_query = !query.is_empty();
    let default_sort = if has_query { "importance" } else { "date" };
    let sort = args.get("sort").map_or_else(|| default_sort.to_owned(), value_to_string);
    let include_archived = args.raw.get("includeArchived") != Some(&Value::Bool(false));
    let temporal = parse_period(clock, &period, has_query);
    let window = match temporal {
        Some(Temporal::Window(w)) => Some(w),
        _ => None,
    };
    let end = window.and_then(|w| w.end_ms);
    let bounded = has_query
        && sort != "date"
        && !latest_intent
        && !timeline_mode
        && window.is_some_and(|w| w.start_ms.is_some())
        && end.is_some_and(|end| end < clock.now_ms - 3_600_000);
    let deep = bounded && end.is_some_and(|end| end < clock.now_ms - 3 * 24 * 3_600_000);
    SearchPlan {
        query,
        retrieval_query,
        timeline_mode,
        latest_intent,
        latest_entity_mode,
        latest_root_mode,
        structured_time_mode,
        requested_limit: page.requested,
        limit: page.limit,
        offset: page.offset,
        cap_prefix: page.prefix,
        sort,
        include_members: args.flag("includeMembers"),
        include_raw: args.flag("includeRaw"),
        include_archived,
        category: args.categories(),
        temporal,
        exclude_statuses: if include_archived { Vec::new() } else { vec!["archived".to_owned()] },
        bounded_historical: bounded,
        deep_historical: deep,
        project_scope: resolve_query_project_scope(args, resolved_scope),
    }
}
