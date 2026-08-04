// Snapshot-scoped view slices: each subscribes to the shared desktop snapshot
// store through its OWN equality comparator, so a header-only change never
// re-renders the conversation (and vice versa). Extracted from App.tsx, which
// keeps composition and session flow.
import { Unplug } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { ActiveAgentsIndicator } from "./ActiveAgentsIndicator";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { Conversation } from "./Conversation";
import {
  desktopConversationShellSnapshotsEqual,
  desktopConversationSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopStreamingTailSnapshotsEqual,
  type DesktopSnapshotStore,
} from "./desktop-snapshot-store";
import {
  EMPTY_SNAPSHOT,
  EMPTY_TRANSCRIPT_ITEMS,
  type RecordValue,
  type Snapshot,
  type TranscriptItem,
} from "./desktop-types";
import { PaneSurfaceCover } from "./PaneSurfaceGate";
import type { SessionScopedSnapshotGate } from "./renderer-logic.mjs";
import { createSessionScopedSnapshotGate } from "./renderer-logic.mjs";
import { defaultSessionLaneStore, useSessionLane } from "./session-lane-store";
import { asRecord } from "./text-format";
import { ContextUsageIndicator, LiveWorkStatus, TranscriptRow } from "./TranscriptView";
import { UtilityDock } from "./UtilityDock";

export const selectDesktopSnapshot = (snapshot: Snapshot) => snapshot;

// The viewed tab scopes which LIVE frames may paint the conversation surface:
// frames carrying another session's id (background engines publishing) are
// suppressed, and only renderer-initiated host actions may adopt a fresh
// session id (submit materialization, auto-clear, /clear).
export interface SnapshotSessionScope {
  /** Viewed session id; '' scopes the New task draft (blank frames only). */
  sessionId: string;
  /** Called lazily with the FOREIGN live frame under adoption consideration. */
  mayAdoptForeign(live?: Snapshot | null): boolean;
  onForeignFrameSuppressed?(liveSessionId: string): void;
}

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

function useSelectedDesktopSnapshot(
  store: DesktopSnapshotStore,
  frozenSnapshot: Snapshot | null,
  isEqual: (left: Snapshot, right: Snapshot) => boolean = Object.is,
  sessionScope?: SnapshotSessionScope,
  enabled = true,
): Snapshot {
  const gateRef = useRef<{ id: string; gate: SessionScopedSnapshotGate<Snapshot> } | null>(null);
  const scopeId = sessionScope?.sessionId ?? "";
  const selector = useCallback(
    (live: Snapshot) => {
      if (frozenSnapshot) return frozenSnapshot;
      if (!sessionScope) return live;
      if (gateRef.current?.id !== scopeId) {
        gateRef.current = { id: scopeId, gate: createSessionScopedSnapshotGate<Snapshot>(scopeId) };
      }
      // Function form: the gate consults it lazily, only for foreign frames.
      const gated = gateRef.current.gate.select(live, sessionScope.mayAdoptForeign);
      if (gated.suppressedSessionId) {
        sessionScope.onForeignFrameSuppressed?.(gated.suppressedSessionId);
      }
      return gated.snapshot || EMPTY_SNAPSHOT;
    },
    [frozenSnapshot, scopeId, sessionScope],
  );
  return useDesktopSnapshotSelector(store, selector, isEqual, enabled);
}

type LiveConversationProps = Omit<React.ComponentProps<typeof Conversation>, "snapshot" | "routeSnapshot"> & {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  transcriptPending?: boolean;
  sessionScope?: SnapshotSessionScope;
};

function transcriptShellSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    items: EMPTY_TRANSCRIPT_ITEMS,
    streamingTail: null,
    failedTurnKeys: [],
    transcriptTurnKeys: [],
  };
}

type PaneStreamingTailProps = {
  focused: boolean;
  sessionId: string;
  fallback?: Snapshot | null;
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  sessionScope?: SnapshotSessionScope;
};

