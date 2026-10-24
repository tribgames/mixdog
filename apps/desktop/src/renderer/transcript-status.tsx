import { ArrowLeftRight, FoldVertical, GitFork, ListTree, Network, Workflow, X } from 'lucide-react';
import { memo, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { resolveContextDisplayUsage } from './context-usage';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { useHoverPopover } from './hover-popover';
import { cachedAutoEffortCapable, useAutoEffortShown } from './auto-effort-store';
import { subscribeUiLanguage, t, uiFormatLocale } from './i18n';
import { modelDisplayName, modelRouteDisplayParts } from './provider-display';
import { uiCurrency } from './ui-format';
import { useClock } from './use-clock';
import { lockDecorativeLoops } from './decorative-motion-sync';
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
/** A newly published phase is painted once it has lasted this long... */
const PHASE_SWITCH_DELAY_MS = 150;
/** ...and the painted one has stood at least this long. */
const PHASE_MIN_DWELL_MS = 650;
// The delegation select's labels (model-controls OrchestrationModeSelect).
const ORCHESTRATION_MODE_LABELS: Record<string, string> = {
  none: 'Solo',
  focused: 'Assisted',
  balanced: 'Collaborative',
  swarm: 'Swarm',
};
// Three clockwise r=8.5 rings around (12,12) starting at -120deg, 0deg and
// 120deg; a [dash, offset] frame puts one arc on each, as the design's
// dashed rings did (pathLength 360, so both are in degrees).
const LIVE_ACTIVITY_ARC_STARTS = [-120, 0, 120];
// The arcs' 2000ms loop as [dash length, dash offset] on a 360-long ring, one
// keyframe per 1/48 of the loop and the closing one, precomputed from the
// design's buildFlow {dur 2000, headEnd .56, tailStart .26, pow 2.1, drift
// .26, pop .07}.
const LIVE_ACTIVITY_ARC_FLOW: ReadonlyArray<readonly [number, number]> = [
  [0, 0.64],
  [0.19, -0.01],
  [0.81, -0.66],
  [1.9, -1.31],
  [3.48, -1.96],
  [5.57, -2.61],
  [8.16, -3.26],
  [11.28, -3.91],
  [14.94, -4.56],
  [19.13, -5.21],
  [23.86, -5.86],
  [29.15, -6.51],
  [35, -7.16],
  [41.38, -7.83],
  [47.94, -8.71],
  [53.8, -9.84],
  [58.83, -11.24],
  [63.03, -12.91],
  [66.39, -14.87],
  [68.92, -17.12],
  [70.61, -19.66],
  [71.48, -22.5],
  [71.52, -25.64],
  [70.75, -29.09],
  [69.16, -32.85],
  [66.78, -36.91],
  [63.62, -41.29],
  [59.71, -45.99],
  [55.35, -51.01],
  [50.66, -56.34],
  [45.65, -62],
  [40.5, -67.8],
  [35.66, -73.29],
  [31.14, -78.46],
  [26.94, -83.31],
  [23.06, -87.85],
  [19.49, -92.06],
  [16.24, -95.97],
  [13.29, -99.56],
  [10.65, -102.85],
  [8.32, -105.84],
  [6.28, -108.52],
  [4.55, -110.91],
  [3.1, -113.01],
  [1.94, -114.82],
  [1.06, -116.34],
  [0.45, -117.6],
  [0.11, -118.6],
  [0, -119.36],
];
// Frame 0 is the static logo pose (reduced or paused motion); frames 1..96
// draw the loop at 48 fps: every keyframe and the midpoint to the next one.
// 14-live-activity.css steps through every second one at 24 fps (the odd
// frames, the keyframes themselves).
export const LIVE_ACTIVITY_ARC_FRAMES: ReadonlyArray<readonly [number, number]> = [
  [80, -20],
  ...LIVE_ACTIVITY_ARC_FLOW.slice(0, -1).flatMap(([dash, offset], index) => {
    const [nextDash, nextOffset] = LIVE_ACTIVITY_ARC_FLOW[index + 1];
    return [
      [dash, offset],
      [(dash + nextDash) / 2, (offset + nextOffset) / 2],
    ] as const;
  }),
];
/** One frame's arcs as explicit circular arcs: a dash of `dash` degrees
 *  starting `-offset` degrees past each ring's start (a zero-length dash is
 *  a round dot). Exact geometry, not a dash on a ring path: Chromium places
 *  dashes through the ring's measured length, which is uneven along the path
 *  (up to ~1.4deg) and doubles the cap of a dash at the path's start/end
 *  point. The loop's last pose (offset -119.36, past the middle of one arc)
 *  and its first (offset 0.64, by the ring's start point) are the same
 *  arrangement turned by the 120deg between rings, but drew 2.6deg apart
 *  with 38% more ink: the mark jumped back and swelled at every loop seam. */
export function liveActivityArcPath(dash: number, offset: number): string {
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${+(12 + 8.5 * Math.cos(radians)).toFixed(3)} ${+(12 + 8.5 * Math.sin(radians)).toFixed(3)}`;
  };
  return LIVE_ACTIVITY_ARC_STARTS.map((ring) => {
    const from = point(ring - offset);
    return dash > 0 ? `M${from}A8.5 8.5 0 0 1 ${point(ring - offset + dash)}` : `M${from}L${from}`;
  }).join('');
}
/** Every arc frame side by side, 24 viewBox units apart, as one mask image.
 *  Stroke dashes cannot animate on the compositor: animated in place they
 *  repainted the mark on the main thread at the display's refresh rate for
 *  as long as a turn ran. The strip is rasterized once and a stepped
 *  transform slides it behind the mark's 14px window instead. */
const LIVE_ACTIVITY_ARC_STRIP = (() => {
  const frames = LIVE_ACTIVITY_ARC_FRAMES.map(
    ([dash, offset], index) => `<path transform="translate(${index * 24} 0)" d="${liveActivityArcPath(dash, offset)}"/>`
  ).join('');
  const width = LIVE_ACTIVITY_ARC_FRAMES.length * 24;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 24" width="${width}" height="24" ` +
    `fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round">${frames}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();
const LIVE_ACTIVITY_ARC_STRIP_STYLE = { maskImage: LIVE_ACTIVITY_ARC_STRIP, WebkitMaskImage: LIVE_ACTIVITY_ARC_STRIP };
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

/** The running mark. Both loops are compositor animations on HTML boxes: the
 *  arcs' frame strip steps behind a 14px window that spins. The star at the
 *  centre holds its static logo pose.
 *  Memoized: the band re-renders on every lane frame and clock tick. */
const LiveActivityIcon = memo(function LiveActivityIcon({ gradientId }: { gradientId: string }) {
  return (
    <span className="live-activity-icon" aria-hidden="true" ref={lockDecorativeLoops}>
      <span className="live-activity-logo live-activity-arcs">
        <span className="live-activity-arc-strip" style={LIVE_ACTIVITY_ARC_STRIP_STYLE} />
      </span>
      <svg className="live-activity-logo" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" />
            <stop offset="1" />
          </linearGradient>
        </defs>
        <path
          className="star"
          fill={`url(#${gradientId})`}
          d="M12 8.4Q12.6 11.4 15.6 12 12.6 12.6 12 15.6 11.4 12.6 8.4 12 11.4 11.4 12 8.4Z"
        />
      </svg>
    </span>
  );
});

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
  const mountedAt = useRef(Date.now());
  const liveSessionId = String(snapshot.sessionId || '').trim();
  const liveKey = liveSessionId && turnKey ? liveTurnKey(liveSessionId, turnKey) : '';
  useLayoutEffect(() => {
    if (liveKey) liveActivityTurns.add(liveKey);
  }, [liveKey]);
  // The entrance belongs to work that starts on screen, once per turn: a
  // remount of the band (a recycled virtual row, a re-keyed working row)
  // finds its turn already entered. Once decided, it holds for the mount, so
  // a later frame never cuts a running entrance.
  const enterRef = useRef(false);
  if (
    !enterRef.current &&
    startedAt > 0 &&
    startedAt >= mountedAt.current &&
    !(liveKey && enteredActivityTurns.has(liveKey))
  ) {
    enterRef.current = true;
  }
  const animateEnter = enterRef.current;
  // Every commit of an entered band renews its turn, so a working turn stays
  // among the most recent ones the bounded record keeps.
  useLayoutEffect(() => {
    if (liveKey && (animateEnter || enteredActivityTurns.has(liveKey))) markActivityTurnEntered(liveKey);
  });
  // The phase the activity names; '' when it publishes none (between two
  // phases, before the runtime's first one).
  let phase = '';
  if (activity) phase = String(activity.mode || (snapshot.thinking ? 'thinking' : 'responding'));
  else if (snapshot.thinking) phase = 'thinking';
  // The painted phase is paced: a newly published phase is painted once it
  // has lasted PHASE_SWITCH_DELAY_MS and the painted one has stood
  // PHASE_MIN_DWELL_MS, so a phase one publication long never flashes. While
  // none is published (between phases, a resume mid-turn) the last painted
  // phase stays.
  const phaseRef = useRef({ target: '', targetSince: 0, shown: '', shownAt: 0 });
  const nowMs = Date.now();
  const known = phaseRef.current;
  if (phase && phase !== 'resuming' && phase !== known.target) {
    known.target = phase;
    known.targetSince = nowMs;
  } else if (!phase || phase === 'resuming') {
    // A withdrawn phase never paints: drop a pending switch, keep the painted one.
    known.target = known.shown;
  }
  let switchIn = 0;
  if (known.target !== known.shown) {
    const wait = known.shown
      ? Math.max(PHASE_SWITCH_DELAY_MS - (nowMs - known.targetSince), PHASE_MIN_DWELL_MS - (nowMs - known.shownAt))
      : 0;
    if (wait > 0) switchIn = wait;
    else {
      known.shown = known.target;
      known.shownAt = nowMs;
    }
  }
  const [, wake] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (switchIn <= 0) return;
    const timer = setTimeout(wake, switchIn);
    return () => clearTimeout(timer);
  });
  // Keep the first timestamp for a turn so thinking/tool/response transitions
  // do not restart the phrase rotation.
  const anchorRef = useRef(0);
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
  // The readout below reads Date.now() itself; the shared clock only
  // re-renders the band once a second while the turn's clock runs.
  useClock(Boolean(startedAt) && !clockPaused);
  const quiet = useLaneSpinnerQuiet(liveSessionId, asRecord(activity)?.quiet);
  if (!known.shown && !activity && !optimisticActivity && !snapshot.thinking && !startedAt) {
    anchorRef.current = 0;
    return null;
  }
  let fallbackMode = 'responding';
  if (snapshot.thinking) fallbackMode = 'thinking';
  else if (optimisticActivity || !activity) fallbackMode = 'requesting';
  const mode = known.shown || String(activity?.mode || fallbackMode);
  if (mode === 'resuming') {
    anchorRef.current = 0;
    return null;
  }
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
  // The token readout is its own span: where the pinned bot overlay stands
  // over the transcript's column (a narrow window) it hides, so the row ends
  // before the bot (html[data-pet-over-transcript], 14-live-activity.css).
  const beforeTokens = elapsed;
  const afterTokens = thinkingLabel;
  const activityMeta =
    beforeTokens || tokensLabel || afterTokens ? (
      <span>
        {beforeTokens}
        {tokensLabel ? (
          <span className="live-activity-tokens">
            {beforeTokens ? ' · ' : ''}
            {tokensLabel}
          </span>
        ) : null}
        {afterTokens ? `${beforeTokens || tokensLabel ? ' · ' : ''}${afterTokens}` : ''}
      </span>
    ) : null;
  const reasoning = publicThinkingSummary(snapshot.thinking);
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
/** Turns whose live band already played its entrance in this view, oldest
 *  first; the ENTERED_ACTIVITY_TURN_LIMIT most recently rendered are kept. */
