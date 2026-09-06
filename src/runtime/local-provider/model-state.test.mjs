import assert from 'node:assert/strict';
import test from 'node:test';
import { beginLocalInference, localModelState, recordLocalModelLoad } from './model-state.mjs';
import { assertLocalModelInput } from './input-capabilities.mjs';

test('runtime observations distinguish queue, first semantic response and generated token rate', () => {
  let now = 100;
  recordLocalModelLoad('metrics-test', { chat_template_caps: { supports_tools: true, supports_tool_calls: true } }, 1234);
  const observation = beginLocalInference('metrics-test', 0, () => now);
  now = 120; observation.progress('transport');
  now = 150; observation.progress('reasoning');
  now = 1150; observation.finish({ usage: { outputTokens: 21 } });
  const state = localModelState('metrics-test');
  assert.equal(state.loadTimeMs, 1234);
  assert.equal(state.inference.queueWaitMs, 100);
  assert.equal(state.inference.firstResponseMs, 50);
  assert.equal(state.inference.tokensPerSecond, 20);
  assert.equal(state.capabilities.tools, true);
});

test('unsupported media and known-unsupported tools are refused, while unknown tool support is not invented', () => {
  const model = { name: 'Text model', supportsFunctionCalling: null };
  for (const type of ['image', 'image_url', 'audio', 'document', 'video']) {
    assert.throws(() => assertLocalModelInput(model, [{ content: [{ type }] }], []), /text-only/);
  }
  assert.doesNotThrow(() => assertLocalModelInput(model, [{ content: 'hello' }], [{ name: 'test' }]));
  assert.throws(() => assertLocalModelInput(model, [{ content: 'hello' }], [{ name: 'test' }], {}, { tools: false }), /tool interface/);
  assert.throws(() => assertLocalModelInput(model, [{ content: 'hello' }], [], { effort: 'high' }), /reasoning-level/);
});
