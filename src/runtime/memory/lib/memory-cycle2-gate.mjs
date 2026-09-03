// Unified-gate cluster extracted from memory-cycle2.mjs: prompt formatting,
// pipe-verdict parsing/validation, the rules-digest cache, the single LLM
// gate pass (runUnifiedGate) and the Sonnet re-judge cascade. Facade
// (memory-cycle2.mjs) re-exports the public members unchanged.
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import { listCore } from './core-memory-store.mjs'
import { __mixdogMemoryLog, throwIfAborted, resourceDir, createSemaphore } from './memory-cycle2-shared.mjs'
import { readPromptSurfaceFile, renderPromptSurfaceDigest } from './prompt-surface-file.mjs'

export const CYCLE2_ACTIVE_TARGET_CAP = 100
const CYCLE2_PACKET_MATERIAL_CAP = 50
const CYCLE2_MAX_PACKETS = 4
const CYCLE2_PACKET_CONCURRENCY = 4
const CYCLE2_LINEAGE_PER_ROW = 6
const CYCLE2_LINEAGE_QUERY_BATCH = 8
const CYCLE2_PROMPT_MAX_BYTES = 160_000

// Default active-row floor for cycle2. It is zero so rolling active rechecks
// always run; protection from archive verdicts is opt-in via
// config.active_floor.
export const CYCLE2_ACTIVE_MIN_FLOOR = 0

// Status-based verb whitelist. 3-tier policy: pending → active/archived,
// active → active/archived/update/merge.
const STATUS_ALLOWED_VERBS = {
  pending: new Set(['active', 'archived']),
  active:  new Set(['active', 'archived', 'update', 'merge']),
  archived: new Set(['archived']),
}
const NON_ARCHIVE_VERBS = new Set(['active', 'update', 'merge'])
const AUXILIARY_ACTIONS = new Set(['core', 'lineage', 'lineage_none'])
// Union of every primary (status) verb across all statuses, plus the two
// non-verb line kinds. Used by the stray-index shift guard to decide whether
// a `idx|id|verb` line had a leading row index prepended by the LLM.
const ALL_PRIMARY_VERBS = new Set(['active', 'archived', 'update', 'merge'])
const isShiftFollowToken = (tok) => {
  const v = String(tok ?? '').trim().toLowerCase()
  return ALL_PRIMARY_VERBS.has(v) || v === 'why' || v === 'core' || v === 'lineage'
}

async function invokeLlm(prompt, mode, preset, timeout, llmCall = callAgentDispatch, signal = null) {
  return await llmCall({
    agent: 'cycle2-agent',
    taskType: 'maintenance',
    mode,
    preset,
    timeout,
    cwd: null,
    signal,
  }, prompt)
}

function buildPidMap(rowSets) {
  const pids = [...new Set(rowSets.flat().map(r => r.project_id).filter(Boolean))].sort()
  return new Map(pids.map((p, i) => [p, `P${i + 1}`]))
}

function formatEntriesForPromotePrompt(rows, pidMap, opts = {}) {
  if (!rows || rows.length === 0) return '(none)'
  const map = pidMap ?? buildPidMap([rows])
  // When numbered, prefix each row with its 1-based prompt-order ordinal so the
  // gate LLM can echo a row number it can see, instead of inventing one. The
  // ordinal domain (1..N) vs batch ids that share those integers on a *different*
  // row — see batchOrdinalIdCollides in runUnifiedGate.
  const numbered = opts.numbered === true
  const lines = rows.map((r, i) => {
    const tag = r.project_id ? (map.get(r.project_id) ?? 'C') : 'C'
    const stat = r.status ? `[${r.status}]` : '[?]'
    const prefix = numbered ? `${i + 1}. ` : '- '
    return `${prefix}id:${r.id} ${stat} ${tag} ${r.category} s:${r.score ?? 'n'} el:${r.element} sm:${String(r.summary || '').slice(0, 100)}`
  })
  if (map.size === 0) return lines.join('\n')
  const legend = [...map.entries()].map(([p, t]) => `${t}=${p}`).concat('C=COMMON').join(', ')
  return `# pid: ${legend}\n` + lines.join('\n')
}

// User-curated rows from core_entries — id-less, no status, no score; the
// LLM only needs element + summary + project tag to detect overlap with
// candidate entries below. Format kept terse so the prompt budget stays small.
function formatUserCoreForPrompt(rows, pidMap) {
  if (!rows || rows.length === 0) return '(none)'
  const map = pidMap ?? new Map()
  return rows.map(r => {
    const tag = r.project_id ? (map.get(r.project_id) ?? 'C') : 'C'
    const sm = String(r.summary || '').slice(0, 200)
    return `- ${tag} ${r.category}: ${r.element}${sm && sm !== r.element ? ` — ${sm}` : ''}`
  }).join('\n')
}

