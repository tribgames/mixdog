import { Check, ChevronRight, Code2, FileDiff, Layers3, X } from "lucide-react";
import React, { Component, Suspense, lazy, memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolveContextDisplayUsage } from "./context-usage";
import { type Snapshot, type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { DiffView } from "./lazy-widgets";
import {
  containsFencedCodeMarkdown,
  MarkdownSourceFallback,
} from "./MarkdownSourceFallback";
import { MxIcon } from "./MxIcon";
import { ProgressSpinner } from "./ProgressSpinner";
import { normalizeApplyPatch, parseUnifiedDiff } from "./renderer-logic.mjs";
import {
  createStreamingMarkdownCache,
  healStreamingMarkdownTail,
  isPlainTextMarkdown,
  resolveStreamingMarkdownChunks,
} from "./streaming-markdown";
import StreamingMarkdownBody from "./StreamingMarkdownBody";
import { asRecord, copyTextToClipboard, formatElapsed, oneLine, publicThinkingSummary } from "./text-format";
import { imagePreviewCache, imagePreviewKey } from "./transcript-metrics";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatToolSurface } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel, splitLineDeltaTokens } from "../../../../src/runtime/shared/tool-card-model.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { isInternalTranscriptDisplayText } from "../../../../src/runtime/shared/tool-execution-contract.mjs";
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

// TUI parity (Spinner formatNumber): compact lowercase k/m token units.
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
  if (tokens >= 1000) return compactTokenFormatter.format(tokens).toLowerCase();
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
  const runningCount = taggedRunningKeys.size + untaggedRunningCount;
  const tools = snapshot.activeTools || {};
  const exploreCount = Math.max(0, Number(tools.explore?.count) || 0);
  const searchCount = Math.max(0, Number(tools.search?.count) || 0);
  const shellCount = Math.max(0, Number(snapshot.shellJobs?.count) || 0);
  const active = runningCount > 0 || exploreCount > 0 || searchCount > 0 || shellCount > 0;
  useEffect(() => {
    if (fixedNow !== undefined || !active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, fixedNow]);
  if (!active) return null;
  // Aggregate chip (user decision): ONE quiet spinner+count left of the
  // context gauge; the per-activity breakdown lives in a hover popover.
  const total = runningCount + exploreCount + searchCount + shellCount;
  const row = (key: string, label: string, elapsed: string) => <div className="live-work-row" key={key}>
    <span>{label}</span>
    {elapsed && <small>{elapsed}</small>}
  </div>;
  return <div className="live-work-status" role="status" tabIndex={0}
    aria-label={t("Background activity: {{count}} running", { count: total })}>
    {/* 16px matches the optical weight of the neighboring 18–20px controls;
        13px read as vertically off next to them (user). */}
    <ProgressSpinner className="live-work-spinner" size={16} aria-hidden="true" />
    <span className="live-work-count">{total}</span>
    <div className="live-work-popover" role="tooltip">
      {runningCount > 0 && row("agents", `${runningCount === 1 ? t("Agent") : t("Agents")} ${runningCount}`,
        Number.isFinite(oldestAgentStart) ? formatWorkElapsed(clock - oldestAgentStart) : "")}
      {exploreCount > 0 && row("explore", t("Explore"),
        tools.explore?.startedAt ? formatWorkElapsed(clock - Number(tools.explore.startedAt)) : "")}
      {searchCount > 0 && row("search", t("Web search"),
        tools.search?.startedAt ? formatWorkElapsed(clock - Number(tools.search.startedAt)) : "")}
      {shellCount > 0 && row("shells", `${t("Shell")} ${shellCount}`,
        String(snapshot.shellJobs?.elapsedLabel || ""))}
    </div>
  </div>;
}

