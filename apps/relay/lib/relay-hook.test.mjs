import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  decodeHookResponseBody,
  failHookPending,
  handleHookRequest,
  MAX_HOOK_RESPONSE_BODY_BYTES,
} from './relay-hook.mjs';

test('webhook relay responses enforce strict base64 and byte limits', () => {
  assert.equal(decodeHookResponseBody(Buffer.from('ok').toString('base64')).toString(), 'ok');
  assert.throws(() => decodeHookResponseBody('not base64!'), /invalid hook response body/);
  assert.throws(
    () => decodeHookResponseBody('A'.repeat(Math.ceil(MAX_HOOK_RESPONSE_BODY_BYTES / 3) * 4 + 4)),
    /invalid hook response body/
  );
});

test('hook HTTP answers 400/404/503 without a live agent', () => {
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
  handleHookRequest(new Map(), { allow: () => true }, 64, { url: 'http://[', headers: {}, socket: {} }, response);
  assert.equal(recorded[0].status, 400);

  handleHookRequest(new Map(), { allow: () => true }, 64, { url: '/nope', headers: {}, socket: {} }, response);
  assert.equal(recorded[1].status, 404);
  assert.equal(recorded[1].body, '{"error":"not found"}');

  handleHookRequest(
    new Map(),
    { allow: () => true },
    64,
    { url: '/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/x', headers: {}, socket: {} },
    response
  );
  assert.equal(recorded[2].status, 503);
  assert.equal(recorded[2].body, '{"error":"agent offline"}');
});

test('a dropped hook leg fails every pending HTTP response', () => {
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
  const timer = setTimeout(() => {}, 60_000);
  timer.unref?.();
  const entry = { pending: new Map([['req', { response, timer }]]) };
  failHookPending(entry);
  assert.equal(entry.pending.size, 0);
  assert.equal(recorded[0].status, 502);
  assert.equal(recorded[0].body, '{"error":"agent disconnected"}');
});

test('hook rate limits destroy the request before a body is read', () => {
  const request = new EventEmitter();
  request.url = '/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  request.headers = {};
  request.socket = { remoteAddress: '203.0.113.8' };
  request.destroy = () => {
    request.destroyed = true;
  };
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
  handleHookRequest(new Map(), { allow: () => false }, 64, request, response);
  assert.equal(recorded[0].status, 429);
  assert.equal(recorded[0].headers['Retry-After'], '60');
  assert.equal(request.destroyed, true);
});
