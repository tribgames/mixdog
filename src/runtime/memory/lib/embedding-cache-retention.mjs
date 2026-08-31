export const DEFAULT_EMBED_CACHE_MAX_ROWS = 10_000

export function resolveEmbeddingCacheMaxRows(
  value = process.env.MIXDOG_EMBED_CACHE_MAX_ROWS,
) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_EMBED_CACHE_MAX_ROWS
}

export async function pruneEmbeddingCache(
  db,
  {
    maxRows = resolveEmbeddingCacheMaxRows(),
    batchSize = 5000,
  } = {},
) {
  const { rows } = await db.query(`SELECT count(*)::bigint AS n FROM memory.embedding_cache`)
  const count = Number(rows?.[0]?.n ?? 0)
  let over = count - maxRows
  if (over <= 0) return { removed: 0, truncated: false, remaining: count }

  // A pre-cap cache can be hundreds of MiB. DELETE would leave those physical
  // pages allocated until a blocking VACUUM FULL; this table is purely
  // regenerable, so one TRUNCATE safely returns the pages immediately.
  if (count > maxRows * 2) {
    await db.query('TRUNCATE TABLE memory.embedding_cache')
    return { removed: count, truncated: true, remaining: 0 }
  }

  let removed = 0
  let guard = 0
  while (over > 0 && guard++ < 1000) {
    const requested = Math.min(batchSize, over)
    const result = await db.query(
      `DELETE FROM memory.embedding_cache
       WHERE ctid IN (
         SELECT ctid FROM memory.embedding_cache
         ORDER BY ctid ASC
         LIMIT $1
       )`,
      [requested],
    )
    const deleted = Number(result.rowCount ?? 0)
    if (deleted === 0) break
    removed += deleted
    over -= deleted
  }
  return {
    removed,
    truncated: false,
    remaining: Math.max(0, count - removed),
  }
}
