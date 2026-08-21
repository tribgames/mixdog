import { ChevronRight, Code2, FileDiff, FoldVertical, GitFork, Layers3, ListTree, X } from "lucide-react";
import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { resolveContextDisplayUsage } from "./context-usage";
import { type Snapshot, type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { DiffView } from "./lazy-widgets";
import { MarkdownSourceFallback } from "./MarkdownSourceFallback";
import { useMobileBack } from "./mobile-back";
import { isMobileRemoteSurface } from "./mobile-surface";
import { MxIcon } from "./MxIcon";
import { showDesktopToast } from "./notifications";
import { ProgressSpinner } from "./ProgressSpinner";
import { normalizeApplyPatch, parseUnifiedDiff } from "./renderer-logic.mjs";
import { shouldOfferSessionInheritance } from "./session-inheritance";
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  isPlainTextMarkdown,
  resolveStreamingMarkdownChunks,
} from "./streaming-markdown";
import StreamingMarkdownBody from "./StreamingMarkdownBody";
import { touchPrimaryPointer } from "./surface-input-focus";
import { asRecord, copyTextToClipboard, formatElapsed, oneLine, publicThinkingSummary } from "./text-format";
import { acquireTitleBarDim } from "./titlebar-dim";
import {
  createTranscriptRowMeasureScheduler,
  requestTranscriptRowMeasure,
} from "./transcript-measure";
import { imagePreviewCache, imagePreviewKey } from "./transcript-metrics";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { aggregateToolCategoryEntries, classifyToolCategory, formatAggregateHeader, formatToolSurface } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel, deriveToolOutcomeTone, splitLineDeltaTokens } from "../../../../src/runtime/shared/tool-card-model.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText, isTranscriptCancelledStatusText } from "../../../../src/runtime/shared/tool-execution-contract.mjs";
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from "../../../../src/tui/spinner-verbs.mjs";
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { buildSpinnerMeta } from "../../../../src/tui/spinner-meta.mjs";
import { stripInjectedDisplayText, stripSessionEnvelope } from "../shared/session-title.mjs";

interface ToolCardModel {
  pending: boolean;
  labelText: string;
  summaryText: string;
  headerFailureText: string;
  detailLine: string;
  detailIsPlaceholder: boolean;
  terminalStatus: string;
}
interface DetailLinePart { text: string; delta?: "+" | "-" }

export const TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

// Desktop token readouts stay compact and use uppercase K/M units.
const compactTokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});
const TOOL_DISCLOSURE_LIMIT = 1_000;
const toolDisclosureStates = new Map<string, boolean>();

function toolDisclosureKey(item: TranscriptItem, scope: string): string {
  const id = String(item.id ?? "").trim();
  return id ? `${scope}:${id}` : "";
}

function rememberToolDisclosure(key: string, open: boolean): void {
  if (!key) return;
  toolDisclosureStates.delete(key);
  toolDisclosureStates.set(key, open);
  while (toolDisclosureStates.size > TOOL_DISCLOSURE_LIMIT) {
    const oldest = toolDisclosureStates.keys().next().value;
    if (typeof oldest !== "string") break;
    toolDisclosureStates.delete(oldest);
  }
}

// Disclosure memory is VISIT-scoped (user contract): within one stay in a
// session it survives virtualization and streaming remounts, but re-entering
// the session always starts every tool card collapsed — stale expansions from
// an earlier visit made transcripts open "randomly" pre-expanded.
export function resetToolDisclosureScope(scope: string): void {
  if (!scope) return;
  const prefix = `${scope}:`;
  for (const key of [...toolDisclosureStates.keys()]) {
    if (key.startsWith(prefix)) toolDisclosureStates.delete(key);
  }
}

export function formatTokenCount(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1000) return compactTokenFormatter.format(tokens).toUpperCase();
  return String(Math.round(tokens));
}

export function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const text = String(value || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatWorkElapsed(value: unknown): string {
  const elapsed = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "";
  const days = Math.floor(elapsed / 86_400_000);
  const hours = Math.floor((elapsed % 86_400_000) / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function LiveWorkStatus({ snapshot, now: fixedNow }: { snapshot: Snapshot; now?: number }) {
  const [clock, setClock] = useState(() => fixedNow ?? Date.now());
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  const taggedRunningKeys = new Set<string>();
  let untaggedRunningCount = 0;
  let oldestAgentStart = Infinity;
  workers.forEach((worker) => {
    const tag = String(worker.tag || worker.agent || worker.name || "").trim();
    if (TERMINAL_AGENT_STATUS.test(String(worker.stage || worker.status || ""))) return;
    if (tag) taggedRunningKeys.add(tag);
    else untaggedRunningCount += 1;
    const startedAt = timeMs(worker.startedAt || worker.startTime || worker.createdAt);
    if (startedAt > 0) oldestAgentStart = Math.min(oldestAgentStart, startedAt);
  });
  jobs.forEach((job) => {
    if (!/running|pending|queued|starting/i.test(String(job.status || job.stage || ""))) return;
    const tag = String(job.tag || job.agent || job.type || job.task_id || job.taskId || "").trim();
    if (tag) taggedRunningKeys.add(tag);
    else untaggedRunningCount += 1;
    const startedAt = timeMs(job.startedAt);
    if (startedAt > 0) oldestAgentStart = Math.min(oldestAgentStart, startedAt);
  });
  const workerCount = taggedRunningKeys.size + untaggedRunningCount;
  const tools = snapshot.activeTools || {};
  const webSearchCount = Math.max(0, Number(tools.web_search?.count) || 0);
  const agentCount = Math.max(workerCount, Math.max(0, Number(tools.agent?.count) || 0));
  const shellCount = Math.max(
    Math.max(0, Number(snapshot.shellJobs?.count) || 0),
    Math.max(0, Number(tools.shell?.count) || 0),
  );
  const active = agentCount > 0 || webSearchCount > 0 || shellCount > 0;
  useEffect(() => {
    if (fixedNow !== undefined || !active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, fixedNow]);
  if (!active) return null;
  // Aggregate chip (user decision): ONE quiet spinner+count left of the
  // context gauge; the per-activity breakdown lives in a hover popover.
  const total = agentCount + webSearchCount + shellCount;
  // Both cells always render: the card's label/value columns are ONE grid, so
  // a dropped value cell would pull the next row's label out of column one.
  const row = (key: string, label: string, elapsed: string) => <div className="live-work-row" key={key}>
    <span>{label}</span>
    <small>{elapsed}</small>
  </div>;
  return <div className="live-work-status" role="status" tabIndex={0}
    aria-label={t("Background activity: {{count}} running", { count: total })}>
    {/* 16px matches the optical weight of the neighboring 18–20px controls;
        13px read as vertically off next to them (user). */}
    <ProgressSpinner className="live-work-spinner" size={16} aria-hidden="true" />
    <span className="live-work-count">{total}</span>
    <div className="live-work-popover" role="tooltip">
      {agentCount > 0 && row("agents", `${agentCount === 1 ? t("Agent") : t("Agents")} ${agentCount}`,
        Number.isFinite(oldestAgentStart)
          ? formatWorkElapsed(clock - oldestAgentStart)
          : tools.agent?.startedAt ? formatWorkElapsed(clock - Number(tools.agent.startedAt)) : "")}
      {webSearchCount > 0 && row("web_search", t("Web search"),
        tools.web_search?.startedAt ? formatWorkElapsed(clock - Number(tools.web_search.startedAt)) : "")}
      {shellCount > 0 && row("shells", `${t("Shell")} ${shellCount}`,
        String(snapshot.shellJobs?.elapsedLabel || "")
          || (tools.shell?.startedAt ? formatWorkElapsed(clock - Number(tools.shell.startedAt)) : ""))}
    </div>
  </div>;
}

const CONTEXT_USAGE_MEMORY_LIMIT = 64;
const rememberedContextUsage = new Map<string, ReturnType<typeof resolveContextDisplayUsage>>();

function contextMetrics(snapshot: Snapshot) {
  // Boot stability (user: the gauge flashed then vanished on New task): the
  // gauge is ALWAYS mounted — before a session, and for a session whose
  // context tokens have not been computed yet, it reads 0% instead of
  // unmounting, so the header never pops in and out.
  const usage = resolveContextDisplayUsage(snapshot);
  const sessionId = String(snapshot.sessionId || "").trim();
  if (!sessionId) return usage;
  // Source stickiness (user: the gauge jumped 0%↔real on pane focus swaps):
  // disk-peek lane frames carry NO stats/window fields at all, which is
  // "unknown", not "empty". A frame WITH a stats record is authoritative —
  // including genuine zeros after /clear — and refreshes the memory.
  const stats = asRecord(snapshot.stats) ?? {};
  const hasContextReading = Object.hasOwn(stats, "currentContextTokens")
    || Object.hasOwn(stats, "currentEstimatedContextTokens");
  // Cost-only and transport-bootstrap stats objects are incomplete, not a
  // context reset. Only an explicit reading with a resolved limit may replace
  // the remembered value; explicit zero still clears correctly after /clear.
  if (hasContextReading && usage.limit > 0) {
    rememberedContextUsage.delete(sessionId);
    rememberedContextUsage.set(sessionId, usage);
    while (rememberedContextUsage.size > CONTEXT_USAGE_MEMORY_LIMIT) {
      const oldest = rememberedContextUsage.keys().next().value;
      if (typeof oldest !== "string") break;
      rememberedContextUsage.delete(oldest);
    }
    return usage;
  }
  return rememberedContextUsage.get(sessionId) ?? usage;
}

export function ContextUsageIndicator({ snapshot, open: controlledOpen, onOpenChange, onInherit }: {
  snapshot: Snapshot;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onInherit?: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const popoverOpen = controlledOpen ?? localOpen;
  const setPopoverOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);
  const [pinned, setPinned] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const context = contextMetrics(snapshot);
  const touch = touchPrimaryPointer();
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setPopoverOpen(false);
      }
    };
    // A touch surface taps this card open because it has no hover to read it
    // with, so a pointer landing anywhere else has to close it again.
    const pointerdown = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && host.current?.contains(target)) return;
      setPinned(false);
      setPopoverOpen(false);
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown, true);
    };
  }, [setPopoverOpen]);
  useEffect(() => {
    if (controlledOpen === false) setPinned(false);
  }, [controlledOpen]);
  useMobileBack(popoverOpen, () => {
    setPinned(false);
    setPopoverOpen(false);
  });
  const descriptionId = `context-usage-${String(snapshot.sessionId || "session")}`;
  // Quota grammar (user: 한도처럼 %따라서 색): the ring adopts the SAME 70/90
  // thresholds the subscription usage meters use, so a filling context window
  // warns in the one language the app already speaks.
  const tone = !context ? ""
    : context.percent >= 90 ? "danger"
      : context.percent >= 70 ? "warning" : "";
  // Hover and keyboard focus are the WHOLE affordance (user: 클릭 시 나오는
  // 팝업/화면전환은 필요없음): the gauge no longer opens the context surface,
  // which stays on /context. A coarse pointer has no hover, so there a tap
  // toggles the same card instead — and the mouse handlers stand down, because
  // a tap also fires a synthetic mouseenter that would fight that toggle.
  const [compacting, setCompacting] = useState(false);
  const state = asRecord(snapshot);
  const sessionId = String(state?.sessionId || "").trim();
  const compactBusy = compacting || Boolean(state?.busy) || Boolean(state?.commandBusy);
  const offerInheritance = Boolean(onInherit) && shouldOfferSessionInheritance(snapshot);
  const compact = async () => {
    if (!sessionId || compactBusy) return;
    setCompacting(true);
    try {
      await window.mixdogDesktop.invokeCapability({ capability: "compact", sessionId });
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setCompacting(false);
    }
  };
  return <div className="session-context-indicator" ref={host}
    data-active={context ? "true" : "false"}
    {...(tone ? { "data-tone": tone } : {})}
    data-open={popoverOpen ? "true" : "false"}
    onMouseEnter={() => { if (!touch) setPopoverOpen(true); }}
    onMouseLeave={() => { if (!touch && !pinned) setPopoverOpen(false); }}>
    <button type="button" onClick={() => {
      if (!context) return;
      const next = !pinned;
      setPinned(next);
      setPopoverOpen(next || (!touch && host.current?.matches(":hover") === true));
    }} onFocus={() => {
      setPopoverOpen(true);
    }} onBlur={(event) => {
      if (!pinned && !host.current?.contains(event.relatedTarget)) setPopoverOpen(false);
    }} aria-label={context ? t("Context usage") : t("Context unavailable")}
      aria-expanded={popoverOpen}
      aria-describedby={context ? descriptionId : undefined}
      disabled={!context}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="8" />
        <circle className="context-usage-value" cx="10" cy="10" r="8"
          pathLength="100" strokeDasharray={`${context?.percent ?? 0} 100`} />
      </svg>
    </button>
    {context && <div className="session-context-popover" id={descriptionId} role="tooltip">
      <div><span>{t("Usage")}</span><b>{context.percent}%</b></div>
      <div><span>{context.estimated ? t("Tokens (est.)") : t("Tokens")}</span><b
        title={context.limit > 0
          ? `${context.used.toLocaleString()} / ${context.limit.toLocaleString()}`
          : context.used.toLocaleString()}>{context.limit > 0
          ? `${formatTokenCount(context.used)} / ${formatTokenCount(context.limit)}`
          : formatTokenCount(context.used)}</b></div>
      {(() => {
        const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
        return cost > 0
          ? <div><span>{t("Cost")}</span><b>${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}</b></div>
          : null;
      })()}
      {/* The readout that reports the pressure now relieves it too (user:
          호버하거나 클릭하면 나오는 곳에 컨텍스트 압축 버튼), so /compact and
          auto-compact are no longer the only ways in. */}
      {offerInheritance && <button type="button" className="context-action context-inherit"
        disabled={compactBusy} onClick={() => {
          setPinned(false);
          setPopoverOpen(false);
          onInherit?.();
        }}>
        <GitFork size={14} aria-hidden="true" />
        {t("Inherit session")}
      </button>}
      <button type="button" className="context-action context-compact" disabled={compactBusy}
        onClick={() => { void compact(); }}>
        <FoldVertical size={14} aria-hidden="true" />
        {t("Compact context")}
      </button>
    </div>}
  </div>;
}

