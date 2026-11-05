//! Paged listing of curated memory with its public addresses.

use mixdog_js::{js_trim};
use serde::Serialize;
use serde_json::Value;

use crate::memory::core::access::Pool;
use crate::memory::core::index::{self, Directory};
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;

const DEFAULT_PAGE: i64 = 50;
const MAX_PAGE: i64 = 100;

/// One listed entry; field order is the order callers see in the JSON.
#[derive(Debug, Clone, Serialize)]
pub struct ListEntry {
    pub source: &'static str,
    pub id: Option<usize>,
    pub project_id: Option<String>,
    pub agent_id: Option<String>,
    pub element: String,
    pub summary: String,
    pub status: String,
    pub injection_enabled: bool,
    pub record_id: i64,
    pub index_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScopeOf {
    pub path: String,
    pub project_id: Option<String>,
}

#[derive(Debug)]
pub struct Page {
    pub entries: Vec<ListEntry>,
    pub next_offset: Option<i64>,
    pub project_scopes: Option<Vec<ProjectScopeOf>>,
}

pub struct ListOptions<'a> {
    pub scope: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub args: &'a Value,
    /// Project ids of `args.project_paths`, resolved by the caller.
    pub project_scopes: Option<Vec<ProjectScopeOf>>,
}

/// JS `Math.trunc(Number(v) || fallback)` for a JSON number or numeric string.
fn truncated(value: Option<&Value>, fallback: i64) -> i64 {
    let number = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => Some(mixdog_js::string_to_number(s)),
        _ => None,
    };
    match number {
        Some(n) if n.is_finite() && n != 0.0 => n.trunc() as i64,
        _ => fallback,
    }
}

pub async fn list(db: &Db, options: ListOptions<'_>) -> Result<Page> {
    let args = options.args;
    let include_inactive = match args.get("include_inactive") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(MemoryError::rejected("include_inactive must be a boolean")),
    };
    if args.get("project_paths").is_some() {
        let paths_ok = args["project_paths"]
            .as_array()
            .is_some_and(|paths| paths.iter().all(|path| path.as_str().is_some_and(|p| !js_trim(p).is_empty())));
        if options.scope != Some("*") || !paths_ok {
            return Err(MemoryError::rejected("project_paths requires an all-project list and non-empty paths"));
        }
    }
    let limit = truncated(args.get("limit"), DEFAULT_PAGE).clamp(1, MAX_PAGE);
    let offset = truncated(args.get("offset"), 0).max(0);
    let directory = index::sync(db).await?;
    // Order before pagination by the persisted scoped address, not the hidden
    // database key: moving an old record into a scope appends it there.
    let cases: Vec<String> = directory
        .values()
        .flat_map(|state| state.record_ids.iter().enumerate().map(|(i, id)| format!("WHEN {id} THEN {}", i + 1)))
        .collect();
    let public_order =
        if cases.is_empty() { "id".to_owned() } else { format!("CASE id {} ELSE id END", cases.join(" ")) };
    let scope_only = args.get("scope_only") == Some(&Value::Bool(true));
    let rows = db
        .query(
            &format!(
                "SELECT * FROM (
                   SELECT 'curated'::text AS source, c.id, c.project_id, c.agent_id, c.element, c.summary,
                          COALESCE(c.status, 'active')::text AS status,
                          (c.status IS NULL OR c.status = 'active') AS injection_enabled
                   FROM core_entries c
                 ) memories
                 WHERE (agent_id = $6::text OR ($6::text IS NULL AND agent_id IS NULL
                     AND ($1::text = '*' OR project_id = $1 OR (project_id IS NULL AND (NOT $5::boolean OR $1::text IS NULL)))))
                   AND ($4::boolean OR injection_enabled)
                 ORDER BY project_id NULLS FIRST, {public_order} ASC, id ASC
                 LIMIT $2 OFFSET $3"
            ),
            &[&options.scope, &(limit + 1), &offset, &include_inactive, &scope_only, &options.agent_id],
        )
        .await?;
    let has_more = rows.len() as i64 > limit;
    let entries: Vec<ListEntry> =
        rows.iter().take(limit as usize).map(|row| indexed(&directory, row)).collect();
    if entries.iter().any(|entry| entry.injection_enabled && entry.id.is_none()) {
        return Err(MemoryError::rejected("memory indices changed during listing; list memories again"));
    }
    Ok(Page {
        entries,
        next_offset: has_more.then_some(offset + limit),
        project_scopes: options.project_scopes,
    })
}

fn indexed(directory: &Directory, row: &tokio_postgres::Row) -> ListEntry {
    let id: i64 = row.get("id");
    let project_id: Option<String> = row.get("project_id");
    let agent_id: Option<String> = row.get("agent_id");
    let pool = Pool { project_id: project_id.as_deref(), agent_id: agent_id.as_deref() };
    let address = index::address(directory, &pool, id);
    ListEntry {
        source: "curated",
        id: address.as_ref().map(|(position, _)| *position),
        element: row.get("element"),
        summary: row.get("summary"),
        status: row.get("status"),
        injection_enabled: row.get("injection_enabled"),
        record_id: id,
        index_revision: address.map(|(_, revision)| revision),
        project_id,
        agent_id,
    }
}

/// The text listing: one line per entry, then a continuation hint.
pub fn format(page: &Page) -> String {
    let mut lines: Vec<String> = page
        .entries
        .iter()
        .map(|row| {
            let id = row.id.map_or_else(|| format!("archived_id={}", row.record_id), |id| format!("id={id}"));
            let version = row.index_revision.as_ref().map_or(String::new(), |rev| format!(" index_revision={rev}"));
            let pool = Pool { project_id: row.project_id.as_deref(), agent_id: row.agent_id.as_deref() }.label();
            let injection = if row.injection_enabled { "enabled" } else { "disabled" };
            format!(
                "{id} source=curated {pool} status={} injection={injection}{version} {} — {}",
                row.status, row.element, row.summary
            )
        })
        .collect();
    if let Some(next) = page.next_offset {
        lines.push(format!(
            "More memories: call list with offset={next} and the same project scope/include_inactive."
        ));
    }
    if lines.is_empty() { "memory: empty".to_owned() } else { lines.join("\n") }
}
