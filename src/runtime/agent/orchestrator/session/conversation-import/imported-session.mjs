/**
 * Materialize an imported conversation as an ordinary Lead session: the normal
 * createSession initialization (route, tools, context limits, cache config,
 * system messages, BP3 fields) followed by the converted plain-text turns,
 * with `importOrigin` provenance. Persisted durably before returning, then
 * dropped from the same-process live cache.
 */
import { createSession } from '../manager/session-lifecycle.mjs';
import { deleteSession, evictLiveSession, saveSessionAsync } from '../store.mjs';
import { newTranscriptMessageId } from '../../../../shared/transcript-metadata.mjs';
import { writeStderrBestEffort } from '../../../../shared/best-effort-stderr.mjs';
import { IMPORTED_MESSAGE_SOURCE } from '../imported-message.mjs';
import { ingestSessionTurn } from '../../../../session-search/session-search-ingest.mjs';

export const IMPORT_ORIGIN_VERSION = 1;

/** Dedupe identity: the foreign session id, else the canonical source path. */
export function importOriginKey(source, foreignSessionId, canonicalPath) {
  return foreignSessionId ? `${source}:${foreignSessionId}` : `${source}:path:${canonicalPath}`;
}

export function buildImportOrigin({ source, sourcePath, foreignSessionId = null, sourceCwd = null, importedAt }) {
  return {
    version: IMPORT_ORIGIN_VERSION,
    source,
    sourcePath,
    foreignSessionId: foreignSessionId || null,
    sourceCwd: sourceCwd || null,
    importedAt,
    key: importOriginKey(source, foreignSessionId, sourcePath),
  };
}

// Lead identity every imported session carries (what a normal Lead session has).
const LEAD_FIELDS = Object.freeze({ owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'main' });
// Ownership, live binding and placement the importing runtime must not lend.
const NOT_INHERITED = [
  'id',
  'parentSessionId',
  'ownerSessionId',
  'visibility',
  'agentTag',
  'taskType',
  'permission',
  'permissionMode',
  'clientHostPid',
  'mcpScopeId',
  'approvalMode',
  'scopeKey',
  'cwd',
  'desktopSession',
];

/** Lead createSession options → options of a fresh, unbound imported session. */
export function importedSessionOptions(leadOptions, { cwd = null, desktopSession }) {
  const options = { ...leadOptions };
  for (const key of NOT_INHERITED) delete options[key];
  Object.assign(options, LEAD_FIELDS);
  if (cwd) options.cwd = cwd;
  options.desktopSession = desktopSession;
  return options;
}

/** Normalized turns → plain user/assistant transcript messages. `meta.source`
 *  marks them imported prose: restore and the model wire never read their text
 *  as runtime control content (reminders, task envelopes, summaries). */
export function importedTranscriptMessages(turns, importedAt) {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.text,
    meta: {
      source: IMPORTED_MESSAGE_SOURCE,
      // Where the text holds a run of tool use, and which tools: the desktop
      // draws each run as a native activity row.
      ...(turn.toolRuns?.length ? { importedToolRuns: turn.toolRuns } : {}),
      transcript: { messageId: newTranscriptMessageId(), at: turn.at || importedAt },
    },
  }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// createSession's own debounced save keeps the id pinned until it settles.
async function evictWhenSettled(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!evictLiveSession(id)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/**
 * Create, fill and persist one imported session. Save failures reject (the
 * half-made record is removed); once saved it is handed to content-search
 * ingestion (the same fire-and-forget ingest a finished turn gets) so it is
 * searchable right away. The live-cache eviction afterwards is bookkeeping only.
 */
export async function createImportedSession({
  leadOptions,
  conversation,
  origin,
  cwd = null,
  desktopSession,
  createSessionFn = createSession,
  ingestFn = ingestSessionTurn,
  evictTimeoutMs = 5_000,
}) {
  const session = createSessionFn(importedSessionOptions(leadOptions, { cwd, desktopSession }));
  try {
    // Append after the system layer createSession seeded; never replace it.
    session.messages.push(...importedTranscriptMessages(conversation.turns, origin.importedAt));
    session.importOrigin = origin;
    if (conversation.title) session.title = conversation.title;
    session.updatedAt = Date.now();
    await saveSessionAsync(session);
  } catch (error) {
    try {
      deleteSession(session.id);
    } catch (cleanupError) {
      writeStderrBestEffort(
        `[conversation-import] cleanup of ${session.id} failed: ${cleanupError?.message || cleanupError}\n`
      );
    }
    throw error;
  }
  ingestFn(session);
  await evictWhenSettled(session.id, evictTimeoutMs);
  return session;
}
