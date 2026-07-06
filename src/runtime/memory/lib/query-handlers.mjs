// Recall / search / dump / stats query handlers extracted from index.mjs.
//
// These six functions form the read-side query cluster: they share the same
// live DB handle plus a small set of recall-format / retriever helpers, and a
// few facade-local pieces of state (the cold-recall log throttle and the
// optional trace DB used for recall
// telemetry). All of that is injected through createQueryHandlers({...}) so the
// module holds no state of its own and the facade keeps ownership of `db`,
// `_traceDb`, etc. (getBootTimestamp stays injected for facade compatibility
// but period='last' no longer reads it — 'last' is an unbounded newest-first
// browse.)

import {
  parsePeriod,
  coreRecallTerms,
  normalizeRecallProjectScope,
  sessionRecallTerms,
  interleaveRawRows,
  renderEntryLines,
  renderSessionGroupedLines,
  collapseNearDuplicateRows,
} from './recall-format.mjs'
import { searchRelevantHybrid } from './memory-recall-store.mjs'
import { fetchEntriesByIdsScoped } from './memory-recall-id-patch.mjs'
import { retrieveEntries } from './memory-retrievers.mjs'
import { cleanMemoryText } from './memory.mjs'
import { insertTraceEvents } from './trace-store.mjs'
import {
  embedText,
  embedTexts,
  isEmbeddingModelReady,
  warmupEmbeddingProvider,
} from './embedding-provider.mjs'

