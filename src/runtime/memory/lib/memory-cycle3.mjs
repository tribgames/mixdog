const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

// Cycle 3 — user-curated core memory review.
//
// Walks every row in core_entries (via listCore('*')), retrieves the related
// current memory for each row using searchRelevantHybrid, packs both into a
// {{CORE_REVIEW}} block for defaults/cycle3-review-prompt.md, then asks the
// maintenance-preset LLM for one verdict per id. By default Cycle3 performs
// conservative cleanup: safe compression updates and strict duplicate merges
// are applied, while deletes stay proposals unless explicitly confirmed.
//
// Verdict line grammar (mirrors parseUnifiedFormat in memory-cycle2.mjs):
//   <id>|keep
//   <id>|update|<element>|<summary>
//   <id>|merge|<target_id>|<source_ids_csv>
//   <id>|delete

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callBridgeLlm } from './agent-ipc.mjs'
import { listCore, editCore, deleteCore, CORE_SUMMARY_MAX } from './core-memory-store.mjs'
import { loadCurrentRulesDigest } from './memory-cycle2.mjs'
import { embedText } from './embedding-provider.mjs'
import { searchRelevantHybrid } from './memory-recall-store.mjs'

function resourceDir() {
  return process.env.MIXDOG_ROOT || fileURLToPath(new URL('../../../..', import.meta.url))
}

