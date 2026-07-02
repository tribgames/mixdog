const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

// Native-PG-backed memory store. Schema, helpers, and lifecycle.

import { ensurePgInstance, closePgInstance, withSchemaBootstrapLock } from './pg/adapter.mjs'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { cleanMemoryText } from './memory-extraction.mjs'

const dbs = new Map()
const opening = new Map()

export { cleanMemoryText }

export const VALID_CATEGORY = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

export async function init(db, dims) {
  const dimCount = Number(dims)
  if (!Number.isInteger(dimCount) || dimCount <= 0) {
    throw new Error(`init: dims must be a positive integer, got ${dims}`)
  }

  // Extensions are created once by pg-adapter.bootstrapInstance; skip here.

  // Status as a real ENUM type — DB-level enforcement, B-tree friendly.
  // PG has no CREATE TYPE IF NOT EXISTS; guard via pg_type lookup so a partial
  // bootstrap (crash after CREATE TYPE but before boot.schema_bootstrap_complete)
  // can re-run init() on the next boot without colliding on the existing type.
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entry_status') THEN
        CREATE TYPE entry_status AS ENUM ('pending', 'active', 'archived');
      END IF;
    END
    $$
  `)

  // Per-category score parameters (lookup table for the score function).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS category_score_params (
      category TEXT PRIMARY KEY,
      grade    REAL NOT NULL,
      decay    REAL NOT NULL
    )
  `)
  await db.query(`
    INSERT INTO category_score_params(category, grade, decay) VALUES
      ('rule', 2.0, 0.0),
      ('constraint', 1.9, 0.06),
      ('decision', 1.8, 0.15),
      ('fact', 1.6, 0.25),
      ('goal', 1.5, 0.30),
      ('preference', 1.4, 0.35),
      ('task', 1.1, 0.45),
      ('issue', 1.0, 0.50)
    ON CONFLICT (category) DO NOTHING
  `)

  // SQL function mirrors src/memory/lib/memory-score.mjs computeEntryScore.
  // STABLE (not IMMUTABLE) because the function reads category_score_params.
  // IMMUTABLE would let the planner cache results across rows where params
  // could legitimately differ if the table is updated.
  await db.exec(`
    CREATE OR REPLACE FUNCTION compute_entry_score(
      category_p TEXT,
      last_seen_at_p BIGINT,
      now_ms_p BIGINT
    ) RETURNS REAL LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN p.grade IS NULL OR last_seen_at_p IS NULL OR now_ms_p IS NULL THEN NULL::REAL
        WHEN p.decay = 0 THEN p.grade
        ELSE LEAST(
          p.grade,
          p.grade / POWER(
            1 + (GREATEST(0, (now_ms_p - last_seen_at_p)) / 86400000.0) * p.decay / 30,
            0.3
          )
        )::REAL
      END
      FROM category_score_params p
      WHERE p.category = category_p
    $$
  `)

  await db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id            BIGSERIAL PRIMARY KEY,
      ts            BIGINT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      source_ref    TEXT NOT NULL UNIQUE,
      session_id    TEXT,
      project_id    TEXT,
      source_turn   INTEGER,
      chunk_root    BIGINT REFERENCES entries(id) ON DELETE SET NULL,
      is_root       SMALLINT NOT NULL DEFAULT 0,
      element       TEXT,
      category      TEXT,
      summary       TEXT,
      core_summary  TEXT,
      status        entry_status,
      score         REAL,
      last_seen_at  BIGINT,
      reviewed_at   BIGINT,
      promoted_at   BIGINT,
      error_count   INTEGER NOT NULL DEFAULT 0,
      embedding     halfvec(${dimCount}),
      summary_hash  TEXT,
      search_tsv    tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple',  coalesce(element, '')), 'A') ||
        setweight(to_tsvector('simple',  coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('simple',  coalesce(content, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(element, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
      ) STORED
    )
  `)

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_chunk_root  ON entries(chunk_root) WHERE chunk_root IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_ts_desc     ON entries(ts DESC)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_session_ts  ON entries(session_id, ts DESC) WHERE session_id IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_root_status_score ON entries(status, score DESC) WHERE is_root = 1`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_root_category     ON entries(category, status)   WHERE is_root = 1`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_pending     ON entries(ts DESC, id DESC) WHERE chunk_root IS NULL AND session_id IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_roots_active        ON entries(status, last_seen_at ASC, score DESC) WHERE is_root = 1 AND status = 'active'`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_project     ON entries(project_id) WHERE project_id IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_reviewed_at ON entries(reviewed_at ASC) WHERE is_root = 1`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_phase_sweep ON entries(status, is_root, error_count, reviewed_at, id)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_promoted_at ON entries(promoted_at) WHERE promoted_at IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_tsv         ON entries USING GIN (search_tsv)`)
  // Recall CTEs (memory-recall-store.mjs dense/trgm legs) intentionally match
  // BOTH root and leaf/chunk rows, so their SQL has NO `is_root = 1` predicate
  // (only `embedding IS NOT NULL` / content|element|summary text filters).
  // The old root-only PARTIAL indexes therefore could not be used by those
  // queries — the planner fell back to a Seq Scan + top-N heapsort over every
  // embedding (verified via EXPLAIN ANALYZE). Broaden the predicates to match
  // the query shape so HNSW/GIN are actually used. A `summary` trgm index is
  // added because the trgm leg also filters on `summary` but had no index.
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_content_trgm ON entries USING GIN (content gin_trgm_ops)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_element_trgm ON entries USING GIN (element gin_trgm_ops) WHERE element IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_summary_trgm ON entries USING GIN (summary gin_trgm_ops) WHERE summary IS NOT NULL`)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`)

  // BEFORE INSERT/UPDATE trigger keeps score in sync with category + last_seen_at
  // automatically; cycle code no longer needs to UPDATE entries SET score = ...
  await db.exec(`
    CREATE OR REPLACE FUNCTION trg_entry_score_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.is_root = 1 AND NEW.category IS NOT NULL THEN
        -- NOW()-to-ms conversion is intentional schema-level work; the
        -- "no EXTRACT(EPOCH …)" rule applies to ms-stored BIGINT timestamp
        -- COLUMNS, not to the trigger reading the current wall clock.
        NEW.score := compute_entry_score(
          NEW.category,
          COALESCE(NEW.last_seen_at, NEW.ts),
          (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
        );
      END IF;
      RETURN NEW;
    END;
    $$
  `)
  await db.exec(`DROP TRIGGER IF EXISTS trg_entries_score ON entries`)
  await db.exec(`
    CREATE TRIGGER trg_entries_score
    BEFORE INSERT OR UPDATE OF category, last_seen_at, promoted_at, is_root ON entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_entry_score_recalc()
  `)

  await db.exec(`
    CREATE OR REPLACE FUNCTION trg_entry_embedding_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.is_root = 1 AND (
        NEW.content IS DISTINCT FROM OLD.content OR
        NEW.summary IS DISTINCT FROM OLD.summary OR
        NEW.element IS DISTINCT FROM OLD.element
      ) THEN
        NEW.embedding := NULL;
        NEW.summary_hash := NULL;
      END IF;
      RETURN NEW;
    END;
    $$
  `)
  await db.exec(`DROP TRIGGER IF EXISTS trg_entries_embedding_invalidate ON entries`)
  await db.exec(`
    CREATE TRIGGER trg_entries_embedding_invalidate
    BEFORE UPDATE OF content, summary, element ON entries
    FOR EACH ROW EXECUTE FUNCTION trg_entry_embedding_invalidate()
  `)

  await db.exec(`
    CREATE TABLE IF NOT EXISTS core_entries (
      id          BIGSERIAL PRIMARY KEY,
      element     TEXT NOT NULL,
      summary     TEXT NOT NULL,
      category    TEXT NOT NULL,
      project_id  TEXT,
      embedding   halfvec(${dimCount}),
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `)
  await db.exec(`CREATE INDEX IF NOT EXISTS core_entries_project_idx ON core_entries(project_id)`)
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS core_entries_unique_proj_elem ON core_entries (project_id, element) NULLS NOT DISTINCT`)
  await db.exec(`CREATE INDEX IF NOT EXISTS core_entries_embedding_hnsw ON core_entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`)

  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL
    )
  `)

  // Operational view — used by /health and dashboards. One round-trip,
  // covers the metrics that previously needed 6+ COUNT queries.
  await db.exec(`
    CREATE OR REPLACE VIEW v_cycle_state AS
    SELECT
      COUNT(*) FILTER (WHERE is_root = 1) AS roots,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'pending')  AS pending,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'active')   AS active,
      COUNT(*) FILTER (WHERE is_root = 1 AND status = 'archived') AS archived,
      COUNT(*) FILTER (WHERE chunk_root IS NULL)                  AS unclassified,
      COUNT(*) AS total
    FROM entries
  `)

  // Hot active set — recall hot path uses the materialized copy. Refresh hook
  // is owned by cycle2 (after promotion/archival). Created WITH NO DATA so
  // bootstrap is fast; first refresh happens on the first cycle2 run.
  await db.exec(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hot_active AS
    SELECT id, element, summary, category, status, score, last_seen_at, promoted_at,
           project_id, embedding, search_tsv
    FROM entries
    WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
    WITH NO DATA
  `)
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mv_hot_active_id ON mv_hot_active(id)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_hnsw ON mv_hot_active USING hnsw (embedding halfvec_cosine_ops)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_tsv  ON mv_hot_active USING GIN (search_tsv)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_score ON mv_hot_active(score DESC)`)

  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ['embedding.current_dims', JSON.stringify(dimCount)],
  )
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ['boot.schema_bootstrap_complete', JSON.stringify('1')],
  )
}