async function loadLineageCandidates(db, rows, options = {}) {
  const ids = rows.map(r => Number(r.id)).filter(Number.isFinite)
  if (ids.length === 0) return new Map()
  const out = new Map()
  const perRowLimit = Math.min(
    CYCLE2_LINEAGE_PER_ROW,
    Math.max(1, Number(options.perRowLimit) || CYCLE2_LINEAGE_PER_ROW),
  )
  const queryBatchSize = Math.min(
    CYCLE2_LINEAGE_QUERY_BATCH,
    Math.max(1, Number(options.queryBatchSize) || CYCLE2_LINEAGE_QUERY_BATCH),
  )
  for (let offset = 0; offset < ids.length; offset += queryBatchSize) {
    const batchIds = ids.slice(offset, offset + queryBatchSize)
    const result = await db.query(`
      SELECT newer.id AS newer_id,
             older.id AS older_id,
             older.ts AS older_ts,
             older.element AS older_element,
             older.summary AS older_summary,
             older.concept_id AS older_concept_id,
             older.sim,
             older.lex,
             older.source
      FROM entries newer
      CROSS JOIN LATERAL (
        WITH lexical_query AS (
          SELECT to_tsquery('simple', string_agg(quote_literal(term), ' | ')) AS query
          FROM (
            SELECT term
            FROM unnest(tsvector_to_array(newer.search_tsv)) AS term
            WHERE length(term) >= 3
            ORDER BY length(term) DESC, term
            LIMIT 24
          ) terms
        ), candidates AS (
          (
            SELECT prior.id, prior.ts, prior.element, prior.summary, prior.concept_id,
                   1 - (newer.embedding <=> prior.embedding)::float8 AS sim,
                   0::float8 AS lex,
                   'dense'::text AS source
            FROM entries prior
            WHERE prior.is_root = 1
              AND prior.embedding IS NOT NULL
              AND prior.id != newer.id
              AND (prior.ts < newer.ts OR (prior.ts = newer.ts AND prior.id < newer.id))
              AND prior.project_id IS NOT DISTINCT FROM newer.project_id
            ORDER BY prior.embedding <=> newer.embedding
            LIMIT 8
          )
          UNION ALL
          (
            SELECT prior.id, prior.ts, prior.element, prior.summary, prior.concept_id,
                   CASE WHEN prior.embedding IS NULL THEN 0
                        ELSE 1 - (newer.embedding <=> prior.embedding)::float8 END AS sim,
                   ts_rank_cd(prior.search_tsv, lexical_query.query)::float8 AS lex,
                   'lexical'::text AS source
            FROM entries prior
            CROSS JOIN lexical_query
            WHERE lexical_query.query IS NOT NULL
              AND prior.is_root = 1
              AND prior.id != newer.id
              AND (prior.ts < newer.ts OR (prior.ts = newer.ts AND prior.id < newer.id))
              AND prior.project_id IS NOT DISTINCT FROM newer.project_id
              AND prior.search_tsv @@ lexical_query.query
            ORDER BY lex DESC, prior.ts DESC, prior.id DESC
            LIMIT 12
          )
        )
        SELECT *
        FROM (
          SELECT DISTINCT ON (id)
                 id, ts, element, summary, concept_id, sim, lex, source
          FROM candidates
          WHERE sim >= 0.55 OR lex > 0
          ORDER BY id, lex DESC, sim DESC
        ) deduped
        ORDER BY lex DESC, sim DESC, ts DESC
        LIMIT $2
      ) older
      WHERE newer.id = ANY($1::bigint[])
        AND newer.embedding IS NOT NULL
      ORDER BY newer.id, older.lex DESC, older.sim DESC, older.ts DESC
    `, [batchIds, perRowLimit])
    for (const row of result.rows ?? []) {
      const id = Number(row.newer_id)
      if (!out.has(id)) out.set(id, [])
      out.get(id).push(row)
    }
  }
  return out
}

export function packUnifiedGatePackets(rows, candidates, options = {}) {
  const materialCap = Math.min(
    CYCLE2_PACKET_MATERIAL_CAP,
    Math.max(1, Number(options.materialCap) || CYCLE2_PACKET_MATERIAL_CAP),
  )
  const maxPackets = Math.min(
    CYCLE2_MAX_PACKETS,
    Math.max(1, Number(options.maxPackets) || CYCLE2_MAX_PACKETS),
  )
  const packets = []
  const deferredIds = []
  let current = null
  for (const row of rows ?? []) {
    const id = Number(row.id)
    const prior = (candidates.get(id) ?? []).slice(0, Math.max(0, materialCap - 1))
    const weight = 1 + prior.length
    if (!current || current.materialCount + weight > materialCap) {
      if (packets.length >= maxPackets) {
        deferredIds.push(id)
        continue
      }
      current = { rows: [], candidates: new Map(), materialCount: 0 }
      packets.push(current)
    }
    current.rows.push(row)
    if (prior.length > 0) current.candidates.set(id, prior)
    current.materialCount += weight
  }
  return { packets, deferredIds }
}

