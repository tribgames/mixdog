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
use crate::db::OptionalExtension;
use crate::db::Transaction;
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

/// One (day, route) of a session: the values SQLite's own `SUM` gives over the session's records
/// (the exact numbers Node's build stores).
pub(crate) struct DayRow {
    day: i64,
    route: i64,
    turns: i64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: f64,
    duration_ms: f64,
    speed_output: f64,
    speed_ms: f64,
}

pub(crate) struct SessionSums {
    session: i64,
    rows: Vec<DayRow>,
}

/// Whole sessions' sums, aggregated by `SUM` over one snapshot of the records. It covers every
/// session in `from_next..upto` (the others in that range had no record in the snapshot), or
/// every session from `from_next` on when `exhausted`.
pub(crate) struct Snapshot {
    from_next: i64,
    upto: i64,
    exhausted: bool,
    sessions: Vec<SessionSums>,
}

/// Sums whole sessions from `from_next` until at least `budget` records are covered (always one
/// session if any). Runs on any connection holding a snapshot, the writer's or a reader's: it
/// counts and sums a session in full, so it belongs on a maintenance lane, never on the writer.
pub(crate) fn aggregate_batch(conn: &Connection, from_next: i64, budget: i64) -> Result<Snapshot> {
    let mut sessions = Vec::new();
    let mut cursor = from_next;
    let mut events = 0;
    let mut exhausted = false;
    while events < budget.max(1) {
        let first: Option<i64> = conn
            .query_row(
                "SELECT session FROM usage_events WHERE session>=?1 ORDER BY session LIMIT 1",
                [cursor],
                |r| r.get(0),
            )
            .optional()?;
        let Some(session) = first else {
            exhausted = true;
            break;
        };
        events += conn.query_row(
            "SELECT COUNT(*) FROM usage_events WHERE session=?1",
            [session],
            |r| r.get::<_, i64>(0),
        )?;
        // The statement of Node's build (`buildSessionDaysStep`), restricted to one session.
        let mut stmt = conn.prepare_cached(
            "SELECT e.day,e.route,COUNT(*),SUM(e.input),SUM(e.output),SUM(e.cache_read),SUM(e.cache_write),
                SUM(COALESCE(e.cost_usd,0)),SUM(e.duration_ms),
                SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END),
                SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END)
             FROM usage_events e WHERE e.session=?1 GROUP BY e.session,e.day,e.route",
        )?;
        let rows = stmt
            .query_map([session], |r| {
                Ok(DayRow {
                    day: r.get(0)?,
                    route: r.get(1)?,
                    turns: r.get(2)?,
                    input: r.get(3)?,
                    output: r.get(4)?,
                    cache_read: r.get(5)?,
                    cache_write: r.get(6)?,
                    cost_usd: r.get(7)?,
                    duration_ms: r.get(8)?,
                    speed_output: r.get(9)?,
                    speed_ms: r.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        sessions.push(SessionSums { session, rows });
        cursor = session + 1;
    }
    Ok(Snapshot {
        from_next,
        upto: cursor,
        exhausted,
        sessions,
    })
}

/// A record the writer committed after the snapshot was taken.
pub(crate) struct Late {
    pub session: i64,
    pub id: Vec<u8>,
}

/// What [`apply_snapshot`] did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Applied {
    /// The cursor moved since the snapshot was taken: nothing was written.
    Stale,
    /// Applied; `true` when the sums are now complete.
    Done(bool),
}

/// Installs a snapshot and moves the cursor past it, in the caller's write transaction.
///
/// Invariant (`next` is the build cursor; the insert/update/delete triggers count a record iff
/// `complete = 1 OR session < next`): every record is counted exactly once, by its session's
/// sums.
///  - A record of a session below `next` is counted by the trigger when it is written.
///  - A record of a session at or above `next` is not counted until the build reaches its
///    session, which sums every record that session holds at that moment.
///  - `next` moves only here. This transaction sums the snapshot's sessions, and then adds each
///    `late` record (written after the snapshot, in commit order, one at a time: the trigger's
///    own upsert) whose session lies in the range the cursor passes, those of sessions that were
///    empty in the snapshot included. A session beyond the range is left to a later batch.
///  - So a record written while a batch was being summed is counted by exactly one of the
///    batch, this fold-in, or a later batch, whichever side of the cursor its session lies on.
///
/// The writer is the only writer of records and the only caller, so `late` is every record
/// written since the snapshot.
pub(crate) fn apply_snapshot(
    tx: &Transaction,
    snapshot: &Snapshot,
    late: &[Late],
) -> Result<Applied> {
    let (complete, next): (i64, i64) = tx.query_row(
        "SELECT complete, next FROM usage_session_days_state",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if complete == 1 || next != snapshot.from_next {
        return Ok(Applied::Stale);
    }
    // Leftover rows of sessions the build is about to cover.
    if snapshot.exhausted {
        tx.execute("DELETE FROM usage_session_days WHERE session >= ?1", [next])?;
    } else {
        tx.execute(
            "DELETE FROM usage_session_days WHERE session >= ?1 AND session < ?2",
            params![next, snapshot.upto],
        )?;
    }
    let mut insert = tx.prepare_cached(
        "INSERT INTO usage_session_days (session,day,route,turns,input,output,cache_read,cache_write,
            cost_usd,duration_ms,speed_output,speed_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
    )?;
    for sums in &snapshot.sessions {
        for r in &sums.rows {
            insert.execute(params![
                sums.session,
                r.day,
                r.route,
                r.turns,
                r.input,
                r.output,
                r.cache_read,
                r.cache_write,
                r.cost_usd,
                r.duration_ms,
                r.speed_output,
                r.speed_ms
            ])?;
        }
    }
    for record in late {
        let passed = record.session >= snapshot.from_next
            && (snapshot.exhausted || record.session < snapshot.upto);
        if passed {
            add_record(tx, record.session, &record.id)?;
        }
    }
    tx.execute(
        "UPDATE usage_session_days_state SET complete = ?1, next = ?2 WHERE id = 1",
        params![snapshot.exhausted, snapshot.upto],
    )?;
    Ok(Applied::Done(snapshot.exhausted))
}

/// Adds one record to its session's sums: the insert trigger's upsert (Node's
/// `SESSION_DAY_UPSERT`, `usage-ledger-rollup.mjs:474`), a plain addition to the stored row.
fn add_record(tx: &Transaction, session: i64, id: &[u8]) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO usage_session_days (session,day,route,turns,input,output,cache_read,cache_write,
            cost_usd,duration_ms,speed_output,speed_ms)
         SELECT e.session,e.day,e.route,1,e.input,e.output,e.cache_read,e.cache_write,
            COALESCE(e.cost_usd,0),e.duration_ms,
            CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END,
            CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END
         FROM usage_events e WHERE e.session=?1 AND e.id=?2
         ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
            output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
            cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
            duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
            speed_ms=speed_ms+excluded.speed_ms",
    )?
    .execute(params![session, id])?;
    Ok(())
}

