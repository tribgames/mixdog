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
  DesktopAbortOptions,
  DesktopModelSelection,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopWorkflowState,
  SessionSnapshot
} from "../shared/contract";
import { t } from "./i18n";
import { isMobileRemoteSurface } from "./mobile-surface";
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
import { SessionGoalHost } from "./SessionGoalIsland";
import { asRecord } from "./text-format";
import { TranscriptList } from "./TranscriptList";
import {
  appendLiveTranscriptRows,
  isCompletionTranscriptItem,
  projectSettledTranscriptRows,
  turnPromptText,
  type TranscriptRowModel,
} from "./transcript-rows";
import {
  nextDraftTranscriptNamespace,
  rememberTranscriptRowNamespace,
  readTranscriptVirtualSnapshot,
  transcriptRowNamespace,
} from "./transcript-virtual-cache";
import {
  nextTranscriptHistoryLimit,
  TRANSCRIPT_HISTORY_PAGE_ITEMS,
} from "./transcript-history";
import { LiveActivity, resetToolDisclosureScope, ToolActivityGroup, TranscriptRow } from "./TranscriptView";
import { TurnReviewBar } from "./TurnReview";
import { useTranscriptFollow } from "./use-transcript-follow";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory } from "../../../../src/runtime/shared/tool-surface.mjs";


/** Does this tool row belong to work that can CHANGE files? The shared
 *  classifier owns the answer (Patch = apply_patch and its aliases), an
 *  aggregate card carries its categories as a count map, and a card that
 *  already published a uiDiff has touched files by definition. */
function toolTouchesFiles(item: TranscriptItem | null | undefined): boolean {
  if (!item || item.kind !== "tool") return false;
  if (typeof item.uiDiff === "string" && item.uiDiff) return true;
  const categories = asRecord(item.categories);
  if (categories && Object.hasOwn(categories, "Patch")) return true;
  return classifyToolCategory(String(item.name || "")) === "Patch";
}

export type PendingPromptItem = TranscriptItem & {
  id: string | number;
  kind: "user";
  text: string;
  pending: boolean;
  accepted: boolean;
  submittedAt: number;
  queuedBehindTurn?: boolean;
  /** User rows already settled in this session when the prompt was sent. The
   *  durable row is the (baseline + 1)-th user row, which releases this
   *  optimistic twin even if the runtime normalized its id. */
  settledUserBaseline?: number;
};

function settledUserRowCount(items: readonly TranscriptItem[]): number {
  let count = 0;
  for (const item of items) if (item?.kind === "user") count += 1;
  return count;
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
  }).filter(Boolean).join("\n").trim() || t("Attached prompt");
}

function pendingPromptImages(options?: DesktopSubmitOptions): NonNullable<TranscriptItem["images"]> {
  return Object.values(options?.pastedImages || {}).map((image) => ({
    id: image.id,
    name: image.filename || "Image",
    mimeType: image.mediaType,
    bytes: Number(image.sizeBytes) || String(image.content || "").length,
  }));
}

export function pendingPromptTranscriptItems(
  optimistic: PendingPromptItem[],
  settled: TranscriptItem[],
): PendingPromptItem[] {
  const settledIds = new Set(settled
    .map((item) => item?.id)
    .filter((id) => id !== undefined && id !== null)
    .map(String));
  const settledUsers = settledUserRowCount(settled);
  const byId = new Map<string, PendingPromptItem>();
  for (const item of optimistic) {
    if (item?.id === undefined || item.id === null || !String(item.text || "").trim()) continue;
    byId.set(String(item.id), item);
  }
  // Host acknowledgement is NOT settlement. Releasing on the RPC result took
  // the bubble back out of the thread for the whole ack -> publication window
  // (measured 77ms to 4s on the daemon-hosted session runtime): the bottom-pinned
  // timeline lost the prompt's height, snapped back, then snapped forward
  // again when the durable row arrived — the double kick the reader sees as
  // one big jerk (user: 프롬프트 입력 들어갈 때 스크롤이 크게 투둑 튄다).
  // The optimistic row is therefore held until its OWN durable row lands.
  const rows: PendingPromptItem[] = [];
  const ordered = [...byId.values()].sort((left, right) => left.submittedAt - right.submittedAt);
  // Durable user rows already claimed by an earlier optimistic prompt: this
  // prompt's own row is the (baseline + claimed + 1)-th user row.
  let claimed = 0;
  for (const item of ordered) {
    if (settledIds.has(String(item.id))) {
      claimed += 1;
      continue;
    }
    // Id-agnostic safety net: a runtime that renames the submission id still
    // releases the twin once its ordinal user row exists, so a lost id can
    // never strand a permanent ghost bubble.
    const baseline = Number(item.settledUserBaseline);
    if (Number.isFinite(baseline) && settledUsers >= baseline + claimed + 1) {
      claimed += 1;
      continue;
    }
    rows.push({ ...item, pending: true });
  }
  return rows;
}

export function promptWaitsBehindActiveTurn(
  draftMode: boolean,
  snapshot: Pick<Snapshot, "busy" | "queued">,
): boolean {
  // A new thread's first prompt belongs to the new thread, never to the
  // active or queued state of the previously viewed
  // session. Existing sessions still expose follow-ups through the queue.
  return !draftMode && (Boolean(snapshot.busy)
    || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0));
}

