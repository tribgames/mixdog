// Snapshot-scoped view slices: each subscribes to the shared desktop snapshot
// store through its OWN equality comparator, so a header-only change never
// re-renders the conversation (and vice versa). Extracted from App.tsx, which
// keeps composition and session flow.
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ActiveAgentsIndicator, ActiveShellsIndicator } from "./ActiveAgentsIndicator";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { Conversation } from "./Conversation";
import {
  desktopConversationShellSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopRuntimeProgressSnapshotsEqual,
  desktopStreamingTailSnapshotsEqual,
  type DesktopSnapshotStore,
} from "./desktop-snapshot-store";
import {
  EMPTY_SNAPSHOT,
  EMPTY_TRANSCRIPT_ITEMS,
  type Snapshot,
  type TranscriptItem,
} from "./desktop-types";
import { PaneSurfaceCover } from "./PaneSurfaceGate";
import { defaultSessionLaneStore, useSessionLane } from "./session-lane-store";
import { asRecord } from "./text-format";
import { t } from "./i18n";
import {
  conversationCoverIdentity,
  conversationSwitchPaintGate,
  nextConversationCoverId,
  conversationPresentedSessionId,
  nextConversationOriginSessionId,
  conversationMarkdownPending,
} from "./first-submit-stability";
import { readTranscriptVirtualSnapshot } from "./transcript-virtual-cache";
import { ContextUsageIndicator, TranscriptRow } from "./TranscriptView";
import { UtilityDock } from "./UtilityDock";

export const selectDesktopSnapshot = (snapshot: Snapshot) => snapshot;

export function useDesktopSnapshotSelector<T>(
  store: DesktopSnapshotStore,
  selector: (snapshot: Snapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
  enabled = true,
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
    [enabled, store],
  );
  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

type DraftConversationProps =
  Omit<React.ComponentProps<typeof Conversation>, "snapshot" | "routeSnapshot" | "transcriptPending"> & {
  transcriptPending?: boolean;
  };

type PaneStreamingTailProps = {
  sessionId: string;
  hidden: boolean;
};

const PaneRuntimeProgress = memo(function PaneRuntimeProgress({
  sessionId,
  hidden,
}: PaneStreamingTailProps) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopRuntimeProgressSnapshotsEqual,
    !hidden && Boolean(sessionId),
  );
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const text = String(asRecord(snapshot.progressHint)?.text || "");
  return !hidden && text
    ? <div className="runtime-progress" role="status">{text}</div>
    : null;
});

const PaneStreamingTail = memo(function PaneStreamingTail({
  sessionId,
  hidden,
}: PaneStreamingTailProps) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopStreamingTailSnapshotsEqual,
    !hidden && Boolean(sessionId),
  );
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const tail = snapshot.streamingTail as TranscriptItem | null | undefined;
  if (hidden) return null;
  if (!tail) return null;
  const items = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  const settledIndex = tail.id == null
    ? -1
    : items.findIndex((item) => item?.id === tail.id);
  if (settledIndex >= 0 && settledIndex !== items.length - 1) return null;
  const index = settledIndex >= 0 ? settledIndex : items.length;
  return <div className="transcript-live-part" data-streaming-tail="true" data-index={index}>
    <TranscriptRow item={tail}
      disclosureScope={String(snapshot.sessionId || "new-task")} />
  </div>;
});

export const DraftConversation = memo(function DraftConversation({
  transcriptPending = false,
  ...props
}: DraftConversationProps) {
  return <Conversation snapshot={EMPTY_SNAPSHOT} routeSnapshot={EMPTY_SNAPSHOT}
    transcriptPending={transcriptPending} {...props} reviewActive />;
});

