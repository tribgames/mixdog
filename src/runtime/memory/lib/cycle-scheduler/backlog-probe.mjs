import { cycle1RowDueSql, cycle1UnchunkedSql } from '../cycle1/cycle1-rows.mjs';

const BACKLOG_WARN_PENDING = 500;

async function countRows(db, sql, params) {
  return Number((await db.query(sql, params)).rows[0]?.c ?? 0);
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
      const unchunked = await countRows(db, `SELECT COUNT(*) c FROM entries WHERE ${cycle1UnchunkedSql()}`);
      const unchunkedEligible = await countRows(
        db,
        `SELECT COUNT(*) c FROM entries
         WHERE ${cycle1UnchunkedSql()}
           AND ${cycle1RowDueSql('$1')}`,
        [now]
      );
      ledger.setBacklog({ unchunked, unchunked_eligible: unchunkedEligible, at: now });
      if (unchunked > BACKLOG_WARN_PENDING) {
        ledger.warn(`backlog unchunked=${unchunked} eligible=${unchunkedEligible}`);
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
