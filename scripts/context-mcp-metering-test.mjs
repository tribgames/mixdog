import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextStatus,
  requestSerializedToolsForContext,
} from '../src/session-runtime/context-status.mjs';
import { splitToolStatusCounts } from '../src/session-runtime/session-turn-api.mjs';
import {
  estimateToolSchemaBreakdown,
  snapshotProviderRequestTools,
  toolKind,
} from '../src/session-runtime/tool-catalog.mjs';
import {
  invalidateProviderRequestToolsScope,
  providerNativeToolPrefixCount,
  runWithProviderRequestToolsScope,
  scopedProviderRequestTools,
} from '../src/session-runtime/provider-request-tools.mjs';
import { _buildRequestBodyForCacheSmoke as buildAnthropicRequestBody } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _test as anthropicApiKeyTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import {
  estimateMessagesTokens,
  estimateRequestReserveTokens,
  estimateToolSchemaTokens,
  toolSchemaSignature,
} from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { agentLoop } from '../src/runtime/agent/orchestrator/session/agent-loop.mjs';
import {
  recordProviderContextBaseline,
  resolveCompactionPressureTokens,
  resolveWorkerCompactPolicy,
} from '../src/runtime/agent/orchestrator/session/loop/compact-policy.mjs';

const schema = (description) => ({
  type: 'object',
  properties: { value: { type: 'string', description } },
});

test('context meters only provider-visible Anthropic deferred schemas', () => {
  const read = { name: 'read', description: 'Read a file', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', description: 'MCP lookup', inputSchema: schema('mcp payload '.repeat(100)) };
  const skill = { name: 'skill_hidden', description: 'Undiscovered skill', inputSchema: schema('skill payload '.repeat(100)) };
  const control = {
    name: 'hidden_control',
    description: 'Undiscovered control',
    annotations: { agentHidden: true },
    inputSchema: schema('control payload '.repeat(100)),
  };
  const session = {
    id: 'deferred-mcp-context',
    provider: 'anthropic',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [read],
    deferredNativeTools: true,
    deferredToolCatalog: [read, mcp, skill, control],
    compaction: {},
  };
  const route = { provider: 'openai', model: 'test' };
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => route,
    getCurrentCwd: () => '',
    getMode: () => 'default',
  });

  assert.deepEqual(requestSerializedToolsForContext(session, 'openai'), [read]);
  assert.deepEqual(requestSerializedToolsForContext(session, 'anthropic'), [read]);
  const before = contextStatus();
  assert.equal(before.request.toolSchemaBreakdown.mcp, undefined);
  assert.equal(before.request.toolSchemaBreakdown.skills, undefined);
  assert.equal(before.request.toolSchemaBreakdown.control, undefined);

  mcp.inputSchema.properties.value.description += ' mutated payload '.repeat(100);
  session.deferredToolCatalog.push({
    name: 'mcp__demo__second',
    description: 'Second MCP tool',
    inputSchema: schema('second payload '.repeat(100)),
  });
  const undiscoveredChanged = contextStatus();
  assert.equal(undiscoveredChanged, before, 'undiscovered catalog changes must not churn status/baselines');

  session.deferredDiscoveredTools = [mcp.name];
  const discovered = contextStatus();
  assert.notEqual(discovered, before);
  assert.equal(discovered.request.toolSchemaBreakdown.mcp.count, 1);
  assert.equal(discovered.request.toolSchemaBreakdown.skills, undefined);
  assert.equal(discovered.request.toolSchemaBreakdown.control, undefined);
  assert.ok(discovered.request.toolSchemaTokens > before.request.toolSchemaTokens);
  assert.ok(discovered.request.reserveTokens > before.request.reserveTokens);
  assert.ok(discovered.usedTokens > before.usedTokens);

  mcp.inputSchema.properties.value.description += ' discovered mutation '.repeat(200);
  const mutated = contextStatus();
  assert.notEqual(mutated, discovered);
  assert.equal(mutated.request.toolSchemaBreakdown.mcp.count, 1);
  assert.ok(mutated.request.toolSchemaTokens > discovered.request.toolSchemaTokens);
  assert.ok(mutated.request.reserveTokens > discovered.request.reserveTokens);
  assert.ok(mutated.usedTokens > discovered.usedTokens);
});

test('provider baseline ignores undiscovered schemas and invalidates after visible discovery/mutation', () => {
  const read = { name: 'read', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', inputSchema: schema('initial') };
  const session = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [read],
    deferredNativeTools: true,
    deferredToolCatalog: [read, mcp],
    compaction: {},
  };
  const pressure = (requestTools) => resolveCompactionPressureTokens(
    estimateMessagesTokens(session.messages),
    resolveWorkerCompactPolicy(session, requestTools),
    { messages: session.messages, sessionRef: session },
  );

  const baseTools = requestSerializedToolsForContext(session, session.provider);
  recordProviderContextBaseline(
    session,
    session.messages,
    { inputTokens: 80_000 },
    { sendTools: baseTools },
  );
  mcp.inputSchema.properties.value.description = 'undiscovered mutation '.repeat(200);
  assert.equal(
    pressure(requestSerializedToolsForContext(session, session.provider)),
    80_000,
    'an undiscovered schema mutation must retain the provider baseline',
  );

  session.deferredDiscoveredTools = [mcp.name];
  const discoveredTools = requestSerializedToolsForContext(session, session.provider);
  assert.notEqual(
    pressure(discoveredTools),
    80_000,
    'discovery must invalidate a baseline recorded against the base surface',
  );
  recordProviderContextBaseline(
    session,
    session.messages,
    { inputTokens: 80_000 },
    { sendTools: discoveredTools },
  );
  assert.equal(pressure(discoveredTools), 80_000);

  mcp.inputSchema.properties.value.description += ' visible mutation '.repeat(200);
  assert.notEqual(
    pressure(requestSerializedToolsForContext(session, session.provider)),
    80_000,
    'a discovered in-place schema mutation must invalidate the provider baseline',
  );
});

