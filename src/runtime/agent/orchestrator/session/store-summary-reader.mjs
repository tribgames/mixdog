/**
 * Read-only session summary catalog for cold desktop startup.
 *
 * The summary path intentionally avoids store.mjs, config/provider loading,
 * workers, and atomic-lock writers. A transcript read stays lightweight too
 * unless a durable turn checkpoint exists; only then does it lazily enter the
 * reconnect recovery boundary so restored panes never paint a stale prompt.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
// Leaf helpers only (no store.mjs, no workers, no config): the three-way
// present/absent/unreadable classification and the strict record parser the
// authoritative store uses, so the cold catalog cannot disagree with it.
import { probePath, readTextFile, PROBE_PRESENT, PROBE_ABSENT } from './store/fs-probe.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from './lifecycle-scan.mjs';
import { isAgentOnlySession, isRootLeadSession, sessionVisibility } from './store-summary-visibility.mjs';
import { createStoredTranscriptCache } from './store-transcript-cache.mjs';
import { projectStoredTranscript } from './store-transcript-projection.mjs';
import { dataDir, sessionHeartbeatMtimes } from './store-summary-locations.mjs';
import { desktopSession, positiveNumber } from './store-summary-fields.mjs';
import { readArchivedAgentResult } from './store-summary-archived-agent.mjs';
// Worker-pool row projection (child + Lead indexes, heartbeat lease, cancel
// ranking) lives in store-agent-worker-rows.mjs; re-exported so prior
// importers of this module stay unchanged.
export { listStoredAgentWorkerLinks, listStoredAgentWorkers } from './store-agent-worker-rows.mjs';
export { storedAgentWorkerIndexPath } from './store-summary-locations.mjs';

// One cache per process: the daemon serves every cold pane read from it, and
// the desktop service worker keeps its own for the deep-history prefetch.
const storedTranscriptCache = createStoredTranscriptCache();

/** Test seam: forget every cached projection. */
export function clearStoredTranscriptCache() {
  storedTranscriptCache.clear();
}

const SESSION_SUMMARY_INDEX_VERSION = 2;

// Mirror of lifecycle-api.mjs listLeadSessions visibility: the cold catalog
// must never surface worker/agent dispatches (memory ingest chunks, judges,
// spawned agents) — the authoritative engine excludes them, so a click on
// such a row dead-ends in "Session is not available." (user report).
const LEAD_OWNERS = new Set(['cli', 'user', 'mixdog']);

function isLeadVisibleRow(row) {
  const owner = String(row.owner || 'user')
    .trim()
    .toLowerCase();
  if (isAgentOnlySession(row)) return false;
  if (!isRootLeadSession(row) && owner && !LEAD_OWNERS.has(owner)) return false;
  // Mirror listLeadSessions: a previewless zero-message row is an unusable
  // scratch (desktop boot leftovers, crashed first turns) — resuming it
  // shows an empty conversation, so the catalog hides it.
  if (!row.preview && row.messageCount === 0) return false;
  const sourceType = String(row.sourceType || '')
    .trim()
    .toLowerCase();
  const sourceName = String(row.sourceName || '')
    .trim()
    .toLowerCase();
  const agent = String(row.agent || '')
    .trim()
    .toLowerCase();
  return (
    agent === 'lead' ||
    sourceType === 'lead' ||
    sourceType === 'cli' ||
    sourceType === 'schedule' ||
    sourceType === 'webhook' ||
    (!sourceType && !sourceName && owner !== 'agent')
  );
}

