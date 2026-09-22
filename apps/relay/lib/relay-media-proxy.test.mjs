import assert from 'node:assert/strict';
import test from 'node:test';

import { failMediaPending, handleMediaRequest } from './relay-media-proxy.mjs';
import { recordingResponse } from './test-recording-response.mjs';

test('malformed media paths answer 400 without consulting the store', () => {
  const response = recordingResponse();
  const { recorded } = response;
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
