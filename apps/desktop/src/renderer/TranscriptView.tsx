import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { MxIcon } from "./MxIcon";
import type { DesktopCapability, DesktopModelOption, DesktopModelSelection, DesktopPromptAttachment, DesktopPromptContent, DesktopProjectSummary, DesktopSessionSummary, DesktopSubmitOptions, DesktopUpdaterState, EngineSnapshot } from "../shared/contract";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { resolveContextUsage } from "./context-usage";
import {
  createStreamingMarkdownCache,
  resolveStreamingMarkdownChunks,
} from "./streaming-markdown";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatAggregateHeader, formatToolSurface, summarizeToolResult } from "../../../../src/runtime/shared/tool-surface.mjs";
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { deriveToolCardModel, splitLineDeltaTokens } from "../../../../src/runtime/shared/tool-card-model.mjs";

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

export function formatTokenCount(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1000) return compactTokenFormatter.format(tokens).toLowerCase();
  return String(Math.round(tokens));
}

export function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(value || ""));
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
    aria-label={`Background activity: ${total} running`}>
    {/* 16px matches the optical weight of the neighboring 18–20px controls;
        13px read as vertically off next to them (user). */}
    <LoaderCircle className="live-work-spinner" size={16} aria-hidden="true" />
    <span className="live-work-count">{total}</span>
    <div className="live-work-popover" role="tooltip">
      {runningCount > 0 && row("agents", `Agent${runningCount === 1 ? "" : "s"} ${runningCount}`,
        Number.isFinite(oldestAgentStart) ? formatWorkElapsed(clock - oldestAgentStart) : "")}
      {exploreCount > 0 && row("explore", "Explore",
        tools.explore?.startedAt ? formatWorkElapsed(clock - Number(tools.explore.startedAt)) : "")}
      {searchCount > 0 && row("search", "Web search",
        tools.search?.startedAt ? formatWorkElapsed(clock - Number(tools.search.startedAt)) : "")}
      {shellCount > 0 && row("shells", `Shell ${shellCount}`,
        String(snapshot.shellJobs?.elapsedLabel || ""))}
    </div>
  </div>;
}

function contextMetrics(snapshot: Snapshot) {
  const stats = asRecord(snapshot.stats);
  const limit = Math.max(0, Number(
    snapshot.autoCompactTokenLimit || snapshot.displayContextWindow || snapshot.contextWindow || 0,
  ));
  // Boot stability (user: the gauge flashed then vanished on New task): the
  // gauge is ALWAYS mounted — before a session, and for a session whose
  // context tokens have not been computed yet, it reads 0% instead of
  // unmounting, so the header never pops in and out.
  const idleGauge = { used: 0, limit, percent: 0, estimated: false };
  if (!String(snapshot.sessionId || "")) return idleGauge;
  if (!stats) return idleGauge;
  const exact = Math.max(0, Number(stats.currentContextTokens || 0));
  const estimated = Math.max(0, Number(stats.currentEstimatedContextTokens || 0));
  const used = exact || estimated;
  const usage = resolveContextUsage({
    usedTokens: used,
    autoCompactTokenLimit: snapshot.autoCompactTokenLimit,
    displayContextWindow: snapshot.displayContextWindow,
    contextWindow: snapshot.contextWindow,
  });
  if (!usage) return idleGauge;
  return {
    ...usage,
    estimated: exact === 0 && estimated > 0,
  };
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
    }} aria-label="Open context details"
      aria-describedby={descriptionId}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="7" />
        <circle className="context-usage-value" cx="10" cy="10" r="7"
          pathLength="100" strokeDasharray={`${context.percent} 100`} />
      </svg>
    </button>
    <div className="session-context-popover" id={descriptionId} role="tooltip">
      <div><span>Usage</span><b>{context.percent}%</b></div>
      <div><span>{context.estimated ? "Tokens (est.)" : "Tokens"}</span><b>{context.limit > 0
        ? `${context.used.toLocaleString()} / ${context.limit.toLocaleString()}`
        : context.used.toLocaleString()}</b></div>
      {(() => {
        const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
        return cost > 0
          ? <div><span>Cost</span><b>${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}</b></div>
          : null;
      })()}
      {/* Compact action removed from the hover popover by user decision —
          /compact and auto-compact remain the compaction paths. */}
    </div>
  </div>;
}

