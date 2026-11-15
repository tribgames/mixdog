// Records what the Node footer does, so the Rust footer (`mixdog_tui::footer`) is checked against it (tests/footer_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/src, nothing is written there. Every directory Node reads
// is a fresh temp directory, set in the environment BEFORE any module loads; the clock, the terminal width and the process
// uptime are fixed, so a recording is reproducible.
//
//   node record-footer.mjs --tree C:/Project/mixdog --write tests/goldens/footer.json
//   node record-footer.mjs --tree C:/Project/mixdog --check tests/goldens/footer.json
//
// Recorded:
//  * renders - `renderStatusline` (src/ui/statusline.mjs, a fresh module per case so its caches start empty) over file sets
//              (the data directory of the case) and a sequence of steps: a render, then the background refreshes it queued
//              (`setImmediate`) run, then the clock moves on. Widths 40..200; an API route with no files; a configured quota
//              window with a usage log (spend and local windows); an OAuth route with a confirmed cached usage (the boot latch,
//              the held segments when the cache goes away) and one cached by a previous launch (stays hidden); the second row
//              with agents, jobs, a web search, a shell job and the memory cycle. The OAuth usage cache and the model catalog
//              are what the process supplies in Node (modules of its own); for each step the recording holds what they
//              answered, and the Rust test hands the same answers back;
//  * hook    - the status line hook (components/status-line/use-statusline-text.mjs, a React effect) replayed statement for
//              statement over a fake timer queue with the real boot-schedule, local-line, bridge and statusline modules:
//              the line after each step, the next timer, and the refresh period.
//
// The corpus keeps clear of the ambiguous-width glyphs the Windows display-width policy widens, so the recording does not
// depend on the platform it was made on.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-footer.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// Every directory Node reads is a fresh temp directory BEFORE any module loads.
const sandbox = mkdtempSync(join(tmpdir(), 'rft-'));
for (const [key, name] of [['MIXDOG_HOME', 'home'], ['HOME', 'h'], ['USERPROFILE', 'up'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'local'], ['MIXDOG_CONFIG_DIR', 'config']]) {
  mkdirSync(join(sandbox, name), { recursive: true });
  process.env[key] = join(sandbox, name);
}
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock = T0;
const realNow = Date.now;
Date.now = () => clock;
process.uptime = () => 0;
const setColumns = (cols) => Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true, writable: true });

const sources = [];
const load = async (path, query = '') => {
  const file = join(tree, path);
  if (!sources.some((source) => source.path === path)) sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href + query);
};
const oauthUsage = await load('src/runtime/agent/orchestrator/providers/oauth-usage.mjs');
const catalog = await load('src/runtime/shared/llm/model-catalog.mjs');
const boot = await load('src/tui/components/status-line/boot-schedule.mjs');
const localLine = await load('src/tui/components/status-line/local-line.mjs');
const bridge = await load('src/tui/statusline-ansi-bridge.mjs');
await load('src/ui/statusline.mjs');
const segments = await load('src/runtime/shared/statusline/statusline-segments.mjs');

const flush = async (ms = 0) => {
  // The refreshes the render queued (setImmediate), and the file reads of the shell and memory segments (promises).
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise((resolve) => setImmediate(resolve));
};

// The shell-job and memory-cycle caches live in the segments module, shared by every case: before a case writes its files they
// are read once against its empty data directory, as a fresh process would have, so no case starts with a neighbour's rows.
async function primeSegments(origin) {
  clock = origin - 10_000;
  for (const pid of [0, 4242, process.pid]) {
    segments.shellJobsStatus({ clientHostPid: pid });
    segments.shellJobsStatus({ clientHostPid: pid, sessionId: 'sess_footer01' });
  }
  segments.memoryCycleStatus();
  await flush(60);
}

const clean = (value) => String(value ?? '').trim();
const providerKind = (provider) => (provider.includes('oauth') ? 'oauth' : provider === 'mixdog-local' ? 'local' : 'api');

