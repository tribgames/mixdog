import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  _buildResponseCreateFrame,
  _computeDelta,
  _sansInput,
  _stableStringify,
} from './openai-ws-delta.mjs';
import { _buildOpenAIHttpFallbackHeaders } from './openai-oauth-http-sse.mjs';
import { codexUserAgent, codexVersionHeader } from './codex-client-meta.mjs';
import { _codexBetaFeatures } from './openai-ws-headers.mjs';

test('response.create frames always drop stream/background and keep every other field', () => {
  const body = {
    model: 'm',
    instructions: 'sys',
    stream: true,
    background: false,
    store: false,
    input: [{ type: 'message', role: 'user', content: 'a' }],
    tools: [],
  };
  const full = _buildResponseCreateFrame(body);
  assert.deepEqual(Object.keys(full), ['type', 'model', 'instructions', 'store', 'input', 'tools']);
  const { stream: _s, background: _b, ...rest } = body;
  assert.deepEqual(full, { type: 'response.create', ...rest });
  const delta = _buildResponseCreateFrame(body, { previousResponseId: 'r1', inputOverride: [] });
  assert.deepEqual(Object.keys(delta), [
    'type', 'model', 'instructions', 'store', 'previous_response_id', 'input', 'tools',
  ]);
});

test('store:false on public OpenAI still continues on the same socket via previous_response_id', (t) => {
  const prior = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
  t.after(() => {
    if (prior == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prior;
  });
  const first = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] };
  const second = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] };
  const base = { model: 'm', store: false, stream: true };
  const entry = {
    lastRequestSansInput: _stableStringify(_sansInput({ ...base, input: [first] })),
    lastRequestInput: [first],
    lastResponseId: 'resp-1',
    lastResponseItems: [],
    turnState: 'sticky',
  };
  const result = _computeDelta({
    entry,
    body: { ...base, input: [first, second] },
    traceProvider: 'openai-direct',
  });
  assert.equal(result.mode, 'delta');
  assert.equal(result.frame.previous_response_id, 'resp-1');
  assert.deepEqual(result.frame.input, [second]);
  assert.equal('stream' in result.frame, false);
});

test('HTTP fallback headers share Codex identity headers but not WS-only ones', () => {
  const headers = _buildOpenAIHttpFallbackHeaders({
    auth: { type: 'openai-oauth', access_token: 't', account_id: 'a' },
    cacheKey: 'c',
  });
  assert.equal(headers['User-Agent'], codexUserAgent());
  assert.equal(headers.version, codexVersionHeader());
  assert.equal(headers['x-codex-beta-features'], _codexBetaFeatures());
  assert.equal(headers['OpenAI-Beta'], 'responses=experimental');
});