// Every split-pane chat keeps ONE Conversation instance mounted for its whole
// lifetime. Focus changes input routing only; every established session reads
// its own lane and a draft reads only its local draft props.
type PaneConversationProps =
  Omit<React.ComponentProps<typeof Conversation>,
    "snapshot" | "routeSnapshot" | "streamingTailSlot" | "runtimeProgressSlot" | "transcriptPending"> & {
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
  ...props
}: PaneConversationProps) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopConversationShellSnapshotsEqual,
    !hidden,
  );
  const [readUnavailable, setReadUnavailable] = useState(false);
  const [readRetry, setReadRetry] = useState(0);
  const coverIdRef = useRef(sessionId || "draft");
  const originSessionRef = useRef(sessionId || "");
  const markdownPending = conversationMarkdownPending({
    transcriptPending,
    coverId: coverIdRef.current,
    hasMeasurements: Boolean(readTranscriptVirtualSnapshot(sessionId)?.measurements?.length),
  });
  useEffect(() => {
    // Fill a cold lane once. A session that already has rows is skipped
    // inside requestSessionRead; a focused resume already filled its target.
    if (!sessionId || !reconcileOnMount) return undefined;
    let current = true;
    setReadUnavailable(false);
    void requestSessionRead(sessionId).then((accepted) => {
      if (current && !accepted && defaultSessionLaneStore.get(sessionId) === null) {
        setReadUnavailable(true);
      }
    });
    return () => { current = false; };
  }, [readRetry, reconcileOnMount, sessionId]);
  const laneReady = hidden || !sessionId || (!markdownPending && lane !== null);
  const { coverKey, promotingFromDraft } = conversationCoverIdentity(
    coverIdRef.current,
    sessionId,
    laneReady,
  );
  useLayoutEffect(() => {
    originSessionRef.current = nextConversationOriginSessionId(
      originSessionRef.current,
      sessionId,
    );
    coverIdRef.current = nextConversationCoverId(
      coverIdRef.current,
      sessionId,
      laneReady,
      originSessionRef.current,
    );
  }, [laneReady, sessionId]);
  // A first-prompt promotion already painted this conversation as New Task.
  // Changing the cover key (or waiting on a one-frame-late lane) replayed
  // "Loading conversation…" over the live composer.
  const contentReady = hidden || !sessionId || promotingFromDraft
    || (!markdownPending && lane !== null);
  const incomingPaintId = sessionId || "draft";
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
  const presentedSessionId = conversationPresentedSessionId(
    heldPaintId === "draft" ? "" : heldPaintId,
    sessionId,
    {
      hidden,
      promotingFromDraft,
      incomingReady: contentReady,
    },
  );
  const presentedLane = useSessionLane(
    presentedSessionId,
    defaultSessionLaneStore,
    desktopConversationShellSnapshotsEqual,
    !hidden,
  );
  const routeSnapshot = presentedSessionId
    ? (presentedSessionId === sessionId ? lane : presentedLane) ?? EMPTY_SNAPSHOT
    : EMPTY_SNAPSHOT;
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
  // Sidebar session registration remounts the virtualizer. Keep the sheet
  // cover up until the incoming lane exists and one frame has committed it.
  const surfaceReady = paintGate.reveal;
  const showingIncoming = presentedSessionId === sessionId;
  const timelinePending = showingIncoming && !promotingFromDraft && (
    markdownPending
    || Boolean(sessionId && !hidden && lane === null)
  );
  const bootKey = sessionId || "new-task";
  // Chromium may discard the raster for a layout-retained Markdown subtree
  // while New Task is visible. Keep the New Task watermark over a warm session
  // for exactly one rAF while the CURRENT route/rows paint underneath. Route
  // identity must still switch in the click commit — a previous session may
  // never remain the draft's DOM, even for one observer delivery.
  const [presentedPaintKey, setPresentedPaintKey] = useState(bootKey);
  const paintKeyChanged = presentedPaintKey !== bootKey;
  const warmDraftHandoff = surfaceReady
    && paintKeyChanged
    && presentedPaintKey === "new-task"
    && bootKey !== "new-task";
  useLayoutEffect(() => {
    if (!paintKeyChanged) return undefined;
    if (!warmDraftHandoff) {
      setPresentedPaintKey(bootKey);
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => setPresentedPaintKey(bootKey));
    return () => window.cancelAnimationFrame(frame);
  }, [bootKey, paintKeyChanged, warmDraftHandoff]);
  beginBootSurface("conversation", bootKey);
  useEffect(() => {
    if (!surfaceReady) return;
    reportBootSurfaceStage("conversation", bootKey, "data");
    reportBootSurfaceReady("conversation", bootKey);
  }, [bootKey, surfaceReady]);
  // Keep Conversation mounted at its final geometry, but do not expose its
  // empty shell followed by a bulk Markdown/virtualizer insertion. The opaque
  // cover leaves only after the authoritative lane and composed frames settle.
  return <>
    <Conversation
      snapshot={paneSnapshot}
      routeSnapshot={routeSnapshot}
      sessionAddress={presentedSessionId}
      draftMode={draftMode}
      transcriptPending={timelinePending}
      reviewActive={focused && !hidden}
      warmPaintHandoff={warmDraftHandoff}
      streamingTailSlot={<PaneStreamingTail
        sessionId={sessionId}
        hidden={hidden} />}
      runtimeProgressSlot={<PaneRuntimeProgress
        sessionId={sessionId}
        hidden={hidden} />}
      {...props}
    />
    <PaneSurfaceCover ready={surfaceReady} label={t("Loading conversation…")}
      transitionKey={coverKey} showSpinner={false} />
    {readUnavailable && lane === null && !hidden
      ? <div className="pane-surface-cover session-unavailable" role="alert">
        <div className="session-unavailable-card">
          <strong>{t("Session unavailable")}</strong>
          <span>{t("The transcript could not be loaded.")}</span>
          <button type="button" onClick={() => setReadRetry((value) => value + 1)}>{t("Retry")}</button>
        </div>
      </div>
      : null}
  </>;
});

