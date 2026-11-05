//! The SQL predicates every recall query shares: project scope, status,
//! category and time window, built over positional bind parameters.

use mixdog_js::{js_trim};
use crate::memory::recall::row::P;

pub const VALID_CATEGORIES: [&str; 8] = ["rule", "constraint", "decision", "fact", "goal", "preference", "task", "issue"];

pub fn is_valid_category(value: &str) -> bool {
    VALID_CATEGORIES.contains(&value)
}

/// The known categories in `values`, trimmed and lower-cased.
pub fn valid_categories(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|c| js_trim(c).to_lowercase())
        .filter(|c| is_valid_category(c))
        .collect()
}

/// `common` → NULL only; a slug → NULL or that slug; `all`/none → no filter.
/// `next` is the 1-based index of the first parameter it may bind.
pub fn project_scope_predicate(scope: Option<&str>, next: usize, column: &str) -> (String, Vec<P>) {
    match scope {
        Some("common") => (format!("{column} IS NULL"), Vec::new()),
        Some(slug) if !slug.is_empty() && slug != "all" => {
            (format!("({column} IS NULL OR {column} = ${next})"), vec![P::T(slug.to_owned())])
        }
        _ => (String::new(), Vec::new()),
    }
}

/// Appends a project-scope clause to a WHERE list that has bound `params` so far.
pub fn append_project_scope(where_clauses: &mut Vec<String>, params: &mut Vec<P>, scope: Option<&str>, column: &str) {
    let (clause, extra) = project_scope_predicate(scope, params.len() + 1, column);
    if clause.is_empty() {
        return;
    }
    where_clauses.push(clause);
    params.extend(extra);
}

#[derive(Debug, Clone, Default)]
pub struct ScopeOptions<'a> {
    pub ts_from: Option<i64>,
    pub ts_to: Option<i64>,
    pub exclude_statuses: &'a [String],
    pub categories: &'a [String],
    pub project_scope: Option<&'a str>,
}

fn category_clause(offset: usize, categories: &[String], alias: &str) -> (String, Vec<P>) {
    if categories.is_empty() {
        return (String::new(), Vec::new());
    }
    let p = format!("{}.", if alias.is_empty() { "entries" } else { alias });
    let ph = (0..categories.len()).map(|i| format!("${}", offset + i)).collect::<Vec<_>>().join(", ");
    let clause = format!(
        "(
    ({p}is_root = 1 AND {p}category IN ({ph}))
    OR ({p}is_root = 0 AND {p}chunk_root IS NOT NULL AND {p}chunk_root <> {p}id AND EXISTS (
      SELECT 1 FROM entries r WHERE r.id = {p}chunk_root AND r.is_root = 1 AND r.category IN ({ph})
    ))
    OR ({p}is_root = 0 AND ({p}chunk_root IS NULL OR {p}chunk_root = {p}id) AND {p}category IN ({ph}))
  )"
    );
    (clause, categories.iter().cloned().map(P::T).collect())
}

/// The window/status/category/scope filter, starting at parameter `offset`.
/// The clause begins with `AND`.
pub fn scope_filter(offset: usize, options: &ScopeOptions<'_>, alias: &str) -> (String, Vec<P>) {
    let p = format!("{}.", if alias.is_empty() { "entries" } else { alias });
    let mut clauses = vec![format!(
        "NOT ({p}is_root = 0 AND {p}chunk_root IS NOT DISTINCT FROM {p}id AND {p}status IS NOT DISTINCT FROM 'archived')"
    )];
    let mut params = Vec::new();
    let mut next = offset;
    if let Some(from) = options.ts_from {
        clauses.push(format!("{p}ts >= ${next}"));
        params.push(P::I(from));
        next += 1;
    }
    if let Some(to) = options.ts_to {
        clauses.push(format!("{p}ts <= ${next}"));
        params.push(P::I(to));
        next += 1;
    }
    let statuses: Vec<String> =
        options.exclude_statuses.iter().filter(|s| !js_trim(s).is_empty()).map(|s| js_trim(s).to_lowercase()).collect();
    if !statuses.is_empty() {
        let ph = statuses
            .iter()
            .map(|_| {
                let placeholder = format!("${next}");
                next += 1;
                placeholder
            })
            .collect::<Vec<_>>()
            .join(", ");
        let status_pred = format!("({p}status IS NULL OR {p}status NOT IN ({ph}))");
        clauses.push(format!(
            "(
      ({p}is_root = 1 AND {status_pred})
      OR ({p}is_root = 0 AND {p}chunk_root IS NOT NULL AND {p}chunk_root <> {p}id AND EXISTS (
        SELECT 1 FROM entries r WHERE r.id = {p}chunk_root AND r.is_root = 1
          AND (r.status IS NULL OR r.status NOT IN ({ph}))
      ))
      OR ({p}is_root = 0 AND ({p}chunk_root IS NULL OR {p}chunk_root = {p}id) AND {status_pred})
    )"
        ));
        params.extend(statuses.into_iter().map(P::T));
    }
    let categories = valid_categories(options.categories);
    let (category, category_params) = category_clause(next, &categories, alias);
    if !category.is_empty() {
        clauses.push(category);
        next += category_params.len();
        params.extend(category_params);
    }
    let (scope, scope_params) = project_scope_predicate(options.project_scope, next, &format!("{p}project_id"));
    if !scope.is_empty() {
        clauses.push(scope);
        params.extend(scope_params);
    }
    (format!("AND {}", clauses.join(" AND ")), params)
}
