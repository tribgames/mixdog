import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { asRecord } from './text-format';

type AcceptedBaseline = {
  authoritative: boolean;
  sawNonAuthoritative: boolean;
  confirmedPostRestore: boolean;
  snapshotRevision: string | number | null | undefined;
  settledIds: ReadonlySet<string>;
  settledCount: number;
  tailId: string | undefined;
  windowStart: string | undefined;
  busy: boolean;
  compacting: boolean;
  hadQueued: boolean;
  sawBusy: boolean;
  turnId: string;
};

type DrainState = {
  settledCount: number;
  tailId: string | undefined;
  afterCompaction: boolean;
  sawBusySinceDrain: boolean;
};

type PromptReleaseTracking = {
  seen: Set<string>;
  compactionHeld: Set<string>;
  draining: Map<string, DrainState>;
  baselines: Map<string, AcceptedBaseline>;
};

type ReleaseFrame = {
  settledIds: ReadonlySet<string>;
  settledCount: number;
  firstSettledId: string | undefined;
  tailId: string | undefined;
  tailKind: TranscriptItem['kind'] | undefined;
  hasQueuedList: boolean;
  queuedIds: ReadonlySet<string>;
  authoritative: boolean;
  currentBusy: boolean | undefined;
  isCompacting: boolean;
  hasOlder: boolean;
  currentTurnId: string;
  snapshotRevision: string | number | null | undefined;
};

function createPromptReleaseTracking(): PromptReleaseTracking {
  return {
    seen: new Set(),
    compactionHeld: new Set(),
    draining: new Map(),
    baselines: new Map(),
  };
}

function clearPromptTracking(tracking: PromptReleaseTracking): void {
  if (tracking.seen.size > 0) tracking.seen.clear();
  if (tracking.compactionHeld.size > 0) tracking.compactionHeld.clear();
  if (tracking.draining.size > 0) tracking.draining.clear();
  if (tracking.baselines.size > 0) tracking.baselines.clear();
}

function deletePromptTracking(tracking: PromptReleaseTracking, id: string): void {
  tracking.seen.delete(id);
  tracking.compactionHeld.delete(id);
  tracking.draining.delete(id);
  tracking.baselines.delete(id);
}

function prunePromptTracking(tracking: PromptReleaseTracking, activeIds: ReadonlySet<string>): void {
  for (const id of tracking.seen) if (!activeIds.has(id)) tracking.seen.delete(id);
  for (const id of tracking.compactionHeld) if (!activeIds.has(id)) tracking.compactionHeld.delete(id);
  for (const id of tracking.draining.keys()) if (!activeIds.has(id)) tracking.draining.delete(id);
  for (const id of tracking.baselines.keys()) if (!activeIds.has(id)) tracking.baselines.delete(id);
}

function isDisjoint(current: ReadonlySet<string>, baseline: ReadonlySet<string>): boolean {
  if (current.size === 0 || baseline.size === 0) return false;
  for (const id of current) {
    if (baseline.has(id)) return false;
  }
  return true;
}

function hasRevisionAdvanced(
  current: string | number | null | undefined,
  baseline: string | number | null | undefined
): boolean {
  return (
    current !== undefined && current !== null && baseline !== undefined && baseline !== null && current !== baseline
  );
}

function isTrimmedPastBaseline(frame: ReleaseFrame, baseline: AcceptedBaseline | undefined): boolean {
  return (
    frame.hasOlder &&
    frame.settledCount > 0 &&
    (!baseline || baseline.settledCount === 0 || isDisjoint(frame.settledIds, baseline.settledIds))
  );
}

function snapshotBaseline(
  frame: ReleaseFrame,
  overrides: {
    authoritative: boolean;
    confirmedPostRestore: boolean;
    snapshotRevision: string | number | null | undefined;
    hadQueued: boolean;
  }
): AcceptedBaseline {
  return {
    authoritative: overrides.authoritative,
    sawNonAuthoritative: !overrides.authoritative,
    confirmedPostRestore: overrides.confirmedPostRestore,
    snapshotRevision: overrides.snapshotRevision,
    settledIds: new Set(frame.settledIds),
    settledCount: frame.settledCount,
    tailId: frame.tailId,
    windowStart: frame.firstSettledId,
    busy: frame.currentBusy === true,
    compacting: frame.isCompacting,
    hadQueued: overrides.hadQueued,
    sawBusy: frame.currentBusy === true,
    turnId: frame.currentTurnId,
  };
}

