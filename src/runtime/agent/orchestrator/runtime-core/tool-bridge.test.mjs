import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRIDGE_CONTINUATION_PREFIX,
  BRIDGE_LIMITS,
  describeBridgeTools,
  isToolBridgeEnabled,
  resolveBridgeTarget,
} from './tool-bridge.mjs';
import { CALL_TOOL_TOOL, TOOL_SEARCH_TOOL, TOOL_BRIDGE_TOOLS, collectStandaloneToolDefs } from './tool-defs.mjs';
import { applyDeferredToolSurface, renderToolSearch, snapshotProviderRequestTools } from './tool-catalog.mjs';
import { deferredProviderMode, nativeProviderFamily } from './tool-catalog-schema.mjs';
import { DEFERRED_SELECT_ALIASES } from './tool-catalog-data.mjs';
import { toolExposureMigrationNeeded, toolExposureModeForProvider } from './tool-exposure.mjs';
import { PROFILES, pinSessionWireRoute, resolveWireRoute } from '../providers/wire-route.mjs';
import { estimateTokens } from '../session/token-estimate.mjs';
import { resolveExecutionToolCall } from '../session/loop/tool-call-resolution.mjs';
import { makeInvalidToolArgsMarker } from '../providers/lib/openai-tool-args.mjs';
import { prepareDeferredToolCallThrough } from '../session/loop/deferred-call-through.mjs';
import { preDispatchDenyForSession } from '../session/loop/pre-dispatch-deny.mjs';
import { deriveToolCardModel } from '../../../shared/tool-card-model.mjs';
import { createKnowledgeToolHandlers } from '../../../../session-runtime/internal-tool-executor/knowledge-tools.mjs';

const def = (name, { readOnly = false, description = `${name} tool.`, inputSchema } = {}) => ({
  name,
  description,
  inputSchema: inputSchema || { type: 'object', properties: { value: { type: 'string' } } },
  annotations: { readOnlyHint: readOnly },
});

/** A bridge session: `eager` names are on the provider surface, the rest of `catalog` is deferred. */
function bridgeSession({ eager = ['read'], catalog = [], ...extra } = {}) {
  const tools = [def('read', { readOnly: true }), def('grep', { readOnly: true }), ...catalog];
  return {
    id: 'bridge-session',
    deferredProviderMode: 'canonical',
    toolExposureMode: 'bridge-v1',
    toolSpec: 'full',
    tools: tools.filter((tool) => eager.includes(tool.name)),
    deferredToolCatalog: tools,
    ...extra,
  };
}

const bytes = (text) => Buffer.byteLength(text, 'utf8');

test('bridge mode covers exactly the non-native providers', () => {
  for (const provider of ['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth']) {
    assert.equal(toolExposureModeForProvider(provider), 'native', provider);
    assert.equal(deferredProviderMode(provider), 'native', provider);
  }
  for (const provider of ['gemini', 'openrouter', 'xai', 'cursor-oauth', 'antigravity-oauth']) {
    assert.equal(toolExposureModeForProvider(provider), 'bridge-v1', provider);
  }
  // Only the versioned exposure enables the bridge, not the provider class:
  // a pre-versioned canonical surface keeps the old loader until it migrates.
  assert.equal(isToolBridgeEnabled({ toolExposureMode: 'bridge-v1' }), true);
  assert.equal(isToolBridgeEnabled({ deferredProviderMode: 'canonical' }), false);
});

