import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createHttpRouter } from './http-router.mjs';

function request(method, url, { host = '127.0.0.1', body } = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = { host };
  if (body !== undefined) req.end(JSON.stringify(body));
  else req.end();
  return req;
}

class Response extends EventEmitter {
  writableFinished = false;
  headersSent = false;
  statusCode = 0;
  value = null;
  writeHead(status) {
    this.statusCode = status;
    this.headersSent = true;
  }
  end(body) {
    this.value = JSON.parse(body);
    this.writableFinished = true;
  }
}

function fixture(overrides = {}) {
  const seen = [];
  const router = createHttpRouter({
    getInitialized: () => true,
    getInitPromise: () => null,
    getDraining: () => false,
    touchDaemonIdleTimer: (label) => seen.push(label),
    setBootTimestamp: () => {},
    handleToolCall: async () => ({ content: [] }),
    ...overrides,
  });
  return { router, seen };
}

async function send(router, req) {
  const res = new Response();
  await router.requestHandler(req, res);
  return res;
}

test('a non-local request is refused before any route, admin and tool routes included', async () => {
  const { router, seen } = fixture();
  for (const [method, url] of [
    ['POST', '/admin/purge'],
    ['POST', '/api/tool'],
    ['POST', '/mcp'],
    ['POST', '/entry'],
    ['GET', '/health'],
  ]) {
    const res = await send(router, request(method, url, { host: 'evil.example', body: {} }));
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.value.error, 'forbidden: non-local request');
  }
  assert.deepEqual(seen, []);
});

test('lifecycle routes answer while the runtime is still starting; the rest wait on the gate', async () => {
  const { router } = fixture({ getInitialized: () => false, getInitPromise: () => null });
  const rebind = await send(router, request('POST', '/rebind', { body: {} }));
  assert.deepEqual(rebind.value, { ok: true });
  const health = await send(router, request('GET', '/health'));
  assert.equal(health.statusCode, 503);
  assert.equal(health.value.status, 'starting');
  const cancel = await send(router, request('POST', '/api/cancel', { body: { callId: 'x' } }));
  assert.equal(cancel.statusCode, 503);
  assert.equal(cancel.value.error, 'memory runtime is starting');
});

test('the ingest tail rejects other methods with 405 and unknown POST urls with 404', async () => {
  const { router, seen } = fixture();
  const get = await send(router, request('GET', '/nope'));
  assert.equal(get.statusCode, 405);
  const post = await send(router, request('POST', '/nope', { body: {} }));
  assert.equal(post.statusCode, 404);
  assert.deepEqual(seen, ['GET /nope', 'POST /nope']);
});

test('/mcp answers 405 for non-POST methods', async () => {
  const { router } = fixture({ log: () => {} });
  const res = await send(router, request('GET', '/mcp'));
  assert.equal(res.statusCode, 405);
  assert.equal(res.value.error, 'Method not allowed');
});
