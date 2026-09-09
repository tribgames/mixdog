import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexImageRequestBody, codexImageRequestHeaders, generateImage } from './codex-image.mjs';
import { codexUserAgent, codexVersionHeader } from '../../agent/orchestrator/providers/codex-client-meta.mjs';

for (const model of ['gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-6-astra']) {
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

test('image requests carry the same client identity as the Codex catalog transport', () => {
  const headers = codexImageRequestHeaders({ access_token: 'test-token', account_id: 'test-account' });
  assert.equal(headers.version, codexVersionHeader());
  assert.equal(headers['User-Agent'], codexUserAgent());
  assert.equal(headers['chatgpt-account-id'], 'test-account');
});

test('OAuth parses image SSE without a content type and reports the actual engine', async () => {
  let request;
  const result = await generateImage({ model: 'gpt-6-astra', prompt: 'Draw a circle.' }, {
    resolveAuth: async () => ({ access_token: 'token', account_id: 'account' }),
    warmVersion: async () => {},
    fetchFn: async (_url, init) => {
      request = init;
      return new Response(`data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', model: 'gpt-image-2-codex', result: 'aW1hZ2U=' },
      })}\n\ndata: [DONE]\n\n`);
    },
  });
  assert.equal(result.bytes.toString(), 'image');
  assert.equal(result.actualModel, 'gpt-image-2-codex');
  assert.deepEqual(JSON.parse(request.body).tools, [{ type: 'image_generation' }]);
  assert.equal(request.redirect, 'error');
});

test('OAuth refuses output settings that the server does not honor before authenticating', async () => {
  await assert.rejects(generateImage({
    model: 'gpt-6-astra', prompt: 'Draw a circle.', options: { size: '1536x1024' },
  }, {
    resolveAuth: () => { throw new Error('must not authenticate'); },
  }), { code: 'MEDIA_OPTION_UNSUPPORTED' });
});
