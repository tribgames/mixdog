import { __mixdogMemoryLog } from './memory-log.mjs';
export { __mixdogMemoryLog };

// User-curated core memory store — native PG-backed via core_entries table.
// Per-project entries distinguished by project_id column (NULL = COMMON).
// addCore / editCore generate an embedding for each row and run a cosine-sim
// lookup against existing rows in the same project pool: candidates at or
// above SIM_RECALL go through an LLM "merge or distinct" judge — only the
// LLM's verdict, not the embedding score, decides whether the prior row is
// superseded in place. Below the threshold the row is INSERTed fresh.
// cycle2 reads core_entries via the {{USER_CORE}} prompt slot to avoid
// re-promoting entries that already overlap a user-curated row.

import { getDatabase, embeddingToSql } from './memory.mjs'
import { cachedEmbedTextBatch } from './memory-embed.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { checkedConnect } from './pg/adapter.mjs'

const VALID_CAT = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

// Embedding sim threshold for surfacing a candidate to the LLM judge. Wider
// than cycle2's tier-1 (0.78) on purpose: LLM verdict is authoritative so
// the recall side can afford broader recall.
const SIM_RECALL = 0.65
export const CORE_DEDUP_TOP_K = 5

export const CORE_SUMMARY_MAX = 100
export const CORE_ELEMENT_MAX = 40

function trimOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

export function normalizeCoreInput(input = {}, options = {}) {
  const summary = trimOrNull(input.summary ?? input.content)
  const element = trimOrNull(input.element) ?? (summary ? summary.slice(0, CORE_ELEMENT_MAX) : null)
  const suppliedCategory = trimOrNull(input.category)
  const category = (suppliedCategory ?? 'fact').toLowerCase()
  const errors = []

  if (options.requireElement && !element) errors.push('element required')
  if (options.requireSummary && !summary) errors.push('summary required')
  if (options.requireCategory && !suppliedCategory) errors.push('category required')
  if (element && element.length > CORE_ELEMENT_MAX) {
    errors.push(`element too long (${element.length}/${CORE_ELEMENT_MAX} chars, remove ${element.length - CORE_ELEMENT_MAX})`)
  }
  if (summary && summary.length > CORE_SUMMARY_MAX) {
    errors.push(`summary too long (${summary.length}/${CORE_SUMMARY_MAX} chars, remove ${summary.length - CORE_SUMMARY_MAX})`)
  }
  if (suppliedCategory && !VALID_CAT.has(category)) {
    errors.push(`invalid category "${category}". Valid: ${[...VALID_CAT].join(', ')}`)
  }

  return { element, summary, category, suppliedCategory, errors }
}

export function _getDb(dataDir) {
  if (!dataDir) throw new Error('core-memory: dataDir required')
  const db = getDatabase(dataDir)
  if (!db) throw new Error('core-memory: database not open — call openDatabase first')
  return db
}

async function _embedFor(db, element, summary) {
  const text = `${element}\n${summary || ''}`.trim()
  if (!text) return null
  const [vec] = await cachedEmbedTextBatch(db, [text])
  return Array.isArray(vec) ? vec : null
}

// Lazy repair of NULL embeddings on existing rows. Runs once per boot or
// whenever a NULL slips back in via direct SQL. SELECT WHERE embedding IS NULL
// returns 0 rows on a fully-populated table, so this is a fast no-op.
export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

async function _backfillNullEmbeddings(db, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  // Only refill live cores — archiveCore intentionally nulls the embedding to
  // drop archived rows from recall; refilling them would resurrect them.
  const r = await db.query(`SELECT id, element, summary FROM core_entries WHERE embedding IS NULL AND (status IS NULL OR status = 'active')`)
  if (r.rows.length === 0) return 0
  let filled = 0
  for (const row of r.rows) {
    throwIfAborted(signal)
    const vec = await _embedFor(db, row.element, row.summary)
    throwIfAborted(signal)
    if (!vec) continue
    await db.query(
      `UPDATE core_entries SET embedding = $1::halfvec WHERE id = $2 AND embedding IS NULL`,
      [embeddingToSql(vec), row.id],
    )
    filled++
  }
  if (filled > 0) {
    __mixdogMemoryLog(`[core-memory] backfilled ${filled} NULL embedding(s) on core_entries\n`)
  }
  return filled
}