test('agent-loop repairs history before one coherent pressure/send/baseline tool snapshot', async () => {
  const read = { name: 'read', description: 'Read', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', description: 'Lookup', inputSchema: schema('mcp') };
  const messages = [
    { role: 'user', content: 'hello' },
    {
      role: 'tool',
      toolCallId: 'orphan-load',
      content: 'Loaded',
      nativeToolSearch: {
        provider: 'anthropic-oauth',
        toolReferences: [mcp.name],
      },
    },
  ];
  const session = {
    id: 'snapshot-repair',
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages,
    tools: [read],
    deferredNativeTools: true,
    deferredToolCatalog: [read, mcp],
    compaction: {},
  };
  let body;
  let apiKeyTools;
  let retryBody;
  let retryApiKeyTools;
  const provider = {
    name: session.provider,
    async send(outgoing, model, tools, opts) {
      assert.equal(opts.providerToolSnapshotAuthoritative, true);
      const late = {
        name: 'mcp__demo__late',
        description: 'Connected after snapshot',
        inputSchema: schema('late'),
      };
      session.deferredToolCatalog.push(late);
      session.deferredDiscoveredTools = [late.name];
      await Promise.resolve();
      body = buildAnthropicRequestBody(outgoing, model, tools, opts);
      apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(tools, outgoing, opts);
      session.deferredToolCatalog.push({
        name: 'mcp__demo__retry_late',
        inputSchema: schema('retry late'),
      });
      session.deferredDiscoveredTools.push('mcp__demo__retry_late');
      await Promise.resolve();
      retryBody = buildAnthropicRequestBody(outgoing, model, tools, opts);
      retryApiKeyTools = anthropicApiKeyTest.requestAnthropicTools(tools, outgoing, opts);
      return { content: 'done', usage: { inputTokens: 100, outputTokens: 1 } };
    },
  };
  const result = await agentLoop(provider, messages, session.model, session.tools, null, '', {
    session,
    sessionId: session.id,
    onUsageDelta(delta) {
      if (delta.source !== 'provider_send') return;
      recordProviderContextBaseline(session, messages, {
        inputTokens: delta.deltaInput,
        outputTokens: delta.deltaOutput,
      }, { boundary: 'request', sendTools: delta.sendTools });
    },
  });

  assert.deepEqual(body.tools.map((tool) => tool.name), [read.name]);
  assert.deepEqual(apiKeyTools.map((tool) => tool.name), [read.name]);
  assert.deepEqual(retryBody.tools, body.tools, 'OAuth retry must reuse authoritative provider bytes');
  assert.deepEqual(retryApiKeyTools, apiKeyTools, 'API-key retry must reuse authoritative provider bytes');
  assert.equal(messages.some((message) => message.toolCallId === 'orphan-load'), false);
  assert.equal(Object.isFrozen(result.lastSendTools), true);
  assert.equal(Object.isFrozen(result.lastSendTools[0].inputSchema), true);
  assert.equal(session.compaction.requestReserveTokens, estimateRequestReserveTokens(result.lastSendTools));
  assert.equal(session.contextPressureBaselineToolSignature, toolSchemaSignature(result.lastSendTools));
});

test('direct Anthropic adapter callers retain unresolved deferred resolution', () => {
  const read = { name: 'read', description: 'Read', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', description: 'Lookup', inputSchema: schema('mcp') };
  const messages = [{ role: 'user', content: 'hello' }];
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredDiscoveredTools: [mcp.name],
    deferredToolCatalog: [read, mcp],
  };
  const native = { type: 'web_search_20250305', name: 'web_search', max_uses: 2 };
  const opts = { session, nativeTools: [native] };
  const oauthBody = buildAnthropicRequestBody(messages, 'claude-sonnet-4-6', [read], opts);
  const apiKeyTools = anthropicApiKeyTest.requestAnthropicTools([read], messages, opts);
  assert.deepEqual(oauthBody.tools.map((tool) => tool.name), [native.name, read.name, mcp.name]);
  assert.deepEqual(apiKeyTools.map((tool) => tool.name), [native.name, read.name, mcp.name]);
  assert.equal(oauthBody.tools[0], native);
  assert.equal(apiKeyTools[0], native);
  assert.equal(oauthBody.tools.at(-1).defer_loading, true);
  assert.equal(apiKeyTools.at(-1).defer_loading, true);

  const nativeOnlySnapshot = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [],
    nativeTools: [native],
    messages,
    session,
  });
  assert.deepEqual(nativeOnlySnapshot.map((tool) => tool.name), [native.name]);
});

test('provider tool snapshots match JSON normalization and preserve stable provider bytes', () => {
  let accessorDescription = 'snapshotted accessor';
  const inherited = { inheritedMutation: 'before' };
  const properties = Object.create(inherited);
  Object.defineProperty(properties, 'dynamic', {
    enumerable: true,
    get() {
      return { type: 'string', description: accessorDescription };
    },
  });
  Object.defineProperty(properties, '__proto__', {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { type: 'string', description: 'own prototype key' },
  });
  const inputSchema = Object.create({ inheritedSchemaField: 'not provider-visible' });
  inputSchema.type = 'object';
  inputSchema.properties = properties;
  inputSchema.optionalUndefined = undefined;
  inputSchema.optionalFunction = () => {};
  inputSchema.optionalSymbol = Symbol('omit');
  inputSchema.arrayValues = [
    undefined,
    () => {},
    Symbol('array-null'),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    '[Circular]',
  ];
  inputSchema.nullValue = null;
  const tool = Object.assign(Object.create({ inheritedToolField: 'hidden' }), {
    name: 'read',
    description: 'Read',
    inputSchema,
  });
  const snapshot = snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [tool],
    messages: [{ role: 'user', content: 'hello' }],
    session: { provider: 'anthropic-oauth' },
  });
  const signature = toolSchemaSignature(snapshot);
  const reserve = estimateRequestReserveTokens(snapshot);

  accessorDescription = 'mutated accessor';
  inherited.inheritedMutation = 'after';
  properties.__proto__.description = 'mutated own prototype key';
  inputSchema.type = 'array';

  assert.equal(Object.getPrototypeOf(snapshot[0]), Object.prototype);
  assert.equal(Object.getPrototypeOf(snapshot[0].inputSchema), Object.prototype);
  assert.equal(snapshot[0].inputSchema.type, 'object');
  assert.equal(snapshot[0].inputSchema.properties.dynamic.description, 'snapshotted accessor');
  assert.equal(snapshot[0].inputSchema.properties.__proto__.description, 'own prototype key');
  assert.equal(Object.hasOwn(snapshot[0].inputSchema.properties, '__proto__'), true);
  assert.equal(Object.hasOwn(snapshot[0].inputSchema, 'optionalUndefined'), false);
  assert.equal(Object.hasOwn(snapshot[0].inputSchema, 'optionalFunction'), false);
  assert.equal(Object.hasOwn(snapshot[0].inputSchema, 'optionalSymbol'), false);
  assert.deepEqual(snapshot[0].inputSchema.arrayValues, [
    null, null, null, null, null, null, null, '[Circular]',
  ]);
  assert.equal(snapshot[0].inputSchema.nullValue, null);
  assert.equal('inheritedMutation' in snapshot[0].inputSchema.properties, false);
  assert.equal('inheritedSchemaField' in snapshot[0].inputSchema, false);
  assert.equal('inheritedToolField' in snapshot[0], false);
  assert.equal(toolSchemaSignature(snapshot), signature);
  assert.equal(estimateRequestReserveTokens(snapshot), reserve);

  const opts = {
    providerToolSnapshotAuthoritative: true,
    session: {
      provider: 'anthropic-oauth',
      deferredNativeTools: true,
      deferredDiscoveredTools: ['mcp__should_not_appear'],
      deferredToolCatalog: [{ name: 'mcp__should_not_appear', inputSchema: schema('late') }],
    },
  };
  const messages = [{ role: 'user', content: 'hello' }];
  const oauthBody = buildAnthropicRequestBody(messages, 'claude-sonnet-4-6', snapshot, opts);
  const apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(snapshot, messages, opts);
  for (const wireTool of [oauthBody.tools[0], apiKeyTools[0]]) {
    assert.equal(wireTool.input_schema.type, 'object');
    assert.equal(wireTool.input_schema.properties.dynamic.description, 'snapshotted accessor');
    assert.equal(wireTool.input_schema.properties.__proto__.description, 'own prototype key');
    assert.equal(Object.hasOwn(wireTool.input_schema.properties, '__proto__'), true);
  }
});

