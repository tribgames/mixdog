import { cleanMemoryText } from './memory.mjs'

// Recall query/format helpers extracted verbatim from index.mjs
// (behavior-preserving). Pure string/date logic plus row rendering.

export function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d'
  if (!period) return null
  if (period === 'all') return null
  if (period === 'last') return { mode: 'last' }
  // Calendar-day windows: 'today' anchors at local midnight rather than
  // rolling 24h. Without this, a query asking 'today' at 01:30 would silently
  // include yesterday's last 22.5h of activity, mislabelling them as
  // 'today's work'. 'yesterday' is the previous calendar day.
  if (period === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return { startMs: start.getTime(), endMs: Date.now() }
  }
  if (period === 'yesterday') {
    const start = new Date()
    start.setDate(start.getDate() - 1)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setHours(23, 59, 59, 999)
    return { startMs: start.getTime(), endMs: end.getTime() }
  }
  if (period === 'this_week' || period === 'last_week') {
    // R6 P9: calendar Mon-Sun previous/current week. Mon-start ISO
    // convention. Replaces R5 rolling 7-14d range which was empty for
    // sessions where "last week" decisions actually fell on Mon (4/27) of
    // this week. Precise calendar bounds match natural-language intuition.
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const dayOfWeek = d.getDay()
    const daysSinceMon = (dayOfWeek + 6) % 7
    const thisWeekMon = new Date(d)
    thisWeekMon.setDate(d.getDate() - daysSinceMon)
    if (period === 'this_week') {
      return { startMs: thisWeekMon.getTime(), endMs: Date.now() }
    }
    const lastWeekMon = new Date(thisWeekMon)
    lastWeekMon.setDate(thisWeekMon.getDate() - 7)
    const lastWeekSunEnd = new Date(thisWeekMon.getTime() - 1)
    return { startMs: lastWeekMon.getTime(), endMs: lastWeekSunEnd.getTime() }
  }
  const relMatch = period.match(/^(\d+)(m|h|d)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const now = new Date()
    if (unit === 'm') {
      // Minute granularity is for "resume from the previous turn / pick
      // up where we left off" style recall — sub-hour windows where 1h
      // is too coarse. n=0 is invalid (the regex requires \d+ which
      // matches "0" but a zero-width window returns no rows; leave that
      // as caller-supplied no-op).
      const start = new Date(now.getTime() - n * 60_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    if (unit === 'h') {
      const start = new Date(now.getTime() - n * 3600_000)
      return { startMs: start.getTime(), endMs: now.getTime() }
    }
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { startMs: start.getTime(), endMs: now.getTime() }
  }
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return {
      startMs: Date.parse(rangeMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(rangeMatch[2] + 'T23:59:59.999'),
    }
  }
  // Time-of-day windows: 'HH:MM~HH:MM' (today) or 'YYYY-MM-DD HH:MM~HH:MM'
  // (specific day). Covers "this afternoon 12:00-14:00" style recall that the
  // day-granular date/range forms cannot express. End is inclusive to the
  // minute (:59.999). An end at or before start returns null (invalid window)
  // rather than guessing an overnight wrap.
  const todMatch = period.match(/^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$/)
  if (todMatch) {
    const [, day, h1, m1, h2, m2] = todMatch
    const base = day ? new Date(day + 'T00:00:00') : new Date()
    if (Number.isNaN(base.getTime())) return null
    const sh = Number(h1), sm = Number(m1), eh = Number(h2), em = Number(m2)
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null
    const start = new Date(base); start.setHours(sh, sm, 0, 0)
    const end = new Date(base); end.setHours(eh, em, 59, 999)
    if (end.getTime() <= start.getTime()) return null
    return { startMs: start.getTime(), endMs: end.getTime(), exact: true }
  }
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/)
  if (dateMatch) {
    return {
      startMs: Date.parse(dateMatch[1] + 'T00:00:00'),
      endMs:   Date.parse(dateMatch[1] + 'T23:59:59.999'),
      exact: true,
    }
  }
  return null
}

export function formatTs(tsMs) {
  const n = Number(tsMs)
  if (Number.isFinite(n) && n > 1e12) {
    return new Date(n).toLocaleString('sv-SE').slice(0, 16)
  }
  return String(tsMs ?? '').slice(0, 16)
}