const CONTEXT_USAGE_MEMORY_LIMIT = 32;
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
  const hasStats = snapshot.stats !== null && typeof snapshot.stats === "object";
  if (hasStats) {
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

export function ContextUsageIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen(): void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const keyboardFocusIntent = useRef(false);
  const context = contextMetrics(snapshot);
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Tab") keyboardFocusIntent.current = true;
      if (event.key === "Escape") setPopoverOpen(false);
    };
    const pointerdown = () => { keyboardFocusIntent.current = false; };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown, true);
    };
  }, []);
  if (!context) return null;
  const descriptionId = `context-usage-${String(snapshot.sessionId || "session")}`;
  return <div className="session-context-indicator" data-open={popoverOpen ? "true" : "false"}
    onMouseEnter={() => setPopoverOpen(true)} onMouseLeave={() => setPopoverOpen(false)}>
    <button type="button" onClick={() => {
      keyboardFocusIntent.current = false;
      setPopoverOpen(false);
      onOpen();
    }} onFocus={() => {
      if (keyboardFocusIntent.current) {
        keyboardFocusIntent.current = false;
        setPopoverOpen(true);
      }
    }} aria-label={t("Open context details")}
      aria-describedby={descriptionId}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="7" />
        <circle className="context-usage-value" cx="10" cy="10" r="7"
          pathLength="100" strokeDasharray={`${context.percent} 100`} />
      </svg>
    </button>
    <div className="session-context-popover" id={descriptionId} role="tooltip">
      <div><span>{t("Usage")}</span><b>{context.percent}%</b></div>
      <div><span>{context.estimated ? t("Tokens (est.)") : t("Tokens")}</span><b>{context.limit > 0
        ? `${context.used.toLocaleString()} / ${context.limit.toLocaleString()}`
        : context.used.toLocaleString()}</b></div>
      {(() => {
        const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
        return cost > 0
          ? <div><span>{t("Cost")}</span><b>${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}</b></div>
          : null;
      })()}
      {/* Compact action removed from the hover popover by user decision —
          /compact and auto-compact remain the compaction paths. */}
    </div>
  </div>;
}