async function getEmbeddingColumnDims(db, tableName) {
  const r = await db.query(`
    SELECT a.atttypmod
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = $1
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `, [tableName])
  const row = r.rows[0]
  return row ? Number(row.atttypmod) : null
}

async function ensureHotActiveSearchObjects(db) {
  await db.exec(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hot_active AS
    SELECT id, element, summary, category, status, score, last_seen_at, promoted_at,
           project_id, embedding, search_tsv
    FROM entries
    WHERE is_root = 1 AND status = 'active' AND embedding IS NOT NULL
    WITH NO DATA
  `)
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS mv_hot_active_id ON mv_hot_active(id)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_hnsw ON mv_hot_active USING hnsw (embedding halfvec_cosine_ops)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_tsv  ON mv_hot_active USING GIN (search_tsv)`)
  await db.exec(`CREATE INDEX IF NOT EXISTS mv_hot_active_score ON mv_hot_active(score DESC)`)
}

async function resetEmbeddingColumnsForDims(db, dimCount) {
  const entriesDims = await getEmbeddingColumnDims(db, 'entries')
  const coreDims = await getEmbeddingColumnDims(db, 'core_entries')
  const needsEntriesReset = entriesDims != null && entriesDims !== dimCount
  const needsCoreReset = coreDims != null && coreDims !== dimCount
  if (!needsEntriesReset && !needsCoreReset) return false

  __mixdogMemoryLog(
    `[memory] embedding dimension changed; resetting vectors for halfvec(${dimCount}) ` +
    `(entries=${entriesDims ?? 'missing'}, core_entries=${coreDims ?? 'missing'})\n`,
  )

  await db.exec(`DROP MATERIALIZED VIEW IF EXISTS mv_hot_active CASCADE`)
  await db.exec(`DROP INDEX IF EXISTS idx_entries_embedding_hnsw`)
  await db.exec(`DROP INDEX IF EXISTS core_entries_embedding_hnsw`)

  if (needsEntriesReset) {
    await db.exec(`ALTER TABLE entries ALTER COLUMN embedding TYPE halfvec(${dimCount}) USING NULL::halfvec(${dimCount})`)
    await db.exec(`UPDATE entries SET summary_hash = NULL WHERE summary_hash IS NOT NULL`)
  }
  if (needsCoreReset) {
    await db.exec(`ALTER TABLE core_entries ALTER COLUMN embedding TYPE halfvec(${dimCount}) USING NULL::halfvec(${dimCount})`)
  }

  await db.exec(`DROP TABLE IF EXISTS memory.embedding_cache`)
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ['embedding.current_dims', JSON.stringify(dimCount)],
  )
  return true
}

