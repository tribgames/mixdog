// Direct vs bridged parity: a call_tool request (wire id X) for a deferred
// target T must be judged, ordered, cached, hooked and audited exactly like a
// direct call of T, answer wire id X, and keep the wire call in the transcript.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'mixdog-tool-bridge-parity-'));
const environment = {
  MIXDOG_DATA_DIR: join(root, 'data'),
  MIXDOG_HOME: join(root, 'home'),
  MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups'),
};
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
});

const { processToolBatch } = await import('./tool-batch.mjs');
const { createEagerDispatcher } = await import('./eager-dispatch.mjs');
const { executeTool } = await import('./loop/tool-exec.mjs');
const { buildToolCallAssistantMessage } = await import('./loop/assistant-commit.mjs');
const { setInternalToolsProvider } = await import('../internal-tools.mjs');
const { _registerMcpServerForTest, disconnectAll } = await import('../mcp/client.mjs');

const READ_T = 'bridge_fixture_read';
const WRITE_T = 'bridge_fixture_write';
const KINDS = ['direct', 'bridged'];

const def = (name, readOnly = false) => ({
  name,
  description: `${name} fixture.`,
  inputSchema: { type: 'object', properties: { value: { type: 'string' }, command: { type: 'string' } } },
  annotations: { readOnlyHint: readOnly },
});

const CATALOG = [
  def('read', true),
  def(READ_T, true),
  def(WRITE_T),
  def('session'),
  def('apply_patch'),
  def('shell'),
  def('computer'),
];

/** `direct`: the target is eager. `bridged`: only `read`-free eager surface; targets are deferred. */
function makeSession(kind, { target, scopeId, eager, catalog = CATALOG, ...extra } = {}) {
  const eagerNames = eager || (kind === 'direct' ? [target] : []);
  return {
    id: `${kind}-${randomUUID()}`,
    mcpScopeId: scopeId || null,
    cwd: root,
    provider: 'openrouter',
    deferredProviderMode: 'canonical',
    toolExposureMode: 'bridge-v1',
    toolSpec: 'full',
    tools: catalog.filter((tool) => eagerNames.includes(tool.name)),
    deferredToolCatalog: catalog.slice(),
    ...extra,
  };
}

const wire = (kind, id, name, args) =>
  kind === 'bridged' ? { id, name: 'call_tool', arguments: { name, arguments: args } } : { id, name, arguments: args };

/** Internal fixture tools dispatched through the real executeTool pipeline. */
function fixtureTools(t, behavior = (name, args) => `ran:${name}:${JSON.stringify(args)}`) {
  const scopeId = `bridge-parity-${randomUUID()}`;
  const executions = [];
  const dispose = setInternalToolsProvider({
    scopeId,
    tools: [def(READ_T, true), def(WRITE_T), def('local_fetch', true)],
    executor: async (name, args) => {
      executions.push({ name, args });
      return behavior(name, args);
    },
  });
  t.after(dispose);
  return { scopeId, executions };
}

/** Records every hook invocation on the session. */
function recordHooks(session, before = () => null) {
  const hooks = { before: [], after: [], failure: [], approval: [] };
  session.beforeToolHook = async (payload) => {
    hooks.before.push({ name: payload.name, args: payload.args, toolCallId: payload.toolCallId });
    return before(payload);
  };
  session.afterToolHook = async (payload) => {
    hooks.after.push({ name: payload.name, args: payload.args, toolCallId: payload.toolCallId });
    return null;
  };
  session.afterToolFailureHook = async (payload) => {
    hooks.failure.push({ name: payload.name, args: payload.args, toolCallId: payload.toolCallId });
  };
  return hooks;
}