function buildReleaseFrame({
  settledItems,
  queued,
  busy,
  compacting,
  hasOlder,
  turnId,
  snapshotRevision,
  snapshotPreview,
  restoring,
}: {
  settledItems: readonly TranscriptItem[];
  queued?: unknown;
  busy?: boolean;
  compacting?: boolean;
  hasOlder?: boolean;
  turnId?: string;
  snapshotRevision?: string | number | null;
  snapshotPreview?: boolean;
  restoring?: boolean;
}): ReleaseFrame {
  const settledIds = new Set<string>();
  let firstSettledId: string | undefined;
  let tailId: string | undefined;
  for (const item of settledItems) {
    if (item?.id === undefined || item.id === null) continue;
    const id = String(item.id);
    if (firstSettledId === undefined) firstSettledId = id;
    tailId = id;
    settledIds.add(id);
  }
  const hasQueuedList = Array.isArray(queued);
  const queuedIds = new Set<string>();
  if (hasQueuedList) {
    for (const entry of queued) {
      const id = String(asRecord(entry)?.id ?? '').trim();
      if (id) queuedIds.add(id);
    }
  }
  return {
    settledIds,
    settledCount: settledItems.length,
    firstSettledId,
    tailId,
    tailKind: settledItems.at(-1)?.kind,
    hasQueuedList,
    queuedIds,
    authoritative: snapshotPreview !== true && restoring !== true,
    currentBusy: typeof busy === 'boolean' ? busy : undefined,
    isCompacting: compacting === true,
    hasOlder: hasOlder === true,
    currentTurnId: typeof turnId === 'string' ? turnId : '',
    snapshotRevision,
  };
}

function shouldReleaseDequeuedPrompt(
  item: PendingPromptItem,
  id: string,
  frame: ReleaseFrame,
  tracking: PromptReleaseTracking
): boolean {
  if (frame.isCompacting) {
    tracking.compactionHeld.add(id);
    return false;
  }

  const wasCompactionHeld = tracking.compactionHeld.delete(id);
  const baseline = tracking.baselines.get(id);
  const baselineRevision = baseline?.snapshotRevision ?? item.acceptedSnapshotRevision;
  const revisionAdvanced = hasRevisionAdvanced(frame.snapshotRevision, baselineRevision);
  const restoreCompleted =
    (item.acceptedWhileRestoring === true && !baseline?.confirmedPostRestore) ||
    (baseline ? !baseline.authoritative || baseline.sawNonAuthoritative : false);
  const trimmedPastBaseline = isTrimmedPastBaseline(frame, baseline);
  const turnChanged =
    Boolean(baseline?.turnId) && Boolean(frame.currentTurnId) && frame.currentTurnId !== baseline?.turnId;

  if (!revisionAdvanced && !restoreCompleted && !trimmedPastBaseline && !turnChanged) {
    const activeDrain = tracking.draining.get(id);
    if (wasCompactionHeld) {
      tracking.draining.set(id, {
        settledCount: frame.settledCount,
        tailId: frame.tailId,
        afterCompaction: true,
        sawBusySinceDrain: frame.currentBusy === true,
      });
      return false;
    }
    // A prompt the running turn took off the queue is shown by its row, which the core stores behind the reply that
    // was streaming when it was read: that reply settling first says nothing about the prompt. The bubble stands until
    // its row lands or the turn that took it ends.
    if (!activeDrain) {
      if (frame.currentBusy !== false) {
        tracking.draining.set(id, {
          settledCount: frame.settledCount,
          tailId: frame.tailId,
          afterCompaction: false,
          sawBusySinceDrain: frame.currentBusy === true,
        });
        return false;
      }
    } else {
      if (frame.currentBusy === true) activeDrain.sawBusySinceDrain = true;
      const turnEndedAfterDrain =
        frame.currentBusy === false && (!activeDrain.afterCompaction || activeDrain.sawBusySinceDrain);
      // No turn runs behind an idle compaction: a row that is no prompt landing there is the session moving on without
      // the prompt it took off the queue.
      const movedOnIdle =
        activeDrain.afterCompaction &&
        frame.currentBusy === false &&
        (frame.settledCount !== activeDrain.settledCount || frame.tailId !== activeDrain.tailId) &&
        frame.tailKind !== 'user';
      if (!turnEndedAfterDrain && !movedOnIdle) {
        activeDrain.settledCount = frame.settledCount;
        activeDrain.tailId = frame.tailId;
        return false;
      }
      tracking.draining.delete(id);
    }
  }
  return true;
}