// Localized builds keep a translated pool; the English UI draws from the full
// shared list in src/tui/spinner-verbs.mjs. t() returns the key verbatim when
// a locale has no entry, which is exactly how English is detected here.
//
// Every entry is a member of the shared pool and stays in
// ONE register: quiet mental work. "Thinking" is the honest baseline for any
// turn, and the rotation only varies its shade or depth (user decision) — no
// cooking/gardening metaphors, and nothing that claims a concrete activity the
// engine may not be doing.
const LOCALIZED_ACTIVITY_VERBS: string[] = [
  "Thinking", "Pondering", "Musing", "Mulling",
  "Ruminating", "Contemplating", "Considering", "Deliberating",
  "Cogitating", "Inferring", "Ideating", "Envisioning",
];

function activityVerbPool(): string[] {
  return t("Thinking") === "Thinking" ? (SPINNER_VERBS as string[]) : LOCALIZED_ACTIVITY_VERBS;
}

export function LiveActivity({
  snapshot,
  optimisticStartedAt = 0,
}: {
  snapshot: Snapshot;
  optimisticStartedAt?: number;
}) {
  const spinner = snapshot.spinner && snapshot.spinner.active !== false ? snapshot.spinner : null;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  const activity = spinner || command;
  const optimisticActivity = !activity && optimisticStartedAt > 0;
  // The stored value is never read: it exists only to re-render once a second
  // so the elapsed readout (computed from this render's clock) advances.
  const [, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || (optimisticActivity ? optimisticStartedAt : 0));
  // The optimistic band starts on the RENDERER clock, then the engine frame
  // lands carrying the turn's own start — a few hundred ms apart, which was
  // enough to redraw the phrase once at the top of every turn (user: 처음에
  // 엉뚱한 게 한 번 뜬다). The FIRST anchor of a turn wins; only a genuinely
  // new turn (a multi-second jump) re-anchors the pool.
  const anchorRef = useRef(0);
  // Re-entering a session REMOUNTS this band. Replaying the enter animation
  // then slid the whole status row 4px on every visit (user: 들어갈 때마다
  // 애니메이션이 다시 나와서 튄다). Only work that actually began after this
  // mount is new; a turn already in flight is restored, not started.
  const mountedAt = useRef(Date.now());
  // Pause accounting (TUI spinner parity): a turn waiting on a tool-approval
  // answer is waiting on the USER, so that time must not inflate the reported
  // duration or open the short-turn token gate.
  const pauseTurnRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef(0);
  useEffect(() => {
    if (!activity || !startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity, startedAt]);
  if (!activity && !optimisticActivity && !snapshot.thinking) {
    anchorRef.current = 0;
    return null;
  }
  const mode = String(activity?.mode
    || (snapshot.thinking ? "thinking" : optimisticActivity ? "requesting" : "responding"));
  if (mode === "resuming") {
    anchorRef.current = 0;
    return null;
  }
  const nowMs = Date.now();
  if (!anchorRef.current || (startedAt > 0 && Math.abs(startedAt - anchorRef.current) > 5_000)) {
    anchorRef.current = startedAt || nowMs;
  }
  // ONE common pool (TUI parity, src/tui/spinner-verbs.mjs): the phrase holds
  // for a 30s window anchored to the turn start, so the stream's
  // thinking→tool-use→responding flips never rewrite the label. Only true
  // state modes override it — compaction/auto-clear by name, reconnect with
  // the engine's own retry countdown.
  const overrideVerb = String(SPINNER_MODE_OVERRIDE_VERBS[mode] || "");
  const rawVerb = overrideVerb
    || (mode === "reconnecting"
      ? String(activity?.verb || "Working")
      : String(spinnerVerbFor(anchorRef.current, nowMs, activityVerbPool())));
  const verb = t(rawVerb);
  if (pauseTurnRef.current !== startedAt) {
    pauseTurnRef.current = startedAt;
    pausedTotalRef.current = 0;
    pauseStartRef.current = 0;
  }
  const approvalPaused = Boolean(snapshot.toolApproval);
  if (approvalPaused && !pauseStartRef.current) {
    pauseStartRef.current = nowMs;
  } else if (!approvalPaused && pauseStartRef.current) {
    pausedTotalRef.current += Math.max(0, nowMs - pauseStartRef.current);
    pauseStartRef.current = 0;
  }
  const pausedMs = pausedTotalRef.current
    + (pauseStartRef.current ? Math.max(0, nowMs - pauseStartRef.current) : 0);
  // `now` only exists to re-render once a second; the value itself comes from
  // this render's clock so the pause subtraction never lags a tick behind.
  const elapsedMs = startedAt ? Math.max(0, nowMs - startedAt - pausedMs) : 0;
  const elapsed = formatElapsed(elapsedMs);
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  // Byline parity with the TUI spinner (src/tui/spinner-meta.mjs): tokens stay
  // hidden on short turns, and a finished thinking span reads as "thought for
  // Ns" instead of vanishing.
  const activityRecord = asRecord(activity) || {};
  const meta = buildSpinnerMeta({
    elapsedMs,
    outputTokens,
    thinking: Boolean(activityRecord.thinking || snapshot.thinking),
    thinkingSince: Number(activityRecord.thinkingSegmentStartedAt || 0),
    thinkingMs: Number(activityRecord.thinkingAccumulatedMs || 0),
    effort: String(snapshot.effort || ""),
  });
  // ONLY the verb shimmers. The byline's elapsed/token fields change every
  // second and TextShimmer keys its span on the text, so a combined string
  // remounted the span on every tick — the sweep restarted forever and the
  // glint never travelled past the first word (user: 폰트에 도는 애니).
  const activityMeta = [
    elapsed,
    meta.showTokens ? meta.tokensText : "",
    meta.thinkingText,
  ].filter(Boolean).join(" · ");
  const reasoning = publicThinkingSummary(snapshot.thinking);
  const animateEnter = startedAt > 0 && startedAt >= mountedAt.current;
  return <div className="live-activity" data-mode={mode}>
    <div className="live-activity-status" role="status" aria-live="polite"
      data-animate={animateEnter ? "true" : undefined}>
      <span className="live-activity-icon" aria-hidden="true">
        {/* TUI parity (user: TUI가 깔끔하다) drawn as VECTOR: the terminal's
            ◇ ◆ ◈ sweep is one rhombus whose core scales, so the band never
            re-renders for animation and never depends on a symbol font. */}
        <svg className="live-activity-glyph" viewBox="0 0 12 12" aria-hidden="true">
          <g className="live-activity-glyph-spin">
            <path className="live-activity-glyph-ring" d="M6 .9 11.1 6 6 11.1.9 6Z" />
            <path className="live-activity-glyph-core" d="M6 .9 11.1 6 6 11.1.9 6Z" />
          </g>
        </svg>
      </span>
      <TextShimmer text={verb} />
      {activityMeta ? <span className="live-activity-meta">{activityMeta}</span> : null}
    </div>
    {reasoning && <details className="thinking-disclosure">
      <summary>{t("View reasoning")}</summary>
      <pre data-scrollable>{reasoning}</pre>
    </details>}
  </div>;
}

// Terminal cell width: the TUI sizes its glint in columns, where CJK occupies
// two. Reporting the same count lets the CSS express the sweep in `ch` and
// land on the rendered width in Korean and Latin alike.
const WIDE_CELL = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function shimmerCells(text: string): number {
  let cells = 0;
  for (const character of text) cells += WIDE_CELL.test(character) ? 2 : 1;
  return cells || 1;
}

export function TextShimmer({ text, active = true }: { text: string; active?: boolean }) {
  return <span data-component="text-shimmer" data-active={active ? "true" : "false"} aria-label={text}
    style={{ "--text-shimmer-cells": shimmerCells(text) } as React.CSSProperties}>
    {/* A REPLACED phrase restarts the sweep from its first cell. Both the tile
        size and the duration are derived from the phrase itself (cell count,
        element width), so reusing the previous element kept its animation
        PROGRESS and teleported the glint into the middle of the new phrase —
        the visible flick on every tool-title or status-verb swap. */}
    <span key={text} data-slot="text-shimmer-char" data-run={active ? "true" : "false"}
      aria-hidden="true">{text}</span>
  </span>;
}

export function completionTone(item: TranscriptItem): "complete" | "failed" | "interrupted" | "compaction" {
  const label = String(item.label || item.status || "").trim();
  const status = String(item.status || "").toLowerCase();
  if (status === "failed" || item.tone === "error" || /failed|error/i.test(label)) return "failed";
  if (/^(?:cancelled|canceled|aborted|interrupted)$/.test(status)
    || /cancelled|canceled|aborted|interrupted/i.test(label)) return "interrupted";
  if (item.kind === "statusdone" && /compact/i.test(label)) return "compaction";
  return "complete";
}

export function CompletionStatus({
  item,
  animate = false,
}: {
  item: TranscriptItem;
  animate?: boolean;
}) {
  const tone = completionTone(item);
  const label = String(item.label || item.status || "");
  if (tone === "failed" || tone === "interrupted") {
    const elapsed = formatElapsed(item.elapsedMs);
    const fallback = tone === "failed"
      ? t("Failed")
      : elapsed ? t("Cancelled after {{elapsed}}", { elapsed }) : t("Cancelled");
    const visible = tone === "failed" && !/^(done|complete|completed)$/i.test(label) ? label || fallback : fallback;
    return <div className={`turn-status ${tone}`} role="status"
      data-animate={animate ? "true" : undefined}>
      <X className="turn-status-icon" size={16} aria-hidden="true" />
      <span>{visible}</span>
    </div>;
  }
  if (tone === "compaction") {
    return <div className="compaction-divider" role="status"
      data-animate={animate ? "true" : undefined}>
      {/* NOT Layers3 — that is the default TOOL glyph (see toolIcon below), so
          the compaction row was drawing the exact same mark as the `Read 7
          files` rows around it and read as one of them (user: 컴팩트 같은
          거에는 아이콘을 빼든 다른 걸 쓰든). A fold says what happened: two
          halves of the thread pressed into one. */}
      <FoldVertical className="compaction-icon" size={16} aria-hidden="true" />
      <span>{label || t("Conversation compacted")}</span>
      {item.detail && <small>{item.detail}</small>}
    </div>;
  }
  const elapsed = formatElapsed(item.elapsedMs);
  // The engine authors the completion verb in English (TUI parity); the whole
  // phrase is one key so each locale controls its own word order.
  const doneVerb = String(item.verb || item.label || "Thought").trim() || "Thought";
  const completionLabel = item.kind === "turndone"
    ? (elapsed ? t("{{verb}} for {{elapsed}}", { verb: t(doneVerb), elapsed }) : t(doneVerb))
    : label || t("Complete");
  return <div className="turn-status complete" role="status"
    data-animate={animate ? "true" : undefined}>
    {/* No check badge: the settled turn is a quiet ◈ marker row like the TUI's
        TurnDone line. The glyph is a CSS ::before so the row's text stays
        exactly the completion phrase. */}
    <span>{completionLabel}</span>
    {item.kind === "statusdone" && item.detail && <small>· {item.detail}</small>}
  </div>;
}

export function CopyControl({ value, label, className, tooltipSide = "top" }: {
  value: string;
  label: string;
  className: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const copiedTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copy = async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className={className} onClick={() => void copy()}
    aria-label={copied ? t("Copied") : t(label)} data-copied={copied || undefined}
    data-tooltip={copied ? t("Copied") : t("Copy")} data-tooltip-side={tooltipSide}>
    {copied ? <MxIcon name="check" size={14} /> : <MxIcon name="copy" size={14} />}
  </button>;
}

let markdownBodyReady = false;
let markdownBodyPromise: Promise<typeof import("./MarkdownBody")> | null = null;
let streamingMarkdownBodyPromise: Promise<typeof import("./StreamingMarkdownBody")> | null = null;
export function isMarkdownBodyReady() {
  return markdownBodyReady;
}
export function preloadMarkdownBody() {
  markdownBodyPromise ||= (async () => {
    // Capture-only race hook: a cold probe can force IPC to beat the lazy
    // chunk and prove that App keeps the transcript neutral until rich
    // Markdown is ready. Production never defines this property.
    const probeWindow = window as typeof window & { __mixdogMarkdownPreloadDelayMs?: number };
    const delayMs = Math.max(0, Number(probeWindow.__mixdogMarkdownPreloadDelayMs || 0));
    probeWindow.__mixdogMarkdownPreloadDelayMs = 0;
    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
    const module = await import("./MarkdownBody");
    markdownBodyReady = true;
    return module;
  })().catch((error) => {
    markdownBodyPromise = null;
    throw error;
  });
  return markdownBodyPromise;
}
export const MarkdownBody = lazy(preloadMarkdownBody);
export function preloadStreamingMarkdownBody() {
  streamingMarkdownBodyPromise ||= import("./StreamingMarkdownBody").catch((error) => {
    streamingMarkdownBodyPromise = null;
    throw error;
  });
  return streamingMarkdownBodyPromise;
}
const StableMarkdownBody = React.memo(function StableMarkdownBody({ text }: { text: string }) {
  if (isPlainTextMarkdown(text)) return <p>{text}</p>;
  return <MarkdownBody text={text} copyControl={CopyControl} />;
});

export const MarkdownResponse = React.memo(function MarkdownResponse({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const markdownCache = useRef(createStreamingMarkdownCache());
  const markdownRoot = useRef<HTMLDivElement>(null);
  const scheduleMarkdownMeasure = useMemo(
    () => createTranscriptRowMeasureScheduler(
      () => requestTranscriptRowMeasure(markdownRoot.current),
    ),
    [],
  );
  const workerPipeline = useRef(streaming);
  if (streaming) workerPipeline.current = true;
  // Renderer snapshots are already frame-coalesced. Adding another rAF here
  // commits DOM growth after the current ResizeObserver delivery and leaves
  // one painted frame off-bottom. Each arriving delta is projected
  // immediately and the scroll owner locks the resulting layout.
  const markdownParts = resolveStreamingMarkdownChunks(text, streaming, markdownCache.current);
  const renderedChunks = markdownParts.stableChunks.map((chunk, index) => (
    <Suspense fallback={<MarkdownSourceFallback text={chunk} copyControl={CopyControl} />}
      key={markdownParts.stableChunkKeys[index]}>
      {workerPipeline.current
        ? <StreamingMarkdownBody text={chunk}
            copyControl={CopyControl} onRendered={scheduleMarkdownMeasure} />
        : <StableMarkdownBody text={chunk} />}
    </Suspense>
  ));
  if (markdownParts.unstableText) {
    // The live tail is healed before parsing, so an unfinished
    // "**bold" or "`code" is already styled while the model types.
    const unstableParseText = streaming
      ? healStreamingMarkdownTail(markdownParts.unstableText)
      : markdownParts.unstableText;
    renderedChunks.push(
      <Suspense
        fallback={<MarkdownSourceFallback text={markdownParts.unstableText} copyControl={CopyControl} />}
        key={markdownParts.unstableKey}>
        {workerPipeline.current
          ? <StreamingMarkdownBody
              text={markdownParts.unstableText}
              parseText={unstableParseText}
              parse={markdownParts.parseUnstable}
              copyControl={CopyControl}
              onRendered={scheduleMarkdownMeasure} />
          : <StableMarkdownBody text={markdownParts.unstableText} />}
      </Suspense>,
    );
  }
  return <div className={`markdown ${streaming ? "streaming" : ""}`} ref={markdownRoot}>
    {renderedChunks}
  </div>;
});

const transcriptItemSignatures = new WeakMap<object, string>();

export function transcriptItemSignature(item: TranscriptItem | undefined): string {
  if (!item) return "";
  const cached = transcriptItemSignatures.get(item);
  if (cached !== undefined) return cached;
  let signature: string;
  try {
    signature = JSON.stringify(item);
  } catch {
    return "";
  }
  transcriptItemSignatures.set(item, signature);
  return signature;
}

export function transcriptItemsEqual(
  previous: TranscriptItem | undefined,
  next: TranscriptItem | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  // The live tail must render whenever its object changes. Serializing its
  // entire growing text merely to prove that it changed made a long response
  // pay O(total streamed text) before every React commit.
  if (previous.streaming || next.streaming) return false;
  return transcriptItemSignature(previous) === transcriptItemSignature(next);
}

export function messageMetadata(item: TranscriptItem) {
  const shortTime = typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0
    ? new Date(item.at).toLocaleTimeString(undefined, { timeStyle: "short" })
    : "";
  return { shortTime };
}

// The transcript renders attached images as chips, so the raw composer token
// ("[Image #N: name]") in the message text is redundant noise there.
function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Chip-only pasted text keeps its "[Pasted text #N +M lines]" token in the
// outgoing prompt (the daemon expands it in place); the transcript folds the
// raw token back into the compact chip the composer showed.
interface PastedTextChip { name: string }
function extractPastedTextMarkers(text: string): { text: string; chips: PastedTextChip[] } {
  const chips: PastedTextChip[] = [];
  const stripped = String(text || "").replace(/ ?\[Pasted text #\d+ \+(\d+) lines\] ?/g, (_match, lines) => {
    chips.push({ name: `Pasted text · ${lines} lines` });
    return " ";
  });
  if (chips.length === 0) return { text, chips };
  const cleaned = stripped
    .split(/\r?\n/).map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, chips };
}

// TUI-side / stored-history image markers arrive as literal bracket lines in
// the user text ("[Image #2]", "[Image: source: C:\shot.png, 1027x702,
// displayed at 1027x702]", "[Image omitted from stored history: image/png]").
// Desktop folds them into compact photo chips (icon + filename + dimensions)
// instead of rendering the raw marker text.
interface ImageMarkerChip { name: string; dims: string; title: string }
function extractImageMarkers(text: string): { text: string; chips: ImageMarkerChip[] } {
  const chips: ImageMarkerChip[] = [];
  const kept: string[] = [];
  let pendingRefs = 0;
  let lastWasMeta = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^\[Image #\d+(?::[^\]]*)?\]$/.test(line)) {
      pendingRefs += 1;
      lastWasMeta = false;
      continue;
    }
    const meta = /^\[Image(?::| source:) ([^\]]+)\]$/.exec(line);
    if (meta && !/^omitted\b/i.test(meta[1])) {
      const parts = meta[1].split(/,\s*/);
      const source = (parts.find((part) => part.startsWith("source: ")) || "").slice(8).trim()
        || (line.startsWith("[Image source:") ? meta[1].trim() : "");
      const dims = parts.find((part) => /^\d+x\d+$/.test(part)) || "";
      const name = source ? (source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Image") : "Image";
      chips.push({ name, dims: dims.replace("x", "\u00D7"), title: source || line });
      if (pendingRefs > 0) pendingRefs -= 1;
      lastWasMeta = true;
      continue;
    }
    if (/^\[Image omitted from stored history[^\]]*\]$/.test(line)) {
      // Follows its metadata line in normal flow — already represented by the
      // chip above. A lone omitted marker still deserves a generic chip.
      if (!lastWasMeta) {
        chips.push({ name: "Image", dims: "", title: line });
        if (pendingRefs > 0) pendingRefs -= 1;
      }
      lastWasMeta = false;
      continue;
    }
    lastWasMeta = false;
    const inlineRefs = rawLine.match(/\[Image #\d+(?::[^\]]*)?\]/g);
    if (inlineRefs && inlineRefs.length > 0) {
      pendingRefs += inlineRefs.length;
      const strippedLine = rawLine.replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, " ").replace(/ {2,}/g, " ").trim();
      if (strippedLine) kept.push(strippedLine);
      continue;
    }
    kept.push(rawLine);
  }
  // Refs that never got a metadata/omitted line (e.g. plain "[Image #N]" from
  // an old history) still surface as generic chips so the count is honest.
  for (let index = 0; index < pendingRefs; index += 1) {
    chips.push({ name: t("Image"), dims: "", title: t("Attached image") });
  }
  return { text: kept.join("\n").trim(), chips };
}

// Webhook fires embed a trust-fencing block (directive + WEBHOOK_UNTRUSTED_DATA
// markers around headers/payload) that the MODEL needs verbatim but the user
// transcript hides entirely (user decision): only the operator-authored
// instructions remain visible as the message text.
const WEBHOOK_FENCE_RE =
  /(?:The block between the WEBHOOK_UNTRUSTED_DATA markers[^\n]*\n+)?<<<WEBHOOK_UNTRUSTED_DATA_BEGIN>>>\n?([\s\S]*?)\n?<<<WEBHOOK_UNTRUSTED_DATA_END>>>/;
function extractWebhookPayload(text: string): { text: string; payload: string } {
  const match = WEBHOOK_FENCE_RE.exec(text);
  if (!match) return { text, payload: "" };
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text: stripped, payload: (match[1] || "").trim() };
}