async function runBatch({
  session,
  calls,
  executeToolFn = executeTool,
  opts = {},
  signal = null,
  iterations = 1,
  stream = true,
}) {
  const results = [];
  const crossTurnCalls = session._crossTurnCalls || (session._crossTurnCalls = new Map());
  const assistantTurnMsg = buildToolCallAssistantMessage({ content: '' }, { calls, opts: {} });
  const dispatcher = createEagerDispatcher({
    tools: session.tools,
    cwd: root,
    sessionId: session.id,
    sessionRef: session,
    signal,
    opts,
    crossTurnCalls,
    getIterations: () => iterations,
    getNextIteration: () => iterations,
    repeatFailLimit: 3,
    executeToolFn,
  });
  // A streaming provider hands each call to eager admission before the batch
  // runs; otherwise the batch starts them itself (startEagerRun).
  if (stream) for (const call of calls) dispatcher.onToolCall(call);
  await processToolBatch({
    calls,
    messages: [],
    tools: session.tools,
    cwd: root,
    sessionId: session.id,
    sessionRef: session,
    signal,
    opts,
    iterations,
    assistantTurnMsg,
    pending: dispatcher.pending,
    epoch: dispatcher.epoch,
    startEagerRun: dispatcher.startEagerRun,
    crossTurnCalls,
    crossTurnCap: 100,
    sessionAgent: null,
    pushToolResultMessage: (message) => results.push(message),
    throwIfAborted: () => {
      if (signal?.aborted) throw signal.reason;
    },
    repeatFailLimit: 3,
    dedupStubTotal: 0,
    editCount: 0,
    executeToolFn,
  });
  return { results, assistantTurnMsg };
}

const summary = (results) =>
  results.map((message) => ({ toolCallId: message.toolCallId, content: message.content, toolKind: message.toolKind }));

/** Runs `scenario(kind)` for both kinds and asserts identical observable outcomes. */
async function parity(scenario) {
  const outcomes = {};
  for (const kind of KINDS) outcomes[kind] = await scenario(kind);
  assert.deepEqual(outcomes.bridged, outcomes.direct);
  return outcomes.direct;
}

for (const stream of [true, false]) {
test(`an allowed bridged call runs its target once with the same hooks, audit and wire id (stream=${stream})`, async (t) => {
  const audit = [];
  const outcome = await parity(async (kind) => {
    const fixture = fixtureTools(t);
    const session = makeSession(kind, { target: READ_T, scopeId: fixture.scopeId });
    const hooks = recordHooks(session);
    const calls = [wire(kind, 'X', READ_T, { value: 'a' })];
    const { results, assistantTurnMsg } = await runBatch({
      session,
      calls,
      stream,
      executeToolFn: (name, args, cwd, sessionId, sessionRef, opts) => {
        audit.push({ kind, name, toolCallId: opts.toolCallId, bridgeWireCall: opts.bridgeWireCall || null });
        return executeTool(name, args, cwd, sessionId, sessionRef, opts);
      },
    });
    // The transcript keeps the wire call exactly as the provider sent it.
    assert.deepEqual(assistantTurnMsg.toolCalls, calls);
    return { results: summary(results), executions: fixture.executions, hooks };
  });
  assert.deepEqual(outcome.results, [
    { toolCallId: 'X', content: `ran:${READ_T}:{"value":"a"}`, toolKind: 'normal' },
  ]);
  assert.deepEqual(outcome.executions, [{ name: READ_T, args: { value: 'a' } }]);
  assert.deepEqual(outcome.hooks.before, [{ name: READ_T, args: { value: 'a' }, toolCallId: 'X' }]);
  assert.deepEqual(outcome.hooks.after, [{ name: READ_T, args: { value: 'a' }, toolCallId: 'X' }]);
  assert.deepEqual(
    audit.map(({ kind, name, toolCallId }) => [kind, name, toolCallId]),
    [
      ['direct', READ_T, 'X'],
      ['bridged', READ_T, 'X'],
    ]
  );
  assert.equal(audit[0].bridgeWireCall, null);
  assert.deepEqual(audit[1].bridgeWireCall, wire('bridged', 'X', READ_T, { value: 'a' }));
});
}

