//! Per-session day sums: their resumable build, the session read and the group token.
//!
//! `usage_session_days` holds one session's records summed per day and route, and refers
//! to its route by id only: provider and model come from `usage_routes` when a sum is
//! read. The triggers keep the sums equal to `usage_events` for sessions below the build
//! cursor `usage_session_days_state.next`; the build step recomputes whole sessions from
//! the records, so a write that lands between steps is counted once whichever side of the
//! cursor it falls.

use serde_json::Map;
use serde_json::Value;

use crate::bucket::Amount;
use crate::bucket::Bucket;
use crate::db::Connection;
use crate::db::TransactionBehavior;
use crate::db::params;
use crate::error::LedgerError;
use crate::error::Result;
use crate::measure::NO_USAGE_COST_SOURCE;
use crate::measure::day_text_sql;
use crate::measure::js_number;

/// Records one build step covers, at most (a single session may exceed it: the cursor is a
/// session id).
pub const SUM_BUILD_STEP_EVENTS: i64 = 1000;

/// Persisted cursor of the build lives in `usage_session_days_state`; a maintenance job
/// needs no other state.
pub fn sums_complete(conn: &Connection) -> Result<bool> {
    Ok(conn
        .query_row("SELECT complete FROM usage_session_days_state", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|complete| complete == 1)?)
}

/// Builds the sums for the next sessions in one short `BEGIN IMMEDIATE` transaction that
/// also commits how far it got. Returns `true` once the sums are complete.
pub fn build_sums_step(conn: &mut Connection, budget: i64) -> Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (complete, next): (i64, i64) = tx.query_row(
        "SELECT complete, next FROM usage_session_days_state",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if complete == 1 {
        return Ok(true);
    }
    let mut last: Option<i64> = None;
    let mut events = 0;
    let mut exhausted = true;
    {
        let mut sessions = tx.prepare(
            "SELECT session, COUNT(*) FROM usage_events WHERE session >= ?1 GROUP BY session ORDER BY session",
        )?;
        let mut rows = sessions.query([next])?;
        while let Some(row) = rows.next()? {
            let (session, n): (i64, i64) = (row.get(0)?, row.get(1)?);
            if last.is_some() && events + n > budget {
                exhausted = false;
                break;
            }
            last = Some(session);
            events += n;
        }
    }
    // The last step also clears whatever lies beyond the sessions that still have records.
    match (exhausted, last) {
        (true, _) => tx.execute("DELETE FROM usage_session_days WHERE session >= ?1", [next])?,
        (false, Some(last)) => tx.execute(
            "DELETE FROM usage_session_days WHERE session BETWEEN ?1 AND ?2",
            params![next, last],
        )?,
        (false, None) => 0,
    };
    if let Some(last) = last {
        tx.execute(
            "INSERT INTO usage_session_days (session,day,route,turns,input,output,cache_read,cache_write,
                cost_usd,duration_ms,speed_output,speed_ms)
             SELECT e.session,e.day,e.route,COUNT(*),SUM(e.input),SUM(e.output),SUM(e.cache_read),SUM(e.cache_write),
                SUM(COALESCE(e.cost_usd,0)),SUM(e.duration_ms),
                SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END),
                SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END)
             FROM usage_events e WHERE e.session BETWEEN ?1 AND ?2 GROUP BY e.session,e.day,e.route",
            params![next, last],
        )?;
    }
    tx.execute(
        "UPDATE usage_session_days_state SET complete = ?1, next = ?2 WHERE id = 1",
        params![exhausted, last.map_or(next, |last| last + 1)],
    )?;
    tx.commit()?;
    Ok(exhausted)
}

/// Sessions named by value, plus every session recorded as run for one of `owners`,
/// transitively.
const MEMBERS: &str = "WITH RECURSIVE owned(id) AS (
        SELECT o.session FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner
        WHERE s.value IN (SELECT value FROM json_each(?1))
        UNION
        SELECT o.session FROM usage_session_owners o JOIN owned ON o.owner=owned.id
    ), members AS (
        SELECT id FROM usage_sessions WHERE value IN (SELECT value FROM json_each(?2))
        UNION SELECT id FROM owned
    )";

