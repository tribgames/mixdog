/**
 * Per-agent notification mute, kept by the host beside its other desktop
 * metadata (`agent-notifications.json` in the app profile). A muted agent's
 * phone and desktop pushes are all silenced — turn results, failures, approval
 * and held requests (push-notifier.ts checks it before sending). In-app state
 * is not touched: unread counts, the Agents-list attention mark, held-request
 * cards and their expiry stay exactly as they are.
 */
import { join } from 'node:path';
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { readJsonStateSync, writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { runOwnerOf } from '../../../../src/runtime/shared/held-request-host.mjs';

const AGENT_ID = /^[a-z0-9][a-z0-9.-]{0,199}$/;

export function agentNotificationMutePath(userDataPath: string): string {
  return join(userDataPath, 'agent-notifications.json');
}

/** The agent a session's pushes belong to: a home thread, a room member
 *  session, or an unattended schedule/webhook run of that agent; any other
 *  session belongs to no agent (''). */
export function notificationAgentOfSession(sessionId: string): string {
  return agentIdOfHomeSession(sessionId) || roomMemberOfSession(sessionId)?.agentId || runOwnerOf(sessionId) || '';
}

function mutedDoc(value: unknown): { muted?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The mute list is not an object.');
  }
  return value as { muted?: unknown };
}

/** The muted agents on disk (the window process reads this fresh per notification). */
export function readMutedAgents(filePath: string): Set<string> {
  try {
    // A damaged file (NUL-filled, truncated) is kept aside and its last good
    // copy read, so the mutes survive instead of being written over.
    const doc = readJsonStateSync(filePath, { validate: mutedDoc, fallback: {} });
    return new Set(Array.isArray(doc.muted) ? doc.muted.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // An unreadable file (an I/O error): nobody is muted.
    return new Set();
  }
}

/** `sessionId` belongs to an agent muted in the file at `filePath`. */
export function isSessionMutedOnDisk(filePath: string, sessionId: string): boolean {
  const agentId = notificationAgentOfSession(sessionId);
  return Boolean(agentId) && readMutedAgents(filePath).has(agentId);
}

export function createAgentNotificationMuteStore(filePath: string) {
  let muted = readMutedAgents(filePath);
  let writing: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    const doc = { muted: [...muted].sort() };
    // A failed write must not poison every later one.
    const write = writing
      .catch(() => undefined)
      .then(async () => {
        await writeJsonAtomicAsync(filePath, doc, { backup: true });
      });
    writing = write;
    return write;
  };
  return {
    isMuted(agentId: string): boolean {
      return muted.has(agentId);
    },
    /** Whether pushes for `sessionId` are silenced by its agent's mute. */
    isSessionMuted(sessionId: string): boolean {
      const agentId = notificationAgentOfSession(sessionId);
      return Boolean(agentId) && muted.has(agentId);
    },
    async setMuted(agentId: string, value: boolean): Promise<boolean> {
      if (!AGENT_ID.test(agentId)) throw new TypeError('agent id is invalid.');
      if (muted.has(agentId) === value) return value;
      muted = new Set(muted);
      if (value) muted.add(agentId);
      else muted.delete(agentId);
      await persist();
      return value;
    },
  };
}

export type AgentNotificationMuteStore = ReturnType<typeof createAgentNotificationMuteStore>;
