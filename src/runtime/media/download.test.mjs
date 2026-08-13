import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeBase64Media,
  downloadGeminiMedia,
  downloadPublicMedia,
  geminiMediaDownloadUrl,
} from './download.mjs';

test('public media downloads reject private targets before network access', async () => {
  let called = false;
  await assert.rejects(
    downloadPublicMedia('http://127.0.0.1/private', {
      fetchImpl: async () => {
        called = true;
        return new Response('secret');
      },
    }),
    /private address/,
  );
  assert.equal(called, false);
});

test('Gemini media keeps API credentials on the trusted HTTPS host', async () => {
  assert.equal(
    geminiMediaDownloadUrl('https://generativelanguage.googleapis.com/v1beta/files/clip'),
    'https://generativelanguage.googleapis.com/v1beta/files/clip?alt=media',
  );
  assert.throws(
    () => geminiMediaDownloadUrl('https://generativelanguage.googleapis.com.attacker.test/clip'),
    /untrusted/,
  );
  let receivedHeaders;
  const bytes = await downloadGeminiMedia(
    'https://generativelanguage.googleapis.com/v1beta/files/clip',
    {
      key: 'test-key',
      fetchImpl: async (_url, options) => {
        receivedHeaders = options.headers;
        return new Response('video');
      },
    },
  );
  assert.equal(bytes.toString(), 'video');
  assert.equal(receivedHeaders['x-goog-api-key'], 'test-key');
});

test('inline media decoding enforces the common result limit', () => {
  assert.equal(decodeBase64Media(Buffer.from('image').toString('base64')).toString(), 'image');
  assert.throws(() => decodeBase64Media(''), /size limit/);
});
