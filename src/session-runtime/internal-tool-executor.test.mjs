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
    channelsEnabled: () => true,
    getWebSearchModule: async () => null,
    getMemoryModule: async () => ({ handleToolCall: record('memory') }),
    getCodeGraphModule: async () => ({ executeCodeGraphTool: record('code_graph') }),
    notifyFnForSession: (sessionId) => record(`notify:${sessionId}`),
    runNativeWebSearch: record('native-web-search'),
    activeToolSurface: () => ({ tools: [] }),
    mcpStatus: () => ({ servers: [] }),
    applyResolvedCwd: record('applyResolvedCwd'),
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
  const off = harness({ channelsEnabled: () => false });
  await assert.rejects(off.execute('channel_send', {}, source), /channels are disabled/);
  assert.deepEqual(off.calls, []);
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

test('cwd reports, lists, and switches the working directory through the caller or the runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-internal-cwd-'));
  try {
    const { execute, calls } = harness();
    assert.deepEqual(JSON.parse(await execute('cwd', {}, { callerSessionId: 'c1' })), {
      cwd: 'C:/work',
      sessionId: 'c1',
    });
    const listed = JSON.parse(await execute('cwd', { action: 'list' }, {}));
    assert.equal(listed.cwd, 'C:/work');
    assert.ok(Array.isArray(listed.projects));

    const viaCaller = JSON.parse(
      await execute('cwd', { path: dir }, { setCallerCwd: async (next) => `${next}::caller` })
    );
    assert.equal(viaCaller.cwd, `${resolve(dir)}::caller`);
    assert.equal(calls.length, 0, 'the caller-owned switch bypasses applyResolvedCwd');

    const viaRuntime = JSON.parse(await execute('cwd', { action: 'set', path: dir }, {}));
    assert.equal(viaRuntime.cwd, 'applyResolvedCwd:ok');
    assert.deepEqual(calls.at(-1), ['applyResolvedCwd', resolve(dir), { persistProjectSelection: true }]);

    await assert.rejects(execute('cwd', { action: 'set' }, {}), /path is required/);
    await assert.rejects(execute('cwd', { action: 'set', path: join(dir, 'missing') }, {}), /ENOENT/);
    await assert.rejects(execute('cwd', { action: 'dance' }, {}), /unknown action "dance"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