const PaneStreamingTail = memo(function PaneStreamingTail({
  focused,
  sessionId,
  fallback,
  snapshotStore,
  frozenSnapshot,
  hidden,
  sessionScope,
}: PaneStreamingTailProps) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    sessionId ? null : frozenSnapshot,
    desktopStreamingTailSnapshotsEqual,
    sessionId ? undefined : sessionScope,
    !hidden && !sessionId,
  );
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopStreamingTailSnapshotsEqual,
    !hidden,
  );
  const laneSnapshot = lane ?? fallback ?? EMPTY_SNAPSHOT;
  const selectedSessionId = String(selectedSnapshot.sessionId || "");
  const selectedOwnsPane = sessionId
    ? selectedSessionId === sessionId
    : selectedSessionId === "";
  // Every session pane reads one source for its whole lifetime. Focus changes
  // input routing only; it never swaps transcript/tail ownership.
  const snapshot = sessionId
    ? laneSnapshot
    : focused && selectedOwnsPane ? selectedSnapshot : laneSnapshot;
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

export const LiveConversation = memo(function LiveConversation({
  snapshotStore,
  frozenSnapshot,
  hidden,
  transcriptPending = false,
  sessionScope,
  ...props
}: LiveConversationProps) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopConversationSnapshotsEqual,
    sessionScope,
  );
  const visibleSnapshot = hidden
    ? EMPTY_SNAPSHOT
    : transcriptPending ? transcriptShellSnapshot(selectedSnapshot) : selectedSnapshot;
  return <Conversation snapshot={visibleSnapshot} routeSnapshot={selectedSnapshot} {...props} />;
});

// Every split-pane chat keeps ONE Conversation instance mounted for its whole
// lifetime. Focus only changes which snapshot/callback route owns that same
// tree; it must never swap LiveConversation <-> LaneConversation because that
// remount consumes the first control click and resets open picker state.
type PaneConversationProps =
  Omit<React.ComponentProps<typeof Conversation>, "snapshot" | "routeSnapshot" | "streamingTailSlot"> & {
    focused: boolean;
    sessionId: string;
    fallback?: Snapshot | null;
    snapshotStore: DesktopSnapshotStore;
    frozenSnapshot: Snapshot | null;
    hidden: boolean;
    transcriptPending?: boolean;
    reconcileOnMount?: boolean;
    sessionScope?: SnapshotSessionScope;
  };

export const PaneConversation = memo(function PaneConversation({
  focused,
  sessionId,
  fallback,
  snapshotStore,
  frozenSnapshot,
  hidden,
  transcriptPending = false,
  reconcileOnMount = true,
  sessionScope,
  draftMode = false,
  ...props
}: PaneConversationProps) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    sessionId ? null : frozenSnapshot,
    desktopConversationShellSnapshotsEqual,
    sessionId ? undefined : sessionScope,
    !sessionId,
  );
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopConversationShellSnapshotsEqual,
    !hidden,
  );
  useLayoutEffect(() => {
    // Every mounted session reconciles once per mount/session change, even if
    // an eager startup lane already exists. That lane can predate dead-owner
    // checkpoint recovery and must never suppress the host handshake.
    // A successful focused resume already crossed the same recovery boundary
    // and placed its authoritative result in this lane before revealing it.
    if (sessionId && reconcileOnMount) requestSessionPeek(sessionId, { reconcile: true });
  }, [reconcileOnMount, sessionId]);
  const laneSnapshot = lane ?? fallback ?? EMPTY_SNAPSHOT;
  const selectedSessionId = String(selectedSnapshot.sessionId || "");
  const selectedOwnsDraft = selectedSessionId === "";
  const routeSnapshot = sessionId
    ? laneSnapshot
    : focused && selectedOwnsDraft ? selectedSnapshot : EMPTY_SNAPSHOT;
  const paneSnapshot = hidden ? EMPTY_SNAPSHOT : routeSnapshot;
  const cachedTranscriptReady = Boolean(fallback?.items?.length);
  const surfaceReady = hidden || !sessionId
    || (!transcriptPending && (lane !== null || cachedTranscriptReady));
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
      draftMode={draftMode}
      warmPaintHandoff={warmDraftHandoff}
      liveWork={<PaneLiveWork
        focused={focused}
        sessionId={sessionId}
        fallback={fallback}
        snapshotStore={snapshotStore}
        frozenSnapshot={frozenSnapshot}
        hidden={hidden}
        sessionScope={sessionScope} />}
      streamingTailSlot={<PaneStreamingTail
        focused={focused}
        sessionId={sessionId}
        fallback={fallback}
        snapshotStore={snapshotStore}
        frozenSnapshot={frozenSnapshot}
        hidden={hidden}
        sessionScope={sessionScope} />}
      {...props}
    />
    <PaneSurfaceCover ready={surfaceReady} label="Loading conversation…"
      transitionKey={sessionId || "new-task"} />
  </>;
});

