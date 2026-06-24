const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { embedText, getEmbeddingModelId } from './embedding-provider.mjs'
import { embeddingToSql } from './memory.mjs'
import { createHash } from 'crypto'

// Restart-survivable embedding dedup cache (DDL created on first flush).
// Keyed per-db handle so a second DB instance in the same process re-runs the
// IF NOT EXISTS DDL on its own connection rather than skipping based on a
// flag set by a different DB.
const _embCacheReady = new WeakSet()

export function inferChunkProjectId(members) {
  const storedIds = new Set()
  for (const m of members) {
    if (m.project_id != null) storedIds.add(m.project_id)
  }
  if (storedIds.size === 1) return [...storedIds][0]
  return null
}

const _flushInFlight = new WeakMap()

const _rawTimeout = Number(process.env.MIXDOG_EMBED_FLUSH_TIMEOUT_MS)
const EMBED_FLUSH_TIMEOUT_MS = (Number.isFinite(_rawTimeout) && _rawTimeout > 0) ? _rawTimeout : 30_000

const BATCH_SIZE = 32

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

async function ensureEmbCacheTable(db) {
  if (_embCacheReady.has(db)) return
  await db.query(`
    CREATE TABLE IF NOT EXISTS memory.embedding_cache (
      model_id  text        NOT NULL,
      text_hash bytea       NOT NULL,
      vector    halfvec     NOT NULL,
      PRIMARY KEY (model_id, text_hash)
    )
  `)
  _embCacheReady.add(db)
}

// Batch variant: resolve cache hits in one SELECT WHERE hash IN (...),
// embed misses in parallel, then bulk-INSERT new entries.
export async function cachedEmbedTextBatch(db, texts, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  if (texts.length === 0) return []
  await ensureEmbCacheTable(db)
  throwIfAborted(signal)
  // Key cache rows by the provider's real model id, not the env override —
  // env may be unset while the provider still has a concrete model, and an
  // env value that doesn't match the provider would tag vectors with a
  // stale/wrong label across model/env changes.
  const modelId = getEmbeddingModelId() || process.env.MIXDOG_EMBED_MODEL || 'default'
  const entries = texts.map(t => ({
    text: t,
    hash: Buffer.from(createHash('sha256').update(t).digest()),
  }))

  // Single SELECT for all hashes
  const hashBufs = entries.map(e => e.hash)
  const hits = (await db.query(
    `SELECT text_hash, vector FROM memory.embedding_cache WHERE model_id=$1 AND text_hash = ANY($2::bytea[])`,
    [modelId, hashBufs],
  )).rows
  throwIfAborted(signal)
  // Issue 6: pgvector/halfvec returns a text string like "[0.1,0.2,...]".
  // Array.from on a string yields individual characters — parse to numeric array.
  const hitMap = new Map(hits.map(r => [
    r.text_hash.toString('hex'),
    typeof r.vector === 'string'
      ? r.vector.replace(/^\[|\]$/g, '').split(',').map(Number)
      : Array.from(r.vector),
  ]))

  // Embed misses in parallel
  const misses = entries.filter(e => !hitMap.has(e.hash.toString('hex')))
  if (misses.length > 0) {
    throwIfAborted(signal)
    await Promise.all(misses.map(async (e) => {
      e.vector = await embedText(e.text)
    }))
    throwIfAborted(signal)
    // Bulk INSERT misses
    await db.query(
      `INSERT INTO memory.embedding_cache (model_id, text_hash, vector)
       SELECT $1, unnest($2::bytea[]), unnest($3::text[])::halfvec
       ON CONFLICT (model_id, text_hash) DO NOTHING`,
      [
        modelId,
        misses.map(e => e.hash),
        misses.map(e => embeddingToSql(e.vector)),
      ],
    )
    throwIfAborted(signal)
    for (const e of misses) hitMap.set(e.hash.toString('hex'), e.vector)
  }

  return entries.map(e => hitMap.get(e.hash.toString('hex')) ?? null)
}

