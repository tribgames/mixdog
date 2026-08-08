import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexImageRequestBody } from './codex-image.mjs';

for (const model of ['gpt-5.6-sol', 'gpt-5.4-mini']) {
  test(`${model} forces the hosted image generation tool`, () => {
    const body = codexImageRequestBody({
      model,
      prompt: 'Draw a blue square.',
      options: { size: '1024x1024', quality: 'low' },
    });

    assert.equal(body.model, model);
    assert.deepEqual(body.tool_choice, { type: 'image_generation' });
    assert.deepEqual(body.tools, [{
      type: 'image_generation',
      size: '1024x1024',
      quality: 'low',
    }]);
    assert.equal(body.input[0].content.at(-1)?.text, 'Draw a blue square.');
  });
}