function cleanText(value, maximum = 240) {
  return (
    String(value || '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<mcp-instructions>[\s\S]*?<\/mcp-instructions>/gi, ' ')
      // Session-context envelope (mirror of session-text.mjs
      // stripSessionDisplayEnvelope): the "# Session / Cwd / Model /
      // Workflow" header must never become a Recent title.
      .replace(/^\s*# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, ' ')
      .replace(/^\s*#\s*Session\s+Cwd:\s+\S+(?:\s+Model:[^\r\n]*?)?(?:\s+Workflow:\s+\S+)?\s*/i, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maximum)
  );
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : String(part?.text || part?.content || '')))
    .filter(Boolean)
    .join(' ');
}

function normalizedRow(row, heartbeatAt = 0) {
  if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id)) return null;
  return {
    id: row.id,
    updatedAt: positiveNumber(row.updatedAt, 0),
    // Conversation-activity timestamp (mirror of listLeadSessions):
    // detach/resume bookkeeping bumps updatedAt in bulk on restarts, so
    // Recent must order by lastUsedAt or every restart reshuffles rows.
    lastUsedAt: positiveNumber(row.lastUsedAt, 0),
    createdAt: positiveNumber(row.createdAt, 0),
    lastHeartbeatAt: positiveNumber(row.lastHeartbeatAt, 0),
    // Liveness comes from the .hb sidecar mtime alone: stored row fields
    // (summary index / final session save) survive completion and must not
    // keep the desktop working indicator on after the sidecar is deleted.
    heartbeatAt: positiveNumber(heartbeatAt, 0),
    closed: row.closed === true,
    status: String(row.status || (row.closed === true ? 'closed' : 'idle')),
    owner: row.owner || 'user',
    agent: row.agent || null,
    sourceType: row.sourceType || null,
    sourceName: row.sourceName || null,
    sourceDelivery: row.sourceDelivery || null,
    scopeKey: row.scopeKey || null,
    ownerSessionId: row.ownerSessionId || row.parentSessionId || null,
    visibility: sessionVisibility(row),
    clientHostPid: positiveNumber(row.clientHostPid, 0) || null,
    cwd: row.cwd || '',
    desktopSession: desktopSession(row.desktopSession, row.cwd),
    provider: row.provider || null,
    model: row.model || null,
    agentTag: row.agentTag || null,
    task_id: row.task_id || row.taskId || null,
    permission: row.permission || null,
    toolPermission: row.toolPermission || null,
    messageCount: Math.max(0, Math.floor(Number(row.messageCount) || 0)),
    title: cleanText(row.title, 100),
    preview: cleanText(row.preview),
    generation: typeof row.generation === 'number' ? row.generation : 0,
    storageMtimeMs: positiveNumber(row.storageMtimeMs, 0),
    storageSize: positiveNumber(row.storageSize, 0),
    detachedReason: row.detachedReason || null,
  };
}

function leadRowsWithAgentHeartbeat(rows) {
  const agentHeartbeatByOwner = new Map();
  for (const row of rows) {
    const heartbeatAt = positiveNumber(row?.heartbeatAt, 0);
    const ownerSessionId = String(row?.ownerSessionId || '').trim();
    const owner = String(row?.owner || '')
      .trim()
      .toLowerCase();
    const agent = String(row?.agent || '')
      .trim()
      .toLowerCase();
    if (!heartbeatAt || !ownerSessionId || (owner !== 'agent' && (!agent || agent === 'lead'))) continue;
    agentHeartbeatByOwner.set(ownerSessionId, Math.max(agentHeartbeatByOwner.get(ownerSessionId) || 0, heartbeatAt));
  }
  return rows
    .filter((row) => row && isLeadVisibleRow(row))
    .map((row) => {
      const agentHeartbeatAt = agentHeartbeatByOwner.get(row.id) || 0;
      return agentHeartbeatAt > 0 ? { ...row, agentHeartbeatAt } : row;
    });
}

function rowFromSession(session, heartbeatAt = 0) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const preview =
    messages
      .filter((message) => message?.role === 'user')
      // Cold-path mirror of isSessionPreviewNoise's synthetic skips: compact
      // handoffs and runtime notices must not become session titles.
      .filter(
        (message) =>
          !/^\s*(?:a previous model worked on this task|re-attached after compaction\b|reference files:\s|\[mixdog-runtime\]|the async (?:agent|shell) task\b)/i.test(
            messageText(message.content)
          )
      )
      .map((message) => cleanText(messageText(message.content)))
      .find(Boolean) || '';
  return normalizedRow(
    {
      ...session,
      messageCount: messages.filter((message) => message?.role === 'user' || message?.role === 'assistant').length,
      preview,
    },
    heartbeatAt
  );
}

/**
 * Read-only scan of the authoritative session files.
 * Returns `null` when the directory itself is NOT enumerable (unreadable
 * stat / readdir): that is not "no sessions", and the caller must keep the
 * authority it already has (the index rows) instead of publishing an empty
 * catalog. `indexRowsById` carries those rows so unchanged files can reuse the
 * durable summary and a single UNREADABLE file retains its last known row
 * instead of vanishing.
 */