export async function flushEmbeddingDirty(db, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  // Coalesce concurrent flush calls per db handle.
  const inFlight = _flushInFlight.get(db)
  if (inFlight) return inFlight
  const p = (async () => {
    let totalAttempted = 0
    let totalSucceeded = 0
    let timedOut = false
    const allFailed = []
    const deadline = Date.now() + EMBED_FLUSH_TIMEOUT_MS
    let cursor = 0
    await ensureEmbCacheTable(db)
    throwIfAborted(signal)

    while (true) {
      throwIfAborted(signal)
      if (Date.now() >= deadline) {
        __mixdogMemoryLog(
          `[embed] flush timed out after ${EMBED_FLUSH_TIMEOUT_MS / 1000}s; proceeding with partial state\n`,
        )
        timedOut = true
        break
      }

      // Claim a disjoint batch via SKIP LOCKED on a dedicated connection.
      // Hold the transaction open across the embedding write so another flush
      // (different process / db handle) cannot re-claim the same ids mid-flight.
      // The protected work routes through `client` so the UPDATE runs on the
      // same connection that owns the row locks (a different pool connection
      // would block on FOR UPDATE).
      const client = await db._pool.connect()
      let ids
      try {
        throwIfAborted(signal)
        await client.query('BEGIN')
        const res = await client.query(
          `SELECT id FROM memory.entries
           WHERE is_root = 1 AND embedding IS NULL
             AND (element IS NOT NULL OR summary IS NOT NULL)
             AND id > $2
           ORDER BY id
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [BATCH_SIZE, cursor],
        )
        ids = res.rows.map(r => Number(r.id))
        throwIfAborted(signal)
      } catch (err) {
        try { await client.query('ROLLBACK') } catch {}
        client.release()
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[embed] flush SKIP LOCKED claim failed: ${err.message}\n`)
        break
      }

      if (ids.length === 0) {
        try { await client.query('COMMIT') } catch {}
        client.release()
        break
      }

      cursor = ids[ids.length - 1]
      totalAttempted += ids.length
      let batchDone = false
      try {
        // One embedding flush batch owns row locks until COMMIT/ROLLBACK;
        // cancellation is checked before each batch and after its locked work.
        throwIfAborted(signal)
        const writtenIds = await syncBatchEmbeddings(client, ids, { signal })
        totalSucceeded += writtenIds.length
        if (writtenIds.length < ids.length) {
          // Track per-id: only the ids that did NOT receive an embedding
          // (no text, dim mismatch, stale write) count as failed.
          const writtenSet = new Set(writtenIds)
          for (const id of ids) {
            if (!writtenSet.has(id)) allFailed.push(id)
          }
        }
        batchDone = true
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err
        __mixdogMemoryLog(`[embed] batch failed (ids=${ids[0]}..${ids[ids.length-1]}): ${err.message}\n`)
        for (const id of ids) allFailed.push(id)
      } finally {
        try {
          if (batchDone) await client.query('COMMIT')
          else await client.query('ROLLBACK')
        } catch {}
        client.release()
      }

      if (ids.length < BATCH_SIZE) break
    }

    return { attempted: totalAttempted, succeeded: totalSucceeded, failed: allFailed, timedOut }
  })()
  _flushInFlight.set(db, p)
  try {
    return await p
  } finally {
    _flushInFlight.delete(db)
  }
}

// Batch-embed all ids in one DB round-trip for fetching, one API call per unique text,
// then one VALUES UPDATE for all results.
// Returns the list of ids that were actually UPDATEd with a fresh embedding.
// Empty result means no ids landed (e.g. all had empty text, dim mismatches,
// or text changed since read). Callers may compare result.length to ids.length
// for per-id success tracking.
async function syncBatchEmbeddings(db, ids, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  // 1. Fetch element+summary for all ids in one query
  const rows = (await db.query(
    `SELECT id, element, summary FROM memory.entries WHERE id = ANY($1::bigint[]) AND is_root = 1`,
    [ids],
  )).rows
  throwIfAborted(signal)
  if (rows.length === 0) return []

  // 2. Fetch dims from meta once
  const dimsRow = (await db.query(`SELECT value FROM memory.meta WHERE key = 'embedding.current_dims'`)).rows[0]
  throwIfAborted(signal)
  const expected = Number(dimsRow?.value ?? 0)

  // 3. Embed each row via batch cache lookup (one SELECT + one INSERT for misses)
  const texts = rows.map(row => [row.element, row.summary].filter(Boolean).join(' — ').trim())
  const vectors = await cachedEmbedTextBatch(db, texts.filter(Boolean), { signal })
  throwIfAborted(signal)
  // Re-map: only non-empty texts were passed to cachedEmbedTextBatch
  let vecIdx = 0
  const updates = []  // { id, element, summary, vector }
  for (let i = 0; i < rows.length; i++) {
    throwIfAborted(signal)
    const row = rows[i]
    if (!texts[i]) continue
    const vector = vectors[vecIdx++]
    if (!Array.isArray(vector) || vector.length === 0) continue
    if (Number.isFinite(expected) && expected > 0 && vector.length !== expected) {
      __mixdogMemoryLog(`[embed] dim mismatch (id=${row.id} got=${vector.length} expected=${expected})\n`)
      continue
    }
    updates.push({ id: Number(row.id), element: row.element, summary: row.summary, vector })
  }

  if (updates.length === 0) return []

  // 4. Bulk UPDATE using VALUES list
  // The VALUES update is one SQL batch; do not split it with an abort checkpoint.
  const valClauses = updates.map((u, i) => {
    const base = i * 4
    return `($${base+1}::bigint, $${base+2}::halfvec, $${base+3}::text, $${base+4}::text)`
  })
  const params = []
  for (const u of updates) {
    params.push(u.id, embeddingToSql(u.vector), u.element, u.summary)
  }
  const res = await db.query(
    `UPDATE memory.entries AS e
     SET embedding = t.vector
     FROM (VALUES ${valClauses.join(',')}) AS t(id, vector, element, summary)
     WHERE e.id = t.id AND e.is_root = 1
       AND e.embedding IS NULL
       AND e.element IS NOT DISTINCT FROM t.element
       AND e.summary IS NOT DISTINCT FROM t.summary
     RETURNING e.id`,
    params,
  )
  throwIfAborted(signal)
  const writtenIds = (res.rows || []).map(r => Number(r.id))
  if (writtenIds.length < updates.length) {
    __mixdogMemoryLog(`[embed-sync] ${updates.length - writtenIds.length} stale-write(s) skipped — text changed since read\n`)
  }
  return writtenIds
}

// Kept for external callers that still import syncRootEmbedding directly.
export async function syncRootEmbedding(db, rootId, options = {}) {
  const writtenIds = await syncBatchEmbeddings(db, [rootId], options)
  return writtenIds.length > 0
}

export async function deleteRootEmbedding(db, rootId) {
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE entries SET embedding = NULL WHERE id = $1 AND is_root = 1`, [rootId])
  })
  return true
}
