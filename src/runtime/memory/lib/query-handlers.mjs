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
  inferRecallPeriod,
  coreRecallTerms,
  normalizeRecallProjectScope,
  sessionRecallTerms,
  interleaveRawRows,
  renderEntryLines,
  renderSessionGroupedLines,
  collapseNearDuplicateRows,
  compactDigestRows,
  compactHandoffRows,
} from './recall-format.mjs'
import { searchRelevantHybrid } from './memory-recall-store.mjs'
import { fetchEntriesByIdsScoped } from './memory-recall-id-patch.mjs'
import { retrieveEntries } from './memory-retrievers.mjs'
import { buildPromotedExclusionClauses } from './memory-recall-scope-filter.mjs'
import { compareRecallNewestFirst } from './recall-order.mjs'
import { decodeRecallPageCursor, encodeRecallPageCursor } from './recall-page-cursor.mjs'
import { expandRecallEventContext } from './recall-event-context.mjs'
import { insertTraceEvents } from './trace-store.mjs'
import { createQueryMaintenanceHandlers } from './query-maintenance-handlers.mjs'
import {
  annotateRecallRootContext,
  boundRecallRowsToTemporal,
  hasLatestRecallIntent,
  hasRecallEntity,
  hasTimelineIntent,
  hasVagueLatestWorkIntent,
  latestRecallSearchTerms,
  latestRecallTopicTerms,
  mergeHistoricalRecallRows,
  preserveLatestConceptRows,
  prioritizeHistoricalRootEvidence,
  rankLatestRecallRows,
  recallRowTopicText,
  sampleRecallTimeline,
} from './query-ranking.mjs'
import {
  embedText,
  embedTexts,
  isEmbeddingModelReady,
  warmupEmbeddingProvider,
} from './embedding-provider.mjs'
import { embedRecallQuery } from './recall-embedding-readiness.mjs'
import { isSemanticOnlyRecall } from './recall-fusion.mjs'

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
  const { dumpSessionRootChunks, entryStats } = createQueryMaintenanceHandlers({ getDb })

  // Raw-row priority lookup for narrow-window queries. Raw rows (is_root=0,
  // chunk_root IS NULL) are inserted immediately by ingestTranscriptFile before
  // cycle1 runs, so they always carry the freshest turns in the DB.
  async function readRawRowsInWindow(db, tsFromMs, tsToMs, hardLimit = 10, { projectScope, sessionId, terms, minHits: minHitsOverride } = {}) {
    try {
      // Composable WHERE assembly (mirrors retrieveEntries' filter semantics so
      // raw and chunked legs stay in filter parity: projectScope AND sessionId
      // apply identically to both pools).
      const where = ['chunk_root IS NULL', 'is_root = 0', 'ts >= $1', 'ts <= $2']
      const params = [tsFromMs ?? 0, tsToMs ?? Date.now()]
      let termOrder = ''
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
        const minHits = Number.isFinite(Number(minHitsOverride))
          ? Math.max(1, Math.floor(Number(minHitsOverride)))
          : (terms.length >= 3 ? 2 : 1)
        const matchSum = clauses.join(' + ')
        where.push(`(${matchSum}) >= ${minHits}`)
        // Rank raw rows by evidence before recency. Token order is deliberate:
        // query normalization puts identifiers and preserved compounds first,
        // so a distinctive term wins ties over a newer broad-term coincidence.
        termOrder = `${matchSum} DESC, ${clauses.map(clause => `${clause} DESC`).join(', ')}, `
      }
      params.push(hardLimit)
      const sql = `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                element, category, summary, status, score, last_seen_at, project_id
         FROM entries
         WHERE ${where.join(' AND ')}
         ORDER BY ${termOrder}ts DESC, source_turn DESC NULLS LAST, id DESC
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
    const compactDigest = args.compactDigest === true
    const compactHandoff = args.compactHandoff === true
    const skipInFlightCutoff = compactDigest || compactHandoff
    // Over-fetch before compact-only dedupe so duplicated legacy rows cannot
    // consume the requested page and hide distinct older context.
    const fetchLimit = compactHandoff
      ? null
      : compactDigest
        ? Math.min(100, Math.max(limit, limit * 4))
        : limit
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
    // Never applies to a compaction digest: that browse reads the completed
    // session history already persisted by the transcript watcher. Applying a
    // freshness cutoff there could silently drop the newest finalized turn.
    const IN_FLIGHT_TURN_FRESHNESS_MS = 5 * 60 * 1000
    let excludeSourceTurnId = null
    if (!skipInFlightCutoff && terms.length === 0) {
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
    if (!skipInFlightCutoff && Number.isFinite(excludeSourceTurnId)) {
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
    if (fetchLimit != null) params.push(fetchLimit)
    const limitClause = fetchLimit == null ? '' : `LIMIT $${params.length}`
    let rows = (await db.query(`
      SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
             element, category, summary, status, score, last_seen_at, project_id
      FROM entries
      WHERE ${where.join(' AND ')}
      ORDER BY ts DESC, source_turn DESC NULLS LAST, id DESC
      ${limitClause}
    `, params)).rows
    if (fetchLimit != null && rows.length < fetchLimit) {
      const seen = new Set(rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)))
      const fillLimit = Math.max(0, fetchLimit - rows.length)
      const fillWhere = ['session_id = $1', 'id <> ALL($2::bigint[])', '(is_root = 1 OR chunk_root IS NULL OR chunk_root = id)']
      const fillParams = [sessionId, [...seen]]
      if (!skipInFlightCutoff && Number.isFinite(excludeSourceTurnId)) {
        fillParams.push(excludeSourceTurnId)
        fillWhere.push(`NOT (chunk_root IS NULL AND source_turn = $${fillParams.length})`)
      }
      fillParams.push(fillLimit)
      const fillRows = fillLimit > 0
        ? (await db.query(`
            SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
                   element, category, summary, status, score, last_seen_at, project_id
            FROM entries
            WHERE ${fillWhere.join(' AND ')}
            ORDER BY ts DESC, source_turn DESC NULLS LAST, id DESC
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
          SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, project_id, chunk_root
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
    if (compactHandoff) rows = compactHandoffRows(rows, limit)
    else if (compactDigest) rows = compactDigestRows(rows, limit)
    return { text: renderEntryLines(rows, { pendingMarks: !compactDigest && !compactHandoff }) }
  }

  async function recallCoreRows(query, { projectScope, category, limit, tsFrom, tsTo } = {}) {
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
    const coreTsExpr = 'COALESCE(updated_at, created_at)'
    if (tsFrom != null && Number.isFinite(Number(tsFrom))) {
      params.push(Number(tsFrom))
      where.push(`${coreTsExpr} >= $${params.length}`)
    }
    if (tsTo != null && Number.isFinite(Number(tsTo))) {
      params.push(Number(tsTo))
      where.push(`${coreTsExpr} <= $${params.length}`)
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
          `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root
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
        // Pre-warm cached query vectors when the model is resident. A cold
        // fan-out starts one shared warmup here; each sub-query then observes
        // the same bounded wait in embedRecallQuery instead of starting its own
        // worker load.
        if (isEmbeddingModelReady()) {
          // Race against the same deadline as the fan-out itself: a stuck
          // embedding worker would previously park here indefinitely because
          // the timer hadn't been started yet from the fan-out's perspective.
          await Promise.race([embedTexts(queries, { inputType: 'query' }), deadlineRace])
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
    const queryPeriod = inferRecallPeriod(query)
    let period = String(args.period ?? '').trim() || queryPeriod
    const timelineMode = args.sort == null && hasTimelineIntent(query)
    const latestIntent = hasLatestRecallIntent(query) || queryPeriod === '3h'
    const latestTopicTerms = latestIntent ? latestRecallTopicTerms(query) : []
    const latestSearchTerms = latestIntent ? latestRecallSearchTerms(query) : []
    const retrievalQuery = latestSearchTerms.length > 0 ? latestSearchTerms.join(' ') : query
    const latestEntityMode = args.sort == null && latestIntent && hasRecallEntity(query)
    const latestRootMode = args.sort == null
      && !timelineMode
      && !latestEntityMode
      && ((Boolean(queryPeriod) && !hasRecallEntity(query)) || latestIntent)
    const structuredTimeMode = timelineMode || latestRootMode
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
    // Root summaries are the compact default recall output. Chunk members and
    // unchunked raw/episode rows are explicit expansion legs for callers that
    // need the underlying transcript evidence.
    const includeMembers = args.includeMembers === true
    const includeRaw = args.includeRaw === true
    const includeArchived = args.includeArchived !== false
    const category = args.category
    const temporal = parsePeriod(period, Boolean(query))
    const boundedHistoricalMode = Boolean(
      query
      && sort !== 'date'
      && !latestIntent
      && !timelineMode
      && Number.isFinite(Number(temporal?.startMs))
      && Number.isFinite(Number(temporal?.endMs))
      && Number(temporal.endMs) < Date.now() - 60 * 60 * 1000
    )
    const deepHistoricalMode = boundedHistoricalMode
      && Number(temporal.endMs) < Date.now() - 3 * 24 * 60 * 60 * 1000
    // A period bounds the candidate set; it does not imply chronology. Topic
    // queries keep relevance ordering even inside a date window, while
    // query-less browsing stays newest-first through the default above.
    // Callers asking for a timeline can pin sort:'date' explicitly.

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

    // period='last': no time window and no session exclusion — 'last' is a
    // recent-session browse; with a query, filter those recent sessions by
    // topic instead of falling through to the unbounded semantic search path.
    // No boot-timestamp cap (the old cap hid every session that ran while a
    // long-lived daemon stayed up), no gap-bounded burst, no current-session
    // filter: limit/offset page through history and the grouped renderer
    // separates sessions. temporal stays unbounded (mode marker only).

    if (query && temporal?.mode !== 'last') {
      const _t0 = Date.now()
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const embedding = await embedRecallQuery(retrievalQuery, {
        isReady: isEmbeddingModelReady,
        canWarmup: embeddingWarmupCanStart,
        warmup: warmupEmbeddingProvider,
        embed: embedText,
        signal,
        onWarmupError: (err) => {
          log(`[memory-service] embedding warmup after cold recall failed: ${err?.message || err}\n`)
        },
      })
      const queryVector = Array.isArray(embedding.vector) ? embedding.vector : null
      if (!queryVector) {
        const now = Date.now()
        if (now - _embeddingColdRecallLogAt > 10_000) {
          _embeddingColdRecallLogAt = now
          const reason = embedding.state === 'timeout'
            ? 'bounded cold-start wait elapsed'
            : `embedding ${embedding.state}`
          log(`[recall] ${reason}; returning lexical results while background warmup continues\n`)
        }
      }
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const _t1 = Date.now()
      if (process.env.MIXDOG_DEBUG_MEMORY) {
        log(`[search-time] embed=${_t1 - _t0}ms query="${retrievalQuery.slice(0, 60)}"\n`)
      }
      // Push ts and status filters into the hybrid candidate query so FTS / vec
      // rank inside the requested window, not the whole tree. The previous post-
      // filter approach silently emptied results when relevant matches sat
      // outside `period` (default 30d) and could not bubble through.
      // Recall is history-first: archived roots hold most prior work. Callers
      // that need only live invariants can pass includeArchived:false.
      const excludeStatuses = includeArchived ? [] : ['archived']
      const retrievalLimit = Math.min(RECALL_LIMIT_CAP, Math.max(limit + offset, (limit + offset) * 3))
      const searchOptions = {
        limit: retrievalLimit,
        queryVector: Array.isArray(queryVector) ? queryVector : null,
        includeMembers: structuredTimeMode ? false : includeMembers,
        ts_from: temporal?.startMs,
        ts_to: temporal?.endMs,
        projectScope,
        category,
        excludeStatuses,
        latestByConcept: latestIntent && args.period == null,
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
      }
      const vagueLatestRootMode = latestRootMode && hasVagueLatestWorkIntent(query)
      const [results, historicalRootRows] = await Promise.all([
        vagueLatestRootMode
          ? retrieveEntries(db, {
              is_root: true,
              ts_from: temporal?.startMs,
              ts_to: temporal?.endMs,
              projectScope,
              category,
              excludeStatuses,
              sort: 'date',
              limit: retrievalLimit,
            })
          : searchRelevantHybrid(db, retrievalQuery, searchOptions),
        boundedHistoricalMode
          ? searchRelevantHybrid(db, retrievalQuery, {
              ...searchOptions,
              includeMembers: false,
              rootOnly: true,
            })
          : Promise.resolve([]),
      ])
      const primaryRootCandidates = deepHistoricalMode
        ? results
            .filter((row) => Number(row?.is_root) === 1)
            .map((row) => ({ ...row, members: [] }))
        : []
      const semanticOnlyRetrieval = isSemanticOnlyRecall(results)
      const seenHistoricalRoots = new Set()
      let historicalRootCandidates = [...primaryRootCandidates, ...historicalRootRows]
        .filter((row) => {
          const id = String(row?.id ?? '')
          if (!id || seenHistoricalRoots.has(id)) return false
          seenHistoricalRoots.add(id)
          return true
        })
      const lowHistoricalResultMode = deepHistoricalMode
        ? results.length <= 2
        : (results.length <= 5 && historicalRootRows.length <= 2)
      if (boundedHistoricalMode && lowHistoricalResultMode) {
        const windowRoots = await retrieveEntries(db, {
          is_root: true,
          ts_from: temporal?.startMs,
          ts_to: temporal?.endMs,
          projectScope,
          category,
          excludeStatuses,
          sort: 'date',
          limit: 50,
        })
        const terms = sessionRecallTerms(retrievalQuery)
        const coverage = (row) => {
          const text = recallRowTopicText(row)
          return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0)
        }
        const seenRoots = new Set()
        historicalRootCandidates = [...primaryRootCandidates, ...windowRoots, ...historicalRootRows]
          .filter((row) => {
            const id = String(row?.id ?? '')
            if (!id || seenRoots.has(id)) return false
            seenRoots.add(id)
            return true
          })
          .sort((a, b) => (
            coverage(b) - coverage(a)
            || Number(b?.retrievalScore ?? b?.rrf ?? 0) - Number(a?.retrievalScore ?? a?.rrf ?? 0)
            || compareRecallNewestFirst(a, b)
          ))
      }
      let filtered = results
      let promoteLatestRaw = false
      if (sort === 'date') {
        // R11 reviewer L5: NaN guard — entries with null/undefined ts default
        // to 0 so the comparator stays numeric and stable.
        filtered.sort(compareRecallNewestFirst)
      } else {
        filtered.sort((a, b) => {
          const sa = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
          return (sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0))
            || (sa(b.score ?? 0) - sa(a.score ?? 0))
            || (sa(b.ts ?? 0) - sa(a.ts ?? 0))
            || (Number(a.id ?? 0) - Number(b.id ?? 0))
        })
      }
      if (structuredTimeMode) {
        const rootRows = filtered.filter((row) => Number(row?.is_root) === 1)
        const roots = vagueLatestRootMode
          ? rootRows.sort(compareRecallNewestFirst)
          : latestIntent
          ? rankLatestRecallRows(rootRows, retrievalQuery)
          : rootRows.sort(compareRecallNewestFirst)
        const other = filtered.filter((row) => Number(row?.is_root) !== 1)
        filtered = [...roots, ...other]
      } else if (latestEntityMode) {
        filtered = rankLatestRecallRows(filtered, retrievalQuery)
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
        const RAW_FETCH = Math.min(500, Math.max(20, retrievalLimit))
        const rawRows = await readRawRowsInWindow(
          db,
          temporal?.startMs ?? null,
          temporal?.endMs ?? Date.now(),
          RAW_FETCH,
          { projectScope, terms: sessionRecallTerms(retrievalQuery) },
        )
        const seenIds = new Set(filtered.map(r => r.id))
        let newRaw = rawRows.filter(r => !seenIds.has(r.id))
        // Relevance gate: readRawRowsInWindow's SQL term filter is loose
        // (minHits 1 for <3-term queries), so unscored raw rows that share a
        // single common token still get stride-interleaved into a ranked
        // result set and push real hits down the page. In the query branch,
        // keep only raw rows whose body actually contains >=1 query term.
        const rawTerms = sessionRecallTerms(retrievalQuery)
        if (rawTerms.length > 0) {
          newRaw = newRaw.filter((r) => {
            const hay = `${r.content ?? ''} ${r.element ?? ''} ${r.summary ?? ''}`.toLowerCase()
            return rawTerms.some((t) => hay.includes(t))
          })
        }
        if (sort === 'date') {
          for (const r of newRaw) filtered.push(r)
          filtered.sort(compareRecallNewestFirst)
        } else {
          // The hybrid entries-table legs already rank indexed raw rows. This
          // auxiliary SQL window only backfills rows not yet present there, so
          // it must not stride unscored progress narration through ranked
          // decisions. Append it as a recall fallback after scored candidates.
          filtered = [...filtered, ...newRaw]
        }
      }
      const coreRows = structuredTimeMode ? [] : await recallCoreRows(retrievalQuery, {
        projectScope,
        category,
        limit: retrievalLimit,
        tsFrom: temporal?.startMs,
        tsTo: temporal?.endMs,
      })
      if (coreRows.length > 0) {
        filtered = interleaveRawRows(filtered, coreRows)
      }
      // Promote fresh unclassified turns only when they cover more of the
      // requested topic than every classified root. Vague latest-work queries
      // must keep their root-only summaries, while a specific fresh setting or
      // identifier can still surface before cycle1 classifies it.
      if (sort !== 'date' && latestIntent) {
        const terms = latestRecallTopicTerms(retrievalQuery)
        const coverage = (row) => {
          const text = recallRowTopicText(row)
          return terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0)
        }
        const rawCoverage = filtered
          .filter((row) => Number(row?.is_root) === 0 && row?.chunk_root == null)
          .reduce((max, row) => Math.max(max, coverage(row)), -1)
        const rootCoverage = filtered
          .filter((row) => Number(row?.is_root) === 1)
          .reduce((max, row) => Math.max(max, coverage(row)), -1)
        promoteLatestRaw = rawCoverage > rootCoverage
        if (promoteLatestRaw) filtered = rankLatestRecallRows(filtered, retrievalQuery)
      }
      // Core rows are prepended by relevance and carry updated_at as ts, so on
      // the chronological (date) path they'd break strict newest-first. Re-sort
      // the merged list by ts desc before slicing so the timeline stays intact.
      if (sort === 'date') {
        filtered.sort(compareRecallNewestFirst)
      }
      if (sort !== 'date' && includeRaw && (!structuredTimeMode || promoteLatestRaw)) {
        const latestConceptRows = latestIntent
          ? filtered.filter((row) => row?._conceptExpanded === true)
          : []
        filtered = await expandRecallEventContext(db, filtered, {
          query: retrievalQuery,
          limit: retrievalLimit,
          tsFrom: temporal?.startMs,
          tsTo: temporal?.endMs,
          excludeStatuses,
          category,
          projectScope,
          dedupeEvents: latestIntent,
        })
        if (latestConceptRows.length > 0) {
          filtered = preserveLatestConceptRows(filtered, latestConceptRows, retrievalLimit)
        }
      }
      if (boundedHistoricalMode) {
        filtered = mergeHistoricalRecallRows(filtered, historicalRootCandidates, retrievalLimit, {
          includeMatchedRootSummary: true,
          rootReserve: deepHistoricalMode ? 6 : (lowHistoricalResultMode ? 5 : 1),
        })
        if (deepHistoricalMode) filtered = prioritizeHistoricalRootEvidence(filtered)
      }
      if (timelineMode) {
        const roots = filtered.filter((row) => Number(row?.is_root) === 1)
        filtered = sampleRecallTimeline(roots.length > 1 ? roots : filtered, limit + offset)
      }
      filtered = annotateRecallRootContext(filtered)
      filtered = boundRecallRowsToTemporal(filtered, temporal)
      // De-duplicate before pagination so member/root pairs do not consume the
      // page and then collapse into a half-empty result set.
      const deduped = collapseNearDuplicateRows(filtered)
      const pageRows = latestIntent
        ? deduped.filter((row) => row?._dupStub !== true)
        : deduped
      const sliced = pageRows.slice(offset, offset + limit)
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
      // recencyOrder render on the date path flattens roots+members into one
      // ts-desc stream so per-chunk (ts-ASC) members can't invert the timeline.
      const latestEvidenceNote = latestIntent && args.period == null
        ? 'note: latest stored evidence; no newer stored completion is implied\n'
        : ''
      const semanticEvidenceNote = semanticOnlyRetrieval
        ? 'note: semantic-only candidates; no lexical corroboration was found, so treat them as possible rather than confirmed evidence\n'
        : ''
      const out = {
        text: recallCapPrefix
          + latestEvidenceNote
          + semanticEvidenceNote
          + renderEntryLines(sliced, { recencyOrder: sort === 'date' }),
      }
      if (process.env.MIXDOG_DEBUG_MEMORY) {
        log(`[search-time] render+trace=${Date.now() - _t2}ms total=${Date.now() - _t0}ms textLen=${out.text.length}\n`)
      }
      return out
    }

    // period='last': session-grouped browse. Pick the N most-recently-active
    // sessions (limit = session count, default 5; offset = session-level
    // paging) ranked by MAX(ts) DESC, then fill each with its newest rows
    // under a per-session row cap. Session selection and per-session fetch
    // reuse the same projectScope / excludeStatuses filters as the generic
    // browse below; the grouped renderer adds activity-span headers. Output
    // size is bounded by session count x per-session row cap plus the
    // orchestrator-level tool-output KB cap — no recall-local line budget.
    if (temporal?.mode === 'last') {
      const sessionCount = Number.isFinite(requestedLimit) ? limit : 5
      const PER_SESSION_ROW_CAP = 10
      const PER_SESSION_SEARCH_CAP = 50
      const queryTerms = sessionRecallTerms(query)
      const matchesQueryTerms = (row) => {
        if (queryTerms.length === 0) return true
        const rowText = `${row?.content ?? ''} ${row?.element ?? ''} ${row?.summary ?? ''}`.toLowerCase()
        if (queryTerms.some((term) => rowText.includes(term))) return true
        if (Array.isArray(row?.members)) {
          return row.members.some((member) => {
            const memberText = `${member?.content ?? ''} ${member?.element ?? ''} ${member?.summary ?? ''}`.toLowerCase()
            return queryTerms.some((term) => memberText.includes(term))
          })
        }
        return false
      }
      const excludeStatuses = includeArchived ? [] : ['archived']
      const VALID_LAST_CATS = new Set(['rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue'])
      const requestedCats = category == null
        ? []
        : [...new Set((Array.isArray(category) ? category : [category])
            .map((c) => String(c).trim().toLowerCase())
            .filter((c) => VALID_LAST_CATS.has(c)))]
      // Asking for every public category is semantically unfiltered. Keeping
      // it as a restrictive filter drops fresh unclassified raw turns before
      // cycle1 assigns a category, which can hide the immediately prior chat.
      const catList = requestedCats.length === VALID_LAST_CATS.size ? [] : requestedCats
      // 1) Rank sessions by the timestamps the renderer actually exposes.
      //    A root with members renders those members instead of its own ts, so
      //    ranking by root MAX(ts) can disagree with the visible group head and
      //    invert adjacent sessions/pages. Roots without members and raw leaves
      //    keep their own ts. projectScope + excludeStatuses + promoted
      //    exclusion still match the fill filters below.
      const selWhere = [
        'e.session_id IS NOT NULL',
        "btrim(e.session_id) <> ''",
        includeRaw ? '(e.is_root = 1 OR e.chunk_root IS NULL OR e.chunk_root = e.id)' : 'e.is_root = 1',
      ]
      const selParams = []
      if (projectScope === 'common') {
        selWhere.push('e.project_id IS NULL')
      } else if (typeof projectScope === 'string' && projectScope && projectScope !== 'all') {
        selParams.push(projectScope)
        selWhere.push(`(e.project_id IS NULL OR e.project_id = $${selParams.length})`)
      }
      if (catList.length > 0) {
        const ph = catList.map((c) => { selParams.push(c); return `$${selParams.length}` }).join(',')
        selWhere.push(`lower(coalesce(e.category, '')) IN (${ph})`)
      }
      if (excludeStatuses.length > 0) {
        const ph = excludeStatuses.map((s) => { selParams.push(s); return `$${selParams.length}` }).join(',')
        selWhere.push(`(e.status IS NULL OR e.status NOT IN (${ph}))`)
      }
      for (const c of buildPromotedExclusionClauses('e')) selWhere.push(c)
      const cursorContext = {
        query,
        projectScope,
        categories: catList,
        includeArchived,
        includeMembers,
        includeRaw,
      }
      const pageCursor = args.cursor ? decodeRecallPageCursor(args.cursor, cursorContext) : null
      // Deterministic tie-breaker: equal visible activity timestamps use
      // session_id DESC. The cursor carries that exact pair, so newly-created
      // sessions ahead of page 1 cannot shift page 2.
      const visibleFirstTs = includeMembers ? `CASE WHEN e.is_root = 1
                              THEN coalesce(member_span.first_ts, e.ts)
                              ELSE e.ts END` : 'e.ts'
      const visibleLastTs = includeMembers ? `CASE WHEN e.is_root = 1
                             THEN coalesce(member_span.last_ts, e.ts)
                             ELSE e.ts END` : 'e.ts'
      let cursorHaving = ''
      if (pageCursor) {
        selParams.push(pageCursor.lastTs, pageCursor.sessionId)
        const tsParam = `$${selParams.length - 1}`
        const sidParam = `$${selParams.length}`
        cursorHaving = `HAVING (MAX(${visibleLastTs}) < ${tsParam}
                          OR (MAX(${visibleLastTs}) = ${tsParam} AND e.session_id < ${sidParam}))`
      }
      const fetchSessionCount = sessionCount + 1
      selParams.push(fetchSessionCount, pageCursor ? 0 : offset)
      const sessSql = `SELECT e.session_id,
                              MIN(${visibleFirstTs}) AS first_ts,
                              MAX(${visibleLastTs}) AS last_ts
                       FROM entries e
                       LEFT JOIN LATERAL (
                         SELECT MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
                         FROM entries m
                         WHERE e.is_root = 1 AND m.is_root = 0 AND m.chunk_root = e.id
                       ) member_span ON true
                       WHERE ${selWhere.join(' AND ')}
                       GROUP BY e.session_id
                       ${cursorHaving}
                       ORDER BY last_ts DESC, e.session_id DESC
                       LIMIT $${selParams.length - 1} OFFSET $${selParams.length}`
      const selectedSessionRows = (await db.query(sessSql, selParams)).rows
      const hasMoreSessions = selectedSessionRows.length > sessionCount
      const sessRows = selectedSessionRows.slice(0, sessionCount)
      const lastSession = sessRows.at(-1)
      const nextCursor = hasMoreSessions && lastSession
        ? encodeRecallPageCursor({
            lastTs: Number(lastSession.last_ts),
            sessionId: lastSession.session_id,
            context: cursorContext,
          })
        : null
      // 2) per selected session, fetch its newest rows (roots+members, sort by
      //    date) plus the fresh raw window, capped at PER_SESSION_ROW_CAP.
      const allRows = []
      const sessionMeta = new Map()
      for (const s of sessRows) {
        const sid = String(s?.session_id || '').trim()
        if (!sid) continue
        const perSessionFetchCap = queryTerms.length > 0 ? PER_SESSION_SEARCH_CAP : PER_SESSION_ROW_CAP
        const sf = { limit: perSessionFetchCap, session_id: sid, projectScope, sort: 'date' }
        if (includeMembers) sf.includeMembers = true
        if (excludeStatuses.length > 0) sf.excludeStatuses = excludeStatuses
        if (catList.length > 0) sf.category = catList
        const sRows = await retrieveEntries(db, sf)
        let merged = sRows
        if (includeRaw) {
          let rawRows
          if (queryTerms.length > 0) {
            // Keep a full unfiltered recency window for the newest-row floor,
            // while separately retaining the deeper term-matched raw window.
            const [recentRawRows, matchedRawRows] = await Promise.all([
              readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, { projectScope, sessionId: sid, terms: [] }),
              readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, { projectScope, sessionId: sid, terms: queryTerms, minHits: 1 }),
            ])
            const rawIds = new Set()
            rawRows = [...recentRawRows, ...matchedRawRows].filter((r) => {
              const id = Number(r.id)
              if (rawIds.has(id)) return false
              rawIds.add(id)
              return true
            })
          } else {
            rawRows = await readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, { projectScope, sessionId: sid, terms: [] })
          }
          const seenIds = new Set(sRows.map((r) => Number(r.id)))
          for (const r of sRows) if (Array.isArray(r.members)) for (const m of r.members) seenIds.add(Number(m.id))
          // readRawRowsInWindow carries no category filter, so a category-
          // scoped last must gate raw rows here to match the ranking/fill
          // category predicate (unclassified raw rows have no category and
          // are correctly dropped when a category is requested).
          let newRaw = rawRows.filter((r) => !seenIds.has(Number(r.id)))
          if (catList.length > 0) {
            newRaw = newRaw.filter((r) => catList.includes(String(r.category || '').trim().toLowerCase()))
          }
          // readRawRowsInWindow carries no status filter either, so an
          // includeArchived:false browse must drop archived raw rows here to
          // match the ranking/root-fill excludeStatuses predicate.
          if (excludeStatuses.length > 0) {
            newRaw = newRaw.filter((r) => {
              const st = String(r.status || '').trim().toLowerCase()
              return !st || !excludeStatuses.includes(st)
            })
          }
          if (newRaw.length > 0) {
            merged = [...sRows, ...newRaw]
            merged.sort(compareRecallNewestFirst)
          }
        }
        const fetchedCount = merged.length
        let queryFiltered = false
        if (queryTerms.length > 0) {
          const newestRows = merged.slice(0, 3)
          const newestIds = new Set(newestRows.map((r) => r.id))
          const matchedRows = merged.filter(matchesQueryTerms)
          // A topic query must not obscure a session's latest activity: keep
          // its three newest rows, then use term matches for the remaining
          // display slots without duplicating rows already kept for recency.
          merged = [...newestRows, ...matchedRows.filter((r) => !newestIds.has(r.id))]
          // Only mark query filtering when its floor+match union actually
          // excludes fetched rows. The later display cap is independent.
          queryFiltered = merged.length < fetchedCount
        }
        merged = merged.slice(0, PER_SESSION_ROW_CAP)
        sessionMeta.set(sid, {
          minTs: Number(s.first_ts),
          maxTs: Number(s.last_ts),
          fetchedCount,
          shownCount: merged.length,
          queryFiltered,
        })
        for (const r of merged) allRows.push(r)
      }
      const _currentSessionHint = String(args?.currentSessionId || '').trim()
      const cursorPrefix = nextCursor ? `[nextCursor: ${nextCursor}]\n` : ''
      return { text: recallCapPrefix + cursorPrefix + renderSessionGroupedLines(allRows, {
        currentSessionId: _currentSessionHint,
        recencyOrder: true,
        spanHeaders: true,
        sessionMeta,
      }), nextCursor }
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
    if (sort === 'date' && includeRaw) {
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
        merged.sort(compareRecallNewestFirst)
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

  return {
    readRawRowsInWindow,
    recallSessionRows,
    recallCoreRows,
    handleSearch,
    dumpSessionRootChunks,
    entryStats,
  }
}
