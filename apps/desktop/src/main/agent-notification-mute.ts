/**
 * Per-agent notification mute, kept by the host beside its other desktop
 * metadata (`agent-notifications.json` in the app profile). A muted agent's
 * phone and desktop pushes are all silenced — turn results, failures, approval
 * and held requests (push-notifier.ts checks it before sending). In-app state
 * is not touched: unread counts, the Agents-list attention mark, held-request
 * cards and their expiry stay exactly as they are.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { agentIdOfHomeSession } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
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

/** The muted agents on disk (the window process reads this fresh per notification). */
export function readMutedAgents(filePath: string): Set<string> {
  try {
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as { muted?: unknown };
    return new Set(Array.isArray(doc.muted) ? doc.muted.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    // No file yet (or an unreadable one): nobody is muted.
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
    const body = `${JSON.stringify({ muted: [...muted].sort() }, null, 2)}\n`;
    // A failed write must not poison every later one.
    const write = writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        await writeFile(temp, body, 'utf8');
        await rename(temp, filePath);
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
