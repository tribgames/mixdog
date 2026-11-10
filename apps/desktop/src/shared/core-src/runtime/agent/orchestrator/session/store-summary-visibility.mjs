import { isStoredSessionId } from './store-summary-fields.mjs';

const SESSION_VISIBILITY_ORDINARY = 'ordinary';
const SESSION_VISIBILITY_AGENT_ONLY = 'agent-only';

function clean(value) {
  return String(value || '').trim();
}

function linkedParentSessionId(value) {
  if (!value || typeof value !== 'object') return '';
  for (const candidate of [value.ownerSessionId, value.parentSessionId]) {
    const id = clean(candidate);
    if (isStoredSessionId(id)) return id;
  }
  return '';
}

/** A root Lead may carry a self owner link, but it is not a child session. */
export function isRootLeadSession(value) {
  if (!value || typeof value !== 'object') return false;
  if (clean(value.agent).toLowerCase() !== 'lead') return false;
  const id = clean(value.id);
  const parentId = linkedParentSessionId(value);
  return !parentId || parentId === id;
}

/** Backward-compatible classification for child records written before the
 * durable visibility field existed. Both Agent ownership and an external,
 * valid parent link are required so ownerless/root sessions remain ordinary. */
function isCanonicalAgentChildSession(value) {
  if (!value || typeof value !== 'object') return false;
  const id = clean(value.id);
  const parentId = linkedParentSessionId(value);
  return clean(value.owner).toLowerCase() === 'agent' && Boolean(parentId) && parentId !== id;
}

export function sessionVisibility(value) {
  // Root Lead sessions are ordinary catalog entries even if stale metadata
  // accidentally retained an agent-only declaration.
  if (isRootLeadSession(value)) return SESSION_VISIBILITY_ORDINARY;
  const declared = clean(value?.visibility || value?.sessionVisibility).toLowerCase();
  if (declared === SESSION_VISIBILITY_AGENT_ONLY || isCanonicalAgentChildSession(value)) {
    return SESSION_VISIBILITY_AGENT_ONLY;
  }
  return SESSION_VISIBILITY_ORDINARY;
}

export function isAgentOnlySession(value) {
  return sessionVisibility(value) === SESSION_VISIBILITY_AGENT_ONLY;
}

/** Every session a record links itself to as its owner or parent (both links,
 *  never itself): the links the descendant walk and the sub-agent retention
 *  trees follow. */
export function agentParentIds(value) {
  const id = clean(value?.id);
  return [...new Set([clean(value?.ownerSessionId), clean(value?.parentSessionId)])].filter(
    (parent) => parent && parent !== id
  );
}

/** The agent-only sessions under `rootId` at any depth, from session rows. A
 *  catalog row links a sub-agent to its root Lead (`ownerSessionId`) or, on a
 *  legacy row, to its parent, so the walk follows every link a row names. */
export function agentDescendantIds(rows, rootId) {
  const root = clean(rootId);
  const children = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isAgentOnlySession(row)) continue;
    const id = clean(row.id);
    if (!id) continue;
    for (const parent of agentParentIds(row)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
  }
  const found = new Set();
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.pop()) || []) {
      if (child === root || found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}
