/**
 * components/StatusLine.jsx — the vendored mixdog L1/L2 statusline footer.
 *
 * renderStatusline() (src/ui/statusline.mjs) is async (it awaits the vendored
 * statusline-lib that may query the gateway). We recompute it whenever the
 * stats/model change and tone-map the vendored ANSI string into the React TUI
 * palette before printing it through ink's <Text>.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { canonicalModelDisplay, shortenModelName } from '../../ui/model-display.mjs';
import { theme } from '../theme.mjs';
import {
  normalizeStatuslineAnsi,
  statuslineFooterCacheKey,
  statuslineFooterIdentityChanged,
} from '../statusline-ansi-bridge.mjs';

// Loaded at RUNTIME (not bundled) so its vendored statusline-lib relative
// imports resolve from the real src/ui location, not the dist/ bundle dir.
// esbuild leaves dynamic-import string specifiers alone.
const STATUSLINE_MODULE = '../../ui/statusline.mjs';
let statuslineModulePromise = null;

function loadStatuslineModule() {
  if (!statuslineModulePromise) statuslineModulePromise = import(STATUSLINE_MODULE);
  return statuslineModulePromise;
}

function resetStatuslineModuleLoad() {
  statuslineModulePromise = null;
}

const RESET = '\x1b[0m';
const STATUSLINE_RENDER_DEBOUNCE_MS = 150;
const STATUSLINE_BOOT_FULL_DELAY_MS = 1000;
const STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS = 2200;
const STATUSLINE_BOOT_FULL_RETRY_MS = 2000;
const STATUSLINE_BOOT_FULL_RETRY_MAX_MS = 30000;
const STATUSLINE_REFRESH_MS = 2000;
const STATUSLINE_ACTIVE_REFRESH_MS = 250;

function isTerminalStatus(statusText) {
  return /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/.test(String(statusText || '').toLowerCase());
}

function hasRunningStatuslineWorkers(agentWorkers = [], agentJobs = []) {
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.role || worker?.name || '').trim();
    if (tag && !isTerminalStatus(worker?.stage || worker?.status)) return true;
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (/running/i.test(String(job?.status || job?.stage || ''))) return true;
  }
  return false;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function hasActiveStatuslineTools(activeTools = null) {
  if (!activeTools || typeof activeTools !== 'object') return false;
  const e = Number(activeTools.explore?.count) > 0;
  const s = Number(activeTools.search?.count) > 0;
  return e || s;
}

function hasActiveStatuslineWork(line, agentWorkers = [], agentJobs = [], activeTools = null) {
  return hasRunningStatuslineWorkers(agentWorkers, agentJobs)
    || hasActiveStatuslineTools(activeTools)
    || /\bRunning \d+ (?:Agents?|Shells?)\b/.test(stripAnsi(line))
    || /\b(?:Exploring|Searching)\b/.test(stripAnsi(line));
}

function bootFullRenderEligible(mountAtMs, line, agentWorkers = [], agentJobs = [], activeTools = null) {
  const elapsed = Date.now() - mountAtMs;
  const active = hasActiveStatuslineWork(line, agentWorkers, agentJobs, activeTools);
  const delay = active ? STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS : STATUSLINE_BOOT_FULL_DELAY_MS;
  return elapsed >= delay;
}

function canAttemptBootFullRender(nextAttemptAtMs = 0) {
  return Date.now() >= nextAttemptAtMs;
}

function shouldSnapLocalStatusline(args, lastArgs) {
  return statuslineFooterIdentityChanged(args, lastArgs);
}

function scheduleBootFullRetry(backoffMsRef, nextAttemptAtRef) {
  resetStatuslineModuleLoad();
  const nextBackoff = Math.min(
    STATUSLINE_BOOT_FULL_RETRY_MAX_MS,
    Math.max(STATUSLINE_BOOT_FULL_RETRY_MS, backoffMsRef.current * 2),
  );
  backoffMsRef.current = nextBackoff;
  nextAttemptAtRef.current = Date.now() + nextBackoff;
}

function ansiRgb(value, fallback) {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(value || '').replace(/\s+/g, ''));
  if (!match) return fallback;
  return `\x1b[38;2;${match[1]};${match[2]};${match[3]}m`;
}

// SGR escapes derived from the active theme. Resolved per call (not captured at
// module load) so a live `/theme` switch re-tones the statusline on the next
// render. `theme` is mutated in-place on switch.
function statusColors() {
  return {
    STATUS: ansiRgb(theme.statusText, '\x1b[38;2;198;198;198m'),
    SUBTLE: ansiRgb(theme.statusSubtle, '\x1b[38;2;136;136;136m'),
    SUCCESS: ansiRgb(theme.success, '\x1b[38;2;0;170;75m'),
    WARNING: ansiRgb(theme.warning, '\x1b[38;2;255;193;7m'),
    ERROR: ansiRgb(theme.error, '\x1b[38;2;220;70;88m'),
  };
}

function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

function localNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function localContextPct({
  provider = '',
  stats = null,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
} = {}) {
  const baseWindow = localNum(compactBoundaryTokens) > 0
    ? localNum(compactBoundaryTokens)
    : (localNum(displayContextWindow) > 0
      ? localNum(displayContextWindow)
      : (localNum(contextWindow) > 0
        ? localNum(contextWindow)
        : (localNum(rawContextWindow) > 0 ? localNum(rawContextWindow) : 200_000)));
  const compactTrigger = localNum(autoCompactTokenLimit);
  const window = compactTrigger > 0 && compactTrigger < baseWindow ? compactTrigger : baseWindow;
  const s = stats && typeof stats === 'object' ? stats : {};
  const source = String(s.currentContextSource || '').toLowerCase();
  const estimated = localNum(s.currentEstimatedContextTokens);
  if (estimated > 0) {
    return Math.max(0, (estimated / window) * 100);
  }
  if (source === 'estimated') return 0;
  let tokens = localNum(s.currentContextTokens ?? s.contextTokens);
  if (!tokens) return 0;
  return Math.max(0, (tokens / window) * 100);
}

function localContextPctDisplayLabel(ctxPct) {
  const pct = Number(ctxPct);
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  if (pct > 0 && pct < 1) return String(Math.round(pct * 10) / 10);
  return String(Math.floor(Math.min(100, pct)));
}

function localContextSegmentFromPct(ctxPct = 0) {
  const { SUBTLE, SUCCESS, WARNING, ERROR } = statusColors();
  const cols = terminalColumns();
  const cells = cols >= 80 ? 14 : 0;
  const raw = Number(ctxPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const barPct = Math.max(0, Math.min(100, pct));
  const fill = pct >= 90 ? ERROR : pct >= 70 ? WARNING : SUCCESS;
  const label = localContextPctDisplayLabel(pct);
  if (!cells) return `${fill}${label}%${RESET}`;
  let filled = Math.floor(barPct * cells / 100);
  if (barPct >= 1 && filled === 0) filled = 1;
  filled = Math.max(0, Math.min(cells, filled));
  const bar = '▓'.repeat(filled) + '░'.repeat(cells - filled);
  const filledBar = bar.replace(/░/g, '');
  const emptyBar = bar.replace(/▓/g, '');
  return `${fill}${filledBar}${RESET}${SUBTLE}${emptyBar}${RESET} ${label}%`;
}

const LOCAL_WORKER_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// L2 segment spinner reuses the original worker dot glyphs (no separate glyph
// list) but spins them at 120ms instead of the worker spinner's 160ms. Mirrors
// statusline.mjs l2SpinnerFrame()/L2_SPINNER_FRAME_MS so instant-local and full
// render stay in sync (no flicker).
const LOCAL_L2_SPINNER_FRAME_MS = 120;

function localWorkerSpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / 160) % LOCAL_WORKER_SPINNER_FRAMES.length;
  return LOCAL_WORKER_SPINNER_FRAMES[index] || LOCAL_WORKER_SPINNER_FRAMES[0];
}

function localL2SpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / LOCAL_L2_SPINNER_FRAME_MS) % LOCAL_WORKER_SPINNER_FRAMES.length;
  return LOCAL_WORKER_SPINNER_FRAMES[index] || LOCAL_WORKER_SPINNER_FRAMES[0];
}

// Byte-identical replica of src/tui/time-format.mjs formatDuration() with
// DEFAULT options (no mostSignificantOnly / hideTrailingZeros), wrapped to drop
// sub-1s. Output shape: '' (<1s), `Xs`, `Xm Ys`, `Xh Ym Zs`, `Xd Yh Zm`. Mirrors
// statusline.mjs formatElapsed so instant-local L2 elapsed matches full render.
function localFormatElapsed(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) {
    if (value < 1_000) return '';
    return `${Math.floor(value / 1000)}s`;
  }
  const days = Math.floor(value / 86_400_000);
  const hours = Math.floor((value % 86_400_000) / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function localRunningWorkerCount(agentWorkers = [], agentJobs = []) {
  const seen = new Set();
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.role || worker?.name || '').trim();
    if (!tag || isTerminalStatus(worker?.stage || worker?.status)) continue;
    seen.add(tag);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (!/running/i.test(String(job?.status || job?.stage || ''))) continue;
    const tag = String(job?.tag || job?.role || job?.type || job?.task_id || job?.taskId || '').trim();
    if (!tag) continue;
    seen.add(tag);
  }
  return seen.size;
}

function localRunningWorkerTags(agentWorkers = [], agentJobs = [], limit = 3) {
  const tags = [];
  const seen = new Set();
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.role || worker?.name || '').trim();
    if (!tag || isTerminalStatus(worker?.stage || worker?.status) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (!/running/i.test(String(job?.status || job?.stage || ''))) continue;
    const tag = String(job?.tag || job?.role || job?.type || job?.task_id || job?.taskId || '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  if (tags.length <= limit) return tags.join(', ');
  return `${tags.slice(0, limit).join(', ')}, +${tags.length - limit}`;
}

function localTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

// Oldest running worker/job start time, for the Agents segment elapsed. Mirrors
// the async path which derives elapsed from the oldest running worker.
function localOldestWorkerStartMs(agentWorkers = [], agentJobs = []) {
  let oldest = Infinity;
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    if (isTerminalStatus(worker?.stage || worker?.status)) continue;
    const t = localTimeMs(worker?.startedAt || worker?.startTime || worker?.createdAt);
    if (t > 0 && t < oldest) oldest = t;
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (!/running/i.test(String(job?.status || job?.stage || ''))) continue;
    const t = localTimeMs(job?.startedAt);
    if (t > 0 && t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

function localBootStatusLine({
  provider = '',
  model = '',
  effort = '',
  fast = false,
  stats = null,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
  agentWorkers = [],
  agentJobs = [],
  activeTools = null,
} = {}) {
  const raw = String(model || '').trim();
  const { STATUS, SUBTLE, SUCCESS } = statusColors();
  const display = shortenModelName(
    canonicalModelDisplay(raw, provider) || raw || 'model',
    terminalColumns(),
  );
  const flags = [effort ? String(effort).toUpperCase() : '', fast === true ? 'FAST' : ''].filter(Boolean);
  const modelBits = [display, ...flags].join(` ${SUBTLE}·${RESET} `);
  const ctxPct = localContextPct({
    provider,
    stats,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
  });
  const l1 = `${STATUS}${modelBits}${RESET} ${SUBTLE}│${RESET} ${localContextSegmentFromPct(ctxPct)}`;
  // L2: per-segment circular-braille spinner, ` │ ` between segments, ` · Ns`
  // elapsed within a segment. Order: Agents → Exploring → Searching → Shells.
  const now = Date.now();
  const spin = `${SUCCESS}${localL2SpinnerFrame(now)}${RESET}`;
  const segSep = ` ${SUBTLE}│${RESET} `;
  const elapsedSuffix = (label) => (label ? ` ${SUBTLE}·${RESET} ${label}` : '');
  const l2Parts = [];
  const runningCount = localRunningWorkerCount(agentWorkers, agentJobs);
  if (runningCount > 0) {
    const label = `Running ${runningCount} Agent${runningCount === 1 ? '' : 's'}`;
    const tagSummary = localRunningWorkerTags(agentWorkers, agentJobs);
    const tags = tagSummary ? ` ${SUBTLE}(${RESET}${STATUS}${tagSummary}${RESET}${SUBTLE})${RESET}` : '';
    const oldestStart = localOldestWorkerStartMs(agentWorkers, agentJobs);
    const elapsed = oldestStart > 0 ? localFormatElapsed(now - oldestStart) : '';
    l2Parts.push(`${spin} ${STATUS}${label}${RESET}${tags}${elapsedSuffix(elapsed)}`);
  }
  const tools = activeTools && typeof activeTools === 'object' ? activeTools : {};
  const exploreInfo = tools.explore || null;
  const searchInfo = tools.search || null;
  if (exploreInfo && localNum(exploreInfo.count) > 0) {
    const elapsed = localNum(exploreInfo.startedAt) > 0 ? localFormatElapsed(now - localNum(exploreInfo.startedAt)) : '';
    l2Parts.push(`${spin} ${STATUS}Exploring${RESET}${elapsedSuffix(elapsed)}`);
  }
  if (searchInfo && localNum(searchInfo.count) > 0) {
    const elapsed = localNum(searchInfo.startedAt) > 0 ? localFormatElapsed(now - localNum(searchInfo.startedAt)) : '';
    l2Parts.push(`${spin} ${STATUS}Searching${RESET}${elapsedSuffix(elapsed)}`);
  }
  if (!l2Parts.length) return l1;
  return `${l1}\n${l2Parts.join(segSep)}`;
}

export function normalizeStatusLine(text) {
  return normalizeStatuslineAnsi(text, statusColors(), { reset: RESET });
}

function workflowModeLabel(workflow = {}) {
  const name = String(workflow?.name || workflow?.id || 'Default').trim() || 'Default';
  return `${name} Mode`;
}

function StatusLineView({ sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, displayContextWindow = 0, compactBoundaryTokens = 0, autoCompactTokenLimit = 0, rawContextWindow, resizeEpoch, agentRevision = '', agentWorkers = [], agentJobs = [], activeTools = null, initialLine = '', workflow = null, themeEpoch = 0 }) {
  const [line, setLine] = useState(() => normalizeStatusLine(initialLine || localBootStatusLine({
    provider,
    model,
    effort,
    fast,
    stats,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
    compactBoundaryTokens,
    autoCompactTokenLimit,
    agentWorkers,
    agentJobs,
    activeTools,
  })));
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
  const lastRawFullLineCacheKeyRef = useRef('');

  const statuslineArgs = {
    sessionId, clientHostPid, provider, model, effort, fast, cwd, stats,
    contextWindow, displayContextWindow, compactBoundaryTokens, autoCompactTokenLimit, rawContextWindow,
    agentWorkers, agentJobs, activeTools,
  };
  statuslineArgsRef.current = statuslineArgs;
  lineRef.current = line;
  // Stable primitive signature for the activeTools object so the render effect
  // re-runs when explore/search counts or start times change (object identity
  // would otherwise be a new ref every render and over-fire the effect).
  const activeToolsSignature = activeTools
    ? [
        Number(activeTools.explore?.count) || 0,
        Number(activeTools.explore?.startedAt) || 0,
        Number(activeTools.search?.count) || 0,
        Number(activeTools.search?.startedAt) || 0,
      ].join('|')
    : '';
  const refreshMs = hasActiveStatuslineWork(line, agentWorkers, agentJobs, activeTools) ? STATUSLINE_ACTIVE_REFRESH_MS : STATUSLINE_REFRESH_MS;

  useEffect(() => {
    const timer = setInterval(() => {
      setRefreshTick((tick) => (tick + 1) % 1_000_000);
    }, refreshMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    let alive = true;
    const effectId = renderEffectIdRef.current + 1;
    renderEffectIdRef.current = effectId;
    const isCurrentEffect = () => alive && renderEffectIdRef.current === effectId;
    const args = statuslineArgsRef.current || statuslineArgs;
    const footerCacheKey = statuslineFooterCacheKey({ ...args, agentRevision });
    const identityChanged = shouldSnapLocalStatusline(
      { ...args, agentRevision },
      lastImmediateArgsRef.current,
    );
    // ROUTE identity = the subset that actually changes the async full line's L1
    // usage/quota segment (provider/model/session/effort/fast + context windows).
    // agentRevision, compactBoundaryTokens, autoCompactTokenLimit and stats-reset
    // are NON-ROUTE: they churn while several agents run but DON'T invalidate the
    // L1 usage windows. Only a true route/session switch may wipe the cached full
    // line and snap to the usage-less local line; non-route churn must keep the
    // last good full line so `5H …/7D …` never blinks. (lastImmediateArgsRef holds
    // exactly these route fields, captured at the end of the previous effect run.)
    const prevImmediate = lastImmediateArgsRef.current;
    const routeChanged = !prevImmediate
      || prevImmediate.sessionId !== args.sessionId
      || prevImmediate.provider !== args.provider
      || prevImmediate.model !== args.model
      || prevImmediate.effort !== args.effort
      || prevImmediate.fast !== args.fast
      || prevImmediate.contextWindow !== args.contextWindow
      || prevImmediate.displayContextWindow !== args.displayContextWindow
      || prevImmediate.rawContextWindow !== args.rawContextWindow;
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
      lastRawFullLineCacheKeyRef.current = '';
      bootFullDoneRef.current = false;
    }
    const snapLocalNow = themeChanged
      || bootFullDoneRef.current !== true
      || identityChanged;
    if (snapLocalNow) {
      // Reuse the last good FULL line (with its L1 usage segment) whenever this is
      // NOT a route switch and a cached full line exists — covers theme re-tone,
      // agent churn, compact/auto-compact changes and stats reset. We intentionally
      // do NOT require `=== footerCacheKey` here: footerCacheKey embeds agentRevision
      // + compact fields, so it differs on exactly the non-route churn we want to
      // ride through, and requiring equality would fall back to the usage-less
      // localBootStatusLine and reintroduce the blink. A momentarily stale L2
      // (agent count/elapsed) is acceptable; a blinking L1 usage segment is not —
      // the full render below corrects the L2 almost immediately. Route switches
      // (routeChanged) have already wiped the cache above, so they snap local.
      const useCachedRaw = !routeChanged && Boolean(lastRawFullLineRef.current);
      const localNext = useCachedRaw
        ? normalizeStatusLine(lastRawFullLineRef.current)
        : normalizeStatusLine(localBootStatusLine(args));
      if (localNext) setLine((prev) => (prev === localNext ? prev : localNext));
    }
    lastImmediateArgsRef.current = {
      agentRevision,
      sessionId: args.sessionId,
      provider: args.provider,
      model: args.model,
      effort: args.effort,
      fast: args.fast,
      contextWindow: args.contextWindow,
      displayContextWindow: args.displayContextWindow,
      rawContextWindow: args.rawContextWindow,
      compactBoundaryTokens: args.compactBoundaryTokens,
      autoCompactTokenLimit: args.autoCompactTokenLimit,
      stats: args.stats,
    };
    const timer = setTimeout(() => {
      if (bootFullDoneRef.current !== true) {
        if (!bootFullRenderEligible(mountAtRef.current, lineRef.current, args.agentWorkers, args.agentJobs, args.activeTools)) {
          return;
        }
        if (!canAttemptBootFullRender(bootFullNextAttemptAtRef.current)) {
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
          lastRawFullLineCacheKeyRef.current = footerCacheKey;
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
    };
  }, [sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, displayContextWindow, compactBoundaryTokens, autoCompactTokenLimit, rawContextWindow, resizeEpoch, agentRevision, agentWorkers, agentJobs, activeToolsSignature, refreshTick, themeEpoch]);

  const lines = line ? line.split('\n').slice(0, 2) : [' ', ' '];
  const workflowLabel = workflowModeLabel(workflow);
  // Footer footprint stays 3 rows total, but L2 sits directly under L1 without
  // an internal spacer; the remaining row is kept as outer breathing room.
  return (
    <Box flexDirection="column" width="100%" height={3} overflow="hidden" paddingLeft={2} backgroundColor={theme.background}>
      <Box flexDirection="row" width="100%" overflow="hidden">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate">{lines[0] || ' '}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1} marginRight={1}>
          <Text color={theme.statusText} wrap="truncate">{workflowLabel}</Text>
        </Box>
      </Box>
      <Text wrap="truncate">{lines[1] || ' '}</Text>
    </Box>
  );
}

export const StatusLine = React.memo(StatusLineView);
