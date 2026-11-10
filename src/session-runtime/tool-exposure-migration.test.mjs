// Live and resumed sessions persisted with a pre-bridge fixed surface migrate
// to bridge-v1 once, at a safe boundary, without rewriting history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLifecycleApi } from './lifecycle-api.mjs';
import { setInternalToolsProvider } from '../runtime/agent/orchestrator/internal-tools.mjs';
import { agentLoop } from '../runtime/agent/orchestrator/session/agent-loop.mjs';
import { applyDeferredToolSurface } from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-exposure-migration-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const def = (name, readOnly = false) => ({
  name,
  description: `${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: readOnly },
});
const CATALOG = [def('read', true), def('shell'), def('bridge_probe', true), def('office')];
const ALL = CATALOG.map((tool) => tool.name);
const OLD_MANIFEST = '<available-deferred-tools>\n- bridge_probe: Probe.\n</available-deferred-tools>';

/** A canonical-provider session as persisted before exposure versions. */
function legacySession(provider, scopeId = null) {
  return {
    id: `legacy-${randomUUID()}`,
    provider,
    model: 'fixture-model',
    mcpScopeId: scopeId,
    cwd: process.cwd(),
    toolSpec: 'full',
    compaction: { auto: false },
    deferredProviderMode: 'canonical',
    deferredSurfaceMode: 'lead',
    tools: CATALOG.slice(),
    deferredToolCatalog: CATALOG.slice(),
    deferredSelectedTools: ALL,
    deferredDiscoveredTools: ALL,
    deferredCallableTools: ALL,
    deferredToolBp2Applied: true,
    providerState: { previousResponseId: 'resp-old' },
    _providerPrefixGuardState: { requestPrefixHash: 'old' },
    contextPressureBaselineTokens: 1234,
    messages: [
      { role: 'system', content: '# Tool Use' },
      { role: 'system', content: `# Profile\n\n---\n\n${OLD_MANIFEST}` },
      { role: 'system', content: '# Session', cacheTier: 'tier3' },
      { role: 'user', content: 'earlier request' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old-1', name: 'bridge_probe', arguments: {} }],
      },
      { role: 'tool', toolCallId: 'old-1', content: 'earlier result' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  };
}

const names = (tools) => tools.map((tool) => tool.name);

test('a live canonical session migrates once at the next request boundary', async (t) => {
  const scopeId = `migration-${randomUUID()}`;
  const executed = [];
  t.after(
    setInternalToolsProvider({
      scopeId,
      tools: [def('bridge_probe', true)],
      executor: async (name, args) => {
        executed.push({ name, args });
        return 'probed';
      },
    })
  );
  const session = legacySession('openrouter', scopeId);
  const history = structuredClone(session.messages.slice(3));
  const messages = [...session.messages, { role: 'user', content: 'run the probe' }];
  const sends = [];
  const provider = {
    name: 'openrouter',
    async send(_messages, _model, tools, opts) {
      sends.push({
        tools: JSON.stringify(tools),
        names: names(tools),
        intent: opts.cacheBreakIntent || null,
        providerState: opts.providerState ?? null,
        bp2: _messages.find((message) => message.role === 'system' && /# Profile/.test(message.content))?.content,
      });
      if (sends.length === 1) {
        return {
          content: '',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'X', name: 'call_tool', arguments: { name: 'bridge_probe', arguments: {} } }],
        };
      }
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const run = () =>
    agentLoop(provider, messages, session.model, session.tools, null, session.cwd, {
      session,
      sessionId: session.id,
    });
  await run();
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].names, ['read', 'shell', 'load_tool', 'call_tool']);
  assert.equal(sends[1].tools, sends[0].tools);
  assert.deepEqual(
    sends.map((send) => send.intent),
    ['tool_surface_bridge_migration', null]
  );
  assert.equal(sends[0].providerState, null);
  // The old manifest is replaced once by the roster (the bridge's pool) plus
  // the bridge guidance.
  assert.equal(sends[0].bp2.match(/<available-deferred-tools>/g).length, 1);
  assert.doesNotMatch(sends[0].bp2, /- bridge_probe: Probe\./);
  assert.match(sends[0].bp2, /^- bridge_probe: bridge_probe tool\.$/m);
  assert.match(sends[0].bp2, /^- office: office tool\.$/m);
  assert.equal(sends[0].bp2.match(/<tool-bridge>/g).length, 1);
  assert.deepEqual(executed, [{ name: 'bridge_probe', args: {} }]);
  assert.equal(session.toolExposureMode, 'bridge-v1');
  assert.equal(session._providerPrefixGuardState?.requestPrefixHash === 'old', false);
  // History before the boundary is untouched; the bridged call stays a wire call.
  assert.deepEqual(messages.slice(3, 3 + history.length), history);
  assert.equal(messages.find((message) => message.toolCalls?.[0]?.id === 'X').toolCalls[0].name, 'call_tool');

  // The next turn finds the current version: no second migration.
  messages.push({ role: 'user', content: 'again' });
  await run();
  assert.equal(sends.length, 3);
  assert.equal(sends[2].intent, null);
  assert.equal(sends[2].tools, sends[0].tools);
});

