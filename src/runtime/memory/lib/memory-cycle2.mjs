const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import {
  syncRootEmbedding, deleteRootEmbedding, flushEmbeddingDirty,
} from './memory-embed.mjs'
import { listCore, backfillCoreEmbeddings, nominateCoreCandidates, CORE_SUMMARY_MAX } from './core-memory-store.mjs'
import { markCycleRequest, consumeCycleRequests, resolveCoalesceMaxDrains, scheduleCoalescedCycleRetry, makeCycleRequestSignature, resolveCoalesceMaxRetries } from './memory-cycle-requests.mjs'

export const CYCLE2_ACTIVE_TARGET_CAP = 100
const TIER1_THRESHOLD = 0.78

const TIER2_LOW = 0.65
const LLM_JUDGE_CAP = 20

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

// Status-based verb whitelist. 3-tier policy: pending → active/archived,
// active → active/archived/update/merge.
const STATUS_ALLOWED_VERBS = {
  pending: new Set(['active', 'archived']),
  active:  new Set(['active', 'archived', 'update', 'merge']),
}
const NON_ARCHIVE_VERBS = new Set(['active', 'update', 'merge'])
// Union of every primary (status) verb across all statuses, plus the two
// non-verb line kinds. Used by the stray-index shift guard to decide whether
// a `idx|id|verb` line had a leading row index prepended by the LLM.
const ALL_PRIMARY_VERBS = new Set(['active', 'archived', 'update', 'merge'])
const isShiftFollowToken = (tok) => {
  const v = String(tok ?? '').trim().toLowerCase()
  return ALL_PRIMARY_VERBS.has(v) || v === 'why' || v === 'core'
}

function resourceDir() {
  return process.env.MIXDOG_ROOT || fileURLToPath(new URL('../../../..', import.meta.url))
}

