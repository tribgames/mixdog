#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactToolSearchDescription, defaultDeferredToolNames, TOOL_SEARCH_TOOL } from '../src/mixdog-session-runtime.mjs';
import { buildExplorerPrompt, EXPLORE_TOOL, MAX_FANOUT_QUERIES, normalizeExploreQueries } from '../src/standalone/explore-tool.mjs';
import { BRIDGE_TOOL, createStandaloneBridge } from '../src/standalone/bridge-tool.mjs';
import { createStandaloneChannelWorker } from '../src/standalone/channel-worker.mjs';
import { OpenAIOAuthProvider } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { contentHasImage, sanitizeContentForStoredHistory } from '../src/runtime/agent/orchestrator/providers/media-normalization.mjs';
import { initProviders } from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as SEARCH_TOOL_DEFS } from '../src/runtime/search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../src/runtime/channels/tool-defs.mjs';
import { classifyBridgeWorkerGitMutationCommand } from '../src/runtime/agent/orchestrator/tool-loop-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertOk(name, result, pattern = null) {
  const text = String(result || '');
  if (!text || /^Error[\s:[]/.test(text)) {
    throw new Error(`${name} failed:\n${text}`);
  }
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} returned unexpected output:\n${text.slice(0, 1000)}`);
  }
  return text;
}

{
  const prevTraceDisable = process.env.MIXDOG_BRIDGE_TRACE_DISABLE;
  process.env.MIXDOG_BRIDGE_TRACE_DISABLE = '1';
  try {
    const provider = new OpenAIOAuthProvider({});
    provider.ensureAuth = async () => ({ access_token: 'fake-token' });
    const calls = [];
    const fakeWs = async () => {
      calls.push('ws');
      return { content: 'ws-ok' };
    };
    const fakeHttp = async () => {
      calls.push('http');
      return { content: 'http-ok' };
    };
    const imageTurnContent = [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
    ];
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: imageTurnContent },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-smoke-image-fallback' },
    );
    if (provider._forceHttpFallback) {
      throw new Error('image fallback must not poison future OpenAI OAuth sends');
    }
    const storedImageTurnContent = sanitizeContentForStoredHistory(imageTurnContent);
    if (contentHasImage(storedImageTurnContent)) {
      throw new Error(`stored image history must not retain provider-visible image parts: ${JSON.stringify(storedImageTurnContent)}`);
    }
    await provider.send(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: storedImageTurnContent },
        { role: 'assistant', content: 'image received' },
        { role: 'user', content: 'plain ping text, no image' },
      ],
      'gpt-5.5',
      [],
      { _sendViaWebSocketFn: fakeWs, _sendViaHttpSseFn: fakeHttp, sessionId: 'tool-smoke-plain-after-image' },
    );
    if (calls.join(',') !== 'http,ws') {
      throw new Error(`image fallback should not force next text send over HTTP: ${calls.join(',')}`);
    }
  } finally {
    if (prevTraceDisable == null) delete process.env.MIXDOG_BRIDGE_TRACE_DISABLE;
    else process.env.MIXDOG_BRIDGE_TRACE_DISABLE = prevTraceDisable;
  }
}

const listOut = await executeBuiltinTool('list', { path: 'scripts', head_limit: 20 }, root);
assertOk('list', listOut, /smoke\.mjs/);

const grepOut = await executeBuiltinTool('grep', {
  pattern: ['standalone mixdog CLI/TUI coding agent', 'smoke passed'],
  path: 'scripts',
  glob: '*.mjs',
  head_limit: 10,
}, root);
assertOk('grep', grepOut, /smoke\.mjs/);

const implicitRefsGlobOut = await executeBuiltinTool('glob', {
  pattern: '**/agent-session.ts',
  head_limit: 20,
}, root);
if (/refs[\\/]/i.test(String(implicitRefsGlobOut))) {
  throw new Error(`glob default search must exclude refs unless explicitly targeted:\n${implicitRefsGlobOut}`);
}

const explicitSrcGlobOut = await executeBuiltinTool('glob', {
  pattern: '**/engine.mjs',
  path: 'src',
  head_limit: 20,
}, root);
assertOk('glob explicit src', explicitSrcGlobOut, /src[\\/].*engine\.mjs/i);

const findOut = await executeBuiltinTool('find', {
  query: 'tool smoke',
  path: '.',
  head_limit: 10,
}, root);
assertOk('find', findOut, /scripts[\\/]tool-smoke\.mjs/i);

const readOut = await executeBuiltinTool('read', {
  path: 'scripts/smoke.mjs',
  line: 1,
  context: 3,
}, root);
assertOk('read', readOut, /spawnSync/);

const readDirOut = await executeBuiltinTool('read', {
  path: 'scripts',
}, root);
if (!/^Error[\s:[]/.test(String(readDirOut)) || !/read expects a file/i.test(String(readDirOut))) {
  throw new Error(`read directory must be classified as Error:\n${readDirOut}`);
}

const graphOut = await executeCodeGraphTool('code_graph', {
  mode: 'symbols',
  file: 'scripts/smoke.mjs',
}, root);
assertOk('code_graph', graphOut, /binding|spawnSync|symbol/i);

const patchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-process.stdout.write('smoke passed ✓\\n');
+process.stdout.write('smoke passed ok\\n');
*** End Patch
`,
}, root);
assertOk('apply_patch dry_run', patchOut, /checked|validated|dry|OK/i);

