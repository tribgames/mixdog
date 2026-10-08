import assert from 'node:assert/strict';
import test from 'node:test';
import { beginLocalInference, localModelState, recordLocalModelLoad } from './model-state.mjs';
import { assertLocalModelInput } from './input-capabilities.mjs';

test('runtime observations distinguish queue, first semantic response and generated token rate', () => {
  let now = 100;
  recordLocalModelLoad(
    'metrics-test',
    { chat_template_caps: { supports_tools: true, supports_tool_calls: true } },
    1234
  );
  const observation = beginLocalInference('metrics-test', 0, () => now);
  now = 120;
  observation.progress('transport');
  now = 150;
  observation.progress('reasoning');
  now = 1150;
  observation.finish({ usage: { outputTokens: 21 } });
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
    assert.throws(() => assertLocalModelInput(model, [{ role: 'user', content: [{ type }] }], []), /text-only/);
  }
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'file', data: 'AAAA', mimeType: 'application/zip' }] }] },
    { role: 'user', content: [{ type: 'document', source: {} }] },
    { role: 'user', content: [{ type: 'text', text: 'now' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ];
  const degraded = assertLocalModelInput(model, history, []);
  assert.equal(degraded[0].content[1].text, '[image omitted: local model is text-only]');
  assert.equal(
    degraded[1].content[0].content[0].text,
    '[file not sent inline: (application/zip, 3 bytes) — this type has no inline form; open it from disk with read]'
  );
  assert.equal(degraded[2].content[0].text, '[document omitted: local model is text-only]');
  assert.equal(degraded[3].content[1].text, '[image omitted: local model is text-only]');
  assert.equal(history[0].content[1].type, 'image');
  assert.deepEqual(assertLocalModelInput(model, history, []), degraded);
  assert.doesNotThrow(() => assertLocalModelInput(model, [{ content: 'hello' }], [{ name: 'test' }]));
  assert.throws(
    () => assertLocalModelInput(model, [{ content: 'hello' }], [{ name: 'test' }], {}, { tools: false }),
    /tool interface/
  );
  assert.throws(() => assertLocalModelInput(model, [{ content: 'hello' }], [], { effort: 'high' }), /reasoning-level/);
});