export function userTranscriptDisplayText(item: TranscriptItem): string {
  return stripInjectedDisplayText(stripSessionEnvelope(String(item.text || "")))
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The one visibility contract for a transcript item. The row projection uses
 * it to keep invisible rows out of the virtual list entirely, so the timeline
 * never carries zero-height placeholders.
 */
export function isVisibleTranscriptItem(item: TranscriptItem | undefined): boolean {
  if (!item) return false;
  if (item.kind === "tool") return !shouldSuppressFullyFailedToolItem(item);
  if (item.kind === "statusdone" || item.kind === "turndone" || item.kind === "notice") return true;
  if (item.kind === "assistant") return true;
  if (item.kind !== "user") return false;
  const metadataRecord = item.metadata && typeof item.metadata === "object"
    ? item.metadata as Record<string, unknown>
    : null;
  const sourceText = String(item.text || "");
  const text = userTranscriptDisplayText(item);
  return !(
    (Boolean(sourceText.trim()) && !text && !(Array.isArray(item.images) && item.images.length > 0))
    || /^(?:system|developer|synthetic|internal|hidden)$/i.test(String(item.role || item.kind || ""))
    || item.internal === true
    || item.hidden === true
    || item.synthetic === true
    || metadataRecord?.internal === true
    || metadataRecord?.hidden === true
    || metadataRecord?.synthetic === true
    || isInternalTranscriptDisplayText(text)
  );
}

function TranscriptImagePreview({
  src,
  name,
  onClose,
}: {
  src: string;
  name: string;
  onClose(): void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <div className="message-image-preview-layer" role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <section className="message-image-preview-dialog" role="dialog" aria-modal="true"
        aria-label={t("Image preview")}>
        <img src={src} alt={name} />
        <button ref={closeButton} type="button" aria-label={t("Close preview")}
          onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </section>
    </div>,
    document.body,
  );
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  completion,
  completionAnimate = false,
  attachedUser = false,
  disclosureScope = "",
}: {
  item: TranscriptItem;
  completion?: TranscriptItem;
  completionAnimate?: boolean;
  attachedUser?: boolean;
  disclosureScope?: string;
}) {
  const previousStreaming = useRef(Boolean(item.streaming));
  const [openImage, setOpenImage] = useState<{ src: string; name: string } | null>(null);
  const closeImage = useCallback(() => setOpenImage(null), []);
  const announceSettled = previousStreaming.current && !item.streaming;
  useEffect(() => {
    previousStreaming.current = Boolean(item.streaming);
  }, [item.streaming]);
  if (item.kind === "tool") {
    if (shouldSuppressFullyFailedToolItem(item)) return null;
    return <ToolCard item={item} disclosureScope={disclosureScope} />;
  }
  if (item.kind === "statusdone" || item.kind === "turndone") {
    return <CompletionStatus item={item} animate={completionAnimate} />;
  }
  if (item.kind === "notice") {
    // Warn-tone notices (watchdog abort, degraded fallback) are not neutral
    // status: they get the amber status pair, errors the danger pair.
    const tone = item.tone === "error" ? "error" : item.tone === "warn" ? "warn" : "";
    return <div className={`notice ${tone}`}
      role={item.tone === "error" ? "alert" : "status"}>{item.text}</div>;
  }
  if (item.kind !== "user" && item.kind !== "assistant") return null;
  const user = item.kind === "user";
  const text = user ? userTranscriptDisplayText(item) : String(item.text || "");
  // Crash-recovery control row: persisted as a plain user message so the next
  // model step sees where a force-killed turn stopped, but it is not human
  // chat — same Cancelled status row as a live abort (TUI turndone cancelled).
  if (user && isTranscriptCancelledStatusText(text)) {
    return <CompletionStatus item={{ kind: "turndone", status: "cancelled", elapsedMs: 0 } as TranscriptItem} />;
  }
  // The projection already dropped hidden rows; this is the final guard for a
  // row rendered outside it (the live tail, an optimistic prompt).
  if (!isVisibleTranscriptItem(item)) return null;
  const metadata = messageMetadata(item);
  // User bubbles: fold literal image markers into chips; the composer-attached
  // images (item.images) keep their thumbnail chips and win over marker chips.
  const attachedImages = user && Array.isArray(item.images) ? item.images : [];
  const imageMarkers = user ? extractImageMarkers(text) : { text, chips: [] };
  const markerChips = attachedImages.length > 0 ? [] : imageMarkers.chips;
  const userDisplayText = attachedImages.length > 0
    ? stripImageTokens(imageMarkers.text)
    : imageMarkers.text;
  const pastedFold = user ? extractPastedTextMarkers(userDisplayText)
    : { text: userDisplayText, chips: [] as PastedTextChip[] };
  const webhookFold = user ? extractWebhookPayload(pastedFold.text) : { text: pastedFold.text, payload: "" };
  return (
    <>
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"} ${item.pending ? "pending" : ""} ${user && attachedUser ? "attached-user" : ""}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}
        aria-busy={item.pending === true ? "true" : undefined}>
        <div className="message-body" onDragStart={(event) => event.preventDefault()}>
          {user ? <>
            {(attachedImages.length > 0 || markerChips.length > 0 || pastedFold.chips.length > 0)
              && <div className="message-image-chips"
              aria-label={t("Attachments")}>
              {attachedImages.map((image, index) => {
                const preview = imagePreviewCache.get(imagePreviewKey(image.id, image.bytes));
                const name = image.name || t('Attached image');
                return preview
                  ? <button type="button" className="message-image-chip message-image-chip-button"
                    key={`${image.id ?? 'img'}-${index}`} title={name}
                    aria-label={t("Open image")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => setOpenImage({ src: preview, name })}>
                    <img src={preview} alt={name} />
                  </button>
                  : <span className="message-image-chip" key={`${image.id ?? 'img'}-${index}`}
                    title={name}>
                    <span className="message-image-fallback">
                <MxIcon name="photo" size={14} />
                      <span>{image.name || 'Image'}</span>
                    </span>
                  </span>;
              })}
              {markerChips.map((chip, index) => (
                <span className="message-image-chip" key={`marker-${index}`} title={chip.title}>
                  <span className="message-image-fallback">
                    <MxIcon name="photo" size={14} />
                    <span>{chip.name}</span>
                    {chip.dims ? <small>{chip.dims}</small> : null}
                  </span>
                </span>
              ))}
              {pastedFold.chips.map((chip, index) => (
                <span className="message-image-chip message-pasted-chip" key={`pasted-${index}`} title={chip.name}>
                  <span className="message-image-fallback">
                    <MxIcon name="open-file" size={14} />
                    <span>{chip.name}</span>
                  </span>
                </span>
              ))}
            </div>}
            {webhookFold.text ? <p>{webhookFold.text}</p> : null}
          </> : (
            <MarkdownResponse text={text} streaming={Boolean(item.streaming)} />
          )}
        </div>
        {/* "Queued" only for prompts genuinely waiting behind an active turn
            (TUI parity): an in-flight idle submit is not a queue state. */}
        {user && item.pending === true && item.queuedBehindTurn === true
          && <span className="message-pending-status" role="status">
          Queued
        </span>}
        {/* No user footer. The send time + copy row rode under every prompt,
            and the phone surface forced hover-revealed chrome permanently
            visible, so it sat there on every bubble (user: 호버도 안 했는데
            항상 떠서 이상하다). The prompt carries its text alone; the
            response footer below still owns the clock and the copy control. */}
        {/* The footer belongs to a SETTLED turn only. A mid-turn preamble part
            carried a hover-only copy overlay that sat on top of the following
            tool row and hid it (user: 프리엠블에서는 복사 버튼 빼자). */}
        {!user && !item.streaming && completion && <footer className="response-footer"
          aria-label={t("Response details")}>
          <CompletionStatus item={completion} animate={completionAnimate} />
          {/* Timestamp marks the END of a turn: mid-turn assistant paragraphs
              (tool calls still running) must not carry a clock (user). */}
          {metadata.shortTime &&
            <time className="message-time">{metadata.shortTime}</time>}
          {text && <CopyControl value={text} label={t("Copy response")}
            className="message-actions response-copy" />}
        </footer>}
      </article>
      {openImage && <TranscriptImagePreview src={openImage.src} name={openImage.name}
        onClose={closeImage} />}
      {announceSettled && !completion && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Mixdog response complete.
      </p>}
    </>
  );
}, (previous, next) => (
  transcriptItemsEqual(previous.item, next.item)
  && transcriptItemsEqual(previous.completion, next.completion)
  && previous.completionAnimate === next.completionAnimate
  && previous.attachedUser === next.attachedUser
  && previous.disclosureScope === next.disclosureScope
));

