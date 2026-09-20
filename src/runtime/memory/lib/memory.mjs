import { __mixdogMemoryLog } from './memory-log.mjs';

// Native-PG-backed memory store. Schema, helpers, and lifecycle.

import { ensurePgInstance, closePgInstance, withSchemaBootstrapLock } from './pg/adapter.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanMemoryText } from './memory-extraction.mjs';
import {
  isInternalRuntimeNotificationText,
  isModelVisibleToolCompletionWrapper,
} from '../../shared/tool-execution-contract.mjs';
import { isUnquotedToolCompletionHead } from './session-ingest.mjs';
import { ensureCoreKeyIndex } from './core-memory-uniqueness.mjs';
import { ensureScoreSchema } from './memory-schema/score-params.mjs';
import { ensureEntriesSchema } from './memory-schema/entries.mjs';
import { ensureEntryTriggers } from './memory-schema/entry-triggers.mjs';
import { ensureCoreEntriesSchema, ensureMetaSchema, stampBootstrapMeta } from './memory-schema/core-and-meta.mjs';

const dbs = new Map();
const opening = new Map();

export { cleanMemoryText };

export const VALID_CATEGORY = new Set([
  'rule',
  'constraint',
  'decision',
  'fact',
  'goal',
  'preference',
  'task',
  'issue',
]);

// Schema bootstrap, in dependency order. Extensions are created once by
// pg-adapter.bootstrapInstance; the phases live under memory-schema/.
export async function init(db, dims, embeddingIdentity = null) {
  const dimCount = Number(dims);
  if (!Number.isInteger(dimCount) || dimCount <= 0) {
    throw new Error(`init: dims must be a positive integer, got ${dims}`);
  }
  await ensureScoreSchema(db);
  await ensureEntriesSchema(db, dimCount);
  await ensureEntryTriggers(db);
  await ensureCoreEntriesSchema(db, dimCount);
  await ensureMetaSchema(db);
  await stampBootstrapMeta(db, dimCount, embeddingIdentity);
}

async function getEmbeddingColumnDims(db, tableName) {
  const r = await db.query(
    `
    SELECT a.atttypmod
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = $1
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `,
    [tableName]
  );
  const row = r.rows[0];
  return row ? Number(row.atttypmod) : null;
}

