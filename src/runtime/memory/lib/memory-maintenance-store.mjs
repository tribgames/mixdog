export async function pruneOldEntries(db, maxAgeDays) {
  const days = Number(maxAgeDays)
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`pruneOldEntries: maxAgeDays must be positive, got ${maxAgeDays}`)
  }
  const cutoffMs = Date.now() - days * 86_400_000
  const result = await db.query(
    `DELETE FROM entries
     WHERE ts < $1
       AND (
         chunk_root IS NULL
         OR (is_root = 0 AND chunk_root = id AND status = 'archived')
       )`,
    [cutoffMs],
  )
  // Cross-schema FK is intentionally absent (trace_events is partitioned and
  // self-FKs are fragile there). After deleting from memory.entries, NULL out
  // the dangling entry_id references on trace_events so cross-schema joins
  // (recall ↔ trace correlation) do not surface stale ids. Same PG instance
  // → fully-qualified names work from either schema's connection.
  let orphanedTraceRefs = 0
  try {
    const orphan = await db.query(
      `UPDATE trace.trace_events SET entry_id = NULL
         WHERE entry_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM memory.entries WHERE id = trace.trace_events.entry_id)`,
      [],
    )
    orphanedTraceRefs = Number(orphan.rowCount ?? 0)
  } catch { /* trace schema may be absent in early boot — no-op */ }
  return { deleted: Number(result.rowCount ?? 0), cutoffMs, orphanedTraceRefs }
}
