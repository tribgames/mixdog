import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { nextComposerSubmissionId } from './composer-draft';
import { useConversationPaneComposerActions } from './conversation-pane-composer-actions';
import type { ConversationProps } from './conversation-pane-props';
import { promptWaitsBehindActiveTurn, type PendingPromptItem } from './conversation-prompt-items';
import { useConversationComposerActions } from './conversation-support';
import type { TranscriptItem } from './desktop-types';
import { defaultSessionLaneStore } from './session-lane-store';
import { useConversationPendingPrompts } from './use-conversation-pending-prompts';

export type ConversationSubmission = ReturnType<typeof useConversationSubmission>;

type SubmissionPaneProps = Pick<
  ConversationProps,
  | 'snapshot'
  | 'routeSnapshot'
  | 'sessionAddress'
  | 'selectedSessionId'
  | 'submit'
  | 'invokeResult'
  | 'applySnapshot'
  | 'onNewTask'
  | 'onResumeSession'
  | 'onOpenSessions'
  | 'onOpenProjects'
  | 'onOpenSettings'
  | 'onOpenCommandSurface'
  | 'onClearToNewTask'
  | 'onInheritSession'
>;

/** The composer's pane-local actions and the optimistic prompts they submit. */
export function useConversationSubmission(
  pane: SubmissionPaneProps,
  {
    draftMode,
    settledItems,
    transcriptSessionKey,
    promotedOwnDraft,
    routeSessionIdRef,
    armFollow,
    resetTranscriptToLive,
    suppressDraftSubmitPaintHandoff,
  }: {
    draftMode: boolean;
    settledItems: TranscriptItem[];
    transcriptSessionKey: string;
    promotedOwnDraft: { current: boolean };
    routeSessionIdRef: { current: string };
    armFollow: () => void;
    resetTranscriptToLive: () => void;
    suppressDraftSubmitPaintHandoff: { current: boolean };
  }
) {
  const [optimisticPrompts, setOptimisticPrompts] = useState<PendingPromptItem[]>([]);
  const draftModeRef = useRef(draftMode);
  draftModeRef.current = draftMode;
  // The pane's submit addresses the session the pane was pointed at. While another session's transcript still shows
  // (the picked one's lane has not landed), what that transcript sends (Retry, Send again) goes to its own session.
  const shownSessionId = draftMode ? '' : String(pane.routeSnapshot.sessionId || '');
  const shownElsewhere = Boolean(shownSessionId && pane.selectedSessionId && pane.selectedSessionId !== shownSessionId);
  const composerActions = useConversationPaneComposerActions({
    actions: {
      submit: shownElsewhere
        ? (content, options) => window.mixdogDesktop.submitToSession(shownSessionId, content, options)
        : pane.submit,
      invokeResult: pane.invokeResult,
      applySnapshot: pane.applySnapshot,
      onNewTask: pane.onNewTask,
      onResumeSession: pane.onResumeSession,
      onOpenSessions: pane.onOpenSessions,
      onOpenProjects: pane.onOpenProjects,
      onOpenSettings: pane.onOpenSettings,
      onOpenCommandSurface: pane.onOpenCommandSurface,
      onClearToNewTask: pane.onClearToNewTask,
    },
    sessionAddress: pane.sessionAddress,
    routeSnapshot: pane.routeSnapshot,
    onInheritSession: pane.onInheritSession,
  });
  const subscribeLane = useCallback(
    (listener: () => void) => {
      if (!shownSessionId) return () => {};
      const offLane = defaultSessionLaneStore.subscribe(shownSessionId, listener);
      const offPosition = defaultSessionLaneStore.subscribeStreamPosition(shownSessionId, listener);
      return () => {
        offLane();
        offPosition();
      };
    },
    [shownSessionId]
  );
  const laneMarker = useSyncExternalStore(subscribeLane, () => {
    if (!shownSessionId) return '';
    const laneSnap = defaultSessionLaneStore.get(shownSessionId);
    const isRestoring = laneSnap?.restoreOwed === true || laneSnap?.replayPending === true ? '1' : '0';
    const epoch = defaultSessionLaneStore.streamPosition(shownSessionId)?.epoch ?? '';
    return `${isRestoring}:${epoch}`;
  });
  const restoring =
    laneMarker.startsWith('1:') || pane.snapshot.restoreOwed === true || pane.snapshot.replayPending === true;
  const streamEpoch = laneMarker ? laneMarker.slice(2) : '';
  const laneProgressRef = useRef({
    scope: transcriptSessionKey,
    wasRestoring: restoring,
    restoreGeneration: 0,
    lastEpoch: streamEpoch,
    epochGeneration: 0,
  });
  if (laneProgressRef.current.scope !== transcriptSessionKey) {
    laneProgressRef.current = {
      scope: transcriptSessionKey,
      wasRestoring: restoring,
      restoreGeneration: 0,
      lastEpoch: streamEpoch,
      epochGeneration: 0,
    };
  } else {
    if (laneProgressRef.current.wasRestoring && !restoring) {
      laneProgressRef.current.restoreGeneration += 1;
    }
    laneProgressRef.current.wasRestoring = restoring;
    if (streamEpoch) {
      if (laneProgressRef.current.lastEpoch && laneProgressRef.current.lastEpoch !== streamEpoch) {
        laneProgressRef.current.epochGeneration += 1;
      }
      laneProgressRef.current.lastEpoch = streamEpoch;
    }
  }
  const transcriptGeneration =
    typeof pane.snapshot.transcriptGeneration === 'number' ? pane.snapshot.transcriptGeneration : 0;
  const authoritativeSnapshotRevision =
    typeof pane.snapshot.snapshotRevision === 'number' ? pane.snapshot.snapshotRevision : 0;
  const snapshotRevision = `${authoritativeSnapshotRevision}:${laneProgressRef.current.restoreGeneration}:${laneProgressRef.current.epochGeneration}:${transcriptGeneration}`;
  const commandActive =
    Boolean(pane.snapshot.commandBusy) ||
    (pane.snapshot.commandStatus != null && pane.snapshot.commandStatus.active !== false);
  // A prompt sent behind an active turn is a steering message the turn reads
  // at its next step boundary. An idle submit — including a draft's first
  // prompt, whose atomic RPC spans session materialization — starts a turn.
  const queuedBehindTurnAtSubmit = useRef(false);
  queuedBehindTurnAtSubmit.current = promptWaitsBehindActiveTurn(draftMode, pane.snapshot);
  const pending = useConversationPendingPrompts({
    optimisticPrompts,
    setOptimisticPrompts,
    settledItems,
    queued: Array.isArray(pane.snapshot.queued) ? pane.snapshot.queued : [],
    transcriptSessionKey,
    promotedOwnDraft,
    busy: Boolean(pane.snapshot.busy),
    compacting: commandActive,
    hasOlder: pane.snapshot.transcriptHasOlder === true || pane.snapshot.transcriptHistory === 'older',
    turnId: typeof pane.snapshot.turnId === 'string' ? pane.snapshot.turnId : '',
    snapshotRevision,
    snapshotPreview: pane.snapshot.transcriptPreview === true,
    restoring,
  });
  // Submit re-arms follow. The new row is an append, so virtual-core's
  // followOnAppend is the only end write.
  const armFollowOnSubmitRef = useRef(armFollow);
  armFollowOnSubmitRef.current = () => {
    // A history page still in flight must not replace the tail after this send.
    resetTranscriptToLive();
    armFollow();
  };
  const acceptSnapshotContextRef = useRef({
    snapshotRevision,
    restoring,
    snapshotPreview: pane.snapshot.transcriptPreview === true,
  });
  acceptSnapshotContextRef.current = {
    snapshotRevision,
    restoring,
    snapshotPreview: pane.snapshot.transcriptPreview === true,
  };
  const actions = useConversationComposerActions({
    acceptSnapshotContextRef,
    armFollowOnSubmitRef,
    composerActions,
    draftModeRef,
    goalSubmission: pending.goalSubmission,
    goalSubmitScopeRef: pending.goalSubmitScopeRef,
    queuedBehindTurnAtSubmit,
    routeSessionIdRef,
    setOptimisticPrompts,
    suppressDraftSubmitPaintHandoff,
  });
  // A slash command sent while a turn runs that the session holds for the
  // turn's end (/compact) shows inline as a held message until the turn ends.
  const [heldCommands, setHeldCommands] = useState<PendingPromptItem[]>([]);
  const busy = Boolean(pane.snapshot.busy);
  useEffect(() => {
    if (!busy) setHeldCommands((current) => (current.length ? [] : current));
  }, [busy]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcriptSessionKey is the reset trigger; the body does not read it
  useEffect(() => setHeldCommands((current) => (current.length ? [] : current)), [transcriptSessionKey]);
  const holdSlashCommand = useCallback((text: string) => {
    setHeldCommands((current) => [
      ...current,
      {
        id: nextComposerSubmissionId(),
        kind: 'user',
        text,
        pending: true,
        accepted: true,
        submittedAt: Date.now(),
        queuedBehindTurn: true,
        steer: 'held',
        steerLocal: true,
      },
    ]);
  }, []);
  const steerItems = useMemo(
    () => (heldCommands.length ? [...pending.steerItems, ...heldCommands] : pending.steerItems),
    [heldCommands, pending.steerItems]
  );
  return { ...pending, steerItems, holdSlashCommand, actions };
}
