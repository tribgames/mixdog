/**
 * http-router/ingest-routes.mjs — the POST-only tail: /entry,
 * /ingest-transcript and /transcript/ingest-sync. The body is read once
 * here; an unknown POST url is a 404 and any other method a 405.
 */
import fs from 'node:fs';
import { readBody, sendJson, sendError } from '../http-wire.mjs';
import { cleanMemoryText } from '../memory.mjs';
import { resolveProjectScope } from '../project-id-resolver.mjs';

const INSERT_ENTRY = `
            INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
            RETURNING id
          `;

export function createIngestHandler({ getDb, log, ingestTranscriptFile, getTranscriptOffset, parseTsToMs }) {
  const entry = async (body, res) => {
    const db = getDb();
    const role = String(body.role ?? 'user');
    const content = String(body.content ?? '');
    const sourceRef = String(body.sourceRef ?? `manual:${Date.now()}-${process.pid}`);
    const sessionId = body.sessionId ?? null;
    const tsMs = parseTsToMs(body.ts ?? Date.now());
    if (!content) {
      sendJson(res, { error: 'content required' }, 400);
      return;
    }
    // Run the same scrubber used by ingestTranscriptFile so noise markers
    // like "[Request interrupted by user]" and whitespace-only payloads
    // are rejected before they reach the entries table. Match the
    // existing 400 / { error } convention for invalid payloads.
    const cleaned = cleanMemoryText(content);
    if (!cleaned?.trim()) {
      sendJson(res, { error: 'empty after clean' }, 400);
      return;
    }
    const entryProjectId = resolveProjectScope(typeof body.cwd === 'string' && body.cwd ? body.cwd : null);
    try {
      const result = await db.query(INSERT_ENTRY, [tsMs, role, cleaned, sourceRef, sessionId, entryProjectId]);
      const insertedId = result.rows[0]?.id ?? null;
      sendJson(res, {
        ok: true,
        id: insertedId !== null ? Number(insertedId) : null,
        changes: Number(result.rowCount ?? result.affectedRows ?? 0),
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
  };

  const ingestTranscript = async (body, res) => {
    const filePath = body.filePath;
    if (!filePath) {
      sendJson(res, { error: 'filePath required' }, 400);
      return;
    }
    try {
      const n = await ingestTranscriptFile(filePath, { cwd: body.cwd });
      sendJson(res, { ok: true, ingested: n });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
  };

  const ingestSync = async (body, res) => {
    const filePath = body.path;
    if (!filePath || typeof filePath !== 'string') {
      sendJson(res, { error: 'path required' }, 400);
      return;
    }
    try {
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        sendJson(res, { ok: true, complete: true, fileSize: 0, offsetBytes: 0 });
        return;
      }
      const fileSize = stat.size;
      await ingestTranscriptFile(filePath, { cwd: body.cwd });
      const off = getTranscriptOffset(filePath);
      const offsetBytes = off && Number.isFinite(off.bytes) ? off.bytes : 0;
      const complete = offsetBytes >= fileSize;
      sendJson(res, { ok: true, offsetBytes, fileSize, complete });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
  };

  const routes = {
    '/entry': entry,
    '/ingest-transcript': ingestTranscript,
    '/transcript/ingest-sync': ingestSync,
  };

  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, { error: 'Method not allowed' }, 405);
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendError(res, e.message, Number(e?.statusCode) || 500);
      return;
    }
    try {
      const route = routes[req.url];
      if (!route) {
        sendJson(res, { error: 'Not found' }, 404);
        return;
      }
      await route(body, res);
    } catch (e) {
      log(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`);
      sendError(res, e.message);
    }
  };
}