export async function backfillCoreEmbeddings(dataDir, options = {}) {
  const db = _getDb(dataDir)
  return await _backfillNullEmbeddings(db, options)
}

// Boot-time invariant restoration: core_entries.id must always be the
// contiguous sequence 1..N. SERIAL only ever increments, so deleting a row
// leaves a permanent gap (e.g. 1,2,4,5 after deleting 3). This closes those
// gaps by resequencing every row globally (across all project_id pools) to
// 1..N in id order, then realigns the serial so the next INSERT continues from
// N+1. Deterministic invariant restore — no heuristic, no fallback branch.
export async function compactCoreIds(dataDir) {
  const db = _getDb(dataDir)
  // Fast no-op guard: a contiguous 1..N table has COUNT == MAX(id). This also
  // covers the empty table (n=0, mx=0) — return before any write.
  const g = await db.query(`SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS mx FROM core_entries`)
  const n = Number(g.rows[0].n)
  const mx = Number(g.rows[0].mx)
  if (n === mx) return 0

  // BEGIN transaction on ONE checked-out client — the pool wrapper db.query
  // releases the client per call, so BEGIN/COMMIT must run on one client
  // (same pattern as addCore).
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    // (a) Vacate the low range so shifted ids can't collide with the 1..N
    // target. Offset by current MAX(id): every id becomes id+mx, which is
    // strictly greater than N (N <= mx), so the resequence below is safe.
    await client.query(`UPDATE core_entries SET id = id + $1`, [mx])
    // (b) Resequence ALL rows globally to 1..N preserving id order.
    await client.query(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM core_entries
      )
      UPDATE core_entries c SET id = o.rn FROM ordered o WHERE c.id = o.id`)
    // (c) Realign the serial so the next INSERT continues from N+1. Guarded by
    // the n===mx return above, so MAX(id) is always > 0 here — setval(...,0,true)
    // is invalid and is never reached.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('core_entries','id'),
         (SELECT COALESCE(MAX(id),0) FROM core_entries), true)`)
    await client.query('COMMIT')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
  __mixdogMemoryLog(`[core-memory] compacted ${n} core id(s)\n`)
  return n
}

async function _findTopKCore(db, projectId, embedding, excludeId, { forUpdate = false } = {}) {
  if (!embedding) return []
  const exclusion = excludeId == null ? '' : 'AND id != $3'
  const sql = `
    SELECT id, element, summary, category, 1 - (embedding <=> $1::halfvec) AS sim
    FROM core_entries
    WHERE embedding IS NOT NULL
      AND project_id IS NOT DISTINCT FROM $2
      AND (status IS NULL OR status = 'active')
      ${exclusion}
    ORDER BY embedding <=> $1::halfvec
    LIMIT ${CORE_DEDUP_TOP_K}${forUpdate ? ' FOR UPDATE' : ''}`
  const params = excludeId == null
    ? [embeddingToSql(embedding), projectId]
    : [embeddingToSql(embedding), projectId, excludeId]
  const r = await db.query(sql, params)
  return r.rows.filter(row => Number(row.sim) >= SIM_RECALL)
}

async function _resolveMergeTarget(candidates, incoming) {
  for (const c of candidates) {
    if (await _llmJudgeMerge(c, incoming)) return c
  }
  return null
}

// LLM judge for "is this incoming entry a restatement of the existing one?"
// One-word reply: merge | distinct. Errors fall back to distinct so a flaky
// LLM never silently absorbs a fresh registration into an unrelated row.
async function _llmJudgeMerge(existing, incoming) {
  const prompt =
    `Two user-curated core memory entries below. Are they restating the same rule, fact, or preference (just different wording)? Reply ONE WORD: merge or distinct.\n\n` +
    `EXISTING: ${existing.element} — ${String(existing.summary || '')}\n` +
    `INCOMING: ${incoming.element} — ${String(incoming.summary || '')}`
  try {
    const raw = await callAgentDispatch({
      agent: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'core-merge-judge',
      preset: resolveMaintenancePreset('memory'),
      timeout: 30_000,
      cwd: null,
    }, prompt)
    return String(raw ?? '').trim().toLowerCase().startsWith('merge')
  } catch (err) {
    __mixdogMemoryLog(`[core-memory] LLM merge judge failed: ${err.message}\n`)
    return false
  }
}

