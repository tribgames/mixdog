// Records Node's MCP surface fold (`runtime-core/tool-catalog.mjs`): `refreshInitialDeferredMcpSurface` (the first
// turn of a fresh session re-folds the live MCP registry into its initial surface and rebuilds the prompt's
// deferred-tool block) and `reconcileDeferredMcpToolCatalog` (the late pool, the connected names and the pending
// deferred-tools delta follow the registry). Each case holds the session `applyDeferredToolSurface` leaves, and per
// step the live MCP tools, the call, its result and the whole session after (clock fixed).
//
//   unit  — the two functions called directly.
//   turn  — a turn start as `turn-prepare.mjs foldMcpSurface` runs it (the one-shot flag cleared, the initial fold,
//           or the late reconcile). The first turn returns after the initial fold (`turn-prepare.mjs:53-57`); its
//           reconcile is the request boundary's `refreshDeferredMcpToolCatalog` (`session/loop/request-boundary.mjs`),
//           recorded as a `boundary` step that follows the first `turn` step over the same registry.
//   migrate — `migrateToolExposureAtBoundary` over a session whose persisted exposure differs from its provider's,
//           with the request boundary's `delete pendingCacheBreakIntent` after a migration; `transcript` is the
//           conversation the request is built from (its unanswered tool calls make the boundary unsafe).
//
//   node benchmarks/rust-core/recorders/record-mcp-fold.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/mcp-fold/golden.json.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'mcp-fold-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'mcp-fold');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-mcp-fold.mjs';
const U = (rel) => importFrom(tree, `src/${rel}`);
const { applyDeferredToolSurface, reconcileDeferredMcpToolCatalog, refreshDeferredMcpToolCatalog, refreshInitialDeferredMcpSurface } = await U(
  'runtime/agent/orchestrator/runtime-core/tool-catalog.mjs'
);

const { migrateToolExposureAtBoundary } = await U('runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
// The runtime's own tools are the product's definitions; a connected server's tools (`mcp__`) are the recorder's inputs.
const real = await nodeRealTool(tree);
const doc = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, ...extra });
const mcp =(server, tool, description) =>
  doc(`mcp__${server}__${tool}`, { description, mcpServerName: server, mcpToolName: tool });
const alphaList = mcp('alpha', 'list', 'List the things. Pages of twenty.');
const alphaGet = mcp('alpha', 'get', 'Get one thing by id.');
const betaPing = mcp('beta', 'ping', `Ping the beta service ${'and report how long it took '.repeat(4)}in milliseconds.`);
const EAGER = [real('read'), real('shell'), real('Skill'), real('web_search'), real('todo')];
const DEFERRED = [real('office'), real('memory'), real('github')];

// A session as `createSession` + `seedToolSurface` leave it: the four system blocks, the surface built by
// `applyDeferredToolSurface` (which renders the deferred-tool block into the second one) and the first-turn flag.
const session = (provider, extra = DEFERRED, after = () => {}) => {
  const current = {
    id: 'sess_fold',
    provider,
    model: 'model-x',
    cwd: '/work',
    tools: [...EAGER],
    messages: [
      { role: 'system', content: '# Base rules' },
      { role: 'system', content: '# Profile' },
      { role: 'system', cacheTier: 'tier3', content: '# Core' },
      { role: 'system', cacheTier: 'env', content: '# Env' },
    ],
    toolSpec: 'full',
    disallowedTools: ['get_goal'],
    callerDisallowedTools: ['get_goal'],
  };
  applyDeferredToolSurface(current, 'lead', extra, { provider });
  current.deferredInitialRefreshPending = true;
  after(current);
  return json(current);
};
const resumed = (current) => {
  delete current.deferredInitialRefreshPending;
};
const asBridgeless = (current) => {
  delete current.toolExposureMode;
};

