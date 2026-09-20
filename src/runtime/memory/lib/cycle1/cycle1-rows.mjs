// cycle1/cycle1-rows.mjs
// The entries rows cycle1 reads and marks: pending counts, the recency-first
// session fetch with its starvation backfill, session grouping, and the
// terminal / omitted sentinel updates.
import { __mixdogMemoryLog } from '../memory-log.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';
import { CYCLE1_OMITTED_COOLDOWN_MS } from './cycle1-plan.mjs';

export function isStructurallyUnchunkableInput(row) {
  return !String(row?.content ?? '').trim();
}

export function uniqueNumbers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => Number(v)).filter((v) => Number.isFinite(v)))];
}

function positiveEntryIds(rowIds) {
  return uniqueNumbers(rowIds).filter((id) => id > 0);
}

export async function markTerminalRows(db, rowIds, label = 'terminal') {
  const ids = positiveEntryIds(rowIds);
  if (ids.length === 0) return { attempted: 0, marked: 0, failed: 0 };
  try {
    const result = await db.query(
      `UPDATE entries
       SET chunk_root = id,
           is_root = 0,
           status = 'archived',
           reviewed_at = COALESCE(reviewed_at, $2)
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0`,
      [ids, Date.now()]
    );
    const marked = Number(result?.rowCount ?? 0);
    return { attempted: ids.length, marked, failed: Math.max(0, ids.length - marked) };
  } catch (err) {
    __mixdogMemoryLog(`[cycle1] ${label} sentinel update failed: ${err.message}\n`);
    return { attempted: ids.length, marked: 0, failed: ids.length };
  }
}

export async function markOmittedRows(db, rowIds) {
  const ids = positiveEntryIds(rowIds);
  if (ids.length === 0) return { attempted: 0, deferred: 0, marked: 0, failed: 0 };
  try {
    const result = await db.query(
      `UPDATE entries
       SET reviewed_at = $2,
           error_count = COALESCE(error_count, 0) + 1
       WHERE id = ANY($1::bigint[])
         AND chunk_root IS NULL
         AND is_root = 0
       RETURNING id`,
      [ids, Date.now()]
    );
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    // A model failure is not permission to retire source data. Keep every
    // nonempty row available after cooldown, regardless of retry count.
    return { attempted: ids.length, deferred: rows.length, marked: 0, failed: Math.max(0, ids.length - rows.length) };
  } catch (err) {
    __mixdogMemoryLog(`[cycle1] omitted retry update failed: ${err.message}\n`);
    return { attempted: ids.length, deferred: 0, marked: 0, failed: ids.length };
  }
}

/** The chunk root: the earliest member (ties broken by the smallest id). */
export function selectRootId(members) {
  let rootId = null;
  let rootTs = null;
  for (const m of members) {
    const ts = Number(m.ts);
    const id = Number(m.id);
    if (!Number.isFinite(ts) || !Number.isFinite(id)) continue;
    if (rootId === null || ts < rootTs || (ts === rootTs && id < rootId)) {
      rootId = id;
      rootTs = ts;
    }
  }
  return rootId;
}

async function countSessionUnchunkedRows(db, { reviewedBefore = null } = {}) {
  const where = ['chunk_root IS NULL', `NULLIF(btrim(session_id), '') IS NOT NULL`];
  const params = [];
  if (reviewedBefore != null) {
    params.push(reviewedBefore);
    where.push('(reviewed_at IS NULL OR reviewed_at < $1)');
  }
  try {
    const result = await db.query(
      `SELECT COUNT(*) AS c
       FROM entries
       WHERE ${where.join('\n         AND ')}`,
      params
    );
    return Number(result.rows[0]?.c ?? 0);
  } catch {
    return null;
  }
}

export function countPendingRows(db) {
  return countSessionUnchunkedRows(db, { reviewedBefore: Date.now() - CYCLE1_OMITTED_COOLDOWN_MS });
}

export function countRawUnchunkedRows(db) {
  return countSessionUnchunkedRows(db);
}

/** Select closest/recent sessions first (plus the starved backfill slice),
 *  then fetch closest/recent rows per selected session. Memory fill is
 *  recency-first; session isolation keeps unrelated episodes out of the same
 *  classifier prompt. Rows come back newest-first. */
export async function fetchCycle1Rows(db, plan) {
  const sessionFilterSql = plan.onlySessionId ? 'AND session_id = $4' : '';
  const queryParams = [plan.sessionCap, Date.now() - CYCLE1_OMITTED_COOLDOWN_MS, plan.rowsPerSession];
  if (plan.onlySessionId) queryParams.push(plan.onlySessionId);
  queryParams.push(plan.backfillCap);
  const backfillParam = `$${queryParams.length}`;
  const fetchStartedAt = Date.now();
  const fetchResult = await db.query(
    `WITH eligible_sessions AS (
       SELECT session_id, MAX(ts) AS latest_ts, MAX(id) AS latest_id
       FROM entries
       WHERE chunk_root IS NULL
         AND NULLIF(btrim(session_id), '') IS NOT NULL
         AND (reviewed_at IS NULL OR reviewed_at < $2)
         ${sessionFilterSql}
       GROUP BY session_id
     ), recent_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM eligible_sessions
       ORDER BY latest_ts DESC, latest_id DESC
       LIMIT GREATEST($1::int - ${backfillParam}::int, 0)
     ), starved_sessions AS (
       SELECT session_id, latest_ts, latest_id FROM eligible_sessions
       ORDER BY latest_ts ASC, latest_id ASC
       LIMIT ${backfillParam}::int
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
       WHERE e.chunk_root IS NULL
         AND (e.reviewed_at IS NULL OR e.reviewed_at < $2)
     )
     SELECT id, ts, role, content, session_id, source_ref, project_id
     FROM ranked
     WHERE rn <= $3
     ORDER BY latest_ts DESC, latest_id DESC, session_id, ts DESC, id DESC`,
    queryParams
  );
  return { rowsDesc: fetchResult.rows, fetchMs: Date.now() - fetchStartedAt };
}

/** Window by session first (up to sessionCap sessions, in fetch order), then
 *  by batch size inside that session. This makes the classifier input
 *  structurally correct instead of relying on prompt text to prevent
 *  cross-session merges. */
export function groupRowsBySession(rowsDesc, sessionCap, signal) {
  const rowsBySession = new Map();
  for (const row of rowsDesc) {
    throwIfAborted(signal);
    const sid = String(row.session_id || '');
    if (!sid) continue;
    if (!rowsBySession.has(sid)) {
      if (rowsBySession.size >= sessionCap) continue;
      rowsBySession.set(sid, []);
    }
    rowsBySession.get(sid).push(row);
  }
  return rowsBySession;
}
