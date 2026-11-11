#!/usr/bin/env node
// openai-ws-handshake.test.mjs (2 tests): the real `attachHandshakeFailureHandlers` over an EventEmitter socket that emits an
// `unexpected-response` with a scripted status / headers / body chunks. The settled value is recorded whole (status, headers, code,
// retry-after / reset advice, raw body, message).
//   node benchmarks/rust-core/recorders/record-openai-ws-handshake.mjs --tree <exact export of b6f10295a>
import { EventEmitter } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-handshake',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-handshake.mjs attachHandshakeFailureHandlers({ socket, errLabel: "OpenAI WS", openStart, isSettled, settle }); the socket is an EventEmitter, the response chunks are emitted synchronously (no timer).',
  replay: 'mixdog-ai providers/openai ws handshake failure (transport/ws.rs:40): feed `input` (status, headers, body chunks) and compare the settled `{ ok, val }` (val fields: status, httpStatus, headers, code, retryAfterMs, resetAt, httpBody, message; `messageLength` for the long case).',
});
const { attachHandshakeFailureHandlers } = await rec.load('src/runtime/agent/orchestrator/providers/openai-ws-handshake.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-handshake.test.mjs';
function handshake(statusCode, headers, chunks) {
  const socket = new EventEmitter();
  socket.terminate = () => {};
  let settled = null;
  attachHandshakeFailureHandlers({ socket, errLabel: 'OpenAI WS', openStart: Date.now(), isSettled: () => settled !== null, settle: (ok, val) => { settled = { ok, val }; } });
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  socket.emit('unexpected-response', {}, res);
  for (const chunk of chunks) res.emit('data', Buffer.from(chunk));
  res.emit('end');
  return settled;
}
const shape = (statusCode, headers, chunks) => {
  const { ok, val } = handshake(statusCode, headers, chunks);
  return { ok, status: val.status, httpStatus: val.httpStatus, headers: val.headers, code: val.code, retryAfterMs: val.retryAfterMs, resetAt: val.resetAt, httpBody: val.httpBody, message: val.message, messageLength: val.message.length };
};
const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'm'.repeat(400), resets_at: 1893456000 } });
const headers = { 'retry-after': '30', 'x-request-id': 'req_1' };
const chunks = [body.slice(0, 50), body.slice(50)];
await rec.run('unexpected-response-preserves-status-headers-body', `${SRC}:28`, { statusCode: 429, headers, chunks }, () => shape(429, headers, chunks));
await rec.run('non-json-body-keeps-status-and-headers', `${SRC}:46`, { statusCode: 403, headers: { server: 'cloudflare' }, chunks: ['<html>blocked</html>'] }, () => shape(403, { server: 'cloudflare' }, ['<html>blocked</html>']));
await rec.finish();