function writeFiles(dir, files, at) {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    utimesSync(path, at / 1000, at / 1000);
  }
}

// The state of a render that the process supplies in Node: what the OAuth usage cache and the catalog answer.
function suppliedFor(spec) {
  const provider = clean(spec.provider).toLowerCase();
  const routeInfo = { provider, model: clean(spec.model), providerKind: providerKind(provider) };
  let usage = null;
  try {
    usage = provider.includes('oauth') ? oauthUsage.readCachedOAuthUsageSnapshot(routeInfo, { allowStale: true }) : null;
  } catch {}
  const meta = {};
  for (const [model, prov] of [[clean(spec.model), spec.provider], [clean(spec.model), clean(spec.provider)], [clean(spec.model), 'anthropic-oauth']]) {
    const found = catalog.getModelMetadataSync(model, prov);
    if (found) meta[`${model}\u0000${prov}`] = JSON.parse(JSON.stringify(found));
  }
  return { usage: usage ? JSON.parse(JSON.stringify(usage)) : null, meta };
}

const baseArgs = {
  provider: 'openai',
  model: 'gpt-5',
  effort: 'high',
  fast: false,
  ultra: false,
  cwd: '/work',
  stats: { currentContextTokens: 50_000, currentContextSource: 'last_api_request', turns: 3 },
  sessionId: 'sess_footer01',
  clientHostPid: 4242,
  contextWindow: 200_000,
  displayContextWindow: 0,
  rawContextWindow: 0,
  compactBoundaryTokens: 0,
  autoCompactTokenLimit: 0,
  agentWorkers: [],
  agentJobs: [],
  activeTools: null,
};

const widths = [40, 60, 79, 80, 100, 119, 120, 160, 200];
const oauthCache = (T, cachedAt, extra = {}) =>
  `${JSON.stringify({ routes: { 'openai-oauth': { cachedAt, source: 'codex', quotaWindows: [{ label: '5H', source: 'openai', usedPct: 41.26, resetAt: T + 3 * HOUR }, { label: '7D', source: 'openai', usedPct: 12, resetAt: T + 3 * DAY }], ...extra } } })}\n`;
const oauthConfig = `${JSON.stringify({ gateway: { mode: 'fixed', defaultProvider: 'openai-oauth', defaultModel: 'gpt-5' } })}\n`;

