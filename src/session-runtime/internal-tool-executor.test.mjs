import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createInternalToolExecutor } from './internal-tool-executor.mjs';

function harness(overrides = {}) {
  const calls = [];
  const record =
    (label) =>
    (...args) => {
      calls.push([label, ...args]);
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
    webSearchEnabled: () => false,
    memoryToolsEnabled: () => false,
    officeToolsEnabled: () => false,
    mediaToolEnabled: () => false,
    tidyToolEnabled: () => false,
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

test('model-tool calls to disabled features are refused before any dispatch', async () => {
  const { execute, calls } = harness();
  const source = { invocationSource: 'model-tool' };
  await assert.rejects(execute('web_search', { q: 'x' }, source), /web search is disabled/);
  await assert.rejects(execute('memory', {}, source), /memory tools are disabled/);
  await assert.rejects(execute('office', {}, source), /office is disabled/);
  await assert.rejects(execute('media', {}, source), /media is disabled/);
  await assert.rejects(execute('tidy', {}, source), /tidy is disabled/);
  const previous = process.env.MIXDOG_FEATURE_BROWSER;
  process.env.MIXDOG_FEATURE_BROWSER = '0';
  try {
    await assert.rejects(execute('browser', {}, source), /browser tool is disabled in this environment/);
    await assert.rejects(execute('browser_devtools', {}, source), /browser tool is disabled in this environment/);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_BROWSER;
    else process.env.MIXDOG_FEATURE_BROWSER = previous;
  }
  assert.deepEqual(calls, []);
});

test('injected runtimes receive the caller context each tool expects', async () => {
  const { execute, calls, rt } = harness({ memoryToolsEnabled: () => true });
  const signal = new AbortController().signal;
  const ctx = { callerCwd: 'D:/proj', callerSessionId: 'caller-9', signal, clientHostPid: 42 };

  assert.equal(await execute('setup', { action: 'status' }, ctx), 'setup:ok');
  assert.deepEqual(calls.at(-1), ['setup', { action: 'status' }, { signal }]);

  assert.equal(await execute('recall', { query: 'q' }, ctx), 'memory:ok');
  assert.equal(calls.at(-1)[0], 'memory');
  assert.equal(calls.at(-1)[1], 'recall');
  assert.equal(calls.at(-1)[2].query, 'q');
  assert.equal(calls.at(-1)[3], signal);

  assert.equal(await execute('code_graph', { mode: 'symbols' }, ctx), 'code_graph:ok');
  assert.deepEqual(calls.at(-1), ['code_graph', 'code_graph', { mode: 'symbols' }, 'D:/proj']);
  await execute('code_graph', { mode: 'symbols', cwd: 'E:/other' }, ctx);
  assert.equal(calls.at(-1)[3], 'E:/other');

  assert.equal(await execute('Skill', { name: 'pdf' }, ctx), 'Skill:ok');
  assert.deepEqual(calls.at(-1), ['Skill', 'pdf', { tools: [] }, 'lead']);

  assert.equal(await execute('goal', { action: 'status' }, ctx), 'goal:ok');
  assert.deepEqual(calls.at(-1), ['goal', 'goal', { action: 'status' }, { callerSessionId: 'caller-9' }]);
  await execute('goal', undefined, {});
  assert.deepEqual(calls.at(-1), ['goal', 'goal', {}, { callerSessionId: 'sess-1' }]);
  rt.session = null;
  await execute('goal', {}, {});
  assert.deepEqual(calls.at(-1)[3], { callerSessionId: 'reserved-1' });
  rt.session = { id: 'sess-1', controller: new AbortController() };

  assert.equal(await execute('agent', { action: 'spawn' }, ctx), 'agent:ok');
  const [, agentArgs, agentCtx] = calls.at(-1);
  assert.deepEqual(agentArgs, { action: 'spawn' });
  assert.equal(agentCtx.callerCwd, 'D:/proj');
  assert.equal(agentCtx.invocationSource, 'model-tool');
  assert.equal(agentCtx.callerSessionId, 'caller-9');
  assert.equal(agentCtx.clientHostPid, 42);
  assert.equal(agentCtx.signal, signal);
  assert.equal(agentCtx.notifyFn('hello'), 'notify:caller-9:ok');

  assert.equal(await execute('channel_send', { text: 'hi' }, ctx), 'channels:ok');
  assert.deepEqual(calls.at(-1), ['channels', 'channel_send', { text: 'hi' }]);

  await assert.rejects(execute('nope', {}, ctx), /unknown standalone internal tool: nope/);
});

test('session reports, lists, and switches the Project through the caller or the runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-internal-cwd-'));
  try {
    const switches = [];
    const { execute, calls } = harness({
      getWorkspaceApi: () => ({
        switchProject: async (...args) => {
          switches.push(args);
          return 'switchProject:ok';
        },
      }),
    });
    const status = JSON.parse(await execute('session', {}, { callerSessionId: 'sess-1' }));
    assert.equal(status.cwd, 'C:/work');
    assert.equal(status.sessionId, 'sess-1');
    const worker = { callerSessionId: 'worker-1' };
    for (const args of [{}, { action: 'list-projects' }, { action: 'set-project', path: dir }, { path: dir }]) {
      await assert.rejects(execute('session', args, worker), /belongs to the Lead session/);
    }
    assert.equal(calls.length, 0);
    const listed = JSON.parse(await execute('session', { action: 'list-projects' }, {}));
    assert.equal(listed.cwd, 'C:/work');
    assert.ok(Array.isArray(listed.projects));

    const viaCaller = JSON.parse(
      await execute('session', { path: dir }, { setCallerCwd: async (next) => `${next}::caller` })
    );
    assert.equal(viaCaller.cwd, `${resolve(dir)}::caller`);
    assert.equal(calls.length + switches.length, 0, 'the caller-owned switch bypasses the runtime authority');

    const viaRuntime = JSON.parse(await execute('session', { action: 'set-project', path: dir }, {}));
    assert.equal(viaRuntime.cwd, 'switchProject:ok');
    assert.deepEqual(switches, [[resolve(dir), { ownTurn: true }]]);

    await assert.rejects(execute('session', { action: 'set-project' }, {}), /path is required/);
    await assert.rejects(execute('session', { action: 'set-project', path: join(dir, 'missing') }, {}), /ENOENT/);
    await assert.rejects(execute('session', { action: 'dance' }, {}), /unknown action "dance"/);
    await assert.rejects(execute('cwd', {}, {}), /unknown standalone internal tool: cwd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session rename protects user titles, honors the setting, and is Lead-only', async () => {
  const seen = [];
  let outcome = { ok: true, title: 'Fix login' };
  const store = { id: 'sess-1', title: 'Fix login', titleLocked: true, titleSource: 'ai' };
  const getSessionManager = () => ({
    updateSessionAiTitle: async (id, title) => (seen.push([id, title]), outcome),
    getSession: () => store,
  });
  const { execute, rt } = harness({ getSessionManager });
  const renamed = JSON.parse(await execute('session', { action: 'rename', title: 'Fix login' }, {}));
  assert.deepEqual(renamed, { action: 'rename', sessionId: 'sess-1', title: 'Fix login' });
  assert.deepEqual(seen.at(-1), ['sess-1', 'Fix login']);
  assert.equal(rt.session.titleSource, 'ai');
  assert.equal(rt.session.title, 'Fix login');
  await assert.rejects(execute('session', { action: 'rename', title: 'x' }, { callerSessionId: 'w' }), /Lead session/);
  await assert.rejects(execute('session', { action: 'rename' }, {}), /title is required/);
  outcome = { ok: false, reason: 'user-title' };
  await assert.rejects(execute('session', { action: 'rename', title: 'x' }, {}), /user already titled/);
  rt.config.aiSessionTitles = false;
  const before = seen.length;
  await assert.rejects(
    execute('session', { action: 'rename', title: 'x' }, {}),
    /session: AI session titles are disabled in settings/
  );
  assert.equal(seen.length, before);
});

test('a manual rename landing while the AI title saves wins on the live session', async () => {
  const store = { id: 'sess-1', title: 'old', titleLocked: false };
  const getSessionManager = () => ({
    updateSessionAiTitle: async () => {
      Object.assign(store, { title: 'AI title', titleLocked: true, titleSource: 'ai' });
      await Promise.resolve();
      // the user's manual rename lands during the awaited save
      Object.assign(store, { title: 'Mine', titleLocked: true, titleSource: 'user' });
      return { ok: true, title: 'AI title' };
    },
    getSession: () => store,
  });
  const { execute, rt } = harness({ getSessionManager });
  await assert.rejects(execute('session', { action: 'rename', title: 'AI title' }, {}), /user already titled/);
  assert.equal(rt.session.title, 'Mine');
  assert.equal(rt.session.titleSource, 'user');
});

test('session compact schedules a one-shot pending compact; status reports the session', async () => {
  const { execute, rt } = harness();
  rt.session.title = 'T';
  rt.session.provider = 'openai';
  rt.session.model = 'gpt';
  const scheduled = JSON.parse(await execute('session', { action: 'compact' }, {}));
  assert.equal(scheduled.scheduled, true);
  assert.equal(rt.pendingCompactSessionIds.has('sess-1'), true);
  await assert.rejects(execute('session', { action: 'compact' }, { callerSessionId: 'w' }), /Lead session/);
  const status = JSON.parse(await execute('session', { action: 'status' }, {}));
  assert.equal(status.sessionId, 'sess-1');
  assert.equal(status.title, 'T');
  assert.equal(status.provider, 'openai');
  assert.equal(status.model, 'gpt');
  // A managed worktree reports its owning Project, not the worktree folder.
  rt.session.workspace = { projectPath: 'D:/proj', cwd: 'D:/worktrees/fix' };
  const inWorktree = JSON.parse(await execute('session', { action: 'status' }, {}));
  assert.equal(inWorktree.project, 'D:/proj');
});

test('session fork calls the lifecycle API and returns the new session id', async () => {
  const calls = [];
  const lifecycle = {
    inheritToNewSession: async (id, options) => (calls.push([id, options]), { sessionId: 'new-1', compacted: true }),
  };
  const { execute } = harness({ getLifecycleApi: () => lifecycle });
  const out = JSON.parse(await execute('session', { action: 'fork', compact: true }, {}));
  assert.equal(out.sessionId, 'new-1');
  assert.deepEqual(calls[0], ['sess-1', { compact: true, titleSuffix: ' (Fork)' }]);
  const { execute: bare } = harness();
  await assert.rejects(bare('session', { action: 'fork' }, {}), /unavailable/);
});

test('session merge-worktree / remove-worktree drive the Lead workspace authority within the calling turn', async () => {
  const calls = [];
  const workspace = {
    mergeWorkspace: async (input, options) => {
      calls.push(['merge', input, options]);
      return { merged: true };
    },
    removeWorktree: async (input, options) => {
      calls.push(['remove', input, options]);
      return { revision: 4 };
    },
  };
  const { execute } = harness({ getWorkspaceApi: () => workspace });
  const merged = JSON.parse(await execute('session', { action: 'merge-worktree' }, { callerSessionId: 'sess-1' }));
  assert.deepEqual(merged, { action: 'merge-worktree', cwd: 'C:/work', result: { merged: true } });
  assert.deepEqual(calls.at(-1), ['merge', { confirmed: true }, { ownTurn: true }]);
  await execute('session', { action: 'remove-worktree', force: true }, {});
  assert.deepEqual(calls.at(-1), ['remove', { force: true }, { ownTurn: true }]);
  // The manual list / prune: never a retained worktree (the authority decides).
  workspace.listWorktrees = async () => (calls.push(['list']), [{ id: 'fix', retained: true }]);
  workspace.pruneWorktrees = async () => (calls.push(['prune']), { removed: [] });
  const listed = JSON.parse(await execute('session', { action: 'list-worktrees' }, {}));
  assert.deepEqual(listed.result, [{ id: 'fix', retained: true }]);
  await execute('session', { action: 'prune-worktrees' }, {});
  assert.deepEqual(calls.slice(-2), [['list'], ['prune']]);
  await assert.rejects(
    execute('session', { action: 'remove-worktree' }, { callerSessionId: 'worker-2' }),
    /belongs to the Lead session/
  );
  const { execute: bare } = harness();
  await assert.rejects(bare('session', { action: 'merge-worktree' }, {}), /unavailable in this runtime/);
});
