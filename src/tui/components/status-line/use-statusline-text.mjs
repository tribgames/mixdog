/*
 * components/status-line/use-statusline-text.mjs — the statusline text state:
 * instant-local snap on identity/theme/route changes plus the debounced async
 * full render (with boot delay/backoff) and its refresh cadence.
 */
import { useEffect, useRef, useState } from 'react';
import { statuslineFooterIdentityChanged } from '../../statusline-ansi-bridge.mjs';
import { useSharedTick } from '../../hooks/useSharedTick.mjs';
import { num, timeMs } from '../../../runtime/shared/statusline/statusline-format.mjs';
import {
  STATUSLINE_ACTIVE_REFRESH_MS,
  STATUSLINE_BOOT_FULL_RETRY_MS,
  STATUSLINE_REFRESH_MS,
  STATUSLINE_RENDER_DEBOUNCE_MS,
  bootFullRenderDelayRemainingMs,
  canAttemptBootFullRender,
  hasActiveStatuslineWork,
  loadStatuslineModule,
  resetStatuslineModuleLoad,
  scheduleBootFullRetry,
  scheduleStatuslineModulePrewarm,
} from './boot-schedule.mjs';
import { buildLocalSnapLine, localBootStatusLine, normalizeStatusLine } from './local-line.mjs';

