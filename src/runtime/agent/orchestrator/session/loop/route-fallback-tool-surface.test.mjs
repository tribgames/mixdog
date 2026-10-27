// A Lead whose provider hits a usage limit hops to the next model of its chain
// automatically. The hop must leave the same deferred tool surface a manual
// model switch does (default eager set + load_tool, MCP tools deferred), never
// the session's whole tool list, which overflowed the new model's window
// (TOOL_SURFACE_EXCEEDS_CONTEXT).
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import test, { mock } from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';

const root = makeTempDirSync('route-fallback-surface');
mkdirSync(root, { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));

// A hop initializes the next provider from the saved settings: the test
// registers its providers itself, so that init never touches the live registry.
const registry = await import('../../providers/registry.mjs');
mock.module('../../providers/registry.mjs', {
  namedExports: { ...registry, initProviders: async () => {} },
});
const realConfig = await import('../../config.mjs');
let chain = [];
let primary = { provider: 'openai-oauth', model: 'gpt-fixture' };
mock.module('../../config.mjs', {
  namedExports: {
    ...realConfig,
    loadConfig: () => ({
      providers: {},
      default: 'workflow-lead',
      presets: [
        {
          id: 'workflow-lead',
          name: 'WORKFLOW LEAD',
          ...primary,
          fallbacks: chain,
        },
      ],
    }),
  },
});

const { createSession } = await import('../manager/session-lifecycle.mjs');
const { deleteSession } = await import('../store.mjs');
const { applyDeferredToolSurface } = await import('../../runtime-core/tool-catalog.mjs');
const { DEFERRED_DEFAULT_LEAD_TOOLS } = await import('../../runtime-core/tool-catalog-data.mjs');
const { _registerMcpServerForTest, disconnectAll } = await import('../../mcp/client.mjs');
const { agentLoop } = await import('../agent-loop.mjs');
const { setInternalToolsProvider } = await import('../../internal-tools.mjs');

const MCP_TOOL_COUNT = 209;
const names = (tools) => tools.map((tool) => tool.name);
const info = (contextWindow) => ({ contextWindow, effectiveContextWindowPercent: 100 });
// A large MCP server: its definitions alone exceed the fallback model's window.
const heavySchema = {
  type: 'object',
  properties: Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`field_${index}`, { type: 'string', description: 'x'.repeat(300) }])
  ),
};

const usageLimit = () =>
  Object.assign(new Error('The usage limit has been reached'), {
    code: 'usage_limit_reached',
    responseFailed: { type: 'response.failed' },
    sawResponseCreated: true,
  });

const mcp = (list) => list.filter((name) => name.startsWith('mcp__'));
const systemPrefix = (messages) => messages.filter((message) => message.role === 'system');

/**
 * A session on `from`, a usage limit there, then the request on `to`; returns
 * what each sent. `agent`: a delegated worker (owner "agent") holding one
 * specialist tool instead of a Lead with a large MCP server.
 */
