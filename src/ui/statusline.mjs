/**
 * src/ui/statusline.mjs — per-turn footer status line.
 *
 * The bottom statusline is rendered from CLI-native state. Older builds routed
 * this through the vendored Claude/plugin statusline renderer by fabricating a
 * Claude-Code-shaped JSON payload; that made CLI-only state (bridge workers,
 * selected model/effort, shell-job ownership) depend on plugin-era side
 * channels. This module is now the normalizing boundary: TUI/REPL state comes
 * in, L1/L2 text comes out.
 *
 * `createSessionStats()` returns a small accumulator the REPL feeds from the
 * engine's `onUsageDelta` callback. Gateway quota/balance helpers are still
 * reused as read-only data sources, but display identity always belongs to the
 * CLI route passed here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { bold, colorEnabled, green, rgb } from './ansi.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { formatGatewayLimitSegments, loadGatewayStatus } from '../vendor/statusline/bin/statusline-route.mjs';

// Token window used to compute a fallback context% from our own session usage.
// The live gateway (when up) overrides this with the real route's window. This
// is only the last resort for unknown local models.
const FALLBACK_CONTEXT_WINDOW = 200000;
const statusText = rgb(198, 198, 198);
const statusSubtle = rgb(136, 136, 136);
const statusAccent = rgb(215, 119, 87);
const DEFAULT_STANDALONE_DATA_DIR = join(homedir(), '.mixdog', 'data');

function sgr(code) {
  return colorEnabled() ? `\x1b[${code}m` : '';
}

const R = sgr('0');
const B = sgr('1');
const D = sgr('38;2;136;136;136');
const GRN = sgr('38;2;0;200;83');
const YLW = sgr('38;2;255;193;7');
const RED = sgr('38;2;255;82;104');
const CYN = sgr('38;2;136;136;136');
const GREY = sgr('38;2;136;136;136');

/** Create a mutable session-usage accumulator. */
export function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCachedTokens: 0,
    latestCacheWriteTokens: 0,
    latestPromptTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

/**
 * Fold one `onUsageDelta` event into the accumulator.
 * @param {object} stats — from createSessionStats()
 * @param {object} delta — { deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite, costUsd }
 */
export function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  stats.inputTokens += num(delta.deltaInput);
  stats.outputTokens += num(delta.deltaOutput);
  stats.cachedTokens += num(delta.deltaCachedRead);
  stats.cacheWriteTokens += num(delta.deltaCacheWrite);
  stats.promptTokens += num(delta.deltaPrompt);
  stats.latestInputTokens = num(delta.deltaInput);
  stats.latestOutputTokens = num(delta.deltaOutput);
  stats.latestCachedTokens = num(delta.deltaCachedRead);
  stats.latestCacheWriteTokens = num(delta.deltaCacheWrite);
  stats.latestPromptTokens = num(delta.deltaPrompt);
  // costUsd from the engine is cumulative-per-call; we sum the per-turn deltas.
  stats.costUsd += num(delta.costUsd);
  return stats;
}

/**
 * Build the Claude-Code-shaped JSON the vendored renderer reads, from our REPL
 * state. Only the fields `renderStatusLine()` actually consumes are emitted:
 *   - display_name              → model name (L1)
 *   - effort.level              → effort string
 *   - context_window.*          → context% bar (used_percentage + raw tokens
 *                                 so the lib's activeContextTokens() also works)
 *   - session_id                → gateway session lookup
 * model / context% / effort / 5H-7D are overridden by the live gateway via
 * loadGatewayStatus() when it's running; these are the standalone fallbacks.
 */
function providerInputExcludesCache(provider) {
  return String(provider || '').toLowerCase().includes('anthropic');
}

function promptFootprintTokens(provider, stats) {
  const s = stats || createSessionStats();
  const explicit = num(s.promptTokens);
  if (explicit > 0) return explicit;
  const input = num(s.inputTokens);
  if (providerInputExcludesCache(provider)) {
    return input + num(s.cachedTokens) + num(s.cacheWriteTokens);
  }
  return input;
}

function currentContextTokens(provider, stats) {
  const s = stats || createSessionStats();
  const explicit = num(s.currentContextTokens ?? s.contextTokens ?? s.latestPromptTokens);
  if (explicit > 0) return explicit;
  const latestInput = num(s.latestInputTokens);
  const latestCacheRead = num(s.latestCachedTokens);
  const latestCacheWrite = num(s.latestCacheWriteTokens);
  if (latestInput || latestCacheRead || latestCacheWrite) {
    return providerInputExcludesCache(provider)
      ? latestInput + latestCacheRead + latestCacheWrite
      : latestInput;
  }
  return promptFootprintTokens(provider, s);
}

