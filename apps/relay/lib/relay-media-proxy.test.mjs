import assert from 'node:assert/strict';
import test from 'node:test';

import { failMediaPending, handleMediaRequest, mediaResponseHeaders } from './relay-media-proxy.mjs';

test('desktop media metadata cannot make the relay origin serve active content', () => {
  const headers = mediaResponseHeaders({
    'content-type': 'image/svg+xml',
    'content-length': 12,
    'set-cookie': 'session=stolen',
    'content-security-policy': 'default-src *',
  });
  assert.equal(headers['Content-Type'], 'application/octet-stream');
  assert.equal(headers['Set-Cookie'], undefined);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Content-Disposition'], 'attachment');
  assert.equal(headers['Content-Security-Policy'], "default-src 'none'; sandbox");
  const passthrough = mediaResponseHeaders({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes' });
  assert.equal(passthrough['Content-Type'], 'video/mp4');
  assert.equal(passthrough['Accept-Ranges'], 'bytes');
});

test('malformed media paths answer 400 without consulting the store', () => {
  const recorded = [];
  const response = {
    writeHead(status, headers) {
      recorded.push({ status, headers });
      return this;
    },
    end(body) {
      recorded.at(-1).body = body;
    },
  };
  handleMediaRequest({}, new Map(), { allow: () => true }, { method: 'GET', url: '/media/%', headers: {} }, response);
  assert.equal(recorded[0].status, 400);
  assert.equal(recorded[0].body, 'Bad request.');
  handleMediaRequest(
    {},
    new Map(),
    { allow: () => true },
    { method: 'POST', url: '/media/abc', headers: {} },
    response
  );
  assert.equal(recorded[1].status, 405);
});

test('a vanished desktop closes half-written media responses', () => {
  const recorded = [];
  const response = {
    writeHead(status) {
      recorded.push(status);
    },
    end() {
      recorded.push('end');
    },
  };
  const timer = setTimeout(() => {}, 60_000);
  timer.unref?.();
  const entry = { media: new Map([['id', { response, timer, head: false }]]) };
  failMediaPending(entry);
  assert.equal(entry.media.size, 0);
  assert.deepEqual(recorded, [503, 'end']);
});