test('provider tool snapshot captures JSON array length once', () => {
  const snapshotArray = (values) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [{ name: 'array_tool', inputSchema: { type: 'object', values } }],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  })[0].inputSchema.values;

  const extending = [null];
  Object.defineProperty(extending, 0, {
    enumerable: true,
    get() {
      extending.push('late');
      return 'first';
    },
  });
  assert.deepEqual(snapshotArray(extending), ['first']);

  const shrinking = ['first', 'second', 'third'];
  Object.defineProperty(shrinking, 0, {
    enumerable: true,
    get() {
      shrinking.length = 1;
      return 'first';
    },
  });
  assert.deepEqual(snapshotArray(shrinking), ['first', null, null]);

  const sparse = new Array(4);
  sparse[2] = 'present';
  assert.deepEqual(snapshotArray(sparse), [null, null, 'present', null]);

  const getterFailure = new Error('array getter failed');
  const throwing = new Array(2);
  Object.defineProperty(throwing, 0, {
    enumerable: true,
    get() { throw getterFailure; },
  });
  assert.throws(() => snapshotArray(throwing), (error) => error === getterFailure);

  let conversions = 0;
  const fractional = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') {
        return {
          valueOf() {
            conversions += 1;
            return 2.9;
          },
        };
      }
      if (key === '0') return 'zero';
      if (key === '1') return 'one';
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(snapshotArray(fractional), ['zero', 'one']);
  assert.equal(conversions, 1);

  let nullExoticConversions = 0;
  const nullExotic = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') {
        return {
          [Symbol.toPrimitive]: null,
          valueOf() {
            nullExoticConversions += 1;
            return 1.9;
          },
        };
      }
      if (key === '0') return 'ordinary';
      return Reflect.get(target, key, receiver);
    },
  });
  assert.deepEqual(snapshotArray(nullExotic), ['ordinary']);
  assert.equal(nullExoticConversions, 1);

  const cappedFraction = new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') return 1_000_000.1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(snapshotArray(cappedFraction).length, 1_000_000);

  for (const [rawLength, expected] of [
    [-1, []],
    [Number.NaN, []],
    [0.9, []],
  ]) {
    const values = new Proxy([], {
      get(target, key, receiver) {
        return key === 'length' ? rawLength : Reflect.get(target, key, receiver);
      },
    });
    assert.deepEqual(snapshotArray(values), expected);
  }

  for (const rawLength of [
    1n,
    Symbol('length'),
    { valueOf: () => 1n },
    { [Symbol.toPrimitive]: () => Symbol('length') },
  ]) {
    const values = new Proxy([], {
      get(target, key, receiver) {
        return key === 'length' ? rawLength : Reflect.get(target, key, receiver);
      },
    });
    assert.throws(
      () => snapshotArray(values),
      (error) => error instanceof TypeError
        && error.message === 'provider tool snapshot: invalid array length',
    );
  }
  for (const rawLength of [Number.POSITIVE_INFINITY, 1_000_001, Number.MAX_SAFE_INTEGER]) {
    const values = new Proxy([], {
      get(target, key, receiver) {
        return key === 'length' ? rawLength : Reflect.get(target, key, receiver);
      },
    });
    assert.throws(
      () => snapshotArray(values),
      (error) => error instanceof RangeError
        && error.message === 'provider tool snapshot: array length exceeds safe limit 1000000',
    );
  }
});

