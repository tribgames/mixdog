import { FoldVertical, GitFork, ListTree, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import { resolveContextDisplayUsage } from './context-usage';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { useHoverPopover } from './hover-popover';
import { t, uiFormatLocale } from './i18n';
import { uiCurrency } from './ui-format';
import { MxIcon } from './MxIcon';
import { showDesktopToast } from './notifications';
import { ProgressSpinner } from './ProgressSpinner';
import { inheritancePreflight, sessionModelSelection, shouldOfferSessionInheritance } from './session-inheritance';
import { asRecord, formatElapsed, publicThinkingSummary } from './text-format';
import {
  completionTone,
  formatTokenCount,
  formatWorkElapsed,
  TERMINAL_AGENT_STATUS,
  TextShimmer,
  timeMs,
} from './transcript-primitives';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from '../../../../src/tui/spinner-verbs.mjs';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { buildSpinnerMeta } from '../../../../src/tui/spinner-meta.mjs';

export function LiveWorkStatus({ snapshot, now: fixedNow }: { snapshot: Snapshot; now?: number }) {
  const [clock, setClock] = useState(() => fixedNow ?? Date.now());
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  const taggedRunningKeys = new Set<string>();
  let untaggedRunningCount = 0;
  let oldestAgentStart = Infinity;
  workers.forEach((worker) => {
    const tag = String(worker.tag || worker.agent || worker.name || '').trim();
    if (TERMINAL_AGENT_STATUS.test(String(worker.stage || worker.status || ''))) return;
    if (tag) taggedRunningKeys.add(tag);
    else untaggedRunningCount += 1;
    const startedAt = timeMs(worker.startedAt || worker.startTime || worker.createdAt);
    if (startedAt > 0) oldestAgentStart = Math.min(oldestAgentStart, startedAt);
  });
  jobs.forEach((job) => {
    if (!/running|pending|queued|starting/i.test(String(job.status || job.stage || ''))) return;
    const tag = String(job.tag || job.agent || job.type || job.task_id || job.taskId || '').trim();
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
    Math.max(0, Number(tools.shell?.count) || 0)
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
  let agentElapsed = '';
  if (Number.isFinite(oldestAgentStart)) agentElapsed = formatWorkElapsed(clock - oldestAgentStart);
  else if (tools.agent?.startedAt) agentElapsed = formatWorkElapsed(clock - Number(tools.agent.startedAt));
  const row = (key: string, label: string, elapsed: string) => (
    <div className="live-work-row" key={key}>
      <span>{label}</span>
      <small>{elapsed}</small>
    </div>
  );
  return (
    <div
      className="live-work-status"
      role="status"
      tabIndex={0}
      aria-label={t('Background activity: {{count}} running', { count: total })}
    >
      <ProgressSpinner className="live-work-spinner" size={16} aria-hidden="true" />
      <span className="live-work-count">{total}</span>
      <div className="live-work-popover" role="tooltip">
        {agentCount > 0 && row('agents', `${agentCount === 1 ? t('Agent') : t('Agents')} ${agentCount}`, agentElapsed)}
        {webSearchCount > 0 &&
          row(
            'web_search',
            t('Web search'),
            tools.web_search?.startedAt ? formatWorkElapsed(clock - Number(tools.web_search.startedAt)) : ''
          )}
        {shellCount > 0 &&
          row(
            'shells',
            `${t('Shell')} ${shellCount}`,
            String(snapshot.shellJobs?.elapsedLabel || '') ||
              (tools.shell?.startedAt ? formatWorkElapsed(clock - Number(tools.shell.startedAt)) : '')
          )}
      </div>
    </div>
  );
}

const CONTEXT_USAGE_MEMORY_LIMIT = 64;
const rememberedContextUsage = new Map<string, ReturnType<typeof resolveContextDisplayUsage>>();

type ContextUsageMetrics = NonNullable<ReturnType<typeof resolveContextDisplayUsage>>;

/** Exact counts for the tooltip; the visible text uses the compact form. */
function contextUsageTitle(context: ContextUsageMetrics): string | undefined {
  if (context.used == null) return undefined;
  const used = context.used.toLocaleString(uiFormatLocale());
  return context.limit > 0 ? `${used} / ${context.limit.toLocaleString(uiFormatLocale())}` : used;
}

function contextUsageText(context: ContextUsageMetrics): string {
  if (context.used == null) return '—';
  const used = formatTokenCount(context.used);
  return context.limit > 0 ? `${used} / ${formatTokenCount(context.limit)}` : used;
}

function contextMetrics(snapshot: Snapshot) {
  const usage = resolveContextDisplayUsage(snapshot);
  const sessionId = String(snapshot.sessionId || '').trim();
  if (!sessionId) return usage;
  const cacheKey = `${sessionId}:${snapshot.provider || ''}:${snapshot.model || ''}`;
  const stats = asRecord(snapshot.stats) ?? {};
  const hasContextReading =
    Object.hasOwn(stats, 'currentContextTokens') ||
    Object.hasOwn(stats, 'currentEstimatedContextTokens') ||
    Object.hasOwn(stats, 'currentContextSource');
  if (!hasContextReading) return rememberedContextUsage.get(cacheKey) ?? usage;
  if (usage.limit > 0) {
    rememberedContextUsage.delete(cacheKey);
    rememberedContextUsage.set(cacheKey, usage);
    while (rememberedContextUsage.size > CONTEXT_USAGE_MEMORY_LIMIT) {
      const oldest = rememberedContextUsage.keys().next().value;
      if (typeof oldest !== 'string') break;
      rememberedContextUsage.delete(oldest);
    }
  }
  // Complete backend readings always win. The cache only bridges frames that
  // omit context fields entirely; it never recomputes or mixes token sources.
  return usage;
}

export function ContextUsageIndicator({
  snapshot,
  open: controlledOpen,
  onOpenChange,
  onInherit,
  onViewDetails,
}: {
  snapshot: Snapshot;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Runs the handover itself (user: 팝업 안 뜨고 바로 진행되게). Inheritance is
   *  a mechanical carry into a fresh session — so the
   *  button IS the decision; the old dialog only restated readings this card
   *  already shows. The host still owns opening the heir's tab. */
  onInherit?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onViewDetails?: () => void;
}) {
  // The card hangs 6px off the gauge, so the pointer heading for it leaves the
  // gauge first; the shared hover contract holds the card through that trip
  // instead of closing on the frame the pointer crosses the gap.
  const popover = useHoverPopover({ open: controlledOpen, onOpenChange });
  const popoverOpen = popover.open;
  const context = contextMetrics(snapshot);
  const descriptionId = `context-usage-${String(snapshot.sessionId || 'session')}`;
  const contextPercent = context?.percent ?? 0;
  let tone = '';
  if (context && contextPercent >= 90) tone = 'danger';
  else if (context && contextPercent >= 70) tone = 'warning';
  const [actionPending, setActionPending] = useState(false);
  const actionInFlight = useRef(false);
  const state = asRecord(snapshot);
  const sessionId = String(state?.sessionId || '').trim();
  const actionBusy = actionPending || Boolean(state?.busy) || Boolean(state?.commandBusy);
  const inheritRoute = sessionModelSelection(snapshot);
  const offerInheritance = Boolean(onInherit) && Boolean(inheritRoute) && shouldOfferSessionInheritance(snapshot);
  // The one fact the card cannot act through is a transcript that no longer
  // fits — and THIS card's readings cannot answer that question: they belong to
  // the session's own route, while the carry lands on the selected one. The
  // runtime measures the heir's route; the refusal is named here in the user's
  // own terms before any session is created.
  const inherit = async () => {
    if (!sessionId || !onInherit || !inheritRoute || actionBusy || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionPending(true);
    try {
      const fit = await inheritancePreflight(sessionId, inheritRoute);
      if (fit?.known && !fit.fits) {
        if (!fit.willCompact) {
          showDesktopToast(t('This conversation no longer fits the model context. Run /compact first.'), 'warn');
          return;
        }
        // The carry takes a summarization pass first. Say so: the handover is
        // about to take a while, and this session keeps its full transcript.
        showDesktopToast(t('This conversation is compacted for the new model before it carries over.'), 'info');
      }
      await onInherit(sessionId, inheritRoute);
      popover.close();
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };
  const compact = async () => {
    if (!sessionId || actionBusy || actionInFlight.current) return;
    actionInFlight.current = true;
    setActionPending(true);
    try {
      await window.mixdogDesktop.invokeCapability({ capability: 'compact', sessionId });
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };
  return (
    <div
      className="session-context-indicator"
      {...popover.hostProps}
      data-active={context ? 'true' : 'false'}
      {...(tone ? { 'data-tone': tone } : {})}
      data-open={popoverOpen ? 'true' : 'false'}
    >
      <button
        type="button"
        {...popover.triggerProps}
        aria-label={context ? t('Context usage') : t('Context unavailable')}
        aria-expanded={popoverOpen}
        aria-describedby={context ? descriptionId : undefined}
        disabled={!context}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle className="context-usage-track" cx="10" cy="10" r="8" />
          <circle
            className="context-usage-value"
            cx="10"
            cy="10"
            r="8"
            pathLength="100"
            strokeDasharray={`${context?.percent ?? 0} 100`}
          />
        </svg>
      </button>
      {context && (
        <div className="session-context-popover" id={descriptionId} role="tooltip">
          <div className="context-popover-header">
            <span>{t('Context')}</span>
            <b>{context.percent == null ? '—' : `${context.percent}%`}</b>
          </div>
          <div>
            <span>{t('Usage')}</span>
            <b title={contextUsageTitle(context)}>{contextUsageText(context)}</b>
          </div>
          {(() => {
            const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
            if (cost <= 0) return null;
            return (
              <div>
                <span>{t('Cost')}</span>
                <b>{uiCurrency(cost, cost >= 1 ? 2 : 3)}</b>
              </div>
            );
          })()}
          {onViewDetails && (
            <button
              type="button"
              className="context-action context-details"
              onClick={() => {
                popover.close();
                onViewDetails();
              }}
            >
              <ListTree size={14} aria-hidden="true" />
              {t('View context details')}
            </button>
          )}
          {/* One mutating action at a time: a model switch offers inheritance;
          a completed handover or matching model offers plain compaction. */}
          {offerInheritance ? (
            <button
              type="button"
              className="context-action context-inherit"
              disabled={actionBusy}
              onClick={() => {
                void inherit();
              }}
            >
              <GitFork size={14} aria-hidden="true" />
              {t('Inherit session')}
            </button>
          ) : (
            <button
              type="button"
              className="context-action context-compact"
              disabled={actionBusy}
              onClick={() => {
                void compact();
              }}
            >
              <FoldVertical size={14} aria-hidden="true" />
              {t('Compact context')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const LOCALIZED_ACTIVITY_VERBS: string[] = [
  'Thinking',
  'Pondering',
  'Musing',
  'Mulling',
  'Ruminating',
  'Contemplating',
  'Considering',
  'Deliberating',
  'Cogitating',
  'Inferring',
  'Ideating',
  'Envisioning',
];

function activityVerbPool(): string[] {
  return t('Thinking') === 'Thinking' ? (SPINNER_VERBS as string[]) : LOCALIZED_ACTIVITY_VERBS;
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
  let fallbackMode = 'responding';
  if (snapshot.thinking) fallbackMode = 'thinking';
  else if (optimisticActivity) fallbackMode = 'requesting';
  const mode = String(activity?.mode || fallbackMode);
  if (mode === 'resuming') {
    anchorRef.current = 0;
    return null;
  }
  const nowMs = Date.now();
  if (!anchorRef.current || (startedAt > 0 && Math.abs(startedAt - anchorRef.current) > 5_000)) {
    anchorRef.current = startedAt || nowMs;
  }
  const overrideVerb = String(SPINNER_MODE_OVERRIDE_VERBS[mode] || '');
  const rawVerb =
    overrideVerb ||
    (mode === 'reconnecting'
      ? String(activity?.verb || 'Working')
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
  const pausedMs = pausedTotalRef.current + (pauseStartRef.current ? Math.max(0, nowMs - pauseStartRef.current) : 0);
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
    effort: String(snapshot.effort || ''),
  });
  const activityMeta = [elapsed, meta.showTokens ? meta.tokensText : '', meta.thinkingText].filter(Boolean).join(' · ');
  const reasoning = publicThinkingSummary(snapshot.thinking);
  const animateEnter = startedAt > 0 && startedAt >= mountedAt.current;
  return (
    <div className="live-activity" data-mode={mode}>
      <div
        className="live-activity-status"
        role="status"
        aria-live="polite"
        data-animate={animateEnter ? 'true' : undefined}
      >
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
      {reasoning && (
        <details className="thinking-disclosure">
          <summary>{t('View reasoning')}</summary>
          <pre data-scrollable>{reasoning}</pre>
        </details>
      )}
    </div>
  );
}

function translateStatusLabel(label: string): string {
  switch (label) {
    case 'Auto-clear complete':
      return t('Auto-clear complete');
    case 'Auto-clear skipped':
      return t('Auto-clear skipped');
    case 'Compact complete':
      return t('Compact complete');
    case 'Compact complete (overflow recovery)':
      return t('Compact complete (overflow recovery)');
    case 'Compact checked':
      return t('Compact checked');
    case 'Compact skipped':
      return t('Compact skipped');
    case 'Compact failed':
      return t('Compact failed');
    case 'Compact failed (overflow retry)':
      return t('Compact failed (overflow retry)');
    case 'Session inherited':
      return t('Session inherited');
    default:
      return label ? t(label) : '';
  }
}

function translateStatusDetail(detail: unknown): string {
  const text = String(detail || '').trim();
  if (!text) return '';
  if (text.startsWith('conversation kept · ')) {
    const reason = text.slice('conversation kept · '.length);
    return t('Conversation kept · {{reason}}', { reason: t(reason) || reason });
  }
  if (text === 'Continuing with the previous context.') {
    return t('Continuing with the previous context.');
  }
  if (text === 'no active session') {
    return t('No active session');
  }
  return t(text) || text;
}

export function CompletionStatus({ item, animate = false }: { item: TranscriptItem; animate?: boolean }) {
  const tone = completionTone(item);
  const label = String(item.label || item.status || '');
  if (item.kind === 'statusdone' && item.status === 'inherited') {
    return (
      <div className="compaction-divider" role="status" data-animate={animate ? 'true' : undefined}>
        <GitFork className="compaction-icon" size={16} aria-hidden="true" />
        <span>{t('Session inherited')}</span>
        <small>{t('Continuing with the previous context.')}</small>
      </div>
    );
  }
  if (tone === 'failed' || tone === 'interrupted') {
    const elapsed = formatElapsed(item.elapsedMs);
    let fallback = t('Cancelled');
    if (tone === 'failed') fallback = t('Failed');
    else if (elapsed) fallback = t('Cancelled after {{elapsed}}', { elapsed });
    const translated = translateStatusLabel(label);
    const visible =
      tone === 'failed' && !/^(done|complete|completed)$/i.test(label) ? translated || label || fallback : fallback;
    return (
      <div className={`turn-status ${tone}`} role="status" data-animate={animate ? 'true' : undefined}>
        <X className="turn-status-icon" size={16} aria-hidden="true" />
        <span>{visible}</span>
      </div>
    );
  }
  if (tone === 'compaction') {
    const displayLabel = translateStatusLabel(label) || label || t('Conversation compacted');
    const displayDetail = translateStatusDetail(item.detail);
    return (
      <div className="compaction-divider" role="status" data-animate={animate ? 'true' : undefined}>
        <FoldVertical className="compaction-icon" size={16} aria-hidden="true" />
        <span>{displayLabel}</span>
        {displayDetail && <small>{displayDetail}</small>}
      </div>
    );
  }
  const elapsed = formatElapsed(item.elapsedMs);
  const toolCount = Number(item.toolCount || 0);
  const elapsedMs = Math.max(0, Number(item.elapsedMs || 0));
  const doneVerb = String(item.verb || item.label || 'Thought').trim() || 'Thought';
  let completionLabel: string;
  if (item.kind === 'turndone') {
    if (toolCount > 0) {
      completionLabel = elapsed ? t('Work complete in {{elapsed}}', { elapsed }) : t('Work complete');
    } else if (elapsedMs > 0 && elapsedMs < 10_000) {
      completionLabel = t('Response complete');
    } else {
      completionLabel = elapsed ? t('{{verb}} for {{elapsed}}', { verb: t(doneVerb), elapsed }) : t(doneVerb);
    }
  } else {
    completionLabel = translateStatusLabel(label) || label || t('Complete');
  }
  const displayDetail = translateStatusDetail(item.detail);
  return (
    <div className="turn-status complete" role="status" data-animate={animate ? 'true' : undefined}>
      <MxIcon name="check" className="turn-status-icon" size={16} />
      <span>{completionLabel}</span>
      {item.kind === 'statusdone' && displayDetail && <small>· {displayDetail}</small>}
    </div>
  );
}
