import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from './desktop-types';
import { turnReviewScope } from './renderer-logic.mjs';
import { isMobileRemoteSurface } from './mobile-surface';
import { useTurnChangesEpoch } from './turn-changes-model';
import {
  beginTurnReviewRequest,
  endTurnReviewRequest,
  isLatestTurnReviewRequest,
  recordTurnReviewAnswer,
  turnReviewPrefetch,
} from './turn-review-prefetch';
import {
  leadReviewSnapshotKindCache,
  reviewTagCache,
  type AgentTurnReview,
  type TurnReviewFile,
} from './turn-review-cache';
import { cachedTurnReviewState, TURN_REVIEW_CAPABILITY, type TurnReviewCapabilityValue } from './turn-review-model';
import type { useTurnReviewDisclosure } from './use-turn-review-disclosure';

type AgentReviewState = {
  scopeKey: string;
  reviews: AgentTurnReview[];
  leadPatch: string | null;
  files: TurnReviewFile[];
  snapshotKind: string;
  checkpointId: string;
  historyTurns: number;
};

type ReadRequest = {
  scopeKey: string;
  boundaryKey: string;
  refreshWorktree: boolean;
  summary: boolean;
  background: boolean;
};

type RefreshAgentReviews = (refreshWorktree?: boolean, background?: boolean) => Promise<void>;

type ReadContext = {
  sessionId: string | undefined;
  turnScopeKey: string;
  checkpoint: string;
  reviewBoundaryKey: string;
  detailShown: MutableRefObject<boolean>;
  activeScope: MutableRefObject<string>;
  /** The read this pane has outstanding for its current scope. */
  capabilityRequestInFlight: MutableRefObject<ReadRequest | null>;
  sameCommitRequest: MutableRefObject<ReadRequest | null>;
  pendingCapabilityRefresh: MutableRefObject<ReadRequest | null>;
  refreshAgentReviewsRef: MutableRefObject<RefreshAgentReviews>;
  lastAgentReviewSignature: MutableRefObject<string | null>;
  setAgentReviewState(state: AgentReviewState): void;
  setAnsweredSession(session: string): void;
};

/** The session's turn scope. A long turn's prompt row can fall out of the
 *  transcript tail the daemon sends. The rows left are still that turn, so it
 *  keeps its scope: the shared `none` scope held an unrelated earlier review
 *  and skipped the checkpoint check (user: 컴포저 위 디프가 엉뚱한 숫자가 나왔다 사라짐). */
function useTurnReviewScope(items: TranscriptItem[], sessionId: string | undefined) {
  const reviewSession = String(sessionId || 'draft');
  const rememberedScope = useRef<{ session: string; key: string } | null>(null);
  const reviewScope = useMemo(() => {
    const scope = turnReviewScope(items);
    if (!scope.truncated) {
      if (scope.key !== 'none') rememberedScope.current = { session: reviewSession, key: scope.key };
      return scope;
    }
    const remembered = rememberedScope.current;
    return remembered?.session === reviewSession ? { ...scope, key: remembered.key } : scope;
  }, [items, reviewSession]);
  const turnScopeKey = `${String(sessionId || 'draft')}:${reviewScope.key}`;
  const activeScope = useRef(turnScopeKey);
  activeScope.current = turnScopeKey;
  return { reviewSession, reviewScope, turnScopeKey, activeScope };
}