// The guidance-only block bridge-v1 sessions persisted before the roster.
const GUIDANCE_ONLY = [
  '<tool-bridge>',
  'This session has more tools than the ones defined here. Find them with search_tools, read a definition with load_tool, and run one with call_tool {name, arguments}. Call directly defined tools directly.',
  '</tool-bridge>',
].join('\n');

test('a bridge-v1 session with the guidance-only block gets the roster once at the boundary', async () => {
  const session = legacySession('openrouter');
  applyDeferredToolSurface(session, 'lead', [], { provider: 'openrouter' });
  assert.equal(session.toolExposureMode, 'bridge-v1');
  // As persisted before the roster: the bridge block alone, live provider state.
  session.messages[1] = { role: 'system', content: `# Profile\n\n---\n\n${GUIDANCE_ONLY}` };
  session.providerState = { previousResponseId: 'resp-bridge' };
  session.contextPressureBaselineTokens = 999;
  const tools = JSON.stringify(session.tools);
  const messages = [...session.messages, { role: 'user', content: 'hello' }];
  const history = structuredClone(messages.slice(3));
  const sends = [];
  const provider = {
    name: 'openrouter',
    async send(sent, _model, sentTools, opts) {
      sends.push({
        tools: JSON.stringify(sentTools),
        intent: opts.cacheBreakIntent || null,
        providerState: opts.providerState ?? null,
        bp2: sent.find((message) => message.role === 'system' && /# Profile/.test(message.content))?.content,
      });
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const run = () =>
    agentLoop(provider, messages, session.model, session.tools, null, session.cwd, { session, sessionId: session.id });
  await run();
  assert.equal(sends[0].intent, 'tool_surface_bridge_migration');
  assert.equal(sends[0].providerState, null);
  assert.equal(sends[0].tools, tools, 'the tool definitions keep their bytes');
  assert.equal(
    sends[0].bp2,
    '# Profile\n\n---\n\n<available-deferred-tools>\nDeferred tools; load_tool loads their schemas.\n' +
      '- bridge_probe: bridge_probe tool.\n- office: office tool.\n</available-deferred-tools>\n\n' +
      sends[0].bp2.match(/<tool-bridge>[\s\S]*<\/tool-bridge>$/)[0]
  );
  assert.equal(sends[0].bp2.includes(GUIDANCE_ONLY), false);
  assert.deepEqual(messages.slice(3, 3 + history.length), history);
  // The next turn finds the roster in place: no second migration.
  messages.push({ role: 'user', content: 'again' });
  await run();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].intent, null);
  assert.equal(sends[1].bp2, sends[0].bp2);
});

// What a bridge-v1 surface carried before load_tool was shared: search_tools,
// a describe-only load_tool, and guidance pointing at search_tools.
const LEGACY_SEARCH_TOOLS = {
  name: 'search_tools',
  description:
    'Search the tools available in this session by name, alias, description or MCP server. Returns names with short descriptions; pass nextCursor back to get the next page.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
const LEGACY_BRIDGE_LOAD_TOOL = {
  name: 'load_tool',
  description:
    'Describe tools by exact name: description, input schema and annotations, or the part one JSON Pointer selects. Large definitions arrive in chunks; pass nextCursor back for the rest. Describing never enables a tool.',
  inputSchema: {
    type: 'object',
    properties: {
      names: { type: 'array', items: { type: 'string' } },
      pointer: { type: 'string' },
      cursor: { type: 'string' },
    },
    required: ['names'],
    additionalProperties: false,
  },
};
const SEARCH_TOOLS_GUIDANCE = [
  '<tool-bridge>',
  'Deferred tools (listed above, or announced later as added) are not defined here: run one with call_tool {name, arguments}, and use load_tool first to see its parameters. search_tools finds tools by keyword. Call directly defined tools directly.',
  '</tool-bridge>',
].join('\n');

test('a bridge-v1 session with search_tools migrates once and still replays its search_tools calls', async () => {
  const { TOOL_SEARCH_TOOL } = await import('../runtime/agent/orchestrator/runtime-core/tool-defs.mjs');
  const session = legacySession('openrouter');
  applyDeferredToolSurface(session, 'lead', [], { provider: 'openrouter' });
  // As persisted by the earlier bridge: its own loader, search_tools and
  // guidance, and a transcript holding a search_tools call.
  session.tools = [
    ...session.tools.filter((tool) => !['load_tool', 'call_tool'].includes(tool.name)),
    LEGACY_SEARCH_TOOLS,
    LEGACY_BRIDGE_LOAD_TOOL,
    session.tools.find((tool) => tool.name === 'call_tool'),
  ];
  session.messages[1] = {
    role: 'system',
    content: session.messages[1].content.replace(/<tool-bridge>[\s\S]*<\/tool-bridge>/, SEARCH_TOOLS_GUIDANCE),
  };
  session.messages.push(
    { role: 'user', content: 'find the probe' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'S1', name: 'search_tools', arguments: { query: 'probe' } }] },
    { role: 'tool', toolCallId: 'S1', content: '{"tools":[{"name":"bridge_probe"}],"nextCursor":null}' },
    { role: 'assistant', content: 'found it' }
  );
  session.providerState = { previousResponseId: 'resp-bridge' };
  const messages = [...session.messages, { role: 'user', content: 'search again' }];
  const history = structuredClone(messages.slice(3));
  const sends = [];
  const provider = {
    name: 'openrouter',
    async send(sent, _model, sentTools, opts) {
      sends.push({
        tools: sentTools.map((tool) => JSON.stringify(tool)),
        names: names(sentTools),
        intent: opts.cacheBreakIntent || null,
        providerState: opts.providerState ?? null,
        bp2: sent.find((message) => message.role === 'system' && /# Profile/.test(message.content))?.content,
        replayed: sent.some((message) => message.toolCalls?.some((call) => call.name === 'search_tools')),
      });
      // The model repeats the retired tool once.
      if (sends.length === 1) {
        return {
          content: '',
          stopReason: 'tool_calls',
          toolCalls: [{ id: 'S2', name: 'search_tools', arguments: { query: 'probe' } }],
        };
      }
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const run = () =>
    agentLoop(provider, messages, session.model, session.tools, null, session.cwd, { session, sessionId: session.id });
  await run();
  assert.equal(sends[0].intent, 'tool_surface_bridge_migration');
  assert.equal(sends[0].providerState, null);
  assert.deepEqual(sends[0].names, ['read', 'shell', 'load_tool', 'call_tool']);
  assert.equal(sends[0].tools[2], JSON.stringify(TOOL_SEARCH_TOOL), 'the shared load_tool');
  assert.equal(sends[0].bp2.includes(SEARCH_TOOLS_GUIDANCE), false);
  assert.match(
    sends[0].bp2,
    /use load_tool first to see its parameters \(a keyword instead of a name searches the deferred tools\)\. Call directly defined tools directly\./
  );
  assert.equal(sends[0].bp2.match(/<tool-bridge>/g).length, 1);
  // History keeps the old call, and every request replays it.
  assert.ok(sends.every((send) => send.replayed));
  assert.deepEqual(messages.slice(3, 3 + history.length), history);
  // A repeated search_tools call is answered as an unknown tool, not run.
  const answer = messages.find((message) => message.role === 'tool' && message.toolCallId === 'S2');
  assert.match(String(answer?.content), /error/i);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].intent, null);
  // The next turn finds the current surface: no second migration.
  messages.push({ role: 'user', content: 'again' });
  await run();
  assert.equal(sends.length, 3);
  assert.equal(sends[2].intent, null);
  assert.deepEqual(sends[2].tools, sends[0].tools);
  assert.equal(sends[2].bp2, sends[0].bp2);
});

test('a bridge-v1 session on the query/cursor load_tool migrates once to the native definition', async () => {
  const { TOOL_SEARCH_TOOL } = await import('../runtime/agent/orchestrator/runtime-core/tool-defs.mjs');
  const { migrateToolExposureAtBoundary } = await import(
    '../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs'
  );
  const session = legacySession('openrouter');
  applyDeferredToolSurface(session, 'lead', [], { provider: 'openrouter' });
  const current = { tools: JSON.stringify(session.tools), bp2: session.messages[1].content };
  // As the interim shared loader left it: query/cursor inputs and guidance naming query.
  const interim = {
    ...TOOL_SEARCH_TOOL,
    description:
      'Load full schemas for missing deferred tool names/aliases; batch needed names in one call. Or find tools by keyword with query. Pass nextCursor back for the next page.',
    inputSchema: {
      type: 'object',
      properties: {
        names: TOOL_SEARCH_TOOL.inputSchema.properties.names,
        query: { type: 'string', description: 'Keywords matching tool names, aliases, descriptions or MCP servers.' },
        cursor: { type: 'string', description: 'nextCursor from the previous page of the same request.' },
      },
      additionalProperties: false,
    },
  };
  session.tools = session.tools.map((tool) => (tool.name === 'load_tool' ? interim : tool));
  session.deferredToolCatalog = [...session.deferredToolCatalog, interim];
  session.messages[1] = {
    role: 'system',
    content: current.bp2.replace(
      'Call directly defined tools directly.',
      'load_tool with query finds tools by keyword. Call directly defined tools directly.'
    ),
  };
  assert.notEqual(session.messages[1].content, current.bp2);
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), true);
  assert.equal(JSON.stringify(session.tools), current.tools);
  assert.equal(
    JSON.stringify(session.tools.find((tool) => tool.name === 'load_tool')),
    JSON.stringify(TOOL_SEARCH_TOOL)
  );
  assert.equal(session.messages[1].content, current.bp2);
  assert.equal(
    session.deferredToolCatalog.some((tool) => tool.description === interim.description),
    false
  );
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), false);
});