const makeRenderCases = (T) => [
  {
    name: 'an API route with no files at widths 40 to 200',
    files: {},
    steps: widths.map((cols, index) => ({ cols, args: { ...baseArgs, fast: index % 2 === 0, ultra: index % 4 === 0 }, advance: 600 })),
  },
  {
    name: 'no stats and no window: nothing measured yet; an unknown model',
    files: {},
    steps: [
      { cols: 120, args: { ...baseArgs, stats: null, contextWindow: 0, model: 'some-local-model', effort: '' }, advance: 600 },
      { cols: 80, args: { ...baseArgs, stats: { currentContextSource: 'unavailable' }, contextWindow: 0 }, advance: 600 },
      { cols: 120, args: { ...baseArgs, stats: { currentContextTokens: 190_000, currentContextSource: 'last_api_request' } }, advance: 600 },
      { cols: 120, args: { ...baseArgs, stats: { currentContextTokens: 150_000, currentContextSource: 'last_api_request' } }, advance: 600 },
    ],
  },
  {
    name: 'a configured quota window measured against the local spend, with the route spend',
    files: {
      'mixdog-config.json': `${JSON.stringify({ gateway: { mode: 'fixed', defaultProvider: 'openai', defaultModel: 'gpt-5', quotaWindows: { daily: { limitUsd: 10 } } } })}\n`,
      'gateway-usage.local.jsonl': [
        { ts: T - 1000, provider: 'openai', model: 'gpt-5', costUsd: 2.5 },
        { ts: T - 2 * DAY, provider: 'openai', model: 'gpt-5', costUsd: 4 },
        { ts: T - 1000, provider: 'other', model: 'gpt-5', costUsd: 99 },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    },
    steps: [120, 120, 120, 80, 80, 60].map((cols) => ({ cols, args: baseArgs, advance: 600 })),
  },
  {
    name: 'an OAuth route: nothing until the first confirmed usage, then the windows, held when the cache goes away',
    files: { 'mixdog-config.json': oauthConfig, 'gateway-oauth-usage-cache.json': oauthCache(T, T + 500) },
    steps: [
      ...[120, 120, 120, 120, 80, 60].map((cols) => ({ cols, args: { ...baseArgs, provider: 'openai-oauth' }, advance: 600 })),
      { cols: 120, args: { ...baseArgs, provider: 'openai-oauth' }, advance: 600, remove: ['gateway-oauth-usage-cache.json'] },
      { cols: 120, args: { ...baseArgs, provider: 'openai-oauth' }, advance: 600 },
      { cols: 120, args: { ...baseArgs, provider: 'openai-oauth' }, advance: 600 },
      { cols: 120, args: { ...baseArgs, provider: 'openai-oauth', sessionId: 'sess_footer02' }, advance: 600 },
      { cols: 120, args: { ...baseArgs, provider: 'openai-oauth', sessionId: 'sess_footer02' }, advance: 600 },
    ],
  },
  {
    name: 'an OAuth route whose usage a previous launch cached stays hidden',
    files: { 'mixdog-config.json': oauthConfig, 'gateway-oauth-usage-cache.json': oauthCache(T, T - 1000) },
    steps: [120, 120, 120, 120].map((cols) => ({ cols, args: { ...baseArgs, provider: 'openai-oauth' }, advance: 600 })),
  },
  {
    name: 'the second row: agents, jobs, a web search, a shell job and the memory cycle',
    files: {
      [`shell-jobs/job_${T - 10_000}_a1.json`]: `${JSON.stringify({ command: 'npm run dev', cwd: '/work', startedAt: T - 10_000, ownerSessionId: 'sess_footer01', foreground: false, pid: '$PID' })}\n`,
      [`shell-jobs/job_${T - 10_000}_a1.owner-4242`]: '',
      'memory-cycle-state.json': `${JSON.stringify({ updatedAt: T - 1000, running: { cycle: 'cycle1', started_at: T - 65_000 } })}\n`,
    },
    steps: [
      { cols: 120, args: baseArgs, advance: 600, wait: 60 },
      { cols: 120, args: baseArgs, advance: 600, wait: 60 },
      {
        cols: 120,
        wait: 60,
        advance: 600,
        args: {
          ...baseArgs,
          agentWorkers: [{ tag: 'a', stage: 'running', startedAt: T - 5000 }, { tag: 'b', status: 'idle', startedAt: T - 9000 }, { name: 'cycle1-agent', stage: 'running', agent: 'cycle1-agent' }],
          agentJobs: [{ tag: 'j', status: 'Running', startedAt: T - 3000 }, { tag: 'k', status: 'done', finishedAt: T - 100, startedAt: T - 2000 }],
          activeTools: { web_search: { count: 2, startedAt: T - 7000 } },
        },
      },
      { cols: 80, wait: 60, advance: 600, args: { ...baseArgs, sessionId: 'sess_other', activeTools: { web_search: { count: 1, startedAt: 0 } } } },
      { cols: 120, wait: 60, advance: 600, args: { ...baseArgs, sessionId: '', clientHostPid: 4242 } },
    ],
  },
];

const caseOrigin = (index) => T0 + (index + 1) * 10 * DAY;

async function recordRender(index) {
  const origin = caseOrigin(index);
  const spec = makeRenderCases(origin)[index];
  const dir = mkdtempSync(join(sandbox, 'data-'));
  process.env.MIXDOG_DATA_DIR = dir;
  await primeSegments(origin);
  const pidToken = String(process.pid);
  const files = {};
  for (const [name, content] of Object.entries(spec.files)) files[name] = content.replaceAll('"$PID"', pidToken);
  writeFiles(dir, files, origin);
  clock = origin;
  const module = await load('src/ui/statusline.mjs', `?case=${index}`);
  const steps = [];
  for (const step of spec.steps) {
    for (const name of step.remove ?? []) {
      rmSync(join(dir, name), { force: true });
      delete files[name];
    }
    setColumns(step.cols);
    const supplied = suppliedFor(step.args);
    const out = await module.renderStatusline(step.args);
    await flush(step.wait ?? 0);
    steps.push({ now: clock, cols: step.cols, args: step.args, supplied, out, removed: step.remove ?? [] });
    clock += step.advance;
  }
  rmSync(dir, { recursive: true, force: true });
  return { name: spec.name, origin, pid: '$PID', files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.replaceAll(pidToken, '$PID')])), steps };
}