function modelContextWindow(provider, model, explicitContextWindow = 0) {
  const explicit = num(explicitContextWindow);
  if (explicit > 0) return explicit;
  const metaWindow = num(getModelMetadataSync(model, provider)?.contextWindow);
  if (metaWindow > 0) return metaWindow;
  return FALLBACK_CONTEXT_WINDOW;
}

function normalizeBridgeWorkerForStatusline(worker = {}) {
  const tag = String(worker.tag || worker.role || worker.name || '').trim();
  if (!tag) return null;
  const statusText = String(worker.stage || worker.status || '').toLowerCase();
  const status = /idle|done|closed|error/.test(statusText) ? 'idle' : 'running';
  return {
    tag,
    status,
    role: worker.role || null,
    stage: worker.stage || worker.status || null,
    sessionId: worker.sessionId || null,
    provider: worker.provider || null,
    model: worker.model || null,
  };
}

function normalizeBridgeJobForStatusline(job = {}) {
  const statusText = String(job.status || job.stage || '').toLowerCase();
  if (!statusText || !/running/.test(statusText)) return null;
  const tag = String(job.tag || job.role || job.type || '').trim();
  if (!tag) return null;
  return {
    tag,
    status: 'running',
    role: job.role || null,
    stage: job.stage || job.workerStatus || job.status || null,
    sessionId: job.sessionId || null,
    provider: job.provider || null,
    model: job.model || null,
  };
}

function bridgeStatuslinePayload(bridgeWorkers = [], bridgeJobs = []) {
  const byTag = new Map();
  for (const worker of Array.isArray(bridgeWorkers) ? bridgeWorkers : []) {
    const row = normalizeBridgeWorkerForStatusline(worker);
    if (row) byTag.set(row.tag, row);
  }
  for (const job of Array.isArray(bridgeJobs) ? bridgeJobs : []) {
    const row = normalizeBridgeJobForStatusline(job);
    if (!row) continue;
    const prev = byTag.get(row.tag);
    byTag.set(row.tag, { ...(prev || {}), ...row, status: 'running' });
  }
  const workers = [...byTag.values()];
  return {
    workers,
    sessions: {
      roles: workers.filter((w) => w.status !== 'idle').map((w) => w.tag),
      workers,
    },
  };
}

/**
 * Render the L1/L2 statusline footer from CLI state.
 *
 * ASYNC only because gateway quota helpers may touch the filesystem. On ANY
 * error we fall back to a minimal one-line footer so the REPL never sees a
 * throw.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} opts.cwd
 * @param {object} opts.stats — createSessionStats() accumulator
 * @param {string} [opts.sessionId]
 * @returns {Promise<string>}
 */
export async function renderStatusline({ provider = '', model = '', effort = '', fast = false, cwd = '', stats, sessionId, contextWindow = 0, rawContextWindow = 0, bridgeWorkers = [], bridgeJobs = [], clientHostPid = process.pid } = {}) {
  try {
    return renderNativeStatusline({ provider, model, effort, fast, cwd, stats, sessionId, contextWindow, rawContextWindow, bridgeWorkers, bridgeJobs, clientHostPid });
  } catch {
    return fallbackLine({ provider, model, effort, fast, cwd, stats });
  }
}

// --- helpers -----------------------------------------------------------------

