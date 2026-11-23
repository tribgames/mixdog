import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { deferredModule, useDeferredModule } from './deferred-module';
import { InitialSurface } from './InitialSurface';
import { useMobileRemoteSurface } from './mobile-surface';

import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { Conversation } from './Conversation';
import {
  desktopConversationShellSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopStreamingTailSnapshotsEqual,
  paneConversationView,
  paneHeaderView,
  type DesktopSnapshotStore,
} from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT, type Snapshot, type TranscriptItem } from './desktop-types';
import { todoPresent } from './session-goal-presentation';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { focusedDraftModelSelection } from './use-focused-draft-route';
import { createSurfaceHoldSignal, PaneSurfaceCover } from './PaneSurfaceGate';
import { usePanePresentation } from './pane-presentation';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { useSessionLaneRead } from './use-session-lane-read';
import { requestSessionRead } from './session-read-request';
export { requestSessionRead } from './session-read-request';
import { t } from './i18n';
import {
  conversationCoverBasis,
  conversationCoverIdentity,
  conversationDraftPromotion,
  conversationSwitchPaintGate,
  nextConversationCoverId,
  conversationPresentedSessionId,
  nextConversationOriginSessionId,
  conversationMarkdownPending,
  conversationLaneIsEmpty,
} from './first-submit-stability';
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';
import { ContextUsageIndicator } from './transcript-status';
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { ComposerRoutineReadout } from './composer-routine-readout';
import { ComposerUsageReadout } from './composer-usage-readout';
import { TranscriptAssistantRow, type TranscriptAssistantRowProps } from './TranscriptAssistantRow';

/** The Search / Source Control / Pull Requests / Bots dock chunk. Once loaded
 *  it renders synchronously (a React.lazy wrapper suspends once per mount even
 *  for a resolved import, which painted a placeholder frame on every first open). */
export const utilityDockModule = deferredModule(() => import('./UtilityDock'));
export function preloadUtilityDock(): Promise<unknown> {
  return utilityDockModule.load();
}
export async function prewarmUtilityDockGitState(projectPath: string): Promise<void> {
  const module = await utilityDockModule.load();
  await module.prewarmUtilityDockGitState(projectPath);
}

export const selectDesktopSnapshot = (snapshot: Snapshot) => snapshot;

export function useDesktopSnapshotSelector<T>(
  store: DesktopSnapshotStore,
  selector: (snapshot: Snapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  enabled = true
): T {
  const cached = useRef<{ value: T } | null>(null);
  const getSelection = useCallback(() => {
    if (!enabled && cached.current) return cached.current.value;
    const next = selector(store.getSnapshot());
    const previous = cached.current;
    if (previous && isEqual(previous.value, next)) return previous.value;
    cached.current = { value: next };
    return next;
  }, [enabled, isEqual, selector, store]);
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? store.subscribe(listener) : () => {}),
    [enabled, store]
  );
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

type DraftConversationProps = Omit<
  React.ComponentProps<typeof Conversation>,
  'snapshot' | 'routeSnapshot' | 'transcriptPending'
> & {
  transcriptPending?: boolean;
};

const subscribeLaneLiveness = (listener: () => void): (() => void) =>
  defaultSessionLaneStore.subscribeApprovals(listener);

type PaneLaneProps = {
  sessionId: string;
  hidden: boolean;
};

const PaneAssistantRow = memo(function PaneAssistantRow({
  sessionId,
  hidden,
  ...props
}: PaneLaneProps & TranscriptAssistantRowProps) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopStreamingTailSnapshotsEqual,
    props.live && !hidden && Boolean(sessionId)
  );
  const latest = useRef(props.item);
  const tail = lane?.streamingTail as TranscriptItem | null | undefined;
  if (!props.live || latest.current.id !== props.item.id) latest.current = props.item;
  if (props.live) {
    const incoming = tail?.id === props.item.id ? tail : lane?.items?.find((item) => item?.id === props.item.id);
    if (incoming) latest.current = incoming;
  }
  // A lane may clear its tail before the shell publishes the settled row.
  // Retain its last body instead of unmounting it during that handoff.
  return <TranscriptAssistantRow {...props} item={props.live ? latest.current : props.item} />;
});