export function SnapshotHeaderStatus({
  snapshotStore,
  frozenSnapshot,
  hidden,
  sessionScope,
  draftRemoteEnabled,
  onOpen,
  onOpenAgents,
  onRemoteChange,
}: {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  sessionScope?: SnapshotSessionScope;
  draftRemoteEnabled?: boolean;
  onOpen(): void;
  onOpenAgents?(): void;
  onRemoteChange(enabled: boolean): void | Promise<void>;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopHeaderSnapshotsEqual,
    sessionScope,
  );
  const visibleSnapshot = hidden ? EMPTY_SNAPSHOT : selectedSnapshot;
  return <>
    {onOpenAgents && <ActiveAgentsIndicator snapshot={visibleSnapshot} onOpen={onOpenAgents} />}
    <ContextUsageIndicator snapshot={visibleSnapshot} onOpen={onOpen} />
    <RemoteToggleButton snapshot={visibleSnapshot} draftEnabled={draftRemoteEnabled}
      onChange={onRemoteChange} />
  </>;
}

// Pane peek: subscribe BEFORE asking the host. Modern visible-session hosts
// retain their latest live frame, so this handshake is safe even when it races
// registration: a delayed disk read cannot replace a newer owner frame.
// Dedupe only while a request is in flight; a failed/missed startup peek gets
// bounded retries instead of being suppressed forever.
const sessionPeeksInFlight = new Map<string, Promise<boolean>>();
const MAX_SESSION_PEEK_ATTEMPTS = 3;
export function requestSessionPeek(
  sessionId: string,
  { reconcile = false }: { reconcile?: boolean } = {},
): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  if (!reconcile && defaultSessionLaneStore.get(sessionId)) return Promise.resolve(true);
  const inFlight = sessionPeeksInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const peekSession = window.mixdogDesktop?.peekSession;
  if (typeof peekSession !== "function") return Promise.resolve(false);
  defaultSessionLaneStore.start();
  const request = (async () => {
    for (let attempt = 1; attempt <= MAX_SESSION_PEEK_ATTEMPTS; attempt += 1) {
      let accepted = false;
      try {
        accepted = await Promise.resolve(peekSession(sessionId)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) return true;
      if (attempt < MAX_SESSION_PEEK_ATTEMPTS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    }
    return false;
  })();
  sessionPeeksInFlight.set(sessionId, request);
  void request.finally(() => {
    if (sessionPeeksInFlight.get(sessionId) === request) {
      sessionPeeksInFlight.delete(sessionId);
    }
  });
  return request;
}

// Corner cluster for a NON-FOCUSED pane: context/remote read the pane's OWN
// live lane snapshot (fallback: that session's cached snapshot), so every
// pane keeps its own values instead of mirroring — and blinking with — the
// focused engine's stream. Draft panes pass an empty sessionId and render
// the neutral (empty-context, remote-off) cluster.
export function PaneHeaderStatus({
  focused,
  sessionId,
  fallback,
  snapshotStore,
  frozenSnapshot,
  hidden,
  reconcileOnMount = true,
  sessionScope,
  draftRemoteEnabled,
  onOpen,
  onOpenAgents,
  onRemoteChange,
}: {
  focused: boolean;
  sessionId: string;
  fallback?: Snapshot | null;
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  reconcileOnMount?: boolean;
  sessionScope?: SnapshotSessionScope;
  draftRemoteEnabled?: boolean;
  onOpen(): void;
  onOpenAgents?(): void;
  onRemoteChange(enabled: boolean): void | Promise<void>;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    sessionId ? null : frozenSnapshot,
    desktopHeaderSnapshotsEqual,
    sessionId ? undefined : sessionScope,
    !sessionId,
  );
  const lane = useSessionLane(sessionId);
  useLayoutEffect(() => {
    // Header state is independently foreground-owned. Reconcile even when a
    // cached lane exists: a cold lane can predate the latest durable context
    // projection, and a pane that has never been focused must still show its
    // own current usage rather than waiting for Conversation or resume.
    if (sessionId && reconcileOnMount) requestSessionPeek(sessionId, { reconcile: true });
  }, [reconcileOnMount, sessionId]);
  const laneSnapshot = (lane ?? fallback ?? EMPTY_SNAPSHOT) as Snapshot;
  const selectedSessionId = String(selectedSnapshot.sessionId || "");
  const selectedOwnsPane = sessionId
    ? selectedSessionId === sessionId
    : selectedSessionId === "";
  const visibleSnapshot = sessionId
    ? laneSnapshot
    : focused && !hidden && selectedOwnsPane ? selectedSnapshot : laneSnapshot;
  return <>
    {onOpenAgents && <ActiveAgentsIndicator snapshot={visibleSnapshot} onOpen={onOpenAgents} />}
    <ContextUsageIndicator snapshot={visibleSnapshot} onOpen={onOpen} />
    <RemoteToggleButton snapshot={visibleSnapshot}
      draftEnabled={focused ? draftRemoteEnabled : undefined}
      onChange={onRemoteChange} />
  </>;
}

// The activity band follows the same pane-local source as the transcript.
// Focus changes interaction routing only; it never adds/removes UI chrome.
export function PaneLiveWork({
  focused,
  sessionId,
  fallback,
  snapshotStore,
  frozenSnapshot,
  hidden,
  sessionScope,
}: {
  focused: boolean;
  sessionId: string;
  fallback?: Snapshot | null;
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  sessionScope?: SnapshotSessionScope;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    sessionId ? null : frozenSnapshot,
    desktopHeaderSnapshotsEqual,
    sessionId ? undefined : sessionScope,
    !sessionId,
  );
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopHeaderSnapshotsEqual,
    !hidden,
  ) as Snapshot | null;
  useEffect(() => {
    if (!hidden && sessionId && !lane) requestSessionPeek(sessionId);
  }, [hidden, lane, sessionId]);
  const laneSnapshot = lane ?? fallback ?? EMPTY_SNAPSHOT;
  const selectedSessionId = String(selectedSnapshot.sessionId || "");
  const selectedOwnsPane = sessionId
    ? selectedSessionId === sessionId
    : selectedSessionId === "";
  const visibleSnapshot = sessionId
    ? laneSnapshot
    : focused && !hidden && selectedOwnsPane ? selectedSnapshot : laneSnapshot;
  return <div className="chat-live-work">
    <LiveWorkStatus snapshot={visibleSnapshot} />
  </div>;
}