async function invokeLlm(prompt, mode, preset, timeout, llmCall = callBridgeLlm) {
  return await llmCall({
    role: 'cycle3-agent',
    taskType: 'maintenance',
    mode,
    preset,
    timeout,
    cwd: null,
  }, prompt)
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

function resolveApplyMode(config, options = {}) {
  if (options?.apply === true) return 'confirmed'
  if (options?.apply === false) return 'proposal'
  const raw = String(options?.applyMode || config?.cycle3?.applyMode || 'conservative').trim().toLowerCase()
  if (raw === 'proposal' || raw === 'dry-run' || raw === 'dryrun') return 'proposal'
  return 'conservative'
}

function normalizeComparable(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[|`"'“”‘’()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactComparable(value) {
  return normalizeComparable(value).replace(/\s+/g, '')
}

function charDice(a, b) {
  const aa = compactComparable(a)
  const bb = compactComparable(b)
  if (!aa || !bb) return 0
  if (aa === bb) return 1
  if (aa.length < 3 || bb.length < 3) return aa === bb ? 1 : 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i <= s.length - 3; i++) {
      const g = s.slice(i, i + 3)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = grams(aa)
  const gb = grams(bb)
  let overlap = 0
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0)
  const total = [...ga.values()].reduce((s, n) => s + n, 0) + [...gb.values()].reduce((s, n) => s + n, 0)
  return total > 0 ? (2 * overlap) / total : 0
}

function coreText(core) {
  return `${core?.element || ''}\n${core?.summary || ''}`
}

function isSafeConservativeUpdate(current, action) {
  if (!current || !action?.element || !action?.summary) return { ok: false, reason: 'missing text' }
  const newElement = normalizeComparable(action.element)
  const newSummary = normalizeComparable(action.summary)
  if (!newElement || !newSummary) return { ok: false, reason: 'empty rewrite' }
  if (newSummary.length > CORE_SUMMARY_MAX) return { ok: false, reason: 'summary too long' }

  const oldText = coreText(current)
  const newText = `${action.element}\n${action.summary}`
  const oldLen = normalizeComparable(oldText).length
  const newLen = normalizeComparable(newText).length
  if (oldLen > 0 && newLen > oldLen + 20) return { ok: false, reason: 'rewrite expands entry' }

  const sim = charDice(oldText, newText)
  if (sim < 0.28) return { ok: false, reason: `rewrite drift sim=${sim.toFixed(2)}` }
  return { ok: true, reason: 'safe compression' }
}

function findElementConflict(coreById, currentId, element, projectId) {
  const nextElement = String(element ?? '').trim()
  if (!nextElement) return null
  for (const [id, row] of coreById) {
    if (Number(id) === Number(currentId)) continue
    if ((row.project_id ?? null) !== (projectId ?? null)) continue
    if (String(row.element ?? '') === nextElement) return Number(id)
  }
  return null
}

function isStrictDuplicate(a, b) {
  if (!a || !b) return false
  const ae = compactComparable(a.element)
  const be = compactComparable(b.element)
  const as = compactComparable(a.summary)
  const bs = compactComparable(b.summary)
  if (as && bs && as === bs) return true
  if (ae && be && ae === be && charDice(a.summary, b.summary) >= 0.65) return true
  const sim = charDice(coreText(a), coreText(b))
  return sim >= 0.78
}

function formatRelatedRow(r) {
  const tag = r.project_id ? r.project_id : 'COMMON'
  const stat = r.status ? `[${r.status}]` : '[?]'
  const el = r.element ? `el:${r.element} ` : ''
  const sm = String(r.summary || r.content || '').replace(/\s+/g, ' ').slice(0, 160)
  return `    - id:${r.id} ${stat} ${tag} ${r.category ?? '?'} ${el}sm:${sm}`
}

function formatCoreBlock(core, related) {
  const tag = core.project_id ? core.project_id : 'COMMON'
  const head = `## CORE id:${core.id} ${tag} ${core.category}`
  const el = `  element: ${core.element}`
  const sm = `  summary: ${String(core.summary || '').replace(/\s+/g, ' ')}`
  const rel = related && related.length
    ? `  related current memory (top ${related.length}):\n` + related.map(formatRelatedRow).join('\n')
    : `  related current memory: (none found)`
  return [head, el, sm, rel].join('\n')
}

// Parse cycle3 verdict lines. Returns { actions } where each action is one of
// { id, verb:'keep' } | { id, verb:'update', element, summary }
// | { id, verb:'merge', targetId, sourceIds:[...] } | { id, verb:'delete' }.
function parseVerdicts(raw, idSet) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return { actions: [] }
  const lines = text.split('\n')
  const actions = []
  let sawValid = false
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^\d+[\.)]?\s+(?=\d+\|)/, '')
    if (!line) continue
    if (line.startsWith('//') || line.startsWith('#')) continue
    if (line.startsWith('```')) continue
    const parts = line.split('|')
    if (parts.length < 2) continue
    const id = Number(parts[0].trim())
    const verb = parts[1].trim().toLowerCase()
    if (!Number.isFinite(id) || !verb) continue
    if (!idSet.has(id)) continue
    sawValid = true
    if (verb === 'keep') {
      actions.push({ id, verb: 'keep' })
    } else if (verb === 'update') {
      const element = (parts[2] ?? '').trim()
      const summary = parts.slice(3).join('|').trim()
      if (!element || !summary) continue
      actions.push({ id, verb: 'update', element, summary })
    } else if (verb === 'merge') {
      const targetId = Number((parts[2] ?? '').trim())
      const sourceIds = [...new Set((parts[3] ?? '')
        .split(',')
        .map(s => Number(String(s).trim()))
        .filter(n => Number.isFinite(n) && idSet.has(n)))]
      if (!Number.isFinite(targetId) || !idSet.has(targetId)) {
        __mixdogMemoryLog(`[cycle3] merge rejected: id=${id} invalid target\n`)
        continue
      }
      if (sourceIds.length === 0) {
        __mixdogMemoryLog(`[cycle3] merge rejected: id=${id} invalid sources\n`)
        continue
      }
      if (targetId !== id && !sourceIds.includes(id)) {
        __mixdogMemoryLog(
          `[cycle3] merge rejected: id=${id} must be target or listed source (target=${targetId} sources=${sourceIds.join(',')})\n`,
        )
        continue
      }
      actions.push({ id, verb: 'merge', targetId, sourceIds })
    } else if (verb === 'delete') {
      actions.push({ id, verb: 'delete' })
    }
  }
  if (!sawValid) return null
  return { actions }
}

const _runCycle3InFlight = new WeakMap()

