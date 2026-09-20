/**
 * entries.mjs — the entries and entry_concepts tables with every index the
 * cycle, recall and ingest queries plan against.
 */
export async function ensureEntriesSchema(db, dimCount) {
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
      cycle2_reviewed_at BIGINT,
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
  `);
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
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_chunk_root  ON entries(chunk_root) WHERE chunk_root IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_concept_latest ON entries(concept_id, ts DESC, id DESC) WHERE is_root = 1 AND concept_id IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_supersedes ON entries(supersedes_id) WHERE supersedes_id IS NOT NULL`
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_ts_desc     ON entries(ts DESC)`);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_session_ts  ON entries(session_id, ts DESC) WHERE session_id IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_root_status_score ON entries(status, score DESC) WHERE is_root = 1`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_root_category     ON entries(category, status)   WHERE is_root = 1`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_pending     ON entries(ts DESC, id DESC) WHERE chunk_root IS NULL AND session_id IS NOT NULL`
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_project     ON entries(project_id) WHERE project_id IS NOT NULL`
  );
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_tsv         ON entries USING GIN (search_tsv)`);
  // Recall CTEs (memory-recall-store.mjs dense/text legs) intentionally match
  // BOTH root and leaf/chunk rows, so their SQL has NO `is_root = 1` predicate
  // (only `embedding IS NOT NULL` / portable substring text filters).
  // The old root-only PARTIAL indexes therefore could not be used by those
  // queries — the planner fell back to a Seq Scan + top-N heapsort over every
  // embedding (verified via EXPLAIN ANALYZE). Broaden the HNSW predicate to
  // match the query shape. Substring rescue intentionally stays index-free:
  // bundled Unix PG runtimes do not include the optional pg_trgm extension.
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_embedding_hnsw ON entries USING hnsw (embedding halfvec_cosine_ops) WHERE embedding IS NOT NULL`
  );
}
