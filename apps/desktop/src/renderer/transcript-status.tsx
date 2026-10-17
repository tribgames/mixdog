import { ArrowLeftRight, FoldVertical, GitFork, ListTree, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { resolveContextDisplayUsage } from './context-usage';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { useHoverPopover } from './hover-popover';
import { cachedAutoEffortCapable, useAutoEffortShown } from './auto-effort-store';
import { subscribeUiLanguage, t, uiFormatLocale } from './i18n';
import { modelDisplayName, modelRouteDisplayParts } from './provider-display';
import { uiCurrency } from './ui-format';
import { liveAgentRows } from './agent-activity-model';
import { onSessionPreviewsDeleted } from './image-preview-store';
import { goalHasBackgroundWork } from './session-goal-presentation';
import { MxIcon } from './MxIcon';
import { showDesktopToast } from './notifications';
import { asRecord, formatElapsed, publicThinkingSummary } from './text-format';
import { completionTone, formatTokenCount, TextShimmer } from './transcript-primitives';
import { localizedTurnFailureReason } from './transcript-failure-text';
import { activityVerb, thinkingEffortLabel } from './activity-verbs';
import { QuietCue, useLaneSpinnerQuiet } from './quiet-cue';
import type { QuietProgressParts } from '../../../../src/runtime/shared/quiet-progress.mjs';
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
  onViewDetails,
}: {
  snapshot: Snapshot;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onViewDetails?: () => void;
}) {
  // Click-only like the other composer chips: hovering past the gauge must not
  // surface the compact action.
  const popover = useHoverPopover({ open: controlledOpen, onOpenChange, hoverOpens: false });
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
        <ContextUsagePopover
          context={context}
          id={descriptionId}
          cost={cost}
          onViewDetails={
            onViewDetails &&
            (() => {
              popover.close();
              onViewDetails();
            })
          }
          actionBusy={actionBusy}
          onCompact={() => {
            void compact();
          }}
        />
      )}
    </div>
  );
}

function ContextUsagePopover({
  context,
  id,
  cost,
  onViewDetails,
  actionBusy,
  onCompact,
}: {
  context: NonNullable<ReturnType<typeof contextMetrics>>;
  id: string;
  cost: number;
  onViewDetails?: () => void;
  actionBusy: boolean;
  onCompact: () => void;
}) {
  return (
    <div className="session-context-popover" id={id} role="tooltip">
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
        <button type="button" className="context-action context-details" onClick={onViewDetails}>
          <ListTree size={14} aria-hidden="true" />
          {t('View context details')}
        </button>
      )}
      <button type="button" className="context-action context-compact" disabled={actionBusy} onClick={onCompact}>
        <FoldVertical size={14} aria-hidden="true" />
        {t('Compact context')}
      </button>
    </div>
  );
}

/** Does a running command (no turn) paint the activity band? A session
 *  resume — including the quiet viewer-follow re-resume, which carries no
 *  status — paints nothing (LiveActivity returns null for it), so the thread
 *  must not reserve the band's 24px for it either: first entry into a stored
 *  session flashed an empty band under the settled tail and bounced the whole
 *  transcript 36px up and back. */
export function commandShowsActivity(snapshot: Snapshot): boolean {
  if (snapshot.spinner && snapshot.spinner.active !== false) return true;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  return Boolean(command) && String(command?.mode || '') !== 'resuming';
}

