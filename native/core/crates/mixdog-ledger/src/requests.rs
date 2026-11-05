//! The request log (`usage-ledger-requests.mjs`): individual requests, newest first, a page at
//! a time, read through an index ordered by time (all requests, one status, or one route) and
//! stopping after the page.

use std::cmp::Reverse;
use std::collections::BTreeMap;

use rusqlite::types::Value as Sql;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;

use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::params_from_iter;
use crate::error::Result;
use crate::measure::js_number;

pub const REQUEST_STATUSES: [&str; 4] = ["completed", "substituted", "retried", "failed"];
const DEFAULT_PAGE: i64 = 50;
const MAX_PAGE: i64 = 200;

// A provider-local retry's abandoned attempts are part of their request, never a request of
// their own.
const NOT_ABANDONED: &str =
    "NOT (substr(e.id,1,1)=X'01' AND instr(e.id, CAST(':abandoned:' AS BLOB))>0)";
const COLUMNS: &str = "e.id,e.ts,e.route,e.session,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,e.duration_ms,
    r.requested_model,r.status,r.attempts,r.elapsed_ms,
    (SELECT f.ttft_ms FROM usage_request_first_output f WHERE f.id=e.id) AS first_output_ms,
    (SELECT p.provider FROM usage_request_requested_provider p WHERE p.id=e.id) AS requested_provider";
const COMPLETED: &str = "(r.status IS NULL OR r.status='completed')";
const LISTED: &str = "(r.status IS NULL OR r.status<>'cancelled')";

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Time,
    Status,
    Route,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestQuery {
    #[serde(default)]
    pub from_ms: i64,
    pub to_ms: i64,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: i64,
}

struct Cursor {
    ts: i64,
    id: Vec<u8>,
}