function toolItemDone(item: TranscriptItem): boolean {
  return item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
}

function toolActivityItemTone(item: TranscriptItem): "error" | "warning" | "neutral" {
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const partialMutation = callFailedCount > 0
    && typeof item.uiDiff === "string"
    && Boolean(item.uiDiff.trim());
  const tone = deriveToolOutcomeTone({
    pending: !toolItemDone(item),
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: isHookApprovalDenialToolItem(item) ? "denied" : "",
    partialMutation,
  });
  return tone === "error" ? "error" : tone === "warning" ? "warning" : "neutral";
}

function mergedToolActivityCategories(items: readonly TranscriptItem[]) {
  const categories = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const add = (key: string, value: unknown) => {
    if (!key) return;
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const count = Math.max(0, Number(record.count ?? value) || 0);
    if (count <= 0) return;
    if (!categories.has(key)) order.push(key);
    const previous = categories.get(key);
    categories.set(key, {
      ...record,
      count: Number(previous?.count || 0) + count,
    });
  };

  for (const item of items) {
    const stored = item.categories && typeof item.categories === "object" && !Array.isArray(item.categories)
      ? item.categories as Record<string, unknown>
      : null;
    if (stored && Object.keys(stored).length > 0) {
      for (const [key, value] of Object.entries(stored)) add(key, value);
      continue;
    }
    const surface = formatToolSurface(item.name, item.args);
    const category = classifyToolCategory(item.name, surface.args);
    for (const entry of aggregateToolCategoryEntries(item.name, surface.args, category)) {
      add(String(entry.key || ""), entry);
    }
  }

  return { categories: Object.fromEntries(categories), order };
}

function localizedToolActivityCategory(category: string): string {
  if (category === "Read") return t("File reading");
  if (category === "Search") return t("Search");
  if (category === "Load") return t("Tool loading");
  if (category === "MCP") return t("MCP tools");
  if (category === "Skill") return t("Skills");
  if (category === "Web Research") return t("Web research");
  if (category === "Memory") return t("Memory");
  if (category === "Patch") return t("File editing");
  if (category === "Git") return t("Git");
  if (category === "Shell") return t("Command execution");
  if (category === "Agent") return t("Agents");
  if (category === "Task") return t("Tasks");
  if (category === "Schedule") return t("Schedules");
  if (category === "Channel") return t("Messages");
  if (category === "Setup") return t("Setup");
  return t("External tools");
}

export function desktopToolActivityCategorySummary(
  categories: Record<string, unknown>,
  order: readonly string[] = [],
): string {
  const totals = new Map<string, number>();
  const categoryOrder: string[] = [];
  const seenEntries = new Set<string>();
  for (const key of [...order, ...Object.keys(categories)]) {
    if (!key || seenEntries.has(key)) continue;
    seenEntries.add(key);
    const value = categories[key];
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const count = Math.max(0, Number(record.count ?? value) || 0);
    if (count <= 0) continue;
    const rawCategory = String(record.category || key.split("|")[0] || "Other");
    const category = [
      "Read", "Search", "Load", "MCP", "Skill", "Web Research", "Memory",
      "Patch", "Git", "Shell", "Agent", "Task", "Schedule", "Channel", "Setup",
    ].includes(rawCategory) ? rawCategory : "Other";
    if (!totals.has(category)) categoryOrder.push(category);
    totals.set(category, Number(totals.get(category) || 0) + count);
  }
  return categoryOrder
    .map((category) => `${localizedToolActivityCategory(category)} ${totals.get(category)}`)
    .join(" · ");
}

export function flattenedToolActivityItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  const flattened: TranscriptItem[] = [];
  for (const item of items) {
    const members = item.aggregate === true && Array.isArray(item.toolMembers)
      ? item.toolMembers
      : [];
    if (members.length === 0) {
      flattened.push(item);
      continue;
    }
    members.forEach((member, index) => {
      if (!member || typeof member !== "object" || Array.isArray(member)) return;
      const record = member as TranscriptItem;
      flattened.push({
        ...record,
        kind: "tool",
        id: record.id ?? `${String(item.id ?? "aggregate")}:member:${index}`,
      });
    });
  }
  return flattened;
}