export async function runCycle3(db, config, dataDir, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  const applyMode = resolveApplyMode(config, options)
  const partial = {
    reviewed: 0, kept: 0, updated: 0, merged: 0, deleted: 0,
    proposed: { kept: 0, updated: 0, merged: 0, deleted: 0 },
    held: { updated: 0, merged: 0, deleted: 0 },
    applied: applyMode !== 'proposal',
    applyMode,
    details: [],
  }
  if (_runCycle3InFlight.has(db)) {
    __mixdogMemoryLog('[cycle3] skipped: already in flight for this db\n')
    return { ...partial, skippedInFlight: true }
  }
  const client = await db._pool.connect()
  let gotLock = false
  try {
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, ['mixdog.cycle3'])
    gotLock = r.rows[0]?.got === true
  } catch (err) {
    client.release()
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle3] advisory lock query failed: ${err.message}\n`)
    return { ...partial, skippedInFlight: true }
  }
  if (!gotLock) {
    client.release()
    __mixdogMemoryLog('[cycle3] skipped: advisory lock held by another worker\n')
    return { ...partial, skippedInFlight: true }
  }
  const promise = (async () => {
    try {
      return await _runCycle3Impl(db, config, dataDir, options)
    } finally {
      try { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['mixdog.cycle3']) } catch {}
      client.release()
    }
  })()
  _runCycle3InFlight.set(db, promise)
  try { return await promise }
  finally { _runCycle3InFlight.delete(db) }
}

async function _runCycle3Impl(db, config, dataDir, options = {}) {
  const signal = options?.signal
  const applyMode = resolveApplyMode(config, options)
  const confirmed = applyMode === 'confirmed'
  const conservative = applyMode === 'conservative'
  const mutate = confirmed || conservative
  throwIfAborted(signal)
  if (!dataDir) throw new Error('runCycle3: dataDir required')

  const cores = await listCore(dataDir, '*')
  throwIfAborted(signal)
  if (!cores || cores.length === 0) {
    __mixdogMemoryLog(`[cycle3] reviewed=0 kept=0 updated=0 merged=0 deleted=0 mode=${applyMode} (no core_entries)\n`)
    return {
      reviewed: 0, kept: 0, updated: 0, merged: 0, deleted: 0,
      proposed: { kept: 0, updated: 0, merged: 0, deleted: 0 },
      held: { updated: 0, merged: 0, deleted: 0 },
      applied: mutate,
      applyMode,
      details: [],
    }
  }

  // Per-core related-memory recall.
  const blocks = []
  for (const core of cores) {
    throwIfAborted(signal)
    const queryText = `${core.element}\n${String(core.summary || '')}`.trim()
    let related = []
    try {
      const scope = core.project_id ? String(core.project_id) : 'common'
      let queryVector = null
      try {
        queryVector = await embedText(queryText)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[cycle3] embedding failed for core id=${core.id}: ${err.message}\n`)
      }
      related = await searchRelevantHybrid(db, queryText, {
        limit: 8,
        projectScope: scope,
        includeMembers: false,
        queryVector: Array.isArray(queryVector) ? queryVector : undefined,
      })
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle3] recall failed for core id=${core.id}: ${err.message}\n`)
      related = []
    }
    throwIfAborted(signal)
    blocks.push(formatCoreBlock(core, related))
  }
  const coreReview = blocks.join('\n\n')

  // Load + fill prompt template.
  const promptPath = join(resourceDir(), 'defaults', 'cycle3-review-prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`runCycle3: prompt file missing at ${promptPath}`)
  }
  const template = readFileSync(promptPath, 'utf8')
  const rulesDigest = loadCurrentRulesDigest() || '(no current rules digest available)'
  const prompt = template
    .replace('{{CORE_REVIEW}}', coreReview)
    .replace('{{CURRENT_RULES}}', rulesDigest)

  const preset = resolveMaintenancePreset('memory')
  const timeout = Number(config?.cycle3?.timeout ?? 600000)
  const mode = 'cycle3-review'

  __mixdogMemoryLog(`[cycle3-diag] prompt=${prompt.length} bytes; cores=${cores.length}\n`)

  let raw
  try {
    throwIfAborted(signal)
    raw = await invokeLlm(prompt, mode, preset, timeout, options.callLlm)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle3] LLM error: ${err.message}\n`)
    return {
      reviewed: cores.length, kept: 0, updated: 0, merged: 0, deleted: 0,
      proposed: { kept: 0, updated: 0, merged: 0, deleted: 0 },
      held: { updated: 0, merged: 0, deleted: 0 },
      applied: mutate,
      applyMode,
      details: [], error: err.message,
    }
  }
  throwIfAborted(signal)

  const idSet = new Set(cores.map(c => Number(c.id)))
  const coreById = new Map(cores.map(c => [Number(c.id), c]))
  const parsed = parseVerdicts(raw, idSet)
  if (!parsed) {
    __mixdogMemoryLog(
      `[cycle3] unparseable response — skipping (${String(raw ?? '').replace(/\s+/g, ' ').slice(0, 200)})\n`,
    )
    return {
      reviewed: cores.length, kept: 0, updated: 0, merged: 0, deleted: 0,
      proposed: { kept: 0, updated: 0, merged: 0, deleted: 0 },
      held: { updated: 0, merged: 0, deleted: 0 },
      applied: mutate,
      applyMode,
      details: [], error: 'unparseable',
    }
  }
  const seenVerdictIds = new Set()
  const dedupedActions = []
  for (const action of parsed.actions) {
    const vid = Number(action.id)
    if (seenVerdictIds.has(vid)) {
      __mixdogMemoryLog(`[cycle3] duplicate verdict rejected: id=${vid} verb=${action.verb}\n`)
      continue
    }
    seenVerdictIds.add(vid)
    dedupedActions.push(action)
  }
  parsed.actions = dedupedActions
  const actionIds = new Set(parsed.actions.map(a => Number(a.id)).filter(n => Number.isFinite(n)))
  for (const id of idSet) {
    if (!actionIds.has(id)) parsed.actions.push({ id, verb: 'keep' })
  }

  let kept = 0, updated = 0, merged = 0, deleted = 0
  const proposed = { kept: 0, updated: 0, merged: 0, deleted: 0 }
  const held = { updated: 0, merged: 0, deleted: 0 }
  const details = []
  const touched = new Set() // ids already acted on this cycle — avoid double action

  // Core-store edit/delete calls are the mutation unit; checkpoints sit before
  // each action/source and after each awaited unit, not inside one file-store write.
  for (const a of parsed.actions) {
    throwIfAborted(signal)
    if (touched.has(a.id)) continue
    if (a.verb === 'keep') {
      kept++
      proposed.kept++
      details.push({ id: a.id, verb: 'keep' })
      touched.add(a.id)
      continue
    }
    if (a.verb === 'update') {
      proposed.updated++
      const safety = conservative ? isSafeConservativeUpdate(coreById.get(a.id), a) : { ok: true, reason: 'confirmed' }
      const conflictId = conservative
        ? findElementConflict(coreById, a.id, a.element, coreById.get(a.id)?.project_id ?? null)
        : null
      if (!mutate || (conservative && (!safety.ok || conflictId != null))) {
        held.updated++
        details.push({
          id: a.id, verb: 'update', element: a.element, summary: a.summary,
          applied: false, held: true,
          reason: !mutate ? 'proposal mode' : (conflictId != null ? `element conflicts with core id=${conflictId}` : safety.reason),
        })
        touched.add(a.id)
        continue
      }
      try {
        await editCore(dataDir, a.id, { element: a.element, summary: a.summary })
        updated++
        details.push({ id: a.id, verb: 'update', element: a.element, summary: a.summary, applied: true })
        touched.add(a.id)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[cycle3] update failed id=${a.id}: ${err.message}\n`)
        details.push({ id: a.id, verb: 'update', error: err.message })
      }
      continue
    }
    if (a.verb === 'delete') {
      proposed.deleted++
      if (!confirmed) {
        held.deleted++
        details.push({
          id: a.id, verb: 'delete', applied: false, held: true,
          reason: conservative ? 'delete requires APPLY CYCLE3' : 'proposal mode',
        })
        touched.add(a.id)
        continue
      }
      try {
        await deleteCore(dataDir, a.id)
        deleted++
        details.push({ id: a.id, verb: 'delete', applied: true })
        touched.add(a.id)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[cycle3] delete failed id=${a.id}: ${err.message}\n`)
        details.push({ id: a.id, verb: 'delete', error: err.message })
      }
      continue
    }
    if (a.verb === 'merge') {
      if (a.targetId !== a.id && !a.sourceIds.includes(a.id)) {
        __mixdogMemoryLog(
          `[cycle3] merge rejected: id=${a.id} must be target or listed source (target=${a.targetId} sources=${a.sourceIds.join(',')})\n`,
        )
        touched.add(a.id)
        touched.add(a.targetId)
        for (const sid of a.sourceIds) touched.add(sid)
        details.push({ id: a.id, verb: 'merge', error: 'id must be target or listed source' })
        continue
      }
      // Only merge within the same project pool. Survivor = targetId.
      const target = coreById.get(a.targetId)
      if (!target) {
        details.push({ id: a.id, verb: 'merge', error: `target ${a.targetId} not found` })
        touched.add(a.id)
        continue
      }
      const validSources = []
      for (const sid of a.sourceIds) {
        throwIfAborted(signal)
        if (sid === a.targetId) continue
        if (touched.has(sid)) continue
        const src = coreById.get(sid)
        if (!src) continue
        if ((src.project_id ?? null) !== (target.project_id ?? null)) {
          __mixdogMemoryLog(`[cycle3] merge skipped src=${sid} target=${a.targetId} (project pool mismatch)\n`)
          continue
        }
        validSources.push(sid)
      }
      if (validSources.length === 0) {
        details.push({ id: a.id, verb: 'merge', error: 'no valid sources' })
        continue
      }
      // Refresh target via editCore so summary/element reflect the merged form.
      // The verdict carries no rewritten text → fall back to the target's
      // existing element/summary unmodified; the LLM expressed merge intent
      // alone. editCore requires a change, so when no text drift is supplied
      // we skip the target update and just absorb sources.
      proposed.merged++
      const safeSources = conservative
        ? validSources.filter(sid => isStrictDuplicate(target, coreById.get(sid)))
        : validSources
      const mergedDetail = {
        id: a.id, verb: 'merge', targetId: a.targetId, sourceIds: validSources,
        removed: [], applied: false, applyMode,
      }
      if (!mutate || safeSources.length === 0) {
        held.merged++
        mergedDetail.held = true
        mergedDetail.reason = !mutate ? 'proposal mode' : 'no strict duplicate source'
        details.push(mergedDetail)
        touched.add(a.targetId)
        validSources.forEach(sid => touched.add(sid))
        continue
      }
      for (const sid of safeSources) {
        throwIfAborted(signal)
        try {
          await deleteCore(dataDir, sid)
          mergedDetail.removed.push(sid)
          touched.add(sid)
        } catch (err) {
          if (signal?.aborted) throw signal.reason ?? err
          __mixdogMemoryLog(`[cycle3] merge delete src=${sid} failed: ${err.message}\n`)
        }
      }
      if (mergedDetail.removed.length > 0) {
        merged++
        mergedDetail.applied = true
        if (safeSources.length < validSources.length) {
          held.merged++
          mergedDetail.heldSources = validSources.filter(sid => !safeSources.includes(sid))
        }
        touched.add(a.targetId)
      }
      details.push(mergedDetail)
      continue
    }
  }

  throwIfAborted(signal)

  __mixdogMemoryLog(
    `[cycle3] reviewed=${cores.length} kept=${kept}` +
    ` proposed_update=${proposed.updated} proposed_merge=${proposed.merged} proposed_delete=${proposed.deleted}` +
    ` applied_update=${updated} applied_merge=${merged} applied_delete=${deleted}` +
    ` held_update=${held.updated} held_merge=${held.merged} held_delete=${held.deleted}` +
    ` mode=${applyMode}\n`,
  )

  return { reviewed: cores.length, kept, updated, merged, deleted, proposed, held, applied: mutate, applyMode, details }
}