export async function listCore(dataDir, projectId = null) {
  const db = _getDb(dataDir)
  const cols = `id, element, summary, category, project_id, created_at, updated_at`
  // Only live cores enter recall/review — archived (superseded) rows are
  // retired but retained for audit. Legacy NULL status = active.
  const live = `(status IS NULL OR status = 'active')`
  if (projectId === '*') {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE ${live} ORDER BY project_id NULLS FIRST, id ASC`)
    return r.rows
  }
  if (projectId === null) {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id IS NULL AND ${live} ORDER BY id ASC`)
    return r.rows
  }
  const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id = $1 AND ${live} ORDER BY id ASC`, [projectId])
  return r.rows
}

export async function addCore(dataDir, input, projectId) {
  if (projectId === undefined) throw new Error('addCore: projectId required — pass null for COMMON pool, or slug string for scoped pool')
  const { element: el, summary: sm, category: cat, errors } = normalizeCoreInput(input, {
    requireElement: true,
    requireSummary: true,
    requireCategory: true,
  })
  if (errors.length) throw new Error(errors.join('; '))
  const db = _getDb(dataDir)
  const now = Date.now()
  await _backfillNullEmbeddings(db)
  const embedding = await _embedFor(db, el, sm)

  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const poolKey = `core:${projectId == null ? 'COMMON' : projectId}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    const candidates = await _findTopKCore(client, projectId, embedding, null, { forUpdate: true })
    const mergeTarget = await _resolveMergeTarget(candidates, { element: el, summary: sm })
    if (mergeTarget) {
      const r = await client.query(
        `UPDATE core_entries
         SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5
         WHERE id = $6
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [el, sm, cat, embedding ? embeddingToSql(embedding) : null, now, mergeTarget.id],
      )
      await client.query('COMMIT')
      const row = r.rows[0]
      return { ...row, merged_with: mergeTarget.id, sim: Number(mergeTarget.sim).toFixed(3) }
    }
    let r
    try {
      // Savepoint so a unique-collision doesn't abort the whole tx — we recover
      // by reviving an archived row on the same connection below.
      await client.query('SAVEPOINT ins')
      r = await client.query(
        `INSERT INTO core_entries(element, summary, category, project_id, embedding, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::halfvec, $6, $7)
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [el, sm, cat, projectId, embedding ? embeddingToSql(embedding) : null, now, now],
      )
      await client.query('RELEASE SAVEPOINT ins')
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT ins')
        // Unique (project_id, element) collision. If the colliding row is an
        // archived (superseded) row, the fact is being re-asserted → revive it
        // in place: flip back to active, clear archived_at, overwrite content.
        // Avoids a partial-index migration. An active collision is a genuine
        // duplicate → surface the error.
        const revived = await client.query(
          `UPDATE core_entries
           SET summary = $1, category = $2, embedding = $3::halfvec,
               status = 'active', archived_at = NULL, updated_at = $4
           WHERE project_id IS NOT DISTINCT FROM $5 AND element = $6
             AND status = 'archived'
           RETURNING id, element, summary, category, project_id, created_at, updated_at`,
          [sm, cat, embedding ? embeddingToSql(embedding) : null, now, projectId, el],
        )
        if (revived.rows.length > 0) {
          await client.query('COMMIT')
          return { ...revived.rows[0], revived_from_archived: true }
        }
        throw new Error(`core entry already exists: project=${projectId ?? 'COMMON'} element=${JSON.stringify(el.slice(0, 200))}`)
      }
      throw err
    }
    await client.query('COMMIT')
    return r.rows[0]
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