const DESKTOP_TOOL_ACTIVITY_ALIASES = new Map([
  ["webfetch", "web_fetch"],
  ["websearch", "web_search"],
  ["patch", "apply_patch"],
  ["write", "edit"],
  ["question", "request_user_input"],
  ["todowrite", "update_plan"],
]);

function desktopToolActivityModeledName(name: unknown, args: unknown): string {
  const surface = formatToolSurface(String(name || "tool"), args);
  return DESKTOP_TOOL_ACTIVITY_ALIASES.get(surface.normalizedName)
    ?? String(name || "tool");
}

export function desktopToolActivityCategory(name: unknown, args: unknown): string {
  const modeledName = desktopToolActivityModeledName(name, args);
  const surface = formatToolSurface(modeledName, args);
  return String(classifyToolCategory(modeledName, surface.args) || "Other");
}

export function desktopToolActivityCategoryGroups(items: readonly TranscriptItem[]) {
  const groups = new Map<string, {
    category: string;
    label: string;
    count: number;
    items: TranscriptItem[];
  }>();
  for (const item of flattenedToolActivityItems(items)) {
    const category = desktopToolActivityCategory(item.name, item.args);
    const count = Math.max(1, Math.round(Number(item.count || 1)));
    const previous = groups.get(category);
    if (previous) {
      previous.count += count;
      previous.items.push(item);
      continue;
    }
    groups.set(category, {
      category,
      label: localizedToolActivityCategory(category),
      count,
      items: [item],
    });
  }
  return [...groups.values()];
}

function toolActivityDisclosureKey(items: readonly TranscriptItem[], scope: string): string {
  const id = String(items[0]?.id ?? "").trim();
  return id ? `${scope}:tool-activity:${id}` : "";
}

export function ToolActivityGroup({
  items,
  disclosureScope = "",
}: {
  items: readonly TranscriptItem[];
  disclosureScope?: string;
}) {
  const disclosureKey = toolActivityDisclosureKey(items, disclosureScope);
  const [open, setOpen] = useState(() =>
    disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  useLayoutEffect(() => {
    setOpen(disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  }, [disclosureKey]);
  const groupRef = useRef<HTMLElement>(null);
  const measuredOpen = useRef(open);
  useLayoutEffect(() => {
    if (measuredOpen.current === open) return;
    measuredOpen.current = open;
    requestTranscriptRowMeasure(groupRef.current);
  }, [open]);
  const contentId = useId();
  const mobileSurface = isMobileRemoteSurface();
  const pending = items.some((item) => !toolItemDone(item));
  const { categories, order } = useMemo(() => mergedToolActivityCategories(items), [items]);
  const desktopCategoryGroups = useMemo(
    () => desktopToolActivityCategoryGroups(items),
    [items],
  );
  const desktopCategorySummary = desktopCategoryGroups
    .map((group) => `${group.label} ${group.count}`)
    .join(" · ");
  const label = mobileSurface
    ? formatAggregateHeader(categories, { pending, order })
    : desktopCategorySummary || t("Tool use");
  const tones = items.map(toolActivityItemTone);
  const failure = tones.includes("error");
  const warning = !failure && tones.includes("warning");

  return (
    <article ref={groupRef}
      className={`tool-activity ${mobileSurface && failure ? "failed" : ""} ${mobileSurface && warning ? "warning" : ""}`}
      data-surface={mobileSurface ? "mobile" : "desktop"}
      data-open={open ? "true" : "false"}>
      <button className="tool-header tool-activity-header"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => {
          const next = !value;
          rememberToolDisclosure(disclosureKey, next);
          return next;
        })}
        aria-expanded={open} aria-controls={contentId}>
        <span className="tool-icon">
          {mobileSurface ? <ListTree size={16} /> : pending ? (
            <svg className="live-activity-glyph tool-activity-pending-glyph"
              viewBox="0 0 12 12" aria-hidden="true">
              <g className="live-activity-glyph-spin">
                <path className="live-activity-glyph-ring" d="M6 .9 11.1 6 6 11.1.9 6Z" />
                <path className="live-activity-glyph-core" d="M6 .9 11.1 6 6 11.1.9 6Z" />
              </g>
            </svg>
          ) : <Layers3 size={16} />}
        </span>
        <span className="tool-title tool-activity-title" title={label}>
          <b>{label}</b>
        </span>
        {pending && <span className="sr-only" role="status">{t("Running")}</span>}
        <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>
      </button>
      {open && (
        <div className="tool-activity-content" id={contentId}>
          {mobileSurface
            ? items.map((item, index) => (
                <ToolCard key={String(item.id ?? index)} item={item}
                  disclosureScope={disclosureScope} />
              ))
            : <DesktopToolActivityDetails groups={desktopCategoryGroups}
                disclosureKey={disclosureKey} />}
        </div>
      )}
    </article>
  );
}

function activityItemKey(item: TranscriptItem, index: number): string {
  return String(item.id ?? `${String(item.name || "tool")}:${index}`);
}

function disclosureChildKey(parent: string, kind: "category" | "item", id: string): string {
  return parent ? `${parent}:${kind}:${id}` : "";
}

