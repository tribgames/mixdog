// session-service/agent-tree.mjs — Agent child catalog for the session service.
//
// Agent children are catalog metadata over ordinary daemon-owned sessions.
// Their transcript/execution state remains exclusively in the service's
// session index; this layer carries only the Parent–Child relationship and
// the public Agent routing fields needed before/after a turn.
import { randomUUID } from 'node:crypto';
import { cancelBackgroundTasks } from '../../runtime/shared/background-tasks.mjs';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function createAgentTree({
  listSessions = null,
  readStoredSession = null,
  log = () => {},
  sessionOwner,
  stateBusy,
  entryForSession,
  retainUnwatched,
  createSession,
} = {}) {
  const agentSessions = new Map();
  const agentChildren = new Map();
  const agentCancelRuns = new Map();
  let agentRehydrated = false;
  let agentRehydratePromise = null;

  function linkAgentDescriptor(descriptor) {
    const sessionId = String(descriptor?.id || '').trim();
    const parentSessionId = String(descriptor?.parentSessionId || '').trim();
    if (!sessionId || !parentSessionId) {
      throw new TypeError('agent child requires session and parent ids');
    }
    const previous = agentSessions.get(sessionId);
    if (previous?.parentSessionId && previous.parentSessionId !== parentSessionId) {
      agentChildren.get(previous.parentSessionId)?.delete(sessionId);
    }
    const linked = {
      ...(previous || {}),
      ...descriptor,
      id: sessionId,
      parentSessionId,
      ownerSessionId: String(
        descriptor.ownerSessionId
        || previous?.ownerSessionId
        || agentSessions.get(parentSessionId)?.ownerSessionId
        || parentSessionId,
      ),
      owner: 'agent',
      visibility: 'agent-only',
      closed: descriptor.closed === true,
    };
    agentSessions.set(sessionId, linked);
    let children = agentChildren.get(parentSessionId);
    if (!children) agentChildren.set(parentSessionId, children = new Set());
    children.add(sessionId);
    return linked;
  }

  function validLinkedSessionId(value, ownId = '') {
    const id = String(value || '').trim();
    return SESSION_ID_PATTERN.test(id) && id !== ownId ? id : '';
  }

  function storedAgentCandidate(row) {
    const id = String(row?.id || '').trim();
    if (!SESSION_ID_PATTERN.test(id)) return null;
    const parentSessionId = validLinkedSessionId(
      row?.parentSessionId || row?.ownerSessionId,
      id,
    );
    if (!parentSessionId) return null;
    const declaredVisibility = String(
      row?.visibility || row?.sessionVisibility || '',
    ).trim().toLowerCase() === 'agent-only';
    const legacyAgentChild = String(row?.owner || '').trim().toLowerCase() === 'agent';
    if (!declaredVisibility && !legacyAgentChild) return null;
    return { row, id, parentSessionId };
  }

  function lastStoredAgentHandoff(row) {
    if (typeof row?.lastHandoff === 'string') return row.lastHandoff;
    const messages = Array.isArray(row?.messages) ? row.messages : [];
    const assistant = [...messages].reverse().find((message) => (
      message?.role === 'assistant'
      && (typeof message.content === 'string' ? message.content.trim() : message.content)
    ));
    if (!assistant) return '';
    return typeof assistant.content === 'string'
      ? assistant.content
      : JSON.stringify(assistant.content);
  }

  /** Rebuild the Agent-only routing layer from lightweight durable summaries
   *  after daemon replacement. Transcripts remain store/runtime owned and are
   *  loaded by exact canonical session id only when a caller needs one. */
  async function rehydrateAgentSessions() {
    if (agentRehydrated) return agentSessions.size;
    if (agentRehydratePromise) return agentRehydratePromise;
    if (typeof listSessions !== 'function') {
      agentRehydrated = true;
      return agentSessions.size;
    }
    let loading;
    loading = (async () => {
      const stored = await listSessions({
        includeAgentOnly: true,
        summaryOnly: true,
        refreshFromStorage: false,
      });
      let candidates = (Array.isArray(stored) ? stored : [])
        .map(storedAgentCandidate)
        .filter(Boolean);
      if (typeof readStoredSession === 'function') {
        candidates = await Promise.all(candidates.map(async (candidate) => {
          if (candidate.row?.parentSessionId) return candidate;
          try {
            const metadata = await readStoredSession(candidate.id, { metadataOnly: true });
            return storedAgentCandidate({
              ...candidate.row,
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              id: candidate.id,
            }) || candidate;
          } catch (error) {
            log(`agent metadata migration failed session=${candidate.id}: ${error?.message || error}`);
            return candidate;
          }
        }));
      }
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
        const root = parent ? resolveRoot(parent, seen) : (explicitOwner || candidate.parentSessionId);
        roots.set(candidate.id, root);
        return root;
      };
      for (const candidate of candidates) {
        // A child created while the summary load was in flight is newer than
        // the stored row and must never be rolled back by rehydration.
        if (agentSessions.has(candidate.id)) continue;
        const row = candidate.row;
        linkAgentDescriptor({
          id: candidate.id,
          parentSessionId: candidate.parentSessionId,
          ownerSessionId: resolveRoot(candidate),
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
          maxLoopIterations: row.maxLoopIterations,
          permission: row.permission || null,
          permissionMode: row.permissionMode || null,
          toolPermission: row.toolPermission || null,
          schemaAllowedTools: Array.isArray(row.schemaAllowedTools)
            ? row.schemaAllowedTools
            : null,
          sourceType: row.sourceType || 'agent',
          sourceName: row.sourceName || row.agent || 'agent',
          clientHostPid: row.clientHostPid || null,
          createdAt: row.createdAt || null,
          updatedAt: row.updatedAt || row.lastUsedAt || null,
          status: row.closed === true ? 'closed' : (row.status || 'idle'),
          stage: row.closed === true ? 'closed' : (row.stage || row.status || 'idle'),
          messageCount: Number(row.messageCount)
            || (Array.isArray(row.messages) ? row.messages.length : 0),
          lastHandoff: lastStoredAgentHandoff(row),
          closed: row.closed === true,
        });
      }
      agentRehydrated = true;
      return agentSessions.size;
    })().finally(() => {
      if (agentRehydratePromise === loading) agentRehydratePromise = null;
    });
    agentRehydratePromise = loading;
    return loading;
  }

  function agentDescriptor(sessionId) {
    const id = String(sessionId || '').trim();
    const descriptor = agentSessions.get(id);
    if (!descriptor) return null;
    const owner = sessionOwner(id);
    const state = owner?.runtime?.getState?.() || {};
    const status = descriptor.closed
      ? (descriptor.status || 'closed')
      : stateBusy(state)
        ? 'running'
        : (descriptor.status || 'idle');
    return {
      ...descriptor,
      status,
      stage: status,
      messageCount: Array.isArray(state.items) && state.items.length > 0
        ? state.items.length
        : Math.max(0, Number(descriptor.messageCount) || 0),
      updatedAt: descriptor.updatedAt || Date.now(),
    };
  }

  function rootOwnerSessionId(sessionId) {
    const id = String(sessionId || '').trim();
    return agentSessions.get(id)?.ownerSessionId || id || null;
  }

  async function createAgentChild({ spec = {}, prompt = '', tag = null } = {}) {
    await rehydrateAgentSessions();
    const parentSessionId = String(spec.parentSessionId || '').trim();
    if (!parentSessionId) throw new TypeError('agent child parentSessionId is required');
    const ownerSessionId = String(
      spec.ownerSessionId
      || agentSessions.get(parentSessionId)?.ownerSessionId
      || parentSessionId,
    );
    const preset = spec.preset && typeof spec.preset === 'object' ? spec.preset : {};
    const provider = String(preset.provider || spec.provider || '').trim();
    const model = String(preset.model || spec.model || '').trim();
    if (!provider || !model) throw new Error('agent child route is incomplete');
    const sessionProfile = {
      owner: 'agent',
      agent: String(spec.agent || 'worker'),
      parentSessionId,
      ownerSessionId,
      visibility: 'agent-only',
      agentTag: String(spec.agentTag || tag || '').trim() || null,
      taskType: spec.taskType || null,
      maxLoopIterations: spec.maxLoopIterations,
      permission: spec.permission || null,
      permissionMode: spec.permissionMode || null,
      schemaAllowedTools: Array.isArray(spec.schemaAllowedTools)
        ? spec.schemaAllowedTools
        : null,
      sourceType: spec.sourceType || 'agent',
      sourceName: spec.sourceName || spec.agent || 'agent',
      clientHostPid: spec.clientHostPid || null,
    };
    const created = await createSession({
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      effort: preset.effort,
      fast: preset.fast === true,
      modelParameters: preset.modelParameters,
      toolMode: 'full',
      sessionProfile,
    });
    const descriptor = linkAgentDescriptor({
      id: created.sessionId,
      ...sessionProfile,
      cwd: spec.cwd || process.cwd(),
      provider,
      model,
      presetName: preset.id || preset.name || null,
      effort: preset.effort || null,
      fast: preset.fast === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      stage: 'idle',
    });
    void prompt;
    return { session: descriptor, effectiveCwd: descriptor.cwd };
  }

  async function runAgentTurn({
    session,
    prompt,
    context = null,
    onToolResult,
    onTerminalResult,
  } = {}) {
    await rehydrateAgentSessions();
    const sessionId = String(session?.id || session || '').trim();
    const descriptor = agentSessions.get(sessionId);
    if (!descriptor || descriptor.closed) {
      throw new Error(`agent session ${sessionId || '(empty)'} is closed`);
    }
    const entry = await entryForSession(sessionId, {
      cwd: descriptor.cwd,
      provider: descriptor.provider,
      model: descriptor.model,
      toolMode: 'full',
    });
    const target = entry.runtime.submitAndWait;
    if (typeof target !== 'function') {
      throw new TypeError('session runtime must implement submitAndWait');
    }
    descriptor.status = 'running';
    descriptor.stage = 'running';
    descriptor.updatedAt = Date.now();
    try {
      const options = {
        id: `agent-turn-${randomUUID()}`,
        mode: 'prompt',
        priority: 'next',
        context,
        transcriptMeta: { sender: 'lead' },
        ...(entry.runtime.isWireSafe === true || typeof onToolResult !== 'function'
          ? {}
          : { onToolResult }),
      };
      const detail = await target.call(entry.runtime, String(prompt || ''), options);
      if (detail?.status === 'failed') {
        throw new Error(String(detail.error || 'agent session turn failed'));
      }
      if (detail?.status === 'cancelled') {
        throw new Error('agent session turn cancelled');
      }
      const result = detail?.result || { content: '' };
      descriptor.status = 'idle';
      descriptor.stage = 'idle';
      descriptor.lastHandoff = typeof result?.content === 'string' ? result.content : '';
      try { onTerminalResult?.(result); } catch {}
      return result;
    } catch (error) {
      descriptor.status = /cancel/i.test(String(error?.message || '')) ? 'cancelled' : 'error';
      descriptor.stage = descriptor.status;
      throw error;
    } finally {
      descriptor.updatedAt = Date.now();
      retainUnwatched(entry, 'agent child idle');
    }
  }

  function cancelAgentTree(sessionId, reason = 'agent session cancelled') {
    const id = String(sessionId || '').trim();
    if (!id) return Promise.resolve(false);
    const active = agentCancelRuns.get(id);
    if (active) return active;
    let run;
    run = (async () => {
      await rehydrateAgentSessions();
      cancelBackgroundTasks({
        surface: 'agent',
        callerSessionId: id,
        reason,
      });
      const children = [...(agentChildren.get(id) || [])];
      await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
      const descriptor = agentSessions.get(id);
      if (!descriptor) return children.length > 0;
      if (descriptor.closed) return true;
      let entry = sessionOwner(id);
      if (!entry) {
        try {
          entry = await entryForSession(id, {
            cwd: descriptor.cwd,
            provider: descriptor.provider,
            model: descriptor.model,
            toolMode: 'full',
          });
        } catch (error) {
          log(`agent cancel load failed session=${id}: ${error?.message || error}`);
        }
      }
      const closeCanonical = entry?.runtime?.closeCanonicalSession;
      if (typeof closeCanonical !== 'function') {
        throw new TypeError('session runtime must implement closeCanonicalSession');
      }
      const closed = await closeCanonical.call(entry.runtime, reason);
      if (closed !== true) throw new Error(`agent session ${id} could not be durably closed`);
      descriptor.closed = true;
      descriptor.status = 'closed';
      descriptor.stage = 'closed';
      descriptor.updatedAt = Date.now();
      return true;
    })().finally(() => {
      if (agentCancelRuns.get(id) === run) agentCancelRuns.delete(id);
    });
    agentCancelRuns.set(id, run);
    return run;
  }

  async function cancelAgentDescendants(parentSessionId, reason = 'parent session cancelled') {
    await rehydrateAgentSessions();
    const parentId = String(parentSessionId || '');
    cancelBackgroundTasks({
      surface: 'agent',
      callerSessionId: parentId,
      reason,
    });
    const children = [...(agentChildren.get(parentId) || [])];
    if (!children.length) return false;
    await Promise.all(children.map((childId) => cancelAgentTree(childId, reason)));
    return true;
  }

  function agentDescendantSessionIds(parentSessionId) {
    const descendants = [];
    const seen = new Set();
    const visit = (parentId) => {
      for (const childId of agentChildren.get(String(parentId || '')) || []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        descendants.push(childId);
        visit(childId);
      }
    };
    visit(parentSessionId);
    return descendants;
  }

  const agentSurface = Object.freeze({
    canonical: true,
    canRun: (session) => Boolean(agentSessions.get(String(session?.id || ''))),
    createChild: createAgentChild,
    runTurn: runAgentTurn,
  });

  const agentManager = Object.freeze({
    rehydrateAgentSessions,
    descendantSessionIds: agentDescendantSessionIds,
    getSession: (sessionId) => agentDescriptor(sessionId),
    listSessions: ({ includeClosed = false } = {}) => [...agentSessions.keys()]
      .map(agentDescriptor)
      .filter((session) => session && (includeClosed || session.closed !== true)),
    getSessionRuntime: (sessionId) => {
      const session = agentDescriptor(sessionId);
      return session ? { stage: session.stage || session.status || 'idle' } : null;
    },
    async readSessionHandoff(sessionId) {
      const id = String(sessionId || '').trim();
      const descriptor = agentSessions.get(id);
      if (!descriptor) return '';
      if (typeof descriptor.lastHandoff === 'string' && descriptor.lastHandoff.trim()) {
        return descriptor.lastHandoff;
      }
      if (typeof readStoredSession !== 'function') return '';
      const stored = await readStoredSession(id, { includeMessages: true });
      const handoff = lastStoredAgentHandoff(stored);
      if (handoff) descriptor.lastHandoff = handoff;
      return handoff;
    },
    async closeSession(sessionId, reason = 'agent session closed') {
      await rehydrateAgentSessions();
      return cancelAgentTree(sessionId, reason);
    },
    unloadSessionRuntime: () => false,
    hideSessionFromList: () => false,
  });

  return Object.freeze({
    linkAgentDescriptor,
    rehydrateAgentSessions,
    agentDescriptor,
    rootOwnerSessionId,
    createAgentChild,
    runAgentTurn,
    cancelAgentTree,
    cancelAgentDescendants,
    agentDescendantSessionIds,
    agentSurface,
    agentManager,
    hasAgentSession: (sessionId) => agentSessions.has(String(sessionId || '')),
    clear() {
      agentSessions.clear();
      agentChildren.clear();
    },
  });
}