test('allow/deny, worker scoping and read-only sessions refuse a bridged target like a direct one', async (t) => {
  const cases = [
    { label: 'schema allowlist', target: READ_T, extra: { schemaAllowedTools: ['read'] }, expect: /schema allowlist/ },
    { label: 'disallowed by hook', target: READ_T, before: () => ({ action: 'deny', reason: 'fixture' }), expect: /denied by hook: fixture/ },
    { label: 'worker scope', target: 'session', extra: { scope: 'agent:worker' }, expect: /Lead-only/ },
    {
      // Review regression: the unresolved-mode denial holds in bridge mode too.
      label: 'unresolved tool mode',
      target: WRITE_T,
      eager: [],
      extra: { toolSpec: null },
      expect: /cannot be auto-loaded without a resolved tool mode/,
    },
    {
      label: 'read-only session',
      target: WRITE_T,
      // A read-only surface never exposes a write tool: both kinds call it while it is deferred.
      eager: [],
      extra: { toolSpec: 'readonly', deferredSurfaceMode: 'readonly' },
      expect: /not available in readonly mode/,
    },
  ];
  for (const scenario of cases) {
    const outcome = await parity(async (kind) => {
      const fixture = fixtureTools(t);
      const session = makeSession(kind, {
        target: scenario.target,
        scopeId: fixture.scopeId,
        ...(scenario.eager ? { eager: scenario.eager } : {}),
        ...scenario.extra,
      });
      const hooks = recordHooks(session, scenario.before);
      const { results } = await runBatch({ session, calls: [wire(kind, 'X', scenario.target, { value: 'a' })] });
      return { results: summary(results), executions: fixture.executions, before: hooks.before.map((h) => h.name) };
    });
    assert.match(String(outcome.results[0].content), scenario.expect, scenario.label);
    assert.equal(outcome.results[0].toolCallId, 'X');
    assert.equal(outcome.results[0].toolKind, 'error');
    assert.deepEqual(outcome.executions, [], scenario.label);
  }
});

test('approval sees the target; a granted or denied decision behaves identically', async (t) => {
  for (const approved of [true, false]) {
    const outcome = await parity(async (kind) => {
      const fixture = fixtureTools(t);
      const session = makeSession(kind, { target: WRITE_T, scopeId: fixture.scopeId });
      const hooks = recordHooks(session, () => ({ action: 'ask' }));
      const opts = {
        onToolApproval: async (request) => {
          hooks.approval.push({ name: request.name, args: request.args, toolCallId: request.toolCallId });
          return { approved, reason: 'fixture decision' };
        },
      };
      const { results } = await runBatch({ session, opts, calls: [wire(kind, 'X', WRITE_T, { value: 'w' })] });
      return { results: summary(results), executions: fixture.executions, hooks };
    });
    assert.deepEqual(outcome.hooks.approval, [{ name: WRITE_T, args: { value: 'w' }, toolCallId: 'X' }]);
    assert.equal(outcome.hooks.before.length, 1);
    if (approved) {
      assert.deepEqual(outcome.executions, [{ name: WRITE_T, args: { value: 'w' } }]);
    } else {
      assert.deepEqual(outcome.executions, []);
      assert.match(String(outcome.results[0].content), new RegExp(`tool "${WRITE_T}" denied by hook.*fixture decision`));
      assert.equal(outcome.hooks.failure.length, 1);
      assert.equal(outcome.hooks.failure[0].name, WRITE_T);
    }
  }
});

test('cancellation during approval stops a bridged call before execution', async (t) => {
  await parity(async (kind) => {
    const fixture = fixtureTools(t);
    const session = makeSession(kind, { target: WRITE_T, scopeId: fixture.scopeId });
    const hooks = recordHooks(session, () => ({ action: 'ask' }));
    const controller = new AbortController();
    const reason = new Error('cancel while awaiting approval');
    const opts = {
      onToolApproval: async (request) => {
        hooks.approval.push(request.name);
        setImmediate(() => controller.abort(reason));
        return new Promise(() => {});
      },
    };
    await assert.rejects(
      runBatch({ session, opts, signal: controller.signal, calls: [wire(kind, 'X', WRITE_T, { value: 'w' })] }),
      (error) => error === reason
    );
    await new Promise(setImmediate);
    assert.deepEqual(fixture.executions, []);
    return { approval: hooks.approval, before: hooks.before.length };
  });
});

