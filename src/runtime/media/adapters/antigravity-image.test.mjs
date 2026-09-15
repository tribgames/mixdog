import assert from 'node:assert/strict';
import test from 'node:test';
import { antigravityImageParts, generateImage } from './antigravity-image.mjs';

const auth = async () => ({ token: 'access-token', projectId: 'projects/test' });

function sse(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

test('Antigravity images ride the streaming gateway route in the chat envelope', async () => {
  for (const references of [[], [{ mime: 'image/png', base64: 'cmVmZXJlbmNl' }]]) {
    let request;
    const result = await generateImage({
      model: 'gemini-3.1-flash-image', prompt: 'A red circle', options: { aspectRatio: '16:9' }, references,
    }, {
      resolveAuth: auth,
      fetchFn: async (url, init) => {
        request = { url, ...init, body: JSON.parse(init.body) };
        return { ok: true, text: async () => sse([
          { response: { candidates: [{ content: { role: 'model', parts: [{ thoughtSignature: 'sig' }] } }] } },
          { response: { candidates: [{ content: { role: 'model', parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2U=' } }, { text: '' },
          ] }, finishReason: 'STOP' }] } },
        ]) };
      },
    });
    assert.match(request.url, /^https:\/\/[^/]+\/v1internal:streamGenerateContent\?alt=sse$/);
    assert.equal(request.headers.Authorization, 'Bearer access-token');
    assert.equal(request.headers.Accept, 'text/event-stream');
    assert.match(request.headers['User-Agent'], /^antigravity\/hub\//);
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.project, 'projects/test');
    assert.equal(request.body.model, 'gemini-3.1-flash-image');
    assert.equal(request.body.userAgent, 'antigravity');
    assert.match(request.body.requestId, /^agent-/);
    assert.deepEqual(request.body.request.generationConfig, {
      responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' },
    });
    assert.equal(request.body.request.contents[0].parts.length, references.length + 1);
    assert.match(request.body.request.sessionId, /^-/);
    assert.equal(result.mime, 'image/jpeg');
    assert.equal(result.bytes.toString(), 'image');
  }
});

test('an empty or failed Antigravity stream is reported once, never retried', async () => {
  let calls = 0;
  await assert.rejects(generateImage({ model: 'gemini-3.1-flash-image', prompt: 'A circle' }, {
    resolveAuth: auth,
    fetchFn: async () => {
      calls++;
      return { ok: true, text: async () => sse([{ response: { candidates: [] } }]) };
    },
  }), { code: 'MEDIA_EMPTY_RESULT' });
  assert.equal(calls, 1);

  await assert.rejects(generateImage({ model: 'gemini-3.1-flash-image', prompt: 'A circle' }, {
    resolveAuth: auth,
    fetchFn: async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"Resource has been exhausted"}}' }),
  }), { code: 'MEDIA_RATE_LIMITED' });

  const { parts, failure } = antigravityImageParts(sse([
    { error: { message: 'model unavailable' } },
    { response: { candidates: [{ content: { parts: [{ text: 'sorry' }] } }] } },
  ]));
  assert.equal(failure, 'model unavailable');
  assert.deepEqual(parts, [{ text: 'sorry' }]);
});
