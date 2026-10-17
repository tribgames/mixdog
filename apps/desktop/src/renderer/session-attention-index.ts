// Which sessions need the user or carry a failure, for every session surface
// (tabs, sidebar rows, project groups) at once. Both come from structural
// state: a lane's pending tool approval and the agent pool's settled rows.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { desktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { sessionAttention, type SessionAttention } from '../shared/session-attention';
import { agentPoolStore, startAgentPool } from './agent-activity-model';
import { useVisibleAgentPool } from './agent-dismiss';
import { defaultSessionLaneStore } from './session-lane-store';

export interface SessionAttentionIndex {
  needsUser: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}

const EMPTY_INDEX: SessionAttentionIndex = { needsUser: new Set(), failed: new Set() };

/** An agent's state belongs to its own session and to the sessions above it
 *  (its spawn parent and its root owner): a Lead whose worker waits on an
 *  approval needs the user too. */
function agentSessionChain(agent: DesktopAgentPoolRow): string[] {
  return [agent.sessionId, agent.parentSessionId, agent.ownerSessionId]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
}

export function sessionAttentionIndex(
  pool: readonly DesktopAgentPoolRow[] | null | undefined,
  approvalSessionIds: ReadonlySet<string>
): SessionAttentionIndex {
  const needsUser = new Set(approvalSessionIds);
  const failed = new Set<string>();
  for (const agent of pool || []) {
    const state = desktopAgentActivityState(agent);
    if (state === 'needs-user') for (const id of agentSessionChain(agent)) needsUser.add(id);
    else if (state === 'failed') for (const id of agentSessionChain(agent)) failed.add(id);
  }
  if (needsUser.size === 0 && failed.size === 0) return EMPTY_INDEX;
  return { needsUser, failed };
}

/** The status one session shows, from the index plus the caller's own
 *  working and unread answers. */
export function sessionAttentionOf(
  index: SessionAttentionIndex,
  sessionId: string,
  { running = false, unread = false }: { running?: boolean; unread?: boolean } = {}
): SessionAttention | '' {
  return sessionAttention({
    needsUser: index.needsUser.has(sessionId),
    failed: index.failed.has(sessionId),
    running,
    unread,
  });
}

export function useSessionAttentionIndex(): SessionAttentionIndex {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  useEffect(() => startAgentPool(poolStore), [poolStore]);
  const pool = useVisibleAgentPool(
    useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot)
  );
  const approvals = useSyncExternalStore(
    defaultSessionLaneStore.subscribeApprovals,
    defaultSessionLaneStore.approvalSessionIds,
    defaultSessionLaneStore.approvalSessionIds
  );
  return useMemo(() => sessionAttentionIndex(pool, approvals), [pool, approvals]);
}
