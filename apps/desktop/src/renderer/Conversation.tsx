import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  X
} from "lucide-react";
import type {
  DesktopModelSelection,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopWorkflowState,
  EngineSnapshot
} from "../shared/contract";
import { MxIcon } from "./MxIcon";
import {
  approvalInstanceKey,
  isScrollIntentKey,
  transcriptTurnKeys
} from "./renderer-logic.mjs";
import {
  type CommandSurface as CommandSurfaceName,
  type SettingsSection
} from "./slash-commands";

import { ApprovalCard } from "./ApprovalCard";
import { Composer, ProjectContextSelector, WorkflowSelect } from "./Composer";
import { BrandTile } from "./WorkspaceEmptyState";
import { EMPTY_TRANSCRIPT_ITEMS, type RecordValue, type Snapshot, type TranscriptItem } from "./desktop-types";
import { InlineErrors } from "./notifications";
import { asRecord } from "./text-format";
import {
  isRetainableTranscriptMarkdownRow,
  refreshRetainedTranscriptMarkdownRows,
  TRANSCRIPT_MARKDOWN_DOM_LRU_LIMIT,
  type RetainedTranscriptMarkdownRow,
} from "./transcript-dom-lru";
import { estimatedTranscriptRowHeight, lastVisibleTranscriptItemIndex, rememberMeasuredTranscriptRowHeight, shouldCompensateTranscriptRowMeasurement, TRANSCRIPT_VIRTUAL_OVERSCAN, TRANSCRIPT_VIRTUALIZE_THRESHOLD } from "./transcript-metrics";
import { completionTone, LiveActivity, resetToolDisclosureScope, TranscriptRow } from "./TranscriptView";
import { TurnReviewBar } from "./TurnReview";
import { useTranscriptScrollRuntime } from "./use-transcript-scroll-runtime";


export type PendingPromptItem = TranscriptItem & {
  id: string | number;
  kind: "user";
  text: string;
  pending: boolean;
  accepted: boolean;
  submittedAt: number;
};

export type SessionScrollPosition = {
  top: number;
  atEnd: boolean;
  anchorKey?: string;
  anchorIndex?: number;
  anchorOffset?: number;
  layoutWidth?: number;
};

export const SESSION_SCROLL_POSITION_LIMIT = 32;

export function rememberSessionScrollPosition(
  positions: Map<string, SessionScrollPosition>,
  sessionKey: string,
  position: SessionScrollPosition,
  limit = SESSION_SCROLL_POSITION_LIMIT,
): void {
  positions.delete(sessionKey);
  positions.set(sessionKey, position);
  while (positions.size > Math.max(0, limit)) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

// A wheel over a nested scroller (tool output, thinking log) that can still
// consume the delta in that direction never moves the transcript itself.
// Treating it as transcript scroll intent intermittently released
// bottom-follow (user: 간헐적으로 자동스크롤이 풀림).
function wheelConsumedByNestedScroller(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== boundary) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const canConsume = deltaY < 0
        ? node.scrollTop > 0.5
        : node.scrollTop + node.clientHeight < node.scrollHeight - 0.5;
      if (canConsume) {
        const { overflowY } = window.getComputedStyle(node);
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
          return true;
        }
      }
    }
    node = node.parentElement;
  }
  return false;
}

let desktopSubmissionSequence = 0;

function nextDesktopSubmissionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `desktop-submit-${uuid || `${Date.now()}-${++desktopSubmissionSequence}`}`;
}

function desktopPromptDisplayText(
  content: DesktopPromptContent,
  options?: DesktopSubmitOptions,
): string {
  const explicit = String(options?.displayText || "").trim();
  if (explicit) return explicit;
  if (typeof content === "string") return content.trim();
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image") return "[Image]";
    return `[File: ${part.filename || "attachment"}]`;
  }).filter(Boolean).join("\n").trim() || "Attached prompt";
}

function pendingPromptImages(options?: DesktopSubmitOptions): NonNullable<TranscriptItem["images"]> {
  return Object.values(options?.pastedImages || {}).map((image) => ({
    id: image.id,
    name: image.filename || "Image",
    mimeType: image.mediaType,
    bytes: image.content.length,
  }));
}

export function pendingPromptTranscriptItems(
  optimistic: PendingPromptItem[],
  settled: TranscriptItem[],
  _queued: unknown[] = [],
): PendingPromptItem[] {
  const settledIds = new Set(settled
    .map((item) => item?.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String));
  const byId = new Map<string, PendingPromptItem>();
  for (const item of optimistic) {
    if (item?.id === undefined || item.id === null || !String(item.text || "").trim()) continue;
    byId.set(String(item.id), item);
  }
  return [...byId.entries()]
    .filter(([id]) => !settledIds.has(id))
    // Host acknowledgement transfers presentation ownership to the real
    // transcript/engine queue. Keeping this renderer row until a matching
    // transcript id arrived duplicated prompts when the host normalized ids.
    .filter(([, item]) => item.accepted !== true)
    // Before host acknowledgement the optimistic row is still pending. After
    // a queue publication it remains the single temporary row only until the
    // submit RPC acknowledges; the authoritative queue then takes over.
    .map(([, item]) => ({
      ...item,
      pending: true,
    }))
    .sort((left, right) => left.submittedAt - right.submittedAt);
}

