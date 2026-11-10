/*
 * components/status-line/local-line.mjs — the instant-local statusline (L1/L2)
 * built from store state, plus palette normalization for the full async line.
 */
import { rgbSgr } from '../../../runtime/shared/statusline/ansi.mjs';
import { measuredContextUsage, contextMeasurementLabel } from '../../../runtime/shared/context-measurement.mjs';
import { displayModelName, effortDisplayLabel, shortenModelName } from '../../../runtime/shared/model-display.mjs';
import { theme } from '../../theme.mjs';
import { normalizeStatuslineAnsi } from '../../statusline-ansi-bridge.mjs';
// Cache-only synchronous read (never touches fs on the render path), so the
// instant-local L2 can render the Shell segment itself instead of grafting it
// out of the previous full line.
import { shellJobsStatus, unconfirmedShellCount } from '../../../runtime/shared/statusline/statusline-segments.mjs';
import { formatElapsed, num, terminalColumns, timeMs } from '../../../runtime/shared/statusline/statusline-format.mjs';
import { isTerminalStatus } from './boot-schedule.mjs';

const RESET = '\x1b[0m';

function ansiRgb(value, fallback) {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(String(value || '').replace(/\s+/g, ''));
  if (!match) return fallback;
  return rgbSgr(match[1], match[2], match[3]);
}

// SGR escapes derived from the active theme. Resolved per call (not captured at
// module load) so a live `/theme` switch re-tones the statusline on the next
// render. `theme` is mutated in-place on switch.
function statusColors() {
  return {
    STATUS: ansiRgb(theme.statusText, rgbSgr(198, 198, 198)),
    SUBTLE: ansiRgb(theme.statusSubtle, rgbSgr(136, 136, 136)),
    SUCCESS: ansiRgb(theme.success, rgbSgr(0, 170, 75)),
    WARNING: ansiRgb(theme.warning, rgbSgr(255, 193, 7)),
    ERROR: ansiRgb(theme.error, rgbSgr(220, 70, 88)),
  };
}

function localContextPctDisplayLabel(ctxPct) {
  const pct = Number(ctxPct);
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  return String(Math.round(Math.min(100, pct) * 10) / 10);
}

function localContextSegmentFromPct(ctxPct, source = 'pending') {
  const { SUBTLE, SUCCESS, WARNING, ERROR } = statusColors();
  if (ctxPct == null) return `${SUBTLE}${contextMeasurementLabel(source)}${RESET}`;
  const cols = terminalColumns();
  const cells = cols >= 80 ? 14 : 0;
  const raw = Number(ctxPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const barPct = Math.max(0, Math.min(100, pct));
  let fill = SUCCESS;
  if (pct >= 90) fill = ERROR;
  else if (pct >= 70) fill = WARNING;
  const label = localContextPctDisplayLabel(pct);
  if (!cells) return `${fill}${label}%${RESET}`;
  let filled = Math.floor((barPct * cells) / 100);
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

function localL2SpinnerFrame(now = Date.now()) {
  const index = Math.floor(now / LOCAL_L2_SPINNER_FRAME_MS) % LOCAL_WORKER_SPINNER_FRAMES.length;
  return LOCAL_WORKER_SPINNER_FRAMES[index] || LOCAL_WORKER_SPINNER_FRAMES[0];
}

function localRunningWorkerCount(agentWorkers = [], agentJobs = []) {
  const seen = new Set();
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.agent || worker?.name || '').trim();
    if (!tag || isTerminalStatus(worker?.stage || worker?.status)) continue;
    seen.add(tag);
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (!/running/i.test(String(job?.status || job?.stage || ''))) continue;
    const tag = String(job?.tag || job?.agent || job?.type || job?.task_id || job?.taskId || '').trim();
    if (!tag) continue;
    seen.add(tag);
  }
  return seen.size;
}