function DesktopToolActivityDetails({
  groups,
  disclosureKey,
}: {
  groups: ReturnType<typeof desktopToolActivityCategoryGroups>;
  disclosureKey: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const allItems = groups.flatMap((group) => group.items);
  const rememberedCategory = () => groups.find((group) =>
    toolDisclosureStates.get(disclosureChildKey(disclosureKey, "category", group.category)) === true)
    ?.category ?? null;
  const rememberedItem = () => allItems.find((item, index) =>
    toolDisclosureStates.get(disclosureChildKey(
      disclosureKey,
      "item",
      activityItemKey(item, index),
    )) === true);
  const [openCategory, setOpenCategory] = useState<string | null>(rememberedCategory);
  const [openItem, setOpenItem] = useState<string | null>(() => {
    const item = rememberedItem();
    return item ? activityItemKey(item, allItems.indexOf(item)) : null;
  });
  useLayoutEffect(() => {
    setOpenCategory(rememberedCategory());
    const item = rememberedItem();
    setOpenItem(item ? activityItemKey(item, allItems.indexOf(item)) : null);
  }, [disclosureKey, groups]);
  useLayoutEffect(() => {
    requestTranscriptRowMeasure(rootRef.current);
  }, [openCategory, openItem]);

  const toggleCategory = (category: string) => {
    const next = openCategory === category ? null : category;
    if (openCategory) {
      rememberToolDisclosure(
        disclosureChildKey(disclosureKey, "category", openCategory),
        false,
      );
    }
    rememberToolDisclosure(
      disclosureChildKey(disclosureKey, "category", category),
      next !== null,
    );
    if (openItem) {
      rememberToolDisclosure(disclosureChildKey(disclosureKey, "item", openItem), false);
      setOpenItem(null);
    }
    setOpenCategory(next);
  };

  const toggleItem = (key: string) => {
    const next = openItem === key ? null : key;
    if (openItem) {
      rememberToolDisclosure(disclosureChildKey(disclosureKey, "item", openItem), false);
    }
    rememberToolDisclosure(
      disclosureChildKey(disclosureKey, "item", key),
      next !== null,
    );
    setOpenItem(next);
  };

  let itemIndex = 0;
  return (
    <div ref={rootRef} className="tool-activity-desktop-details">
      {groups.map((group, groupIndex) => {
        const groupItems = group.items.map((item) => ({
          item,
          index: itemIndex++,
        }));
        if (group.items.length <= 1) {
          const entry = groupItems[0];
          if (!entry) return null;
          const key = activityItemKey(entry.item, entry.index);
          return <DesktopToolActivityItem key={key} item={entry.item}
            open={openItem === key} onToggle={() => toggleItem(key)}
            contentId={`${contentId}-item-${entry.index}`} />;
        }
        const categoryOpen = openCategory === group.category;
        const categoryPending = group.items.some((item) => !toolItemDone(item));
        const categoryContentId = `${contentId}-category-${groupIndex}`;
        return (
          <section className="tool-activity-category"
            data-open={categoryOpen ? "true" : "false"} key={group.category}>
            <button type="button" className="tool-header tool-activity-category-header"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => toggleCategory(group.category)}
              aria-expanded={categoryOpen} aria-controls={categoryContentId}>
              <span className="tool-icon">{toolIcon(group.category)}</span>
              <span className="tool-title tool-activity-category-title">
                <b>{group.label}</b>
                <small>{group.count}</small>
              </span>
              {categoryPending && <span className="sr-only" role="status">{t("Running")}</span>}
              <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>
            </button>
            {categoryOpen && (
              <div className="tool-activity-category-items" id={categoryContentId}>
                {groupItems.map(({ item, index }) => {
                  const key = activityItemKey(item, index);
                  return <DesktopToolActivityItem key={key} item={item}
                    open={openItem === key} onToggle={() => toggleItem(key)}
                    contentId={`${contentId}-item-${index}`} />;
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

const TOOL_ACTIVITY_INTERNAL_ARGS = new Set([
  "categoryOrder",
  "loadingTargets",
  "agentBatch",
  "verifyShell",
]);
const TOOL_ACTIVITY_BULK_ARGS = new Set([
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "old_str",
  "new_str",
  "content",
  "patch",
]);

const TOOL_ACTIVITY_SECRET_ARG = /(?:password|secret|token|api[_-]?key|authorization|cookie)/i;
const TOOL_ACTIVITY_ROUTINE_RESULT = /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|saved|loaded|cancelled)[.!]?$/i;
const TOOL_ACTIVITY_MEANINGLESS_RESULT = /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|loaded)[.!]?$/i;

type ToolActivityStructuredKind = "plan" | "todos" | "questions" | "";

interface ToolActivityStructuredRow {
  text: string;
  status: string;
  answer?: string;
}

export interface DesktopToolActivityItemPresentation {
  category: string;
  title: string;
  subject: string;
  resultLabel: string;
  pending: boolean;
  tone: string;
  command: string;
  fields: Array<{ key: string; label: string; value: string }>;
  diffPatch: string;
  outputText: string;
  metaText: string;
  previewLabel: string;
  previewText: string;
  beforeText: string;
  afterText: string;
  structuredKind: ToolActivityStructuredKind;
  structuredRows: ToolActivityStructuredRow[];
  hasDetails: boolean;
  hideSubjectWhenOpen: boolean;
}

function toolActivityInline(value: unknown, max = 500): string {
  return oneLine(boundedTextOf(value, max)).trim();
}

function toolActivityFirstText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function toolActivityStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean);
}

function toolActivityCompact(parts: Array<string | undefined>): string {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" · ");
}

function toolActivityQuoted(value: unknown): string {
  const text = toolActivityInline(value, 300);
  return text ? `"${text}"` : "";
}

function toolActivityCommand(args: Record<string, unknown>): string {
  const direct = toolActivityFirstText(args, "command", "cmd", "description");
  if (direct) return direct;
  const commands = toolActivityStringList(args.commands);
  return commands.join("\n");
}

function toolActivityPath(args: Record<string, unknown>): string {
  return toolActivityFirstText(args, "file_path", "filePath", "path", "file", "target");
}

function toolActivitySubject(
  normalizedName: string,
  args: Record<string, unknown>,
  fallback: string,
): string {
  const path = toolActivityPath(args);
  switch (normalizedName) {
    case "read": {
      const paths = toolActivityStringList(args.file_path ?? args.path);
      const target = paths.length > 1 ? `${paths.length} files` : path;
      const offset = Number(args.offset);
      const limit = Number(args.limit);
      const window = Number.isFinite(offset) && offset > 0 && Number.isFinite(limit) && limit > 0
        ? `lines ${offset}-${offset + limit - 1}`
        : Number.isFinite(offset) && offset > 0
          ? `from line ${offset}`
          : Number.isFinite(limit) && limit > 0 ? `${limit} lines` : "";
      return toolActivityCompact([target, window]);
    }
    case "view_image":
    case "read_mcp_resource":
      return path || toolActivityFirstText(args, "uri");
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      return path;
    case "apply_patch":
      return fallback;
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
    case "git":
      return toolActivityInline(toolActivityCommand(args), 1_000);
    case "git_stage": {
      const files = toolActivityStringList(args.files ?? args.paths);
      return files.length > 2 ? `${files.length} files` : files.join(", ");
    }
    case "grep": {
      const patterns = toolActivityStringList(args.pattern ?? args.query);
      const pattern = patterns.length > 1
        ? `${patterns.length} patterns`
        : toolActivityQuoted(args.pattern ?? args.query);
      return toolActivityCompact([
        pattern,
        args.path ? `in ${toolActivityInline(args.path)}` : "",
        args.glob ? toolActivityInline(args.glob) : "",
      ]);
    }
    case "glob": {
      const patterns = toolActivityStringList(args.pattern ?? args.glob);
      const pattern = patterns.length > 1
        ? `${patterns.length} globs`
        : toolActivityInline(args.pattern ?? args.glob);
      return toolActivityCompact([pattern, args.path ? `in ${toolActivityInline(args.path)}` : ""]);
    }
    case "find": {
      const queries = toolActivityStringList(args.query ?? args.fuzzy);
      const query = queries.length > 1
        ? `${queries.length} queries`
        : toolActivityQuoted(args.query ?? args.fuzzy);
      return toolActivityCompact([query, args.path ? `in ${toolActivityInline(args.path)}` : ""]);
    }
    case "list":
    case "ls":
      return toolActivityCompact([
        path,
        args.limit ? `${toolActivityInline(args.limit)} entries` : "",
      ]);
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      return toolActivityQuoted(args.query ?? args.keywords);
    case "web_fetch":
    case "fetch":
      return toolActivityInline(args.url ?? args.uri ?? fallback, 1_000);
    case "load_tool": {
      const names = [
        ...toolActivityStringList(args.names),
        ...toolActivityStringList(args.select),
      ];
      return names.join(", ") || fallback;
    }
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      return toolActivityFirstText(args, "name", "skill", "skill_name", "query") || fallback;
    case "task":
      return toolActivityCompact([
        toolActivityFirstText(args, "action"),
        toolActivityFirstText(args, "task_id", "id"),
      ]);
    case "agent":
    case "bridge":
      return toolActivityFirstText(args, "description", "tag", "role", "model")
        || fallback;
    case "request_user_input": {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      return questions.length ? `${questions.length} ${questions.length === 1 ? "question" : "questions"}` : "";
    }
    case "update_plan":
      return "";
    default:
      return fallback;
  }
}

function toolActivityTitle(
  normalizedName: string,
  originalName: string,
  surfaceLabel: string,
  args: Record<string, unknown>,
): string {
  if (originalName === "write") return "Write";
  if (originalName === "question") return "Questions";
  if (originalName === "todowrite" || Array.isArray(args.todos)) return "Todos";
  switch (normalizedName) {
    case "read": return "Read";
    case "view_image": return "Image";
    case "read_mcp_resource": return "Resource";
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      return "Edit";
    case "git":
    case "git_stage":
      return "Git";
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
      return "Run";
    case "grep":
    case "glob":
    case "find":
      return "Search";
    case "list":
    case "ls":
      return "List";
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      return "Web Search";
    case "web_fetch":
    case "fetch":
      return "Fetch";
    case "load_tool": return "Load";
    case "task": return "Task";
    case "agent":
    case "bridge":
      return "Agent";
    case "request_user_input": return "Questions";
    case "update_plan": return "Plan";
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      return "Skill";
    default:
      return surfaceLabel || originalName || "Tool";
  }
}

function toolActivityFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    api_key: "API key",
    include_noise: "Include ignored",
    monitor_interval_ms: "Interval",
    timeout_ms: "Timeout",
  };
  if (labels[key]) return labels[key];
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : key;
}

function toolActivityFieldValue(key: string, value: unknown): string {
  if (TOOL_ACTIVITY_SECRET_ARG.test(key)) return "••••••";
  if ((key === "timeout_ms" || key === "monitor_interval_ms") && Number(value) > 0) {
    return formatElapsed(Number(value));
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(", ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2).slice(0, 8_000);
    } catch {}
  }
  return boundedTextOf(value, 8_000);
}

function toolActivityRedactInlineSecrets(text: string, args: Record<string, unknown>): string {
  let redacted = text;
  for (const [key, value] of Object.entries(args)) {
    if (!TOOL_ACTIVITY_SECRET_ARG.test(key) || value == null || typeof value === "object") continue;
    const raw = toolActivityInline(value);
    if (!raw) continue;
    redacted = redacted
      .split(`${key}=${raw}`).join(`${key}=••••••`)
      .split(`${key}: ${raw}`).join(`${key}: ••••••`);
  }
  return redacted;
}

function toolActivityRepresentedKeys(normalizedName: string): Set<string> {
  const keys = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => keys.add(value));
  switch (normalizedName) {
    case "read":
      add("file_path", "filePath", "path", "file", "offset", "limit", "pages");
      break;
    case "view_image":
    case "read_mcp_resource":
      add("file_path", "filePath", "path", "file", "uri");
      break;
    case "edit":
    case "strreplace":
    case "str_replace":
    case "str_replace_editor":
    case "search_replace":
      add("file_path", "filePath", "path", "file", "target");
      break;
    case "shell":
    case "bash":
    case "bash_session":
    case "shell_command":
    case "job_wait":
    case "git":
      add("command", "commands", "cmd", "description");
      break;
    case "git_stage":
      add("files", "paths");
      break;
    case "grep":
      add("pattern", "query", "path", "glob");
      break;
    case "glob":
      add("pattern", "glob", "path");
      break;
    case "find":
      add("query", "fuzzy", "path");
      break;
    case "list":
    case "ls":
      add("path", "dir", "cwd", "limit");
      break;
    case "web_search":
    case "web_search_call":
    case "search_query":
    case "image_query":
      add("query", "keywords");
      break;
    case "web_fetch":
    case "fetch":
      add("url", "uri");
      break;
    case "load_tool":
      add("names", "select", "query", "q", "text");
      break;
    case "skill":
    case "skill_execute":
    case "skill_view":
    case "skills_list":
    case "use_skill":
      add("name", "skill", "skill_name", "query", "q");
      break;
    case "task":
      add("action", "task_id", "id");
      break;
    case "agent":
    case "bridge":
      add("type", "action", "description", "tag", "role", "model", "prompt",
        "status", "task_id", "sessionId");
      break;
    case "request_user_input":
      add("questions", "answers");
      break;
    case "update_plan":
      add("plan", "todos", "explanation");
      break;
    case "memory":
    case "remember":
    case "save_memory":
    case "update_memory":
    case "recall_memory":
    case "recall":
    case "search_memories":
      add("action", "type", "operation", "op", "query", "queries", "text", "input",
        "summary", "element", "key", "name", "value", "limit", "topK");
      break;
    case "code_graph":
      add("mode", "action", "symbols", "symbol", "query", "files", "file", "path",
        "body", "limit", "depth", "cwd");
      break;
    case "cwd":
      add("action", "type", "path", "cwd", "dir");
      break;
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      add("server");
      break;
  }
  return keys;
}

function toolActivityErrorSummary(text: string): string {
  const first = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return toolActivityInline(
    first.replace(/^(?:\[(?:error|failed)\]\s*|error\s*:?\s*|failed\s*:?\s*)/i, ""),
    180,
  );
}

function toolActivityResultValue(item: TranscriptItem): unknown {
  const value = item.rawResult ?? item.result;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toolActivityAnswer(
  result: unknown,
  question: Record<string, unknown>,
  index: number,
  total: number,
): string {
  const secret = question.is_secret === true || question.isSecret === true;
  const record = asRecord(result);
  const answers = record?.answers ?? record?.answer;
  let value: unknown;
  if (Array.isArray(answers)) value = answers[index];
  else {
    const answerRecord = asRecord(answers);
    const id = toolActivityFirstText(question, "id");
    value = answerRecord?.[id] ?? answerRecord?.[String(index)];
  }
  if (value == null && total === 1 && typeof result === "string"
    && result.trim() && !TOOL_ACTIVITY_ROUTINE_RESULT.test(result.trim())) {
    value = result.trim();
  }
  const text = Array.isArray(value)
    ? value.map((entry) => toolActivityInline(entry)).filter(Boolean).join(", ")
    : toolActivityInline(value);
  return text ? (secret ? "••••••" : text) : "";
}

function toolActivityStructuredRows(
  normalizedName: string,
  args: Record<string, unknown>,
  result: unknown,
): { kind: ToolActivityStructuredKind; rows: ToolActivityStructuredRow[] } {
  if (normalizedName === "request_user_input" && Array.isArray(args.questions)) {
    const questions = args.questions
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return {
      kind: "questions",
      rows: questions.map((question, index) => ({
        text: toolActivityFirstText(question, "question", "header", "text") || `Question ${index + 1}`,
        status: toolActivityAnswer(result, question, index, questions.length) ? "completed" : "pending",
        answer: toolActivityAnswer(result, question, index, questions.length),
      })),
    };
  }
  const source = Array.isArray(args.todos) ? args.todos
    : normalizedName === "update_plan" && Array.isArray(args.plan) ? args.plan
      : [];
  if (source.length) {
    const kind: ToolActivityStructuredKind = Array.isArray(args.todos) ? "todos" : "plan";
    return {
      kind,
      rows: source.map((entry, index) => {
        const record = asRecord(entry) ?? {};
        return {
          text: toolActivityFirstText(record, "content", "step", "text", "title") || `${kind === "todos" ? "Todo" : "Step"} ${index + 1}`,
          status: toolActivityFirstText(record, "status") || "pending",
        };
      }),
    };
  }
  return { kind: "", rows: [] };
}

function toolActivityOutputText(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") return toolActivityFieldValue("output", value).trimEnd();
  const text = value.trimEnd();
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).slice(0, 100_000);
    } catch {}
  }
  return boundedTextOf(text, 100_000).trimEnd();
}

/* Every tool body arrives wrapped in harness scaffolding written for the
   model: pagination hints, guard notices, evidence anchors, and polling
   instructions. None of it means anything on screen, and it buried the actual
   result, so each card strips it before rendering. */
const TOOL_ACTIVITY_PROTOCOL_HINT =
  /(?:pass offset:|one window:|to continue|for more|raw source spans|evidence-ref|showing \d+ of|top \d+ of)/i;
const TOOL_ACTIVITY_TASK_INSTRUCTION =
  /(?:completion is automatic|do not call task|continue independent work|explicitly ask|use read for full output)/i;

function toolActivityIsProtocolLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\[arg-guard\]/i.test(text)) return true;
  if (!/^(?:\.{3}\s*)?\[[^\]]*\]$/.test(text)) return false;
  return TOOL_ACTIVITY_PROTOCOL_HINT.test(text);
}

function toolActivityCleanOutput(text: string): string {
  if (!text.includes("[")) return text;
  return text
    .split("\n")
    .filter((line) => !toolActivityIsProtocolLine(line))
    .join("\n")
    .trim();
}

/** A `background task` result is a protocol payload: an id/status header
    followed by instructions telling the model not to poll. The card keeps the
    status and id as one quiet line and shows only the real body. */
