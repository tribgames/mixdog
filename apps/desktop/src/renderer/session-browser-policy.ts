import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession, roomSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { DesktopAgentPoolRow, DesktopBrowserOpenRequest, DesktopSessionSummary } from '../shared/contract';

export type SessionBrowserPaneOwner = {
  leafId: string;
  sessionId: string | null;
};

type SessionBrowserRevealPlan = {
  leafId: string | null;
};

/** The ownership records a session's surfaces climb (the same the Browser
 *  Use approvals read, main/browser/approval-requester.ts): the agent pool
 *  for sub-agents, the catalog for a bot's task sessions. */
export type SurfaceOwnerSources = {
  sessions: readonly Pick<DesktopSessionSummary, 'id' | 'title' | 'taskAgent' | 'taskFrom'>[];
  pool: readonly Pick<DesktopAgentPoolRow, 'sessionId' | 'parentSessionId' | 'ownerSessionId' | 'title' | 'tag'>[];
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** `sessionId` and the conversations its surfaces belong to, nearest first:
 *  a sub-agent's spawn parents up to the session it works for (pool
 *  `ownerSessionId`), a room member's room log, a task session a bot made
 *  from its own chat → that bot's home. [sessionId] for anything else. */
export function surfaceOwnerChain(sessionId: string, sources: SurfaceOwnerSources): string[] {
  const chain = [sessionId];
  const add = (id: unknown) => {
    const clean = text(id);
    if (clean && !chain.includes(clean)) chain.push(clean);
  };
  let row = sources.pool.find((entry) => entry.sessionId === sessionId);
  while (row) {
    // A parent already on the chain closes a cycle: stop there, never loop.
    const parent = text(row.parentSessionId);
    const visited = chain.includes(parent);
    add(parent);
    const next = visited ? undefined : sources.pool.find((entry) => entry.sessionId === parent);
    if (!next) {
      add(row.ownerSessionId);
      break;
    }
    row = next;
  }
  const top = chain.at(-1) ?? sessionId;
  const member = roomMemberOfSession(top);
  if (member) add(roomSessionId(member.roomId));
  const task = sources.sessions.find((entry) => entry.id === top);
  if (task?.taskAgent && task.taskFrom === 'home') add(agentHomeSessionId(task.taskAgent));
  return chain;
}

/** How the owner conversation names a child session: its pool title or tag,
 *  else its catalog title; '' when neither knows it. */
export function surfaceSessionName(sessionId: string, sources: SurfaceOwnerSources): string {
  const row = sources.pool.find((entry) => entry.sessionId === sessionId);
  const session = sources.sessions.find((entry) => entry.id === sessionId);
  return text(row?.title) || text(row?.tag) || text(session?.title);
}

/** Where a session's surface reveals: the nearest conversation of its owner
 *  chain a pane shows (`sessionId` names it), else no pane and the session
 *  itself, parked until one of the chain is shown. Panes are never guessed:
 *  only the chain's own conversations are candidates. */
export function surfaceRevealTarget(
  owners: readonly SessionBrowserPaneOwner[],
  chain: readonly string[],
  focusedLeafId: string
): { leafId: string | null; sessionId: string } {
  for (const sessionId of chain) {
    const { leafId } = browserSurfaceRevealPlan(owners, sessionId, focusedLeafId);
    if (leafId) return { leafId, sessionId };
  }
  return { leafId: null, sessionId: chain[0] ?? '' };
}

export function browserSurfaceRequestShouldReveal(request: DesktopBrowserOpenRequest): boolean {
  return request.hide !== true && request.reveal !== false;
}

/**
 * A foreground Browser Use request reveals beside a visible owner. A hidden
 * owner stays parked until the user returns to it. Duplicate views prefer the
 * focused pane.
 */
export function browserSurfaceRevealPlan(
  owners: readonly SessionBrowserPaneOwner[],
  sessionId: string,
  focusedLeafId: string
): SessionBrowserRevealPlan {
  const matching = owners.filter((owner) => owner.sessionId === sessionId);
  const leafId = matching.find((owner) => owner.leafId === focusedLeafId)?.leafId ?? matching[0]?.leafId ?? null;
  return { leafId };
}