/// Builds the sums of the next whole sessions (until `budget` records are covered) in one
/// `BEGIN IMMEDIATE` transaction that also commits how far it got: Node's
/// `buildSessionDaysStep`. For a ledger that nothing else writes (a tool, a test setup): a
/// session is summed in full while the lock is held. The core's writer never calls it; it
/// summed on a maintenance lane and applies the result briefly (`UsageWriter`). Returns `true`
/// once the sums are complete.
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
    let snapshot = aggregate_batch(&tx, next, budget)?;
    let applied = apply_snapshot(&tx, &snapshot, &[])?;
    tx.commit()?;
    Ok(applied == Applied::Done(true))
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
pub(crate) fn read_usage_token(
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
pub(crate) fn read_session_usage(
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

#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    reason = "test fixture: temporary ledger files"
)]
mod tests {
    use super::*;
    use crate::append::UsageRecord;
    use crate::append::append_batch;
    use crate::schema::prepare;

    fn record(n: u64, session: &str, cost: f64) -> UsageRecord {
        serde_json::from_value(serde_json::json!({
            "id": format!("{n:064x}"), "ts": 1_000 + n, "day": "2026-01-01", "provider": "p",
            "model": "m", "kind": "api", "sessionId": session, "sourceType": "user", "input": 10,
            "output": 5, "cacheRead": 1, "cacheWrite": 2, "costUsd": cost, "costSource": "catalog",
            "origin": "live", "durationMs": 100
        }))
        .unwrap()
    }

    /// A ledger holding `records` whose sums are not built yet.
    fn unbuilt(dir: &std::path::Path, records: &[UsageRecord]) -> Connection {
        let mut conn = Connection::open(dir.join("ledger.sqlite")).unwrap();
        prepare(&mut conn).unwrap();
        append_batch(&mut conn, records).unwrap();
        conn.execute_batch(
            "DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0",
        )
        .unwrap();
        conn
    }

    type Sums = Vec<(i64, i64, i64, i64, [f64; 8])>;

