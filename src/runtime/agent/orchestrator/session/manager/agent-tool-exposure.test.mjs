// Review regression: agent (worker) sessions on a non-native provider send
// core + bridge built from their own filtered tools, not the full array.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('agent-exposure');
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = join(root, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const { createSession, updateSessionRoute, resumeSession } = await import('./session-lifecycle.mjs');
const { deleteSession, saveSession } = await import('../store.mjs');
const { applyDeferredToolSurface } = await import('../../runtime-core/tool-catalog.mjs');
const { applyInitialDeferredToolManifestToBp2 } = await import('../../context/collect.mjs');
const { _withRegisteredProviderForTest, _withRegisteredProviderForTestAsync } = await import(
  '../../providers/registry.mjs'
);
const { setInternalToolsProvider } = await import('../../internal-tools.mjs');
const { agentLoop } = await import('../agent-loop.mjs');
const { DEFERRED_DEFAULT_FULL_TOOLS } = await import('../../runtime-core/tool-catalog-data.mjs');
const { _registerMcpServerForTest, disconnectAll } = await import('../../mcp/client.mjs');
const { refreshDeferredMcpToolCatalog } = await import('../../runtime-core/tool-catalog.mjs');

const BRIDGE = ['load_tool', 'call_tool'];
const names = (tools) => tools.map((tool) => tool.name);
const bigSchema = {
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: 400 }, (_, index) => [`field_${index}`, { type: 'string', description: 'x'.repeat(300) }])
  ),
};

function scope(t) {
  const scopeId = `agent-exposure-${Math.random().toString(36).slice(2)}`;
  t.after(
    setInternalToolsProvider({
      scopeId,
      tools: [
        { name: 'big_probe', description: 'Big.', inputSchema: bigSchema, annotations: { readOnlyHint: true } },
        { name: 'denied_probe', description: 'Denied.', inputSchema: { type: 'object' } },
      ],
      executor: async () => 'ok',
    })
  );
  return scopeId;
}

function create(provider, opts) {
  return _withRegisteredProviderForTest(provider, { name: provider, contextWindow: 128000 }, () =>
    createSession({
      provider,
      model: 'fixture-model',
      owner: 'agent',
      agent: 'worker',
      cwd: root,
      ...opts,
    })
  );
}

