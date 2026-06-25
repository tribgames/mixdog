#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactToolSearchDescription, defaultDeferredToolNames } from '../src/mixdog-session-runtime.mjs';
import { buildExplorerPrompt, EXPLORE_MAX_LOOP_ITERATIONS, EXPLORE_TOOL, MAX_FANOUT_QUERIES, normalizeExploreQueries } from '../src/standalone/explore-tool.mjs';
import { BRIDGE_TOOL, createStandaloneBridge, resolveBridgeExecutionMode } from '../src/standalone/bridge-tool.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { BUILTIN_TOOLS } from '../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { PATCH_TOOL_DEFS } from '../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';

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

const explicitRefsGlobOut = await executeBuiltinTool('glob', {
  pattern: '**/agent-session.ts',
  path: 'refs',
  head_limit: 20,
}, root);
assertOk('glob explicit refs', explicitRefsGlobOut, /refs[\\/].*agent-session\.ts/i);

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

const shellOut = await executeBuiltinTool('bash', {
  command: 'node --version',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);
assertOk('bash explicit shell/cwd', shellOut, /v\d+\.\d+\.\d+/);

const shellFailOut = await executeBuiltinTool('bash', {
  command: 'Write-Error "tool-smoke-bash-fail"; exit 7',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);
if (!/^Error[\s:[]/.test(String(shellFailOut)) || !/\[exit code: 7\]/.test(String(shellFailOut))) {
  throw new Error(`bash non-zero exit must be classified as Error:\n${shellFailOut}`);
}

const shellTimeoutOut = await executeBuiltinTool('bash', {
  command: 'Start-Sleep -Seconds 2; Write-Output tool-smoke-timeout-missed',
  cwd: root,
  timeout: 500,
  shell: 'powershell',
}, root);
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
  path: 'C:\\Project\\mixdog-cli\\src\\tui C:\\Project\\mixdog-cli\\src\\mixdog-session-runtime.mjs',
});
if (!/multiple absolute paths/i.test(invalidGrepPath || '')) {
  throw new Error(`grep multi-path guard failed: ${invalidGrepPath}`);
}

const invalidGrepLookaround = validateBuiltinArgs('grep', {
  pattern: 'C:\\\\Project(?!\\\\mixdog-cli)',
  path: root,
});
if (!/lookaround\/backrefs/i.test(invalidGrepLookaround || '')) {
  throw new Error(`grep unsupported-regex guard failed: ${invalidGrepLookaround}`);
}

const invalidShellPath = validateBuiltinArgs('bash', {
  command: 'cd C:\\Project\\mixdog-cli && node scripts/build-tui.mjs',
});
if (process.platform === 'win32' && !/shell:'powershell'/i.test(invalidShellPath || '')) {
  throw new Error(`bash Windows-path shell guard failed: ${invalidShellPath}`);
}

const invalidShellCwdAliasConflict = validateBuiltinArgs('bash', {
  command: 'pwd',
  cwd: root,
  workdir: resolve(root, 'scripts'),
  shell: 'powershell',
});
if (!/cwd.*workdir.*conflict/i.test(invalidShellCwdAliasConflict || '')) {
  throw new Error(`bash cwd/workdir conflict guard failed: ${invalidShellCwdAliasConflict}`);
}

const shellWorkdirOut = await executeBuiltinTool('bash', {
  command: 'Get-Location | Select-Object -ExpandProperty Path',
  workdir: resolve(root, 'scripts'),
  timeout: 30_000,
  shell: 'powershell',
}, root);
assertOk('bash workdir alias', shellWorkdirOut, /scripts\s*$/i);

const invalidEditMixedShape = validateBuiltinArgs('edit', {
  path: 'scripts/smoke.mjs',
  old_string: 'x',
  new_string: 'y',
  edits: [{ old_string: 'x', new_string: 'y' }],
});
if (!/either single old_string\/new_string OR edits\[\], not both/i.test(invalidEditMixedShape || '')) {
  throw new Error(`edit mixed single+batch guard failed: ${invalidEditMixedShape}`);
}

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

const forcedAsync = resolveBridgeExecutionMode(
  { wait: true, mode: 'sync', async: false },
  { invocationSource: 'model-tool' },
  'sync',
);
if (forcedAsync !== 'async') throw new Error(`bridge model-tool mode should be async, got ${forcedAsync}`);

const userSync = resolveBridgeExecutionMode(
  { wait: true },
  { invocationSource: 'user-command' },
  'async',
);
if (userSync !== 'sync') throw new Error(`bridge user-command wait mode should be sync, got ${userSync}`);

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
  EXPLORE_TOOL,
  BRIDGE_TOOL,
  { name: 'tool_search', annotations: { readOnlyHint: true, destructiveHint: false }, description: 'select tools' },
].filter(Boolean);

