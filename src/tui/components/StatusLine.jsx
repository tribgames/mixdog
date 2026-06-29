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

function hasActiveStatuslineWork(line, agentWorkers = [], agentJobs = []) {
  return hasRunningStatuslineWorkers(agentWorkers, agentJobs)
    || /\bRunning (?:Agents?|Shells?)\b/.test(stripAnsi(line));
}

function bootFullRenderEligible(mountAtMs, line, agentWorkers = [], agentJobs = []) {
  const elapsed = Date.now() - mountAtMs;
  const active = hasActiveStatuslineWork(line, agentWorkers, agentJobs);
  const delay = active ? STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS : STATUSLINE_BOOT_FULL_DELAY_MS;
  return elapsed >= delay;
}

function canAttemptBootFullRender(nextAttemptAtMs = 0) {
  return Date.now() >= nextAttemptAtMs;
}

function isResetStatsState(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  return localNum(s.currentContextTokens) === 0
    && localNum(s.currentEstimatedContextTokens) === 0
    && localNum(s.inputTokens) === 0
    && localNum(s.latestInputTokens) === 0
    && localNum(s.promptTokens) === 0
    && localNum(s.turns) === 0;
}

function shouldSnapLocalStatusline(args, lastArgs) {
  if (!args) return false;
  if (!lastArgs) return true;
  if (args.agentRevision !== lastArgs.agentRevision) return true;
  if (args.sessionId !== lastArgs.sessionId) return true;
  if (args.provider !== lastArgs.provider || args.model !== lastArgs.model) return true;
  if (args.effort !== lastArgs.effort || args.fast !== lastArgs.fast) return true;
  if (args.contextWindow !== lastArgs.contextWindow || args.rawContextWindow !== lastArgs.rawContextWindow) return true;
  if (isResetStatsState(args.stats) && !isResetStatsState(lastArgs.stats)) return true;
  return false;
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

function localContextPct({ provider = '', stats = null, contextWindow = 0 } = {}) {
  const window = localNum(contextWindow) > 0 ? localNum(contextWindow) : 200_000;
  const s = stats && typeof stats === 'object' ? stats : {};
  const source = String(s.currentContextSource || '').toLowerCase();
  const estimated = localNum(s.currentEstimatedContextTokens);
  if (source === 'estimated' && estimated > 0) {
    return Math.max(0, Math.min(100, (estimated / window) * 100));
  }
  let tokens = localNum(s.currentContextTokens ?? s.contextTokens ?? s.latestInputTokens);
  if (!tokens) tokens = localNum(s.inputTokens);
  if (!tokens) return 0;
  return Math.max(0, Math.min(100, (tokens / window) * 100));
}

function localContextSegmentFromPct(ctxPct = 0) {
  const { SUBTLE, SUCCESS, WARNING, ERROR } = statusColors();
  const cols = terminalColumns();
  const cells = cols >= 80 ? 14 : 0;
  const pct = Math.max(0, Math.min(100, Number(ctxPct) || 0));
  const fill = pct >= 90 ? ERROR : pct >= 70 ? WARNING : SUCCESS;
  const label = pct > 0 && pct < 1 ? String(Math.round(pct * 10) / 10) : String(Math.floor(pct));
  if (!cells) return `${fill}${label}%${RESET}`;
  let filled = Math.floor(pct * cells / 100);
  if (pct >= 1 && filled === 0) filled = 1;
  filled = Math.max(0, Math.min(cells, filled));
  const bar = '▓'.repeat(filled) + '░'.repeat(cells - filled);
  const filledBar = bar.replace(/░/g, '');
  const emptyBar = bar.replace(/▓/g, '');
  return `${fill}${filledBar}${RESET}${SUBTLE}${emptyBar}${RESET} ${label}%`;
}

const LOCAL_WORKER_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function localWorkerSpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / 160) % LOCAL_WORKER_SPINNER_FRAMES.length;
  return LOCAL_WORKER_SPINNER_FRAMES[index] || LOCAL_WORKER_SPINNER_FRAMES[0];
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

