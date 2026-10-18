// Which sessions need the user or carry a failure, for every session surface
// (tabs, sidebar rows, project groups) at once. Both come from structural
// state: a lane's pending tool approval and the agent pool's settled rows.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { desktopAgentActivityState, isAwaitingTaskDesktopAgentEntry } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { sessionAttention, type SessionAttention } from '../shared/session-attention';
import { agentPoolStore, startAgentPool } from './agent-activity-model';
import { withoutDismissedAgentRows } from './agent-dismiss';
import { dismissedJobsRevision, subscribeDismissedJobs } from './background-jobs-dismissed-store';
import { defaultSessionLaneStore } from './session-lane-store';

interface SessionAttentionIndex {
  needsUser: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  /** Sessions whose own agent waits on background work it handed off. */
  waiting: ReadonlySet<string>;
}

const EMPTY_INDEX: SessionAttentionIndex = { needsUser: new Set(), failed: new Set(), waiting: new Set() };

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
  const waiting = new Set<string>();
  for (const agent of pool || []) {
    const state = desktopAgentActivityState(agent);
    if (state === 'needs-user') for (const id of agentSessionChain(agent)) needsUser.add(id);
    // A failure is the agent's own state: only its own session reads failed
    // (the Lead's row for a Lead turn failure). A sub-agent's failure stays in
    // the agents chip and popover, never on the sessions above it.
    else if (state === 'failed') {
      const own = String(agent.sessionId || '').trim();
      if (own) failed.add(own);
    }
    // Only the agent's own session: its owner may still be working.
    else if (state === 'waiting' && isAwaitingTaskDesktopAgentEntry(agent)) {
      const own = String(agent.sessionId || '').trim();
      if (own) waiting.add(own);
    }
  }
  if (needsUser.size === 0 && failed.size === 0 && waiting.size === 0) return EMPTY_INDEX;
  return { needsUser, failed, waiting };
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
    waiting: index.waiting.has(sessionId),
    running,
    unread,
  });
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

type AttentionPoolStore = ReturnType<typeof agentPoolStore>;
interface AttentionSelection {
  rows: readonly DesktopAgentPoolRow[] | null;
  approvals: ReadonlySet<string>;
  dismissedRevision: number;
  index: SessionAttentionIndex;
}
const selections = new WeakMap<AttentionPoolStore, AttentionSelection>();

/** The index for the store's current inputs, as the SAME object while its
 *  sets are unchanged: a pool frame (each reconcile, each running agent's
 *  progress) re-renders a subscriber only when an attention mark changes. */
function selectSessionAttentionIndex(store: AttentionPoolStore): SessionAttentionIndex {
  const rows = store.getSnapshot();
  const approvals = defaultSessionLaneStore.approvalSessionIds();
  const dismissedRevision = dismissedJobsRevision();
  const cached = selections.get(store);
  if (
    cached &&
    cached.rows === rows &&
    cached.approvals === approvals &&
    cached.dismissedRevision === dismissedRevision
  ) {
    return cached.index;
  }
  const next = sessionAttentionIndex(withoutDismissedAgentRows(rows), approvals);
  const index =
    cached &&
    sameIds(cached.index.needsUser, next.needsUser) &&
    sameIds(cached.index.failed, next.failed) &&
    sameIds(cached.index.waiting, next.waiting)
      ? cached.index
      : next;
  selections.set(store, { rows, approvals, dismissedRevision, index });
  return index;
}

export function useSessionAttentionIndex(): SessionAttentionIndex {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  useEffect(() => startAgentPool(poolStore), [poolStore]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = [
        poolStore.subscribe(listener),
        defaultSessionLaneStore.subscribeApprovals(listener),
        subscribeDismissedJobs(listener),
      ];
      return () => {
        for (const release of releases) release();
      };
    },
    [poolStore]
  );
  const select = useCallback(() => selectSessionAttentionIndex(poolStore), [poolStore]);
  return useSyncExternalStore(subscribe, select, select);
}