export const DraftConversation = memo(function DraftConversation({
  transcriptPending = false,
  ...props
}: DraftConversationProps) {
  return (
    <Conversation
      snapshot={EMPTY_SNAPSHOT}
      routeSnapshot={EMPTY_SNAPSHOT}
      transcriptPending={transcriptPending}
      {...props}
      reviewActive
    />
  );
});

// Every split-pane chat keeps ONE Conversation instance mounted for its whole
// lifetime. Focus changes input routing only; every established session reads
// its own lane and a draft reads only its local draft props.
type PaneConversationProps = Omit<
  React.ComponentProps<typeof Conversation>,
  'snapshot' | 'routeSnapshot' | 'renderAssistantRow' | 'transcriptPending'
> & {
  focused: boolean;
  sessionId: string;
  hidden: boolean;
  transcriptPending?: boolean;
  reconcileOnMount?: boolean;
  /** The session's last snapshot, kept by its viewer after the live lane
   *  went away (a side-panel sub-agent that ended): shown in place of the
   *  shared store, which is neither read nor written for it. */
  heldSnapshot?: ReturnType<typeof useSessionLane> | null;
};

/** The transcript list mounts one frame after the shell on a phone entering a
 *  session it holds no lane for; true while it is held back. */
function useTranscriptListGate(sessionId: string, holdsList: boolean): boolean {
  const [listGate, setListGate] = useState({ sessionId, mounted: !holdsList });
  let currentListGate = listGate;
  if (listGate.sessionId !== sessionId) {
    currentListGate = { sessionId, mounted: !holdsList };
    setListGate(currentListGate);
  }
  const listHeld = !currentListGate.mounted;
  useEffect(() => {
    if (!listHeld) return undefined;
    const frame = window.requestAnimationFrame(() =>
      setListGate((state) => (state.sessionId === sessionId ? { ...state, mounted: true } : state))
    );
    return () => window.cancelAnimationFrame(frame);
  }, [listHeld, sessionId]);
  return listHeld;
}

/** Chromium may discard the raster of a layout-retained Markdown subtree while
 *  New Task is visible: the New Task watermark stays over a warm session for one
 *  rAF while its rows paint underneath. */
function useWarmDraftHandoff(bootKey: string, surfaceReady: boolean): boolean {
  const [presentedPaintKey, setPresentedPaintKey] = useState(bootKey);
  const paintKeyChanged = presentedPaintKey !== bootKey;
  const warmDraftHandoff =
    surfaceReady && paintKeyChanged && presentedPaintKey === 'new-task' && bootKey !== 'new-task';
  useLayoutEffect(() => {
    if (!paintKeyChanged) return undefined;
    if (!warmDraftHandoff) {
      setPresentedPaintKey(bootKey);
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => setPresentedPaintKey(bootKey));
    return () => window.cancelAnimationFrame(frame);
  }, [bootKey, paintKeyChanged, warmDraftHandoff]);
  beginBootSurface('conversation', bootKey);
  useEffect(() => {
    if (!surfaceReady) return;
    reportBootSurfaceStage('conversation', bootKey, 'data');
    reportBootSurfaceReady('conversation', bootKey);
  }, [bootKey, surfaceReady]);
  return warmDraftHandoff;
}