function renderNativeStatusline({ provider = '', model = '', effort = '', fast = false, stats, sessionId, contextWindow = 0, rawContextWindow = 0, bridgeWorkers = [], bridgeJobs = [], clientHostPid = process.pid } = {}) {
  const cols = terminalColumns();
  const s = stats || createSessionStats();
  const contextTokens = currentContextTokens(provider, s);
  const resolvedContextWindow = modelContextWindow(provider, model, contextWindow);
  const ctxPct = resolvedContextWindow > 0 ? clampPct((contextTokens / resolvedContextWindow) * 100) : 0;
  const gatewayStatus = loadGatewayQuotaStatus({ provider, sessionId, activeContextTokens: contextTokens, clientHostPid });

  const sep = ` ${D}│${R} `;
  const l1Parts = [];
  const l2Parts = [];
  const addL1 = (seg) => { if (seg) l1Parts.push(seg); };
  const addL2 = (seg) => { if (seg) l2Parts.push(seg); };

  addL1(formatModelSegment({ provider, model, effort, fast, cols }));
  addL1(formatContextSegment(ctxPct, cols));

  const quotaSegments = gatewayStatus
    ? formatGatewayLimitSegments(gatewayStatus, { COLS: cols, D, R, GRN, YLW, RED, colourPct, epochMsToHHMM })
    : [];
  for (const seg of quotaSegments) addL1(seg);

  const { maintenance, runningWorkers, idleWorkers } = classifyBridgeWorkers(bridgeStatuslinePayload(bridgeWorkers, bridgeJobs).workers);
  if (maintenance.length) addL1(maintenance.join(' '));
  addL1(formatShellJobsSegment({ clientHostPid }));

  if (runningWorkers.length) {
    addL2(`${GRN}●${R} ${B}${runningWorkers.length} Running${R} ${D}(${R}${CYN}${runningWorkers.join(', ')}${R}${D})${R}`);
  }
  if (idleWorkers.length) {
    addL2(`${GREY}● ${idleWorkers.length} idle (${idleWorkers.join(', ')})${R}`);
  }

  const l1 = l1Parts.join(sep) || 'mixdog';
  const l2 = l2Parts.join(sep);
  return l2 ? `${l1}\n${l2}` : l1;
}

function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.MIXDOG_DATA_DIR || DEFAULT_STANDALONE_DATA_DIR;
}

function loadGatewayQuotaStatus({ provider, sessionId, activeContextTokens, clientHostPid } = {}) {
  try {
    const status = loadGatewayStatus({ sessionId, activeContextTokens, clientHostPid });
    if (!status) return null;
    const statusProvider = String(status.provider || '').trim();
    const cliProvider = String(provider || '').trim();
    if (cliProvider && statusProvider && statusProvider !== cliProvider) return null;
    return status;
  } catch {
    return null;
  }
}

function formatModelSegment({ provider, model, effort, fast, cols }) {
  const modelName = shortenModelName(displayModelName(provider, model), cols);
  const bits = [`${CYN}◆${R} ${B}${modelName}${R}`];
  if (effort) bits.push(`${B}${String(effort).toUpperCase()}${R}`);
  if (fast === true) bits.push(`${B}FAST${R}`);
  return bits.join(` ${D}·${R} `);
}

function displayModelName(provider, model) {
  const raw = String(model || '').trim();
  const meta = getModelMetadataSync(raw, provider) || {};
  const display = String(meta.display || meta.name || meta.displayName || raw || 'model').trim();
  return display || raw || 'model';
}

function shortenModelName(name, cols) {
  let out = String(name || 'model').replace(/\s*\(1M context\)/i, ' (1M)');
  out = out.replace(/^Claude\s+/i, '');
  out = out.replace(/^OpenAI\s+/i, '');
  if (cols < 80 && out.length > 18) return out.slice(0, 17) + '…';
  if (cols < 120 && out.length > 28) return out.slice(0, 27) + '…';
  return out;
}

function formatContextSegment(ctxPct, cols) {
  const pct = clampPct(ctxPct);
  const fill = pct >= 90 ? RED : pct >= 70 ? YLW : GRN;
  const label = pct > 0 && pct < 1 ? String(Math.round(pct * 10) / 10) : String(Math.floor(pct));
  const cells = cols >= 120 ? 14 : cols >= 80 ? 8 : 0;
  if (!cells) return `${fill}${label}%${R}`;
  const bar = makeBar(pct, cells);
  const filled = bar.replace(/░/g, '');
  const empty = bar.replace(/▓/g, '');
  return `${fill}${filled}${R}${D}${empty}${R} ${label}%`;
}