function LiveActivityIcon({ gradientId }: { gradientId: string }) {
  return (
    <span className="live-activity-icon" aria-hidden="true">
      <svg
        className="live-activity-logo live-activity-arcs"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" />
            <stop offset="1" />
          </linearGradient>
        </defs>
        {/* Each arc is the same r=8.5 ring started 120deg apart, drawn as an
            un-rotated path: a rotate() transform would also rotate the
            gradient, so the arc taking over at the loop seam showed a
            different colour and the mark flickered on every restart. */}
        <g stroke={`url(#${gradientId})`}>
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
          fill={`url(#${gradientId})`}
          d="M12 8.4Q12.6 11.4 15.6 12 12.6 12.6 12 15.6 11.4 12.6 8.4 12 11.4 11.4 12 8.4Z"
        />
      </svg>
    </span>
  );
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
  // Re-render when the catalog finishes loading or the language switches.
  const language = useSyncExternalStore(subscribeUiLanguage, uiFormatLocale, uiFormatLocale);
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
  // Auto replaces the saved level: until the runtime resolves this turn's
  // effort, the saved level must not stand in for it.
  const autoShown = useAutoEffortShown(
    cachedAutoEffortCapable(String(snapshot.provider || ''), String(snapshot.model || '')),
    String(snapshot.effort || ''),
    snapshot.autoEffort
  );
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
  const quiet = useLaneSpinnerQuiet(liveSessionId, asRecord(activity)?.quiet);
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
  const verb = activityVerb({
    mode,
    runtimeVerb: String(activity?.verb || ''),
    anchor: anchorRef.current,
    now: nowMs,
    language,
  });
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
    // What the runtime actually resolved this turn/step (Auto judge); the saved
    // level when nothing was recorded (Auto off, or a model without it).
    effort: String(snapshot.turnEffort || (autoShown ? '' : snapshot.effort) || ''),
    // The turn's published quiet state: the quiet-time cue below.
    quiet,
    now: nowMs,
  });
  const quietParts = meta.quietParts as QuietProgressParts | null;
  // The TUI formats these parts as lowercase English; the desktop translates them.
  const thinkingLabel = (() => {
    const parts = meta.thinkingParts as
      | { kind: 'thinking'; effort: string }
      | { kind: 'thought'; seconds: number }
      | null;
    if (!parts) return '';
    if (parts.kind === 'thought') return t('Thought for {{seconds}}s', { seconds: parts.seconds });
    // The effort word is an untranslated name, spelled like the model chip's.
    const effortWord = modelRouteDisplayParts('', parts.effort).effort;
    return thinkingEffortLabel(effortWord, language);
  })();
  const tokensLabel = meta.showTokens ? t('{{tokens}} tokens', { tokens: meta.tokensCount }) : '';
  const activityMeta = [elapsed, tokensLabel, thinkingLabel].filter(Boolean).join(' · ');
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
        <LiveActivityIcon gradientId={logoGradientId} />
        <TextShimmer text={verb} />
        {activityMeta ? <span className="live-activity-meta">{activityMeta}</span> : null}
        {quietParts ? <QuietCue parts={quietParts} sessionId={liveSessionId} className="live-activity-quiet" /> : null}
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
    case 'Conversation compacted':
      return t('Conversation compacted');
    case 'Session inherited':
      return t('Session forked');
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

// A deleted session's turns never render again: drop its entries.
onSessionPreviewsDeleted((sessionId) => {
  const prefix = `${sessionId}\0`;
  for (const turns of [liveActivityTurns, completedActivityTurns]) {
    for (const key of turns) if (key.startsWith(prefix)) turns.delete(key);
  }
});

export function completionActivityKey(sessionId: string, turnKey: string): string {
  return sessionId && turnKey ? liveTurnKey(sessionId, turnKey) : '';
}

/** Did this mounted view show a live activity for the session's turn? */
export function hadLiveActivity(sessionId: string, turnKey: string): boolean {
  const key = completionActivityKey(sessionId, turnKey);
  return Boolean(key) && liveActivityTurns.has(key) && !completedActivityTurns.has(key);
}

export type BackgroundWorkCounts = { shell: number; agent: number };

/** Background work still running for the session, or undefined when none.
 *  Same facts as goalHasBackgroundWork: shell jobs plus non-queued agents. */
export function backgroundWorkCounts(snapshot: Snapshot): BackgroundWorkCounts | undefined {
  const agent = liveAgentRows(snapshot).filter((row) => !row.queued).length;
  const shell = Math.max(Number(snapshot.shellJobs?.count) || 0, snapshot.shellJobs?.jobs?.length || 0);
  return goalHasBackgroundWork(snapshot, agent > 0) ? { shell, agent } : undefined;
}

function backgroundWaitingLabel({ shell, agent }: BackgroundWorkCounts): string {
  if (shell > 0 && agent > 0) return t('Waiting on {{shell}} shell jobs · {{agent}} agents', { shell, agent });
  if (shell > 0) return t('Waiting on {{shell}} shell jobs', { shell });
  return t('Waiting on {{agent}} agents', { agent });
}

/** `animateComplete` is the caller's explicit decision (see hadLiveActivity);
 *  consume the turn on commit, not during a render React may discard.
 *  `backgroundWork` is passed only to the latest completion: while it holds
 *  work the line shows a waiting state in the same row, then settles in place. */
export function CompletionStatus({
  item,
  animateComplete: animate = false,
  completionActivityKey: activityKey = '',
  backgroundWork,
}: {
  item: TranscriptItem;
  animateComplete?: boolean;
  completionActivityKey?: string;
  backgroundWork?: BackgroundWorkCounts;
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
        <span>{t('Session forked')}</span>
        <small>{t('Continuing with the previous context.')}</small>
      </div>
    );
  }
  if (item.kind === 'statusdone' && item.status === 'model-switched') {
    return (
      <div className="compaction-divider" role="status">
        <ArrowLeftRight className="compaction-icon" size={16} aria-hidden="true" />
        <span>
          {t('Switched to {{model}}', {
            model: modelDisplayName(String(item.modelId || ''), String(item.provider || '')),
          })}
        </span>
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
  if (backgroundWork && backgroundWork.shell + backgroundWork.agent > 0) {
    return (
      <div className="turn-status complete waiting" role="status">
        <span className="turn-status-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>{backgroundWaitingLabel(backgroundWork)}</span>
      </div>
    );
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