export async function editCore(dataDir, id, patch) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = (await db.query(`SELECT * FROM core_entries WHERE id = $1`, [numId])).rows[0]
  if (!cur) throw new Error(`no entry with id=${numId}`)
  const incoming = normalizeCoreInput(patch)
  const newElement = incoming.element ?? cur.element
  const newSummary = incoming.summary ?? cur.summary
  const newCategory = incoming.suppliedCategory ? incoming.category : cur.category
  const { errors } = normalizeCoreInput({
    element: newElement,
    summary: newSummary,
    category: newCategory,
  }, {
    requireElement: true,
    requireSummary: true,
    requireCategory: true,
  })
  if (errors.length) throw new Error(errors.join('; '))
  if (newElement === cur.element && newSummary === cur.summary && newCategory === cur.category) {
    throw new Error('no change')
  }
  const now = Date.now()
  const textChanged = newElement !== cur.element || newSummary !== cur.summary
  if (!textChanged) {
    await db.query(
      `UPDATE core_entries SET category = $1, updated_at = $2 WHERE id = $3`,
      [newCategory, now, numId],
    )
    return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
  }

  await _backfillNullEmbeddings(db)
  const embedding = await _embedFor(db, newElement, newSummary)
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const poolKey = `core:${cur.project_id == null ? 'COMMON' : cur.project_id}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    const candidates = await _findTopKCore(client, cur.project_id, embedding, numId, { forUpdate: true })
    const mergeTarget = await _resolveMergeTarget(candidates, { element: newElement, summary: newSummary })
    if (mergeTarget) {
      const r = await client.query(
        `UPDATE core_entries
         SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5
         WHERE id = $6
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [newElement, newSummary, newCategory, embedding ? embeddingToSql(embedding) : null, now, mergeTarget.id],
      )
      await client.query(`DELETE FROM core_entries WHERE id = $1`, [numId])
      await client.query('COMMIT')
      const row = r.rows[0]
      return { ...row, merged_from: numId, merged_with: mergeTarget.id, sim: Number(mergeTarget.sim).toFixed(3) }
    }
    await client.query(
      `UPDATE core_entries SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5 WHERE id = $6`,
      [newElement, newSummary, newCategory, embedding ? embeddingToSql(embedding) : null, now, numId],
    )
    await client.query('COMMIT')
    return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

export async function deleteCore(dataDir, id) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const r = await db.query(`DELETE FROM core_entries WHERE id = $1 RETURNING *`, [numId])
  if (r.rows.length === 0) throw new Error(`no entry with id=${numId}`)
  return r.rows[0]
}

