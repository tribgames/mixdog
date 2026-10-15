/**
 * Legacy recovery path for child transcripts a terminal reaper already
 * unlinked: parse the parent's canonical completion notification and project
 * its recorded body as a read-only single-item transcript.
 *
 * The notification header keys (`surface`, `sessionId`, `status`, `tag`,
 * `label`, `agent`, `provider`, `model`, `effort`, `fast`, `finished`) and the
 * "\n\nResult:\n" marker are the wire format the notification writer emits;
 * they are matched verbatim.
 *
 * Only the parent(s) named by metadata are read — never the sessions
 * directory: every vanished id reaches this path (deleted Lead records too),
 * and a synchronous scan of every session file froze the daemon loop.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { dataDir } from './store-summary-locations.mjs';
import { listStoredAgentWorkerLinks } from './store-agent-worker-rows.mjs';
import { cleanValue, desktopSession, isStoredSessionId, positiveNumber } from './store-summary-fields.mjs';

function archivedAgentNotification(content, sessionId) {
  const text = typeof content === 'string' ? content : '';
  const marker = '\n\nResult:\n';
  const markerAt = text.indexOf(marker);
  if (markerAt < 0 || !/Async agent task .* finished\./.test(text.slice(0, markerAt))) return null;
  const lines = text
    .slice(markerAt + marker.length)
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s?/, ''));
  const divider = lines.findIndex((line) => line.trim() === '');
  if (divider < 0) return null;
  const headers = new Map();
  for (const line of lines.slice(0, divider)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (match) headers.set(match[1], match[2]);
  }
  if (headers.get('surface') !== 'agent' || headers.get('sessionId') !== sessionId) return null;
  const status = cleanValue(headers.get('status')).toLowerCase();
  if (!/^(?:completed|failed|cancelled)$/.test(status)) return null;
  const body = lines
    .slice(divider + 1)
    .join('\n')
    .trim();
  if (!body) return null;
  return {
    body,
    status,
    tag: cleanValue(headers.get('tag') || headers.get('label')),
    agent: cleanValue(headers.get('agent')),
    provider: cleanValue(headers.get('provider')),
    model: cleanValue(headers.get('model')),
    effort: cleanValue(headers.get('effort')),
    fast: cleanValue(headers.get('fast')).toLowerCase() === 'true',
    finishedAt: Date.parse(cleanValue(headers.get('finished'))) || 0,
  };
}

/** Parent session ids metadata names for `sessionId`: its agent-workers.json
 *  link and its summary-catalog row (`catalogRow(id)`, optional). */
function parentSessionIds(sessionId, catalogRow) {
  const parents = new Set();
  for (const link of listStoredAgentWorkerLinks()) {
    if (link.sessionId !== sessionId) continue;
    parents.add(link.parentSessionId);
    parents.add(link.ownerSessionId);
  }
  const row = typeof catalogRow === 'function' ? catalogRow(sessionId) : null;
  if (row) {
    parents.add(cleanValue(row.parentSessionId));
    parents.add(cleanValue(row.ownerSessionId));
  }
  parents.delete(sessionId);
  return [...parents].filter(isStoredSessionId);
}

/** Legacy recovery for child transcripts already unlinked by terminal reaping.
 * The parent owns one canonical body-carrying completion notification: read
 * only the parent(s) metadata links the child to, asynchronously, and project
 * the newest valid body. An id with no parent link (a deleted Lead record)
 * resolves to null without touching any session file. */
export async function readArchivedAgentResult(sessionId, { catalogRow } = {}) {
  const parents = parentSessionIds(sessionId, catalogRow);
  if (parents.length === 0) return null;
  const dir = join(dataDir(), 'sessions');
  let best = null;
  for (const parentId of parents) {
    let raw;
    try {
      raw = await readFile(join(dir, `${parentId}.json`), 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes(sessionId)) continue;
    const record = readTopLevelLifecycleRecord(raw);
    if (isLifecycleUnreadable(record) || record.id === sessionId) continue;
    const parent = record.doc;
    const messages = Array.isArray(parent.messages) ? parent.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== 'user') continue;
      const archived = archivedAgentNotification(message.content, sessionId);
      if (!archived) continue;
      const at = positiveNumber(message?.meta?.transcript?.at, archived.finishedAt || positiveNumber(parent.updatedAt));
      if (best && best.at > at) continue;
      best = { ...archived, at, parent };
      break;
    }
  }
  if (!best) return null;
  const text = `# Archived agent result\n\n${best.body}`;
  return {
    sessionId,
    items: [
      {
        id: `archived-agent-result:${sessionId}`,
        kind: 'assistant',
        text,
        status: best.status,
        ...(best.at ? { at: best.at } : {}),
        ...(best.model ? { model: best.model } : {}),
        ...(best.provider ? { provider: best.provider } : {}),
        ...(best.agent ? { agent: best.agent } : {}),
      },
    ],
    provider: best.provider,
    model: best.model,
    effort: best.effort,
    fast: best.fast,
    cwd: cleanValue(best.parent.cwd),
    desktopSession: desktopSession(best.parent.desktopSession, best.parent.cwd),
    workflow: null,
    stats: {
      currentContextTokens: 0,
      currentEstimatedContextTokens: 0,
      currentContextSource: null,
    },
    contextWindow: null,
    rawContextWindow: null,
    displayContextWindow: null,
    autoCompactTokenLimit: null,
    archivedAgentResult: true,
    readOnlyDetachedAgent: false,
  };
}