function shouldReleaseUnqueuedAcceptedPrompt(
  item: PendingPromptItem,
  id: string,
  frame: ReleaseFrame,
  tracking: PromptReleaseTracking
): boolean {
  const baseline = tracking.baselines.get(id);
  if (!baseline) {
    const acceptedRevisionAdvanced = hasRevisionAdvanced(frame.snapshotRevision, item.acceptedSnapshotRevision);
    if (item.acceptedWhileRestoring === true || acceptedRevisionAdvanced) {
      if (!frame.isCompacting) return true;
      tracking.baselines.set(
        id,
        snapshotBaseline(frame, {
          authoritative: false,
          confirmedPostRestore: false,
          snapshotRevision: item.acceptedSnapshotRevision ?? frame.snapshotRevision,
          hadQueued: frame.queuedIds.size > 0,
        })
      );
      return false;
    }
    tracking.baselines.set(
      id,
      snapshotBaseline(frame, {
        authoritative: true,
        confirmedPostRestore: false,
        snapshotRevision: item.acceptedSnapshotRevision ?? frame.snapshotRevision,
        hadQueued: frame.queuedIds.size > 0,
      })
    );
    return false;
  }

  if (!baseline.authoritative || baseline.sawNonAuthoritative) {
    return !frame.isCompacting;
  }

  if (frame.currentBusy === true) baseline.sawBusy = true;
  if (frame.isCompacting) baseline.compacting = true;
  if (
    (baseline.snapshotRevision === undefined || baseline.snapshotRevision === null) &&
    frame.snapshotRevision !== undefined &&
    frame.snapshotRevision !== null
  ) {
    baseline.snapshotRevision = frame.snapshotRevision;
  }

  const revisionAdvanced = hasRevisionAdvanced(frame.snapshotRevision, baseline.snapshotRevision);
  const trimmedPastBaseline = isTrimmedPastBaseline(frame, baseline);
  const settledChanged =
    frame.settledCount !== baseline.settledCount ||
    frame.tailId !== baseline.tailId ||
    frame.firstSettledId !== baseline.windowStart;
  const idleAndQueueEmpty =
    frame.currentBusy === false && !frame.isCompacting && frame.hasQueuedList && frame.queuedIds.size === 0;
  const idleAfterProgress =
    idleAndQueueEmpty &&
    (item.queuedBehindTurn
      ? baseline.busy || baseline.compacting || baseline.hadQueued || settledChanged
      : baseline.sawBusy || baseline.compacting);
  const nextTurnWithEmptyQueue =
    Boolean(baseline.turnId) &&
    Boolean(frame.currentTurnId) &&
    frame.currentTurnId !== baseline.turnId &&
    frame.hasQueuedList &&
    frame.queuedIds.size === 0;

  return revisionAdvanced || trimmedPastBaseline || idleAfterProgress || nextTurnWithEmptyQueue;
}

/** Drops optimistic prompt cards: on navigation away from the session, once
 *  each card's own durable row lands in the settled transcript (including
 *  failed steers whose send succeeded despite a lost reply), when an accepted
 *  card previously observed in `queued` leaves `queued` outside active
 *  compaction or a live busy-turn drain, or when an accepted card is passed by
 *  a post-accept authoritative snapshot (reconnect/resync, restore completion,
 *  trimmed tail, next turn, or idle empty queue). */