// A NON-FOCUSED pane's conversation: the IDENTICAL Conversation component the
// focused surface uses — no replica, no reduced variant (user requirement:
// selected and unselected panes are the same live surface). Sessions stream
// from their own lane; drafts pass an empty sessionId and render the draft
// welcome/composer over the EMPTY snapshot.
type LaneConversationProps =
  Omit<React.ComponentProps<typeof Conversation>, "snapshot" | "routeSnapshot"> & {
    sessionId: string;
    fallback?: Snapshot | null;
  };
export const LaneConversation = memo(function LaneConversation({
  sessionId,
  fallback,
  ...props
}: LaneConversationProps) {
  const lane = useSessionLane(sessionId) as Snapshot | null;
  useEffect(() => {
    if (sessionId && !lane) requestSessionPeek(sessionId);
  }, [lane, sessionId]);
  const snapshot = lane ?? fallback ?? EMPTY_SNAPSHOT;
  return <Conversation snapshot={snapshot} routeSnapshot={snapshot} {...props} />;
});

/** Child-agent transcript viewer. The child lane is refreshed independently
 * from the focused parent engine and Conversation mounts no mutating controls. */
export const AgentSessionConversation = memo(function AgentSessionConversation({
  sessionId,
}: {
  sessionId: string;
}) {
  const lane = useSessionLane(
    sessionId,
    defaultSessionLaneStore,
    desktopConversationSnapshotsEqual,
  ) as Snapshot | null;
  const [peekFailed, setPeekFailed] = useState(false);
  const [retryRequest, setRetryRequest] = useState(0);
  useLayoutEffect(() => {
    if (!sessionId) return undefined;
    let current = true;
    setPeekFailed(false);
    void requestSessionPeek(sessionId, { reconcile: true }).then((accepted) => {
      if (current && !accepted && !defaultSessionLaneStore.get(sessionId)) {
        setPeekFailed(true);
      }
    });
    return () => { current = false; };
  }, [retryRequest, sessionId]);
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  return <>
    <Conversation snapshot={snapshot} routeSnapshot={snapshot} readOnly
      invokeResult={async () => undefined}
      errors={[]}
      submit={async () => undefined}
      applySnapshot={() => {}}
      transitioning={false}
      composerFocusRequest={0}
      onNewTask={() => {}}
      onResumeSession={() => {}}
      onOpenSessions={() => {}}
      onOpenSettings={() => {}}
      projects={[]}
      showProjectSelector={false}
      activeProjectPath=""
      activeProjectLabel=""
      onSelectProject={() => {}}
      onChooseProject={() => {}}
      onOpenCommandSurface={() => {}} />
    {peekFailed && lane === null
      ? <div className="pane-surface-cover agent-session-unavailable" role="alert">
        <div className="agent-session-unavailable-card">
          <strong>Agent session record unavailable</strong>
          <span>The transcript and its archived result could not be loaded.</span>
          <button type="button" onClick={() => setRetryRequest((value) => value + 1)}>Retry</button>
        </div>
      </div>
      : <PaneSurfaceCover ready={lane !== null} label="Loading agent session…"
        transitionKey={`agent-session:${sessionId}`} />}
  </>;
});