// Validate that the halfvec column dimension stored in the DB matches
// dimCount from the current model config. Call after schema is confirmed
// complete and before any embedding operations.
export async function validateEmbeddingDims(db, dimCount) {
  const colDims = await getEmbeddingColumnDims(db, 'entries')
  if (colDims == null) return // column absent — pre-schema DB; bootstrapSchema will handle
  // pgvector halfvec stores dimension as atttypmod directly (unlike varchar which uses dims+4).
  if (colDims !== dimCount) {
    throw new Error(
      `Embedding dimension mismatch: DB column halfvec(${colDims}) vs model config ${dimCount} dims. ` +
      `Reconfigure the embedding model or rebuild the memory store before booting.`
    )
  }
}

// One-time migration: broaden the recall indexes that were created as root-only
// PARTIAL indexes (`WHERE is_root = 1 ...`) so they match the recall CTE query
// predicates (which do NOT restrict is_root — recall matches leaf/chunk rows
// too). A stale root-only index is unusable by those queries and forces a Seq
// Scan. This runs on every boot (via ensureCurrentSchemaExtensions), so it is
// carefully guarded: it only DROP+CREATEs an index when the CURRENT definition
// still contains the `is_root = 1` predicate. Once broadened, every check is a
// cheap catalog read and no rebuild happens. Best-effort: catalog-read or DDL
// failures are logged and swallowed so a boot is never blocked by this.
async function _migrateRecallIndexesIfStale(db) {
  // Each entry: [indexName, newDefTailPredicate] where the presence of
  // "is_root" in the live indexdef signals the stale root-only shape.
  const targets = [
    { name: 'idx_entries_content_trgm',   create: `CREATE INDEX idx_entries_content_trgm ON entries USING GIN (content gin_trgm_ops)` },
    { name: 'idx_entries_element_trgm',   create: `CREATE INDEX idx_entries_element_trgm ON entries USING GIN (element gin_trgm_ops) WHERE element IS NOT NULL` },
    { name: 'idx_entries_embedding_hnsw', create: `CREATE INDEX idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL` },
  ]
  try {
    for (const t of targets) {
      let def = null
      try {
        const r = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [t.name])
        def = r.rows?.[0]?.indexdef ?? null
      } catch { def = null }
      // Missing index → post-loop IF-NOT-EXISTS ensures below self-heal trgm
      // indexes; embedding_hnsw is also re-ensured by ensureCurrentSchemaExtensions.
      if (def == null) continue
      // Already broadened (no is_root predicate) → no-op, no rebuild.
      if (!/is_root/i.test(def)) continue
      try {
        await db.exec(`DROP INDEX IF EXISTS ${t.name}`)
        await db.exec(t.create)
        __mixdogMemoryLog(`[memory] migrated stale root-only index ${t.name} → broadened to match recall query predicates\n`)
      } catch (err) {
        __mixdogMemoryLog(`[memory] recall index migration for ${t.name} failed: ${err?.message || err}\n`)
      }
    }
    // Self-heal trgm recall indexes on already-bootstrapped DBs: init() will
    // not re-run, and a missing index is not handled by the stale-shape loop
    // above (def == null → continue). These IF-NOT-EXISTS ensures recreate any
    // trgm index that never existed or whose migrate-create failed. No-op (cheap
    // catalog check) when the broadened index is already present.
    try {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_content_trgm ON entries USING GIN (content gin_trgm_ops)`)
    } catch (err) {
      __mixdogMemoryLog(`[memory] idx_entries_content_trgm ensure failed: ${err?.message || err}\n`)
    }
    try {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_element_trgm ON entries USING GIN (element gin_trgm_ops) WHERE element IS NOT NULL`)
    } catch (err) {
      __mixdogMemoryLog(`[memory] idx_entries_element_trgm ensure failed: ${err?.message || err}\n`)
    }
    try {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_summary_trgm ON entries USING GIN (summary gin_trgm_ops) WHERE summary IS NOT NULL`)
    } catch (err) {
      __mixdogMemoryLog(`[memory] idx_entries_summary_trgm ensure failed: ${err?.message || err}\n`)
    }
  } catch (err) {
    __mixdogMemoryLog(`[memory] _migrateRecallIndexesIfStale failed: ${err?.message || err}\n`)
  }
}

export async function ensureCurrentSchemaExtensions(db, dims) {
  // One-time cleanup: attachment-only placeholder rows ('(attachment)' user
  // content, e.g. Discord backend discord.mjs:724) predate the
  // shouldExcludeIngestMessage() ingest-time filter (session-ingest.mjs).
  // Delete any already-persisted rows so they stop polluting recall/cycle1.
  // Idempotent (no-op once cleaned); best-effort so a failure never blocks boot.
  try {
    const cleaned = await db.query(
      `DELETE FROM entries WHERE content = '(attachment)' AND role = 'user'`,
    )
    const n = Number(cleaned?.rowCount ?? 0)
    if (n > 0) {
      __mixdogMemoryLog(`[memory] ensureCurrentSchemaExtensions: removed ${n} attachment-only placeholder rows\n`)
    }
  } catch (err) {
    __mixdogMemoryLog(`[memory] attachment-placeholder cleanup failed: ${err?.message || err}\n`)
  }
  // core_entries gained an embedding column for cross-table semantic dedup
  // between user-curated rows and cycle2-promoted entries. ALTER + index are
  // idempotent and define the current runtime schema.
  if (Number.isInteger(dims) && dims > 0) {
    await db.exec(`ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS embedding halfvec(${dims})`)
    // One-time migration for EXISTING deployments (bootstrap-complete DBs never
    // re-run init(), so the broadened index definitions there would otherwise
    // never reach them). This path runs on EVERY boot, so we must NOT
    // unconditionally DROP+CREATE an HNSW index (that would rebuild it on every
    // startup). Only rebuild when the current index still carries the stale
    // root-only `is_root = 1` predicate; once broadened, the check is a no-op.
    await _migrateRecallIndexesIfStale(db)
    // Residual (low risk, no action needed): cycle2's root-active embedding
    // scans (memory-cycle2.mjs) now share this broader all-embedding HNSW
    // instead of a root-only partial index; acceptable at current scale.
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`)
    await db.exec(`CREATE INDEX IF NOT EXISTS core_entries_embedding_hnsw ON core_entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`)
  }
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS core_summary text`)



  // Core-candidate promotion pipeline (proposal mode): active entries the
  // cycle2 nomination pass flags as strong core-memory candidates. Never
  // auto-inserted into core_entries — a user approves each via the
  // action:'core' op:'promote' handler. Columns are nullable and the ALTERs
  // are idempotent (ADD COLUMN IF NOT EXISTS), safe to re-run every boot.
  //   core_candidate_status: NULL (not a candidate) | 'candidate' | 'promoting'
  //     (mid-flight promote, recoverable) | 'promoted' | 'dismissed'
  //   core_candidate_at:     ms timestamp of last nomination/state change
  // 'dismissed'/'promoted' are terminal for a given root so the pass never
  // re-nominates the same entry.
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS core_candidate_status text`)
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS core_candidate_at bigint`)
  // No index on core_candidate_status by design (round-2 finding #4): the only
  // readers are listCoreCandidates (user picker, on-demand) and
  // nominateCoreCandidates (once per cycle2, hourly). Both are rare and the
  // entries table is small enough that a seq scan is fine — an index isn't
  // worth the boot-time AccessExclusive build lock on the hot entries table.
  // Drop it if a previous deploy created it (idempotent no-op otherwise).
  await db.exec(`DROP INDEX IF EXISTS idx_entries_core_candidate`)

  // Dedupe core_entries before creating the unique index — keeps the row with
  // the most recent updated_at (id breaks ties), drops the rest.
  const dedupe = await db.query(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY project_id, element
               ORDER BY updated_at DESC NULLS LAST, id DESC
             ) AS rn
      FROM core_entries
    ), deleted AS (
      DELETE FROM core_entries c
      USING ranked r
      WHERE c.id = r.id AND r.rn > 1
      RETURNING c.id
    )
    SELECT count(*)::int AS n FROM deleted
  `)
  const deduped = Number(dedupe.rows?.[0]?.n ?? 0)
  if (deduped > 0) {
    __mixdogMemoryLog(`[memory] ensureCurrentSchemaExtensions: removed ${deduped} duplicate core_entries before unique index creation\n`)
  }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS core_entries_unique_proj_elem ON core_entries (project_id, element) NULLS NOT DISTINCT`)
  } catch (err) {
    __mixdogMemoryLog(`[memory] ensureCurrentSchemaExtensions: core_entries_unique_proj_elem creation failed — duplicate rows must be deduplicated before this index can be created: ${err?.message || err}\n`)
    throw err
  }

  if (Number.isInteger(dims) && dims > 0) {
    await db.query(
      `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      ['embedding.current_dims', JSON.stringify(dims)],
    )
  }

  await ensureHotActiveSearchObjects(db)
}