function formatLineageCandidates(rows, candidates) {
  const lines = []
  rows.forEach((row, index) => {
    const prior = candidates.get(Number(row.id)) ?? []
    if (prior.length === 0) return
    lines.push(`row:${index + 1} id:${row.id}`)
    for (const item of prior) {
      lines.push(`- older_id:${item.older_id} ts:${item.older_ts} source:${item.source} sim:${Number(item.sim).toFixed(3)} lex:${Number(item.lex).toFixed(3)} concept:${item.older_concept_id ?? '-'} el:${String(item.older_element ?? '').slice(0, 100)} sm:${String(item.older_summary ?? '').slice(0, 180)}`)
    }
  })
  return lines.length > 0 ? lines.join('\n') : '(none)'
}

// Parse pipe-format unified verdicts. Each line: <id>|<verb> [|...].
// Verbs validated against the row's current status via STATUS_ALLOWED_VERBS.
// Returns { actions, rejected } or null when no parseable lines.
// True when some entry id K in 1..N is also the row-ordinal label for a different
// entry (token K is ambiguous between id K and "row K").
function batchOrdinalIdCollides(statusById, ordinalToId, rowCount) {
  const n = Math.max(0, Number(rowCount) || 0)
  for (let k = 1; k <= n; k++) {
    if (!statusById.has(k)) continue
    if (ordinalToId.get(k) !== k) return k
  }
  return null
}

function parseUnifiedFormat(raw, statusById, ordinalToId = null, lineageCandidates = new Map()) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return { actions: [], rejected: new Set() }
  const lines = text.split('\n')
  const actions = []
  const rejected = new Set()
  const support = new Map()
  let sawValid = false
  // Resolve a first-field/merge token to a real batch id. The gate may echo
  // either the exact batch id OR the 1-based row ordinal shown in the numbered
  // Entries block. When batchOrdinalIdCollides is false, an exact-id hit wins
  // and an unmatched value falls back to ordinal lookup; anything else is NaN.
  const resolveId = (tok) => {
    const n = Number(String(tok ?? '').trim())
    if (!Number.isFinite(n)) return NaN
    if (statusById.has(n)) return n
    if (ordinalToId && ordinalToId.has(n)) return ordinalToId.get(n)
    return NaN
  }
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('//') || line.startsWith('#')) continue
    if (line.startsWith('```')) continue
    const parts = line.split('|')
    if (parts.length < 2) continue
    // LLM sometimes prefixes a row index, emitting `idx|id|verdict` instead of
    // `id|verdict`; parts[0] (the index) is a stray token and the line must be
    // shifted before parsing. Strict invariant so a real 2-field `id|verdict`
    // is never shifted into a 1-field line (which would throw on parts[1]):
    //   parts.length >= 3 AND parts[1] is a known batch id AND parts[2] is a
    //   valid primary verb / why / core (the shifted verdict slot).
    // Trigger when EITHER parts[0] is not a known id (classic stray index) OR
    // parts[0] IS known but parts[1] is not itself a valid verb — that covers
    // `1|1|active`, where the stray index collides with a real batch id and the
    // un-shifted reading would verb-reject the wrong row.
    if (
      parts.length >= 3 &&
      statusById.has(Number(parts[1].trim())) &&
      isShiftFollowToken(parts[2]) &&
      (!statusById.has(Number(parts[0].trim())) || !isShiftFollowToken(parts[1]))
    ) {
      parts.shift()
    }
    const entryId = resolveId(parts[0])
    const action = parts[1].trim().toLowerCase()
    if (!Number.isFinite(entryId) || !action) continue
    const status = statusById.get(entryId)
    if (!status) continue
    // Only mark as parse-ok when the id is known to the batch; a response
    // composed entirely of unknown ids would otherwise return parse-ok with
    // zero actions/rejections, leaving the rows un-reviewed and re-queued.
    sawValid = true
    if (action === 'core') {
      actions.push({ entry_id: entryId, action: 'core', core_summary: parts.slice(2).join('|').trim() })
      continue
    }
    if (action === 'lineage') {
      const predecessorToken = String(parts[2] ?? '').trim()
      if (predecessorToken.toLowerCase() === 'none') {
        actions.push({ entry_id: entryId, action: 'lineage_none' })
        continue
      }
      const allowed = new Set((lineageCandidates.get(entryId) ?? []).map(row => Number(row.older_id)))
      const predecessorIds = [...new Set(predecessorToken
        .split(',')
        .map(value => Number(value.trim()))
        .filter(id => Number.isFinite(id) && allowed.has(id)))]
      if (predecessorIds.length > 0) {
        actions.push({ entry_id: entryId, action: 'lineage', predecessor_ids: predecessorIds })
      } else {
        __mixdogMemoryLog(`[cycle2] lineage rejected: id=${entryId} predecessor=${parts[2] ?? ''}\n`)
      }
      continue
    }
    if (action === 'why') {
      const kind = (parts[2] ?? '').trim().toUpperCase()
      const reason = parts.slice(3).join('|').replace(/\s+/g, ' ').trim().slice(0, 240)
      if ((kind === 'A' || kind === 'B') && reason) {
        support.set(entryId, { kind, reason })
      }
      continue
    }
    const allowed = STATUS_ALLOWED_VERBS[status]
    if (!allowed || !allowed.has(action)) {
      __mixdogMemoryLog(`[cycle2] verb rejected: id=${entryId} status=${status} verb=${action}\n`)
      rejected.add(entryId)
      continue
    }
    if (action === 'update') {
      actions.push({
        entry_id: entryId, action,
        element: (parts[2] ?? '').trim(),
        summary: parts.slice(3).join('|').trim(),
      })
    } else if (action === 'merge') {
      const targetId = resolveId(parts[2])
      const sourceIds = [...new Set((parts[3] ?? '').split(',').map(s => resolveId(s)).filter(Number.isFinite))]
      if (!Number.isFinite(targetId) || sourceIds.length === 0) {
        __mixdogMemoryLog(`[cycle2] merge rejected: id=${entryId} invalid target/sources\n`)
        rejected.add(entryId)
        continue
      }
      if (targetId !== entryId && !sourceIds.includes(entryId)) {
        __mixdogMemoryLog(
          `[cycle2] merge rejected: id=${entryId} must be target or listed source (target=${targetId} sources=${sourceIds.join(',')})\n`,
        )
        rejected.add(entryId)
        continue
      }
      actions.push({
        entry_id: entryId, action,
        target_id: targetId,
        source_ids: sourceIds,
        element: (parts[4] ?? '').trim(),
        summary: parts.slice(5).join('|').trim(),
      })
    } else {
      actions.push({ entry_id: entryId, action })
    }
  }
  if (!sawValid && rejected.size === 0) return null
  return { actions, rejected, support }
}

