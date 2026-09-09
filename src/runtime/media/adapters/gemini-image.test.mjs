import assert from 'node:assert/strict';
import test from 'node:test';
import { generateImage } from './gemini-image.mjs';

test('Gemini explicitly requests images for both creation and reference editing', async () => {
  for (const references of [[], [{ mime: 'image/png', base64: 'cmVmZXJlbmNl' }]]) {
    let request;
    const result = await generateImage({
      model: 'gemini-3-pro-image', prompt: 'A red circle', options: { aspectRatio: '1:1' }, references,
    }, {
      resolveKey: () => 'secret-key',
      fetchFn: async (url, init) => {
        request = { url, ...init, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }],
        }) };
      },
    });
    assert.match(request.url, /gemini-3-pro-image:generateContent$/);
    assert.deepEqual(request.body.generationConfig, {
      responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' },
    });
    assert.equal(request.body.contents[0].parts.length, references.length + 1);
    assert.equal(request.redirect, 'error');
    assert.equal(result.bytes.toString(), 'image');
  }
});

test('a rejected Gemini output setting is not silently dropped or retried', async () => {
  let calls = 0;
  await assert.rejects(generateImage({
    model: 'gemini-3-pro-image', prompt: 'A circle', options: { aspectRatio: '16:9' },
  }, {
    resolveKey: () => 'key',
    fetchFn: async () => {
      calls++;
      return { ok: false, status: 400, text: async () => '{"error":{"message":"unsupported setting"}}' };
    },
  }), { code: 'MEDIA_UPSTREAM_FAILED' });
  assert.equal(calls, 1);
});
