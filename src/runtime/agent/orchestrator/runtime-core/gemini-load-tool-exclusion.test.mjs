import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { renderToolSearch } = await import('./tool-catalog.mjs');
const { TOOL_SEARCH_TOOL } = await import('./tool-defs.mjs');
const { resolveExecutionToolCall } = await import('../session/loop/tool-call-resolution.mjs');
const { prepareDeferredToolCallThrough } = await import('../session/loop/deferred-call-through.mjs');
const { buildGeminiRequest } = await import('../providers/gemini-request-body.mjs');

const tool = (name, inputSchema) => ({
  name,
  description: `${name} tool.`,
  inputSchema,
  annotations: { readOnlyHint: true },
});
const good = tool('mcp__x__good', { type: 'object', properties: { a: { type: 'string' } } });
const bogus = tool('mcp__x__bogus', { type: 'object', properties: { a: { type: 'bogus-type' } } });
const tuple = tool('mcp__x__tuple', { type: 'object', properties: { a: { type: 'array', items: { type: 'bogus-type' } } } });
// Draft-07 tuple items: lowered on every route, so it loads everywhere.
const draft07 = tool('mcp__x__draft07', { type: 'object', properties: { a: { type: 'array', items: [{ type: 'string' }] } } });
const read = tool('read', { type: 'object', properties: { file_path: { type: 'string' } } });

// A non-bridge, non-native session: deferred tools are loaded onto session.tools.
function loaderSession(model, extra = {}) {
  return {
    id: `s-${model}`,
    provider: 'openrouter',
    model,
    deferredProviderMode: 'canonical',
    toolSpec: 'full',
    tools: [read, TOOL_SEARCH_TOOL],
    deferredToolCatalog: [good, bogus, tuple, draft07],
    ...extra,
  };
}
const load = (session, names) => JSON.parse(renderToolSearch({ names }, session, 'lead'));

test('Gemini route: load_tool does not load or list a tool whose schema Gemini rejects, and says why', () => {
  const session = loaderSession('google/gemini-3.5-flash-lite');
  const result = load(session, [good.name, bogus.name, tuple.name]);
  assert.deepEqual(result.loaded, [good.name]);
  assert.deepEqual(
    result.blocked.map((entry) => entry.name),
    [bogus.name, tuple.name]
  );
  assert.match(
    result.blocked[0].reason,
    /^tool "mcp__x__bogus" is unavailable with the current model: .*\/properties\/a/
  );
  assert.match(result.blocked[0].reason, /no call was sent/);
  assert.ok(result.activeTools.includes(good.name));
  assert.equal(result.activeTools.includes(bogus.name), false);
  assert.equal(result.activeTools.includes(tuple.name), false);
  assert.deepEqual(
    session.tools.map((t) => t.name),
    ['read', 'load_tool', good.name]
  );

  // Stable across turns: the same request again gives the same answer.
  assert.deepEqual(load(session, [bogus.name]).blocked, result.blocked.slice(0, 1));
  assert.equal(load(session, [bogus.name]).activeTools.includes(bogus.name), false);
});

test('Gemini route: an already-eager excluded tool is dropped from activeTools, with and without names', () => {
  const session = loaderSession('gemini-3.8-flash', { tools: [read, TOOL_SEARCH_TOOL, bogus, good] });
  assert.deepEqual(JSON.parse(renderToolSearch({}, session, 'lead')).activeTools.includes(bogus.name), false);
  assert.equal(load(session, [good.name]).activeTools.includes(bogus.name), false);
  assert.ok(load(session, [good.name]).activeTools.includes(good.name));
});

test('every route: a broken schema is blocked with the reason, a lowerable one loads', () => {
  const routes = [
    ['openrouter', 'claude-sonnet-4-6'],
    ['openrouter', 'gpt-5.5'],
    ['openrouter', 'fixture-model'],
    ['openrouter', undefined],
    ['anthropic', 'claude-sonnet-4-6'],
    ['openai-oauth', 'gpt-5.5'],
    ['deepseek', 'deepseek-chat'],
  ];
  for (const [provider, model] of routes) {
    const result = load(loaderSession(model, { provider }), [good.name, bogus.name, tuple.name, draft07.name]);
    assert.deepEqual(result.loaded, [good.name, draft07.name], `${provider} ${model}`);
    assert.deepEqual(result.blocked.map((entry) => entry.name), [bogus.name, tuple.name]);
    assert.match(result.blocked[0].reason, /is unavailable with the current model/);
    assert.ok(result.activeTools.includes(draft07.name));
    assert.equal(result.activeTools.includes(bogus.name), false);
  }
});

test('no exclusion: load_tool output and serialized requests do not depend on the Gemini route check', () => {
  const asGemini = load(loaderSession('gemini-3.8-flash'), [good.name]);
  const asOther = load(loaderSession('fixture-model'), [good.name]);
  assert.equal(JSON.stringify(asGemini), JSON.stringify(asOther));
  const tools = [read, good];
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = JSON.stringify(buildGeminiRequest(messages, 'gemini-3.5-flash-lite', tools, {}));
  const noticed = JSON.stringify(buildGeminiRequest(messages, 'gemini-3.5-flash-lite', tools, { onToolExcluded() {} }));
  assert.equal(noticed, plain);
});

test('bridge session on Gemini: an excluded eager tool is not described as directly available', () => {
  const session = loaderSession('gemini-3.8-flash', {
    toolExposureMode: 'bridge-v1',
    tools: [read, TOOL_SEARCH_TOOL, bogus, good],
    deferredToolCatalog: [read, bogus, good, tuple],
  });
  const described = JSON.parse(renderToolSearch({ names: [bogus.name, good.name, tuple.name] }, session, 'lead'));
  assert.deepEqual(
    described.blocked.map((entry) => entry.name),
    [bogus.name]
  );
  assert.match(described.blocked[0].reason, /is unavailable with the current model/);
  assert.deepEqual(described.entries.map((entry) => entry.name).sort(), [good.name, tuple.name].sort());
  const call = resolveExecutionToolCall(
    { id: 'X', name: 'call_tool', arguments: { name: bogus.name, arguments: {} } },
    session
  );
  assert.match(call.bridgeError, /^Error: TOOL_EXCLUDED: tool "mcp__x__bogus" is unavailable/);
  // A deferred tool runs through call_tool without any declaration.
  const deferred = resolveExecutionToolCall(
    { id: 'Y', name: 'call_tool', arguments: { name: tuple.name, arguments: {} } },
    session
  );
  assert.equal(deferred.bridgeError, undefined);
});

test('calling an unloaded excluded deferred tool by name is denied with the reason, not run', () => {
  const session = loaderSession('google/gemini-3.5-flash-lite');
  const denied = prepareDeferredToolCallThrough(session, bogus.name);
  assert.match(denied.deny, /^Error: tool "mcp__x__bogus" is unavailable with the current model/);
  assert.equal(
    session.tools.some((t) => t.name === bogus.name),
    false
  );
  assert.match(prepareDeferredToolCallThrough(loaderSession('fixture-model'), bogus.name).deny, /is unavailable/);
  assert.equal(prepareDeferredToolCallThrough(loaderSession('fixture-model'), good.name)?.deny, undefined);
  assert.equal(prepareDeferredToolCallThrough(loaderSession('fixture-model'), draft07.name)?.deny, undefined);
});