test('request tool scopes isolate parallel and nested same-session gauges and restore on errors', async () => {
  const session = {
    id: 'scope-isolation',
    provider: 'anthropic-oauth',
    messages: [{ role: 'user', content: 'fallback' }],
    tools: [{ name: 'fallback', inputSchema: schema('fallback') }],
  };
  const messagesA = [{ role: 'user', content: 'a' }];
  const messagesB = [{ role: 'user', content: 'b' }];
  const messagesNested = [{ role: 'user', content: 'nested' }];
  const snapshotA = snapshotProviderRequestTools({
    provider: session.provider,
    nativeTools: [{ type: 'native_a', name: 'native_a', input_schema: { ambiguous: true } }],
    tools: [{ name: 'a', inputSchema: schema('a') }],
    messages: messagesA,
    session,
  });
  const snapshotB = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [{ name: 'b', inputSchema: schema('b') }],
    messages: messagesB,
    session,
  });
  const nestedSnapshot = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [{ name: 'nested', inputSchema: schema('nested') }],
    messages: messagesNested,
    session,
  });
  const scopeFor = (messages, requestTools) => ({
    session,
    provider: session.provider,
    messages,
    requestTools,
    nativePrefixCount: providerNativeToolPrefixCount(requestTools),
  });

  const [seenA, seenB] = await Promise.all([
    runWithProviderRequestToolsScope(scopeFor(messagesA, snapshotA), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        requestSerializedToolsForContext(session, session.provider, messagesA),
        snapshotA,
      );
      assert.equal(scopedProviderRequestTools(session, 'anthropic', messagesA), null);
      await runWithProviderRequestToolsScope(scopeFor(messagesNested, nestedSnapshot), async () => {
        await Promise.resolve();
        assert.equal(
          requestSerializedToolsForContext(session, session.provider, messagesNested),
          nestedSnapshot,
        );
      });
      assert.equal(
        requestSerializedToolsForContext(session, session.provider, messagesA),
        snapshotA,
      );
      return requestSerializedToolsForContext(session, session.provider, messagesA);
    }),
    runWithProviderRequestToolsScope(scopeFor(messagesB, snapshotB), async () => {
      await Promise.resolve();
      return requestSerializedToolsForContext(session, session.provider, messagesB);
    }),
  ]);
  assert.equal(seenA, snapshotA);
  assert.equal(seenB, snapshotB);

  let delayedErrorLookup;
  let resolveDelayedError;
  const delayedError = new Promise((resolve) => {
    resolveDelayedError = resolve;
  });
  await assert.rejects(
    runWithProviderRequestToolsScope(scopeFor(messagesA, snapshotA), async () => {
      assert.equal(
        requestSerializedToolsForContext(session, session.provider, messagesA),
        snapshotA,
      );
      setTimeout(() => {
        delayedErrorLookup = scopedProviderRequestTools(session, session.provider, messagesA);
        resolveDelayedError();
      }, 10);
      throw new Error('scope failure');
    }),
    /scope failure/,
  );
  await delayedError;
  assert.equal(delayedErrorLookup, null);
  assert.equal(scopedProviderRequestTools(session, session.provider, messagesA), null);

  let delayedOldLookup;
  const delayedOld = new Promise((resolve) => {
    runWithProviderRequestToolsScope(scopeFor(messagesA, snapshotA), () => {
      setTimeout(() => {
        delayedOldLookup = scopedProviderRequestTools(session, session.provider, messagesA);
        resolve();
      }, 15);
    });
  });
  await runWithProviderRequestToolsScope(scopeFor(messagesA, snapshotB), async () => {
    assert.equal(
      scopedProviderRequestTools(session, session.provider, messagesA)?.requestTools,
      snapshotB,
    );
    await delayedOld;
    assert.equal(delayedOldLookup, null);
  });

  await runWithProviderRequestToolsScope(scopeFor(messagesA, snapshotA), async () => {
    const outerScope = scopedProviderRequestTools(session, session.provider, messagesA);
    await runWithProviderRequestToolsScope(scopeFor(messagesNested, nestedSnapshot), async () => {
      invalidateProviderRequestToolsScope(outerScope);
      assert.equal(
        scopedProviderRequestTools(session, session.provider, messagesNested)?.requestTools,
        nestedSnapshot,
      );
    });
    assert.equal(scopedProviderRequestTools(session, session.provider, messagesA), null);
  });

  const explicitNative = [{ type: 'fallback_native', name: 'fallback_native' }];
  const fallback = requestSerializedToolsForContext(
    session,
    session.provider,
    session.messages,
    { nativeTools: explicitNative },
  );
  assert.deepEqual(fallback.map((tool) => tool.name), ['fallback_native', 'fallback']);
  assert.equal(providerNativeToolPrefixCount(fallback), 1);
});

test('selected deferred snapshots force one pre-freeze deferLoading value', () => {
  const snapshotSelected = (tool) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [{ name: 'read', inputSchema: schema('path') }],
    messages: [],
    session: {
      provider: 'anthropic-oauth',
      deferredNativeTools: true,
      deferredDiscoveredTools: ['mcp__demo__selected'],
      deferredToolCatalog: [tool],
    },
  });
  for (const initial of [true, false]) {
    const tool = { name: 'mcp__demo__selected', inputSchema: schema(String(initial)) };
    Object.defineProperty(tool, 'deferLoading', {
      value: initial,
      enumerable: true,
      configurable: false,
    });
    const selected = snapshotSelected(tool).at(-1);
    assert.equal(selected.deferLoading, true);
    assert.equal(Object.isFrozen(selected), true);
  }

  let getterReads = 0;
  const accessor = { name: 'mcp__demo__selected', inputSchema: schema('getter') };
  Object.defineProperty(accessor, 'deferLoading', {
    enumerable: true,
    configurable: false,
    get() {
      getterReads += 1;
      if (getterReads > 1) throw new Error('deferLoading read twice');
      return false;
    },
  });
  const selected = snapshotSelected(accessor).at(-1);
  assert.equal(getterReads, 1);
  assert.equal(selected.deferLoading, true);

  let calls = 0;
  const callable = {
    name: 'mcp__demo__selected',
    toJSON() {
      calls += 1;
      const properties = {};
      Object.defineProperty(properties, '__proto__', {
        value: { type: 'string' },
        enumerable: true,
      });
      return {
        name: 'mcp__demo__selected',
        inputSchema: {
          type: 'object',
          properties,
        },
        deferLoading: false,
      };
    },
  };
  const callableSelected = snapshotSelected(callable).at(-1);
  assert.equal(calls, 1);
  assert.equal(callableSelected.deferLoading, true);
  assert.equal(Object.hasOwn(callableSelected.inputSchema.properties, '__proto__'), true);
});