const stalePatchOut = await executePatchTool('apply_patch', {
  base_path: root,
  dry_run: true,
  fuzzy: false,
  patch: `*** Begin Patch
*** Update File: scripts/smoke.mjs
@@
-definitely-not-current-smoke-line
+definitely-not-current-smoke-line-2
*** End Patch
`,
}, root);
if (!/^Error[\s:[]/.test(String(stalePatchOut)) || !/apply_patch/i.test(String(stalePatchOut))) {
  throw new Error(`apply_patch stale context must return an Error result, not throw or pass:\n${stalePatchOut}`);
}

const shellOutPromise = executeBuiltinTool('shell', {
  command: 'node --version',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellFailOutPromise = executeBuiltinTool('shell', {
  command: 'Write-Error "tool-smoke-bash-fail"; exit 7',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellTimeoutOutPromise = executeBuiltinTool('shell', {
  command: 'Start-Sleep -Seconds 2; Write-Output tool-smoke-timeout-missed',
  cwd: root,
  timeout: 500,
  shell: 'powershell',
}, root);

const shellWorkdirOutPromise = executeBuiltinTool('shell', {
  command: 'Get-Location | Select-Object -ExpandProperty Path',
  workdir: resolve(root, 'scripts'),
  timeout: 30_000,
  shell: 'powershell',
}, root);

const shellOut = await shellOutPromise;
assertOk('bash explicit shell/cwd', shellOut, /v\d+\.\d+\.\d+/);

const shellFailOut = await shellFailOutPromise;
if (!/^Error[\s:[]/.test(String(shellFailOut)) || !/\[exit code: 7\]/.test(String(shellFailOut))) {
  throw new Error(`bash non-zero exit must be classified as Error:\n${shellFailOut}`);
}

const shellTimeoutOut = await shellTimeoutOutPromise;
if (!/^Error[\s:[]/.test(String(shellTimeoutOut)) || !/\[timeout: 500ms\b/.test(String(shellTimeoutOut))) {
  throw new Error(`bash timeout must be milliseconds and classified as Error:\n${shellTimeoutOut}`);
}

const legacyEscapedAlternationErr = validateBuiltinArgs('grep', { pattern: 'state\\.items\\.map\\|items\\.map', path: root });
if (legacyEscapedAlternationErr) {
  throw new Error(`grep legacy \\| alternation should be accepted: ${legacyEscapedAlternationErr}`);
}
const legacyEscapedAlternationOut = await executeBuiltinTool('grep', {
  pattern: 'standalone mixdog CLI/TUI coding agent\\|smoke passed',
  path: 'scripts',
  glob: '*.mjs',
  head_limit: 10,
}, root);
assertOk('grep legacy \\| alternation', legacyEscapedAlternationOut, /smoke\.mjs/);
const literalBackslashPipeArray = validateBuiltinArgs('grep', {
  pattern: ['contains \\\\|', 'conflicting window args'],
  path: root,
});
if (literalBackslashPipeArray) {
  throw new Error(`grep array literal \\| should be allowed: ${literalBackslashPipeArray}`);
}

const invalidGrepPath = validateBuiltinArgs('grep', {
  pattern: 'providerStatus',
  path: 'C:\\Project\\mixdog\\src\\tui C:\\Project\\mixdog\\src\\mixdog-session-runtime.mjs',
});
if (!/multiple absolute paths/i.test(invalidGrepPath || '')) {
  throw new Error(`grep multi-path guard failed: ${invalidGrepPath}`);
}

const invalidGrepLookaround = validateBuiltinArgs('grep', {
  pattern: 'C:\\\\Project(?!\\\\mixdog)',
  path: root,
});
if (!/lookaround\/backrefs/i.test(invalidGrepLookaround || '')) {
  throw new Error(`grep unsupported-regex guard failed: ${invalidGrepLookaround}`);
}

const invalidShellPath = validateBuiltinArgs('shell', {
  command: 'cd C:\\Project\\mixdog && node scripts/build-tui.mjs',
});
if (process.platform === 'win32' && !/shell:'powershell'/i.test(invalidShellPath || '')) {
  throw new Error(`shell Windows-path guard failed: ${invalidShellPath}`);
}

const invalidShellCwdAliasConflict = validateBuiltinArgs('shell', {
  command: 'pwd',
  cwd: root,
  workdir: resolve(root, 'scripts'),
  shell: 'powershell',
});
if (!/cwd.*workdir.*conflict/i.test(invalidShellCwdAliasConflict || '')) {
  throw new Error(`shell cwd/workdir conflict guard failed: ${invalidShellCwdAliasConflict}`);
}

const shellWorkdirOut = await shellWorkdirOutPromise;
assertOk('shell workdir alias', shellWorkdirOut, /scripts\s*$/i);

const mixedReadWindow = {
  path: 'scripts/smoke.mjs',
  line: 1,
  context: 3,
  offset: 1,
  limit: 20,
};
const readWindowErr = validateBuiltinArgs('read', mixedReadWindow);
if (!/exactly one window family/i.test(readWindowErr || '')) {
  throw new Error(`read mixed-window guard failed: err=${readWindowErr} args=${JSON.stringify(mixedReadWindow)}`);
}

for (const command of [
  'git status --short',
  'git diff -- src/mixdog-session-runtime.mjs',
  'Write-Output "git push"',
]) {
  const blocked = classifyBridgeWorkerGitMutationCommand(command);
  if (blocked) throw new Error(`agent git guard should allow readonly/non-command form ${JSON.stringify(command)}; got ${blocked}`);
}
for (const [command, expected] of [
  ['git push', 'git push'],
  ['git -C . commit -m smoke', 'git commit'],
  ['npm test && git add -A', 'git add'],
  ['bash -lc "git push"', 'git push'],
  ['cmd /c git commit -m smoke', 'git commit'],
  ['powershell -Command "git stash"', 'git stash'],
]) {
  const blocked = classifyBridgeWorkerGitMutationCommand(command);
  if (blocked !== expected) throw new Error(`agent git guard mismatch for ${JSON.stringify(command)}: got ${blocked}, expected ${expected}`);
}

function assertHas(set, name) {
  if (!set.has(name)) throw new Error(`default tool surface missing ${name}: ${[...set].join(', ')}`);
}

function assertLacks(set, name) {
  if (set.has(name)) throw new Error(`default tool surface should not include ${name}: ${[...set].join(', ')}`);
}

const smokeCatalog = [
  ...BUILTIN_TOOLS,
  ...CODE_GRAPH_TOOL_DEFS,
  ...PATCH_TOOL_DEFS,
  ...MEMORY_TOOL_DEFS,
  ...SEARCH_TOOL_DEFS,
  ...CHANNEL_TOOL_DEFS,
  EXPLORE_TOOL,
  BRIDGE_TOOL,
  TOOL_SEARCH_TOOL,
].filter(Boolean);

const fullDefaults = defaultDeferredToolNames(smokeCatalog, 'full');
if (fullDefaults.size !== 9) {
  throw new Error(`full default surface should stay 9 tools, got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'explore', 'tool_search']) {
  assertHas(fullDefaults, name);
}
for (const name of ['shell', 'task', 'agent', 'recall', 'search', 'web_fetch', 'cwd']) {
  assertLacks(fullDefaults, name);
}

const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
if (leadDefaults.size !== 15) {
  throw new Error(`lead default surface should stay 15 tools, got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'shell', 'task', 'apply_patch', 'explore', 'agent', 'recall', 'search', 'web_fetch', 'tool_search']) {
  assertHas(leadDefaults, name);
}
function toolSchemaSize(tool) {
  const desc = String(tool?.description || '');
  const schema = JSON.stringify(tool?.input_schema || tool?.inputSchema || {});
  return desc.length + schema.length;
}

const surfaceSize = [...fullDefaults].reduce((sum, name) => {
  const tool = smokeCatalog.find((item) => item?.name === name);
  return sum + toolSchemaSize(tool);
}, 0);
if (surfaceSize > 17000) {
  throw new Error(`full default tool surface too large: ${surfaceSize} chars (cap 17000)`);
}
for (const [name, cap] of [
  ['apply_patch', 1300],
  ['code_graph', 1550],
  ['agent', 2500],
  ['recall', 2400],
  ['search', 3200],
  ['web_fetch', 900],
  ['tool_search', 900],
]) {
  const tool = smokeCatalog.find((item) => item?.name === name);
  const size = toolSchemaSize(tool);
  if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
}

const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
if (readonlyDefaults.size !== 8) {
  throw new Error(`readonly default surface should stay 8 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'explore', 'tool_search']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'agent', 'shell']) {
  assertLacks(readonlyDefaults, name);
}

const bridgeProps = BRIDGE_TOOL.inputSchema?.properties || {};
if (bridgeProps.mode || bridgeProps.wait) throw new Error('agent schema should not expose execution mode controls');
if (!/always start background tasks/i.test(BRIDGE_TOOL.description || '') || !/distinct tags/i.test(BRIDGE_TOOL.description || '') || !/completion notification/i.test(BRIDGE_TOOL.description || '') || !/do not (?:call|poll) status\/read/i.test(BRIDGE_TOOL.description || '')) {
  throw new Error('agent description must preserve async tagged delegation contract');
}
const bridgeSmoke = createStandaloneBridge({
  cfgMod: {
    loadConfig: () => ({ providers: {}, presets: [] }),
    resolveRuntimeSpec: () => { throw new Error('agent smoke should not resolve runtime for read/list errors'); },
  },
  reg: { initProviders: async () => {} },
  mgr: {
    getSession: () => null,
    listSessions: () => [],
    closeSession: () => false,
  },
  dataDir: root,
  cwd: root,
  defaultMode: 'async',
});
const bridgeMissingJob = await bridgeSmoke.execute({ type: 'read', task_id: 'task_missing_smoke' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(bridgeMissingJob)) || !/task_missing_smoke/.test(String(bridgeMissingJob))) {
  throw new Error(`agent missing task must return Error result:\n${bridgeMissingJob}`);
}
const bridgeBadType = await bridgeSmoke.execute({ type: 'definitely_bad_type' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(bridgeBadType)) || !/unknown type/i.test(String(bridgeBadType))) {
  throw new Error(`agent unknown type must return Error result:\n${bridgeBadType}`);
}

async function waitForSmoke(predicate, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const channelWorkerTmp = mkdtempSync(join(tmpdir(), 'mixdog-channel-worker-env-'));
let channelEnvWorker = null;
const prevChannelDaemon = process.env.MIXDOG_CHANNEL_DAEMON;
const prevChannelSingleton = process.env.MIXDOG_CHANNEL_SINGLETON;
const prevChannelWorkerProcess = process.env.MIXDOG_CHANNEL_WORKER_PROCESS;
const prevRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
const prevEnvOut = process.env.SMOKE_CHANNEL_ENV_OUT;
try {
  const entry = join(channelWorkerTmp, 'entry.mjs');
  const dataDir = join(channelWorkerTmp, 'data');
  const runtimeDir = join(channelWorkerTmp, 'runtime');
  const envOut = join(channelWorkerTmp, 'env.json');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(entry, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.SMOKE_CHANNEL_ENV_OUT, JSON.stringify({
  cliOwned: process.env.MIXDOG_CLI_OWNED,
  daemon: process.env.MIXDOG_CHANNEL_DAEMON,
}));
process.send?.({ type: 'ready' });
process.on('message', (msg) => {
  if (msg?.type === 'shutdown') process.exit(0);
});
setInterval(() => {}, 10000);
`);
  process.env.MIXDOG_CHANNEL_DAEMON = '1';
  process.env.MIXDOG_CHANNEL_SINGLETON = '1';
  process.env.MIXDOG_CHANNEL_WORKER_PROCESS = '1';
  process.env.MIXDOG_RUNTIME_ROOT = runtimeDir;
  process.env.SMOKE_CHANNEL_ENV_OUT = envOut;
  channelEnvWorker = createStandaloneChannelWorker({
    entry,
    rootDir: root,
    dataDir,
    cwd: root,
  });
  await channelEnvWorker.start();
  const childEnv = JSON.parse(readFileSync(envOut, 'utf8'));
  if (childEnv.daemon !== '1') {
    throw new Error(`channel daemon smoke expected daemon=1, got ${childEnv.daemon}`);
  }
  if (childEnv.cliOwned !== '0') {
    throw new Error(`channel daemon must advertise owner HTTP (MIXDOG_CLI_OWNED=0), got ${childEnv.cliOwned}`);
  }
} finally {
  try { await channelEnvWorker?.stop?.('channel-worker-env-smoke', { force: true }); } catch {}
  if (prevChannelDaemon == null) delete process.env.MIXDOG_CHANNEL_DAEMON;
  else process.env.MIXDOG_CHANNEL_DAEMON = prevChannelDaemon;
  if (prevChannelSingleton == null) delete process.env.MIXDOG_CHANNEL_SINGLETON;
  else process.env.MIXDOG_CHANNEL_SINGLETON = prevChannelSingleton;
  if (prevChannelWorkerProcess == null) delete process.env.MIXDOG_CHANNEL_WORKER_PROCESS;
  else process.env.MIXDOG_CHANNEL_WORKER_PROCESS = prevChannelWorkerProcess;
  if (prevRuntimeRoot == null) delete process.env.MIXDOG_RUNTIME_ROOT;
  else process.env.MIXDOG_RUNTIME_ROOT = prevRuntimeRoot;
  if (prevEnvOut == null) delete process.env.SMOKE_CHANNEL_ENV_OUT;
  else process.env.SMOKE_CHANNEL_ENV_OUT = prevEnvOut;
  rmSync(channelWorkerTmp, { recursive: true, force: true });
}

const bridgeNotifyTmp = mkdtempSync(join(tmpdir(), 'mixdog-bridge-notify-'));
try {
  const ownerNotifications = [];
  const workerQueued = [];
  const bridgeNotifySmoke = createStandaloneBridge({
    cfgMod: {
      loadConfig: () => ({
        providers: { 'openai-oauth': { enabled: true } },
        presets: [{ id: 'sonnet-high', name: 'sonnet-high', provider: 'openai-oauth', model: 'smoke-model', type: 'agent', tools: 'full' }],
      }),
      resolveRuntimeSpec: () => ({ scopeKey: 'smoke-notify', lane: 'bridge' }),
    },
    reg: { initProviders },
    mgr: {
      askSession: async (sessionId, _prompt, _context, _onToolCall, _cwdOverride, _prefetch, askOpts = {}) => {
        const nestedText = `background task\ntask_id: task_shell_notify_smoke\nsurface: shell\noperation: shell\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:01.000Z\n\nnested background done for ${sessionId}`;
        askOpts.notifyFn?.(nestedText, {
          type: 'shell_task_result',
          execution_surface: 'shell',
          execution_id: 'task_shell_notify_smoke',
          status: 'completed',
        });
        return { content: 'worker completed' };
      },
      enqueuePendingMessage: (sessionId, message) => {
        workerQueued.push({ sessionId, message });
        return 1;
      },
      getSession: () => null,
      listSessions: () => [],
      closeSession: () => false,
      hideSessionFromList: () => false,
    },
    dataDir: bridgeNotifyTmp,
    cwd: root,
    defaultMode: 'async',
  });
  const notifyContext = {
    invocationSource: 'model-tool',
    callerCwd: root,
    callerSessionId: 'sess_owner_notify_smoke',
    clientHostPid: 424242,
    notifyFn: (text, meta) => {
      ownerNotifications.push({ text, meta });
      return true;
    },
  };
  const notifyStart = await bridgeNotifySmoke.execute({ type: 'spawn', agent: 'worker', tag: 'notify-smoke', prompt: 'notify smoke' }, notifyContext);
  if (!/agent task:/i.test(String(notifyStart)) || !/status: running/i.test(String(notifyStart))) {
    throw new Error(`agent async notify smoke did not start task:\n${notifyStart}`);
  }
  await waitForSmoke(
    () => ownerNotifications.some((event) => /task_shell_notify_smoke/.test(event.text))
      && workerQueued.some((event) => /task_shell_notify_smoke/.test(event.message)),
    'agent child background completion routing',
  );
  await bridgeNotifySmoke.execute({ type: 'cleanup', force: true }, notifyContext);
} finally {
  rmSync(bridgeNotifyTmp, { recursive: true, force: true });
}
if (EXPLORE_TOOL.annotations?.readOnlyHint !== true || EXPLORE_TOOL.annotations?.destructiveHint === true) {
  throw new Error('explore must stay read-only so readonly surfaces can use it');
}
const exploreProps = EXPLORE_TOOL.inputSchema?.properties || {};
if (!/(?:Broad-scope locator only|First-choice tool for broad or unclear repo\/code location questions)/i.test(EXPLORE_TOOL.description || '') || !/(?:code_graph\/grep\/glob first|Use code_graph\/grep\/glob instead only when)/i.test(EXPLORE_TOOL.description || '')) {
  throw new Error('explore description must preserve broad-locator and direct-tool-first guidance');
}
if (!/Never pass a whole brief/i.test(exploreProps.query?.description || '') || !/relevant repo or subtree/i.test(exploreProps.cwd?.description || '')) {
  throw new Error('explore schema must preserve query narrowness and cwd narrowing guidance');
}
const normalizedExplore = normalizeExploreQueries('["where is model selection?","  ","which file owns agent async?"]');
if (normalizedExplore.length !== 2 || normalizedExplore[0] !== 'where is model selection?') {
  throw new Error(`explore query normalization failed: ${JSON.stringify(normalizedExplore)}`);
}
if (MAX_FANOUT_QUERIES !== 8) throw new Error(`explore fanout cap changed: ${MAX_FANOUT_QUERIES}`);
const explorerPrompt = buildExplorerPrompt('where is <agent> & status?');
if (!explorerPrompt.includes('&lt;agent&gt;') || !explorerPrompt.includes('&amp;') || /verdicts, ratings, or recommendations/.test(explorerPrompt) === false) {
  throw new Error(`explorer prompt contract failed: ${explorerPrompt}`);
}
const patchDescription = PATCH_TOOL_DEFS[0]?.inputSchema?.properties?.patch?.description || '';
if (!/V4A/i.test(patchDescription) || !/one (?:file )?block per target file/i.test(patchDescription) || !/exact current context/i.test(patchDescription)) {
  throw new Error('apply_patch schema must keep V4A, per-target block, and exact-context guidance');
}
const readPathDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.inputSchema?.properties?.path?.description || '';
if (!/file path only/i.test(readPathDescription)) {
  throw new Error('read schema must keep directory-vs-file guidance');
}
const readDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.description || '';
if (!/known file path\(s\)/i.test(readDescription) || !/line\+context/i.test(readDescription)) {
  throw new Error('read description must stay narrow-target oriented');
}
const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
if (!/known files\/symbols/i.test(codeGraphDescription) || !/Use find\/glob for file discovery/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must stay structure-oriented and defer file discovery to find/glob');
}
if (!/Operation:/i.test(codeGraphProps.mode?.description || '') || !/Directory scope is only for references\/callers/i.test(codeGraphProps.file?.description || '')) {
  throw new Error('code_graph schema must explain mode and file scoping');
}
const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall');
const recallProps = recallTool?.inputSchema?.properties || {};
if (!/when in doubt, recall first/i.test(recallTool?.description || '') || !recallProps.id?.anyOf || !/Do not invent ids/i.test(recallProps.id?.description || '')) {
  throw new Error('recall schema must preserve prior-context guidance and id lookup shape');
}
if (!/array for independent fan-out/i.test(recallProps.query?.description || '') || !/Project pool selector/i.test(recallProps.projectScope?.description || '')) {
  throw new Error('recall schema must explain fan-out query and project scope filters');
}
const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory');
const memoryProps = memoryTool?.inputSchema?.properties || {};
if (!/explicit mutation/i.test(memoryTool?.description || '') || !/Destructive jobs require exact confirm/i.test(memoryTool?.description || '') || !/Exact confirmation phrase/i.test(memoryProps.confirm?.description || '')) {
  throw new Error('memory schema must preserve mutation/destructive confirmation guidance');
}
const searchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'search');
const searchProps = searchTool?.inputSchema?.properties || {};
if (!/Runs synchronously/i.test(searchTool?.description || '') || searchProps.mode || searchProps.action || searchProps.task_id || !searchProps.query?.anyOf || !/array for fan-out/i.test(searchProps.query?.description || '')) {
  throw new Error('search schema must preserve sync execution guidance and string/array query shape');
}
if (!/Default web/i.test(searchProps.type?.description || '') || !/locale hint/i.test(searchProps.locale?.description || '') || !/Default low/i.test(searchProps.contextSize?.description || '')) {
  throw new Error('search schema must describe type, locale, and contextSize defaults');
}
const webFetchTool = SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
const webFetchProps = webFetchTool?.inputSchema?.properties || {};
if (!/Use after search/i.test(webFetchTool?.description || '') || !webFetchProps.url?.anyOf || !/array of URLs/i.test(webFetchProps.url?.description || '')) {
  throw new Error('web_fetch schema must preserve after-search guidance and string/array url shape');
}
if (!/offset/i.test(webFetchProps.startIndex?.description || '') || !/Maximum characters/i.test(webFetchProps.maxLength?.description || '')) {
  throw new Error('web_fetch schema must describe paging window fields');
}
if (!/tools\/skills/i.test(TOOL_SEARCH_TOOL.description || '') || !/deferred/i.test(TOOL_SEARCH_TOOL.description || '') || !TOOL_SEARCH_TOOL.inputSchema?.properties?.select) {
  throw new Error('tool_search schema must preserve selection guidance and select field');
}
const replyTool = CHANNEL_TOOL_DEFS.find((tool) => tool.name === 'reply');
if (!/configured channel/i.test(replyTool?.description || '') || !/local .*paths/i.test(replyTool?.inputSchema?.properties?.files?.description || '')) {
  throw new Error('channel reply schema must describe target channel and attachment paths');
}
const fetchTool = CHANNEL_TOOL_DEFS.find((tool) => tool.name === 'fetch');
if (!/NOT for URLs/i.test(fetchTool?.description || '') || !/web_fetch/i.test(fetchTool?.description || '')) {
  throw new Error('channel fetch schema must distinguish Discord fetch from web_fetch');
}
const grepTool = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
const grepPatternDescription = grepTool?.inputSchema?.properties?.pattern?.description || '';
const grepPathDescription = grepTool?.inputSchema?.properties?.path?.description || '';
if (!/(array for OR|array = OR)/i.test(grepPatternDescription) || !/one file or directory/i.test(grepPathDescription)) {
  throw new Error('grep schema must keep array-OR and one-path guidance');
}

const longToolSearchText = compactToolSearchDescription(`${patchDescription}\n${patchDescription}`);
if (longToolSearchText.length > 220 || /\n/.test(longToolSearchText)) {
  throw new Error(`tool_search descriptions must be compact single-line snippets, got ${longToolSearchText.length} chars`);
}

process.stdout.write(`tool smoke passed surface_chars=${surfaceSize}\n`);
