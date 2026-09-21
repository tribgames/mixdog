// agent-tree/agent-rehydrate.mjs
// Rebuilding the Agent-only routing layer from lightweight durable summaries
// after daemon replacement. Transcripts remain store/runtime owned and are
// loaded by exact canonical session id only when a caller needs one.
import { SESSION_ID_PATTERN } from './agent-registry.mjs';

export function validLinkedSessionId(value, ownId = '') {
  const id = String(value || '').trim();
  return SESSION_ID_PATTERN.test(id) && id !== ownId ? id : '';
}

/** A stored row that is an agent child: declared agent-only visibility or the
 *  legacy owner='agent' marker, with a valid parent. */
function storedAgentCandidate(row) {
  const id = String(row?.id || '').trim();
  if (!SESSION_ID_PATTERN.test(id)) return null;
  const parentSessionId = validLinkedSessionId(row?.parentSessionId || row?.ownerSessionId, id);
  if (!parentSessionId) return null;
  const declaredVisibility =
    String(row?.visibility || row?.sessionVisibility || '')
      .trim()
      .toLowerCase() === 'agent-only';
  const legacyAgentChild =
    String(row?.owner || '')
      .trim()
      .toLowerCase() === 'agent';
  if (!declaredVisibility && !legacyAgentChild) return null;
  return { row, id, parentSessionId };
}

export function lastStoredAgentHandoff(row) {
  if (typeof row?.lastHandoff === 'string') return row.lastHandoff;
  const messages = Array.isArray(row?.messages) ? row.messages : [];
  const assistant = messages.findLast(
    (message) =>
      message?.role === 'assistant' && (typeof message.content === 'string' ? message.content.trim() : message.content)
  );
  if (!assistant) return '';
  return typeof assistant.content === 'string' ? assistant.content : JSON.stringify(assistant.content);
}

/** Root owner of each candidate, resolved through the stored parent chain: an
 *  explicit owner that differs from the parent wins, otherwise the parent's
 *  root; a chain that leaves the candidate set ends at its last known owner. */
function createRootResolver(candidates) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const roots = new Map();
  const resolveRoot = (candidate, seen = new Set()) => {
    if (!candidate || seen.has(candidate.id)) return candidate?.parentSessionId || '';
    if (roots.has(candidate.id)) return roots.get(candidate.id);
    seen.add(candidate.id);
    const explicitOwner = validLinkedSessionId(candidate.row?.ownerSessionId, candidate.id);
    if (explicitOwner && explicitOwner !== candidate.parentSessionId) {
      roots.set(candidate.id, explicitOwner);
      return explicitOwner;
    }
    const parent = byId.get(candidate.parentSessionId);
    const root = parent ? resolveRoot(parent, seen) : explicitOwner || candidate.parentSessionId;
    roots.set(candidate.id, root);
    return root;
  };
  return resolveRoot;
}

/** The descriptor a stored row rehydrates into. */
function rehydratedDescriptor(candidate, ownerSessionId) {
  const row = candidate.row;
  return {
    id: candidate.id,
    parentSessionId: candidate.parentSessionId,
    ownerSessionId,
    owner: 'agent',
    visibility: 'agent-only',
    agent: row.agent || row.sourceName || 'worker',
    agentTag: row.agentTag || row.tag || null,
    cwd: row.cwd || process.cwd(),
    provider: row.provider || null,
    model: row.model || null,
    presetName: row.presetName || row.preset || row.profileId || null,
    effort: row.effort || null,
    fast: row.fast === true,
    modelParameters: row.modelParameters || null,
    taskType: row.taskType || null,
    permission: row.permission || null,
    permissionMode: row.permissionMode || null,
    toolPermission: row.toolPermission || null,
    schemaAllowedTools: Array.isArray(row.schemaAllowedTools) ? row.schemaAllowedTools : null,
    sourceType: row.sourceType || 'agent',
    sourceName: row.sourceName || row.agent || 'agent',
    clientHostPid: row.clientHostPid || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || row.lastUsedAt || null,
    status: row.closed === true ? 'closed' : row.status || 'idle',
    stage: row.closed === true ? 'closed' : row.stage || row.status || 'idle',
    messageCount: Number(row.messageCount) || (Array.isArray(row.messages) ? row.messages.length : 0),
    lastHandoff: lastStoredAgentHandoff(row),
    closed: row.closed === true,
  };
}

export function createAgentRehydration({ registry, listSessions, readStoredSession, log }) {
  let agentRehydrated = false;
  let agentRehydratePromise = null;

  /** Rows whose summary lacks the parent link are completed from their stored
   *  metadata (a one-time migration of older agent children). */
  const completeCandidates = async (candidates) => {
    if (typeof readStoredSession !== 'function') return candidates;
    return Promise.all(
      candidates.map(async (candidate) => {
        if (candidate.row?.parentSessionId) return candidate;
        try {
          const metadata = await readStoredSession(candidate.id, { metadataOnly: true });
          return (
            storedAgentCandidate({
              ...candidate.row,
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              id: candidate.id,
            }) || candidate
          );
        } catch (error) {
          log(`agent metadata migration failed session=${candidate.id}: ${error?.message || error}`);
          return candidate;
        }
      })
    );
  };

  async function rehydrateAgentSessions() {
    if (agentRehydrated) return registry.size();
    if (agentRehydratePromise) return agentRehydratePromise;
    if (typeof listSessions !== 'function') {
      agentRehydrated = true;
      return registry.size();
    }
    let loading;
    loading = (async () => {
      const stored = await listSessions({
        includeAgentOnly: true,
        summaryOnly: true,
        refreshFromStorage: false,
      });
      const candidates = await completeCandidates(
        (Array.isArray(stored) ? stored : []).map(storedAgentCandidate).filter(Boolean)
      );
      const resolveRoot = createRootResolver(candidates);
      for (const candidate of candidates) {
        // A child created while the summary load was in flight is newer than
        // the stored row and must never be rolled back by rehydration.
        if (registry.has(candidate.id)) continue;
        registry.linkAgentDescriptor(rehydratedDescriptor(candidate, resolveRoot(candidate)));
      }
      agentRehydrated = true;
      return registry.size();
    })().finally(() => {
      if (agentRehydratePromise === loading) agentRehydratePromise = null;
    });
    agentRehydratePromise = loading;
    return loading;
  }

  return { rehydrateAgentSessions };
}