test('authoritative snapshot includes native tools in gauge, pressure, baseline, and both Anthropic bodies', async () => {
  let schemaReads = 0;
  let schemaToJsonReads = 0;
  let schemaToJsonCalls = 0;
  const read = { name: 'read' };
  Object.defineProperty(read, 'inputSchema', {
    enumerable: true,
    get() {
      schemaReads += 1;
      if (schemaReads > 1) throw new Error('request schema observed twice');
      const inputSchema = {};
      Object.defineProperty(inputSchema, 'toJSON', {
        enumerable: true,
        get() {
          schemaToJsonReads += 1;
          if (schemaToJsonReads > 1) throw new Error('request schema toJSON observed twice');
          return function toJSON() {
            schemaToJsonCalls += 1;
            if (schemaToJsonCalls > 1) throw new Error('request schema toJSON called twice');
            return schema('single gauge/send snapshot');
          };
        },
      });
      return inputSchema;
    },
  });
  const native = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 3,
  };
  const ambiguousNative = {
    type: 'ambiguous_native',
    name: 'read',
    input_schema: { nativeAlias: 'input_schema' },
    inputSchema: { nativeAlias: 'inputSchema' },
    parameters: { nativeAlias: 'parameters' },
    schema: { nativeAlias: 'schema' },
  };
  const session = {
    id: 'native-authoritative-snapshot',
    owner: 'agent',
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [read],
    compaction: {},
  };
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => ({ provider: session.provider, model: session.model }),
    getCurrentCwd: () => '',
    getMode: () => 'default',
    getNativeTools() {
      throw new Error('scoped gauge must not read live native tools');
    },
  });
  let firstBody;
  let retryBody;
  let apiKeyTools;
  let gauge;
  let baselineGauge;
  const provider = {
    name: session.provider,
    async send(messages, model, tools, opts) {
      gauge = contextStatus();
      assert.equal(schemaReads, 1);
      assert.equal(schemaToJsonReads, 1);
      assert.equal(schemaToJsonCalls, 1);
      assert.equal(opts.providerNativeToolPrefixCount, 2);
      const expectedSignature = toolSchemaSignature(tools);
      const expectedReserve = estimateRequestReserveTokens(tools);
      native.max_uses = 99;
      ambiguousNative.input_schema.nativeAlias = 'mutated';
      opts.nativeTools.push({ type: 'code_execution_20250825', name: 'late_native' });
      opts.providerNativeToolPrefixCount = 0;
      firstBody = buildAnthropicRequestBody(messages, model, tools, opts);
      apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(tools, messages, opts);
      retryBody = buildAnthropicRequestBody(messages, model, tools, opts);
      assert.equal(toolSchemaSignature(tools), expectedSignature);
      assert.equal(estimateRequestReserveTokens(tools), expectedReserve);
      return { content: 'done', usage: { inputTokens: 100, outputTokens: 1 } };
    },
  };
  const result = await agentLoop(provider, session.messages, session.model, session.tools, null, '', {
    session,
    sessionId: session.id,
    nativeTools: [native, ambiguousNative],
    onUsageDelta(delta) {
      if (delta.source !== 'provider_send') return;
      baselineGauge = contextStatus();
      recordProviderContextBaseline(session, session.messages, {
        inputTokens: delta.deltaInput,
        outputTokens: delta.deltaOutput,
      }, { boundary: 'request', sendTools: delta.sendTools });
    },
  });

  assert.equal(schemaReads, 1);
  assert.equal(schemaToJsonReads, 1);
  assert.equal(schemaToJsonCalls, 1);
  assert.deepEqual(result.lastSendTools.map((tool) => tool.name), ['web_search', 'read', 'read']);
  assert.equal(providerNativeToolPrefixCount(result.lastSendTools), 2);
  assert.deepEqual(firstBody.tools, retryBody.tools);
  assert.deepEqual(firstBody.tools, apiKeyTools);
  assert.equal(firstBody.tools[0].max_uses, 3);
  assert.deepEqual(firstBody.tools[1], {
    type: 'ambiguous_native',
    name: 'read',
    input_schema: { nativeAlias: 'input_schema' },
    inputSchema: { nativeAlias: 'inputSchema' },
    parameters: { nativeAlias: 'parameters' },
    schema: { nativeAlias: 'schema' },
  });
  assert.equal(firstBody.tools.some((tool) => tool.name === 'late_native'), false);
  assert.equal(gauge.request.reserveTokens, estimateRequestReserveTokens(result.lastSendTools));
  assert.equal(baselineGauge.request.reserveTokens, gauge.request.reserveTokens);
  const nativeWebOnly = snapshotProviderRequestTools({
    provider: session.provider,
    nativeTools: [result.lastSendTools[0]],
    tools: [],
    messages: session.messages,
    session,
  });
  const nativeAmbiguousOnly = snapshotProviderRequestTools({
    provider: session.provider,
    nativeTools: [result.lastSendTools[1]],
    tools: [],
    messages: session.messages,
    session,
  });
  const functionOnly = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [result.lastSendTools[2]],
    messages: session.messages,
    session,
  });
  assert.equal(
    gauge.request.toolSchemaBreakdown.other.tokens,
    estimateToolSchemaTokens(nativeWebOnly),
  );
  assert.equal(
    gauge.request.toolSchemaBreakdown.code.tokens,
    estimateToolSchemaTokens(nativeAmbiguousOnly) + estimateToolSchemaTokens(functionOnly),
  );
  assert.deepEqual(
    estimateToolSchemaBreakdown(result.lastSendTools),
    gauge.request.toolSchemaBreakdown,
  );
  assert.equal(session.compaction.requestReserveTokens, estimateRequestReserveTokens(result.lastSendTools));
  assert.equal(session.contextPressureBaselineToolSignature, toolSchemaSignature(result.lastSendTools));
});

test('provider tool snapshots reject BigInt, cycles, and throwing accessors without wire substitutes', () => {
  const snapshotForSchema = (inputSchema) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [{ name: 'read', inputSchema }],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  });

  assert.throws(
    () => snapshotForSchema({ type: 'object', invalid: 1n }),
    (error) => error instanceof TypeError
      && error.message === 'provider tool snapshot: BigInt is not JSON-serializable',
  );
  assert.throws(
    () => snapshotForSchema({ type: 'object', invalid: Object(1n) }),
    (error) => error instanceof TypeError
      && error.message === 'provider tool snapshot: BigInt is not JSON-serializable',
  );

  const cyclic = { type: 'object' };
  cyclic.self = cyclic;
  assert.throws(
    () => snapshotForSchema(cyclic),
    (error) => error instanceof TypeError
      && error.message === 'provider tool snapshot: cyclic value is not JSON-serializable',
  );

  const accessorFailure = new Error('schema accessor failed');
  const throwing = { type: 'object' };
  Object.defineProperty(throwing, 'properties', {
    enumerable: true,
    get() { throw accessorFailure; },
  });
  assert.throws(
    () => snapshotForSchema(throwing),
    (error) => error === accessorFailure,
  );

  const legitimate = snapshotForSchema({
    type: 'object',
    properties: {
      literal: { type: 'string', description: '[Circular]' },
      nullable: { type: 'string', default: null },
    },
  });
  assert.equal(legitimate[0].inputSchema.properties.literal.description, '[Circular]');
  assert.equal(legitimate[0].inputSchema.properties.nullable.default, null);
  assert.doesNotThrow(() => toolSchemaSignature(legitimate));
  assert.doesNotThrow(() => estimateRequestReserveTokens(legitimate));
});

