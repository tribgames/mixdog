/**
 * core-and-meta.mjs — core_entries, the meta key/value table, the cycle
 * state view and the bootstrap stamps that record which embedding model and
 * dimension the schema was built for.
 */
import { ensureCoreKeyIndex } from '../core-memory-uniqueness.mjs';

const UPSERT_META = `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;

export async function ensureCoreEntriesSchema(db, dimCount) {
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
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS core_entries_project_idx ON core_entries(project_id)`);
  await ensureCoreKeyIndex(db);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS core_entries_embedding_hnsw ON core_entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`
  );
}

export async function ensureMetaSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL
    )
  `);

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
  `);
}

export async function stampBootstrapMeta(db, dimCount, embeddingIdentity) {
  await db.query(UPSERT_META, ['embedding.current_dims', JSON.stringify(dimCount)]);
  if (embeddingIdentity != null) {
    await db.query(UPSERT_META, ['embedding.current_model', JSON.stringify(embeddingIdentity)]);
  }
  await db.query(UPSERT_META, ['boot.schema_bootstrap_complete', JSON.stringify('1')]);
}