/** One turn-review capability read, coalesced with any read in flight. */
async function requestTurnReview(ctx: ReadContext, refreshWorktree: boolean, background: boolean) {
  const { sessionId, reviewBoundaryKey, capabilityRequestInFlight, sameCommitRequest, pendingCapabilityRefresh } = ctx;
  const api = window.mixdogDesktop as
    | {
        invokeCapability?: (request: {
          capability: string;
          args: unknown[];
          sessionId?: string;
        }) => Promise<{ value?: unknown }>;
      }
    | undefined;
  const requestedScope = ctx.turnScopeKey;
  const requestedCheckpoint = ctx.checkpoint;
  if (!sessionId || !api?.invokeCapability) return;
  if (document.visibilityState === 'hidden') return;
  const summary = !ctx.detailShown.current;
  // Only a read for the same scope coalesces. The pane keeps this hook across
  // session switches: queueing the incoming session's entry read behind the
  // previous session's worktree capture held its review bar (and the pane's
  // reveal) for seconds. The outgoing read still answers its own cache.
  if (capabilityRequestInFlight.current?.scopeKey === requestedScope) {
    // The boundary effect and the busy poll both ask when one commit moves
    // a boundary: the read already sent for it answers both, so a queued
    // follow-up would only repeat it.
    const issued = sameCommitRequest.current;
    if (
      issued?.scopeKey === requestedScope &&
      issued.boundaryKey === reviewBoundaryKey &&
      (!issued.summary || summary) &&
      (issued.refreshWorktree || !refreshWorktree) &&
      (!issued.background || background)
    ) {
      return;
    }
    const pending = pendingCapabilityRefresh.current;
    const samePending = pending?.scopeKey === requestedScope;
    pendingCapabilityRefresh.current = {
      scopeKey: requestedScope,
      boundaryKey: reviewBoundaryKey,
      refreshWorktree: refreshWorktree || (samePending && pending.refreshWorktree),
      summary,
      // A queued foreground read stays foreground when a poll joins it.
      background: background && (!samePending || pending.background),
    };
    return;
  }
  const issued = { scopeKey: requestedScope, boundaryKey: reviewBoundaryKey, refreshWorktree, summary, background };
  capabilityRequestInFlight.current = issued;
  const generation = beginTurnReviewRequest(requestedScope);
  let recorded = false;
  let cachedAnswer = false;
  sameCommitRequest.current = issued;
  queueMicrotask(() => {
    if (sameCommitRequest.current === issued) sameCommitRequest.current = null;
  });
  try {
    // This bar belongs to the pane's session. During a tab switch the host's
    // focused view can already point elsewhere, so omitting this address
    // mixed another turn's diff into the bar and could hit a stale view.
    // The tag lives with the cached review it names, so `unchanged` is only
    // ever asked for a review this scope still holds.
    // A `none` scope names no turn, so nothing read under it is kept for
    // a later mount to show as its own review.
    const cacheable = requestedCheckpoint !== 'none';
    // The entry read a session's open already started is this same request
    // (stored summary, no worktree refresh, foreground): its answer is taken
    // rather than asked for again. A refresh, a poll and an expanded patch are
    // different requests and are issued as usual.
    const entryRead = !refreshWorktree && summary && !background ? turnReviewPrefetch(requestedScope) : undefined;
    let result = entryRead ? await entryRead : null;
    if (!result) {
      const known = cacheable ? (reviewTagCache.get(requestedScope) ?? '') : '';
      // The collapsed bar draws files and counts only. Its patch text is
      // most of each read (and, for a large change, most of its cost), so
      // it is read once the bar is opened.
      result = await api.invokeCapability({
        capability: TURN_REVIEW_CAPABILITY,
        args: [
          {
            refresh: refreshWorktree,
            ...(known ? { known } : {}),
            ...(summary ? { summary } : {}),
            ...(background ? { poll: 'background' } : {}),
          },
        ],
        sessionId,
      });
    }
    const value = (result?.value ?? null) as TurnReviewCapabilityValue;
    // Leaving and re-entering a scope issues a newer read of it while this
    // one runs; that read owns the scope's cache and state.
    if (!isLatestTurnReviewRequest(requestedScope, generation)) return;
    if (value?.unchanged === true) return;
    recorded = value?.reason === 'recorded';
    cachedAnswer = value?.reason === 'cached';
    const decoded = recordTurnReviewAnswer(sessionId, requestedScope, requestedCheckpoint, value);
    if (!decoded) return;
    const { leadPatch, snapshotKind, checkpointId, files, reviews, historyTurns } = decoded;
    const signature = JSON.stringify([leadPatch, files, snapshotKind, checkpointId, reviews, historyTurns]);
    // The signature belongs to the active scope: an outgoing session's answer
    // (cached above) must not mark the incoming one's review as already shown.
    if (ctx.activeScope.current !== requestedScope) return;
    if (ctx.lastAgentReviewSignature.current === signature) return;
    ctx.lastAgentReviewSignature.current = signature;
    ctx.setAgentReviewState({
      scopeKey: requestedScope,
      reviews,
      leadPatch,
      files,
      snapshotKind,
      checkpointId,
      historyTurns,
    });
  } catch {
    // The next turn boundary, visibility change, expansion, or bounded idle
    // refresh retries. A transient read must never permanently lock Revert.
  } finally {
    const latest = endTurnReviewRequest(requestedScope, generation);
    if (latest && ctx.activeScope.current === requestedScope) ctx.setAnsweredSession(String(sessionId));
    // A superseded read neither releases nor drains the newer scope's lane.
    if (capabilityRequestInFlight.current === issued) {
      capabilityRequestInFlight.current = null;
      let pending = pendingCapabilityRefresh.current;
      pendingCapabilityRefresh.current = null;
      // A cached summary is the last computed answer, not the worktree now:
      // a refreshing read always follows it (entry and idle backoff alike).
      if (cachedAnswer && !pending?.refreshWorktree) pending = { ...(pending ?? issued), refreshWorktree: true };
      // A recorded review already reflects the current worktree: the
      // refreshing read queued behind it for the same boundary (an idle
      // entry asks twice) would only compute it again. A summary cannot
      // satisfy an expansion that asked for the actual patch while it ran.
      const repeatsRecorded =
        recorded &&
        pending?.scopeKey === requestedScope &&
        pending.boundaryKey === issued.boundaryKey &&
        (!issued.summary || pending.summary);
      if (pending && !repeatsRecorded && ctx.activeScope.current === pending.scopeKey) {
        void ctx.refreshAgentReviewsRef.current(pending.refreshWorktree, pending.background);
      }
    }
  }
}