export function useStatusLineText({
  sessionId,
  clientHostPid,
  provider,
  model,
  effort,
  fast,
  ultra,
  cwd,
  stats,
  contextWindow,
  displayContextWindow,
  compactBoundaryTokens,
  autoCompactTokenLimit,
  rawContextWindow,
  resizeEpoch,
  agentRevision,
  agentWorkers,
  agentJobs,
  activeTools,
  initialLine,
  themeEpoch,
}) {
  const [line, setLine] = useState(() =>
    normalizeStatusLine(
      initialLine ||
        localBootStatusLine({
          provider,
          model,
          effort,
          fast,
          ultra,
          stats,
          contextWindow,
          displayContextWindow,
          rawContextWindow,
          compactBoundaryTokens,
          autoCompactTokenLimit,
          agentWorkers,
          agentJobs,
          activeTools,
        })
    )
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const statuslineArgsRef = useRef(null);
  const bootFullDoneRef = useRef(false);
  const mountAtRef = useRef(Date.now());
  const lineRef = useRef('');
  const bootFullNextAttemptAtRef = useRef(0);
  const bootFullRetryBackoffMsRef = useRef(STATUSLINE_BOOT_FULL_RETRY_MS);
  const renderEffectIdRef = useRef(0);
  const lastImmediateArgsRef = useRef(null);
  const themeEpochRef = useRef(themeEpoch);
  const lastRawFullLineRef = useRef('');

  const statuslineArgs = {
    sessionId,
    clientHostPid,
    provider,
    model,
    effort,
    fast,
    ultra,
    cwd,
    stats,
    contextWindow,
    displayContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    rawContextWindow,
    agentWorkers,
    agentJobs,
    activeTools,
  };
  statuslineArgsRef.current = statuslineArgs;
  lineRef.current = line;
  // Stable primitive signature for the activeTools object so the render effect
  // re-runs when the web-search count or start time changes (object identity
  // would otherwise be a new ref every render and over-fire the effect).
  const activeToolsSignature = activeTools
    ? [Number(activeTools.web_search?.count) || 0, Number(activeTools.web_search?.startedAt) || 0].join('|')
    : '';
  // Stable primitive signatures so the render effect's dep array doesn't
  // churn on new array/object identities carrying unchanged content — a new
  // `agentWorkers`/`agentJobs` array (or `stats` object) reference on every
  // render was clearing the pending 150ms debounce timer before it could
  // fire, starving the boot full-render. Only tag|stage per worker/job and
  // the numeric stats fields actually consumed here are covered.
  const agentWorkersSignature = Array.isArray(agentWorkers)
    ? agentWorkers
        .map(
          (w) =>
            `${w?.tag || w?.agent || w?.name || ''}|${w?.stage || w?.status || ''}|${timeMs(w?.startedAt || w?.startTime || w?.createdAt)}`
        )
        .join(',')
    : '';
  const agentJobsSignature = Array.isArray(agentJobs)
    ? agentJobs
        .map(
          (j) =>
            `${j?.tag || j?.agent || j?.name || ''}|${j?.status || j?.stage || ''}|${timeMs(j?.startedAt || j?.startTime || j?.createdAt)}`
        )
        .join(',')
    : '';
  const statsForSignature = stats && typeof stats === 'object' ? stats : {};
  const statsSignature = [
    num(statsForSignature.currentContextTokens),
    num(statsForSignature.currentEstimatedContextTokens),
    num(statsForSignature.inputTokens),
    num(statsForSignature.latestInputTokens),
    num(statsForSignature.promptTokens),
    num(statsForSignature.turns),
    num(statsForSignature.contextTokens),
    String(statsForSignature.currentContextSource || ''),
  ].join('|');
  const refreshMs = hasActiveStatuslineWork(line, agentWorkers, agentJobs, activeTools)
    ? STATUSLINE_ACTIVE_REFRESH_MS
    : STATUSLINE_REFRESH_MS;

  useEffect(() => {
    scheduleStatuslineModulePrewarm();
  }, []);

  // Refresh cadence rides the shared animation tick (no dedicated interval).
  // The callback bumps refreshTick so the async full-render effect below still
  // re-fires on schedule; the tick timer stops when nothing is subscribed.
  useSharedTick(refreshMs, true, () => {
    setRefreshTick((tick) => (tick + 1) % 1_000_000);
  });

  useEffect(() => {
    let alive = true;
    let bootRetryTimer = null;
    const effectId = renderEffectIdRef.current + 1;
    renderEffectIdRef.current = effectId;
    const isCurrentEffect = () => alive && renderEffectIdRef.current === effectId;
    const args = statuslineArgsRef.current;
    const identityChanged = statuslineFooterIdentityChanged({ ...args, agentRevision }, lastImmediateArgsRef.current);
    // ROUTE identity = the subset that actually changes the async full line's L1
    // usage/quota segment (provider/model/session/effort/fast). agentRevision,
    // compactBoundaryTokens, autoCompactTokenLimit, stats-reset AND the context
    // window fields (contextWindow/displayContextWindow/rawContextWindow) are
    // NON-ROUTE: the first prompt's API response publishes displayContextWindow
    // 0→N (engine syncContextDisplayFields), which only moves the ctx% bar —
    // never the `5H …/7D …` usage windows. Treating it as route wiped the cached
    // full line and snapped to the usage-less local line for one frame (the
    // "usage blinks once on first prompt" bug). A real route switch that changes
    // usage windows always changes provider/model/session anyway. Only a true
    // route/session switch may wipe the cached full line; non-route churn keeps
    // the last good full line (identityChanged still snaps, but via the cached
    // graft path below, so usage survives and the async render refreshes ctx%
    // within ~150ms). (lastImmediateArgsRef holds these fields, captured at the
    // end of the previous effect run.)
    const prevImmediate = lastImmediateArgsRef.current;
    const routeChanged =
      !prevImmediate ||
      prevImmediate.sessionId !== args.sessionId ||
      prevImmediate.provider !== args.provider ||
      prevImmediate.model !== args.model ||
      prevImmediate.effort !== args.effort ||
      prevImmediate.fast !== args.fast ||
      prevImmediate.ultra !== args.ultra;
    // A theme switch must re-tone the footer immediately: the stored `line`
    // holds already-normalized ANSI with the OLD palette, so re-running
    // normalizeStatusLine on it is a no-op. Force a fresh local rebuild (new
    // palette) and reset bootFullDone so the next full render re-normalizes.
    const themeChanged = themeEpochRef.current !== themeEpoch;
    if (themeChanged) {
      themeEpochRef.current = themeEpoch;
    }
    // Only a real route/session switch invalidates the cached full line (and its
    // L1 usage segment). On non-route identity churn (agent stage/status, compact
    // boundary, auto-compact limit, stats reset) KEEP the cache so the usage
    // segment survives; the async full render scheduled below refreshes any stale
    // L2 within ~150ms (and every ~250ms while active).
    if (routeChanged) {
      lastRawFullLineRef.current = '';
      bootFullDoneRef.current = false;
    }
    const snapLocalNow = themeChanged || bootFullDoneRef.current !== true || identityChanged;
    if (snapLocalNow) {
      // Reuse the last good FULL line (with its L1 usage segment) whenever this is
      // NOT a route switch and a cached full line exists — covers theme re-tone,
      // agent churn, compact/auto-compact changes and stats reset. We intentionally
      // do NOT require a matching footer cache key here: it embeds agentRevision
      // + compact fields, so it differs on exactly the non-route churn we want to
      // ride through, and requiring equality would fall back to the usage-less
      // localBootStatusLine and reintroduce the blink. Route switches (routeChanged)
      // have already wiped the cache above, so they snap local.
      const localNext = buildLocalSnapLine(args, routeChanged ? '' : lastRawFullLineRef.current);
      if (localNext) setLine((prev) => (prev === localNext ? prev : localNext));
    }
    lastImmediateArgsRef.current = {
      agentRevision,
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      effort: args.effort,
      fast: args.fast,
      ultra: args.ultra,
      contextWindow: args.contextWindow,
      displayContextWindow: args.displayContextWindow,
      rawContextWindow: args.rawContextWindow,
      compactBoundaryTokens: args.compactBoundaryTokens,
      autoCompactTokenLimit: args.autoCompactTokenLimit,
      stats: args.stats,
    };
    // Re-fire this effect after `waitMs` (at least 150ms) via refreshTick.
    const armBootRetry = (waitMs) => {
      bootRetryTimer = setTimeout(
        () => {
          if (!isCurrentEffect()) return;
          setRefreshTick((tick) => (tick + 1) % 1_000_000);
        },
        Math.max(150, waitMs)
      );
      bootRetryTimer.unref?.();
    };
    const timer = setTimeout(() => {
      if (bootFullDoneRef.current !== true) {
        const bootDelayRemainingMs = bootFullRenderDelayRemainingMs(
          mountAtRef.current,
          lineRef.current,
          args.agentWorkers,
          args.agentJobs,
          args.activeTools
        );
        if (bootDelayRemainingMs > 0) {
          // Not eligible yet (boot delay not elapsed). Don't just bail and wait
          // for the next refreshTick interval (250ms/2000ms) — arm a follow-up
          // timeout for the REMAINING boot delay so the first full render still
          // fires on schedule instead of stalling/flickering until the next tick.
          armBootRetry(bootDelayRemainingMs);
          return;
        }
        if (!canAttemptBootFullRender(bootFullNextAttemptAtRef.current)) {
          // Backoff window not elapsed yet — arm a follow-up timeout for exactly
          // the remaining backoff so the retry fires on time instead of waiting
          // for the next refreshTick interval.
          armBootRetry(bootFullNextAttemptAtRef.current - Date.now());
          return;
        }
      }
      loadStatuslineModule()
        .then((m) => {
          if (!isCurrentEffect()) return null;
          return m.renderStatusline(args);
        })
        .then((s) => {
          if (!isCurrentEffect() || s == null) return;
          lastRawFullLineRef.current = String(s);
          bootFullDoneRef.current = true;
          bootFullRetryBackoffMsRef.current = STATUSLINE_BOOT_FULL_RETRY_MS;
          bootFullNextAttemptAtRef.current = 0;
          const next = normalizeStatusLine(s);
          if (next) setLine((prev) => (prev === next ? prev : next));
        })
        .catch(() => {
          if (!isCurrentEffect()) return;
          if (bootFullDoneRef.current !== true) {
            scheduleBootFullRetry(bootFullRetryBackoffMsRef, bootFullNextAttemptAtRef);
            return;
          }
          resetStatuslineModuleLoad();
          // Keep the previous/minimal line. Boot-time gateway/cache races should
          // never blank the reserved footer and make the statusline flicker.
        });
    }, STATUSLINE_RENDER_DEBOUNCE_MS);
    timer.unref?.();
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(bootRetryTimer);
    };
  }, [
    sessionId,
    clientHostPid,
    provider,
    model,
    effort,
    fast,
    ultra,
    cwd,
    statsSignature,
    contextWindow,
    displayContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    rawContextWindow,
    resizeEpoch,
    agentRevision,
    agentWorkersSignature,
    agentJobsSignature,
    activeToolsSignature,
    refreshTick,
    themeEpoch,
  ]);

  return line;
}