// Canonical session.read fills a cold lane without resuming it. The visible
// session subscription remains responsible for subsequent live frames.
// Dedupe only while a request is in flight; a failed/missed startup read gets
// bounded retries instead of being suppressed forever.
const sessionReadsInFlight = new Map<string, Promise<boolean>>();
const MAX_SESSION_READ_ATTEMPTS = 3;
export function requestSessionRead(
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  const existing = defaultSessionLaneStore.get(sessionId);
  // A lane that already has rows is the live truth. Re-peeking republished
  // the same session after first paint and the transcript rebuilt.
  if (existing && Array.isArray(existing.items) && existing.items.length > 0) {
    return Promise.resolve(true);
  }
  const inFlight = sessionReadsInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const readSession = window.mixdogDesktop?.prefetchSession;
  if (typeof readSession !== "function") return Promise.resolve(false);
  defaultSessionLaneStore.start();
  const request = (async () => {
    for (let attempt = 1; attempt <= MAX_SESSION_READ_ATTEMPTS; attempt += 1) {
      let accepted = false;
      try {
        accepted = await Promise.resolve(readSession(sessionId)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) return true;
      if (attempt < MAX_SESSION_READ_ATTEMPTS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    }
    return false;
  })();
  sessionReadsInFlight.set(sessionId, request);
  void request.finally(() => {
    if (sessionReadsInFlight.get(sessionId) === request) {
      sessionReadsInFlight.delete(sessionId);
    }
  });
  return request;
}

/** Context gauge docked immediately right of the composer's model selector.
 *  Every pane status slot reads its own lane. Focus never changes data
 *  ownership. */
export function PaneContextStatus({ sessionId, hidden, onOpen }: {
  sessionId: string;
  hidden: boolean;
  onOpen(): void;
}) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopHeaderSnapshotsEqual,
    !hidden && Boolean(sessionId),
  );
  const visibleSnapshot = hidden || !sessionId
    ? EMPTY_SNAPSHOT
    : lane ?? EMPTY_SNAPSHOT;
  return <ContextUsageIndicator snapshot={visibleSnapshot} onOpen={onOpen} />;
}

/** Agent/Shell live-work chips: they ride the thinking line's right end while
 *  a turn runs and float above the diff/composer stack while idle. */
export function PaneLiveWork({ sessionId, hidden, onOpenAgents }: {
  sessionId: string;
  hidden: boolean;
  onOpenAgents?(): void;
}) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopHeaderSnapshotsEqual,
    !hidden && Boolean(sessionId),
  );
  const visibleSnapshot = hidden || !sessionId
    ? EMPTY_SNAPSHOT
    : lane ?? EMPTY_SNAPSHOT;
  return <>
    <ActiveAgentsIndicator snapshot={visibleSnapshot} onOpen={onOpenAgents} />
    <ActiveShellsIndicator snapshot={visibleSnapshot} />
  </>;
}


type SnapshotUtilityDockProps =
  Omit<React.ComponentProps<typeof UtilityDock>, "snapshot"> & {
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
  ...props
}: SnapshotUtilityDockProps) {
  const hostSnapshot = useDesktopSnapshotSelector(
    snapshotStore,
    selectDesktopSnapshot,
    desktopDockSnapshotsEqual,
  );
  return <UtilityDock {...props} snapshot={hidden ? EMPTY_SNAPSHOT : hostSnapshot} />;
});