test('provider tool snapshot evaluates active and selected catalog names exactly once', () => {
  let activeNameReads = 0;
  const active = {
    description: 'Read',
    inputSchema: schema('active'),
  };
  Object.defineProperty(active, 'name', {
    enumerable: true,
    get() {
      activeNameReads += 1;
      if (activeNameReads > 1) throw new Error('active name read twice');
      return 'read';
    },
  });

  let selectedNameReads = 0;
  let selectedSchemaReads = 0;
  const selected = { description: 'Selected MCP' };
  Object.defineProperty(selected, 'name', {
    enumerable: true,
    get() {
      selectedNameReads += 1;
      if (selectedNameReads > 1) throw new Error('selected name read twice');
      return 'mcp__demo__selected';
    },
  });
  Object.defineProperty(selected, 'inputSchema', {
    enumerable: true,
    get() {
      selectedSchemaReads += 1;
      return schema('selected');
    },
  });
  const undiscovered = { name: 'mcp__demo__undiscovered' };
  Object.defineProperty(undiscovered, 'inputSchema', {
    enumerable: true,
    get() { throw new Error('undiscovered schema must stay inert'); },
  });
  const duplicate = { name: 'mcp__demo__selected' };
  Object.defineProperty(duplicate, 'inputSchema', {
    enumerable: true,
    get() { throw new Error('duplicate schema must stay inert'); },
  });
  const session = {
    provider: 'anthropic-oauth',
    deferredNativeTools: true,
    deferredDiscoveredTools: ['mcp__demo__selected'],
    // The active object is intentionally also in the catalog; identity skip
    // must prevent a second active-name observation.
    deferredToolCatalog: [active, selected, undiscovered, duplicate],
  };
  const messages = [{ role: 'user', content: 'hello' }];
  const snapshot = snapshotProviderRequestTools({
    provider: session.provider,
    tools: [active],
    messages,
    session,
  });

  assert.equal(activeNameReads, 1);
  assert.equal(selectedNameReads, 1);
  assert.equal(selectedSchemaReads, 1);
  assert.deepEqual(snapshot.map((tool) => tool.name), ['read', 'mcp__demo__selected']);
  assert.equal(new Set(snapshot.map((tool) => tool.name)).size, snapshot.length);
  const signature = toolSchemaSignature(snapshot);
  const reserve = estimateRequestReserveTokens(snapshot);
  const opts = { session, providerToolSnapshotAuthoritative: true };
  const oauthBody = buildAnthropicRequestBody(messages, 'claude-sonnet-4-6', snapshot, opts);
  const apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(snapshot, messages, opts);
  assert.deepEqual(oauthBody.tools.map((tool) => tool.name), snapshot.map((tool) => tool.name));
  assert.deepEqual(apiKeyTools.map((tool) => tool.name), snapshot.map((tool) => tool.name));
  assert.equal(toolSchemaSignature(snapshot), signature);
  assert.equal(estimateRequestReserveTokens(snapshot), reserve);
});

test('selected deferred tool identity is stable before pressure, baseline, or provider effects', async () => {
  const read = { name: 'read', inputSchema: schema('path') };
  const selectedTool = (toJSON) => ({
    name: 'mcp__demo__selected',
    toJSON,
  });
  const snapshotSelected = (tool) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [read],
    messages: [{ role: 'user', content: 'hello' }],
    session: {
      provider: 'anthropic-oauth',
      deferredNativeTools: true,
      deferredDiscoveredTools: ['mcp__demo__selected'],
      deferredToolCatalog: [read, tool],
    },
  });
  const identityError = (error) => error instanceof TypeError
    && error.message === 'provider tool snapshot: selected tool identity mismatch for "mcp__demo__selected"';

  for (const tool of [
    selectedTool(() => ({ name: 'mcp__demo__other', inputSchema: schema('changed identity') })),
    selectedTool(() => ({ inputSchema: schema('missing identity') })),
    selectedTool(() => ({ name: 42, inputSchema: schema('non-string identity') })),
  ]) {
    assert.throws(() => snapshotSelected(tool), identityError);
  }

  const activeByNormalizedName = snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [
      {
        name: 'pre_normalized_name',
        toJSON: () => ({ name: 'normalized_name', inputSchema: schema('first') }),
      },
      { name: 'normalized_name', inputSchema: schema('duplicate') },
    ],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  });
  assert.deepEqual(activeByNormalizedName.map((tool) => tool.name), ['normalized_name']);

  let providerCalls = 0;
  const session = {
    id: 'selected-identity-mismatch',
    owner: 'agent',
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [read],
    deferredNativeTools: true,
    deferredDiscoveredTools: ['mcp__demo__selected'],
    deferredToolCatalog: [
      read,
      selectedTool(() => ({ name: 'mcp__demo__other', inputSchema: schema('agent mismatch') })),
    ],
    compaction: {},
  };
  const provider = {
    name: session.provider,
    async send() {
      providerCalls += 1;
      return { content: 'must not send', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await assert.rejects(
    agentLoop(provider, session.messages, session.model, session.tools, null, '', {
      session,
      sessionId: session.id,
    }),
    identityError,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(session.compaction, {});
  assert.equal(Object.hasOwn(session, 'contextPressureBaselineToolSignature'), false);
  assert.equal(Object.hasOwn(session, 'contextPressureBaseline'), false);
});

test('provider tool snapshot applies valid toJSON once and rejects invalid toJSON results', () => {
  let topLevelCalls = 0;
  let nestedCalls = 0;
  let nestedDescription = 'nested snapshot';
  const nestedSchema = {
    toJSON() {
      nestedCalls += 1;
      return {
        type: 'object',
        properties: { value: { type: 'string', description: nestedDescription } },
      };
    },
  };
  const topLevelTool = {
    toJSON() {
      topLevelCalls += 1;
      return {
        name: 'read',
        description: 'top-level snapshot',
        inputSchema: nestedSchema,
      };
    },
  };
  const valid = snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [topLevelTool],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  });
  nestedDescription = 'mutated after snapshot';
  assert.equal(topLevelCalls, 1);
  assert.equal(nestedCalls, 1);
  assert.equal(valid[0].inputSchema.properties.value.description, 'nested snapshot');
  assert.equal(Object.isFrozen(valid[0].inputSchema), true);
  const validSignature = toolSchemaSignature(valid);
  const validReserve = estimateRequestReserveTokens(valid);
  const opts = { providerToolSnapshotAuthoritative: true, session: { provider: 'anthropic-oauth' } };
  const messages = [{ role: 'user', content: 'hello' }];
  const oauthBody = buildAnthropicRequestBody(messages, 'claude-sonnet-4-6', valid, opts);
  const apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(valid, messages, opts);
  assert.equal(oauthBody.tools[0].input_schema.properties.value.description, 'nested snapshot');
  assert.equal(apiKeyTools[0].input_schema.properties.value.description, 'nested snapshot');
  assert.equal(toolSchemaSignature(valid), validSignature);
  assert.equal(estimateRequestReserveTokens(valid), validReserve);

  const snapshotTool = (tool) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [tool],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  });
  let ownNonFunctionReads = 0;
  const ownNonFunction = { name: 'own_non_function', inputSchema: schema('own') };
  Object.defineProperty(ownNonFunction, 'toJSON', {
    enumerable: true,
    get() {
      ownNonFunctionReads += 1;
      if (ownNonFunctionReads > 1) throw new Error('own non-function toJSON read twice');
      return 'metadata';
    },
  });
  const ownNonFunctionSnapshot = snapshotTool(ownNonFunction);
  assert.equal(ownNonFunctionReads, 1);
  assert.equal(ownNonFunctionSnapshot[0].toJSON, 'metadata');
  assert.deepEqual(Object.keys(ownNonFunctionSnapshot[0]), ['name', 'inputSchema', 'toJSON']);

  let inheritedNonFunctionReads = 0;
  const inheritedPrototype = {};
  Object.defineProperty(inheritedPrototype, 'toJSON', {
    get() {
      inheritedNonFunctionReads += 1;
      if (inheritedNonFunctionReads > 1) throw new Error('inherited non-function toJSON read twice');
      return 'inherited metadata';
    },
  });
  const inheritedNonFunction = Object.assign(Object.create(inheritedPrototype), {
    name: 'inherited_non_function',
    inputSchema: schema('inherited'),
  });
  const inheritedNonFunctionSnapshot = snapshotTool(inheritedNonFunction);
  assert.equal(inheritedNonFunctionReads, 1);
  assert.equal(Object.hasOwn(inheritedNonFunctionSnapshot[0], 'toJSON'), false);

  let callableReads = 0;
  let callableCalls = 0;
  const callableAccessor = {};
  Object.defineProperty(callableAccessor, 'toJSON', {
    enumerable: true,
    get() {
      callableReads += 1;
      if (callableReads > 1) throw new Error('callable toJSON read twice');
      return function toJSON() {
        callableCalls += 1;
        return { name: 'callable_accessor', inputSchema: schema('callable') };
      };
    },
  });
  const callableSnapshot = snapshotTool(callableAccessor);
  assert.equal(callableReads, 1);
  assert.equal(callableCalls, 1);
  assert.equal(callableSnapshot[0].name, 'callable_accessor');

  for (const tool of [
    { toJSON: () => 1n },
    { toJSON: () => ({ name: 'read', inputSchema: { toJSON: () => ({ invalid: 1n }) } }) },
  ]) {
    assert.throws(
      () => snapshotTool(tool),
      (error) => error instanceof TypeError
        && error.message === 'provider tool snapshot: BigInt is not JSON-serializable',
    );
  }
  const cyclicOutput = { name: 'read' };
  cyclicOutput.self = cyclicOutput;
  assert.throws(
    () => snapshotTool({ toJSON: () => cyclicOutput }),
    (error) => error instanceof TypeError
      && error.message === 'provider tool snapshot: cyclic value is not JSON-serializable',
  );
});

