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

export function renderEntryLines(rows) {
  if (!rows || rows.length === 0) return '(no results)'
  const lines = []
  // Bound total emitted lines (roots x members) so a many-member recall can't
  // inject unbounded output. Per-line content is already capped at 1000 chars;
  // this caps the line COUNT. Narrow the query (limit/period/projectScope) for more.
  const RECALL_LINE_CAP = 200
  let _capped = false
  outer:
  for (const r of rows) {
    const hasMembers = Array.isArray(r.members) && r.members.length > 0
    if (hasMembers) {
      // Chunks present: emit each member as its own line. Root row is a
      // grouping artifact for retrieval — the caller wants the chunk
      // content (cycle1 raw), not the cycle2-compressed summary.
      for (const m of r.members) {
        if (lines.length >= RECALL_LINE_CAP) { _capped = true; break outer }
        const mTs = formatTs(m.ts)
        const role = m.role === 'user' ? 'u' : m.role === 'assistant' ? 'a' : (m.role || '?')
        const content = cleanMemoryText(String(m.content ?? '')).slice(0, 1000)
        lines.push(`[${mTs}] ${role}: ${content} #${m.id}`)
      }
    } else {
      if (lines.length >= RECALL_LINE_CAP) { _capped = true; break }
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
        : cleanMemoryText(String(r.content ?? '')).slice(0, 1000)
      // Unchunked raw leaf (cycle1 hasn't classified it yet): mark it so
      // callers can tell fresh-but-unprocessed rows from chunked memory.
      const pendingMark = (r.is_root === 0 && r.chunk_root == null) ? ' [pending]' : ''
      lines.push(`[${ts}] ${rolePrefix}${body.slice(0, 1000)}${pendingMark} #${r.id}`)
    }
  }
  if (_capped) lines.push(`[recall truncated — showing first ${RECALL_LINE_CAP} lines; narrow the query (limit/period/projectScope) for the rest]`)
  return lines.join('\n')
}
