import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {
  _registerMcpServerForTest, disconnectAll, getMcpTools, isRegisteredMcpTool,
} from '../runtime/agent/orchestrator/mcp/client.mjs';
import { setInternalToolsProvider } from '../runtime/agent/orchestrator/internal-tools.mjs';
import { agentLoop } from '../runtime/agent/orchestrator/session/agent-loop.mjs';
import { executeTool } from '../runtime/agent/orchestrator/session/loop/tool-exec.mjs';
import { isOnDeferredToolSurface } from '../runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { normalizeToolEnvelope } from '../runtime/agent/orchestrator/session/tool-envelope.mjs';
import { buildRequestBody } from '../runtime/agent/orchestrator/providers/openai-responses-payload.mjs';
import { nativeToolSearchCallFromArguments } from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import { toAnthropicMessages } from '../runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs';
import { createInternalToolExecutor } from './internal-tool-executor.mjs';
import { TOOL_SEARCH_TOOL } from './tool-defs.mjs';
import { providerNativeToolPrefixCount } from './provider-request-tools.mjs';
import {
  applyDeferredToolSurface, deferredCatalogUnion, reconcileDeferredMcpToolCatalog,
  refreshDeferredMcpToolCatalog, renderToolSearch, snapshotProviderRequestTools,
} from './tool-catalog.mjs';

function fixture(t, provider = 'openai-oauth', { boot = false, mode = 'full' } = {}) {
  const scopeId = randomUUID();
  const server = `deferred-${scopeId}`;
  const name = `mcp__${server}__menu`;
  const peerName = `mcp__${server}__unused`;
  const original = {
    name, description: 'Run an exact menu command.',
    inputSchema: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
    },
  };
  const revised = {
    ...original, description: 'Run the revised menu command.',
    inputSchema: {
      type: 'object', properties: { menu_path: { type: 'string' } }, required: ['menu_path'],
    },
  };
  const peer = { name: peerName, inputSchema: { type: 'object', properties: {} } };
  const session = {
    id: scopeId, mcpScopeId: scopeId, provider, model: 'gpt-6-astra',
    cwd: process.cwd(), owner: 'cli', toolSpec: mode,
    tools: [TOOL_SEARCH_TOOL, ...(boot ? [original, peer] : [])],
    messages: [], compaction: { auto: false },
  };
  applyDeferredToolSurface(session, mode);
  const calls = [];
  const register = (tools) => _registerMcpServerForTest(scopeId, server, tools, {
    callTool: async (params) => {
      calls.push(params);
      return { content: [{ type: 'text', text: `executed:${JSON.stringify(params.arguments)}` }] };
    },
  });
  const rt = { session, mode, currentCwd: session.cwd, config: {} };
  const executor = createInternalToolExecutor({
    rt, activeToolSurface: () => session,
    mcpStatus: () => ({ servers: [] }),
  });
  t.after(() => disconnectAll({ scopeId }));
  return { session, rt, scopeId, server, name, peerName, original, revised, peer, calls, register, executor };
}

for (const changeMcp of [false, true]) {
  test(`deferred refresh preserves the frozen eager and provider-native prefix: changed=${changeMcp}`, async (t) => {
    const f = fixture(t, 'anthropic-oauth', { boot: true });
    const eager = {
      name: 'cached_eager', description: 'original eager definition',
      inputSchema: { type: 'object', properties: {} },
    };
    const native = {
      name: 'provider_native', description: 'original native definition',
      input_schema: { type: 'object', properties: {} },
    };
    f.session.tools.push(eager);
    f.register([f.original, f.peer]);
    await f.executor('load_tool', { names: [f.name] });
    const dispose = setInternalToolsProvider({
      scopeId: f.scopeId, tools: [TOOL_SEARCH_TOOL], executor: f.executor,
    });
    t.after(dispose);
    const requests = [];
    const prefixCounts = [];
    const nativeTools = [native];
    const provider = {
      name: f.session.provider,
      async send(_messages, _model, tools) {
        requests.push(structuredClone(tools));
        prefixCounts.push(providerNativeToolPrefixCount(tools));
        assert.ok(Object.isFrozen(tools));
        if (requests.length === 1) {
          const index = f.session.tools.findIndex(tool => tool.name === eager.name);
          f.session.tools[index] = { ...eager, description: 'unrelated eager change' };
          nativeTools[0] = { ...native, description: 'unrelated native change' };
          if (changeMcp) f.register([f.revised, f.peer]);
          return {
            content: '', stopReason: 'tool_calls',
            toolCalls: [{ id: 'reload', name: 'load_tool', arguments: { names: [f.name] } }],
          };
        }
        return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
      },
    };
    await agentLoop(provider, [{ role: 'user', content: 'Inspect.' }], f.session.model,
      f.session.tools, null, f.session.cwd, { session: f.session, sessionId: f.scopeId, nativeTools });
    assert.equal(requests.length, 2);
    assert.deepEqual(prefixCounts, [1, 1]);
    assert.deepEqual(requests[1].filter(tool => !tool.deferLoading), requests[0].filter(tool => !tool.deferLoading));
    assert.equal(requests[1].find(tool => tool.name === eager.name).description, eager.description);
    assert.equal(requests[1][0].description, native.description);
    assert.deepEqual(requests[1].find(tool => tool.name === f.name).inputSchema,
      changeMcp ? f.revised.inputSchema : f.original.inputSchema);
  });
}

