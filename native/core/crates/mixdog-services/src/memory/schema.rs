//! The `memory` schema: generated-history `entries`, curated `core_entries`
//! and the `meta` key/value table. Every statement is idempotent and additive,
//! so the same script creates a fresh store and brings a store written by an
//! earlier version up to date; nothing here drops or rewrites user data except
//! the vector reset when the embedding model changes.

use serde_json::json;

use crate::memory::error::Result;
use crate::memory::pg::db::Db;

/// Entry statuses, in the order of the Postgres enum.
pub const ENTRY_STATUSES: [&str; 3] = ["pending", "active", "archived"];

const BOOTSTRAP_DONE_KEY: &str = "boot.schema_bootstrap_complete";
pub(crate) const DIMS_KEY: &str = "embedding.current_dims";
const MODEL_KEY: &str = "embedding.current_model";

fn entries_ddl(dims: usize) -> String {
    format!(
        "
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'entry_status' AND n.nspname = 'memory') THEN
    CREATE TYPE memory.entry_status AS ENUM ('pending', 'active', 'archived');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS category_score_params (
  category TEXT PRIMARY KEY,
  grade    REAL NOT NULL,
  decay    REAL NOT NULL
);
INSERT INTO category_score_params(category, grade, decay) VALUES
  ('rule', 1.6, 0.25), ('constraint', 1.6, 0.25), ('decision', 1.6, 0.25), ('fact', 1.6, 0.25),
  ('goal', 1.6, 0.25), ('preference', 1.6, 0.25), ('task', 1.6, 0.25), ('issue', 1.6, 0.25)
ON CONFLICT (category) DO UPDATE SET grade = EXCLUDED.grade, decay = EXCLUDED.decay;

CREATE OR REPLACE FUNCTION compute_entry_score(category_p TEXT, last_seen_at_p BIGINT, now_ms_p BIGINT)
RETURNS REAL LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p.grade IS NULL OR last_seen_at_p IS NULL OR now_ms_p IS NULL THEN NULL::REAL
    WHEN p.decay = 0 THEN p.grade
    ELSE LEAST(p.grade,
      p.grade / POWER(1 + (GREATEST(0, (now_ms_p - last_seen_at_p)) / 86400000.0) * p.decay / 30, 0.3))::REAL
  END
  FROM category_score_params p WHERE p.category = category_p
$$;

CREATE TABLE IF NOT EXISTS entries (
  id            BIGSERIAL PRIMARY KEY,
  ts            BIGINT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  source_ref    TEXT NOT NULL UNIQUE,
  session_id    TEXT,
  project_id    TEXT,
  source_turn   INTEGER,
  time_source   TEXT,
  chunk_root    BIGINT REFERENCES entries(id) ON DELETE SET NULL,
  duplicate_of  BIGINT REFERENCES entries(id) ON DELETE SET NULL,
  concept_id    BIGINT,
  supersedes_id BIGINT REFERENCES entries(id) ON DELETE SET NULL,
  is_root       SMALLINT NOT NULL DEFAULT 0,
  element       TEXT,
  category      TEXT,
  summary       TEXT,
  chunk_quality JSONB,
  status        entry_status,
  score         REAL,
  last_seen_at  BIGINT,
  reviewed_at   BIGINT,
  error_count   INTEGER NOT NULL DEFAULT 0,
  embedding     halfvec({dims}),
  summary_hash  TEXT,
  search_tsv    tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple',  coalesce(element, '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(content, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(element, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) STORED
);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS chunk_quality jsonb;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS duplicate_of bigint REFERENCES entries(id) ON DELETE SET NULL;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS time_source text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS concept_id bigint;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS supersedes_id bigint;

CREATE TABLE IF NOT EXISTS entry_concepts (
  entry_id       BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  concept_id     BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  supersedes_id  BIGINT REFERENCES entries(id) ON DELETE SET NULL,
  created_at     BIGINT NOT NULL,
  PRIMARY KEY (entry_id, concept_id)
);
CREATE INDEX IF NOT EXISTS idx_entry_concepts_latest ON entry_concepts(concept_id, entry_id DESC);
CREATE INDEX IF NOT EXISTS idx_entry_concepts_supersedes ON entry_concepts(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_chunk_root ON entries(chunk_root) WHERE chunk_root IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_duplicate_of ON entries(duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_concept_latest ON entries(concept_id, ts DESC, id DESC) WHERE is_root = 1 AND concept_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_supersedes ON entries(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_ts_desc ON entries(ts DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session_ts ON entries(session_id, ts DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_root_status_score ON entries(status, score DESC) WHERE is_root = 1;
CREATE INDEX IF NOT EXISTS idx_entries_root_category ON entries(category, status) WHERE is_root = 1;
CREATE INDEX IF NOT EXISTS idx_entries_pending ON entries(ts DESC, id DESC) WHERE chunk_root IS NULL AND session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entries_tsv ON entries USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL;

CREATE OR REPLACE FUNCTION trg_entry_score_recalc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_root = 1 AND NEW.category IS NOT NULL THEN
    NEW.score := compute_entry_score(NEW.category, COALESCE(NEW.last_seen_at, NEW.ts),
                                     (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_entries_score ON entries;
CREATE TRIGGER trg_entries_score BEFORE INSERT OR UPDATE OF category, last_seen_at, is_root ON entries
  FOR EACH ROW EXECUTE FUNCTION trg_entry_score_recalc();

CREATE OR REPLACE FUNCTION trg_entry_embedding_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_root = 1 AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.summary IS DISTINCT FROM OLD.summary
                          OR NEW.element IS DISTINCT FROM OLD.element) THEN
    NEW.embedding := NULL;
    NEW.summary_hash := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_entries_embedding_invalidate ON entries;
CREATE TRIGGER trg_entries_embedding_invalidate BEFORE UPDATE OF content, summary, element ON entries
  FOR EACH ROW EXECUTE FUNCTION trg_entry_embedding_invalidate();
"
    )
}

const CORE_DDL: &str = "
CREATE TABLE IF NOT EXISTS core_entries (
  id          BIGSERIAL PRIMARY KEY,
  element     TEXT NOT NULL,
  summary     TEXT NOT NULL,
  category    TEXT NOT NULL,
  project_id  TEXT,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);
ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE core_entries ADD COLUMN IF NOT EXISTS archived_at bigint;
CREATE INDEX IF NOT EXISTS core_entries_project_idx ON core_entries(project_id);
CREATE INDEX IF NOT EXISTS core_entries_agent_idx ON core_entries(agent_id) WHERE agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);
";

/// A pool is keyed by (project, agent, element). The index is installed only
/// when no stored rows collide: a store with legacy duplicate keys keeps them
/// editable rather than choosing a winner at start-up.
const CORE_KEY_INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS core_entries_unique_pool_elem \
     ON core_entries (project_id, agent_id, element) NULLS NOT DISTINCT";

/// Creates or updates the `memory` schema for `dims`-dimensional vectors. When the
/// stored vectors were made by another model (different dimension or
/// identity) they are discarded and re-embedded later.
pub async fn ensure_memory_schema(db: &Db, dims: usize, model_identity: &serde_json::Value) -> Result<()> {
    db.bootstrap_schema(&entries_ddl(dims)).await?;
    db.batch(CORE_DDL).await?;
    reset_vectors_for_model(db, dims, model_identity).await?;
    install_core_key_index(db).await?;
    set_meta(db, DIMS_KEY, &json!(dims)).await?;
    set_meta(db, MODEL_KEY, model_identity).await?;
    set_meta(db, BOOTSTRAP_DONE_KEY, &json!("1")).await?;
    Ok(())
}

/// A replay's gate just before the key build (where Node's recording holds each starter of its two-starter race).
#[cfg(test)]
pub(crate) type BeforeKeyBuild = std::sync::Arc<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;
#[cfg(test)]
tokio::task_local! {
    pub(crate) static BEFORE_KEY_BUILD: BeforeKeyBuild;
}

async fn install_core_key_index(db: &Db) -> Result<()> {
    let conflict = db
        .query_opt(
            "SELECT 1 FROM core_entries GROUP BY project_id, agent_id, element HAVING COUNT(*) > 1 LIMIT 1",
            &[],
        )
        .await?;
    if conflict.is_some() {
        mixdog_rt::memory_stderr!(
            "[core-memory] duplicate keys preserved; resolve them with explicit edits/deletes before installing the unique index"
        );
        return Ok(());
    }
    // The pool key replaces the legacy (project_id, element) key, which would refuse an agent
    // memory sharing an element with a common one.
    #[cfg(test)]
    if let Ok(gate) = BEFORE_KEY_BUILD.try_with(std::sync::Arc::clone) {
        gate().await;
    }
    match db.batch(&format!("{CORE_KEY_INDEX};\nDROP INDEX IF EXISTS core_entries_unique_proj_elem")).await {
        Err(crate::memory::error::MemoryError::Pg(error)) if error.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) => {
            // A write raced the conflict check: keep both rows, install the index later.
            mixdog_rt::memory_stderr!("[core-memory] concurrent key conflict preserved; unique index deferred until explicit resolution");
            Ok(())
        }
        other => other,
    }
}

async fn reset_vectors_for_model(db: &Db, dims: usize, identity: &serde_json::Value) -> Result<()> {
    let stored_dims = db
        .query_opt(
            "SELECT a.atttypmod FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = current_schema() AND c.relname = 'entries'
                AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped",
            &[],
        )
        .await?
        .map(|row| row.get::<_, i32>(0));
    let same_identity = db
        .query_opt("SELECT value = $1::jsonb FROM meta WHERE key = $2", &[identity, &MODEL_KEY])
        .await?
        .map(|row| row.get::<_, bool>(0))
        .unwrap_or(true);
    let dims_i32 = i32::try_from(dims).unwrap_or(i32::MAX);
    match stored_dims {
        Some(stored) if stored != dims_i32 => {
            db.batch(&format!(
                "DROP INDEX IF EXISTS idx_entries_embedding_hnsw;
                 ALTER TABLE entries ALTER COLUMN embedding TYPE halfvec({dims}) USING NULL::halfvec({dims});
                 UPDATE entries SET summary_hash = NULL WHERE summary_hash IS NOT NULL;
                 CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL;"
            ))
            .await
        }
        Some(_) if !same_identity => {
            db.batch(
                "DROP INDEX IF EXISTS idx_entries_embedding_hnsw;
                 UPDATE entries SET embedding = NULL WHERE embedding IS NOT NULL;
                 UPDATE entries SET summary_hash = NULL WHERE summary_hash IS NOT NULL;
                 CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL;",
            )
            .await
        }
        _ => Ok(()),
    }
}

pub async fn set_meta(db: &Db, key: &str, value: &serde_json::Value) -> Result<()> {
    db.execute(
        "INSERT INTO meta(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
        &[&key, value],
    )
    .await?;
    Ok(())
}

/// `isBootstrapComplete`: the flag counts only while the objects it vouches for still exist.
pub async fn is_bootstrap_complete(db: &Db) -> bool {
    let check = async {
        if db.query_opt("SELECT 1 FROM meta WHERE key = $1", &[&BOOTSTRAP_DONE_KEY]).await?.is_none() {
            return Ok(false);
        }
        let schema = db.schema().name();
        let row = db
            .query_opt(
                "SELECT
                   EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                           WHERE t.typname = 'entry_status' AND n.nspname = $1)
                   AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'entries')
                   AND EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = $1 AND table_name = 'entries' AND column_name = 'status')
                   AND EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = $1 AND table_name = 'entries' AND column_name = 'chunk_root')
                   AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'meta')",
                &[&schema],
            )
            .await?;
        Ok::<_, crate::memory::error::MemoryError>(row.is_some_and(|row| row.get::<_, bool>(0)))
    };
    check.await.unwrap_or(false)
}

pub async fn get_meta(db: &Db, key: &str) -> Result<Option<serde_json::Value>> {
    Ok(db
        .query_opt("SELECT value FROM meta WHERE key = $1", &[&key])
        .await?
        .map(|row| row.get::<_, serde_json::Value>(0)))
}