test('a hook rewrite is re-checked against the session policy for bridged calls too', async (t) => {
  const cases = [
    {
      label: 'rewrite to a denied target',
      target: READ_T,
      extra: { schemaAllowedTools: ['read', READ_T] },
      rewrite: WRITE_T,
      expect: /schema allowlist/,
    },
    {
      label: 'rewrite to a mutating target in a read-only session',
      target: READ_T,
      extra: { toolSpec: 'readonly', deferredSurfaceMode: 'readonly' },
      rewrite: WRITE_T,
      expect: /not available in readonly mode/,
    },
    { label: 'rewrite to the bridge itself', target: READ_T, rewrite: 'call_tool', expect: /BRIDGE_RECURSION/ },
  ];
  for (const scenario of cases) {
    const outcome = await parity(async (kind) => {
      const fixture = fixtureTools(t);
      const session = makeSession(kind, { target: scenario.target, scopeId: fixture.scopeId, ...scenario.extra });
      const hooks = recordHooks(session, () => ({ action: 'rewrite', name: scenario.rewrite }));
      const { results } = await runBatch({ session, calls: [wire(kind, 'X', scenario.target, { value: 'a' })] });
      return { results: summary(results), executions: fixture.executions, hooks };
    });
    assert.match(String(outcome.results[0].content), scenario.expect, scenario.label);
    assert.deepEqual(outcome.executions, [], scenario.label);
    assert.deepEqual(
      outcome.hooks.before.map((hook) => hook.name),
      [scenario.target],
      scenario.label
    );
    assert.equal(outcome.hooks.failure.length, 1, scenario.label);
  }
});

test('a bridged web_fetch keeps its loopback transport routing (authorized as web_fetch)', async (t) => {
  // Review regression: the execution recheck uses the public identity, so the
  // routed local_fetch transport is not reported as TOOL_NOT_FOUND.
  const outcome = await parity(async (kind) => {
    const fixture = fixtureTools(t);
    const session = makeSession(kind, {
      target: 'web_fetch',
      scopeId: fixture.scopeId,
      catalog: [...CATALOG, def('web_fetch', true)],
    });
    const { results } = await runBatch({
      session,
      calls: [wire(kind, 'X', 'web_fetch', { url: 'http://127.0.0.1:9/page' })],
    });
    return { results: summary(results), executions: fixture.executions };
  });
  assert.deepEqual(outcome.executions, [{ name: 'local_fetch', args: { url: 'http://127.0.0.1:9/page' } }]);
  assert.equal(outcome.results[0].toolKind, 'normal');
});

test('a failed bridged call fires the failure hook once and restores the wire arguments', async (t) => {
  const command = `echo ${'x'.repeat(12_000)}`;
  const outcome = await parity(async (kind) => {
    const fixture = fixtureTools(t, () => 'Error: fixture failure');
    const session = makeSession(kind, { target: WRITE_T, scopeId: fixture.scopeId });
    const hooks = recordHooks(session);
    const calls = [wire(kind, 'X', WRITE_T, { command })];
    const { results, assistantTurnMsg } = await runBatch({ session, calls });
    // The stored assistant turn compacted the long command at commit; the
    // failure restored it inside the original wire call shape.
    assert.deepEqual(assistantTurnMsg.toolCalls, calls);
    return { results: summary(results), executions: fixture.executions.length, hooks };
  });
  assert.equal(outcome.results[0].toolKind, 'error');
  assert.equal(outcome.results[0].toolCallId, 'X');
  assert.deepEqual(outcome.hooks.failure, [{ name: WRITE_T, args: { command }, toolCallId: 'X' }]);
  assert.equal(outcome.executions, 1);
});

test('a disconnected MCP server refuses bridged and direct calls before anything is sent', async (t) => {
  for (const when of ['before projection', 'during the policy hook']) {
    const outcome = await parity(async (kind) => {
      const scopeId = `bridge-mcp-${randomUUID()}`;
      const server = `srv${randomUUID().slice(0, 8)}`;
      const name = `mcp__${server}__run`;
      const mcpTool = { ...def(name), annotations: {} };
      const sent = [];
      const register = (tools) =>
        _registerMcpServerForTest(scopeId, server, tools, {
          callTool: async (params) => {
            sent.push(params);
            return { content: [{ type: 'text', text: 'ran' }] };
          },
        });
      t.after(() => disconnectAll({ scopeId }));
      const connected = when !== 'before projection';
      if (connected) register([mcpTool]);
      const session = makeSession(kind, {
        target: name,
        scopeId,
        catalog: [...CATALOG, mcpTool],
        deferredMcpToolNames: connected ? [name] : [],
      });
      recordHooks(session, () => {
        register([]);
        return { action: 'allow' };
      });
      const { results } = await runBatch({ session, calls: [wire(kind, 'X', name, { value: 'a' })] });
      return { refused: /unavailable in the current session catalog; no call was sent/.test(String(results[0].content)), id: results[0].toolCallId, sent: sent.length };
    });
    assert.deepEqual(outcome, { refused: true, id: 'X', sent: 0 }, when);
  }
});

