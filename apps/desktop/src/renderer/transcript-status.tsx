import { FoldVertical, GitFork, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveContextDisplayUsage } from "./context-usage";
import { type Snapshot, type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { MxIcon } from "./MxIcon";
import { useMobileBack } from "./mobile-back";
import { showDesktopToast } from "./notifications";
import { ProgressSpinner } from "./ProgressSpinner";
import { shouldOfferSessionInheritance } from "./session-inheritance";
import { touchPrimaryPointer } from "./surface-input-focus";
import { asRecord, formatElapsed, publicThinkingSummary } from "./text-format";
import {
  completionTone,
  formatTokenCount,
  formatWorkElapsed,
  TERMINAL_AGENT_STATUS,
  TextShimmer,
  timeMs,
} from "./transcript-primitives";
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from "../../../../src/tui/spinner-verbs.mjs";
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { buildSpinnerMeta } from "../../../../src/tui/spinner-meta.mjs";

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
  const total = agentCount + webSearchCount + shellCount;
  const row = (key: string, label: string, elapsed: string) => <div className="live-work-row" key={key}>
    <span>{label}</span>
    <small>{elapsed}</small>
  </div>;
  return <div className="live-work-status" role="status" tabIndex={0}
    aria-label={t("Background activity: {{count}} running", { count: total })}>
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
  const usage = resolveContextDisplayUsage(snapshot);
  const sessionId = String(snapshot.sessionId || "").trim();
  if (!sessionId) return usage;
  const stats = asRecord(snapshot.stats) ?? {};
  const hasContextReading = Object.hasOwn(stats, "currentContextTokens")
    || Object.hasOwn(stats, "currentEstimatedContextTokens");
  if (!hasContextReading) return rememberedContextUsage.get(sessionId) ?? usage;
  if (usage.limit > 0) {
    rememberedContextUsage.delete(sessionId);
    rememberedContextUsage.set(sessionId, usage);
    while (rememberedContextUsage.size > CONTEXT_USAGE_MEMORY_LIMIT) {
      const oldest = rememberedContextUsage.keys().next().value;
      if (typeof oldest !== "string") break;
      rememberedContextUsage.delete(oldest);
    }
  }
  // Complete backend readings always win. The cache only bridges frames that
  // omit context fields entirely; it never recomputes or mixes token sources.
  return usage;
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
  const tone = !context ? ""
    : context.percent >= 90 ? "danger"
      : context.percent >= 70 ? "warning" : "";
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
      <div className="context-popover-header">
        <span>{t("Context")}</span>
        <b>{context.percent}%</b>
      </div>
      <div><span>{t("Usage")}</span><b
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
      {/* One action at a time: a model switch offers inheritance (compact +
          hand over); otherwise plain compaction. */}
      {offerInheritance
        ? <button type="button" className="context-action context-inherit"
          disabled={compactBusy} onClick={() => {
            setPinned(false);
            setPopoverOpen(false);
            onInherit?.();
          }}>
          <GitFork size={14} aria-hidden="true" />
          {t("Inherit session")}
        </button>
        : <button type="button" className="context-action context-compact" disabled={compactBusy}
          onClick={() => { void compact(); }}>
          <FoldVertical size={14} aria-hidden="true" />
          {t("Compact context")}
        </button>}
    </div>}
  </div>;
}

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
  const [, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || (optimisticActivity ? optimisticStartedAt : 0));
  // Keep the first timestamp for a turn so thinking/tool/response transitions
  // do not restart the phrase rotation.
  const anchorRef = useRef(0);
  const mountedAt = useRef(Date.now());
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
  const elapsedMs = startedAt ? Math.max(0, nowMs - startedAt - pausedMs) : 0;
  const elapsed = formatElapsed(elapsedMs);
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  const activityRecord = asRecord(activity) || {};
  const meta = buildSpinnerMeta({
    elapsedMs,
    outputTokens,
    thinking: Boolean(activityRecord.thinking || snapshot.thinking),
    thinkingSince: Number(activityRecord.thinkingSegmentStartedAt || 0),
    thinkingMs: Number(activityRecord.thinkingAccumulatedMs || 0),
    effort: String(snapshot.effort || ""),
  });
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
      <FoldVertical className="compaction-icon" size={16} aria-hidden="true" />
      <span>{label || t("Conversation compacted")}</span>
      {item.detail && <small>{item.detail}</small>}
    </div>;
  }
  const elapsed = formatElapsed(item.elapsedMs);
  const doneVerb = String(item.verb || item.label || "Thought").trim() || "Thought";
  const completionLabel = item.kind === "turndone"
    ? (elapsed ? t("{{verb}} for {{elapsed}}", { verb: t(doneVerb), elapsed }) : t(doneVerb))
    : label || t("Complete");
  return <div className="turn-status complete" role="status"
    data-animate={animate ? "true" : undefined}>
    <MxIcon name="check" className="turn-status-icon" size={16} />
    <span>{completionLabel}</span>
    {item.kind === "statusdone" && item.detail && <small>· {item.detail}</small>}
  </div>;
}