/** Re-reads at turn boundaries, while busy or open, and on an idle backoff. */
function useTurnReviewRefreshSchedule({
  active,
  busy,
  expanded,
  hasTurnActivity,
  agentReviewCount,
  turnBoundaryKey,
  mutations,
  entryPendingRef,
  refreshAgentReviews,
}: {
  active: boolean;
  busy: boolean;
  expanded: boolean;
  hasTurnActivity: boolean;
  agentReviewCount: number;
  turnBoundaryKey: string;
  /** The session's change-history epoch (Undo/Reapply, Delete history). */
  mutations: number;
  entryPendingRef: MutableRefObject<boolean>;
  refreshAgentReviews: RefreshAgentReviews;
}) {
  // Opening the review reads the worktree now; every other read while the
  // turn runs may be answered from a recent capture.
  const wasExpanded = useRef(false);
  const boundaryInBackground = busy && !(expanded && !wasExpanded.current);
  useEffect(() => {
    wasExpanded.current = expanded;
  }, [expanded]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnBoundaryKey stands in for items, mutations for a history change, as re-run triggers
  useEffect(() => {
    // A tool/turn boundary is the authoritative point at which the visible
    // count must catch up. If an older request is still running, the callback
    // above coalesces this into one mandatory follow-up refresh instead of
    // dropping the final file set and leaving an earlier count on screen.
    if (active && hasTurnActivity) {
      // An idle entry asks the runtime's held snapshot first (fast), then the
      // fresh worktree read queues behind it.
      if (entryPendingRef.current && !busy) void refreshAgentReviews(false);
      // A tool boundary inside a running turn is a `background` read, so the
      // daemon's capture gap applies instead of forcing a worktree capture at
      // every tool. The turn's end, an idle entry and an opening review still
      // capture now (the runtime also seals the turn with a fresh capture).
      void refreshAgentReviews(true, boundaryInBackground);
    }
  }, [active, busy, refreshAgentReviews, hasTurnActivity, turnBoundaryKey, mutations]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnBoundaryKey re-runs the schedule at each turn boundary
  useEffect(() => {
    if (!active || (!hasTurnActivity && agentReviewCount === 0)) return undefined;
    // While a turn is active (or the review is open), keep the display fresh.
    // Once idle, use a bounded backoff window to catch a late child completion
    // without leaving every mounted session on a permanent six-second poll.
    if (busy || expanded) {
      void refreshAgentReviews(true, boundaryInBackground);
      // Every tool/turn boundary already re-reads (effect above). On a phone
      // each timed re-read of a working turn moves its whole diff over the
      // relay and re-diffs the desktop worktree, so the timer only backstops.
      const timer = window.setInterval(
        () => {
          void refreshAgentReviews(true, true);
        },
        isMobileRemoteSurface() ? 30_000 : 6_000
      );
      return () => window.clearInterval(timer);
    }
    const delays = [6_000, 12_000, 24_000, 48_000];
    let index = 0;
    let timer = 0;
    const schedule = () => {
      if (index >= delays.length) return;
      timer = window.setTimeout(() => {
        index += 1;
        void refreshAgentReviews(false);
        schedule();
      }, delays[index]);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, busy, expanded, refreshAgentReviews, hasTurnActivity, agentReviewCount, turnBoundaryKey]);
}

/** The turn's authoritative review: scope, cached state, the coalesced
 *  capability read, the entry wait, and the refresh schedule. */
export function useTurnReviewReads({
  items,
  sessionId,
  active,
  busy,
  disclosure,
}: {
  items: TranscriptItem[];
  sessionId: string | undefined;
  active: boolean;
  busy: boolean;
  disclosure: ReturnType<typeof useTurnReviewDisclosure>;
}) {
  const { reviewSession, reviewScope, turnScopeKey, activeScope } = useTurnReviewScope(items, sessionId);
  const [agentReviewState, setAgentReviewState] = useState<AgentReviewState>(() => cachedTurnReviewState(turnScopeKey));
  // Keying the read as well as the write prevents a one-frame stale bar before
  // effects run when the user switches sessions or opens New task.
  const reviewState =
    agentReviewState.scopeKey === turnScopeKey ? agentReviewState : cachedTurnReviewState(turnScopeKey);
  const capabilityRequestInFlight = useRef<ReadRequest | null>(null);
  // The read issued in the current synchronous pass (one commit's effects),
  // cleared at the next microtask.
  const sameCommitRequest = useRef<ReadRequest | null>(null);
  const pendingCapabilityRefresh = useRef<ReadRequest | null>(null);
  const refreshAgentReviewsRef = useRef<RefreshAgentReviews>(async () => undefined);
  const lastAgentReviewSignature = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnScopeKey is the reset trigger; the body does not read it
  useEffect(() => {
    pendingCapabilityRefresh.current = null;
    lastAgentReviewSignature.current = null;
    disclosure.setExpanded(false);
    disclosure.setOpenFile('');
    disclosure.setConfirmFile('');
    disclosure.setReverted([]);
    disclosure.setRevertedBoundary('');
  }, [turnScopeKey]);
  // Only probe once the transcript shows turn activity: a fresh/empty session
  // has no child review and passive mounts must not fire capability calls.
  const hasTurnActivity = reviewScope.hasActivity;
  // Entering a session with no read for its turn yet shows no bar until the
  // first authoritative read answers. The transcript estimate also counts
  // edits outside the worktree: it painted "1 file changed" on entry, the read
  // removed it ~1s later and the transcript dropped by the bar's height (user:
  // 세션 처음 열 때 잔상이 남았다가 툭 튄다). A cached read answers in tens of
  // milliseconds, so the bar lands with the transcript. A slow read remains
  // undecided: the conversation owns the bounded entry wait, not a shorter
  // timer that briefly paints an estimate before the real answer replaces it.
  // A live turn in a session already answered never waits.
  const [answeredSession, setAnsweredSession] = useState('');
  // Entry presentation is chosen once per turn, not on every focus change.
  // A background pane may already show its transcript estimate. Its first
  // focused refresh must not remove that bar and reinsert the same bar when
  // the read answers. Conversely, blurring a pending foreground entry must
  // not expose an estimate before its authoritative read has answered.
  const reviewEntry = useRef({ scopeKey: turnScopeKey, waitForRead: active });
  if (reviewEntry.current.scopeKey !== turnScopeKey) {
    reviewEntry.current = { scopeKey: turnScopeKey, waitForRead: active };
  }
  const entryPending =
    Boolean(sessionId) &&
    reviewEntry.current.waitForRead &&
    hasTurnActivity &&
    answeredSession !== reviewSession &&
    !leadReviewSnapshotKindCache.has(turnScopeKey);
  const entryPendingRef = useRef(entryPending);
  entryPendingRef.current = entryPending;
  // Refresh on turn boundaries, not every streaming transcript publication.
  const turnBoundaryKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === 'turndone' || item.kind === 'statusdone' || item.kind === 'tool') {
        return `${String(item.id ?? index)}:${String(item.completedAt ?? item.completedCount ?? '')}`;
      }
    }
    return '';
  }, [items]);
  const reviewBoundaryKey = JSON.stringify([turnScopeKey, turnBoundaryKey, busy]);
  const { detailShown } = disclosure;
  const refreshAgentReviews = useCallback(
    // `background` marks the interval timer's re-read: the daemon may answer
    // it from a recent worktree capture. Every other read captures now.
    async (refreshWorktree = false, background = false) =>
      requestTurnReview(
        {
          sessionId,
          turnScopeKey,
          checkpoint: reviewScope.key,
          reviewBoundaryKey,
          detailShown,
          activeScope,
          capabilityRequestInFlight,
          sameCommitRequest,
          pendingCapabilityRefresh,
          refreshAgentReviewsRef,
          lastAgentReviewSignature,
          setAgentReviewState,
          setAnsweredSession,
        },
        refreshWorktree,
        background
      ),
    [sessionId, turnScopeKey, reviewScope.key, reviewBoundaryKey, detailShown, activeScope]
  );
  refreshAgentReviewsRef.current = refreshAgentReviews;
  // Delete history zeroes the retained turn count the files menu shows.
  const mutations = useTurnChangesEpoch(String(sessionId || ''));
  useTurnReviewRefreshSchedule({
    active,
    busy,
    expanded: disclosure.expanded,
    hasTurnActivity,
    agentReviewCount: reviewState.reviews.length,
    turnBoundaryKey,
    mutations,
    entryPendingRef,
    refreshAgentReviews,
  });
  return { reviewScope, reviewState, entryPending, turnBoundaryKey, refreshAgentReviews };
}