// The live tools are the registry's own objects, passed by identity as the real callers pass them (the reconcile's
// state cache compares them so).
// `foldMcpSurface` (turn-prepare.mjs): the initial fold on the first turn, the late reconcile after it.
const turn = (current, live) => {
  if (current.deferredInitialRefreshPending) {
    current.deferredInitialRefreshPending = false;
    refreshInitialDeferredMcpSurface(current, live);
    return null;
  }
  reconcileDeferredMcpToolCatalog(current, live);
  return null;
};
// The request boundary's `refreshDeferredMcpToolCatalog(session)` over a registry holding `live` (a session with no
// deferred provider mode has no MCP catalog to refresh).
const boundary = (current, live) => {
  if (current.deferredProviderMode) reconcileDeferredMcpToolCatalog(current, live);
  return null;
};
const CALLS = {
  boundary,
  initial: (current, live) => refreshInitialDeferredMcpSurface(current, live),
  reconcile: (current, live) => reconcileDeferredMcpToolCatalog(current, live),
  turn,
  // refreshDeferredMcpToolCatalog(session) of the request boundary, a tool call and load_tool; it reads the registry,
  // which this recorder leaves empty.
  refresh: (current) => refreshDeferredMcpToolCatalog(current),
  // `prepareProviderRequest`: the migration, then the cache-break tag it carries on the request instead of the session.
  migrate: (current, _live, transcript = []) => {
    const migrated = migrateToolExposureAtBoundary(current, [...current.messages, ...transcript]);
    if (migrated) delete current.pendingCacheBreakIntent;
    return migrated;
  },
};

const measured = (current) => {
  current.providerState = { id: 'resp_1' };
  current._providerPrefixGuardState = { hash: 'h' };
  current.pendingCacheBreakIntent = 'manual_compaction';
};
const ask = { role: 'user', content: 'list things' };
const asked = { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }] };
const answered = { role: 'tool', toolCallId: 'call_1', content: 'ok' };