export function createQueryHandlers({
  getDb,
  log,
  resolveProjectScope,
  embeddingWarmupCanStart,
  getBootTimestamp,
  getTraceDb,
}) {
  // Facade-owned cold-recall log throttle. Kept module-local to this factory
  // instance (one memory runtime = one factory) so the 10s de-dup window
  // behaves exactly as it did when it was a top-level `let` in index.mjs.
  let _embeddingColdRecallLogAt = 0

  // Raw-row priority lookup for narrow-window queries. Raw rows (is_root=0,
  // chunk_root IS NULL) are inserted immediately by ingestTranscriptFile before
  // cycle1 runs, so they always carry the freshest turns in the DB.
  async function readRawRowsInWindow(db, tsFromMs, tsToMs, hardLimit = 10, { projectScope, sessionId, terms } = {}) {
    try {
      // Composable WHERE assembly (mirrors retrieveEntries' filter semantics so
      // raw and chunked legs stay in filter parity: projectScope AND sessionId
      // apply identically to both pools).
      const where = ['chunk_root IS NULL', 'is_root = 0', 'ts >= $1', 'ts <= $2']
      const params = [tsFromMs ?? 0, tsToMs ?? Date.now()]
      if (projectScope === 'common') {
        where.push('project_id IS NULL')
      } else if (projectScope && projectScope !== 'all') {
        params.push(projectScope)
        where.push(`(project_id IS NULL OR project_id = $${params.length})`)
      }
      const sid = String(sessionId || '').trim()
      if (sid) {
        params.push(sid)
        where.push(`session_id = $${params.length}`)
      }
      if (Array.isArray(terms) && terms.length > 0) {
        const textExpr = `lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))`
        const clauses = terms.map((term) => {
          params.push(`%${term}%`)
          return `(CASE WHEN ${textExpr} LIKE $${params.length} THEN 1 ELSE 0 END)`
        })
        // Multi-token queries: from 3+ terms require at least 2 matching terms
        // so one common token ("chat", "recall") can't drag unrelated raw rows
        // into the page. 1-2 term queries keep single-hit contains semantics —
        // short Korean queries are often exactly two meaningful tokens and a
        // 2-of-2 requirement silently emptied the raw leg for them.
        const minHits = terms.length >= 3 ? 2 : 1
        where.push(`(${clauses.join(' + ')}) >= ${minHits}`)
      }
      params.push(hardLimit)
      const sql = `SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                element, category, summary, status, score, last_seen_at, project_id
         FROM entries
         WHERE ${where.join(' AND ')}
         ORDER BY ts DESC
         LIMIT $${params.length}`
      const rows = (await db.query(sql, params)).rows
      return rows.map(r => ({ ...r, retrievalScore: 0, rrf: 0 }))
    } catch { return [] }
  }

  async function recallSessionRows(args = {}) {
    const db = getDb()
    const sessionId = String(args.sessionId || args.session_id || '').trim()
    if (!sessionId) return { text: '(no current session)' }
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
    const terms = sessionRecallTerms(args.query)
    const params = [sessionId]
    // Roots + not-yet-chunked leaves only. Once cycle1 turns raw leaves into
    // (root, members) pairs, selecting every row unfiltered emitted the root's
    // summary AND its own member rows in the same browse — duplicate content.
    // A committed member (is_root=0 with a chunk_root) is always reachable via
    // its root's `members` expansion below, so it never needs to be selected
    // directly here.
    const where = ['session_id = $1', '(is_root = 1 OR chunk_root IS NULL OR chunk_root = id)']
    // Current-turn cutoff: the newest unchunked row is very often the calling
    // turn's OWN recall request/tool-args, still being written when this query
    // runs. Exclude it from a bare (no-query) browse so the in-flight turn
    // doesn't self-echo; a query browse (explicit search intent) keeps it.
    // Only treat the newest unchunked turn as "in-flight" when its latest row
    // is fresh (within FRESHNESS_MS of now) — an older newest-unchunked-turn
    // is completed history (cycle1 just hasn't gotten to it, or drain timed
    // out) and must stay visible, not be silently hidden every browse.
    const IN_FLIGHT_TURN_FRESHNESS_MS = 5 * 60 * 1000
    let excludeSourceTurnId = null
    if (terms.length === 0) {
      try {
        const r = await db.query(
          `SELECT source_turn t, MAX(ts) last_ts FROM entries
           WHERE session_id = $1 AND chunk_root IS NULL
           GROUP BY source_turn ORDER BY source_turn DESC LIMIT 1`,
          [sessionId],
        )
        const t = r.rows?.[0]?.t
        const lastTs = Number(r.rows?.[0]?.last_ts)
        if (t != null && Number.isFinite(lastTs) && (Date.now() - lastTs) <= IN_FLIGHT_TURN_FRESHNESS_MS) {
          excludeSourceTurnId = Number(t)
        }
      } catch {}
    }
    if (Number.isFinite(excludeSourceTurnId)) {
      params.push(excludeSourceTurnId)
      where.push(`NOT (chunk_root IS NULL AND source_turn = $${params.length})`)
    }
    if (terms.length > 0) {
      const textExpr = `lower(coalesce(content, '') || ' ' || coalesce(element, '') || ' ' || coalesce(summary, ''))`
      const clauses = terms.map((term) => {
        params.push(`%${term}%`)
        return `${textExpr} LIKE $${params.length}`
      })
      where.push(`(${clauses.join(' OR ')})`)
    }
    params.push(limit)
    let rows = (await db.query(`
      SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
             element, category, summary, status, score, last_seen_at, project_id
      FROM entries
      WHERE ${where.join(' AND ')}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}
    `, params)).rows
    if (rows.length < limit) {
      const seen = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)))
      const fillLimit = Math.max(0, limit - rows.length)
      const fillWhere = ['session_id = $1', 'id <> ALL($2::bigint[])', '(is_root = 1 OR chunk_root IS NULL OR chunk_root = id)']
      const fillParams = [sessionId, [...seen]]
      if (Number.isFinite(excludeSourceTurnId)) {
        fillParams.push(excludeSourceTurnId)
        fillWhere.push(`NOT (chunk_root IS NULL AND source_turn = $${fillParams.length})`)
      }
      fillParams.push(fillLimit)
      const fillRows = fillLimit > 0
        ? (await db.query(`
            SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
                   element, category, summary, status, score, last_seen_at, project_id
            FROM entries
            WHERE ${fillWhere.join(' AND ')}
            ORDER BY ts DESC, id DESC
            LIMIT $${fillParams.length}
          `, fillParams)).rows
        : []
      if (fillRows.length > 0) rows = [...rows, ...fillRows]
    }
    if (args.includeMembers === true) {
      const rootIds = rows
        .filter((row) => Number(row.is_root) === 1)
        .map((row) => Number(row.id))
        .filter((id) => Number.isFinite(id))
      if (rootIds.length > 0) {
        const members = (await db.query(`
          SELECT id, ts, role, content, session_id, source_turn, project_id, chunk_root
          FROM entries
          WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        `, [rootIds])).rows
        const byRoot = new Map(rootIds.map((id) => [id, []]))
        for (const member of members) {
          const root = Number(member.chunk_root)
          if (byRoot.has(root)) byRoot.get(root).push(member)
        }
        for (const row of rows) {
          const id = Number(row.id)
          if (byRoot.has(id)) row.members = byRoot.get(id)
        }
      }
    }
    return { text: renderEntryLines(rows) }
  }

  async function recallCoreRows(query, { projectScope, category, limit } = {}) {
    const db = getDb()
    const terms = coreRecallTerms(query)
    if (terms.length === 0) return []

    const params = []
    const where = []
    const scope = normalizeRecallProjectScope(projectScope)
    if (scope === null) {
      where.push('project_id IS NULL')
    } else if (scope !== '*') {
      params.push(scope)
      where.push(`(project_id IS NULL OR project_id = $${params.length})`)
    }
    if (category != null) {
      const cats = (Array.isArray(category) ? category : [category])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      if (cats.length > 0) {
        const placeholders = cats.map((cat) => {
          params.push(cat)
          return `$${params.length}`
        })
        where.push(`category IN (${placeholders.join(', ')})`)
      }
    }

    const textExpr = `lower(coalesce(element, '') || ' ' || coalesce(summary, ''))`
    const termClauses = terms.map((term) => {
      params.push(`%${term}%`)
      return `${textExpr} LIKE $${params.length}`
    })
    where.push(`(${termClauses.join(' OR ')})`)
    const hitExpr = termClauses.map((clause) => `CASE WHEN ${clause} THEN 1 ELSE 0 END`).join(' + ')
    const rowLimit = Math.max(1, Math.min(10, Number(limit) || 5))
    params.push(rowLimit)

    const rows = (await db.query(`
      SELECT id, element, summary, category, project_id, created_at, updated_at,
             (${hitExpr}) AS hit_count
      FROM core_entries
      WHERE ${where.join(' AND ')}
        AND (status IS NULL OR status = 'active')
      ORDER BY hit_count DESC, updated_at DESC, id ASC
      LIMIT $${params.length}
    `, params)).rows

    return rows.map((row) => ({
      ...row,
      id: `core:${row.id}`,
      ts: row.updated_at || row.created_at || Date.now(),
      is_root: 1,
    }))
  }

  async function handleSearch(args, signal) {
    const db = getDb()
    const _traceDb = getTraceDb()
    // Cooperative abort check: throw early if the caller already aborted
    // (IPC cancel handler signals the AbortController before re-entry).
    if (signal?.aborted) throw signal.reason ?? new Error('aborted')
    // No pre-search drain: recall NEVER runs LLM chunking inline. Unchunked
    // rows are served directly by the raw leg (readRawRowsInWindow on the
    // query path, the chunk_root IS NULL selection in recallSessionRows) and
    // are dense-searchable via the always-on raw-embedding flush (post-ingest
    // + checkCycles tick). Chunked/scored upgrades arrive from the background
    // cycle1 sweep on its own schedule.
    // #id lookup normalization: search_memories and memory action:'search'
    // callers pass a single `id` (or an id array under that same key), not
    // the `ids` array below. Normalize once here so every dispatch path gets
    // exact-id lookup, not just callers who already knew to use `ids`.
    if (!Array.isArray(args.ids) && args.id != null) {
      args = { ...args, ids: Array.isArray(args.id) ? args.id : [args.id] }
    }
    if (args?.currentSession === true || args?.sessionId || args?.session_id) {
      return await recallSessionRows(args)
    }
    // id mode (follow-up lookup): caller passed `#N` markers from a prior
    // recall result. Fetch those rows directly + their chunk members,
    // bypassing hybrid search entirely. Output reuses renderEntryLines so
    // the shape stays identical to the search path (chunk members first,
    // root summary fallback).
    if (Array.isArray(args.ids) && args.ids.length > 0) {
      const ids = args.ids
        .map(v => Number(v))
        .filter(v => Number.isInteger(v) && v > 0)
      if (ids.length === 0) return { text: '(no valid ids)' }
      const includeArchived = args.includeArchived !== false
      const category = args.category
      const period = String(args.period ?? '').trim() || undefined
      const temporal = parsePeriod(period, false)
      let projectScope
      if (typeof args.projectScope === 'string' && args.projectScope) {
        projectScope = args.projectScope
      } else {
        const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
        projectScope = projectId !== null ? projectId : 'common'
      }
      const excludeStatuses = includeArchived ? [] : ['archived']
      const rows = await fetchEntriesByIdsScoped(db, ids, {
        ts_from: temporal?.startMs,
        ts_to: temporal?.endMs,
        excludeStatuses,
        category,
        projectScope,
      })
      if (rows.length === 0) return { text: '(no results)' }
      // Members for any root rows in the result set.
      const rootIds = rows.filter(r => r.is_root === 1).map(r => Number(r.id))
      const memberLeafIds = new Set()
      if (rootIds.length > 0) {
        const { rows: memberRows } = await db.query(
          `SELECT id, ts, role, content, chunk_root
           FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
           ORDER BY ts ASC, id ASC`,
          [rootIds],
        )
        const membersByRoot = new Map()
        for (const m of memberRows) {
          const k = Number(m.chunk_root)
          if (!membersByRoot.has(k)) membersByRoot.set(k, [])
          membersByRoot.get(k).push(m)
          memberLeafIds.add(Number(m.id))
        }
        for (const r of rows) {
          if (r.is_root === 1) r.members = membersByRoot.get(Number(r.id)) ?? []
        }
      }
      // Preserve caller-supplied id order; drop leaves already inlined as a
      // root's chunk member to prevent double emission when the caller names
      // a root and one of its leaves in the same batch.
      const byId = new Map(rows.map(r => [Number(r.id), r]))
      const ordered = ids
        .map(id => byId.get(id))
        .filter(Boolean)
        .filter(r => !(r.is_root === 0 && memberLeafIds.has(Number(r.id))))
      return { text: renderEntryLines(ordered) }
    }
    // Array query — fan out in parallel, each query runs its own hybrid search
    // path, and results are grouped in the response so the caller sees one
    // ranked list per angle. Collapses what would otherwise be N sequential
    // tool calls into a single invocation.
    if (Array.isArray(args.query)) {
      // Dedup + fan-out cap. The cap protects the result envelope from
      // over-eager callers (20+ near-duplicate queries N× the IO) without
      // silently swallowing the caller's intent: when the input exceeds
      // QUERIES_CAP, prepend a one-line note so the caller can see the
      // truncation and re-shape their query list.
      const QUERIES_CAP = 5
      const dedup = [...new Set(args.query.map(q => String(q || '').trim()).filter(Boolean))]
      if (dedup.length === 0) return { text: '' }
      const queries = dedup.slice(0, QUERIES_CAP)
      const dropped = dedup.length - queries.length
      const rest = { ...args }
      delete rest.query
      const deadlineSec = Math.max(1, Number(process.env.MEMORY_FANOUT_DEADLINE_S) || 180)
      const deadlineMs = deadlineSec * 1000
      const fanOutAbort = new AbortController()
      let deadlineTimer
      const deadlineRace = new Promise((_res, rej) => {
        deadlineTimer = setTimeout(() => {
          fanOutAbort.abort(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`))
          rej(Object.assign(new Error(`memory fan-out deadline exceeded (${deadlineSec}s)`), { _deadline: true }))
        }, deadlineMs)
      })
      let settled
      try {
        // Pre-warm only when the embedding model is already resident. If the
        // process is still cold, keep recall responsive and let the background
        // warmup finish independently instead of making the first query pay the
        // ONNX session-create cost.
        if (isEmbeddingModelReady()) {
          // Race against the same deadline as the fan-out itself: a stuck
          // embedding worker would previously park here indefinitely because
          // the timer hadn't been started yet from the fan-out's perspective.
          await Promise.race([embedTexts(queries), deadlineRace])
        } else if (embeddingWarmupCanStart()) {
          void warmupEmbeddingProvider().catch((err) => {
            log(`[memory-service] embedding warmup after cold fan-out skipped dense search: ${err?.message || err}\n`)
          })
        }
        settled = await Promise.race([
          Promise.all(queries.map(async (q) => {
            if (fanOutAbort.signal.aborted) throw fanOutAbort.signal.reason
            if (signal?.aborted) throw signal.reason ?? new Error('aborted')
            const sub = await handleSearch({ ...rest, query: q }, signal)
            return `[${q}]\n${sub.text || '(no results)'}`
          })),
          deadlineRace,
        ])
      } finally {
        clearTimeout(deadlineTimer)
      }
      const parts = settled
      const header = dropped > 0
        ? `note: ${dedup.length} queries received, ${queries.length} processed, ${dropped} dropped (cap ${QUERIES_CAP})\n\n`
        : ''
      return { text: header + parts.join('\n\n') }
    }
    const query = String(args.query ?? '').trim()
    let period = String(args.period ?? '').trim() || undefined
    // Period and sort are caller-supplied only. Lead is responsible for
    // mapping vague time phrases / chronological intent into the period
    // argument before calling; the engine does not infer them from query
    // text.
    const RECALL_LIMIT_CAP = 100
    const RECALL_OFFSET_CAP = 500
    const requestedLimit = Number(args.limit)
    const requestedOffset = Number(args.offset)
    let limit = Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 10)
    let offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0)
    const recallCapNotes = []
    if (Number.isFinite(requestedLimit) && requestedLimit > RECALL_LIMIT_CAP) {
      limit = RECALL_LIMIT_CAP
      recallCapNotes.push(`limit capped to ${RECALL_LIMIT_CAP} (requested ${requestedLimit})`)
    } else {
      limit = Math.min(RECALL_LIMIT_CAP, limit)
    }
    if (Number.isFinite(requestedOffset) && requestedOffset > RECALL_OFFSET_CAP) {
      offset = RECALL_OFFSET_CAP
      recallCapNotes.push(`offset capped to ${RECALL_OFFSET_CAP} (requested ${requestedOffset})`)
    } else {
      offset = Math.min(RECALL_OFFSET_CAP, offset)
    }
    const recallCapPrefix = recallCapNotes.length ? `${recallCapNotes.join('; ')}\n` : ''
    // Recent-browsing default: a query-less recall is a "show me the latest
    // messages" browse, not a relevance search — chronological order is the
    // only ordering that makes sense there, so sort defaults to 'date' when
    // no query is present (explicit args.sort still wins). Query recalls keep
    // the importance default.
    const hasQueryForSort = Array.isArray(args.query)
      ? args.query.some((v) => String(v || '').trim())
      : String(args.query ?? '').trim() !== ''
    let sort = args.sort != null ? String(args.sort) : (hasQueryForSort ? 'importance' : 'date')
    // Chunk content is the primary recall output. Members default to true so
    // callers receive the raw chunk leaves (the cycle1-produced semantic
    // chunks) rather than just the root's cycle2-compressed summary line.
    // Explicit `includeMembers:false` keeps the legacy summary-only mode.
    const includeMembers = args.includeMembers !== false
    // Raw leg defaults ON: recall never drains/chunks inline anymore, so raw
    // (unchunked) rows — embedded by the always-on post-ingest/tick flush —
    // are the only way to see content cycle1 hasn't reached yet, regardless
    // of the recap toggle. The importance/query search leg only ranks chunked
    // entries; readRawRowsInWindow interleaves the raw rows into the hybrid
    // list. Explicit includeRaw:false keeps the chunked-only view.
    const includeRaw = args.includeRaw !== false
    const includeArchived = args.includeArchived !== false
    const category = args.category
    const temporal = parsePeriod(period, Boolean(query))
    // Bounded-period query recall reads as a timeline ("today's work"), not a
    // relevance ranking: when the caller EXPLICITLY supplied a period that
    // resolves to a real time window and did NOT pin sort, force newest-first
    // so the page is strictly chronological (bench: recency-today). Gated on
    // the explicit `period` string — the implicit 30d default a bare query
    // gets must keep importance ranking (else topical query recall regresses).
    if (args.sort == null && query && period && temporal && temporal.startMs != null) sort = 'date'

    // Derive projectScope from caller cwd (falls back to process.cwd()).
    // Explicit args.projectScope (string) takes priority so callers can
    // override to 'all', 'common', or a specific slug.
    let projectScope
    if (typeof args.projectScope === 'string' && args.projectScope) {
      projectScope = args.projectScope
    } else {
      const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
      projectScope = projectId !== null ? projectId : 'common'
    }

    // R11 reviewer M4: calendar-bounded periods disable freshness decay
    // so within-period ranking doesn't downgrade Mon entries vs Sun.
    const CALENDAR_PERIODS = new Set(['yesterday', 'today', 'this_week', 'last_week'])
    const isCalendarPeriod = period != null
      && (CALENDAR_PERIODS.has(period) || /^\d{4}-\d{2}-\d{2}/.test(period) || /^\d{1,2}:\d{2}~/.test(period))
    const applyFreshness = !isCalendarPeriod

    // period='last': no time window and no session exclusion — 'last' is a
    // plain "walk back through ALL prior conversation, newest first" browse.
    // No boot-timestamp cap (the old cap hid every session that ran while a
    // long-lived daemon stayed up), no gap-bounded burst, no current-session
    // filter: limit/offset page through history and the grouped renderer
    // separates sessions. temporal stays unbounded (mode marker only).

    if (query) {
      const _t0 = Date.now()
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      let queryVector = null
      if (isEmbeddingModelReady()) {
        queryVector = await embedText(query, { priority: true })
      } else if (embeddingWarmupCanStart()) {
        // Cold model: WAIT for warmup (bounded) instead of silently degrading
        // to lexical-only. Raw rows are already embedded at ingest time, so
        // the query vector is the only missing piece of the dense leg — a few
        // seconds of warmup buys full hybrid quality on the first recall.
        // On timeout the warmup keeps running in the background and this
        // recall falls back to lexical (same as before).
        const COLD_RECALL_WARMUP_WAIT_MS = Math.max(0, Number(process.env.MIXDOG_RECALL_WARMUP_WAIT_MS) || 8_000)
        let timer
        try {
          queryVector = await Promise.race([
            warmupEmbeddingProvider().then(() => embedText(query, { priority: true })),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), COLD_RECALL_WARMUP_WAIT_MS) }),
          ])
        } catch (err) {
          log(`[memory-service] embedding warmup during cold recall failed: ${err?.message || err}\n`)
          queryVector = null
        } finally {
          clearTimeout(timer)
        }
        if (!Array.isArray(queryVector)) {
          const now = Date.now()
          if (now - _embeddingColdRecallLogAt > 10_000) {
            _embeddingColdRecallLogAt = now
            log(`[recall] embedding still cold after ${COLD_RECALL_WARMUP_WAIT_MS}ms wait; returning lexical results while background warmup continues\n`)
          }
        }
      } else {
        const now = Date.now()
        if (now - _embeddingColdRecallLogAt > 10_000) {
          _embeddingColdRecallLogAt = now
          log('[recall] embedding model cold; returning lexical results while background warmup continues\n')
        }
      }
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const _t1 = Date.now()
      if (process.env.MIXDOG_DEBUG_MEMORY) {
        log(`[search-time] embed=${_t1 - _t0}ms query="${query.slice(0, 60)}"\n`)
      }
      // Push ts and status filters into the hybrid candidate query so FTS / vec
      // rank inside the requested window, not the whole tree. The previous post-
      // filter approach silently emptied results when relevant matches sat
      // outside `period` (default 30d) and could not bubble through.
      // Recall is history-first: archived roots hold most prior work. Callers
      // that need only live invariants can pass includeArchived:false.
      const excludeStatuses = includeArchived ? [] : ['archived']
      const results = await searchRelevantHybrid(db, query, {
        limit: limit + offset,
        queryVector: Array.isArray(queryVector) ? queryVector : null,
        includeMembers,
        ts_from: temporal?.startMs,
        ts_to: temporal?.endMs,
        applyFreshness,
        projectScope,
        category,
        excludeStatuses,
        // useHotActive was set to true here so default (no-period) calls
        // routed through the mv_hot_active materialized view — a narrow
        // active-roots-only pool. Live usage is dominated by vague-time
        // queries ("recent / lately") where Lead callers omit the period
        // filter, leaving the MV as the sole source. That hid every
        // orphan leaf and every pending root — fresh work from the last 1-60
        // minutes never surfaced. Now that the entries-table CTE legs run
        // against broaden HNSW + GIN trgm partial indexes (the
        // is_root=1 predicate was dropped in the same revision), the
        // entries path is fast enough (1-2 ms ANN on ~10K rows, O(log N)
        // through 1M+) to be the single source of truth. The MV is left in
        // place for now but no longer routed to from search; cycle2 may stop
        // refreshing it in a follow-up commit once nothing else reads it.
        useHotActive: false,
      })
      let filtered = results
      if (sort === 'date') {
        // R11 reviewer L5: NaN guard — entries with null/undefined ts default
        // to 0 so the comparator stays numeric and stable.
        filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      } else {
        filtered.sort((a, b) => {
          const sa = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
          return (sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0))
            || (sa(b.score ?? 0) - sa(a.score ?? 0))
            || (sa(b.ts ?? 0) - sa(a.ts ?? 0))
            || (Number(a.id ?? 0) - Number(b.id ?? 0))
        })
      }
      if (includeRaw) {
        // Raw rows (chunk_root IS NULL) carry no retrievalScore, so a naive
        // append-after-hybrid under sort=importance always lands them past
        // slice(offset, offset+limit) once the hybrid pool exceeds one page —
        // every page beyond the first silently drops them. Fetch a wider raw
        // window (bounded like the hybrid candidate pool) and spread the
        // fetched raw rows evenly across the WHOLE hybrid list before slicing,
        // so every offset page gets its proportional share instead of only
        // page 0. Same projectScope/ts window as the hybrid leg — filter
        // parity (item 3) is deliberate, not accidental.
        const RAW_FETCH = Math.min(500, Math.max(20, limit + offset))
        const rawRows = await readRawRowsInWindow(
          db,
          temporal?.startMs ?? null,
          temporal?.endMs ?? Date.now(),
          RAW_FETCH,
          { projectScope, terms: sessionRecallTerms(query) },
        )
        const seenIds = new Set(filtered.map(r => r.id))
        let newRaw = rawRows.filter(r => !seenIds.has(r.id))
        // Relevance gate: readRawRowsInWindow's SQL term filter is loose
        // (minHits 1 for <3-term queries), so unscored raw rows that share a
        // single common token still get stride-interleaved into a ranked
        // result set and push real hits down the page. In the query branch,
        // keep only raw rows whose body actually contains >=1 query term.
        const rawTerms = sessionRecallTerms(query)
        if (rawTerms.length > 0) {
          newRaw = newRaw.filter((r) => {
            const hay = `${r.content ?? ''} ${r.element ?? ''} ${r.summary ?? ''}`.toLowerCase()
            return rawTerms.some((t) => hay.includes(t))
          })
        }
        if (sort === 'date') {
          for (const r of newRaw) filtered.push(r)
          filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
        } else {
          // sort=importance: interleave raw rows at a fixed stride through the
          // full (pre-slice) hybrid list instead of appending at the tail, so
          // offset > 0 pages also draw from the raw pool proportionally.
          filtered = interleaveRawRows(filtered, newRaw)
        }
      }
      const coreRows = await recallCoreRows(query, { projectScope, category, limit })
      if (coreRows.length > 0) {
        filtered = [...coreRows, ...filtered]
      }
      // Core rows are prepended by relevance and carry updated_at as ts, so on
      // the chronological (date) path they'd break strict newest-first. Re-sort
      // the merged list by ts desc before slicing so the timeline stays intact.
      if (sort === 'date') {
        filtered.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (Number(b.id) || 0) - (Number(a.id) || 0))
      }
      const sliced = filtered.slice(offset, offset + limit)
      const _t2 = Date.now()
      if (process.env.MIXDOG_DEBUG_MEMORY) {
        log(`[search-time] hybrid+sort+raw=${_t2 - _t1}ms rows=${filtered.length} sliced=${sliced.length}\n`)
      }
      // Emit a recall trace event so getTraceWithEntries() can correlate
      // this search with the top-ranked memory entry.  One event per
      // handleSearch call (not per returned row) — cheapest meaningful link.
      // parent_span_id left null: the agent-side span id is only known after
      // the DB insert of the loop/tool events, which happens async on the
      // client side and is not available here.
      if (_traceDb && filtered.length > 0) {
        const topHit = filtered[0]
        const topId = topHit?.id != null ? Number(topHit.id) : null
        if (topId !== null && Number.isFinite(topId)) {
          insertTraceEvents(_traceDb, [{
            ts: Date.now(),
            kind: 'recall',
            entry_id: topId,
            payload: { query: query.slice(0, 200), hit_count: filtered.length },
          }]).catch(e => log(`[trace] insertTraceEvents error: ${e?.message}\n`))
        }
      }
      // Collapse near-duplicate long bodies within this single result set so
      // paraphrased restatements don't each spend the full line budget. Search
      // path only — id-lookup output above never calls this.
      const deduped = collapseNearDuplicateRows(sliced)
      // recencyOrder render on the date path flattens roots+members into one
      // ts-desc stream so per-chunk (ts-ASC) members can't invert the timeline.
      const out = { text: recallCapPrefix + renderEntryLines(deduped, { recencyOrder: sort === 'date' }) }
      if (process.env.MIXDOG_DEBUG_MEMORY) {
        log(`[search-time] render+trace=${Date.now() - _t2}ms total=${Date.now() - _t0}ms textLen=${out.text.length}\n`)
      }
      return out
    }

    const filters = { limit: limit + offset }
    if (temporal?.startMs != null) { filters.ts_from = temporal.startMs; filters.ts_to = temporal.endMs }
    filters.projectScope = projectScope
    if (category != null) filters.category = category
    filters.sort = sort
    if (!includeArchived) filters.excludeStatuses = ['archived']
    if (includeMembers) filters.includeMembers = true
    const rows = await retrieveEntries(db, filters)
    // Recent-browsing raw merge: a query-less recall must show the freshest
    // turns even when cycle1 hasn't chunked them yet. Roots lag ingest by up
    // to a cycle interval, so on sort=date pull the raw (unchunked) window
    // too and merge chronologically — original text first, no summaries.
    // Query-less + includeRaw:false callers keep the roots-only view.
    let merged = rows
    if (sort === 'date' && args.includeRaw !== false) {
      const rawRows = await readRawRowsInWindow(
        db,
        filters.ts_from ?? temporal?.startMs ?? null,
        filters.ts_to ?? temporal?.endMs ?? Date.now(),
        Math.min(500, Math.max(20, limit + offset)),
        { projectScope },
      )
      const seenIds = new Set(rows.map(r => Number(r.id)))
      // Drop raw leaves already inlined as some returned root's member.
      for (const r of rows) {
        if (Array.isArray(r.members)) for (const m of r.members) seenIds.add(Number(m.id))
      }
      const newRaw = rawRows.filter(r => !seenIds.has(Number(r.id)))
      if (newRaw.length > 0) {
        merged = [...rows, ...newRaw]
        merged.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0) || (Number(b.id) || 0) - (Number(a.id) || 0))
      }
    }
    const sliced = merged.slice(offset, offset + limit)
    // Multi-session grouping: a GLOBAL query-less browse ("recent work") spans
    // sessions — render grouped per session (newest activity first) with the
    // caller's own session marked "(current)" via the currentSessionId hint.
    // Falls through to the flat list when everything is one session.
    const _currentSessionHint = String(args?.currentSessionId || '').trim()
    // recencyOrder on the date path: without it, chunk members (stored ts-ASC
    // per root) interleave out of order with raw rows inside each session
    // group (e.g. 04:33 rendered above 04:41).
    return { text: recallCapPrefix + renderSessionGroupedLines(sliced, { currentSessionId: _currentSessionHint, recencyOrder: sort === 'date' }) }
  }

  async function dumpSessionRootChunks(args = {}) {
    const db = getDb()
    const sessionId = String(args.sessionId || args.session_id || '').trim()
    if (!sessionId) return { text: '(no current session)', rows: [], chunks: [], isError: true }
    const includeRaw = args.includeRaw !== false
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 1000))
    const rootRows = (await db.query(`
      SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
             element, category, summary, status, score, last_seen_at, project_id
      FROM entries
      WHERE session_id = $1 AND is_root = 1
      ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      LIMIT $2
    `, [sessionId, limit])).rows
    const roots = rootRows.map((r) => ({ ...r, members: [] }))
    const rootIds = roots.map((r) => Number(r.id)).filter((id) => Number.isFinite(id))
    const memberRows = rootIds.length > 0
      ? (await db.query(`
          SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
          FROM entries
          WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        `, [rootIds])).rows
      : []
    const byRoot = new Map(roots.map((r) => [Number(r.id), r]))
    for (const m of memberRows) {
      const root = byRoot.get(Number(m.chunk_root))
      if (root) root.members.push(m)
    }
    let rawRows = []
    if (includeRaw) {
      rawRows = (await db.query(`
        SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
        FROM entries
        WHERE session_id = $1
          AND is_root = 0
          AND (chunk_root IS NULL OR chunk_root = id)
        ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        LIMIT $2
      `, [sessionId, limit])).rows
    }
    const chunks = []
    for (const root of roots) {
      const memberText = root.members
        .map((m) => `${m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role}: ${cleanMemoryText(String(m.content ?? ''))}`)
        .filter(Boolean)
        .join('\n')
      const summary = [root.element, root.summary].map((v) => String(v || '').trim()).filter(Boolean).join(' — ')
      chunks.push({
        id: Number(root.id),
        kind: 'root',
        ts: Number(root.ts) || 0,
        sourceTurn: root.source_turn ?? null,
        category: root.category || null,
        summary,
        text: memberText || cleanMemoryText(String(root.content ?? '')),
        members: root.members,
      })
    }
    for (const raw of rawRows) {
      chunks.push({
        id: Number(raw.id),
        kind: 'raw',
        chunkRoot: raw.chunk_root ?? null,
        ts: Number(raw.ts) || 0,
        sourceTurn: raw.source_turn ?? null,
        category: null,
        summary: '',
        text: `${raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : raw.role}: ${cleanMemoryText(String(raw.content ?? ''))}`,
        members: [],
      })
    }
    chunks.sort((a, b) => {
      const at = Number.isFinite(Number(a.sourceTurn)) ? Number(a.sourceTurn) : 2147483647
      const bt = Number.isFinite(Number(b.sourceTurn)) ? Number(b.sourceTurn) : 2147483647
      return (at - bt) || ((a.ts || 0) - (b.ts || 0)) || ((a.id || 0) - (b.id || 0))
    })
    const text = chunks.length
      ? chunks.map((chunk, idx) => {
          const label = chunk.kind === 'root'
            ? `# chunk ${idx + 1} root=${chunk.id}${chunk.category ? ` category=${chunk.category}` : ''}`
            : `${chunk.chunkRoot == null ? '# raw_pending' : '# raw_terminal'} ${idx + 1} id=${chunk.id}`
          const summary = chunk.summary ? `summary: ${chunk.summary}\n` : ''
          return `${label}\n${summary}${chunk.text}`.trim()
        }).join('\n\n')
      : '(no results)'
    return { text, rows: [...roots, ...rawRows], chunks }
  }

  async function entryStats() {
    const db = getDb()
    return await db.transaction(async (tx) => {
      const total               = (await tx.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c
      const roots               = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`)).rows[0].c
      const active_roots        = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active'`)).rows[0].c
      const archived_roots      = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'archived'`)).rows[0].c
      const unchunked_leaves    = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`)).rows[0].c
      const cycle2_pending_roots = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'pending'`)).rows[0].c
      const core_entries        = (await tx.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c
      const core_embed_null     = (await tx.query(`SELECT COUNT(*) c FROM core_entries WHERE embedding IS NULL`)).rows[0].c
      const active_core_summaries = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' AND core_summary IS NOT NULL`)).rows[0].c
      const active_core_summary_missing = (await tx.query(`
        SELECT COUNT(*) c
        FROM entries
        WHERE is_root = 1
          AND status = 'active'
          AND (core_summary IS NULL OR btrim(core_summary) = '')
      `)).rows[0].c
      const byStatus            = (await tx.query(`SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status`)).rows
      const byCategory          = (await tx.query(`SELECT category, COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' GROUP BY category ORDER BY c DESC`)).rows
      const mvRows              = (await tx.query(`SELECT relispopulated FROM pg_class WHERE relname = 'mv_hot_active' LIMIT 1`)).rows
      const mv_hot_active_populated = mvRows.length ? Boolean(mvRows[0].relispopulated) : null
      return {
        total, roots, active_roots, archived_roots, unchunked_leaves, cycle2_pending_roots,
        core_entries, core_embed_null, active_core_summaries, active_core_summary_missing,
        mv_hot_active_populated,
        byStatus, byCategory,
      }
    })
  }

  return {
    readRawRowsInWindow,
    recallSessionRows,
    recallCoreRows,
    handleSearch,
    dumpSessionRootChunks,
    entryStats,
  }
}
