// agent-tree/agent-registry.mjs
// The Parent–Child routing layer over daemon-owned sessions: descriptors by
// id, children by parent, and the root owner every descendant inherits.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function createAgentRegistry() {
  const agentSessions = new Map();
  const agentChildren = new Map();

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
        descriptor.ownerSessionId ||
          previous?.ownerSessionId ||
          agentSessions.get(parentSessionId)?.ownerSessionId ||
          parentSessionId
      ),
      owner: 'agent',
      visibility: 'agent-only',
      closed: descriptor.closed === true,
    };
    agentSessions.set(sessionId, linked);
    if (!agentChildren.has(parentSessionId)) agentChildren.set(parentSessionId, new Set());
    agentChildren.get(parentSessionId).add(sessionId);
    return linked;
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

  return {
    linkAgentDescriptor,
    agentDescendantSessionIds,
    get: (sessionId) => agentSessions.get(String(sessionId || '').trim()),
    has: (sessionId) => agentSessions.has(String(sessionId || '')),
    ids: () => [...agentSessions.keys()],
    size: () => agentSessions.size,
    childrenOf: (parentId) => [...(agentChildren.get(String(parentId || '')) || [])],
    rootOwnerSessionId(sessionId) {
      const id = String(sessionId || '').trim();
      return agentSessions.get(id)?.ownerSessionId || id || null;
    },
    clear() {
      agentSessions.clear();
      agentChildren.clear();
    },
  };
}