// [suite, name, session, [[call, live, set?]...]]: set is assigned onto the session before the call, as another
// writer (an acknowledged delta, a gate) would between two calls.
const CASES = [
  ['unit', 'native: nothing connected changes nothing', session('anthropic-oauth'), [['initial', []]]],
  ['unit', 'native: a server connected before the first send joins the boot catalog and the prompt', session('anthropic-oauth'), [['initial', [alphaList, alphaGet]], ['initial', [alphaList, alphaGet]]]],
  ['unit', 'native: a server gone since creation leaves the initial surface', session('anthropic-oauth', [...DEFERRED, alphaList, alphaGet]), [['initial', []]]],
  ['unit', 'native: one tool of a server gone, one added', session('anthropic-oauth', [...DEFERRED, alphaList]), [['initial', [alphaGet]]]],
  ['unit', 'native: a denied MCP tool is not folded', session('anthropic-oauth', DEFERRED, (current) => { current.disallowedTools = ['get_goal', 'mcp__alpha__get']; }), [['initial', [alphaList, alphaGet]]]],
  ['unit', 'bridge: the roster and bridge guidance are rebuilt', session('openrouter'), [['initial', [alphaList, betaPing]]]],
  ['unit', 'a fixed surface updates its catalog alone', session('openrouter', DEFERRED, asBridgeless), [['initial', [alphaList]], ['reconcile', [alphaList]]]],
  ['unit', 'a session without messages is not folded', (() => { const current = session('anthropic-oauth'); delete current.messages; return current; })(), [['initial', [alphaList]]]],
  ['unit', 'native: first reconcile announces nothing the manifest listed, then a new server and its removal', session('anthropic-oauth', [...DEFERRED, alphaList]), [['reconcile', [alphaList]], ['reconcile', [alphaList, betaPing]], ['reconcile', [betaPing]], ['reconcile', []]]],
  ['unit', 'native: a server connecting after create is announced by a first reconcile', session('anthropic-oauth'), [['reconcile', [alphaList, alphaGet]], ['reconcile', [alphaList]]]],
  ['unit', 'native: a loaded tool survives its disconnect in the late pool', session('anthropic-oauth', [...DEFERRED, alphaList], (current) => { current.deferredDiscoveredTools = ['mcp__alpha__list']; }), [['reconcile', [alphaList, alphaGet]], ['reconcile', []]]],
  ['unit', 'bridge: removal and a new server', session('openrouter', [...DEFERRED, alphaList]), [['reconcile', [alphaList, betaPing]], ['reconcile', [betaPing]]]],
  ['unit', 'native: a reconnect with a fresher schema re-links the active tool', (() => { const current = session('anthropic-oauth', DEFERRED); current.tools.push(alphaList); current.deferredCallableTools.push('mcp__alpha__list'); return current; })(), [['reconcile', [{ ...alphaList, description: 'Fresher.' }]], ['reconcile', [{ ...alphaList, description: 'Fresher.' }]]]],
  ['unit', 'native: a pending delta merges with the next change', session('anthropic-oauth'), [['reconcile', [alphaList]], ['reconcile', [alphaList, betaPing]], ['reconcile', [betaPing]]]],
  ['unit', 'a session without tools is left alone', { id: 'sess_none', disallowedTools: [] }, [['reconcile', [alphaList]]]],
  ['turn', 'first turn: nothing connected', session('anthropic-oauth'), [['turn', []]]],
  ['turn', 'first turn on a bridge provider: nothing connected', session('openrouter'), [['turn', []]]],
  ['turn', 'first turn: a server connected since creation', session('anthropic-oauth'), [['turn', [alphaList, alphaGet]], ['turn', [alphaList, alphaGet]], ['turn', [alphaList, betaPing]]]],
  ['turn', 'first turn: a server gone since creation', session('openrouter', [...DEFERRED, alphaList]), [['turn', []], ['turn', [betaPing]]]],
  ['turn', 'a resumed session takes the late path only', session('anthropic-oauth', DEFERRED, resumed), [['turn', [alphaList]], ['turn', [alphaList]], ['turn', []]]],
  ['turn', 'first turn on a fixed surface', session('openrouter', DEFERRED, asBridgeless), [['turn', [alphaList]], ['turn', []]]],
  ['turn', 'cache: an unchanged registry skips the reconcile, a changed one runs it', session('anthropic-oauth'), [['turn', [alphaList]], ['turn', [alphaList]], ['turn', [alphaList], { deferredMcpToolNames: ['stale'] }], ['turn', [alphaList, betaPing]]]],
  ['turn', 'cache: an input the key reads runs the reconcile again', session('anthropic-oauth', [...DEFERRED, alphaList]), [['turn', [alphaList]], ['turn', [alphaList], { deferredMcpToolNames: ['stale'] }], ['turn', [alphaList], { disallowedTools: ['get_goal', 'office'] }], ['turn', [alphaList], { deferredMcpToolNames: ['stale'], callerDisallowedTools: [] }]]],
  ['turn', 'refresh: a session with a deferred mode follows the registry', session('anthropic-oauth', [...DEFERRED, alphaList], resumed), [['refresh', []], ['refresh', []]]],
  ['migrate', 'a native session whose provider became a bridge one migrates once', session('anthropic-oauth', DEFERRED, measured), [['migrate', [], { provider: 'openrouter' }, [ask]], ['migrate', [], null, [ask]]]],
  ['migrate', 'a bridge session whose provider became a native one migrates', session('openrouter', DEFERRED, measured), [['migrate', [], { provider: 'anthropic-oauth' }, [ask]]]],
  ['migrate', 'a fixed surface persisted before exposure versions migrates to the bridge', session('openrouter', DEFERRED, (current) => { measured(current); asBridgeless(current); }), [['migrate', [], null, [ask]]]],
  ['migrate', 'an unanswered tool call is not a safe boundary, an answered one is', session('anthropic-oauth', DEFERRED, measured), [['migrate', [], { provider: 'openrouter' }, [ask, asked]], ['migrate', [], null, [ask, asked, answered]]]],
  ['migrate', 'a session already on its provider is left as it is', session('anthropic-oauth', DEFERRED, measured), [['migrate', [], null, [ask]]]],
  ['migrate', 'a session with no exposure yet is left as it is', session('anthropic-oauth', DEFERRED, (current) => { measured(current); delete current.deferredProviderMode; delete current.toolExposureMode; }), [['migrate', [], { provider: 'openrouter' }, [ask]]]],
  ['turn', 'refresh: a session with no deferred mode is left alone', session('anthropic-oauth', [...DEFERRED, alphaList], (current) => { resumed(current); delete current.deferredProviderMode; }), [['refresh', []]]],
].map(([suite, name, before, plan]) => {
  const current = json(before);
  // A first turn is followed by its request boundary over the same registry.
  const steps = before.deferredInitialRefreshPending && plan[0][0] === 'turn' ? [plan[0], ['boundary', plan[0][1]], ...plan.slice(1)] : plan;
  return {
    suite,
    name,
    before,
    steps: steps.map(([call, live, set, transcript]) => {
      if (set) Object.assign(current, json(set));
      const result = CALLS[call](current, live, transcript);
      return { call, live, set: set ?? null, transcript: transcript ?? null, result: result ?? null, after: json(current) };
    }),
  };
});

await writeJsonCompact(tree, join(stage, 'golden.json'), { now: NOW, cases: CASES });
writeSetManifest(stage, { set: 'mcp-fold', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`mcp fold: ${CASES.length} cases`);