export const CORE_RECALL_STOPWORDS = new Set([
  'about', 'after', 'again', 'before', 'check', 'color', 'decision', 'decided',
  'earlier', 'memory', 'previous', 'routing', 'stored', 'tell', 'what',
])

export function coreRecallTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) || [])]
    .filter((term) => !CORE_RECALL_STOPWORDS.has(term))
    .slice(0, 8)
}

export function normalizeRecallProjectScope(projectScope) {
  const raw = String(projectScope || 'common').trim()
  if (!raw || raw.toLowerCase() === 'common') return null
  if (raw.toLowerCase() === 'all') return '*'
  return raw
}

export function sessionRecallTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu) || [])]
    .filter((term) => !CORE_RECALL_STOPWORDS.has(term))
    .slice(0, 12)
}

export function interleaveRawRows(hybridRows, rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return hybridRows
  const out = []
  const stride = Math.max(1, Math.round(hybridRows.length / (rawRows.length + 1)))
  let rawIdx = 0
  for (let i = 0; i < hybridRows.length; i += 1) {
    out.push(hybridRows[i])
    if ((i + 1) % stride === 0 && rawIdx < rawRows.length) {
      out.push(rawRows[rawIdx])
      rawIdx += 1
    }
  }
  while (rawIdx < rawRows.length) out.push(rawRows[rawIdx++])
  return out
}

export function renderEntryLines(rows, { recencyOrder = false } = {}) {
  if (!rows || rows.length === 0) return '(no results)'
  // Each emitted line is tracked as a { ts, text } unit so the recencyOrder
  // path can sort the WHOLE stream (roots + their members, plus leaf/raw rows)
  // strictly newest-first. Members are fetched ts-ASC per chunk, so without
  // this global re-sort a multi-member chunk would emit oldest-first lines and
  // break a strict newest-first contract (bench: recency-today).
  const units = []
  // No line-count cap here: the orchestrator enforces a global tool-output KB
  // cap (builtin.mjs tool_output_token_limit), so recall need not self-truncate.
  // recencyOrder still collects every unit first so the ts sort sees the full
  // set; the default path emits in row order. Per-line body is bounded by a
  // loose 8000-char safety cap so one giant pasted-log row can't monopolize
  // the envelope.
  for (const r of rows) {
    // Collapsed near-duplicate (search path only — set by
    // collapseNearDuplicateRows). Emit a one-line stub carrying its #id so an
    // id-lookup follow-up can still fetch the full body; never rendered for
    // id-lookup output (those rows never carry _dupStub).
    if (r && r._dupStub) {
      units.push({ ts: Number(r.ts) || 0, text: `[${formatTs(r.ts)}] (near-duplicate of #${r._dupOf} — collapsed) #${r.id}` })
      continue
    }
    const hasMembers = Array.isArray(r.members) && r.members.length > 0
    if (hasMembers) {
      // Chunks present: emit each member as its own line. Root row is a
      // grouping artifact for retrieval — the caller wants the chunk
      // content (cycle1 raw), not the cycle2-compressed summary.
      for (const m of r.members) {
        const mTs = formatTs(m.ts)
        const role = m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : (m.role || '?')
        const content = cleanMemoryText(String(m.content ?? '')).slice(0, 8000)
        units.push({ ts: Number(m.ts) || 0, text: `[${mTs}] ${role}: ${content} #${m.id}` })
      }
    } else {
      // No chunks (root not yet chunked by cycle1, or orphan leaf): emit
      // the row itself in the same shape. element/summary fall back to
      // raw content when both are absent.
      const ts = formatTs(r.ts)
      const element = r.element ?? ''
      const summary = r.summary ?? ''
      // Standalone leaf rows (is_root=0, no parent chunks_root resolved
      // into a `members` list) carry their u/a role just like inline
      // chunk members — surface it so the format stays consistent across
      // the two emission paths.
      const rolePrefix = r.is_root === 0 && r.role
        ? (r.role === 'user' ? 'u: ' : r.role === 'assistant' ? 'a: ' : `${r.role}: `)
        : ''
      const body = element || summary
        ? `${element}${summary ? ' — ' + summary : ''}`
        : cleanMemoryText(String(r.content ?? '')).slice(0, 8000)
      // Unchunked raw leaf (cycle1 hasn't classified it yet): mark it so
      // callers can tell fresh-but-unprocessed rows from chunked memory.
      const pendingMark = (r.is_root === 0 && r.chunk_root == null) ? ' [pending]' : ''
      units.push({ ts: Number(r.ts) || 0, text: `[${ts}] ${rolePrefix}${body.slice(0, 8000)}${pendingMark} #${r.id}` })
    }
  }
  if (recencyOrder) {
    // Array.sort is stable in V8, so units sharing the same ts keep their
    // insertion (root/member) order; only cross-unit ts breaks are corrected.
    units.sort((a, b) => b.ts - a.ts)
  }
  return units.map((u) => u.text).join('\n')
}

