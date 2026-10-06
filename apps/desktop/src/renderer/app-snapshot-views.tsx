// Snapshot-scoped view slices: each subscribes to the shared desktop snapshot
// store through its OWN equality comparator, so a header-only change never
// re-renders the conversation (and vice versa). App.tsx keeps composition and
// session flow.
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
import { InitialSurface } from './InitialSurface';

import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import type { DesktopModelSelection } from '../shared/contract';
import { Conversation } from './Conversation';
import {
  desktopConversationShellSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopStreamingTailSnapshotsEqual,
  type DesktopSnapshotStore,
} from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT, type Snapshot, type TranscriptItem } from './desktop-types';
import { PaneSurfaceCover } from './PaneSurfaceGate';
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
} from './first-submit-stability';
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';
import { ENTRY_REVEAL_MAX_MS } from './use-transcript-reveal';
import { ContextUsageIndicator } from './transcript-status';
import { TranscriptAssistantRow, type TranscriptAssistantRowProps } from './TranscriptAssistantRow';

let utilityDockModulePromise: Promise<typeof import('./UtilityDock')> | null = null;
function loadUtilityDockModule() {
  utilityDockModulePromise ||= import('./UtilityDock').catch((error) => {
    utilityDockModulePromise = null;
    throw error;
  });
  return utilityDockModulePromise;
}
export function preloadUtilityDock(): Promise<unknown> {
  return loadUtilityDockModule();
}
export async function prewarmUtilityDockGitState(projectPath: string): Promise<void> {
  const module = await loadUtilityDockModule();
  await module.prewarmUtilityDockGitState(projectPath);
}
const UtilityDock = React.lazy(() => loadUtilityDockModule().then((module) => ({ default: module.UtilityDock })));

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
};