test('a non-native worker sends core + bridge on its first request', async (t) => {
  const mcpScopeId = scope(t);
  const session = create('gemini', { mcpScopeId, disallowedTools: ['denied_probe'] });
  t.after(() => deleteSession(session.id));
  const full = session.deferredToolCatalog.map((tool) => tool.name);
  assert.ok(full.includes('big_probe'), 'the worker catalog holds its routed tools');
  assert.equal(full.includes('denied_probe'), false, 'denied tools stay out of the catalog');
  assert.equal(full.includes('agent'), false, 'the recursive agent tool stays out');
  assert.equal(session.toolExposureMode, 'bridge-v1');

  const sent = [];
  const provider = {
    name: 'gemini',
    async send(messages, _model, tools) {
      sent.push({ tools: names(tools), system: messages.filter((message) => message.role === 'system') });
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const messages = [...session.messages, { role: 'user', content: 'work' }];
  await _withRegisteredProviderForTestAsync('gemini', provider, () =>
    agentLoop(provider, messages, session.model, session.tools, null, root, { session, sessionId: session.id })
  );
  const core = DEFERRED_DEFAULT_FULL_TOOLS.filter((name) => name !== 'load_tool' && full.includes(name));
  assert.deepEqual(new Set(sent[0].tools), new Set([...core, ...BRIDGE]));
  assert.equal(sent[0].tools.includes('big_probe'), false);
  // The worker's roster lists its own deferred pool only, then the guidance.
  const prompt = sent[0].system.map((message) => message.content).join('\n');
  const roster = prompt.match(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>\n\n<tool-bridge>/)?.[0];
  assert.ok(roster, 'roster followed by the bridge guidance');
  const listed = [...roster.matchAll(/^- ([^:\n]+)/gm)].map((match) => match[1]);
  assert.ok(listed.includes('big_probe'));
  assert.equal(listed.includes('denied_probe'), false, 'denied tools are never listed');
  assert.equal(listed.includes('agent'), false);
  for (const name of sent[0].tools) assert.equal(listed.includes(name), false, `${name} is eager`);
  assert.deepEqual(new Set(listed), new Set(full.filter((name) => !sent[0].tools.includes(name))));
});

// One MCP server per test scope, (re)connected with the given tools; every
// call that reaches the server is recorded.
function mcpServer(t, scopeId) {
  const calls = [];
  const connect = (tools) =>
    _registerMcpServerForTest(
      scopeId,
      'alpha',
      tools.map((name) => ({ name, description: `${name} tool.`, annotations: { readOnlyHint: true } })),
      {
        callTool: async (params) => {
          calls.push(params.name);
          return { content: [{ type: 'text', text: `ran ${params.name}` }] };
        },
      }
    );
  t.after(() => disconnectAll({ scopeId }));
  return { calls, connect, disconnect: () => disconnectAll({ scopeId }) };
}

/** One worker turn on `provider` whose model makes `toolCall`; returns the tools sent and the result. */
async function workerTurn(session, providerName, toolCall) {
  const sent = [];
  let sends = 0;
  const provider = {
    name: providerName,
    async send(_messages, _model, tools) {
      sends += 1;
      sent.push(names(tools));
      if (sends === 1) return { content: '', stopReason: 'tool_calls', toolCalls: [toolCall] };
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const messages = [...session.messages, { role: 'user', content: 'go' }];
  await _withRegisteredProviderForTestAsync(providerName, provider, () =>
    agentLoop(provider, messages, session.model, session.tools, null, root, { session, sessionId: session.id })
  );
  session.messages = messages; // the settled turn
  const result = messages.find((message) => message.role === 'tool' && message.toolCallId === toolCall.id);
  return { sent, result: String(result?.content ?? '') };
}

function reroute(session, provider) {
  return _withRegisteredProviderForTest(provider, { name: provider, contextWindow: 128000 }, () =>
    updateSessionRoute(session.id, { provider, model: 'fixture-model' })
  );
}

test('review: bridge → native drops the MCP availability snapshot; a newly connected tool runs', async (t) => {
  const mcpScopeId = `agent-exposure-mcp-${Math.random().toString(36).slice(2)}`;
  const server = mcpServer(t, mcpScopeId);
  server.connect(['one']);
  const worker = create('gemini', { mcpScopeId });
  t.after(() => deleteSession(worker.id));
  refreshDeferredMcpToolCatalog(worker);
  assert.deepEqual(worker.deferredMcpToolNames, ['mcp__alpha__one']);

  server.connect(['one', 'two']);
  const native = reroute(worker, 'anthropic-oauth');
  assert.equal(native.toolExposureMode, undefined);
  assert.equal(native.deferredMcpToolNames, undefined);
  assert.ok(names(native.tools).includes('mcp__alpha__two'));
  const turn = await workerTurn(native, 'anthropic-oauth', { id: 'n1', name: 'mcp__alpha__two', arguments: {} });
  assert.ok(turn.sent[0].includes('mcp__alpha__two'), 'the request snapshot carries the connected tool');
  assert.deepEqual(server.calls, ['two']);
  assert.match(turn.result, /ran two/);
});

test('review: native → bridge follows MCP connect and disconnect for a worker', async (t) => {
  const mcpScopeId = `agent-exposure-mcp-${Math.random().toString(36).slice(2)}`;
  const server = mcpServer(t, mcpScopeId);
  server.connect(['one']);
  const worker = create('anthropic-oauth', { mcpScopeId });
  t.after(() => deleteSession(worker.id));
  assert.equal(worker.deferredMcpToolNames, undefined);

  const bridged = reroute(worker, 'gemini');
  assert.equal(bridged.toolExposureMode, 'bridge-v1');
  // A tool connected after the switch is reached through the bridge.
  server.connect(['one', 'two']);
  const call = { id: 'b1', name: 'call_tool', arguments: { name: 'mcp__alpha__two', arguments: {} } };
  const connected = await workerTurn(bridged, 'gemini', call);
  assert.equal(connected.sent[0].includes('mcp__alpha__two'), false, 'never eager on the bridge');
  assert.deepEqual(server.calls, ['two']);
  assert.match(connected.result, /ran two/);
  assert.ok(bridged.deferredMcpToolNames.includes('mcp__alpha__two'));

  // After a disconnect the same bridged call is refused before anything is sent.
  await server.disconnect();
  const gone = await workerTurn(bridged, 'gemini', { ...call, id: 'b2' });
  assert.deepEqual(server.calls, ['two']);
  assert.match(gone.result, /^Error/);
  assert.equal(bridged.deferredMcpToolNames.includes('mcp__alpha__two'), false);
});

// A reviewer hosted by a session runtime carries the runtime's native deferred
// surface (eager core + load_tool + BP2 roster). Resuming it must not strip
// that surface and tag a migration: native → native is no exposure change.
test('a native deferred agent surface survives resume with no migration and the same prefix', async (t) => {
  const mcpScopeId = scope(t);
  const provider = 'openai-oauth';
  const session = create(provider, { mcpScopeId, agent: 'reviewer' });
  t.after(() => deleteSession(session.id));
  applyDeferredToolSurface(session, 'lead', [], { provider });
  const active = new Set(names(session.tools));
  applyInitialDeferredToolManifestToBp2(
    session,
    session.deferredToolCatalog.map((tool) => tool.name).filter((name) => !active.has(name))
  );
  const prefix = (value) =>
    JSON.stringify([value.messages.filter((m) => m.role === 'system').map((m) => m.content), names(value.tools)]);
  const before = prefix(session);
  assert.match(session.messages.find((m) => /<available-deferred-tools>/.test(m.content))?.content || '', /big_probe/);
  saveSession(session);
  const resumed = await _withRegisteredProviderForTestAsync(provider, { name: provider, contextWindow: 128000 }, () =>
    resumeSession(session.id, 'full')
  );
  assert.equal(resumed.pendingCacheBreakIntent, undefined, 'no tool_surface_bridge_migration');
  assert.equal(resumed.deferredProviderMode, 'native');
  assert.equal(prefix(resumed), before, 'tools and the BP2 roster are unchanged');
});

test('native workers keep their full array; a route change migrates both ways', (t) => {
  const mcpScopeId = scope(t);
  const native = create('anthropic-oauth', { mcpScopeId });
  t.after(() => deleteSession(native.id));
  assert.equal(native.toolExposureMode, undefined);
  assert.equal(native.deferredProviderMode, undefined);
  assert.ok(names(native.tools).includes('big_probe'));
  assert.equal(
    names(native.tools).some((name) => BRIDGE.includes(name) && name !== 'load_tool'),
    false
  );

  const bridged = _withRegisteredProviderForTest('gemini', { name: 'gemini', contextWindow: 128000 }, () =>
    updateSessionRoute(native.id, { provider: 'gemini', model: 'fixture-model' })
  );
  assert.equal(bridged.toolExposureMode, 'bridge-v1');
  assert.ok(names(bridged.tools).includes('call_tool'));
  assert.equal(names(bridged.tools).includes('big_probe'), false);
  assert.equal(bridged.pendingCacheBreakIntent, 'tool_surface_bridge_migration');

  const back = _withRegisteredProviderForTest(
    'anthropic-oauth',
    { name: 'anthropic-oauth', contextWindow: 128000 },
    () => updateSessionRoute(native.id, { provider: 'anthropic-oauth', model: 'fixture-model' })
  );
  assert.equal(back.toolExposureMode, undefined);
  assert.equal(back.deferredProviderMode, undefined);
  assert.ok(names(back.tools).includes('big_probe'));
  assert.equal(names(back.tools).includes('call_tool'), false);
  assert.equal(
    back.messages.some((message) => message.role === 'system' && /<tool-bridge>/.test(message.content)),
    false
  );
});