export async function resetEmbeddingColumnsForModel(db, dimCount, embeddingIdentity = null) {
  const entriesDims = await getEmbeddingColumnDims(db, 'entries');
  const coreDims = await getEmbeddingColumnDims(db, 'core_entries');
  const normalizedIdentity = embeddingIdentity == null ? null : JSON.stringify(embeddingIdentity);
  let identityChanged = false;
  if (normalizedIdentity != null) {
    const identity = await db.query(`SELECT value = $2::jsonb AS matches FROM meta WHERE key = $1`, [
      'embedding.current_model',
      normalizedIdentity,
    ]);
    identityChanged = identity.rows.length === 0 || identity.rows[0].matches !== true;
  }
  const needsEntriesReset = entriesDims != null && (entriesDims !== dimCount || identityChanged);
  const needsCoreReset = coreDims != null && (coreDims !== dimCount || identityChanged);
  if (!needsEntriesReset && !needsCoreReset) return false;

  __mixdogMemoryLog(
    `[memory] embedding model changed; resetting vectors for halfvec(${dimCount}) ` +
      `(entries=${entriesDims ?? 'missing'}, core_entries=${coreDims ?? 'missing'})\n`
  );

  // Old installations may still have a derived view depending on embedding.
  // Release that dependency only during a model migration; never recreate it.
  await db.exec(`DROP MATERIALIZED VIEW IF EXISTS mv_hot_active CASCADE`);
  await db.exec(`DROP INDEX IF EXISTS idx_entries_embedding_hnsw`);
  await db.exec(`DROP INDEX IF EXISTS core_entries_embedding_hnsw`);

  if (needsEntriesReset) {
    if (entriesDims !== dimCount) {
      await db.exec(
        `ALTER TABLE entries ALTER COLUMN embedding TYPE halfvec(${dimCount}) USING NULL::halfvec(${dimCount})`
      );
    } else {
      await db.exec(`UPDATE entries SET embedding = NULL WHERE embedding IS NOT NULL`);
    }
    await db.exec(`UPDATE entries SET summary_hash = NULL WHERE summary_hash IS NOT NULL`);
  }
  if (needsCoreReset) {
    if (coreDims !== dimCount) {
      await db.exec(
        `ALTER TABLE core_entries ALTER COLUMN embedding TYPE halfvec(${dimCount}) USING NULL::halfvec(${dimCount})`
      );
    } else {
      await db.exec(`UPDATE core_entries SET embedding = NULL WHERE embedding IS NOT NULL`);
    }
  }

  await db.exec(`DROP TABLE IF EXISTS memory.embedding_cache`);
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    ['embedding.current_dims', JSON.stringify(dimCount)]
  );
  if (normalizedIdentity != null) {
    await db.query(
      `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      ['embedding.current_model', normalizedIdentity]
    );
  }
  return true;
}

// Validate that the halfvec column dimension stored in the DB matches
// dimCount from the current model config. Call after schema is confirmed
// complete and before any embedding operations.
async function validateEmbeddingDims(db, dimCount) {
  const colDims = await getEmbeddingColumnDims(db, 'entries');
  if (colDims == null) return; // column absent — pre-schema DB; bootstrapSchema will handle
  // pgvector halfvec stores dimension as atttypmod directly (unlike varchar which uses dims+4).
  if (colDims !== dimCount) {
    throw new Error(
      `Embedding dimension mismatch: DB column halfvec(${colDims}) vs model config ${dimCount} dims. ` +
        `Reconfigure the embedding model or rebuild the memory store before booting.`
    );
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
    {
      name: 'idx_entries_embedding_hnsw',
      create: `CREATE INDEX idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`,
    },
  ];
  try {
    for (const t of targets) {
      let def = null;
      try {
        const r = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [t.name]);
        def = r.rows?.[0]?.indexdef ?? null;
      } catch {
        def = null;
      }
      // Missing embedding_hnsw is re-ensured by ensureCurrentSchemaExtensions.
      if (def == null) continue;
      // Already broadened (no is_root predicate) → no-op, no rebuild.
      if (!/is_root/i.test(def)) continue;
      try {
        await db.exec(`DROP INDEX IF EXISTS ${t.name}`);
        await db.exec(t.create);
        __mixdogMemoryLog(
          `[memory] migrated stale root-only index ${t.name} → broadened to match recall query predicates\n`
        );
      } catch (err) {
        __mixdogMemoryLog(`[memory] recall index migration for ${t.name} failed: ${err?.message || err}\n`);
      }
    }
  } catch (err) {
    __mixdogMemoryLog(`[memory] _migrateRecallIndexesIfStale failed: ${err?.message || err}\n`);
  }
}

export async function ensureCurrentSchemaExtensions(db, dims, embeddingIdentity = null) {
  // One-time cleanup: attachment-only placeholder rows ('(attachment)' user
  // content, e.g. Discord provider discord.mjs:724) predate the
  // shouldExcludeIngestMessage() ingest-time filter (session-ingest.mjs).
  // Delete any already-persisted rows so they stop polluting recall/cycle1.
  // Idempotent (no-op once cleaned); best-effort so a failure never blocks boot.
  try {
    const cleaned = await db.query(`DELETE FROM entries WHERE content = '(attachment)' AND role = 'user'`);
    const n = Number(cleaned?.rowCount ?? 0);
    if (n > 0) {
      __mixdogMemoryLog(`[memory] ensureCurrentSchemaExtensions: removed ${n} attachment-only placeholder rows\n`);
    }
  } catch (err) {
    __mixdogMemoryLog(`[memory] attachment-placeholder cleanup failed: ${err?.message || err}\n`);
  }
  // One-time cleanup: runtime tool-completion notification rows ("Async ...
  // finished." followed by an unquoted or `> `-quoted Result body, and
  // "[mixdog-runtime] ..." nudges) that were persisted by the transcript
  // watcher before it gained the shouldExcludeIngestMessage exclusion
  // (transcript-ingest.mjs). Gated by a meta flag so this DELETE runs at
  // most once ever, not on every boot (mirrors boot.schema_bootstrap_complete).
  // SQL prefilter narrows candidates to role='user' rows only; the DELETE
  // itself only fires for rows the SAME JS predicates ingest applies confirm
  // as internal-runtime text — a row that merely starts with "background
  // task" prose is never deleted unless isInternalRuntimeNotificationText
  // (or the instruction-head match) itself confirms it. Best-effort so a
  // failure never blocks boot.
  const NOTIFICATION_CLEANUP_META_KEY = 'cleanup.notification_rows_v1';
  try {
    const already = await db.query(`SELECT 1 FROM meta WHERE key = $1`, [NOTIFICATION_CLEANUP_META_KEY]);
    if (!already?.rows?.length) {
      const candidates = await db.query(
        `SELECT id, content FROM entries
         WHERE role = 'user' AND (
           content LIKE 'Async % finished.%'
           OR content LIKE '[mixdog-runtime]%'
           OR content LIKE 'background task%'
         )`
      );
      const rows = Array.isArray(candidates?.rows) ? candidates.rows : [];
      const idsToDelete = rows
        .filter((row) => {
          const text = String(row?.content ?? '');
          return (
            /^\[mixdog-runtime\]/.test(text.trimStart()) ||
            isInternalRuntimeNotificationText(text) ||
            isModelVisibleToolCompletionWrapper(text) ||
            isUnquotedToolCompletionHead(text)
          );
        })
        .map((row) => row.id)
        .filter((id) => id != null);
      if (idsToDelete.length > 0) {
        const deleted = await db.query(`DELETE FROM entries WHERE id = ANY($1::bigint[])`, [idsToDelete]);
        const n = Number(deleted?.rowCount ?? idsToDelete.length);
        if (n > 0) {
          __mixdogMemoryLog(`[memory] ensureCurrentSchemaExtensions: removed ${n} runtime notification rows\n`);
        }
      }
      await db.query(
        `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
        [NOTIFICATION_CLEANUP_META_KEY, JSON.stringify('1')]
      );
    }
  } catch (err) {
    __mixdogMemoryLog(`[memory] notification-row cleanup failed: ${err?.message || err}\n`);
  }
  // User-curated entries retain their own embeddings for explicit retrieval.
  if (Number.isInteger(dims) && dims > 0) {
    await db.exec(`ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS embedding halfvec(${dims})`);
    // One-time migration for EXISTING deployments (bootstrap-complete DBs never
    // re-run init(), so the broadened index definitions there would otherwise
    // never reach them). This path runs on EVERY boot, so we must NOT
    // unconditionally DROP+CREATE an HNSW index (that would rebuild it on every
    // startup). Only rebuild when the current index still carries the stale
    // root-only `is_root = 1` predicate; once broadened, the check is a no-op.
    await _migrateRecallIndexesIfStale(db);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`
    );
    await db.exec(
      `CREATE INDEX IF NOT EXISTS core_entries_embedding_hnsw ON core_entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`
    );
  }
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS chunk_quality jsonb`);
  // Separate maintenance progress from legacy importance/status verdicts.
  // Existing content and classification values remain untouched.
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS cycle2_reviewed_at bigint`);
  await db.exec(
    `ALTER TABLE entries ADD COLUMN IF NOT EXISTS duplicate_of bigint REFERENCES entries(id) ON DELETE SET NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_duplicate_of ON entries(duplicate_of) WHERE duplicate_of IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_cycle2_unreviewed ON entries(ts DESC, id DESC) WHERE is_root = 1 AND cycle2_reviewed_at IS NULL`
  );
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS time_source text`);
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS concept_id bigint`);
  await db.exec(`ALTER TABLE entries ADD COLUMN IF NOT EXISTS supersedes_id bigint`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_concept_latest ON entries(concept_id, ts DESC, id DESC) WHERE is_root = 1 AND concept_id IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_supersedes ON entries(supersedes_id) WHERE supersedes_id IS NOT NULL`
  );
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entry_concepts (
      entry_id       BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      concept_id     BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      supersedes_id  BIGINT REFERENCES entries(id) ON DELETE SET NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (entry_id, concept_id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entry_concepts_latest ON entry_concepts(concept_id, entry_id DESC)`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entry_concepts_supersedes ON entry_concepts(supersedes_id) WHERE supersedes_id IS NOT NULL`
  );
  await db.exec(`
    INSERT INTO entry_concepts(entry_id, concept_id, supersedes_id, created_at)
    SELECT id, concept_id, supersedes_id, ts
    FROM entries
    WHERE is_root = 1 AND concept_id IS NOT NULL
    ON CONFLICT (entry_id, concept_id) DO UPDATE
      SET supersedes_id = COALESCE(EXCLUDED.supersedes_id, entry_concepts.supersedes_id)
  `);

  // Preserve archived user-curated records from older versions.
  // Legacy NULL status remains active; obsolete generated metadata is untouched.
  await db.exec(`ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS status text`);
  await db.exec(`ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS archived_at bigint`);

  await ensureCoreKeyIndex(db);

  if (Number.isInteger(dims) && dims > 0) {
    await db.query(
      `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      ['embedding.current_dims', JSON.stringify(dims)]
    );
  }
  if (embeddingIdentity != null) {
    await db.query(
      `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      ['embedding.current_model', JSON.stringify(embeddingIdentity)]
    );
  }
}