async function invokeLlm(prompt, mode, preset, timeout, llmCall = callAgentDispatch) {
  return await llmCall({
    agent: 'cycle2-agent',
    taskType: 'maintenance',
    mode,
    preset,
    timeout,
    cwd: null,
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
  // ordinal domain (1..N) and the 5-digit batch-id domain must stay disjoint —
  // see the ordinalToId invariant in runUnifiedGate.
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

// Parse pipe-format unified verdicts. Each line: <id>|<verb> [|...].
// Verbs validated against the row's current status via STATUS_ALLOWED_VERBS.
// Returns { actions, rejected } or null when no parseable lines.
function parseUnifiedFormat(raw, statusById, ordinalToId = null) {
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return { actions: [], rejected: new Set() }
  const lines = text.split('\n')
  const actions = []
  const rejected = new Set()
  const support = new Map()
  let sawValid = false
  // Resolve a first-field/merge token to a real batch id. The gate may echo
  // either the exact 5-digit batch id OR the 1-based row ordinal shown in the
  // numbered Entries block. The two domains are disjoint (asserted in
  // runUnifiedGate), so an exact-id hit always wins and an unmatched value
  // falls back to ordinal lookup; anything else is NaN (line treated invalid).
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
      actions.push({ entry_id: entryId, action: 'core', core_summary: parts.slice(2).join('|').trim().slice(0, 120) })
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

// Batch CTE UPDATE for status-only verdicts (active/archived from pending or active rows).
// Trigger handles score recompute automatically — no app-side score writes.
async function applyBatchStatusVerdicts(db, batch, nowMs) {
  if (!batch || batch.length === 0) return { promoted: 0, archived: 0 }
  const valueRows = batch.map((item, i) => {
    const base = i * 3
    return `($${base + 1}::bigint, $${base + 2}::text, $${base + 3}::boolean)`
  })
  const params = []
  for (const item of batch) {
    params.push(item.entry_id, item.new_status, item.was_pending)
  }
  params.push(nowMs)
  const lastParam = `$${params.length}`
  const res = await db.query(
    `WITH actions(entry_id, new_status, was_pending) AS (
       VALUES ${valueRows.join(', ')}
     )
     UPDATE entries
     SET status = a.new_status::entry_status,
         last_seen_at = ${lastParam},
         promoted_at = CASE
           WHEN a.was_pending AND a.new_status = 'active' THEN ${lastParam}
           ELSE promoted_at
         END
     FROM actions a
     WHERE entries.id = a.entry_id AND entries.is_root = 1
     RETURNING entries.id, entries.status, a.was_pending, a.new_status`,
    params,
  )
  let promoted = 0
  let archived = 0
  for (const r of (res.rows ?? [])) {
    if (r.was_pending && r.new_status === 'active') promoted += 1
    else if (r.new_status === 'archived') archived += 1
  }
  return { promoted, archived }
}

// Generic status update for archived/active terminal transitions.
export async function applySimpleStatus(db, entryId, nextStatus) {
  const res = await db.query(
    `UPDATE entries SET status = $1 WHERE id = $2 AND is_root = 1`,
    [nextStatus, entryId],
  )
  return Number(res.rowCount ?? res.affectedRows ?? 0) > 0
}

export async function applyUpdate(db, entryId, element, summary, options = {}) {
  const setClauses = []
  const params = []
  let paramIdx = 1
  const newElement = (typeof element === 'string' && element.trim()) ? element.trim() : null
  const newSummary = (typeof summary === 'string' && summary.trim()) ? summary.trim() : null
  if (newElement) {
    setClauses.push(`element = $${paramIdx++}`); params.push(newElement)
  }
  if (newSummary) {
    setClauses.push(`summary = $${paramIdx++}`); params.push(newSummary)
    setClauses.push('summary_hash = NULL')
  }
  if (setClauses.length === 0) return false
  params.push(entryId)
  const res = await db.query(
    `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND is_root = 1`,
    params,
  )
  if (Number(res.rowCount ?? res.affectedRows ?? 0) === 0) return false
  await syncRootEmbedding(db, entryId, options)
  return true
}

export async function applyMerge(db, targetId, sourceIds, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (!Number.isFinite(targetId)) return 0
  const targetRes = await db.query(
    `SELECT id, project_id FROM entries WHERE id = $1 AND is_root = 1`,
    [targetId],
  )
  throwIfAborted(signal)
  const target = targetRes.rows[0]
  if (!target) return 0
  let moved = 0
  for (const src of sourceIds) {
    throwIfAborted(signal)
    const sid = Number(src)
    if (!Number.isFinite(sid) || sid === targetId) continue
    const srcRes = await db.query(
      `SELECT id, project_id, status FROM entries WHERE id = $1 AND is_root = 1`,
      [sid],
    )
    throwIfAborted(signal)
    const srcRow = srcRes.rows[0]
    if (!srcRow) continue
    if (target.project_id !== srcRow.project_id) {
      __mixdogMemoryLog(
        `[cycle2] merge rejected: cross-pool (target=${targetId} project_id=${target.project_id ?? 'COMMON'} src=${sid} project_id=${srcRow.project_id ?? 'COMMON'})\n`,
      )
      continue
    }
    try {
      // One source merge is the mutation unit: DB reassignment/archive plus
      // embedding cleanup. The next abort checkpoint is before the next source.
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE entries SET chunk_root = $1, project_id = $2 WHERE chunk_root = $3 AND id != $4 AND is_root = 0`,
          [targetId, target.project_id, sid, sid],
        )
        await tx.query(
          `UPDATE entries SET status = 'archived' WHERE id = $1 AND is_root = 1`,
          [sid],
        )
      })
      await deleteRootEmbedding(db, sid)
      moved += 1
    } catch (err) {
      __mixdogMemoryLog(`[cycle2] merge failed (target=${targetId} src=${sid}): ${err.message}\n`)
    }
  }
  return moved
}

// ─── phase_merge: cosine-similarity dedup pass ───────────────────────────────

function _pickKeeper(a, b) {
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b
  if ((a.last_seen_at ?? 0) !== (b.last_seen_at ?? 0)) return (a.last_seen_at ?? 0) > (b.last_seen_at ?? 0) ? a : b
  return a.id < b.id ? a : b
}

async function _llmJudgePair(summaryA, summaryB, siblingContext = [], options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  const llmCall = typeof options?.callLlm === 'function' ? options.callLlm : callAgentDispatch
  const siblings = Array.isArray(siblingContext) && siblingContext.length > 0
    ? `\n\nSibling near-matches (recall context only — do not absorb these into the verdict):\n${siblingContext.slice(0, 5).map((p, i) => `${i + 1}. ${String(p.a?.summary ?? '')} ↔ ${String(p.b?.summary ?? '')}`).join('\n')}`
    : ''
  const prompt =
    `Two memory entries below. Are they restating the same principle? Reply ONE WORD: merge or distinct.\n\nA: ${summaryA}\nB: ${summaryB}${siblings}`
  try {
    const raw = await llmCall({
      agent: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'cycle2-phase_merge_judge',
      preset: 'HAIKU',
      timeout: 30000,
      cwd: null,
    }, prompt)
    throwIfAborted(signal)
    return String(raw ?? '').trim().toLowerCase().startsWith('merge')
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] phase_merge llm-judge error: ${err.message}\n`)
    return false
  }
}

export async function runPhaseMerge(db, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  // PG-side lateral nearest-neighbor via HNSW index — replaces JS O(n²) double loop.
  const pairRes = await db.query(
    `WITH active AS (
       SELECT id, category, summary, score, last_seen_at, status, embedding, project_id
       FROM entries
       WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
     )
     SELECT a.id AS a_id, a.category AS a_category, a.summary AS a_summary, a.score AS a_score, a.last_seen_at AS a_last_seen_at, a.status AS a_status,
            b.id AS b_id, b.category AS b_category, b.summary AS b_summary, b.score AS b_score, b.last_seen_at AS b_last_seen_at, b.status AS b_status,
            1 - (a.embedding <=> b.embedding)::float8 AS sim
     FROM active a
     CROSS JOIN LATERAL (
       SELECT id, category, summary, score, last_seen_at, status, embedding
       FROM active inner_b
       WHERE inner_b.id != a.id AND inner_b.category = a.category
         AND inner_b.project_id IS NOT DISTINCT FROM a.project_id
       ORDER BY inner_b.embedding <=> a.embedding
       LIMIT 8
     ) b
     WHERE a.id < b.id
       AND 1 - (a.embedding <=> b.embedding) >= $1
     ORDER BY sim DESC`,
    [TIER2_LOW],
  )
  throwIfAborted(signal)

  const tier1Pairs = []
  const tier2Pairs = []
  for (const row of pairRes.rows) {
    throwIfAborted(signal)
    const a = { id: row.a_id, category: row.a_category, summary: row.a_summary, score: row.a_score, last_seen_at: row.a_last_seen_at, status: row.a_status }
    const b = { id: row.b_id, category: row.b_category, summary: row.b_summary, score: row.b_score, last_seen_at: row.b_last_seen_at, status: row.b_status }
    if (row.sim >= TIER1_THRESHOLD) tier1Pairs.push({ a, b, sim: row.sim })
    else tier2Pairs.push({ a, b, sim: row.sim })
  }

  // No active/active similarity pairs is NOT a reason to skip the
  // core_entries overlap sweep below — that pass archives active entries
  // that restate a user-curated core row and is independent of intra-
  // entry pairing. Falling through with merged=0 keeps the cross-table
  // sweep running and the per-phase log shape intact.
  let merged = 0
  let llmCalls = 0
  const mergedIds = new Set()

  const doMerge = async (a, b, sim) => {
    throwIfAborted(signal)
    if (mergedIds.has(a.id) || mergedIds.has(b.id)) return
    const keeper = _pickKeeper(a, b)
    const loser = keeper.id === a.id ? b : a
    const moved = await applyMerge(db, keeper.id, [loser.id], { signal })
    if (moved > 0) {
      merged += moved
      mergedIds.add(loser.id)
      __mixdogMemoryLog(
        `[cycle2] phase_merge merged id=${loser.id} -> keeper=${keeper.id} category=${keeper.category} sim=${typeof sim === 'number' ? sim.toFixed(3) : '?'}\n`,
      )
    }
  }

  // Only tier1 pairs enter the LLM judge. Tier2 pairs (0.65 ≤ sim < 0.78)
  // are recall context only — passed as sibling examples to the judge, never
  // as judge input themselves, and never archived here.
  for (const pair of tier1Pairs) {
    throwIfAborted(signal)
    if (llmCalls >= LLM_JUDGE_CAP) break
    if (mergedIds.has(pair.a.id) || mergedIds.has(pair.b.id)) continue
    llmCalls++
    const shouldMerge = await _llmJudgePair(
      String(pair.a.summary ?? ''),
      String(pair.b.summary ?? ''),
      tier2Pairs,
      { signal },
    )
    throwIfAborted(signal)
    if (shouldMerge) await doMerge(pair.a, pair.b, pair.sim)
  }

  // Cross-table sweep: surface every active entry whose embedding sits near
  // a user-curated core_entries row (sim ≥ TIER2_LOW for broad recall) and
  // ask the LLM whether the entry is a restatement of that user rule. Only
  // the LLM verdict moves the entry to archived — embedding sim alone is
  // never authoritative. Project-scoped core only matches the same pool;
  // COMMON core is global and may absorb duplicate generated project memory.
  throwIfAborted(signal)
  const coreOverlapRes = await db.query(
    `WITH active_e AS (
       SELECT id, project_id, summary, embedding
       FROM entries
       WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
     )
     SELECT e.id AS entry_id, e.summary AS entry_summary, c.core_id, c.core_summary, c.sim
     FROM active_e e
     CROSS JOIN LATERAL (
       SELECT inner_c.id AS core_id, inner_c.summary AS core_summary,
              1 - (e.embedding <=> inner_c.embedding)::float8 AS sim
       FROM core_entries inner_c
       WHERE inner_c.embedding IS NOT NULL
         AND (inner_c.project_id IS NULL OR inner_c.project_id IS NOT DISTINCT FROM e.project_id)
       ORDER BY
         CASE WHEN inner_c.project_id IS NOT DISTINCT FROM e.project_id THEN 0 ELSE 1 END,
         inner_c.embedding <=> e.embedding
       LIMIT 1
     ) c
     WHERE c.sim >= $1`,
    [TIER1_THRESHOLD],
  )
  throwIfAborted(signal)
  let coreOverlap = 0
  for (const row of coreOverlapRes.rows) {
    throwIfAborted(signal)
    if (llmCalls >= LLM_JUDGE_CAP) break
    llmCalls++
    const verdictMerge = await _llmJudgePair(
      String(row.entry_summary ?? ''),
      String(row.core_summary ?? ''),
      [],
      { signal },
    )
    throwIfAborted(signal)
    if (!verdictMerge) continue
    // Archiving one overlap and deleting its embedding is one mutation unit;
    // cancellation resumes at the next row boundary.
    const r = await db.query(
      `UPDATE entries SET status = 'archived' WHERE id = $1 AND is_root = 1 AND status = 'active'`,
      [Number(row.entry_id)],
    )
    if (Number(r.rowCount ?? r.affectedRows ?? 0) > 0) {
      coreOverlap++
      await deleteRootEmbedding(db, Number(row.entry_id))
    }
  }
  throwIfAborted(signal)
  if (coreOverlap > 0) {
    __mixdogMemoryLog(
      `[cycle2] phase_merge core_overlap archived=${coreOverlap} (LLM-judged restatements of user-curated core_entries)\n`,
    )
  }

  __mixdogMemoryLog(
    `[cycle2] phase_merge tier1_pairs=${tier1Pairs.length} tier2_pairs=${tier2Pairs.length}` +
    ` llm_calls=${llmCalls} merged=${merged} core_overlap=${coreOverlap}\n`,
  )

  return { merged, llm_calls: llmCalls, tier1_pairs: tier1Pairs.length, tier2_pairs: tier2Pairs.length, core_overlap: coreOverlap }
}

// ─── Current rules digest cache ──────────────────────────────────────────────

let _currentRulesDigest = null
let _currentRulesDigestTs = 0
export function loadCurrentRulesDigest() {
  const now = Date.now()
  if (_currentRulesDigest && now - _currentRulesDigestTs < 60_000) return _currentRulesDigest
  const sources = [
    join(resourceDir(), 'rules', 'shared', '01-general.md'),
    join(resourceDir(), 'rules', 'shared', '01-tool.md'),
    join(resourceDir(), 'rules', 'shared', '04-memory.md'),
    join(resourceDir(), 'rules', 'shared', '06-team.md'),
    join(resourceDir(), 'rules', 'shared', '07-workflow.md'),
  ]
  const parts = []
  for (const p of sources) {
    try {
      if (!existsSync(p)) continue
      const txt = readFileSync(p, 'utf8').trim()
      if (txt) parts.push(`# Source: ${p}\n${txt}`)
    } catch {}
  }
  const joined = parts.join('\n\n---\n\n')
  const CAP = 40_000
  _currentRulesDigest = joined.length > CAP ? joined.slice(0, CAP) + '\n…[truncated]' : joined
  _currentRulesDigestTs = now
  return _currentRulesDigest
}

function uniqueIds(values) {
  return [...new Set(values
    .map(id => Number(id))
    .filter(id => Number.isFinite(id)))]
}

function validateUnifiedGate(parsed, statusById) {
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : []
  const primary = actions.filter(a => a?.action !== 'core')
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
  }
}

function gateQualitySummary(quality) {
  const parts = []
  if (quality?.missingVerdictIds?.length) parts.push(`missing verdict ids=${quality.missingVerdictIds.join(',')}`)
  if (quality?.duplicateVerdictIds?.length) parts.push(`duplicate verdict ids=${quality.duplicateVerdictIds.join(',')}`)
  if (quality?.missingSupportIds?.length) parts.push(`missing why ids=${quality.missingSupportIds.join(',')}`)
  if (quality?.missingCoreIds?.length) parts.push(`missing core ids=${quality.missingCoreIds.join(',')}`)
  return parts.join('; ')
}

function stripUnsupportedPromotions(parsed, unsupportedIds) {
  const ids = new Set(uniqueIds(unsupportedIds))
  if (ids.size === 0) return parsed
  const rejected = new Set(parsed?.rejected || [])
  for (const id of ids) rejected.add(id)
  const actions = (parsed?.actions || []).filter(a => {
    if (a?.action === 'core') return true
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

// Single LLM pass over rows whose status is in {pending, active}.
// Returns { actions, rejected, parseOk } following parseUnifiedFormat shape.
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
  throwIfAborted(signal)
  const sharedPidMap = buildPidMap([activeContext ?? [], rows ?? [], userCoreRows ?? []])
  const rulesDigest = loadCurrentRulesDigest() || '(no current rules digest available)'
  const activeCount = activeContext?.length ?? 0
  const activeCap = options.activeCap ?? CYCLE2_ACTIVE_TARGET_CAP

  const prompt = template
    .replace('{{CURRENT_RULES}}', rulesDigest)
    .replace('{{USER_CORE}}', formatUserCoreForPrompt(userCoreRows, sharedPidMap))
    .replace('{{CORE_MEMORY}}', formatEntriesForPromotePrompt(activeContext, sharedPidMap))
    .replace('{{ITEMS}}', formatEntriesForPromotePrompt(rows, sharedPidMap, { numbered: true }))
    .replace('{{ACTIVE_COUNT}}', String(activeCount))
    .replace('{{ACTIVE_CAP}}', String(activeCap))

  const preset = options.preset || resolveMaintenancePreset('memory')
  const timeout = Number(config?.cycle2?.timeout ?? 600000)
  const mode = 'cycle2-unified'

  const previewRaw = (raw) => String(raw ?? '').replace(/\s+/g, ' ').slice(0, 200)
  const callOnce = async (extraTag) => {
    throwIfAborted(signal)
    const p = extraTag ? `${prompt}\n\n[retry:${extraTag}]` : prompt
    const raw = await invokeLlm(p, mode, preset, timeout, options.callLlm)
    throwIfAborted(signal)
    return raw
  }

  const statusById = new Map(rows.map(r => [Number(r.id), String(r.status)]))
  // Ordinal → batch-id map, keyed by 1-based prompt order (the same order the
  // numbered Entries block uses). The gate may echo either the real 5-digit
  // batch id or the row ordinal 1..N; the parser resolves both. The two domains
  // MUST be disjoint or an ordinal could shadow a real id (ids are 5-digit,
  // ordinals are <= rows.length, so disjointness always holds in practice).
  // On a violation a row-number line is indistinguishable from an exact-id
  // line, so no safe interpretation exists — skip this batch (gate failure)
  // rather than risk applying a verdict to the wrong entry. The cycle itself
  // proceeds; the batch re-queues for a later run.
  const ordinalToId = new Map(rows.map((r, i) => [i + 1, Number(r.id)]))
  const minBatchId = Math.min(...[...statusById.keys()])
  if (Number.isFinite(minBatchId) && minBatchId <= rows.length) {
    __mixdogMemoryLog(`[cycle2] batch id ${minBatchId} collides with ordinal range 1..${rows.length} — skipping batch (no safe id resolution)\n`)
    return { actions: null, rejected: new Set(), parseOk: false }
  }

  __mixdogMemoryLog(`[cycle2-diag] unified prompt=${prompt.length} bytes; rows=${rows.length}\n`)

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

  let parsed = parseUnifiedFormat(raw, statusById, ordinalToId)
  let quality = parsed ? validateUnifiedGate(parsed, statusById) : null
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
      const retryParsed = parseUnifiedFormat(raw2, statusById, ordinalToId)
      if (retryParsed) {
        parsed = retryParsed
        quality = validateUnifiedGate(retryParsed, statusById)
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
  if (quality?.duplicateVerdictIds?.length) {
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
  const primaryCount = (parsed.actions || []).filter(a => a?.action !== 'core').length
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
  }
}

// ─── Sonnet cascade ──────────────────────────────────────────────────────────

// Sonnet re-judge over first-pass keep verdicts. Sonnet sees rules + summary
// and returns binary keep/drop. Failures fail-open (preserve first-pass).
async function sonnetCascade(candidates, rulesDigest, options = {}) {
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

  // Hardcoded — resolveMaintenancePreset falls back to first preset (HAIKU)
  // when no binding exists, which would defeat the cascade. SONNET HIGH
  // matches the worker pool's default preset id from agent-config.
  const preset = options.cascadePreset || 'SONNET HIGH'
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

// ─── runCycle2 ───────────────────────────────────────────────────────────────

const _runCycle2InFlight = new WeakMap()

function mergeNestedNumeric(a = {}, b = {}) {
  const out = { ...a, ...b }
  for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[key] = Number(a?.[key] || 0) + Number(b?.[key] || 0)
  }
  return out
}

function mergeCycle2Results(a, b) {
  if (!a) return b
  if (!b) return a
  return {
    ...a,
    ...b,
    promoted: Number(a.promoted || 0) + Number(b.promoted || 0),
    archived: Number(a.archived || 0) + Number(b.archived || 0),
    merged: Number(a.merged || 0) + Number(b.merged || 0),
    updated: Number(a.updated || 0) + Number(b.updated || 0),
    kept: Number(a.kept || 0) + Number(b.kept || 0),
    rejected_verb: Number(a.rejected_verb || 0) + Number(b.rejected_verb || 0),
    merge_rejected: Number(a.merge_rejected || 0) + Number(b.merge_rejected || 0),
    missing_core_summary: Number(a.missing_core_summary || 0) + Number(b.missing_core_summary || 0),
    core_embedding_backfill: Number(a.core_embedding_backfill || 0) + Number(b.core_embedding_backfill || 0),
    core_candidates_nominated: Number(a.core_candidates_nominated || 0) + Number(b.core_candidates_nominated || 0),
    rescore: mergeNestedNumeric(a.rescore, b.rescore),
    phase_merge: mergeNestedNumeric(a.phase_merge, b.phase_merge),
    cascade: mergeNestedNumeric(a.cascade, b.cascade),
    skippedInFlight: false,
  }
}

export async function runCycle2(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const coalescedRetry = options?.coalescedRetry === true
  const retryAttempt = Math.max(0, Number(options?.coalescedRetryAttempt || 0))
  const maxRetries = resolveCoalesceMaxRetries(config, 3)
  const requestSignature = makeCycleRequestSignature('cycle2', config, {
    cascadePreset: options?.cascadePreset,
    concurrency: options?.concurrency,
  })
  const scheduleRetry = () => scheduleCoalescedCycleRetry(
    db,
    'cycle2',
    () => runCycle2(db, config, { ...options, signal: undefined, coalescedRetry: true, coalescedRetryAttempt: retryAttempt + 1 }, dataDir),
    config,
    requestSignature,
  )
  const partial = {
    promoted: 0, archived: 0, merged: 0, updated: 0, kept: 0, rejected_verb: 0,
    merge_rejected: 0,
    missing_core_summary: 0,
    core_embedding_backfill: 0,
    rescore: { updated: 0 },
    phase_merge: { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0, core_overlap: 0 },
    cascade: { evaluated: 0, dropped: 0 },
  }
  if (_runCycle2InFlight.has(db)) {
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'in-flight', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    __mixdogMemoryLog('[cycle2] skipped: already in flight for this db\n')
    return { ok: true, ...partial, skippedInFlight: true }
  }
  const client = await db._pool.connect()
  let gotLock = false
  try {
    throwIfAborted(signal)
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS got`, ['mixdog.cycle2'])
    gotLock = r.rows[0]?.got === true
  } catch (err) {
    client.release()
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] advisory lock query failed: ${err.message}\n`)
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'lock-error', requestSignature)
    return { ok: true, ...partial, skippedInFlight: true }
  }
  if (!gotLock) {
    client.release()
    if (!coalescedRetry) await markCycleRequest(db, 'cycle2', 'advisory-lock', requestSignature)
    if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
    __mixdogMemoryLog('[cycle2] skipped: advisory lock held by another worker\n')
    return { ok: true, ...partial, skippedInFlight: true }
  }
  const _p = (async () => {
    try {
      let result = null
      let coalescedRuns = 0
      let coalescedRequests = 0
      if (coalescedRetry) {
        const pending = await consumeCycleRequests(db, 'cycle2', requestSignature)
        if (pending <= 0) return { ok: true, ...partial, skippedInFlight: false, coalescedRetryNoop: true }
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle2] retrying coalesced requests=${pending}\n`)
      }
      try {
        result = await _runCycle2Impl(db, config, options, dataDir)
      } catch (err) {
        if (coalescedRetry) {
          await markCycleRequest(db, 'cycle2', 'retry-error', requestSignature)
          if (retryAttempt < maxRetries) scheduleRetry()
        }
        throw err
      }
      const maxDrains = resolveCoalesceMaxDrains(config, 1)
      let drainLoops = 0
      while (drainLoops < maxDrains) {
        throwIfAborted(signal)
        const pending = await consumeCycleRequests(db, 'cycle2', requestSignature)
        if (pending <= 0) break
        drainLoops += 1
        coalescedRuns += 1
        coalescedRequests += pending
        __mixdogMemoryLog(`[cycle2] draining coalesced requests=${pending}\n`)
        try {
          const next = await _runCycle2Impl(db, config, options, dataDir)
          result = mergeCycle2Results(result, next)
        } catch (err) {
          await markCycleRequest(db, 'cycle2', 'drain-error', requestSignature)
          if (!coalescedRetry || retryAttempt < maxRetries) scheduleRetry()
          throw err
        }
      }
      if (coalescedRuns > 0) {
        result = { ...result, coalescedRuns, coalescedRequests }
      }
      const okResult = { ok: true, ...result }
      if (coalescedRetry && !okResult?.coalescedRetryNoop && typeof options?.onCoalescedSuccess === 'function') {
        try { await options.onCoalescedSuccess(okResult) }
        catch (err) { __mixdogMemoryLog(`[cycle2] coalesced success callback failed: ${err?.message || err}\n`) }
      }
      return okResult
    } catch (e) {
      if (signal?.aborted) throw signal.reason ?? e
      return { ok: false, error: e.message, ...partial }
    } finally {
      let releaseErr = null
      try {
        const r = await client.query(`SELECT pg_advisory_unlock(hashtext($1)) AS unlocked`, ['mixdog.cycle2'])
        if (r.rows[0]?.unlocked !== true) releaseErr = new Error('cycle2 advisory unlock returned false')
      } catch (err) {
        releaseErr = err
      }
      client.release(releaseErr || undefined)
    }
  })()
  _runCycle2InFlight.set(db, _p)
  try { return await _p }
  finally { _runCycle2InFlight.delete(db) }
}

async function _runCycle2Impl(db, config = {}, options = {}, dataDir = null) {
  const signal = options?.signal
  throwIfAborted(signal)
  const batchSize = Math.max(1, Number(config.batch_size ?? 50))
  const activeTargetCap = Number.isFinite(Number(config.active_target_cap))
    ? Math.max(1, Number(config.active_target_cap))
    : CYCLE2_ACTIVE_TARGET_CAP
  const nowMs = Date.now()

  const stats = {
    promoted: 0, archived: 0, merged: 0,
    updated: 0, kept: 0, rejected_verb: 0,
    merge_rejected: 0,
    missing_core_summary: 0,
    core_embedding_backfill: 0,
    core_candidates_nominated: 0,
    rescore: { updated: 0 },
    phase_merge: { merged: 0, llm_calls: 0, tier1_pairs: 0, tier2_pairs: 0, core_overlap: 0 },
    cascade: { evaluated: 0, dropped: 0 },
  }

  if (dataDir) {
    try {
      stats.core_embedding_backfill = await backfillCoreEmbeddings(dataDir, { signal })
      throwIfAborted(signal)
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle2] core embedding backfill failed: ${err.message}\n`)
    }
  }

  const activeCountRes = await db.query(
    `SELECT COUNT(*) AS c FROM entries WHERE is_root = 1 AND status = 'active'`,
    [],
  )
  throwIfAborted(signal)
  const activeCount = Number(activeCountRes.rows[0]?.c ?? 0)
  const reviewActiveRows = activeCount > activeTargetCap

  // Rolling active re-review quota. Under cap, the unified selection below
  // pulls only pending rows, so an already-promoted entry that later drifts
  // stale or turns out to restate a rule file never gets re-judged — the
  // over-cap path was historically the ONLY one that re-examined active.
  // Reserve a bounded slice of batch slots for the stalest active rows so
  // rule-duplicate / drifted promotions are archived continuously instead of
  // sitting forever un-rechecked. Bounded count + reviewed_at rotation
  // prevents eroding the set to zero (the original over-cap-only concern):
  // only the oldest few are re-judged per cycle, and the gate — shown
  // {{CURRENT_RULES}} — keeps genuine A/B entries and archives only
  // restatements. Embedding dedup is skipped on purpose: rule restatements
  // are often cross-language paraphrases whose cosine never clears the merge
  // threshold, but the LLM gate catches the semantic overlap.
  const activeRecheckQuota = reviewActiveRows
    ? 0
    : Math.max(0, Math.min(Number(config.active_recheck_quota ?? 8), batchSize - 1))
  const pendingLimit = batchSize - activeRecheckQuota
  // Score direction depends on the phase. Under cap we are SEEDING the active
  // set: evaluate the highest-value pending first so promotion-worthy rows
  // reach the gate instead of starving behind low-score cycle1 churn. Over cap
  // we are CONTRACTING: evaluate the lowest-score rows first to shed the
  // weakest. (The active-recheck slice below stays ASC — demote weakest active
  // first.)
  const scoreDir = reviewActiveRows ? 'ASC' : 'DESC'

  // Unified candidate selection. Pending rows (and, when over cap, active
  // rows) reach the gate here; the reserved active-recheck slice is appended
  // below. Cleanup of duplicates/stale user-core overlap also runs via
  // phase_merge / cycle3.
  const rowsRes = await db.query(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status
    FROM entries
    WHERE is_root = 1
      AND (status = 'pending' OR ($2::boolean AND status = 'active'))
    ORDER BY
      CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 END ASC,
      reviewed_at ASC NULLS FIRST,
      error_count ASC,
      score ${scoreDir},
      id ASC
    LIMIT $1
  `, [pendingLimit, reviewActiveRows])
  throwIfAborted(signal)
  const rows = rowsRes.rows

  // Append the reserved rolling slice of stalest active rows (under-cap only;
  // the over-cap branch already pulls active broadly). De-duped against the
  // primary selection so an id never gets two verdicts in one batch.
  if (activeRecheckQuota > 0 && activeCount > 0) {
    const seen = new Set(rows.map(r => Number(r.id)))
    const recheckRes = await db.query(`
      SELECT id, element, category, summary, score, last_seen_at, project_id, status
      FROM entries
      WHERE is_root = 1 AND status = 'active'
      ORDER BY reviewed_at ASC NULLS FIRST, score ASC, id ASC
      LIMIT $1
    `, [activeRecheckQuota])
    throwIfAborted(signal)
    for (const r of recheckRes.rows) {
      if (!seen.has(Number(r.id))) rows.push(r)
    }
  }

  // Active snapshot for prompt context (do-not-duplicate reference).
  const activeContextRes = await db.query(`
    SELECT id, element, category, summary, score, last_seen_at, project_id, status
    FROM entries
    WHERE is_root = 1 AND status = 'active'
    ORDER BY score DESC, last_seen_at DESC, id ASC
    LIMIT 100
  `, [])
  throwIfAborted(signal)
  const activeContext = activeContextRes.rows

  const gateResult = rows.length > 0
    ? await runUnifiedGate(db, rows, activeContext, config, { activeCap: activeTargetCap, preset: options.preset, dataDir, signal, callLlm: options.callLlm })
    : { actions: [], rejected: new Set(), parseOk: true }
  throwIfAborted(signal)
  // Surface a gate parse/coverage failure so the caller can distinguish a
  // clean no-op run from one where the LLM gate produced nothing usable.
  if (gateResult.parseOk === false) stats.gate_failed = true

  const sweepCursor = nowMs

  const rowsById = new Map(rows.map(r => [Number(r.id), r]))

  // Cascade pre-pass: pull first-pass keeps (verb 'active') into Sonnet for
  // re-judge. update/merge/archived skip.
  const cascadeCandidates = []
  if (gateResult.actions) {
    // First-pass proposed core lines: under the pending-row transform the L2
    // lesson lives only in the core line, so thread it into the cascade.
    const proposedCoreById = new Map()
    for (const a of gateResult.actions) {
      if (a.action !== 'core') continue
      const id = Number(a.entry_id)
      const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim()
      if (Number.isFinite(id) && core) proposedCoreById.set(id, core)
    }
    for (const a of gateResult.actions) {
      throwIfAborted(signal)
      if (a.action !== 'active') continue
      const row = rowsById.get(Number(a.entry_id))
      if (!row) continue
      cascadeCandidates.push({
        id: row.id, status: row.status, verb: a.action,
        category: row.category, element: row.element, summary: row.summary,
        core: proposedCoreById.get(Number(a.entry_id)) || '',
      })
    }
  }

  const rulesDigest = loadCurrentRulesDigest() || ''
  let cascadeVerdicts = new Map()
  if (cascadeCandidates.length > 0) {
    cascadeVerdicts = await sonnetCascade(cascadeCandidates, rulesDigest, { ...options, signal })
    throwIfAborted(signal)
    stats.cascade.evaluated = cascadeCandidates.length
  }

  // Apply actions.
  if (gateResult.actions) {
    const reviewedIds = []
    const rejectedActionIds = []
    const cascadeDropArchiveIds = []
    const statusBatch = []
    const coreSummaryById = new Map()
    const primaryActions = []

    for (const a of gateResult.actions) {
      throwIfAborted(signal)
      if (a.action === 'core') {
        const id = Number(a.entry_id)
        const core = String(a.core_summary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
        if (Number.isFinite(id) && core) coreSummaryById.set(id, core)
      } else {
        primaryActions.push(a)
      }
    }

    const setCoreSummary = async (entryId, explicitSummary) => {
      const id = Number(entryId)
      if (!Number.isFinite(id)) return false
      let core = String(explicitSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, CORE_SUMMARY_MAX)
      if (!core) return false
      await db.query(`UPDATE entries SET core_summary = $1 WHERE id = $2 AND is_root = 1`, [core, id])
      return true
    }

    for (const a of primaryActions) {
      throwIfAborted(signal)
      const id = Number(a.entry_id)
      if (!Number.isFinite(id)) continue
      const row = rowsById.get(id)
      if (!row) continue
      let accepted = false

      try {
        const requiresCore = NON_ARCHIVE_VERBS.has(a.action)
        const coreId = requiredCoreIdForAction(a)
        const explicitCore = coreSummaryById.get(coreId) || coreSummaryById.get(id)
        if (requiresCore && !explicitCore) {
          stats.missing_core_summary += 1
          rejectedActionIds.push(id)
          __mixdogMemoryLog(`[cycle2] non-archive action rejected: missing explicit core line id=${id} action=${a.action}\n`)
          continue
        }

        // Cascade override: drop a tentatively-kept entry → archive.
        if (a.action === 'active' && cascadeVerdicts.get(id) === 'drop') {
          cascadeDropArchiveIds.push(id)
          accepted = true
          reviewedIds.push(id)
          continue
        }

        if (a.action === 'active') {
          if (row.status === 'pending') {
            statusBatch.push({ entry_id: id, new_status: 'active', was_pending: true })
          } else if (row.status === 'active') {
            stats.kept += 1
          }
          await setCoreSummary(id, explicitCore)
          accepted = true
        } else if (a.action === 'archived') {
          statusBatch.push({ entry_id: id, new_status: 'archived', was_pending: row.status === 'pending' })
          accepted = true
        } else if (a.action === 'update') {
          if (await applyUpdate(db, id, a.element, a.summary, { signal })) stats.updated += 1
          await setCoreSummary(id, explicitCore)
          accepted = true
        } else if (a.action === 'merge') {
          const sourceIds = Array.isArray(a.source_ids) ? a.source_ids : []
          const targetId = Number(a.target_id)
          if (!Number.isFinite(targetId) || sourceIds.length === 0) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            continue
          }
          if (targetId !== id && !sourceIds.map(Number).includes(id)) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            __mixdogMemoryLog(
              `[cycle2] merge rejected during apply: id=${id} target=${targetId} sources=${sourceIds.join(',')}\n`,
            )
            continue
          }
          // Bounded-erosion invariant: a merge may only consolidate entries
          // that are themselves candidates in this batch. Otherwise a single
          // rechecked active row could list source_ids pointing at active
          // entries outside the batch (e.g. ids drawn from the activeContext
          // reference list), and applyMerge would archive those too —
          // un-judged and beyond the rolling-recheck quota. Out-of-batch
          // target/source ids are rejected; a true duplicate of an existing
          // active entry is handled by the `archived` verdict instead.
          if (![targetId, ...sourceIds.map(Number)].every(mid => rowsById.has(mid))) {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
            __mixdogMemoryLog(
              `[cycle2] merge rejected: out-of-batch target/source (target=${targetId} sources=${sourceIds.join(',')})\n`,
            )
            continue
          }
          const moved = await applyMerge(db, targetId, sourceIds, { signal })
          throwIfAborted(signal)
          if (moved > 0) {
            stats.merged += moved
            if (typeof a.element === 'string' || typeof a.summary === 'string') {
              try { if (await applyUpdate(db, targetId, a.element, a.summary, { signal })) stats.updated += 1 }
              catch (err) {
                if (signal?.aborted) throw signal.reason ?? err
                __mixdogMemoryLog(`[cycle2] merge target update failed (target=${targetId}): ${err.message}\n`)
              }
            }
            await setCoreSummary(targetId, explicitCore)
            accepted = true
          } else {
            stats.merge_rejected += 1
            rejectedActionIds.push(id)
          }
        }
        if (accepted) reviewedIds.push(id)
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[cycle2] action error (id=${id}): ${err.message}\n`)
      }
    }

    if (statusBatch.length > 0) {
      // Status verdicts are applied as one SQL batch; checkpoint before the
      // batch and then again at the next cycle2 unit boundary.
      throwIfAborted(signal)
      const batchRes = await applyBatchStatusVerdicts(db, statusBatch, nowMs)
      stats.promoted += batchRes.promoted
      stats.archived += batchRes.archived
    }

    if (cascadeDropArchiveIds.length > 0) {
      throwIfAborted(signal)
      const r = await db.query(`UPDATE entries SET status = 'archived' WHERE id = ANY($1::bigint[]) AND is_root = 1`, [cascadeDropArchiveIds])
      stats.cascade.dropped += Number(r.rowCount ?? r.affectedRows ?? 0)
      stats.archived += Number(r.rowCount ?? r.affectedRows ?? 0)
    }
    if (reviewedIds.length > 0) {
      throwIfAborted(signal)
      await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = ANY($2::bigint[])`, [sweepCursor, reviewedIds])
    }
    if (rejectedActionIds.length > 0) {
      throwIfAborted(signal)
      await db.query(
        `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = ANY($1::bigint[])`,
        [[...new Set(rejectedActionIds)]],
      )
    }
  } else if (rows.length > 0) {
    // Parse failure — bump error_count and advance reviewed_at so the
    // failing row sorts to the back of reviewed_at ASC NULLS FIRST (see
    // ~:1067-1073), matching CYCLE1_OMITTED_COOLDOWN_MS-style cooldown
    // semantics instead of spinning forever on the same row.
    for (const r of rows) {
      throwIfAborted(signal)
      try {
        await db.query(
          `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1, reviewed_at = $1 WHERE id = $2`,
          [sweepCursor, r.id],
        )
      } catch {}
    }
  }

  // Rejected verb rows: advance reviewed_at + bump error_count so an all-reject
  // batch does not loop forever. error_count ASC sort pushes them to the back.
  if (gateResult.rejected && gateResult.rejected.size > 0) {
    stats.rejected_verb = gateResult.rejected.size
    for (const id of gateResult.rejected) {
      throwIfAborted(signal)
      try {
        await db.query(`UPDATE entries SET reviewed_at = $1 WHERE id = $2`, [sweepCursor, id])
        await db.query(
          `UPDATE entries SET error_count = COALESCE(error_count, 0) + 1 WHERE id = $1`,
          [id],
        )
      } catch {}
    }
  }

  // Flush embeddings BEFORE phase_merge: newly promoted/dirty roots have
  // NULL embeddings until the dirty queue drains, and runPhaseMerge filters
  // on `embedding IS NOT NULL` for both the cosine dedup and the core-overlap
  // pass. Running the flush after the merge would skip those rows for an
  // entire cycle. Reordering ensures same-cycle dedup/core-overlap sees them.
  try {
    throwIfAborted(signal)
    const d = await flushEmbeddingDirty(db, { signal })
    throwIfAborted(signal)
    if (d.attempted > 0) {
      __mixdogMemoryLog(
        `[cycle2] embedding flush attempted=${d.attempted} ok=${d.succeeded} failed=${d.failed.length}\n`,
      )
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[cycle2] embedding flush failed: ${err.message}\n`)
  }

  // phase_merge: cosine dedup over active entries.
  const phaseMergeStats = await runPhaseMerge(db, { ...options, signal })
  throwIfAborted(signal)
  stats.phase_merge = phaseMergeStats

  // Core-candidate nomination (proposal mode): flag strong durable active
  // roots as core-memory candidates for user approval. Runs AFTER phase_merge
  // so its core_overlap sweep has already archived active entries that restate
  // an existing core row — nomination never re-surfaces those. NEVER
  // auto-inserts into core_entries; the user promotes via action:'core'
  // op:'promote'. Best-effort: a failure here must not fail the cycle.
  if (dataDir) {
    try {
      throwIfAborted(signal)
      stats.core_candidates_nominated = await nominateCoreCandidates(dataDir, { signal })
      throwIfAborted(signal)
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[cycle2] core-candidate nomination failed: ${err.message}\n`)
    }
  }

  // Active-cap enforcement is delegated to the gate (phases 1-3): the prompt
  // exposes Active/cap counts and instructs aggressive `archived` verdicts on
  // overflow. No deterministic safety net here — if the gate ever fails to
  // contain growth, fix the prompt, not bolt a fallback back on.

  __mixdogMemoryLog(
    `[cycle2] rescore=${stats.rescore.updated}` +
    ` core_backfill=${stats.core_embedding_backfill}` +
    ` active=${activeCount}/${activeTargetCap} review_active=${reviewActiveRows ? 1 : 0}` +
    ` | gate promoted=${stats.promoted} archived=${stats.archived}` +
    ` updated=${stats.updated} kept=${stats.kept}` +
    ` rejected_verb=${stats.rejected_verb} merge_rejected=${stats.merge_rejected}` +
    ` missing_core=${stats.missing_core_summary}` +
    ` | cascade eval=${stats.cascade.evaluated} drop=${stats.cascade.dropped}` +
    ` | phase_merge merged=${stats.phase_merge.merged} core_overlap=${stats.phase_merge.core_overlap || 0}` +
    ` llm=${stats.phase_merge.llm_calls}` +
    ` | core_candidates=${stats.core_candidates_nominated || 0}\n`,
  )

  return stats
}

export function parseInterval(s) {
  if (String(s).toLowerCase() === 'immediate') return 0
  const match = String(s).match(/^(\d+)(s|m|h)$/)
  if (!match) throw new Error(`[memory-cycle2] invalid interval config: ${s}`)
  const [, num, unit] = match
  const multiplier = { s: 1000, m: 60000, h: 3600000 }
  return Number(num) * multiplier[unit]
}