fn decode_cursor(cursor: Option<&str>) -> Option<Cursor> {
    let (ts, id) = cursor?.split_once(':')?;
    let valid = !ts.is_empty()
        && ts.bytes().all(|b| b.is_ascii_digit())
        && !id.is_empty()
        && id.len() % 2 == 0
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return None;
    }
    let id = (0..id.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).unwrap_or(0))
        .collect();
    Some(Cursor {
        ts: ts.parse().ok()?,
        id,
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Row {
    id: Vec<u8>,
    ts: i64,
    route: i64,
    session: i64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: Option<f64>,
    duration_ms: f64,
    requested_model: Option<String>,
    status: Option<String>,
    attempts: Option<i64>,
    elapsed_ms: Option<f64>,
    first_output_ms: Option<f64>,
    requested_provider: Option<String>,
}

pub fn page_sql(source: Source, cursor: bool, completed: bool, routes: usize) -> String {
    let alias = if source == Source::Status { "r" } else { "e" };
    let from = match source {
        Source::Status => "usage_requests r INDEXED BY usage_requests_status_time CROSS JOIN usage_events e ON e.id=r.id".to_string(),
        _ => format!(
            "usage_events e INDEXED BY {} LEFT JOIN usage_requests r ON r.id=e.id",
            if source == Source::Route { "usage_events_route_time" } else { "usage_events_time" }
        ),
    };
    let mut wheres: Vec<String> = Vec::new();
    if source == Source::Status {
        wheres.push("r.status=? AND r.status<>'completed'".to_string());
    }
    if source == Source::Route {
        wheres.push("e.route=?".to_string());
    }
    wheres.push(format!("{alias}.ts>=?"));
    wheres.push(format!("{alias}.ts<=?"));
    if cursor {
        wheres.push(format!("({alias}.ts<? OR {alias}.id<?)"));
    }
    wheres.push(NOT_ABANDONED.to_string());
    if source != Source::Status {
        wheres.push(if completed { COMPLETED } else { LISTED }.to_string());
    }
    if routes > 0 {
        wheres.push(format!("e.route IN ({})", vec!["?"; routes].join(",")));
    }
    format!(
        "SELECT {COLUMNS} FROM {from} WHERE {} ORDER BY {alias}.ts DESC, {alias}.id DESC LIMIT ?",
        wheres.join(" AND ")
    )
}

fn run_page(conn: &Connection, sql: &str, params: Vec<Sql>) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok(Row {
            id: row.get(0)?,
            ts: row.get(1)?,
            route: row.get(2)?,
            session: row.get(3)?,
            input: row.get(4)?,
            output: row.get(5)?,
            cache_read: row.get(6)?,
            cache_write: row.get(7)?,
            cost_usd: row.get(8)?,
            duration_ms: row.get(9)?,
            requested_model: row.get(10)?,
            status: row.get(11)?,
            attempts: row.get(12)?,
            elapsed_ms: row.get(13)?,
            first_output_ms: row.get(14)?,
            requested_provider: row.get(15)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[derive(Default)]
struct RouteInfo {
    provider: String,
    model: String,
    kind: String,
    source_type: String,
    cost_source: String,
}

fn text(value: Option<String>) -> Value {
    Value::from(value.unwrap_or_default())
}

pub const MODEL_ROUTES_SQL: &str =
    "SELECT id FROM usage_routes WHERE json_extract(signature,'$[1]')=?";
pub const ROUTE_INFO_SQL: &str =
    "SELECT json_extract(signature,'$[0]'),json_extract(signature,'$[1]'),json_extract(signature,'$[2]'),
                        json_extract(signature,'$[3]'),json_extract(signature,'$[4]') FROM usage_routes WHERE id=?";
pub const SESSION_SQL: &str = "SELECT value FROM usage_sessions WHERE id=?";
pub const OWNER_SQL: &str = "SELECT s.value FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner WHERE o.session=?";
/// Every route: the models list visits all of them, so it is not a bounded read.
pub const MODELS_ROUTES_SQL: &str = "SELECT id,json_extract(signature,'$[1]') FROM usage_routes";

/// One indexed probe per route: does any request of it fall in the period?
pub fn models_probe_sql() -> String {
    format!(
        "SELECT 1 FROM usage_events e INDEXED BY usage_events_route_time LEFT JOIN usage_requests r ON r.id=e.id
             WHERE e.route=? AND e.ts>=? AND e.ts<=? AND {NOT_ABANDONED} AND {LISTED} LIMIT 1"
    )
}

impl RequestQuery {
    /// The first page (no usable cursor) also carries the models list.
    pub fn is_first_page(&self) -> bool {
        decode_cursor(self.cursor.as_deref()).is_none()
    }
}

/// Every model that answered within the period. It visits every route and probes the events
/// of each (a route whose requests are all abandoned or cancelled is skipped row by row), so
/// its cost grows with the ledger: the reader runs it on the maintenance lane.
pub(crate) fn read_request_models(conn: &Connection, from_ms: i64, to_ms: i64) -> Result<Value> {
    let mut probe = conn.prepare(&models_probe_sql())?;
    let mut found: Vec<String> = Vec::new();
    let mut routes = conn.prepare(MODELS_ROUTES_SQL)?;
    let list: Vec<(i64, Option<String>)> = routes
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for (id, model) in list {
        let Some(model) = model.filter(|m| !m.is_empty()) else {
            continue;
        };
        if !found.contains(&model)
            && probe.exists([Sql::Integer(id), Sql::Integer(from_ms), Sql::Integer(to_ms)])?
        {
            found.push(model);
        }
    }
    found.sort_by(|a, b| mixdog_js::locale_compare(a, b));
    Ok(Value::from(found))
}

/// `{requests, nextCursor}` for one page, read through the time-ordered indexes and stopping
/// after the page: bounded by the page size, whatever the ledger holds.
pub(crate) fn read_request_rows(conn: &Connection, query: &RequestQuery) -> Result<Value> {
    let limit = if query.limit > 0 {
        query.limit.min(MAX_PAGE)
    } else {
        DEFAULT_PAGE
    };
    let status = if REQUEST_STATUSES.contains(&query.status.as_str()) {
        query.status.as_str()
    } else {
        ""
    };
    let cursor = decode_cursor(query.cursor.as_deref());
    let mut range = vec![
        Sql::Integer(query.from_ms),
        Sql::Integer(
            cursor
                .as_ref()
                .map_or(query.to_ms, |c| query.to_ms.min(c.ts)),
        ),
    ];
    if let Some(c) = &cursor {
        range.push(Sql::Integer(c.ts));
        range.push(Sql::Blob(c.id.clone()));
    }
    let model_routes: Option<Vec<i64>> = match query.model.as_deref().filter(|m| !m.is_empty()) {
        Some(model) => Some(
            conn.prepare(MODEL_ROUTES_SQL)?
                .query_map([model], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?,
        ),
        None => None,
    };
    let has_cursor = cursor.is_some();
    let run = |source: Source,
               completed: bool,
               routes: usize,
               mut params: Vec<Sql>|
     -> Result<Vec<Row>> {
        params.push(Sql::Integer(limit + 1));
        run_page(
            conn,
            &page_sql(source, has_cursor, completed, routes),
            params,
        )
    };
    let mut rows = match &model_routes {
        Some(routes) if routes.is_empty() => Vec::new(),
        routes if !status.is_empty() && status != "completed" => {
            let routes = routes.as_deref().unwrap_or(&[]);
            let mut params = vec![Sql::Text(status.to_string())];
            params.extend(range.clone());
            params.extend(routes.iter().map(|r| Sql::Integer(*r)));
            run(Source::Status, false, routes.len(), params)?
        }
        Some(routes) => {
            let mut all = Vec::new();
            for route in routes {
                let mut params = vec![Sql::Integer(*route)];
                params.extend(range.clone());
                all.extend(run(Source::Route, !status.is_empty(), 0, params)?);
            }
            all.sort_by(|a, b| {
                (Reverse(a.ts), Reverse(&a.id)).cmp(&(Reverse(b.ts), Reverse(&b.id)))
            });
            all.truncate(usize::try_from(limit + 1).unwrap_or(usize::MAX));
            all
        }
        None => run(Source::Time, !status.is_empty(), 0, range.clone())?,
    };
    let more = rows.len() as i64 > limit;
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));

    let mut route_cache: BTreeMap<i64, RouteInfo> = BTreeMap::new();
    let mut requests = Vec::with_capacity(rows.len());
    for row in &rows {
        if let std::collections::btree_map::Entry::Vacant(slot) = route_cache.entry(row.route) {
            let info = conn
                .prepare_cached(ROUTE_INFO_SQL)?
                .query_row([row.route], |r| {
                    Ok(RouteInfo {
                        provider: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        model: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        kind: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        source_type: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        cost_source: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    })
                })
                .optional()?
                .unwrap_or_default();
            slot.insert(info);
        }
        let route = &route_cache[&row.route];
        let session: Option<String> = conn
            .prepare_cached(SESSION_SQL)?
            .query_row([row.session], |r| r.get(0))
            .optional()?;
        let owner: Option<String> = conn
            .prepare_cached(OWNER_SQL)?
            .query_row([row.session], |r| r.get(0))
            .optional()?;
        let non_empty = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        let duration = if row.duration_ms != 0.0 {
            row.duration_ms
        } else {
            row.elapsed_ms.unwrap_or(0.0)
        };
        let mut out = Map::new();
        out.insert("id".into(), Value::from(hex(&row.id)));
        out.insert("ts".into(), Value::from(row.ts));
        out.insert("provider".into(), Value::from(route.provider.as_str()));
        out.insert("model".into(), Value::from(route.model.as_str()));
        out.insert(
            "requestedModel".into(),
            Value::from(non_empty(&row.requested_model).unwrap_or_else(|| route.model.clone())),
        );
        out.insert(
            "requestedProvider".into(),
            text(non_empty(&row.requested_provider)),
        );
        out.insert("kind".into(), Value::from(route.kind.as_str()));
        out.insert("sourceType".into(), Value::from(route.source_type.as_str()));
        out.insert("costSource".into(), Value::from(route.cost_source.as_str()));
        out.insert("sessionId".into(), text(session));
        out.insert("ownerSessionId".into(), text(owner));
        out.insert("input".into(), js_number(row.input));
        out.insert("output".into(), js_number(row.output));
        out.insert("cacheRead".into(), js_number(row.cache_read));
        out.insert("cacheWrite".into(), js_number(row.cache_write));
        out.insert(
            "tokens".into(),
            js_number(row.input + row.output + row.cache_read + row.cache_write),
        );
        out.insert(
            "costUsd".into(),
            row.cost_usd.map_or(Value::Null, js_number),
        );
        out.insert("durationMs".into(), js_number(duration));
        out.insert(
            "ttftMs".into(),
            row.first_output_ms.map_or(Value::Null, js_number),
        );
        out.insert(
            "attempts".into(),
            Value::from(row.attempts.filter(|a| *a != 0).unwrap_or(1)),
        );
        out.insert(
            "status".into(),
            Value::from(non_empty(&row.status).unwrap_or_else(|| "completed".to_string())),
        );
        requests.push(Value::Object(out));
    }

    let next = match rows.last() {
        Some(last) if more => Value::from(format!("{}:{}", last.ts, hex(&last.id))),
        _ => Value::Null,
    };
    let mut out = Map::new();
    out.insert("requests".into(), Value::Array(requests));
    out.insert("nextCursor".into(), next);
    Ok(Value::Object(out))
}