/// The token of a group of sessions: it changes whenever a number [`read_session_usage`]
/// would return for the group can have changed, and not otherwise.
pub fn read_usage_token(
    conn: &Connection,
    session_ids: &[String],
    owner_ids: &[String],
) -> Result<String> {
    let sql = format!(
        "{MEMBERS}
        SELECT (SELECT rev FROM usage_membership_revision),
            (SELECT COUNT(*) FROM members),
            (SELECT COALESCE(SUM(rev),0) FROM usage_session_revisions WHERE session IN (SELECT id FROM members)),
            (SELECT COALESCE(SUM(k.rev),0) FROM usage_key_revisions k WHERE EXISTS (
                SELECT 1 FROM usage_session_days d JOIN usage_routes r ON r.id = d.route
                WHERE d.session IN (SELECT id FROM members) AND d.day = k.day
                    AND json_extract(r.signature,'$[0]') = k.provider
                    AND json_extract(r.signature,'$[1]') = k.model))"
    );
    let (membership, members, sessions, keys): (i64, i64, i64, i64) = conn.query_row(
        &sql,
        params![
            serde_json::to_string(owner_ids)?,
            serde_json::to_string(session_ids)?
        ],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    Ok(format!("{membership}.{members}.{sessions}.{keys}"))
}

/// One session's lifetime totals over every id its spend was recorded under, with the same
/// route choice as a rollup (a gateway summary never doubles a detail record). `owner_ids`
/// adds every session recorded as run for one of them.
pub fn read_session_usage(
    conn: &Connection,
    session_ids: &[String],
    owner_ids: &[String],
) -> Result<Value> {
    if !sums_complete(conn)? {
        return Err(LedgerError::SumsBuilding);
    }
    let sql = format!(
        // The statement keeps the Node ledger's shape: float sums are order-sensitive, and the
        // planner orders rows by the statement it is given.
        "WITH RECURSIVE owned(id) AS (
                SELECT o.session FROM usage_session_owners o JOIN usage_sessions s ON s.id=o.owner
                WHERE s.value IN (SELECT value FROM json_each(?))
                UNION
                SELECT o.session FROM usage_session_owners o JOIN owned ON o.owner=owned.id
            ), mine AS (
                SELECT day,route,SUM(turns) AS turns,SUM(input) AS input,SUM(output) AS output,
                    SUM(cache_read) AS cache_read,SUM(cache_write) AS cache_write,
                    SUM(cost_usd) AS cost_usd,SUM(duration_ms) AS duration_ms,
                    SUM(speed_output) AS speed_output,SUM(speed_ms) AS speed_ms
                FROM usage_session_days WHERE session IN (
                    SELECT id FROM usage_sessions WHERE value IN (SELECT value FROM json_each(?))
                    UNION SELECT id FROM owned)
                GROUP BY day,route
            ), attributed AS (
            SELECT {day} AS day,
                json_extract(r.signature,'$[0]') AS provider,
                json_extract(r.signature,'$[1]') AS model,
                json_extract(r.signature,'$[4]') AS cost_source,
                json_extract(r.signature,'$[7]') AS rank,
                COALESCE(json_extract(json_extract(r.signature,'$[5]'),'$.inputTokensKnown'),1)=0 AS unmeasured,
                m.turns,m.input,m.output,m.cache_read,m.cache_write,m.cost_usd,m.duration_ms,
                m.speed_output,m.speed_ms
            FROM mine m JOIN usage_routes r ON r.id=m.route
            WHERE json_extract(r.signature,'$[4]')<>'{NO_USAGE_COST_SOURCE}'
        )
        SELECT a.* FROM attributed a JOIN ({best}) b USING(day,provider,model,rank)",
        day = day_text_sql("m"),
        best = crate::rollup::BEST_SQL,
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![
        serde_json::to_string(owner_ids)?,
        serde_json::to_string(session_ids)?,
        "0000-01-01",
        "9999-12-31",
    ])?;
    let mut total = Bucket::new();
    let (mut speed_output, mut speed_ms) = (0.0, 0.0);
    while let Some(row) = rows.next()? {
        let provider: String = row.get(1)?;
        let cost_source: String = row.get(3)?;
        total.add(
            &Amount {
                provider: &provider,
                turns: row.get(6)?,
                input: row.get(7)?,
                output: row.get(8)?,
                cache_read: row.get(9)?,
                cache_write: row.get(10)?,
                cost_usd: row.get(11)?,
                cost_source: &cost_source,
                duration_ms: row.get(12)?,
                unmeasured: row.get::<_, i64>(5)? != 0,
            },
            1.0,
        );
        speed_output += row.get::<_, f64>(13)?;
        speed_ms += row.get::<_, f64>(14)?;
    }
    let mut usage: Map<String, Value> = total.measurements();
    usage.insert("speedOutput".to_string(), js_number(speed_output));
    usage.insert("speedMs".to_string(), js_number(speed_ms));
    Ok(Value::Object(usage))
}