export async function openDatabase(dataDir, dims) {
  const key = resolve(dataDir)

  // Fast path — already resolved.
  if (dbs.get(key)) return dbs.get(key)

  // Dedupe concurrent callers — return the in-flight Promise if one exists.
  if (opening.has(key)) return opening.get(key)

  const promise = (async () => {
    mkdirSync(key, { recursive: true })

    const { db, pool } = await ensurePgInstance(dataDir, { schema: 'memory' })

    if (!(await isBootstrapComplete(db))) {
      // Serialize the schema/CREATE TYPE bootstrap across concurrent first-boot
      // processes with a cluster-global advisory lock. Re-check completion once
      // the lock is held (double-checked locking) so a worker that lost the
      // race skips the redundant DDL instead of re-running init().
      await withSchemaBootstrapLock(pool, async () => {
        if (!(await isBootstrapComplete(db))) {
          await init(db, dims)
        }
      })
    }
    if (await isBootstrapComplete(db)) {
      await resetEmbeddingColumnsForDims(db, Number(dims))
    }
    await ensureCurrentSchemaExtensions(db, Number(dims))
    await validateEmbeddingDims(db, Number(dims))

    dbs.set(key, db)
    return db
  })()

  opening.set(key, promise)
  try {
    return await promise
  } finally {
    opening.delete(key)
  }
}