export function LiveActivity({ snapshot }: { snapshot: Snapshot }) {
  const spinner = snapshot.spinner && snapshot.spinner.active !== false ? snapshot.spinner : null;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  const activity = spinner || command;
  const [now, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || 0);
  // Stream events flip the activity mode (thinking→responding→tool-use)
  // several times a second; a status line that rewrites itself that fast
  // reads as flicker. Hold each verb for a minimum dwell before accepting
  // the next one — appearance/disappearance stays immediate.
  const heldVerb = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  useEffect(() => {
    if (!activity || !startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity, startedAt]);
  if (!activity && !snapshot.thinking) {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const mode = String(activity?.mode || (snapshot.thinking ? "thinking" : "responding"));
  if (mode === "resuming") {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const canonicalVerb: Record<string, string> = {
    requesting: "Requesting",
    responding: "Responding",
    thinking: "Thinking",
    "tool-use": "Using tools",
    "tool-input": "Using tools",
    compacting: "Compacting conversation",
    "auto-clear": "Auto-clearing conversation",
  };
  // Mirror Spinner's MODE_VERBS boundary: only those modes have a stable
  // canonical first phrase. Other modes carry engine-authored status detail.
  const rawVerb = canonicalVerb[mode] || String(activity?.verb || "Working");
  const nowMs = Date.now();
  // Engine-authored statuses (retry countdowns, compaction detail) must break
  // through immediately; only the canonical stream verbs dwell.
  const canonicalMode = Boolean(canonicalVerb[mode]);
  if (!heldVerb.current.text
    || !canonicalMode
    || (rawVerb !== heldVerb.current.text && nowMs - heldVerb.current.at >= 3_000)) {
    heldVerb.current = { text: rawVerb, at: nowMs };
  }
  const verb = heldVerb.current.text;
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  const reasoning = publicThinkingSummary(snapshot.thinking);
  return <div className="live-activity" data-mode={mode}>
    <div className="live-activity-status" role="status" aria-live="polite">
      <TextShimmer text={verb} />
      {(elapsed || outputTokens > 0) && <small>
        {[elapsed, outputTokens > 0 ? `${formatTokenCount(outputTokens)} tokens` : ""].filter(Boolean).join(" · ")}
      </small>}
    </div>
    {reasoning && <details className="thinking-disclosure">
      <summary>View reasoning</summary>
      <pre>{reasoning}</pre>
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

export function CompletionStatus({ item }: { item: TranscriptItem }) {
  const tone = completionTone(item);
  const label = String(item.label || item.status || "");
  if (tone === "failed" || tone === "interrupted") {
    const elapsed = formatElapsed(item.elapsedMs);
    const fallback = tone === "failed" ? "Failed" : elapsed ? `Cancelled after ${elapsed}` : "Cancelled";
    const visible = tone === "failed" && !/^(done|complete|completed)$/i.test(label) ? label || fallback : fallback;
    return <div className={`turn-status ${tone}`} role="status">
      <X size={13} />{visible}
    </div>;
  }
  if (tone === "compaction") {
    return <div className="compaction-divider" role="status">
      <span>{label || "Conversation compacted"}</span>
      {item.detail && <small>{item.detail}</small>}
    </div>;
  }
  const elapsed = formatElapsed(item.elapsedMs);
  const completionLabel = item.kind === "turndone"
    ? [String(item.verb || item.label || "Thought"), elapsed ? `for ${elapsed}` : ""].filter(Boolean).join(" ")
    : label || "Complete";
  return <div className="turn-status complete" role="status">
    <Check size={13} />
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
    aria-label={copied ? "Copied" : label} data-copied={copied || undefined}
    data-tooltip={copied ? "Copied" : "Copy"} data-tooltip-side={tooltipSide}>
    {copied ? <MxIcon name="check" size={13} /> : <MxIcon name="copy" size={13} />}
  </button>;
}

let markdownBodyReady = false;
let markdownBodyPromise: Promise<typeof import("./MarkdownBody")> | null = null;
export function preloadMarkdownBody() {
  markdownBodyPromise ||= import("./MarkdownBody").then((module) => {
    markdownBodyReady = true;
    return module;
  }).catch((error) => {
    markdownBodyPromise = null;
    throw error;
  });
  return markdownBodyPromise;
}
export const MarkdownBody = lazy(preloadMarkdownBody);
const StableMarkdownBody = React.memo(function StableMarkdownBody({ text }: { text: string }) {
  return <MarkdownBody text={text} copyControl={CopyControl} />;
});

export const MarkdownResponse = React.memo(function MarkdownResponse({ text, streaming }: {
  text: string;
  streaming: boolean;
}) {
  const [renderedText, setRenderedText] = useState(text);
  const pendingText = useRef(text);
  const parseTimer = useRef<number | undefined>(undefined);
  const markdownCache = useRef(createStreamingMarkdownCache());
  pendingText.current = text;
  useEffect(() => {
    if (!streaming) {
      window.clearTimeout(parseTimer.current);
      parseTimer.current = undefined;
      setRenderedText(text);
      return undefined;
    }
    if (parseTimer.current === undefined) {
      parseTimer.current = window.setTimeout(() => {
        parseTimer.current = undefined;
        setRenderedText(pendingText.current);
      }, 80);
    }
    return undefined;
  }, [text, streaming]);
  useEffect(() => () => window.clearTimeout(parseTimer.current), []);
  const markdownParts = resolveStreamingMarkdownChunks(renderedText, streaming, markdownCache.current);
  return <div className={`markdown ${streaming ? "streaming" : ""}`}>
    <Suspense fallback={<div className="markdown-plain">{renderedText}</div>}>
      {markdownParts.stableChunks.map((chunk, index) => (
        <StableMarkdownBody key={`stable-${index}`} text={chunk} />
      ))}
      {markdownParts.unstableText
        ? <StableMarkdownBody key="unstable" text={markdownParts.unstableText} />
        : null}
    </Suspense>
    {streaming && <span className="stream-cursor" aria-hidden="true" />}
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
    chips.push({ name: "Image", dims: "", title: "Attached image" });
  }
  return { text: kept.join("\n").trim(), chips };
}

// Webhook fires embed a trust-fencing block (directive + WEBHOOK_UNTRUSTED_DATA
// markers around headers/payload) that the MODEL needs verbatim but the user
// bubble should not shout: fold it into a collapsed "Webhook payload" box and
// keep only the operator-authored instructions as the visible message text.
const WEBHOOK_FENCE_RE =
  /(?:The block between the WEBHOOK_UNTRUSTED_DATA markers[^\n]*\n+)?<<<WEBHOOK_UNTRUSTED_DATA_BEGIN>>>\n?([\s\S]*?)\n?<<<WEBHOOK_UNTRUSTED_DATA_END>>>/;
export function extractWebhookPayload(text: string): { text: string; payload: string } {
  const match = WEBHOOK_FENCE_RE.exec(text);
  if (!match) return { text, payload: "" };
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text: stripped, payload: (match[1] || "").trim() };
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  completion,
  attachedUser = false,
}: {
  item: TranscriptItem;
  completion?: TranscriptItem;
  attachedUser?: boolean;
}) {
  const previousStreaming = useRef(Boolean(item.streaming));
  const announceSettled = previousStreaming.current && !item.streaming;
  useEffect(() => {
    previousStreaming.current = Boolean(item.streaming);
  }, [item.streaming]);
  if (item.kind === "tool") {
    if (shouldSuppressFullyFailedToolItem(item)) return null;
    return <ToolCard item={item} />;
  }
  if (item.kind === "statusdone" || item.kind === "turndone") {
    return <CompletionStatus item={item} />;
  }
  if (item.kind === "notice") {
    return <div className={`notice ${item.tone === "error" ? "error" : ""}`}
      role={item.tone === "error" ? "alert" : "status"}>{item.text}</div>;
  }
  if (item.kind !== "user" && item.kind !== "assistant") return null;
  const user = item.kind === "user";
  const text = String(item.text || "");
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
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"} ${user && attachedUser ? "attached-user" : ""}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}>
        <div className="message-body">
          {user ? <>
            {(attachedImages.length > 0 || markerChips.length > 0) && <div className="message-image-chips"
              aria-label="Attached images">
              {attachedImages.map((image, index) => {
                const preview = imagePreviewCache.get(imagePreviewKey(image.id, image.bytes));
                return <span className="message-image-chip" key={`${image.id ?? 'img'}-${index}`}
                  title={image.name || 'Attached image'}>
                  {preview
                    ? <img src={preview} alt={image.name || 'Attached image'} />
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
            {webhookFold.payload ? <details className="message-webhook-payload">
              <summary>Webhook payload</summary>
              <pre>{webhookFold.payload}</pre>
            </details> : null}
          </> : (
            <MarkdownResponse text={text} streaming={Boolean(item.streaming)} />
          )}
        </div>
        {user && !item.streaming && text && <footer className="message-meta-line"
          aria-label="Message details">
          {metadata.details.length > 0 && <span className="message-meta">
            {metadata.details.join("\u00A0\u00B7\u00A0")}
          </span>}
          <CopyControl value={text} label="Copy message"
            className="message-actions user-copy" />
        </footer>}
        {!user && !item.streaming && (text || completion) && <footer className="response-footer"
          aria-label="Response details">
          {completion && <CompletionStatus item={completion} />}
          {/* Timestamp marks the END of a turn: mid-turn assistant paragraphs
              (tool calls still running) must not carry a clock (user). */}
          {Boolean(completion) && metadata.shortTime &&
            <time className="message-time">{metadata.shortTime}</time>}
          {text && <CopyControl value={text} label="Copy response"
            className="message-actions response-copy" />}
        </footer>}
      </article>
      {announceSettled && !completion && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Mixdog response complete.
      </p>}
    </>
  );
}, (previous, next) => (
  previous.item === next.item ||
  transcriptItemSignature(previous.item) === transcriptItemSignature(next.item)
) && (
  previous.completion === next.completion ||
  transcriptItemSignature(previous.completion) === transcriptItemSignature(next.completion)
  ) && previous.attachedUser === next.attachedUser);

export function ToolCard({ item }: { item: TranscriptItem }) {
  // Default collapsed (user decision): the engine's `expanded` flag mirrors
  // the terminal's ctrl+o state and must not force desktop cards open — the
  // `└ detail` row already carries the summary, and the desktop chevron owns
  // raw-body expansion.
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const done = item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
  // Ticking clock for the running card's shared `Running · 12s` detail row.
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
  const exited = !failed && exitFailedCount > 0;
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const parsedArgs = asRecord(surface.args);
  const shellCommand = category === "Shell"
    ? String(parsedArgs?.command || parsedArgs?.cmd || parsedArgs?.script || "").trim()
    : "";
  const rawResult = item.result ?? item.rawResult;
  // TUI parity (user request): header label, casing, parenthesized arg
  // summary, and the always-visible `└ detail` row all come from the SAME
  // shared derivation the terminal consumes (deriveToolCardModel). The
  // desktop adds only icons/chevron/expansion chrome around it.
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
  const errorCard = (failed || denied) && hasResult;
  // Streamed tail from the running command (engine liveOutput plumbing).
  // Only meaningful pre-settlement; the settled result supersedes it.
  const liveOutput = !done && typeof item.liveOutput === "string" ? item.liveOutput : "";
  // User contract (final): collapsed = header ONLY; expanding shows JUST the
  // one-line summary row — no raw body blocks. Running cards keep their
  // progress row/live tail without a click.
  const detailRowVisible = Boolean(model.detailLine) && !liveOutput && (open || !done);
  return (
    <article className={`tool-card ${failed || denied ? "failed" : ""} ${partialFailed ? "partial-failed" : ""} ${exited ? "exited" : ""} ${done ? "settled" : ""}`}
      data-category={category} data-kind={errorCard ? "tool-error-card" : undefined}
      data-open={open ? "true" : "false"}>
      <button className="tool-header" disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)} aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? contentId : undefined}>
        {/* Keep the tool's own glyph on failure (user): danger color + blink
            carries the signal; no X swap. */}
        <span className="tool-icon">{toolIcon(category)}</span>
        <span className="tool-title">
          <b data-component={item.aggregate ? "tool-count-summary" : "tool-status-title"}
            data-active={!done ? "true" : "false"}>
            <TextShimmer text={model.labelText} active={!done} />
          </b>
          {model.summaryText && <small>({model.summaryText})</small>}
        </span>
        {model.headerFailureText && <span className="tool-state failed" role="status">
          {model.headerFailureText}
        </span>}
        {!done && <span className="sr-only" role="status">Running</span>}
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
      {liveOutput && (
        <div className="tool-content" id={contentId} data-live="true">
          <ToolOutput value={liveOutput} command={shellCommand} follow />
        </div>
      )}
    </article>
  );
}

function ToolOutput({ value, command = "", copyLabel, follow = false }: {
  value: unknown;
  command?: string;
  copyLabel?: string;
  follow?: boolean;
}) {
  const output = boundedTextOf(value);
  const text = command ? `$ ${command}${output.trim() ? `\n\n${output}` : ""}` : output;
  const scroller = useRef<HTMLDivElement>(null);
  // Live tails append at the bottom; keep the capped viewport pinned there
  // (reference clients' terminal-follow behavior). Static outputs never jump.
  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [follow, text]);
  if (!text.trim()) return null;
  return <div className={`tool-output ${command ? "shell-output" : ""}`}>
    {copyLabel && <CopyControl value={text} label={copyLabel}
      className="tool-detail-copy tool-output-copy" />}
    <div className="tool-output-scroll" ref={scroller}>
      <pre><code>{text}</code></pre>
    </div>
  </div>;
}

function DetailBlock({ label, value, copyLabel }: { label: string; value: unknown; copyLabel?: string }) {
  const text = boundedTextOf(value);
  if (!text.trim()) return null;
  return <div className="detail-block">
    <div className="detail-block-heading"><span>{label}</span>
      {copyLabel && text && <CopyControl value={text} label={copyLabel} className="tool-detail-copy" />}
    </div>
    <pre>{text}</pre>
  </div>;
}

// Structured Input block: per-tool key/value rows
// instead of a raw args JSON dump. Long values (prompts,
// briefs) drop into a wrapped block in the value column.
function ToolInputBlock({ name, args }: { name: string; args: RecordValue }) {
  const rows = useMemo(() => toolInputRows(name, args) as Array<{
    key: string; value: string; block: boolean;
  }>, [name, args]);
  if (!rows.length) return null;
  return <div className="detail-block tool-input-block">
    <div className="detail-block-heading"><span>Input</span></div>
    <div className="tool-args">
      {rows.map((row, index) => (
        <div className="tool-arg" key={`${row.key}:${index}`}>
          <span data-slot="key">{row.key}</span>
          {row.block
            ? <pre data-slot="value">{row.value}</pre>
            : <span data-slot="value">{row.value}</span>}
        </div>
      ))}
    </div>
  </div>;
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
                <Suspense fallback={<div className="diff-loading" aria-hidden="true">Loading diff…</div>}>
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
          {expanded ? "Collapse diff" : "Show full diff"}
        </button>
      )}
    </section>
  );
}
