import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-openai-caps-'));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS;

const { buildRequestBody, toOpenAIResponsesTool } = await import('./openai-responses-payload.mjs');
const { applyOpenAIDirectCachePolicy } = await import('./openai-direct-request.mjs');

const schema = { type: 'object', properties: {} };
const messages = [
  { role: 'system', content: 'Sys' },
  { role: 'user', content: 'hi' },
];
const tools = [
  { name: 'read', description: 'r', inputSchema: schema },
  { name: 'load_tool', description: 'l', inputSchema: schema },
];
const build = (provider, model, extra = {}) =>
  buildRequestBody(messages, model, tools, { promptCacheProvider: provider, sessionId: 'parity', effort: 'high', ...extra });

test('conforming models keep byte-identical bodies on openai and openai-oauth', () => {
  const expected = JSON.parse(
    readFileSync(new URL('./openai-responses-payload-parity.fixture.json', import.meta.url), 'utf8')
  );
  for (const [key, old] of Object.entries(expected)) {
    const [provider, model] = key.split('|');
    assert.equal(JSON.stringify(build(provider, model)), JSON.stringify(old), key);
  }
});

test('public models without reasoning/verbosity/tool_search get none of them', () => {
  const body = build('openai', 'gpt-4.1');
  assert.equal('reasoning' in body, false);
  assert.equal('text' in body, false);
  assert.equal('stream_options' in body, false);
  assert.deepEqual(
    body.tools.map((t) => t.type),
    ['function', 'function']
  );
  assert.equal(body.tools[1].name, 'load_tool');
});

test('public gpt-5 before 5.4 keeps reasoning and verbosity but loads tools by function', () => {
  const body = build('openai', 'gpt-5.2');
  assert.equal(body.reasoning.effort, 'high');
  assert.deepEqual(body.text, { verbosity: 'low' });
  assert.equal(body.tools[1].type, 'function');
  assert.equal(build('openai', 'gpt-5.4').tools[1].type, 'tool_search');
  assert.equal(build('openai', 'gpt-6-astra').tools[1].type, 'tool_search');
});

test('public models without reasoning send no encrypted-reasoning include or replay', () => {
  const body = build('openai', 'gpt-4.1');
  assert.equal('include' in body, false);
  assert.deepEqual(build('openai', 'gpt-5.2').include, ['reasoning.encrypted_content']);
  assert.deepEqual(build('openai-oauth', 'gpt-4.1').include, ['reasoning.encrypted_content']);
  const history = [
    { role: 'system', content: 'Sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      reasoningItems: [{ id: 'rs_1', encrypted_content: 'enc', summary: [] }],
    },
    { role: 'user', content: 'next' },
  ];
  const replayed = (model) =>
    buildRequestBody(history, model, tools, { promptCacheProvider: 'openai', sessionId: 'parity' }).input.some(
      (item) => item.type === 'reasoning'
    );
  assert.equal(replayed('gpt-5.2'), true);
  assert.equal(replayed('gpt-4.1'), false);
});

test('a model without native tool_search replays load_tool history as a function pair', () => {
  const history = [
    { role: 'system', content: 'Sys' },
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'ts1', name: 'load_tool', arguments: { names: ['x'] }, nativeType: 'tool_search_call' }],
    },
    {
      role: 'tool',
      toolCallId: 'ts1',
      content: 'loaded x',
      nativeToolSearch: { provider: 'openai', openaiTools: [{ type: 'function', name: 'x' }] },
    },
  ];
  const types = (model) =>
    buildRequestBody(history, model, tools, { promptCacheProvider: 'openai', sessionId: 'parity' })
      .input.map((item) => item.type)
      .filter(Boolean);
  assert.deepEqual(types('gpt-5.4'), ['tool_search_call', 'tool_search_output']);
  const older = buildRequestBody(history, 'gpt-5.2', tools, { promptCacheProvider: 'openai', sessionId: 'parity' }).input;
  assert.deepEqual(
    older.filter((item) => item.type).map((item) => item.type),
    ['function_call', 'function_call_output']
  );
  assert.equal(older.find((item) => item.type === 'function_call').name, 'load_tool');
  assert.equal(older.find((item) => item.type === 'function_call_output').output, 'loaded x');
  // A replayed native search item is lowered the same way.
  const replay = {
    version: 1,
    provider: 'openai-responses',
    items: [
      { type: 'tool_search_call', call_id: 'ts1', execution: 'client', arguments: { names: ['x'] } },
      { type: 'tool_search_call', id: 'srv', call_id: null, execution: 'server', arguments: {} },
      { type: 'tool_search_output', call_id: null, execution: 'server', tools: [] },
    ],
  };
  const replayHistory = [history[0], history[1], { role: 'assistant', content: '', providerReplay: replay }, history[3]];
  const lowered = buildRequestBody(replayHistory, 'gpt-5.2', tools, {
    promptCacheProvider: 'openai',
    sessionId: 'parity',
  }).input.filter((item) => item.type);
  assert.deepEqual(
    lowered.map((item) => item.type),
    ['function_call', 'function_call_output']
  );
});

test('Codex route keeps its defaults regardless of the public capability table', () => {
  const body = build('openai-oauth', 'gpt-5.2');
  assert.ok(body.reasoning);
  assert.ok(body.text);
  assert.equal(body.tools[1].type, 'tool_search');
});

test('toOpenAIResponsesTool defaults to native tool_search and can opt out', () => {
  assert.equal(toOpenAIResponsesTool(tools[1]).type, 'tool_search');
  const fn = toOpenAIResponsesTool(tools[1], { nativeToolSearch: false });
  assert.deepEqual(fn, { type: 'function', name: 'load_tool', description: 'l', parameters: schema, strict: false });
});

test('an explicit caller limit is sent on the public API but not on OAuth unless enabled', () => {
  assert.equal(build('openai', 'gpt-5.5', { maxOutputTokens: 1234.7 }).max_output_tokens, 1234);
  assert.equal('max_output_tokens' in build('openai', 'gpt-5.5'), false);
  assert.equal('max_output_tokens' in build('openai-oauth', 'gpt-5.5', { maxOutputTokens: 1234 }), false);
  process.env.MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS = '1';
  try {
    assert.equal(build('openai-oauth', 'gpt-5.5', { maxOutputTokens: 1234 }).max_output_tokens, 1234);
  } finally {
    delete process.env.MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS;
  }
});

test('cache lifetime: 24h only on the documented list, ttl for GPT-5.6+, else omitted', () => {
  for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-codex', 'gpt-4.1', 'gpt-5.4-2026-03-05']) {
    const body = applyOpenAIDirectCachePolicy({}, model, true);
    assert.equal(body.prompt_cache_retention, '24h', model);
    assert.equal(body.prompt_cache_options, undefined, model);
  }
  for (const model of ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol']) {
    const body = applyOpenAIDirectCachePolicy({}, model, true);
    assert.deepEqual(body.prompt_cache_options, { ttl: '30m' }, model);
    assert.equal(body.prompt_cache_retention, undefined, model);
  }
  for (const model of ['gpt-5.4-mini', 'gpt-4o', 'o3', 'some-custom-model']) {
    const body = applyOpenAIDirectCachePolicy({ prompt_cache_retention: '24h' }, model, true);
    assert.equal(body.prompt_cache_retention, undefined, model);
    assert.equal(body.prompt_cache_options, undefined, model);
  }
});