function scanSessionFiles(
  heartbeatMtimes = sessionHeartbeatMtimes(),
  indexRowsById = new Map(),
  { forceRead = false } = {}
) {
  const directory = join(dataDir(), 'sessions');
  const dirProbe = probePath(directory);
  if (dirProbe.state === PROBE_ABSENT) return [];
  if (dirProbe.state !== PROBE_PRESENT) return null;
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return null;
  }
  const rows = [];
  for (const filename of entries) {
    if (!filename.endsWith('.json')) continue;
    const storageId = filename.slice(0, -5);
    const path = join(directory, filename);
    const retained = indexRowsById.get(storageId);
    const probe = probePath(path);
    // Provably gone: the row legitimately disappears with the file.
    if (probe.state === PROBE_ABSENT) continue;
    if (probe.state !== PROBE_PRESENT) {
      if (retained) rows.push(retained);
      continue;
    }
    if (!forceRead && retained) {
      const exactFingerprint =
        retained.storageMtimeMs > 0 &&
        retained.storageSize > 0 &&
        retained.storageMtimeMs === probe.mtimeMs &&
        retained.storageSize === probe.size;
      if (exactFingerprint) {
        rows.push(retained);
        continue;
      }
    }
    const read = readTextFile(path);
    // Provably gone: the row legitimately disappears with the file.
    if (read.state === PROBE_ABSENT) continue;
    if (read.state !== PROBE_PRESENT) {
      // Exists and could not be read (EACCES/EIO): retain the last known
      // row rather than let a transient IO error delete it from view.
      if (retained) rows.push(retained);
      continue;
    }
    // Same strict authority as the store: a duplicate/ambiguous top-level
    // record or a foreign identity is not this file's session.
    const record = readTopLevelLifecycleRecord(read.text);
    if (isLifecycleUnreadable(record) || record.id !== storageId) continue;
    const summary = rowFromSession(record.doc, heartbeatMtimes.get(record.id) || 0);
    const row = summary ? { ...summary, storageMtimeMs: probe.mtimeMs, storageSize: probe.size } : null;
    if (row) rows.push(row);
  }
  return leadRowsWithAgentHeartbeat(rows).sort(
    (left, right) => (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0)
  );
}

export function listStoredSessionSummaries(options = {}) {
  const heartbeatMtimes = sessionHeartbeatMtimes();
  const indexPath = join(dataDir(), 'session-summaries.json');
  // The index is read on EVERY path (it is one small file): its rows are the
  // authority that must be retained whenever storage cannot be enumerated or
  // an individual session file cannot be read.
  const indexRowsById = new Map();
  let indexRows = null;
  const indexRead = readTextFile(indexPath);
  if (indexRead.state === PROBE_PRESENT) {
    try {
      const index = JSON.parse(indexRead.text);
      if (Number(index?.version) === SESSION_SUMMARY_INDEX_VERSION) {
        const normalizedRows = (Array.isArray(index.rows) ? index.rows : [])
          .map((row) => normalizedRow(row, heartbeatMtimes.get(row?.id) || 0))
          .filter(Boolean);
        for (const row of normalizedRows) indexRowsById.set(row.id, row);
        indexRows = leadRowsWithAgentHeartbeat(normalizedRows).sort(
          (left, right) => (right.lastUsedAt || right.updatedAt || 0) - (left.lastUsedAt || left.updatedAt || 0)
        );
      }
    } catch {
      /* malformed sidecar: the files below are the authority */
    }
  }
  // An index that EXISTS but is unreadable (EACCES/EIO) is neither missing
  // nor empty: the scan below still runs, and when IT cannot enumerate
  // either, the catalog reports nothing rather than inventing an empty truth.
  const scan = (forceRead = false) => scanSessionFiles(heartbeatMtimes, indexRowsById, { forceRead });
  if (options.refreshFromStorage === true) return scan(true) ?? indexRows ?? [];
  if (indexRows) {
    if (options.rebuildIfMissing === false) return indexRows;
    // Enumerate identities to detect deletions, stat known files, and parse
    // only rows newer than the index. Cold-start cost therefore scales with
    // changed transcripts rather than total transcript bytes.
    return scan(false) ?? indexRows;
  }
  // Missing/malformed index is the sole cold path that must rebuild every
  // summary from canonical session bytes.
  return options.rebuildIfMissing === false ? [] : (scan(true) ?? indexRows ?? []);
}

/** Exact, fail-closed existence check for a durable session address.
 * Summary indexes and desktop metadata are presentation caches; neither may
 * make a missing sessions/<id>.json record addressable again. */
