const CYCLE1_OMITTED_COOLDOWN_MS = 60 * 60 * 1000;
const BACKLOG_WARN_PENDING = 500;

async function countRows(db, sql, params) {
  return Number((await db.query(sql, params)).rows[0]?.c ?? 0);
}

export function countPendingCycle2Roots(db) {
  return countRows(
    db,
    `SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND cycle2_reviewed_at IS NULL AND duplicate_of IS NULL`
  );
}

// Per-tick backlog counts for the state file / statusline, the backlog
// warning, and the opportunistic raw-embedding flush while rows are unchunked.
export function createBacklogProbe({ getDb, ledger, log, flushRawEmbeddings }) {
  let flushInFlight = false;

  function flushRawEmbeddingsOnce(db) {
    if (flushInFlight) return;
    flushInFlight = true;
    flushRawEmbeddings(db, { limit: 200 })
      .then((r) => {
        if (r.attempted > 0) log(`[embed] raw fallback flush attempted=${r.attempted} embedded=${r.embedded}\n`);
      })
      .catch((err) => log(`[embed] raw fallback flush failed: ${err?.message || err}\n`))
      .finally(() => {
        flushInFlight = false;
      });
  }

  async function probe(now) {
    const db = getDb();
    try {
      const unchunked = await countRows(
        db,
        `SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL AND NULLIF(btrim(session_id), '') IS NOT NULL`
      );
      const unchunkedEligible = await countRows(
        db,
        `SELECT COUNT(*) c FROM entries
         WHERE chunk_root IS NULL
           AND NULLIF(btrim(session_id), '') IS NOT NULL
           AND (reviewed_at IS NULL OR reviewed_at < $1)`,
        [now - CYCLE1_OMITTED_COOLDOWN_MS]
      );
      const cycle2Pending = await countPendingCycle2Roots(db);
      ledger.setBacklog({ unchunked, unchunked_eligible: unchunkedEligible, cycle2_pending: cycle2Pending, at: now });
      if (unchunked > BACKLOG_WARN_PENDING || cycle2Pending > BACKLOG_WARN_PENDING) {
        ledger.warn(`backlog unchunked=${unchunked} eligible=${unchunkedEligible} cycle2_pending=${cycle2Pending}`);
      }
      if (unchunked > 0) flushRawEmbeddingsOnce(db);
    } catch {
      /* counts are best-effort; never fail the tick */
    }
  }

  return {
    probe,
    reset: () => {
      flushInFlight = false;
    },
  };
}