// ─── Current rules digest cache ──────────────────────────────────────────────

let _currentRulesDigest = null
let _currentRulesDigestTs = 0
let _currentRulesDigestDataDir = null
// Per-call cap: cycle2 pays for the digest on every packet of every hourly
// pass, so it takes a tighter slice than the once-a-day cycle3 review.
const RULES_DIGEST_DEFAULT_CHARS = 48_000
const RULES_DIGEST_MAX_CHARS = 160_000
function capDigest(text, maxChars) {
  const cap = Math.min(RULES_DIGEST_MAX_CHARS, Math.max(4_000, Number(maxChars) || RULES_DIGEST_DEFAULT_CHARS))
  return text.length > cap ? text.slice(0, cap) + '\n…[truncated]' : text
}
export function loadCurrentRulesDigest(dataDir = null, { maxChars } = {}) {
  const now = Date.now()
  if (_currentRulesDigest && _currentRulesDigestDataDir === (dataDir ?? null)
      && now - _currentRulesDigestTs < 60_000) return capDigest(_currentRulesDigest, maxChars)
  const parts = []
  // Preferred authority: the prompt-surface snapshot the session runtime
  // writes from the exact blocks a live Lead session receives (rules, skill
  // catalog, workflow, role rules, AND every tool description). Rule files
  // below remain as fallback / supplement for cycles that run before any
  // session has started.
  if (dataDir) {
    const surface = readPromptSurfaceFile(dataDir)
    const rendered = renderPromptSurfaceDigest(surface)
    if (rendered) parts.push(rendered)
  }
  // Collect every rule file that loads into live sessions (lead + shared).
  // Discovered dynamically so rule-layout refactors can't silently empty the
  // digest again (the old hardcoded shared/* list rotted to one file and the
  // dedup gate compared against nothing).
  const sources = []
  for (const dir of ['lead', 'shared']) {
    const base = join(resourceDir(), 'rules', dir)
    try {
      if (!existsSync(base)) continue
      for (const f of readdirSync(base).sort()) {
        if (f.endsWith('.md')) sources.push(join(base, f))
      }
    } catch {}
  }
  const workflows = join(resourceDir(), 'workflows')
  try {
    if (existsSync(workflows)) {
      for (const dir of readdirSync(workflows).sort()) {
        const workflow = join(workflows, dir, 'WORKFLOW.md')
        if (existsSync(workflow)) sources.push(workflow)
      }
    }
  } catch {}
  for (const p of sources) {
    try {
      if (!existsSync(p)) continue
      const txt = readFileSync(p, 'utf8').trim()
      if (txt) parts.push(`# Source: ${p}\n${txt}`)
    } catch {}
  }
  // The live surface sits first so truncation only ever trims fallback files.
  _currentRulesDigest = parts.join('\n\n---\n\n')
  _currentRulesDigestTs = now
  _currentRulesDigestDataDir = dataDir ?? null
  return capDigest(_currentRulesDigest, maxChars)
}