export async function openDatabase(dataDir, dims, embeddingIdentity = null) {
  const key = resolve(dataDir);

  // Fast path — already resolved.
  if (dbs.get(key)) return dbs.get(key);

  // Dedupe concurrent callers — return the in-flight Promise if one exists.
  if (opening.has(key)) return opening.get(key);

  const promise = (async () => {
    mkdirSync(key, { recursive: true });

    const { db, pool } = await ensurePgInstance(dataDir, { schema: 'memory' });

    if (!(await isBootstrapComplete(db))) {
      // Serialize the schema/CREATE TYPE bootstrap across concurrent first-boot
      // processes with a cluster-global advisory lock. Re-check completion once
      // the lock is held (double-checked locking) so a worker that lost the
      // race skips the redundant DDL instead of re-running init().
      await withSchemaBootstrapLock(pool, async () => {
        if (!(await isBootstrapComplete(db))) {
          await init(db, dims, embeddingIdentity);
        }
      });
    }
    if (await isBootstrapComplete(db)) {
      await resetEmbeddingColumnsForModel(db, Number(dims), embeddingIdentity);
    }
    await ensureCurrentSchemaExtensions(db, Number(dims), embeddingIdentity);
    await validateEmbeddingDims(db, Number(dims));

    dbs.set(key, db);
    return db;
  })();

  opening.set(key, promise);
  try {
    return await promise;
  } finally {
    opening.delete(key);
  }
}