export function getDatabase(dataDir) {
  if (!dataDir) return null
  const key = resolve(dataDir)
  return dbs.get(key) ?? null
}

export async function closeDatabase(dataDir) {
  const key = resolve(dataDir)
  const db = dbs.get(key)
  if (!db) return
  try { await db.close() } catch {}
  dbs.delete(key)
  // Evict pg-adapter's instance cache too: db.close() ends the pool, but the
  // adapter still holds `instances.get(key)` pointing at the ended pool. A
  // same-process reopen would then return the dead handle. closePgInstance
  // drops the cache entry (and re-ends the pool, which is a safe no-op on
  // an already-ended pool) so the next ensurePgInstance rebuilds fresh.
  try { await closePgInstance(dataDir, { schema: 'memory' }) } catch {}
}

export async function isBootstrapComplete(db) {
  try {
    const r = await db.query(`SELECT 1 FROM meta WHERE key = 'boot.schema_bootstrap_complete'`)
    return r.rows.length > 0
  } catch {
    return false
  }
}

// Returns the raw JSON-encoded string stored in meta.value. Callers JSON.parse
// it themselves; preserves API parity with the prior TEXT column.
export async function getMetaValue(db, key, fallback = null) {
  try {
    const r = await db.query(`SELECT value::text AS v FROM meta WHERE key = $1`, [key])
    if (r.rows.length === 0) return fallback
    return r.rows[0].v ?? fallback
  } catch {
    return fallback
  }
}

// Caller passes a JSON-encoded string (e.g. JSON.stringify(obj) or a quoted
// scalar like '"v1"'). Stored verbatim into the JSONB column.
export async function setMetaValue(db, key, value) {
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value == null ? 'null' : String(value)],
  )
}

// Shallow-merge patch into an existing JSON object meta row (jsonb ||). Avoids
// read-modify-write lost updates when concurrent writers touch different keys.
export async function mergeMetaValue(db, key, patch) {
  const patchJson = typeof patch === 'string' ? patch : JSON.stringify(patch ?? {})
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = COALESCE(meta.value, '{}'::jsonb) || EXCLUDED.value`,
    [key, patchJson],
  )
}

export function embeddingToSql(arr) {
  if (!arr || !Array.isArray(arr)) return null
  return `[${arr.map((n) => Number(n).toFixed(6)).join(',')}]`
}
