//! `cycle1/cycle1-plan.mjs` and `cycle1/cycle1-rows.mjs`: the bounds of one run and the `entries`
//! rows it reads and marks.

use mixdog_js::{js_trim, to_number, value_to_string};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::log;
use super::quality::{CYCLE1_INPUT_TOKEN_BUDGET, Row};
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;

const MIN_BATCH: f64 = 3.0;
const SESSION_CAP: f64 = 10.0;
pub const PACKET_MAX_ROWS: usize = 50;
pub const MAX_PACKETS: usize = 4;
const OMITTED_COOLDOWN_MS: i64 = 60 * 60 * 1000;
const OMITTED_COOLDOWN_MAX_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// A session is chunked only after it has been quiet this long.
const SESSION_QUIET_MS: f64 = 15.0 * 60.0 * 1000.0;
/// A session that never pauses is drained once its oldest pending row has waited this long.
const SESSION_FORCE_AGE_MS: f64 = 2.0 * 60.0 * 60.0 * 1000.0;

/// `Math.max`/`Math.min`: NaN wins, unlike `f64::max`.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `Number(first non-nullish of the values ?? fallback)`.
fn number_of(values: &[Option<&Value>], fallback: f64) -> f64 {
    values.iter().flatten().find(|v| !v.is_null()).map_or(fallback, |v| to_number(v))
}

fn truthy(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub window_size: f64,
    pub max_packets: f64,
    pub rows_per_session: f64,
    pub min_batch: f64,
    pub session_cap: f64,
    pub backfill_cap: f64,
    pub session_quiet_ms: f64,
    pub session_force_age_ms: f64,
    pub only_session_id: String,
    pub preset: Option<Value>,
    pub timeout: f64,
    pub input_token_budget: f64,
    pub concurrency: f64,
}

/// The run options that reach the plan (`options` of `runCycle1`).
#[derive(Clone, Debug, Default)]
pub struct PlanOptions {
    pub caller_deadline_ms: Option<f64>,
    pub preset: Option<Value>,
    pub concurrency: Option<f64>,
    pub max_concurrent: Option<f64>,
}

/// `resolveCycle1Plan`; `default_preset` is `resolveMaintenancePreset('memory')`.
pub fn resolve_cycle1_plan(config: &Value, options: &PlanOptions, default_preset: Option<Value>) -> Plan {
    let c = |key: &str| config.get(key);
    let nested = |key: &str| config.get("cycle1").and_then(|n| n.get(key));
    let batch_size = js_max(1.0, number_of(&[c("batch_size")], 100.0));
    let window_size = js_min(PACKET_MAX_ROWS as f64, js_max(1.0, number_of(&[c("window_size"), c("windowSize")], batch_size)));
    let max_packets = js_min(MAX_PACKETS as f64, js_max(1.0, number_of(&[c("max_packets"), c("maxPackets")], MAX_PACKETS as f64)));
    let per_session = number_of(&[c("rows_per_session"), c("rowsPerSession"), c("max_rows_per_session"), c("maxRowsPerSession")], batch_size);
    let rows_per_session = js_max(window_size, if truthy(per_session) { per_session } else { batch_size });
    let min_batch = js_max(1.0, number_of(&[c("min_batch"), nested("min_batch")], MIN_BATCH));
    let session_cap = js_max(1.0, number_of(&[c("session_cap"), nested("session_cap")], SESSION_CAP));
    let backfill_cap = js_min(js_max(1.0, (session_cap / 3.0).floor()), js_max(1.0, session_cap - 1.0));
    let caller_deadline = options.caller_deadline_ms.unwrap_or(0.0);
    let base_timeout = number_of(&[c("timeout"), nested("timeout")], 180_000.0);
    let requested = |v: Option<f64>| v.map(Value::from);
    let (conc_a, conc_b) = (requested(options.concurrency), requested(options.max_concurrent));
    let concurrency = js_min(
        MAX_PACKETS as f64,
        js_max(1.0, number_of(&[c("cycle1_concurrency"), c("concurrency"), conc_a.as_ref(), conc_b.as_ref()], MAX_PACKETS as f64)),
    );
    let ms = |keys: [Option<&Value>; 2], fallback: f64| {
        let n = number_of(&keys, fallback);
        js_max(0.0, if truthy(n) { n } else { 0.0 })
    };
    Plan {
        window_size,
        max_packets,
        rows_per_session,
        min_batch,
        session_cap,
        backfill_cap,
        session_quiet_ms: ms([c("session_quiet_ms"), c("sessionQuietMs")], SESSION_QUIET_MS),
        session_force_age_ms: ms([c("session_force_age_ms"), c("sessionForceAgeMs")], SESSION_FORCE_AGE_MS),
        only_session_id: js_trim(&match c("session_id").filter(|v| !v.is_null()).or(c("sessionId")).filter(|v| !v.is_null()) {
            Some(v) => value_to_string(v),
            None => String::new(),
        })
        .to_owned(),
        preset: options.preset.clone().filter(|p| !p.is_null()).or(default_preset),
        timeout: if caller_deadline > 0.0 { js_min(base_timeout, js_max(5000.0, caller_deadline - 1000.0)) } else { base_timeout },
        input_token_budget: number_of(&[c("input_token_budget")], CYCLE1_INPUT_TOKEN_BUDGET),
        concurrency,
    }
}

