const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

import { embedTexts, getEmbeddingModelId } from './embedding-provider.mjs'
import { embeddingToSql } from './memory.mjs'
import { createHash } from 'crypto'

// Restart-survivable embedding dedup cache (DDL created on first flush).
// Keyed per-db handle so a second DB instance in the same process re-runs the
// IF NOT EXISTS DDL on its own connection rather than skipping based on a
// flag set by a different DB.
const _embCacheReady = new WeakSet()

// Opportunistic retention for embedding_cache. Unbounded growth otherwise:
// every distinct embedded text leaves a permanent row. Prune by row-count cap
// (oldest inserted rows first) so the working set of hot vectors survives while
// the tail is reclaimed. Applied opportunistically after cache writes, rate-
// limited per db handle so it never runs on the hot path more than once/interval.
const EMB_CACHE_MAX_ROWS = (() => {
  const n = Number(process.env.MIXDOG_EMBED_CACHE_MAX_ROWS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200_000
})()
const EMB_CACHE_PRUNE_INTERVAL_MS = 10 * 60_000
const _embCachePruneAt = new WeakMap() // db → next-allowed prune epoch ms

async function maybePruneEmbCache(db) {
  const now = Date.now()
  const next = _embCachePruneAt.get(db) ?? 0
  if (now < next) return
  _embCachePruneAt.set(db, now + EMB_CACHE_PRUNE_INTERVAL_MS)
  try {
    // Only prune when actually over the cap.
    const { rows } = await db.query(`SELECT count(*)::bigint AS n FROM memory.embedding_cache`)
    let over = Number(rows?.[0]?.n ?? 0) - EMB_CACHE_MAX_ROWS
    if (over <= 0) return
    // Delete OLDEST rows first (ctid ascending ≈ insertion age) in bounded
    // batches so a large backlog never takes one long ACCESS-heavy DELETE that
    // locks the table. Each batch caps at PRUNE_BATCH; loop until under cap.
    const PRUNE_BATCH = 5000
    let guard = 0
    while (over > 0 && guard++ < 1000) {
      const del = await db.query(
        `DELETE FROM memory.embedding_cache
         WHERE ctid IN (
           SELECT ctid FROM memory.embedding_cache
           ORDER BY ctid ASC
           LIMIT $1
         )`,
        [Math.min(PRUNE_BATCH, over)],
      )
      const n = Number(del?.rowCount ?? 0)
      if (n === 0) break
      over -= n
    }
  } catch (err) {
    __mixdogMemoryLog(`[embed] cache prune skipped: ${err?.message || err}\n`)
  }
}

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
const RAW_EMBEDDING_ENABLED = process.env.MIXDOG_ENABLE_RAW_EMBEDDINGS === '1'
let _rawEmbeddingDisabledLogged = false

// Conservative per-text length cap applied before any text reaches the
// embedding provider. Raw transcript rows and tool-output content can be
// arbitrarily large; feeding a 14k-token string to the transformer builds a
// giant [batch, seq] tensor (observed: dims [8,14363] → ORT attempting a 79GB
// allocation before dumping the input BigInt64Array). The model only attends to
// its first ~512 tokens anyway, so truncating to a bounded char budget preserves
// recall while capping tensor size and worker RSS. ~4 chars/token → 8000 chars
// ≈ 2000 tokens, comfortably above the model window yet far below the blowup.
const _envEmbedMaxChars = Number(process.env.MIXDOG_EMBED_MAX_CHARS)
const EMBED_MAX_CHARS = (Number.isFinite(_envEmbedMaxChars) && _envEmbedMaxChars > 0)
  ? Math.floor(_envEmbedMaxChars)
  : 8000

export function truncateForEmbed(text) {
  if (typeof text !== 'string') return ''
  return text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text
}

// Raw-row dense-embed eligibility. Storage/recall rows are NEVER deleted or
// unindexed here — but the dense embedding leg should only cover useful
// CONVERSATIONAL text. Tool call/result traces and runtime/log/offload/debug/
// system notifications carry no recall value as dense vectors and pollute the
// shared embedding cache with mechanical noise, so they are excluded before
// embedding AND before batch vector mapping. An excluded row keeps its row +
// embedding-NULL storage state untouched (no delete, no schema change).
const RAW_EMBED_EXCLUDE_ROLES = new Set(['tool', 'tool_result', 'tool-result', 'function', 'system', 'log', 'offload', 'debug'])
const RAW_EMBED_EXCLUDE_CONTENT_RES = [
  /^\s*\[tool_call\b/i,
  /^\s*\[tool_result\b/i,
  /^\s*\[mixdog-runtime\]/i,
  /^\s*The async (?:shell task|agent task|\S+ execution|\S+) .*has finished\b.*review this result in your next step/i,
  /^\s*background task\b/i,
]
const RAW_EMBED_EXCLUDE_NON_CONVERSATION_CONTENT_RES = [
  /^\s*\[(?:system|log|offload|debug|trace|info|warn|warning|error|fatal)\]/i,
]
const RAW_EMBED_CONVERSATION_ROLES = new Set(['user', 'assistant'])

export function isRawEmbeddable(role, content) {
  const normRole = String(role ?? '').trim().toLowerCase()
  if (RAW_EMBED_EXCLUDE_ROLES.has(normRole)) return false
  const text = typeof content === 'string' ? content : ''
  if (!text.trim()) return false
  for (const re of RAW_EMBED_EXCLUDE_CONTENT_RES) if (re.test(text)) return false
  if (!RAW_EMBED_CONVERSATION_ROLES.has(normRole)) {
    for (const re of RAW_EMBED_EXCLUDE_NON_CONVERSATION_CONTENT_RES) if (re.test(text)) return false
  }
  return true
}

const RAW_EMBED_SQL_EXCLUDE_ROLE_VALUES = [...RAW_EMBED_EXCLUDE_ROLES]
const RAW_EMBED_SQL_ALWAYS_EXCLUDE_CONTENT_RE =
  '^\\s*(\\[tool_call\\b|\\[tool_result\\b|\\[mixdog-runtime\\]|The async (shell task|agent task|\\S+ execution|\\S+) .*has finished\\b.*review this result in your next step|background task\\b)'
const RAW_EMBED_SQL_NON_CONVERSATION_EXCLUDE_CONTENT_RE =
  '^\\s*\\[(system|log|offload|debug|trace|info|warn|warning|error|fatal)\\]'

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
  // Bound each text before hashing/embedding: the cache key and the provider
  // input are both the truncated string, so oversized rows can never build a
  // giant tensor and identical truncations dedup in-cache.
  const entries = texts.map(t => {
    const text = truncateForEmbed(t)
    return { text, hash: Buffer.from(createHash('sha256').update(text).digest()) }
  })

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

  // Embed misses through the real batch path (provider embedTexts → worker
  // embed-batch): one batched ONNX run per BATCH_SIZE chunk instead of N
  // single-embed calls fanned out via Promise.all that the worker then
  // re-serializes one at a time. Vector format/cache-key semantics unchanged.
  const misses = entries.filter(e => !hitMap.has(e.hash.toString('hex')))
  if (misses.length > 0) {
    throwIfAborted(signal)
    for (let i = 0; i < misses.length; i += BATCH_SIZE) {
      throwIfAborted(signal)
      const chunk = misses.slice(i, i + BATCH_SIZE)
      const vectors = await embedTexts(chunk.map(e => e.text))
      for (let j = 0; j < chunk.length; j++) chunk[j].vector = vectors[j]
    }
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
  // Opportunistic retention cap (rate-limited per db).
  await maybePruneEmbCache(db)

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

// Embeds raw transcript rows (is_root = 0, non-chunk-member) so the dense
// recall leg can rank them alongside root/summary entries. Mirrors
// flushEmbeddingDirty's SKIP LOCKED batch-claim structure but sources the
// embed text from `content` (raw rows have no element/summary) and honors
// `limit` as a total cap across the whole call rather than an unbounded loop.
//
// Stale-embedding safety when recap toggles back ON: cycle1's promotion
// UPDATE (memory-cycle1.mjs chunk commit) SETs summary/element, which fires
// trg_entries_embedding_invalidate (memory.mjs — BEFORE UPDATE OF content,
// summary, element; NEW.is_root=1 AND summary IS DISTINCT FROM OLD.summary)
// and NULLs the raw-content embedding written here; cycle1's end-of-cycle
// flushEmbeddingDirty (is_root=1 AND embedding IS NULL) then re-embeds the
// root from its fresh element/summary. Member leaves keep their content
// embedding — the dense recall leg resolves members to their chunk root
// (memory-recall-store.mjs member→root resolution), so that is leaf-level
// dense matching, not staleness.
export async function flushRawEmbeddings(db, options = {}) {
  const { limit = 200, signal } = options ?? {}
  throwIfAborted(signal)
  if (!RAW_EMBEDDING_ENABLED) {
    if (!_rawEmbeddingDisabledLogged) {
      __mixdogMemoryLog('[embed] raw transcript embedding disabled; only root/summary entries are embedded\n')
      _rawEmbeddingDisabledLogged = true
    }
    return { attempted: 0, embedded: 0, skipped: 'raw-embedding-disabled' }
  }
  // Optional id allow-list: restrict the SKIP LOCKED claim to a specific set of
  // rows (e.g. exactly the rows a single ingest_session call inserted) so a
  // caller can flush ONLY its own rows instead of inheriting the whole raw
  // backlog. An explicit but empty list means "nothing to do for this call"
  // and must NOT fall through to an unscoped backlog sweep.
  const idFilter = Array.isArray(options?.ids)
    ? options.ids.map(Number).filter(Number.isFinite)
    : null
  if (idFilter && idFilter.length === 0) return { attempted: 0, embedded: 0 }
  await ensureEmbCacheTable(db)
  throwIfAborted(signal)

  let attempted = 0
  let embedded = 0
  let cursor = 0

  while (attempted < limit) {
    throwIfAborted(signal)
    const batchCap = Math.min(BATCH_SIZE, limit - attempted)
    const client = await db._pool.connect()
    let ids
    try {
      throwIfAborted(signal)
      await client.query('BEGIN')
      const params = [
        batchCap,
        cursor,
        RAW_EMBED_SQL_EXCLUDE_ROLE_VALUES,
        [...RAW_EMBED_CONVERSATION_ROLES],
        RAW_EMBED_SQL_ALWAYS_EXCLUDE_CONTENT_RE,
        RAW_EMBED_SQL_NON_CONVERSATION_EXCLUDE_CONTENT_RE,
      ]
      let idClause = ''
      if (idFilter) {
        params.push(idFilter)
        idClause = ` AND id = ANY($${params.length}::bigint[])`
      }
      const res = await client.query(
        `SELECT id FROM memory.entries
         WHERE is_root = 0 AND chunk_root IS NULL AND embedding IS NULL
           AND NULLIF(btrim(session_id), '') IS NOT NULL
           AND content IS NOT NULL
           AND id > $2${idClause}
           AND lower(COALESCE(role, '')) <> ALL($3::text[])
           AND content !~* $5
           AND (lower(COALESCE(role, '')) = ANY($4::text[]) OR content !~* $6)
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        params,
      )
      ids = res.rows.map(r => Number(r.id))
      throwIfAborted(signal)
    } catch (err) {
      try { await client.query('ROLLBACK') } catch {}
      client.release()
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[embed] raw flush SKIP LOCKED claim failed: ${err.message}\n`)
      break
    }

    if (ids.length === 0) {
      try { await client.query('COMMIT') } catch {}
      client.release()
      break
    }

    cursor = ids[ids.length - 1]
    attempted += ids.length
    let batchDone = false
    try {
      throwIfAborted(signal)
      const writtenIds = await syncRawBatchEmbeddings(client, ids, { signal })
      embedded += writtenIds.length
      batchDone = true
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err
      __mixdogMemoryLog(`[embed] raw batch failed (ids=${ids[0]}..${ids[ids.length-1]}): ${err.message}\n`)
    } finally {
      try {
        if (batchDone) await client.query('COMMIT')
        else await client.query('ROLLBACK')
      } catch {}
      client.release()
    }

    if (ids.length < batchCap) break
  }

  return { attempted, embedded }
}

// Batch-embed raw transcript rows: content is the embed source text (raw
// rows have no element/summary). Mirrors syncBatchEmbeddings' shape.
async function syncRawBatchEmbeddings(db, ids, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  const rows = (await db.query(
    `SELECT id, role, content FROM memory.entries
     WHERE id = ANY($1::bigint[]) AND is_root = 0 AND chunk_root IS NULL`,
    [ids],
  )).rows
  throwIfAborted(signal)
  if (rows.length === 0) return []

  const dimsRow = (await db.query(`SELECT value FROM memory.meta WHERE key = 'embedding.current_dims'`)).rows[0]
  throwIfAborted(signal)
  const expected = Number(dimsRow?.value ?? 0)

  // Exclude tool/tool_result/log/offload/debug/system-like rows from the dense
  // embed leg (empty text ⇒ dropped below and never vector-mapped). The length
  // cap still applies to survivors via cachedEmbedTextBatch → truncateForEmbed.
  const texts = rows.map(row => (isRawEmbeddable(row.role, row.content) ? row.content.trim() : ''))
  const vectors = await cachedEmbedTextBatch(db, texts.filter(Boolean), { signal })
  throwIfAborted(signal)
  let vecIdx = 0
  const updates = []  // { id, content, vector }
  for (let i = 0; i < rows.length; i++) {
    throwIfAborted(signal)
    const row = rows[i]
    if (!texts[i]) continue
    const vector = vectors[vecIdx++]
    if (!Array.isArray(vector) || vector.length === 0) continue
    if (Number.isFinite(expected) && expected > 0 && vector.length !== expected) {
      __mixdogMemoryLog(`[embed] raw dim mismatch (id=${row.id} got=${vector.length} expected=${expected})\n`)
      continue
    }
    updates.push({ id: Number(row.id), content: row.content, vector })
  }

  if (updates.length === 0) return []

  const valClauses = updates.map((u, i) => {
    const base = i * 3
    return `($${base+1}::bigint, $${base+2}::halfvec, $${base+3}::text)`
  })
  const params = []
  for (const u of updates) {
    params.push(u.id, embeddingToSql(u.vector), u.content)
  }
  const res = await db.query(
    `UPDATE memory.entries AS e
     SET embedding = t.vector
     FROM (VALUES ${valClauses.join(',')}) AS t(id, vector, content)
     WHERE e.id = t.id AND e.is_root = 0 AND e.chunk_root IS NULL
       AND e.embedding IS NULL
       AND e.content IS NOT DISTINCT FROM t.content
     RETURNING e.id`,
    params,
  )
  throwIfAborted(signal)
  const writtenIds = (res.rows || []).map(r => Number(r.id))
  if (writtenIds.length < updates.length) {
    __mixdogMemoryLog(`[embed-sync] ${updates.length - writtenIds.length} raw stale-write(s) skipped — content changed since read\n`)
  }
  return writtenIds
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
    const writtenSet = new Set(writtenIds)
    const missed = updates.filter((u) => !writtenSet.has(u.id))
    const missedIds = missed.map((u) => u.id)
    const curRows = missedIds.length
      ? (await db.query(
          `SELECT id, embedding IS NOT NULL AS has_embedding, element, summary
           FROM memory.entries WHERE id = ANY($1::bigint[]) AND is_root = 1`,
          [missedIds],
        )).rows
      : []
    const curById = new Map(curRows.map((r) => [Number(r.id), r]))
    let staleSkips = 0
    let concurrentSkips = 0
    for (const u of missed) {
      const cur = curById.get(u.id)
      if (!cur) continue
      const textUnchanged =
        (cur.element === u.element || (cur.element == null && u.element == null)) &&
        (cur.summary === u.summary || (cur.summary == null && u.summary == null))
      if (!textUnchanged) {
        staleSkips++
        continue
      }
      if (cur.has_embedding) {
        concurrentSkips++
        continue
      }
      staleSkips++
    }
    if (staleSkips > 0) {
      __mixdogMemoryLog(`[embed-sync] ${staleSkips} stale-write(s) skipped — text changed since read\n`)
    }
    if (concurrentSkips > 0 && process.env.MIXDOG_DEBUG_EMBED) {
      __mixdogMemoryLog(`[embed-sync] ${concurrentSkips} concurrent embed write(s) skipped — already embedded\n`)
    }
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