function makeBar(pct, cells) {
  let filled = Math.floor((Number(pct) || 0) * cells / 100);
  if (filled < 0) filled = 0;
  if (filled > cells) filled = cells;
  if (pct > 0 && filled === 0) filled = 1;
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

function colourPct(p) {
  if (p >= 90) return `${RED}${p}%${R}`;
  if (p >= 70) return `${YLW}${p}%${R}`;
  return `${GRN}${p}%${R}`;
}

function epochMsToHHMM(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function classifyBridgeWorkers(workers = []) {
  const maintenance = [];
  const runningWorkers = [];
  const idleWorkers = [];
  for (const w of Array.isArray(workers) ? workers : []) {
    const tag = String(w?.tag || '').trim();
    if (!tag) continue;
    const maint = maintenanceLabel(tag);
    if (maint) {
      if (w.status !== 'idle') maintenance.push(`${GRN}↻${R} ${B}${maint}${R}`);
      continue;
    }
    if (w.status === 'idle') idleWorkers.push(tag);
    else runningWorkers.push(tag);
  }
  return { maintenance, runningWorkers, idleWorkers };
}

function maintenanceLabel(tag) {
  switch (tag) {
    case 'cycle1-agent': return 'cycle1';
    case 'cycle2-agent': return 'cycle2';
    case 'cycle3-agent': return 'cycle3';
    case 'scheduler-task': return 'scheduler';
    case 'webhook-handler': return 'webhook';
    case 'explorer': return 'explorer';
    default: return '';
  }
}

function formatShellJobsSegment({ clientHostPid } = {}) {
  const ownerPid = positiveInt(clientHostPid);
  if (!ownerPid) return '';
  try {
    const dir = join(dataDir(), 'shell-jobs');
    if (!existsSync(dir)) return '';
    const names = readdirSync(dir);
    const done = new Set(names.filter((n) => n.endsWith('.done')).map((n) => n.slice(0, -5)));
    const ownerByJob = new Map();
    for (const n of names) {
      const i = n.lastIndexOf('.owner-');
      if (i > 0) {
        const pid = positiveInt(n.slice(i + 7));
        if (pid) ownerByJob.set(n.slice(0, i), pid);
      }
    }
    const ids = names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((id) => !done.has(id) && ownerByJob.get(id) === ownerPid)
      .sort((a, b) => jobStampMs(b) - jobStampMs(a))
      .slice(0, 30);
    let count = 0;
    let oldestMs = Infinity;
    for (const id of ids) {
      const p = join(dir, `${id}.json`);
      let detail;
      try { detail = JSON.parse(readFileSync(p, 'utf-8')); } catch { continue; }
      if (!isShellJobAlive(detail, p, dir, id)) continue;
      count++;
      try {
        const st = statSync(p);
        if (st.mtimeMs < oldestMs) oldestMs = st.mtimeMs;
      } catch {}
    }
    if (!count) return '';
    const elapsed = Number.isFinite(oldestMs) ? ` ${formatElapsed(Date.now() - oldestMs)}` : '';
    return `${GREY}⚙ bash:${count}${elapsed}${R}`;
  } catch {
    return '';
  }
}

function isShellJobAlive(detail, detailPath, dir, id) {
  const pid = positiveInt(detail?.pid);
  if (!pid) return false;
  try {
    const st = statSync(detailPath);
    const timeoutMs = Number(detail?.timeoutMs);
    const enforced = detail?.timeoutEnforced === true || existsSync(join(dir, `${id}.enforced`));
    if (enforced && Number.isFinite(timeoutMs) && timeoutMs > 0 && Date.now() - st.mtimeMs > timeoutMs + 30 * 60_000) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function jobStampMs(id) {
  const m = /^job_(\d+)/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function formatElapsed(ms) {
  const secs = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

/** Minimal one-line footer used when the vendored renderer is unavailable. */
function fallbackLine({ provider = '', model = '', effort = '', fast = false, cwd = '', stats } = {}) {
  const s = stats || createSessionStats();
  const sep = statusSubtle(' | ');
  const flags = [effort ? String(effort).toUpperCase() : '', fast === true ? 'FAST' : ''].filter(Boolean).join(' | ');
  const id = statusAccent(`${provider}/${model}${flags ? ` | ${flags}` : ''}`);
  const tokens = statusText(
    `${fmt(s.inputTokens)} in / ${fmt(s.outputTokens)} out` +
      (s.cachedTokens ? ` / ${fmt(s.cachedTokens)} read` : '') +
      (s.cacheWriteTokens ? ` / ${fmt(s.cacheWriteTokens)} write` : ''),
  );
  const cost = s.costUsd > 0 ? green('$' + s.costUsd.toFixed(4)) : statusSubtle('$0.0000');
  const dir = bold(basename(cwd || process.cwd()) || cwd);
  return statusSubtle('> ') + [id, tokens, cost, dir].join(sep);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Human-friendly token count: 1234 -> 1.2k. */
function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? '1M' : `${k}k`;
  }
  return (v / 1_000_000).toFixed(1) + 'M';
}
