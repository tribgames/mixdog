/**
 * score-params.mjs — the entry status enum, per-category score parameters
 * and the SQL score function that mirrors memory-score.mjs computeEntryScore.
 */
export async function ensureScoreSchema(db) {
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
  `);

  // Per-category score parameters (lookup table for the score function).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS category_score_params (
      category TEXT PRIMARY KEY,
      grade    REAL NOT NULL,
      decay    REAL NOT NULL
    )
  `);
  await db.query(`
    INSERT INTO category_score_params(category, grade, decay) VALUES
      ('rule', 1.6, 0.25),
      ('constraint', 1.6, 0.25),
      ('decision', 1.6, 0.25),
      ('fact', 1.6, 0.25),
      ('goal', 1.6, 0.25),
      ('preference', 1.6, 0.25),
      ('task', 1.6, 0.25),
      ('issue', 1.6, 0.25)
    ON CONFLICT (category) DO UPDATE SET grade = EXCLUDED.grade, decay = EXCLUDED.decay
  `);

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
  `);
}