export function Conversation({
  snapshot,
  routeSnapshot,
  invokeResult,
  errors,
  submit,
  applySnapshot,
  transitioning,
  composerFocusRequest,
  onNewTask,
  onResumeSession,
  onOpenSessions,
  onOpenSettings,
  projects,
  showProjectSelector,
  activeProjectPath,
  activeProjectLabel,
  onSelectProject,
  onChooseProject,
  draftMode = false,
  draftModelSelection,
  draftWorkflow,
  onDraftModelSelection,
  onDraftWorkflow,
  onOpenCommandSurface,
  liveWork,
  streamingTailSlot,
  readOnly = false,
  warmPaintHandoff = false,
}: {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  onChooseProject: () => void;
  draftMode?: boolean;
  draftModelSelection?: DesktopModelSelection | null;
  draftWorkflow?: DesktopWorkflowState | null;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onDraftWorkflow?: (workflow: DesktopWorkflowState) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  /** Background-activity chip rendered right above the composer (own
   *  snapshot subscription — the conversation memo ignores agent workers). */
  liveWork?: ReactNode;
  /** Selector-driven live row; keeps token publications out of this shell. */
  streamingTailSlot?: ReactNode;
  /** Transcript-only child-agent view: no submit, retry, approval, review, or
   *  other engine-mutating controls are mounted. */
  readOnly?: boolean;
  /** A warm New Task → session commit paints the requested transcript under
   *  the prior watermark for one frame so Chromium uploads its raster before
   *  it becomes visible. Route identity and interaction are already current. */
  warmPaintHandoff?: boolean;
  /** A session is opening with nothing cached to paint yet. Transitions stay
   *  wordless, so the thread shows placeholder rows — never the empty-task
   *  welcome, which read as a hang on the first cold open. */
}) {
  const conversation = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const virtualContent = useRef<HTMLDivElement>(null);
  const transcriptLayoutWidth = useRef(800);
  // Width reflow is a separate scroll phase: while wrapped rows are being
  // remeasured, neither the aggregate observer nor TanStack compensation may
  // chase each intermediate total height.
  const widthReflowing = useRef(false);
  const {
    following,
    followingRef: followOutput,
    ownerRef: scrollOwnerRef,
    programmaticRef: programmaticScroll,
    markProgrammatic: markProgrammaticScroll,
    markUserInput: markScrollUserInput,
    takeUserControl: takeScrollUserControl,
    resumeFollow,
    suspend: suspendScroll,
    resolveSuspension: resolveScrollSuspension,
    snapToBottom: writeViewportBottom,
    scrollToBottom: driveScrollToBottom,
    followContentGrowth,
    writeDelta: writeScrollDelta,
  } = useTranscriptScrollRuntime();
  const pointerScrollIntent = useRef(false);
  const pointerScrollStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const scrollIntentUntil = useRef(0);
  const lastObservedScrollTop = useRef(0);
  const bottomReturnIntent = useRef(false);
  // Tool-card toggle hold: for the ~2 frames the clicked card is being kept in
  // place, no observer may re-pin the bottom — the pin re-applied exactly the
  // shift the anchor correction had just undone.
  const toggleHoldUntil = useRef(0);
  const toggleSequence = useRef(0);
  const sessionScrollPositions = useRef(new Map<string, SessionScrollPosition>());
  const restoredTranscriptSessionKey = useRef("");
  const [optimisticPrompts, setOptimisticPrompts] = useState<PendingPromptItem[]>([]);
  const composerActions = useRef({
    submit, invokeResult, applySnapshot, onNewTask, onResumeSession,
    onOpenSessions, onOpenSettings, onOpenCommandSurface,
  });
  composerActions.current = {
    submit, invokeResult, applySnapshot, onNewTask, onResumeSession,
    onOpenSessions, onOpenSettings, onOpenCommandSurface,
  };
  // TUI parity: a prompt only reads as "Queued" when it actually waits behind
  // an active turn. An idle submit — including a draft's first prompt, whose
  // atomic RPC spans session materialization — renders as a normal user row.
  const queuedBehindTurnAtSubmit = useRef(false);
  queuedBehindTurnAtSubmit.current = Boolean(snapshot.busy)
    || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0);
  const settledItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  const streamingTail = snapshot.streamingTail as TranscriptItem | null | undefined;
  const streamingTailId = streamingTail?.id;
  // Settled arrays are immutable by identity. Resolve a same-id replacement
  // only when that identity or the tail id changes; streamed text then uses an
  // indexed settled+tail view instead of allocating/copying a merged array.
  const tailSettledIndex = useMemo(() => {
    if (streamingTailId === undefined || streamingTailId === null) return -1;
    return settledItems.findIndex((item) => item?.id === streamingTailId);
  }, [settledItems, streamingTailId]);
  const tailAppended = Boolean(streamingTail) && tailSettledIndex < 0;
  const liveItemCount = settledItems.length + (tailAppended ? 1 : 0);
  const transcriptSessionKey = draftMode
    ? 'new-task'
    : String(routeSnapshot.sessionId || 'new-task');
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  // Session ENTRY resets this visit's tool disclosures before the first row
  // renders (user: tool cards must always start collapsed; remembered
  // expansions from an earlier visit reopened them "randomly"). Idempotent
  // render-time module-map mutation; focus swaps keep the same key and do
  // not reset.
  const disclosureVisitKey = useRef("");
  if (disclosureVisitKey.current !== transcriptSessionKey) {
    disclosureVisitKey.current = transcriptSessionKey;
    resetToolDisclosureScope(transcriptSessionKey);
  }
  const pendingPromptItems = useMemo(
    () => pendingPromptTranscriptItems(
      optimisticPrompts,
      settledItems,
      Array.isArray(snapshot.queued) ? snapshot.queued : [],
    ),
    [optimisticPrompts, settledItems, snapshot.queued],
  );
  const pendingPromptIds = useMemo(
    () => pendingPromptItems.map((item) => item.id),
    [pendingPromptItems],
  );
  const optimisticActivityStartedAt = pendingPromptItems.reduce((earliest, item) => {
    if (item.queuedBehindTurn === true) return earliest;
    const startedAt = Number(item.submittedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return earliest;
    return earliest > 0 ? Math.min(earliest, startedAt) : startedAt;
  }, 0);
  const itemCount = liveItemCount + pendingPromptItems.length;
  const currentItemCount = useRef(itemCount);
  currentItemCount.current = itemCount;
  const transcriptItemAt = useCallback((index: number): TranscriptItem | undefined => {
    if (streamingTail && (
      index === tailSettledIndex
      || (tailAppended && index === settledItems.length)
    )) {
      return streamingTail;
    }
    if (index >= liveItemCount) return pendingPromptItems[index - liveItemCount];
    return settledItems[index];
  }, [liveItemCount, pendingPromptItems, settledItems, streamingTail, tailSettledIndex, tailAppended]);
  const settledTranscriptItemAt = useCallback(
    (index: number): TranscriptItem | undefined => settledItems[index],
    [settledItems],
  );
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    setOptimisticPrompts([]);
  }, [transcriptSessionKey]);
  useEffect(() => {
    // Queue acknowledgement is not settlement: keep the optimistic card
    // visible (and hide only its duplicate queue row) until the same id lands
    // in the transcript after provider injection.
    const acknowledged = new Set(settledItems
      .map((item) => item?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String));
    if (acknowledged.size === 0) return;
    setOptimisticPrompts((current) => {
      const next = current.filter((item) => !acknowledged.has(String(item.id)));
      return next.length === current.length ? current : next;
    });
  }, [settledItems]);
  const virtualizingTranscript = itemCount > TRANSCRIPT_VIRTUALIZE_THRESHOLD;
  // Keep the continuously changing streaming row OUTSIDE the historical
  // virtualizer whenever it is the transcript tail. This removes the hottest
  // feedback loop: token render -> row ResizeObserver -> virtual size update
  // -> end-anchor correction -> content ResizeObserver -> second correction.
  // Stable history remains virtualized; the live suffix grows in normal flow
  // and is followed by the existing content observer.
  const detachedStreamingTail = Boolean(
    streamingTail
    && (tailAppended || tailSettledIndex === settledItems.length - 1)
    && (virtualizingTranscript || streamingTailSlot)
  );
  const virtualItemCount = detachedStreamingTail
    ? Math.max(0, settledItems.length - (tailAppended ? 0 : 1))
    : itemCount;
  const virtualTranscriptItemAt = detachedStreamingTail
    ? settledTranscriptItemAt
    : transcriptItemAt;
  // Keep entry geometry immutable after the first commit. A delayed idle
  // prewarm used to widen overscan in batches and repeatedly rewrite virtual
  // row sizes several seconds after opening a session. Rows now measure only
  // when actual scrolling mounts them; off-bottom compensation keeps the
  // reader's visible anchor stable during that user-driven work.
  const failedTurns = useMemo(() => new Set(snapshot.failedTurnKeys || []), [snapshot.failedTurnKeys]);
  const precomputedTurnKeys = Array.isArray(snapshot.transcriptTurnKeys)
    ? snapshot.transcriptTurnKeys as string[]
    : null;
  const turnMetadata = useMemo(() => {
    // Streaming text changes must not rescan the full settled transcript.
    // Completion/failure structure lives in settled items; the live tail only
    // needs one derived turn key below.
    const current = settledItems;
    const turnKeys = precomputedTurnKeys?.length === current.length
      ? precomputedTurnKeys
      : transcriptTurnKeys(current);
    const lastItemByTurn = new Map<string, number>();
    const lastCompletionByTurn = new Map<string, number>();
    const lastAssistantByTurn = new Map<string, number>();
    const completionByAssistant = new Map<number, TranscriptItem>();
    const attachedCompletionIndexes = new Set<number>();
    turnKeys.forEach((turnKey, index) => {
      lastItemByTurn.set(turnKey, index);
      if (current[index]?.kind === "assistant") lastAssistantByTurn.set(turnKey, index);
      if (current[index]?.kind === "statusdone" || current[index]?.kind === "turndone") {
        lastCompletionByTurn.set(turnKey, index);
      }
      const item = current[index];
      if (item?.kind !== "turndone" || failedTurns.has(turnKey) || completionTone(item) !== "complete") return;
      const assistantIndex = lastAssistantByTurn.get(turnKey);
      if (assistantIndex === undefined) return;
      completionByAssistant.set(assistantIndex, item);
      attachedCompletionIndexes.add(index);
    });
    return { turnKeys, lastItemByTurn, lastCompletionByTurn, completionByAssistant, attachedCompletionIndexes };
  }, [settledItems, failedTurns, precomputedTurnKeys]);
  const { turnKeys: settledTurnKeys, lastItemByTurn, lastCompletionByTurn, completionByAssistant, attachedCompletionIndexes } = turnMetadata;
  const tailTurnKey = useMemo(() => {
    if (!tailAppended || !streamingTail) return "";
    const previous = settledItems.at(-1);
    if (previous?.kind !== "turndone" && settledTurnKeys.length > 0) {
      return settledTurnKeys.at(-1) || "";
    }
    return transcriptTurnKeys([streamingTail])[0] || "";
  }, [settledItems, settledTurnKeys, streamingTail, tailAppended]);
  const turnKeyAt = useCallback((index: number) => {
    if (index < settledTurnKeys.length) return settledTurnKeys[index];
    if (index < liveItemCount) return tailTurnKey;
    return `pending:${String(transcriptItemAt(index)?.id ?? index)}`;
  }, [liveItemCount, settledTurnKeys, tailTurnKey, transcriptItemAt]);
  const transcriptItemHidden = (index: number) => {
    if (attachedCompletionIndexes.has(index)) return true;
    const item = transcriptItemAt(index);
    const completion = item?.kind === "statusdone" || item?.kind === "turndone";
    const turnKey = turnKeyAt(index);
    return Boolean(completion && failedTurns.has(turnKey) && index !== lastCompletionByTurn.get(turnKey));
  };
  const lastVisibleTranscriptIndex = lastVisibleTranscriptItemIndex(
    itemCount,
    transcriptItemHidden,
  );
  // Row identity must survive index shifts: the streaming tail's index moves
  // every time a settled row lands above it, and an index-suffixed key made
  // the virtualizer drop that row's measured size on every append — the tail
  // then repainted at its ESTIMATE height until re-measure (user: rows bounce
  // up/down inside a still-streaming session). Index remains only as the
  // fallback identity for id-less rows.
  const transcriptItemKey = useCallback((index: number) => {
    const item = virtualTranscriptItemAt(index);
    const id = item?.id;
    return id !== undefined && id !== null
      ? `${transcriptSessionKey}:${String(id)}`
      : `${transcriptSessionKey}:${item?.kind || "row"}-${index}`;
  }, [transcriptSessionKey, virtualTranscriptItemAt]);
  const completionAnimationKeyByItem = useMemo(() => {
    const keys = new Map<TranscriptItem, string>();
    settledItems.forEach((item, index) => {
      if (item?.kind !== "statusdone" && item?.kind !== "turndone") return;
      const id = item.id;
      keys.set(item, id !== undefined && id !== null
        ? `${transcriptSessionKey}:${String(id)}`
        : `${transcriptSessionKey}:${item.kind}:${index}`);
    });
    return keys;
  }, [settledItems, transcriptSessionKey]);
  const currentCompletionAnimationKeys = useMemo(
    () => new Set(completionAnimationKeyByItem.values()),
    [completionAnimationKeyByItem],
  );
  const transcriptHydrated = settledItems.length > 0;
  // Animate only completions that ARRIVE while this session's transcript is
  // already hydrated on screen. The baseline is a per-session UNION of every
  // completion key ever committed, not the previous frame: pane focus swaps
  // the snapshot source (live route ↔ session lane) whose item sets can lag
  // each other, and a per-frame diff replayed the enter-pop on historical
  // "Reasoned for …" / compaction labels on every focus change (user report).
  // A key seen once never animates again; only genuinely new completions pop.
  const seenCompletionFrame = useRef({
    sessionKey: transcriptSessionKey,
    hydrated: transcriptHydrated,
    keys: new Set(currentCompletionAnimationKeys),
  });
  const freshCompletionAnimationKeys = seenCompletionFrame.current.sessionKey === transcriptSessionKey
    && seenCompletionFrame.current.hydrated
    ? new Set([...currentCompletionAnimationKeys]
      .filter((key) => !seenCompletionFrame.current.keys.has(key)))
    : new Set<string>();
  useLayoutEffect(() => {
    const seen = seenCompletionFrame.current;
    if (seen.sessionKey !== transcriptSessionKey) {
      seenCompletionFrame.current = {
        sessionKey: transcriptSessionKey,
        hydrated: transcriptHydrated,
        keys: new Set(currentCompletionAnimationKeys),
      };
      return;
    }
    // Union + latched hydration: a transient empty frame during a source swap
    // must not re-arm animation for keys that already rendered.
    seen.hydrated = seen.hydrated || transcriptHydrated;
    currentCompletionAnimationKeys.forEach((key) => seen.keys.add(key));
  }, [currentCompletionAnimationKeys, transcriptSessionKey, transcriptHydrated]);
  const rememberTranscriptLayoutWidth = useCallback((width: number) => {
    if (Number.isFinite(width) && width > 0) {
      transcriptLayoutWidth.current = Math.round(width);
    }
  }, []);
  useLayoutEffect(() => {
    const element = virtualContent.current || content.current;
    if (element) rememberTranscriptLayoutWidth(element.clientWidth);
  }, [rememberTranscriptLayoutWidth, transcriptSessionKey, virtualizingTranscript]);
  const transcriptMeasurementState = useRef({
    itemAt: virtualTranscriptItemAt,
    sessionKey: transcriptSessionKey,
  });
  transcriptMeasurementState.current = {
    itemAt: virtualTranscriptItemAt,
    sessionKey: transcriptSessionKey,
  };
  const measureTranscriptElement = useCallback((
    element: Element,
    entry?: ResizeObserverEntry,
  ) => {
    const index = Number((element as HTMLElement).dataset.index);
    const measurement = transcriptMeasurementState.current;
    const measuredSessionKey = (element as HTMLElement).dataset.measureSessionKey;
    // ResizeObserver can deliver an outgoing session's detached row after the
    // stable Conversation owner has already switched its virtualizer options.
    // Never let that old DOM height populate the new session's index/key.
    if (measuredSessionKey && measuredSessionKey !== measurement.sessionKey) {
      return Math.max(1, Math.round(estimatedTranscriptRowHeight(
        Number.isInteger(index) ? measurement.itemAt(index) : undefined,
        {
          sessionKey: measurement.sessionKey,
          width: transcriptLayoutWidth.current,
        },
      )));
    }
    const borderBox = entry?.borderBoxSize?.[0];
    let measuredWidth = Number(borderBox?.inlineSize);
    let measuredBlockSize = Number(borderBox?.blockSize);
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0
      || !Number.isFinite(measuredBlockSize) || measuredBlockSize <= 0) {
      const rect = element.getBoundingClientRect();
      measuredWidth = rect.width;
      measuredBlockSize = rect.height;
    }
    // jsdom has no layout boxes even when a fixture supplies offsetHeight.
    // Falling back only for a zero box prevents the virtualizer from
    // collapsing every row to 1px and synchronously walking the full corpus.
    if ((!Number.isFinite(measuredBlockSize) || measuredBlockSize <= 0)
      && element instanceof HTMLElement) {
      measuredBlockSize = element.offsetHeight;
    }
    rememberTranscriptLayoutWidth(measuredWidth);
    const measuredHeight = Math.max(
      1,
      Math.round(measuredBlockSize),
    );
    if (element instanceof HTMLElement
      && !element.classList.contains("transcript-virtual-row--empty")
      && !element.querySelector('.tool-card[data-open="true"]')) {
      if (Number.isInteger(index)) {
        rememberMeasuredTranscriptRowHeight(measurement.itemAt(index), measuredHeight, {
          sessionKey: measurement.sessionKey,
          width: transcriptLayoutWidth.current,
        });
      }
    }
    return measuredHeight;
  }, [rememberTranscriptLayoutWidth]);
  const transcriptVirtualizer = useVirtualizer({
    count: virtualizingTranscript ? virtualItemCount : 0,
    enabled: virtualizingTranscript,
    getScrollElement: () => viewport.current,
    // TanStack cannot retain an end range when the newly appended completion
    // placeholder is exactly 0px. One invisible measurement pixel preserves
    // the stable item-key map without contributing visible row spacing.
    estimateSize: (index) => transcriptItemHidden(index)
      ? 1
      : estimatedTranscriptRowHeight(virtualTranscriptItemAt(index), {
          sessionKey: transcriptSessionKey,
          width: transcriptLayoutWidth.current,
        }),
    getItemKey: transcriptItemKey,
    // Persist every ResizeObserver measurement, not only the ref's mount
    // measurement. Markdown settlement and responsive reflow can change a row
    // later; re-entry estimates must retain the final geometry for this exact
    // session and reading width. Expanded tool cards are local UI state and
    // intentionally never poison the collapsed re-entry estimate.
    measureElement: measureTranscriptElement,
    // Fixed for the lifetime of the mounted session: no delayed idle task may
    // mutate transcript geometry after entry.
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    initialRect: { width: 800, height: 800 },
    // Explicit history restores still route through the virtualizer. Grow the
    // spacer before those writes so Chrome cannot clamp the requested offset
    // against the previous total height. Ongoing bottom-follow is owned only
    // by the aggregate content ResizeObserver below.
    scrollToFn: (offset, options, instance) => {
      if (virtualContent.current) {
        virtualContent.current.style.height = `${instance.getTotalSize()}px`;
      }
      elementScroll(offset, options, instance);
    },
    // Upward-wheel judder fix: when a row ABOVE the viewport measures larger
    // than its estimate, compensate scrollTop by the delta so the visible
    // content does not snap back while scrolling up. Rows below the viewport
    // never need compensation.
    // While following, one content ResizeObserver owns the bottom position.
    // Off-bottom reading retains virtualizer compensation for rows measured
    // above the viewport.
  });
  // The vendored virtual-core consults this predicate as an INSTANCE property
  // (resizeItem reads `this.shouldAdjustScrollPositionOnItemSizeChange`), NOT
  // an option — passing it through useVirtualizer options silently left the
  // library default active, whose "first measurement always compensates"
  // branch fired a counter-write per mounted row DURING upward wheeling
  // (CDP-measured −100..−470px reversals per tick; user: 스크롤 잔상/튐).
  // Anchor compensation now runs only between gestures, above the viewport,
  // outside toggle holds and width reflows, and never while following.
  (transcriptVirtualizer as unknown as {
    shouldAdjustScrollPositionOnItemSizeChange?: (
      item: { start: number; end: number },
      delta: number,
      instance: { getScrollOffset(): number },
    ) => boolean;
  }).shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    restoredTranscriptSessionKey.current === transcriptSessionKey
    && shouldCompensateTranscriptRowMeasurement({
      end: item.end,
      scrollOffset: instance.getScrollOffset(),
      now: performance.now(),
      toggleHoldUntil: toggleHoldUntil.current,
      scrollIntentUntil: scrollIntentUntil.current,
      pointerScrollIntent: pointerScrollIntent.current,
      widthReflowing: widthReflowing.current,
      following: followOutput.current,
    });
  const transcriptVirtualSize = transcriptVirtualizer.getTotalSize();
  const transcriptVirtualizerRef = useRef(transcriptVirtualizer);
  transcriptVirtualizerRef.current = transcriptVirtualizer;
  const measureTranscriptRow = useCallback((element: Element | null) => {
    transcriptVirtualizerRef.current.measureElement(element);
  }, []);
  const scrollToBottom = useCallback((
    element: HTMLDivElement,
    behavior: ScrollBehavior = "auto",
  ) => {
    if (!followOutput.current) return;
    driveScrollToBottom(element, behavior);
  }, [driveScrollToBottom]);
  const scheduleStickyBottom = useCallback((
    element: HTMLDivElement,
  ) => {
    if (!followOutput.current) return;
    if (performance.now() < toggleHoldUntil.current) return;
    followContentGrowth(element);
  }, [followContentGrowth]);
  const captureScrollPosition = useCallback((
    element: HTMLDivElement,
    atEnd: boolean,
  ): SessionScrollPosition => {
    const position: SessionScrollPosition = {
      top: element.scrollTop,
      atEnd,
      layoutWidth: transcriptLayoutWidth.current,
    };
    if (atEnd || !virtualizingTranscript) return position;
    const anchor = transcriptVirtualizer.getVirtualItems()
      .find((item) => item.end > element.scrollTop + 1);
    if (!anchor) return position;
    position.anchorKey = String(anchor.key);
    position.anchorIndex = anchor.index;
    position.anchorOffset = anchor.start - element.scrollTop;
    return position;
  }, [transcriptVirtualizer, virtualizingTranscript]);
  const restoreScrollPosition = useCallback((
    element: HTMLDivElement,
    saved: SessionScrollPosition | undefined,
  ): boolean => {
    if (!saved || saved.atEnd) {
      // A session-scoped cold placeholder has no geometry to pin. Waiting for
      // the hydration batch avoids one raw empty-scroll write followed by a
      // second virtualizer target when the transcript arrives.
      if (itemCount === 0) return false;
      if (virtualizingTranscript) {
        const offset = transcriptVirtualizer.getOffsetForIndex(itemCount - 1, "end");
        if (!offset) return false;
        markProgrammaticScroll();
        transcriptVirtualizer.scrollToOffset(offset[0], { behavior: "auto" });
        return true;
      }
      writeViewportBottom(element);
      return true;
    }
    if (!virtualizingTranscript) {
      if (itemCount === 0 && saved.top > 0) return false;
      markProgrammaticScroll();
      element.scrollTo({ top: saved.top, behavior: "auto" });
      return true;
    }
    if (itemCount === 0) return false;
    const sameLayoutWidth = Number.isFinite(saved.layoutWidth)
      && Math.abs(Number(saved.layoutWidth) - transcriptLayoutWidth.current) <= 1;
    if (sameLayoutWidth) {
      markProgrammaticScroll();
      transcriptVirtualizer.scrollToOffset(saved.top, { behavior: "auto" });
      return true;
    }
    let anchorIndex = Number.isInteger(saved.anchorIndex) ? Number(saved.anchorIndex) : -1;
    if (saved.anchorKey && (anchorIndex < 0
      || anchorIndex >= itemCount
      || String(transcriptItemKey(anchorIndex)) !== saved.anchorKey)) {
      anchorIndex = -1;
      for (let index = 0; index < itemCount; index += 1) {
        if (String(transcriptItemKey(index)) === saved.anchorKey) {
          anchorIndex = index;
          break;
        }
      }
    }
    if (anchorIndex >= 0 && Number.isFinite(saved.anchorOffset)) {
      const offset = transcriptVirtualizer.getOffsetForIndex(anchorIndex, "start");
      if (!offset) return false;
      markProgrammaticScroll();
      transcriptVirtualizer.scrollToOffset(
        Math.max(0, offset[0] - Number(saved.anchorOffset)),
        { behavior: "auto" },
      );
      return true;
    }
    markProgrammaticScroll();
    transcriptVirtualizer.scrollToOffset(saved.top, { behavior: "auto" });
    return true;
  }, [
    itemCount,
    markProgrammaticScroll,
    transcriptItemKey,
    transcriptVirtualizer,
    virtualizingTranscript,
    writeViewportBottom,
  ]);
  const captureScrollPositionRef = useRef(captureScrollPosition);
  captureScrollPositionRef.current = captureScrollPosition;
  const restoreScrollPositionRef = useRef(restoreScrollPosition);
  restoreScrollPositionRef.current = restoreScrollPosition;
  const jumpToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    resumeFollow();
    const element = viewport.current;
    if (!element) return;
    scrollToBottom(element, behavior);
  }, [resumeFollow, scrollToBottom]);
  // The virtualizer object changes with streamed geometry. Route the latest
  // jump implementation through a ref so Composer's submit callback retains
  // identity and a 20 Hz transcript stream cannot re-render the typing tree.
  const jumpToLatestRef = useRef(jumpToLatest);
  jumpToLatestRef.current = jumpToLatest;
  const composerSubmit = useCallback(async (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => {
    const submittedAt = Number(options?.submittedAt);
    const trackedSubmittedAt = Number.isFinite(submittedAt) && submittedAt > 0
      ? submittedAt
      : Date.now();
    const submissionId = String(options?.id || "").trim() || nextDesktopSubmissionId();
    const images = pendingPromptImages(options);
    const optimistic: PendingPromptItem = {
      id: submissionId,
      kind: "user",
      text: desktopPromptDisplayText(content, options),
      pending: true,
      accepted: false,
      submittedAt: trackedSubmittedAt,
      queuedBehindTurn: queuedBehindTurnAtSubmit.current,
      ...(images.length ? { images } : {}),
    };
    setOptimisticPrompts((current) => [
      ...current.filter((item) => item.id !== submissionId),
      optimistic,
    ]);
    window.mixdogDesktop?.perfLog?.(`prompt-submit phase=renderer-queued id=${submissionId}`);
    jumpToLatestRef.current("auto");
    const acceptedStartedAt = performance.now();
    let accepted: unknown;
    try {
      accepted = await composerActions.current.invokeResult(
        () => composerActions.current.submit(content, {
          ...options,
          id: submissionId,
          submittedAt: trackedSubmittedAt,
        }),
      );
    } finally {
      // The RPC boundary is the end of renderer ownership, whether accepted,
      // rejected, or thrown. The host transcript/queue is authoritative from
      // here and may intentionally use a different durable message id.
      setOptimisticPrompts((current) =>
        current.filter((item) => String(item.id) !== submissionId));
    }
    window.mixdogDesktop?.perfLog?.(
      `prompt-submit phase=renderer-host-ack id=${submissionId}`
      + ` accepted=${accepted === true ? 1 : 0}`
      + ` wait=${(performance.now() - acceptedStartedAt).toFixed(0)}ms`,
    );
    if (accepted === true) {
      // Sending a prompt is an explicit return-to-live intent: force the
      // bottom pin instead of only re-arming the follow flag. A stale saved
      // scroll state or an attached-surface bulk transcript refresh could
      // otherwise leave the view parked mid-transcript with the
      // "Jump to latest" chip showing right after the user submits.
      jumpToLatestRef.current("auto");
    }
    return accepted;
  }, []);
  const composerAbort = useCallback(
    () => composerActions.current.invokeResult(() => window.mixdogDesktop.abort()),
    [],
  );
  const composerInvokeResult = useCallback(
    <T,>(action: () => T | Promise<T>) => composerActions.current.invokeResult(action),
    [],
  );
  const composerApplySnapshot = useCallback(
    (next: EngineSnapshot | null) => composerActions.current.applySnapshot(next),
    [],
  );
  const composerOnNewTask = useCallback(() => composerActions.current.onNewTask(), []);
  const composerOnResumeSession = useCallback((id: string) => composerActions.current.onResumeSession(id), []);
  const composerOnOpenSessions = useCallback(() => composerActions.current.onOpenSessions(), []);
  const composerOnOpenSettings = useCallback(
    (section?: SettingsSection | null) => composerActions.current.onOpenSettings(section),
    [],
  );
  const composerOnOpenCommandSurface = useCallback(
    (surface: CommandSurfaceName) => composerActions.current.onOpenCommandSurface(surface),
    [],
  );

  useLayoutEffect(() => {
    if (restoredTranscriptSessionKey.current === transcriptSessionKey) return;
    const element = viewport.current;
    if (!element) return;
    const saved = sessionScrollPositions.current.get(transcriptSessionKey);
    const atEnd = saved?.atEnd ?? true;
    if (atEnd) resumeFollow();
    else takeScrollUserControl();
    if (restoreScrollPosition(element, saved)) {
      restoredTranscriptSessionKey.current = transcriptSessionKey;
    }
  }, [itemCount, restoreScrollPosition, transcriptSessionKey]);
  useLayoutEffect(() => {
    if (!transitioning) return;
    const element = viewport.current;
    if (!element) return;
    // When the session key changed in this same commit, the restore effect
    // above has already repositioned the viewport (programmatic marker still
    // armed). Saving now would record that mid-restore offset under the NEW
    // session's key and poison its next visit (user: a fresh chat starts
    // unpinned with the jump chip visible).
    if (programmaticScroll.current) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    rememberSessionScrollPosition(
      sessionScrollPositions.current,
      transcriptSessionKey,
      captureScrollPosition(element, atEnd),
    );
  }, [transitioning, transcriptSessionKey]);
  // The ONE ongoing bottom-follow authority for Markdown, tools, approvals,
  // virtual spacer measurements, and composer/viewport growth. The virtualizer
  // only compensates history rows while the user is reading off-bottom.
  useEffect(() => {
    const element = viewport.current;
    const contentElement = content.current;
    if (!element || !contentElement || typeof ResizeObserver === "undefined") return undefined;
    const restoredItemCount = currentItemCount.current;
    let initialDelivery = true;
    let observedViewportWidth = element.clientWidth;
    let observedViewportHeight = element.clientHeight;
    let widthSettleFrame = 0;
    let widthSettlePending = false;
    let stableWidthFrames = 0;
    let widthCheckpointFrames = 0;
    let lastCheckpointWidth = 0;
    let settledWidth = observedViewportWidth;
    let settledVirtualSize = transcriptVirtualizerRef.current.getTotalSize();
    let reflowPosition: SessionScrollPosition | null = null;
    let reflowFollowAfterSettle: boolean | null = null;
    // Entry-settle shield (user: 전환해서 다시 보일 때 스크립트가 튐): right
    // after re-entering a tab, the lane reconcile or a virtualizer re-measure
    // can shrink the content for one frame. The browser then clamps scrollTop,
    // paints a wrong offset, and the pin writes it back a frame later — a
    // visible flash. Hold the entry height as a min-height and release it the
    // moment geometry proves settled — content growing past the entry height
    // (shield moot) or three consecutive stable frames (no wall-clock wait) —
    // so a genuine shrink settles ONCE under the follow/restore authority.
    let entryHoldFrame = 0;
    const heldEntryHeight = contentElement.offsetHeight;
    if (heldEntryHeight > 0) {
      contentElement.style.minHeight = `${heldEntryHeight}px`;
      let entryQuietFrames = 0;
      let entryLastSize = transcriptVirtualizerRef.current.getTotalSize();
      const releaseEntryHold = () => {
        entryHoldFrame = 0;
        contentElement.style.minHeight = "";
        if (followOutput.current && currentItemCount.current > 0) {
          writeViewportBottom(element);
        }
      };
      const entryTick = () => {
        const size = transcriptVirtualizerRef.current.getTotalSize();
        if (contentElement.offsetHeight > heldEntryHeight + 1) {
          releaseEntryHold();
          return;
        }
        if (size === entryLastSize) entryQuietFrames += 1;
        else {
          entryQuietFrames = 0;
          entryLastSize = size;
        }
        if (entryQuietFrames >= 3) {
          releaseEntryHold();
          return;
        }
        entryHoldFrame = window.requestAnimationFrame(entryTick);
      };
      entryHoldFrame = window.requestAnimationFrame(entryTick);
    }
    // Panel toggles animate the pane over ~180ms, which used to re-wrap every
    // transcript row at each intermediate width — the script visibly shook
    // like an afterimage (user: 레이아웃 시프트 때 스크립트가 잔상남듯 튐).
    // Freeze the thread at its current pixel width for the whole shift, so
    // rows keep their wrap (vertical geometry untouched, scrollTop stable)
    // and exactly ONE re-wrap runs at settle, under the scroll restore that
    // already owns that moment.
    let frozenContentWidth: number | null = null;
    const freezeContentWidth = () => {
      if (frozenContentWidth !== null) return;
      const width = contentElement.offsetWidth;
      if (!(width > 0)) return;
      frozenContentWidth = width;
      contentElement.style.width = `${width}px`;
    };
    const unfreezeContentWidth = (): boolean => {
      if (frozenContentWidth === null) return false;
      frozenContentWidth = null;
      contentElement.style.width = "";
      return true;
    };
    const releaseWidthReflow = () => {
      widthSettleFrame = 0;
      if (widthSettlePending) {
        settleWidthReflow();
        return;
      }
      widthReflowing.current = false;
      delete element.dataset.widthReflow;
      if (reflowFollowAfterSettle !== null) {
        resolveScrollSuspension("reflow", reflowFollowAfterSettle);
        reflowFollowAfterSettle = null;
      }
    };
    const settleWidthReflow = () => {
      widthSettleFrame = 0;
      if (!widthSettlePending) return;
      const nextWidth = element.clientWidth;
      const nextVirtualSize = transcriptVirtualizerRef.current.getTotalSize();
      if (nextWidth !== settledWidth || Math.abs(nextVirtualSize - settledVirtualSize) >= 1) {
        settledWidth = nextWidth;
        settledVirtualSize = nextVirtualSize;
        stableWidthFrames = 0;
      } else {
        stableWidthFrames += 1;
      }
      // Native window drags can deliver resize steps 30–60ms apart under GPU
      // load. Two quiet frames falsely split one drag into several settles;
      // four consecutive stable frames keep the whole OS gesture atomic.
      if (stableWidthFrames < 4) {
        // Incremental anchored rewrap (user: 쉬프트가 한 번에 크게 튐): a long
        // drag used to hold ONE frozen wrap until fully quiet and then pay the
        // entire re-wrap as a single full-viewport pop at settle. Rebase the
        // frozen width every ~4 frames of an ongoing gesture instead — each
        // step re-wraps within one task (no intermediate paint) and restores
        // its scroll target (bottom pin or anchor) immediately, so the gesture
        // reads as a near-continuous anchored follow, never one giant jump.
        widthCheckpointFrames += 1;
        if (frozenContentWidth !== null && widthCheckpointFrames >= 4
          && Math.abs(element.clientWidth - lastCheckpointWidth) >= 8) {
          widthCheckpointFrames = 0;
          lastCheckpointWidth = element.clientWidth;
          const position = captureScrollPositionRef.current(element, followOutput.current);
          unfreezeContentWidth();
          // Force the re-wrap layout at the new width before re-freezing.
          void contentElement.offsetWidth;
          freezeContentWidth();
          if (position.atEnd) {
            if (currentItemCount.current > 0) writeViewportBottom(element);
          } else {
            restoreScrollPositionRef.current(element, position);
          }
          settledVirtualSize = transcriptVirtualizerRef.current.getTotalSize();
        }
        widthSettleFrame = window.requestAnimationFrame(settleWidthReflow);
        return;
      }
      // The pane geometry is quiet — release the frozen wrap now and let the
      // single final re-wrap's measurements re-stabilize before restoring.
      if (unfreezeContentWidth()) {
        stableWidthFrames = 0;
        settledVirtualSize = transcriptVirtualizerRef.current.getTotalSize();
        widthSettleFrame = window.requestAnimationFrame(settleWidthReflow);
        return;
      }
      widthSettlePending = false;
      const settledPosition = reflowPosition || {
        top: element.scrollTop,
        atEnd: followOutput.current,
        layoutWidth: transcriptLayoutWidth.current,
      };
      reflowFollowAfterSettle = settledPosition.atEnd;
      if (settledPosition.atEnd) {
        if (currentItemCount.current > 0) writeViewportBottom(element);
      }
      else restoreScrollPositionRef.current(element, settledPosition);
      reflowPosition = null;
      // Keep both competing authorities disabled through the restore frame:
      // its newly mounted virtual rows may synchronously deliver one last
      // measurement, which must not add another raw bottom write.
      widthSettleFrame = window.requestAnimationFrame(releaseWidthReflow);
    };
    const beginWidthReflow = () => {
      if (!widthSettlePending) {
        const wasFollowing = followOutput.current;
        reflowPosition = captureScrollPositionRef.current(element, wasFollowing);
        suspendScroll("reflow");
        freezeContentWidth();
        // VS Code part-toggle grammar (user: 레이아웃 쉬프트 때 스크립트가
        // 튐): the thread has ALREADY re-wrapped at the delivered width in
        // this same frame, and ResizeObserver runs before paint. Restore the
        // scroll target (bottom pin or reading anchor) NOW so the first
        // painted frame of the shift is correct, instead of painting an
        // off-target offset for the whole multi-frame settle window and then
        // snapping once at the end. The settle loop below still owns drag
        // gestures and the final post-unfreeze restore.
        if (reflowPosition.atEnd) {
          if (currentItemCount.current > 0) writeViewportBottom(element);
        } else {
          restoreScrollPositionRef.current(element, reflowPosition);
        }
      }
      widthSettlePending = true;
      widthReflowing.current = true;
      element.dataset.widthReflow = "true";
      freezeContentWidth();
      stableWidthFrames = 0;
      widthCheckpointFrames = 0;
      lastCheckpointWidth = element.clientWidth;
      settledWidth = element.clientWidth;
      settledVirtualSize = transcriptVirtualizerRef.current.getTotalSize();
      if (widthSettleFrame) window.cancelAnimationFrame(widthSettleFrame);
      widthSettleFrame = window.requestAnimationFrame(settleWidthReflow);
    };
    // Content measurements remain virtualizer-owned. A viewport-only resize
    // (review/composer growth, mobile keyboard) uses the already-updated DOM
    // clientHeight so it cannot lag TanStack's separate rect observer.
    const observer = new ResizeObserver(() => {
      const viewportWidthChanged = element.clientWidth !== observedViewportWidth;
      const viewportHeightChanged = element.clientHeight !== observedViewportHeight;
      observedViewportWidth = element.clientWidth;
      observedViewportHeight = element.clientHeight;
      if (initialDelivery) {
        initialDelivery = false;
        // Session-key restore already positioned this exact transcript before
        // paint. Ignore ResizeObserver's mandatory initial delivery so entry
        // cannot add a second visible scroll write. If hydration changed the
        // item count or viewport height first, it is real growth and still
        // needs a pin.
        if (currentItemCount.current === restoredItemCount
          && !viewportWidthChanged && !viewportHeightChanged) return;
      }
      if (viewportWidthChanged) {
        beginWidthReflow();
        return;
      }
      if (widthReflowing.current) return;
      scheduleStickyBottom(element);
    });
    // Aggregate geometry includes both the virtual spacer and the detached
    // live suffix. Observing this one box avoids child render callbacks racing
    // virtualizer measurements.
    observer.observe(contentElement);
    // The scroll container itself resizes when the phone keyboard opens
    // (mobile-shell pins the layout to the visual viewport): while following,
    // the last row must ride up with the keyboard and settle back down when
    // it closes. Off-bottom readers are untouched (scheduleStickyBottom
    // no-ops without follow).
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (widthSettleFrame) window.cancelAnimationFrame(widthSettleFrame);
      if (entryHoldFrame) window.cancelAnimationFrame(entryHoldFrame);
      contentElement.style.minHeight = "";
      unfreezeContentWidth();
      widthReflowing.current = false;
      delete element.dataset.widthReflow;
    };
  }, [
    resolveScrollSuspension,
    scheduleStickyBottom,
    suspendScroll,
    transcriptSessionKey,
    writeViewportBottom,
  ]);
  const virtualRows = virtualizingTranscript ? transcriptVirtualizer.getVirtualItems() : [];
  const disclosureScope = String(routeSnapshot.sessionId || "new-task");
  const activeRetainedRows = virtualRows
    .flatMap((virtualRow): RetainedTranscriptMarkdownRow[] => {
      const item = virtualTranscriptItemAt(virtualRow.index);
      if (!isRetainableTranscriptMarkdownRow(item)) return [];
      return [{
        key: String(virtualRow.key),
        index: virtualRow.index,
        item: item!,
        completion: completionByAssistant.get(virtualRow.index),
        attachedUser: false,
        disclosureScope,
      }];
    })
    .slice(-TRANSCRIPT_MARKDOWN_DOM_LRU_LIMIT);
  // One bounded pool belongs to the persistent pane Conversation, not to its
  // currently selected tab. Parking a session behind New Task must keep its
  // parsed script DOM alive; otherwise returning to the tab remounts and
  // remeasures the same large Markdown/code subtree for one visible frame.
  const retainedMarkdownState = useRef<readonly RetainedTranscriptMarkdownRow[]>([]);
  const retainedMarkdownRows = refreshRetainedTranscriptMarkdownRows(
    retainedMarkdownState.current,
    activeRetainedRows,
  );
  // Populate the pane-local pool in the same render that exposes an active
  // row. Persisting it from a layout effect leaves a race where New Task can
  // commit first and render an empty pool, disconnecting the script subtree.
  retainedMarkdownState.current = retainedMarkdownRows;
  const activeRetainedKeys = new Set(activeRetainedRows.map((row) => row.key));
  const activeVirtualRowsByKey = new Map(
    virtualRows.map((virtualRow) => [String(virtualRow.key), virtualRow]),
  );

  const renderTranscriptItem = (
    item: TranscriptItem,
    index: number,
  ) => {
    const turnKey = turnKeyAt(index);
    const completion = item.kind === "statusdone" || item.kind === "turndone";
    // Session retry: resubmit the failed turn's original
    // user prompt through the normal composer submit path.
    const retryTurn = () => {
      for (let cursor = 0; cursor < itemCount; cursor += 1) {
        const candidate = transcriptItemAt(cursor);
        if (turnKeyAt(cursor) !== turnKey || candidate?.kind !== "user") continue;
        const text = String(candidate.text ?? "").trim();
        if (text) void composerSubmit(text);
        return;
      }
    };
    const retryDisabled = Boolean(snapshot.busy) || transitioning;
    const retryButton = readOnly ? null : <button type="button" className="turn-retry" disabled={retryDisabled}
      onClick={retryTurn} aria-label="Retry failed turn">
    <MxIcon name="reset" size={12} />Retry
    </button>;
    if (failedTurns.has(turnKey) && completion) {
      if (index !== lastCompletionByTurn.get(turnKey)) return null;
      return <div className="turn-status failed" role="status"
        key={`failed-${turnKey}`}>
        <X className="turn-status-icon" size={15} aria-hidden="true" />
        <span>Failed</span>
        {retryButton}
      </div>;
    }
    if (attachedCompletionIndexes.has(index)) return null;
    const attachedCompletion = completionByAssistant.get(index);
    const animatedCompletion = completion ? item : attachedCompletion;
    const completionAnimate = animatedCompletion
      ? freshCompletionAnimationKeys.has(completionAnimationKeyByItem.get(animatedCompletion) || "")
      : false;
    const row = <TranscriptRow item={item} completion={attachedCompletion}
      completionAnimate={completionAnimate}
      disclosureScope={String(routeSnapshot.sessionId || "new-task")}
      attachedUser={item.kind === "user" && transcriptItemAt(index - 1)?.kind === "user"}
      key={transcriptItemKey(index)} />;
    const lastItemIndex = tailAppended && tailTurnKey === turnKey
      ? liveItemCount - 1
      : lastItemByTurn.get(turnKey);
    const pendingFailure = failedTurns.has(turnKey) &&
      !lastCompletionByTurn.has(turnKey) &&
      lastItemIndex === index;
    if (!pendingFailure) return row;
    return <React.Fragment key={`pending-${turnKey}`}>
      {row}
      <div className="turn-status failed" role="status"><X size={13} />Failed{retryButton}</div>
    </React.Fragment>;
  };

  return (
    <section className={`conversation${readOnly ? " conversation-read-only" : ""}`} ref={conversation}>
      <div className="transcript-shell">
      <div className="transcript" ref={viewport} role="log" aria-label="Conversation transcript"
        data-session-key={transcriptSessionKey}
        data-following={following ? "true" : "false"}
        data-virtualized={virtualizingTranscript ? "true" : "false"}
        aria-live="polite" aria-relevant="additions" aria-atomic="false"
        aria-busy={Boolean(snapshot.busy || snapshot.commandBusy)} tabIndex={0}
        onScroll={(event) => {
        const currentFollowing = followOutput.current;
        const owner = scrollOwnerRef.current;
        const acceptsIntent = owner === "follow" || owner === "user";
        const explicitScrollIntent = pointerScrollIntent.current
          || performance.now() <= scrollIntentUntil.current;
        const distanceFromBottom = event.currentTarget.scrollHeight
          - event.currentTarget.scrollTop - event.currentTarget.clientHeight;
        const previousScrollTop = lastObservedScrollTop.current;
        const currentScrollTop = event.currentTarget.scrollTop;
        lastObservedScrollTop.current = currentScrollTop;
        const movedUp = currentScrollTop < previousScrollTop - 0.5;
        const movedDown = currentScrollTop > previousScrollTop + 0.5;
        const atTrueEnd = event.currentTarget.scrollHeight <= event.currentTarget.clientHeight + 1
          || distanceFromBottom <= 1;
        if (explicitScrollIntent && !programmaticScroll.current) {
          if (movedUp) bottomReturnIntent.current = false;
          else if (movedDown) bottomReturnIntent.current = true;
        }
        // Content-driven layout movement never cancels following. Only an
        // explicit user gesture can leave the bottom; reaching it resumes.
        const nextFollowing = acceptsIntent
          ? owner === "user"
            ? atTrueEnd && bottomReturnIntent.current
            : movedUp && explicitScrollIntent && !programmaticScroll.current
              ? false
              : currentFollowing
          : currentFollowing;
        if (nextFollowing !== currentFollowing) {
          if (nextFollowing) {
            bottomReturnIntent.current = false;
            resumeFollow();
          } else {
            bottomReturnIntent.current = false;
            takeScrollUserControl();
          }
        }
        if (!programmaticScroll.current) {
          rememberSessionScrollPosition(
            sessionScrollPositions.current,
            transcriptSessionKey,
            captureScrollPosition(event.currentTarget, acceptsIntent ? nextFollowing : following),
          );
        }
      }} onClickCapture={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target || typeof target.closest !== "function") return;
        if (!target.closest(".tool-header")) return;
        // Match ordinary streamed growth: while pinned, a disclosure resize
        // stays under the aggregate ResizeObserver and is bottom-locked before
        // paint. Suspending here made the new height look like user scroll and
        // permanently released follow.
        if (followOutput.current) {
          toggleSequence.current += 1;
          toggleHoldUntil.current = 0;
          return;
        }
        // Off-bottom readers get a short, silent anchor hold so the clicked
        // card stays in place. This path never resumes follow on its own.
        const wasFollowing = suspendScroll("toggle");
        // The tail row is BOTTOM-anchored, so its own growth moves the header
        // up by the row it added even while pinned. Hold every bottom pin for
        // the correction window so the card can stay exactly where it was
        // clicked (user: 어떤 경우에도 튀지 않아야 함).
        toggleHoldUntil.current = performance.now() + 400;
        // During the hold the virtualizer's own size correction is disabled,
        // so this is the single scroll authority for the disclosure change.
        const card = target.closest(".tool-card") as HTMLElement | null;
        const anchorTop = card ? card.getBoundingClientRect().top : 0;
        const sequence = ++toggleSequence.current;
        const correctOnce = () => {
          if (sequence !== toggleSequence.current) return;
          if (!viewport.current) return;
          if (card?.isConnected) {
            const delta = card.getBoundingClientRect().top - anchorTop;
            if (delta !== 0) {
              writeScrollDelta(viewport.current, delta);
            }
          }
          window.requestAnimationFrame(() => {
            if (sequence !== toggleSequence.current) return;
            // Single reconciliation after the corrected layout settles.
            const scroller = viewport.current;
            if (!scroller) return;
            resolveScrollSuspension("toggle", wasFollowing);
          });
        };
        window.requestAnimationFrame(correctOnce);
      }} onWheel={(event) => {
          markScrollUserInput();
          lastObservedScrollTop.current = event.currentTarget.scrollTop;
          // An upward wheel is an explicit read-back intent: break follow
          // IMMEDIATELY. Waiting for the 80px shouldAutoFollow threshold let
          // the pre-paint pin yank the view back to bottom between the first
          // small wheel ticks (user: first scroll rattles and barely moves).
          // Only when there is actually something to scroll back through — an
          // overflow-free view (empty New task) must never disarm follow
          // (user: "Jump to latest" appeared on a blank conversation).
          if (event.deltaY < 0) {
            if (wheelConsumedByNestedScroller(
              event.target, event.currentTarget, event.deltaY,
            )) return;
            scrollIntentUntil.current = performance.now() + 180;
            bottomReturnIntent.current = false;
            const scrollable = event.currentTarget.scrollHeight
              > event.currentTarget.clientHeight + 1;
            if (followOutput.current && scrollable) {
              takeScrollUserControl();
            }
          } else if (event.deltaY > 0) {
            if (wheelConsumedByNestedScroller(
              event.target, event.currentTarget, event.deltaY,
            )) return;
            // A downward wheel never arms the scroll-intent window: while
            // pinned, a virtualizer re-measure can clamp scrollTop inside that
            // window and the clamp's upward movement was mis-read as a user
            // gesture releasing follow. Bottom-return is tracked directly.
            bottomReturnIntent.current = true;
          }
        }}
        onPointerDown={(event) => {
          markScrollUserInput();
          const element = event.currentTarget;
          lastObservedScrollTop.current = element.scrollTop;
          bottomReturnIntent.current = false;
          const rect = element.getBoundingClientRect();
          const scrollbarWidth = Math.max(0, element.offsetWidth - element.clientWidth);
          // A plain click inside an unfocused pane only changes pane focus.
          // Treating every pointerdown as scroll intent let the lane→live
          // layout correction disarm bottom-follow and persist a one-line-up
          // offset. Only an actual scrollbar hit or pointer drag owns scroll.
          pointerScrollIntent.current = scrollbarWidth > 0
            && event.clientX >= rect.right - scrollbarWidth;
          pointerScrollStart.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }}
        onPointerMove={(event) => {
          const start = pointerScrollStart.current;
          if (!start || start.pointerId !== event.pointerId || (event.buttons & 1) === 0) return;
          if (Math.abs(event.clientX - start.x) >= 3 || Math.abs(event.clientY - start.y) >= 3) {
            pointerScrollIntent.current = true;
            markScrollUserInput();
            scrollIntentUntil.current = performance.now() + 240;
          }
        }}
        onPointerUp={() => {
          const hadPointerScrollIntent = pointerScrollIntent.current;
          pointerScrollIntent.current = false;
          pointerScrollStart.current = null;
          // A plain click (including a tool disclosure toggle) must not arm
          // scroll intent: its layout-driven scroll event would otherwise look
          // like an upward user gesture and intermittently release follow.
          scrollIntentUntil.current = hadPointerScrollIntent
            ? performance.now() + 240
            : 0;
        }}
        onPointerCancel={() => {
          const hadPointerScrollIntent = pointerScrollIntent.current;
          pointerScrollIntent.current = false;
          pointerScrollStart.current = null;
          scrollIntentUntil.current = hadPointerScrollIntent
            ? performance.now() + 240
            : 0;
        }}
        onTouchStart={() => {
          markScrollUserInput();
          if (viewport.current) lastObservedScrollTop.current = viewport.current.scrollTop;
          bottomReturnIntent.current = false;
          scrollIntentUntil.current = performance.now() + 240;
        }}
        onTouchMove={() => {
          markScrollUserInput();
          scrollIntentUntil.current = performance.now() + 240;
        }}
        onTouchEnd={() => {
          scrollIntentUntil.current = performance.now() + 320;
        }}
        onTouchCancel={() => {
          scrollIntentUntil.current = performance.now() + 320;
        }}
        onKeyDown={(event) => {
          if (isScrollIntentKey(event.key)) {
            markScrollUserInput();
            lastObservedScrollTop.current = event.currentTarget.scrollTop;
            if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") {
              // Only upward keys arm the intent window (same clamp guard as
              // the wheel handler above).
              scrollIntentUntil.current = performance.now() + 180;
              bottomReturnIntent.current = false;
              if (followOutput.current) takeScrollUserControl();
            } else {
              // ArrowDown / PageDown / End / Space page toward the bottom.
              bottomReturnIntent.current = true;
            }
          }
        }}>
        <div className="thread" ref={content}>
          {/* An EMPTY draft carries ONLY the centered brand watermark (user:
              VS Code grammar — shortcuts live solely on the fully empty
              workspace; secondary surfaces keep the quiet letterpress).
              Sessions and transitions never show it. */}
          {(((draftMode || (!routeSnapshot.sessionId && Boolean(activeProjectPath)))
            && itemCount === 0 && pendingPromptItems.length === 0
            && !streamingTail && !transitioning) || warmPaintHandoff) && (
            <div className={`thread-welcome thread-welcome-task${warmPaintHandoff
              ? " thread-welcome-paint-handoff" : ""}`} aria-hidden="true">
              <span className="welcome-logo"><BrandTile crop /></span>
            </div>
          )}
          {/* Keep this layer mounted even while New Task or a short transcript
              is active. Cross-session retained rows stay hidden/inert at zero
              height, then reuse the same DOM when their tab returns. */}
          <div className="transcript-virtual-space"
            data-virtualized={virtualizingTranscript ? "true" : "false"}
            ref={virtualContent}
            style={{ height: virtualizingTranscript ? `${transcriptVirtualSize}px` : "0px" }}>
            {virtualizingTranscript && virtualRows.map((virtualRow) => {
              if (activeRetainedKeys.has(String(virtualRow.key))) return null;
              const tailRow = !detachedStreamingTail
                && virtualRow.index === lastVisibleTranscriptIndex;
              return <div className={`transcript-virtual-row ${transcriptItemHidden(virtualRow.index)
                ? "transcript-virtual-row--empty" : ""} ${tailRow
                ? "transcript-virtual-row--tail" : ""}`} key={virtualRow.key}
                data-index={virtualRow.index}
                data-measure-session-key={transcriptSessionKey}
                ref={measureTranscriptRow}
                // The tail row anchors to the spacer BOTTOM instead of a
                // translateY start: streamed text commits one frame before the
                // virtualizer measures it, and a top-anchored tail painted that
                // frame overflowing past the spacer (bottom line bouncing
                // up/down while entering a streaming session). Bottom-anchored,
                // the newest line stays glued to the pinned bottom and the
                // one-frame slack moves to the row's top edge instead.
                style={tailRow ? { top: "auto", bottom: 0 }
                  : { transform: `translateY(${virtualRow.start}px)` }}>
                {renderTranscriptItem(virtualTranscriptItemAt(virtualRow.index)!, virtualRow.index)}
              </div>;
            })}
            {retainedMarkdownRows.map((retainedRow) => {
              const virtualRow = activeVirtualRowsByKey.get(retainedRow.key);
              const active = Boolean(virtualRow);
              const index = virtualRow?.index ?? retainedRow.index;
              const tailRow = active && !detachedStreamingTail
                && index === lastVisibleTranscriptIndex;
              return <div className={`transcript-virtual-row transcript-virtual-row--retained ${tailRow
                ? "transcript-virtual-row--tail" : ""}`} key={retainedRow.key}
                data-index={index}
                data-measure-session-key={transcriptSessionKey}
                data-retained={active ? "active" : "hidden"}
                inert={active ? undefined : true}
                aria-hidden={active ? undefined : true}
                ref={active ? measureTranscriptRow : undefined}
                style={!virtualRow ? undefined : tailRow
                  ? { top: "auto", bottom: 0 }
                  : { transform: `translateY(${virtualRow.start}px)` }}>
                <TranscriptRow item={retainedRow.item}
                  completion={active
                    ? completionByAssistant.get(index)
                    : retainedRow.completion}
                  completionAnimate={active && Boolean(retainedRow.completion)
                    ? freshCompletionAnimationKeys.has(
                        completionAnimationKeyByItem.get(retainedRow.completion!) || "")
                    : false}
                  disclosureScope={retainedRow.disclosureScope}
                  attachedUser={retainedRow.attachedUser} />
              </div>;
            })}
          </div>
          {!virtualizingTranscript && <>
            {settledItems.map((item, index) => detachedStreamingTail && index === tailSettledIndex
              ? null
              : renderTranscriptItem(
                  index === tailSettledIndex && streamingTail ? streamingTail : item,
                  index,
                ))}
            {!detachedStreamingTail && tailAppended && streamingTail
              ? renderTranscriptItem(streamingTail, liveItemCount - 1)
              : null}
            {!detachedStreamingTail && pendingPromptItems.map((item, index) => renderTranscriptItem(
              item,
              liveItemCount + index,
            ))}
          </>}
          {detachedStreamingTail && streamingTail
            ? streamingTailSlot
              ? streamingTailSlot
              : <div className="transcript-live-tail" data-streaming-tail="true"
                  data-index={tailAppended ? settledItems.length : tailSettledIndex}>
                {renderTranscriptItem(
                  streamingTail,
                  tailAppended ? settledItems.length : tailSettledIndex,
                )}
              </div>
            : null}
          {detachedStreamingTail && pendingPromptItems.map((item, index) =>
            renderTranscriptItem(item, liveItemCount + index))}
          {/* Fixed-height activity slot: during entry/source swaps the busy
              band's spinner state can flicker null for one frame; unmounting
              the 24px band shifted the whole thread and the follow write
              chased it a frame late (user: 진입/전환 시 스크립트가 튐). While
              the turn is busy the slot keeps the band's box reserved; it only
              truly collapses when the turn ends. */}
          <div className="live-activity-slot"
            data-busy={Boolean(snapshot.busy || snapshot.commandBusy) || Boolean(streamingTail)
              ? "true" : undefined}>
            <LiveActivity snapshot={snapshot}
              optimisticStartedAt={optimisticActivityStartedAt} />
          </div>
          {!readOnly && snapshot.toolApproval && (
            <ApprovalCard key={approvalInstanceKey(snapshot.toolApproval.id)}
              approval={snapshot.toolApproval}
              resolve={(approved) => window.mixdogDesktop.resolveToolApproval(
                String(snapshot.toolApproval?.id || ""), { approved },
              )} />
          )}
        </div>
      </div>
      {!following && itemCount > 0 && <button type="button" className="jump-to-latest" onClick={() => jumpToLatest()}
        aria-label="Jump to latest message">
        <ArrowDown size={14} />Jump to latest
      </button>}
      </div>
      {!readOnly && <div className="composer-region">
        {Boolean(asRecord(snapshot.progressHint)?.text) && <div className="runtime-progress" role="status">
          {String(asRecord(snapshot.progressHint)?.text)}
        </div>}
        {showProjectSelector && <div className="composer-context-bar">
          <ProjectContextSelector projects={projects}
            activePath={activeProjectPath} activeLabel={activeProjectLabel}
            disabled={transitioning || Boolean(snapshot.busy)}
            onClear={onNewTask} onSelect={onSelectProject} onChoose={onChooseProject} />
          <WorkflowSelect workflow={(draftWorkflow || routeSnapshot.workflow as RecordValue | null) ?? null}
            disabled={transitioning || (!draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy))}
            invokeResult={composerInvokeResult} applySnapshot={composerApplySnapshot}
            onDraftChange={onDraftWorkflow} />
        </div>}
        {/* Absolute background-activity overlay aligns with the transcript's
            final 20px thinking/tool status band without consuming layout. */}
        {liveWork}
        <InlineErrors messages={errors} />
        {/* Review is part of the bottom stack: a late worker result grows this
            region upward, while the transcript ResizeObserver retains its
            followed bottom. It never overlays transcript or thinking rows. */}
        <div className="turn-review-slot">
        <TurnReviewBar items={settledItems}
          sessionId={String(snapshot.sessionId || "")}
          cwd={String(snapshot.currentProject || snapshot.project || snapshot.cwd || "")} />
        </div>
        <Composer
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={!draftMode && Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          focusRequest={composerFocusRequest}
          historyScope={draftMode ? `new-task:${activeProjectPath || 'local'}`
            : String(routeSnapshot.sessionId || routeSnapshot.currentProject ||
              routeSnapshot.project || routeSnapshot.cwd || 'new-task')}
          projectScope={draftMode ? activeProjectPath
            : String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '')}
          hasConversation={itemCount > 0
            || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0)}
          promptHistoryList={routeSnapshot.promptHistoryList}
          provider={String(draftModelSelection?.provider || routeSnapshot.provider || "")}
          model={String(draftModelSelection?.model || routeSnapshot.model || "")}
          effort={String(draftModelSelection?.effort ?? routeSnapshot.effort ?? "")}
          fast={draftModelSelection?.fast ?? Boolean(routeSnapshot.fast)}
          fastCapable={Boolean(routeSnapshot.fastCapable)}
          draftMode={draftMode}
          onDraftModelSelection={onDraftModelSelection}
          queued={snapshot.queued}
          hiddenQueueIds={pendingPromptIds}
          submit={composerSubmit}
          abort={composerAbort}
          invokeResult={composerInvokeResult}
          applySnapshot={composerApplySnapshot}
          onNewTask={composerOnNewTask}
          onResumeSession={composerOnResumeSession}
          onOpenSessions={composerOnOpenSessions}
          onOpenSettings={composerOnOpenSettings}
          onOpenCommandSurface={composerOnOpenCommandSurface}
          dropTargetRef={conversation} />
      </div>}
    </section>
  );
}