// Verb pools mirrored from src/tui/components/Spinner.jsx MODE_VERBS — keep
// both lists in sync so TUI and GUI rotate through the same phrases.
const LIVE_ACTIVITY_VERBS: Record<string, readonly string[]> = {
  requesting: ["Requesting"],
  compacting: ["Compacting conversation"],
  "auto-clear": ["Auto-clearing conversation"],
  thinking: ["Thinking", "Considering", "Organizing"],
  "tool-use": ["Working", "Running tools", "Reviewing output"],
  "tool-input": ["Working", "Running tools", "Reviewing output"],
  responding: ["Writing", "Wrapping up"],
};

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
  const [now, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || (optimisticActivity ? optimisticStartedAt : 0));
  // Stream events flip the activity mode (thinking→responding→tool-use)
  // several times a second; a status line that rewrites itself that fast
  // reads as flicker. Hold each verb for a minimum dwell before accepting
  // the next one — appearance/disappearance stays immediate.
  const heldVerb = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  // Re-entering a session REMOUNTS this band. Replaying the enter animation
  // then slid the whole status row 4px on every visit (user: 들어갈 때마다
  // 애니메이션이 다시 나와서 튄다). Only work that actually began after this
  // mount is new; a turn already in flight is restored, not started.
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    if (!activity || !startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity, startedAt]);
  if (!activity && !optimisticActivity && !snapshot.thinking) {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const mode = String(activity?.mode
    || (snapshot.thinking ? "thinking" : optimisticActivity ? "requesting" : "responding"));
  if (mode === "resuming") {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const nowMs = Date.now();
  // Mirror the TUI Spinner's MODE_VERBS pools: the verb rotates through its
  // mode pool on a fixed 30s cadence (user decision), anchored to the turn
  // start so TUI and GUI advance on the same clock. Other modes carry
  // engine-authored status detail unchanged.
  const pool = LIVE_ACTIVITY_VERBS[mode];
  const slot = pool && pool.length > 1
    ? Math.floor(Math.max(0, nowMs - (startedAt || nowMs)) / 30_000) % pool.length
    : 0;
  const rawVerb = pool ? t(pool[slot]) : String(activity?.verb || t("Working"));
  // Engine-authored statuses (retry countdowns, compaction detail) must break
  // through immediately; only the canonical stream verbs dwell.
  const canonicalMode = Boolean(pool);
  if (!heldVerb.current.text
    || !canonicalMode
    || (rawVerb !== heldVerb.current.text && nowMs - heldVerb.current.at >= 3_000)) {
    heldVerb.current = { text: rawVerb, at: nowMs };
  }
  const verb = heldVerb.current.text;
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  const activityText = [
    verb,
    elapsed,
    outputTokens > 0 ? `${formatTokenCount(outputTokens)} tokens` : "",
  ].filter(Boolean).join(" · ");
  const reasoning = publicThinkingSummary(snapshot.thinking);
  const animateEnter = startedAt > 0 && startedAt >= mountedAt.current;
  return <div className="live-activity" data-mode={mode}>
    <div className="live-activity-status" role="status" aria-live="polite"
      data-animate={animateEnter ? "true" : undefined}>
      <span className="live-activity-icon" aria-hidden="true">
        <ProgressSpinner className="live-activity-spinner" size={15} />
      </span>
      <TextShimmer text={activityText} />
    </div>
    {reasoning && <details className="thinking-disclosure">
      <summary>{t("View reasoning")}</summary>
      <pre data-scrollable>{reasoning}</pre>
    </details>}
  </div>;
}

export function TextShimmer({ text, active = true }: { text: string; active?: boolean }) {
  return <span data-component="text-shimmer" data-active={active ? "true" : "false"} aria-label={text}>
    <span data-slot="text-shimmer-char" data-run={active ? "true" : "false"}
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
    const fallback = tone === "failed" ? "Failed" : elapsed ? `Cancelled after ${elapsed}` : "Cancelled";
    const visible = tone === "failed" && !/^(done|complete|completed)$/i.test(label) ? label || fallback : fallback;
    return <div className={`turn-status ${tone}`} role="status"
      data-animate={animate ? "true" : undefined}>
      <X className="turn-status-icon" size={15} aria-hidden="true" />
      <span>{visible}</span>
    </div>;
  }
  if (tone === "compaction") {
    return <div className="compaction-divider" role="status"
      data-animate={animate ? "true" : undefined}>
      <Layers3 className="compaction-icon" size={15} aria-hidden="true" />
      <span>{label || t("Conversation compacted")}</span>
      {item.detail && <small>{item.detail}</small>}
    </div>;
  }
  const elapsed = formatElapsed(item.elapsedMs);
  const completionLabel = item.kind === "turndone"
    ? [String(item.verb || item.label || "Thought"), elapsed ? `for ${elapsed}` : ""].filter(Boolean).join(" ")
    : label || "Complete";
  return <div className="turn-status complete" role="status"
    data-animate={animate ? "true" : undefined}>
    <Check className="turn-status-icon" size={15} aria-hidden="true" />
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
    {copied ? <MxIcon name="check" size={13} /> : <MxIcon name="copy" size={13} />}
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
  const workerPipeline = useRef(streaming);
  const fencedScriptGeometryLocked = useRef(false);
  // The geometry lock belongs to the fenced chunk alone. Applying it to the
  // whole response froze every following heading/list/bold block as raw
  // markdown source until the row remounted (user: 트랜스크립트 출력 도중에
  // 마크다운 포맷이 안 먹는다).
  const fencedChunks = useRef<Map<string, boolean>>(new Map());
  if (streaming) workerPipeline.current = true;
  if (streaming && containsFencedCodeMarkdown(text)) {
    fencedScriptGeometryLocked.current = true;
  }
  const chunkDefersPromotion = (key: string, chunk: string): boolean => {
    if (!fencedScriptGeometryLocked.current) return false;
    const cached = fencedChunks.current.get(key);
    if (cached !== undefined) return cached;
    const fenced = containsFencedCodeMarkdown(chunk);
    fencedChunks.current.set(key, fenced);
    return fenced;
  };
  // Renderer snapshots are already frame-coalesced. Adding another rAF here
  // commits DOM growth after the current ResizeObserver delivery and leaves
  // one painted frame off-bottom. OpenCode projects each arriving delta
  // immediately and lets the scroll owner lock the resulting layout.
  const markdownParts = resolveStreamingMarkdownChunks(text, streaming, markdownCache.current);
  const renderedChunks = markdownParts.stableChunks.map((chunk, index) => (
    <Suspense fallback={<MarkdownSourceFallback text={chunk} copyControl={CopyControl} />}
      key={markdownParts.stableChunkKeys[index]}>
      {workerPipeline.current
        ? <StreamingMarkdownBody text={chunk} live={false}
            deferAsyncPromotion={chunkDefersPromotion(markdownParts.stableChunkKeys[index], chunk)}
            copyControl={CopyControl} />
        : <StableMarkdownBody text={chunk} />}
    </Suspense>
  ));
  if (markdownParts.unstableText) {
    // OpenCode heals the live tail before parsing it, so an unfinished
    // "**bold" or "`code" is already styled while the model types.
    const unstableParseText = streaming
      ? healStreamingMarkdownTail(markdownParts.unstableText)
      : markdownParts.unstableText;
    const unstableDefers = fencedScriptGeometryLocked.current
      && containsFencedCodeMarkdown(markdownParts.unstableText);
    renderedChunks.push(
      <Suspense
        fallback={<MarkdownSourceFallback text={markdownParts.unstableText} copyControl={CopyControl} />}
        key={markdownParts.unstableKey}>
        {workerPipeline.current
          ? <StreamingMarkdownBody
              text={markdownParts.unstableText}
              parseText={unstableParseText}
              live={streaming || !markdownParts.parseUnstable}
              deferAsyncPromotion={unstableDefers}
              copyControl={CopyControl} />
          : <StableMarkdownBody text={markdownParts.unstableText} />}
      </Suspense>,
    );
  }
  return <div className={`markdown ${streaming ? "streaming" : ""}`}>
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
  const agent = typeof item.agent === "string" ? item.agent.trim() : "";
  const model = typeof item.model === "string" ? item.model.trim() : "";
  const shortTime = typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0
    ? new Date(item.at).toLocaleTimeString(undefined, { timeStyle: "short" })
    : "";
  return {
    details: [agent, model, shortTime].filter(Boolean),
    shortTime,
  };
}

