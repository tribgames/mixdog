import React, {
  Component,
  lazy,
  Suspense,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  FileDiff,
  Folder,
  GitCompare,
  Layers3,
  LoaderCircle,
  Mic,
  ArrowUp,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MxIcon } from "./MxIcon";
import { ContextBody } from "./ContextBody";
import { createPortal } from "react-dom";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  DesktopUpdaterState,
  EngineSnapshot,
} from "../shared/contract";
import {
  approvalInstanceKey,
  draftAfterSubmission,
  followAfterScroll,
  isApprovalDismissKey,
  isScrollIntentKey,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldNavigatePromptHistory,
  toolInputRows,
  transcriptTurnKeys,
} from "./renderer-logic.mjs";
import type { TurnFailureModel } from "./renderer-logic.mjs";
import {
  DesktopTitlebar,
  ProjectSwitcher,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceTab,
} from "./navigation";
import {
  applyDesktopTheme,
  applyDesktopThemePreference,
  clearDesktopThemePreference,
  getDesktopThemePreference,
} from "./desktop-theme";
import { resolveContextUsage } from "./context-usage";
import { OpenSelect } from "./OpenSelect";
import { ModelPicker } from "./ModelPicker";
import { modelDisplayName } from "./provider-display";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { TooltipLayer } from "./TooltipLayer";
import { acquireModalLayer } from "./modal-layer";
import {
  SLASH_COMMANDS,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection,
} from "./slash-commands";
import { promptTitle, sessionSummaryTitle } from "../shared/session-title.mjs";
// The desktop transcript deliberately consumes the same semantic tool labels,
// categories, and result summaries as the terminal UI. Keeping this import at
// the shared formatter boundary prevents the renderer from inventing a second
// (and inevitably divergent) tool vocabulary.
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatAggregateHeader, formatToolSurface, summarizeToolResult } from "../../../../src/runtime/shared/tool-surface.mjs";

import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { LiveWorkStatus, ContextUsageIndicator, LiveActivity, TextShimmer, CompletionStatus, completionTone, CopyControl, MarkdownResponse, preloadMarkdownBody, transcriptItemSignature, messageMetadata, TranscriptRow, ToolCard, DiffBoundary, CodeDiff, findPatch, toolIcon, toolResultText, isHookApprovalDenialToolItem, shouldSuppressFullyFailedToolItem, boundedTextOf } from "./TranscriptView";
import { ApprovalCard } from "./ApprovalCard";
import { TurnReviewBar } from "./TurnReview";
import { UtilityDock, type UtilityDockTab, clampDockWidth, readDockState, DOCK_STATE_KEY } from "./UtilityDock";
import { ReviewPane } from "./ReviewPane";
import { InlineErrors } from "./notifications";
import { Composer, ProjectContextSelector, PROJECT_CONTEXT_LOCAL, PROJECT_CONTEXT_OPEN, WorkflowSelect, ModelSelector, queuedFollowupPreview, readPromptHistory, promptHistoryStorageKey } from "./Composer";


export const STARTERS = [
  { icon: <Layers3 size={15} />, label: "Plan a feature", prompt: "Help me plan a new feature for this project." },
  { icon: <Code2 size={15} />, label: "Explain the code", prompt: "Explain how this codebase is structured." },
  { icon: <Sparkles size={15} />, label: "Fix a bug", prompt: "Find a meaningful bug in this project and propose a fix." },
  { icon: <Check size={15} />, label: "Improve tests", prompt: "Review this project's tests and suggest the highest-value improvements." },
];