// Search-result de-duplication. Within a SINGLE formatted result set, hybrid
// recall frequently returns several long rows that restate the same design in
// slightly different words (e.g. a root summary plus a chunk that paraphrases
// it). They each spend a large slice of the envelope on near-identical text.
// Cheap heuristic (no embeddings): normalize each row's body to word tokens,
// build 3-gram shingle sets, and measure containment overlap = |A∩B| /
// min(|A|,|B|) against already-kept rows. Rows arrive rank/date-ordered, so the
// FIRST occurrence is the newest/highest-ranked and is kept full; a later
// high-overlap row is dropped (near-total) or rendered as an id-stub.
//   - drop  when overlap >= DROP_OVERLAP (0.9): body adds nothing.
//   - stub  when overlap >= STUB_OVERLAP (0.65): keep the #id reachable.
// Short bodies (< MIN_TOKENS words) are never collapsed — they can't carry
// enough signal for the overlap metric to be meaningful and are cheap anyway.
// Applies to search results only; id-lookup output must never call this.
function normalizedRowText(r) {
  if (Array.isArray(r?.members) && r.members.length > 0) {
    return r.members.map((m) => cleanMemoryText(String(m.content ?? ''))).join(' ').toLowerCase()
  }
  const element = r?.element ?? ''
  const summary = r?.summary ?? ''
  const body = (element || summary)
    ? `${element} ${summary}`
    : cleanMemoryText(String(r?.content ?? ''))
  return String(body).toLowerCase()
}