export function unsettledQueueEntries(
  queued: unknown,
  settled: readonly TranscriptItem[],
): unknown[] {
  if (!Array.isArray(queued) || queued.length === 0) return [];
  const settledUserIds = new Set(settled
    .filter((item) => item?.kind === "user" && item.id !== undefined && item.id !== null)
    .map((item) => String(item.id)));
  if (settledUserIds.size === 0) return queued;
  // One owner per submission: once the durable user row exists, it wins over
  // a delayed queue projection carrying the same id. Text is deliberately not
  // compared because identical follow-ups with distinct ids are valid.
  return queued.filter((entry) => {
    const id = asRecord(entry)?.id;
    return id === undefined || id === null || !settledUserIds.has(String(id));
  });
}

export function Conversation({
  snapshot,
  routeSnapshot,
  sessionAddress,
  invokeResult,
  errors,
  submit,
  applySnapshot,
  transitioning,
  composerFocusRequest,
  onNewTask,
  onClearToNewTask,
  onClearProject,
  onResumeSession,
  onOpenSessions,
  onOpenProjects,
  onOpenSettings,
  projects,
  showProjectSelector,
  activeProjectPath,
  activeProjectLabel,
  onSelectProject,
  draftMode = false,
  draftId = "",
  draftModelSelection,
  draftWorkflow,
  onDraftModelSelection,
  onRoutePreferenceApplied,
  onDraftWorkflow,
  onOpenCommandSurface,
  streamingTailSlot,
  runtimeProgressSlot,
  goalIsland,
  contextIndicator,
  readOnly = false,
  reviewActive = true,
  warmPaintHandoff = false,
  transcriptPending = false,
}: {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  /** Pane ownership resolves to this canonical session address. */
  sessionAddress?: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  /** Session-pane /clear · /new: close this session's tab and open a New
   *  Task in its place with the session's settings inherited. */
  onClearToNewTask?: (sessionId: string) => void;
  onClearProject: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  draftMode?: boolean;
  /** Distinct New Task pane identity: pressing New task mints a new one, so
   *  the composer opens clean instead of inheriting the previous draft. */
  draftId?: string;
  draftModelSelection?: DesktopModelSelection | null;
  draftWorkflow?: DesktopWorkflowState | null;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection) => void;
  onDraftWorkflow?: (workflow: DesktopWorkflowState) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  /** Selector-driven live row; keeps token publications out of this shell. */
  streamingTailSlot?: ReactNode;
  /** Selector-driven runtime status; progress publications do not rerender the
   *  transcript/composer shell. */
  runtimeProgressSlot?: ReactNode;
  /** Goal capsule routed to the composer unless the pane's visible DIFF owns
   *  it instead. */
  goalIsland?: ReactNode;
  /** Context gauge seated in the composer footer beside the model trigger
   *  on every surface (user: 컨텍스트는 모델 선택기 옆; 모바일도 PC에 맞춰). */
  contextIndicator?: ReactNode;
  /** Transcript-only child-agent view: no submit, retry, approval, review, or
   *  other session runtime-mutating controls are mounted. */
  readOnly?: boolean;
  /** Only the focused, visible session performs background review refreshes. */
  reviewActive?: boolean;
  /** A warm New Task → session commit paints the requested transcript under
   *  the prior watermark for one frame so Chromium uploads its raster before
   *  it becomes visible. Route identity and interaction are already current. */
  warmPaintHandoff?: boolean;
  /** The rich Markdown chunk this session's rows need has not resolved yet.
   *  The timeline stays UNMOUNTED until it has (the surface cover holds the
   *  frame): the timeline mounts once, with the real rows, so the entry
   *  offset is resolved exactly once. */
  transcriptPending?: boolean;
}) {
  const conversation = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollToEndRef = useRef<(behavior?: ScrollBehavior) => void>(() => {});
  // Reader intent must reach the virtual timeline's anchor in the same task it
  // is decided in; React state gets there a render later.
  const setTranscriptAnchorBottomRef = useRef<(bottom: boolean) => void>(() => {});
  // Latched once this identity has painted its timeline. A promotion whose
  // Markdown-readiness flag lags one tick must not unmount measured rows.
  const timelineMounted = useRef(false);
  // Auto-scroll + message-gesture split.
  const {
    following,
    showJump,
    hasScrollGesture: hasTranscriptScrollGesture,
    handleScroll: handleTranscriptScroll,
    handleWheel: handleTranscriptWheel,
    handlePointerDown: handleTranscriptPointerDown,
    handlePointerMove: handleTranscriptPointerMove,
    handlePointerUp: handleTranscriptPointerUp,
    handleSelectionAutoScroll: handleTranscriptSelectionAutoScroll,
    handleTouchStart: handleTranscriptTouchStart,
    handleTouchMove: handleTranscriptTouchMove,
    handleTouchEnd: handleTranscriptTouchEnd,
    handleInteraction: handleTranscriptInteraction,
    handleKeyDown: handleTranscriptKeyDown,
    resume: resumeFollow,
    arm: armFollow,
    markProgrammaticScroll: markTranscriptProgrammaticScroll,
  } = useTranscriptFollow({
    viewport,
    content,
    sessionKey: draftMode
      ? "new-task"
      : String(routeSnapshot.sessionId || "new-task"),
    contentMounted: !transcriptPending || timelineMounted.current,
    setAnchorBottomRef: setTranscriptAnchorBottomRef,
    scrollToEndRef,
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
  // Pane-local session runtime addressing: abort and tool approvals always target the
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
    onOpenSessions, onOpenProjects, onOpenSettings, onOpenCommandSurface,
    onClearToNewTask,
  });
  composerActions.current = {
    submit, invokeResult, applySnapshot, onNewTask, onResumeSession,
    onOpenSessions, onOpenProjects, onOpenSettings, onOpenCommandSurface,
    onClearToNewTask,
  };
  // TUI parity: a prompt only reads as "Queued" when it actually waits behind
  // an active turn. An idle submit — including a draft's first prompt, whose
  // atomic RPC spans session materialization — renders as a normal user row.
  const queuedBehindTurnAtSubmit = useRef(false);
  queuedBehindTurnAtSubmit.current = promptWaitsBehindActiveTurn(draftMode, snapshot);
  const settledItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  // Esc-Esc message selector source: the most recent rewindable user prompts,
  // oldest → newest (TUI parity, capped like the terminal picker).
  const composerUserMessages = useMemo(() => {
    const rows: Array<{ id: string; text: string }> = [];
    for (let index = settledItems.length - 1; index >= 0 && rows.length < 20; index -= 1) {
      const item = settledItems[index];
      if (!item || item.kind !== "user" || item.id == null) continue;
      const text = String(item.text || "").trim();
      if (!text) continue;
      rows.push({ id: String(item.id), text });
    }
    return rows.reverse();
  }, [settledItems]);
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
  const settledItemCountRef = useRef(settledItems.length);
  settledItemCountRef.current = settledItems.length;
  const historyPagingRef = useRef({
    sessionId: transcriptSessionKey,
    limit: Math.max(TRANSCRIPT_HISTORY_PAGE_ITEMS, settledItems.length),
    pending: false,
    exhausted: settledItems.length < TRANSCRIPT_HISTORY_PAGE_ITEMS,
  });
  if (historyPagingRef.current.sessionId !== transcriptSessionKey) {
    historyPagingRef.current = {
      sessionId: transcriptSessionKey,
      limit: Math.max(TRANSCRIPT_HISTORY_PAGE_ITEMS, settledItems.length),
      pending: false,
      exhausted: settledItems.length < TRANSCRIPT_HISTORY_PAGE_ITEMS,
    };
  }
  const requestEarlierTranscript = useCallback(() => {
    const sessionId = String(routeSnapshot.sessionId || '');
    const prefetch = window.mixdogDesktop?.prefetchSession;
    const paging = historyPagingRef.current;
    if (!sessionId || typeof prefetch !== 'function' || paging.pending || paging.exhausted) return;
    const nextLimit = nextTranscriptHistoryLimit(
      settledItemCountRef.current,
      paging.limit,
    );
    if (nextLimit == null) {
      paging.exhausted = true;
      return;
    }
    const beforeCount = settledItemCountRef.current;
    paging.pending = true;
    void Promise.resolve(prefetch(sessionId, nextLimit)).then((accepted) => {
      window.requestAnimationFrame(() => {
        const current = historyPagingRef.current;
        if (current.sessionId !== transcriptSessionKey) return;
        current.pending = false;
        current.limit = Math.max(current.limit, nextLimit);
        const afterCount = settledItemCountRef.current;
        if (accepted !== true || afterCount <= beforeCount || afterCount < nextLimit) {
          current.exhausted = true;
        }
      });
    }).catch(() => {
      if (historyPagingRef.current.sessionId === transcriptSessionKey) {
        historyPagingRef.current.pending = false;
      }
    });
  }, [routeSnapshot.sessionId, transcriptSessionKey]);
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  // A pane's OWN draft -> session promotion must NOT rebuild the timeline. The
  // virtual list AND its row keys are namespaced by this identity, which
  // survives the promotion; only the geometry cache follows the real session
  // key. Keying them by the session key remounted the list mid-turn, dropped
  // every measured row, and repainted the first prompt from the flat estimate
  // (user: 첫 프롬 입력 후 화면이 툭 튀고 말풍선이 엉뚱한 위치로 튄다).
  const transcriptIdentity = useRef("");
  const transcriptIdentitySource = useRef("");
  // Set on the promotion render, where the submit marker is still armed, and
  // consumed by the effect below; never cleared in render, so a repeated
  // render of the same commit cannot lose it.
  const promotedOwnDraft = useRef(false);
  // The pending gate below belongs to a COLD session entry. Once this identity
  // has painted its timeline, it must never be unmounted again — a promotion
  // whose Markdown-readiness flag lags one tick would otherwise discard every
  // measured row exactly like a remount.
  if (transcriptIdentitySource.current !== transcriptSessionKey) {
    const ownPromotion = transcriptIdentitySource.current === 'new-task'
      && transcriptSessionKey !== 'new-task'
      && suppressDraftSubmitPaintHandoff.current;
    transcriptIdentitySource.current = transcriptSessionKey;
    if (ownPromotion) {
      promotedOwnDraft.current = true;
      // Re-entry must still match the geometry cached under the REAL session
      // key, so the draft's namespace outlives this mount.
      rememberTranscriptRowNamespace(transcriptSessionKey, transcriptIdentity.current);
    } else {
      transcriptIdentity.current = transcriptSessionKey === 'new-task'
        ? nextDraftTranscriptNamespace()
        : transcriptRowNamespace(transcriptSessionKey);
      timelineMounted.current = Boolean(
        readTranscriptVirtualSnapshot(transcriptSessionKey)?.measurements?.length,
      );
    }
  }
  const showTranscriptTimeline = !transcriptPending || timelineMounted.current;
  if (showTranscriptTimeline) timelineMounted.current = true;
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
  // Submit-time baseline for the id-agnostic release path below.
  const settledUsers = useMemo(() => settledUserRowCount(settledItems), [settledItems]);
  const settledUsersRef = useRef(settledUsers);
  settledUsersRef.current = settledUsers;
  // Cross-surface queue parity: ONE queue owns every prompt waiting behind an
  // active turn, whatever typed it. The moment the session runtime
  // publishes this submission in `queued`, the composer's reserved-message
  // list owns its display — so an app-typed prompt stacks in session runtime order
  // beside terminal-typed ones and drains on the next turn loop, instead of
  // hiding inside the transcript as a private "Queued" card. The optimistic
  // item stays in state: a prompt that leaves the queue before its durable
  // row lands falls back to the transcript card instead of blinking out.
  // Only a prompt submitted BEHIND an active turn hands over. EVERY submit
  // rides the session runtime queue for one drain hop (idle ones included, via
  // autoClearBeforeSubmit), so keying on the queue publication alone put a
  // brand-new task's very first prompt into the reserved list with an empty
  // transcript (user report).
  const unsettledSessionQueue = useMemo(
    () => unsettledQueueEntries(snapshot.queued, settledItems),
    [settledItems, snapshot.queued],
  );
  const sessionQueuedIdKey = useMemo(
    () => unsettledSessionQueue
      .map((entry) => String(asRecord(entry)?.id ?? ""))
      .join("\u0000"),
    [unsettledSessionQueue],
  );
  const sessionQueuedIds = useMemo(
    () => new Set(sessionQueuedIdKey.split("\u0000").filter(Boolean)),
    [sessionQueuedIdKey],
  );
  const pendingPromptItems = useMemo(
    () => pendingPromptTranscriptItems(optimisticPrompts, settledItems)
      .filter((item) => item.queuedBehindTurn !== true
        || !sessionQueuedIds.has(String(item.id))),
    [sessionQueuedIds, optimisticPrompts, settledItems],
  );
  // A prompt submitted BEHIND an active turn belongs to the reserved list from
  // its FIRST frame. Keying its transcript row on the session runtime's queue
  // publication painted it as a real chat row for one RPC round trip
  // (user: 예약 메시지가 잠깐 채팅창에 찍힌다). The row is withheld here and the
  // same prompt is handed to the composer's queue below until the session runtime
  // publishes its own entry — the ids match, because submit mints the id the
  // session runtime reuses for the queue entry.
  const transcriptPendingPromptItems = useMemo(
    () => pendingPromptItems.filter((item) => item.queuedBehindTurn !== true),
    [pendingPromptItems],
  );
  const localQueuedPrompts = useMemo(
    () => pendingPromptItems.filter((item) => item.queuedBehindTurn === true),
    [pendingPromptItems],
  );
  const pendingPromptIds = useMemo(
    () => transcriptPendingPromptItems.map((item) => item.id),
    [transcriptPendingPromptItems],
  );
  // The composer's reserved list = the session runtime queue plus the submits it has not
  // published yet. Local entries carry the submission id, so the session runtime entry
  // replaces its local twin by id the moment it lands.
  const composerQueued = useMemo(() => {
    const sessionQueue = unsettledSessionQueue;
    if (localQueuedPrompts.length === 0) return sessionQueue;
    const published = new Set(sessionQueue
      .map((entry) => String(asRecord(entry)?.id ?? ""))
      .filter(Boolean));
    const local = localQueuedPrompts
      .filter((item) => !published.has(String(item.id)))
      .map((item) => ({
        id: item.id,
        displayText: item.text,
        ...(item.images?.length ? { images: item.images } : {}),
      }));
    return local.length === 0 ? sessionQueue : [...sessionQueue, ...local];
  }, [localQueuedPrompts, unsettledSessionQueue]);
  const optimisticActivityStartedAt = pendingPromptItems.reduce((earliest, item) => {
    if (item.queuedBehindTurn === true) return earliest;
    const startedAt = Number(item.submittedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return earliest;
    return earliest > 0 ? Math.min(earliest, startedAt) : startedAt;
  }, 0);
  const itemCount = liveItemCount + transcriptPendingPromptItems.length;
  // An idle submit starts the next review scope on its optimistic user row,
  // not one host round-trip later when that row settles. Otherwise the prior
  // turn's review bar/reservation remains fixed above the composer while the
  // next response begins streaming.
  const reviewItems = useMemo(
    () => transcriptPendingPromptItems.length > 0
      ? [...settledItems, ...transcriptPendingPromptItems]
      : settledItems,
    [settledItems, transcriptPendingPromptItems],
  );
  // A turn that can actually produce a diff reserves the collapsed review row,
  // so a result arriving mid-stream fills existing geometry instead of
  // shrinking the transcript viewport. Reserving it for EVERY live turn left a
  // conversation-only turn floating an empty 36px plate above the input
  // (user: DIFF가 없는 경우에도 스크립트가 좀 떠있네).
  const turnTouchesFiles = useMemo(() => {
    for (let index = reviewItems.length - 1; index >= 0; index--) {
      const item = reviewItems[index];
      if (!item) continue;
      if (item.kind === "user") break;
      if (toolTouchesFiles(item)) return true;
    }
    return toolTouchesFiles(activeStreamingTail);
  }, [activeStreamingTail, reviewItems]);
  const reviewSlotReserved = turnTouchesFiles && Boolean(
    snapshot.busy
    || snapshot.commandBusy
    || activeStreamingTail
    || optimisticActivityStartedAt
  );
  // Submit-gap batching: the optimistic user row opens the next review scope
  // in the SAME commit it appends, so the diff bar unmounts there; the goal
  // capsule instead follows the lane snapshot, which lands one commit later,
  // and the composer height then steps twice (user: 엔터 치면 투툭투툭 튄다 —
  // 한 프레임에 동시 처리). While the submit gap is open, hide the goal in
  // that same commit — but only when this submit actually closes a
  // file-touching scope, so persistent goals on conversation-only turns are
  // left alone.
  const turnTouchesFilesRef = useRef(turnTouchesFiles);
  turnTouchesFilesRef.current = turnTouchesFiles;
  const hideGoalForSubmitRef = useRef(false);
  const submitGapOpen = transcriptPendingPromptItems.length > 0;
  if (!submitGapOpen && hideGoalForSubmitRef.current) hideGoalForSubmitRef.current = false;
  const hideGoalForSubmit = hideGoalForSubmitRef.current && submitGapOpen;
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    // A promotion is not a navigation: the in-flight prompt stays visible
    // until its own settled row lands (released by id), instead of blinking
    // out of the thread for the publication interval after the first submit.
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
  }, [transcriptSessionKey]);
  useEffect(() => {
    // Neither host acknowledgement nor queue publication is settlement: the
    // optimistic card is dropped from state only once its own durable row is
    // in the transcript.
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
  // The settled half re-runs only when settled items change; each streaming
  // tick appends the live tail onto the memoized settled rows instead of
  // re-projecting the whole transcript.
  const settledProjection = useMemo(() => projectSettledTranscriptRows({
    sessionKey: transcriptIdentity.current,
    items: settledRowItems,
    turnKeys: settledTurnKeys,
    failedTurns,
  }), [failedTurns, settledRowItems, settledTurnKeys, transcriptSessionKey]);
  const transcriptRows = useMemo(() => appendLiveTranscriptRows({
    sessionKey: transcriptIdentity.current,
    settled: settledProjection,
    pendingItems: transcriptPendingPromptItems,
    liveItem: activeStreamingTail,
    thinking: Boolean(
      snapshot.busy
      || snapshot.commandBusy
      || activeStreamingTail
      || optimisticActivityStartedAt
    ),
  }), [
    optimisticActivityStartedAt,
    settledProjection,
    transcriptPendingPromptItems,
    snapshot.busy,
    snapshot.commandBusy,
    activeStreamingTail,
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
  // Cold-entry one-shot reveal (phone): entering a session whose lane is
  // still filling used to paint rows at estimated heights and then visibly
  // snap once real measurements pinned the bottom. Hold the scroller
  // invisible until the first hydrated commit has settled (double rAF), then
  // show the final frame in one paint (user: 전 페이지 보였다가 튀는 것보다
  // 빈 화면에서 한 번에). A lane that is already warm renders settled in
  // this same commit and never hides; the desktop surface never hides.
  const [, bumpTranscriptReveal] = useState(0);
  const transcriptRevealFrame = useRef({ sessionKey: transcriptSessionKey, revealed: true });
  if (transcriptRevealFrame.current.sessionKey !== transcriptSessionKey) {
    transcriptRevealFrame.current = {
      sessionKey: transcriptSessionKey,
      revealed: transcriptHydrated || !isMobileRemoteSurface(),
    };
  }
  const transcriptRevealed = transcriptRevealFrame.current.revealed;
  useLayoutEffect(() => {
    if (transcriptRevealFrame.current.revealed || !transcriptHydrated) return undefined;
    // Two frames: the hydrated commit measures its rows in the first, the
    // follow pin's corrective write lands by the second. A session that never
    // hydrates stays hidden, which reads the same as the blank it already is,
    // and the pane-surface unavailable cover renders outside this gate.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        transcriptRevealFrame.current.revealed = true;
        bumpTranscriptReveal((tick) => tick + 1);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [transcriptHydrated, transcriptSessionKey]);
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
  }, [resumeFollow]);
  // A session route change resumes at the latest row. Measurement
  // snapshots survive re-entry, but a stale per-session scroll offset does not.
  const armedFollowSessionKey = useRef("");
  useLayoutEffect(() => {
    if (armedFollowSessionKey.current === transcriptSessionKey) return;
    armedFollowSessionKey.current = transcriptSessionKey;
    // Entry re-arms following ONLY. The virtual timeline owns the end
    // position; writing scrollTop here too made two authorities aim at
    // different offsets across the first frames (re-entry jump/flicker).
    armFollow();
  }, [armFollow, transcriptSessionKey]);
  // A bulk item swap — mid-turn COMPACTION above all — deletes the rows the
  // reader was anchored to, so the viewport returns to the live tail with
  // follow re-armed. Mirrors the TUI's transcriptSwapReturnsToTail
  // (src/tui/app/transcript-window.mjs): live appends never touch index 0, so a
  // changed HEAD id WITHOUT growth is the swap signal. Growth that changes the
  // head (older-history restore) is a prepend and keeps the reading position.
  // Without this the desktop had no return-to-tail path at all: the follow hook
  // only re-arms on a scroll event or a VIEWPORT resize, and a compaction
  // shrinks the CONTENT, so auto-scroll stayed released for the rest of the
  // session (user: 컴팩트 상황에서 자동스크롤이 풀린다).
  const transcriptSwapRef = useRef({ sessionKey: "", count: 0 });
  useLayoutEffect(() => {
    const count = settledItems.length;
    const previous = transcriptSwapRef.current;
    transcriptSwapRef.current = { sessionKey: transcriptSessionKey, count };
    // Session entry owns its own arm. A same-length head-id change is a lane
    // republish, not compaction — that used to fire a second scrollToEnd.
    if (previous.sessionKey !== transcriptSessionKey) return;
    if (!previous.count || !count || count >= previous.count) return;
    armFollow();
    scrollToEndRef.current();
  }, [armFollow, settledItems, transcriptSessionKey]);
  // Content growth is watched on the rows commit (without a second
  // observer): a transcript that no longer OVERFLOWS holds no reading
  // position, so a shrink that fits inside the viewport re-arms follow instead
  // of leaving auto-scroll released with nothing left to scroll. Driven by the
  // rows commit, so virtual-core stays the only content-growth authority.
  useLayoutEffect(() => {
    if (following) return;
    const element = viewport.current;
    if (!element) return;
    if (element.scrollHeight - element.clientHeight > 1) return;
    armFollow();
  }, [armFollow, following, transcriptRows, viewport]);
  const shouldAnchorTranscriptBottom = following
    || armedFollowSessionKey.current !== transcriptSessionKey;
  // Submit re-arms follow. The new row is an append, so virtual-core's
  // followOnAppend is the only end write.
  const armFollowOnSubmitRef = useRef(armFollow);
  armFollowOnSubmitRef.current = armFollow;
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
      settledUserBaseline: settledUsersRef.current,
      ...(images.length ? { images } : {}),
    };
    const materializingDraft = draftModeRef.current;
    if (materializingDraft) suppressDraftSubmitPaintHandoff.current = true;
    // Batch the goal hide into the same commit as the append + diff hide (see
    // submit-gap batching above). Queued follow-ups ride the active turn and
    // must not touch the current chrome.
    if (turnTouchesFilesRef.current && !queuedBehindTurnAtSubmit.current) {
      hideGoalForSubmitRef.current = true;
    }
    setOptimisticPrompts((current) => [
      ...current.filter((item) => item.id !== submissionId),
      optimistic,
    ]);
    window.mixdogDesktop?.perfLog?.(`prompt-submit phase=renderer-queued id=${submissionId}`);
    armFollowOnSubmitRef.current();
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
    (options: DesktopAbortOptions = {}) => composerActions.current.invokeResult(() => {
      const host = window.mixdogDesktop;
      const sessionId = routeSessionIdRef.current;
      return sessionId ? host.abortSession(sessionId, options) : { aborted: false };
    }),
    [],
  );
  const composerInvokeResult = useCallback(
    <T,>(action: () => T | Promise<T>) => composerActions.current.invokeResult(action),
    [],
  );
  const composerQueuedRestored = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const restored = new Set(ids);
    setOptimisticPrompts((current) => {
      const next = current.filter((item) => !restored.has(String(item.id)));
      return next.length === current.length ? current : next;
    });
  }, []);
  const composerApplySnapshot = useCallback(
    (next: SessionSnapshot | null) => composerActions.current.applySnapshot(next),
    [],
  );
  const composerOnNewTask = useCallback(() => composerActions.current.onNewTask(), []);
  // A session pane's /clear · /new addresses ITS OWN session (pane-local
  // route), never the globally focused one.
  const composerOnClearToNewTask = useCallback(() => {
    const sessionId = routeSessionIdRef.current;
    if (sessionId) composerActions.current.onClearToNewTask?.(sessionId);
  }, []);
  const composerOnResumeSession = useCallback((id: string) => composerActions.current.onResumeSession(id), []);
  const composerOnOpenSessions = useCallback(() => composerActions.current.onOpenSessions(), []);
  const composerOnOpenProjects = useCallback(() => composerActions.current.onOpenProjects(), []);
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
      const failureReason = String(
        row.item?.detail || row.item?.message || row.item?.text || row.item?.label || "",
      ).replace(/^Error:\s*/i, "").trim();
      return <div className="turn-status failed" role="status">
        <X className="turn-status-icon" size={16} aria-hidden="true" />
        <span>{t("Failed")}{failureReason && !/^failed$/i.test(failureReason) ? ` · ${failureReason}` : ""}</span>
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
    if (row._tag === "ToolActivity") {
      return <ToolActivityGroup items={row.items} disclosureScope={disclosureScope} />;
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
        const transcriptKey = event.key === "PageUp" || event.key === "PageDown"
          || event.key === "Home" || event.key === "End";
        const target = event.target as HTMLElement | null;
        const editingHomeOrEnd = (event.key === "Home" || event.key === "End")
          && Boolean(target?.closest('textarea, input, select, [contenteditable="true"]'));
        const paletteOpen = Boolean(event.currentTarget.querySelector('[role="listbox"]'));
        const nestedScroller = target?.closest<HTMLElement>("[data-scrollable]");
        if (transcriptKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
          && !editingHomeOrEnd && !paletteOpen && !nestedScroller) {
          const element = viewport.current;
          if (element) {
            event.preventDefault();
            handleTranscriptKeyDown({ key: event.key });
            if (event.key === "PageUp" || event.key === "PageDown") {
              const direction = event.key === "PageDown" ? 1 : -1;
              element.scrollBy({ top: Math.round(element.clientHeight * 0.9) * direction, behavior: "auto" });
            } else {
              element.scrollTo({ top: event.key === "Home" ? 0 : element.scrollHeight, behavior: "auto" });
            }
          }
          return;
        }
        // Typing must always land in the composer: a printable key (or the
        // IME "Process" key starting a Korean composition) pressed while
        // focus sits on the transcript or tool chrome refocuses the input
        // BEFORE the character/composition commits, so keystrokes are never
        // silently dropped (user: 간헐적으로 채팅 입력이 안 됨).
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.length !== 1 && event.key !== "Process") return;
        if (!target || typeof target.closest !== "function") return;
        if (target.closest('textarea, input, select, [contenteditable="true"]')) return;
        event.currentTarget
          .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Mixdog"]')
          ?.focus({ preventScroll: true });
      }}>
      <div className="transcript-shell">
      <div className="transcript" ref={viewport} role="log" aria-label={t("Conversation transcript")}
        style={transcriptRevealed ? undefined : { visibility: "hidden" }}
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
        onScroll={(event) => {
          handleTranscriptScroll();
          if (event.currentTarget.scrollTop <= 320) requestEarlierTranscript();
        }}
        onWheel={handleTranscriptWheel}
        onPointerDown={handleTranscriptPointerDown}
        onPointerMove={handleTranscriptPointerMove}
        onPointerUp={handleTranscriptPointerUp}
        onPointerCancel={handleTranscriptPointerUp}
        onTouchStart={handleTranscriptTouchStart}
        onTouchMove={handleTranscriptTouchMove}
        onTouchEnd={handleTranscriptTouchEnd}
        onTouchCancel={handleTranscriptTouchEnd}
        onClick={handleTranscriptInteraction}
        onKeyDown={handleTranscriptKeyDown}>
        <div className="thread">
          {/* An empty draft carries only the centered brand watermark;
              shortcuts live solely on the fully empty
              workspace; secondary surfaces keep the quiet letterpress).
              Sessions and transitions never show it. */}
          {(((draftMode || (!routeSnapshot.sessionId && Boolean(activeProjectPath)))
            && itemCount === 0 && transcriptPendingPromptItems.length === 0
            && !activeStreamingTail && !transitioning) || visibleWarmPaintHandoff) && (
            <div className={`thread-welcome thread-welcome-task${visibleWarmPaintHandoff
              ? " thread-welcome-paint-handoff" : ""}`} aria-hidden="true">
              <span className="welcome-logo"><BrandTile crop /></span>
            </div>
          )}
          {/* ONE mount per session, always with the real rows: a placeholder
              shell mounted first made the virtual core resolve its end anchor
              against an empty list and again on the 0 -> N row swap — the
              visible up/down bounce on entering a session. */}
          {showTranscriptTimeline && <TranscriptList key={transcriptIdentity.current} sessionKey={transcriptSessionKey}
            rows={transcriptRows} viewport={viewport} content={content}
            shouldAnchorBottom={shouldAnchorTranscriptBottom}
            markProgrammaticScroll={markTranscriptProgrammaticScroll}
            hasScrollGesture={hasTranscriptScrollGesture}
            onSelectionAutoScroll={handleTranscriptSelectionAutoScroll}
            setAnchorBottomRef={setTranscriptAnchorBottomRef}
            scrollToEndRef={scrollToEndRef} renderRow={renderTranscriptRow} />}
        </div>
      </div>
      {showJump && itemCount > 0 && <button type="button" className="jump-to-latest"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          // A live wheel/fling can cancel the later click. Take the tail on the
          // press itself so the jump also stops the remaining scroll frames.
          event.preventDefault();
          jumpToLatest();
        }}
        // Native keyboard activation has no pointerdown and reports detail 0.
        onClick={(event) => {
          if (event.detail === 0) jumpToLatest();
        }}
        aria-label={t("Jump to latest message")}>
        <ArrowDown size={14} />{t("Jump to latest")}
      </button>}
      </div>
      {!readOnly && <div className="composer-region">
        <SessionGoalHost placement="composer">{hideGoalForSubmit ? null : goalIsland}</SessionGoalHost>
        {runtimeProgressSlot ?? (Boolean(asRecord(snapshot.progressHint)?.text)
          ? <div className="runtime-progress" role="status">
            {String(asRecord(snapshot.progressHint)?.text)}
          </div>
          : null)}
        {snapshot.toolApproval && (
          <div className="composer-approval-row">
            <ApprovalCard key={approvalInstanceKey(snapshot.toolApproval.id)}
              approval={snapshot.toolApproval}
              resolve={(approved) => {
                const host = window.mixdogDesktop;
                const sessionId = routeSessionIdRef.current;
                const approvalId = String(snapshot.toolApproval?.id || "");
                return sessionId
                  ? host.resolveToolApprovalForSession(sessionId, approvalId, { approved })
                  : Promise.resolve(false);
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
            onClear={onClearProject} onSelect={onSelectProject} />
          <WorkflowSelect workflow={(draftWorkflow || routeSnapshot.workflow as RecordValue | null) ?? null}
            disabled={transitioning || (!draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy))}
            invokeResult={composerInvokeResult} applySnapshot={composerApplySnapshot}
            onDraftChange={onDraftWorkflow} />
        </div>}
        <InlineErrors messages={errors} />
        {/* Review sits attached ABOVE the input (user: 채팅창 위에 붙어야 한다).
            It is not a timeline row: as scroll content it read as a detached
            card floating over the composer. */}
        <div className="turn-review-slot"
          data-reserved={reviewSlotReserved ? "true" : "false"}>
          <TurnReviewBar items={reviewItems}
            active={reviewActive}
            busy={Boolean(snapshot.busy || routeSnapshot.commandBusy)}
            sessionId={draftMode ? "" : String(sessionAddress || routeSnapshot.sessionId || "")}
            cwd={String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || "")} />
        </div>
        <Composer
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={!draftMode && Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          focusRequest={composerFocusRequest}
          historyScope={draftMode ? `new-task:${activeProjectPath || 'local'}`
            : String(routeSnapshot.sessionId || routeSnapshot.currentProject ||
              routeSnapshot.project || routeSnapshot.cwd || 'new-task')}
          identityScope={draftMode ? `draft:${draftId || 'default'}`
            : String(routeSnapshot.sessionId || routeSnapshot.currentProject ||
              routeSnapshot.project || routeSnapshot.cwd || 'new-task')}
          recoveryScope={transcriptIdentity.current}
          projectScope={draftMode ? activeProjectPath
            : String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '')}
          sessionId={draftMode ? '' : String(routeSnapshot.sessionId || '')}
          hasConversation={itemCount > 0
            || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0)}
          promptHistoryList={routeSnapshot.promptHistoryList}
          provider={String(draftModelSelection?.provider || routeSnapshot.provider || "")}
          model={String(draftModelSelection?.model || routeSnapshot.model || "")}
          effort={String(draftModelSelection?.effort ?? routeSnapshot.effort ?? "")}
          fast={draftModelSelection?.fast ?? Boolean(routeSnapshot.fast)}
          fastCapable={Boolean(routeSnapshot.fastCapable)}
          modelParameters={draftModelSelection?.modelParameters
            || routeSnapshot.modelParameters as Record<string, string> | undefined}
          contextPercent={draftModelSelection?.contextPercent
            ?? (Number(routeSnapshot.contextPercent) || undefined)}
          draftMode={draftMode}
          onDraftModelSelection={onDraftModelSelection}
          onRoutePreferenceApplied={onRoutePreferenceApplied}
          modelAside={contextIndicator}
          queued={composerQueued}
          hiddenQueueIds={pendingPromptIds}
          pendingSubmissionIds={pendingPromptIds}
          onQueuedRestored={composerQueuedRestored}
          userMessages={composerUserMessages}
          submit={composerSubmit}
          abort={composerAbort}
          invokeResult={composerInvokeResult}
          applySnapshot={composerApplySnapshot}
          onNewTask={composerOnNewTask}
          onClearToNewTask={onClearToNewTask ? composerOnClearToNewTask : undefined}
          onResumeSession={composerOnResumeSession}
          onOpenSessions={composerOnOpenSessions}
          onOpenProjects={composerOnOpenProjects}
          onOpenSettings={composerOnOpenSettings}
          onOpenCommandSurface={composerOnOpenCommandSurface}
          paneActive={reviewActive}
          dropTargetRef={conversation} />
      </div>}
    </section>
  );
}
