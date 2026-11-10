/**
 * core-and-meta.mjs — core_entries, the meta key/value table and the
 * bootstrap stamps that record which embedding model and dimension the schema
 * was built for.
 */
import { ensureCoreKeyIndex } from '../core-memory-uniqueness.mjs';

const UPSERT_META = `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;

export async function ensureCoreEntriesSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS core_entries (
      id          BIGSERIAL PRIMARY KEY,
      element     TEXT NOT NULL,
      summary     TEXT NOT NULL,
      category    TEXT NOT NULL,
      project_id  TEXT,
      created_at  BIGINT NOT NULL,
      updated_at  BIGINT NOT NULL
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS core_entries_project_idx ON core_entries(project_id)`);
  await ensureCoreAgentColumn(db);
  await ensureCoreKeyIndex(db);
}

// An agent's own pool (core-memory-access.mjs): agent_id names it and its
// project_id stays NULL. Existing rows keep NULL, i.e. common/project memory.
// Idempotent; runs on every boot before the pool key index.
export async function ensureCoreAgentColumn(db) {
  await db.exec(`ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS core_entries_agent_idx ON core_entries(agent_id) WHERE agent_id IS NOT NULL`
  );
}

export async function ensureMetaSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key    TEXT PRIMARY KEY,
      value  JSONB NOT NULL
    )
  `);
}

export async function stampBootstrapMeta(db, dimCount, embeddingIdentity) {
  await db.query(UPSERT_META, ['embedding.current_dims', JSON.stringify(dimCount)]);
  if (embeddingIdentity != null) {
    await db.query(UPSERT_META, ['embedding.current_model', JSON.stringify(embeddingIdentity)]);
  }
  await db.query(UPSERT_META, ['boot.schema_bootstrap_complete', JSON.stringify('1')]);
}
