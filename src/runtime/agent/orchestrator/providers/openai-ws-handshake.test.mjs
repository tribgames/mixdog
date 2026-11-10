import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachHandshakeFailureHandlers } from './openai-ws-handshake.mjs';

function handshake(statusCode, headers, chunks) {
  const socket = new EventEmitter();
  socket.terminate = () => {};
  let settled = null;
  attachHandshakeFailureHandlers({
    socket,
    errLabel: 'OpenAI WS',
    openStart: Date.now(),
    isSettled: () => settled !== null,
    settle: (ok, val) => {
      settled = { ok, val };
    },
  });
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  socket.emit('unexpected-response', {}, res);
  for (const chunk of chunks) res.emit('data', Buffer.from(chunk));
  res.emit('end');
  return settled;
}

test('unexpected-response preserves status, headers and the parsed body', () => {
  const message = 'm'.repeat(400);
  const body = JSON.stringify({
    error: { type: 'usage_limit_reached', message, resets_at: 1893456000 },
  });
  const headers = { 'retry-after': '30', 'x-request-id': 'req_1' };
  const { ok, val } = handshake(429, headers, [body.slice(0, 50), body.slice(50)]);
  assert.equal(ok, false);
  assert.equal(val.status, 429);
  assert.equal(val.httpStatus, 429);
  assert.equal(val.headers, headers);
  assert.equal(val.code, 'usage_limit_reached');
  assert.equal(val.retryAfterMs, 30_000);
  assert.equal(val.resetAt, 1893456000 * 1000);
  assert.equal(val.httpBody, body);
  assert.ok(val.message.length < 260);
});

test('unexpected-response with a non-JSON body keeps status and headers', () => {
  const headers = { server: 'cloudflare' };
  const { val } = handshake(403, headers, ['<html>blocked</html>']);
  assert.equal(val.status, 403);
  assert.equal(val.headers, headers);
  assert.equal(val.code, undefined);
  assert.match(val.message, /handshake 403: <html>blocked<\/html>/u);
});