export const PaneConversation = memo(function PaneConversation({
  focused,
  sessionId,
  hidden,
  transcriptPending = false,
  reconcileOnMount = true,
  draftMode = false,
  onInheritSession,
  ...props
}: PaneConversationProps) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopConversationShellSnapshotsEqual, !hidden);
  const { readUnavailable, retryRead } = useSessionLaneRead({
    sessionId,
    hasLane: lane !== null,
    hidden,
    reconcileOnMount,
    read: requestSessionRead,
  });
  const coverIdRef = useRef(sessionId || 'draft');
  const originSessionRef = useRef(sessionId || '');
  // Armed by this draft's own submit; only that submit promotes the draft.
  const draftSubmittedRef = useRef(false);
  const draftSubmit = props.submit;
  const submit = useCallback<typeof draftSubmit>(
    async (content, options) => {
      if (!sessionId) draftSubmittedRef.current = true;
      try {
        return await draftSubmit(content, options);
      } catch (error) {
        if (!sessionId) draftSubmittedRef.current = false;
        throw error;
      }
    },
    [draftSubmit, sessionId]
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
  const routeSnapshot = presentedSessionId ? (presentedLaneSnapshot ?? EMPTY_SNAPSHOT) : EMPTY_SNAPSHOT;
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
  // A session's FIRST entry in this pane loads behind the spinner cover until
  // its rows are laid out and its dock chrome has decided, then shows at once
  // (user: 로딩 중엔 스피너 돌고 다 정리된 뒤 보여야 한다). Uncovered, the
  // pane showed the composer over an empty transcript, then the rows, then a
  // review bar that came and went. A revisit settles in a frame and swaps in
  // place.
  const [enteredSessions, setEnteredSessions] = useState<ReadonlySet<string>>(() => new Set());
  const onEntryRevealed = useCallback((sessionKey: string) => {
    setEnteredSessions((current) => (current.has(sessionKey) ? current : new Set(current).add(sessionKey)));
  }, []);
  const entryPending = !hidden && Boolean(sessionId) && !promotingFromDraft && !enteredSessions.has(sessionId);
  // The transcript's own reveal is bounded; this bounds a report that never
  // names this pane's session, so the cover can never outlive a loaded lane.
  const entryWaitsOnLayout = entryPending && paintGate.reveal;
  useEffect(() => {
    if (!entryWaitsOnLayout) return undefined;
    const timer = window.setTimeout(() => onEntryRevealed(sessionId), ENTRY_REVEAL_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [entryWaitsOnLayout, onEntryRevealed, sessionId]);
  // Sidebar session registration remounts the virtualizer. Keep the sheet
  // cover up until the incoming lane exists and one frame has committed it.
  const surfaceReady = paintGate.reveal && !entryPending;
  const showingIncoming = presentedSessionId === sessionId;
  const timelinePending =
    showingIncoming && !promotingFromDraft && (markdownPending || Boolean(sessionId && !hidden && lane === null));
  const bootKey = sessionId || 'new-task';
  // Chromium may discard the raster for a layout-retained Markdown subtree
  // while New Task is visible. Keep the New Task watermark over a warm session
  // for exactly one rAF while the CURRENT route/rows paint underneath. Route
  // identity must still switch in the click commit — a previous session may
  // never remain the draft's DOM, even for one observer delivery.
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
  // Keep Conversation mounted at its final geometry, but do not expose its
  // empty shell followed by a bulk Markdown/virtualizer insertion. The opaque
  // cover leaves only after the authoritative lane and composed frames settle.
  // The context gauge sits beside the composer's model trigger on every
  // surface (user: 컨텍스트는 모델 선택기 옆; 모바일도 PC에 맞춰) — the
  // phone's floating status capsule is retired with it.
  const contextIndicator = useMemo(
    () => (
      <PaneContextIndicator
        sessionId={presentedSessionId}
        hidden={hidden}
        onInherit={onInheritSession}
        onViewDetails={() => props.onOpenCommandSurface('context')}
      />
    ),
    [hidden, onInheritSession, presentedSessionId, props.onOpenCommandSurface]
  );
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
        renderAssistantRow={(row) => <PaneAssistantRow {...row} sessionId={sessionId} hidden={hidden} />}
        {...props}
        onInheritSession={onInheritSession}
        submit={submit}
        goalIsland={<PaneGoalIsland sessionId={presentedSessionId} hidden={hidden} />}
        contextIndicator={contextIndicator}
      />
      <PaneSurfaceCover ready={surfaceReady} label={t('Loading conversation…')} transitionKey={coverKey} />
      {readUnavailable && lane === null && !hidden ? (
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

// Relay hops drop per-session lane pushes for a congested or backgrounded
// leg, and stateResync recovery only restores the bound-session state lane.
// When the remote shim signals such a gap, re-read every mounted lane and
// drop unmounted cached lanes so their next open re-reads from the host.
// Inside Electron the shim never installs and this event never fires.
const recoverSessionLanesFromRemoteGap = (): void => {
  defaultSessionLaneStore.evictInactive();
  for (const sessionId of defaultSessionLaneStore.subscribedSessionIds()) {
    void requestSessionRead(sessionId, { refresh: true });
  }
};
if (typeof window !== 'undefined') {
  window.addEventListener('mixdog:remote-state-gap', recoverSessionLanesFromRemoteGap);
}

/** Session status island: the context gauge and the live Agent/Shell chips as
 *  ONE capsule at the transcript's top-right corner. Every pane status slot
 *  reads its own lane through a single subscription — the gauge and the chips
 *  share the same header-scoped comparator, so one lane read now feeds both.
 *  Focus never changes data ownership. */
function usePaneIslandSnapshot(sessionId: string, hidden: boolean): Snapshot {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopHeaderSnapshotsEqual,
    !hidden && Boolean(sessionId)
  );
  return hidden || !sessionId ? EMPTY_SNAPSHOT : (lane ?? EMPTY_SNAPSHOT);
}

// Most sessions have no Goal, so the capsule module stays out of the first
// screen: the idle boot lane warms it, or the first lane frame that carries a
// Goal fetches it. Once loaded, every pane mounts the (empty) island right
// away, so its lazy boundary has resolved before a Goal session is entered. A
// boundary that first suspends with a Goal on screen holds the capsule back
// for React's reveal throttle (~300ms): the transcript painted without it and
// lifted 40px when it landed (user: 컴포저 위에 골이 있을 때 튄다). Mounted,
// the island stays mounted, keeping its presence diagnostics and submission
// mask.
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
  const goalPresent = Boolean(snapshot.goal);
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
  onInherit,
  onViewDetails,
}: {
  sessionId: string;
  hidden: boolean;
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onViewDetails?: () => void;
}) {
  const visibleSnapshot = usePaneIslandSnapshot(sessionId, hidden);
  return <ContextUsageIndicator snapshot={visibleSnapshot} onInherit={onInherit} onViewDetails={onViewDetails} />;
}

type SnapshotUtilityDockProps = Omit<
  React.ComponentProps<typeof import('./UtilityDock')['UtilityDock']>,
  'snapshot'
> & {
  snapshotStore: DesktopSnapshotStore;
  hidden: boolean;
};

// ONE dock element for every tab. The old per-tab alternation between a
// snapshot-backed dock (Search) and a bare one (Agents/Source Control) swapped
// the component TYPE on a tab change, which unmounted the whole dock — every
// retained pane, tree expansion and scroll went with it. The dock-scoped
// comparator (desktopDockSnapshotsEqual) already limits re-renders to the
// fields the dock reads, and UtilityDock is memoised, so a single subscription
// keeps live agent/tool work flowing without rebuilding the surface.
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
  if (!activated && hidden) return null;
  return (
    <React.Suspense fallback={<InitialSurface />}>
      <UtilityDock {...props} prewarm={prewarm} snapshot={hidden ? EMPTY_SNAPSHOT : hostSnapshot} />
    </React.Suspense>
  );
});
