// ingest/ingest-insert.mjs
// Writing prepared session rows: the monotonic source_turn seed and the
// ON CONFLICT DO NOTHING insert loop that reports exactly the ids it inserted.
import { stableSessionSourceRef } from '../session-ingest.mjs';

/** Monotonic ingest order, independent of the current (post-compaction) array
 *  index. source_turn used to be `i+1`, but after compaction shrinks /
 *  reindexes session.messages a NEWLY appended turn gets a LOW i and thus a
 *  LOW source_turn — and since dump_session_roots / recall order by
 *  source_turn first, it would sort BEFORE older pre-compaction rows. Seeding
 *  from the current max for this session gives every new row a turn strictly
 *  greater than all previously-ingested ones. */
export async function readMaxSourceTurn(db, sessionId) {
  try {
    const maxRow = await db.query(
      `SELECT COALESCE(MAX(source_turn), 0) AS max_turn FROM entries WHERE session_id = $1`,
      [sessionId]
    );
    return Number(maxRow.rows?.[0]?.max_turn) || 0;
  } catch {
    return 0;
  }
}

/** Inserts the prepared rows. Re-ingested (ON CONFLICT) rows keep their
 *  original turn and do not consume a new one. Returns the ids THIS call
 *  actually inserted (skips return no id). */
export async function insertPreparedRows({ db, sessionId, messages, prepared, projectId, parseTsToMs, turnAllocator }) {
  let inserted = 0;
  const insertedIds = [];
  for (const { m, role, content, rawContent, occurrence, index, untimestamped } of prepared) {
    const fallbackTs = Date.now() - (messages.length - index);
    const rawTimestamp = m.ts ?? m.timestamp;
    const timeSource = untimestamped ? 'collected' : 'recorded';
    const tsMs = untimestamped ? fallbackTs : parseTsToMs(rawTimestamp);
    // Assign the next monotonic turn BEFORE building the source_ref so identical
    // untimestamped repeats get distinct identities (peekNext is stable until a
    // row is actually inserted → next()).
    const assignedTurn = turnAllocator.peekNext();
    // Stable per-message identity. The previous `session:${id}#${i+1}` key was
    // positional, so after compaction shrinks/reindexes session.messages a
    // later turn could reuse an old index and be silently skipped by
    // ON CONFLICT DO NOTHING. stableSessionSourceRef hashes only durable
    // fields (role, original ts if present, tool ids, content) — never the
    // synthesized tsMs fallback or the loop index. For untimestamped turns the
    // monotonic ordinal is folded in so genuine repeats persist (not collapsed).
    const sourceRef = stableSessionSourceRef(sessionId, m, role, content, occurrence);
    const result = await db.query(
      `
        INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id, time_source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [tsMs, role, rawContent, sourceRef, sessionId, assignedTurn, projectId, timeSource]
    );
    const rowInserted = Number(result.rowCount ?? result.affectedRows ?? 0) || 0;
    if (rowInserted > 0) {
      inserted += rowInserted;
      const newId = result.rows?.[0]?.id;
      if (newId != null && Number.isFinite(Number(newId))) insertedIds.push(Number(newId));
      turnAllocator.next();
    }
  }
  return { inserted, insertedIds };
}