function uniqueIds(values) {
  return [...new Set(values
    .map(id => Number(id))
    .filter(id => Number.isFinite(id)))]
}

function validateUnifiedGate(parsed, statusById, lineageCandidates = new Map()) {
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : []
  const primary = actions.filter(a => !AUXILIARY_ACTIONS.has(a?.action))
  const verdictCounts = new Map()
  for (const action of primary) {
    const id = Number(action?.entry_id)
    if (!Number.isFinite(id)) continue
    verdictCounts.set(id, (verdictCounts.get(id) || 0) + 1)
  }
  const expectedIds = [...statusById.keys()]
  const missingVerdictIds = expectedIds.filter(id => !verdictCounts.has(id))
  const duplicateVerdictIds = [...verdictCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
  const support = parsed?.support instanceof Map ? parsed.support : new Map()
  const coreIds = new Set(actions
    .filter(a => a?.action === 'core')
    .map(a => Number(a.entry_id))
    .filter(id => Number.isFinite(id)))
  const missingSupportIds = []
  const missingCoreIds = []
  const lineageDecisionCounts = new Map()
  for (const action of actions) {
    if (action?.action !== 'lineage' && action?.action !== 'lineage_none') continue
    const id = Number(action.entry_id)
    if (!Number.isFinite(id)) continue
    lineageDecisionCounts.set(id, (lineageDecisionCounts.get(id) || 0) + 1)
  }
  const lineageExpectedIds = [...lineageCandidates.keys()]
  const missingLineageIds = lineageExpectedIds.filter(id => !lineageDecisionCounts.has(Number(id)))
  const duplicateLineageIds = [...lineageDecisionCounts.entries()]
    .filter(([id, count]) => lineageCandidates.has(id) && count > 1)
    .map(([id]) => id)
  for (const action of primary) {
    if (!NON_ARCHIVE_VERBS.has(action?.action)) continue
    const id = Number(action.entry_id)
    if (!Number.isFinite(id)) continue
    const coreId = action.action === 'merge' && Number.isFinite(Number(action.target_id))
      ? Number(action.target_id)
      : id
    const hasSupport = support.has(id) || (action.action === 'merge' && support.has(coreId))
    if (!hasSupport) missingSupportIds.push(id)
    if (!coreIds.has(coreId)) missingCoreIds.push(id)
  }
  return {
    missingVerdictIds: uniqueIds(missingVerdictIds),
    duplicateVerdictIds: uniqueIds(duplicateVerdictIds),
    missingSupportIds: uniqueIds(missingSupportIds),
    missingCoreIds: uniqueIds(missingCoreIds),
    missingLineageIds: uniqueIds(missingLineageIds),
    duplicateLineageIds: uniqueIds(duplicateLineageIds),
  }
}

function gateQualitySummary(quality) {
  const parts = []
  if (quality?.missingVerdictIds?.length) parts.push(`missing verdict ids=${quality.missingVerdictIds.join(',')}`)
  if (quality?.duplicateVerdictIds?.length) parts.push(`duplicate verdict ids=${quality.duplicateVerdictIds.join(',')}`)
  if (quality?.missingSupportIds?.length) parts.push(`missing why ids=${quality.missingSupportIds.join(',')}`)
  if (quality?.missingCoreIds?.length) parts.push(`missing core ids=${quality.missingCoreIds.join(',')}`)
  if (quality?.missingLineageIds?.length) parts.push(`missing lineage ids=${quality.missingLineageIds.join(',')}`)
  if (quality?.duplicateLineageIds?.length) parts.push(`duplicate lineage ids=${quality.duplicateLineageIds.join(',')}`)
  return parts.join('; ')
}

function stripUnsupportedPromotions(parsed, unsupportedIds) {
  const ids = new Set(uniqueIds(unsupportedIds))
  if (ids.size === 0) return parsed
  const rejected = new Set(parsed?.rejected || [])
  for (const id of ids) rejected.add(id)
  const actions = (parsed?.actions || []).filter(a => {
    if (AUXILIARY_ACTIONS.has(a?.action)) return true
    return !ids.has(Number(a?.entry_id))
  })
  return { ...parsed, actions, rejected }
}

function requiredCoreIdForAction(action) {
  if (action?.action === 'merge' && Number.isFinite(Number(action.target_id))) {
    return Number(action.target_id)
  }
  return Number(action?.entry_id)
}

// ─── Unified gate ────────────────────────────────────────────────────────────

// Single ephemeral LLM pass over one bounded packet.
// Returns { actions, rejected, parseOk } following parseUnifiedFormat shape.
async function runUnifiedGatePacket(db, rows, activeContext, config = {}, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (!rows || rows.length === 0) return { actions: [], rejected: new Set(), parseOk: true }
  const template = options.template
  const userCoreRows = options.userCoreRows ?? []
  const lineageCandidates = options.lineageCandidates ?? new Map()
  throwIfAborted(signal)
  const sharedPidMap = buildPidMap([activeContext ?? [], rows ?? [], userCoreRows ?? []])
  const rulesDigest = options.rulesDigest || '(no current rules digest available)'
  const activeCount = activeContext?.length ?? 0
  const activeCap = options.activeCap ?? CYCLE2_ACTIVE_TARGET_CAP

  const prompt = template
    .replace('{{CURRENT_RULES}}', rulesDigest)
    .replace('{{USER_CORE}}', formatUserCoreForPrompt(userCoreRows, sharedPidMap))
    .replace('{{CORE_MEMORY}}', formatEntriesForPromotePrompt(activeContext, sharedPidMap))
    .replace('{{ITEMS}}', formatEntriesForPromotePrompt(rows, sharedPidMap, { numbered: true }))
    .replace('{{LINEAGE_CANDIDATES}}', formatLineageCandidates(rows, lineageCandidates))
    .replace('{{ACTIVE_COUNT}}', String(activeCount))
    .replace('{{ACTIVE_CAP}}', String(activeCap))

  const promptBytes = Buffer.byteLength(prompt, 'utf8')
  const promptMaxBytes = Math.max(20_000, Number(options.promptMaxBytes) || CYCLE2_PROMPT_MAX_BYTES)
  const packetLabel = Number(options.packetIndex ?? 0) + 1
  if (promptBytes > promptMaxBytes) {
    __mixdogMemoryLog(`[cycle2] packet=${packetLabel} prompt budget exceeded bytes=${promptBytes} max=${promptMaxBytes}\n`)
    return { actions: null, rejected: new Set(), parseOk: false, error: 'prompt_budget_exceeded' }
  }

  const preset = options.preset || resolveMaintenancePreset('memory')
  const timeout = Number(config?.cycle2?.timeout ?? 600000)
  const mode = 'cycle2-unified'

  const previewRaw = (raw) => String(raw ?? '').replace(/\s+/g, ' ').slice(0, 200)
  const callOnce = async (extraTag) => {
    throwIfAborted(signal)
    const p = extraTag ? `${prompt}\n\n[retry:${extraTag}]` : prompt
    const raw = await invokeLlm(p, mode, preset, timeout, options.callLlm, signal)
    throwIfAborted(signal)
    return raw
  }

  const statusById = new Map(rows.map(r => [Number(r.id), String(r.status)]))
  // Ordinal → batch-id map, keyed by 1-based prompt order (the same order the
  // numbered Entries block uses). The gate may echo either the real batch id
  // or the row ordinal 1..N; the parser resolves both when no integer token is
  // ambiguous (id K present in batch but row K points at a different entry).
  // On collision, DISABLE ordinal fallback (exact ids only) instead of
  // skipping: a skipped batch is re-selected with the same rows next run and
  // collides again — a permanent stall (observed: same "batch id 3 collides"
  // skip every cycle while cycle2_pending climbed past 500).
  let ordinalToId = new Map(rows.map((r, i) => [i + 1, Number(r.id)]))
  const collideToken = batchOrdinalIdCollides(statusById, ordinalToId, rows.length)
  if (collideToken != null) {
    __mixdogMemoryLog(`[cycle2] batch id ${collideToken} collides with row ordinal ${collideToken} (id ${ordinalToId.get(collideToken)}) — ordinal fallback disabled, exact ids only\n`)
    ordinalToId = null
  }

  __mixdogMemoryLog(`[cycle2-diag] packet=${packetLabel} prompt=${promptBytes} bytes; rows=${rows.length}\n`)

  let raw
  try {
    raw = await callOnce(null)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] unified LLM error: ${err.message}\n`)
    return { actions: null, rejected: new Set(), parseOk: false }
  }
  throwIfAborted(signal)
  __mixdogMemoryLog(`[cycle2-diag] unified raw (first 1500): ${String(raw ?? '').replace(/\n/g, '⏎').slice(0, 1500)}\n`)

  let parsed = parseUnifiedFormat(raw, statusById, ordinalToId, lineageCandidates)
  let quality = parsed ? validateUnifiedGate(parsed, statusById, lineageCandidates) : null
  const qualityIssue = () => gateQualitySummary(quality)
  if (!parsed || qualityIssue()) {
    throwIfAborted(signal)
    const issue = parsed ? qualityIssue() : `unparseable (${previewRaw(raw)})`
    __mixdogMemoryLog(`[cycle2] unified quality retry: ${issue}\n`)
    // Preserve the first pass before retrying. A retry fired for a mere quality
    // issue (e.g. a few missing verdicts) must not throw away an otherwise-valid
    // first-pass parse if the retry comes back unparseable.
    const firstParsed = parsed
    const firstQuality = quality
    try {
      const retryTag = parsed
        ? 'complete-verdicts-with-why-and-core-lines'
        : 'first-field-must-be-the-listed-row-number'
      const raw2 = await callOnce(retryTag)
      const retryParsed = parseUnifiedFormat(raw2, statusById, ordinalToId, lineageCandidates)
      if (retryParsed) {
        parsed = retryParsed
        quality = validateUnifiedGate(retryParsed, statusById, lineageCandidates)
      } else if (firstParsed) {
        __mixdogMemoryLog(`[cycle2] unparseable after retry — falling back to first-pass parse (${previewRaw(raw2)})\n`)
        parsed = firstParsed
        quality = firstQuality
      } else {
        __mixdogMemoryLog(`[cycle2] unparseable after retry — skipping batch (${previewRaw(raw2)})\n`)
        return { actions: null, rejected: new Set(), parseOk: false }
      }
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      if (firstParsed) {
        __mixdogMemoryLog(`[cycle2] retry LLM error: ${err.message} — falling back to first-pass parse\n`)
        parsed = firstParsed
        quality = firstQuality
      } else {
        __mixdogMemoryLog(`[cycle2] retry LLM error: ${err.message}\n`)
        return { actions: null, rejected: new Set(), parseOk: false }
      }
    }
  }
  const finalIssue = gateQualitySummary(quality)
  // duplicateVerdictIds are genuinely ambiguous (the same row got two conflicting
  // verbs) — keep the full-skip. missingVerdictIds, by contrast, used to skip the
  // WHOLE batch, so a handful of persistently-missing poison rows could livelock
  // the gate. Partial-apply instead: keep the valid verdicts we did receive, just
  // log the missing ids and leave those rows for a later run.
  if (quality?.duplicateVerdictIds?.length || quality?.duplicateLineageIds?.length) {
    __mixdogMemoryLog(`[cycle2] duplicate verdict coverage after retry — skipping batch (${finalIssue})\n`)
    return { actions: null, rejected: new Set(), parseOk: false }
  }
  if (quality?.missingVerdictIds?.length) {
    __mixdogMemoryLog(`[cycle2] missing verdicts after retry — partial apply, leaving ids=${quality.missingVerdictIds.join(',')} for a later run (${finalIssue})\n`)
  }
  // A response made up solely of why/core lines parses "ok" yet carries zero
  // primary (status-verb) verdicts. Without this guard parseOk stays true and
  // the caller treats the batch as a clean no-op, masking the coverage failure
  // and marking the rows reviewed. Fail the parse so the rows are re-queued.
  const primaryCount = (parsed.actions || []).filter(a => !AUXILIARY_ACTIONS.has(a?.action)).length
  if (rows.length > 0 && primaryCount === 0) {
    __mixdogMemoryLog(`[cycle2] gate produced zero primary verdicts for ${rows.length} rows — failing parse\n`)
    return { actions: null, rejected: new Set(), parseOk: false, missingIds: [...statusById.keys()] }
  }
  const incompletePromotionIds = uniqueIds([
    ...(quality?.missingSupportIds || []),
    ...(quality?.missingCoreIds || []),
  ])
  if (incompletePromotionIds.length > 0) {
    __mixdogMemoryLog(`[cycle2] incomplete non-archive verdicts rejected after retry ids=${incompletePromotionIds.join(',')} (${finalIssue})\n`)
    parsed = stripUnsupportedPromotions(parsed, incompletePromotionIds)
  }
  return {
    actions: parsed.actions,
    rejected: parsed.rejected,
    parseOk: true,
    missingIds: quality?.missingVerdictIds || [],
    lineageCandidateIds: [...lineageCandidates.keys()],
  }
}

// A cycle selects candidate roots once, then packs each root together with its
// lineage material into at most four isolated, disposable agent calls.
export async function runUnifiedGate(db, rows, activeContext, config = {}, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (!rows || rows.length === 0) return { actions: [], rejected: new Set(), parseOk: true }
  const promptPath = join(resourceDir(), 'defaults', 'memory-promote-prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`runCycle2: prompt file missing at ${promptPath}`)
  }
  const template = readFileSync(promptPath, 'utf8')
  const userCoreRows = options.dataDir ? await listCore(options.dataDir, '*').catch(() => []) : []
  const rulesDigest = loadCurrentRulesDigest(options.dataDir ?? null) || '(no current rules digest available)'
  const lineageCandidates = await loadLineageCandidates(db, rows, {
    perRowLimit: config?.lineage_per_row,
    queryBatchSize: config?.lineage_query_batch,
  })
  throwIfAborted(signal)
  const { packets, deferredIds } = packUnifiedGatePackets(rows, lineageCandidates, {
    materialCap: config?.packet_material_cap,
    maxPackets: config?.max_packets,
  })
  const concurrency = Math.min(
    CYCLE2_PACKET_CONCURRENCY,
    Math.max(1, Number(config?.agent_concurrency ?? config?.concurrency) || CYCLE2_PACKET_CONCURRENCY),
  )
  const promptMaxBytes = Math.max(20_000, Number(config?.prompt_max_bytes) || CYCLE2_PROMPT_MAX_BYTES)
  const sem = createSemaphore(Math.min(Math.max(1, packets.length), concurrency))
  const settled = await Promise.allSettled(packets.map((packet, packetIndex) => sem(() =>
    runUnifiedGatePacket(db, packet.rows, activeContext, config, {
      ...options,
      template,
      userCoreRows,
      rulesDigest,
      lineageCandidates: packet.candidates,
      promptMaxBytes,
      packetIndex,
    })
  )))
  const rejectedRun = settled.find(item => item.status === 'rejected')
  if (rejectedRun) throw rejectedRun.reason

  const actions = []
  const rejected = new Set()
  const missingIds = []
  const failedIds = []
  const lineageCandidateIds = []
  let parseOk = true
  settled.forEach((item, packetIndex) => {
    const result = item.value
    const packet = packets[packetIndex]
    if (result.parseOk === false) {
      parseOk = false
      failedIds.push(...packet.rows.map(row => Number(row.id)).filter(Number.isFinite))
      return
    }
    actions.push(...(result.actions ?? []))
    for (const id of result.rejected ?? []) rejected.add(id)
    missingIds.push(...(result.missingIds ?? []))
    lineageCandidateIds.push(...(result.lineageCandidateIds ?? []))
  })
  if (deferredIds.length > 0) {
    __mixdogMemoryLog(`[cycle2] deferred roots=${deferredIds.length} after packet cap=${packets.length}\n`)
  }
  return {
    actions,
    rejected,
    parseOk,
    missingIds: uniqueIds(missingIds),
    failedIds: uniqueIds(failedIds),
    deferredIds: uniqueIds(deferredIds),
    lineageCandidateIds: uniqueIds(lineageCandidateIds),
    packets: packets.length,
  }
}

// ─── Sonnet cascade ──────────────────────────────────────────────────────────

// Sonnet re-judge over first-pass keep verdicts. Sonnet sees rules + summary
// and returns binary keep/drop. Failures fail-open (preserve first-pass).
export async function sonnetCascade(candidates, rulesDigest, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (!candidates || candidates.length === 0) return new Map()
  const lines = candidates.map(c =>
    `id:${c.id} status:${c.status} verb:${c.verb} cat:${c.category} el:${c.element} sm:${String(c.summary || '').slice(0, 200)}${c.core ? ` core:${String(c.core).slice(0, 200)}` : ''}`,
  ).join('\n')
  const prompt = [
    `Final gate over first-pass keep verdicts.`,
    `Keep a candidate ONLY if it lands in one of three layers: L1 relationship/communication`,
    `(user identity, address form, reply-style preferences, disliked patterns); L2 behavior rules`,
    `(principles the user corrected/insisted on, hard safety boundaries, quality bars); or L3 current`,
    `map (one-line project-landscape summaries, live long-running goals, environment anchors documented`,
    `nowhere else). For a past decision/failure, keep only the one-line lesson that still constrains`,
    `behavior, else drop. DROP anything whose source of truth is code, rules files, or skill docs, plus`,
    `implementation specs, code-internal constants, measurements, resolved-bug stories, status snapshots,`,
    `and duplicates of source-of-truth rules.`,
    `When a candidate has a core: field, judge THAT extracted one-line lesson (the entry will live as`,
    `that line), not the raw narrative in el:/sm:.`,
    ``,
    `Source-of-truth rules (excerpt — DO NOT duplicate in memory):`,
    String(rulesDigest || '').slice(0, 4000),
    ``,
    `Candidates:`,
    lines,
    ``,
    `Reply one line per id: "<id>|keep" to retain, "<id>|drop" to reject.`,
    `NO prose, NO preamble, NO meta-commentary. First character must be a digit.`,
  ].join('\n')

  // Keep the cascade on the same maintenance route as every other memory
  // cycle call. An explicit override remains available for focused tests and
  // controlled callers.
  const preset = options.cascadePreset || resolveMaintenancePreset('memory')
  const llmCall = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch
  let raw
  try {
    raw = await llmCall({
      agent: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'cycle2-cascade',
      preset,
      timeout: 600000,
      cwd: null,
      signal,
    }, prompt)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] cascade error: ${err.message} — fail-open\n`)
    return new Map()
  }
  throwIfAborted(signal)

  const verdicts = new Map()
  for (const line of String(raw ?? '').split('\n')) {
    throwIfAborted(signal)
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('```')) continue
    const parts = trimmed.split('|')
    if (parts.length < 2) continue
    const id = Number(parts[0].trim())
    const v = parts[1].trim().toLowerCase()
    if (Number.isFinite(id) && (v === 'keep' || v === 'drop')) verdicts.set(id, v)
  }
  __mixdogMemoryLog(`[cycle2] cascade evaluated=${candidates.length} drops=${[...verdicts.values()].filter(v => v === 'drop').length}\n`)
  return verdicts
}

export { NON_ARCHIVE_VERBS, requiredCoreIdForAction }