// Oldest running worker/job start time, for the Agents segment elapsed. Mirrors
// the async path which derives elapsed from the oldest running worker.
function localOldestWorkerStartMs(agentWorkers = [], agentJobs = []) {
  let oldest = Infinity;
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    if (isTerminalStatus(worker?.stage || worker?.status)) continue;
    const t = timeMs(worker?.startedAt || worker?.startTime || worker?.createdAt);
    if (t > 0 && t < oldest) oldest = t;
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (!/running/i.test(String(job?.status || job?.stage || ''))) continue;
    const t = timeMs(job?.startedAt);
    if (t > 0 && t < oldest) oldest = t;
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

// L2 assembly only — themed SGR (statusColors SUCCESS/STATUS/SUBTLE), already in
// the active palette, so this must NOT be passed through normalizeStatusLine.
// Returns the joined L2 string or '' when no active segment. Order:
// Agents → Shells → Web Searching. shellJobsStatus() is a cache-only
// synchronous read (its refresh runs in the background, never on the render
// path), so the shell count is computed here directly instead of being grafted
// out of the previously cached full line.
export function localStatusLineL2(
  { agentWorkers = [], agentJobs = [], activeTools = null, sessionId = '', clientHostPid = 0 } = {},
  now = Date.now()
) {
  const { STATUS, SUBTLE, SUCCESS } = statusColors();
  const spin = `${SUCCESS}${localL2SpinnerFrame(now)}${RESET}`;
  const segSep = ` ${SUBTLE}│${RESET} `;
  const elapsedSuffix = (label) => (label ? ` ${SUBTLE}·${RESET} ${label}` : '');
  const l2Parts = [];
  const runningCount = localRunningWorkerCount(agentWorkers, agentJobs);
  if (runningCount > 0) {
    const label = `Running ${runningCount} Agent${runningCount === 1 ? '' : 's'}`;
    const oldestStart = localOldestWorkerStartMs(agentWorkers, agentJobs);
    const elapsed = oldestStart > 0 ? formatElapsed(now - oldestStart) : '';
    l2Parts.push(`${spin} ${STATUS}${label}${RESET}${elapsedSuffix(elapsed)}`);
  }
  // Session-scoped like the full path: one host process owns many sessions'
  // jobs, so an owner-wide aggregate would light up every other pane.
  const shellScope = String(sessionId ?? '').trim();
  const shellStatus = shellScope
    ? shellJobsStatus({ clientHostPid, sessionId: shellScope })
    : shellJobsStatus({ clientHostPid });
  // A shell whose termination is unconfirmed is not "running": it is held,
  // with /shells as the way to inspect or release it.
  const unconfirmed = unconfirmedShellCount(shellStatus);
  const shellCount = (Number(shellStatus?.count) || 0) - unconfirmed;
  if (shellCount > 0) {
    const label = `Running ${shellCount} Shell${shellCount === 1 ? '' : 's'}`;
    l2Parts.push(`${spin} ${STATUS}${label}${RESET}${elapsedSuffix(shellStatus.elapsedLabel || '')}`);
  }
  if (unconfirmed > 0) {
    const { WARNING } = statusColors();
    const label = `⚠ ${unconfirmed} Shell${unconfirmed === 1 ? '' : 's'} termination unconfirmed`;
    l2Parts.push(`${WARNING}${label}${RESET} ${SUBTLE}·${RESET} /shells`);
  }
  // `web_search` is the key the producers publish (session/active-tool-summary
  // and app/use-transcript-activity); the async full render reads the same key,
  // so both paths light the segment on the same snapshot.
  const tools = activeTools && typeof activeTools === 'object' ? activeTools : {};
  const searchInfo = tools.web_search || null;
  if (searchInfo && num(searchInfo.count) > 0) {
    const elapsed = num(searchInfo.startedAt) > 0 ? formatElapsed(now - num(searchInfo.startedAt)) : '';
    l2Parts.push(`${spin} ${STATUS}Web Searching${RESET}${elapsedSuffix(elapsed)}`);
  }
  return l2Parts.length ? l2Parts.join(segSep) : '';
}

export function localBootStatusLine(args = {}) {
  const {
    provider = '',
    model = '',
    effort = '',
    fast = false,
    ultra = false,
    stats = null,
    contextWindow = 0,
    displayContextWindow = 0,
    rawContextWindow = 0,
  } = args;
  const raw = String(model || '').trim();
  const { STATUS, SUBTLE } = statusColors();
  const display = shortenModelName(displayModelName(raw, provider, ''), terminalColumns());
  let speedLabel = '';
  if (fast === true) speedLabel = ultra === true ? 'Ultrafast' : 'Fast';
  const flags = [effort ? effortDisplayLabel(effort) : '', speedLabel].filter(Boolean);
  const modelBits = [display, ...flags].join(` ${SUBTLE}·${RESET} `);
  const ctxPct = measuredContextUsage({
    stats,
    contextWindow,
    displayContextWindow,
    rawContextWindow,
  }).percent;
  const l1 = `${STATUS}${modelBits}${RESET} ${SUBTLE}│${RESET} ${localContextSegmentFromPct(ctxPct, stats?.currentContextSource)}`;
  const l2 = localStatusLineL2(args);
  return l2 ? `${l1}\n${l2}` : l1;
}

export function normalizeStatusLine(text) {
  return normalizeStatuslineAnsi(text, statusColors(), { reset: RESET });
}

export function workflowModeLabel(workflow = {}) {
  const name = String(workflow?.name || workflow?.id || 'Default').trim() || 'Default';
  return `${name} Mode`;
}

// Local line shown while the async full render is not yet applicable. Keeps the
// cached full line's L1 (usage segment preserved, re-toned via normalize) and
// grafts a FRESH L2 from the CURRENT args so agent count/elapsed/web search are
// never stale. The cached line is canonical-truecolor, so normalizeStatusLine
// re-tones it; the fresh L2 is built with statusColors() (already themed) and
// MUST NOT be double-normalized. Falls back to localBootStatusLine when there is
// no cached line or it normalizes to empty (never emit a blank).
export function buildLocalSnapLine(args, cachedRawLine) {
  if (cachedRawLine) {
    const cachedNormalized = normalizeStatusLine(cachedRawLine);
    if (cachedNormalized) {
      const [cachedL1] = cachedNormalized.split('\n');
      // One shared `now` so every L2 spinner shows the SAME frame even across a
      // 120ms frame boundary. The local L2 renders every segment itself (Agents
      // → Shells → Web Search), so the cached L2 is discarded outright.
      const freshL2 = localStatusLineL2(args, Date.now());
      return freshL2 ? `${cachedL1}\n${freshL2}` : cachedL1;
    }
  }
  return normalizeStatusLine(localBootStatusLine(args));
}