test('a boundary with an unanswered tool call does not migrate', async () => {
  const session = legacySession('openrouter');
  session.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'open', name: 'read', arguments: {} }] });
  const { migrateToolExposureAtBoundary } = await import(
    '../runtime/agent/orchestrator/session/loop/tool-exposure-migration.mjs'
  );
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), false);
  assert.equal(session.toolExposureMode, undefined);
  session.messages.push({ role: 'tool', toolCallId: 'open', content: 'ok' });
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), true);
  assert.equal(session.toolExposureMode, 'bridge-v1');
});

test('resume migrates a legacy surface and ignores its all-selected state', async () => {
  const resumed = legacySession('gemini');
  const history = structuredClone(resumed.messages.slice(3));
  let current = null;
  let route = {};
  let pendingRoutePreparation = null;
  const api = createLifecycleApi({
    getSession: () => current,
    setSession: (session) => {
      current = session;
    },
    getRoute: () => route,
    setRoute: (next) => {
      route = next;
    },
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => resumed.cwd,
    getMcpScopeId: () => null,
    getDesktopSession: () => null,
    setSessionNeedsCwdRefresh: () => {},
    clearRoutePreparation: () => {},
    beginRoutePreparation: (prepare) => {
      pendingRoutePreparation = prepare;
    },
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    applyResolvedCwd: () => {},
    resolveRoute: (_config, next) => ({ ...next, effectiveEffort: next.effort }),
    refreshRouteEffort: async (_args, next) => next,
    applyDeferredToolSurface,
    getStandaloneTools: () => [],
    mgr: {
      async resumeSession() {
        return resumed;
      },
    },
  });
  await api.resume(resumed.id);
  const tools = JSON.stringify(current.tools);
  assert.deepEqual(names(current.tools), ['read', 'shell', 'load_tool', 'call_tool']);
  assert.equal(current.toolExposureMode, 'bridge-v1');
  assert.deepEqual(current.deferredSelectedTools, ['read', 'shell']);
  assert.equal(current.pendingCacheBreakIntent, 'tool_surface_bridge_migration');
  assert.equal(current.providerState, undefined);
  assert.equal(current.contextPressureBaselineTokens, null);
  assert.doesNotMatch(current.messages[1].content, /- bridge_probe: Probe\./);
  assert.match(current.messages[1].content, /^- office: office tool\.\n<\/available-deferred-tools>\n\n<tool-bridge>/m);
  // Resume only stamps transcript ids; the conversation itself is unchanged.
  const withoutMeta = (list) => list.map(({ meta: _meta, ...message }) => message);
  assert.deepEqual(withoutMeta(current.messages.slice(3)), history);
  // Route preparation re-applies the surface: same bytes, no new migration.
  delete current.pendingCacheBreakIntent;
  assert.equal(await pendingRoutePreparation(), true);
  assert.equal(JSON.stringify(current.tools), tools);
  assert.equal(current.pendingCacheBreakIntent, undefined);
});