export function collapseNearDuplicateRows(rows, {
  stubOverlap = 0.65,
  dropOverlap = 0.9,
  minTokens = 12,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return rows
  const shingle = (r) => {
    const toks = normalizedRowText(r).match(/[\p{L}\p{N}_]+/gu) || []
    if (toks.length < minTokens) return null
    const set = new Set()
    if (toks.length < 3) { for (const t of toks) set.add(t); return set }
    for (let i = 0; i + 3 <= toks.length; i += 1) set.add(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`)
    return set
  }
  const kept = [] // { row, shingles }
  const out = []
  for (const r of rows) {
    const sh = shingle(r)
    if (!sh) { out.push(r); continue }
    // Two metrics per kept row:
    //   containment = |A∩B| / min(|A|,|B|)  — catches paraphrase/superset
    //   jaccard     = |A∩B| / |A∪B|         — size-aware, immune to the
    //                                         short-vs-long 1.0 false positive
    // Dropping on containment alone let a short distinct UPDATE fully contained
    // in a long earlier row score 1.0 and vanish. Drop only on high jaccard OR
    // high containment between comparably-sized rows (size ratio >= 0.5). Stub
    // stays containment-based so paraphrase restatements still collapse to a
    // reachable id-stub.
    let bestStub = 0
    let bestStubId = null
    let drop = false
    for (const k of kept) {
      const [small, large] = sh.size <= k.shingles.size ? [sh, k.shingles] : [k.shingles, sh]
      let inter = 0
      for (const g of small) if (large.has(g)) inter += 1
      const containment = small.size ? inter / small.size : 0
      const union = sh.size + k.shingles.size - inter
      const jaccard = union ? inter / union : 0
      const sizeRatio = large.size ? small.size / large.size : 0
      if (jaccard >= 0.85 || (containment >= dropOverlap && sizeRatio >= 0.5)) drop = true
      if (containment > bestStub) { bestStub = containment; bestStubId = k.row.id }
    }
    if (drop) continue
    if (bestStub >= stubOverlap) { out.push({ ...r, _dupStub: true, _dupOf: bestStubId }); continue }
    kept.push({ row: r, shingles: sh })
    out.push(r)
  }
  return out
}

// Compact session label for group headers: keep short ids verbatim, shorten
// long ones to a recognizable tail (ids are typically unique in the suffix —
// timestamp/counter — not the prefix).
function shortSessionLabel(sid) {
  const s = String(sid || '').trim()
  if (s.length <= 20) return s
  return `…${s.slice(-16)}`
}

// Collect every ts in a session group (roots + their inline members) so the
// span header reflects the true activity window, not just the root ts.
function collectGroupTs(groupRows) {
  const all = []
  for (const r of groupRows) {
    const t = Number(r?.ts)
    if (Number.isFinite(t)) all.push(t)
    if (Array.isArray(r?.members)) for (const m of r.members) {
      const mt = Number(m?.ts)
      if (Number.isFinite(mt)) all.push(mt)
    }
  }
  return all
}

// Activity-span header suffix: `(MM-DD HH:mm ~ HH:mm, n건)`; the end keeps the
// MM-DD prefix only when it falls on a different calendar day than the start.
function spanHeaderSuffix(minTs, maxTs, n) {
  const min = formatTs(minTs) // "YYYY-MM-DD HH:mm"
  const max = formatTs(maxTs)
  const startPart = min.slice(5) // "MM-DD HH:mm"
  const endPart = min.slice(0, 10) === max.slice(0, 10) ? max.slice(11) : max.slice(5)
  return `(${startPart} ~ ${endPart}, ${n}건)`
}

// Session-grouped rendering for the GLOBAL query-less browse ("what did we
// work on recently") when the window spans multiple sessions. A flat ts-desc
// list interleaves sessions into one indistinguishable stream and lets one
// chatty session crowd the page; grouping keeps each work-unit readable.
// Group order = newest activity first (rows arrive ts-desc, first-seen wins).
// The caller's own session (currentSessionId hint) is marked "(current)".
// Single-session (or session-less) result sets fall through to the flat
// renderer — no headers when grouping adds nothing.
// recencyOrder (date-sorted browse) is forwarded to renderEntryLines so each
// group's lines are globally ts-desc: without it a chunk root's members (stored
// ts-ASC) interleave with raw rows and invert the visible timeline within a
// session (e.g. 04:33 rendered above 04:41).
export function renderSessionGroupedLines(rows, { currentSessionId, recencyOrder = false, spanHeaders = false } = {}) {
  if (!rows || rows.length === 0) return '(no results)'
  const groups = new Map()
  for (const r of rows) {
    const sid = String(r?.session_id || '').trim()
    const key = sid || '(no session)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  if (!spanHeaders && groups.size <= 1) return renderEntryLines(rows, { recencyOrder })
  const current = String(currentSessionId || '').trim()
  // period='last' session-grouped browse: activity-span headers over each
  // group's body. No line budget — the orchestrator's global tool-output KB
  // cap bounds total size; each group's body is already row-capped by the
  // caller.
  if (spanHeaders) {
    const parts = []
    for (const [sid, groupRows] of groups) {
      const mark = current && sid === current ? ' (current)' : ''
      const label = sid === '(no session)' ? sid : `session ${shortSessionLabel(sid)}`
      const tsAll = collectGroupTs(groupRows)
      const suffix = tsAll.length
        ? ` ${spanHeaderSuffix(Math.min(...tsAll), Math.max(...tsAll), groupRows.length)}`
        : ` (${groupRows.length}건)`
      parts.push(`## ${label}${mark}${suffix}`)
      const bodyStr = renderEntryLines(groupRows, { recencyOrder })
      const bodyLines = bodyStr === '(no results)'
        ? []
        : bodyStr.split('\n')
      for (const l of bodyLines) parts.push(l)
    }
    return parts.join('\n')
  }
  const parts = []
  for (const [sid, groupRows] of groups) {
    const mark = current && sid === current ? ' (current)' : ''
    const label = sid === '(no session)' ? sid : `session ${shortSessionLabel(sid)}`
    parts.push(`## ${label}${mark}`)
    parts.push(renderEntryLines(groupRows, { recencyOrder }))
  }
  return parts.join('\n')
}
