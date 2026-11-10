import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { anthropicGzipLatch } from '../lib/request-compression.mjs';
import { postMessages } from './gzip-post.mjs';

// The live CLI-version lookup also uses fetch; keep it out of the call counts.
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';

function withFetch(responder, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return responder(calls.length);
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

const largeBody = () => ({
  model: 'claude',
  messages: [{ role: 'user', content: 'x'.repeat(16 * 1024) }],
});

test('large bodies are gzipped asynchronously to the same bytes as gzipSync', async () => {
  const requestBody = largeBody();
  const raw = Buffer.from(JSON.stringify(requestBody));
  await withFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      const response = await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b' });
      assert.equal(response.status, 200);
      assert.equal(calls.length, 1);
      const { headers, body } = calls[0].init;
      assert.equal(headers['Content-Encoding'], 'gzip');
      assert.deepEqual(Buffer.from(body), gzipSync(raw));
      assert.equal(gunzipSync(body).toString('utf8'), raw.toString('utf8'));
    }
  );
});

test('small bodies are sent uncompressed', async () => {
  const requestBody = { model: 'claude', messages: [{ role: 'user', content: 'hi' }] };
  await withFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b' });
      assert.equal(calls[0].init.headers['Content-Encoding'], undefined);
      assert.equal(Buffer.from(calls[0].init.body).toString('utf8'), JSON.stringify(requestBody));
    }
  );
});

test('a failed plain resend does not latch; a throwing compressor fails open; encoded headers are kept', async () => {
  anthropicGzipLatch.reset();
  const requestBody = largeBody();
  await withFetch(
    (count) => new Response('{}', { status: count === 1 ? 415 : 500 }),
    async (calls) => {
      const response = await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b' });
      assert.equal(response.status, 500);
      assert.equal(calls.length, 2);
      assert.equal(anthropicGzipLatch.disabled(), false);
    }
  );
  await withFetch(
    () => new Response('{}', { status: 200 }),
    async (calls) => {
      const compress = async () => {
        throw new Error('boom');
      };
      await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b', compress });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.headers['Content-Encoding'], undefined);
    }
  );
});

test('a 400 on a gzipped body retries uncompressed and latches gzip off', async () => {
  anthropicGzipLatch.reset();
  const requestBody = largeBody();
  const raw = JSON.stringify(requestBody);
  await withFetch(
    (count) => new Response('{}', { status: count === 1 ? 400 : 200 }),
    async (calls) => {
      const response = await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b' });
      assert.equal(response.status, 200);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].init.headers['Content-Encoding'], 'gzip');
      assert.equal(gunzipSync(calls[0].init.body).toString('utf8'), raw);
      assert.equal(calls[1].init.headers['Content-Encoding'], undefined);
      assert.equal(Buffer.from(calls[1].init.body).toString('utf8'), raw);
      await postMessages({ accessToken: 't', requestBody, betaHeaders: 'b' });
      assert.equal(calls[2].init.headers['Content-Encoding'], undefined);
    }
  );
});
