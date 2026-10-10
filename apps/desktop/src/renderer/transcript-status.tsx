import { FoldVertical, GitFork, ListTree, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import { resolveContextDisplayUsage } from './context-usage';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { useHoverPopover } from './hover-popover';
import { t, uiFormatLocale } from './i18n';
import { uiCurrency } from './ui-format';
import { MxIcon } from './MxIcon';
import { showDesktopToast } from './notifications';
import { inheritSessionDirectly, sessionModelSelection, shouldOfferSessionInheritance } from './session-inheritance';
import { asRecord, formatElapsed, publicThinkingSummary } from './text-format';
import { completionTone, formatTokenCount, TextShimmer } from './transcript-primitives';
import { localizedTurnFailureReason } from './transcript-failure-text';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { SPINNER_MODE_OVERRIDE_VERBS, SPINNER_VERBS, spinnerVerbFor } from '../../../../src/tui/spinner-verbs.mjs';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { buildSpinnerMeta } from '../../../../src/tui/spinner-meta.mjs';

const CONTEXT_USAGE_MEMORY_LIMIT = 64;
// Clockwise r=8.5 rings around (12,12) starting at -120deg, 0deg and 120deg.
const LIVE_ACTIVITY_ARC_PATHS = [
  'M7.75 4.639A8.5 8.5 0 0 1 16.25 19.361A8.5 8.5 0 0 1 7.75 4.639',
  'M20.5 12A8.5 8.5 0 0 1 3.5 12A8.5 8.5 0 0 1 20.5 12',
  'M7.75 19.361A8.5 8.5 0 0 1 16.25 4.639A8.5 8.5 0 0 1 7.75 19.361',
];
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
  const runContextAction = async (action: () => Promise<void>) => {
    actionInFlight.current = true;
    setActionPending(true);
    try {
      await action();
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      actionInFlight.current = false;
      setActionPending(false);
    }
  };
  const inherit = async () => {
    if (!sessionId || !onInherit || !inheritRoute || actionBusy || actionInFlight.current) return;
    await runContextAction(async () => {
      if (await inheritSessionDirectly(sessionId, inheritRoute, onInherit)) popover.close();
    });
  };
  const compact = async () => {
    if (!sessionId || actionBusy || actionInFlight.current) return;
    await runContextAction(async () => {
      await window.mixdogDesktop.invokeCapability({ capability: 'compact', sessionId });
    });
  };
  const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
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
          {cost > 0 && (
            <div>
              <span>{t('Cost')}</span>
              <b>{uiCurrency(cost, cost >= 1 ? 2 : 3)}</b>
            </div>
          )}
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

/** Does a running command (no turn) paint the activity band? A session
 *  resume — including the quiet viewer-follow re-resume, which carries no
 *  status — paints nothing (LiveActivity returns null for it), so the thread
 *  must not reserve the band's 24px for it either: first entry into a stored
 *  session flashed an empty band under the settled tail and bounced the whole
 *  transcript 36px up and back (user: 세션 처음 들어갈 때 위아래로 떨린다). */
export function commandShowsActivity(snapshot: Snapshot): boolean {
  if (snapshot.spinner && snapshot.spinner.active !== false) return true;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  return Boolean(command) && String(command?.mode || '') !== 'resuming';
}

export function LiveActivity({
  snapshot,
  optimisticStartedAt = 0,
  turnKey = '',
}: {
  snapshot: Snapshot;
  optimisticStartedAt?: number;
  turnKey?: string;
}) {
  const spinner = snapshot.spinner && snapshot.spinner.active !== false ? snapshot.spinner : null;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  const activity = spinner || command;
  const optimisticActivity = !activity && optimisticStartedAt > 0;
  const [, setNow] = useState(Date.now());
  const activityStartedAt = Number(activity?.startedAt || 0);
  const submitStartedAt = optimisticStartedAt > 0 ? optimisticStartedAt : 0;
  // The submit clock starts before the spinner exists. Keep that first
  // timestamp for this mounted row; a later spinner.startedAt must not zero it.
  const clockRef = useRef(0);
  let earliest = 0;
  if (activityStartedAt > 0) earliest = activityStartedAt;
  if (submitStartedAt > 0 && (earliest === 0 || submitStartedAt < earliest)) earliest = submitStartedAt;
  if (earliest > 0 && (clockRef.current === 0 || earliest < clockRef.current)) clockRef.current = earliest;
  const startedAt = clockRef.current;
  // Keep the first timestamp for a turn so thinking/tool/response transitions
  // do not restart the phrase rotation.
  const anchorRef = useRef(0);
  const mountedAt = useRef(Date.now());
  const liveSessionId = String(snapshot.sessionId || '').trim();
  useLayoutEffect(() => {
    if (!liveSessionId || !turnKey) return;
    liveActivityTurns.add(liveTurnKey(liveSessionId, turnKey));
  }, [liveSessionId, turnKey]);
  const logoGradientId = `live-logo-${useId().replace(/:/g, '')}`;
  const pauseTurnRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef(0);
  const clockPaused = String(activity?.mode || '') === 'resuming';
  useEffect(() => {
    if (!startedAt || clockPaused) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [clockPaused, startedAt]);
  if (!activity && !optimisticActivity && !snapshot.thinking && !startedAt) {
    anchorRef.current = 0;
    return null;
  }
  let fallbackMode = 'responding';
  if (snapshot.thinking) fallbackMode = 'thinking';
  else if (optimisticActivity || !activity) fallbackMode = 'requesting';
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
          <svg
            className="live-activity-logo live-activity-arcs"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={logoGradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" />
                <stop offset="1" />
              </linearGradient>
            </defs>
            {/* Each arc is the same r=8.5 ring started 120deg apart, drawn as an
                un-rotated path: a rotate() transform would also rotate the
                gradient, so the arc taking over at the loop seam showed a
                different colour and the mark flickered on every restart. */}
            <g stroke={`url(#${logoGradientId})`}>
              {LIVE_ACTIVITY_ARC_PATHS.map((d) => (
                <path key={d} className="arc" d={d} pathLength="360" />
              ))}
            </g>
          </svg>
          <svg
            className="live-activity-logo live-activity-star"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            aria-hidden="true"
          >
            <path
              className="star"
              fill={`url(#${logoGradientId})`}
              d="M12 8.4Q12.6 11.4 15.6 12 12.6 12.6 12 15.6 11.4 12.6 8.4 12 11.4 11.4 12 8.4Z"
            />
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
      return label;
  }
}

function translateStatusDetail(detail: unknown): string {
  const text = String(detail || '').trim();
  if (!text) return '';
  if (text.startsWith('conversation kept · ')) {
    const reason = text.slice('conversation kept · '.length);
    return t('Conversation kept · {{reason}}', { reason: localizedTurnFailureReason(reason) });
  }
  if (text === 'Continuing with the previous context.') {
    return t('Continuing with the previous context.');
  }
  if (text === 'no active session') {
    return t('No active session');
  }
  return localizedTurnFailureReason(text);
}

// A completion is durable history, not an entrance event. Focus, history
// hydration and virtual-row remounts must paint it in its final state.
// The core stamps no completion time on turndone rows, so "completed while the
// user was watching" is decided by identity: a LiveActivity mounted for a session + turn records
// that pair, and only the completion of that same pair animates. Rows restored
// by opening or re-entering a session never had a live band in this view.
const liveActivityTurns = new Set<string>();
const completedActivityTurns = new Set<string>();
const liveTurnKey = (sessionId: string, turnKey: string) => `${sessionId}\0${turnKey}`;

export function completionActivityKey(sessionId: string, turnKey: string): string {
  return sessionId && turnKey ? liveTurnKey(sessionId, turnKey) : '';
}

/** Did this mounted view show a live activity for the session's turn? */
export function hadLiveActivity(sessionId: string, turnKey: string): boolean {
  const key = completionActivityKey(sessionId, turnKey);
  return Boolean(key) && liveActivityTurns.has(key) && !completedActivityTurns.has(key);
}

/** `animateComplete` is the caller's explicit decision (see hadLiveActivity);
 *  consume the turn on commit, not during a render React may discard. */
export function CompletionStatus({
  item,
  animateComplete: animate = false,
  completionActivityKey: activityKey = '',
}: {
  item: TranscriptItem;
  animateComplete?: boolean;
  completionActivityKey?: string;
}) {
  const [animateComplete] = useState(() => animate && !completedActivityTurns.has(activityKey));
  useLayoutEffect(() => {
    if (!activityKey) return;
    completedActivityTurns.add(activityKey);
    liveActivityTurns.delete(activityKey);
  }, [activityKey]);
  const tone = completionTone(item);
  const label = String(item.label || item.status || '');
  if (item.kind === 'statusdone' && item.status === 'inherited') {
    return (
      <div className="compaction-divider" role="status">
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
      <div className={`turn-status ${tone}`} role="status">
        <X className="turn-status-icon" size={16} aria-hidden="true" />
        <span>{visible}</span>
      </div>
    );
  }
  if (tone === 'compaction') {
    const displayLabel = translateStatusLabel(label) || label || t('Conversation compacted');
    const displayDetail = translateStatusDetail(item.detail);
    return (
      <div className="compaction-divider" role="status">
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
    <div className="turn-status complete" role="status" data-animate={animateComplete ? 'true' : undefined}>
      {animateComplete ? (
        <span className="turn-status-mark" aria-hidden="true">
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the wrapping mark is aria-hidden. */}
          <svg className="turn-status-logo" viewBox="0 0 24 24">
            <g>
              {[-120, 0, 120].map((rot) => (
                <circle
                  key={rot}
                  className="arc"
                  cx="12"
                  cy="12"
                  r="8.5"
                  pathLength="360"
                  transform={`rotate(${rot} 12 12)`}
                />
              ))}
            </g>
            <path className="star" d="M12 8.4Q12.6 11.4 15.6 12 12.6 12.6 12 15.6 11.4 12.6 8.4 12 11.4 11.4 12 8.4Z" />
          </svg>
          {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative; the wrapping mark is aria-hidden. */}
          <svg
            className="turn-status-icon turn-status-check mx-icon lucide-check"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" pathLength="1" />
          </svg>
        </span>
      ) : (
        <MxIcon name="check" className="turn-status-icon" size={16} />
      )}
      <span>{completionLabel}</span>
      {item.kind === 'statusdone' && displayDetail && <small>· {displayDetail}</small>}
    </div>
  );
}