const enteredActivityTurns = new Set<string>();
export const ENTERED_ACTIVITY_TURN_LIMIT = 128;

function markActivityTurnEntered(key: string): void {
  enteredActivityTurns.delete(key);
  enteredActivityTurns.add(key);
  for (const oldest of enteredActivityTurns) {
    if (enteredActivityTurns.size <= ENTERED_ACTIVITY_TURN_LIMIT) break;
    enteredActivityTurns.delete(oldest);
  }
}
const liveTurnKey = (sessionId: string, turnKey: string) => `${sessionId}\0${turnKey}`;

// A deleted session's turns never render again: drop its entries.
onSessionPreviewsDeleted((sessionId) => {
  const prefix = `${sessionId}\0`;
  for (const turns of [liveActivityTurns, completedActivityTurns, enteredActivityTurns]) {
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
  if (item.kind === 'statusdone' && item.status === 'workflow-switched') {
    return (
      <div className="compaction-divider" role="status">
        <Workflow className="compaction-icon" size={16} aria-hidden="true" />
        <span>
          {item.unavailable === true
            ? t('Workflow {{to}} is no longer available; this conversation keeps {{from}}', {
                from: String(item.from || ''),
                to: String(item.to || ''),
              })
            : t('Switched the workflow {{from}} → {{to}}', {
                from: String(item.from || ''),
                to: String(item.to || ''),
              })}
        </span>
      </div>
    );
  }
  if (item.kind === 'statusdone' && item.status === 'orchestration-mode-switched') {
    const modeLabel = (mode: unknown) => t(ORCHESTRATION_MODE_LABELS[String(mode)] || String(mode || ''));
    return (
      <div className="compaction-divider" role="status">
        <Network className="compaction-icon" size={16} aria-hidden="true" />
        <span>
          {t('Switched the delegation mode {{from}} → {{to}}', { from: modeLabel(item.from), to: modeLabel(item.to) })}
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