test('a gateway is native only on a route pinned with verified support for its wire', async () => {
  const gateway = (model) => ({
    name: 'openrouter',
    resolveWireRoute: async (m, ctx) => resolveWireRoute('openrouter', m, ctx),
    model,
  });
  const fresh = (model) => ({ provider: 'openrouter', model, wireRoute: null, messages: [], tools: [] });
  const pin = async (model) => {
    const session = fresh(model);
    await pinSessionWireRoute(session, gateway(model));
    return session;
  };
  const CLAUDE = 'anthropic/claude-opus-4.8';
  const GPT = 'openai/gpt-6-sol';
  const OTHER = 'meta/llama-5';
  // Flag OFF (the shipped default): every gateway route stays on the bridge.
  for (const model of [CLAUDE, GPT, OTHER]) {
    const session = await pin(model);
    assert.equal(Object.hasOwn(session.wireRoute, 'nativeDeferredTools'), false, model);
    assert.equal(deferredProviderMode('openrouter', session.wireRoute), 'canonical', model);
    assert.equal(nativeProviderFamily('openrouter', session.wireRoute), '', model);
  }
  const flags = PROFILES.openrouter.nativeDeferredTools;
  flags.messages = true;
  flags.responses = true;
  try {
    const messages = await pin(CLAUDE);
    const responses = await pin(GPT);
    const chat = await pin(OTHER);
    assert.equal(messages.wireRoute.wire, 'messages');
    assert.equal(responses.wireRoute.wire, 'responses');
    assert.equal(chat.wireRoute.wire, 'chat');
    assert.equal(nativeProviderFamily('openrouter', messages.wireRoute), 'anthropic');
    assert.equal(nativeProviderFamily('openrouter', responses.wireRoute), 'openai');
    assert.equal(nativeProviderFamily('openrouter', chat.wireRoute), '');
    assert.equal(toolExposureModeForProvider('openrouter', chat.wireRoute), 'bridge-v1');
    for (const session of [messages, responses, chat]) {
      session.tools = [def('read', { readOnly: true }), def('extra_deferred', { readOnly: true })];
      applyDeferredToolSurface(session, 'lead');
    }
    // A native Messages route serializes deferred definitions like Anthropic.
    const deferredNames = (session) =>
      snapshotProviderRequestTools({ provider: 'openrouter', tools: session.tools, session, messages: [] })
        .filter((tool) => tool.deferLoading === true)
        .map((tool) => tool.name);
    assert.deepEqual(deferredNames(messages), ['extra_deferred']);
    assert.deepEqual(deferredNames(responses), []);
    assert.deepEqual(deferredNames(chat), []);
    assert.equal(messages.deferredProviderMode, 'native');
    assert.equal(messages.deferredNativeTools, true);
    assert.equal(messages.toolExposureMode, undefined);
    assert.equal(responses.deferredProviderMode, 'native');
    assert.equal(chat.deferredProviderMode, 'canonical');
    assert.equal(chat.toolExposureMode, 'bridge-v1');
    // The route names its own provider: another provider's surface ignores it.
    assert.equal(deferredProviderMode('deepseek', messages.wireRoute), 'canonical');
    // A session that already answered on the bridge keeps it.
    const answered = {
      ...fresh(CLAUDE),
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    };
    await pinSessionWireRoute(answered, gateway(CLAUDE));
    assert.equal(deferredProviderMode('openrouter', answered.wireRoute), 'canonical');
  } finally {
    flags.messages = false;
    flags.responses = false;
  }
  // Flipping the flag back changes nothing for a session pinned while it was on.
  const pinnedOn = { provider: 'openrouter', model: CLAUDE, wire: 'messages', nativeDeferredTools: true };
  assert.equal(nativeProviderFamily('openrouter', pinnedOn), 'anthropic');
  // A session pinned while it was off stays on the bridge after it turns on.
  const pinnedOff = await pin(CLAUDE);
  pinnedOff.tools = [def('read', { readOnly: true })];
  applyDeferredToolSurface(pinnedOff, 'lead');
  flags.messages = true;
  try {
    assert.equal(toolExposureMigrationNeeded(pinnedOff), false);
    assert.equal(await pinSessionWireRoute(pinnedOff, gateway(CLAUDE)), pinnedOff.wireRoute);
    assert.equal(deferredProviderMode('openrouter', pinnedOff.wireRoute), 'canonical');
  } finally {
    flags.messages = false;
  }
});

test('bridge tool definitions are the shared load_tool and call_tool: static, closed, call_tool outside the catalog', () => {
  assert.deepEqual(
    TOOL_BRIDGE_TOOLS.map((tool) => tool.name),
    ['load_tool', 'call_tool']
  );
  // One load_tool for native and bridge sessions.
  assert.equal(TOOL_BRIDGE_TOOLS[0], TOOL_SEARCH_TOOL);
  for (const tool of TOOL_BRIDGE_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.doesNotMatch(tool.description, /\bread\b|\bgrep\b|mcp__|\d+ tools/);
  }
  // Byte for byte the HEAD loader every native session sends.
  assert.equal(
    JSON.stringify(TOOL_SEARCH_TOOL),
    JSON.stringify({
      name: 'load_tool',
      title: 'load_tool',
      annotations: {
        title: 'load_tool',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        agentHidden: true,
      },
      description:
        'Load full schemas for missing deferred tool names/aliases; a connector name loads all its tools; batch needed names in one call.',
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
            description: 'Exact name(s)/aliases.',
          },
        },
        required: ['names'],
        additionalProperties: false,
      },
    })
  );
  assert.deepEqual(CALL_TOOL_TOOL.inputSchema.required, ['name', 'arguments']);
  const collected = collectStandaloneToolDefs({ webSearchToolDefs: {}, memoryToolDefs: {}, codeGraphToolDefs: {} });
  const names = collected.standaloneTools.map((tool) => tool.name);
  assert.equal(names.includes('call_tool'), false);
  for (const name of ['search_tools', 'call_tool']) {
    assert.equal(
      collected.internalToolDefs.some((tool) => tool.name === name),
      false,
      name
    );
  }
  assert.deepEqual(Object.keys(collected), ['standaloneTools', 'internalToolDefs', 'agentToolNames']);
});

