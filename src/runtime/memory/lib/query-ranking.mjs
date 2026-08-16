import { sessionRecallTerms } from './recall-format.mjs'
import { compareRecallNewestFirst } from './recall-order.mjs'

const LATEST_RECALL_CONTEXT_TERMS = new Set([
  'latest', 'current', 'recent', 'most', 'now', 'final', 'result', 'status', 'statu',
  'decision', 'complete', 'completed',
  '최신', '현재', '최근', '지금', '방금', '최종', '결과', '상태', '값', '확정값', '결정', '완료',
])

export function hasRecallEntity(text) {
  return /[A-Za-z0-9_./:-]/u.test(String(text ?? ''))
}

export function hasLatestRecallIntent(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  return /최신|현재|최근|방금|latest|current|most\s+recent/.test(value)
}

export function hasVagueLatestWorkIntent(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  return /방금.*(?:작업|결과)|(?:latest|recent|most\s+recent).*(?:work|result)/u.test(value)
}

export function latestRecallTopicTerms(text) {
  return sessionRecallTerms(text)
    .filter((term) => !LATEST_RECALL_CONTEXT_TERMS.has(term))
    .filter((term) => !/^\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?$/u.test(term))
    .filter((term) => !/^\d{1,2}:\d{2}(?:~\d{1,2}:\d{2})?$/u.test(term))
    .filter((term) => !/^\d{1,4}(?:년|월|일|시|분)$/u.test(term))
}

export function latestRecallSearchTerms(text) {
  const topicTerms = latestRecallTopicTerms(text)
  const attachedAsciiTerms = [...String(text ?? '').matchAll(/([A-Za-z0-9_./:-]{2,})(?=\p{Script=Hangul})/gu)]
    .flatMap((match) => sessionRecallTerms(match[1]))
  const attachedSet = new Set(attachedAsciiTerms)
  const identifiers = topicTerms.filter((term) => (
    /[_./:-]|\d/u.test(term)
    || attachedSet.has(term)
    || (attachedSet.size > 0 && /^[a-z][a-z0-9_-]*$/u.test(term))
  ))
  return identifiers.length > 0 ? identifiers : topicTerms
}

export function recallRowTopicText(row) {
  const members = Array.isArray(row?.members) ? row.members : []
  return [
    row?.content,
    row?.element,
    row?.summary,
    ...members.flatMap((member) => [member?.content, member?.element, member?.summary]),
  ].filter(Boolean).join(' ').normalize('NFKC').toLowerCase()
}

export function rankLatestRecallRows(rows, query) {
  const terms = latestRecallTopicTerms(query)
  const explicitIdentifiers = String(query ?? '').match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []
  const strictEntityCoverage = explicitIdentifiers.filter((term) => (
    /^[A-Z]{2,}$/u.test(term) || /[A-Z]/u.test(term.slice(1)) || /[_\d]/u.test(term)
  )).length > 1
  const normalizedQuery = String(query ?? '').normalize('NFKC').trim().toLowerCase()
  const score = (row) => {
    const value = Number(row?.retrievalScore ?? row?.rrf ?? row?.score ?? 0)
    return Number.isFinite(value) ? value : 0
  }
  const annotated = [...(Array.isArray(rows) ? rows : [])]
    .map((row, index) => {
      const text = recallRowTopicText(row)
      return {
        row,
        index,
        coverage: terms.reduce((count, term) => count + (text.includes(term) ? 1 : 0), 0),
        selfEcho: String(row?.content ?? '').normalize('NFKC').trim().toLowerCase() === normalizedQuery,
      }
    })
  const maxCoverage = annotated.reduce((max, candidate) => Math.max(max, candidate.coverage), 0)
  const latestCoverageFloor = strictEntityCoverage
    ? maxCoverage
    : (maxCoverage > 1 ? maxCoverage - 1 : maxCoverage)
  return annotated
    .sort((a, b) => {
      if (a.selfEcho !== b.selfEcho) return a.selfEcho ? 1 : -1
      const aLatestTopic = a.coverage >= latestCoverageFloor
      const bLatestTopic = b.coverage >= latestCoverageFloor
      if (aLatestTopic !== bLatestTopic) return aLatestTopic ? -1 : 1
      if (aLatestTopic && bLatestTopic) {
        return compareRecallNewestFirst(a.row, b.row)
          || (b.coverage - a.coverage)
          || (score(b.row) - score(a.row))
          || (a.index - b.index)
      }
      return (b.coverage - a.coverage)
        || (score(b.row) - score(a.row))
        || compareRecallNewestFirst(a.row, b.row)
        || (a.index - b.index)
    })
    .map(({ row }) => row)
}