test('toJSON source-reference cycles fail once before pressure, baseline, or provider effects', async () => {
  const cycleError = (error) => error instanceof TypeError
    && error.message === 'provider tool snapshot: cyclic value is not JSON-serializable';
  const sourceCycle = (replacementFor) => {
    let getterReads = 0;
    let calls = 0;
    const source = {};
    Object.defineProperty(source, 'toJSON', {
      enumerable: true,
      get() {
        getterReads += 1;
        if (getterReads > 1) throw new Error('cyclic toJSON getter read twice');
        return function toJSON() {
          calls += 1;
          if (calls > 1) throw new Error('cyclic toJSON called twice');
          return replacementFor(source);
        };
      },
    });
    return {
      source,
      counts: () => ({ getterReads, calls }),
    };
  };
  const snapshot = (tool) => snapshotProviderRequestTools({
    provider: 'anthropic-oauth',
    tools: [tool],
    messages: [],
    session: { provider: 'anthropic-oauth' },
  });

  for (const replacementFor of [
    (source) => source,
    (source) => ({ name: 'read', source }),
    (source) => ({ name: 'read', inputSchema: { nested: { source } } }),
    (source) => ({ name: 'read', inputSchema: { values: [source] } }),
  ]) {
    const cyclic = sourceCycle(replacementFor);
    assert.throws(() => snapshot(cyclic.source), cycleError);
    assert.deepEqual(cyclic.counts(), { getterReads: 1, calls: 1 });
  }

  let deep = { type: 'string', description: 'finite leaf' };
  for (let index = 0; index < 64; index += 1) deep = { nested: deep };
  const valid = sourceCycle(() => ({
    name: 'deep_valid',
    inputSchema: { type: 'object', properties: { value: deep } },
  }));
  const validSnapshot = snapshot(valid.source);
  assert.deepEqual(valid.counts(), { getterReads: 1, calls: 1 });
  let leaf = validSnapshot[0].inputSchema.properties.value;
  for (let index = 0; index < 64; index += 1) leaf = leaf.nested;
  assert.equal(leaf.description, 'finite leaf');
  const signature = toolSchemaSignature(validSnapshot);
  const reserve = estimateRequestReserveTokens(validSnapshot);
  const messages = [{ role: 'user', content: 'hello' }];
  const opts = {
    providerToolSnapshotAuthoritative: true,
    session: { provider: 'anthropic-oauth' },
  };
  const oauthBody = buildAnthropicRequestBody(messages, 'claude-sonnet-4-6', validSnapshot, opts);
  const apiKeyTools = anthropicApiKeyTest.requestAnthropicTools(validSnapshot, messages, opts);
  assert.equal(oauthBody.tools[0].name, 'deep_valid');
  assert.equal(apiKeyTools[0].name, 'deep_valid');
  assert.equal(toolSchemaSignature(validSnapshot), signature);
  assert.equal(estimateRequestReserveTokens(validSnapshot), reserve);

  const cyclic = sourceCycle((source) => ({
    name: 'read',
    inputSchema: { nested: { source } },
  }));
  let providerCalls = 0;
  const session = {
    id: 'to-json-source-cycle',
    owner: 'agent',
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [cyclic.source],
    compaction: {},
  };
  const provider = {
    name: session.provider,
    async send() {
      providerCalls += 1;
      return { content: 'must not send', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  await assert.rejects(
    agentLoop(provider, session.messages, session.model, session.tools, null, '', {
      session,
      sessionId: session.id,
    }),
    cycleError,
  );
  assert.deepEqual(cyclic.counts(), { getterReads: 1, calls: 1 });
  assert.equal(providerCalls, 0);
  assert.deepEqual(session.compaction, {});
  assert.equal(Object.hasOwn(session, 'contextPressureBaselineToolSignature'), false);
  assert.equal(Object.hasOwn(session, 'contextPressureBaseline'), false);
});

test('agent-loop re-snapshots after reactive compaction without pressure/send signature drift', async () => {
  const read = { name: 'read', description: 'Read', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', description: 'Lookup', inputSchema: schema('before snapshot') };
  const messages = [
    { role: 'user', content: `old request ${'x'.repeat(30_000)}` },
    { role: 'assistant', content: `old answer ${'y'.repeat(10_000)}` },
    { role: 'user', content: 'current request' },
  ];
  const session = {
    id: 'snapshot-reactive-compact',
    owner: 'agent',
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-6',
    contextWindow: 100_000,
    messages,
    tools: [read],
    deferredNativeTools: true,
    deferredDiscoveredTools: [mcp.name],
    deferredToolCatalog: [read, mcp],
    compaction: {
      type: 'semantic',
      compactType: 'semantic',
      tailTurns: 1,
      keepTokens: 100,
      preserveRecentTokens: 100,
    },
  };
  const requestBodies = [];
  let actualAttempts = 0;
  let compactCalls = 0;
  let compactMutationDone = false;
  let preCompactGauge;
  let postCompactTools;
  let postCompactScoped;
  let delayedPreCompactLookup;
  let resolveDelayedPreCompact;
  const delayedPreCompact = new Promise((resolve) => {
    resolveDelayedPreCompact = resolve;
  });
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => ({ provider: session.provider, model: session.model }),
    getCurrentCwd: () => '',
    getMode: () => 'default',
    getNativeTools: () => [],
  });
  const provider = {
    name: session.provider,
    async send(outgoing, model, tools, opts) {
      if (String(opts?.sessionId || '').endsWith(':compact')) {
        compactCalls += 1;
        return { content: 'Compacted prior context.', usage: { inputTokens: 10, outputTokens: 2 } };
      }
      assert.equal(opts.providerToolSnapshotAuthoritative, true);
      actualAttempts += 1;
      if (actualAttempts === 1) {
        const snapshottedDescription = tools.find((tool) => tool.name === mcp.name)
          .inputSchema.properties.value.description;
        mcp.inputSchema.properties.value.description = 'mutated after first snapshot';
        await Promise.resolve();
        const body = buildAnthropicRequestBody(outgoing, model, tools, opts);
        requestBodies.push(body);
        assert.equal(
          body.tools.find((tool) => tool.name === mcp.name).input_schema.properties.value.description,
          snapshottedDescription,
          'post-snapshot catalog mutation must not alter provider bytes',
        );
        throw new Error('context length exceeded');
      }
      const body = buildAnthropicRequestBody(outgoing, model, tools, opts);
      requestBodies.push(body);
      return { content: 'done', usage: { inputTokens: 200, outputTokens: 2 } };
    },
  };
  const usageSnapshots = [];
  const result = await agentLoop(provider, messages, session.model, session.tools, null, '', {
    session,
    sessionId: session.id,
    async preCompactHook() {
      preCompactGauge = contextStatus();
      setTimeout(() => {
        delayedPreCompactLookup = scopedProviderRequestTools(session, session.provider, messages);
        resolveDelayedPreCompact();
      }, 30);
      await Promise.resolve();
      mcp.inputSchema.properties.value.description = 'mutated during compaction';
      compactMutationDone = true;
    },
    async postCompactHook() {
      if (!compactMutationDone || postCompactTools) return;
      postCompactScoped = scopedProviderRequestTools(session, session.provider, messages);
      postCompactTools = requestSerializedToolsForContext(session, session.provider, messages);
      contextStatus();
      await Promise.resolve();
    },
    onUsageDelta(delta) {
      if (delta.source !== 'provider_send') return;
      usageSnapshots.push(delta.sendTools);
      recordProviderContextBaseline(session, messages, {
        inputTokens: delta.deltaInput,
        outputTokens: delta.deltaOutput,
      }, { boundary: 'request', sendTools: delta.sendTools });
    },
  });

  assert.equal(compactCalls, 1);
  assert.equal(preCompactGauge.request.toolSchemaBreakdown.mcp.count, 1);
  assert.equal(postCompactScoped, null);
  assert.equal(
    postCompactTools.find((tool) => tool.name === mcp.name).inputSchema.properties.value.description,
    'mutated during compaction',
  );
  await delayedPreCompact;
  assert.equal(delayedPreCompactLookup, null);
  assert.equal(compactMutationDone, true);
  assert.equal(actualAttempts, 2);
  const finalBodyTool = requestBodies.at(-1).tools.find((tool) => tool.name === mcp.name);
  assert.equal(finalBodyTool.input_schema.properties.value.description, 'mutated during compaction');
  assert.equal(
    session.compaction.requestReserveTokens,
    estimateRequestReserveTokens(result.lastSendTools),
    'post-compaction pressure must use the exact final send snapshot',
  );
  assert.equal(toolSchemaSignature(usageSnapshots.at(-1)), toolSchemaSignature(result.lastSendTools));
  assert.equal(session.contextPressureBaselineToolSignature, toolSchemaSignature(result.lastSendTools));
});

test('tool status counts exclude MCP and skills while exposing MCP tool count', () => {
  const rows = [
    { name: 'read', kind: toolKind({ name: 'read' }), active: true },
    { name: 'mcp__demo__lookup', kind: toolKind({ name: 'mcp__demo__lookup' }), active: false },
    { name: 'Skill', kind: toolKind({ name: 'Skill' }), active: true },
  ];
  assert.deepEqual(splitToolStatusCounts(rows), {
    count: 1,
    activeCount: 1,
    mcpToolCount: 1,
    activeMcpToolCount: 0,
  });
});
