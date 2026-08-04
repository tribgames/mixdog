import {
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
import { t } from "./i18n";
import { MxIcon } from "./MxIcon";
import {
  approvalInstanceKey,
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
import { TranscriptList } from "./TranscriptList";
import {
  isCompletionTranscriptItem,
  projectTranscriptRows,
  turnPromptText,
  type TranscriptRowModel,
} from "./transcript-rows";
import { LiveActivity, resetToolDisclosureScope, TranscriptRow } from "./TranscriptView";
import { TurnReviewBar } from "./TurnReview";
import { useTranscriptFollow } from "./use-transcript-follow";


export type PendingPromptItem = TranscriptItem & {
  id: string | number;
  kind: "user";
  text: string;
  pending: boolean;
  accepted: boolean;
  submittedAt: number;
  queuedBehindTurn?: boolean;
  queueAcknowledged?: boolean;
};

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
  }).filter(Boolean).join("\n").trim() || t("Attached prompt");
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
  queued: unknown[] = [],
): PendingPromptItem[] {
  const settledIds = new Set(settled
    .map((item) => item?.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String));
  const queuedIds = new Set(queued
    .map((item) => asRecord(item)?.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String));
  const byId = new Map<string, PendingPromptItem>();
  for (const item of optimistic) {
    if (item?.id === undefined || item.id === null || !String(item.text || "").trim()) continue;
    byId.set(String(item.id), item);
  }
  return [...byId.entries()]
    .filter(([id]) => !settledIds.has(id))
    // A queued follow-up stays in the transcript across host acknowledgement:
    // moving it into the composer queue changed both boxes at once and visibly
    // kicked every script row. Once the observed queue entry drains, the
    // authoritative user transcript takes over (even if the runtime normalized
    // its durable id). Idle submits still release on acknowledgement.
    .filter(([id, item]) => item.accepted !== true
      || queuedIds.has(id)
      || (item.queuedBehindTurn === true && item.queueAcknowledged !== true))
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
  const scrollToEndRef = useRef<(behavior?: ScrollBehavior) => void>(() => {});
  // React port of OpenCode's createAutoScroll + message-gesture split.
  const {
    following,
    showJump,
    handleScroll: handleTranscriptScroll,
    handleWheel: handleTranscriptWheel,
    handlePointerDown: handleTranscriptPointerDown,
    handlePointerMove: handleTranscriptPointerMove,
    handleTouchStart: handleTranscriptTouchStart,
    handleTouchMove: handleTranscriptTouchMove,
    handleTouchEnd: handleTranscriptTouchEnd,
    handleInteraction: handleTranscriptInteraction,
    handleKeyDown: handleTranscriptKeyDown,
    resume: resumeFollow,
  } = useTranscriptFollow({
    viewport,
    content,
    sessionKey: draftMode
      ? "new-task"
      : String(routeSnapshot.sessionId || "new-task"),
  });
  const [optimisticPrompts, setOptimisticPrompts] = useState<PendingPromptItem[]>([]);
  // A first submit already replaced the blank watermark with its optimistic
  // user row. Re-applying the watermark during draft -> session promotion
  // flashes one full-pane frame; ordinary New task -> warm session navigation
  // still uses the compositor handoff.
  const suppressDraftSubmitPaintHandoff = useRef(false);
  const draftModeRef = useRef(draftMode);
  draftModeRef.current = draftMode;
  // Draft-only composer context bar: when the surface promotes to a session
  // the bar collapses over ~140ms (CSS) before unmounting, instead of
  // vanishing in one frame and dropping the composer 34px.
  const [contextBarPhase, setContextBarPhase] = useState<"open" | "collapsing" | "closed">(
    showProjectSelector ? "open" : "closed",
  );
  useEffect(() => {
    if (showProjectSelector) {
      setContextBarPhase("open");
      return undefined;
    }
    // Only this pane's OWN draft->session promotion earns the soft collapse —
    // ordinary session renders and tab switches must drop the bar instantly
    // (session chrome asserts its absence).
    if (!suppressDraftSubmitPaintHandoff.current) {
      setContextBarPhase("closed");
      return undefined;
    }
    setContextBarPhase((current) => current === "open" ? "collapsing" : current);
    const timer = window.setTimeout(() => setContextBarPhase("closed"), 180);
    return () => window.clearTimeout(timer);
  }, [showProjectSelector]);
  // Pane-local engine addressing: abort and tool approvals always target the
  // session THIS surface renders, never the globally active route.
  const routeSessionIdRef = useRef("");
  routeSessionIdRef.current = String(routeSnapshot.sessionId || "");
  const visibleWarmPaintHandoff = warmPaintHandoff
    && !suppressDraftSubmitPaintHandoff.current;
  useEffect(() => {
    if (!draftMode && !warmPaintHandoff) {
      suppressDraftSubmitPaintHandoff.current = false;
    }
  }, [draftMode, warmPaintHandoff]);
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
  // A tail whose id already settled before the final item is a delayed lane
  // publication. It must not reopen old output or leave a synthetic Thinking
  // row behind after the actual turn has moved on.
  const activeStreamingTail = streamingTail
    && (tailSettledIndex < 0 || tailSettledIndex === settledItems.length - 1)
    ? streamingTail
    : null;
  const tailAppended = Boolean(activeStreamingTail) && tailSettledIndex < 0;
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
  const queuedPromptIds = useMemo(
    () => new Set((Array.isArray(snapshot.queued) ? snapshot.queued : [])
      .map((item) => asRecord(item)?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String)),
    [snapshot.queued],
  );
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
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    setOptimisticPrompts([]);
  }, [transcriptSessionKey]);
  useEffect(() => {
    if (queuedPromptIds.size === 0) return;
    setOptimisticPrompts((current) => {
      let changed = false;
      const next = current.map((item) => {
        if (item.queueAcknowledged === true || !queuedPromptIds.has(String(item.id))) return item;
        changed = true;
        return { ...item, queueAcknowledged: true };
      });
      return changed ? next : current;
    });
  }, [queuedPromptIds]);
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
  // A same-id live item replaces the last settled row in the projection. Its
  // selector-driven renderer still updates independently, but now occupies the
  // same virtual row and measurement path as settled output.
  const tailReplacesLastSettled = Boolean(activeStreamingTail)
    && tailSettledIndex === settledItems.length - 1;
  const settledRowItems = useMemo(
    () => (tailReplacesLastSettled ? settledItems.slice(0, -1) : settledItems),
    [settledItems, tailReplacesLastSettled],
  );
  const failedTurns = useMemo(
    () => new Set(snapshot.failedTurnKeys || []),
    [snapshot.failedTurnKeys],
  );
  const precomputedTurnKeys = Array.isArray(snapshot.transcriptTurnKeys)
    ? snapshot.transcriptTurnKeys as string[]
    : null;
  const settledTurnKeys = useMemo(() => (
    precomputedTurnKeys?.length === settledItems.length
      ? precomputedTurnKeys
      : transcriptTurnKeys(settledItems)
  ), [precomputedTurnKeys, settledItems]);
  // ONE projection owns visibility, completion folding, and failed-turn status
  // rows, so the virtual list never carries invisible or zero-height rows.
  const transcriptRows = useMemo(() => projectTranscriptRows({
    sessionKey: transcriptSessionKey,
    items: settledRowItems,
    turnKeys: settledTurnKeys,
    failedTurns,
    pendingItems: pendingPromptItems,
    liveItem: activeStreamingTail,
    thinking: Boolean(
      snapshot.busy
      || snapshot.commandBusy
      || activeStreamingTail
      || optimisticActivityStartedAt
    ),
  }), [
    failedTurns,
    optimisticActivityStartedAt,
    pendingPromptItems,
    settledRowItems,
    settledTurnKeys,
    snapshot.busy,
    snapshot.commandBusy,
    activeStreamingTail,
    transcriptSessionKey,
  ]);
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
  const jumpToLatest = useCallback(() => {
    resumeFollow();
    scrollToEndRef.current();
  }, [resumeFollow]);
  // OpenCode resumes at the latest row on a session route change. Measurement
  // snapshots survive re-entry, but a stale per-session scroll offset does not.
  const armedFollowSessionKey = useRef("");
  useLayoutEffect(() => {
    if (armedFollowSessionKey.current === transcriptSessionKey) return;
    armedFollowSessionKey.current = transcriptSessionKey;
    resumeFollow();
  }, [resumeFollow, transcriptSessionKey]);
  const shouldAnchorTranscriptBottom = following
    || armedFollowSessionKey.current !== transcriptSessionKey;
  // Submit mirrors OpenCode resumeScroll: re-arm auto-scroll, then ask the
  // virtual timeline—not the DOM observer—to resolve the final row.
  const resumeFollowOnSubmitRef = useRef(resumeFollow);
  resumeFollowOnSubmitRef.current = resumeFollow;
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
    const materializingDraft = draftModeRef.current;
    if (materializingDraft) suppressDraftSubmitPaintHandoff.current = true;
    setOptimisticPrompts((current) => [
      ...current.filter((item) => item.id !== submissionId),
      optimistic,
    ]);
    window.mixdogDesktop?.perfLog?.(`prompt-submit phase=renderer-queued id=${submissionId}`);
    resumeFollowOnSubmitRef.current();
    scrollToEndRef.current();
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
    } catch (error) {
      if (materializingDraft) suppressDraftSubmitPaintHandoff.current = false;
      setOptimisticPrompts((current) =>
        current.filter((item) => String(item.id) !== submissionId));
      throw error;
    }
    if (accepted !== true && materializingDraft) {
      suppressDraftSubmitPaintHandoff.current = false;
    }
    setOptimisticPrompts((current) => current.flatMap((item) => {
      if (String(item.id) !== submissionId) return [item];
      return accepted === true ? [{ ...item, accepted: true }] : [];
    }));
    window.mixdogDesktop?.perfLog?.(
      `prompt-submit phase=renderer-host-ack id=${submissionId}`
      + ` accepted=${accepted === true ? 1 : 0}`
      + ` wait=${(performance.now() - acceptedStartedAt).toFixed(0)}ms`,
    );
    return accepted;
  }, []);
  const composerAbort = useCallback(
    () => composerActions.current.invokeResult(() => {
      const host = window.mixdogDesktop;
      const sessionId = routeSessionIdRef.current;
      if (sessionId && typeof host.abortSession === "function") {
        return host.abortSession(sessionId);
      }
      return host.abort();
    }),
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

  const disclosureScope = String(routeSnapshot.sessionId || "new-task");
  const retryDisabled = Boolean(snapshot.busy) || transitioning;
  // Session retry: resubmit the failed turn's original user prompt through the
  // normal composer submit path.
  const retryTurn = (turnKey: string) => {
    const text = turnPromptText(settledItems, settledTurnKeys, turnKey);
    if (text) void composerSubmit(text);
  };
  const renderTranscriptRow = (row: TranscriptRowModel) => {
    if (row._tag === "TurnGap") {
      return <div className="transcript-turn-gap" aria-hidden="true" />;
    }
    if (row._tag === "Error") {
      return <div className="turn-status failed" role="status">
        <X className="turn-status-icon" size={15} aria-hidden="true" />
        <span>{t("Failed")}</span>
        {readOnly ? null : <button type="button" className="turn-retry" disabled={retryDisabled}
          onClick={() => retryTurn(row.turnKey)} aria-label={t("Retry failed turn")}>
          <MxIcon name="reset" size={12} />{t("Retry")}
        </button>}
      </div>;
    }
    if (row._tag === "Thinking") {
      return <div className="live-activity-slot" data-busy="true">
        <LiveActivity snapshot={snapshot}
          optimisticStartedAt={optimisticActivityStartedAt} />
      </div>;
    }
    if (row._tag === "UserMessage") {
      return <TranscriptRow item={row.item}
        disclosureScope={disclosureScope}
        attachedUser={row.attachedUser} />;
    }
    if (row.live) {
      return streamingTailSlot ?? <div className="transcript-live-part"
        data-streaming-tail="true">
        <TranscriptRow item={row.item} disclosureScope={disclosureScope} />
      </div>;
    }
    const animated = isCompletionTranscriptItem(row.item) ? row.item : row.completion;
    return <TranscriptRow item={row.item} completion={row.completion}
      completionAnimate={animated
        ? freshCompletionAnimationKeys.has(completionAnimationKeyByItem.get(animated) || "")
        : false}
      disclosureScope={disclosureScope} />;
  };

  return (
    <section className={`conversation${readOnly ? " conversation-read-only" : ""}`} ref={conversation}
      onKeyDownCapture={readOnly ? undefined : (event) => {
        // Typing must always land in the composer: a printable key (or the
        // IME "Process" key starting a Korean composition) pressed while
        // focus sits on the transcript or tool chrome refocuses the input
        // BEFORE the character/composition commits, so keystrokes are never
        // silently dropped (user: 간헐적으로 채팅 입력이 안 됨).
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.length !== 1 && event.key !== "Process") return;
        const target = event.target as HTMLElement | null;
        if (!target || typeof target.closest !== "function") return;
        if (target.closest('textarea, input, select, [contenteditable="true"]')) return;
        event.currentTarget
          .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Mixdog"]')
          ?.focus({ preventScroll: true });
      }}>
      <div className="transcript-shell">
      <div className="transcript" ref={viewport} role="log" aria-label={t("Conversation transcript")}
        data-session-key={transcriptSessionKey}
        data-following={following ? "true" : "false"}
        aria-live="polite" aria-relevant="additions" aria-atomic="false"
        aria-busy={Boolean(snapshot.busy || snapshot.commandBusy)} tabIndex={0}
        // The thread is a READING surface: a mouse drag may extend the
        // selection, but it must never pick the text (or a code block, tool
        // output, image chip) up and carry it as a native drag payload
        // (user). Capture refuses the drag for every descendant, so no row
        // needs its own guard.
        onDragStartCapture={(event) => event.preventDefault()}
        // Chromium defers a press that lands INSIDE the live selection: it
        // waits for a drag it is no longer allowed to start, so the next
        // drag-select is swallowed (user: 연속 드래그 시 한 번씩 씹힘).
        // Collapsing the selection first makes every press begin a fresh
        // range; shift-extend and the right-click menu keep theirs.
        onMouseDownCapture={(event) => {
          if (event.button !== 0 || event.shiftKey) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) selection.removeAllRanges();
        }}
        onScroll={handleTranscriptScroll}
        onWheel={handleTranscriptWheel}
        onPointerDown={handleTranscriptPointerDown}
        onPointerMove={handleTranscriptPointerMove}
        onTouchStart={handleTranscriptTouchStart}
        onTouchMove={handleTranscriptTouchMove}
        onTouchEnd={handleTranscriptTouchEnd}
        onTouchCancel={handleTranscriptTouchEnd}
        onClick={handleTranscriptInteraction}
        onKeyDown={handleTranscriptKeyDown}>
        <div className="thread">
          {/* An EMPTY draft carries ONLY the centered brand watermark (user:
              VS Code grammar — shortcuts live solely on the fully empty
              workspace; secondary surfaces keep the quiet letterpress).
              Sessions and transitions never show it. */}
          {(((draftMode || (!routeSnapshot.sessionId && Boolean(activeProjectPath)))
            && itemCount === 0 && pendingPromptItems.length === 0
            && !activeStreamingTail && !transitioning) || visibleWarmPaintHandoff) && (
            <div className={`thread-welcome thread-welcome-task${visibleWarmPaintHandoff
              ? " thread-welcome-paint-handoff" : ""}`} aria-hidden="true">
              <span className="welcome-logo"><BrandTile crop /></span>
            </div>
          )}
          <TranscriptList key={transcriptSessionKey} sessionKey={transcriptSessionKey}
            rows={transcriptRows} viewport={viewport} content={content}
            shouldAnchorBottom={shouldAnchorTranscriptBottom}
            scrollToEndRef={scrollToEndRef} renderRow={renderTranscriptRow} />
        </div>
      </div>
      {showJump && itemCount > 0 && <button type="button" className="jump-to-latest" onClick={() => jumpToLatest()}
        aria-label={t("Jump to latest message")}>
        <ArrowDown size={14} />{t("Jump to latest")}
      </button>}
      </div>
      {!readOnly && <div className="composer-region">
        {Boolean(asRecord(snapshot.progressHint)?.text) && <div className="runtime-progress" role="status">
          {String(asRecord(snapshot.progressHint)?.text)}
        </div>}
        {snapshot.toolApproval && (
          <div className="composer-approval-row">
            <ApprovalCard key={approvalInstanceKey(snapshot.toolApproval.id)}
              approval={snapshot.toolApproval}
              resolve={(approved) => {
                const host = window.mixdogDesktop;
                const sessionId = routeSessionIdRef.current;
                const approvalId = String(snapshot.toolApproval?.id || "");
                return sessionId
                  && typeof host.resolveToolApprovalForSession === "function"
                  ? host.resolveToolApprovalForSession(sessionId, approvalId, { approved })
                  : host.resolveToolApproval(approvalId, { approved });
              }} />
          </div>
        )}
        {/* Draft-only context bar leaves with a 140ms collapse instead of an
            instant unmount: removing its 34px in the promotion frame dropped
            the composer in one visible jerk (measured layout shift; user:
            첫 프롬 직후 화면이 한 번 툭 튐). */}
        {(showProjectSelector || contextBarPhase !== "closed")
          && <div className={`composer-context-bar${showProjectSelector
            ? "" : " composer-context-bar-collapsing"}`}>
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
