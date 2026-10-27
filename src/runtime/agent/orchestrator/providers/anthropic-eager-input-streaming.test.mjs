// Fine-grained tool streaming (`eager_input_streaming`) is a first-party
// Anthropic request feature: a proxy or custom endpoint answers it with a 400.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const { buildAnthropicApiRequest } = await import('./anthropic-api-request.mjs');
const { _buildRequestBodyForCacheSmoke } = await import('./anthropic-oauth.mjs');
const { requestAnthropicTools } = await import('./lib/anthropic-request-utils.mjs');

const MODEL = 'claude-opus-5-5';
const TOOLS = [
  { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } },
  { name: 'write', description: 'Write', inputSchema: { type: 'object', properties: {} } },
];
const MESSAGES = [
  { role: 'system', content: 'You are a worker.' },
  { role: 'user', content: 'Go.' },
];

const apiTools = async (name, config, model = MODEL) =>
  (
    await buildAnthropicApiRequest({
      name,
      config,
      messages: MESSAGES,
      useModel: model,
      tools: TOOLS,
      opts: {},
      fastModeLatched: false,
    })
  ).params.tools;

test('the API-key route sends eager_input_streaming on every tool for first-party Anthropic', async () => {
  for (const config of [{}, { baseURL: 'https://api.anthropic.com' }, { baseURL: 'https://api.anthropic.com/v1' }]) {
    const tools = await apiTools('anthropic', config);
    assert.equal(tools.length, TOOLS.length);
    for (const tool of tools) assert.equal(tool.eager_input_streaming, true, JSON.stringify(config));
  }
});

test('the API-key route omits it on a custom base URL, without beta headers, and on gateways', async () => {
  const cases = [
    ['anthropic', { baseURL: 'https://gw.example/v1' }],
    ['anthropic', { baseURL: 'https://api.anthropic.com.evil.example' }],
    ['anthropic', { disableBetaHeaders: true }],
    ['openrouter', { authScheme: 'bearer' }, 'anthropic/claude-opus-5.5'],
    ['custom-claude', {}],
  ];
  for (const [name, config, model] of cases) {
    const tools = await apiTools(name, config, model);
    assert.equal(tools.length, TOOLS.length);
    for (const tool of tools) {
      assert.equal('eager_input_streaming' in tool, false, `${name} ${JSON.stringify(config)}`);
    }
  }
});

test('the OAuth route sends eager_input_streaming on every tool', () => {
  const { tools } = _buildRequestBodyForCacheSmoke(MESSAGES, MODEL, TOOLS, {});
  assert.equal(tools.length, TOOLS.length);
  for (const tool of tools) assert.equal(tool.eager_input_streaming, true);
});

test('provider-native tools are left as supplied', () => {
  const native = { type: 'web_search_20250305', name: 'web_search' };
  const tools = requestAnthropicTools(TOOLS, [], { nativeTools: [native] }, 'anthropic-oauth');
  assert.deepEqual(tools[0], native);
  assert.equal(tools[1].eager_input_streaming, true);
});