fn omitted_max_doublings() -> i64 {
    ((OMITTED_COOLDOWN_MAX_MS as f64 / OMITTED_COOLDOWN_MS as f64).log2()).ceil() as i64
}

/// `cycle1RowDueSql`: "this unchunked row may be sent now" - never reviewed, or its cooldown
/// (doubling with each miss counted in `error_count`) has passed.
pub fn cycle1_row_due_sql(now_param: &str, alias: &str) -> String {
    let c = if alias.is_empty() { String::new() } else { format!("{alias}.") };
    let doublings = format!("LEAST(GREATEST(COALESCE({c}error_count, 0) - 1, 0), {})", omitted_max_doublings());
    let cooldown = format!("LEAST({OMITTED_COOLDOWN_MAX_MS}::bigint, {OMITTED_COOLDOWN_MS}::bigint * (1::bigint << {doublings}))");
    format!("({c}reviewed_at IS NULL OR {c}reviewed_at < {now_param}::bigint - {cooldown})")
}

/// `cycle1UnchunkedSql`: an unchunked row that belongs to a session.
pub fn cycle1_unchunked_sql(alias: &str) -> String {
    let c = if alias.is_empty() { String::new() } else { format!("{alias}.") };
    format!("{c}chunk_root IS NULL AND {c}session_id IS NOT NULL AND NULLIF(btrim({c}session_id), '') IS NOT NULL")
}

pub fn is_structurally_unchunkable(row: &Row) -> bool {
    js_trim(&row.content).is_empty()
}

pub fn row_of(row: &tokio_postgres::Row) -> Row {
    Row {
        id: row.get("id"),
        ts: row.get("ts"),
        role: row.get("role"),
        content: row.get("content"),
        session_id: row.get("session_id"),
        // The commit's locking read (Node) selects no project_id: absent there.
        project_id: row.try_get::<_, Option<String>>("project_id").ok().flatten(),
        element: None,
    }
}

/// `markTerminalRows`: `(attempted, marked, failed)`.
pub async fn mark_terminal_rows(db: &Db, ids: &[i64], label: &str, now: i64) -> (usize, usize, usize) {
    let ids: Vec<i64> = ids.iter().copied().filter(|&id| id > 0).collect();
    if ids.is_empty() {
        return (0, 0, 0);
    }
    let updated = db
        .execute(
            "UPDATE entries
       SET chunk_root = id,
           is_root = 0,
           status = 'archived',
           reviewed_at = COALESCE(reviewed_at, $2)
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0",
            &[&ids, &now],
        )
        .await;
    match updated {
        Ok(marked) => (ids.len(), marked as usize, ids.len().saturating_sub(marked as usize)),
        Err(error) => {
            log(&format!("[cycle1] {label} sentinel update failed: {}\n", error.message()));
            (ids.len(), 0, ids.len())
        }
    }
}

/// `markOmittedRows`: `(attempted, deferred, failed)`. Only a miss the classifier produced
/// counts toward the lengthening cooldown; `transient` rows never got an answer.
pub async fn mark_omitted_rows(db: &Db, ids: &[i64], transient: &[i64], now: i64) -> (usize, usize, usize) {
    let ids: Vec<i64> = ids.iter().copied().filter(|&id| id > 0).collect();
    if ids.is_empty() {
        return (0, 0, 0);
    }
    let transient: Vec<i64> = transient.iter().copied().filter(|&id| id > 0).collect();
    let updated = db
        .query(
            "UPDATE entries
       SET reviewed_at = $2,
           error_count = COALESCE(error_count, 0) + CASE WHEN id = ANY($3::bigint[]) THEN 0 ELSE 1 END
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0
       RETURNING id",
            &[&ids, &now, &transient],
        )
        .await;
    match updated {
        Ok(rows) => (ids.len(), rows.len(), ids.len().saturating_sub(rows.len())),
        Err(error) => {
            log(&format!("[cycle1] omitted retry update failed: {}\n", error.message()));
            (ids.len(), 0, ids.len())
        }
    }
}

/// `selectRootId`: the earliest member, ties broken by the smallest id.
pub fn select_root_id(members: &[Row]) -> Option<i64> {
    members.iter().min_by_key(|m| (m.ts, m.id)).map(|m| m.id)
}

