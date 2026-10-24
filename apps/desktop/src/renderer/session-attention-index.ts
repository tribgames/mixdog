// Which sessions need the user or carry a failure, for every session surface
// (tabs, sidebar rows, project groups) at once. Both come from structural
// state: a pending tool approval (a lane's, the host catalog's) and the agent
// pool's settled rows.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { desktopAgentActivityState, isAwaitingTaskDesktopAgentEntry } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { sessionAttention, type SessionAttention } from '../shared/session-attention';
import { agentPoolStore, startAgentPool } from './agent-activity-model';
import { withoutDismissedAgentRows } from './agent-dismiss';
import { dismissedJobsRevision, subscribeDismissedJobs } from './background-jobs-dismissed-store';
import { browserApprovalSessionIds, subscribeBrowserApprovalSessions } from './browser-approval-marks';
import { catalogApprovalSessionIds, subscribeCatalogApprovalSessions } from './session-catalog-approvals';
import { defaultSessionLaneStore } from './session-lane-store';

interface SessionAttentionIndex {
  needsUser: ReadonlySet<string>;
  /** The needsUser sessions whose wait is an ask_user question (known from a
   *  shown session's lane; the catalog marks carry no kind). */
  asking: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  /** Sessions whose own agent waits on background work it handed off. */
  waiting: ReadonlySet<string>;
}

const EMPTY_INDEX: SessionAttentionIndex = {
  needsUser: new Set(),
  asking: new Set(),
  failed: new Set(),
  waiting: new Set(),
};

/** An agent's state belongs to its own session and to the sessions above it
 *  (its spawn parent and its root owner): a Lead whose worker waits on an
 *  approval needs the user too. */
function agentSessionChain(agent: DesktopAgentPoolRow): string[] {
  return [agent.sessionId, agent.parentSessionId, agent.ownerSessionId]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
}

/** The sessions waiting on a tool approval, each from its one current source:
 *  a session shown in a pane whose lane has received a frame since it became
 *  shown (`liveSessionIds`) from its lane, every other one from the host
 *  catalog — a just-opened pane keeps the catalog's mark until its first frame. A lane left behind by a pane keeps its
 *  last frame, so an approval answered elsewhere would stay on it. */
export function effectiveApprovalSessionIds(
  laneApprovalSessionIds: ReadonlySet<string>,
  catalogApprovalSessionIds: ReadonlySet<string>,
  liveSessionIds: ReadonlySet<string>
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const id of laneApprovalSessionIds) if (liveSessionIds.has(id)) ids.add(id);
  for (const id of catalogApprovalSessionIds) if (!liveSessionIds.has(id)) ids.add(id);
  return ids;
}

export function sessionAttentionIndex(
  pool: readonly DesktopAgentPoolRow[] | null | undefined,
  approvalSessionIds: ReadonlySet<string>,
  browserApprovalSessionIds: ReadonlySet<string> = new Set(),
  questionSessionIds: ReadonlySet<string> = new Set()
): SessionAttentionIndex {
  const needsUser = new Set([...approvalSessionIds, ...browserApprovalSessionIds]);
  const asking = new Set([...questionSessionIds].filter((id) => approvalSessionIds.has(id)));
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
  // A pool agent's approval on the same session outranks the question mark.
  for (const agent of pool || []) {
    if (desktopAgentActivityState(agent) === 'needs-user') for (const id of agentSessionChain(agent)) asking.delete(id);
  }
  for (const id of browserApprovalSessionIds) asking.delete(id);
  if (needsUser.size === 0 && failed.size === 0 && waiting.size === 0) return EMPTY_INDEX;
  return { needsUser, asking, failed, waiting };
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
    asking: index.asking.has(sessionId),
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
  questions: ReadonlySet<string>;
  browserApprovals: ReadonlySet<string>;
  catalogApprovals: ReadonlySet<string>;
  liveSessions: ReadonlySet<string>;
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
  const questions = defaultSessionLaneStore.questionSessionIds();
  const browserApprovals = browserApprovalSessionIds();
  const catalogApprovals = catalogApprovalSessionIds();
  const liveSessions = defaultSessionLaneStore.liveSessionIds();
  const dismissedRevision = dismissedJobsRevision();
  const cached = selections.get(store);
  if (
    cached &&
    cached.rows === rows &&
    cached.approvals === approvals &&
    cached.questions === questions &&
    cached.browserApprovals === browserApprovals &&
    cached.catalogApprovals === catalogApprovals &&
    cached.liveSessions === liveSessions &&
    cached.dismissedRevision === dismissedRevision
  ) {
    return cached.index;
  }
  const next = sessionAttentionIndex(
    withoutDismissedAgentRows(rows),
    effectiveApprovalSessionIds(approvals, catalogApprovals, liveSessions),
    browserApprovals,
    // A lane's question kind counts only while that lane is live: a left
    // session's cached question must not mask its catalog approval.
    new Set([...questions].filter((id) => liveSessions.has(id)))
  );
  const index =
    cached &&
    sameIds(cached.index.needsUser, next.needsUser) &&
    sameIds(cached.index.asking, next.asking) &&
    sameIds(cached.index.failed, next.failed) &&
    sameIds(cached.index.waiting, next.waiting)
      ? cached.index
      : next;
  selections.set(store, {
    rows,
    approvals,
    questions,
    browserApprovals,
    catalogApprovals,
    liveSessions,
    dismissedRevision,
    index,
  });
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
        subscribeBrowserApprovalSessions(listener),
        subscribeCatalogApprovalSessions(listener),
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