    fn sums(conn: &Connection) -> Sums {
        let mut stmt = conn
            .prepare(
                "SELECT session,day,route,turns,input,output,cache_read,cache_write,cost_usd,
                    duration_ms,speed_output,speed_ms FROM usage_session_days ORDER BY session,day,route",
            )
            .unwrap();
        stmt.query_map([], |r| {
            let f = |i| r.get::<_, f64>(i);
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                [f(4)?, f(5)?, f(6)?, f(7)?, f(8)?, f(9)?, f(10)?, f(11)?],
            ))
        })
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap()
    }

    fn late_of(conn: &Connection, rows: &[UsageRecord]) -> Vec<Late> {
        rows.iter()
            .map(|row| {
                let id = crate::append::encode_usage_id(&row.id);
                let session = conn
                    .query_row("SELECT session FROM usage_events WHERE id=?1", [&id], |r| {
                        r.get(0)
                    })
                    .unwrap();
                Late { session, id }
            })
            .collect()
    }

    fn apply_in_tx(conn: &mut Connection, snapshot: &Snapshot, late: &[Late]) -> Applied {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let applied = apply_snapshot(&tx, snapshot, late).unwrap();
        tx.commit().unwrap();
        applied
    }

    /// Records written after the snapshot are added one at a time, in commit order: exactly
    /// the numbers a build that finished first and then saw the records through the trigger has.
    #[test]
    fn late_records_fold_in_as_the_trigger_adds_them() {
        let first: Vec<UsageRecord> = (0..50)
            .map(|n| record(n, "a", 0.1 * ((n % 7) + 1) as f64))
            .collect();
        let late_rows = [
            record(100, "a", 0.3),
            record(101, "a", 0.7),
            record(102, "a", 0.1),
        ];

        let dir = tempfile::tempdir().unwrap();
        let mut folded = unbuilt(dir.path(), &first);
        let snapshot = aggregate_batch(&folded, 0, 10).unwrap();
        append_batch(&mut folded, &late_rows).unwrap();
        let late = late_of(&folded, &late_rows);
        assert_eq!(
            apply_in_tx(&mut folded, &snapshot, &late),
            Applied::Done(false)
        );
        let rest = aggregate_batch(&folded, snapshot.upto, 10).unwrap();
        assert_eq!(apply_in_tx(&mut folded, &rest, &[]), Applied::Done(true));

        let other = tempfile::tempdir().unwrap();
        let mut triggered = unbuilt(other.path(), &first);
        while !build_sums_step(&mut triggered, 10).unwrap() {}
        append_batch(&mut triggered, &late_rows).unwrap();

        assert_eq!(sums(&folded), sums(&triggered));
    }

    /// A record appended to a session that was empty when the batch was summed, below the
    /// session the batch built, is counted once: the cursor passes that session, and the
    /// trigger skipped the record because the cursor had not.
    #[test]
    fn an_append_to_an_earlier_empty_session_is_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(dir.path().join("ledger.sqlite")).unwrap();
        prepare(&mut conn).unwrap();
        // 'e' is session 1 and holds nothing yet; 'l' is session 2, 'm' session 3.
        conn.execute("INSERT INTO usage_sessions(value) VALUES ('e')", [])
            .unwrap();
        let rows: Vec<UsageRecord> = (0..20)
            .map(|n| record(n, "l", 0.5))
            .chain((20..25).map(|n| record(n, "m", 0.5)))
            .collect();
        append_batch(&mut conn, &rows).unwrap();
        conn.execute_batch(
            "DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0",
        )
        .unwrap();

        let snapshot = aggregate_batch(&conn, 0, 10).unwrap();
        assert_eq!(
            (snapshot.upto, snapshot.exhausted),
            (3, false),
            "'l' alone reaches the budget"
        );
        let written = [record(100, "e", 0.5), record(101, "m", 0.5)];
        append_batch(&mut conn, &written).unwrap();
        let late = late_of(&conn, &written);
        assert_eq!(
            apply_in_tx(&mut conn, &snapshot, &late),
            Applied::Done(false)
        );
        // 'e' is in; 'm' (beyond the cursor) waits for its batch, which finds both its records.
        let turns = |conn: &Connection, session: &str| -> i64 {
            conn.query_row(
                "SELECT COALESCE(SUM(turns),0) FROM usage_session_days d
                 JOIN usage_sessions s ON s.id=d.session WHERE s.value=?1",
                [session],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            (turns(&conn, "e"), turns(&conn, "l"), turns(&conn, "m")),
            (1, 20, 0)
        );

        let rest = aggregate_batch(&conn, snapshot.upto, 10).unwrap();
        assert_eq!(apply_in_tx(&mut conn, &rest, &[]), Applied::Done(true));
        assert_eq!(
            (turns(&conn, "e"), turns(&conn, "l"), turns(&conn, "m")),
            (1, 20, 6)
        );
        // Every record is counted once, and later appends follow the trigger.
        append_batch(&mut conn, &[record(200, "e", 0.5)]).unwrap();
        assert_eq!(turns(&conn, "e"), 2);
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_events", [], |r| r.get(0))
            .unwrap();
        let counted: i64 = conn
            .query_row("SELECT SUM(turns) FROM usage_session_days", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(counted, events);
    }

    /// A snapshot taken before the cursor moved does not apply.
    #[test]
    fn a_snapshot_of_a_moved_cursor_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let rows: Vec<UsageRecord> = (0..4).map(|n| record(n, "a", 0.5)).collect();
        let mut conn = unbuilt(dir.path(), &rows);
        let snapshot = aggregate_batch(&conn, 0, 1).unwrap();
        build_sums_step(&mut conn, 1).unwrap();
        assert_eq!(apply_in_tx(&mut conn, &snapshot, &[]), Applied::Stale);
    }
}
