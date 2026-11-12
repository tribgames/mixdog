#!/usr/bin/env node
// Records Node's `session` tool for the k1 UNTESTED cases of src/session-runtime/internal-tool-executor.test.mjs
// (gaps-tools.md row 84: :130 project, :251 worktree): the test's own harness through Node's real
// `createInternalToolExecutor`, each call's whole outcome (the returned text, or the thrown message).
// The Project directory is this run's temp dir, written as <dir>.
//
//   node benchmarks/rust-core/recorders/record-session-tool-project-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/session-tool-project-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-session-tool-project-cases.mjs';
const TEST = 'src/session-runtime/internal-tool-executor.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
// An empty home: the Project registry (<MIXDOG_HOME>/projects.json) lists nothing, and no user data is read.
const home = mkdtempSync(join(tmpdir(), 'mixdog-internal-home-'));
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = join(home, 'data');
const { createInternalToolExecutor } = await importFrom(tree, 'src/session-runtime/internal-tool-executor.mjs');

// The test's harness (internal-tool-executor.test.mjs `harness`).
function harness(overrides = {}) {
  const calls = [];
  const record =
    (label) =>
    (...a) => {
      calls.push([label, ...a]);
      return `${label}:ok`;
    };
  const rt = {
    session: { id: 'sess-1', controller: new AbortController(), usageMetricsTurnId: 'turn-1' },
    mode: 'lead',
    currentCwd: 'C:/work',
    config: {},
    reservedSessionId: 'reserved-1',
  };
  const execute = createInternalToolExecutor({
    rt,
    channels: { isChannelTool: (name) => name.startsWith('channel_'), execute: record('channels') },
    goalRuntime: { executeTool: record('goal') },
    agentTool: { execute: record('agent') },
    setupTool: { execute: record('setup') },
    featureDisallowedTools: () => ['web_search', 'web_fetch', 'memory', 'recall', 'office', 'media', 'tidy'],
    getWebSearchModule: async () => null,
    getMemoryModule: async () => ({ handleToolCall: record('memory') }),
    getCodeGraphModule: async () => ({ executeCodeGraphTool: record('code_graph') }),
    notifyFnForSession: (sessionId) => record(`notify:${sessionId}`),
    runNativeWebSearch: record('native-web-search'),
    activeToolSurface: () => ({ tools: [] }),
    mcpStatus: () => ({ servers: [] }),
    skillToolContent: record('Skill'),
    ...overrides,
  });
  return { execute, calls, rt };
}

const dir = mkdtempSync(join(tmpdir(), 'mixdog-internal-cwd-'));
const shown = (text) => text.split(dir).join('<dir>').split(dir.replaceAll('\\', '\\\\')).join('<dir>');
const run = async (execute, tool, a, context, label) => {
  try {
    return { label, tool, args: a, context, outcome: { ok: shown(String(await execute(tool, a, context))) } };
  } catch (error) {
    return { label, tool, args: a, context, outcome: { error: shown(error instanceof Error ? error.message : String(error)) } };
  }
};
const shownArgs = (a) => JSON.parse(shown(JSON.stringify(a)));

