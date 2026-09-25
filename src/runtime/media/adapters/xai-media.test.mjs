import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const here = (path) => new URL(path, import.meta.url).href;
mock.module(here('../auth.mjs'), {
  namedExports: { resolveXaiAuth: async () => ({ baseURL: 'https://xai.invalid/v1', token: 't' }) },
});
mock.module(here('../download.mjs'), {
  namedExports: {
    decodeBase64Media: (value) => Buffer.from(value, 'base64'),
    downloadPublicMedia: async () => Buffer.from('mp4'),
  },
});
mock.module(here('../lanes.mjs'), {
  namedExports: { mediaError: (message, code, status) => Object.assign(new Error(message), { code, status }) },
});
const { generateImage, generateVideo } = await import('./xai-media.mjs');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => '' });

test('the image request carries its own timeout even when the caller passes no signal', async () => {
  const signals = [];
  globalThis.fetch = async (_url, init) => {
    signals.push(init.signal);
    return reply({ data: [{ b64_json: Buffer.from('png').toString('base64') }] });
  };
  await generateImage({ lane: 'xai', model: 'grok-imagine-image', prompt: 'p' });
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal, 'the image request must be bounded by a timeout signal');
  assert.equal(signals[0].aborted, false);
});

test('every video status poll carries its own timeout signal', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, signal: init.signal });
    if (url.endsWith('/videos/generations')) return reply({ request_id: 'req-1' });
    return reply({ status: 'done', video: { url: 'https://cdn.invalid/v.mp4', duration: 5 } });
  };
  const result = await generateVideo({ lane: 'xai', model: 'grok-imagine-video', prompt: 'p' });
  assert.equal(result.bytes.toString(), 'mp4');
  const poll = calls.find((call) => call.url.endsWith('/videos/req-1'));
  assert.ok(poll, 'the job was polled');
  assert.ok(poll.signal instanceof AbortSignal, 'a status poll must be bounded by a timeout signal');
});