// Background activity overlays the right edge of the thinking/tool status
// band; the breakdown still reveals on hover via the chip's own popover.
export function SnapshotLiveWork({
  snapshotStore,
  frozenSnapshot,
  hidden,
  sessionScope,
}: {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  sessionScope?: SnapshotSessionScope;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopHeaderSnapshotsEqual,
    sessionScope,
  );
  const visibleSnapshot = hidden ? EMPTY_SNAPSHOT : selectedSnapshot;
  return <div className="chat-live-work">
    <LiveWorkStatus snapshot={visibleSnapshot} />
  </div>;
}

// Lucide's Wifi draws its base dot as a 0.01-length stroke ("M12 20h.01") —
// invisible at the header's thin 1.25px stroke. Same waves, but the dot is a
// FILLED circle so the glyph reads complete (user: "the bottom looks empty").
function WifiGlyph({ size = 18 }: { size?: number }) {
  return <svg className="lucide" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {/* The stock glyph spans y 8.8–20 (optical center ~14.4): shift up so it
        centers in the 24px box like its neighbors. Integer shift keeps the
        arcs on the pixel grid (user: -2.4 read slightly high and fuzzy). */}
    <g transform="translate(0 -2)">
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.859a10 10 0 0 1 14 0" />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
      <circle cx="12" cy="20" r="1.2" fill="currentColor" stroke="none" />
    </g>
  </svg>;
}

// SESSION-SCOPED remote (user decision): the toggle reflects whether the
// VIEWED session owns the channel relay (snapshot-driven — no polling).
// Off → on claims for this session; owner → off; owned elsewhere → clicking
// moves the relay seat to this session (last-wins).
// The channel-setup probe result is cached at module scope: every pane (and
// every focus swap) remounts this button, and a null initial state hid it
// until the async probe returned — the cluster popped in and out and shifted
// its neighbors (user report).
let channelReadyCache: boolean | null = null;
let channelReadyProbe: Promise<void> | null = null;
let channelReadyTimer = 0;
const channelReadyListeners = new Set<() => void>();
const CHANNEL_READY_POLL_MS = 60_000;

function readChannelReady(): boolean | null {
  return channelReadyCache;
}

function publishChannelReady(ready: boolean): void {
  if (channelReadyCache === ready) return;
  channelReadyCache = ready;
  for (const listener of [...channelReadyListeners]) listener();
}

function probeChannelReady(): Promise<void> {
  channelReadyProbe ??= (async () => {
    try {
      const result = await window.mixdogDesktop.invokeCapability<RecordValue>({
        capability: "getChannelSetup",
        args: [],
      });
      const setup = asRecord(result?.value) || {};
      const channel = asRecord(setup.channel) || {};
      const backend = String(setup.backend || "discord");
      publishChannelReady(backend === "telegram"
        ? asRecord(setup.telegram)?.authenticated === true
          && Boolean(channel.telegramChatId || channel.channelId)
        : asRecord(setup.discord)?.authenticated === true
          && Boolean(channel.discordChannelId || channel.channelId));
    } catch {
      publishChannelReady(channelReadyCache ?? false);
    }
  })().finally(() => {
    channelReadyProbe = null;
  });
  return channelReadyProbe;
}

function probeVisibleChannelReady(): void {
  if (document.visibilityState === "visible") void probeChannelReady();
}

