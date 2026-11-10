/**
 * entry-triggers.mjs — row triggers on entries: score recalculation and
 * embedding invalidation when the embedded text changes.
 */
export async function ensureEntryTriggers(db) {
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
  `);
  await db.exec(`DROP TRIGGER IF EXISTS trg_entries_score ON entries`);
  await db.exec(`
    CREATE TRIGGER trg_entries_score
    BEFORE INSERT OR UPDATE OF category, last_seen_at, is_root ON entries
    FOR EACH ROW
    EXECUTE FUNCTION trg_entry_score_recalc()
  `);

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
  `);
  await db.exec(`DROP TRIGGER IF EXISTS trg_entries_embedding_invalidate ON entries`);
  await db.exec(`
    CREATE TRIGGER trg_entries_embedding_invalidate
    BEFORE UPDATE OF content, summary, element ON entries
    FOR EACH ROW EXECUTE FUNCTION trg_entry_embedding_invalidate()
  `);
}
