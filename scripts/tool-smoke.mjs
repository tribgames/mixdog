#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactToolSearchDescription, defaultDeferredToolNames, TOOL_SEARCH_TOOL } from '../src/mixdog-session-runtime.mjs';
import { buildExplorerPrompt, EXPLORE_TOOL, MAX_FANOUT_QUERIES, normalizeExploreQueries } from '../src/standalone/explore-tool.mjs';
import { BRIDGE_TOOL, createStandaloneBridge, resolveBridgeExecutionMode } from '../src/standalone/bridge-tool.mjs';
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

const shellOut = await executeBuiltinTool('shell', {
  command: 'node --version',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);
assertOk('bash explicit shell/cwd', shellOut, /v\d+\.\d+\.\d+/);

const shellFailOut = await executeBuiltinTool('shell', {
  command: 'Write-Error "tool-smoke-bash-fail"; exit 7',
  cwd: root,
  timeout: 30_000,
  shell: 'powershell',
}, root);
if (!/^Error[\s:[]/.test(String(shellFailOut)) || !/\[exit code: 7\]/.test(String(shellFailOut))) {
  throw new Error(`bash non-zero exit must be classified as Error:\n${shellFailOut}`);
}

const shellTimeoutOut = await executeBuiltinTool('shell', {
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

const shellWorkdirOut = await executeBuiltinTool('shell', {
  command: 'Get-Location | Select-Object -ExpandProperty Path',
  workdir: resolve(root, 'scripts'),
  timeout: 30_000,
  shell: 'powershell',
}, root);
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

const modelDefaultAsync = resolveBridgeExecutionMode(
  {},
  { invocationSource: 'model-tool' },
  'sync',
);
if (modelDefaultAsync !== 'async') throw new Error(`bridge model-tool default mode should be async, got ${modelDefaultAsync}`);

const explicitSync = resolveBridgeExecutionMode(
  { wait: true, mode: 'sync', async: false },
  { invocationSource: 'model-tool' },
  'sync',
);
if (explicitSync !== 'sync') throw new Error(`bridge explicit sync mode should be honored, got ${explicitSync}`);

const userSync = resolveBridgeExecutionMode(
  { wait: true },
  { invocationSource: 'user-command' },
  'async',
);
if (userSync !== 'sync') throw new Error(`bridge user-command wait mode should be sync, got ${userSync}`);

for (const command of [
  'git status --short',
  'git diff -- src/mixdog-session-runtime.mjs',
  'Write-Output "git push"',
]) {
  const blocked = classifyBridgeWorkerGitMutationCommand(command);
  if (blocked) throw new Error(`bridge git guard should allow readonly/non-command form ${JSON.stringify(command)}; got ${blocked}`);
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
  if (blocked !== expected) throw new Error(`bridge git guard mismatch for ${JSON.stringify(command)}: got ${blocked}, expected ${expected}`);
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
if (fullDefaults.size !== 12) {
  throw new Error(`full default surface should stay 12 tools, got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'glob', 'list', 'apply_patch', 'explore', 'bridge', 'recall', 'search', 'web_fetch', 'tool_search']) {
  assertHas(fullDefaults, name);
}
for (const name of ['shell', 'edit', 'write']) {
  assertLacks(fullDefaults, name);
}

const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
if (leadDefaults.size !== 14) {
  throw new Error(`lead default surface should stay 14 tools, got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'glob', 'list', 'shell', 'task', 'apply_patch', 'explore', 'bridge', 'recall', 'search', 'web_fetch', 'tool_search']) {
  assertHas(leadDefaults, name);
}
for (const name of ['edit', 'write']) {
  assertLacks(leadDefaults, name);
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
if (surfaceSize > 14000) {
  throw new Error(`full default tool surface too large: ${surfaceSize} chars (cap 14000)`);
}
for (const [name, cap] of [
  ['apply_patch', 1300],
  ['code_graph', 1550],
  ['bridge', 2500],
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
if (readonlyDefaults.size !== 7) {
  throw new Error(`readonly default surface should stay 7 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
}
for (const name of ['read', 'code_graph', 'grep', 'glob', 'list', 'explore', 'tool_search']) {
  assertHas(readonlyDefaults, name);
}
for (const name of ['apply_patch', 'bridge', 'shell', 'edit', 'write']) {
  assertLacks(readonlyDefaults, name);
}

const bridgeProps = BRIDGE_TOOL.inputSchema?.properties || {};
if (!bridgeProps.mode || bridgeProps.wait) throw new Error('bridge schema should expose mode but not legacy wait');
if (!/Prefer async by default/i.test(BRIDGE_TOOL.description || '') || !/distinct tags/i.test(BRIDGE_TOOL.description || '') || !/completion notification/i.test(BRIDGE_TOOL.description || '') || !/do not interfere/i.test(BRIDGE_TOOL.description || '')) {
  throw new Error('bridge description must preserve async tagged delegation contract');
}
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
const bridgeMissingJob = await bridgeSmoke.execute({ type: 'read', task_id: 'job_missing_smoke' }, { invocationSource: 'model-tool', cwd: root });
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
const exploreProps = EXPLORE_TOOL.inputSchema?.properties || {};
if (!/Broad-scope locator only/i.test(EXPLORE_TOOL.description || '') || !/code_graph\/grep\/glob first/i.test(EXPLORE_TOOL.description || '')) {
  throw new Error('explore description must preserve broad-locator and direct-tool-first guidance');
}
if (!/Never pass a whole brief/i.test(exploreProps.query?.description || '') || !/relevant repo or subtree/i.test(exploreProps.cwd?.description || '')) {
  throw new Error('explore schema must preserve query narrowness and cwd narrowing guidance');
}
const normalizedExplore = normalizeExploreQueries('["where is model selection?","  ","which file owns bridge async?"]');
if (normalizedExplore.length !== 2 || normalizedExplore[0] !== 'where is model selection?') {
  throw new Error(`explore query normalization failed: ${JSON.stringify(normalizedExplore)}`);
}
if (MAX_FANOUT_QUERIES !== 8) throw new Error(`explore fanout cap changed: ${MAX_FANOUT_QUERIES}`);
const explorerPrompt = buildExplorerPrompt('where is <bridge> & status?');
if (!explorerPrompt.includes('&lt;bridge&gt;') || !explorerPrompt.includes('&amp;') || /verdicts, ratings, or recommendations/.test(explorerPrompt) === false) {
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
if (!/specific file window or symbol body/i.test(readDescription) || !/after narrowing/i.test(readDescription)) {
  throw new Error('read description must stay narrow-target oriented');
}
const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
if (!/Top-level entry for code-related questions/i.test(codeGraphDescription) || !/Use before read/i.test(codeGraphDescription)) {
  throw new Error('code_graph description must stay top-level for code questions');
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
if (!/Prefer mode=async/i.test(searchTool?.description || '') || !searchProps.query?.anyOf || !/array for fan-out/i.test(searchProps.query?.description || '')) {
  throw new Error('search schema must preserve async guidance and string/array query shape');
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
