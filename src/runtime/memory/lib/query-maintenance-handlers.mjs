import { cleanMemoryText } from './memory.mjs';

/** One transcript line, `role: cleaned content`. */
const roleLine = (role, content) => `${role}: ${cleanMemoryText(String(content ?? ''))}`;

/**
 * The session's stored rows in three reads: its roots, the member rows each
 * root owns (folded into `root.members`), and — unless suppressed — the raw
 * leaves that belong to no chunk.
 */
async function fetchSessionChunkRows(db, { sessionId, limit, includeRaw }) {
  const rootRows = (
    await db.query(
      `
      SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root,
             element, category, summary, status, score, last_seen_at, project_id
      FROM entries
      WHERE session_id = $1 AND is_root = 1
      ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      LIMIT $2
    `,
      [sessionId, limit]
    )
  ).rows;
  const roots = rootRows.map((r) => ({ ...r, members: [] }));
  const rootIds = roots.map((r) => Number(r.id)).filter((id) => Number.isFinite(id));
  const memberRows =
    rootIds.length > 0
      ? (
          await db.query(
            `
          SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root, project_id
          FROM entries
          WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        `,
            [rootIds]
          )
        ).rows
      : [];
  const byRoot = new Map(roots.map((r) => [Number(r.id), r]));
  for (const m of memberRows) {
    const root = byRoot.get(Number(m.chunk_root));
    if (root) root.members.push(m);
  }
  let rawRows = [];
  if (includeRaw) {
    rawRows = (
      await db.query(
        `
        SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root, is_root, project_id
        FROM entries
        WHERE session_id = $1
          AND is_root = 0
          AND (chunk_root IS NULL OR chunk_root = id)
        ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        LIMIT $2
      `,
        [sessionId, limit]
      )
    ).rows;
  }
  return { roots, rawRows };
}

/** Roots and raw leaves as one transcript-ordered chunk list (source turn,
 *  then timestamp, then id). */
function buildSessionChunks(roots, rawRows) {
  const chunks = [];
  for (const root of roots) {
    const memberText = root.members
      .map((m) => roleLine(m.role, m.content))
      .filter(Boolean)
      .join('\n');
    const summary = [root.element, root.summary]
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .join(' — ');
    chunks.push({
      id: Number(root.id),
      kind: 'root',
      ts: Number(root.ts) || 0,
      sourceTurn: root.source_turn ?? null,
      category: root.category || null,
      summary,
      text: memberText || cleanMemoryText(String(root.content ?? '')),
      members: root.members,
    });
  }
  for (const raw of rawRows) {
    chunks.push({
      id: Number(raw.id),
      kind: 'raw',
      chunkRoot: raw.chunk_root ?? null,
      ts: Number(raw.ts) || 0,
      sourceTurn: raw.source_turn ?? null,
      category: null,
      summary: '',
      text: roleLine(raw.role, raw.content),
      members: [],
    });
  }
  chunks.sort((a, b) => {
    const at = Number.isFinite(Number(a.sourceTurn)) ? Number(a.sourceTurn) : 2147483647;
    const bt = Number.isFinite(Number(b.sourceTurn)) ? Number(b.sourceTurn) : 2147483647;
    return at - bt || (a.ts || 0) - (b.ts || 0) || (a.id || 0) - (b.id || 0);
  });
  return chunks;
}

/** The dump's readable form: one labelled block per chunk. */
function renderSessionChunks(chunks) {
  const chunkLabel = (chunk, idx) => {
    if (chunk.kind === 'root') {
      const categoryNote = chunk.category ? ` category=${chunk.category}` : '';
      return `# chunk ${idx + 1} root=${chunk.id}${categoryNote}`;
    }
    const rawKind = chunk.chunkRoot == null ? '# raw_pending' : '# raw_terminal';
    return `${rawKind} ${idx + 1} id=${chunk.id}`;
  };
  const renderChunk = (chunk, idx) => {
    const summary = chunk.summary ? `summary: ${chunk.summary}\n` : '';
    return `${chunkLabel(chunk, idx)}\n${summary}${chunk.text}`.trim();
  };
  return chunks.length ? chunks.map(renderChunk).join('\n\n') : '(no results)';
}

export function createQueryMaintenanceHandlers({ getDb }) {
  async function dumpSessionRootChunks(args = {}) {
    const db = getDb();
    const sessionId = String(args.sessionId || args.session_id || '').trim();
    if (!sessionId) return { text: '(no current session)', rows: [], chunks: [], isError: true };
    const { roots, rawRows } = await fetchSessionChunkRows(db, {
      sessionId,
      limit: Math.max(1, Math.min(1000, Number(args.limit) || 1000)),
      includeRaw: args.includeRaw !== false,
    });
    const chunks = buildSessionChunks(roots, rawRows);
    return { text: renderSessionChunks(chunks), rows: [...roots, ...rawRows], chunks };
  }

  async function entryStats() {
    const db = getDb();
    return await db.transaction(async (tx) => {
      const total = (await tx.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c;
      const roots = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`)).rows[0].c;
      const active_roots = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active'`))
        .rows[0].c;
      const archived_roots = (
        await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'archived'`)
      ).rows[0].c;
      const unchunked_leaves = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`)).rows[0].c;
      const cycle2_pending_roots = (
        await tx.query(
          `SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND cycle2_reviewed_at IS NULL AND duplicate_of IS NULL`
        )
      ).rows[0].c;
      const core_entries = (await tx.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c;
      const core_embed_null = (await tx.query(`SELECT COUNT(*) c FROM core_entries WHERE embedding IS NULL`)).rows[0].c;
      const byStatus = (await tx.query(`SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status`))
        .rows;
      const byCategory = (
        await tx.query(`SELECT category, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY category ORDER BY c DESC`)
      ).rows;
      return {
        total,
        roots,
        active_roots,
        archived_roots,
        unchunked_leaves,
        cycle2_pending_roots,
        core_entries,
        core_embed_null,
        byStatus,
        byCategory,
      };
    });
  }

  return { dumpSessionRootChunks, entryStats };
}
