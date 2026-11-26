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

function isDisjoint(current: ReadonlySet<string>, baseline: ReadonlySet<string>): boolean {
  if (current.size === 0 || baseline.size === 0) return false;
  for (const id of current) {
    if (baseline.has(id)) return false;
  }
  return true;
}

function snapshotBaseline(
  authoritative: boolean,
  confirmedPostRestore: boolean,
  snapshotRevision: string | number | null | undefined,
  settledIds: ReadonlySet<string>,
  settledCount: number,
  tailId: string | undefined,
  windowStart: string | undefined,
  busy: boolean,
  compacting: boolean,
  hadQueued: boolean,
  turnId: string
): AcceptedBaseline {
  return {
    authoritative,
    sawNonAuthoritative: !authoritative,
    confirmedPostRestore,
    snapshotRevision,
    settledIds: new Set(settledIds),
    settledCount,
    tailId,
    windowStart,
    busy,
    compacting,
    hadQueued,
    sawBusy: busy,
    turnId,
  };
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
  const seenInQueueIds = useRef(new Set<string>());
  const compactionHeldIds = useRef(new Set<string>());
  const drainingIds = useRef(new Map<string, DrainState>());
  const acceptedBaselines = useRef(new Map<string, AcceptedBaseline>());

  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    seenInQueueIds.current.clear();
    compactionHeldIds.current.clear();
    drainingIds.current.clear();
    acceptedBaselines.current.clear();
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);

  useEffect(() => {
    const seen = seenInQueueIds.current;
    const compactionHeld = compactionHeldIds.current;
    const draining = drainingIds.current;
    const baselines = acceptedBaselines.current;
    if (optimisticPrompts.length === 0) {
      if (seen.size > 0) seen.clear();
      if (compactionHeld.size > 0) compactionHeld.clear();
      if (draining.size > 0) draining.clear();
      if (baselines.size > 0) baselines.clear();
      return;
    }

    const activeIds = new Set<string>();
    for (const item of optimisticPrompts) activeIds.add(String(item.id));
    for (const id of seen) if (!activeIds.has(id)) seen.delete(id);
    for (const id of compactionHeld) if (!activeIds.has(id)) compactionHeld.delete(id);
    for (const id of draining.keys()) if (!activeIds.has(id)) draining.delete(id);
    for (const id of baselines.keys()) if (!activeIds.has(id)) baselines.delete(id);

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
    const tailKind = settledItems.at(-1)?.kind;

    const hasQueuedList = Array.isArray(queued);
    const queuedIds = new Set<string>();
    if (hasQueuedList) {
      for (const entry of queued) {
        const id = String(asRecord(entry)?.id ?? '').trim();
        if (id) queuedIds.add(id);
      }
    }

    const authoritative = snapshotPreview !== true && restoring !== true;
    const currentBusy = typeof busy === 'boolean' ? busy : undefined;
    const isCompacting = compacting === true;
    const currentTurnId = typeof turnId === 'string' ? turnId : '';
    const toRelease = new Set<string>();

    for (const item of optimisticPrompts) {
      const id = String(item.id);
      if (settledIds.has(id)) {
        toRelease.add(id);
        continue;
      }
      if (item.steer === 'failed') {
        if (authoritative && hasQueuedList && queuedIds.has(id)) {
          toRelease.add(id);
          continue;
        }
        // Only preserve genuinely unreceived failed steers; once the server was
        // already observed queuing this id, a lost reply releases normally.
        if (!seen.has(id)) {
          compactionHeld.delete(id);
          draining.delete(id);
          baselines.delete(id);
          continue;
        }
      }

      if (!authoritative) {
        if (item.accepted === true || seen.has(id)) {
          const existing = baselines.get(id);
          if (existing) {
            existing.sawNonAuthoritative = true;
          } else {
            baselines.set(
              id,
              snapshotBaseline(
                false,
                false,
                item.acceptedSnapshotRevision ?? snapshotRevision,
                settledIds,
                settledItems.length,
                tailId,
                firstSettledId,
                currentBusy === true,
                isCompacting,
                queuedIds.size > 0,
                currentTurnId
              )
            );
          }
        } else {
          baselines.delete(id);
        }
        continue;
      }

      if (hasQueuedList && queuedIds.has(id)) {
        seen.add(id);
        compactionHeld.delete(id);
        draining.delete(id);
        baselines.set(
          id,
          snapshotBaseline(
            true,
            item.accepted === true,
            snapshotRevision,
            settledIds,
            settledItems.length,
            tailId,
            firstSettledId,
            currentBusy === true,
            isCompacting,
            true,
            currentTurnId
          )
        );
        continue;
      }

      const serverAccepted = item.accepted === true || (item.steer === 'failed' && seen.has(id));
      if (!serverAccepted) {
        if (!seen.has(id)) {
          baselines.delete(id);
        } else if (hasQueuedList && isCompacting) {
          compactionHeld.add(id);
        }
        continue;
      }

      if (hasQueuedList && seen.has(id)) {
        if (isCompacting) {
          compactionHeld.add(id);
          continue;
        }

        const wasCompactionHeld = compactionHeld.delete(id);
        const baseline = baselines.get(id);
        const baselineRevision = baseline?.snapshotRevision ?? item.acceptedSnapshotRevision;
        const revisionAdvanced =
          snapshotRevision !== undefined &&
          snapshotRevision !== null &&
          baselineRevision !== undefined &&
          baselineRevision !== null &&
          snapshotRevision !== baselineRevision;
        const restoreCompleted =
          (item.acceptedWhileRestoring === true && !baseline?.confirmedPostRestore) ||
          (baseline ? !baseline.authoritative || baseline.sawNonAuthoritative : false);
        const trimmedPastBaseline =
          hasOlder === true &&
          settledItems.length > 0 &&
          (!baseline || baseline.settledCount === 0 || isDisjoint(settledIds, baseline.settledIds));
        const turnChanged = Boolean(baseline?.turnId) && Boolean(currentTurnId) && currentTurnId !== baseline?.turnId;

        if (!revisionAdvanced && !restoreCompleted && !trimmedPastBaseline && !turnChanged) {
          const activeDrain = draining.get(id);
          if (wasCompactionHeld) {
            draining.set(id, {
              settledCount: settledItems.length,
              tailId,
              afterCompaction: true,
              sawBusySinceDrain: currentBusy === true,
            });
            continue;
          }
          if (!activeDrain) {
            if (currentBusy !== false) {
              const settledMovedPastUser =
                baseline !== undefined &&
                (settledItems.length !== baseline.settledCount || tailId !== baseline.tailId) &&
                tailKind !== 'user';
              if (!settledMovedPastUser) {
                draining.set(id, {
                  settledCount: settledItems.length,
                  tailId,
                  afterCompaction: false,
                  sawBusySinceDrain: currentBusy === true,
                });
                continue;
              }
            }
          } else {
            if (currentBusy === true) activeDrain.sawBusySinceDrain = true;
            const progressedBeyondUserDrain =
              (settledItems.length !== activeDrain.settledCount || tailId !== activeDrain.tailId) &&
              tailKind !== 'user';
            const turnEndedAfterDrain =
              currentBusy === false && (!activeDrain.afterCompaction || activeDrain.sawBusySinceDrain);
            if (!progressedBeyondUserDrain && !turnEndedAfterDrain) {
              activeDrain.settledCount = settledItems.length;
              activeDrain.tailId = tailId;
              continue;
            }
            draining.delete(id);
          }
        }
        toRelease.add(id);
        continue;
      }

      const baseline = baselines.get(id);
      if (!baseline) {
        const acceptedRevisionAdvanced =
          item.acceptedSnapshotRevision !== undefined &&
          item.acceptedSnapshotRevision !== null &&
          snapshotRevision !== undefined &&
          snapshotRevision !== null &&
          snapshotRevision !== item.acceptedSnapshotRevision;
        if (item.acceptedWhileRestoring === true || acceptedRevisionAdvanced) {
          if (!isCompacting) {
            toRelease.add(id);
          } else {
            baselines.set(
              id,
              snapshotBaseline(
                false,
                false,
                item.acceptedSnapshotRevision ?? snapshotRevision,
                settledIds,
                settledItems.length,
                tailId,
                firstSettledId,
                currentBusy === true,
                isCompacting,
                queuedIds.size > 0,
                currentTurnId
              )
            );
          }
          continue;
        }
        baselines.set(
          id,
          snapshotBaseline(
            true,
            false,
            item.acceptedSnapshotRevision ?? snapshotRevision,
            settledIds,
            settledItems.length,
            tailId,
            firstSettledId,
            currentBusy === true,
            isCompacting,
            queuedIds.size > 0,
            currentTurnId
          )
        );
        continue;
      }

      if (!baseline.authoritative || baseline.sawNonAuthoritative) {
        if (!isCompacting) {
          toRelease.add(id);
        }
        continue;
      }

      if (currentBusy === true) baseline.sawBusy = true;
      if (isCompacting) baseline.compacting = true;
      if (
        (baseline.snapshotRevision === undefined || baseline.snapshotRevision === null) &&
        snapshotRevision !== undefined &&
        snapshotRevision !== null
      ) {
        baseline.snapshotRevision = snapshotRevision;
      }

      const revisionAdvanced =
        snapshotRevision !== undefined &&
        snapshotRevision !== null &&
        baseline.snapshotRevision !== undefined &&
        baseline.snapshotRevision !== null &&
        snapshotRevision !== baseline.snapshotRevision;

      const trimmedPastBaseline =
        hasOlder === true &&
        settledItems.length > 0 &&
        (baseline.settledCount === 0 || isDisjoint(settledIds, baseline.settledIds));

      const settledChanged =
        settledItems.length !== baseline.settledCount ||
        tailId !== baseline.tailId ||
        firstSettledId !== baseline.windowStart;
      const idleAndQueueEmpty = currentBusy === false && !isCompacting && hasQueuedList && queuedIds.size === 0;
      const idleAfterProgress =
        idleAndQueueEmpty &&
        (item.queuedBehindTurn
          ? baseline.busy || baseline.compacting || baseline.hadQueued || settledChanged
          : baseline.sawBusy || baseline.compacting);

      const nextTurnWithEmptyQueue =
        Boolean(baseline.turnId) &&
        Boolean(currentTurnId) &&
        currentTurnId !== baseline.turnId &&
        hasQueuedList &&
        queuedIds.size === 0;

      if (revisionAdvanced || trimmedPastBaseline || idleAfterProgress || nextTurnWithEmptyQueue) {
        toRelease.add(id);
      }
    }

    if (toRelease.size === 0) return;
    for (const id of toRelease) {
      seen.delete(id);
      compactionHeld.delete(id);
      draining.delete(id);
      baselines.delete(id);
    }
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