export function useConversationOptimisticPromptRelease({
  transcriptSessionKey,
  promotedOwnDraft,
  settledItems,
  optimisticPrompts,
  setOptimisticPrompts,
  queued,
  busy,
  compacting,
  hasOlder,
  turnId,
  snapshotRevision,
  snapshotPreview,
  restoring,
}: {
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
  settledItems: readonly TranscriptItem[];
  optimisticPrompts: readonly PendingPromptItem[];
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
  /** The session runtime's queue (`snapshot.queued`). */
  queued?: unknown;
  /** Whether a turn is actively running (`snapshot.busy`). */
  busy?: boolean;
  /** Whether a command or compaction is active (`snapshot.commandBusy` / active `commandStatus`). */
  compacting?: boolean;
  /** Whether `settledItems` is a trimmed tail with older history available. */
  hasOlder?: boolean;
  /** Active turn id (`snapshot.turnId`), when present. */
  turnId?: string;
  /** Authoritative snapshot revision token that advances on reconnect/resync/history reset. */
  snapshotRevision?: string | number | null;
  /** Provisional stored preview, not an authoritative live snapshot. */
  snapshotPreview?: boolean;
  /** True while the session lane is awaiting a reconnect restore or replay completion. */
  restoring?: boolean;
}) {
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  const trackingRef = useRef<PromptReleaseTracking>(createPromptReleaseTracking());

  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    clearPromptTracking(trackingRef.current);
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);

  useEffect(() => {
    const tracking = trackingRef.current;
    if (optimisticPrompts.length === 0) {
      clearPromptTracking(tracking);
      return;
    }

    const activeIds = new Set<string>();
    for (const item of optimisticPrompts) activeIds.add(String(item.id));
    prunePromptTracking(tracking, activeIds);

    const frame = buildReleaseFrame({
      settledItems,
      queued,
      busy,
      compacting,
      hasOlder,
      turnId,
      snapshotRevision,
      snapshotPreview,
      restoring,
    });
    const toRelease = new Set<string>();

    for (const item of optimisticPrompts) {
      const id = String(item.id);
      if (frame.settledIds.has(id)) {
        toRelease.add(id);
        continue;
      }
      if (item.steer === 'failed') {
        if (frame.authoritative && frame.hasQueuedList && frame.queuedIds.has(id)) {
          toRelease.add(id);
          continue;
        }
        // Only preserve genuinely unreceived failed steers; once the server was
        // already observed queuing this id, a lost reply releases normally.
        if (!tracking.seen.has(id)) {
          tracking.compactionHeld.delete(id);
          tracking.draining.delete(id);
          tracking.baselines.delete(id);
          continue;
        }
      }

      if (!frame.authoritative) {
        if (item.accepted === true || tracking.seen.has(id)) {
          const existing = tracking.baselines.get(id);
          if (existing) {
            existing.sawNonAuthoritative = true;
          } else {
            tracking.baselines.set(
              id,
              snapshotBaseline(frame, {
                authoritative: false,
                confirmedPostRestore: false,
                snapshotRevision: item.acceptedSnapshotRevision ?? frame.snapshotRevision,
                hadQueued: frame.queuedIds.size > 0,
              })
            );
          }
        } else {
          tracking.baselines.delete(id);
        }
        continue;
      }

      if (frame.hasQueuedList && frame.queuedIds.has(id)) {
        tracking.seen.add(id);
        tracking.compactionHeld.delete(id);
        tracking.draining.delete(id);
        tracking.baselines.set(
          id,
          snapshotBaseline(frame, {
            authoritative: true,
            confirmedPostRestore: item.accepted === true,
            snapshotRevision: frame.snapshotRevision,
            hadQueued: true,
          })
        );
        continue;
      }

      const serverAccepted = item.accepted === true || (item.steer === 'failed' && tracking.seen.has(id));
      if (!serverAccepted) {
        if (!tracking.seen.has(id)) {
          tracking.baselines.delete(id);
        } else if (frame.hasQueuedList && frame.isCompacting) {
          tracking.compactionHeld.add(id);
        }
        continue;
      }

      const shouldRelease =
        frame.hasQueuedList && tracking.seen.has(id)
          ? shouldReleaseDequeuedPrompt(item, id, frame, tracking)
          : shouldReleaseUnqueuedAcceptedPrompt(item, id, frame, tracking);
      if (shouldRelease) toRelease.add(id);
    }

    if (toRelease.size === 0) return;
    for (const id of toRelease) deletePromptTracking(tracking, id);
    // Out for good: a window that later drops the row does not bring the card back.
    setOptimisticPrompts((current) => {
      const kept = current.filter((item) => !toRelease.has(String(item.id)));
      return kept.length === current.length ? current : kept;
    });
  }, [
    busy,
    compacting,
    hasOlder,
    optimisticPrompts,
    queued,
    restoring,
    setOptimisticPrompts,
    settledItems,
    snapshotPreview,
    snapshotRevision,
    turnId,
  ]);
}