test('load_tool describes without loading and reports missing and blocked names', () => {
  const session = bridgeSession({
    catalog: [def('apply_patch'), def('web_fetch', { readOnly: true }), def('mcp__gone__probe')],
    deferredMcpToolNames: [],
    deferredSurfaceMode: 'readonly',
  });
  const toolsBefore = session.tools.slice();
  const result = describeBridgeTools(session, { names: ['web_fetch', 'apply_patch', 'nope', 'mcp__gone__probe'] });
  assert.deepEqual(
    result.entries.map((entry) => [entry.name, entry.complete]),
    [['web_fetch', true]]
  );
  assert.deepEqual(result.entries[0].document, {
    name: 'web_fetch',
    description: 'web_fetch tool.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  });
  assert.match(result.entries[0].schemaRevision, /^[0-9a-f]{16}$/);
  // The bridge result says how to run what it described.
  assert.match(result.note, /call_tool \{name, arguments\}/);
  assert.deepEqual(result.missing, ['nope', 'mcp__gone__probe']);
  assert.deepEqual(result.blocked, [{ name: 'apply_patch', reason: 'readonly mode' }]);
  assert.equal(result.continueWith, null);
  assert.equal(session.tools.length, toolsBefore.length);
  session.tools.forEach((tool, index) => {
    assert.equal(tool, toolsBefore[index]);
  });
  assert.equal(session.deferredCallableTools, undefined);
  // The legacy string form and aliases stay accepted.
  assert.deepEqual(
    describeBridgeTools(session, { names: 'read, grep' }).entries.map((entry) => entry.name),
    ['read', 'grep']
  );
  assert.deepEqual(
    describeBridgeTools(session, { names: ['websearch'] }).entries.map((entry) => entry.name),
    ['web_fetch']
  );
});

test('load_tool describes every tool of a connector by server name, within the target cap; call_tool runs them', () => {
  const notion = ['search', 'create_page', 'update_page'].map((tool) => def(`mcp__notion__${tool}`));
  const big = Array.from({ length: BRIDGE_LIMITS.continuationMaxTargets + 3 }, (_, i) =>
    def(`mcp__big__t${String(i).padStart(2, '0')}`, { readOnly: true, description: 'x' })
  );
  const catalog = [...notion, ...big, def('mcp__other__ping')];
  const session = bridgeSession({ catalog, deferredMcpToolNames: catalog.map((tool) => tool.name) });
  const result = describeBridgeTools(session, { names: ['mcp__notion'] });
  assert.deepEqual(result.entries.map((entry) => entry.name).sort(), notion.map((tool) => tool.name).sort());
  assert.deepEqual(result.missing, []);
  assert.equal(result.omitted, undefined);
  // Exact names keep resolving to one tool.
  assert.deepEqual(
    describeBridgeTools(session, { names: ['mcp__other__ping'] }).entries.map((entry) => entry.name),
    ['mcp__other__ping']
  );
  // A server past the continuation cap describes the first definitions and lists the rest.
  let page = describeBridgeTools(session, { names: 'mcp__big' });
  const described = [];
  for (;;) {
    described.push(...page.entries.filter((entry) => entry.complete).map((entry) => entry.name));
    if (!page.continueWith) break;
    page = describeBridgeTools(session, page.continueWith);
    assert.equal(page.error, undefined);
  }
  assert.equal(described.length, BRIDGE_LIMITS.continuationMaxTargets);
  assert.equal(
    new Set([...described, ...(describeBridgeTools(session, { names: 'mcp__big' }).omitted || [])]).size,
    big.length
  );
  // call_tool runs a described server tool through the ordinary pipeline.
  const call = resolveExecutionToolCall(
    { id: 'C', name: 'call_tool', arguments: { name: 'mcp__notion__search', arguments: { value: 'q' } } },
    session
  );
  assert.equal(call.name, 'mcp__notion__search');
  assert.deepEqual(call.arguments, { value: 'q' });
  assert.match(resolveBridgeTarget(session, 'mcp__notion').error.code, /TOOL_NOT_FOUND/);
});

test('load_tool validates names and continuation tokens', () => {
  const session = bridgeSession();
  const code = (args) => describeBridgeTools(session, args).error?.code;
  assert.equal(code({}), 'INVALID_ARGUMENTS');
  assert.equal(code({ names: [] }), 'INVALID_ARGUMENTS');
  assert.equal(code({ names: Array.from({ length: 9 }, (_, i) => `t${i}`) }), 'INVALID_ARGUMENTS');
  assert.equal(code({ names: ['x'.repeat(257)] }), 'INVALID_ARGUMENTS');
  assert.equal(code({ names: ['read'], pointer: '/inputSchema' }), 'INVALID_ARGUMENTS');
  assert.equal(code({ names: ['read'], cursor: 'garbage' }), 'INVALID_ARGUMENTS');
  assert.match(describeBridgeTools(session, { query: 'read' }).error.message, /exact names/);
  const forge = (payload) =>
    `${BRIDGE_CONTINUATION_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  assert.equal(code({ names: `${BRIDGE_CONTINUATION_PREFIX}garbage` }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: [`${BRIDGE_CONTINUATION_PREFIX}garbage`] }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: `${BRIDGE_CONTINUATION_PREFIX}${'a'.repeat(4096)}` }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: forge({ v: 2, t: [], r: 'x', o: 0 }) }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: forge({ v: 2, t: [0, 0], r: 'x', o: 0 }) }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: forge({ v: 2, t: [0], r: 'x', o: -1 }) }), 'INVALID_CONTINUATION');
  assert.equal(code({ names: forge({ v: 2, t: [0], r: 'x', o: 0 }) }), 'CATALOG_CHANGED');
  assert.equal(code({ names: forge({ v: 2, t: [99], r: 'x', o: 0 }) }), 'CATALOG_CHANGED');
  // A token travels alone, however names is written: never a "missing" name beside others.
  const token = forge({ v: 2, t: [0], r: 'x', o: 0 });
  for (const names of [['read', token], `read,${token}`, `${token}, read`, `read ${token}`, [` ${token} `, 'grep']]) {
    const result = describeBridgeTools(session, { names });
    assert.equal(result.error?.code, 'INVALID_ARGUMENTS', JSON.stringify(names));
    assert.match(result.error.message, /continuation token alone/);
  }
  assert.equal(code({ names: [` ${token} `] }), 'CATALOG_CHANGED');
});

test('a token mixed with other content inside one names element is refused, and only canonical tokens decode', () => {
  const session = bridgeSession();
  const forge = (payload) =>
    `${BRIDGE_CONTINUATION_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  const token = forge({ v: 2, t: [0], r: 'x', o: 0 });
  const code = (names) => describeBridgeTools(session, { names }).error?.code;
  assert.equal(code([token]), 'CATALOG_CHANGED');
  for (const names of [
    [`${token}=,read`],
    [`read,${token}`],
    [`${token}=`],
    [`${token}==`],
    [`${token},read`],
    [`${token}!`],
    [`read ${token}`],
    `${token}=,read`,
  ]) {
    const result = describeBridgeTools(session, { names });
    assert.equal(result.error?.code, 'INVALID_ARGUMENTS', JSON.stringify(names));
    assert.equal(result.entries, undefined);
    assert.equal(result.missing, undefined);
  }
  // A non-canonical encoding of the same bytes (stray trailing bits) is no token this tool returned.
  const body = token.slice(BRIDGE_CONTINUATION_PREFIX.length);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = body.at(-1);
  if (body.length % 4 !== 0) {
    const sibling = alphabet[(alphabet.indexOf(last) + 1) % 64];
    const noncanonical = `${BRIDGE_CONTINUATION_PREFIX}${body.slice(0, -1)}${sibling}`;
    assert.deepEqual(
      Buffer.from(noncanonical.slice(BRIDGE_CONTINUATION_PREFIX.length), 'base64url'),
      Buffer.from(body, 'base64url')
    );
    assert.equal(code([noncanonical]), 'INVALID_CONTINUATION');
  }
});

test('review: a forged token naming more definitions than a request can resolve is refused', () => {
  const catalog = Array.from({ length: 1200 }, (_, index) => def(`fixture_${index}`, { readOnly: true }));
  const session = bridgeSession({ catalog });
  const forge = (payload) =>
    `${BRIDGE_CONTINUATION_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  const max = BRIDGE_LIMITS.continuationMaxTargets;
  // 8 names, each an alias of the widest alias.
  assert.equal(
    max,
    BRIDGE_LIMITS.describeMaxNames * Math.max(...Object.values(DEFERRED_SELECT_ALIASES).map((m) => m.length))
  );
  // As many unique valid positions as fit just under the decode limit: a
  // well-formed token whose next continuation would outgrow the limit.
  const indexes = [];
  let index = 100;
  while (
    forge({ v: 2, t: [...indexes, index], r: 'f'.repeat(16), o: 0 }).length <= BRIDGE_LIMITS.continuationMaxChars
  ) {
    indexes.push(index);
    index += 1;
  }
  const nearLimit = forge({ v: 2, t: indexes, r: 'f'.repeat(16), o: 0 });
  assert.ok(nearLimit.length > BRIDGE_LIMITS.continuationMaxChars - 8 && indexes.length > max);
  assert.equal(describeBridgeTools(session, { names: nearLimit }).error.code, 'INVALID_CONTINUATION');
  assert.equal(
    describeBridgeTools(session, { names: forge({ v: 2, t: indexes.slice(0, max + 1), r: 'x', o: 0 }) }).error.code,
    'INVALID_CONTINUATION'
  );
  // The largest token a real request can produce (every position and the
  // offset at their widest) stays within the limit and decodes.
  const widest = forge({
    v: 2,
    t: Array.from({ length: max }, (_, i) => Number.MAX_SAFE_INTEGER - i),
    r: 'f'.repeat(16),
    o: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(widest.length <= BRIDGE_LIMITS.continuationMaxChars, `${widest.length} chars`);
  assert.equal(describeBridgeTools(session, { names: widest }).error.code, 'CATALOG_CHANGED');
});

test('review: every emitted continuation token decodes, whatever the request names', () => {
  const big = largeTool();
  const filler = (index) => `${'도'.repeat(255)}${index}`;
  const session = bridgeSession({ catalog: [big, def('web_fetch', { readOnly: true })] });
  // One large definition beside the longest missing names the bounds allow,
  // and an alias that expands to several definitions.
  const requests = [
    [big.name, filler(1), filler(2), filler(3), filler(4), filler(5), filler(6), filler(7)],
    [big.name, 'filesystem', 'websearch', filler(1), filler(2), filler(3), filler(4), filler(5)],
  ];
  for (const names of requests) {
    let result = describeBridgeTools(session, { names });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.ok(result.missing.length >= 5);
    let pages = 1;
    const chunks = [];
    while (result.continueWith) {
      const token = result.continueWith.names;
      assert.ok(token.length <= BRIDGE_LIMITS.continuationMaxChars, `${token.length} chars`);
      // Requested and missing names never travel in the token.
      assert.doesNotMatch(Buffer.from(token.slice(BRIDGE_CONTINUATION_PREFIX.length), 'base64url').toString(), /도/);
      result = describeBridgeTools(session, { names: token });
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.deepEqual(result.missing, []);
      chunks.push(...result.entries.filter((entry) => entry.name === big.name && entry.jsonTextChunk));
      pages += 1;
    }
    assert.ok(pages >= 4, `${pages} pages`);
    assert.equal(chunks.at(-1).complete, true);
  }
});

function largeTool() {
  const options = Array.from({ length: 2500 }, (_, index) => `option_${String(index).padStart(4, '0')}`);
  return def('mcp__big__configure', {
    description: `Configure everything 😀 설정 ${'é'.repeat(3000)}`,
    inputSchema: {
      type: 'object',
      $defs: {
        target: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      properties: {
        mode: { type: 'string', enum: options, description: '모드 🙂'.repeat(500) },
        target: { $ref: '#/$defs/target' },
        flag: { type: 'boolean' },
      },
      required: ['mode', 'target'],
    },
  });
}

test('load_tool chunks a large definition losslessly within 16 KiB / 4096 tokens per page', () => {
  const big = largeTool();
  const session = bridgeSession({ catalog: [big, def('web_fetch', { readOnly: true })] });
  let cursor;
  const chunks = [];
  let small = null;
  let pages = 0;
  do {
    const result = describeBridgeTools(session, { names: cursor ?? ['mcp__big__configure', 'web_fetch'] });
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    const text = JSON.stringify(result);
    assert.ok(bytes(text) <= BRIDGE_LIMITS.describeMaxBytes, `${bytes(text)} bytes`);
    assert.ok(estimateTokens(text) <= BRIDGE_LIMITS.describeMaxTokens, `${estimateTokens(text)} tokens`);
    for (const entry of result.entries) {
      if (entry.document) {
        small = entry;
        continue;
      }
      assert.equal(entry.name, 'mcp__big__configure');
      // A chunk is well-formed UTF-8 on its own: no split surrogate pair.
      assert.equal(Buffer.from(entry.jsonTextChunk, 'utf8').toString('utf8'), entry.jsonTextChunk);
      chunks.push(entry);
    }
    // The rest comes back through load_tool's own names field.
    cursor = result.continueWith?.names ?? null;
    if (cursor) {
      assert.deepEqual(Object.keys(result.continueWith), ['names']);
      assert.ok(cursor.startsWith(BRIDGE_CONTINUATION_PREFIX));
      assert.match(cursor, /^@continue:[A-Za-z0-9_-]+$/);
      assert.ok(cursor.length <= BRIDGE_LIMITS.continuationMaxChars);
    }
    assert.match(result.note, /continueWith/);
    pages += 1;
  } while (cursor);
  assert.ok(pages >= 4, `${pages} pages`);
  assert.deepEqual(
    chunks.map((entry) => entry.complete),
    chunks.map((_, index) => index === chunks.length - 1)
  );
  let offset = 0;
  for (const entry of chunks) {
    assert.equal(entry.offset, offset);
    offset += entry.jsonTextChunk.length;
  }
  const document = JSON.parse(chunks.map((entry) => entry.jsonTextChunk).join(''));
  assert.deepEqual(document.inputSchema, big.inputSchema);
  assert.equal(document.inputSchema.properties.target.$ref, '#/$defs/target');
  assert.equal(document.inputSchema.properties.mode.enum.length, 2500);
  assert.deepEqual(document.inputSchema.required, ['mode', 'target']);
  assert.equal(document.description, big.description);
  assert.equal(small.name, 'web_fetch');
});

test('load_tool continuation tokens bind the names and the schema revision and grant nothing', () => {
  const big = largeTool();
  const session = bridgeSession({ catalog: [big] });
  const first = describeBridgeTools(session, { names: ['mcp__big__configure'] });
  const token = first.continueWith.names;
  const second = describeBridgeTools(session, { names: token });
  assert.equal(second.entries[0].name, 'mcp__big__configure');
  assert.equal(second.entries[0].offset, first.entries[0].jsonTextChunk.length);
  assert.equal(describeBridgeTools(session, { names: [token] }).entries[0].offset, second.entries[0].offset);
  // The token resumes under the session's current policy: excluded, it describes nothing.
  const denied = { ...session, disallowedTools: ['mcp__big__configure'] };
  assert.equal(describeBridgeTools(denied, { names: token }).error.code, 'CATALOG_CHANGED');
  session.deferredToolCatalog = session.deferredToolCatalog.map((tool) =>
    tool.name === big.name ? { ...tool, description: 'changed' } : tool
  );
  assert.equal(describeBridgeTools(session, { names: token }).error.code, 'CATALOG_CHANGED');
});

test('renderToolSearch: bridge sessions describe, native sessions keep the loader contract', () => {
  const bridge = bridgeSession({ catalog: [def('web_fetch', { readOnly: true })] });
  const described = JSON.parse(renderToolSearch({ names: ['web_fetch'] }, bridge, 'lead'));
  assert.deepEqual(Object.keys(described), ['entries', 'missing', 'blocked', 'note', 'continueWith']);
  assert.match(renderToolSearch({ names: ['web_fetch'], cursor: 'bad' }, bridge), /^Error: INVALID_ARGUMENTS: /);

  const native = {
    provider: 'anthropic-oauth',
    tools: [def('read', { readOnly: true }), TOOL_SEARCH_TOOL],
    messages: [],
  };
  applyDeferredToolSurface(native, 'lead', [def('web_fetch', { readOnly: true })]);
  const loaded = JSON.parse(renderToolSearch({ names: ['web_fetch'] }, native, 'lead'));
  assert.deepEqual(loaded.loaded, ['web_fetch']);
  assert.ok(loaded.nativeToolSearch);
  assert.equal(loaded.entries, undefined);
  // The native loader's own errors, as before the bridge.
  assert.equal(
    JSON.parse(renderToolSearch({}, native, 'lead')).error,
    'load_tool requires names:["exact_tool_name", ...] (deferred tool names/aliases).'
  );
  assert.match(
    JSON.parse(renderToolSearch({ query: 'fetch' }, native, 'lead')).error,
    /^load_tool is a loader, not a search: "fetch"/
  );
});

test('call_tool resolves one deferred target and rejects recursion, eager and unknown targets', () => {
  const session = bridgeSession({
    catalog: [def('web_fetch', { readOnly: true }), def('mcp__gone__probe')],
    deferredMcpToolNames: [],
  });
  assert.equal(resolveBridgeTarget(session, 'web_fetch').name, 'web_fetch');
  assert.equal(resolveBridgeTarget(session, 'WEB_FETCH').name, 'web_fetch');
  const direct = resolveBridgeTarget(session, 'read').error;
  assert.equal(direct.code, 'USE_DIRECT_TOOL');
  assert.match(direct.message, /call read directly/);
  for (const name of ['call_tool', 'load_tool', 'tool_search']) {
    assert.equal(resolveBridgeTarget(session, name).error.code, 'BRIDGE_RECURSION', name);
  }
  assert.equal(resolveBridgeTarget(session, 'nope').error.code, 'TOOL_NOT_FOUND');
  assert.match(resolveBridgeTarget(session, 'nope').error.message, /load_tool \{names: keyword\}/);
  // The retired search_tools is no tool at all.
  assert.equal(resolveBridgeTarget(session, 'search_tools').error.code, 'TOOL_NOT_FOUND');
  assert.equal(resolveBridgeTarget(session, 'mcp__gone__probe').error.code, 'TOOL_UNAVAILABLE');
  assert.equal(resolveBridgeTarget(session, '').error.code, 'INVALID_ARGUMENTS');
  assert.equal(resolveBridgeTarget(session, 'x'.repeat(257)).error.code, 'INVALID_ARGUMENTS');
});

test('the execution projection keeps the wire call and target identity', () => {
  const session = bridgeSession({ catalog: [def('web_fetch', { readOnly: true })] });
  const wire = { id: 'X', name: 'call_tool', arguments: { name: 'web_fetch', arguments: { url: 'https://a.test' } } };
  const call = resolveExecutionToolCall(wire, session);
  assert.deepEqual(
    { ...call, wireCall: undefined },
    {
      id: 'X',
      name: 'web_fetch',
      arguments: { url: 'https://a.test' },
      wireCall: undefined,
    }
  );
  assert.deepEqual(call.wireCall, wire);
  assert.ok(Object.isFrozen(call.wireCall) && Object.isFrozen(call.wireCall.arguments.arguments));
  call.arguments.url = 'https://mutated.test';
  assert.equal(wire.arguments.arguments.url, 'https://a.test');
  assert.equal(call.bridgeTool.name, 'web_fetch');
  assert.equal(Object.keys(call).includes('bridgeTool'), false);
  assert.equal(resolveExecutionToolCall(call, session), call);

  const failure = (args) => resolveExecutionToolCall({ id: 'Y', name: 'call_tool', arguments: args }, session);
  assert.match(failure({ name: 'web_fetch' }).bridgeError, /^Error: INVALID_ARGUMENTS: /);
  assert.match(failure({ name: 'web_fetch', arguments: [] }).bridgeError, /^Error: INVALID_ARGUMENTS: /);
  assert.match(failure({ name: 'web_fetch', arguments: {}, extra: 1 }).bridgeError, /^Error: INVALID_ARGUMENTS: /);
  assert.match(failure({ name: 'read', arguments: {} }).bridgeError, /^Error: USE_DIRECT_TOOL: .*call read directly/);
  assert.match(failure({ name: 'call_tool', arguments: {} }).bridgeError, /^Error: BRIDGE_RECURSION: /);
  assert.match(failure(makeInvalidToolArgsMarker('{', 'bad json')).bridgeError, /invalid JSON/);
  assert.equal(failure({ name: 'nope', arguments: {} }).id, 'Y');

  // Native sessions and every other call pass through untouched.
  const native = { ...session, deferredProviderMode: 'native', toolExposureMode: undefined };
  assert.equal(resolveExecutionToolCall(wire, native), wire);
  const plain = { id: 'Z', name: 'read', arguments: {} };
  assert.equal(resolveExecutionToolCall(plain, session), plain);
});

test('review: continuation tokens bind schema revisions; forged offsets inside a surrogate pair are rejected', () => {
  const emoji = def('emoji_tool', { readOnly: true, description: `😀${'설명 '.repeat(9000)}` });
  const described = bridgeSession({ catalog: [emoji] });
  const page = describeBridgeTools(described, { names: ['emoji_tool'] });
  const token = page.continueWith.names;
  // Only an input schema changes: the name and description are equal.
  const changed = bridgeSession({
    catalog: [{ ...emoji, inputSchema: { type: 'object', properties: { other: { type: 'string' } } } }],
  });
  assert.equal(describeBridgeTools(changed, { names: token }).error.code, 'CATALOG_CHANGED');
  const payload = JSON.parse(Buffer.from(token.slice(BRIDGE_CONTINUATION_PREFIX.length), 'base64url').toString('utf8'));
  const text = JSON.stringify({
    name: emoji.name,
    description: emoji.description,
    inputSchema: emoji.inputSchema,
    annotations: emoji.annotations,
  });
  const forged = `${BRIDGE_CONTINUATION_PREFIX}${Buffer.from(
    JSON.stringify({ ...payload, o: text.indexOf('\uD83D') + 1 }),
    'utf8'
  ).toString('base64url')}`;
  assert.equal(describeBridgeTools(described, { names: forged }).error.code, 'INVALID_CONTINUATION');
});

test('review: outside bridge-v1 load_tool keeps the loader; bridge consumers word describe results', () => {
  // A pre-versioned canonical surface (not yet migrated) still loads.
  const legacy = { ...bridgeSession({ catalog: [def('web_fetch', { readOnly: true })] }), toolExposureMode: undefined };
  const loaded = JSON.parse(renderToolSearch({ names: ['web_fetch'] }, legacy, 'lead'));
  assert.ok(loaded.selected);
  assert.equal(loaded.entries, undefined);
  // A bridge-v1 surface advertises the shared loader, byte for byte the native one.
  const bridge = { provider: 'gemini', tools: [def('read', { readOnly: true })], messages: [] };
  applyDeferredToolSurface(bridge, 'lead', [def('web_fetch', { readOnly: true }), TOOL_SEARCH_TOOL]);
  const loader = bridge.tools.find((tool) => tool.name === 'load_tool');
  assert.equal(JSON.stringify(loader), JSON.stringify(TOOL_SEARCH_TOOL));
  // UI wording: a describe result reads as described, never loaded.
  const result = renderToolSearch({ names: ['web_fetch', 'nope'] }, bridge, 'lead');
  const card = deriveToolCardModel({ name: 'load_tool', args: { names: ['web_fetch', 'nope'] }, result });
  assert.equal(card.labelText, 'Described web_fetch');
  assert.match(card.summaryText, /Missing: nope/);
  const legacyCard = deriveToolCardModel({
    name: 'load_tool',
    args: { names: ['web_fetch'] },
    result: JSON.stringify(loaded),
  });
  assert.match(legacyCard.labelText, /^Loaded/);
  // A bridged call shows the tool it runs.
  const bridged = deriveToolCardModel({
    name: 'call_tool',
    args: { name: 'web_fetch', arguments: { url: 'https://a.test' } },
  });
  assert.equal(bridged.via, 'call_tool');
  assert.equal(bridged.normalizedName, 'web_fetch');
});

test('review: an unresolved tool mode still refuses a deferred mutating tool in bridge mode', () => {
  for (const toolExposureMode of ['bridge-v1', undefined]) {
    const session = bridgeSession({ catalog: [def('apply_patch')], toolSpec: null, toolExposureMode });
    const denial = prepareDeferredToolCallThrough(session, 'apply_patch');
    assert.match(denial.deny, /without a resolved tool mode/, String(toolExposureMode));
    assert.equal(
      session.tools.some((tool) => tool.name === 'apply_patch'),
      false
    );
  }
});

test('review: discovery honours the schema allowlist — native loader and bridge query/describe', async () => {
  const privateTool = def('private_tool', { readOnly: true, description: 'Private tool body.' });
  privateTool.inputSchema = { type: 'object', properties: { secretField: { type: 'string' } } };
  const handlers = createKnowledgeToolHandlers({
    rt: { mode: 'lead', config: {} },
    activeToolSurface: () => null,
    mcpStatus: () => ({ servers: [] }),
  });

  // Native: load_tool is allowed, private_tool is not.
  const native = {
    id: 'native-allowlist',
    provider: 'anthropic-oauth',
    toolSpec: 'full',
    schemaAllowedTools: ['read', 'load_tool'],
    tools: [def('read', { readOnly: true }), privateTool],
    messages: [],
  };
  applyDeferredToolSurface(native, 'lead', [TOOL_SEARCH_TOOL]);
  assert.ok(native.deferredToolCatalog.some((tool) => tool.name === 'private_tool'));
  const text = await handlers.load_tool({ names: ['private_tool'] }, { callerCtx: { callerSession: native } });
  const result = JSON.parse(text);
  assert.deepEqual(result.missing, ['private_tool']);
  assert.deepEqual(result.loaded, []);
  assert.doesNotMatch(text, /Private tool body|secretField/);
  assert.equal((native.deferredDiscoveredTools || []).includes('private_tool'), false);
  assert.equal((native.deferredCallableTools || []).includes('private_tool'), false);
  assert.equal(JSON.stringify(result.activeTools).includes('private_tool'), false);
  // An alias that covers it does not leak it either.
  assert.doesNotMatch(renderToolSearch({ names: ['PRIVATE_TOOL'] }, native, 'lead'), /secretField/);

  // Bridge: describe treats it as unknown, not as blocked.
  const bridge = bridgeSession({
    catalog: [privateTool],
    schemaAllowedTools: ['read', 'load_tool', 'call_tool'],
  });
  const callerCtx = { callerSession: bridge };
  const described = await handlers.load_tool({ names: ['private_tool'] }, { callerCtx });
  assert.deepEqual(JSON.parse(described).missing, ['private_tool']);
  assert.deepEqual(JSON.parse(described).blocked, []);
  assert.doesNotMatch(described, /Private tool body|secretField/);
  // Execution stays refused by the same rule.
  const projected = resolveExecutionToolCall(
    { id: 'X', name: 'call_tool', arguments: { name: 'private_tool', arguments: {} } },
    bridge
  );
  assert.match(preDispatchDenyForSession(bridge, projected), /schema allowlist/);
});

test('bridge handlers answer within the calling session scope', async () => {
  const lead = bridgeSession({ id: 'lead', catalog: [def('web_fetch', { readOnly: true })] });
  const worker = bridgeSession({ id: 'worker', catalog: [def('worker_only_tool', { readOnly: true })] });
  const native = { id: 'native', deferredProviderMode: 'native', tools: [def('read', { readOnly: true })] };
  const handlers = createKnowledgeToolHandlers({
    rt: { mode: 'lead', config: {} },
    activeToolSurface: () => lead,
    mcpStatus: () => ({ servers: [] }),
  });
  const names = (text) => JSON.parse(text).entries.map((entry) => entry.name);
  assert.deepEqual(names(await handlers.load_tool({ names: ['worker_only_tool'] }, { callerCtx: {} })), []);
  assert.deepEqual(names(await handlers.load_tool({ names: ['web_fetch'] }, { callerCtx: {} })), ['web_fetch']);
  const described = JSON.parse(
    await handlers.load_tool({ names: ['worker_only_tool'] }, { callerCtx: { callerSession: worker } })
  );
  assert.deepEqual(
    described.entries.map((entry) => entry.name),
    ['worker_only_tool']
  );
  // A caller outside bridge mode keeps the loader, within its own scope.
  const legacy = JSON.parse(
    await handlers.load_tool({ names: ['web_fetch'] }, { callerCtx: { callerSession: native } })
  );
  assert.equal(legacy.entries, undefined);
  assert.deepEqual(legacy.missing, ['web_fetch']);
  // The retired search_tools has no handler.
  assert.equal(handlers.search_tools, undefined);
});

test('review: a non-bridge worker never reads the lead surface or its own excluded tools', async () => {
  const secret = def('secret_tool', { readOnly: true, description: 'Lead-only secret tool.' });
  const lead = bridgeSession({ id: 'lead', catalog: [secret, def('web_fetch', { readOnly: true })] });
  // A native worker whose own policy excludes secret_tool.
  const worker = {
    id: 'worker',
    owner: 'agent',
    provider: 'anthropic-oauth',
    toolSpec: 'full',
    disallowedTools: ['secret_tool'],
    tools: [def('read', { readOnly: true }), secret],
    messages: [],
  };
  const handlers = createKnowledgeToolHandlers({
    rt: { mode: 'lead', config: {} },
    activeToolSurface: () => lead,
    mcpStatus: () => ({ servers: [] }),
  });
  const callerCtx = { callerSession: worker };
  const loaded = await handlers.load_tool({ names: ['secret_tool'] }, { callerCtx });
  assert.doesNotMatch(loaded, /Lead-only secret tool/);
  assert.deepEqual(JSON.parse(loaded).missing, ['secret_tool']);
  // The lead surface was not touched by the worker's call.
  assert.deepEqual(
    lead.tools.map((tool) => tool.name),
    ['read']
  );
});

test('a name that is no tool is a keyword search over the tools this session can run', () => {
  const session = bridgeSession({
    catalog: [
      def('web_fetch', { readOnly: true, description: 'Fetch a page over networking.' }),
      def('web_post', { description: 'Post a form over networking.' }),
      def('secret_web', { readOnly: true, description: 'Hidden networking helper.' }),
      def('db_query', { readOnly: true, description: 'Run a database query.' }),
    ],
    schemaAllowedTools: ['read', 'grep', 'load_tool', 'call_tool', 'web_fetch', 'web_post', 'db_query'],
  });
  const search = (args, options) => describeBridgeTools(session, args, options);
  // An exact name still describes; a keyword lists matches without schemas.
  const result = search({ names: ['networking'] });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(
    result.matches.map((match) => [match.keyword, match.tools.map((tool) => tool.name).sort()]),
    [['networking', ['web_fetch', 'web_post']]],
    'secret_web is outside the allowlist, read is directly available'
  );
  assert.equal(JSON.stringify(result).includes('inputSchema'), false);
  assert.equal(JSON.stringify(result).includes('secret_web'), false);
  // Mixed with an exact name: the name describes, the keyword searches.
  const mixed = search({ names: ['db_query', 'page'] });
  assert.deepEqual(
    mixed.entries.map((entry) => entry.name),
    ['db_query']
  );
  assert.deepEqual(
    mixed.matches[0].tools.map((tool) => tool.name),
    ['web_fetch']
  );
  // A keyword nothing matches is reported missing.
  assert.deepEqual(search({ names: ['zzz'] }).missing, ['zzz']);
  // Read-only mode hides tools it could not run.
  const readonly = search({ names: ['networking'] }, { mode: 'readonly' });
  assert.deepEqual(
    readonly.matches[0].tools.map((tool) => tool.name),
    ['web_fetch']
  );
  // A denied tool is never listed.
  const denied = bridgeSession({
    catalog: [
      def('web_fetch', { readOnly: true, description: 'Fetch networking.' }),
      def('web_post', { description: 'Post networking.' }),
    ],
    disallowedTools: ['web_post'],
  });
  assert.deepEqual(
    describeBridgeTools(denied, { names: ['networking'] }).matches[0].tools.map((tool) => tool.name),
    ['web_fetch']
  );
  // The bridge tools themselves are never listed.
  assert.equal(JSON.stringify(search({ names: ['tool'] }).matches ?? []).includes('call_tool'), false);
});
