/**
 * http-router/session-routes.mjs — the session-start core-memory payload
 * (curated common + project-scoped lines) and the recall-embedding prewarm
 * that follows a session start.
 */
import { readBody, sendJson, sendError } from '../http-wire.mjs';
import { formatCuratedCoreMemoryLine } from '../core-memory-file.mjs';
import { resolveProjectScope } from '../project-id-resolver.mjs';
import { warmupEmbeddingProvider, isEmbeddingModelReady } from '../embedding-provider.mjs';
import { embeddingWarmupCanStart, memorySecondaryMode } from '../memory-config-flags.mjs';

// The embedding ONNX session loads lazily and self-disposes after an idle
// window. Session start is the earliest reliable signal that interactive recall
// is coming, so warm it fire-and-forget after responding.
// The cooldown keeps a burst of session starts (e.g. background cycle agents)
// from queueing redundant warmups.
const RECALL_PREWARM_COOLDOWN_MS = 30_000;
let _lastRecallPrewarmAt = 0;
function prewarmRecallEmbedding(log, reason = 'session-start') {
  if (memorySecondaryMode()) return;
  const now = Date.now();
  if (now - _lastRecallPrewarmAt < RECALL_PREWARM_COOLDOWN_MS) return;
  _lastRecallPrewarmAt = now;
  if (!isEmbeddingModelReady() && embeddingWarmupCanStart()) {
    void warmupEmbeddingProvider().catch((e) =>
      log(`[memory-service] ${reason} embedding prewarm failed: ${e?.message || e}\n`)
    );
  }
}

const ACTIVE_CORE_ROWS = `SELECT id, summary FROM core_entries WHERE project_id IS NULL AND (status IS NULL OR status = 'active') ORDER BY id ASC`;
const SCOPED_CORE_ROWS = `SELECT id, summary FROM core_entries WHERE project_id = $1 AND (status IS NULL OR status = 'active') ORDER BY id ASC`;

export function createSessionRoutes({ getDb, log }) {
  async function buildSessionCoreMemoryPayload(cwd) {
    const db = getDb();
    const projectId = resolveProjectScope(typeof cwd === 'string' && cwd ? cwd : null);
    const commonRows = (await db.query(ACTIVE_CORE_ROWS)).rows;
    const scopedRows = projectId !== null ? (await db.query(SCOPED_CORE_ROWS, [projectId])).rows : [];
    return {
      projectId,
      dbLines: [],
      userLines: [
        ...commonRows.map(formatCuratedCoreMemoryLine).filter(Boolean),
        ...scopedRows.map(formatCuratedCoreMemoryLine).filter(Boolean),
      ],
    };
  }

  const sessionStart = async (req, res) => {
    try {
      const body = await readBody(req);
      const { projectId, dbLines, userLines } = await buildSessionCoreMemoryPayload(body.cwd);
      sendJson(res, { ok: true, projectId, dbLines, userLines });
      // Response is already flushed; warm recall embedding for the session
      // that just started so its first recall is not a cold one.
      prewarmRecallEmbedding(log);
    } catch (e) {
      sendError(res, e.message);
    }
  };

  return {
    buildSessionCoreMemoryPayload,
    routes: { 'POST /session-start/core-memory': sessionStart },
  };
}