// --- the hook ---------------------------------------------------------------------------------------------------------

const hookBase = { ...baseArgs, stats: { currentContextTokens: 20_000, currentContextSource: 'last_api_request' } };

function hookCaseSpec(name, ops) {
  return { name, ops };
}

const makeHookCases = (T) => [
  hookCaseSpec('boot: the instant line, the boot delay, the first full render, then the refresh ticks', [
    { op: 'mount', inputs: { args: hookBase } },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'tick' },
    { op: 'wake' },
    { op: 'advance', ms: 1800 },
    { op: 'tick' },
    { op: 'wake' },
  ]),
  hookCaseSpec('a route switch snaps local, a context window change keeps the full line, a theme change re-tones', [
    { op: 'mount', inputs: { args: hookBase } },
    { op: 'advance', ms: 1200 },
    { op: 'tick' },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, displayContextWindow: 400_000 } } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, displayContextWindow: 400_000, model: 'gpt-5-mini' } } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, displayContextWindow: 400_000, model: 'gpt-5-mini' }, themeEpoch: 1 } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, displayContextWindow: 400_000, model: 'gpt-5-mini', stats: { currentContextTokens: 90_000, currentContextSource: 'last_api_request' } }, themeEpoch: 1 } },
    { op: 'wake' },
  ]),
  hookCaseSpec('active work: the web search and the agents lengthen the boot delay and speed up the refresh', [
    { op: 'mount', inputs: { args: { ...hookBase, activeTools: { web_search: { count: 1, startedAt: T } } } } },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, agentWorkers: [{ tag: 'a', stage: 'running', startedAt: T }] }, agentRevision: 1 } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, agentWorkers: [{ tag: 'a', stage: 'done', startedAt: T }] }, agentRevision: 2 } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, agentWorkers: [{ tag: 'a', stage: 'done', startedAt: T }] }, agentRevision: 2, resizeEpoch: 1 } },
    { op: 'wake' },
  ]),
  hookCaseSpec('a saved line stands in for the boot line; a new array with the same content does not re-arm the timer', [
    { op: 'mount', inputs: { args: hookBase }, initialLine: '\u001b[38;2;198;198;198msaved model\u001b[0m' },
    { op: 'update', inputs: { args: { ...hookBase, agentWorkers: [] } } },
    { op: 'wake' },
    { op: 'update', inputs: { args: { ...hookBase, agentWorkers: [] } } },
    { op: 'wake' },
  ]),
];