export const PaneConversation = memo(function PaneConversation({
  focused,
  sessionId,
  hidden,
  transcriptPending = false,
  reconcileOnMount = true,
  draftMode = false,
  onInheritSession,
  heldSnapshot = null,
  ...props
}: PaneConversationProps) {
  const liveLane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopConversationShellSnapshotsEqual,
    !hidden && !heldSnapshot
  );
  const presentation = usePanePresentation();
  const live = useSyncExternalStore(
    subscribeLaneLiveness,
    () => sessionId !== '' && defaultSessionLaneStore.liveSessionIds().has(sessionId)
  );
  // A conversation prepared behind the one its pane still shows is presented over the session's current state only: a
  // lane kept from before the session was let go is what it showed then, and is not shown as now.
  const lane = heldSnapshot ?? (presentation.preparing && !live ? null : liveLane);
  const { readUnavailable, retryRead } = useSessionLaneRead({
    sessionId,
    hasLane: lane !== null && lane.transcriptPreview !== true,
    hidden,
    reconcileOnMount,
    read: requestSessionRead,
  });
  const mobileSurface = useMobileRemoteSurface();
  const holdsList = mobileSurface && !hidden && sessionId !== '' && lane === null;
  const listHeld = useTranscriptListGate(sessionId, holdsList);
  const coverIdRef = useRef(sessionId || 'draft');
  const originSessionRef = useRef(sessionId || '');
  // Armed by this draft's own submit; only that submit promotes the draft.
  const draftSubmittedRef = useRef(false);
  const draftSubmit = props.submit;
  const submit = useCallback<typeof draftSubmit>(
    async (content, options) => {
      if (!sessionId) {
        draftSubmittedRef.current = true;
        presentation.keep();
      }
      try {
        return await draftSubmit(content, options);
      } catch (error) {
        if (!sessionId) draftSubmittedRef.current = false;
        throw error;
      }
    },
    [draftSubmit, presentation, sessionId]
  );
  const draftPromotion = conversationDraftPromotion(draftSubmittedRef.current, originSessionRef.current, sessionId);
  const coverBasis = conversationCoverBasis(coverIdRef.current, sessionId, draftPromotion);
  const markdownPending = conversationMarkdownPending({
    transcriptPending,
    coverId: coverBasis,
    hasMeasurements: Boolean(readTranscriptVirtualSnapshot(sessionId)?.measurements?.length),
  });
  const laneReady = hidden || !sessionId || (!markdownPending && lane !== null);
  const { coverKey, promotingFromDraft } = conversationCoverIdentity(coverBasis, sessionId, laneReady);
  useLayoutEffect(() => {
    if (!sessionId) draftSubmittedRef.current = false;
  }, [sessionId]);
  useLayoutEffect(() => {
    originSessionRef.current = nextConversationOriginSessionId(originSessionRef.current, sessionId);
    if (sessionId && originSessionRef.current !== sessionId) draftSubmittedRef.current = false;
    coverIdRef.current = nextConversationCoverId(coverIdRef.current, sessionId, laneReady, draftPromotion);
  }, [draftPromotion, laneReady, sessionId]);
  // A first-prompt promotion already painted this conversation as New Task.
  // Changing the cover key (or waiting on a one-frame-late lane) replayed
  // "Loading conversation…" over the live composer.
  const contentReady = hidden || !sessionId || promotingFromDraft || (!markdownPending && lane !== null);
  const incomingPaintId = sessionId || 'draft';
  const switchArrivalRef = useRef({
    id: incomingPaintId,
    ready: contentReady,
  });
  if (switchArrivalRef.current.id !== incomingPaintId) {
    switchArrivalRef.current = {
      id: incomingPaintId,
      ready: contentReady,
    };
  }
  const [heldPaintId, setHeldPaintId] = useState(incomingPaintId);
  const presentedSessionId = conversationPresentedSessionId(heldPaintId === 'draft' ? '' : heldPaintId, sessionId, {
    hidden,
    promotingFromDraft,
    incomingReady: contentReady,
  });
  const presentedLane = useSessionLane(
    presentedSessionId,
    defaultSessionLaneStore,
    desktopConversationShellSnapshotsEqual,
    !hidden && presentedSessionId !== sessionId
  );
  const presentedLaneSnapshot = presentedSessionId === sessionId ? lane : presentedLane;
  const routeSnapshot =
    presentedSessionId && presentedLaneSnapshot ? paneConversationView(presentedLaneSnapshot) : EMPTY_SNAPSHOT;
  const paneSnapshot = hidden ? EMPTY_SNAPSHOT : routeSnapshot;
  const paintGate = conversationSwitchPaintGate(heldPaintId, incomingPaintId, {
    hidden,
    promotingFromDraft,
    contentReady,
    preparedBeforeSwitch: switchArrivalRef.current.ready,
  });
  useLayoutEffect(() => {
    if (paintGate.adoptNow) {
      if (heldPaintId !== incomingPaintId) setHeldPaintId(incomingPaintId);
      return undefined;
    }
    if (!contentReady) return undefined;
    const frame = window.requestAnimationFrame(() => setHeldPaintId(incomingPaintId));
    return () => window.cancelAnimationFrame(frame);
  }, [contentReady, heldPaintId, incomingPaintId, paintGate.adoptNow]);
  // Entered per visit: each time the pane puts the conversation up, its rows are revealed anew.
  const [enteredSessions, setEnteredSessions] = useState<ReadonlySet<string>>(() => new Set());
  const { visit } = presentation;
  const onEntryRevealed = useCallback(
    (sessionKey: string) => {
      const entry = `${sessionKey}\n${visit}`;
      // Within one visit a session shown before stays entered: a conversation that changes session in place is not
      // covered again.
      setEnteredSessions((current) =>
        current.has(entry) ? current : new Set([...current].filter((kept) => kept.endsWith(`\n${visit}`))).add(entry)
      );
    },
    [visit]
  );
  const entryPending =
    !hidden && Boolean(sessionId) && !promotingFromDraft && !enteredSessions.has(`${sessionId}\n${visit}`);
  // The timeline records an entry only after populated rows were revealed. A
  // loaded lane with no rows has none to reveal, so it is entered as it lands.
  const laneEmpty = !hidden && Boolean(sessionId) && !markdownPending && conversationLaneIsEmpty(lane);
  useLayoutEffect(() => {
    if (laneEmpty) onEntryRevealed(sessionId);
  }, [laneEmpty, onEntryRevealed, sessionId]);
  const [transcriptHidden] = useState(createSurfaceHoldSignal);
  const surfaceReady = paintGate.reveal && !entryPending && !listHeld;
  const showingIncoming = presentedSessionId === sessionId;
  const timelinePending =
    showingIncoming && !promotingFromDraft && (markdownPending || Boolean(sessionId && !hidden && lane === null));
  const bootKey = sessionId || 'new-task';
  const warmDraftHandoff = useWarmDraftHandoff(bootKey, surfaceReady);
  const contextIndicator = useMemo(
    () => (
      <PaneContextIndicator
        sessionId={presentedSessionId}
        hidden={hidden}
        onViewDetails={() => props.onOpenCommandSurface('context')}
      />
    ),
    [hidden, presentedSessionId, props.onOpenCommandSurface]
  );
  const usageReadout = useMemo(
    () => (
      <PaneUsageReadout
        sessionId={presentedSessionId}
        hidden={hidden}
        onOpenUsage={() => props.onOpenCommandSurface('stats')}
      />
    ),
    [hidden, presentedSessionId, props.onOpenCommandSurface]
  );
  // The cover covers the transcript viewport only (phone and wide pane alike),
  // so the composer dock never disappears under a session switch.
  // The cover, the Goal island and the assistant row renderer keep their
  // identities between the conversation's own commits (a session switch is
  // several), so the transcript and the memoised island skip those renders.
  const coverHold = hidden ? undefined : transcriptHidden;
  const surfaceCover = useMemo(
    () => (
      <PaneSurfaceCover
        ready={surfaceReady}
        label={t('Loading conversation…')}
        transitionKey={coverKey}
        holdSignal={coverHold}
        revealOnReady
      />
    ),
    [surfaceReady, coverKey, coverHold]
  );
  const goalIsland = useMemo(
    () => <PaneGoalIsland sessionId={presentedSessionId} hidden={hidden} />,
    [presentedSessionId, hidden]
  );
  const renderAssistantRow = useCallback(
    (row: TranscriptAssistantRowProps) => <PaneAssistantRow {...row} sessionId={sessionId} hidden={hidden} />,
    [sessionId, hidden]
  );
  // A lane the core ended is known gone as it ends: the pane says so without waiting out a read of it.
  const ended = useSyncExternalStore(
    subscribeLaneLiveness,
    () => sessionId !== '' && defaultSessionLaneStore.sessionEnded(sessionId)
  );
  const unavailable = (readUnavailable || ended) && !hidden;
  // What the pane hands over to: a draft, a session whose rows are revealed where its reader is (or that has none),
  // or the notice that it cannot be read.
  const presentable = !sessionId || unavailable || (surfaceReady && lane !== null && showingIncoming);
  useLayoutEffect(() => {
    if (presentation.preparing && presentable) presentation.ready();
  }, [presentable, presentation]);
  return (
    <>
      <Conversation
        snapshot={paneSnapshot}
        routeSnapshot={routeSnapshot}
        sessionAddress={presentedSessionId}
        draftMode={draftMode}
        transcriptPending={timelinePending}
        reviewActive={focused && !hidden}
        warmPaintHandoff={warmDraftHandoff}
        onEntryRevealed={onEntryRevealed}
        onTranscriptHiddenChange={transcriptHidden.set}
        renderAssistantRow={renderAssistantRow}
        {...props}
        onInheritSession={onInheritSession}
        submit={submit}
        goalIsland={goalIsland}
        contextIndicator={contextIndicator}
        usageReadout={usageReadout}
        transcriptCover={unavailable ? undefined : surfaceCover}
        transcriptListHeld={listHeld && showingIncoming}
      />
      {unavailable ? (
        <div className="pane-surface-cover session-unavailable" role="alert">
          <div className="session-unavailable-card">
            <strong>{t('Session unavailable')}</strong>
            <span>{t('The transcript could not be loaded.')}</span>
            <button type="button" onClick={retryRead}>
              {t('Retry')}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
});

// Relay hops drop per-session lane pushes on a congested or backgrounded leg,
// and stateResync restores only the bound session's lane. Only the remote shim
// fires this event.
const recoverSessionLanesFromRemoteGap = (): void => {
  defaultSessionLaneStore.evictInactive();
  for (const sessionId of defaultSessionLaneStore.subscribedSessionIds()) {
    void requestSessionRead(sessionId, { refresh: true });
  }
};
if (typeof window !== 'undefined') {
  window.addEventListener('mixdog:remote-state-gap', recoverSessionLanesFromRemoteGap);
}

function usePaneIslandSnapshot(sessionId: string, hidden: boolean): Snapshot {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopHeaderSnapshotsEqual,
    !hidden && Boolean(sessionId)
  );
  return hidden || !sessionId || !lane ? EMPTY_SNAPSHOT : paneHeaderView(lane);
}

let sessionGoalModuleLoaded = false;
let sessionGoalModulePromise: Promise<typeof import('./SessionGoalIsland')> | null = null;
const sessionGoalModuleListeners = new Set<() => void>();
export function preloadSessionGoalIsland(): Promise<typeof import('./SessionGoalIsland')> {
  sessionGoalModulePromise ||= import('./SessionGoalIsland').then(
    (module) => {
      sessionGoalModuleLoaded = true;
      for (const listener of sessionGoalModuleListeners) listener();
      return module;
    },
    (error) => {
      sessionGoalModulePromise = null;
      throw error;
    }
  );
  return sessionGoalModulePromise;
}
function subscribeSessionGoalModule(listener: () => void): () => void {
  sessionGoalModuleListeners.add(listener);
  return () => {
    sessionGoalModuleListeners.delete(listener);
  };
}
const readSessionGoalModuleLoaded = () => sessionGoalModuleLoaded;
const SessionGoalIsland = React.lazy(() =>
  preloadSessionGoalIsland().then((module) => ({ default: module.SessionGoalIsland }))
);

/** Holds a boot reveal until a restored Goal capsule has painted, so it never
 *  pops in above the composer after the shell is shown. */
function GoalIslandBootReady({ bootKey }: { bootKey: string }) {
  useEffect(() => {
    reportBootSurfaceReady('goal-island', bootKey);
  }, [bootKey]);
  return null;
}

/** Goal capsule snapshot owner for the composer. */
export function PaneGoalIsland({ sessionId, hidden }: { sessionId: string; hidden: boolean }) {
  const snapshot = usePaneIslandSnapshot(sessionId, hidden);
  const goalPresent = Boolean(snapshot.goal) || todoPresent(snapshot.todo);
  const moduleLoaded = useSyncExternalStore(
    subscribeSessionGoalModule,
    readSessionGoalModuleLoaded,
    readSessionGoalModuleLoaded
  );
  if (!goalPresent && !moduleLoaded) return null;
  if (goalPresent) beginBootSurface('goal-island', sessionId);
  return (
    <React.Suspense fallback={goalPresent ? <span hidden data-entry-pending /> : null}>
      <SessionGoalIsland snapshot={snapshot} />
      {goalPresent ? <GoalIslandBootReady bootKey={sessionId} /> : null}
    </React.Suspense>
  );
}

/** Context gauge alone, for the desktop composer footer: the same lane read
 *  the status capsule uses, without the capsule frame. */
export function PaneContextIndicator({
  sessionId,
  hidden,
  onViewDetails,
}: {
  sessionId: string;
  hidden: boolean;
  onViewDetails?: () => void;
}) {
  const visibleSnapshot = usePaneIslandSnapshot(sessionId, hidden);
  return <ContextUsageIndicator snapshot={visibleSnapshot} onViewDetails={onViewDetails} />;
}

/** The composer line's speed and cache-hit readout, on the same lane read. */
function PaneUsageReadout({
  sessionId,
  hidden,
  onOpenUsage,
}: {
  sessionId: string;
  hidden: boolean;
  onOpenUsage(): void;
}) {
  // A bot's home thread or a group room (agent mode) reads routines here; a coding session its usage.
  return agentIdOfHomeSession(sessionId) || roomIdOfSession(sessionId) ? (
    <ComposerRoutineReadout sessionId={sessionId} hidden={hidden} />
  ) : (
    <PaneCodingUsageReadout sessionId={sessionId} hidden={hidden} onOpenUsage={onOpenUsage} />
  );
}

function PaneCodingUsageReadout({
  sessionId,
  hidden,
  onOpenUsage,
}: {
  sessionId: string;
  hidden: boolean;
  onOpenUsage(): void;
}) {
  return <ComposerUsageReadout snapshot={usePaneIslandSnapshot(sessionId, hidden)} onOpenUsage={onOpenUsage} />;
}

type SnapshotUtilityDockProps = Omit<
  React.ComponentProps<typeof import('./UtilityDock')['UtilityDock']>,
  'snapshot'
> & {
  snapshotStore: DesktopSnapshotStore;
  hidden: boolean;
};

export const SnapshotUtilityDock = memo(function SnapshotUtilityDock({
  snapshotStore,
  hidden,
  prewarm = false,
  ...props
}: SnapshotUtilityDockProps) {
  // A prewarmed slot activates while still hidden, so the dock body exists
  // before the first expand (user: 사이드탭 즉시 열리게).
  const [activated, setActivated] = useState(!hidden || prewarm);
  useEffect(() => {
    if ((!hidden || prewarm) && !activated) setActivated(true);
  }, [activated, hidden, prewarm]);
  const hostSnapshot = useDesktopSnapshotSelector(
    snapshotStore,
    selectDesktopSnapshot,
    desktopDockSnapshotsEqual,
    activated || !hidden
  );
  // Read at the moment of use: the dock's snapshot slice skips model changes.
  const readComposerModel = useCallback(
    // A focused session owns the engine snapshot's model; a draft composer
    // (blank engine) paints its own selection.
    () => draftModelSelectionFromSnapshot(snapshotStore.getSnapshot()) ?? focusedDraftModelSelection(),
    [snapshotStore]
  );
  const dockModule = useDeferredModule(utilityDockModule, { load: activated || !hidden });
  if (!activated && hidden) return null;
  if (!dockModule) return <InitialSurface />;
  const UtilityDock = dockModule.UtilityDock;
  return (
    <UtilityDock
      {...props}
      prewarm={prewarm}
      snapshot={hidden ? EMPTY_SNAPSHOT : hostSnapshot}
      readComposerModel={readComposerModel}
    />
  );
});