// The transcript renders attached images as chips, so the raw composer token
// ("[Image #N: name]") in the message text is redundant noise there.
function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
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
 * it to keep invisible rows out of the virtual list entirely (opencode's
 * `renderable(part)`), so the timeline never carries zero-height placeholders.
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
  // chat — render the standard interrupted status row instead of leaking the
  // raw "[Request interrupted by process restart]" marker into the thread.
  if (user && /^\[request interrupted by process restart\]$/i.test(text)) {
    return <div className="turn-status interrupted" role="status">
      <X className="turn-status-icon" size={15} aria-hidden="true" />
      <span>{t("Interrupted by app restart")}</span>
    </div>;
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
  const webhookFold = user ? extractWebhookPayload(userDisplayText) : { text: userDisplayText, payload: "" };
  return (
    <>
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"} ${item.pending ? "pending" : ""} ${user && attachedUser ? "attached-user" : ""}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}
        aria-busy={item.pending === true ? "true" : undefined}>
        <div className="message-body" onDragStart={(event) => event.preventDefault()}>
          {user ? <>
            {(attachedImages.length > 0 || markerChips.length > 0) && <div className="message-image-chips"
              aria-label={t("Attached images")}>
              {attachedImages.map((image, index) => {
                const preview = imagePreviewCache.get(imagePreviewKey(image.id, image.bytes));
                return <span className="message-image-chip" key={`${image.id ?? 'img'}-${index}`}
                  title={image.name || t('Attached image')}>
                  {preview
                    ? <img src={preview} alt={image.name || t('Attached image')} />
                    : <span className="message-image-fallback">
                <MxIcon name="photo" size={14} />
                      <span>{image.name || 'Image'}</span>
                    </span>}
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
        {user && !item.pending && !item.streaming && text && <footer className="message-meta-line"
          aria-label={t("Message details")}>
          {metadata.details.length > 0 && <span className="message-meta">
            {metadata.details.join("\u00A0\u00B7\u00A0")}
          </span>}
          <CopyControl value={text} label={t("Copy message")}
            className="message-actions user-copy" />
        </footer>}
        {!user && !item.streaming && (text || completion) && <footer className="response-footer"
          aria-label={t("Response details")}>
          {completion && <CompletionStatus item={completion} animate={completionAnimate} />}
          {/* Timestamp marks the END of a turn: mid-turn assistant paragraphs
              (tool calls still running) must not carry a clock (user). */}
          {Boolean(completion) && metadata.shortTime &&
            <time className="message-time">{metadata.shortTime}</time>}
          {text && <CopyControl value={text} label={t("Copy response")}
            className="message-actions response-copy" />}
        </footer>}
      </article>
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
  const contentId = useId();
  const done = item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
  // Ticking clock for the running card's optional expanded `Running · 12s`
  // summary. Collapsed cards stay one row throughout their lifecycle.
  const startedAt = Number(item.startedAt || 0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (done || !startedAt) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [done, startedAt]);
  const failedCount = Math.max(0, Number(item.errorCount || 0));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const failed = Boolean(item.isError || failedCount > 0 || callFailedCount > 0);
  const failure = failed || denied;
  // Restored/virtualized history mounts in its final state and must stay still.
  // Blink only when this retained live card actually crosses into failure.
  const previousFailure = useRef(failure);
  const failureArrived = failure && !previousFailure.current;
  useEffect(() => {
    previousFailure.current = failure;
  }, [failure]);
  const exited = !failed && exitFailedCount > 0;
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
  // TUI parity (toolStatusColor): some-but-not-all of a group failing is the
  // amber partial state, not the red full-failure state.
  const partialFailed = failed && count > 1
    && (callFailedCount > 0 ? callFailedCount < count : failedCount > 0 && failedCount < count);
  const errorCard = failure && hasResult;
  // User contract: every collapsed tool is exactly one header row, whether it
  // is running or settled. Expanding adds exactly one summary row; live shell
  // tails never auto-grow the transcript.
  const detailRowVisible = Boolean(model.detailLine) && open;
  return (
    <article className={`tool-card ${failure ? "failed" : ""} ${failureArrived ? "failure-arrived" : ""} ${partialFailed ? "partial-failed" : ""} ${exited ? "exited" : ""} ${done ? "settled" : ""}`}
      data-category={category} data-kind={errorCard ? "tool-error-card" : undefined}
      data-open={open ? "true" : "false"}>
      <button className="tool-header" disabled={!hasDetails}
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
        {model.headerFailureText && <span className="tool-state failed" role="status">
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
    normalizedPatchCache.set(value, normalized);
    if (normalizedPatchCache.size > PATCH_CACHE_LIMIT) {
      normalizedPatchCache.delete(normalizedPatchCache.keys().next().value as string);
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
            return <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
              <header><FileDiff size={15} /><b>{file.newFile.fileName}</b>
                <span className="diff-stats"><i>+{additions}</i><em>-{deletions}</em></span>
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