test('load_tool refreshes a recovered registry in the same user turn', async (t) => {
  const f = fixture(t);
  f.register([f.original, f.peer]);
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  f.register([]);
  reconcileDeferredMcpToolCatalog(f.session, []);
  f.register([f.revised, f.peer]);
  const result = JSON.parse(await f.executor('load_tool', { names: [f.name] }));
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.loaded, [f.name]);
  assert.deepEqual(result.nativeToolSearch.openaiTools[0].parameters, f.revised.inputSchema);
  assert.equal(f.session.tools.some(tool => tool.name === f.name), false);
});

test('native discovery history survives disconnect without granting availability', async (t) => {
  const f = fixture(t);
  f.register([f.original]);
  await f.executor('load_tool', { names: [f.name] });
  await disconnectAll({ scopeId: f.scopeId });
  refreshDeferredMcpToolCatalog(f.session, {});
  assert.ok(f.session.deferredCallableTools.includes(f.name));
  assert.ok(deferredCatalogUnion(f.session).some(tool => tool.name === f.name));
  assert.equal(isOnDeferredToolSurface(f.session, f.name), false);
  assert.deepEqual(JSON.parse(renderToolSearch({ names: [f.name] }, f.session)).missing, [f.name]);
  f.register([f.revised]);
  const reloaded = JSON.parse(await f.executor('load_tool', { names: [f.name] }));
  assert.deepEqual(reloaded.alreadyActive, [f.name]);
  assert.deepEqual(reloaded.nativeToolSearch.toolReferences, [f.name]);
  assert.deepEqual(reloaded.nativeToolSearch.openaiTools[0].parameters, f.revised.inputSchema);
});

test('a current removal overrides boot and loaded definitions for both loading and execution', async (t) => {
  const f = fixture(t, 'anthropic-oauth', { boot: true });
  f.register([f.original, f.peer]);
  const boot = JSON.stringify(f.session.deferredToolCatalog);
  await f.executor('load_tool', { names: [f.name] });
  f.register([]);
  const result = JSON.parse(await f.executor('load_tool', { names: [f.name, f.peerName] }));
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.alreadyActive, []);
  assert.deepEqual(result.missing, [f.name, f.peerName]);
  assert.equal(result.activeTools.includes(f.name), false);
  assert.equal(isRegisteredMcpTool(f.name, f.scopeId), false);
  assert.equal(JSON.stringify(f.session.deferredToolCatalog), boot);
  const definitions = snapshotProviderRequestTools({
    provider: f.session.provider, tools: f.session.tools, session: f.session, messages: [],
  });
  assert.equal(definitions.some(tool => tool.name === f.name), false);
  const denied = normalizeToolEnvelope(await executeTool(f.name, { path: 'Tools/Run' }, process.cwd(), null, f.session));
  assert.match(denied.result, /unavailable.*no call was sent/);
  assert.equal(f.calls.length, 0);
});

test('refresh preserves project scope, disabled tools and readonly selection rules', async (t) => {
  const f = fixture(t, 'openai-oauth', { boot: true, mode: 'readonly' });
  f.register([f.original, f.peer]);
  f.rt.config = { extensionScopes: { mcp: { [f.server]: [join(process.cwd(), 'other-project')] } } };
  const excluded = JSON.parse(await f.executor('load_tool', { names: [f.name] }));
  assert.deepEqual(excluded.missing, [f.name]);
  f.rt.config = {};
  const readonly = JSON.parse(await f.executor('load_tool', { names: [f.name] }));
  assert.deepEqual(readonly.blocked, [{ name: f.name, reason: 'readonly mode' }]);
  f.session.disallowedTools = [f.peerName];
  const disabled = JSON.parse(await f.executor('load_tool', { names: [f.peerName] }));
  assert.deepEqual(disabled.missing, [f.peerName]);
});

test('a removal while an approval hook is pending prevents MCP dispatch', async (t) => {
  const f = fixture(t, 'openai-oauth', { boot: true });
  f.register([f.original]);
  await f.executor('load_tool', { names: [f.name] });
  const result = await executeTool(f.name, { path: 'Tools/Run' }, process.cwd(), null, f.session, {
    beforeToolHook: async () => {
      f.register([]);
      return { action: 'allow' };
    },
  });
  assert.match(normalizeToolEnvelope(result).result, /unavailable.*no call was sent/);
  assert.equal(f.calls.length, 0);
});