function localBootStatusLine({
  provider = '',
  model = '',
  effort = '',
  fast = false,
  stats = null,
  contextWindow = 0,
  agentWorkers = [],
  agentJobs = [],
} = {}) {
  const raw = String(model || '').trim();
  const { STATUS, SUBTLE, SUCCESS } = statusColors();
  const display = shortenModelName(
    canonicalModelDisplay(raw, provider) || raw || 'model',
    terminalColumns(),
  );
  const flags = [effort ? String(effort).toUpperCase() : '', fast === true ? 'FAST' : ''].filter(Boolean);
  const modelBits = [display, ...flags].join(` ${SUBTLE}·${RESET} `);
  const ctxPct = localContextPct({ provider, stats, contextWindow });
  const l1 = `${STATUS}◆${RESET} ${STATUS}${modelBits}${RESET} ${SUBTLE}│${RESET} ${localContextSegmentFromPct(ctxPct)}`;
  const runningCount = localRunningWorkerCount(agentWorkers, agentJobs);
  if (!runningCount) return l1;
  const label = `${runningCount} Running Agent${runningCount === 1 ? '' : 's'}`;
  const tagSummary = localRunningWorkerTags(agentWorkers, agentJobs);
  const tags = tagSummary ? ` ${SUBTLE}(${RESET}${STATUS}${tagSummary}${RESET}${SUBTLE})${RESET}` : '';
  const l2 = `${SUCCESS}${localWorkerSpinnerFrame()}${RESET} ${STATUS}${label}${RESET}${tags}`;
  return `${l1}\n${l2}`;
}

export function normalizeStatusLine(text) {
  const { STATUS, SUBTLE, SUCCESS, WARNING, ERROR } = statusColors();
  return String(text || '')
    .replace(/\n+$/, '')
    .replace(/\x1b\[1m/g, STATUS)
    .replace(/\x1b\[2m/g, SUBTLE)
    .replace(/\x1b\[31m/g, ERROR)
    .replace(/\x1b\[32m/g, SUCCESS)
    .replace(/\x1b\[33m/g, WARNING)
    .replace(/\x1b\[36m/g, SUBTLE)
    .replace(/\x1b\[90m/g, SUBTLE)
    .replace(/^(?:\x1b\[[0-9;]*m)*◆(?:\x1b\[[0-9;]*m)*\s?/, STATUS)
    .replace(/(\x1b\[0m )(\d+(?:\.\d+)?%)(?= |$)/g, `$1${STATUS}$2${RESET}`)
    .replaceAll(`${RESET} ${SUBTLE}│${RESET} `, ` ${SUBTLE}│${RESET} `);
}

function workflowModeLabel(workflow = {}) {
  const name = String(workflow?.name || workflow?.id || 'Default').trim() || 'Default';
  return `${name} Mode`;
}

function StatusLineView({ sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, agentRevision = '', agentWorkers = [], agentJobs = [], initialLine = '', workflow = null, themeEpoch = 0 }) {
  const [line, setLine] = useState(() => normalizeStatusLine(initialLine || localBootStatusLine({
    provider,
    model,
    effort,
    fast,
    stats,
    contextWindow,
    agentWorkers,
    agentJobs,
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

  const statuslineArgs = { sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, agentWorkers, agentJobs };
  statuslineArgsRef.current = statuslineArgs;
  lineRef.current = line;
  const refreshMs = hasActiveStatuslineWork(line, agentWorkers, agentJobs) ? STATUSLINE_ACTIVE_REFRESH_MS : STATUSLINE_REFRESH_MS;

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
    // A theme switch must re-tone the footer immediately: the stored `line`
    // holds already-normalized ANSI with the OLD palette, so re-running
    // normalizeStatusLine on it is a no-op. Force a fresh local rebuild (new
    // palette) and reset bootFullDone so the next full render re-normalizes.
    const themeChanged = themeEpochRef.current !== themeEpoch;
    if (themeChanged) {
      themeEpochRef.current = themeEpoch;
      bootFullDoneRef.current = false;
    }
    const snapLocalNow = themeChanged
      || bootFullDoneRef.current !== true
      || shouldSnapLocalStatusline(
        { ...args, agentRevision },
        lastImmediateArgsRef.current,
      );
    if (snapLocalNow) {
      const localNext = normalizeStatusLine(localBootStatusLine(args));
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
      rawContextWindow: args.rawContextWindow,
      stats: args.stats,
    };
    const timer = setTimeout(() => {
      if (bootFullDoneRef.current !== true) {
        if (!bootFullRenderEligible(mountAtRef.current, lineRef.current, args.agentWorkers, args.agentJobs)) {
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
  }, [sessionId, clientHostPid, provider, model, effort, fast, cwd, stats, contextWindow, rawContextWindow, resizeEpoch, agentRevision, agentWorkers, agentJobs, refreshTick, themeEpoch]);

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