function subscribeChannelReady(listener: () => void): () => void {
  const first = channelReadyListeners.size === 0;
  channelReadyListeners.add(listener);
  if (first) {
    document.addEventListener("visibilitychange", probeVisibleChannelReady);
    // The first render needs an answer even in prerender/jsdom shells whose
    // visibility state is not yet "visible"; only recurring probes are gated.
    void probeChannelReady();
    channelReadyTimer = window.setInterval(probeVisibleChannelReady, CHANNEL_READY_POLL_MS);
  }
  return () => {
    channelReadyListeners.delete(listener);
    if (channelReadyListeners.size > 0) return;
    window.clearInterval(channelReadyTimer);
    channelReadyTimer = 0;
    document.removeEventListener("visibilitychange", probeVisibleChannelReady);
  };
}

function RemoteToggleButton({
  snapshot,
  draftEnabled,
  onChange,
}: {
  snapshot: Snapshot;
  draftEnabled?: boolean;
  onChange(enabled: boolean): void | Promise<void>;
}) {
  beginBootSurface("channel-controls", "setup");
  const [busy, setBusy] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const requestEpoch = useRef(0);
  // Every split-pane header consumes one process-wide probe. The old
  // per-button interval multiplied the same capability RPC by pane count.
  const channelReady = useSyncExternalStore(
    subscribeChannelReady,
    readChannelReady,
    () => false,
  );
  useEffect(() => {
    if (channelReady === null) return;
    reportBootSurfaceStage("channel-controls", "setup", "data");
    reportBootSurfaceReady("channel-controls", "setup");
  }, [channelReady]);
  const remoteEnabled = snapshot.remoteEnabled === true;
  const owner = String(snapshot.remoteSessionId || "");
  const current = String(snapshot.sessionId || "");
  const draft = typeof draftEnabled === "boolean";
  const settledOn = remoteEnabled && Boolean(owner) && owner === current;
  const on = draft ? draftEnabled : pendingEnabled ?? settledOn;
  const elsewhere = !draft && pendingEnabled === null && remoteEnabled && !settledOn;
  if (channelReady !== true) return null;
  // On/off reads through the GLYPH, not color (user decision): Wifi waves
  // while THIS session relays, Unplug otherwise — same ink, stroke, and 18px
  // frame as the panel toggle.
  return <button type="button"
    className="session-dock-toggle remote-toggle"
    aria-pressed={on} aria-busy={busy || undefined}
    aria-label={draft
      ? on ? "Turn remote off for this new task" : "Turn remote on for this new task"
      : on ? "Turn channel relay off"
        : elsewhere ? "Override the channel relay with this session"
          : "Turn channel relay on"}
    data-tooltip={busy ? "Updating remote…"
      : draft ? on ? "Remote on for new task" : "Remote off for new task"
        : on ? "Remote on" : elsewhere ? "Remote on elsewhere — click to override" : "Remote off"}
    onClick={() => {
      if (draft) {
        void onChange(!on);
        return;
      }
      const desired = !on;
      const requestId = ++requestEpoch.current;
      setPendingEnabled(desired);
      setBusy(true);
      void Promise.resolve(onChange(desired)).finally(() => {
        if (requestId !== requestEpoch.current) return;
        setPendingEnabled(null);
        setBusy(false);
      });
    }}>
    {on ? <WifiGlyph size={18} /> : <Unplug size={18} aria-hidden="true" />}
  </button>;
}

type SnapshotUtilityDockProps =
  Omit<React.ComponentProps<typeof UtilityDock>, "snapshot"> & {
    snapshotStore: DesktopSnapshotStore;
    frozenSnapshot: Snapshot | null;
    hidden: boolean;
  };

// ONE dock element for every tab. The old per-tab alternation between a
// snapshot-backed dock (Files) and a bare one (Tasks/Source Control) swapped
// the component TYPE on a tab change, which unmounted the whole dock — every
// retained pane, tree expansion and scroll went with it. The dock-scoped
// comparator (desktopDockSnapshotsEqual) already limits re-renders to the
// fields the dock reads, and UtilityDock is memoised, so a single subscription
// keeps live agent/tool work flowing without rebuilding the surface.
export const SnapshotUtilityDock = memo(function SnapshotUtilityDock({
  snapshotStore,
  frozenSnapshot,
  hidden,
  ...props
}: SnapshotUtilityDockProps) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopDockSnapshotsEqual,
  );
  return <UtilityDock {...props} snapshot={hidden ? EMPTY_SNAPSHOT : selectedSnapshot} />;
});