// Batch-level ordering, cardinality and dedup with a recording executor.
function recordingExecutor(events, behavior = async () => 'ok') {
  return async (name, args, _cwd, _sessionId, _sessionRef, opts) => {
    events.push(`${name}:start:${opts.toolCallId}`);
    const result = await behavior(name, args, opts);
    events.push(`${name}:end:${opts.toolCallId}`);
    return result;
  };
}

test('shell after a failed edit waits for it and is skipped, bridged or direct', async () => {
  const outcome = await parity(async (kind) => {
    const session = makeSession(kind, { eager: kind === 'direct' ? ['apply_patch', 'shell'] : [] });
    const events = [];
    let releasePatch;
    const patchGate = new Promise((resolve) => {
      releasePatch = resolve;
    });
    const executeToolFn = recordingExecutor(events, async (name) => {
      if (name === 'apply_patch') {
        await patchGate;
        return 'Error: patch failed';
      }
      return 'shell ran';
    });
    const calls = [
      wire(kind, 'P', 'apply_patch', { patch: 'fixture' }),
      wire(kind, 'S', 'shell', { command: 'npm test' }),
    ];
    const pending = runBatch({ session, calls, executeToolFn });
    await new Promise(setImmediate);
    assert.deepEqual(events, ['apply_patch:start:P']);
    releasePatch();
    const { results } = await pending;
    return { events, results: summary(results) };
  });
  assert.deepEqual(outcome.events, ['apply_patch:start:P', 'apply_patch:end:P']);
  assert.match(String(outcome.results[1].content), /mutation-dependency-guard.*`shell` skipped.*P/);
  assert.deepEqual(
    outcome.results.map((message) => message.toolCallId),
    ['P', 'S']
  );
});

test('Computer Use stays one call per turn through the bridge', async () => {
  const outcome = await parity(async (kind) => {
    const session = makeSession(kind, { target: 'computer' });
    const events = [];
    const calls = [wire(kind, 'C1', 'computer', { value: '1' }), wire(kind, 'C2', 'computer', { value: '2' })];
    const { results } = await runBatch({ session, calls, executeToolFn: recordingExecutor(events) });
    return { events, results: summary(results) };
  });
  assert.deepEqual(outcome.events, ['computer:start:C1', 'computer:end:C1']);
  assert.match(String(outcome.results[1].content), /computer-call-cardinality/);
  assert.equal(outcome.results[1].toolCallId, 'C2');
});

test('read-only bridged targets share intra-turn dedup and the result cache', async () => {
  const file = join(root, 'dedup.txt');
  await writeFile(file, 'cached body\n');
  const outcome = await parity(async (kind) => {
    const session = makeSession(kind, { target: 'read' });
    const events = [];
    const executeToolFn = recordingExecutor(events, async () => 'cached body\n');
    const first = await runBatch({
      session,
      executeToolFn,
      calls: [wire(kind, 'R1', 'read', { file_path: file }), wire(kind, 'R2', 'read', { file_path: file })],
    });
    const second = await runBatch({
      session,
      executeToolFn,
      iterations: 2,
      calls: [wire(kind, 'R3', 'read', { file_path: file })],
    });
    return { events, first: summary(first.results), second: summary(second.results) };
  });
  assert.deepEqual(outcome.events, ['read:start:R1', 'read:end:R1']);
  assert.match(String(outcome.first[1].content), /intra-turn-dedup.*R1/);
  assert.notEqual(outcome.second[0].toolKind, 'normal');
  assert.equal(outcome.second[0].toolCallId, 'R3');
});

test('native sessions never project call_tool', async () => {
  const session = makeSession('direct', {
    target: READ_T,
    deferredProviderMode: 'native',
    toolExposureMode: undefined,
    provider: 'anthropic-oauth',
  });
  const events = [];
  const calls = [wire('bridged', 'X', READ_T, { value: 'a' })];
  await runBatch({ session, calls, executeToolFn: recordingExecutor(events) });
  assert.deepEqual(events, ['call_tool:start:X', 'call_tool:end:X']);
});