const fullDefaults = defaultDeferredToolNames(smokeCatalog, 'full');
if (fullDefaults.size !== 9) {
  throw new Error(`full default surface should stay 9 tools, got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'glob', 'list', 'apply_patch', 'explore', 'bridge', 'tool_search']) {
  assertHas(fullDefaults, name);
}
for (const name of ['bash', 'edit', 'write']) {
  assertLacks(fullDefaults, name);
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
if (surfaceSize > 8500) {
  throw new Error(`full default tool surface too large: ${surfaceSize} chars (cap 8500)`);
}
for (const [name, cap] of [
  ['apply_patch', 1300],
  ['code_graph', 1300],
  ['bridge', 1500],
]) {
  const tool = smokeCatalog.find((item) => item?.name === name);
  const size = toolSchemaSize(tool);
  if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
}

const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
if (readonlyDefaults.size !== 7) {
  throw new Error(`readonly default surface should stay 7 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'glob', 'list', 'explore', 'tool_search']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'bridge', 'bash', 'edit', 'write']) {
  assertLacks(readonlyDefaults, name);
}

const bridgeProps = BRIDGE_TOOL.inputSchema?.properties || {};
if (bridgeProps.mode || bridgeProps.wait) throw new Error('bridge model schema must not expose mode/wait');
if (!/always async/i.test(BRIDGE_TOOL.description || '')) throw new Error('bridge description must state model calls are async');
const bridgeSmoke = createStandaloneBridge({
  cfgMod: {
    loadConfig: () => ({ providers: {}, presets: [] }),
    resolveRuntimeSpec: () => { throw new Error('bridge smoke should not resolve runtime for read/list errors'); },
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
const bridgeMissingJob = await bridgeSmoke.execute({ type: 'read', jobId: 'job_missing_smoke' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(bridgeMissingJob)) || !/job_missing_smoke/.test(String(bridgeMissingJob))) {
  throw new Error(`bridge missing job must return Error result:\n${bridgeMissingJob}`);
}
const bridgeBadType = await bridgeSmoke.execute({ type: 'definitely_bad_type' }, { invocationSource: 'model-tool', cwd: root });
if (!/^Error[\s:[]/.test(String(bridgeBadType)) || !/unknown type/i.test(String(bridgeBadType))) {
  throw new Error(`bridge unknown type must return Error result:\n${bridgeBadType}`);
}
if (EXPLORE_TOOL.annotations?.readOnlyHint !== true || EXPLORE_TOOL.annotations?.destructiveHint === true) {
  throw new Error('explore must stay read-only so readonly surfaces can use it');
}
const normalizedExplore = normalizeExploreQueries('["where is model selection?","  ","which file owns bridge async?"]');
if (normalizedExplore.length !== 2 || normalizedExplore[0] !== 'where is model selection?') {
  throw new Error(`explore query normalization failed: ${JSON.stringify(normalizedExplore)}`);
}
if (MAX_FANOUT_QUERIES !== 8) throw new Error(`explore fanout cap changed: ${MAX_FANOUT_QUERIES}`);
if (EXPLORE_MAX_LOOP_ITERATIONS !== 8) throw new Error(`explore loop cap changed: ${EXPLORE_MAX_LOOP_ITERATIONS}`);
const explorerPrompt = buildExplorerPrompt('where is <bridge> & status?');
if (!explorerPrompt.includes('&lt;bridge&gt;') || !explorerPrompt.includes('&amp;') || /verdicts, ratings, or recommendations/.test(explorerPrompt) === false) {
  throw new Error(`explorer prompt contract failed: ${explorerPrompt}`);
}
const patchDescription = PATCH_TOOL_DEFS[0]?.inputSchema?.properties?.patch?.description || '';
if (!/do not repeat the same target file/i.test(patchDescription)) {
  throw new Error('apply_patch schema must warn against duplicate target blocks');
}
const readPathDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.inputSchema?.properties?.path?.description || '';
if (!/file path only/i.test(readPathDescription)) {
  throw new Error('read schema must keep directory-vs-file guidance');
}
const readDescription = BUILTIN_TOOLS.find((tool) => tool.name === 'read')?.description || '';
if (!/(do not inspect refs unless requested|refs only if requested)/i.test(readDescription) || !/use symbol OR line\+context/i.test(readDescription)) {
  throw new Error('read description must keep broad-query and exclusive-window guidance');
}
if (!/avoid read/i.test(readDescription) || !/(do not reread the same file|no reread same file)/i.test(readDescription)) {
  throw new Error('read description must keep location-candidate anti-reread guidance');
}
const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
if (!/answer from file:line without read/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must keep location-candidate no-read guidance');
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