export function storedSessionExists(id) {
  const sessionId = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
  const read = readTextFile(join(dataDir(), 'sessions', `${sessionId}.json`));
  if (read.state !== PROBE_PRESENT) return false;
  const record = readTopLevelLifecycleRecord(read.text);
  return !isLifecycleUnreadable(record) && record.id === sessionId;
}

/** Read exactly one persisted session for a visible desktop pane. This never
 * enumerates siblings. Normal reads stay independent of runtime ownership;
 * interrupted turns conditionally use the same durable reconnect recovery as
 * resumeSession before projecting the transcript. */
export async function readStoredSessionTranscript(id, options = {}) {
  const sessionId = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  // Same strict authority as the store, and the same fail-closed rule: an
  // absent, unreadable, ambiguous or foreign record yields no transcript.
  const recordPath = join(dataDir(), 'sessions', `${sessionId}.json`);
  if (options.metadataOnly === true) {
    const read = readTextFile(recordPath);
    if (read.state !== PROBE_PRESENT) return null;
    const record = readTopLevelLifecycleRecord(read.text);
    if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
    const session = record.doc;
    return {
      id: sessionId,
      sessionId,
      owner: session.owner || null,
      agent: session.agent || null,
      parentSessionId: session.parentSessionId || null,
      ownerSessionId: session.ownerSessionId || session.parentSessionId || null,
      visibility: sessionVisibility(session),
      agentTag: session.agentTag || null,
      cwd: session.cwd || '',
      provider: session.provider || null,
      model: session.model || null,
      presetName: session.presetName || session.profileId || null,
      effort: session.effort || null,
      fast: session.fast === true,
      modelParameters: session.modelParameters || null,
      taskType: session.taskType || null,
      permission: session.permission || null,
      permissionMode: session.permissionMode || null,
      toolPermission: session.toolPermission || null,
      schemaAllowedTools: Array.isArray(session.schemaAllowedTools) ? session.schemaAllowedTools : null,
      sourceType: session.sourceType || null,
      sourceName: session.sourceName || null,
      clientHostPid: session.clientHostPid || null,
      createdAt: session.createdAt || null,
      updatedAt: session.updatedAt || session.lastUsedAt || null,
      status: session.status || (session.closed === true ? 'closed' : 'idle'),
      closed: session.closed === true,
    };
  }
  // The checkpoint sidecar shapes the projection as much as the record does,
  // so its identity joins the cache fingerprint. Only a PROVABLY absent
  // checkpoint skips recovery: an unreadable probe must not silently
  // downgrade an interrupted turn to a plain cold read.
  const startedAt = performance.now();
  const recordStat = probePath(recordPath);
  if (recordStat.state === PROBE_ABSENT) return readArchivedAgentResult(sessionId);
  if (recordStat.state !== PROBE_PRESENT) return null;
  const checkpoint = probePath(join(dataDir(), 'turn-checkpoints', `${sessionId}.json`));
  const requestedLimit = Number(options.transcriptItemLimit);
  const itemLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : Number.POSITIVE_INFINITY;
  let readState = PROBE_PRESENT;
  // The strict record parse (full JSON + duplicate-key scan) is itself a
  // large share of a cold read, so it only runs when the content is new.
  const { value, hit, read } = await storedTranscriptCache.read({
    key: `${sessionId}|${itemLimit}|${options.includeMessages === true ? 'messages' : 'items'}`,
    fingerprint: [
      checkpoint.state,
      checkpoint.mtimeMs,
      checkpoint.ctimeMs,
      checkpoint.size,
      checkpoint.ino,
      checkpoint.dev,
    ].join(':'),
    fileStat: recordStat,
    loadText: () => {
      const body = readTextFile(recordPath);
      readState = body.state;
      return body.state === PROBE_PRESENT ? body.text : null;
    },
    produce: (text) => {
      const record = readTopLevelLifecycleRecord(text);
      if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
      return projectStoredTranscript(sessionId, record.doc, {
        itemLimit,
        includeMessages: options.includeMessages === true,
        checkpointAbsent: checkpoint.state === PROBE_ABSENT,
      });
    },
  });
  // The record vanished between stat and read: same answer as an absent probe.
  if (readState === PROBE_ABSENT) return readArchivedAgentResult(sessionId);
  if (typeof options.trace === 'function') {
    options.trace({
      sessionId,
      hit,
      read,
      ms: performance.now() - startedAt,
      chars: recordStat.size,
      items: Array.isArray(value?.items) ? value.items.length : 0,
    });
  }
  return value;
}
