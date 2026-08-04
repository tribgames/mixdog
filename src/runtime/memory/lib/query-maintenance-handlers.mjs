import { cleanMemoryText } from './memory.mjs'

export function createQueryMaintenanceHandlers({ getDb }) {
  async function dumpSessionRootChunks(args = {}) {
    const db = getDb()
    const sessionId = String(args.sessionId || args.session_id || '').trim()
    if (!sessionId) return { text: '(no current session)', rows: [], chunks: [], isError: true }
    const includeRaw = args.includeRaw !== false
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 1000))
    const rootRows = (await db.query(`
      SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root,
             element, category, summary, status, score, last_seen_at, project_id
      FROM entries
      WHERE session_id = $1 AND is_root = 1
      ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
      LIMIT $2
    `, [sessionId, limit])).rows
    const roots = rootRows.map((r) => ({ ...r, members: [] }))
    const rootIds = roots.map((r) => Number(r.id)).filter((id) => Number.isFinite(id))
    const memberRows = rootIds.length > 0
      ? (await db.query(`
          SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
          FROM entries
          WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
          ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        `, [rootIds])).rows
      : []
    const byRoot = new Map(roots.map((r) => [Number(r.id), r]))
    for (const m of memberRows) {
      const root = byRoot.get(Number(m.chunk_root))
      if (root) root.members.push(m)
    }
    let rawRows = []
    if (includeRaw) {
      rawRows = (await db.query(`
        SELECT id, ts, role, content, session_id, source_turn, chunk_root, is_root, project_id
        FROM entries
        WHERE session_id = $1
          AND is_root = 0
          AND (chunk_root IS NULL OR chunk_root = id)
        ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
        LIMIT $2
      `, [sessionId, limit])).rows
    }
    const chunks = []
    for (const root of roots) {
      const memberText = root.members
        .map((m) => `${m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : m.role}: ${cleanMemoryText(String(m.content ?? ''))}`)
        .filter(Boolean)
        .join('\n')
      const summary = [root.element, root.summary].map((v) => String(v || '').trim()).filter(Boolean).join(' — ')
      chunks.push({
        id: Number(root.id),
        kind: 'root',
        ts: Number(root.ts) || 0,
        sourceTurn: root.source_turn ?? null,
        category: root.category || null,
        summary,
        text: memberText || cleanMemoryText(String(root.content ?? '')),
        members: root.members,
      })
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
        text: `${raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : raw.role}: ${cleanMemoryText(String(raw.content ?? ''))}`,
        members: [],
      })
    }
    chunks.sort((a, b) => {
      const at = Number.isFinite(Number(a.sourceTurn)) ? Number(a.sourceTurn) : 2147483647
      const bt = Number.isFinite(Number(b.sourceTurn)) ? Number(b.sourceTurn) : 2147483647
      return (at - bt) || ((a.ts || 0) - (b.ts || 0)) || ((a.id || 0) - (b.id || 0))
    })
    const text = chunks.length
      ? chunks.map((chunk, idx) => {
          const label = chunk.kind === 'root'
            ? `# chunk ${idx + 1} root=${chunk.id}${chunk.category ? ` category=${chunk.category}` : ''}`
            : `${chunk.chunkRoot == null ? '# raw_pending' : '# raw_terminal'} ${idx + 1} id=${chunk.id}`
          const summary = chunk.summary ? `summary: ${chunk.summary}\n` : ''
          return `${label}\n${summary}${chunk.text}`.trim()
        }).join('\n\n')
      : '(no results)'
    return { text, rows: [...roots, ...rawRows], chunks }
  }

  async function entryStats() {
    const db = getDb()
    return await db.transaction(async (tx) => {
      const total               = (await tx.query(`SELECT COUNT(*) c FROM entries`)).rows[0].c
      const roots               = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1`)).rows[0].c
      const active_roots        = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active'`)).rows[0].c
      const archived_roots      = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'archived'`)).rows[0].c
      const unchunked_leaves    = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL`)).rows[0].c
      const cycle2_pending_roots = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'pending'`)).rows[0].c
      const core_entries        = (await tx.query(`SELECT COUNT(*) c FROM core_entries`)).rows[0].c
      const core_embed_null     = (await tx.query(`SELECT COUNT(*) c FROM core_entries WHERE embedding IS NULL`)).rows[0].c
      const active_core_summaries = (await tx.query(`SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' AND core_summary IS NOT NULL`)).rows[0].c
      const active_core_summary_missing = (await tx.query(`
        SELECT COUNT(*) c
        FROM entries
        WHERE is_root = 1
          AND status = 'active'
          AND (core_summary IS NULL OR btrim(core_summary) = '')
      `)).rows[0].c
      const byStatus            = (await tx.query(`SELECT status, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status`)).rows
      const byCategory          = (await tx.query(`SELECT category, COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'active' GROUP BY category ORDER BY c DESC`)).rows
      const mvRows              = (await tx.query(`SELECT relispopulated FROM pg_class WHERE relname = 'mv_hot_active' LIMIT 1`)).rows
      const mv_hot_active_populated = mvRows.length ? Boolean(mvRows[0].relispopulated) : null
      return {
        total, roots, active_roots, archived_roots, unchunked_leaves, cycle2_pending_roots,
        core_entries, core_embed_null, active_core_summaries, active_core_summary_missing,
        mv_hot_active_populated,
        byStatus, byCategory,
      }
    })
  }

  return { dumpSessionRootChunks, entryStats }
}