async fn count_unchunked(db: &Db, due_at: Option<i64>) -> Option<i64> {
    let mut sql = format!("SELECT COUNT(*) AS c FROM entries WHERE {}", cycle1_unchunked_sql(""));
    let rows = match due_at {
        Some(now) => {
            sql.push_str(&format!("\n         AND {}", cycle1_row_due_sql("$1", "")));
            db.query(sql.as_str(), &[&now]).await
        }
        None => db.query(sql.as_str(), &[]).await,
    };
    rows.ok().and_then(|rows| rows.first().map(|r| r.get::<_, i64>(0)))
}

/// `countPendingRows`: unchunked rows due now; `None` when the count failed.
pub async fn count_pending_rows(db: &Db, now: i64) -> Option<i64> {
    count_unchunked(db, Some(now)).await
}

/// `countRawUnchunkedRows`.
pub async fn count_raw_unchunked_rows(db: &Db) -> Option<i64> {
    count_unchunked(db, None).await
}

/// `fetchCycle1Rows`: recency-first sessions plus the starved backfill slice, then the newest rows
/// per selected session, newest first.
pub async fn fetch_cycle1_rows(db: &Db, plan: &Plan, now: i64) -> Result<Vec<Row>> {
    let (session_cap, per_session, backfill) = (plan.session_cap as i32, plan.rows_per_session as i64, plan.backfill_cap as i32);
    let only = !plan.only_session_id.is_empty();
    let session_filter = if only { "AND session_id = $4" } else { "" };
    let backfill_param = if only { "$5" } else { "$4" };
    let (quiet_cut, force_cut) = (now - plan.session_quiet_ms as i64, now - plan.session_force_age_ms as i64);
    let due_sql = if only {
        String::new()
    } else {
        let at = 5;
        format!(
            "WHERE oldest_ts <= ${}\n          OR NOT EXISTS (\n            SELECT 1 FROM entries active\n            WHERE active.session_id = eligible_sessions.session_id AND active.ts > ${}\n          )",
            at + 1,
            at
        )
    };
    let sql = format!(
        "WITH eligible_sessions AS (
       SELECT session_id, MAX(ts) AS latest_ts, MAX(id) AS latest_id, MIN(ts) AS oldest_ts
       FROM entries
       WHERE {unchunked}
         AND {due}
         {session_filter}
       GROUP BY session_id
     ), due_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM eligible_sessions
       {due_sql}
     ), recent_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM due_sessions
       ORDER BY latest_ts DESC, latest_id DESC
       LIMIT GREATEST($1::int - {backfill_param}::int, 0)
     ), starved_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM due_sessions
       ORDER BY latest_ts ASC, latest_id ASC
       LIMIT {backfill_param}::int
     ), selected_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM recent_sessions
       UNION
       SELECT session_id, latest_ts, latest_id FROM starved_sessions
     ), ranked AS (
       SELECT e.id, e.ts, e.role, e.content, e.session_id, e.source_ref, e.project_id,
              s.latest_ts, s.latest_id,
              ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts DESC, e.id DESC) AS rn
       FROM entries e
       JOIN selected_sessions s ON s.session_id = e.session_id
       WHERE {unchunked_e}
         AND {due_e}
     )
     SELECT id, ts, role, content, session_id, source_ref, project_id
     FROM ranked
     WHERE rn <= $3
     ORDER BY latest_ts DESC, latest_id DESC, session_id, ts DESC, id DESC",
        unchunked = cycle1_unchunked_sql(""),
        due = cycle1_row_due_sql("$2", ""),
        unchunked_e = cycle1_unchunked_sql("e"),
        due_e = cycle1_row_due_sql("$2", "e"),
    );
    // Placeholders are positional: $1 cap, $2 now, $3 rows per session, then either the session
    // filter and the backfill ($4, $5) or the backfill and the quiet and force cut-offs ($4..$6).
    let rows = if only {
        db.query(sql.as_str(), &[&session_cap, &now, &per_session, &plan.only_session_id, &backfill]).await?
    } else {
        db.query(sql.as_str(), &[&session_cap, &now, &per_session, &backfill, &quiet_cut, &force_cut]).await?
    };
    Ok(rows.iter().map(row_of).collect())
}

/// `groupRowsBySession`: up to `session_cap` sessions in fetch order, each with its rows.
pub fn group_rows_by_session(rows_desc: Vec<Row>, session_cap: usize, cancel: &CancellationToken) -> Result<Vec<(String, Vec<Row>)>> {
    let mut sessions: Vec<(String, Vec<Row>)> = Vec::new();
    for row in rows_desc {
        if cancel.is_cancelled() {
            return Err(MemoryError::Cancelled);
        }
        let sid = row.session_id.clone().unwrap_or_default();
        if sid.is_empty() {
            continue;
        }
        match sessions.iter().position(|(id, _)| *id == sid) {
            Some(at) => sessions[at].1.push(row),
            None if sessions.len() >= session_cap => {}
            None => sessions.push((sid, vec![row])),
        }
    }
    Ok(sessions)
}