export function mergeHistoricalRecallRows(primaryRows, rootRows, limit = 10, {
  includeMatchedRootSummary = false,
  rootReserve = 1,
} = {}) {
  const cap = Math.max(1, Math.floor(Number(limit) || 10))
  const rootById = new Map()
  for (const row of Array.isArray(rootRows) ? rootRows : []) {
    const id = String(row?.id ?? '')
    if (id && !rootById.has(id)) rootById.set(id, row)
  }
  const seen = new Set()
  const primary = []
  for (const row of Array.isArray(primaryRows) ? primaryRows : []) {
    const id = String(row?.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const classified = rootById.get(id)
    const summarySource = classified ?? (Number(row?.is_root) === 1 ? row : null)
    primary.push(includeMatchedRootSummary && summarySource
      ? {
          ...row,
          _historicalRootElement: summarySource.element,
          _historicalRootSummary: summarySource.summary,
        }
      : row)
  }
  const reserve = Math.max(0, Math.min(cap, Math.floor(Number(rootReserve) || 0)))
  const novelRoots = (Array.isArray(rootRows) ? rootRows : [])
    .filter((row) => !seen.has(String(row?.id ?? '')))
    .slice(0, reserve)
  if (novelRoots.length === 0) return primary.slice(0, cap)
  const out = []
  let primaryIndex = 0
  if (primary.length > 0) out.push(primary[primaryIndex++])
  if (reserve > 1) {
    out.push(...novelRoots)
    while (out.length < cap && primaryIndex < primary.length) out.push(primary[primaryIndex++])
    return out.slice(0, cap)
  }
  for (const root of novelRoots) {
    out.push(root)
    if (primaryIndex < primary.length) out.push(primary[primaryIndex++])
  }
  while (out.length < cap && primaryIndex < primary.length) out.push(primary[primaryIndex++])
  return out.slice(0, cap)
}

export function preserveLatestConceptRows(primaryRows, conceptRows, limit = 30) {
  const cap = Math.max(1, Math.floor(Number(limit) || 30))
  const primary = Array.isArray(primaryRows) ? primaryRows : []
  const concepts = Array.isArray(conceptRows)
    ? conceptRows
        .slice()
        .sort((a, b) => (
          Number(b?.retrievalScore ?? b?.rrf ?? 0) - Number(a?.retrievalScore ?? a?.rrf ?? 0)
          || Number(a?.retrievalRank ?? Number.MAX_SAFE_INTEGER)
            - Number(b?.retrievalRank ?? Number.MAX_SAFE_INTEGER)
        ))
        .slice(0, 1)
    : []
  const seen = new Set()
  const out = []
  const append = (row) => {
    const id = String(row?.id ?? '')
    if (!id || seen.has(id) || out.length >= cap) return
    seen.add(id)
    out.push(row)
  }
  if (primary.length > 0) append(primary[0])
  for (const row of concepts) append(row)
  for (const row of primary) append(row)
  return out
}

export function boundRecallRowsToTemporal(rows, temporal) {
  const startMs = Number(temporal?.startMs)
  const endMs = Number(temporal?.endMs)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return rows
  const inRange = (row) => {
    const ts = Number(row?.ts)
    return Number.isFinite(ts) && ts >= startMs && ts <= endMs
  }
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (!Array.isArray(row?.members) || row.members.length === 0) return inRange(row) ? [row] : []
    const members = row.members.filter(inRange)
    if (members.length > 0) return [{ ...row, members }]
    return inRange(row) ? [{ ...row, members: [] }] : []
  })
}

export function prioritizeHistoricalRootEvidence(rows) {
  const source = Array.isArray(rows) ? rows : []
  const rootIds = new Set(source
    .filter((row) => Number(row?.is_root) === 1)
    .map((row) => String(row?.id ?? ''))
    .filter(Boolean))
  const groups = new Map()
  for (const row of source) {
    const ownId = String(row?.id ?? '')
    const parentId = String(row?.chunk_root ?? '')
    const key = Number(row?.is_root) === 1
      ? `root:${ownId}`
      : (rootIds.has(parentId) ? `root:${parentId}` : `row:${ownId}`)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.values()].flatMap((group) => group.sort((a, b) => (
    Number(b?.is_root === 1) - Number(a?.is_root === 1)
  )))
}

export function annotateRecallRootContext(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => (
    Number(row?.is_root) === 1 && Array.isArray(row?.members) && row.members.length > 0
      ? {
          ...row,
          _historicalRootElement: row.element,
          _historicalRootSummary: row.summary,
        }
      : row
  ))
}

export function hasTimelineIntent(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  return /처음(?:부터)?|나중|변천|히스토리|과정|history|timeline|from\s+the\s+start/.test(value)
}

export function sampleRecallTimeline(rows, limit) {
  const cap = Math.max(1, Math.floor(Number(limit) || 10))
  const sorted = [...rows].sort(compareRecallNewestFirst)
  if (sorted.length <= cap) return sorted
  const selected = new Set()
  const score = (row) => {
    const value = Number(row?.retrievalScore ?? row?.rrf ?? row?.score ?? 0)
    return Number.isFinite(value) ? value : 0
  }
  const byRelevance = sorted
    .map((row, index) => ({ index, score: score(row) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
  const relevanceCount = Math.max(1, Math.ceil(cap / 2))
  for (const candidate of byRelevance) {
    selected.add(candidate.index)
    if (selected.size >= relevanceCount) break
  }
  const coverageCount = cap - relevanceCount
  for (let slot = 0; slot < coverageCount; slot += 1) {
    const ratio = coverageCount === 1 ? 0 : slot / (coverageCount - 1)
    selected.add(Math.round(ratio * (sorted.length - 1)))
  }
  for (const candidate of byRelevance) {
    if (selected.size >= cap) break
    selected.add(candidate.index)
  }
  for (let index = 0; selected.size < cap && index < sorted.length; index += 1) selected.add(index)
  return [...selected].sort((a, b) => a - b).slice(0, cap).map((index) => sorted[index])
}
