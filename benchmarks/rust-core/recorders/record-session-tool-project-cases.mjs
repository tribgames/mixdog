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
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });

const excluded = {
  'model-tool calls to disabled features are refused before any dispatch': 'COVERED (gaps-tools.md row 84): tools/policy/surface.rs:382',
  'injected runtimes receive the caller context each tool expects': 'GONE (row 84): the ToolContext carries the caller',
  'session rename protects user titles, honors the setting, and is Lead-only': 'COVERED (row 84): core/run_host/tool_pool/tests.rs:536',
  'a manual rename landing while the AI title saves wins on the live session': 'COVERED (row 84): core/run_host/tool_pool/tests.rs:536',
  'session fork calls the lifecycle API and returns the new session id': 'COVERED (row 84): core/run_host/tool_pool/tests.rs:559',
  'session reports, lists, and switches the Project through the caller or the runtime: the caller-owned switch ({path} with setCallerCwd)':
    "Node's MCP caller may own the cwd switch (setCallerCwd); the core's session tool has one switch, the session port's",
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
    compared: "per call: the whole outcome, the tool's text or its error message; the Project directory as <dir>",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`session-tool-project-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
for (const c of cases) for (const call of c.recorded.calls) console.log(JSON.stringify(call));
console.log(JSON.stringify(cases[0].recorded.switches));
process.exit(0);