async function hop(t, from, to, { agent = false, model = 'gpt-fixture', fallbackModel = 'fallback-fixture' } = {}) {
  chain = [{ provider: to, model: fallbackModel }];
  primary = { provider: from, model };
  const scopeId = `route-fallback-surface-${Math.random().toString(36).slice(2)}`;
  if (agent) {
    t.after(
      setInternalToolsProvider({
        scopeId,
        tools: [{ name: 'specialist_tool', description: 'Specialist.', inputSchema: { type: 'object' } }],
        executor: async () => 'ok',
      })
    );
  } else {
    _registerMcpServerForTest(
      scopeId,
      'rea',
      Array.from({ length: MCP_TOOL_COUNT }, (_, index) => ({
        name: `tool_${index}`,
        description: `REA tool ${index}.`,
        inputSchema: heavySchema,
        annotations: { readOnlyHint: true },
      })),
      { callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
    );
    t.after(() => disconnectAll({ scopeId }));
  }

  const sent = { first: [], second: [], secondEager: [], firstRequest: null, secondRequest: null };
  const left = {
    name: from,
    getCachedModelInfo: () => info(1_000_000),
    send: async (messages, _model, tools) => {
      sent.first.push(names(tools));
      sent.firstRequest = { tools: JSON.stringify(tools), system: JSON.stringify(systemPrefix(messages)) };
      throw usageLimit();
    },
  };
  const next = {
    name: to,
    getCachedModelInfo: () => info(200_000),
    send: async (messages, _model, tools) => {
      sent.second.push(names(tools));
      sent.secondEager.push(names(tools.filter((tool) => !tool.deferLoading && !tool.defer_loading)));
      sent.secondRequest = { tools: JSON.stringify(tools), system: JSON.stringify(systemPrefix(messages)) };
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const { _withRegisteredProviderForTest, _withRegisteredProviderForTestAsync } = registry;
  const session = _withRegisteredProviderForTest(from, left, () =>
    createSession({
      provider: from,
      model,
      owner: agent ? 'agent' : 'user',
      agent: agent ? 'worker' : 'lead',
      cwd: root,
      mcpScopeId: scopeId,
      id: agent ? 'sess_worker_route_fallback_surface' : 'sess_lead_route_fallback_surface',
    })
  );
  t.after(() => deleteSession(session.id));
  if (agent) {
    // A delegated worker follows the chain it was spawned with.
    session.routeFallbacks = chain;
  } else {
    // The Lead's initial deferred surface (session-create/materialize.mjs).
    applyDeferredToolSurface(session, 'lead', []);
    assert.equal(mcp(names(session.tools)).length, 0, 'the Lead starts with its MCP tools deferred');
    assert.equal(mcp(names(session.deferredToolCatalog)).length, MCP_TOOL_COUNT);
  }

  const messages = [...session.messages, { role: 'user', content: 'work' }];
  let outcome;
  await _withRegisteredProviderForTestAsync(from, left, () =>
    _withRegisteredProviderForTestAsync(to, next, async () => {
      try {
        await agentLoop(left, messages, session.model, session.tools, null, root, { session, sessionId: session.id });
      } catch (error) {
        outcome = error;
      }
    })
  );
  return { session, sent, outcome, mcp };
}

test('a native → native hop of a Lead whose surface was already deferred keeps the request prefix byte-identical', async (t) => {
  // Same model on both providers of the Anthropic family: nothing but the surface could differ.
  const { sent, outcome } = await hop(t, 'anthropic-oauth', 'anthropic', {
    model: 'claude-fixture',
    fallbackModel: 'claude-fixture',
  });
  assert.equal(outcome, undefined);
  assert.ok(sent.firstRequest && sent.secondRequest);
  assert.equal(sent.secondRequest.tools, sent.firstRequest.tools);
  assert.equal(sent.secondRequest.system, sent.firstRequest.system);
});

test('an agent hop keeps the tools its surface had, specialist tools included', async (t) => {
  const { session, sent, outcome } = await hop(t, 'openai-oauth', 'anthropic-oauth', { agent: true });
  assert.equal(outcome, undefined);
  assert.equal(session.provider, 'anthropic-oauth');
  assert.equal(session.deferredSurfaceMode, undefined, 'a native agent has no Lead surface');
  assert.ok(sent.first[0].includes('specialist_tool'));
  // The model-specific edit tool is the only difference between the two models.
  const common = (list) => list.filter((name) => name !== 'edit' && name !== 'apply_patch');
  assert.deepEqual(common(sent.second[0]), common(sent.first[0]));
});

for (const [from, to, bridge] of [
  ['openai-oauth', 'anthropic-oauth', false],
  ['openai-oauth', 'gemini', true],
]) {
  test(`${from} → ${to}: the hop sends the deferred default surface, not every MCP tool`, async (t) => {
    const { session, sent, outcome } = await hop(t, from, to);
    assert.equal(outcome?.code, undefined, `no ${outcome?.code}: ${outcome?.message}`);
    assert.equal(outcome, undefined);
    assert.equal(session.provider, to);
    assert.equal(sent.second.length, 1, 'the request ran on the fallback model');
    const surface = sent.second[0];
    assert.equal(mcp(surface).length, 0, 'MCP tools stay deferred');
    // The Lead's deferred default set; the bridge adds call_tool, a native
    // provider searches its deferred tools natively. (Anthropic also lists one
    // built-in deferred anchor definition: defer_loading, not eager.)
    const eager = sent.secondEager[0];
    const allowed = new Set([...DEFERRED_DEFAULT_LEAD_TOOLS, 'call_tool']);
    assert.deepEqual(
      eager.filter((name) => !allowed.has(name)),
      []
    );
    assert.ok(eager.length <= DEFERRED_DEFAULT_LEAD_TOOLS.length + 1);
    assert.equal(eager.includes('call_tool'), bridge);
    assert.equal(eager.includes('load_tool'), bridge);
    assert.equal(session.deferredProviderMode, bridge ? 'manifest' : 'native');
    // The catalog behind load_tool still holds every MCP tool.
    assert.equal(mcp(names(session.deferredToolCatalog)).length, MCP_TOOL_COUNT);
  });
}