// Archive (retire without physical removal) a core entry whose fact was
// superseded by a newer active fact. Non-destructive: flips status to
// 'archived' + stamps archived_at so the row can be recovered/audited, and
// drops it from the recall/review pool. Safe-by-default: unlike deleteCore this
// is reversible and runs in conservative mode. Relies on the nullable status/
// archived_at columns added in ensureCurrentSchemaExtensions (no migration
// beyond those additive columns).
//
// Takes the same core:${project} advisory lock as addCore/editCore and
// re-checks the row inside it, so a concurrent addCore merge/overwrite that
// changed the fact after cycle3 read it is NOT clobbered. `expect` carries the
// element/summary cycle3 reviewed; if the live row drifted from it the archive
// is skipped (returns { skipped:true, reason:'content drift' }).
export async function archiveCore(dataDir, id, expect = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const now = Date.now()
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    // Lock ORDER must match addCore/editCore: advisory (pool) FIRST, then the
    // row FOR UPDATE — otherwise same-row concurrency deadlocks. The advisory
    // key needs project_id, so read it first WITHOUT a row lock (plain SELECT,
    // no FOR UPDATE → acquires no row lock, can't invert ordering), take the
    // pool advisory lock, THEN FOR UPDATE the row and re-validate under it.
    const pre = (await client.query(
      `SELECT project_id FROM core_entries WHERE id = $1`,
      [numId],
    )).rows[0]
    if (!pre) throw new Error(`no entry with id=${numId}`)
    const poolKey = `core:${pre.project_id == null ? 'COMMON' : pre.project_id}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    // Now take the row lock under the pool lock and re-read — a concurrent
    // addCore holding the same advisory lock may have merged/overwritten or
    // moved the row's project_id between our pre-read and the lock.
    const locked = (await client.query(
      `SELECT id, element, summary, project_id, status FROM core_entries WHERE id = $1 FOR UPDATE`,
      [numId],
    )).rows[0]
    if (!locked || !(locked.status == null || locked.status === 'active')) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    }
    // If project_id moved pools between pre-read and lock, our advisory lock is
    // on the wrong pool → bail rather than archive under a mismatched lock.
    if ((locked.project_id ?? null) !== (pre.project_id ?? null)) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'pool changed under lock' }
    }
    if (expect && (String(expect.element ?? '') !== String(locked.element ?? '') ||
                   String(expect.summary ?? '') !== String(locked.summary ?? ''))) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'content drift' }
    }
    const r = await client.query(
      `UPDATE core_entries
       SET status = 'archived', archived_at = $1, updated_at = $2, embedding = NULL
       WHERE id = $3 AND (status IS NULL OR status = 'active')
       RETURNING *`,
      [now, now, numId],
    )
    await client.query('COMMIT')
    if (r.rows.length === 0) return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    return r.rows[0]
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// Non-destructive project reclassification: move a mis-scoped core entry to the
// correct pool (a project slug, or COMMON when newProjectId is null). Only the
// project_id + updated_at change — no delete, and no re-embed (the embedding is
// derived from element/summary text, which is pool-independent). Takes BOTH the
// source and target pool advisory locks in a deterministic (sorted) order so a
// move can't deadlock with a concurrent add/edit/archive on either pool, then
// FOR UPDATEs the row and re-validates under the lock. `expect` carries the
// element/summary cycle3 reviewed; if the live row drifted, the move is skipped
// ({ skipped, reason }). A live (project_id, element) collision in the target
// pool means the fact already exists there → skipped, so the caller holds it for
// manual resolution instead of clobbering the existing row.
export async function reclassifyCore(dataDir, id, newProjectId, expect = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const targetPid = newProjectId == null ? null : (String(newProjectId).trim() || null)
  const db = _getDb(dataDir)
  const now = Date.now()
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    // Read the current pool WITHOUT a row lock first (no FOR UPDATE → acquires
    // no row lock, can't invert ordering) so the advisory locks are taken first.
    const pre = (await client.query(`SELECT project_id FROM core_entries WHERE id = $1`, [numId])).rows[0]
    if (!pre) throw new Error(`no entry with id=${numId}`)
    const curPid = pre.project_id ?? null
    if ((curPid ?? null) === (targetPid ?? null)) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'already in target pool' }
    }
    // Lock BOTH pools, sorted, so a move in the opposite direction can't deadlock.
    const keys = [...new Set([
      `core:${curPid == null ? 'COMMON' : curPid}`,
      `core:${targetPid == null ? 'COMMON' : targetPid}`,
    ])].sort()
    for (const k of keys) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k])
    const locked = (await client.query(
      `SELECT id, element, summary, project_id, status FROM core_entries WHERE id = $1 FOR UPDATE`,
      [numId],
    )).rows[0]
    if (!locked || !(locked.status == null || locked.status === 'active')) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    }
    if ((locked.project_id ?? null) !== curPid) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'pool changed under lock' }
    }
    // Reviewed-source guard: cycle3 decided this move against the pool the row
    // was in AT REVIEW time. If the row was reclassified into a THIRD pool
    // between review and now, the in-tx pre-read above sees that new pool (so
    // the pool-changed-under-lock check passes) but the move is stale → skip.
    // `expect.sourceProjectId` (null = COMMON) carries the reviewed pool.
    if (expect && 'sourceProjectId' in expect) {
      const reviewedPid = expect.sourceProjectId == null ? null : (String(expect.sourceProjectId).trim() || null)
      if ((locked.project_id ?? null) !== reviewedPid) {
        await client.query('ROLLBACK')
        return { id: numId, skipped: true, reason: 'source pool drift' }
      }
    }
    if (expect && (String(expect.element ?? '') !== String(locked.element ?? '') ||
                   String(expect.summary ?? '') !== String(locked.summary ?? ''))) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'content drift' }
    }
    // Unique (project_id, element) guard: a live row with this element already in
    // the target pool means the fact is present there → don't clobber it.
    const dup = (await client.query(
      `SELECT id FROM core_entries
       WHERE project_id IS NOT DISTINCT FROM $1 AND element = $2
         AND (status IS NULL OR status = 'active') AND id != $3
       LIMIT 1`,
      [targetPid, locked.element, numId],
    )).rows[0]
    if (dup) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: `target pool already has element (id=${dup.id})` }
    }
    let r
    try {
      await client.query('SAVEPOINT mv')
      r = await client.query(
        `UPDATE core_entries SET project_id = $1, updated_at = $2 WHERE id = $3
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [targetPid, now, numId],
      )
      await client.query('RELEASE SAVEPOINT mv')
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK')
        return { id: numId, skipped: true, reason: 'unique collision in target pool' }
      }
      throw err
    }
    await client.query('COMMIT')
    return { ...r.rows[0], from_project_id: curPid, to_project_id: targetPid }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// ─── Core-candidate promotion pipeline (proposal mode) ───────────────────────

export { nominateCoreCandidates, listCoreCandidates, promoteCoreCandidate, recoverStalePromotions, dismissCoreCandidate } from './core-memory-candidates.mjs';