async function recordHook(index) {
  const origin = caseOrigin(100 + index);
  const spec = makeHookCases(origin)[index];
  const dir = mkdtempSync(join(sandbox, 'hook-'));
  process.env.MIXDOG_DATA_DIR = dir;
  await primeSegments(origin);
  clock = origin;
  setColumns(120);
  const module = await load('src/ui/statusline.mjs', `?hook=${index}`);
  const h = { line: '', refreshTick: 0, bootFullDone: false, mountAt: 0, lastRaw: '', lastImmediate: null, themeEpoch: 0, debounceAt: null, bootRetryAt: null, deps: null, inputs: null, effectArgs: null };
  const withClientDefaults = (inputs) => ({ ...inputs.args, sessionId: inputs.args.sessionId, clientHostPid: inputs.args.clientHostPid });
  const stats = (s) => {
    const o = s && typeof s === 'object' ? s : {};
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return [n(o.currentContextTokens), n(o.currentEstimatedContextTokens), n(o.inputTokens), n(o.latestInputTokens), n(o.promptTokens), n(o.turns), n(o.contextTokens), String(o.currentContextSource || '')].join('|');
  };
  const ws = (list, tagKeys, stageKeys) =>
    Array.isArray(list)
      ? list.map((w) => `${tagKeys.map((k) => w?.[k]).find(Boolean) || ''}|${stageKeys.map((k) => w?.[k]).find(Boolean) || ''}|${num(w?.startedAt || w?.startTime || w?.createdAt)}`).join(',')
      : '';
  const num = (value) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const depsOf = (inputs) => {
    const a = inputs.args;
    return JSON.stringify([
      a.sessionId, a.clientHostPid, a.provider, a.model, a.effort, a.fast, a.ultra, a.cwd, stats(a.stats), a.contextWindow, a.displayContextWindow, a.compactBoundaryTokens,
      a.autoCompactTokenLimit, a.rawContextWindow, inputs.resizeEpoch ?? 0, inputs.agentRevision ?? 0, ws(a.agentWorkers, ['tag', 'agent', 'name'], ['stage', 'status']),
      ws(a.agentJobs, ['tag', 'agent', 'name'], ['status', 'stage']), a.activeTools ? [Number(a.activeTools.web_search?.count) || 0, Number(a.activeTools.web_search?.startedAt) || 0].join('|') : '',
      h.refreshTick, inputs.themeEpoch ?? 0,
    ]);
  };
  const recordLine = () => h.line;
  const effect = async (inputs) => {
    h.debounceAt = null;
    h.bootRetryAt = null;
    const a = withClientDefaults(inputs);
    const identityChanged = bridge.statuslineFooterIdentityChanged({ ...a, agentRevision: inputs.agentRevision ?? 0 }, h.lastImmediate);
    const prev = h.lastImmediate;
    const routeChanged = !prev || prev.sessionId !== a.sessionId || prev.provider !== a.provider || prev.model !== a.model || prev.effort !== a.effort || prev.fast !== a.fast || prev.ultra !== a.ultra;
    const themeChanged = h.themeEpoch !== (inputs.themeEpoch ?? 0);
    if (themeChanged) h.themeEpoch = inputs.themeEpoch ?? 0;
    if (routeChanged) {
      h.lastRaw = '';
      h.bootFullDone = false;
    }
    if (themeChanged || h.bootFullDone !== true || identityChanged) {
      const next = localLine.buildLocalSnapLine(a, routeChanged ? '' : h.lastRaw);
      if (next) h.line = next;
    }
    h.lastImmediate = { agentRevision: inputs.agentRevision ?? 0, sessionId: a.sessionId, provider: a.provider, model: a.model, effort: a.effort, fast: a.fast, ultra: a.ultra, contextWindow: a.contextWindow, displayContextWindow: a.displayContextWindow, rawContextWindow: a.rawContextWindow, compactBoundaryTokens: a.compactBoundaryTokens, autoCompactTokenLimit: a.autoCompactTokenLimit, stats: a.stats };
    h.effectArgs = a;
    h.debounceAt = clock + boot.STATUSLINE_RENDER_DEBOUNCE_MS;
  };
  const render = async (inputs) => {
    h.inputs = inputs;
    const deps = depsOf(inputs);
    if (h.deps === deps) return;
    h.deps = deps;
    await effect(inputs);
  };
  const tick = async () => {
    h.refreshTick = (h.refreshTick + 1) % 1_000_000;
    await render(h.inputs);
  };
  const steps = [];
  const snapshot = (op) => {
    const wakes = [h.debounceAt, h.bootRetryAt].filter((t) => t !== null);
    const a = h.inputs.args;
    steps.push({ op, now: clock - origin, line: recordLine(), nextWake: wakes.length ? Math.min(...wakes) - origin : null, refreshMs: boot.hasActiveStatuslineWork(h.line, a.agentWorkers, a.agentJobs, a.activeTools) ? boot.STATUSLINE_ACTIVE_REFRESH_MS : boot.STATUSLINE_REFRESH_MS });
  };
  const fire = async () => {
    const a = h.effectArgs;
    if (h.bootRetryAt !== null && h.bootRetryAt <= clock) {
      h.bootRetryAt = null;
      await tick();
    }
    if (h.debounceAt !== null && h.debounceAt <= clock) {
      h.debounceAt = null;
      if (h.bootFullDone !== true) {
        const remaining = boot.bootFullRenderDelayRemainingMs(h.mountAt, h.line, a.agentWorkers, a.agentJobs, a.activeTools);
        if (remaining > 0) {
          h.bootRetryAt = clock + Math.max(150, remaining);
          return;
        }
      }
      const s = await module.renderStatusline(a);
      h.lastRaw = String(s);
      h.bootFullDone = true;
      const next = localLine.normalizeStatusLine(s);
      if (next) h.line = next;
    }
    await flush();
  };
  for (const op of spec.ops) {
    if (op.op === 'mount') {
      h.inputs = op.inputs;
      h.mountAt = clock;
      h.themeEpoch = op.inputs.themeEpoch ?? 0;
      h.line = localLine.normalizeStatusLine(op.initialLine || localLine.localBootStatusLine({ ...op.inputs.args, sessionId: undefined, clientHostPid: undefined }));
      await render(op.inputs);
    } else if (op.op === 'update') {
      await render(op.inputs);
    } else if (op.op === 'tick') {
      await tick();
    } else if (op.op === 'advance') {
      clock += op.ms;
    } else if (op.op === 'wake') {
      const wakes = [h.debounceAt, h.bootRetryAt].filter((t) => t !== null);
      if (wakes.length) clock = Math.max(clock, Math.min(...wakes));
      await fire();
    }
    snapshot(op);
  }
  rmSync(dir, { recursive: true, force: true });
  return { name: spec.name, origin, ops: spec.ops, steps };
}

const golden = { note: 'footer text of the Node statusline: renderStatusline over file sets, and the status line hook over a fake timer queue', sources: null, renders: [], hooks: [] };
for (let i = 0; i < makeRenderCases(T0).length; i += 1) golden.renders.push(await recordRender(i));
for (let i = 0; i < makeHookCases(T0).length; i += 1) golden.hooks.push(await recordHook(i));
golden.sources = sources.map((source) => ({ ...source }));
Date.now = realNow;
rmSync(sandbox, { recursive: true, force: true });

const text = `${JSON.stringify(golden, null, 1)}\n`;
const sanitized = text;
if (option('--write')) {
  writeFileSync(option('--write'), sanitized);
  console.log(`renders=${golden.renders.length} hooks=${golden.hooks.length} bytes=${sanitized.length}`);
} else {
  const recorded = JSON.parse(readFileSync(option('--check'), 'utf8'));
  const strip = (value) => ({ ...value, sources: undefined });
  const same = JSON.stringify(strip(recorded)) === JSON.stringify(strip(golden));
  if (!same) {
    console.error('footer.json differs from what the Node code does now');
    process.exit(1);
  }
  console.log('footer.json matches');
}
void relative;
void readdirSync;
void statSync;