export function getDatabase(dataDir) {
  if (!dataDir) return null;
  const key = resolve(dataDir);
  return dbs.get(key) ?? null;
}

export async function closeDatabase(dataDir) {
  const key = resolve(dataDir);
  const db = dbs.get(key);
  if (!db) return;
  try {
    await db.close();
  } catch {}
  dbs.delete(key);
  // Evict pg-adapter's instance cache too: db.close() ends the pool, but the
  // adapter still holds `instances.get(key)` pointing at the ended pool. A
  // same-process reopen would then return the dead handle. closePgInstance
  // drops the cache entry (and re-ends the pool, which is a safe no-op on
  // an already-ended pool) so the next ensurePgInstance rebuilds fresh.
  try {
    await closePgInstance(dataDir, { schema: 'memory' });
  } catch {}
}

export async function isBootstrapComplete(db) {
  try {
    const r = await db.query(`SELECT 1 FROM meta WHERE key = 'boot.schema_bootstrap_complete'`);
    if (r.rows.length === 0) return false;
    // The meta flag alone is not proof the schema is CURRENT: an older cluster
    // whose pgdata predates a column/type addition can carry the flag while the
    // physical schema has drifted, and trusting the flag would skip init() and
    // leave inserts failing forever. Verify the critical objects init() creates
    // actually exist; on drift return false so the caller re-runs init() (all
    // DDL there is IF NOT EXISTS / additive, so re-running is a safe no-op on a
    // healthy DB and self-heals a drifted one — no destructive change).
    const drift = await db.query(`
      SELECT
        EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE t.typname = 'entry_status' AND n.nspname = 'memory') AS has_status_type,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'memory' AND table_name = 'entries') AS has_entries,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'memory' AND table_name = 'entries'
                  AND column_name = 'status') AS has_status_col,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'memory' AND table_name = 'entries'
                  AND column_name = 'chunk_root') AS has_chunk_root,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'memory' AND table_name = 'meta') AS has_meta
    `);
    const d = drift.rows?.[0] ?? {};
    const healthy = d.has_status_type && d.has_entries && d.has_status_col && d.has_chunk_root && d.has_meta;
    if (!healthy) {
      __mixdogMemoryLog(
        `[memory] bootstrap flag present but schema drifted (${JSON.stringify(d)}); re-running init()\n`
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Returns the raw JSON-encoded string stored in meta.value. Callers JSON.parse
// it themselves; preserves API parity with the prior TEXT column.
export async function getMetaValue(db, key, fallback = null) {
  try {
    const r = await db.query(`SELECT value::text AS v FROM meta WHERE key = $1`, [key]);
    if (r.rows.length === 0) return fallback;
    return r.rows[0].v ?? fallback;
  } catch {
    return fallback;
  }
}

// Caller passes a JSON-encoded string (e.g. JSON.stringify(obj) or a quoted
// scalar like '"v1"'). Stored verbatim into the JSONB column.
export async function setMetaValue(db, key, value) {
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value == null ? 'null' : String(value)]
  );
}

// Shallow-merge patch into an existing JSON object meta row (jsonb ||). Avoids
// read-modify-write lost updates when concurrent writers touch different keys.
export async function mergeMetaValue(db, key, patch) {
  const patchJson = typeof patch === 'string' ? patch : JSON.stringify(patch ?? {});
  await db.query(
    `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = COALESCE(meta.value, '{}'::jsonb) || EXCLUDED.value`,
    [key, patchJson]
  );
}

export function embeddingToSql(arr) {
  if (!arr || !Array.isArray(arr)) return null;
  return `[${arr.map((n) => Number(n).toFixed(6)).join(',')}]`;
}