function toolActivityBackgroundTask(text: string): { meta: string; body: string } | null {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "background task") return null;
  const meta = new Map<string, string>();
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) {
      index += 1;
      break;
    }
    const match = /^([a-z0-9_]+):\s*(.*)$/i.exec(line);
    if (!match) break;
    meta.set(match[1].toLowerCase(), match[2].trim());
  }
  const status = (meta.get("status") || "").toLowerCase();
  const statusLabel = status === "running"
    ? t("Running")
    : status === "completed" ? t("Completed") : status === "failed" ? t("Failed") : status;
  const body = lines.slice(index).join("\n")
    .split(/\n{2,}/)
    .filter((block) => block.trim() && !TOOL_ACTIVITY_TASK_INSTRUCTION.test(block))
    .join("\n\n")
    .trim();
  return {
    meta: toolActivityCompact([statusLabel, meta.get("task_id"), meta.get("error")]),
    body,
  };
}

function toolActivityIsCompleted(status: string): boolean {
  return /^(?:completed|complete|done|success|succeeded|checked)$/i.test(status);
}

export function desktopToolActivityItemPresentation(
  item: TranscriptItem,
  nowMs = Date.now(),
): DesktopToolActivityItemPresentation {
  const name = String(item.name || "tool");
  const originalSurface = formatToolSurface(name, item.args);
  const originalName = originalSurface.normalizedName;
  const modeledName = desktopToolActivityModeledName(name, item.args);
  const surface = formatToolSurface(modeledName, item.args);
  const normalizedName = surface.normalizedName;
  const args = asRecord(surface.args) ?? asRecord(item.args) ?? {};
  const done = toolItemDone(item);
  const model = deriveToolCardModel({
    name: modeledName,
    args: item.args,
    result: item.result,
    rawResult: item.rawResult,
    isError: item.isError,
    errorCount: item.errorCount,
    callErrorCount: item.callErrorCount,
    exitErrorCount: item.exitErrorCount,
    count: 1,
    completedCount: done ? 1 : 0,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    headerFinalized: item.headerFinalized,
    nowMs,
  }) as ToolCardModel & {
    resultSummary?: string | null;
    displayedResultBodyText?: string;
    terminalStatus?: string;
  };
  const baseTone = toolActivityItemTone(item);
  const tone = baseTone !== "neutral"
    ? baseTone
    : item.isError || Number(item.errorCount || 0) > 0 || /fail|error|timeout|denied/i.test(String(model.terminalStatus || ""))
      ? "error"
      : "neutral";
  const resultValue = toolActivityResultValue(item);
  const structured = toolActivityStructuredRows(normalizedName, args, resultValue);
  const title = toolActivityTitle(normalizedName, originalName, surface.label, args);
  const subject = toolActivityRedactInlineSecrets(toolActivitySubject(
    normalizedName,
    args,
    oneLine(String(model.summaryText || "")),
  ), args);
  const command = /^(?:shell|bash|bash_session|shell_command|job_wait|git)$/.test(normalizedName)
    ? toolActivityCommand(args)
    : "";
  const represented = toolActivityRepresentedKeys(normalizedName);
  if (desktopToolActivityCategory(name, item.args) === "MCP") {
    ["query", "q", "text", "prompt", "path", "uri", "name", "id", "action"]
      .forEach((key) => represented.add(key));
  }
  const fields = Object.entries(args)
    .filter(([key, value]) => (
      value !== undefined
      && value !== null
      && value !== ""
      && !represented.has(key)
      && !TOOL_ACTIVITY_INTERNAL_ARGS.has(key)
      && !TOOL_ACTIVITY_BULK_ARGS.has(key)
      // Defaults say nothing on screen. An unset flag and a zeroed budget
      // (timeout_ms: 0, monitor_interval_ms: 0) only added rows to read past.
      && value !== false
      && !(typeof value === "number" && value === 0)
    ))
    .map(([key, value]) => ({
      key,
      label: toolActivityFieldLabel(key),
      value: toolActivityFieldValue(key, value),
    }));
  const argumentPatch = typeof args.patch === "string" ? args.patch.trim() : "";
  const diffPatch = typeof item.uiDiff === "string" && item.uiDiff.trim()
    ? item.uiDiff.trim()
    : normalizedName === "apply_patch" ? argumentPatch : "";
  const previewText = originalName === "write" && typeof args.content === "string"
    ? args.content
    : "";
  const beforeText = !diffPatch && normalizedName === "edit"
    ? toolActivityFirstText(args, "old_string", "oldString", "old_str")
    : "";
  const afterText = !diffPatch && normalizedName === "edit"
    ? toolActivityFirstText(args, "new_string", "newString", "new_str")
    : "";
  let outputText = toolActivityCleanOutput(toolActivityOutputText(
    item.rawResult ?? model.displayedResultBodyText ?? item.result,
  ));
  const backgroundTask = toolActivityBackgroundTask(outputText);
  const metaText = backgroundTask ? backgroundTask.meta : "";
  if (backgroundTask) outputText = backgroundTask.body;
  const mutation = normalizedName === "edit" || normalizedName === "apply_patch";
  const routineSurface = mutation
    || normalizedName === "load_tool"
    || /^(?:skill|skill_execute|skill_view|skills_list|use_skill)$/.test(normalizedName)
    || normalizedName === "agent"
    || normalizedName === "bridge"
    || normalizedName === "task";
  const quietSuccessSurface = normalizedName === "load_tool"
    || /^(?:skill|skill_execute|skill_view|skills_list|use_skill)$/.test(normalizedName);
  if (structured.kind || (tone === "neutral" && routineSurface
    && TOOL_ACTIVITY_ROUTINE_RESULT.test(outputText.trim()))) {
    outputText = "";
  }
  if (tone === "neutral" && quietSuccessSurface) outputText = "";
  if (normalizedName === "view_image" && /^\[image:/i.test(outputText.trim())) outputText = "";
  if (tone === "neutral" && diffPatch && outputText.split("\n").length === 1
    && /(?:applied|updated|changed|created|deleted|success|done)/i.test(outputText)) {
    outputText = "";
  }
  let resultLabel = "";
  if (!model.pending) {
    const semantic = oneLine(String(model.resultSummary || ""));
    if (semantic && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(semantic)) resultLabel = semantic;
    if (tone === "neutral" && quietSuccessSurface) resultLabel = "";
    if (!resultLabel && tone === "error") {
      const failure = oneLine(String(model.headerFailureText || model.detailLine || ""));
      resultLabel = toolActivityErrorSummary(outputText)
        || (failure && !TOOL_ACTIVITY_MEANINGLESS_RESULT.test(failure) ? failure : t("Failed"));
    }
  }
  if (structured.rows.length) {
    const completed = structured.rows.filter((row) => toolActivityIsCompleted(row.status)).length;
    resultLabel = `${completed}/${structured.rows.length}`;
  }
  if (!resultLabel && normalizedName === "git_stage" && /^staged\b/i.test(outputText.trim())) {
    resultLabel = t("Staged");
  }
  if (resultLabel && outputText
    && oneLine(outputText).toLocaleLowerCase() === resultLabel.toLocaleLowerCase()) {
    outputText = "";
  }
  const hasDetails = Boolean(
    command
    || fields.length
    || diffPatch
    || outputText
    || metaText
    || previewText
    || beforeText
    || afterText
    || structured.rows.length,
  );
  return {
    category: desktopToolActivityCategory(name, item.args),
    title,
    subject,
    resultLabel,
    pending: model.pending,
    tone,
    command,
    fields,
    diffPatch,
    outputText,
    metaText,
    previewLabel: previewText ? t("Content") : "",
    previewText,
    beforeText,
    afterText,
    structuredKind: structured.kind,
    structuredRows: structured.rows,
    hasDetails,
    hideSubjectWhenOpen: Boolean(command),
  };
}

function DesktopToolActivityItem({
  item,
  open,
  onToggle,
  contentId,
}: {
  item: TranscriptItem;
  open: boolean;
  onToggle: () => void;
  contentId: string;
}) {
  const itemRef = useRef<HTMLElement>(null);
  const presentation = useMemo(
    () => desktopToolActivityItemPresentation(item),
    [item],
  );
  const panelOpen = open && presentation.hasDetails;
  // The body outlives `open` by one exit animation so its height can ease back
  // to zero, and the expanded flag is set a frame after mount so the row has a
  // 0fr state to animate from. Reduced motion drops the body on the spot.
  const [rendered, setRendered] = useState(panelOpen);
  const [expanded, setExpanded] = useState(panelOpen);
  useLayoutEffect(() => {
    if (panelOpen) {
      setRendered(true);
      const frame = window.requestAnimationFrame(() => setExpanded(true));
      return () => window.cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = window.setTimeout(
      () => setRendered(false),
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    );
    return () => window.clearTimeout(timer);
  }, [panelOpen]);
  useLayoutEffect(() => {
    requestTranscriptRowMeasure(itemRef.current);
  }, [rendered, expanded]);

  return (
    <article ref={itemRef} className={`tool-activity-item ${presentation.tone}`}
      data-open={open ? "true" : "false"} data-expanded={expanded ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (event.propertyName === "grid-template-rows") {
          requestTranscriptRowMeasure(itemRef.current);
        }
      }}>
      <button type="button" className="tool-header tool-activity-item-header"
        disabled={!presentation.hasDetails}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onToggle}
        aria-expanded={presentation.hasDetails ? open : undefined}
        aria-controls={presentation.hasDetails ? contentId : undefined}>
        <span className="tool-icon">{toolIcon(presentation.category)}</span>
        <span className="tool-title tool-activity-item-title"
          title={[presentation.title, presentation.subject, presentation.resultLabel].filter(Boolean).join(" · ")}>
          <b><TextShimmer text={presentation.title} active={presentation.pending} /></b>
          {/* While a call is in flight its arguments can still be streaming
              in, so the target is held back and only the shimmering verb runs
              (opencode reference). A command is the exception: it IS the work,
              and a running shell with no visible command says nothing. */}
          {presentation.subject && !(open && presentation.hideSubjectWhenOpen)
            && !(presentation.pending && !presentation.command)
            && <small>{presentation.subject}</small>}
        </span>
        {presentation.resultLabel && <span className="tool-activity-item-result">{presentation.resultLabel}</span>}
        {presentation.pending && <span className="sr-only" role="status">{t("Running")}</span>}
        {presentation.hasDetails && <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>}
      </button>
      {rendered && presentation.hasDetails && (
        <div className="tool-activity-item-body" id={contentId}>
          {presentation.metaText && (
            <p className="tool-activity-item-meta">{presentation.metaText}</p>
          )}
          {presentation.command && (
            <section className="tool-activity-terminal">
              <pre className="tool-activity-item-command"><code>$ {presentation.command}</code></pre>
              {presentation.outputText && (
                <pre className="tool-activity-item-output">{presentation.outputText}</pre>
              )}
              <CopyControl className="tool-detail-copy tool-activity-copy" label="Copy"
                value={[presentation.command, presentation.outputText].filter(Boolean).join("\n\n")} />
            </section>
          )}
          {presentation.structuredRows.length > 0 && (
            <section className="tool-activity-item-section">
              <span>{presentation.structuredKind === "questions"
                ? t("Questions")
                : presentation.structuredKind === "todos" ? t("Todos") : t("Plan")}</span>
              <div className="tool-activity-structured-list">
                {presentation.structuredRows.map((row, index) => (
                  <div className="tool-activity-structured-row"
                    data-status={row.status} key={`${row.text}:${index}`}>
                    <span className="tool-activity-structured-marker" aria-hidden="true">
                      {toolActivityIsCompleted(row.status) ? "✓" : "○"}
                    </span>
                    {presentation.structuredKind === "questions" ? (
                      <span className="tool-activity-structured-question">
                        <span className="tool-activity-structured-content">{row.text}</span>
                        {row.answer && <span className="tool-activity-structured-answer">
                          <span>{t("Answer")}</span>{row.answer}
                        </span>}
                      </span>
                    ) : <span className="tool-activity-structured-content">{row.text}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {presentation.previewText && (
            <section className="tool-activity-item-section">
              <span>{presentation.previewLabel}</span>
              <pre className="tool-activity-item-preview">{presentation.previewText}</pre>
            </section>
          )}
          {(presentation.beforeText || presentation.afterText) && (
            <section className="tool-activity-item-section tool-activity-replacement">
              <div className="tool-activity-replacement-block" data-kind="before">
                <span>{t("Before")}</span>
                <pre>{presentation.beforeText}</pre>
              </div>
              <div className="tool-activity-replacement-block" data-kind="after">
                <span>{t("After")}</span>
                <pre>{presentation.afterText}</pre>
              </div>
            </section>
          )}
          {presentation.fields.length > 0 && (
            <section className="tool-activity-item-section">
              <span>{t("Arguments")}</span>
              <dl className="tool-activity-item-fields">
                {presentation.fields.map((field) => (
                  <React.Fragment key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          )}
          {presentation.diffPatch && <CodeDiff patch={presentation.diffPatch} />}
          {presentation.outputText && !presentation.command && (
            <section className="tool-activity-item-section tool-activity-item-result-block">
              <pre className="tool-activity-item-output">{presentation.outputText}</pre>
              <CopyControl className="tool-detail-copy tool-activity-copy" label="Copy"
                value={presentation.outputText} />
            </section>
          )}
        </div>
      )}
    </article>
  );
}

export function ToolCard({
  item,
  disclosureScope = "",
}: {
  item: TranscriptItem;
  disclosureScope?: string;
}) {
  // New cards start collapsed. Once touched, the user's last disclosure state
  // survives virtualization, streaming remounts, and session re-entry.
  const disclosureKey = toolDisclosureKey(item, disclosureScope);
  const [open, setOpen] = useState(() =>
    disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  useLayoutEffect(() => {
    setOpen(disclosureKey ? toolDisclosureStates.get(disclosureKey) ?? false : false);
  }, [disclosureKey]);
  const cardRef = useRef<HTMLElement>(null);
  const measuredOpen = useRef(open);
  useLayoutEffect(() => {
    if (measuredOpen.current === open) return;
    measuredOpen.current = open;
    requestTranscriptRowMeasure(cardRef.current);
  }, [open]);
  const contentId = useId();
  const done = toolItemDone(item);
  // Ticking clock for the running card's optional expanded `Running · 12s`
  // summary. Collapsed cards stay one row throughout their lifecycle.
  const startedAt = Number(item.startedAt || 0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (done || !startedAt) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [done, startedAt]);
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const rawResult = item.result ?? item.rawResult;
  // Header label, casing, parenthesized arg summary, and the optional expanded
  // detail all come from the shared TUI derivation. Desktop adds only
  // icons/chevron/expansion chrome around it.
  const model = useMemo(() => deriveToolCardModel({
    name: item.name,
    args: item.args,
    result: item.result,
    rawResult: item.rawResult,
    isError: item.isError,
    errorCount: item.errorCount,
    callErrorCount: item.callErrorCount,
    exitErrorCount: item.exitErrorCount,
    count: item.count,
    completedCount: done ? Math.max(1, Math.round(Number(item.count || 1))) : 0,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    aggregate: Boolean(item.aggregate),
    categories: item.categories,
    doneCategories: item.doneCategories,
    headerFinalized: item.headerFinalized,
    nowMs: nowTick,
  }) as ToolCardModel, [item, done, nowTick]);
  const hasResult = typeof rawResult === "string" ? Boolean(rawResult.trim()) : rawResult != null;
  // Expansion reveals exactly one thing now: the summary row.
  const hasDetails = Boolean(model.detailLine);
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const partialMutation = callFailedCount > 0
    && typeof item.uiDiff === "string"
    && Boolean(item.uiDiff.trim());
  const outcomeTone = deriveToolOutcomeTone({
    pending: model.pending,
    groupCount: count,
    callFailedCount,
    exitFailedCount,
    terminalStatus: denied ? "denied" : model.terminalStatus,
    partialMutation,
  });
  const failure = outcomeTone === "error";
  const warning = outcomeTone === "warning";
  // Restored/virtualized history mounts in its final state and must stay still.
  // Blink only when this retained live card crosses into a total failure.
  const previousFailure = useRef(failure);
  const failureArrived = failure && !previousFailure.current;
  useEffect(() => {
    previousFailure.current = failure;
  }, [failure]);
  const errorCard = (failure || warning) && hasResult;
  // User contract: every collapsed tool is exactly one header row, whether it
  // is running or settled. Expanding adds exactly one summary row; live shell
  // tails never auto-grow the transcript.
  const detailRowVisible = Boolean(model.detailLine) && open;
  return (
    <article ref={cardRef}
      className={`tool-card ${failure ? "failed" : ""} ${warning ? "warning" : ""} ${failureArrived ? "failure-arrived" : ""} ${done ? "settled" : ""}`}
      data-category={category} data-kind={errorCard ? "tool-error-card" : undefined}
      data-open={open ? "true" : "false"}>
      <button className="tool-header" disabled={!hasDetails}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((value) => {
          const next = !value;
          rememberToolDisclosure(disclosureKey, next);
          return next;
        })} aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? contentId : undefined}>
        {/* Keep the tool's own glyph on failure (user): danger color plus a
            one-shot live transition blink carries the signal; no X swap. */}
        <span className="tool-icon">{toolIcon(category)}</span>
        <span className="tool-title"
          title={[model.labelText, model.summaryText ? `(${model.summaryText})` : ""]
            .filter(Boolean).join(" ")}>
          <b data-component={item.aggregate ? "tool-count-summary" : "tool-status-title"}
            data-active={!done ? "true" : "false"}>
            <TextShimmer text={model.labelText} active={!done} />
          </b>
          {/* Collapsed headers show the LABEL only (user decision): the
              parenthesized arg summary flapped between sources (stored items
              often lack args) and leaked long raw commands into the row. The
              full summary stays on the hover title and in the expanded
              detail. */}
        </span>
        {model.headerFailureText && <span className={`tool-state ${warning ? "warning" : "failed"}`} role="status">
          {model.headerFailureText}
        </span>}
        {!done && <span className="sr-only" role="status">{t("Running")}</span>}
        {hasDetails && <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>}
      </button>
      {detailRowVisible && (
        <div className="tool-detail-line" id={contentId} data-component="tool-collapsed-summary">
          <span className="tool-detail-text"
            data-placeholder={model.detailIsPlaceholder || undefined}>
            {(splitLineDeltaTokens(model.detailLine) as DetailLinePart[]).map((part, index) => (
              part.delta
                ? <em key={index} data-delta={part.delta}>{part.text}</em>
                : <React.Fragment key={index}>{part.text}</React.Fragment>
            ))}
          </span>
        </div>
      )}
    </article>
  );
}

export function boundedTextOf(value: unknown, maxLength = 100_000) {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}\n…truncated` : value;
  let visited = 0;
  try {
    const text = JSON.stringify(value, (_key, nested) => {
      visited += 1;
      if (visited > 2_000) return "…truncated";
      if (typeof nested === "string" && nested.length > 20_000) return `${nested.slice(0, 20_000)}…`;
      return nested;
    }, 2) || "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…truncated` : text;
  } catch {
    return oneLine(String(value), maxLength);
  }
}

export function toolResultText(item: TranscriptItem) {
  return [item.result, item.rawResult]
    .filter((value, index, values) => value != null && (index === 0 || value !== values[0]))
    .map(String).join("\n").trim();
}

export function isHookApprovalDenialToolItem(item: TranscriptItem) {
  if (!item.isError) return false;
  const text = toolResultText(item);
  return /^Error:\s*tool\s*"[^"]*"\s*denied by hook\b/im.test(text)
    || /denied by hook:\s*approval required but no approval UI is available/i.test(text);
}

export function shouldSuppressFullyFailedToolItem(item: TranscriptItem) {
  const args = asRecord(item.args);
  const status = String(args?.status || "").toLowerCase();
  if ((args?.task_id || args?.taskId) && /^(failed|error|timeout|cancelled|canceled|killed)$/.test(status)) return false;
  const count = Math.max(1, Number(item.count || 1));
  const completed = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
  const explicit = Number(item.errorCount);
  const errors = Number.isFinite(explicit) ? Math.max(0, Math.min(count, Math.floor(explicit))) : item.isError ? count : 0;
  return completed >= count && errors >= count && !isHookApprovalDenialToolItem(item) && !toolResultText(item);
}

export function toolIcon(category: unknown) {
  if (category === "Patch") return <Code2 size={16} />;
  if (category === "Read") return <MxIcon name="open-file" size={16} />;
  if (category === "Search" || category === "Web Research") return <MxIcon name="magnifying-glass" size={16} />;
  if (category === "Shell") return <MxIcon name="terminal" size={16} />;
  return <Layers3 size={16} />;
}

const normalizedPatchCache = new Map<string, string>();
export const PATCH_CACHE_LIMIT = 24;
const PATCH_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const PATCH_CACHE_ENTRY_MAX_CHARS = 1024 * 1024;

function pruneNormalizedPatchCache(): void {
  const retainedChars = () => [...normalizedPatchCache]
    .reduce((total, [input, normalized]) => total + input.length + normalized.length, 0);
  while (
    normalizedPatchCache.size > PATCH_CACHE_LIMIT
    || retainedChars() > PATCH_CACHE_MAX_CHARS
  ) {
    const oldest = normalizedPatchCache.keys().next().value;
    if (oldest === undefined) break;
    normalizedPatchCache.delete(oldest);
  }
}

export function findPatch(item: TranscriptItem) {
  const args = asRecord(item.args);
  const result = asRecord(item.result);
  const candidates = [args?.patch, args?.diff, result?.patch, result?.diff, item.result, item.rawResult];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const cached = normalizedPatchCache.get(value);
    if (cached !== undefined) {
      normalizedPatchCache.delete(value);
      normalizedPatchCache.set(value, cached);
      return cached;
    }
    if (!(/^@@/m.test(value) || /^diff --git/m.test(value)
      || /^\*\*\* (?:Begin Patch|Add File:|Delete File:)/m.test(value))) continue;
    const normalized = normalizeApplyPatch(value);
    if (value.length + normalized.length <= PATCH_CACHE_ENTRY_MAX_CHARS) {
      normalizedPatchCache.set(value, normalized);
      pruneNormalizedPatchCache();
    }
    return normalized;
  }
  return undefined;
}

export class DiffBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function CodeDiff({ patch }: { patch: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = patch.split("\n").length;
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const fallback = <pre className="diff-fallback">{patch}</pre>;
  return (
    <section className="code-diff">
      <div className={expanded ? "" : "diff-collapsed"}>
        <DiffBoundary key={patch} fallback={fallback}>
          {files.map((file, index) => {
            const additions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
            const deletions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
            const operation = file.status === "A" ? t("Added")
              : file.status === "D" ? t("Deleted")
                : file.status === "M" ? t("Changed") : "";
            return <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
              <header><FileDiff size={16} /><b>{file.newFile.fileName}</b>
                {operation && <span className="diff-operation" data-status={file.status}>{operation}</span>}
                {(additions > 0 || deletions > 0) && <span className="diff-stats">
                  {additions > 0 && <i>+{additions}</i>}
                  {deletions > 0 && <em>-{deletions}</em>}
                </span>}
                <CopyControl value={file.patch} label={`Copy diff for ${file.newFile.fileName}`}
                  className="tool-detail-copy diff-copy" />
              </header>
              {file.renderable ? (
                <Suspense fallback={<div className="diff-loading" role="status" aria-label={t("Rendering diff…")}>
                  <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />
                </div>}>
                  {/* The library's parser requires the ---/+++ header in each
                      hunk entry; header-less @@ hunks parse as an EMPTY diff.
                      Feed the full per-file patch instead. */}
                  <DiffView data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.renderPatch || file.patch] }} />
                </Suspense>
              ) : <pre className="diff-fallback">{file.patch}</pre>}
            </div>;
          })}
        </DiffBoundary>
      </div>
      {lineCount > 14 && (
        <button type="button" className="diff-toggle" onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}>
          {expanded ? t("Collapse diff") : t("Show full diff")}
        </button>
      )}
    </section>
  );
}