export function Conversation({
  snapshot,
  routeSnapshot,
  invoke,
  invokeResult,
  errors,
  submit,
  applySnapshot,
  transitioning,
  composerFocusRequest,
  onNewTask,
  onStartProject,
  onResumeSession,
  onOpenProjects,
  onOpenSessions,
  onOpenSettings,
  projects,
  showProjectSelector,
  activeProjectPath,
  activeProjectLabel,
  onSelectProject,
  onChooseProject,
  onOpenCommandSurface,
}: {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  invoke: (action: () => unknown) => Promise<void>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  onStartProject: (path: string) => void;
  onResumeSession: (id: string) => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  onChooseProject: () => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const virtualContent = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const programmaticScroll = useRef(false);
  const pointerScrollIntent = useRef(false);
  const scrollIntentUntil = useRef(0);
  const scrollTimer = useRef<number | undefined>(undefined);
  const stickyBottomFrame = useRef<number | undefined>(undefined);
  const stickyBottomBehavior = useRef<ScrollBehavior>("auto");
  const sessionScrollPositions = useRef(new Map<string, { top: number; atEnd: boolean }>());
  const [starter, setStarter] = useState<{ id: number; text: string } | null>(null);
  const [following, setFollowing] = useState(true);
  const composerActions = useRef({
    submit, invokeResult, applySnapshot, onNewTask, onStartProject, onResumeSession,
    onOpenProjects, onOpenSessions, onOpenSettings, onOpenCommandSurface,
  });
  composerActions.current = {
    submit, invokeResult, applySnapshot, onNewTask, onStartProject, onResumeSession,
    onOpenProjects, onOpenSessions, onOpenSettings, onOpenCommandSurface,
  };
  const settledItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  const items = useMemo(
    () => mergeTranscript(settledItems, snapshot.streamingTail),
    [settledItems, snapshot.streamingTail],
  );
  const transcriptSessionKey = String(routeSnapshot.sessionId || 'new-task');
  const virtualizingTranscript = items.length > TRANSCRIPT_VIRTUALIZE_THRESHOLD;
  // Perf probe (MIXDOG_DESKTOP_PERF=1): main-process resume+first paint measure
  // fast (60-250ms) while the user still reports multi-second lag — capture the
  // POST-paint renderer story: main-thread long tasks and the transcript's
  // measure/commit settle window after a session switch.
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return undefined;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 100) {
            window.mixdogDesktop?.perfLog?.(`renderer-longtask ms=${Math.round(entry.duration)}`);
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch { return undefined; }
  }, []);
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
  const tailAppended = Boolean(snapshot.streamingTail) && items.length === settledItems.length + 1;
  const tailTurnKey = useMemo(() => {
    if (!tailAppended) return "";
    const previous = settledItems.at(-1);
    if (previous?.kind !== "turndone" && settledTurnKeys.length > 0) {
      return settledTurnKeys.at(-1) || "";
    }
    return transcriptTurnKeys([items.at(-1)])[0] || "";
  }, [items, settledItems, settledTurnKeys, tailAppended]);
  const turnKeyAt = useCallback((index: number) => (
    index < settledTurnKeys.length ? settledTurnKeys[index] : tailTurnKey
  ), [settledTurnKeys, tailTurnKey]);
  const transcriptItemHidden = (index: number) => {
    if (attachedCompletionIndexes.has(index)) return true;
    const item = items[index];
    const completion = item?.kind === "statusdone" || item?.kind === "turndone";
    const turnKey = turnKeyAt(index);
    return Boolean(completion && failedTurns.has(turnKey) && index !== lastCompletionByTurn.get(turnKey));
  };
  const lastVisibleTranscriptIndex = lastVisibleTranscriptItemIndex(
    items.length,
    transcriptItemHidden,
  );
  // Row identity must survive index shifts: the streaming tail's index moves
  // every time a settled row lands above it, and an index-suffixed key made
  // the virtualizer drop that row's measured size on every append — the tail
  // then repainted at its ESTIMATE height until re-measure (user: rows bounce
  // up/down inside a still-streaming session). Index remains only as the
  // fallback identity for id-less rows.
  const transcriptItemKey = useCallback((index: number) => {
    const id = items[index]?.id;
    return id !== undefined && id !== null
      ? `${transcriptSessionKey}:${String(id)}`
      : `${transcriptSessionKey}:${items[index]?.kind || "row"}-${index}`;
  }, [items, transcriptSessionKey]);
  const transcriptVirtualizer = useVirtualizer({
    count: virtualizingTranscript ? items.length : 0,
    enabled: virtualizingTranscript,
    getScrollElement: () => viewport.current,
    // TanStack cannot retain an end range when the newly appended completion
    // placeholder is exactly 0px. One invisible measurement pixel preserves
    // the stable item-key map without contributing visible row spacing.
    estimateSize: (index) => transcriptItemHidden(index)
      ? 1
      : estimatedTranscriptRowHeight(items[index]),
    getItemKey: transcriptItemKey,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    initialRect: { width: 800, height: 800 },
    // The virtualizer is the only bottom-scroll authority. Grow the spacer
    // before it writes scrollTop so Chrome cannot clamp an end-anchor
    // correction against the previous height, then let the virtualizer retain
    // the end across appends and streaming row measurements.
    scrollToFn: (offset, options, instance) => {
      if (virtualContent.current) {
        virtualContent.current.style.height = `${instance.getTotalSize()}px`;
      }
      elementScroll(offset, options, instance);
    },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    // Upward-wheel judder fix: when a row ABOVE the viewport measures larger
    // than its estimate, compensate scrollTop by the delta so the visible
    // content does not snap back while scrolling up. Rows below the viewport
    // never need compensation.
    // While following, one content ResizeObserver owns the bottom position.
    // Off-bottom reading retains virtualizer compensation for rows measured
    // above the viewport.
    // @ts-expect-error virtual-core 3.14 supports this option; the react
    // adapter's PartialKeys type has not caught up.
    shouldAdjustScrollPositionOnItemSizeChange: (
      item: { start: number },
      _delta: number,
      instance: { scrollOffset: number | null },
    ) => !followOutput.current && item.start < (instance.scrollOffset ?? 0),
  });
  const transcriptVirtualSize = transcriptVirtualizer.getTotalSize();
  const scrollToBottom = useCallback((
    element: HTMLDivElement,
    behavior: ScrollBehavior = "auto",
  ) => {
    if (!followOutput.current) return;
    programmaticScroll.current = true;
    // One authority per mode: the virtualizer owns virtual geometry and the
    // browser owns the short, non-virtual transcript.
    if (virtualizingTranscript) {
      transcriptVirtualizer.scrollToEnd({ behavior });
    } else {
      element.scrollTo({ top: element.scrollHeight, behavior });
    }
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      programmaticScroll.current = false;
    }, behavior === "smooth" ? 500 : 80);
  }, [transcriptVirtualizer, virtualizingTranscript]);
  const scheduleStickyBottom = useCallback((
    element: HTMLDivElement,
    behavior: ScrollBehavior = "auto",
  ) => {
    if (!followOutput.current) return;
    // Pre-paint pin: deferring the "auto" pin to the next animation frame let
    // every row measurement during a session open paint one UNPINNED frame
    // before the correction landed (user: transcript shakes up/down while
    // loading). ResizeObserver callbacks and layout effects both run before
    // paint, so an immediate pin anchors the bottom within the same frame. A
    // pending smooth glide keeps ownership of the scroll position.
    if (behavior === "auto") {
      if (stickyBottomFrame.current === undefined) scrollToBottom(element, "auto");
      return;
    }
    stickyBottomBehavior.current = behavior;
    if (stickyBottomFrame.current !== undefined) return;
    stickyBottomFrame.current = window.requestAnimationFrame(() => {
      stickyBottomFrame.current = undefined;
      const pendingBehavior = stickyBottomBehavior.current;
      stickyBottomBehavior.current = "auto";
      scrollToBottom(element, pendingBehavior);
    });
  }, [scrollToBottom]);
  const jumpToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    followOutput.current = true;
    setFollowing(true);
    const element = viewport.current;
    if (!element) return;
    scheduleStickyBottom(element, behavior);
  }, [scheduleStickyBottom]);
  const composerSubmit = useCallback(async (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => {
    const accepted = await composerActions.current.invokeResult(
      () => composerActions.current.submit(content, options),
    );
    if (accepted === true) {
      // Sending a prompt is an explicit return-to-live intent: force the
      // bottom pin instead of only re-arming the follow flag. A stale saved
      // scroll state or an attached-surface bulk transcript refresh could
      // otherwise leave the view parked mid-transcript with the
      // "Jump to latest" chip showing right after the user submits.
      jumpToLatest("auto");
    }
    return accepted;
  }, [jumpToLatest]);
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
  const composerOnStartProject = useCallback((path: string) => composerActions.current.onStartProject(path), []);
  const composerOnResumeSession = useCallback((id: string) => composerActions.current.onResumeSession(id), []);
  const composerOnOpenProjects = useCallback(() => composerActions.current.onOpenProjects(), []);
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
    const element = viewport.current;
    if (!element) return;
    const saved = sessionScrollPositions.current.get(transcriptSessionKey);
    const atEnd = saved?.atEnd ?? true;
    followOutput.current = atEnd;
    setFollowing(atEnd);
    programmaticScroll.current = true;
    if (saved && !saved.atEnd) {
      if (virtualizingTranscript) transcriptVirtualizer.scrollToOffset(saved.top, { behavior: 'auto' });
      else element.scrollTo({ top: saved.top, behavior: 'auto' });
    } else {
      scheduleStickyBottom(element);
    }
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
    return undefined;
  }, [transcriptSessionKey]);
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
    sessionScrollPositions.current.set(transcriptSessionKey, {
      top: element.scrollTop,
      atEnd: element.scrollHeight - element.scrollTop - element.clientHeight < 48,
    });
  }, [transitioning, transcriptSessionKey]);
  useEffect(() => () => {
    window.clearTimeout(scrollTimer.current);
    if (stickyBottomFrame.current !== undefined) {
      window.cancelAnimationFrame(stickyBottomFrame.current);
    }
  }, []);
  // One scroll authority for streaming Markdown, tools, approvals, and queue
  // growth. Resize bursts coalesce to one frame; explicit upward input disarms
  // following before the next observer callback.
  useEffect(() => {
    const element = viewport.current;
    const contentElement = content.current;
    if (!element || !contentElement || typeof ResizeObserver === "undefined") return undefined;
    // The observer schedules follow, but virtualized writes still flow through
    // transcriptVirtualizer.scrollToEnd — there is no competing raw DOM
    // scroll authority.
    const observer = new ResizeObserver(() => scheduleStickyBottom(element));
    observer.observe(contentElement);
    // The scroll container itself resizes when the phone keyboard opens
    // (mobile-shell pins the layout to the visual viewport): while following,
    // the last row must ride up with the keyboard and settle back down when
    // it closes. Off-bottom readers are untouched (scheduleStickyBottom
    // no-ops without follow).
    observer.observe(element);
    return () => observer.disconnect();
  }, [scheduleStickyBottom, transcriptSessionKey]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== "undefined") return;
    const element = viewport.current;
    if (element) scheduleStickyBottom(element);
  }, [items.length, scheduleStickyBottom, snapshot.streamingTail?.text]);

  const renderTranscriptItem = (item: TranscriptItem, index: number) => {
    const turnKey = turnKeyAt(index);
    const completion = item.kind === "statusdone" || item.kind === "turndone";
    // Session retry: resubmit the failed turn's original
    // user prompt through the normal composer submit path.
    const retryTurn = () => {
      for (let cursor = 0; cursor < items.length; cursor += 1) {
        if (turnKeyAt(cursor) !== turnKey || items[cursor]?.kind !== "user") continue;
        const text = String(items[cursor]?.text ?? "").trim();
        if (text) void composerSubmit(text);
        return;
      }
    };
    const retryDisabled = Boolean(snapshot.busy) || transitioning;
    const retryButton = <button type="button" className="turn-retry" disabled={retryDisabled}
      onClick={retryTurn} aria-label="Retry failed turn">
    <MxIcon name="reset" size={12} />Retry
    </button>;
    if (failedTurns.has(turnKey) && completion) {
      if (index !== lastCompletionByTurn.get(turnKey)) return null;
      return <div className="turn-status failed" role="status"
        key={`failed-${turnKey}`}>
        <X size={13} />Failed
        {retryButton}
      </div>;
    }
    if (attachedCompletionIndexes.has(index)) return null;
    const row = <TranscriptRow item={item} completion={completionByAssistant.get(index)}
      attachedUser={item.kind === "user" && items[index - 1]?.kind === "user"}
      key={`${String(routeSnapshot.sessionId || "new-task")}:${String(item.id ?? `${item.kind}-${index}`)}`} />;
    const lastItemIndex = tailAppended && tailTurnKey === turnKey
      ? items.length - 1
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
    <section className="conversation">
      <div className="transcript-shell">
      <div className="transcript" ref={viewport} role="log" aria-label="Conversation transcript"
        aria-live="polite" aria-relevant="additions" aria-atomic="false"
        aria-busy={Boolean(snapshot.busy || snapshot.commandBusy)} tabIndex={0}
        onScroll={(event) => {
        const currentFollowing = followOutput.current;
        const explicitScrollIntent = pointerScrollIntent.current
          || performance.now() <= scrollIntentUntil.current;
        // Virtualizer measurement correction can emit a native scroll well
        // after the 80ms programmatic marker expires. While already following,
        // only explicit wheel/key/drag intent may disarm it; an unexplained
        // layout scroll is repinned immediately in the same event.
        const passiveLayoutScroll = currentFollowing
          && !programmaticScroll.current
          && !explicitScrollIntent;
        const nextFollowing = passiveLayoutScroll
          ? true
          : followAfterScroll(
              currentFollowing,
              programmaticScroll.current,
              event.currentTarget,
            );
        if (passiveLayoutScroll
          && event.currentTarget.scrollHeight - event.currentTarget.scrollTop
            - event.currentTarget.clientHeight > 1) {
          scheduleStickyBottom(event.currentTarget);
        }
        if (nextFollowing !== currentFollowing) {
          followOutput.current = nextFollowing;
          setFollowing(nextFollowing);
        }
        sessionScrollPositions.current.set(transcriptSessionKey, {
          top: event.currentTarget.scrollTop,
          atEnd: nextFollowing,
        });
      }} onClickCapture={(event) => {
        // Toggling a tool card is a reading intent: the resize it causes must
        // not re-pin the transcript bottom (user: the whole script lurched
        // with ghosting on collapse/expand). Mirrors the upward-wheel disarm,
        // including its no-overflow guard so an unscrollable view keeps
        // follow armed (no orphaned "Jump to latest" chip).
        const target = event.target as HTMLElement | null;
        if (!target || typeof target.closest !== "function") return;
        if (!target.closest(".tool-header")) return;
        const element = event.currentTarget;
        const scrollable = element.scrollHeight > element.clientHeight + 1;
        if (scrollable && followOutput.current) {
          followOutput.current = false;
          setFollowing(false);
        }
      }} onWheel={(event) => {
          programmaticScroll.current = false;
          scrollIntentUntil.current = performance.now() + 180;
          // An upward wheel is an explicit read-back intent: break follow
          // IMMEDIATELY. Waiting for the 80px shouldAutoFollow threshold let
          // the pre-paint pin yank the view back to bottom between the first
          // small wheel ticks (user: first scroll rattles and barely moves).
          // Only when there is actually something to scroll back through — an
          // overflow-free view (empty New task) must never disarm follow
          // (user: "Jump to latest" appeared on a blank conversation).
          const scrollable = event.currentTarget.scrollHeight
            > event.currentTarget.clientHeight + 1;
          if (event.deltaY < 0 && followOutput.current && scrollable) {
            followOutput.current = false;
            setFollowing(false);
          }
        }}
        onPointerDown={() => {
          programmaticScroll.current = false;
          pointerScrollIntent.current = true;
        }}
        onPointerUp={() => { pointerScrollIntent.current = false; }}
        onPointerCancel={() => { pointerScrollIntent.current = false; }}
        onTouchStart={() => {
          programmaticScroll.current = false;
          scrollIntentUntil.current = performance.now() + 240;
        }}
        onKeyDown={(event) => {
          if (isScrollIntentKey(event.key)) {
            programmaticScroll.current = false;
            scrollIntentUntil.current = performance.now() + 180;
            if ((event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home")
              && followOutput.current) {
              followOutput.current = false;
              setFollowing(false);
            }
          }
        }}>
        <div className="thread" ref={content}>
          {items.length === 0 && !snapshot.busy && !snapshot.commandBusy && !snapshot.thinking
            && !snapshot.spinner && !snapshot.commandStatus && !snapshot.toolApproval && (
            <div className="thread-welcome">
              <span className="welcome-wordmark" aria-hidden="true">mixdog</span>
              <h1 className="sr-only">What can Mixdog help you build?</h1>
              <p>Describe what you would like Mixdog to help with.</p>
              <div className="starter-grid" aria-label="Starter actions">
                {STARTERS.map((action) => (
                  <button key={action.label} onClick={() => setStarter({ id: Date.now(), text: action.prompt })}>
                    {action.icon}<span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {virtualizingTranscript ? <div className="transcript-virtual-space" data-virtualized="true"
            ref={virtualContent} style={{ height: `${transcriptVirtualSize}px` }}>
            {transcriptVirtualizer.getVirtualItems().map((virtualRow) => {
              const tailRow = virtualRow.index === lastVisibleTranscriptIndex;
              return <div className={`transcript-virtual-row ${transcriptItemHidden(virtualRow.index)
                ? "transcript-virtual-row--empty" : ""} ${tailRow
                ? "transcript-virtual-row--tail" : ""}`} key={virtualRow.key}
                data-index={virtualRow.index}
                ref={transcriptVirtualizer.measureElement}
                // The tail row anchors to the spacer BOTTOM instead of a
                // translateY start: streamed text commits one frame before the
                // virtualizer measures it, and a top-anchored tail painted that
                // frame overflowing past the spacer (bottom line bouncing
                // up/down while entering a streaming session). Bottom-anchored,
                // the newest line stays glued to the pinned bottom and the
                // one-frame slack moves to the row's top edge instead.
                style={tailRow ? { top: "auto", bottom: 0 }
                  : { transform: `translateY(${virtualRow.start}px)` }}>
                {renderTranscriptItem(items[virtualRow.index], virtualRow.index)}
              </div>;
            })}
          </div> : items.map(renderTranscriptItem)}
          <LiveActivity snapshot={snapshot} />
          {snapshot.toolApproval && (
            <ApprovalCard key={approvalInstanceKey(snapshot.toolApproval.id)}
              approval={snapshot.toolApproval}
              resolve={(approved) => window.mixdogDesktop.resolveToolApproval(
                String(snapshot.toolApproval?.id || ""), { approved },
              )} />
          )}
        </div>
      </div>
      {!following && items.length > 0 && <button type="button" className="jump-to-latest" onClick={() => jumpToLatest()}
        aria-label="Jump to latest message">
        <ArrowDown size={14} />Jump to latest
      </button>}
      </div>
      <div className="composer-region">
        {Boolean(asRecord(snapshot.progressHint)?.text) && <div className="runtime-progress" role="status">
          {String(asRecord(snapshot.progressHint)?.text)}
        </div>}
        {showProjectSelector && <ProjectContextSelector projects={projects}
          activePath={activeProjectPath} activeLabel={activeProjectLabel}
          disabled={transitioning || Boolean(snapshot.busy)}
          onClear={onNewTask} onSelect={onSelectProject} onChoose={onChooseProject} />}
        <InlineErrors messages={errors} />
        <TurnReviewBar items={items}
          cwd={String(snapshot.currentProject || snapshot.project || snapshot.cwd || "")} />
        <Composer
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          focusRequest={composerFocusRequest}
          historyScope={String(routeSnapshot.sessionId || routeSnapshot.currentProject ||
            routeSnapshot.project || routeSnapshot.cwd || 'new-task')}
          projectScope={String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '')}
          hasConversation={items.length > 0}
          hasProjectContext={Boolean(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd)}
          promptHistoryList={routeSnapshot.promptHistoryList}
          provider={String(routeSnapshot.provider || "")}
          model={String(routeSnapshot.model || "")}
          effort={String(routeSnapshot.effort || "")}
          fast={Boolean(routeSnapshot.fast)}
          fastCapable={Boolean(routeSnapshot.fastCapable)}
          workflow={(routeSnapshot.workflow as RecordValue | null) ?? null}
          starter={starter}
          queued={snapshot.queued}
          submit={composerSubmit}
          abort={composerAbort}
          invokeResult={composerInvokeResult}
          applySnapshot={composerApplySnapshot}
          onNewTask={composerOnNewTask}
          onStartProject={composerOnStartProject}
          onResumeSession={composerOnResumeSession}
          onOpenProjects={composerOnOpenProjects}
          onOpenSessions={composerOnOpenSessions}
          onOpenSettings={composerOnOpenSettings}
          onOpenCommandSurface={composerOnOpenCommandSurface} />
      </div>
    </section>
  );
}
