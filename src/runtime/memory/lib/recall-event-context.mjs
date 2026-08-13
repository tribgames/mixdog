import { buildRecallScopeFilter } from './memory-recall-scope-filter.mjs'
import { recallReadQuery } from './memory-recall-read-query.mjs'
const EVENT_TAIL_ROWS = 1

function sessionKey(row) {
  const value = String(row?.session_id ?? '').trim()
  return value || null
}

function anchorPoint(row) {
  const members = Array.isArray(row?.members) ? row.members : []
  const candidates = members.length > 0 ? members : [row]
  let best = null
  for (const candidate of candidates) {
    const turn = Number(candidate?.source_turn)
    const ts = Number(candidate?.ts)
    if (!best
      || (Number.isFinite(turn) && (!Number.isFinite(best.turn) || turn > best.turn))
      || (turn === best.turn && Number.isFinite(ts) && ts > best.ts)) {
      best = {
        turn: Number.isFinite(turn) ? turn : null,
        ts: Number.isFinite(ts) ? ts : Number(row?.ts) || 0,
      }
    }
  }
  return best ?? { turn: null, ts: Number(row?.ts) || 0 }
}

export function mergeRecallEventRows(rankedRows, tailRows, { dedupeEvents = false } = {}) {
  if (!Array.isArray(rankedRows) || rankedRows.length === 0) return []
  const tailsByAnchor = new Map()
  for (const row of Array.isArray(tailRows) ? tailRows : []) {
    const key = Number(row?._anchor_order)
    if (!Number.isInteger(key) || key < 0) continue
    if (!tailsByAnchor.has(key)) tailsByAnchor.set(key, [])
    tailsByAnchor.get(key).push(row)
  }
  const emittedIds = new Set()
  const emittedEventKeys = new Set()
  const out = []
  const emit = (row) => {
    const id = String(row?.id ?? '')
    if (id && emittedIds.has(id)) return
    if (id) emittedIds.add(id)
    out.push(row)
  }

  for (let index = 0; index < rankedRows.length; index += 1) {
    const tails = (tailsByAnchor.get(index) ?? []).slice(0, EVENT_TAIL_ROWS)
    const eventKey = String(tails[0]?._event_key ?? '')
    if (dedupeEvents && eventKey && emittedEventKeys.has(eventKey)) continue
    if (dedupeEvents && eventKey) emittedEventKeys.add(eventKey)
    for (const tail of tails) emit(tail)
    emit(rankedRows[index])
  }
  return out
}

export async function expandRecallEventContext(db, rankedRows, {
  query,
  limit,
  tsFrom,
  tsTo,
  excludeStatuses,
  category,
  projectScope,
  dedupeEvents = false,
} = {}) {
  const anchors = []
  const anchorLimit = Math.max(1, Math.floor(Number(limit) || 10))
  for (let index = 0; index < (Array.isArray(rankedRows) ? rankedRows.length : 0); index += 1) {
    const row = rankedRows[index]
    const sessionId = sessionKey(row)
    if (!sessionId) continue
    const point = anchorPoint(row)
    anchors.push({
      anchor_order: index,
      anchor_id: Number(row?.id) || null,
      session_id: sessionId,
      anchor_turn: point.turn,
      anchor_ts: point.ts,
    })
    if (anchors.length >= anchorLimit) break
  }
  if (anchors.length === 0) return rankedRows

  const normalizedQuery = String(query ?? '').trim().toLowerCase()
  const { clause, params } = buildRecallScopeFilter(3, {
    ts_from: tsFrom,
    ts_to: tsTo,
    excludeStatuses,
    projectScope,
  }, 'e')
  const { rows } = await recallReadQuery(db, `
    WITH anchors AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS a(
        anchor_order integer,
        anchor_id bigint,
        session_id text,
        anchor_turn integer,
        anchor_ts bigint
      )
    ),
    bounded AS (
      SELECT a.*,
             (
               SELECT MIN(next_row.source_turn)
               FROM entries next_row
               WHERE next_row.session_id = a.session_id
                 AND next_row.role = 'user'
                 AND a.anchor_turn IS NOT NULL
                 AND next_row.source_turn > a.anchor_turn
             ) AS next_user_turn,
             (
               SELECT MIN(next_row.ts)
               FROM entries next_row
               WHERE next_row.session_id = a.session_id
                 AND next_row.role = 'user'
                 AND next_row.ts > a.anchor_ts
             ) AS next_user_ts
      FROM anchors a
    ),
    ranked_event_rows AS (
      SELECT b.anchor_order AS _anchor_order,
             CONCAT(
               b.session_id,
               ':',
               CASE
                 WHEN b.anchor_turn IS NOT NULL THEN COALESCE(b.next_user_turn::text, 'open')
                 ELSE COALESCE(b.next_user_ts::text, 'open')
               END
             ) AS _event_key,
             e.id, e.ts, e.role, e.content, e.source_ref, e.session_id,
             e.source_turn, e.time_source, e.chunk_root, e.is_root,
             e.element, e.category, e.summary, e.status, e.score,
             e.last_seen_at, e.project_id,
             ROW_NUMBER() OVER (
               PARTITION BY b.anchor_order
               ORDER BY e.ts DESC, e.source_turn DESC NULLS LAST, e.id DESC
             ) AS event_rank
      FROM bounded b
      JOIN entries e ON e.session_id = b.session_id
      WHERE (
          (
            b.anchor_turn IS NOT NULL
            AND e.source_turn >= b.anchor_turn
            AND (b.next_user_turn IS NULL OR e.source_turn < b.next_user_turn)
          )
          OR (
            b.anchor_turn IS NULL
            AND e.ts >= b.anchor_ts
            AND (b.next_user_ts IS NULL OR e.ts < b.next_user_ts)
          )
        )
        AND e.is_root = 0
        AND ($2::text = '' OR lower(btrim(e.content)) <> $2)
        ${clause}
    )
    SELECT _anchor_order, _event_key, id, ts, role, content, source_ref, session_id, source_turn,
           time_source, chunk_root, is_root, element, category, summary,
           status, score, last_seen_at, project_id
    FROM ranked_event_rows
    WHERE event_rank <= ${EVENT_TAIL_ROWS}
    ORDER BY _anchor_order ASC, event_rank ASC
  `, [JSON.stringify(anchors), normalizedQuery, ...params])
  return mergeRecallEventRows(rankedRows, rows, { dedupeEvents })
}
