import { isRememberableAction } from './outbound-policy.mjs';

export const SESSION_GRANT_TTL_MS = 12 * 60 * 60 * 1000;

/** Most grants held at once (a session holds at most one per action kind). */
export const MAX_SESSION_GRANTS = 256;

const text = (value) => (typeof value === 'string' ? value : '');

/** @param {{ now?: () => number, ttlMs?: number }} [options] */
export function createSessionGrants({
  now = () => Date.now(),
  ttlMs = SESSION_GRANT_TTL_MS,
  maxEntries = MAX_SESSION_GRANTS,
} = {}) {
  /** `session\naction` → { agentId, mark, expiresAt }, oldest grant first. */
  const grants = new Map();
  const keyOf = (sessionId, action) => `${sessionId}\n${action}`;
  const live = (entry, agentId, mark) => entry.expiresAt > now() && entry.agentId === agentId && entry.mark === mark;
  const prune = () => {
    const at = now();
    for (const [key, entry] of grants) if (entry.expiresAt <= at) grants.delete(key);
  };
  return {
    /** Allow `action` for `sessionId` as `agentId`; false for an unknown session,
     *  a kind that is never remembered, or a missing id. */
    grant({ sessionId, agentId, action, mark = '' }) {
      if (!text(sessionId) || !text(agentId) || !isRememberableAction(action)) return false;
      prune();
      const key = keyOf(sessionId, action);
      grants.delete(key);
      grants.set(key, { agentId, mark: text(mark), expiresAt: now() + ttlMs });
      // Bounded: the oldest grants go first.
      while (grants.size > maxEntries) grants.delete(grants.keys().next().value);
      return true;
    },
    /** Whether `action` is allowed for this very session, agent and life of it. */
    has({ sessionId, agentId, action, mark = '' }) {
      if (!isRememberableAction(action)) return false;
      prune();
      const key = keyOf(sessionId, action);
      const entry = grants.get(key);
      if (!entry) return false;
      if (live(entry, agentId, text(mark))) return true;
      grants.delete(key);
      return false;
    },
    /** The session ended or was reset: nothing it was granted survives. */
    end(sessionId) {
      for (const key of [...grants.keys()]) if (key.startsWith(`${sessionId}\n`)) grants.delete(key);
    },
  };
}