for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
  test(`${provider}: deferred load, call, schema refresh and removal work in one agent loop`, async (t) => {
    const f = fixture(t, provider);
    const boot = JSON.stringify(f.session.deferredToolCatalog);
    const dispose = setInternalToolsProvider({
      scopeId: f.scopeId, tools: [TOOL_SEARCH_TOOL], executor: f.executor,
    });
    t.after(dispose);
    const requests = [];
    const bodies = [];
    const searchCall = (id) => provider === 'openai-oauth'
      ? nativeToolSearchCallFromArguments(id, { names: [f.name] })
      : { id, name: 'load_tool', arguments: { names: [f.name] } };
    const toolResponse = (call) => ({ content: '', toolCalls: [call], stopReason: 'tool_calls' });
    const fakeProvider = {
      name: provider,
      async send(messages, _model, tools) {
        requests.push(structuredClone(tools));
        if (provider === 'openai-oauth') {
          bodies.push(buildRequestBody(messages, f.session.model, tools, { sessionId: f.scopeId }));
        } else if (provider === 'anthropic-oauth') {
          bodies.push(toAnthropicMessages(messages, tools));
        }
        switch (requests.length) {
          case 1:
            assert.equal(tools.some(tool => tool.name === f.name), false);
            f.register([f.original, f.peer]);
            return toolResponse(searchCall('load-1'));
          case 2:
            return toolResponse({ id: 'call-1', name: f.name, arguments: { path: 'Tools/Run' } });
          case 3:
            assert.match(String(messages.find(message => message.toolCallId === 'call-1')?.content), /executed/);
            f.register([f.revised, f.peer]);
            return toolResponse(searchCall('load-2'));
          case 4:
            return toolResponse({ id: 'call-2', name: f.name, arguments: { menu_path: 'Tools/Run' } });
          case 5:
            f.register([]);
            return toolResponse(searchCall('load-3'));
          case 6:
            assert.match(String(messages.find(message => message.toolCallId === 'load-3')?.content), /missing/);
            return toolResponse({ id: 'stale-call', name: f.name, arguments: { menu_path: 'Tools/Run' } });
          default:
            assert.equal(requests.length, 7);
            assert.match(String(messages.find(message => message.toolCallId === 'stale-call')?.content), /unavailable/);
            return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
        }
      },
    };
    const messages = [{ role: 'user', content: 'Run the requested menu twice.' }];
    const result = await agentLoop(fakeProvider, messages, f.session.model, f.session.tools, null,
      f.session.cwd, { session: f.session, sessionId: f.scopeId });
    assert.equal(result.content, 'done');
    assert.equal(messages.filter(message => message.role === 'user').length, 1);
    assert.deepEqual(f.calls.map(call => call.arguments), [
      { path: 'Tools/Run' }, { menu_path: 'Tools/Run' },
    ]);
    if (f.session.deferredNativeTools) {
      assert.equal(JSON.stringify(f.session.deferredToolCatalog), boot);
      assert.ok(f.session.deferredCallableTools.includes(f.name));
      assert.equal(f.session.deferredCallableTools.includes(f.peerName), false);
      assert.equal(requests.flat().some(tool => tool.name === f.peerName), false);
    }
    if (provider === 'openai-oauth') {
      for (const body of bodies) assert.deepEqual(body.tools, bodies[0].tools);
      for (const [index, callId, schema] of [
        [1, 'load-1', f.original.inputSchema], [3, 'load-2', f.revised.inputSchema],
      ]) {
        const output = bodies[index].input.find(item => item.type === 'tool_search_output' && item.call_id === callId);
        assert.deepEqual(output.tools.map(tool => tool.name), [f.name]);
        assert.deepEqual(output.tools[0].parameters, schema);
        assert.equal(output.tools[0].strict, false);
      }
      const removed = bodies[5].input.find(item => item.type === 'tool_search_output' && item.call_id === 'load-3');
      assert.deepEqual(removed.tools, []);
    } else {
      assert.deepEqual(requests[1].find(tool => tool.name === f.name).inputSchema, f.original.inputSchema);
      assert.deepEqual(requests[3].find(tool => tool.name === f.name).inputSchema, f.revised.inputSchema);
      assert.equal(requests[5].some(tool => tool.name === f.name), false);
      if (provider === 'anthropic-oauth') {
        assert.equal(requests[1].find(tool => tool.name === f.name).deferLoading, true);
        assert.ok(JSON.stringify(bodies[1]).includes(`"tool_reference","tool_name":"${f.name}"`));
        for (const tools of requests) assert.deepEqual(tools.filter(tool => !tool.deferLoading), requests[0]);
      }
    }
  });
}