const cases = [];
{
  const switches = [];
  const { execute } = harness({
    getWorkspaceApi: () => ({
      switchProject: async (...a) => {
        switches.push(a);
        return 'switchProject:ok';
      },
    }),
  });
  const calls = [];
  const lead = { callerSessionId: 'sess-1' };
  const worker = { callerSessionId: 'worker-1' };
  calls.push(await run(execute, 'session', {}, lead, 'status'));
  for (const a of [{}, { action: 'list-projects' }, { action: 'set-project', path: dir }, { path: dir }]) {
    calls.push(await run(execute, 'session', a, worker, 'worker'));
  }
  calls.push(await run(execute, 'session', { action: 'list-projects' }, {}, 'list-projects'));
  calls.push(await run(execute, 'session', { action: 'set-project', path: dir }, {}, 'set-project'));
  // :153, the test's caller-owned switch: the calling session's own `setCallerCwd` answers, never the workspace API
  // (every model call carries one, dispatch.mjs:98); the golden names the double's answer as a suffix.
  {
    const before = switches.length;
    const outcome = await run(execute, 'session', { path: dir }, { setCallerCwd: async (next) => `${next}::caller` }, 'the caller-owned switch');
    calls.push({ ...outcome, context: { setCallerCwd: '<path>::caller' } });
    if (switches.length !== before) throw new Error('the workspace API switched although the caller owned the switch');
  }
  calls.push(await run(execute, 'session', { action: 'set-project' }, {}, 'set-project without a path'));
  calls.push(await run(execute, 'session', { action: 'set-project', path: join(dir, 'missing') }, {}, 'set-project to a missing directory'));
  calls.push(await run(execute, 'session', { action: 'dance' }, {}, 'unknown action'));
  calls.push(await run(execute, 'cwd', {}, {}, 'the retired cwd tool'));
  cases.push({
    case: 'session reports, lists, and switches the Project through the caller or the runtime',
    recorded: { calls: calls.map((c) => ({ ...c, args: shownArgs(c.args) })), switches: JSON.parse(shown(JSON.stringify(switches))) },
  });
}
{
  const touched = [];
  const workspace = {
    mergeWorkspace: async () => touched.push('merge'),
    removeWorktree: async () => touched.push('remove'),
    listWorktrees: async () => touched.push('list'),
    pruneWorktrees: async () => touched.push('prune'),
  };
  const { execute } = harness({ getWorkspaceApi: () => workspace });
  const calls = [];
  for (const action of ['merge-worktree', 'remove-worktree', 'list-worktrees', 'prune-worktrees']) {
    calls.push(await run(execute, 'session', { action }, { callerSessionId: 'sess-1' }, action));
  }
  cases.push({ case: 'worktree operations on existing sessions belong to the git tool, not the session tool', recorded: { calls, touched } });
}
{
  // :218, the test's steps: the runtime's session carries its title and route, then a worktree workspace.
  const { execute, rt } = harness();
  rt.session.title = 'T';
  rt.session.provider = 'openai';
  rt.session.model = 'gpt';
  const calls = [];
  calls.push(await run(execute, 'session', { action: 'compact' }, {}, 'compact'));
  const pending = [...(rt.pendingCompactSessionIds ?? [])];
  calls.push(await run(execute, 'session', { action: 'compact' }, { callerSessionId: 'w' }, 'worker compact'));
  calls.push(await run(execute, 'session', { action: 'status' }, {}, 'status'));
  rt.session.workspace = { projectPath: 'D:/proj', cwd: 'D:/worktrees/fix' };
  calls.push(await run(execute, 'session', { action: 'status' }, {}, 'status in a worktree'));
  cases.push({
    case: 'session compact schedules a one-shot pending compact; status reports the session',
    recorded: { session: { title: 'T', provider: 'openai', model: 'gpt' }, workspace: rt.session.workspace, calls, pending },
  });
}
const liveTitle = (rt) => ({ title: rt.session.title ?? null, titleSource: rt.session.titleSource ?? null });
{
  // :173, the test's steps: the store holds the AI title; then it answers user-title; then the setting is off.
  let outcome = { ok: true, title: 'Fix login' };
  const store = { id: 'sess-1', title: 'Fix login', titleLocked: true, titleSource: 'ai' };
  const getSessionManager = () => ({ updateSessionAiTitle: async () => outcome, getSession: () => store });
  const { execute, rt } = harness({ getSessionManager });
  const calls = [];
  calls.push(await run(execute, 'session', { action: 'rename', title: 'Fix login' }, {}, 'rename'));
  const live = liveTitle(rt);
  calls.push(await run(execute, 'session', { action: 'rename', title: 'x' }, { callerSessionId: 'w' }, 'worker rename'));
  calls.push(await run(execute, 'session', { action: 'rename' }, {}, 'rename without a title'));
  outcome = { ok: false, reason: 'user-title' };
  calls.push(await run(execute, 'session', { action: 'rename', title: 'x' }, {}, 'rename over a user title'));
  rt.config.aiSessionTitles = false;
  calls.push(await run(execute, 'session', { action: 'rename', title: 'x' }, {}, 'rename with AI titles off'));
  cases.push({ case: 'session rename protects user titles, honors the setting, and is Lead-only', recorded: { store: { ...store }, calls, live } });
}
{
  // :200: the user's manual rename lands while the AI title save is awaited.
  const store = { id: 'sess-1', title: 'old', titleLocked: false };
  const getSessionManager = () => ({
    updateSessionAiTitle: async () => {
      Object.assign(store, { title: 'AI title', titleLocked: true, titleSource: 'ai' });
      await Promise.resolve();
      Object.assign(store, { title: 'Mine', titleLocked: true, titleSource: 'user' });
      return { ok: true, title: 'AI title' };
    },
    getSession: () => store,
  });
  const { execute, rt } = harness({ getSessionManager });
  const calls = [await run(execute, 'session', { action: 'rename', title: 'AI title' }, {}, 'rename')];
  cases.push({
    case: 'a manual rename landing while the AI title saves wins on the live session',
    recorded: { store: { id: 'sess-1', title: 'old', titleLocked: false }, calls, live: liveTitle(rt) },
  });
}
{
  // :238: the lifecycle API forks with compaction.
  const forks = [];
  const lifecycle = { inheritToNewSession: async (id, options) => (forks.push([id, options]), { sessionId: 'new-1', compacted: true }) };
  const { execute } = harness({ getLifecycleApi: () => lifecycle });
  const calls = [await run(execute, 'session', { action: 'fork', compact: true }, {}, 'fork')];
  cases.push({ case: 'session fork calls the lifecycle API and returns the new session id', recorded: { calls, forks } });
}
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });

const excluded = {
  'model-tool calls to disabled features are refused before any dispatch':
    "the executor's own gate (internal-tool-executor.mjs:76-80) never answers a model: its list is boot.featureDisallowedTools, " +
    'the same function boot/tools.mjs:341 registers as the scope\'s live gate, which dispatch.mjs:125-128 checks first and ' +
    "answers with its own text; the browser gate (bridge-tools.mjs:15-23) reads MIXDOG_FEATURE_BROWSER, the same process env " +
    'the surface was built from (builtin-features.mjs:177), which nothing outside the process changes',
  'injected runtimes receive the caller context each tool expects':
    "the executor's argument plumbing into the test's injected recorders (internal-tool-executor.mjs, workspace-tools.mjs:352-364): " +
    "what a client sees is each tool's own answer in the caller's cwd and session, replayed in that tool's set (code_graph, goal, " +
    'agent, setup, memory, Skill); the unknown-tool throw is unreachable for a model, the surface refuses an unknown tool first',
  'session fork calls the lifecycle API and returns the new session id: fork without a lifecycle API':
    "the test's bare harness injects no getLifecycleApi (workspace-tools.mjs:145); every product runtime injects it (lifecycle-api.mjs:47)",
  'session reports, lists, and switches the Project through the caller or the runtime: the retired cwd tool':
    "Node's internal executor's own refusal of a tool it does not route; the core has no internal executor, and a model " +
    'never reaches either: the session surface refuses an unknown tool first',
};

const finalDir = join(FIXTURES_ROOT, 'session-tool-project-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's session tool at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'session-tool-project-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "per call: the whole outcome, the tool's text or its error message; the Project directory as <dir>; " +
      "the fork case: the session id the test's lifecycle double minted (new-1) stands for the id the core's directory minted, " +
      'and `forks` is [source, compacted] of the copy the core really made and compacted',
    excluded,
    injected:
      "the fork case's heir budget: the recording's lifecycle double (inheritToNewSession) names no route and no context window, so Node's " +
      'recording holds none; the replay gives the forked session the route openai-oauth/gpt-6-astra with contextWindow, rawContextWindow ' +
      '400000, effectiveContextWindowPercent 100, autoCompactTokenLimit and compactBoundaryTokens 300000 (room to spare, so the copy is ' +
      "kept whole), which the product's heir policy reads from the session header (native/core/crates/mixdog-core/src/run_host/" +
      'inheritance_fit.rs:114 `settings.session(header)`; the same seven fields of a route without a session: inheritance_fit.rs:96-104 ' +
      '`route_header`)',
  },
});
commitStage(stage, finalDir);
console.log(`session-tool-project-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
for (const c of cases) for (const call of c.recorded.calls) console.log(JSON.stringify(call));
for (const c of cases.slice(3)) console.log(JSON.stringify({ live: c.recorded.live, forks: c.recorded.forks }));
process.exit(0);
