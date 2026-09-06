import { __mixdogMemoryLog } from './memory-log.mjs'
import { embedText } from './embedding-provider.mjs'
import { searchRelevantHybrid } from './memory-recall-store.mjs'
import { throwIfAborted } from './memory-cycle2-shared.mjs'

export const CYCLE3_RELATED_PER_CORE = 6
export const CYCLE3_RELATED_PER_CORE_MAX = 8
const CYCLE3_SCOPE_CANDIDATE_MULTIPLIER = 3

function projectScope(row) {
  return row?.project_id == null ? null : String(row.project_id)
}

function formatRelatedRow(row) {
  const tag = row.project_id ? row.project_id : 'COMMON'
  const stat = row.status ? `[${row.status}]` : '[?]'
  const el = row.element ? `el:${row.element} ` : ''
  const sm = String(row.summary || row.content || '').replace(/\s+/g, ' ').slice(0, 160)
  return `    - id:${row.id} ${stat} ${tag} ${row.category ?? '?'} ${el}sm:${sm}`
}

export function formatCoreBlock(core, related, scopeEvidence) {
  const tag = core.project_id ? core.project_id : 'COMMON'
  const head = `## CORE id:${core.id} ${tag} ${core.category}`
  const el = `  element: ${core.element}`
  const sm = `  summary: ${String(core.summary || '').replace(/\s+/g, ' ')}`
  const rel = related && related.length
    ? `  related current memory in its current scope (top ${related.length}):\n` + related.map(formatRelatedRow).join('\n')
    : `  related current memory in its current scope: (none found)`
  const cross = scopeEvidence && scopeEvidence.length
    ? `  scope evidence from other pools (top ${scopeEvidence.length}):\n` + scopeEvidence.map(formatRelatedRow).join('\n')
    : `  scope evidence from other pools: (none found)`
  return [head, el, sm, rel, cross].join('\n')
}

async function recall(db, queryText, projectScopeValue, limit, queryVector, {
  search,
  signal,
  log,
  coreId,
  label,
}) {
  if (limit <= 0) return []
  try {
    const rows = await search(db, queryText, {
      limit,
      projectScope: projectScopeValue,
      includeMembers: false,
      queryVector: Array.isArray(queryVector) ? queryVector : undefined,
    })
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    log(`[cycle3] ${label} recall failed for core id=${coreId}: ${err.message}\n`)
    return []
  }
}

export async function collectCycle3ReviewEvidence(db, cores, options = {}) {
  const {
    signal,
    relatedLimit = CYCLE3_RELATED_PER_CORE,
    embed = embedText,
    search = searchRelevantHybrid,
    log = __mixdogMemoryLog,
  } = options
  const blocks = []
  const knownPools = new Set(
    cores.map(core => projectScope(core)).filter(scope => scope != null),
  )
  const scopeCandidateLimit = Math.min(
    CYCLE3_RELATED_PER_CORE_MAX * CYCLE3_SCOPE_CANDIDATE_MULTIPLIER,
    Math.max(0, relatedLimit * CYCLE3_SCOPE_CANDIDATE_MULTIPLIER),
  )

  for (const core of cores) {
    throwIfAborted(signal)
    const queryText = `${core.element}\n${String(core.summary || '')}`.trim()
    let queryVector = null
    try {
      queryVector = await embed(queryText, { inputType: 'query' })
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      log(`[cycle3] embedding failed for core id=${core.id}: ${err.message}\n`)
    }

    const currentScope = projectScope(core)
    const related = await recall(
      db,
      queryText,
      currentScope ?? 'common',
      relatedLimit,
      queryVector,
      { search, signal, log, coreId: core.id, label: 'current-scope' },
    )
    const allScopeCandidates = await recall(
      db,
      queryText,
      'all',
      scopeCandidateLimit,
      queryVector,
      { search, signal, log, coreId: core.id, label: 'cross-scope' },
    )
    const scopeEvidence = allScopeCandidates
      .filter(row => projectScope(row) !== currentScope)
      .slice(0, relatedLimit)
    for (const row of scopeEvidence) {
      const pool = projectScope(row)
      if (pool != null) knownPools.add(pool)
    }

    throwIfAborted(signal)
    blocks.push(formatCoreBlock(core, related, scopeEvidence))
  }

  return { coreReview: blocks.join('\n\n'), knownPools }
}
