// Current-session browse: roots + not-yet-chunked leaves of one session,
// newest-first, optionally with each root's members inlined, rendered as a
// plain page, a compaction digest, or a compact handoff timeline.
import { compactDigestRows, renderEntryLines, sessionRecallTerms } from './recall-format.mjs';
import { compactHandoffRows } from './compact-handoff.mjs';

const SESSION_ENTRY_COLUMNS = `id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
             element, category, summary, chunk_quality, status, score, last_seen_at, project_id`;
const SESSION_TEXT_EXPR = `lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))`;
// Roots + not-yet-chunked leaves only. Once cycle1 turns raw leaves into
// (root, members) pairs, selecting every row unfiltered emitted the root's
// summary AND its own member rows in the same browse — duplicate content. A
// committed member (is_root=0 with a chunk_root) is always reachable via its
// root's `members` expansion, so it never needs to be selected directly.
const BROWSABLE_ROW = '(is_root = 1 OR chunk_root IS NULL OR chunk_root = id)';
const IN_FLIGHT_TURN_FRESHNESS_MS = 5 * 60 * 1000;

/** Current-turn cutoff: the newest unchunked row is very often the calling
 *  turn's OWN recall request/tool-args, still being written when this query
 *  runs. Returns its source_turn so a bare browse doesn't self-echo — only
 *  when its latest row is fresh (within FRESHNESS_MS of now); an older
 *  newest-unchunked turn is completed history (cycle1 just hasn't gotten to
 *  it, or drain timed out) and must stay visible. */
async function findInFlightTurn(db, sessionId) {
  try {
    const r = await db.query(
      `SELECT source_turn t, MAX(ts) last_ts FROM entries
           WHERE session_id = $1 AND chunk_root IS NULL
           GROUP BY source_turn ORDER BY source_turn DESC LIMIT 1`,
      [sessionId]
    );
    const t = r.rows?.[0]?.t;
    const lastTs = Number(r.rows?.[0]?.last_ts);
    if (t != null && Number.isFinite(lastTs) && Date.now() - lastTs <= IN_FLIGHT_TURN_FRESHNESS_MS) return Number(t);
  } catch {}
  return null;
}

function excludeTurn(where, params, sourceTurn) {
  if (!Number.isFinite(sourceTurn)) return;
  params.push(sourceTurn);
  where.push(`NOT (chunk_root IS NULL AND source_turn = $${params.length})`);
}

async function selectSessionEntries(db, where, params, limit) {
  if (limit != null) params.push(limit);
  const limitClause = limit == null ? '' : `LIMIT $${params.length}`;
  return (
    await db.query(
      `
        SELECT ${SESSION_ENTRY_COLUMNS}
        FROM entries
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC, source_turn DESC NULLS LAST, id DESC
        ${limitClause}
      `,
      params
    )
  ).rows;
}

/** One page of browsable rows, back-filled from older unfiltered rows when the
 *  term filter or in-flight cutoff left it short of `fetchLimit`. */
async function selectSessionPage(db, { sessionId, terms, excludeSourceTurn, fetchLimit }) {
  const params = [sessionId];
  const where = ['session_id = $1', BROWSABLE_ROW];
  excludeTurn(where, params, excludeSourceTurn);
  if (terms.length > 0) {
    const clauses = terms.map((term) => {
      params.push(`%${term}%`);
      return `${SESSION_TEXT_EXPR} LIKE $${params.length}`;
    });
    where.push(`(${clauses.join(' OR ')})`);
  }
  let rows = await selectSessionEntries(db, where, params, fetchLimit);
  if (fetchLimit != null && rows.length < fetchLimit) {
    const seen = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)));
    const fillLimit = Math.max(0, fetchLimit - rows.length);
    const fillWhere = ['session_id = $1', 'id <> ALL($2::bigint[])', BROWSABLE_ROW];
    const fillParams = [sessionId, [...seen]];
    excludeTurn(fillWhere, fillParams, excludeSourceTurn);
    const fillRows = fillLimit > 0 ? await selectSessionEntries(db, fillWhere, fillParams, fillLimit) : [];
    if (fillRows.length > 0) rows = [...rows, ...fillRows];
  }
  return rows;
}

/** Inlines each root's committed members (turn order) as `row.members`. */
async function attachRootMembers(db, rows) {
  const rootIds = rows
    .filter((row) => Number(row.is_root) === 1)
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id));
  if (rootIds.length === 0) return;
  const members = (
    await db.query(
      `
          SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
          FROM entries
          WHERE chunk_root = ANY($1::bigint[])
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        `,
      [rootIds]
    )
  ).rows;
  const byRoot = new Map(rootIds.map((id) => [id, []]));
  for (const member of members) {
    const root = Number(member.chunk_root);
    if (byRoot.has(root)) byRoot.get(root).push(member);
  }
  for (const row of rows) {
    const id = Number(row.id);
    if (byRoot.has(id)) row.members = byRoot.get(id);
  }
}

export async function recallSessionRows(db, args = {}) {
  const sessionId = String(args.sessionId || args.session_id || '').trim();
  if (!sessionId) return { text: '(no current session)' };
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
  const compactDigest = args.compactDigest === true;
  const compactHandoff = args.compactHandoff === true;
  // Over-fetch before compact-only dedupe so duplicated legacy rows cannot
  // consume the requested page and hide distinct older context.
  let fetchLimit = limit;
  if (compactHandoff) fetchLimit = null;
  else if (compactDigest) fetchLimit = Math.min(100, Math.max(limit, limit * 4));
  const terms = sessionRecallTerms(args.query);
  // The in-flight cutoff applies to a bare (no-query) browse only: a query
  // browse (explicit search intent) keeps the newest turn, and a compaction
  // digest/handoff reads the completed session history already persisted by
  // the transcript watcher — a freshness cutoff there could silently drop the
  // newest finalized turn.
  const excludeSourceTurn =
    !compactDigest && !compactHandoff && terms.length === 0 ? await findInFlightTurn(db, sessionId) : null;
  let rows = await selectSessionPage(db, { sessionId, terms, excludeSourceTurn, fetchLimit });
  if (args.includeMembers === true || compactHandoff) await attachRootMembers(db, rows);
  if (compactHandoff) {
    rows = compactHandoffRows(rows, { preserveLatestUserTurns: args.preserveLatestUserTurns });
  } else if (compactDigest) rows = compactDigestRows(rows, limit);
  return {
    // Compact handoff reads as one session timeline: oldest first, RAW rows
    // without their meaningless ingest-time stamps, bodies uncapped.
    text: renderEntryLines(rows, {
      pendingMarks: !compactDigest && !compactHandoff,
      chronologicalOrder: compactHandoff,
      compactTimestamps: compactHandoff,
      maxBodyChars: compactHandoff ? null : 8000,
      preserveSource: args.includeMembers === true || args.includeRaw === true,
      includeRootSource: !compactHandoff && args.includeMembers === true,
    }),
  };
}
